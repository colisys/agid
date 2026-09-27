#!/usr/bin/env python3
"""pm: 地牢「真正的后端」演示服务——监听/操纵活局 + 中断续玩存档。

由网关按 manifest.json 的 services 声明托管（SVC_PORT 注入端口）。两条消费路径：
  1. gm 脑席:   host.svc("pm", "/observe"/"/poll")  （supervisor 内部直连，无鉴权）
  2. PM 后台页: /svc/dungeon/pm/live 等              （网关反代；写操作须 X-Admin-Token）

能力展示链路（GM 只是演示形式，本质是「后端能监听并操作游戏 state」）：
  监听: gm 脑席每轮 POST /observe 快照摘要 → 内存 live[key]（覆盖式）
  操纵: PM 页 POST /op（鉴权）→ ops 队列 → gm 脑席 GET /poll 取走 →
        commands.gm → rules.tick 逐条校验执行（合法性全部归规则）
  运行键: seed（decide 入参没有 match_id；UI 建局 seed 留空自动随机保证唯一）

存档（中断续玩）：UI 把 SSE raw state 存到 <data>/pm/saves/<name>.json（每玩家
一份，原子落盘），建局时经 props.resume 传回，rules.newmatch 白名单 hydrate。

鉴权：PM_TOKEN env 未设置时打印响亮警告并放行（本地开发）；容器编排
（service.sh compose 生成的 compose 文件，位于 gitignore 的 data/）里手填。
"""
import json
import os
import re
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_BODY = 256 * 1024
MAX_SAVES = 200
GM_OPS = {"grant_gold", "set_hp", "heal_full", "set_atk", "add_item", "del_item"}

_LOCK = threading.Lock()
_LIVE = {}  # key(str seed) -> 最新 observe 视图 + ts（内存，重启即失）
_OPS = {}  # key -> [op, ...] 走桥接直接投递；bridge 未就绪时的回退队列
# 网关 match bridge 下发的每局凭证：seed -> (match_id, token, ops_path, notify_path)。
# 网关每个 tick 推一次 observe（POST /observe），这里记下地址与 token；PM 页的
# 操纵请求据此直接投递到对局，不再需要 gm 脑席中转。
_BRIDGE = {}  # key(str seed) -> {"match_id","token","ops_path","notify_path","ts"}

# 文案库异步生成：narrator 脑席 POST /bankgen 投递任务（立即返回，不阻塞结算），
# 后台线程调 LLM 上游，完成后领货。LLM 慢（可到 25s），决不能在脑席 decide 的
# 同步路径里等它。任务可同时携带：kinds（补货场景）+ lore（来历传说单件上下文）。
_BANK_JOB = {}  # {"kinds":[...], "scene": str, "lore": {...}|None, "ts": int}
_BANK_RESULT = {}  # {"ready": bool, "bank": {...}, "lore": {...}|None, "error": str|None, "ts": int}


def _llm_chat(system: str, user: str) -> str:
    """直连 LLM 上游（网关注入的 LLM_UPSTREAM_* env），返回文本。"""
    url = os.environ.get("LLM_UPSTREAM_URL", "").rstrip("/")
    key = os.environ.get("LLM_UPSTREAM_KEY", "")
    model = os.environ.get("LLM_UPSTREAM_MODEL", "")
    if not (url and model):
        raise RuntimeError("LLM_UPSTREAM_* env not set (gateway injects at spawn)")
    payload = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    }).encode()
    req = urllib.request.Request(
        url + "/chat/completions", data=payload, method="POST",
        headers={"Content-Type": "application/json",
                 **({"Authorization": "Bearer " + key} if key else {})},
    )
    with urllib.request.urlopen(req, timeout=90) as resp:
        out = json.loads(resp.read().decode())
    return str(out["choices"][0]["message"]["content"] or "")


BANK_SYSTEM = (
    "你是古早 WAP 文字游戏的旁白。为地牢探索的多个场景各写 3 句旁白短句："
    "大多数场景是不超过 14 个汉字的有画面感短句；"
    "quota 场景的句子是不超过 20 个字的惊悚提示（石阶被封、黑暗中有东西守着，"
    "压抑而有未知的威胁感）。"
    "输出 JSON 对象：{\"场景名\":[\"…\",\"…\",\"…\"],…}，"
    "只输出这个 JSON 对象，不要解释、不要代码块。"
)


