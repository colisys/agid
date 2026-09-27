// 海龟汤规则包 v1：竞猜型聚会游戏（situation puzzle）。
// 必需导出（global）：newmatch, tick, snapshot, over。
// 规则只算数：不碰 host.*（无 LLM、无 Jev）、不读墙钟；唯一的"随机性"是
// 题目的确定性抽取（seed 决定，同 seed 同题）。
//
// 席位：p0..p7 是人类玩家（8 席，先猜中汤底者胜），p8 是主持人脑席
//（manifest capabilities 给它授 llm）。汤面在开局由规则按 seed 抽取进 state；
// 汤底在规则端只用于终局揭晓（state.revealed），在主持人端保存在其私有
// memory 里——判定走 commands.judge 通道，规则逐字段校验（LLM 输出不可信）。
//
// 玩家指令（action，白名单，一拍每席一条）：
//   ask:<问题>     占全局唯一的 pending_q，扣 1 次提问预算
//   guess:<猜测>   占全局唯一的 pending_g，扣 1 次竞猜预算；命中即胜
// 主持人指令（judge 通道，经脑席 decide 回传）：
//   { q_tick, answer }    answer ∈ 是|不是|无关|unknown
//   { g_tick, verdict }   verdict ∈ 命中|未中|unknown
// unknown = 主持人没判出来：规则释放 pending、返还预算、提示重试。
//
// 行为驱动：人类没下指令且无待判定项时整轮静止（引擎挂起等指令）；存在
// 待判定项时世界自己走表——主持人在下一拍 decide 里判定，倒计时归零自动
// 释放（防 LLM 长时间不可用时玩家被卡死）。

import type { Judge, LogLine, State } from "./shared";
import { selectPuzzle } from "./puzzles";

var TUNING = {
  seats: 8, // 人类席位数（p0..p7）；主持人脑席固定 p8
  ask_limit: 20, // 每人提问次数
  guess_limit: 2, // 每人竞猜次数（命中即胜，不命中烧 1 次）
  ask_max_chars: 100, // 问题/竞猜文本长度上限
  q_deadline: 8, // 提问判定倒计时（拍），归零释放并返还预算
  g_deadline: 8, // 竞猜判定倒计时（拍）
  qa_cap: 80, // 已答问历史封顶
  ga_cap: 20, // 已判竞猜历史封顶
  log_cap: 80,
};

var Q_ANSWERS = ["是", "不是", "无关"]; // unknown 单独处理（= 释放）

function seatName(seat: string): string {
  var n = parseInt(String(seat).slice(1), 10);
  return "玩家" + (isFinite(n) ? n + 1 : "?");
}

function truncate(t: unknown, n: number): string {
  return String(t == null ? "" : t).slice(0, n);
}

function addLog(
  s: State,
  kind: string,
  text: string,
  events: LogLine[] | null,
): void {
  var line: LogLine = { tick: s.tick, kind: kind, text: text };
  s.log.push(line);
  if (s.log.length > TUNING.log_cap) s.log.shift();
  if (events) events.push(line);
}

// ---- newmatch -------------------------------------------------------------

function newmatch(args: { seed?: number; players?: number; props?: unknown }) {
  var seedIn = args && args.seed ? args.seed : 0;
  var p = selectPuzzle(seedIn);
  var s: State = {
    seed: seedIn,
    tick: 0,
    status: "play",
    puzzle: { id: p.id, surface: p.surface },
    pending_q: null,
    pending_g: null,
    qa: [],
    ga: [],
    budget: {},
    log: [],
    winner: null,
  };
  for (var i = 0; i < TUNING.seats; i++) {
    s.budget["p" + i] = { asks: 0, guesses: 0, joined: false };
  }
  addLog(s, "enter", "深夜汤馆开锅。锅里的故事只有主持人知道——", null);
  addLog(s, "surface", "【汤面】" + p.surface, null);
  addLog(s, "hint", "在输入框提问，主持人只会回答「是 / 不是 / 无关」；凑齐线索后用「竞猜」报出你眼里的真相。", null);
  return { state: s };
}

// ---- command scanning -----------------------------------------------------

// 玩家指令：稳定槽位扫描（p0..p7），每席至多一条 action。
function pickActions(
  commands: Record<string, Record<string, unknown>>,
): Array<{ seat: string; action: string }> {
  var out: Array<{ seat: string; action: string }> = [];
  for (var i = 0; i < TUNING.seats; i++) {
    var c = commands["p" + i] as Record<string, unknown> | undefined;
    if (c && typeof c.action === "string" && c.action) {
      out.push({ seat: "p" + i, action: c.action as string });
    }
  }
  return out;
}

// 主持人判定通道：脑席 decide 的输出落在自己的 p 槽上（这里 p8）。也兼容
// __svc__ 保留席位（与 dungeon 的 pickBrain 同约定）。
function pickJudge(
  commands: Record<string, Record<string, unknown>>,
): Judge | null {
  var scan = ["__svc__"];
  for (var i = 0; i <= TUNING.seats; i++) scan.push("p" + i); // 含 p8 = 主持人
  for (var k = 0; k < scan.length; k++) {
    var c = commands[scan[k]] as Record<string, unknown> | undefined;
    if (c && c.judge && typeof c.judge === "object") {
      return c.judge as Judge;
    }
  }
  return null;
}

