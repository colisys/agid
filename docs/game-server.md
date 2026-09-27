# 游戏服务器：网关即权威对局服

网关自己跑对局：服务端持状态、跑 tick loop、SSE 推送；AI 是 QuickJS 脑脚本；
Jev 只做策略选择与裁判；对局结束即卸载，只留战报。

## 跑起来

```bash
# 1. 配置 games_dir（configs/gateway.yaml 已带默认值 scripts/games）
# 2. 建局开打（admin token 鉴权）
curl -X POST localhost:8080/v1/games -H 'X-Admin-Token: $ADMIN_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"game":"rts","players":[{"brain":{"brain":"aggressive"}}],"tick_ms":500,"max_ticks":50}'
# 返回 {"match_id":"m_…","game":"rts","player_token":"mt_…"}

# 3. 观战（SSE）。EventSource 带不了自定义头，令牌走查询串：
curl -N "localhost:8080/v1/games/<id>/events?token=$PLAYER_TOKEN"

# 4. headless 快跑（直接返回 replay+评分，不开 SSE）
curl -X POST localhost:8080/v1/games -H 'X-Admin-Token: $ADMIN_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"game":"rts","players":[{"brain":{"brain":"aggressive"}},{"brain":{"brain":"defensive"}}],"headless":true,"max_ticks":50}'

# 5. gwadmin 快捷方式
gwadmin games create rts aggressive --headless max_ticks=50
gwadmin games list | show | stop | replay
gwadmin brains list|get|set rts <name> <version> <file>
gwadmin brains promote rts <name> <version>
gwadmin rules list|get|set <game> <version> <file>
gwadmin rules promote <game> <version>
```

## 职责边界

| JS 脑/规则脚本 | 外部后端服务（网关只给数据） |
| --- | --- |
| 系统 AI、剧情、quests、规则数值、脑 memory | 计分板、排位、业务结算、观战页 |

双向集成：对局事件 POST 到 `games.webhook_url`（HMAC 签名，失败重试 3 次丢弃，
不阻塞 tick）；外部以 `player:"director"` 注入剧情指令。

## 脚本热更新（优雅路线）

上传即新版本，不碰运行中对局；存量对局绑定建局版本跑完；`promote` 后新局生效；
建局参数可显式指定版本做灰度。

```bash
gwadmin brains set rts aggressive v2 ./aggressive.v2.js   # 上传候选版
# 灰度：建局时 {"brain":{"brain":"aggressive","version":"v2"}} 对比胜率
gwadmin brains promote rts aggressive v2                  # 切稳定版
```

## JS 契约

```js
// rules.js 必备导出
function newmatch(args) { return { state: {...} }; }   // 可选
function tick(args) { return { state, events }; }       // args={state, commands}
function snapshot(args) { return {...}; }               // args={state, player}
function over(args) { return { over: null } | { over: true, result: {...} }; }
// tick 返回 {wait:true} 表示本 tick 无棋可走（如轮到的人类还没落子）：不推进
// 状态、不计 tick、不推送，tick loop 就地挂起等命令，避免空转刷屏。

// brains/<name>.js 必备导出
function decide(args) { return { commands, memory }; }  // args={snapshot, memory}
// 可用宿主：host.intent(state)（Jev）、host.llm(provider, msgs)（仅解说）、
// host.svc(name, path, body)（JSON POST 到包内后端服务）、host.log
// memory cap 64KB；规则脚本禁止调 host.*（只算数）
```

## 推送（SSE）

`GET /v1/games/<id>/events` 是纯推送通道，不靠轮询：

- 订阅成功先推一条当前快照（棋盘/轮到谁），客户端据此首屏渲染，无需再补一次 GET。
- 之后只在真有事发生时推送：一次实打实的 tick、或 `over`。
- 轮到人类思考时通道完全静默（没有心跳消息）；落子命令到达即唤醒 tick loop，
  立刻推进，最多再按 `tick_ms` 间隔补一步（人走完 → AI 应手）。
