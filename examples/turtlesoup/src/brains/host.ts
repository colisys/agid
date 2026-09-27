// 主持人脑席：海龟汤的裁定者，全包唯一碰 LLM 的席位。
//
// 职责：
//   * 首次 decide 时用 seed 从题库确定性抽题，汤底存进私有 memory——
//     汤底绝不进 state（快照全局单份，进 state 就等于向全场泄底）
//   * 看到 state.pending_q 就调 LLM 判 是/不是/无关，经 commands.judge 回传
//   * 看到 state.pending_g 就判 命中/未中（命中即终局，规则端揭晓汤底）
//
// 纪律：
//   * 绝不 throw（脑席抛错会停整个 tick 循环）
//   * LLM 失败回 unknown（规则端释放并返还预算，玩家重试即可自愈）
//   * 判定结果按 pending 的 tick 缓存进 memory：引擎在等待轮会整轮丢弃
//     decide 输出，state 没落上就凭缓存重发（自愈），不重复烧 LLM；
//     缓存只存判定词，绝不缓存/回传汤底
//   * 任何日志与命令里都不出现汤底

import type { DecideArgs, DecideResult, Judge, Snapshot } from "../shared";
import { selectPuzzle } from "../puzzles";

// QuickJS 注入的脑席通道；类型来自 quickjs.d.ts。
declare const host: QuickJSBrainHost;

var Q_SYSTEM =
  "你是海龟汤游戏的主持人。玩家会围绕汤面提问，你必须只依据汤底的事实来判断。" +
  "回答只能是一个词：是、不是、无关。「无关」表示问题与汤底核心无关。" +
  "只输出这一个词，不要解释、不要标点。";
var G_SYSTEM =
  "你是海龟汤游戏的主持人。玩家会给出对汤底的猜测，你判断它是否抓住了汤底的" +
  "核心真相（关键因果一致即算命中，措辞不必逐字相同；细节偏差不算未中）。" +
  "只输出两个字：命中 或 未中。";

interface HostMem {
  [k: string]: unknown;
  pid?: string;
  surface?: string;
  bottom?: string; // 汤底：只活在主持人私有 memory 里
  answers?: Record<string, string>; // "q<tick>" -> 是|不是|无关
  verdicts?: Record<string, string>; // "g<tick>" -> 命中|未中
}

function clean(text: unknown): string {
  if (typeof text !== "string") return "";
  var t = text
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t
    .replace(/^["'「『《.,，。!？?]+/, "")
    .replace(/["'」』》.,，。!？?]+$/, "")
    .trim();
}

// 解析必须抗住模型的絮叨：先匹配更长的否定词，再匹配肯定词。
function parseAnswer(raw: unknown): string {
  var t = clean(raw);
  if (t.indexOf("无关") >= 0) return "无关";
  if (t.indexOf("不是") >= 0 || t.indexOf("不") === 0) return "不是";
  if (t.indexOf("是") >= 0) return "是";
  return "unknown";
}

function parseVerdict(raw: unknown): string {
  var t = clean(raw);
  if (t.indexOf("未") >= 0) return "未中";
  if (t.indexOf("命中") >= 0) return "命中";
  return "unknown";
}

// 缓存封顶：键是 "q<tick>"/"g<tick>"，按数字部分裁掉最旧的。
var CACHE_CAP = 24;
function pruneCache(c: Record<string, string>): void {
  var keys = Object.keys(c);
  if (keys.length <= CACHE_CAP) return;
  keys.sort(function (a, b) {
    return (
      (parseInt(a.replace(/\D/g, ""), 10) || 0) -
      (parseInt(b.replace(/\D/g, ""), 10) || 0)
    );
  });
  var drop = keys.length - CACHE_CAP;
  for (var i = 0; i < drop; i++) delete c[keys[i]];
}

// 同步 LLM 调用（decide 路径，学地牢序章模式）：主持人是全场的节拍器，
// 玩家本来就等他说话；失败一律回 unknown，由规则端释放并返还预算。
function askAnswer(snap: Snapshot, question: string, mem: HostMem): string {
  try {
    var out = host.llm("", [
      { role: "system", content: Q_SYSTEM },
      {
        role: "user",
        content:
          "【汤面】" +
          (snap.puzzle ? snap.puzzle.surface : mem.surface || "") +
          "\n【汤底】" +
          (mem.bottom || "") +
          "\n【玩家的问题】" +
          question +
          "\n只回答：是 / 不是 / 无关",
      },
    ]);
    return parseAnswer(out);
  } catch (err) {
    // 日志绝不带汤底
    host.log("[host] LLM 提问判定失败: " + err);
    return "unknown";
  }
}

function askVerdict(snap: Snapshot, guess: string, mem: HostMem): string {
  try {
    var out = host.llm("", [
      { role: "system", content: G_SYSTEM },
      {
        role: "user",
        content:
          "【汤面】" +
          (snap.puzzle ? snap.puzzle.surface : mem.surface || "") +
          "\n【汤底】" +
          (mem.bottom || "") +
          "\n【玩家的竞猜】" +
          guess +
          "\n只输出：命中 或 未中",
      },
    ]);
    return parseVerdict(out);
  } catch (err) {
    host.log("[host] LLM 竞猜判定失败: " + err);
    return "unknown";
  }
}

function decide(args: DecideArgs): DecideResult {
  var mem: HostMem = (args.memory &&
  typeof args.memory === "object"
    ? args.memory
    : {}) as HostMem;
  var commands: { judge?: Judge } = {};
  try {
    var snap = (args.snapshot || {}) as Snapshot;

    // 0) 题目保障：首次 decide 按 seed 抽题。抽题本身是纯函数、幂等——
    //    等待轮 decide 输出被引擎整轮丢弃也不影响，重算即可。
    if (!mem.bottom) {
      var p = selectPuzzle(snap.seed || 0);
      mem.pid = p.id;
      mem.surface = p.surface;
      mem.bottom = p.bottom;
      mem.answers = {};
      mem.verdicts = {};
    }

    // 1) 竞猜判定优先（命中即终局，一拍一票）。
    var pg = snap.pending_g;
    if (pg) {
      var gkey = "g" + pg.tick;
      var verdict = (mem.verdicts || {})[gkey] || "";
      if (!verdict) {
        verdict = askVerdict(snap, pg.text, mem);
        if (verdict !== "unknown") {
          mem.verdicts = mem.verdicts || {};
          mem.verdicts[gkey] = verdict;
          pruneCache(mem.verdicts);
        }
      }
      // 缓存命中直接重发（自愈）；unknown 也回传——规则端释放并返还预算。
      commands.judge = { g_tick: pg.tick, verdict: verdict };
      return { commands: commands, memory: mem };
    }

    // 2) 提问判定。
    var pq = snap.pending_q;
    if (pq) {
      var qkey = "q" + pq.tick;
      var answer = (mem.answers || {})[qkey] || "";
      if (!answer) {
        answer = askAnswer(snap, pq.text, mem);
        if (answer !== "unknown") {
          mem.answers = mem.answers || {};
          mem.answers[qkey] = answer;
          pruneCache(mem.answers);
        }
      }
      if (answer) {
        commands.judge = { q_tick: pq.tick, answer: answer };
      }
    }
  } catch (err) {
    // 兜底：绝不向上抛，否则 tick loop 会停
    try {
      host.log("[host] 异常降级: " + err);
    } catch (e2) {
      /* host 不可用 */
    }
  }
  return { commands: commands, memory: mem };
}

(globalThis as Record<string, unknown>).decide = decide;