LORE_SYSTEM = (
    "你为地牢探险游戏里的装备撰写来历传说。根据装备名、描述和发现时的场景，"
    "用不超过 26 个汉字写一段有画面感的短传说（它经历过谁、藏着什么故事）。"
    "只输出这段文字，不要引号、不要解释。"
)

# 事件房动态文案：为每个事件各写 2 组 {title, desc}。title ≤10 字、desc ≤40 字，
# 只做场景包装（机制选项由规则生成，LLM 永不触碰数值）。
EVENTS_SYSTEM = (
    "你为地牢文字游戏的事件房改写场景包装。对给出的每个事件，各写 2 组中文文案："
    "title 是不超过 10 个字的场景名（第二人称代入感，如「白骨堆里半掩的木箱」），"
    "desc 是不超过 40 个字的场景描述（一句有画面感的描写，不剧透后果、不出现数值）。"
    '输出 JSON 对象：{"事件id":[{"title":"…","desc":"…"},…],…}，'
    "只输出这个 JSON 对象，不要解释、不要代码块。"
)


def _run_bank_job(kinds: list, scene: str, lore: dict | None, events: list) -> None:
    bank, lore_out, ev_out, err = {}, None, None, None
    # 文案库部分：一次调用批量补齐全部缺货场景
    if kinds:
        try:
            ask = "需要补货的场景：" + ", ".join(kinds) + "。\n" + scene
            raw = _llm_chat(BANK_SYSTEM, ask)
            raw = raw[raw.index("{"): raw.rindex("}") + 1]  # 剥掉可能的 markdown 包裹
            parsed = json.loads(raw)
            if not isinstance(parsed, dict):
                raise ValueError("not an object")
            for k, v in parsed.items():
                if isinstance(v, list) and k in kinds:
                    lines = [str(x).strip()[:20] for x in v if str(x).strip()]
                    if lines:
                        bank[k] = lines[:4]
            if not bank:
                err = "empty"
        except Exception as e:  # noqa: BLE001 —— 后台线程兜底，结果里带错误
            err = str(e)
    # 事件动态文案部分：独立失败域
    if events:
        try:
            ask = "需要包装的事件：" + ", ".join(events)
            raw = _llm_chat(EVENTS_SYSTEM, ask)
            raw = raw[raw.index("{"): raw.rindex("}") + 1]
            parsed = json.loads(raw)
            if not isinstance(parsed, dict):
                raise ValueError("not an object")
            ev_out = {}
            for k, v in parsed.items():
                if k not in events or not isinstance(v, list):
                    continue
                variants = []
                for o in v[:2]:
                    if isinstance(o, dict) and str(o.get("title", "")).strip():
                        variants.append({
                            "title": str(o.get("title", "")).strip()[:10],
                            "desc": str(o.get("desc", "")).strip()[:40],
                        })
                if variants:
                    ev_out[k] = variants
        except Exception as e:  # noqa: BLE001
            if not err:
                err = "events: " + str(e)
    # 来历传说部分：独立失败域，一行文本，失败不影响其他部分
    if isinstance(lore, dict) and lore.get("base"):
        try:
            ask = (
                "装备：「" + str(lore.get("name", "")) + "」（" + str(lore.get("desc", "")) + "）\n"
                "场景：冒险者在" + str(lore.get("where", "")) + "鉴定出它——「" + str(lore.get("scene", "")) + "」"
            )
            lore_out = {"base": str(lore["base"])[:40], "text": _llm_chat(LORE_SYSTEM, ask).strip()[:40]}
        except Exception as e:  # noqa: BLE001
            if not err:
                err = "lore: " + str(e)
    with _LOCK:
        _BANK_RESULT.update({"ready": True, "bank": bank, "lore": lore_out,
                             "events": ev_out, "error": err, "ts": time.time()})


