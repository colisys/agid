# 通用网关架构设计：Jev 决策 + 多 LLM 编排

> 形态：Go 单体网关（单二进制 + 容器交付）· 范围：仅设计文档，不含可运行网关代码
> Jev 合约依据：TypeSafe 官方文档 `POST https://api.typesafe.ai/v1/systemone`（`api.md`、`models.md`、
> patterns: intent-routing / confidence-routing / fan-out，cookbook: function_calling）

## 1. 一句话目标

做一个**统一入口的 Go 单体网关**：北向对外暴露统一 REST（+ OpenAI 兼容子集）接口；
南向**只把 Jev 当决策器**（路由 / 审批 / 评分 / 校验，返回 typed judgment + probability + confidence），
**把其他 LLM 当编排/执行器**（任务拆解、候选方案生成、工具调用、文本生成）。

核心原则（照搬 TypeSafe 官方编程模型）：**Code owns workflow**。
所有分支、阈值、权重、降级都在代码里，模型只提供语义判断。

## 2. 分工：为什么 Jev 只决策、LLM 只编排

| 维度 | Jev (System One) | 其他 LLM |
| --- | --- | --- |
| 输入 | `state + questions{Choice\|Noul\|Score}` | prompt / messages / tools |
| 输出 | typed 答案：选项/概率/置信度，不生成文本 | 生成文本、计划、工具调用参数 |
| 计费 | 按输入 token，`$42/Btok`（`$0.042/Mtok`），输出 token 免费 | 按输入+输出计费，贵一个数量级 |
| 延迟/并发 | 快，可一次请求并行多问；限流 250k tok/s、1200 req/min | 慢，适合低频重任务 |
| 网关职责 | 路由、审批、评分、校验（拍板） | 候选生成、拆解、执行（干活） |

三个原语与网关决策的直接映射：

- `Choice`：选路由 / 选候选 / 选函数名。返回 `choice + probabilities（和为1）+ confidence`。
- `Noul`：是否门（safe? reversible? compliant? stated?）。返回 `noul ∈ [0,1]`，
  无独立 confidence，`≈0.5` 表示不确定，按保守侧处理。
- `Score`：风险 / 复杂度 / 严重度分级。返回概率加权 `score + legend + probabilities + confidence`。

复用的官方模式：

- Intent Routing：先分类再路由到确定性代码 / 专家 LLM / 人工。
- Confidence-gated Routing：按 confidence 分级放行 / 确认 / 转人工。
- Speculative Fan-out：一次请求并行问含推测性问题，代码选消费哪个答案。
- Function Calling cookbook：函数名 + 闭集参数映射为 Choice，`stated?` Noul 控制可选参数省略，
  整单 confidence 取最弱环节（min，不是乘积）。
- Guardrails / Citation-check：出入双向校验。

## 3. 总体架构

```text
Client
  │  POST /v1/execute · POST /v1/chat/completions(OpenAI兼容) · POST /v1/decide(Jev直通校验版)
  ▼
[Ingress: AuthN/Z, 限流, 租户配额, PII脱敏, TraceID]
  ▼
[Orchestrator 编排引擎] ──plan(DAG/候选)──▶ [LLM Provider层: OpenAI/Anthropic/Gemini/自托管]
  │                                                    ▲
  │ state={goal,context,candidates,policies,history}   │ specialist LLM 执行子任务/工具调用
  ▼                                                    │
[Decision决策服务: Pack构建 → Jev Adapter → Policy Evaluator(阈值/权重/门控)]
  ▼ verdict {decision, probabilities, confidence, model版本}
[Executor: 确定性代码 / 工具调用 / 人工升级] → [Verifier: Jev二次校验] → Response + AuditLog
```

核心请求生命周期（全链带 TraceID）：

