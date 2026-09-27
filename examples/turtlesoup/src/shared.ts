// Shared type contracts for the turtlesoup pack (rules + brains).
// Types only: esbuild erases them at build time, so every entry still ships as
// one self-contained IIFE with zero runtime imports — QuickJS eats a single
// file and the only I/O channel stays `host.*` (brains) or nothing (rules).

// ---- state ----------------------------------------------------------------

export interface PuzzleView {
  id: string;
  surface: string; // 汤面：公开信息
  // 注意：汤底（PuzzleDef.bottom）绝不进 state——快照全局单份，进 state 就
  // 等于向 SSE / 复盘 / REST 全线泄底。终局揭晓用 State.revealed。
}

// 一条已判定的提问。answer ∈ 是 | 不是 | 无关
export interface QAEntry {
  tick: number;
  seat: string; // 提问者席位 "p0".."p7"
  text: string;
  answer: string;
}

// 一条已判定的竞猜。verdict ∈ 命中 | 未中
export interface GAEntry {
  tick: number;
  seat: string;
  text: string;
  verdict: string;
}

// 待主持人判定条目。left 是倒计时拍数：归零自动释放并返还预算——防止 LLM
// 长时间不可用时玩家被一个悬而未决的问题卡死。
export interface PendingItem {
  tick: number; // 落地那一拍，也是判定通道的回执键
  seat: string;
  text: string;
  left: number;
}

export interface SeatBudget {
  asks: number; // 已用提问次数
  guesses: number; // 已用竞猜次数
  joined: boolean; // 是否出过手（全局枯竭判定只统计出手过的席位）
}

export interface LogLine {
  tick: number;
  kind: string; // enter | surface | hint | ask | answer | guess | verdict | win | end | reveal | release | illegal
  text: string;
}

export interface State {
  seed: number;
  tick: number;
  status: "play" | "ended";
  puzzle: PuzzleView; // 只有汤面
  pending_q: PendingItem | null; // 全局唯一的待判定提问
  pending_g: PendingItem | null; // 全局唯一的待判定竞猜
  qa: QAEntry[]; // 已答问（封顶）
  ga: GAEntry[]; // 已判竞猜（封顶）
  budget: Record<string, SeatBudget>; // "p0".."p7" -> 预算账本
  log: LogLine[];
  winner: string | null; // 猜中者席位；枯竭终局为 null
  revealed?: string; // 汤底——只在 status === "ended" 时存在（终局揭晓）
}

// Snapshot = state + 规则常量（UI 不硬编码预算/长度上限）。
export interface Snapshot extends State {
  seats: number; // 人类席位数（8；主持人脑席在 p8）
  ask_limit: number;
  guess_limit: number;
  ask_max_chars: number;
}

// ---- brain contract -------------------------------------------------------

// 主持人席的判定回执。q_tick / g_tick 必须与 pending 的 tick 一致，answer /
// verdict 在白名单内——LLM 输出不可信，规则逐字段校验，非法即静默忽略。
// unknown = 主持人没判出来：规则释放 pending、返还预算、提示玩家重试。
export interface Judge {
  q_tick?: number; // 回答 pending_q
  g_tick?: number; // 判定 pending_g
  answer?: string; // 是 | 不是 | 无关 | unknown
  verdict?: string; // 命中 | 未中 | unknown
}

export interface Commands {
  judge?: Judge; // 主持人席专用通道
}

export interface DecideArgs {
  snapshot: Snapshot;
  memory: Record<string, unknown>; // 首次 decide 时为 null，须兜底 {}
}

export interface DecideResult {
  commands: Commands;
  memory: Record<string, unknown>;
}

// host 的类型在 quickjs.d.ts（QuickJSBrainHost / QuickJSRulesHost）。
// 脑席入口自行 declare const host: QuickJSBrainHost;
// 规则席不声明——规则脚本里出现 host.* 就是编译错误（规则只算数）。