def queue_bank_job(req: dict) -> tuple:
    kinds = req.get("kinds")
    lore = req.get("lore")
    events = req.get("events")
    if not isinstance(kinds, list):
        kinds = []
    kinds = [str(k)[:16] for k in kinds][:16]
    if lore is not None and not isinstance(lore, dict):
        lore = None
    if not isinstance(events, list):
        events = []
    events = [str(k)[:16] for k in events][:6]
    if not kinds and not lore and not events:
        return 400, {"error": "kinds, lore or events required"}
    scene = str(req.get("scene") or "")[:200]
    with _LOCK:
        busy = bool(_BANK_JOB) and not (_BANK_RESULT.get("ready") and _BANK_RESULT["ts"] > _BANK_JOB.get("ts", 0))
    if busy:
        return 200, {"ok": True, "queued": False}  # 已有任务在跑，幂等
    ts = time.time()
    with _LOCK:
        _BANK_JOB.update({"kinds": kinds, "scene": scene, "lore": lore, "events": events, "ts": ts})
        _BANK_RESULT.update({"ready": False, "bank": {}, "lore": None, "events": None, "error": None, "ts": ts})
    threading.Thread(target=_run_bank_job, args=(kinds, scene, lore, events), daemon=True).start()
    return 200, {"ok": True, "queued": True}


def bank_result() -> dict:
    with _LOCK:
        return dict(_BANK_RESULT)


def data_dir() -> str:
    # 网关保证 SVC_DATA 一定存在（manifest 的 data_dir 解析后注入，dev 与容器
    # 指向同一相对位置）。手工直接跑本脚本时退回脚本同级目录，仅为方便调试。
    return os.environ.get("SVC_DATA") or os.path.dirname(os.path.abspath(__file__))


def saves_dir() -> str:
    return os.path.join(data_dir(), "pm", "saves")


def pm_token() -> str:
    return os.environ.get("PM_TOKEN") or ""


def authorized(req_headers) -> bool:
    want = pm_token()
    if not want:
        return True  # 未配置 token：本地开发放行（启动时有警告）
    return (req_headers.get("X-Admin-Token") or "") == want


def safe_name(name: str) -> str:
    """玩家名 -> 安全文件名：只留常用字符，限长（防路径穿越/怪名）。"""
    n = re.sub(r"[^\w\u4e00-\u9fff-]", "_", str(name or "")).strip("_")
    return n[:48]


def save_path(name: str) -> str:
    return os.path.join(saves_dir(), safe_name(name) + ".json")


def atomic_write(path: str, obj) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)
    os.replace(tmp, path)


def list_saves() -> list:
    out = []
    try:
        names = sorted(os.listdir(saves_dir()))
    except OSError:
        return out
    for fn in names:
        if not fn.endswith(".json"):
            continue
        try:
            with open(os.path.join(saves_dir(), fn), encoding="utf-8") as f:
                rec = json.load(f)
            st = rec.get("state") or {}
            out.append({
                "name": rec.get("name") or fn[:-5],
                "match_id": rec.get("match_id") or "",
                "seed": rec.get("seed"),
                "max_ticks": rec.get("max_ticks"),
                "tick": st.get("tick"),
                "depth": st.get("depth"),
                "gold": st.get("gold"),
                "saved_at": rec.get("saved_at"),
            })
        except (OSError, ValueError):
            continue
    return out


def load_board() -> list:
    """顺手汇合 solver 的排行榜，PM 页按玩家聚合展示。"""
    p = os.path.join(data_dir(), "leaderboard-dungeon.json")
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return []


def do_save(req) -> tuple:
    name = safe_name(req.get("name"))
    st = req.get("state")
    if not name or not isinstance(st, dict):
        return 400, {"error": "name and state required"}
    rec = {
        "name": name,
        "match_id": str(req.get("match_id") or "")[:64],
        "seed": req.get("seed"),
        "max_ticks": req.get("max_ticks"),
        "state": st,
        "saved_at": int(time.time()),
    }
    path = save_path(name)
    with _LOCK:
        if len(list_saves()) >= MAX_SAVES and not os.path.exists(path):
            return 429, {"error": "too many saves"}
        if len(json.dumps(rec, ensure_ascii=False)) > MAX_BODY:
            return 413, {"error": "save too large"}
        atomic_write(path, rec)
    return 200, {"ok": True, "name": name}


def gateway_url() -> str:
    # 网关注入的服务地址（固定环境变量，无需 env_allow：它不是凭据，
    # 真正授权的是每局 token）。
    return (os.environ.get("GATEWAY_URL") or "http://127.0.0.1:6363").rstrip("/")