1. 归一化：OpenAI 兼容请求或自定义 `ExecuteRequest` → 内部 `Task{goal, context, policies, budget}`。
2. 编排（LLM）：生成执行计划 = 1 个主计划 + N 个候选（或 DAG 步骤），只做候选生成，不拍板。
3. 决策（Jev，一次 `/v1/systemone` 并行多问）：`intent Choice` + `risk Nouls` +
   `complexity/severity Score` + 推测性问题。State 用命名 JSON 字段，`instructions` 写完整语义
   （含 `other/no_match` 回退选项），用 `` `path.to.field` `` 引用嵌套 state。
4. 门控（代码）：查置信度路由表（§6）决定放行 / 要求确认 / 转人工 / 降级。
5. 执行：低风险确定性代码直行；中风险调 specialist LLM（最小上下文）；工具调用走
   Function-calling 映射。
6. 校验（Jev）：输出侧 guardrail Nouls + citation Choice，不通过则重试 / 转人工。
7. 记账：记录 `response.model`（实际版本 ID）、`usage`、confidence 分布、最终动作，供阈值调优和计费。

## 4. 北向接口（详见 `api/openapi.yaml`）

| 方法与路径 | 用途 |
| --- | --- |
| `POST /v1/execute` | 主入口：目标 + 上下文 + 策略集 + 预算 → verdict + 步骤 + 置信度 + 用量 |
| `POST /v1/decide` | Jev 直通 + 服务端 key + 校验 + 审计；禁止浏览器直调 Jev |
| `POST /v1/chat/completions` | OpenAI 兼容透传，现有客户端零改接入编排层 |
| `GET /v1/models` | 聚合 Jev `GET /v1/models` + 已配置 LLM 列表 |
| `GET /admin/packs`、`PUT /admin/policies` | 运营调阈值 / 权重 / Pack，无需重发版 |

`POST /v1/execute` 草案：

```json
{
  "goal": "处理这笔退款申请",
  "context": { "ticket": { "id": "T-1024" }, "locale": "zh-CN" },
  "policy_set": "payments-v3",
  "budget": { "max_jev_tokens": 8000, "max_llm_cost_usd": 0.05 }
}
```

返回（含 Jev 与 LLM 各自用量，便于核算）：

```json
{
  "verdict": { "action": "allow", "route": "refund_auto", "confidence": 0.91 },
  "steps": [{ "id": "s1", "kind": "tool", "tool": "refund.create" }],
  "trace_id": "tr_9f2...",
  "usage": { "jev_input_tokens": 1204, "llm_tokens": 2310, "cost_usd": 0.0031 }
}
```

## 5. Jev 决策层：State 与 Question Packs

### 5.1 State 规范（`internal/decision/state_builder.go`）

- 固定命名字段：`{goal, user_input, candidates[], policies, history, locale}`；
  观测事实（observed）与推断状态（inferred）分字段存，执行前查 freshness（过期重判）。
- 形态：`string | object | array`。非文本（图/音/二进制）先转文本再入 state。
- 预算：总量 64k（state + 全部 questions）；`state + 单个最长 question ≤ 32k`，超限按
  `history → candidates → policies` 顺序截断并打标。
- 入 Jev 前 PII 脱敏；英文主训，CJK（含中文）先测后用，密切看 confidence。
- 结构化 `instructions` 允许把问题与数据放同一对象，用反引号引用 state 路径。

### 5.2 四组预置 Pack（`internal/decision/packs.go`，支持运营配置化）

- **routing**：`intent Choice{…业务路由…, other/no_match必填}` + `complexity Score[简单/需判断/需升级]`。
- **risk**：`safe?/reversible?/compliant? Nouls` + `severity Score`。
  高风险不用加权平均，用"任一严重违规即拦"规则。
- **selection**：`pick Choice over candidates` + 每候选 `quality Score`，composite scoring 权重放代码，
  换权重不重跑推理。
- **verification**：`citation Choice{支持/不支持/无关}` + `hazard Nouls`，输出侧必跑。
- 完整 JSON 见附录 B。

### 5.3 单次扇出规则

- 独立问题（含推测性分支问题）同一次请求并行发；代码按实际路由消费对应答案，
  未用分支的置信度直接忽略，不否决主分支。
