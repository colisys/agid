# 游戏包后端服务：发现与设计稿

> 状态：第 1–4 步**全部实现并验证**。
> 实现说明见 `docs/game-server.md` 的「服务的环境与沙箱」「工作目录与数据区」
> 「match bridge」「鉴权：两级令牌」「/svc 读写分离」五节。
> 相关既有文档：`docs/game-server.md`（对局服务器与 manifest 布局）、`docs/service.md`（systemd 运维）。

## 1. 起因

原意是四件事，但逐条核对代码后发现实现程度不一：

1. manifest 指定工作目录
2. 网关托管 Python 后端代码并沙箱隔离运行
3. 后端代码能操作前端 state
4. 前端可直接访问网关相关接口

## 2. 现状对照

| 意图 | 现状 | 差距 |
| --- | --- | --- |
| manifest 指定工作目录 | `services.Ref.Dir` 硬编码为包根（`cmd/gateway/main.go` 建 Ref 处），manifest 无对应字段 | 所有服务共享包根，无独立工作目录 / 数据区 |
| 沙箱隔离 | 仅 `Setpgid`（`internal/services/supervisor.go:129`）+ compose 侧 `:ro` 挂载 | dev 模式零隔离；存在权限提升路径（见 §3.1） |
| 后端操作 state | pm 服务排队 → **gm 脑席 `/poll` 中转** → `commands.gm` → `rules.ts` 白名单 | 依赖脑席在场、每 tick 轮询、白名单双写、后端只能看到脑席转发的那份摘要 |
| 前端访问网关 | `/svc/<game>/<svc>/…` 反代（无鉴权，`internal/api/svc.go:12`）；`/v1/games/*` 要 admin token（`internal/api/games.go:27`） | 前端要么握 admin 全权，要么走完全裸奔的 svc 面 |

## 3. 三个需要先处理的问题

### 3.1 托管代码继承了网关的 admin 凭据（权限提升）

`internal/services/supervisor.go:130` 用 `cmd.Env = append(os.Environ(), …)`，被托管的 Python 服务
继承网关进程的**全部**环境变量。systemd 注入的 env 文件里有 `ADMIN_TOKEN` / `TYPESAFE_API_KEY` /
`LLM_API_KEY`（键名见 `docs/service.md:22`）。

因此包内任何一行 `os.environ["ADMIN_TOKEN"]` 都能通过网关的任意 admin 端点。
`examples/dungeon/services/pm.py:206` 自己在做 token 校验，但防的恰好是它本来就不缺的权限。

`SKILL` 文档里"模型永远拿不到密钥"的纪律，在这层被完整绕过。

> **凭据分两类**，这是本项目的信任边界：
> - **网关运营凭据**（`ADMIN_TOKEN`、Jev key）：属于网关操作面，托管代码**永远拿不到**。
> - **包级业务凭据**（如 LLM 上游）：包可信度与 `rules.js` / `brains/*.js` 同级，可由 manifest 显式申请。

### 3.2 `/svc/*` 数据面全裸

`internal/api/svc.go:12` 明确无鉴权（"与 /play 同一信任域"）。于是
`GET /svc/dungeon/pm/saves` 可列出全部玩家存档（含完整 state），`/live` 可列出全部活局快照。
"读接口公开（跨浏览器续玩不要求带 token）"是有意选择，但把用户数据一起公开了。

### 3.3 玩家浏览器握的是 admin token

`/v1/games/*` 全走 `AdminGuard`，前端把 admin token 存进 localStorage。
知道 match_id 就能 `stop` / `replay` 任意对局。

### 3.4 数据位置 dev / 容器不一致

`pm.py` 的 `data_dir()` 靠 `__file__` 往上爬三级找仓库 `data/`；compose 里则被换成 `SVC_DATA=/data`。
同一份代码两个数据位置——这是"没有 manifest 数据区"的直接后果。
另外服务会往包内写 `__pycache__`（包根在容器里是 `:ro`，dev 下没有保护）。

## 4. 设计提案

### 4.1 manifest 成为工作目录与权限的唯一声明源

```jsonc
{
  "name": "地牢探险",
  "services": {
    "pm": {
      "entry": "services/pm.py",
      "port": 8902,
      "workdir": ".",              // 进程 cwd（相对包根）
      "data_dir": "data/pm",       // 唯一可写区
      "env_allow": ["LLM_UPSTREAM_URL", "LLM_UPSTREAM_KEY", "LLM_UPSTREAM_MODEL"],
      "sandbox": { "profile": "strict", "memory_mb": 256, "pids": 64, "cpu_s": 300 },
      "match_access": {
        "observe": "full",         // 网关每 tick 主动推；"full" | "digest" | 路径投影
        "commands": ["gm"],        // 可投递的指令通道（fail-closed，同 capabilities 思路）
        "notify": true             // 允许向 SSE 插带外事件
      }
    }
  }
}
```