def _digest_of(st: dict) -> dict:
    """把桥接推来的完整 state 压成 PM 页要看的摘要（与 gm 脑席的 digest 同形）。"""
    hero = st.get("hero") if isinstance(st.get("hero"), dict) else {}
    foe = st.get("foe") if isinstance(st.get("foe"), dict) else None
    return {
        "tick": st.get("tick"),
        "depth": st.get("depth"),
        "gold": st.get("gold"),
        "potions": st.get("potions"),
        "kills": st.get("kills"),
        "boss_kills": st.get("boss_kills"),
        "hero": {k: hero.get(k) for k in ("hp", "hp_max", "atk")},
        "foe": ({"name": foe.get("name"), "hp": foe.get("hp"),
                 "hp_max": foe.get("hp_max"), "boss": foe.get("boss")} if foe else None),
        "pending": ({"title": (st.get("pending") or {}).get("title"),
                     "deadline_tick": (st.get("pending") or {}).get("deadline_tick")}
                    if isinstance(st.get("pending"), dict) else None),
        "inventory": (st.get("inventory") or [])[:16],
        "statuses": st.get("statuses") or {},
        "resumes": st.get("resumes") or 0,
        "log": (st.get("log") or [])[-6:],
    }


def remember_bridge(req: dict, key: str) -> None:
    """从网关推来的 observe 载荷里记下这一局的桥接凭证。"""
    if not key or not req.get("token"):
        return
    with _LOCK:
        _BRIDGE[key] = {
            "match_id": str(req.get("match_id") or ""),
            "token": str(req.get("token")),
            "ops_path": str(req.get("ops_path") or ""),
            "notify_path": str(req.get("notify_path") or ""),
            "ts": time.time(),
        }
        if len(_BRIDGE) > 32:  # 视图上限与 _LIVE 一致，别让桥接表无限增长
            for k in sorted(_BRIDGE, key=lambda k: _BRIDGE[k]["ts"])[:-32]:
                _BRIDGE.pop(k, None)


