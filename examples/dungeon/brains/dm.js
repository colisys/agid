// GENERATED from src/brains/dm.ts — 源码在 src/，请勿直接编辑本文件。
"use strict";
(() => {
  // src/brain_common.ts
  function hpRatio(snap) {
    var h = snap.hero;
    return h && h.hp_max ? h.hp / h.hp_max : 1;
  }

  // src/brains/dm.ts
  var FAIL_LIMIT = 1;
  var MUTE_TICKS = 90;
  var GAP = 8;
  var MIN_DEPTH = 3;
  var MOVES = {
    ambush: "唤醒伏兵——下一只普通怪物更强（生命 +30%、攻击 +1）",
    hex: "诅咒他的兵器——他下一次攻击必然落空",
    tremor: "震塌甬道——立刻砸他 2-4 点体力"
  };
  function muted(mem, snap) {
    return typeof mem.mute_until === "number" && (snap.tick || 0) < mem.mute_until;
  }
  function markFail(mem, snap) {
    mem.fail_streak = (mem.fail_streak || 0) + 1;
    if (mem.fail_streak >= FAIL_LIMIT) {
      mem.fail_streak = 0;
      mem.mute_until = (snap.tick || 0) + MUTE_TICKS;
      try {
        host.log("[dm] intent 失败，地牢之主暂歇 " + MUTE_TICKS + " 回合");
      } catch (e2) {
      }
    }
  }
  function decide(args) {
    var snap = args.snapshot || {};
    var mem = args.memory && typeof args.memory === "object" ? args.memory : {};
    var commands = {};
    try {
      var dc = (mem.dc || 0) + 1;
      mem.dc = dc;
      var eligible = snap.hero && snap.hero.hp > 0 && !snap.pending && (snap.depth || 0) >= MIN_DEPTH && !muted(mem, snap) && dc >= (mem.next_dc || 0);
      if (eligible) {
        mem.next_dc = dc + GAP;
        var move = pickMove(snap);
        if (move) {
          commands.dm = { move };
        }
      }
    } catch (err) {
      try {
        host.log("[dm] 异常降级: " + err);
        markFail(mem, snap);
      } catch (e2) {
      }
    }
    return { commands, memory: mem };
  }
  function pickMove(snap) {
    var picked = host.intent({
      goal: "你就是地牢之主。一个冒险者正在你的地牢里逐层烧杀抢掠——选一个当下最能阻挡他的手段。不必仁慈，但要在关键处下手。",
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
        stance: snap.hero.stance
      }),
      context: {
        hero: snap.hero,
        foe: snap.foe,
        equip: snap.equip,
        statuses: snap.statuses
      },
      routes: MOVES
    });
    var move = picked && typeof picked.route === "string" ? picked.route : "";
    var conf = picked && typeof picked.confidence === "number" ? picked.confidence : 0;
    if (!(move in MOVES) || conf < 0.3) {
      return "";
    }
    return move;
  }
  globalThis.decide = decide;
})();
