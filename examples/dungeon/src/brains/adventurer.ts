// Adventurer brain v2: a Jev-free, LLM-free auto-player for the dungeon rules.
// It is what makes "headless N runs, compare win rate" and `--verify`
// determinism possible: swapping this file for another brain is the whole
// experiment. Everything routes through the shared heuristic in brain_common
// (event-room choices, combat postures incl. consumables, auto-equip).
import {
  pickPendingOption,
  pickFallbackAction,
  bestEquipDiff,
} from "../brain_common";
import type { Commands, DecideArgs, DecideResult } from "../shared";

function decide(args: DecideArgs): DecideResult {
  try {
    var snap = args.snapshot || ({} as DecideArgs["snapshot"]);
    var mem = args.memory && typeof args.memory === "object" ? args.memory : {};
    var cmds: Commands = {};

    var eq = bestEquipDiff(snap);
    if (eq) {
      cmds.equip = eq;
    }

    if (snap.pending) {
      cmds.choose = pickPendingOption(snap); // 事件房决策：启发式直接定
    } else {
      var pick = pickFallbackAction(snap, mem);
      cmds.action = pick;
      var streak =
        typeof mem.guard_streak === "number" ? (mem.guard_streak as number) : 0;
      mem.guard_streak = pick === "guard" ? streak + 1 : 0;
    }
    return { commands: cmds, memory: mem };
  } catch (err) {
    // A throwing brain stops the tick loop, so never let one out.
    return { commands: { action: "attack" }, memory: { guard_streak: 0 } };
  }
}

(globalThis as Record<string, unknown>).decide = decide;
