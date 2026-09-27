# 地牢探险（Dungeon）

实时策略小游戏的示例：**服务端 tick 驱动 + 确定性随机 + 道具/事件内容表 + Jev 低频决策 + LLM 极短文案**。
和井字棋（回合制、纯数值）互补，这个包演示几件事：

1. 行为驱动：世界只在玩家下指令时推进一轮（rules.tick 对无指令的 tick 返回 `wait`，
   引擎挂起等命令，指令一到立即结算——不操作就静止，不会被怪物单方面殴打）；
   指令是**姿态**（攻击/格挡/喝药/逃跑/下潜），每按一次结算一轮。全脑局
   （headless/演示）脑席每 tick 都发指令，仍按 `tick_ms` 节流实时推进。
2. 确定性随机：随机源是 `state.rng` 里的 32 位 PRNG 状态，**同 seed + 同指令序列 → 同终局**，
   headless 跑得快、可复现，能直接做「改脑脚本 → 跑 N 局 → 看胜率」。
3. 内容即数据：19 件道具、6 类事件房、精英怪、状态效果（中毒/灼烧/圣盾/巨力）全部是
   `rules.js` 里的表——前端靠快照里的 `catalog` 渲染道具，脑靠它评估换装，没有硬编码数值。
4. 职责边界：规则脚本只算数（**不碰 `host.*`**）；模型能力只出现在大脑席——
   `narrator.js` 用 `host.llm` 写 ≤14 字的古早 WAP 短句，`sage.js` 用 `host.intent`（Jev）
   在**低频决策点**拍板，规则只负责把结果合进状态。

## 源码与构建（TypeScript）

脚本源码在 `src/`（TS，strict 模式），构建产物 `rules.js` / `brains/*.js` 一并提交入库，
**运行时只读产物**——QuickJS 只认 JS，不认 TS：

```bash
cd examples/dungeon
npm install          # esbuild + vite + typescript，仅构建期依赖
npm run check        # tsc --noEmit 类型检查
npm run build        # esbuild 打包 → rules.js / brains/*.js（IIFE + globalThis 导出）
npm run dev          # vite 开发模式（HMR 免构建）：打开 /dev.html 直接跑 TS 源码
```

`npm run dev` 的说明：vite 只服务浏览器 UI 的源码，API/SSE 经代理转发到网关
（默认 `http://localhost:6363`，设 `GATEWAY` 环境变量可换）；vite 源与生产页的
localStorage 互相独立，dev 页首次要重填 Admin Token。**改 rules/brains 仍无需
任何构建**（建局热读盘产物），vite 只是让 UI 改动免跑 `npm run build`——
生产构建路径（build.mjs → 产物提交入库）保持不变，产物与 vite 无关。

要点：esbuild 的 IIFE 包装会把顶层声明变成闭包局部量，所以每个入口文件末尾都显式
`(globalThis).xxx = xxx` 导出入口函数，QuickJS 才能在全局对象上找到 `newmatch` / `decide`。
`src/quickjs.d.ts` 是 QuickJS 注入面（`host.log/llm/intent/svc`）的类型声明：脑席文件自行
`declare const host: QuickJSBrainHost`，规则席不声明——规则脚本里出现 `host.*` 就是编译错误
（"规则只算数"的硬约束在类型层面执行）。其他 TS 游戏包可整份复制该文件。
node_modules 已 gitignore；只提交 `src/` 与构建产物。

