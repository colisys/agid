// DM brain: the Jev-driven Dungeon Master — an adversarial seat for HUMAN
// matches. While the adventurer fights, the dungeon itself fights back: every
// GAP decisions the dm asks Jev (host.intent) to pick one hostile "move", and
// the rules — which never touch host.* — apply it deterministically:
//   ambush  -> the next ordinary monster wakes stronger (+30% hp, +1 atk)
//   hex     -> the adventurer's next attack whiffs
//   tremor  -> falling rubble, 2-4 immediate damage
// Guardrails (defense in depth, because a stalled loop is worse than a mean
// dungeon):
//   * rules-side cooldown (TUNING.dm_cooldown=5 ticks) + shallow-depth amnesty
//     (dm_min_depth=3) — this brain hardcodes the same numbers (mirroring the
//     brain_common gear_every convention) and still defers to the rules check
//   * decide-count gap (NOT snap.tick: waits freeze the tick, not the decider)
//   * no moves while pending (shopping is sacred) or after death
//   * one failure -> breaker, silence for MUTE_TICKS
import { hpRatio } from "../brain_common";
import type { DecideArgs, DecideResult, Snapshot } from "../shared";

// QuickJS 注入的脑席通道；类型来自 quickjs.d.ts。
declare const host: QuickJSBrainHost;

var FAIL_LIMIT = 1;
var MUTE_TICKS = 90; // 地牢之主失手可以久一点不理人
var GAP = 8; // 两次出手之间至少隔 8 次 decide（约 8 个活跃 tick）
var MIN_DEPTH = 3; // 镜像 rules TUNING.dm_min_depth：浅层不欺负新人

var MOVES: Record<string, string> = {
  ambush: "唤醒伏兵——下一只普通怪物更强（生命 +30%、攻击 +1）",
  hex: "诅咒他的兵器——他下一次攻击必然落空",
  tremor: "震塌甬道——立刻砸他 2-4 点体力",
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
      host.log("[dm] intent 失败，地牢之主暂歇 " + MUTE_TICKS + " 回合");
    } catch (e2) {
      /* host 不可用 */
    }
  }
}

function decide(args: DecideArgs): DecideResult {
  var snap = (args.snapshot || {}) as Snapshot;
  var mem = args.memory && typeof args.memory === "object" ? args.memory : {};
  var commands: { dm?: import("../shared").DmMove } = {};
  try {
    var dc = ((mem.dc as number) || 0) + 1;
    mem.dc = dc;
    var eligible =
      snap.hero &&
      snap.hero.hp > 0 &&
      !snap.pending &&
      (snap.depth || 0) >= MIN_DEPTH &&
      !muted(mem, snap) &&
      dc >= ((mem.next_dc as number) || 0);
    if (eligible) {
      mem.next_dc = dc + GAP;
      var move = pickMove(snap);
      if (move) {
        commands.dm = { move: move };
      }
    }
  } catch (err) {
    // 兜底：绝不向上抛，否则 tick loop 会停
    try {
      host.log("[dm] 异常降级: " + err);
      markFail(mem, snap);
    } catch (e2) {
      /* host 不可用 */
    }
  }
  return { commands: commands, memory: mem };
}

function pickMove(snap: Snapshot): import("../shared").DmMove["move"] | "" {
  var picked = host.intent({
    goal:
      "你就是地牢之主。一个冒险者正在你的地牢里逐层烧杀抢掠——" +
      "选一个当下最能阻挡他的手段。不必仁慈，但要在关键处下手。",
    user_input: JSON.stringify({
      hp: snap.hero.hp,
      hp_max: snap.hero.hp_max,
      hp_ratio: Math.round(hpRatio(snap) * 100) / 100,
      depth: snap.depth,
      level: snap.level,
      gold: snap.gold,
      kills: snap.kills,
      foe_present: !!snap.foe,
      foe: snap.foe ? snap.foe.name : "",
      stance: snap.hero.stance,
    }),
    context: {
      hero: snap.hero,
      foe: snap.foe,
      equip: snap.equip,
      statuses: snap.statuses,
    },
    routes: MOVES,
  });
  var move = picked && typeof picked.route === "string" ? picked.route : "";
  var conf =
    picked && typeof picked.confidence === "number" ? picked.confidence : 0;
  if (!(move in MOVES) || conf < 0.3) {
    return ""; // 低置信就不出手——地牢之主也在观望
  }
  return move as import("../shared").DmMove["move"];
}

(globalThis as Record<string, unknown>).decide = decide;
