// GENERATED from src/brains/adventurer.ts — 源码在 src/，请勿直接编辑本文件。
"use strict";
(() => {
  // src/brain_common.ts
  function has(list, x) {
    return list.indexOf(x) >= 0;
  }
  function hpRatio(snap) {
    var h = snap.hero;
    return h && h.hp_max ? h.hp / h.hp_max : 1;
  }
  var GUARD_RUN_CAP = 3;
  var TRINKET_PRIO = ["lantern", "charm", "ring_regen", "amulet", "cursed_ring"];
  function baseOf(entry) {
    var i = entry.indexOf("@");
    return i < 0 ? entry : entry.slice(0, i);
  }
  function gearDepth(entry) {
    var i = entry.indexOf("@");
    return i < 0 ? 1 : parseInt(entry.slice(i + 1), 10) || 1;
  }
  function gearScaled(v, entry) {
    if (!v) return 0;
    return v + Math.floor((gearDepth(entry) - 1) / 3);
  }
  function isUnid(snap, entry) {
    var u = snap.unidentified || [];
    return u.indexOf(baseOf(entry)) >= 0;
  }
  function pickPendingOption(snap) {
    var p = snap.pending;
    if (!p) {
      return "";
    }
    var gold = snap.gold || 0;
    var cat = snap.catalog || {};
    if (p.event_id === "merchant") {
      var best = "", bestScore = -1;
      for (var i = 0; i < p.options.length; i++) {
        var o = p.options[i];
        if (typeof o.cost !== "number" || o.cost > gold) {
          continue;
        }
        var it = p.wares ? cat[p.wares[parseInt(o.id.slice(3), 10)]] : null;
        if (!it) {
          continue;
        }
        var score = (it.atk || 0) * 2 + (it.armor || 0) * 2 + (it.heal || 0) / 8 + (it.hp_max || 0);
        if (score > bestScore) {
          bestScore = score;
          best = o.id;
        }
      }
      return best || "leave";
    }
    if (p.event_id === "altar") {
      var cursed = !!snap.equip && (baseOf(snap.equip.trinket || "") === "cursed_ring" || baseOf(snap.equip.armor || "") === "lead_boots");
      if (cursed) {
        return "pray";
      }
      return hpRatio(snap) > 0.6 ? "pray" : "leave";
    }
    if (p.event_id === "chest") {
      return hpRatio(snap) > 0.5 ? "open" : "leave";
    }
    if (p.event_id === "fork") {
      return !!(snap.equip && baseOf(snap.equip.trinket || "") === "lantern") ? "tunnel" : "path";
    }
    if (p.event_id === "adventurer") {
      return (snap.potions || 0) > 1 ? "give" : "leave";
    }
    if (p.event_id === "gambler") {
      return "leave";
    }
    return p.default;
  }
  function pickFallbackAction(snap, mem) {
    var actions = snap.actions || [];
    var ratio = hpRatio(snap);
    var streak = typeof mem.guard_streak === "number" ? mem.guard_streak : 0;
    if (ratio < 0.35 && has(actions, "potion")) {
      return "potion";
    }
    if (ratio < 0.5 && has(actions, "use:potion_big")) {
      return "use:potion_big";
    }
    if (ratio < 0.2 && has(actions, "flee")) {
      return "flee";
    }
    if (ratio < 0.35 && has(actions, "guard") && streak < GUARD_RUN_CAP) {
      return "guard";
    }
    if (snap.foe && snap.foe.hp > 15 && has(actions, "use:bomb")) {
      return "use:bomb";
    }
    if (has(actions, "explore")) {
      var explored = snap.flags && snap.flags.explores_this_layer || 0;
      var quota = snap.foes_left || 0;
      var nextIsBoss = ((snap.depth || 0) + 1) % 5 === 0;
      if (quota > 0 || explored < 4 || nextIsBoss && ratio < 0.85) {
        return "explore";
      }
    }
    if (has(actions, "descend")) {
      return "descend";
    }
    if (has(actions, "attack")) {
      return "attack";
    }
    return actions.length ? actions[0] : "guard";
  }
  function hasNonCursedArmor(inv, cat) {
    for (var i = 0; i < inv.length; i++) {
      var it = cat[baseOf(inv[i])];
      if (it && it.slot === "armor" && it.kind !== "cursed") {
        return true;
      }
    }
    return false;
  }
  function bestEquipDiff(snap) {
    var cat = snap.catalog || {};
    var inv = snap.inventory || [];
    var eq = snap.equip || { weapon: null, armor: null, trinket: null };
    var i, entry, it;
    var best = null;
    var bestScore = eq.weapon && !isUnid(snap, eq.weapon) ? gearScaled(cat[baseOf(eq.weapon)]?.atk, eq.weapon) : -1;
    for (i = 0; i < inv.length; i++) {
      entry = inv[i];
      it = cat[baseOf(entry)];
      if (!it || it.slot !== "weapon" || isUnid(snap, entry)) {
        continue;
      }
      if (gearScaled(it.atk, entry) > bestScore) {
        bestScore = gearScaled(it.atk, entry);
        best = entry;
      }
    }
    if (best) {
      return best;
    }
    best = null;
    bestScore = eq.armor && !isUnid(snap, eq.armor) ? gearScaled(cat[baseOf(eq.armor)]?.armor, eq.armor) : -1;
    var alt = hasNonCursedArmor(
      inv,
      cat
    );
    for (i = 0; i < inv.length; i++) {
      entry = inv[i];
      it = cat[baseOf(entry)];
      if (!it || it.slot !== "armor" || isUnid(snap, entry)) {
        continue;
      }
      if (baseOf(entry) === "lead_boots" && alt) {
        continue;
      }
      if (gearScaled(it.armor, entry) > bestScore) {
        bestScore = gearScaled(it.armor, entry);
        best = entry;
      }
    }
    if (best) {
      return best;
    }
    var curBase = eq.trinket ? baseOf(eq.trinket) : "";
    var curRank = curBase ? TRINKET_PRIO.indexOf(curBase) : TRINKET_PRIO.length;
    for (i = 0; i < TRINKET_PRIO.length; i++) {
      for (var j = 0; j < inv.length; j++) {
        if (baseOf(inv[j]) === TRINKET_PRIO[i] && i < curRank) {
          return inv[j];
        }
      }
    }
    return null;
  }

  // src/brains/adventurer.ts
  function decide(args) {
    try {
      var snap = args.snapshot || {};
      var mem = args.memory && typeof args.memory === "object" ? args.memory : {};
      var cmds = {};
      var eq = bestEquipDiff(snap);
      if (eq) {
        cmds.equip = eq;
      }
      if (snap.pending) {
        cmds.choose = pickPendingOption(snap);
      } else {
        var pick = pickFallbackAction(snap, mem);
        cmds.action = pick;
        var streak = typeof mem.guard_streak === "number" ? mem.guard_streak : 0;
        mem.guard_streak = pick === "guard" ? streak + 1 : 0;
      }
      return { commands: cmds, memory: mem };
    } catch (err) {
      return { commands: { action: "attack" }, memory: { guard_streak: 0 } };
    }
  }
  globalThis.decide = decide;
})();