`data_dir` 落地后，dev 解析为 `<包根>/data/pm`（只给写权限），compose 挂到 `/data`，
§3.4 的路径 hack 自然消失。

### 4.2 沙箱分档

**`strict`（默认）**
- 环境变量**不再继承**：固定集仅 `PATH / HOME / LANG / LC_ALL / PYTHONUNBUFFERED /
  PYTHONDONTWRITEBYTECODE / SVC_PORT / SVC_NAME / GAME / GAME_ROOT / SVC_DATA / SVC_SANDBOX`；
  额外变量由 `env_allow` 显式放行，且网关运营凭据进硬拒名单（纵深防御）。
- 资源限制：`prlimit`（本机已确认可用）设内存 / 进程数 / CPU / 文件大小上限。
- 可写区仅 `data_dir`；包根只读。
- 附注：本机 `bwrap` 可用，可作为将来的 `bwrap` 档（真 user namespace 隔离），但它会切断
  服务对网关的访问，需额外配 veth 或宿主代理才能保留 §4.3 的链路——**本期不做**。

**compose 侧加固**：`read_only: true` + `cap_drop: [ALL]` + `security_opt: no-new-privileges`。

### 4.3 后端 ↔ state 变成网关直连的一等通道（ServiceBridge）

取代"脑席中转"：

```
pm.py ──POST /v1/internal/matches/<id>/ops────▶ 网关校验 commands 白名单
                                                    │ 塞进该局 commands
                                                    ▼ nudge 唤醒 tick loop
                                               rules.tick()   ← 唯一状态写入口
pm.py ◀──POST /__gw/observe（网关每 tick 主动推）──
pm.py ──POST /v1/internal/matches/<id>/notify──▶ SSE 带外事件（不进 state、不污染 replay）
```

收益：
- 不再需要 gm 脑席在场，后端才有操纵能力；
- 推送替代轮询（现在是一 tick 一次 `/poll`）；
- **`notify` 是当前架构最缺的能力**——后端想往游戏画面显示任何东西，现在唯一路径是污染 rules state；
- 白名单只在 manifest 写一次，`pm.py` 与 `rules.ts` 的双份定义不再漂移
  （规则侧保留第二道校验，防绕过网关直调）。

### 4.4 per-match 玩家令牌

`POST /v1/games` 返回 `{match_id, player_token}`（128bit 随机，只对该局有效）。
网关把 `Authorization: Bearer <admin>` 与 `?token=<player>` 归一成同一 principal：
admin 全权、player 限本局。前端从此不再需要 admin token。
`/svc` 配合读写分离：读接口按需公开，写操作要求 admin。

## 5. 已确认的决策

| 议题 | 决定 |
| --- | --- |
| 沙箱强度 | 分档：strict 用 env 白名单 + rlimit + 可写区限制；compose 补 `read_only`/`cap_drop`。**不引入 bubblewrap** |
| 鉴权范围 | 一起做：per-match `player_token` + `/svc` 读写分离（会改现有 UI 的凭证用法） |
| 实施顺序 | ① env 隔离 → ② workdir/data_dir → ③ ServiceBridge → ④ 鉴权 |

## 6. 实施顺序与可独立验证点

1. **env 隔离** — ✅ 已完成（2026-09-27）
   `supervisor.go` 改 env 白名单 + `prlimit`；`manifest.go` 加 `env_allow`/`sandbox`
   字段与校验；`EmitCompose` 加固；`main.go` 接线。
   实施中额外修掉的两个问题见 §6.1。
2. **workdir / data_dir** — ✅ 已完成（2026-09-27）
   manifest 加服务级 `workdir` / `data_dir`，`SVC_DATA` 由网关解析后注入并建好目录；
   compose 侧改为每服务挂自己的数据区；`pm.py` / `solver.py` 删掉 `../../..` 猜测。
   额外发现并修掉的问题见 §6.1、§6.2。
   实测：dev 下两个服务都解析到 `data/dungeon/`，跨服务共享成立（pm 能读到
   solver 写的 15 条榜单），文案生成通路不受影响（`/bankgen` 返回真实短句）。
3. **ServiceBridge** — ✅ 已完成（2026-09-27）
   Match 挂 per-match/per-service token；网关每 tick 主动推 observe；
   `/ops` 投递唤醒 tick loop；`notify` 推 SSE 带外事件。实现与验证见
   `docs/game-server.md`「match bridge」一节。
   实测（座位里**没有 gm 脑席**）：pm 收到 `bridged: true`、投递返回
   `delivered: "bridge"`、金币 104→633 且日志出现 `[后台] 金币 +500`、
   notice 以独立 `event: notice` 到达且 `notice in state: False`。
