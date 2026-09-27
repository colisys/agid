// Oracle brain: the Jev-driven tactical whisperer for HUMAN matches.
//
// The dungeon sage (sage.ts) plays by itself in headless demos; the oracle
// instead sits beside a human player and only whispers advice — the player is
// free to ignore it. host.intent is called at exactly three low-frequency
// decision points, each keyed by a situation signature so the same situation
// never asks twice (Jev costs seconds; a per-tick pattern would stall the
// loop):
//   A. event room pending  -> which option looks sane
//   B. elite/boss sighted  -> which tactic (with a local solver hint first)
//   C. low hp in combat    -> flee/heal warning
// Output is commands.whisper = {sig, text}; the rules dedupe by sig, render it
// as a log line kind "whisper", and never let it touch numbers. Any failure
// trips the same breaker as sage: one failure -> mute, heuristics carry on.
import { hpRatio, RISKY_OPTS } from "../brain_common";
import type { DecideArgs, DecideResult, Opt, Snapshot } from "../shared";

// QuickJS 注入的脑席通道；类型来自 quickjs.d.ts。
declare const host: QuickJSBrainHost;

var FAIL_LIMIT = 1; // 失败一次就熔断：建议可以缺席，卡顿不能接受
var MUTE_TICKS = 60; // 60 回合后再试一次
var LOW_CONF = 0.4; // 低置信度宁可不说话

var TACTIC_LABEL: Record<string, string> = {
  aggressive: "趁它没站稳，连续猛攻",
  careful: "先举盾稳住，等血线安全再攻",
  item_heavy: "别耗了，用炸弹速战速决",
};

function muted(mem: Record<string, unknown>, snap: Snapshot): boolean {
  return (
    typeof mem.mute_until === "number" &&
    (snap.tick || 0) < (mem.mute_until as number)
  );
}

function markFail(mem: Record<string, unknown>, snap: Snapshot): void {
  mem.fail_streak = ((mem.fail_streak as number) || 0) + 1;
  if ((mem.fail_streak as number) >= FAIL_LIMIT) {
    mem.fail_streak = 0;
    mem.mute_until = (snap.tick || 0) + MUTE_TICKS;
    try {
      host.log("[oracle] intent 失败，暂停低语 " + MUTE_TICKS + " 回合");
    } catch (e2) {
      /* host 不可用 */
    }
  }
}

// 统一收口：问 Jev 选路由，低置信返回 null（不说话）。
function ask(
  goal: string,
  userInput: Record<string, unknown>,
  context: Record<string, unknown>,
  routes: Record<string, string>,
): string | null {
  var picked = host.intent({
    goal: goal,
    user_input: JSON.stringify(userInput),
    context: context,
    routes: routes,
  });
  var route = picked && typeof picked.route === "string" ? picked.route : "";
  var conf =
    picked && typeof picked.confidence === "number" ? picked.confidence : 0;
  if (!(route in routes) || conf < LOW_CONF) {
    return null;
  }
  return route;
}

function decide(args: DecideArgs): DecideResult {
  var snap = (args.snapshot || {}) as Snapshot;
  var mem = args.memory && typeof args.memory === "object" ? args.memory : {};
  var commands: { whisper?: { sig: string; text: string } } = {};
  try {
    // 终局/已死：地牢里不再有军师。
    if (snap.hero && snap.hero.hp > 0 && !muted(mem, snap)) {
      var sig = situation(snap);
      // 同一情境只问一次；情境消失后 mem.sig 清空，可再次低语。
      if (sig && sig !== (mem.sig as string)) {
        var text = advise(snap, sig, mem);
        if (text) {
          commands.whisper = { sig: sig, text: text };
        }
        mem.sig = sig;
      } else if (!sig) {
        mem.sig = "";
      }
    } else {
      mem.sig = "";
    }
  } catch (err) {
    // 兜底：绝不向上抛，否则 tick loop 会停
    try {
      host.log("[oracle] 异常降级: " + err);
      markFail(mem, snap);
    } catch (e2) {
      /* host 不可用 */
    }
  }
  return { commands: commands, memory: mem };
}

