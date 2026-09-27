// quickjs.d.ts — QuickJS 运行时注入面的类型声明（游戏包通用，可整份复制到其他 TS 包）。
//
// 网关对每个 QuickJS VM 注入一个全局对象 `host`（见 internal/jsflow/pool.go 的
// bindHost 与 cmd/gateway/main.go 的 hosts 工厂）。注入面按席位不同：
//
//   规则席（rules.js）  host.log —— 只注入 Log；intent/llm 调了会 throw "not available"
//   脑席（brains/*.js） host.log / host.llm / host.intent —— 完整模型通道
//
// 因此本文件只声明接口，不声明全局变量 `host`：各入口文件在模块内用
//   declare const host: QuickJSBrainHost;   // 脑席
// 规则席**不要**声明——规则脚本里任何 host.* 引用都会直接编译报错，
// 这正是"规则只算数"这条硬约束在类型层面的执行。
//
// 其余运行时约定（不属于注入面，故不在此声明）：
//   * 每个入口必须显式导出：(globalThis as Record<string, unknown>).decide = decide;
//     esbuild 的 IIFE 包装会把顶层声明变成闭包局部量，不导出 QuickJS 就找不到入口。
//   * host.tool 在编排流（jsflow default.js）里可用，但游戏包的宿主未接线，调用即抛错，
//     所以不在游戏包的类型里出现。

// host.llm 的对话消息（OpenAI chat 格式的最小子集）。
interface QuickJSChatMessage {
  role: string; // "system" | "user" | "assistant"
  content: string;
}

// host.intent 的入参：routes 决定 Jev 在哪些选项里做选择题。
interface QuickJSIntentState {
  goal: string; // 本局总目标，常驻上下文
  user_input: string; // 本次要判断的具体问题（建议 JSON.stringify 状态摘要）
  context?: unknown; // 任意附加上下文，原样传给 Jev
  routes: string[] | Record<string, string>; // 路线名列表，或 路线名→描述 映射
}

// host.intent 的返回（internal/game/scripts.go 装配的形状）。
// 注意：Jev 出错时 host.intent 会 throw——脑脚本必须 try/catch 并降级。
interface QuickJSIntentResult {
  route: string; // 选中的路线名
  confidence: number; // 0..1；<0.4 建议沿用上一姿态或默认项
  probabilities?: Record<string, number>; // 各路线的概率分布
}

// 脑席注入面（完整通道）。
interface QuickJSBrainHost {
  log(msg: string): void; // 进网关日志（game <id> [<slot>] 前缀）
  // provider 用配置里的 llm_providers 名字（openai/anthropic/...），空串 = 默认 provider；
  // model 可选：显式指定本次请求的模型名。裁决规则——网关配置了默认模型时一切以
  // 网关默认为准（provider/model 都被覆盖）；网关没配默认模型时原样转发，model
  // 再为空则退到该 provider 的 `model:` 字段（上游要求必须带模型名）。
  // 返回纯文本；上游出错会 throw——务必 try/catch，失败走兜底，别在 tick 路径上重试。
  llm(provider: string, messages: QuickJSChatMessage[], model?: string): string;
  // 低频决策专用：单次超时 15s × 重试 4 次，绝不能每 tick 调。
  intent(state: QuickJSIntentState): QuickJSIntentResult;
  // 调用 manifest 里本包 services 声明的后端服务（阻塞 JSON POST）。
  // 需在 capabilities 里声明 svc:<服务名>；未声明的服务名会 throw，
  // 服务宕机也 throw——调用方必须 try/catch 并兜底。
  svc(name: string, path: string, body: unknown): Record<string, unknown>;
}

// 规则席注入面：只有日志。规则脚本只做确定性数值计算。
interface QuickJSRulesHost {
  log(msg: string): void;
}