// ---- budget helpers -------------------------------------------------------

function refundAsk(s: State, seat: string): void {
  var b = s.budget[seat];
  if (b && b.asks > 0) b.asks -= 1;
}
function refundGuess(s: State, seat: string): void {
  var b = s.budget[seat];
  if (b && b.guesses > 0) b.guesses -= 1;
}

// 出手过的席位是否全部耗尽预算（至少一人出过手才算数，空局永不自尽）。
function allExhausted(s: State): boolean {
  var any = false;
  for (var i = 0; i < TUNING.seats; i++) {
    var b = s.budget["p" + i];
    if (!b || !b.joined) continue;
    any = true;
    if (b.asks < TUNING.ask_limit || b.guesses < TUNING.guess_limit) {
      return false;
    }
  }
  return any;
}

// ---- endgame --------------------------------------------------------------

// 终局唯一入口：汤底在这里第一次（也是最后一次）进入 state。
function endGame(
  s: State,
  winnerSeat: string | null,
  events: LogLine[],
): void {
  s.status = "ended";
  s.winner = winnerSeat;
  s.pending_q = null;
  s.pending_g = null;
  s.revealed = selectPuzzle(s.seed).bottom;
  if (winnerSeat) {
    addLog(s, "win", seatName(winnerSeat) + "猜中了汤底！", events);
  } else {
    addLog(s, "end", "所有玩家的提问与竞猜机会都耗尽了——锅盖揭开。", events);
  }
  addLog(s, "reveal", "【汤底】" + s.revealed, events);
}

// ---- judge application ----------------------------------------------------

function applyJudge(s: State, j: Judge, events: LogLine[]): void {
  // 提问判定
  if (typeof j.q_tick === "number" && s.pending_q && s.pending_q.tick === j.q_tick) {
    var pq = s.pending_q;
    if (j.answer === "unknown") {
      refundAsk(s, pq.seat);
      addLog(s, "release", "主持人没听清" + seatName(pq.seat) + "的问题，已退回——请换一种问法再试。", events);
    } else if (typeof j.answer === "string" && Q_ANSWERS.indexOf(j.answer) >= 0) {
      s.qa.push({ tick: pq.tick, seat: pq.seat, text: pq.text, answer: j.answer });
      if (s.qa.length > TUNING.qa_cap) s.qa.shift();
      addLog(s, "answer", seatName(pq.seat) + "问：" + pq.text + " —— 主持人：" + j.answer, events);
    } else {
      return; // 非法 answer：静默忽略，倒计时兜底释放
    }
    s.pending_q = null;
    return;
  }
  // 竞猜判定
  if (typeof j.g_tick === "number" && s.pending_g && s.pending_g.tick === j.g_tick) {
    var pg = s.pending_g;
    if (j.verdict === "unknown") {
      refundGuess(s, pg.seat);
      addLog(s, "release", "主持人没核对清" + seatName(pg.seat) + "的竞猜，已退回——再试一次。", events);
    } else if (j.verdict === "命中") {
      s.ga.push({ tick: pg.tick, seat: pg.seat, text: pg.text, verdict: "命中" });
      if (s.ga.length > TUNING.ga_cap) s.ga.shift();
      addLog(s, "verdict", seatName(pg.seat) + "发起竞猜：" + pg.text + " —— 主持人：命中！", events);
      endGame(s, pg.seat, events);
    } else if (j.verdict === "未中") {
      s.ga.push({ tick: pg.tick, seat: pg.seat, text: pg.text, verdict: "未中" });
      if (s.ga.length > TUNING.ga_cap) s.ga.shift();
      addLog(s, "verdict", seatName(pg.seat) + "发起竞猜：" + pg.text + " —— 主持人：未中。", events);
    } else {
      return;
    }
    s.pending_g = null;
  }
}

// ---- player commands ------------------------------------------------------