// 当前是否有值得低语的情境；有则返回签名（rules 侧也用它去重）。
function situation(snap: Snapshot): string {
  if (snap.pending) {
    return (
      "pending:" + snap.pending.event_id + ":" + snap.pending.deadline_tick
    );
  }
  if (snap.foe && (snap.foe.elite || snap.foe.boss)) {
    return "tactic:" + snap.foe.name + "@" + snap.foe.hp_max;
  }
  if (snap.foe && hpRatio(snap) < 0.35) {
    return "lowhp:" + snap.depth + ":" + snap.foe.name;
  }
  return "";
}

function advise(
  snap: Snapshot,
  sig: string,
  mem: Record<string, unknown>,
): string {
  if (sig.indexOf("pending:") === 0) {
    return advisePending(snap);
  }
  if (sig.indexOf("tactic:") === 0) {
    return adviseTactic(snap, mem);
  }
  return adviseLowHp(snap, mem);
}

// A. 事件房：给一句倾向性建议，绝不替玩家做主。
// v5.6：事件房低语不再烧 Jev——同步 intent 会把玩家点击动作后的结算卡住
// 几十秒（体感「点了没反应，过了好几轮才出字」）。改用确定性提示，零延迟；
// 精英/守主战法（B）保留 Jev（开战前的一次性建议，卡顿可接受）。
function advisePending(snap: Snapshot): string {
  var p = snap.pending!;
  var risky = p.options.filter(function (o: Opt) {
    return RISKY_OPTS.indexOf(o.id) >= 0;
  });
  if (hpRatio(snap) < 0.35 && risky.length) {
    return "血不多了，「" + risky[0].label + "」这种先别碰。";
  }
  var free = p.options.filter(function (o: Opt) {
    return typeof o.cost !== "number";
  });
  if (free.length) {
    return "稳一点的话，「" + free[0].label + "」不吃亏。";
  }
  return "想清楚再选——超时会自动按默认的来。";
}

// B. 精英/守主：先问本地 solver 要一句提示（可用则带上当上下文），再问 Jev。
function adviseTactic(snap: Snapshot, mem: Record<string, unknown>): string {
  var hint = "";
  try {
    var h = host.svc("solver", "/hint", {
      hp: snap.hero.hp,
      hp_max: snap.hero.hp_max,
      depth: snap.depth,
      foe: snap.foe ? snap.foe.name : "",
      foe_intent: snap.foe && snap.foe.intent ? snap.foe.intent : "",
    });
    if (h && typeof h.hint === "string") {
      hint = h.hint;
    }
  } catch (e) {
    /* solver 不可用：低语不依赖它 */
  }
  var route = ask(
    "冒险者撞上了强敌。你是观战的军师——从三种战法里挑一个最稳的。",
    {
      hp: snap.hero.hp,
      hp_max: snap.hero.hp_max,
      atk: snap.hero.atk,
      foe: snap.foe,
      gold: snap.gold,
      solver_hint: hint,
    },
    {
      hero: snap.hero,
      foe: snap.foe,
      equip: snap.equip,
      statuses: snap.statuses,
    },
    TACTIC_LABEL,
  );
  if (!route) {
    return "";
  }
  mem.last_tactic = route;
  return (
    (snap.foe ? snap.foe.name : "这东西") +
    "不好惹——" +
    TACTIC_LABEL[route] +
    "。"
  );
}

// C. 濒死警示：确定性触发，不值得烧一次 Jev——直接说人话。
function adviseLowHp(snap: Snapshot, _mem: Record<string, unknown>): string {
  var hasPotion = (snap.actions || []).indexOf("use:potion") >= 0;
  return hasPotion
    ? "血见底了——喝药，或者退回上一层。"
    : "血见底了——别恋战，先撤。";
}

(globalThis as Record<string, unknown>).decide = decide;