```
examples/dungeon/
  manifest.json         # 包自描述：名称 + brain 能力申请（sage→jev+svc:solver，narrator→llm）+ solver 服务
  src/                  # TS 源码（shared.ts 类型契约 / rules.ts / brain_common.ts / brains/）
  rules.js              # 构建产物：newmatch / tick / snapshot / over + 内联 TUNING + 19 道具表
  tuning.json           # 数值表（与 rules.js 内联的 TUNING 一致，脚本单文件热更）
  brains/
    adventurer.js       # 确定性脑：换装/事件/战斗全启发式，headless 可复现快跑
    sage.js             # Jev 决策脑：事件房选项 + 精英战战术走 host.intent，失败/低置信自动降级
    narrator.js         # 旁白席：LLM 三通道——关键事件旁白、鉴定装备的来历传说（commands.lore）、
                        #   死亡墓志铭（commands.epitaph，借终局宽限 tick 回传）
    oracle.js           # 军师低语席（人类局）：Jev 在事件房/精英战/濒死三个情境给一句建议，
                        #   可听可不听（commands.whisper，sig 去重），Jev 挂了自动静默
    dm.js               # 地牢之主席（人类局）：Jev 挑对抗手段（伏击/诅咒/落石），规则侧有
                        #   冷却（dm_cooldown）与浅层豁免（dm_min_depth）兜底
  services/
    solver.py           # 包内 Python 后端：POST /hint 返回一句战术提示（sage/oracle 经 host.svc 消费）
    pm.py               # 「真正的后端」演示：监听/操纵活局 + 中断续玩存档（见下章）
  ui/wap/
    index.html          # 单文件对局页，完全由 SSE payload 渲染（事件面板/背包/状态徽章）
  ui/pm/
    index.html          # PM 后台页（/play/dungeon/pm/）：活动局实时视图 + GM 操作 + 存档管理
  ui/app/
    index.html          # Vue 3 + Pinia 版（默认壳：首页只有「进入」按钮，未配 token 自动弹系统设置）
    assets/app.js       # 构建产物（esbuild iife，vue/pinia 已 bundle，提交入库）
    assets/app.css      # 构建产物（源码 src/app/style.css）
  src/app/              # Vue 版源码：stores/（settings=系统设置, game=对局）+ components/
  demo.py               # 上传包 → headless 快跑 → 打印日志（--verify 做确定性自检）
  build.mjs / tsconfig.json / package.json
```

## 跑

```bash
# headless 快跑（默认 adventurer 脑，秒级跑完、逐行可复现）
python3 examples/dungeon/demo.py --base http://localhost:8080 --token $ADMIN_TOKEN
python3 examples/dungeon/demo.py --seed 7 -v        # 换种子 / 连入场与指令行一起打印
python3 examples/dungeon/demo.py --verify           # 同 seed 跑两局比对事件流（确定性自检）
python3 examples/dungeon/demo.py --narrate          # 加上 LLM 旁白席，看「」短句
python3 examples/dungeon/demo.py --brain sage       # Jev 决策脑（事件房 + 精英战）
```

包在 `examples/dungeon/` 里就是稳定版（`rules.js` / `brains/*.js`），
网关的 `games_dir` 已含 `examples`，所以不需要上传也能直接建局；
`demo.py` 里的上传分支只在包不在盘上时才生效。

## 前端

两个 UI 变体，`/play/dungeon/` 会列出选择页：

```bash
# 打开 http://网关:端口/play/dungeon/app/    # Vue 3 + Pinia 版（推荐）
# 打开 http://网关:端口/play/dungeon/wap/    # 单文件极简版
```

