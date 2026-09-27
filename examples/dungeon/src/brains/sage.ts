// Sage brain: the Jev-driven decision maker.
//
// host.intent is called at exactly two low-frequency decision points — never
// per tick (a Jev call costs seconds; the RTS packs' every-tick pattern would
// stall the realtime loop):
//   A. event rooms  -> pick one of the room's options (or the default)
//   B. elite/boss   -> pick a combat tactic (aggressive/careful/item_heavy)
// Any failure trips a breaker copied from the narrator brain (one failure ->
// mute for MUTE_TICKS); while muted, and on every non-decision tick, the
// shared deterministic heuristic from brain_common takes over. Event rooms
// also carry a rules-side deadline with a default option, so even a hung Jev
// can at worst cost the default choice — degradation is graceful by design.
import {
  pickPendingOption,
  pickFallbackAction,
  bestEquipDiff,
  hpRatio,
  has,
  RISKY_OPTS,
} from "../brain_common";
import type { Commands, DecideArgs, DecideResult, Snapshot } from "../shared";

// QuickJS 注入的脑席通道；类型来自 quickjs.d.ts。
declare const host: QuickJSBrainHost;

var FAIL_LIMIT = 1; // 失败一次就熔断：决策可以兜底，卡顿不能接受
var MUTE_TICKS = 60; // 60 回合（实时局约 2 分钟）后再试一次
var LOW_CONF = 0.4; // 低于此置信度不替玩家冒险，取默认

var TACTIC_ROUTES: Record<string, string> = {
  aggressive: "尽快击杀敌人：连续攻击",
  careful: "先稳住：格挡回血，等血线安全再攻",
  item_heavy: "优先用消耗品（炸弹等）速战速决",
};

function markFail(mem: Record<string, unknown>, snap: Snapshot): void {
  mem.fail_streak = ((mem.fail_streak as number) || 0) + 1;
  if ((mem.fail_streak as number) >= FAIL_LIMIT) {
    mem.fail_streak = 0;
    mem.mute_until = (snap.tick || 0) + MUTE_TICKS;
    try {
      host.log(
        "[sage] intent 失败，暂停请求 " + MUTE_TICKS + " 回合（回退启发式）",
      );
    } catch (e2) {
      /* host 不可用 */
    }
  }
}

function muted(mem: Record<string, unknown>, snap: Snapshot): boolean {
  return (
    typeof mem.mute_until === "number" &&
    (snap.tick || 0) < (mem.mute_until as number)
  );
}

function tacticKey(snap: Snapshot): string {
  var f = snap.foe;
  return f ? f.name + "@" + f.hp_max : "";
}

// 决策点 A：事件房。返回 null 表示没问成（调用方走启发式）。
function askPending(
  snap: Snapshot,
  mem: Record<string, unknown>,
): DecideResult {
  var p = snap.pending!;
  var routes: Record<string, string> = { default: "超时默认选项" };
  p.options.forEach(function (o) {
    routes[o.id] =
      o.label +
      "：" +
      o.desc +
      (typeof o.cost === "number" ? "（花费 " + o.cost + " 金）" : "");
  });
  var picked = host.intent({
    goal: "在地牢里活到最后并击杀地牢之主",
    user_input: JSON.stringify({
      hp: snap.hero.hp,
      hp_max: snap.hero.hp_max,
      gold: snap.gold,
      potions: snap.potions,
      depth: snap.depth,
      level: snap.level,
      event: p.event_id,
      title: p.title,
    }),
    context: {
      hero: snap.hero,
      foe: snap.foe,
      equip: snap.equip,
      statuses: snap.statuses,
      pending: p,
    },
    routes: routes,
  });
  var route =
    picked && typeof picked.route === "string" ? picked.route : "default";
  var conf =
    picked && typeof picked.confidence === "number" ? picked.confidence : 0;
  var known = false;
  p.options.forEach(function (o) {
    if (o.id === route) {
      known = true;
    }
  });
  if (route === "default" || !known) {
    route = p.default;
  }
  if (hpRatio(snap) < 0.35 && RISKY_OPTS.indexOf(route) >= 0) {
    route = p.default;
  } // 硬覆盖：残血不赌
  if (conf < LOW_CONF) {
    route = p.default;
  }
  mem.last_pending = p.deadline_tick;
  mem.last_conf = conf;
  return { commands: { choose: route }, memory: mem };
}