function handleCommand(
  s: State,
  seat: string,
  action: string,
  events: LogLine[],
): void {
  var b = s.budget[seat];
  if (!b) {
    addLog(s, "illegal", "未知席位 " + seat + "。", events);
    return;
  }
  if (action.indexOf("ask:") === 0) {
    var text = action.slice(4).replace(/\s+/g, " ").trim().slice(0, TUNING.ask_max_chars);
    if (!text) {
      addLog(s, "illegal", "问题不能为空。", events);
    } else if (s.pending_q) {
      addLog(s, "illegal", "主持人正在思考" + seatName(s.pending_q.seat) + "的问题，稍等片刻再问。", events);
    } else if (b.asks >= TUNING.ask_limit) {
      addLog(s, "illegal", seatName(seat) + "的提问次数用完了。", events);
    } else {
      b.asks += 1;
      b.joined = true;
      s.pending_q = { tick: s.tick, seat: seat, text: text, left: TUNING.q_deadline };
      addLog(s, "ask", seatName(seat) + "提问（剩 " + (TUNING.ask_limit - b.asks) + " 次）：" + text, events);
    }
    return;
  }
  if (action.indexOf("guess:") === 0) {
    var gtext = action.slice(6).replace(/\s+/g, " ").trim().slice(0, TUNING.ask_max_chars);
    if (!gtext) {
      addLog(s, "illegal", "竞猜内容不能为空。", events);
    } else if (s.pending_g) {
      addLog(s, "illegal", "主持人正在核对" + seatName(s.pending_g.seat) + "的竞猜，稍等片刻。", events);
    } else if (b.guesses >= TUNING.guess_limit) {
      addLog(s, "illegal", seatName(seat) + "的竞猜机会用完了。", events);
    } else {
      b.guesses += 1;
      b.joined = true;
      s.pending_g = { tick: s.tick, seat: seat, text: gtext, left: TUNING.g_deadline };
      addLog(s, "guess", seatName(seat) + "发起竞猜（剩 " + (TUNING.guess_limit - b.guesses) + " 次）：" + gtext, events);
    }
    return;
  }
  addLog(s, "illegal", "无法识别的指令「" + truncate(action, 30) + "」，请用 ask: / guess: 前缀。", events);
}

// ---- pending deadline -----------------------------------------------------

// 倒计时只在真实推进的拍里流逝；归零释放并返还预算。
function releaseExpired(s: State, events: LogLine[]): void {
  if (s.pending_q) {
    s.pending_q.left -= 1;
    if (s.pending_q.left <= 0) {
      refundAsk(s, s.pending_q.seat);
      addLog(s, "release", "主持人迟迟未答，" + seatName(s.pending_q.seat) + "的问题已退回（次数返还）。", events);
      s.pending_q = null;
    }
  }
  if (s.pending_g) {
    s.pending_g.left -= 1;
    if (s.pending_g.left <= 0) {
      refundGuess(s, s.pending_g.seat);
      addLog(s, "release", "主持人迟迟未判，" + seatName(s.pending_g.seat) + "的竞猜已退回（次数返还）。", events);
      s.pending_g = null;
    }
  }
}

// ---- tick -----------------------------------------------------------------

function tick(args: {
  state: State;
  commands?: Record<string, Record<string, unknown>>;
}) {
  var s = JSON.parse(JSON.stringify(args.state)) as State;
  var commands = args.commands || {};
  var events: LogLine[] = [];
  // 防御：破损初始状态不抛错（抛错会杀掉整个 tick 循环）。
  if (!s.puzzle || !s.puzzle.surface || !s.budget) {
    return { state: s, events: events };
  }

  var judge = pickJudge(commands);
  var acts = pickActions(commands);

  // 行为驱动：没有玩家指令、没有待判定项时整轮静止——引擎挂起等指令，
  // 指令一到立刻结算一轮。待判定项存在时世界自己走表（主持人在下一拍
  // decide 里判定，倒计时实时流逝）。
  if (!s.pending_q && !s.pending_g && acts.length === 0 && !judge) {
    return { state: s, events: events, wait: true };
  }

  s.tick = (s.tick || 0) + 1;

  // 1. 主持人判定先落地（同拍既有判定又有新提问时，先释放槽位再收新问题）。
  if (judge) applyJudge(s, judge, events);

  // 2. 玩家指令：逐席位处理，同拍可多人同时出手（槽位被占会得到提示）。
  for (var i = 0; i < acts.length && s.status === "play"; i++) {
    handleCommand(s, acts[i].seat, acts[i].action, events);
  }

  // 3. 待判定倒计时。
  releaseExpired(s, events);

  // 4. 全局枯竭检查。
  if (s.status === "play" && allExhausted(s)) {
    endGame(s, null, events);
  }

  return { state: s, events: events };
}

// ---- snapshot / over ------------------------------------------------------

function snapshot(args: { state: State }) {
  var s = JSON.parse(JSON.stringify(args.state)) as State & {
    seats?: number;
    ask_limit?: number;
    guess_limit?: number;
    ask_max_chars?: number;
  };
  s.seats = TUNING.seats;
  s.ask_limit = TUNING.ask_limit;
  s.guess_limit = TUNING.guess_limit;
  s.ask_max_chars = TUNING.ask_max_chars;
  return s;
}

function over(args: { state: State }) {
  var s = args.state;
  if (s.status === "ended") {
    return {
      over: true,
      result: {
        winner: s.winner || "",
        reason: s.winner ? "puzzle_solved" : "budget_exhausted",
        puzzle_id: s.puzzle ? s.puzzle.id : "",
        revealed: s.revealed || "",
      },
    };
  }
  return { over: null };
}

// quickjs-go locates entries on the global object; the IIFE wrapper keeps
// top-level declarations closure-local, so export them explicitly.
(globalThis as Record<string, unknown>).newmatch = newmatch;
(globalThis as Record<string, unknown>).tick = tick;
(globalThis as Record<string, unknown>).snapshot = snapshot;
(globalThis as Record<string, unknown>).over = over;