**app 变体（Vue 3 + Pinia，源码 `src/app/`）**：像大多数游戏一样，首页只有一个
「进入地牢」按钮 + 下潜排行榜；网关地址 / Admin Token / 冒险者大名 / 种子与行动上限
都是**系统设置**（弹窗 + localStorage 持久化），未配置 token 时首次打开自动弹出，
保存后直接进入。对局页三栏：英雄面板（体力/经验/姿态/状态徽章/**装备三槽 + 背包六格**，
换装免费动作点「装备」即发 equip 指令）、敌人卡（阶级标/意图/血条）、行动按钮组与
事件房决策，右栏探险志自动滚动。结算层显示「你永远留在了第 N 层（X 轮 · 击倒守主 Y）」
并自动提交下潜榜。数据流与 wap 完全一致：SSE payload 渲染 + 开局 REST 拉一次 catalog。
工具链：`npm run build` 会把 `src/app/main.ts` 打成 `ui/app/assets/app.js`（vue/pinia
bundle 进产物，"vue" 默认解析即 runtime-only 版，产物零模板编译器），组件用
TSX（defineComponent + render，esbuild automatic runtime，tsc 以
`jsx: react-jsx + jsxImportSource: vue` 做类型检查——含一个 children 声明补丁
`src/app/vue-jsx.d.ts`；TSX 里别写 `<>单段文本</>`，Fragment 的字符串 children
会在 Vue patch 时炸）。重建产物后要递增 `ui/app/index.html` 里的 `?v=`——
网关不发 Cache-Control，浏览器会按启发式缓存旧文件。

**wap 变体（单文件）**：点「进入地牢」→ 顶栏/怪物卡/事件面板/背包/日志随 SSE 刷新 → 按钮下发指令。

页面调 `POST /v1/games`（人类英雄槽 + 旁白/低语/地牢之主三个脑席，人类局的「低语」
与「地牢之主」只在这局有 Jev 戏份）、`POST .../commands`
（`{player:"p0",commands:{action|choose|equip}}`）、`GET .../events`（SSE，token 走 `?token=`）。
指令与事件选项按钮都由快照生成，合法性归规则，前端不猜。
界面以**轮**为单位呈现（第 N 轮、倒计时剩余轮数、状态效果剩余轮），不向玩家暴露
tick 概念——行为驱动下 1 tick 就是玩家的一轮行动，世界静止时不产生任何推送。
道具名与描述来自 `catalog`：SSE 每 tick 广播的是 tick() 的原始 state（不带 catalog），
所以页面开局时经 `GET /v1/games/<id>`（走 rules.snapshot()）拉一次道具表并缓存。

`solver.py` 也走网关暴露给 UI：`POST /svc/dungeon/solver/hint`（战术提示）与
`GET /svc/dungeon/solver/top` / `POST /svc/dungeon/solver/score`（下潜排行榜，
按 `SVC_DATA` 或仓库 `data/` 落盘 `leaderboard-dungeon.json`）。页面打开即拉榜，
死亡结算时自动把「大名/深度/守主数/轮数/种子」写进榜单。

## 真正的后端：监听、操纵与存档（pm 服务）

`services/pm.py`（端口 8902，`service.sh compose` 自动进容器编排）演示网关侧
后端程序的两种能力：

**监听**：网关的 match bridge 在每个真实 tick 后把完整 state `POST /observe`
推给 pm（载荷含 per-match token、`ops_path`、`notify_path`），pm 记下凭证并压成
PM 页要的摘要（内存保留最近 32 局，`GET /svc/dungeon/pm/live` 轮询渲染，
`bridged` 字段标出该局是否已桥接）。

**操纵**：PM 后台页（`/play/dungeon/pm/`）下发的操作 `POST /op` **经 match bridge
直连投递**到对局——网关校验 manifest 声明的通道白名单后，把指令放进保留席位
`__svc__` 并唤醒 tick loop，下一 tick 由 `rules.tick` 逐条白名单校验执行
（grant_gold/set_hp/heal_full/set_atk/add_item/del_item，非法即忽略），对局日志
出现「[后台]」行。全程**不需要 gm 脑席在场**，也没有一 tick 的轮询延迟；桥接
尚未就绪（还没收到该局的 observe）时 `/op` 返回 409，PM 页稍后重试即可。

**带外消息**：`GET /svc/dungeon/pm/announce?key=<seed>&text=…` 经桥接向对局的 SSE
通道推一条独立的 `event: notice` —— 不进 state，因此不影响确定性复盘。这是后端
第一次能往游戏画面推东西而不用污染规则状态。

**代为建局**：`POST /svc/dungeon/pm/newmatch`（`http.public` 声明，免凭据）收到
`{"match": {...}}` 后，pm 用网关注入的 `SVC_TOKEN` 调 `POST /v1/games`，把
`match_id` 和只对本局有效的 `player_token` 一起回给页面。于是**玩家浏览器全程
不持有 Admin Token**：建局靠服务自己的窄权限令牌（manifest 的
`gateway_access.create_matches`，只能建本包的对局），对局闭环靠 `player_token`。
这正是网关要在本机托管 Python 运行时的意义——后端是那个可以持有凭据、而浏览器
不该持有的层。

**存档（中断续玩）**：对局页「存档」按钮把 SSE raw state 交 `POST /save` 落盘
`<data>/pm/saves/<大名>.json`；首页出现「未竟的探险」卡，继续冒险时经建局
`props.resume` 传回，`rules.newmatch` 白名单 hydrate（数值夹紧、背包/装备校验
catalog、rng 续接 → 恢复局与原局同指令序列事件流一致），榜单条目记「续命×N」。

**鉴权与容器**：读接口（/live /save/<名> /saves /health）公开（与 solver 同
哲学）；写操作（/op /save DELETE）由服务端校验 `X-Admin-Token === PM_TOKEN`
env——PM_TOKEN 未设置时启动警告并放行（本地开发），容器部署在生成的 compose
文件里手填。运行键是 seed（decide 入参没有 match_id，UI seed 留空自动随机）。

## 规则要点（v2）

- **出身骰（v5.2）**：开局掷一颗 8 面骰定出身——好面（将门之后/猎户之子/商贾遗孤/
  拾荒的命：属性、金币或一件开局装备）合计 4/9≈44%，坏面（老兵旧伤/囊中羞涩）
  2/9≈22%，平凡出身 3/9≈33%。数值全部规则端掷骰（同 seed 同出身，确定性不破），
  narrator 席用 LLM 把出身写进开局背景故事（首轮回传，日志【序章】行）；骰面表经
  `snapshot.origin_dice` 下发，对局页左栏「出身骰」卡渲染掷面与全部概率。
- **层数无限，探索驱动（v5）**：每 5 层一个守主「地牢之主」（第 5/10/15… 层，hp 150+90·m /
  atk 16+4·m，m 为里程碑序号，全面压制同期的精英怪）。深度即成绩，死亡或行动上限
  耗尽结算入榜。**层里不再有强制清剿的怪队**：新层是安静的 idle 驻留态，可 `descend`
  下潜，也可 `explore` 主动探索——摸宝箱（15% 是陷阱箱）、**搅醒遭遇战**（40%，普通怪/
  精英，绝不刷守主——敌人是消磨回合的随机遭遇而非任务清单）、发现空洞（跳：随机下潜
  1~2 层+摔伤；绕开：无事）、撞见路过的事件房，或一无所获。每层探索上限 6 次
  （`explores_max`）。**守主巢穴是唯一的墙**：下潜进第 5/10/15… 层会立刻面对面撞上守主，
  不掀翻它就无法继续下潜。事件房在玩家明确下潜/探索的轮不开启（尊重行动意图，避免
  「决定下潜→商人开张→行动非法」的自相矛盾），同轮刚做完抉择也不再开新房；喝药/换装
  等轮才可能触发。精英怪（▲）按层数概率出现，属性 1.5~1.7 倍、带一个**意图**
  （狂暴/铁壁/剧毒）。
- **守主遗产**：每击倒一个守主，死亡时多保留一件背包物品带入下一局，槽位上限 3
  （`min(boss_kills, 3)`）；多次结转遵守同一槽位规则（结转物就在下局背包里，死亡时
  重新按本局守主数计槽）。活着走出（行动上限）不算死亡，遗产保持原样。UI 按玩家
  大名存在 localStorage（`dungeon.legacy.v1`，两个 UI 变体共用），建局经
  `POST /v1/games` 的 `props.legacy` 传入；规则端独立校验（catalog 内、去重、上限 3），
  前端存储不可信。
- **道具**（19 件）：消耗品（药水/火油弹/卷轴/解毒剂/秘药）+ 武器/护甲/饰品三槽位，
  其中混着两件诅咒物（血诅戒、铅靴）——捡了不亏属性但有毒，祭坛能解，商人处可变卖
  （买入价一半，越深给得越多）。背包物品也可以丢弃（`drop:<id>` 动作，占一回合）。
  装备/换装是**免费动作**（`commands.equip`，不耗回合）；背包满 6 格，重复拾取自动折金。
- **事件房**：清层后 85% 概率触发（商人/祭坛/宝箱/岔路/冒险者/赌徒），进入 `pending`
  决策期。决策期是行为驱动的唯一例外：**没有敌人，世界自己走表**（tick_ms 节奏），
  倒计时实时流逝，`deadline_tick`（6 轮）一到自动执行默认选项——磨蹭的玩家和
  慢/挂的 Jev 都有安全网，最坏情况就是拿默认结果。商人会收购背包里有价物品
  （装备中的除外），卖货选项直接出现在事件面板里。
- **状态效果**：中毒/灼烧每回合固定扣血（无随机数，保确定性），圣盾减伤、巨力增攻，
  按回合数递减；武器附魔（焰刃/毒牙匕首）按概率给怪上灼烧/中毒。
- `tick` 对无指令的人类局返回 `wait`：世界挂起静止（不推进/不掉血/不倒计时），
  指令一到立即结算一轮；唯一例外是决策期（pending，见上）——决策期无指令也走表。
  全脑局脑席每 tick 都发指令，不受影响。

## 脑脚本契约

- `brains/*.js` 导出 `decide(args) -> {commands, memory}`，`args = {snapshot, memory}`，
  `memory` 由服务端原样往返（adventurer 用它记格挡连击数，sage 用它记战术姿态与熔断窗口）。
- 指令槽：`{action}`（姿态或 `use:<id>`）、`{choose}`（事件房）、`{equip}`（免费换装）、
  `{narrate}`（旁白）、`{lore}`（来历传说）、`{epitaph}`（墓志铭）、
  `{whisper}`（低语，带 sig 去重）、`{dm}`（地牢之主手段，规则侧有冷却兜底）。
- **脑脚本绝不抛异常**：抛错会让 tick loop 停下，五个脑都有 try/catch 兜底。
- **sage 的 Jev 纪律**（`host.intent` 单次 15s 超时×4 重试，只能低频调）：
  只在两类决策点调用——事件房（routes=各选项）与精英/Boss 战开局（routes=三种战术）；
  换装与普通战斗走纯启发式。置信 < 0.4 沿用默认/上一姿态；连续失败熔断 60 回合，
  期间全部走确定性启发式。事件房 deadline 兜底保证慢/挂的 Jev 无害。
- **sage 先问本地 solver**（`host.svc("solver", "/hint", {...})`，manifest 里
  `svc:solver` 声明才可用）：精英战开局问 Jev 之前先拿一句 Python solver 的战术提示
  塞进 user_input；solver 挂了静默跳过，决策不依赖它。
- `narrator.js` 三通道共用一条 LLM 链（熔断 + 模板兜底）：①关键事件（遇怪/击杀/升级/
  下潜/脱战/遭遇/陷阱/诅咒）且间隔 ≥2 回合发 ≤14 字旁白；②识别日志行的 `ids` 载荷，
  为未鉴定的「秘密资料」写 ≤26 字来历传说（每种一次，落 `item_lore` 跨局携带）；
  ③死亡行触发 ≤18 字墓志铭（借终局宽限 tick 回传，结算层展示）。

## 边界

规则脚本（`rules.js`）只能算数：运行时拿不到 `host.intent` / `host.llm`（网关只注入 `log`），
所以文案、决策增强这类模型能力只能出现在 `brains/` 里；计分板、排位、剧情推进属于外部后端，
网关只提供对局原语、replay 与 webhook（见 `docs/game-server.md`）。