// 决策点 B：精英/Boss 战术。同一只怪只问一次（memory 记 key）。
// 问 Jev 之前先问本地 Python solver（host.svc，manifest 声明 svc:solver 才可用）
// 要一句战术提示，塞进 user_input 当上下文——solver 挂了就静默跳过，不影响决策。
function askTactic(snap: Snapshot, mem: Record<string, unknown>): DecideResult {
  mem.tactic_key = tacticKey(snap);
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
    /* solver 不可用：决策不依赖它 */
  }
  var picked = host.intent({
    goal: "在地牢里活到最后并击杀地牢之主",
    user_input: JSON.stringify({
      hp: snap.hero.hp,
      hp_max: snap.hero.hp_max,
      atk: snap.hero.atk,
      foe: snap.foe,
      gold: snap.gold,
      inventory: snap.inventory,
      solver_hint: hint,
    }),
    context: {
      hero: snap.hero,
      foe: snap.foe,
      equip: snap.equip,
      statuses: snap.statuses,
    },
    routes: TACTIC_ROUTES,
  });
  var route = picked && typeof picked.route === "string" ? picked.route : "";
  var conf =
    picked && typeof picked.confidence === "number" ? picked.confidence : 0;
  if (!(route in TACTIC_ROUTES) || conf < LOW_CONF) {
    route = (mem.last_tactic as string) || "careful"; // 低置信度沿用上局战术
  }
  mem.last_tactic = route;
  mem.last_conf = conf;

  var cmds: Commands = {};
  if (route === "careful") {
    cmds.action = "guard";
  } else if (route === "item_heavy") {
    cmds.action = has(snap.actions || [], "use:bomb") ? "use:bomb" : "attack";
  } else {
    cmds.action = "attack";
  }
  return { commands: cmds, memory: mem };
}

function decide(args: DecideArgs): DecideResult {
  var snap = (args.snapshot || {}) as Snapshot;
  var mem = args.memory && typeof args.memory === "object" ? args.memory : {};
  var cmds: Commands = {};

  // 换装是免费动作，永远走确定性规则，不劳 Jev。
  var eq = bestEquipDiff(snap);
  if (eq) {
    cmds.equip = eq;
  }

  try {
    if (!muted(mem, snap)) {
      if (snap.pending && mem.last_pending !== snap.pending.deadline_tick) {
        var r = askPending(snap, mem);
        r.commands = Object.assign({}, cmds, r.commands);
        return r;
      }
      if (
        snap.foe &&
        (snap.foe.elite || snap.foe.boss) &&
        mem.tactic_key !== tacticKey(snap)
      ) {
        var t = askTactic(snap, mem);
        t.commands = Object.assign({}, cmds, t.commands);
        return t;
      }
    }
  } catch (err) {
    try {
      host.log("[sage] intent 失败: " + err);
    } catch (e2) {
      /* host 不可用 */
    }
    markFail(mem, snap);
  }

  // 非 decision tick 或已熔断：
  if (snap.pending) {
    cmds.choose = pickPendingOption(snap); // 事件房兜底：启发式选
  } else if (
    snap.foe &&
    (snap.foe.elite || snap.foe.boss) &&
    mem.tactic_key === tacticKey(snap)
  ) {
    // 精英战进行中：战术姿态保持粘滞，只在血线告急时干预一次。
    // 行为驱动规则下“不发指令”会被当作玩家没行动而挂起，所以粘滞期间
    // 显式重发当前姿态（与实时局的空指令语义完全一致）。
    if (hpRatio(snap) < 0.35 && has(snap.actions || [], "potion")) {
      cmds.action = "potion";
    } else if (hpRatio(snap) < 0.2 && has(snap.actions || [], "flee")) {
      cmds.action = "flee";
    } else {
      cmds.action = (snap.hero && snap.hero.stance) || "attack";
    }
  } else {
    var pick = pickFallbackAction(snap, mem);
    cmds.action = pick;
    var streak =
      typeof mem.guard_streak === "number" ? (mem.guard_streak as number) : 0;
    mem.guard_streak = pick === "guard" ? streak + 1 : 0;
  }
  return { commands: cmds, memory: mem };
}

(globalThis as Record<string, unknown>).decide = decide;
