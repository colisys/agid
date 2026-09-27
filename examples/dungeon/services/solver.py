#!/usr/bin/env python3
"""solver: 地牢战术提示 + 下潜排行榜服务（dogfood 示例，纯标准库，无第三方依赖）。

由网关按 manifest.json 的 services 声明托管（SVC_PORT 注入端口），两条消费路径：
  1. UI/外部:   /svc/dungeon/solver/hint 等  （网关反向代理）
  2. sage 脑:   host.svc("solver", "/hint", {...})  （需 capabilities 声明 svc:solver）

POST /hint
  {"hp": 12, "hp_max": 36, "depth": 2, "foe": "精英·腐骨兵", "foe_intent": "剧毒"}
-> {"hint": "血量不足四成，优先喝药或格挡回稳"}

POST /score   下潜成绩入库（死亡结算时 UI 提交）
  {"name": "无名者", "depth": 7, "boss_kills": 1, "ticks": 92, "seed": 42}
-> {"ok": true, "rank": 3}
GET  /top     前 20 名（按深度降序）
-> {"entries": [{"name":..., "depth":..., "boss_kills":..., "ticks":..., "seed":..., "ts":...}]}

排行榜持久化在 <SVC_DATA>/leaderboard-dungeon.json。SVC_DATA 由网关按 manifest
的 data_dir 解析后注入（dev 指向 games.data_root 下的目录，容器里是 /data 挂载点），
服务不需要也不能自己推断存放位置。
"""
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_BODY = 64 * 1024
TOP_N = 20

_LOCK = threading.Lock()


def data_dir() -> str:
    # 网关保证 SVC_DATA 一定存在（services.Ref.dataDir 建好目录再注入）。
    # 手工直接跑本脚本时退回脚本同级目录，仅为方便本地调试。
    return os.environ.get("SVC_DATA") or os.path.dirname(os.path.abspath(__file__))


def board_path() -> str:
    return os.path.join(data_dir(), "leaderboard-dungeon.json")


def load_board() -> list:
    try:
        with open(board_path(), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return []


def save_board(entries: list) -> None:
    os.makedirs(data_dir(), exist_ok=True)
    tmp = board_path() + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(entries, f, ensure_ascii=False, indent=1)
    os.replace(tmp, board_path())  # 原子落盘，防写一半损坏


def key(e: dict):
    return (-int(e.get("depth") or 0), -int(e.get("boss_kills") or 0), int(e.get("ticks") or 0))


def add_score(req: dict) -> dict:
    entry = {
        "name": str(req.get("name") or "无名者")[:24],
        "depth": max(1, int(req.get("depth") or 1)),
        "boss_kills": max(0, int(req.get("boss_kills") or 0)),
        "ticks": max(0, int(req.get("ticks") or 0)),
        "seed": req.get("seed"),
        "resumes": max(0, int(req.get("resumes") or 0)),  # 续命次数（存档恢复）
        "ts": int(time.time()),
    }
    with _LOCK:
        board = load_board()
        board.append(entry)
        board.sort(key=key)
        board = board[:TOP_N]
        save_board(board)
    rank = next((i + 1 for i, e in enumerate(board) if e is entry or e.get("ts") == entry["ts"] and e == entry), None)
    return {"ok": True, "rank": rank}


def top_scores() -> dict:
    with _LOCK:
        return {"entries": load_board()}


def hint_for(req: dict) -> str:
    hp = float(req.get("hp") or 0)
    hp_max = float(req.get("hp_max") or 0) or 1.0
    depth = int(req.get("depth") or 1)
    foe = str(req.get("foe") or "")
    intent = str(req.get("foe_intent") or "")
    ratio = hp / hp_max

    if ratio < 0.2:
        return "命悬一线，能逃则逃，否则喝大药搏一线生机"
    if ratio < 0.35:
        return "血量不足四成，优先喝药或格挡回稳"
    if "守主" in foe or "地牢之主" in foe:
        return "守主 attacking！换上最好的装备，药水全带上，残血就格挡回稳"
    if "精英" in foe and intent == "狂暴":
        return "精英正在狂暴，这回合格挡接它的爆发"
    if "精英" in foe and intent == "剧毒":
        return "剧毒精英会叠毒，速战速决别拖回合"
    if "精英" in foe:
        return "精英皮糙肉厚，留好药水再拼刀"
    if depth % 5 == 4:
        return "下一层就是守主巢穴，先补满状态再下"
    if depth >= 4:
        return "深处怪物渐强，没有把握就别贪宝箱"
    return "状态尚可，正常换防推进即可"


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.rstrip("/") == "/top":
            self._reply(200, top_scores())
            return
        self._reply(404, {"error": "unknown path, use GET /top"})

    def do_POST(self):
        path = self.path.rstrip("/")
        if path not in ("/hint", "/score"):
            self._reply(404, {"error": "unknown path, use POST /hint or POST /score"})
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
        print(f"{path} <- {req}", flush=True)  # 经网关 lineWriter 进服务日志，用于确认调用方
        if path == "/hint":
            self._reply(200, {"hint": hint_for(req)})
        else:
            self._reply(200, add_score(req))

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
    port = int(os.environ.get("SVC_PORT") or 8901)
    print(f"solver listening on 127.0.0.1:{port} (board: {board_path()})", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