- `wait` 行为只对有外部座位的对局生效：全脑对局（如 RTS）仍按 `tick_ms` 实时推进。
- 结束时（自然结束 **或** `POST /stop`）都会推一条 `event: over` 再关闭连接，
  前端据此收尾并渲染结算；被操作者停掉的局同样会收到，不会只看到连接断掉。

## 实测（fake Jev，2026-09-24）

- 单脑 headless 30 tick：策略随战况变化（harass 运营），replay 完整。
- 双脑 headless 20 tick：p0/p1 各自决策，互不干扰。
- 实时局 SSE：`event: tick` 流正常，结束自动卸载（live 查 404，replay 可查）。
- 版本灰度：v3（硬编码 tech）promote 后新局全 tech；按版本建局生效。
- 鉴权：无 token/租户 key 调 `/v1/games/*` 均 401。

## manifest.json 与 /play 托管

游戏包是三级目录布局，`manifest.json` 放在游戏根目录做**自描述**——网关只认 manifest，
`games_dir` 各根下找不到 `manifest.json` 的目录直接跳过（不建局、不托管）。

```text
<games_dir 根>/<游戏名>/          ← 游戏包根（含 manifest.json）
  manifest.json
  rules.js 或 rules.<ver>.js     ← rules 字段填基名 "rules"（缺省即 "rules"）
  brains/<name>.js               ← brains_dir 字段（缺省 "brains"）
  ui/<变体>/                     ← ui_dir 字段（缺省 "ui"），每个子目录是一个独立静态站
  services/*.py                  ← services 声明的后端服务入口
```

manifest schema（字段缺省值合理，最小只需 `{"name": "..."}`）：

```json
{
  "name": "地牢探险",
  "rules": "rules",              // 规则脚本基名（rules.js / rules.v2.js）
  "brains_dir": "brains",        // 脑脚本目录（单段路径名，禁 ..）
  "ui_dir": "ui",                // UI 变体根目录
  "capabilities": {              // 每个 brain 申请的能力，fail-closed
    "adventurer": [],            // 什么都不给
    "sage": ["jev", "svc:solver"],
    "narrator": ["llm"]
  },
  "services": {                  // 包内后端服务（内置 python 运行时，网关直接 spawn）
    "solver": { "runtime": "python", "entry": "services/solver.py", "port": 8901,
                "data_dir": "dungeon" },
    "pm": {
      "runtime": "python", "entry": "services/pm.py", "port": 8902,
      "data_dir": "dungeon",           // 与 solver 共享：pm 要读 solver 写的榜单
      "env_allow": ["LLM_UPSTREAM_URL", "LLM_UPSTREAM_KEY", "LLM_UPSTREAM_MODEL"],
      "match_access": {
        "observe": "full",              // 网关每 tick 主动推完整 state（"digest" 为有界摘要）
        "commands": ["gm"],             // 允许投递的通道名，fail-closed
        "notify": true,                 // 允许向 SSE 推带外事件
        "timeout_ms": 3000
      },
      "sandbox": { "profile": "strict", "memory_mb": 256, "cpu_s": 300, "max_file_mb": 64 }
    }
  }
}
```

能力词表：`llm`（host.llm）、`jev`（host.intent）、`svc:<服务名>`（host.svc 调对应服务）。
**fail-closed**：没在 capabilities 里声明的脑只拿到 `host.log`，调 `host.llm/intent/svc`
直接抛 `not available`；`svc:` 只放行点名的服务，白名单在建局时快照进对局，
对局中途改 manifest 不影响存量局。规则席固定只有 `log`。

### 服务的环境与沙箱（fail-closed）

服务进程**不从网关继承环境变量**。子进程的完整环境是一组固定值
（`PATH` / `HOME`（指向包根）/ `LANG` / `PYTHONUNBUFFERED` /
`PYTHONDONTWRITEBYTECODE` / `SVC_PORT` / `SVC_NAME` / `GAME` / `GAME_ROOT` /
`SVC_DATA` / `SVC_SANDBOX`），加上 `env_allow` 显式点名的变量。

