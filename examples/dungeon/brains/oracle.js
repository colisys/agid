// GENERATED from src/brains/oracle.ts — 源码在 src/，请勿直接编辑本文件。
"use strict";
(() => {
  // src/brain_common.ts
  var RISKY_OPTS = ["tunnel", "loot", "bet10", "bet30"];
  function hpRatio(snap) {
    var h = snap.hero;
    return h && h.hp_max ? h.hp / h.hp_max : 1;
  }

  // src/brains/oracle.ts
  var FAIL_LIMIT = 1;
  var MUTE_TICKS = 60;
  var LOW_CONF = 0.4;
  var TACTIC_LABEL = {
    aggressive: "趁它没站稳，连续猛攻",
    careful: "先举盾稳住，等血线安全再攻",
    item_heavy: "别耗了，用炸弹速战速决"
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
        host.log("[oracle] intent 失败，暂停低语 " + MUTE_TICKS + " 回合");
      } catch (e2) {
      }
    }
  }
  function ask(goal, userInput, context, routes) {
    var picked = host.intent({
      goal,
      user_input: JSON.stringify(userInput),
      context,
      routes
    });
    var route = picked && typeof picked.route === "string" ? picked.route : "";
    var conf = picked && typeof picked.confidence === "number" ? picked.confidence : 0;
    if (!(route in routes) || conf < LOW_CONF) {
      return null;
    }
    return route;
  }
  function decide(args) {
    var snap = args.snapshot || {};
    var mem = args.memory && typeof args.memory === "object" ? args.memory : {};
    var commands = {};
    try {
      if (snap.hero && snap.hero.hp > 0 && !muted(mem, snap)) {
        var sig = situation(snap);
        if (sig && sig !== mem.sig) {
          var text = advise(snap, sig, mem);
          if (text) {
            commands.whisper = { sig, text };
          }
          mem.sig = sig;
        } else if (!sig) {
          mem.sig = "";
        }
      } else {
        mem.sig = "";
      }
    } catch (err) {
      try {
        host.log("[oracle] 异常降级: " + err);
        markFail(mem, snap);
      } catch (e2) {
      }
    }
    return { commands, memory: mem };
  }
  function situation(snap) {
    if (snap.pending) {
      return "pending:" + snap.pending.event_id + ":" + snap.pending.deadline_tick;
    }
    if (snap.foe && (snap.foe.elite || snap.foe.boss)) {
      return "tactic:" + snap.foe.name + "@" + snap.foe.hp_max;
    }
    if (snap.foe && hpRatio(snap) < 0.35) {
      return "lowhp:" + snap.depth + ":" + snap.foe.name;
    }
    return "";
  }
  function advise(snap, sig, mem) {
    if (sig.indexOf("pending:") === 0) {
      return advisePending(snap);
    }
    if (sig.indexOf("tactic:") === 0) {
      return adviseTactic(snap, mem);
    }
    return adviseLowHp(snap, mem);
  }
  function advisePending(snap) {
    var p = snap.pending;
    var risky = p.options.filter(function(o) {
      return RISKY_OPTS.indexOf(o.id) >= 0;
    });
    if (hpRatio(snap) < 0.35 && risky.length) {
      return "血不多了，「" + risky[0].label + "」这种先别碰。";
    }
    var free = p.options.filter(function(o) {
      return typeof o.cost !== "number";
    });
    if (free.length) {
      return "稳一点的话，「" + free[0].label + "」不吃亏。";
    }
    return "想清楚再选——超时会自动按默认的来。";
  }
  function adviseTactic(snap, mem) {
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
    var route = ask(
      "冒险者撞上了强敌。你是观战的军师——从三种战法里挑一个最稳的。",
      {
        hp: snap.hero.hp,
        hp_max: snap.hero.hp_max,
        atk: snap.hero.atk,
        foe: snap.foe,
        gold: snap.gold,
        solver_hint: hint
      },
      {
        hero: snap.hero,
        foe: snap.foe,
        equip: snap.equip,
        statuses: snap.statuses
      },
      TACTIC_LABEL
    );
    if (!route) {
      return "";
    }
    mem.last_tactic = route;
    return (snap.foe ? snap.foe.name : "这东西") + "不好惹——" + TACTIC_LABEL[route] + "。";
  }
  function adviseLowHp(snap, _mem) {
    var hasPotion = (snap.actions || []).indexOf("use:potion") >= 0;
    return hasPotion ? "血见底了——喝药，或者退回上一层。" : "血见底了——别恋战，先撤。";
  }
  globalThis.decide = decide;
})();