- 只有"需前序答案取数 / 构造新 state / 确定下一跳选项"时才发第二次请求。
- 问题数与长度纳入预算；参考数据点：13 问一批次相对逐问约 12.2x 便宜、10x 快——能并则并。

## 6. 门控：置信度路由表（`internal/decision/evaluator.go` + `internal/policy/`）

默认值（运营可调，**必须在自有数据上标定**，cookbook 数字只当起点）：

| 条件 | 动作 |
| --- | --- |
| `intent.confidence < 0.6` | 转人工（不确定兜底） |
| 低风险动作 + conf ≥ 0.6 | 自动执行 |
| 高风险（转账/删除/对外发送/退款） | 需 conf > 0.85，否则先向用户确认 |
| `complexity.score > 1 或其 conf < 0.5` | 转人工 |
| Noul ≈ 0.5 | 视为"均可"，按保守侧处理 |
| function call 整单 confidence | 取最弱环节（min） |

`PolicyEvaluator.Gate(route, answers) → allow | confirm | human | deny`。
高风险 fail-closed（转人工/拒绝），低风险 fail-open（走默认安全动作并打标审计）。

## 7. 模型、韧性与错误映射（`internal/decision/jev_client.go`）

- 生产 pin `jev-1.13.0`（`response.model` 回的是实际版本 ID，务必记入审计）。
  `jev-latest` 随发版漂移只用于 dev；`jev-preview` 同理。
- 并发上限按 250k tok/s、1200 req/min 做客户端预算 + 排队（官方称限流动态调整，企业版可谈）。
- `429/529` 指数退避 + 识别 `retry-after`（手写 client 时照做，SDK 默认自带）。
  Jev 熔断时按 §6 fail-closed / fail-open。
- 错误映射：`401` → 服务端 key 告警（不透传）；`422` → 打回调用方（question 构造 bug）；
  `429/529` → 退避重试 + 预算 shed。
- 持久化：每次判定存 `state + questions + answers + confidence + response.model`（脱敏后），供复盘与阈值标定。

## 8. LLM 编排层（`internal/orchestrator/` + `internal/llm/`）

- Provider 抽象统一为 OpenAI 风格 `chat → 结构化候选`，各家（OpenAI/Anthropic/Gemini/自托管）
  只写适配器；编排 LLM 不直接做最终决策，只输出 `candidates[{id, plan, args, predicted_cost}]`。
- 闭集参数走 Jev Choice（值即函数接受的字面量，无需二次映射）；
  开放文本/数字/日期走 LLM 或函数默认值，不给 Jev 出题。
- 编排侧做 token/费用预算和熔断；流式只在执行侧透传，决策链路保持同步可审计。

## 9. 工具调用（`internal/tools/`）

- `tool.go` 定义 `Tool` 接口，`registry.go` 注册；函数签名提取闭集：
  `Literal → choice`，`list[Literal] → set（每成员一 Noul）`，`bool → flag`。
- 调度 = __tool__ Choice（选函数）+ 各参数 Choice/Noul + `stated?` Noul（未提及则省略，用函数默认值）。
- 值即字面量（如 `"1mo"`、`"candles"`），Jev 答案直接填参，无映射层。

## 10. 配置、安全、可观测

- 配置 `configs/gateway.yaml`：Jev `{endpoint, model_pin, timeout, retry, tps_budget}`、
  LLM providers、packs 定义、阈值/权重表、租户配额；支持热重载 + `/admin` 在线调参。
- 安全：Jev API key 只存服务端（env/secret），多租户北向 key 独立签发；入 Jev 前 PII 脱敏；
  企业 ZDR 需求走 TypeSafe enterprise；`422` 细节不透传原始 state。
- 可观测：TraceID 串联 LLM + Jev + 工具三次调用；指标
  `decision_confidence_hist, jev_usage_tokens, jev_cost_usd(=input_tokens×0.042/1M), llm_cost, gate_outcome{allow/confirm/human/deny}`；
  审计日志存全量 state/questions/answers/verdict（脱敏后）。

## 11. 代码结构（实现阶段照此建）