**网关运营凭据永远不给托管代码** —— `ADMIN_TOKEN` / `TYPESAFE_API_KEY` /
`LLM_API_KEY` 等在硬拒名单里，`env_allow` 写了会在 manifest 解析时报错，
而不是被静默丢弃。（`LLM_UPSTREAM_KEY` 这类包级业务凭据可以申请：包的
`rules.js` / `brains/*.js` 本来就在同一信任域。）

`sandbox` 走 `prlimit`（缺省退回 `sh` + `ulimit`）限制内存 / CPU / 文件大小。
`max_procs` **默认不开** —— RLIMIT_NPROC 按真实 UID 而非按进程计数，实测该 UID
已有约 6 万进程，设小了会让该用户的其他 fork 一起失败。

`profile: "off"` 退化为继承网关全部环境变量（含 `ADMIN_TOKEN`），仅供本地调试，
spawn 时会打警告。

详见 `docs/services-design.md`。

### 工作目录与数据区

- **`workdir`**（服务级，相对包根，默认 `.`）= 进程 cwd。`entry` 仍相对包根解析，
  两者独立，所以老包不受影响。
- **`data_dir`**（服务级，相对 `games.data_root`，默认 `<game>/<service>`）=
  这个服务唯一可写的持久区。网关建好目录后以 **`SVC_DATA`** 注入绝对路径；
  服务不需要、也不允许再从 `__file__` 往上爬去猜存放位置。

同一个游戏里需要共享文件的服务声明相同的 `data_dir`（地牢的 `solver` 与 `pm`
都要读写榜单，于是都写 `"data_dir": "dungeon"`）。默认则是每服务一个目录，互不干扰。

`games.data_root`（默认 `data`）由 `service.sh install` 写成**绝对路径** ——
用户级 systemd 单元没有 `WorkingDirectory`，cwd 是 `$HOME`，相对路径会解析到
`<HOME>/data` 而不是仓库目录。

### 鉴权：两级令牌

`/v1/games/*` 认两种凭据：

| 凭据 | 取得方式 | 能做什么 |
| --- | --- | --- |
| **operator token** | `ADMIN_TOKEN` | 全部：建局、列表、停局、复盘、`/admin/*` |
| **player_token** | `POST /v1/games` 的响应里 | **仅该局**：快照、事件流、指令 |

`player_token` 是 per-match 的 128 位随机值，只能打开**它自己那一局**（拿它去开
别的对局或不存在的对局一律 401）。停局（`/stop`）和复盘（`/replay`）即使拿着本局
令牌也返回 403 —— 结束别人的游戏不是玩家的事。

这样玩家浏览器在**整条地牢链路上**不再需要 operator 凭据：建局由包内后端用
自己的 `SVC_TOKEN` 代劳（见下节），对局闭环用 `player_token`，只有 pm 自己的
写接口（`/save` 等）仍走 operator token —— 那一层的跨对局身份需要真正的账号
体系，超出本步范围。

### `/svc` 读写分离（fail-closed）

包内服务经 `/svc/<game>/<service>/…` 暴露。**只有 manifest 里 `http.public`
显式声明的路由免凭据**，其余一律要求 operator token：

```jsonc
"http": { "public": ["GET /health", "GET /top", "POST /score"] }
```

- 条目是 `"<METHOD> <path>"`，路径可以以 `/*` 结尾覆盖一个集合的子路径
  （`"GET /save/*"`）。**方法也在匹配里** —— 否则声明 `GET /save/*` 会连带
  暴露同路径的 `DELETE`，那正是删掉别人存档的入口。
- **fail-closed**：没声明就是需要 token，无论服务自己怎么想。此前 `/svc/*` 完全
  开放、靠每个服务自查，而其中两个没查。
