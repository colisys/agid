// GENERATED from src/brains/sage.ts — 源码在 src/，请勿直接编辑本文件。
"use strict";
(() => {
  // src/brain_common.ts
  var RISKY_OPTS = ["tunnel", "loot", "bet10", "bet30"];
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

  // src/brains/sage.ts
  var FAIL_LIMIT = 1;
  var MUTE_TICKS = 60;
  var LOW_CONF = 0.4;
  var TACTIC_ROUTES = {
    aggressive: "尽快击杀敌人：连续攻击",
    careful: "先稳住：格挡回血，等血线安全再攻",
    item_heavy: "优先用消耗品（炸弹等）速战速决"
  };
  function markFail(mem, snap) {
    mem.fail_streak = (mem.fail_streak || 0) + 1;
    if (mem.fail_streak >= FAIL_LIMIT) {
      mem.fail_streak = 0;
      mem.mute_until = (snap.tick || 0) + MUTE_TICKS;
      try {
        host.log(
          "[sage] intent 失败，暂停请求 " + MUTE_TICKS + " 回合（回退启发式）"
        );
      } catch (e2) {
      }
    }
  }
  function muted(mem, snap) {
    return typeof mem.mute_until === "number" && (snap.tick || 0) < mem.mute_until;
  }
  function tacticKey(snap) {
    var f = snap.foe;
    return f ? f.name + "@" + f.hp_max : "";
  }
  function askPending(snap, mem) {
    var p = snap.pending;
    var routes = { default: "超时默认选项" };
    p.options.forEach(function(o) {
      routes[o.id] = o.label + "：" + o.desc + (typeof o.cost === "number" ? "（花费 " + o.cost + " 金）" : "");
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
        title: p.title
      }),
      context: {
        hero: snap.hero,
        foe: snap.foe,
        equip: snap.equip,
        statuses: snap.statuses,
        pending: p
      },
      routes
    });
    var route = picked && typeof picked.route === "string" ? picked.route : "default";
    var conf = picked && typeof picked.confidence === "number" ? picked.confidence : 0;
    var known = false;
    p.options.forEach(function(o) {
      if (o.id === route) {
        known = true;
      }
    });
    if (route === "default" || !known) {
      route = p.default;
    }
    if (hpRatio(snap) < 0.35 && RISKY_OPTS.indexOf(route) >= 0) {
      route = p.default;
    }
    if (conf < LOW_CONF) {
      route = p.default;
    }
    mem.last_pending = p.deadline_tick;
    mem.last_conf = conf;
    return { commands: { choose: route }, memory: mem };
  }
  function askTactic(snap, mem) {
    mem.tactic_key = tacticKey(snap);
    var hint = "";
    try {
      var h = host.svc("solver", "/hint", {
        hp: snap.hero.hp,
        hp_max: snap.hero.hp_max,
        depth: snap.depth,
        foe: snap.foe ? snap.foe.name : "",
        foe_intent: snap.foe && snap.foe.intent ? snap.foe.intent : ""
      });
      if (h && typeof h.hint === "string") {
        hint = h.hint;
      }
    } catch (e) {
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
        solver_hint: hint
      }),
      context: {
        hero: snap.hero,
        foe: snap.foe,
        equip: snap.equip,
        statuses: snap.statuses
      },
      routes: TACTIC_ROUTES
    });
    var route = picked && typeof picked.route === "string" ? picked.route : "";
    var conf = picked && typeof picked.confidence === "number" ? picked.confidence : 0;
    if (!(route in TACTIC_ROUTES) || conf < LOW_CONF) {
      route = mem.last_tactic || "careful";
    }
    mem.last_tactic = route;
    mem.last_conf = conf;
    var cmds = {};
    if (route === "careful") {
      cmds.action = "guard";
    } else if (route === "item_heavy") {
      cmds.action = has(snap.actions || [], "use:bomb") ? "use:bomb" : "attack";
    } else {
      cmds.action = "attack";
    }
    return { commands: cmds, memory: mem };
  }
  function decide(args) {
    var snap = args.snapshot || {};
    var mem = args.memory && typeof args.memory === "object" ? args.memory : {};
    var cmds = {};
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
        if (snap.foe && (snap.foe.elite || snap.foe.boss) && mem.tactic_key !== tacticKey(snap)) {
          var t = askTactic(snap, mem);
          t.commands = Object.assign({}, cmds, t.commands);
          return t;
        }
      }
    } catch (err) {
      try {
        host.log("[sage] intent 失败: " + err);
      } catch (e2) {
      }
      markFail(mem, snap);
    }
    if (snap.pending) {
      cmds.choose = pickPendingOption(snap);
    } else if (snap.foe && (snap.foe.elite || snap.foe.boss) && mem.tactic_key === tacticKey(snap)) {
      if (hpRatio(snap) < 0.35 && has(snap.actions || [], "potion")) {
        cmds.action = "potion";
      } else if (hpRatio(snap) < 0.2 && has(snap.actions || [], "flee")) {
        cmds.action = "flee";
      } else {
        cmds.action = snap.hero && snap.hero.stance || "attack";
      }
    } else {
      var pick = pickFallbackAction(snap, mem);
      cmds.action = pick;
      var streak = typeof mem.guard_streak === "number" ? mem.guard_streak : 0;
      mem.guard_streak = pick === "guard" ? streak + 1 : 0;
    }
    return { commands: cmds, memory: mem };
  }
  globalThis.decide = decide;
})();
