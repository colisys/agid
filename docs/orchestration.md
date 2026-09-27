# 编排架构：Jev 做意图选择，QuickJS 做编排

## 分工

```
请求 ──▶ Engine ──▶ QuickJS 脚本 orchestrate(input)
                        │
                        ├─ host.intent(state) ──▶ Jev: 只选路由（Choice + 复杂度 Score）
                        ├─ host.tool(name, args) ─▶ 工具注册表
                        └─ host.llm(provider, msgs) ▶ LLM provider
                        │
                        ▼ 返回 { route, steps, output }
                   Go 门控（阈值/高风险）──▶ verdict: allow|confirm|human|deny
```

- **Jev 只做一件事**：给请求选一个路由（`intent` Choice，带 `other` 兜底）+ 一个复杂度 Score。
  不再做风险/选择/校验等通用判定——那些属于编排逻辑。
- **QuickJS 脚本拥有编排**：分支、工具调用、LLM 调用、输出塑形，全部写在 JS 里，可热更。
- **Go 拥有安全门控**：脚本决定「做什么」，Go 决定「能不能放行」（阈值、高风险确认）。

## 脚本契约

脚本必须定义 `orchestrate(input)`，返回 `{ route, steps, output }`。

`input` 字段：`goal, user_input, context, routes, candidates, high_risk, tool, llm_provider, policy_set`。
`routes` 是 `{routeName: description}`，会作为 Jev 的 Choice 选项（自动加 `other`）。

`host` 能力：

| 调用 | 说明 |
| --- | --- |
| `host.intent(state)` | 调 Jev 选路由，返回 `{route, confidence, probabilities, complexity, complexity_confidence}` |
| `host.tool(name, args)` | 执行注册的工具，返回其结果 |
| `host.llm(provider, messages)` | 调 LLM（`provider` 为空用默认），返回文本 |
| `host.log(msg)` | 打日志 |

约定：路由名以 `tool:` 开头表示执行该工具（内置默认脚本的约定，可自行改）。

## 内置默认脚本

见 `internal/jsflow/scripts/default.js`：`host.intent` 选路由 → `tool:<name>` 走工具、
其余走 LLM → 返回。用 `jsflow: { script_file: path/to/flow.js }` 覆盖，或运行时热更。

## 热更脚本

```bash
gwadmin script get > flow.js      # 导出当前脚本
vim flow.js
gwadmin script set flow.js        # 即时生效，不重启
```

或直接 `PUT /admin/script {"script": "..."}`（需 `X-Admin-Token`）。

## 配置

```yaml
jsflow:
  pool_size: 4          # QuickJS worker 数（每 worker 一个 runtime，绑定独立 OS 线程）
  script_file: ""       # 空 = 用内置默认脚本
```

QuickJS 非线程安全，因此用固定 worker 池：每个 worker 在自己的 goroutine 上持有
Runtime+Context，请求经 channel 派发。宿主回调（intent/tool/llm）在同一 goroutine 内执行，
网络调用阻塞该 worker，其余 worker 不受影响。

## 安全注意

- 脚本是**受信代码**：它能调 `host.llm`/`host.tool`，等于网关内的执行能力。
  只加载你信任的脚本（同 `bytecode` 的信任级别）。
- 门控仍在 Go：即使脚本返回 `route`，`confidence` 低于阈值 / 复杂度超限 / 高风险未达高置信
  都会被拦成 `human`/`confirm`。
- 脚本若不调用 `host.intent`（拿不到意图），Go 直接判 `human`，不放行。