4. **鉴权** — ✅ 已完成（2026-09-27）
   per-match `player_token`（建局响应下发，只管本局的快照/事件流/指令；停局与
   复盘即使持本局令牌也 403）；`/svc` 改为 manifest `http.public` 声明式、
   fail-closed 的读写分离。说明见 `docs/game-server.md`「鉴权：两级令牌」
   「/svc 读写分离」。
   实测：只带 player_token 走通快照 200 / 指令 200 / SSE 收到 7 个事件；
   停局 403、列全部对局 401、无 token 401；`/svc/dungeon/solver/top` 免 token
   200 而 `/svc/dungeon/pm/saves` 免 token 401、带 admin token 200。

   **补：服务级凭据**（浏览器彻底不碰 admin）。`gateway_access` 声明的服务获得
   per-service `SVC_TOKEN`，用它代玩家建局；说明见 `docs/game-server.md`
   「服务级凭据：后端代为建局」。
   实测：`POST /svc/dungeon/pm/newmatch` 零凭据建局成功并回 player_token，
   之后快照/指令/事件流全通；`SVC_TOKEN` 建别的包(401)、列全部对局(401)、
   访问 `/admin/*`(401)，停自己包的对局(200)；pm 进程 env 里网关密钥数量为 0。

### 6.1 修掉的既有问题

- **compose 卷路径是相对的**。`composeVolume` 只做了 `Clean` 没做 `Abs`，而出厂
  `games_dir: "examples,scripts/games"` 就是相对的。docker 拿 **compose 文件所在目录**
  解析相对卷，而生成的文件落在操作者当时的工作目录 —— 挂载会静默指向错误路径
  （或自动建出一个空目录）。原测试喂的是绝对路径，恰好掩盖了它。已修 + 补回归测试。

- **`ServiceRefs()` 静默吞掉坏 manifest**。原先 `main.go` 自己遍历游戏包，遇到
  manifest 解析失败会打日志；为了让 dev spawn 和 compose 共用一份 ref 列表
  （`store.ServiceRefs()`），这段遍历被合并掉了，日志也一起丢了。后果是：一个
  `env_allow` 写错的包会毫无征兆地不启动服务。已补 `games.services` 审计日志。

- **`admin.ServiceRefs()` 原本不带 `ExtraEnv`**，所以生成的 compose 里从来没有
  `LLM_UPSTREAM_*` —— 容器模式下 pm 的文案生成一直是坏的。现在两条路径共用
  `ServiceDef.Ref()`，不会再漂移。

### 6.2 第 2 步中发现的问题

- **compose 会内联密钥**。为了修上一条而让 `ServiceRefs()` 带上 LLM 候选池，
  结果 `EmitCompose` 把 `LLM_UPSTREAM_KEY` 的**明文值写进了 YAML**。compose 是
  可读、可分享的产物 —— 它会被提交、被贴进工单、被 `/admin/compose` 原样返回。
  已改为：YAML 里只写 `env_file: env.<game>-<service>.env`，值由
  `service.sh compose` 落成 600 权限的同目录文件。dev 与 compose 两条路径现在
  共用同一个 `allowedEnv()`，不会再出现一边有一边没有。

- **相对路径依赖进程 cwd**。`service.sh install` 的「全新拷贝」分支原样复制
  `configs/gateway.yaml`（相对 `games_dir` / 相对 `data_root`），而「老配置回填」
  分支写的却是绝对路径——两处不一致。用户级 systemd 单元没有 `WorkingDirectory`，
  cwd 是 `$HOME`，相对路径会解析到 `<HOME>/examples`（不存在）与 `<HOME>/data`。
  已加 `absolutize_config()`，安装时把两个键统一改写成绝对路径，新旧配置都过一遍。

## 7. 与其他 agent 的协作注意

`examples/dungeon/**` 当前有另一个 agent 在改业务代码。分工：

- **Go 侧**（`internal/services`、`internal/game`、`internal/admin`、
  `internal/api`、`cmd/gateway`）归本文档的实施者；
- **地牢侧**（`examples/dungeon/**`）在对方收工后再动。

第 1 步为了不引入功能回归，只增改了 `examples/dungeon/manifest.json` 的 `pm`
服务（加 `env_allow` 三个变量 + `sandbox` 限额，共 9 行）—— 这是让 pm 的
`/bankgen` 文案生成继续可用的最小改动。`pm.py`、`src/brains/gm.ts`、`ui/*`
均未触碰。

`gm.ts` / `pm.py` 的中转逻辑在第 3 步之后会成为可删代码，**暂不提前动**。