def _bridge_post(path: str, token: str, body: dict) -> bool:
    payload = json.dumps(body).encode()
    req = urllib.request.Request(
        gateway_url() + path, data=payload, method="POST",
        headers={"Content-Type": "application/json", "X-Match-Token": token},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return 200 <= resp.status < 300
    except Exception:  # noqa: BLE001 —— 对局可能已结束/卸载，交给回退路径
        return False


def post_ops(ops: list, key: str) -> bool:
    """把 GM 操作经 match bridge 直接投递给对局。返回是否走了桥接。

    桥接就绪时走后端直连：没有脑席中转、没有一 tick 的轮询延迟。还没收到
    该局的 observe 时返回 False，调用方回退到旧的队列 + gm 脑席路径。
    """
    with _LOCK:
        b = dict(_BRIDGE.get(str(key)) or {})
    if not b.get("token") or not b.get("ops_path"):
        return False
    return _bridge_post(b["ops_path"], b["token"], {"commands": {"gm": {"ops": ops}}})


def post_notice(key: str, notice: dict) -> bool:
    """经桥接向对局的 SSE 通道推一条带外事件（不进 state，不影响复盘）。"""
    with _LOCK:
        b = dict(_BRIDGE.get(str(key)) or {})
    if not b.get("token") or not b.get("notify_path"):
        return False
    return _bridge_post(b["notify_path"], b["token"], {"notice": notice})


def gateway_create_match(opts: dict) -> tuple:
    """代表玩家建局：用本服务自己的网关令牌（SVC_TOKEN）调 POST /v1/games。

    这是「浏览器不持有 operator 凭据」的关键一环——玩家页面把建局请求交给
    服务，服务用它被 manifest 授权的窄权限令牌去建。令牌只能建**本包**的对局
    （网关按对局所属的游戏名校验），也做不了别的网关操作。
    """
    tok = os.environ.get("SVC_TOKEN", "")
    if not tok:
        return 503, {"error": "gateway_access not granted to this service"}
    payload = json.dumps(opts).encode()
    req = urllib.request.Request(
        gateway_url() + "/v1/games", data=payload, method="POST",
        headers={"Content-Type": "application/json", "X-Service-Token": tok},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        raw = e.read().decode(errors="replace")
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, {"error": raw[:200]}
    except Exception as e:  # noqa: BLE001
        return 502, {"error": "gateway unreachable: %s" % e}


def queue_op(req) -> tuple:
    key = str(req.get("key") or "")
    op = req.get("op")
    if not key or op not in GM_OPS:
        return 400, {"error": "key and valid op required (ops: " + ", ".join(sorted(GM_OPS)) + ")"}
    args = req.get("args") if isinstance(req.get("args"), dict) else {}
    entry = {"op": op, **args}
    # 桥接就绪 → 后端直连投递（网关唤醒 tick loop，规则下一 tick 生效）。
    # 否则回退到队列，交给 gm 脑席 /poll 中转。
    if post_ops([entry], key):
        return 200, {"ok": True, "delivered": "bridge"}
    with _LOCK:
        _OPS.setdefault(key, []).append(entry)
        _OPS[key] = _OPS[key][-16:]  # 每局队列封顶
    return 200, {"ok": True, "queued": len(_OPS[key]), "delivered": "queue"}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path, _, qs = self.path.partition("?")
        path = path.rstrip("/")
        # 查询参数要解码：PM 页传的中文/带空格的文本是百分号编码的
        # （save 路径早就用了 unquote，这里之前漏了）。
        q = {k: urllib.parse.unquote(v) for k, v in
             (p.split("=", 1) for p in qs.split("&") if "=" in p)}
        if path == "/health":
            self._reply(200, {"ok": True, "svc": "pm"})
            return
        if path == "/live":
            with _LOCK:
                live = [
                    {"key": k, "age": int(time.time()) - int(v.get("ts", 0)),
                     "bridged": k in _BRIDGE, **v["observe"]}
                    for k, v in sorted(_LIVE.items())
                ]
                bridges = {
                    k: {"match_id": b["match_id"], "age": int(time.time()) - int(b["ts"])}
                    for k, b in sorted(_BRIDGE.items())
                }
            self._reply(200, {"matches": live, "bridged": bridges})
            return
        if path == "/announce":
            # 桥接带外消息：让后端能往游戏画面推东西，而不必污染 rules state
            # （不影响确定性复盘）。body: {"key":…, "text":…}
            key = q.get("key", "")
            text = q.get("text", "")
            if not key or not text:
                self._reply(400, {"error": "key and text required"})
                return
            ok = post_notice(key, {"text": str(text)[:200], "source": "pm"})
            self._reply(200 if ok else 409, {"ok": ok})
            return
        if path == "/poll":
            key = q.get("key", "")
            with _LOCK:
                ops = _OPS.pop(key, [])
            self._reply(200, {"ops": ops})
            return
        if path.startswith("/save/"):
            # 读存档免鉴权（与 solver 榜单同哲学：跨浏览器续玩不要求带 token）
            nm = q.get("name") or urllib.parse.unquote(path[len("/save/"):])
            p = save_path(nm)
            try:
                with open(p, encoding="utf-8") as f:
                    self._reply(200, json.load(f))
            except (OSError, ValueError):
                self._reply(404, {"error": "no save for " + nm})
            return
        if path == "/saves":
            self._reply(200, {"saves": list_saves(), "board": load_board()[-100:]})
            return
        if path == "/bankgen/result":
            # narrator 脑席非阻塞取货：任务没跑完就回 ready:false，不等待
            self._reply(200, bank_result())
            return
        self._reply(404, {"error": "unknown path"})

    def do_POST(self):
        raw_path = self.path
        path, _, qs = raw_path.partition("?")
        path = path.rstrip("/")
        if path not in ("/observe", "/op", "/save", "/poll", "/newmatch",
                        "/bankgen", "/bankgen/result"):
            self._reply(404, {"error": "unknown path, use POST /newmatch /observe /op /save /poll /bankgen"})
            return
        try:
            n = int(self.headers.get("Content-Length") or 0)
            req = json.loads(self.rfile.read(min(n, MAX_BODY)) or b"{}")
        except (ValueError, json.JSONDecodeError):
            self._reply(400, {"error": "bad json"})
            return
        if not isinstance(req, dict):
            self._reply(400, {"error": "body must be an object"})
            return
        # 脑席内部直连的 /observe /poll 不鉴权（supervisor 内网）；PM 页写操作鉴权
        if path in ("/op", "/save") and not authorized(self.headers):
            self._reply(403, {"error": "forbidden (X-Admin-Token)"})
            return
        if path == "/poll":
            # gm 脑席经 host.svc POST（query 或 body 带 key），取走即清空
            key = req.get("key") or dict(p.split("=", 1) for p in qs.split("&") if "=" in p).get("key", "")
            with _LOCK:
                ops = _OPS.pop(str(key), [])
            self._reply(200, {"ops": ops})
        elif path == "/bankgen":
            # narrator 脑席投递文案库补货任务（立即返回，LLM 在后台线程跑）
            code, resp = queue_bank_job(req)
            self._reply(code, resp)
        elif path == "/bankgen/result":
            # host.svc 只有 POST：脑席领货也走 POST（幂等读）
            self._reply(200, bank_result())
        elif path == "/observe":
            # 两种载荷：
            #  a) 网关 match bridge：{match_id, token, state, ops_path, …} —— 网关
            #     每个真实 tick 主动推，是本服务直连操纵对局的主路径。
            #  b) gm 脑席：{key, observe:{摘要}} —— 旧的中转路径，没有 token。
            # 适配在服务侧做：网关不该知道 pm 用 seed 当运行键。
            st = req.get("state")
            if req.get("token") and isinstance(st, dict):
                key = str(st.get("seed") or req.get("match_id") or "")
                ob = _digest_of(st)
                bridged = True
            else:
                key = str(req.get("key") or "")
                ob = req.get("observe")
                bridged = False
            if not key or not isinstance(ob, dict):
                self._reply(400, {"error": "need bridge payload (token+state) or key+observe"})
                return
            ob["ts"] = int(time.time())
            if bridged:
                remember_bridge(req, key)
            with _LOCK:
                _LIVE[key] = {"observe": ob, "ts": ob["ts"]}
                # 视图上限：内存演示用，超龄不清理会泄；保最近 32 局
                if len(_LIVE) > 32:
                    for k in sorted(_LIVE, key=lambda k: _LIVE[k]["ts"])[:-32]:
                        _LIVE.pop(k, None)
                        _OPS.pop(k, None)
                        _BRIDGE.pop(k, None)
            self._reply(200, {"ok": True, "bridged": bridged})
        elif path == "/newmatch":
            # 代表玩家建局（manifest gateway_access.create_matches）。玩家
            # 页面只跟服务说话，operator 凭据不必进浏览器。
            opts = req.get("match")
            if not isinstance(opts, dict) or not opts.get("game"):
                self._reply(400, {"error": "match object with a game is required"})
                return
            opts = dict(opts)
            opts.setdefault("game", "dungeon")
            if opts["game"] != "dungeon":
                # 本服务只被授权建本包的对局——网关也会再校验一次，这里先挡一道。
                self._reply(403, {"error": "this service may only create dungeon matches"})
                return
            code, resp = gateway_create_match(opts)
            self._reply(code, resp)
        elif path == "/op":
            code, resp = queue_op(req)
            self._reply(code, resp)
        else:
            code, resp = do_save(req)
            self._reply(code, resp)

    def do_DELETE(self):
        if not self.path.rstrip("/").startswith("/save/"):
            self._reply(404, {"error": "unknown path"})
            return
        if not authorized(self.headers):
            self._reply(403, {"error": "forbidden (X-Admin-Token)"})
            return
        nm = urllib.parse.unquote(self.path.rstrip("/")[len("/save/"):])
        p = save_path(nm)
        if os.path.exists(p):
            os.remove(p)
            self._reply(200, {"ok": True})
        else:
            self._reply(404, {"error": "no save for " + nm})

    def _reply(self, code, obj):
        b = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def log_message(self, *args):
        pass  # 安静：网关日志里只留进程级输出


if __name__ == "__main__":
    port = int(os.environ.get("SVC_PORT") or 8902)
    print(f"pm listening on 127.0.0.1:{port} (saves: {saves_dir()})", flush=True)
    if not pm_token():
        print("pm WARNING: PM_TOKEN 未设置——写操作（/op /save DELETE）对所有人开放，"
              "容器部署请在 compose 里设置 PM_TOKEN", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
