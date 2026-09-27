// GENERATED from src/brains/narrator.ts — 源码在 src/，请勿直接编辑本文件。
"use strict";
(() => {
  // src/brains/narrator.ts
  var NOTABLE = [
    "spawn",
    "kill",
    "levelup",
    "descend",
    "flee",
    "clear",
    "win",
    "event",
    "trap",
    "curse",
    "nothing"
  ];
  var MIN_GAP = 2;
  var MAX_CHARS = 20;
  var FAIL_LIMIT = 2;
  var MUTE_TICKS = 40;
  var EPITAPH_SYSTEM = "你是地牢里的最后一位史官。为一位死在深处的冒险者写一句不超过 18 个汉字的墓志铭，冷峻而有余味。只输出这一句，不要引号、不要解释。";
  var TEMPLATES = {
    spawn: "暗处有什么在动",
    kill: "又一只怪物倒下",
    levelup: "力量涌了上来",
    descend: "石阶通向更深处",
    flee: "你退回了入口",
    clear: "这一层安静下来了",
    win: "地牢的黑暗散去了",
    event: "前方的黑暗里有什么",
    trap: "疼痛来得毫无预兆",
    curse: "有什么东西缠上了你",
    nothing: "你翻找了一阵，只有碎石和蛛网"
  };
  var EPITAPH_FALLBACK = "他的故事，止步于火把熄灭的地方";
  var PROLOGUE_SYSTEM = "你是地牢探险游戏的开场旁白。根据冒险者的随机出身（骰子掷出的出身与赐福/厄运），用不超过 40 个汉字写一段第二人称的背景故事，要点到那个出身。只输出故事本身。";
  var PROLOGUE_FALLBACK = "你举着火把走进深渊——你的出身，就是你的第一件装备。";
  var NOTABLE_KINDS = [
    "spawn",
    "kill",
    "levelup",
    "descend",
    "flee",
    "clear",
    "event",
    "trap",
    "curse",
    "nothing",
    "quota"
  ];
  var EVENT_IDS = ["merchant", "altar", "chest", "fork", "adventurer", "gambler"];
  function clean(text, maxChars) {
    if (typeof text !== "string") {
      return "";
    }
    var t = text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
    t = t.replace(/^["'「『《]+/, "").replace(/["'」』》]+$/, "").trim();
    var cut = t.search(/[。！？!?]/);
    if (cut > 0) {
      t = t.slice(0, cut);
    }
    return t.slice(0, maxChars);
  }
  function llmText(snap, system, userPrompt, mem, fallback, maxChars) {
    var tick = snap.tick || 0;
    if (typeof mem.mute_until === "number" && tick < mem.mute_until) {
      return fallback;
    }
    try {
      var out = clean(
        host.llm("", [
          { role: "system", content: system },
          { role: "user", content: userPrompt }
        ]),
        maxChars
      );
      if (out) {
        mem.fail_streak = 0;
        return out;
      }
      host.log("[narrator] llm 返回空文本，改用模板兜底");
    } catch (err) {
      host.log("[narrator] llm 降级: " + err);
    }
    mem.fail_streak = (mem.fail_streak || 0) + 1;
    if (mem.fail_streak >= FAIL_LIMIT) {
      mem.fail_streak = 0;
      mem.mute_until = tick + MUTE_TICKS;
      host.log(
        "[narrator] 连续失败，暂停旁白请求 " + MUTE_TICKS + " 回合（模板继续兜底）"
      );
    }
    return fallback;
  }
  function scene(snap) {
    var hero = snap.hero;
    return "第" + snap.depth + "层，等级" + snap.level + "，体力 " + hero.hp + "/" + hero.hp_max + "，金币 " + snap.gold + "。";
  }
  function template(entry) {
    return TEMPLATES[entry.kind] || clean(entry.text, MAX_CHARS) || "……";
  }
  function narrate(snap, entry) {
    var bank = snap.flavor_bank || {};
    var lines = bank[entry.kind];
    if (lines && lines.length) {
      return { text: lines[0], pop: entry.kind };
    }
    return { text: template(entry) };
  }
  function findLoreTarget(snap, mem) {
    var lored = mem.lored || {};
    var have = snap.item_lore || {};
    var log = snap.log || [];
    for (var i = log.length - 1; i >= 0; i--) {
      var e = log[i];
      if (!e.ids || !e.ids.length) {
        continue;
      }
      for (var j = 0; j < e.ids.length; j++) {
        var b = e.ids[j];
        if (!have[b] && !lored[b]) {
          return { entry: e, base: b };
        }
      }
    }
    return null;
  }
  function loreAsk(snap, target) {
    var def = snap.catalog ? snap.catalog[target.base] : null;
    return {
      base: target.base,
      name: def ? def.name : target.base,
      desc: def ? def.desc || "" : "",
      scene: target.entry.text,
      where: scene(snap)
    };
  }
  function epitaphText(snap, entry, mem) {
    var ask = "事实：" + entry.text + "\n场景：" + scene(snap) + "击倒守主 " + (snap.boss_kills || 0) + " 次。";
    return llmText(snap, EPITAPH_SYSTEM, ask, mem, EPITAPH_FALLBACK, 30);
  }
  function decide(args) {
    var snap = args.snapshot || {};
    var mem = args.memory && typeof args.memory === "object" ? args.memory : {};
    var commands = {};
    try {
      if (snap.prologue_boon && !snap.prologue_text) {
        var boon = snap.prologue_boon;
        mem.prologue_done = true;
        var ptext = mem.prologue_text;
        if (!ptext) {
          ptext = llmText(
            snap,
            PROLOGUE_SYSTEM,
            "出身：" + boon.label + "\n场景：" + scene(snap),
            mem,
            PROLOGUE_FALLBACK,
            60
          );
          mem.prologue_text = ptext;
        }
        return {
          commands: {
            prologue: { text: ptext }
          },
          memory: mem
        };
      }
      var log = snap.log || [];
      var last = typeof mem.narrated_tick === "number" ? mem.narrated_tick : -999;
      var muted = typeof mem.mute_until === "number" && snap.tick < mem.mute_until;
      if (mem.prologue_done && !muted) {
        var bank = snap.flavor_bank || {};
        var missing = [];
        for (var bi = 0; bi < NOTABLE_KINDS.length; bi++) {
          var kind = NOTABLE_KINDS[bi];
          if ((bank[kind] || []).length === 0) missing.push(kind);
        }
        var target = findLoreTarget(snap, mem);
        var evpool = snap.event_variants || {};
        var evNeed = [];
        var evAsked = mem.ev_asked || {};
        for (var vi = 0; vi < EVENT_IDS.length; vi++) {
          var eid = EVENT_IDS[vi];
          if (!(evpool[eid] || []).length && !evAsked[eid]) evNeed.push(eid);
        }
        if (mem.bank_pending) {
          try {
            var res = host.svc("pm", "/bankgen/result", {});
            if (res && res.ready) {
              mem.bank_pending = false;
              if (res.error) {
                host.log("[narrator] 后台文案生成失败: " + res.error);
              }
              if (res.bank && Object.keys(res.bank).length) {
                commands.bank = res.bank;
                mem.narrated_tick = snap.tick;
              }
              if (res.events && Object.keys(res.events).length) {
                commands.event_variants = res.events;
                mem.narrated_tick = snap.tick;
              }
              if (res.lore && res.lore.base && res.lore.text) {
                var lored = mem.lored || {};
                lored[res.lore.base] = true;
                mem.lored = lored;
                commands.lore = {
                  base: res.lore.base,
                  text: String(res.lore.text)
                };
                mem.narrated_tick = snap.tick;
              }
              for (var vj = 0; vj < evNeed.length; vj++) {
                evAsked[evNeed[vj]] = true;
              }
              mem.ev_asked = evAsked;
            }
          } catch (e3) {
            host.log("[narrator] 后台文案通道异常: " + e3);
            mem.mute_until = (snap.tick || 0) + MUTE_TICKS;
          }
        } else if (missing.length || target || evNeed.length) {
          try {
            host.svc("pm", "/bankgen", {
              kinds: missing,
              lore: target ? loreAsk(snap, target) : null,
              events: evNeed,
              scene: scene(snap)
            });
            mem.bank_pending = true;
            mem.narrated_tick = snap.tick;
          } catch (e4) {
            host.log("[narrator] 后台文案投递异常: " + e4);
            mem.mute_until = (snap.tick || 0) + MUTE_TICKS;
          }
        }
      }
      for (var i = log.length - 1; i >= 0; i--) {
        if (log[i].kind === "death") {
          if (!mem.epitaph_done) {
            mem.epitaph_done = true;
            commands.epitaph = { text: epitaphText(snap, log[i], mem) };
          }
          return { commands, memory: mem };
        }
      }
      var entry = null;
      for (var i2 = log.length - 1; i2 >= 0; i2--) {
        var e2 = log[i2];
        if (e2.flavor) {
          continue;
        }
        if (NOTABLE.indexOf(e2.kind) < 0) {
          continue;
        }
        if (e2.tick - last < MIN_GAP && !((snap.flavor_bank || {})[e2.kind] || []).length) {
          continue;
        }
        entry = e2;
        break;
      }
      if (entry) {
        var said = narrate(snap, entry);
        commands.narrate = {
          tick: entry.tick,
          kind: entry.kind,
          text: said.text,
          pop: said.pop
        };
        mem.narrated_tick = entry.tick;
      }
    } catch (err) {
      try {
        host.log("[narrator] 异常降级: " + err);
      } catch (e22) {
      }
    }
    return { commands, memory: mem };
  }
  globalThis.decide = decide;
})();
