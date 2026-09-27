// GENERATED from src/brains/gm.ts — 源码在 src/，请勿直接编辑本文件。
"use strict";
(() => {
  // src/brains/gm.ts
  function digest(snap) {
    return {
      seed: snap.seed,
      tick: snap.tick,
      depth: snap.depth,
      gold: snap.gold,
      potions: snap.potions,
      kills: snap.kills,
      boss_kills: snap.boss_kills,
      hero: { hp: snap.hero?.hp, hp_max: snap.hero?.hp_max, atk: snap.hero?.atk },
      foe: snap.foe ? { name: snap.foe.name, hp: snap.foe.hp, hp_max: snap.foe.hp_max, boss: snap.foe.boss } : null,
      pending: snap.pending ? { title: snap.pending.title, deadline_tick: snap.pending.deadline_tick } : null,
      inventory: (snap.inventory || []).slice(0, 16),
      statuses: snap.statuses || {},
      resumes: snap.resumes || 0,
      log: (snap.log || []).slice(-6)
    };
  }
  function decide(args) {
    var mem = args.memory || {};
    var snap = args.snapshot;
    var tick = snap.tick || 0;
    var commands = {};
    if (typeof mem.mute_until === "number" && tick < mem.mute_until) {
      return { commands: {}, memory: mem };
    }
    if (mem.last_tick === tick) {
      return { commands, memory: mem };
    }
    mem.last_tick = tick;
    try {
      host.svc("pm", "/observe", { key: String(snap.seed), observe: digest(snap) });
      var polled = host.svc("pm", "/poll?key=" + encodeURIComponent(String(snap.seed)), {});
      if (polled && Array.isArray(polled.ops) && polled.ops.length) {
        commands.gm = { ops: polled.ops };
      }
    } catch (e) {
      mem.mute_until = tick + 30;
    }
    return { commands, memory: mem };
  }
  globalThis.decide = decide;
})();