```text
docs/architecture.md            # 本设计定稿版
api/openapi.yaml                # /v1/execute, /v1/decide, /v1/chat/completions, /admin/* 定义
configs/gateway.yaml            # 路由表, Jev模型pin, 阈值, LLM provider, 配额
cmd/gateway/main.go             # 单体入口, 配置加载, 热重载
internal/api/                   # handler_auth.go, handler_execute.go, handler_decide.go, handler_openai_compat.go
internal/orchestrator/          # planner.go, dag.go, budget.go
internal/decision/              # ★核心：jev_client.go, state_builder.go, packs.go, evaluator.go
internal/llm/                   # provider.go (interface), openai.go, anthropic.go, gemini.go, registry.go
internal/tools/                 # tool.go (interface), registry.go, http_tool.go
internal/policy/                # policy.yaml加载, 阈值表, 权重表
internal/state/                 # 会话/任务状态存储接口 + 内存/Redis实现
internal/observability/         # tracing, metrics, auditlog
```

关键 Go 接口：

```go
type DecisionProvider interface {
  Evaluate(ctx context.Context, req SystemOneRequest) (SystemOneResult, error)
}
type SystemOneRequest struct { State any; Model string; Questions map[string]Question }
type Question struct { Type string // "choice"|"noul"|"score"; Instructions any; Criteria any }

type LLMProvider interface {
  Plan(ctx context.Context, task Task) (PlanCandidates, error)
  Execute(ctx context.Context, step Step) (StepResult, error)
}
type PolicyEvaluator interface {
  Gate(route string, answers Answers) Verdict // allow | confirm | human | deny
}
```

## 12. 取舍

- 选 Go 单体而非 Python/微服务：首版只要"网关 + 决策 + 编排代理"，Go 的并发扇出、
  超时/熔断、单二进制交付最合适；Python 生态（LangChain/Graph）留给 specialist LLM 侧或二期。
- 北向兼容 OpenAI、南向 Jev 原生：LLM 侧必须兼容才能零成本接入多模型；Jev 语义
  （typed judgment + probability）与 OpenAI 不兼容，不做"统一 chat 接口"削足适履，
  而是原生 `decide` 接口 + 代码内组合。
- 首版只定接口 + 核心链路：实现先跑通 execute → plan → jev decide → gate → execute → verify
  全链路 demo；多租户计费、Redis 状态、Admin 全量、混沌/压测列为二期。

## 13. 验证（设计文档的验收标准）

- 文档评审：分工（Jev 不生成、LLM 不拍板）、接口（openapi.yaml 可 lint 通过）、阈值表可解释。
- 契约测试（实现阶段用）：用官方交易/客服示例 replay Jev 请求体，断言 `packs.go` 生成的
  questions 与官方字段一致（`type/instructions/criteria`），`evaluator.go` 对示例 confidence
  的 gate 结果符合路由表。
- 阈值标定：准备 ≥50 条代表性 case（含 CJK），跑 Jev 记录 answers/confidence，按后果调阈值。
- 故障演练设计：Jev 429/529 注入 → 高风险 fail-closed、低风险 fail-open 可观测；
  key 失效 401 告警；state 超 32k 截断策略生效。

## 14. 交付物与下一步

- 本次交付：`docs/architecture.md`（本文件）+ `api/openapi.yaml` + `configs/gateway.yaml` 示例。
  不写可运行网关代码。
- 批准后实现顺序建议：Jev Adapter + Packs → Evaluator 门控 → Orchestrator + 1 家 LLM →
  Executor + Verifier → Ingress / Observability。

---

## 附录 A：Jev 请求/响应示例（官方契约）

```http
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <TYPESAFE_API_KEY>
Content-Type: application/json
```