- 声明写错（缺方法、缺路径）会在 manifest 解析时报错，不会被静默丢进一个
  作者没预期的策略。

服务仍然看得到 token，可以在网关之上再做自己的校验（地牢的 pm 仍校验
`PM_TOKEN`）。

### 服务级凭据：后端代为建局

上面说的「玩家浏览器不需要 operator 凭据」，靠的是让**后端服务代建局** ——
这正是网关要在自己这边托管 Python 运行时的原因：后端是可以持有凭据、而浏览器
不该持有的那一层。

manifest 里声明：

```jsonc
"services": {
  "pm": {
    "http": { "public": ["GET /health", "POST /newmatch"] },
    "gateway_access": { "create_matches": true, "stop_matches": true }
  }
}
```

网关为每个声明了 `gateway_access` 的服务铸造一个 **per-service token**
（`SVC_TOKEN`，与 `GATEWAY_URL` 一样是固定注入的环境变量），于是：

```text
浏览器 ──POST /svc/dungeon/pm/newmatch（无需凭据）──▶ pm 服务
pm     ──POST /v1/games（X-Service-Token: SVC_TOKEN）──▶ 网关
网关   ──▶ 权威对局，回给服务 match_id + player_token
pm     ──▶ 浏览器 {match_id, player_token}
```

之后浏览器全程只用 `player_token`。这条链路上**没有任何一步需要 admin**。

`SVC_TOKEN` 严格窄于 operator token，而且**不能**通过 `env_allow` 拿到 admin
（那在 manifest 解析期就是硬错误）：

| 尝试 | 结果 |
| --- | --- |
| 用 `SVC_TOKEN` 建**别的**包的对局 | 401（按**请求里**的游戏名校验） |
| 用 `SVC_TOKEN` 列出全部对局 | 401 |
| 用 `SVC_TOKEN` 访问 `/admin/*` | 401 |
| 用 `SVC_TOKEN` 停**自己包**的对局 | 200 |
| 在 manifest 里 `env_allow: ["ADMIN_TOKEN"]` | manifest 解析报错，服务不启动 |

停局时校验用的是**活对局实际所属的游戏**，不是请求声称的，所以令牌无法被指向
不属于它的对局。

### 后端服务（/svc）

manifest.services 里的 python 服务由网关监管：建局前随网关启动 spawn
（`python3 entry`，工作目录=包根，注入 `SVC_PORT/GAME/GAME_ROOT/SVC_NAME` 环境变量），
TCP 就绪探测、崩溃指数退避重启（1s→30s 封顶，连败 5 次放弃），网关退出时整组回收。

两个消费方：

- **UI**：`/svc/<game>/<service>/<path>` 反向代理到服务进程（strip 前缀转发）；
  鉴权由 manifest 的 `http.public` 决定（见上「/svc 读写分离」），未声明的服务
  404、宕机 503；
- **脑**：`host.svc(name, path, body)` 是阻塞 JSON POST，返回 JSON 对象，
  非 2xx 抛错、非 JSON 转成 `{text: ...}`。

```bash
curl -X POST localhost:8080/svc/dungeon/solver/hint -d '{"hp":3,"depth":2}'
```

### match bridge：后端直接操纵对局

服务不必再靠「排队 + 某个脑席轮询中转」来操作 state。manifest 里声明
`match_access` 后，网关在建局时为每个服务铸造一个 **per-match token**：

```text
网关 ──POST /observe（每 tick）──▶ 服务
      payload: {match_id, token, gateway, ops_path, notify_path, state}

服务 ──POST /v1/internal/matches/<id>/ops────▶ 网关校验通道白名单
                                                   │ 塞进保留席位 __svc__
                                                   ▼ 唤醒 tick loop
                                              rules.tick()  ← 唯一状态写入口

服务 ──POST /v1/internal/matches/<id>/notify─▶ SSE event: notice（不进 state）
```

要点：