```json
{
  "state": "Help! My payouts have been failing for 3 days.",
  "model": "jev-latest",
  "questions": {
    "is_urgent": {
      "type": "noul",
      "instructions": "Does this convey urgency?",
      "criteria": { "true": "Explicitly time-sensitive", "false": "No urgency expressed" }
    },
    "department": {
      "type": "choice",
      "instructions": "Which team should handle this?",
      "criteria": {
        "billing": "Payments, invoicing, refunds",
        "technical": "Bugs, outages, integrations",
        "sales": "Pricing, upgrades, new accounts"
      }
    },
    "frustration": {
      "type": "score",
      "instructions": "How frustrated is the customer?",
      "criteria": ["Calm", "Frustrated", "Very angry"]
    }
  }
}
```

```json
{
  "model": "jev-1.13.0",
  "answers": {
    "is_urgent": { "type": "noul", "noul": 0.95 },
    "department": {
      "type": "choice", "choice": "billing",
      "probabilities": { "billing": 0.88, "technical": 0.12, "sales": 0.0 },
      "confidence": 0.81
    },
    "frustration": {
      "type": "score", "score": 1.05,
      "legend": { "0": "Calm", "1": "Frustrated", "2": "Very angry" },
      "probabilities": { "0": 0.0, "1": 0.95, "2": 0.05 },
      "confidence": 0.92
    }
  },
  "usage": { "input_tokens": 318, "output_tokens": 34 }
}
```

## 附录 B：四组 Pack JSON（可直接放入 `configs/gateway.yaml` 或 `packs.go`）

```json
{
  "routing": {
    "intent": {
      "type": "choice",
      "instructions": "The primary intent of this request; pick the handler that should own it",
      "criteria": {
        "refund_auto": "Standard refund within policy, deterministic code can execute",
        "specialist_llm": "Needs domain LLM with extra context",
        "human": "Unusual, escalated, or high-stakes; needs a person",
        "other": "None of the above fits"
      }
    },
    "complexity": {
      "type": "score",
      "instructions": "How complex is this request to resolve",
      "criteria": [
        "Simple lookup or standard procedure",
        "Requires some judgment or multi-step process",
        "Unusual situation, edge case, or escalation needed"
      ]
    }
  },
  "risk": {
    "is_safe": { "type": "noul", "instructions": "Is it safe to auto-execute `candidates[0]` given `policies`?" },
    "is_reversible": { "type": "noul", "instructions": "Can the effect of `candidates[0]` be fully reversed?" },
    "is_compliant": { "type": "noul", "instructions": "Does `candidates[0]` comply with `policies`?" },
    "severity": {
      "type": "score",
      "instructions": "If this action is wrong, how bad is the consequence",
      "criteria": ["Harmless or trivially fixable", "Costly or hard to reverse", "Severe, regulated, or externally visible harm"]
    }
  },
  "selection": {
    "pick": {
      "type": "choice",
      "instructions": "Which candidate in `candidates` best achieves `goal` under `policies`",
      "criteria": {
        "cand_0": "First candidate as described in `candidates[0]`",
        "cand_1": "Second candidate as described in `candidates[1]`",
        "no_match": "No candidate is acceptable"
      }
    }
  },
  "verification": {
    "citation": {
      "type": "choice",
      "instructions": "Does the evidence in `context` support the claim in `user_input`",
      "criteria": {
        "supported": "Quoted context supports the claim",
        "contradicted": "Context contradicts the claim",
        "unrelated": "No usable evidence in context"
      }
    },
    "is_hazardous": { "type": "noul", "instructions": "Does this content contain a hazard that must block or escalate?" }
  }
}
```

## 附录 C：阈值表（默认，可运营覆盖）

| 信号 | 阈值 | 动作 | 备注 |
| --- | --- | --- | --- |
| intent.confidence | < 0.6 | human | 不确定兜底 |
| 低风险 + conf | ≥ 0.6 | allow | 自动执行 |
| 高风险动作 conf | ≤ 0.85 | confirm | 先向用户确认；> 0.85 才 allow |
| complexity.score | > 1 | human | 或其 conf < 0.5 也转人工 |
| Noul | ≈ 0.5 | 保守侧 | 视为"均可"，不单独作为放行依据 |
| function call | min(各环节) | 整单 confidence | 一处弱则整单弱 |