- **不需要脑席在场**。之前后端要有人操纵，必须先起一个 gm 脑席；现在没有也行。
- **不冒充玩家座位**。后端的指令落在保留席位 `__svc__` 上，规则用同一个读取器
  取（`pickBrain` 先扫 `__svc__` 再扫 `p0..p7`）。复盘时一眼能分清「玩家做的」
  和「后台做的」。
- **通道白名单 fail-closed**。`commands` 没列的通道直接 403；合法性仍然全部归
  规则，网关只管「哪个服务能说哪个通道」。
- **一次性消费**。和人类座位一样，指令只在下一个 tick 生效一次，不会重放。
- **带外事件不进 state**。`notify` 走独立的 SSE 事件类型，聊天式后端不会污染
  状态、不会打乱确定性复盘。
- **观测推送是 fire-and-forget**。慢或挂掉的服务只影响它自己，绝不拖住 tick loop。

授权用 `X-Match-Token` 头（不放 body，避免进访问日志）。token 是 **per-match 且
per-service** 的：泄露一个后端的 token 不能操作别的对局、别的游戏或别的服务。
服务从 `GATEWAY_URL`（网关注入，非凭据）知道往哪投递。

**旧路径已删除**：地牢的 gm 脑席中转（`gm.ts`、`/poll`、`_OPS` 队列）已在
match bridge 落地后整体移除——pm 服务只认 bridge 载荷，桥接凭证未就绪时
`/op` 返回 409 让调用方重试。

### 容器隔离（compose 配置生成）

网关**只生成配置不执行**。`POST /admin/compose`（admin token）把当前所有
manifest 声明的服务编成一份 docker-compose.yml（python:3.12-slim、包根只读挂载、
requirements 自动装进 `/tmp` 下的 venv、127.0.0.1 端口映射）：

- `read_only: true` + `cap_drop: [ALL]` + `security_opt: no-new-privileges`
- `tmpfs: /tmp` —— 只读根文件系统里唯一可写处，依赖装这里
- 每个服务只挂自己的数据区：`<data_root>/<data_dir>:/data`（与 dev 模式的
  `SVC_DATA` 同一相对位置），不再用共享卷
- `environment` 是**完整集合不做继承**；`env_allow` 的值不进 YAML，而是写进
  同目录的 `env.<game>-<service>.env`（600 权限，`service.sh compose` 落盘）——
  compose 是可读、可分享的产物，密钥内联进去就会跟着进 git、工单或 `/admin` 响应
- 卷源强制转绝对路径：`games_dir` 通常是相对的（出厂配置 `examples,scripts/games`），
  而 docker 是拿**compose 文件所在目录**解析相对卷的，转发路径不对会静默挂错

```bash
scripts/service.sh compose        # 生成 data/compose-<主机名>.yml + data/env.*.env
docker compose -f data/compose-<主机名>.yml up -d
```

生成用的 ref 列表与本地 spawn 用的是同一份（`store.ServiceRefs()`），
所以容器编排和 dev 进程不会各写一套而漂移。

### /play：UI 静态托管

`GET /play/<game>/` 服务三级布局里的 UI 变体，UI 可用任意前端技术栈构建后整目录放入：

- 0 个变体：404（纯后端游戏）；1 个变体：302 直达；多变体：内置选择页（标题取 manifest.name）。
- 只 serve `ui/<变体>/` 下的文件：`rules.js`、`brains/*.js` 等脚本不再公开（404）。
- SPA 回退：末段无扩展名且文件不存在 → 200 该变体的 index.html；带扩展名 → 404。
- 路径穿越（`..`、反斜杠）拒绝；文件服务用 ServeContent，不发规范化 301 泄露盘上布局。

```bash
# 多变体示例：ui/app/（Vue 版）与 ui/wap/（单文件版）各一个站
curl localhost:8080/play/dungeon/             # 变体选择页（单变体时 302 直达）
curl localhost:8080/play/dungeon/app/         # 200 index.html
curl localhost:8080/play/dungeon/rules.js     # 404（脚本不公开）
```
