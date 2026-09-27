// GENERATED from src/rules.ts — 源码在 src/，请勿直接编辑本文件。
"use strict";
(() => {
  // src/rules.ts
  var TUNING = {
    tick_ms: 2e3,
    boss_every: 5,
    // 每 5 层一个守主（第 5/10/15…层），属性随深度增强
    hero_hp: 30,
    hero_atk: 6,
    guard_reduce: 2,
    // divisor applied to incoming damage before armor
    guard_regen: 3,
    // （已弃用，v5.6 格挡改概率反击）保留键位防旧存档/旧 tuning 报错
    guard_counter_pct: 40,
    // 格挡触发反击的概率%
    potion_boss_mult: 1.5,
    // 守主战药效倍率
    potion_elite_mult: 1.2,
    // 精英战药效倍率
    ambush_pct: 30,
    // 探索搅醒敌人时，敌人抢先出手的机会%（其余情况你抢到先机）
    potion_heal: 16,
    potion_start: 2,
    flee_pct: 45,
    flee_regen: 3,
    flee_gold_loss: 8,
    descend_regen: 5,
    xp_base: 10,
    xp_step: 8,
    level_hp: 6,
    level_heal: 12,
    level_atk: 2,
    monster: {
      hp: 10,
      atk: 3,
      xp: 6,
      gold: 4,
      d_hp: 6,
      d_atk: 1,
      d_xp: 3,
      d_gold: 3
    },
    monster_names: ["岩缝鼠", "腐骨兵", "毒雾蛛", "石壁蝠", "失落卫士", "幽影"],
    // 守主基线必须全面压制同期的精英怪，否则决战没有分量；每深一个
    // 里程碑（boss_every 层）整体再抬一档，深渊没有尽头。
    boss: { name: "地牢之主", hp: 150, atk: 16, xp: 100, gold: 400 },
    // v2
    log_cap: 60,
    inv_cap: 6,
    event_pct: 85,
    // chance per cleared layer (non-boss) to open a room
    event_deadline: 6,
    // ticks to decide before the default kicks in
    explores_max: 6,
    // 每层主动探索次数上限（防翻箱刷资源；探索是主循环，上限放宽）
    min_foes_cap: 3,
    // 每层最低击杀配额上限（1 + 每过 5 层 +1，封顶）
    gear_every: 3,
    // 装备主属性：每 3 层深度 +1（获取时定格，已装备的不涨）
    scroll_break_pct: 20,
    // 鉴定古卷失败率：被鉴定装备直接损坏
    unid_pct: 35,
    // 装备类掉落为「未鉴定」的概率
    dm_cooldown: 5,
    // 地牢之主两次得手之间至少隔几个 tick（规则侧冷却）
    dm_min_depth: 3,
    // 浅层不欺负新人：地牢之主从这个深度开始出手
    elite_pct_base: 0,
    // 精英概率 = base + per_depth * depth（base 0：第 1 层 4%，浅层别上精英）
    elite_pct_per_depth: 4,
    elite: { hp: 1.7, atk: 1.5, xp: 2, gold: 2.5 },
    intents: ["狂暴", "铁壁", "剧毒"],
    foe_status: { turns: 3, dmg: 2 },
    // weapon-inflicted burn/poison on foes
    hero_status_dmg: { poison: 2, burn: 2 },
    // fixed per-tick, no rng
    shield: { turns: 3, armor: 2 },
    might: { turns: 5, atk: 3 },
    pray_hp: 6,
    drop: {
      none: 30,
      potion: 25,
      gold_pack: 15,
      weapon: 10,
      armor: 8,
      trinket: 7,
      potion_big: 5
    },
    drop_none_lucky: 15,
    // charm replaces the `none` weight with this
    gold_pack: [8, 18],
    merchant_scale: [0.4, 0.4],
    // price = ceil(base * (0.4 + 0.4 * depth))
    bet_low: { cost: 10, reward: 25, win_pct: 55 },
    bet_high: { cost: 30, reward: 70, win_pct: 45 },
    items: [
      {
        id: "potion",
        name: "药水",
        kind: "consumable",
        price: 12,
        use: "heal",
        heal: 16,
        desc: "回复 16 点体力。"
      },
      {
        id: "potion_big",
        name: "大红药",
        kind: "consumable",
        price: 25,
        use: "heal",
        heal: 30,
        desc: "回复 30 点体力。"
      },
      {
        id: "bomb",
        name: "火油弹",
        kind: "consumable",
        price: 20,
        use: "bomb",
        desc: "对当前敌人造成 10+2×层数 伤害。"
      },
      {
        id: "scroll_shield",
        name: "圣光卷轴",
        kind: "consumable",
        price: 18,
        use: "shield",
        desc: "获得 3 回合圣盾（受伤 -2）。"
      },
      {
        id: "antidote",
        name: "解毒剂",
        kind: "consumable",
        price: 10,
        use: "antidote",
        desc: "解除中毒。"
      },
      {
        id: "elixir",
        name: "巨人秘药",
        kind: "consumable",
        price: 22,
        use: "might",
        desc: "5 回合内攻击 +3。"
      },
      {
        id: "rust_sword",
        name: "锈剑",
        kind: "weapon",
        slot: "weapon",
        price: 15,
        atk: 1,
        desc: "攻击 +1。"
      },
      {
        id: "iron_sword",
        name: "铁剑",
        kind: "weapon",
        slot: "weapon",
        price: 40,
        atk: 3,
        desc: "攻击 +3。"
      },
      {
        id: "flame_blade",
        name: "焰刃",
        kind: "weapon",
        slot: "weapon",
        price: 70,
        atk: 5,
        on_hit: { status: "burn", pct: 25 },
        desc: "攻击 +5，25% 点燃敌人。"
      },
      {
        id: "viper_dagger",
        name: "毒牙匕首",
        kind: "weapon",
        slot: "weapon",
        price: 55,
        atk: 2,
        on_hit: { status: "poison", pct: 30 },
        desc: "攻击 +2，30% 使敌人中毒。"
      },
      {
        id: "leather",
        name: "皮甲",
        kind: "armor",
        slot: "armor",
        price: 20,
        armor: 1,
        desc: "受伤 -1。"
      },
      {
        id: "chain",
        name: "锁子甲",
        kind: "armor",
        slot: "armor",
        price: 45,
        armor: 2,
        desc: "受伤 -2。"
      },
      {
        id: "plate",
        name: "板甲",
        kind: "armor",
        slot: "armor",
        price: 80,
        armor: 4,
        desc: "受伤 -4。"
      },
      {
        id: "lantern",
        name: "提灯",
        kind: "trinket",
        slot: "trinket",
        price: 30,
        event_pct: 15,
        desc: "事件与暗道判定更安全（+15%）。"
      },
      {
        id: "amulet",
        name: "生命护符",
        kind: "trinket",
        slot: "trinket",
        price: 35,
        hp_max: 8,
        desc: "装备时体力上限 +8。"
      },
      {
        id: "ring_regen",
        name: "回环戒",
        kind: "trinket",
        slot: "trinket",
        price: 50,
        regen: 2,
        desc: "每回合回复 2 点体力。"
      },
      {
        id: "charm",
        name: "幸运符",
        kind: "trinket",
        slot: "trinket",
        price: 40,
        lucky: true,
        desc: "掉落更慷慨。"
      },
      {
        id: "scroll_identify",
        name: "鉴定古卷",
        kind: "consumable",
        price: 26,
        use: "identify",
        desc: "火漆封缄的残卷，展开的刹那，蒙尘装备的铭文将自行显形。羊皮古旧，两成机率失灵并蚀坏一件——鉴定有险，落笔无悔。"
      },
      {
        id: "pack_expander",
        name: "扩容袋",
        kind: "consumable",
        price: 30,
        use: "bag",
        desc: "失传匠人的折迭革囊。撑开暗袋，这一趟探险背包多容 2 种物件；归窟之后针脚自散，一切如初。"
      },
      {
        id: "cursed_ring",
        name: "血诅戒",
        kind: "cursed",
        slot: "trinket",
        price: 0,
        atk: 4,
        drain: 1,
        desc: "攻击 +4，但每回合流失 1 点体力（祭坛可移除）。"
      },
      {
        id: "lead_boots",
        name: "铅靴",
        kind: "cursed",
        slot: "armor",
        price: 0,
        armor: 2,
        flee_pct: -20,
        desc: "受伤 -2，但逃跑概率 -20%。"
      }
    ]
  };
  var LOG_CAP = TUNING.log_cap;
  function baseOf(entry) {
    var i = entry.indexOf("@");
    return i < 0 ? entry : entry.slice(0, i);
  }
  function gearDepth(entry) {
    var i = entry.indexOf("@");
    return i < 0 ? 1 : parseInt(entry.slice(i + 1), 10) || 1;
  }
  function stampDepth(id, depth) {
    return id + "@" + depth;
  }
  function gearAtk(entry) {
    var def = CATALOG[baseOf(entry)];
    return def && def.atk ? def.atk + Math.floor((gearDepth(entry) - 1) / TUNING.gear_every) : 0;
  }
  function gearArmor(entry) {
    var def = CATALOG[baseOf(entry)];
    return def && def.armor ? def.armor + Math.floor((gearDepth(entry) - 1) / TUNING.gear_every) : 0;
  }
  function gearHpMax(entry) {
    var def = CATALOG[baseOf(entry)];
    return def && def.hp_max ? def.hp_max + Math.floor((gearDepth(entry) - 1) / TUNING.gear_every) : 0;
  }
  function isUnid(s, entry) {
    return !!s.unidentified && s.unidentified.indexOf(baseOf(entry)) >= 0;
  }
  function markIdentified(s, base) {
    if (!s.unidentified) s.unidentified = [];
    if (!s.identified) s.identified = [];
    var ui = s.unidentified.indexOf(base);
    if (ui >= 0) s.unidentified.splice(ui, 1);
    if (s.identified.indexOf(base) < 0) s.identified.push(base);
  }
  var ACTIONS = ["attack", "guard", "potion", "flee", "descend", "explore"];
  var ACT_LABEL = {
    attack: "攻击",
    guard: "格挡",
    potion: "喝药",
    flee: "逃跑",
    descend: "下潜",
    explore: "探索"
  };
  var EVENTS = ["merchant", "altar", "chest", "fork", "adventurer", "gambler"];
  var EVENT_IDS = EVENTS;
  var ORIGIN_DICE = [
    {
      face: 1,
      kind: "hp",
      label: "将门之后",
      desc: "体魄强健（体力上限 +5）",
      weight: 1
    },
    {
      face: 2,
      kind: "atk",
      label: "猎户之子",
      desc: "锋芒初露（攻击 +2）",
      weight: 1
    },
    {
      face: 3,
      kind: "gold",
      label: "商贾遗孤",
      desc: "行囊鼓胀（金币 +60）",
      weight: 1
    },
    {
      face: 4,
      kind: "item",
      label: "拾荒的命",
      desc: "命运赠礼（一件开局装备）",
      weight: 1
    },
    {
      face: 5,
      kind: "wound",
      label: "老兵旧伤",
      desc: "旧伤未愈（体力上限 -3）",
      weight: 1
    },
    {
      face: 6,
      kind: "poor",
      label: "囊中羞涩",
      desc: "出门少带一瓶药水（药水 -1）",
      weight: 1
    },
    { face: 7, kind: "none", label: "平凡出身", desc: "无事发生", weight: 2 },
    { face: 8, kind: "none", label: "平凡出身", desc: "无事发生", weight: 1 }
  ];
  var CATALOG = {};
  TUNING.items.forEach(function(it) {
    CATALOG[it.id] = it;
  });
  function nextRand(s) {
    s.rng = s.rng + 1831565813 >>> 0;
    var t = s.rng;
    t = Math.imul(t ^ t >>> 15, t | 1) >>> 0;
    t = (t ^ t + Math.imul(t ^ t >>> 7, t | 61)) >>> 0;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }
  function rint(s, lo, hi) {
    return lo + Math.floor(nextRand(s) * (hi - lo + 1));
  }
  function pct(s, p) {
    return nextRand(s) * 100 < p;
  }
  function weightedPick(s, table) {
    var total = 0, k = "";
    for (k in table) {
      total += table[k];
    }
    var r = nextRand(s) * total;
    for (k in table) {
      r -= table[k];
      if (r < 0) {
        return k;
      }
    }
    return k;
  }
  function addLog(s, kind, text, out) {
    var e = { tick: s.tick, kind, text };
    s.log.push(e);
    if (s.log.length > LOG_CAP) {
      s.log = s.log.slice(s.log.length - LOG_CAP);
    }
    if (out) {
      out.push(e);
    }
    return e;
  }
  function minFoes(depth) {
    if (depth % TUNING.boss_every === 0) {
      return 0;
    }
    return Math.min(
      1 + Math.floor((depth - 1) / TUNING.boss_every),
      TUNING.min_foes_cap
    );
  }
  function owned(s, id) {
    var b = baseOf(id);
    return s.inventory.some(function(e) {
      return baseOf(e) === b;
    }) || baseOf(s.equip.weapon || "") === b || baseOf(s.equip.armor || "") === b || baseOf(s.equip.trinket || "") === b;
  }
  function armorSum(s) {
    var n = 0;
    if (s.equip.armor) {
      n += gearArmor(s.equip.armor);
    }
    if (s.statuses.shield) {
      n += s.statuses.shield.armor || 0;
    }
    return n;
  }
  function effAtk(s) {
    var n = s.hero.atk;
    if (s.equip.weapon) {
      n += gearAtk(s.equip.weapon);
    }
    if (baseOf(s.equip.trinket || "") === "cursed_ring") {
      n += CATALOG.cursed_ring.atk || 0;
    }
    if (s.statuses.might) {
      n += s.statuses.might.atk || 0;
    }
    return n;
  }
  function fleeChance(s) {
    var p = TUNING.flee_pct;
    if (baseOf(s.equip.armor || "") === "lead_boots") {
      p += CATALOG.lead_boots.flee_pct || 0;
    }
    return p;
  }
  function lampBonus(s) {
    return baseOf(s.equip.trinket || "") === "lantern" ? CATALOG.lantern.event_pct || 0 : 0;
  }
  function migrate(s) {
    if (!Array.isArray(s.inventory)) {
      s.inventory = [];
    }
    if (!s.equip) {
      s.equip = { weapon: null, armor: null, trinket: null };
    }
    var d = s.depth || 1;
    var stamp = function(e) {
      return typeof e === "string" && CATALOG[baseOf(e)] && CATALOG[baseOf(e)].slot && e.indexOf("@") < 0 ? stampDepth(e, d) : e;
    };
    s.inventory = s.inventory.map(stamp);
    if (s.equip.weapon) s.equip.weapon = stamp(s.equip.weapon);
    if (s.equip.armor) s.equip.armor = stamp(s.equip.armor);
    if (s.equip.trinket) s.equip.trinket = stamp(s.equip.trinket);
    if (!s.statuses) {
      s.statuses = {};
    }
    if (typeof s.pending === "undefined") {
      s.pending = null;
    }
    if (typeof s.boss_kills === "undefined") {
      s.boss_kills = 0;
    }
    if (!s.flags) {
      s.flags = { events_this_layer: 0, elites_slain: 0, explores_this_layer: 0 };
    }
    if (!s.unidentified) s.unidentified = [];
    if (!s.identified) s.identified = [];
    if (typeof s.event_variants === "undefined") s.event_variants = {};
    if (typeof s.bag_cap !== "number") s.bag_cap = TUNING.inv_cap;
  }
  function pickCommand(commands, key) {
    for (var i = 0; i < 8; i++) {
      var c = commands["p" + i];
      if (c && typeof c[key] === "string") {
        return c[key];
      }
    }
    return null;
  }
  function pickNarrate(commands) {
    for (var i = 0; i < 8; i++) {
      var c = commands["p" + i];
      if (c && c.narrate && typeof c.narrate.tick === "number" && typeof c.narrate.kind === "string" && c.narrate.text) {
        return c.narrate;
      }
    }
    return null;
  }
  function pickBrain(commands, key) {
    var svc = commands["__svc__"];
    if (svc && svc[key]) {
      return svc[key];
    }
    for (var i = 0; i < 8; i++) {
      var c = commands["p" + i];
      if (c && c[key]) {
        return c[key];
      }
    }
    return null;
  }
  function collectGmOps(commands) {
    var gm = pickBrain(commands, "gm");
    if (!gm || !gm.ops || !gm.ops.length) return [];
    var out = [];
    var raw = gm.ops;
    for (var i = 0; i < raw.length && out.length < 8; i++) {
      if (raw[i] && typeof raw[i] === "object")
        out.push(raw[i]);
    }
    return out;
  }
  function applyGmOps(s, ops, events) {
    var applied = false;
    for (var i = 0; i < ops.length; i++) {
      var o = ops[i];
      var op = typeof o.op === "string" ? o.op : "";
      var hero = s.hero;
      if (op === "grant_gold") {
        var amt = Math.max(
          -500,
          Math.min(500, Math.floor(Number(o.amount) || 0))
        );
        if (!amt) continue;
        s.gold = Math.max(0, s.gold + amt);
        addLog(
          s,
          "gm",
          "[后台] 金币 " + (amt > 0 ? "+" : "") + amt + "（现 " + s.gold + "）。",
          events
        );
        applied = true;
      } else if (op === "set_hp") {
        var v = Math.floor(Number(o.value) || 0);
        v = Math.max(0, Math.min(hero.hp_max, v));
        hero.hp = v;
        addLog(
          s,
          "gm",
          "[后台] 体力被拨到 " + v + "/" + hero.hp_max + "。",
          events
        );
        applied = true;
      } else if (op === "heal_full") {
        hero.hp = hero.hp_max;
        addLog(s, "gm", "[后台] 一道暖流涌过——体力回满了。", events);
        applied = true;
      } else if (op === "set_atk") {
        var a = Math.max(1, Math.min(99, Math.floor(Number(o.value) || 0)));
        hero.atk = a;
        addLog(s, "gm", "[后台] 攻击力被拨到 " + a + "。", events);
        applied = true;
      } else if (op === "add_item") {
        var id = typeof o.id === "string" ? o.id : "";
        var def = id ? CATALOG[id] : null;
        if (!def || invKinds(s) >= (s.bag_cap || TUNING.inv_cap)) continue;
        var entry = def.slot ? stampDepth(id, s.depth) : id;
        s.inventory.push(entry);
        markIdentified(s, id);
        addLog(
          s,
          "gm",
          "[后台] 一件「" + def.name + "」凭空出现在你的背包里。",
          events
        );
        applied = true;
      } else if (op === "del_item") {
        var want = typeof o.entry === "string" ? o.entry : "";
        var hit = resolveEntry(s, want);
        if (hit && s.inventory.indexOf(hit) >= 0) {
          takeOff(s, hit);
          s.inventory.splice(s.inventory.indexOf(hit), 1);
          addLog(
            s,
            "gm",
            "[后台] 「" + (CATALOG[baseOf(hit)] ? CATALOG[baseOf(hit)].name : hit) + "」被后台收走了。",
            events
          );
          applied = true;
        } else {
          var eqAll = s.equip;
          var eqSlots = [
            "weapon",
            "armor",
            "trinket"
          ];
          for (var di = 0; di < eqSlots.length; di++) {
            var worn = eqAll[eqSlots[di]] || "";
            if (worn && baseOf(worn) === baseOf(want) && CATALOG[baseOf(want)]) {
              takeOff(s, worn);
              addLog(
                s,
                "gm",
                "[后台] 「" + CATALOG[baseOf(want)].name + "」从你身上被收走了。",
                events
              );
              applied = true;
              break;
            }
          }
        }
      }
    }
    if (applied) s.gm_used = (s.gm_used || 0) + 1;
    return applied;
  }
  function applyAmbush(s, f) {
    if (!f.boss && s.flags && s.flags.dm_ambush) {
      s.flags.dm_ambush = false;
      f.hp = Math.floor(f.hp * 1.3);
      f.hp_max = f.hp;
      f.atk += 1;
      f.name = "伏击·" + f.name;
    }
  }
  function spawn(s) {
    var M = TUNING.monster;
    var d = s.depth;
    if (d % TUNING.boss_every === 0) {
      var m = d / TUNING.boss_every;
      var b = TUNING.boss;
      var bhp = b.hp + (m - 1) * 90;
      return {
        name: "第" + d + "层·" + b.name,
        hp: bhp,
        hp_max: bhp,
        atk: b.atk + (m - 1) * 4,
        xp: b.xp * m,
        gold: b.gold * m,
        boss: true
      };
    }
    var name = TUNING.monster_names[rint(s, 0, TUNING.monster_names.length - 1)];
    var hp = M.hp + M.d_hp * (d - 1) + rint(s, 0, 3);
    var f = {
      name,
      hp,
      hp_max: hp,
      atk: M.atk + M.d_atk * (d - 1),
      xp: M.xp + M.d_xp * (d - 1),
      gold: M.gold + M.d_gold * (d - 1)
    };
    if (pct(s, TUNING.elite_pct_base + TUNING.elite_pct_per_depth * d)) {
      f.name = "精英·" + name;
      f.hp = Math.ceil(f.hp * TUNING.elite.hp);
      f.hp_max = f.hp;
      f.atk = Math.ceil(f.atk * TUNING.elite.atk);
      f.xp = f.xp * TUNING.elite.xp;
      f.gold = Math.ceil(f.gold * TUNING.elite.gold);
      f.elite = true;
      f.intent = TUNING.intents[rint(s, 0, TUNING.intents.length - 1)];
      if (f.intent === "铁壁") {
        f.armor = 2;
      }
    }
    applyAmbush(s, f);
    return f;
  }
  function invKinds(s) {
    var seen = {};
    var n = 0;
    s.inventory.forEach(function(e) {
      var b = baseOf(e);
      if (!seen[b]) {
        seen[b] = true;
        n += 1;
      }
    });
    return n;
  }
  function giveItem(s, id, out) {
    var def = CATALOG[id];
    if (!def) {
      return;
    }
    if (id === "potion") {
      s.potions += 1;
      addLog(s, "item", "你拾取了一瓶药水。", out);
      return;
    }
    var hasBase = s.inventory.some(function(e) {
      return baseOf(e) === id;
    });
    if (invKinds(s) >= (s.bag_cap || TUNING.inv_cap) && !hasBase) {
      var g = Math.max(5, Math.ceil(def.price / 2));
      s.gold += g;
      addLog(
        s,
        "item",
        "背包装不下了，「" + def.name + "」折成了 " + g + " 金。",
        out
      );
      return;
    }
    if (def.slot) {
      s.inventory.push(stampDepth(id, s.depth));
      var everKnown = !!s.identified && s.identified.indexOf(id) >= 0;
      if (!everKnown && pct(s, TUNING.unid_pct)) {
        if (!s.unidentified) s.unidentified = [];
        if (s.unidentified.indexOf(id) < 0) s.unidentified.push(id);
        var slotName = def.slot === "weapon" ? "武器" : def.slot === "armor" ? "护甲" : "饰品";
        addLog(
          s,
          "item",
          "你获得了一件" + slotName + "——铭文晦涩如谜，属性不明（???）。古卷可解其谜。",
          out
        );
      } else {
        markIdentified(s, id);
        addLog(s, "item", "你获得了「" + def.name + "」：" + def.desc, out);
      }
      return;
    }
    s.inventory.push(id);
    addLog(s, "item", "你获得了「" + def.name + "」：" + def.desc, out);
  }
  function sellablePool(s, kind) {
    return TUNING.items.filter(function(it) {
      return it.kind === kind && it.price > 0 && !owned(s, it.id);
    });
  }
  function randomGiveOfKind(s, kind, out) {
    var pool = sellablePool(s, kind);
    if (pool.length === 0) {
      var g = rint(s, TUNING.gold_pack[0], TUNING.gold_pack[1]);
      s.gold += g;
      addLog(s, "item", "你翻出 " + g + " 金。", out);
      return;
    }
    giveItem(s, pool[rint(s, 0, pool.length - 1)].id, out);
  }
  function cursedItem(s) {
    return ["cursed_ring", "lead_boots"][rint(s, 0, 1)];
  }
  function takeOff(s, entry) {
    var def = CATALOG[baseOf(entry)];
    if (!def || !def.slot) return;
    var eq = s.equip;
    if (baseOf(eq[def.slot] || "") !== baseOf(entry)) return;
    eq[def.slot] = null;
    var hp = gearHpMax(entry);
    if (hp) {
      s.hero.hp_max -= hp;
      s.hero.hp = Math.min(s.hero.hp, s.hero.hp_max);
    }
  }
  function resolveEntry(s, id) {
    if (id.indexOf("@") >= 0) {
      return id;
    }
    for (var i = 0; i < s.inventory.length; i++) {
      if (baseOf(s.inventory[i]) === id) {
        return s.inventory[i];
      }
    }
    return id;
  }
  function doEquip(s, entry, out) {
    entry = resolveEntry(s, entry);
    var base = baseOf(entry);
    var def = CATALOG[base];
    var ix = s.inventory.indexOf(entry);
    if (!def || !def.slot || ix < 0) {
      return false;
    }
    var slot = def.slot;
    var eq = s.equip;
    if (baseOf(eq[slot] || "") === base) {
      return true;
    }
    var cur = eq[slot];
    if (cur) {
      takeOff(s, cur);
      s.inventory.push(cur);
    }
    s.inventory.splice(ix, 1);
    eq[slot] = entry;
    var hp = gearHpMax(entry);
    if (hp) {
      s.hero.hp_max += hp;
    }
    s.hero.hp = Math.min(s.hero.hp, s.hero.hp_max);
    if (isUnid(s, entry)) {
      markIdentified(s, base);
      addLog(s, "equip", "你换上了" + def.name + "——上手一试，" + def.desc, out);
    } else {
      addLog(s, "equip", "你换上了" + def.name + "。", out);
    }
    return true;
  }
  function merchantPrice(s, def) {
    return Math.ceil(
      def.price * (TUNING.merchant_scale[0] + TUNING.merchant_scale[1] * s.depth)
    );
  }
  function sellPrice(s, def) {
    return Math.max(1, Math.floor(merchantPrice(s, def) / 2));
  }
  function buildEvent(s, id) {
    var dl = s.tick + TUNING.event_deadline;
    if (id === "merchant") {
      var p = {
        event_id: id,
        title: "一个裹着黑袍的流浪商人",
        options: [],
        deadline_tick: dl,
        left: TUNING.event_deadline,
        default: "leave",
        wares: []
      };
      var pool = TUNING.items.filter(function(it) {
        return it.price > 0 && it.id !== "potion" && !owned(s, it.id);
      });
      for (var i = 0; i < 2 && pool.length > 0; i++) {
        p.wares.push(pool.splice(rint(s, 0, pool.length - 1), 1)[0].id);
      }
      if (p.wares.length === 0) {
        return buildEvent(s, "chest");
      }
      p.wares.forEach(function(wid, ix) {
        var def = CATALOG[wid];
        p.options.unshift({
          id: "buy" + ix,
          label: "买·" + def.name,
          desc: def.desc,
          cost: merchantPrice(s, def)
        });
      });
      s.inventory.forEach(function(entry) {
        var base = baseOf(entry);
        var d = CATALOG[base];
        if (!d || d.price <= 0) return;
        var known = !isUnid(s, entry);
        var gain = sellPrice(s, d);
        p.options.push({
          id: "sell:" + entry,
          label: "卖·" + (known ? d.name : "???") + "（+" + gain + "金）",
          desc: known ? d.desc : "来历不明，商人倒是不挑。"
        });
      });
      p.options.push({ id: "leave", label: "离开", desc: "捂紧钱袋" });
      return p;
    }
    if (id === "altar") {
      var cursed = baseOf(s.equip.trinket || "") === "cursed_ring" || baseOf(s.equip.armor || "") === "lead_boots";
      var pray = cursed ? "移除身上的诅咒物品" : "献祭 " + TUNING.pray_hp + " 体力，获得 5 回合力量";
      return {
        event_id: id,
        title: "一座刻满纹路的古老祭坛",
        deadline_tick: dl,
        left: TUNING.event_deadline,
        default: "leave",
        options: [
          { id: "pray", label: "祈祷", desc: pray },
          { id: "smash", label: "砸坛", desc: "搜走香火钱（8~20 金）" },
          { id: "leave", label: "离开", desc: "敬而远之" }
        ]
      };
    }
    if (id === "chest") {
      return {
        event_id: id,
        title: "一只上锁的铁宝箱",
        deadline_tick: dl,
        left: TUNING.event_deadline,
        default: "leave",
        options: [
          { id: "open", label: "强开", desc: "70% 宝物 / 20% 陷阱 / 10% 诅咒" },
          { id: "leave", label: "离开", desc: "不值得冒险" }
        ]
      };
    }
    if (id === "fork") {
      return {
        event_id: id,
        title: "幽暗的三岔路口",
        deadline_tick: dl,
        left: TUNING.event_deadline,
        default: "stay",
        options: [
          { id: "path", label: "石阶小径", desc: "安稳：回复 4 点体力" },
          {
            id: "tunnel",
            label: "暗道",
            desc: "有灯 65% 宝物，否则可能遭遇埋伏"
          },
          { id: "stay", label: "原路", desc: "不作他想" }
        ]
      };
    }
    if (id === "adventurer") {
      return {
        event_id: id,
        title: "一个倒在血泊里的冒险者",
        deadline_tick: dl,
        left: TUNING.event_deadline,
        default: "leave",
        options: [
          { id: "give", label: "给药水", desc: "用一瓶药水换他背后的饰品" },
          { id: "loot", label: "搜刮", desc: "50% 搜出 15~30 金，50% 摸到诅咒" },
          { id: "leave", label: "离开", desc: "各自安好" }
        ]
      };
    }
    return {
      event_id: "gambler",
      title: "一个眼神发亮的骰子赌徒",
      deadline_tick: dl,
      left: TUNING.event_deadline,
      default: "leave",
      options: [
        {
          id: "bet10",
          label: "押 10 金",
          desc: "55% 拿回 25 金",
          cost: TUNING.bet_low.cost
        },
        {
          id: "bet30",
          label: "押 30 金",
          desc: "45% 拿回 70 金",
          cost: TUNING.bet_high.cost
        },
        { id: "leave", label: "走开", desc: "十赌九输" }
      ]
    };
  }
  function openEvent(s, out) {
    var id = EVENTS[rint(s, 0, EVENTS.length - 1)];
    var p = buildEvent(s, id);
    var pool = s.event_variants && s.event_variants[id];
    if (pool && pool.length) {
      var v = pool.shift();
      p.title = v.title;
      p.desc = v.desc;
    }
    s.pending = p;
    s.flags.events_this_layer = 1;
    addLog(s, "event", "你发现了" + p.title + "。", out);
  }
  function encounterSpawn(s) {
    var M = TUNING.monster;
    var d = s.depth;
    var name = TUNING.monster_names[rint(s, 0, TUNING.monster_names.length - 1)];
    var hp = M.hp + M.d_hp * (d - 1) + rint(s, 0, 3);
    var f = {
      name,
      hp,
      hp_max: hp,
      atk: M.atk + M.d_atk * (d - 1),
      xp: M.xp + M.d_xp * (d - 1),
      gold: M.gold + M.d_gold * (d - 1)
    };
    if (pct(s, TUNING.elite_pct_base + TUNING.elite_pct_per_depth * d)) {
      f.name = "精英·" + name;
      f.hp = Math.ceil(f.hp * TUNING.elite.hp);
      f.hp_max = f.hp;
      f.atk = Math.ceil(f.atk * TUNING.elite.atk);
      f.xp = f.xp * TUNING.elite.xp;
      f.gold = Math.ceil(f.gold * TUNING.elite.gold);
      f.elite = true;
      f.intent = TUNING.intents[rint(s, 0, TUNING.intents.length - 1)];
      if (f.intent === "铁壁") {
        f.armor = 2;
      }
    }
    applyAmbush(s, f);
    return f;
  }
  function exploreRoll(s, out) {
    var r = rint(s, 0, 99);
    var quotaUnmet = (s.foes_left || 0) > 0;
    var lastExplore = (s.flags.explores_this_layer || 0) >= TUNING.explores_max;
    if (quotaUnmet && lastExplore) {
      r = 30;
    }
    if (r < 24) {
      if (pct(s, 15)) {
        var trap = 4 + s.depth + rint(s, 0, 3);
        s.hero.hp = Math.max(0, s.hero.hp - trap);
        addLog(
          s,
          "explore",
          "箱子咬人！机关毒针扎掉你 " + trap + " 点体力。",
          out
        );
        return;
      }
      var gold = 12 + 3 * s.depth + rint(s, 0, 8);
      if (baseOf(s.equip.trinket || "") === "charm") {
        gold = Math.ceil(gold * 1.5);
      }
      s.gold += gold;
      addLog(s, "explore", "一只积灰的木箱——你摸出 " + gold + " 金。", out);
      if (pct(s, 25)) {
        var kinds = ["weapon", "armor", "trinket", "consumable"];
        randomGiveOfKind(s, kinds[rint(s, 0, kinds.length - 1)], out);
      }
    } else if (r < 64) {
      s.foe = encounterSpawn(s);
      addLog(
        s,
        "spawn",
        "你搅醒了" + s.foe.name + "（体力 " + s.foe.hp + "，攻击 " + s.foe.atk + "）" + (s.foe.intent ? "，意图：" + s.foe.intent + "。" : "。"),
        out
      );
    } else if (r < 78) {
      var pitDmg = 6 + 2 * s.depth;
      s.pending = {
        event_id: "pit",
        title: "深不见底的黑洞",
        options: [
          {
            id: "jump",
            label: "跳下去",
            desc: "直达下方 1~2 层，摔伤（体力 -" + pitDmg + " 左右）"
          },
          { id: "skip", label: "绕开", desc: "继续驻留本层" }
        ],
        default: "skip",
        deadline_tick: s.tick + TUNING.event_deadline,
        left: TUNING.event_deadline
      };
      addLog(s, "event", "地面塌陷出一个深不见底的黑洞，风声呜咽。", out);
    } else if (r < 88) {
      openEvent(s, out);
    } else {
      addLog(s, "nothing", "你翻找了一阵，只有碎石和蛛网。", out);
    }
  }
  function applyChoice(s, optId, out) {
    var p = s.pending;
    var t = s.tick;
    switch (p.event_id) {
      case "merchant": {
        if (optId.indexOf("sell:") === 0) {
          var sentry = optId.slice(5);
          var sbase = baseOf(sentry);
          var sdef = CATALOG[sbase];
          var six = s.inventory.indexOf(sentry);
          if (sdef && six >= 0) {
            var gain = sellPrice(s, sdef);
            s.inventory.splice(six, 1);
            s.gold += gain;
            addLog(
              s,
              "sell",
              "你把" + (isUnid(s, sentry) ? "???（" + sdef.name + "）" : sdef.name) + "卖给了商人，进账 " + gain + " 金。",
              out
            );
          } else {
            addLog(s, "sell", "那件东西已经不在背包里了。", out);
          }
          break;
        }
        if (optId.indexOf("buy") !== 0) {
          break;
        }
        var ix = parseInt(optId.slice(3), 10);
        var wid = p.wares[ix];
        var def = CATALOG[wid];
        var price = merchantPrice(s, def);
        var hasBase = s.inventory.some(function(e) {
          return baseOf(e) === wid;
        });
        if (invKinds(s) >= (s.bag_cap || TUNING.inv_cap) && !hasBase) {
          addLog(s, "buy", "背包已经塞满了，商人耸耸肩把货收了回去。", out);
          break;
        }
        s.gold -= price;
        if (def.slot) {
          s.inventory.push(stampDepth(wid, s.depth));
          markIdentified(s, wid);
        } else {
          s.inventory.push(wid);
        }
        addLog(s, "buy", "你花 " + price + " 金买下了" + def.name + "。", out);
        break;
      }
      case "altar": {
        if (optId === "pray") {
          var ringCursed = baseOf(s.equip.trinket || "") === "cursed_ring";
          var bootsCursed = baseOf(s.equip.armor || "") === "lead_boots";
          if (ringCursed || bootsCursed) {
            var slot = ringCursed ? "trinket" : "armor";
            var eq = s.equip;
            var cid = eq[slot];
            eq[slot] = null;
            s.inventory.push(cid);
            addLog(
              s,
              "curse",
              "祭坛的火光一闪，" + CATALOG[baseOf(cid)].name + "上的诅咒消散了。",
              out
            );
          } else {
            s.hero.hp = Math.max(1, s.hero.hp - TUNING.pray_hp);
            s.statuses.might = {
              turns: TUNING.might.turns,
              atk: TUNING.might.atk
            };
            addLog(
              s,
              "event",
              "你献上血，力量涌进四肢（攻击 +" + TUNING.might.atk + "，" + TUNING.might.turns + " 回合）。",
              out
            );
          }
        } else if (optId === "smash") {
          var g = rint(s, 8, 20);
          s.gold += g;
          addLog(s, "event", "你砸开祭坛，摸走 " + g + " 金香火钱。", out);
        }
        break;
      }
      case "chest": {
        var r = nextRand(s) * 100;
        if (r < 70) {
          var kinds = ["weapon", "armor", "trinket", "consumable"];
          randomGiveOfKind(s, kinds[rint(s, 0, kinds.length - 1)], out);
        } else if (r < 90) {
          var dmg = rint(s, 4, 8);
          s.hero.hp = Math.max(0, s.hero.hp - dmg);
          addLog(
            s,
            "trap",
            "箱盖弹出的毒针扎中你，损失 " + dmg + " 点体力。",
            out
          );
        } else {
          giveItem(s, cursedItem(s), out);
        }
        break;
      }
      case "fork": {
        if (optId === "path") {
          s.hero.hp = Math.min(s.hero.hp_max, s.hero.hp + 4);
          addLog(s, "event", "你沿石阶小径缓步而行，喘匀了气（+4 体力）。", out);
        } else if (optId === "tunnel") {
          if (pct(s, 50 + lampBonus(s))) {
            var kinds2 = ["weapon", "armor", "trinket", "consumable"];
            randomGiveOfKind(s, kinds2[rint(s, 0, kinds2.length - 1)], out);
          } else if (pct(s, 50)) {
            s.foe = spawn(s);
            addLog(
              s,
              "spawn",
              "暗道里窜出了" + s.foe.name + "（体力 " + s.foe.hp + "，攻击 " + s.foe.atk + "）！",
              out
            );
          } else {
            addLog(s, "event", "暗道里只有风声和碎石的回响。", out);
          }
        }
        break;
      }
      case "adventurer": {
        if (optId === "give") {
          if (s.potions > 0) {
            s.potions -= 1;
            randomGiveOfKind(s, "trinket", out);
          } else {
            addLog(s, "illegal", "你的药水架已经空了。", out);
          }
        } else if (optId === "loot") {
          if (pct(s, 50)) {
            var g2 = rint(s, 15, 30);
            s.gold += g2;
            addLog(s, "event", "你从他怀里搜出 " + g2 + " 金。", out);
          } else {
            giveItem(s, cursedItem(s), out);
          }
        }
        break;
      }
      case "gambler": {
        if (optId !== "bet10" && optId !== "bet30") {
          break;
        }
        var bet = optId === "bet10" ? TUNING.bet_low : TUNING.bet_high;
        if (pct(s, bet.win_pct)) {
          s.gold += bet.reward;
          addLog(s, "event", "骰子停下——你赢了 " + bet.reward + " 金！", out);
        } else {
          s.gold -= bet.cost;
          addLog(s, "event", "骰子停下——" + bet.cost + " 金进了他的口袋。", out);
        }
        break;
      }
      case "pit": {
        if (optId !== "jump") {
          addLog(s, "event", "你贴着洞沿绕了过去——有些深，还是别冒。", out);
          break;
        }
        var drop = 1 + rint(s, 0, 1);
        var pitHurt = 6 + 2 * (s.depth + drop) + rint(s, 0, 3);
        s.depth += drop;
        s.foes_left = minFoes(s.depth);
        s.flags.events_this_layer = 0;
        s.flags.explores_this_layer = 0;
        s.hero.hp = Math.max(0, s.hero.hp - pitHurt);
        addLog(
          s,
          "event",
          "你纵身跃入黑暗，跌落在第 " + s.depth + " 层——摔掉 " + pitHurt + " 点体力。",
          out
        );
        break;
      }
    }
    s.pending = null;
  }
  function legalActions(s) {
    var out = [];
    if (s.pending) {
    } else if (s.foe) {
      out.push("attack", "guard", "flee");
    } else {
      if ((s.foes_left || 0) <= 0) {
        out.push("descend");
      }
      if ((s.flags.explores_this_layer || 0) < TUNING.explores_max || (s.foes_left || 0) > 0) {
        out.push("explore");
      }
    }
    if (s.potions > 0) {
      out.push("potion");
    }
    s.inventory.forEach(function(id) {
      var def = CATALOG[id];
      if (def && def.kind === "consumable") {
        out.push("use:" + id);
      }
    });
    return out;
  }
  function levelUp(s, out) {
    while (s.xp >= s.xp_next) {
      s.xp -= s.xp_next;
      s.level += 1;
      s.xp_next = TUNING.xp_base + (s.level - 1) * TUNING.xp_step;
      s.hero.hp_max += TUNING.level_hp;
      s.hero.atk += TUNING.level_atk;
      s.hero.hp = Math.min(s.hero.hp_max, s.hero.hp + TUNING.level_heal);
      addLog(
        s,
        "levelup",
        "你升到 " + s.level + " 级，体力上限 " + s.hero.hp_max + "，攻击 " + s.hero.atk + "。",
        out
      );
    }
  }
  function resolveKill(s, out) {
    var f = s.foe;
    s.kills += 1;
    s.xp += f.xp;
    s.gold += f.gold;
    if (!f.boss && (s.foes_left || 0) > 0) {
      s.foes_left -= 1;
      if (s.foes_left === 0) {
        addLog(s, "clear", "本层的潜伏之物已肃清，石阶放行——可以下潜了。", out);
      }
    }
    if (f.elite) {
      s.flags.elites_slain += 1;
      randomGiveOfKind(s, ["weapon", "armor", "trinket"][rint(s, 0, 2)], out);
    } else {
      var w = Object.assign({}, TUNING.drop);
      var charm = baseOf(s.equip.trinket || "") === "charm";
      if (charm) {
        w.none = TUNING.drop_none_lucky;
      }
      var cat = weightedPick(s, w);
      if (cat === "none") {
        addLog(
          s,
          "kill",
          "你击败了" + f.name + "，获得 " + f.xp + " 经验、" + f.gold + " 金。",
          out
        );
      } else if (cat === "gold_pack") {
        var g = rint(s, TUNING.gold_pack[0], TUNING.gold_pack[1]);
        s.gold += g;
        addLog(
          s,
          "kill",
          "你击败了" + f.name + "，获得 " + f.xp + " 经验、" + (f.gold + g) + " 金（含一袋散金）。",
          out
        );
      } else if (cat === "potion") {
        s.potions += 1;
        addLog(
          s,
          "kill",
          "你击败了" + f.name + "，获得 " + f.xp + " 经验、" + f.gold + " 金、一瓶药水。",
          out
        );
      } else {
        var kind = cat === "potion_big" ? "consumable" : cat;
        addLog(
          s,
          "kill",
          "你击败了" + f.name + "，获得 " + f.xp + " 经验、" + f.gold + " 金。",
          out
        );
        randomGiveOfKind(s, kind, out);
        if (cat === "potion_big") {
        }
      }
    }
    var wasBoss = !!f.boss;
    s.foe = null;
    if (wasBoss) {
      s.boss_kills = (s.boss_kills || 0) + 1;
      addLog(
        s,
        "win",
        "第 " + s.depth + " 层守主倒下！战利品到手（累计击倒守主 " + s.boss_kills + "）。深渊仍在继续。",
        out
      );
    }
    levelUp(s, out);
  }
  function newmatch(args) {
    var seedIn = args && args.seed ? args.seed : 0;
    var s = {
      seed: seedIn,
      rng: seedIn >>> 0 || 2654435769,
      tick: 0,
      depth: 1,
      foes_left: minFoes(1),
      level: 1,
      xp: 0,
      xp_next: TUNING.xp_base,
      gold: 0,
      potions: TUNING.potion_start,
      kills: 0,
      boss_kills: 0,
      status: "explore",
      hero: {
        hp: TUNING.hero_hp,
        hp_max: TUNING.hero_hp,
        atk: TUNING.hero_atk,
        stance: "attack"
      },
      foe: null,
      actions: [],
      log: [],
      inventory: [],
      equip: { weapon: null, armor: null, trinket: null },
      statuses: {},
      pending: null,
      unidentified: [],
      identified: [],
      bag_cap: TUNING.inv_cap,
      flags: { events_this_layer: 0, elites_slain: 0, explores_this_layer: 0 }
    };
    addLog(s, "enter", "你走进第 1 层地牢，火把在石壁上噼啪作响。");
    var oTable = {};
    ORIGIN_DICE.forEach(function(f) {
      oTable[String(f.face)] = f.weight;
    });
    var oFace = parseInt(weightedPick(s, oTable), 10);
    var oDef = ORIGIN_DICE[oFace - 1];
    s.dice_face = oFace;
    s.prologue_boon = { kind: oDef.kind, label: oDef.label + "：" + oDef.desc };
    if (oDef.kind === "hp") {
      s.hero.hp_max += 5;
      s.hero.hp += 5;
    } else if (oDef.kind === "atk") {
      s.hero.atk += 2;
    } else if (oDef.kind === "gold") {
      s.gold += 60;
    } else if (oDef.kind === "item") {
      var boonKinds = ["weapon", "armor", "trinket", "consumable"];
      randomGiveOfKind(s, boonKinds[rint(s, 0, 3)], []);
    } else if (oDef.kind === "wound") {
      s.hero.hp_max = Math.max(10, s.hero.hp_max - 3);
      s.hero.hp = Math.min(s.hero.hp, s.hero.hp_max);
    } else if (oDef.kind === "poor") {
      s.potions = Math.max(0, s.potions - 1);
    }
    var resume = args && args.props && args.props.resume;
    if (resume && typeof resume === "object" && !resume.ending) {
      var r = resume;
      var num = (v, lo, hi, dflt) => {
        var n = Math.floor(Number(v));
        return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
      };
      s.tick = num(r.tick, 0, 1e5, 0);
      s.depth = num(r.depth, 1, 1e3, 1);
      s.level = num(r.level, 1, 99, 1);
      s.xp = num(r.xp, 0, 1e9, 0);
      s.gold = num(r.gold, 0, 1e9, 0);
      s.potions = num(r.potions, 0, 99, 0);
      s.kills = num(r.kills, 0, 1e9, 0);
      s.boss_kills = num(r.boss_kills, 0, 1e9, 0);
      s.bag_cap = num(r.bag_cap, TUNING.inv_cap, 24, TUNING.inv_cap);
      s.foes_left = num(r.foes_left, 0, 9, minFoes(s.depth));
      if (typeof r.rng === "number" && isFinite(r.rng)) s.rng = r.rng >>> 0;
      var rs = r.seed;
      if (typeof rs === "number" && isFinite(rs)) s.seed = rs | 0;
      var rh = r.hero;
      if (rh && typeof rh === "object") {
        s.hero.hp_max = num(rh.hp_max, 1, 9999, TUNING.hero_hp);
        s.hero.hp = num(rh.hp, 0, s.hero.hp_max, s.hero.hp_max);
        s.hero.atk = num(rh.atk, 1, 999, TUNING.hero_atk);
        var st = typeof rh.stance === "string" ? rh.stance : "attack";
        if (ACTIONS.indexOf(st) >= 0) s.hero.stance = st;
      }
      var re = r.equip;
      if (re && typeof re === "object") {
        var slots = [
          "weapon",
          "armor",
          "trinket"
        ];
        for (var si = 0; si < slots.length; si++) {
          var ev = re[slots[si]];
          var eb = typeof ev === "string" ? baseOf(ev) : "";
          var ed = eb ? CATALOG[eb] : null;
          if (ed && ed.slot === slots[si]) s.equip[slots[si]] = ev;
        }
      }
      if (Array.isArray(r.inventory)) {
        var inv = [];
        for (var ii = 0; ii < r.inventory.length; ii++) {
          var iv = r.inventory[ii];
          var ib = typeof iv === "string" ? baseOf(iv) : "";
          if (ib && CATALOG[ib] && inv.length < (s.bag_cap || TUNING.inv_cap) + 8) {
            inv.push(iv);
          }
        }
        s.inventory = inv;
      }
      if (Array.isArray(r.unidentified)) {
        s.unidentified = r.unidentified.filter(function(u) {
          return typeof u === "string" && !!CATALOG[u];
        });
      }
      if (Array.isArray(r.identified)) {
        for (var fi = 0; fi < r.identified.length; fi++) {
          var fv = r.identified[fi];
          if (typeof fv === "string" && CATALOG[fv]) markIdentified(s, fv);
        }
      }
      if (r.item_lore && typeof r.item_lore === "object") {
        var lo2 = {};
        var loN = 0;
        for (var lk in r.item_lore) {
          var lv = r.item_lore[lk];
          if (CATALOG[lk] && typeof lv === "string" && loN < 40) {
            lo2[lk] = lv.slice(0, 80);
            loN++;
          }
        }
        s.item_lore = lo2;
      }
      s.unidentified = (s.unidentified || []).filter(function(u) {
        return s.inventory.some(function(e) {
          return baseOf(e) === u;
        });
      });
      for (var wi = 0; wi < s.inventory.length; wi++) {
        if (!isUnid(s, s.inventory[wi]))
          markIdentified(s, baseOf(s.inventory[wi]));
      }
      if (r.statuses && typeof r.statuses === "object") {
        var st2 = {};
        for (var sk in r.statuses) {
          var sv = r.statuses[sk];
          if (sv && typeof sv === "object" && sk.length < 24) {
            st2[sk] = {
              turns: num(sv.turns, 0, 99, 0),
              dmg: sv.dmg === void 0 ? void 0 : num(sv.dmg, 0, 99, 0)
            };
          }
        }
        s.statuses = st2;
      }
      var rf = r.foe;
      if (rf && typeof rf === "object" && num(rf.hp, 0, 1e9, 0) > 0) {
        s.foe = {
          name: String(rf.name || "???").slice(0, 40),
          hp: num(rf.hp, 1, 1e9, 1),
          hp_max: num(rf.hp_max, 1, 1e9, 1),
          atk: num(rf.atk, 0, 999, 1),
          boss: !!rf.boss,
          elite: !!rf.elite,
          intent: typeof rf.intent === "string" ? rf.intent.slice(0, 16) : void 0,
          statuses: {}
        };
      }
      var rp = r.pending;
      if (rp && typeof rp === "object" && typeof rp.event_id === "string" && Array.isArray(rp.options)) {
        var hp0 = rp;
        hp0.left = typeof hp0.left === "number" ? hp0.left : TUNING.event_deadline;
        s.pending = hp0;
      }
      if (r.event_variants && typeof r.event_variants === "object") {
        var evh = {};
        var rv = r.event_variants;
        var evn = 0;
        for (var vk in rv) {
          if (!Array.isArray(rv[vk]) || evn >= 12) continue;
          var vl = [];
          var va = rv[vk];
          for (var vi = 0; vi < va.length && vl.length < 2 && evn < 12; vi++) {
            var vo = va[vi];
            if (!vo || typeof vo !== "object") continue;
            var vt = String(vo.title || "").trim().slice(0, 10);
            var vd = String(vo.desc || "").trim().slice(0, 40);
            if (vt && vd) {
              vl.push({ title: vt, desc: vd });
              evn++;
            }
          }
          if (vl.length && EVENT_IDS.indexOf(vk) >= 0) {
            evh[vk] = vl;
          }
        }
        s.event_variants = evh;
      }
      if (Array.isArray(r.log)) {
        s.log = r.log.slice(-200);
      }
      if (typeof r.status === "string" && r.status.length < 16) {
        s.status = r.status;
      }
      if (r.flags && typeof r.flags === "object") {
        var rf2 = r.flags;
        var fk = ["events_this_layer", "explores_this_layer", "elites_slain"];
        for (var fi2 = 0; fi2 < fk.length; fi2++) {
          if (typeof rf2[fk[fi2]] === "number") {
            s.flags[fk[fi2]] = rf2[fk[fi2]];
          }
        }
        if (typeof rf2.dm_hex === "boolean") s.flags.dm_hex = rf2.dm_hex;
        if (typeof rf2.dm_ambush === "boolean") s.flags.dm_ambush = rf2.dm_ambush;
      }
      if (typeof r.xp_next === "number" && isFinite(r.xp_next)) {
        s.xp_next = Math.max(1, Math.min(1e9, Math.floor(r.xp_next)));
      }
      s.resumes = (r.resumes | 0) + 1;
      var rb = r.prologue_boon;
      if (rb && typeof rb === "object" && typeof rb.kind === "string") {
        s.prologue_boon = {
          kind: rb.kind,
          label: String(rb.label || "").slice(0, 40)
        };
      }
      if (typeof r.prologue_text === "string") {
        s.prologue_text = r.prologue_text.slice(0, 80);
      }
      addLog(s, "enter", "你从第 " + s.depth + " 层的存档中醒来，火把重新燃起。");
      s.actions = legalActions(s);
      return { state: s };
    }
    var legacy = args && args.props && args.props.legacy;
    if (legacy && legacy.length) {
      var names = [];
      for (var i = 0; i < legacy.length && s.inventory.length < 3; i++) {
        var lid = typeof legacy[i] === "string" ? legacy[i] : "";
        var lbase = lid ? baseOf(lid) : "";
        var ldef = lbase ? CATALOG[lbase] : null;
        if (!ldef || s.inventory.indexOf(lid) >= 0) continue;
        s.inventory.push(lid);
        markIdentified(s, lbase);
        names.push(ldef.name);
      }
      if (names.length) {
        addLog(s, "legacy", "守主的遗产与你同行：" + names.join("、") + "。");
      }
    }
    var knownIds = args && args.props && args.props.identified;
    if (knownIds && knownIds.length) {
      var known = s.identified || (s.identified = []);
      for (var ki = 0; ki < knownIds.length; ki++) {
        var kid = typeof knownIds[ki] === "string" ? knownIds[ki] : "";
        if (kid && CATALOG[kid] && known.indexOf(kid) < 0) {
          known.push(kid);
        }
      }
    }
    var loreIn = args && args.props && args.props.lore;
    if (loreIn && typeof loreIn === "object") {
      var loreOut = {};
      var loreN = 0;
      for (var lb in loreIn) {
        var lv = loreIn[lb];
        if (loreN >= 40) break;
        if (Object.prototype.hasOwnProperty.call(loreIn, lb) && CATALOG[lb] && typeof lv === "string" && lv) {
          loreOut[lb] = lv.slice(0, 80);
          loreN += 1;
        }
      }
      s.item_lore = loreOut;
    }
    s.actions = legalActions(s);
    return { state: s };
  }
  function heroStatusTick(s, out) {
    var st = s.statuses;
    if (st.poison) {
      s.hero.hp = Math.max(0, s.hero.hp - (st.poison.dmg || 0));
      addLog(s, "hurt", "毒素在血管里烧（-" + st.poison.dmg + " 体力）。", out);
    }
    if (st.burn) {
      s.hero.hp = Math.max(0, s.hero.hp - (st.burn.dmg || 0));
      addLog(
        s,
        "hurt",
        "火苗燎着了皮甲下的皮肤（-" + st.burn.dmg + " 体力）。",
        out
      );
    }
    var regen = baseOf(s.equip.trinket || "") === "ring_regen" ? CATALOG.ring_regen.regen || 0 : 0;
    var drain = baseOf(s.equip.trinket || "") === "cursed_ring" ? CATALOG.cursed_ring.drain || 0 : 0;
    if (regen) {
      s.hero.hp = Math.min(s.hero.hp_max, s.hero.hp + regen);
      addLog(s, "guard", "回环戒微微发烫（+" + regen + " 体力）。", out);
    }
    if (drain) {
      s.hero.hp = Math.max(0, s.hero.hp - drain);
      addLog(s, "hurt", "血诅戒噬咬你的手指（-" + drain + " 体力）。", out);
    }
    for (var k in st) {
      st[k].turns -= 1;
      if (st[k].turns <= 0) {
        delete st[k];
      }
    }
  }
  function foeStatusTick(s, out) {
    var f = s.foe;
    if (!f || !f.statuses) {
      return;
    }
    for (var k in f.statuses) {
      var st = f.statuses[k];
      f.hp = Math.max(0, f.hp - (st.dmg || 0));
      addLog(
        s,
        "hit",
        f.name + (k === "burn" ? "身上还燃着火" : "的伤口泛着紫黑") + "（-" + st.dmg + "）。",
        out
      );
      st.turns -= 1;
      if (st.turns <= 0) {
        delete f.statuses[k];
      }
    }
  }
  function tick(args) {
    var s = JSON.parse(JSON.stringify(args.state));
    var commands = args.commands || {};
    var events = [];
    if (!s.hero || !s.hero.hp_max) {
      return { state: s, events };
    }
    migrate(s);
    var gmOps = collectGmOps(commands);
    var hasAction = !!pickCommand(commands, "action");
    var hasEquip = !!pickCommand(commands, "equip");
    var hasChoose = !!pickCommand(commands, "choose");
    if (!s.pending && !s.ending && !hasAction && !hasEquip && !hasChoose && gmOps.length === 0) {
      return { state: s, events, wait: true };
    }
    if (s.ending || hasAction || hasEquip || gmOps.length) {
      s.tick = (s.tick || 0) + 1;
    }
    var action = hasAction ? pickCommand(commands, "action") : null;
    var illegal = null;
    if (action) {
      var isUse = action.indexOf("use:") === 0;
      var isDrop = action.indexOf("drop:") === 0;
      var known = ACTIONS.indexOf(action) >= 0 || isUse && s.inventory.indexOf(action.slice(4)) >= 0 && CATALOG[action.slice(4)] && CATALOG[action.slice(4)].kind === "consumable" || isDrop && s.inventory.indexOf(resolveEntry(s, action.slice(5))) >= 0;
      if (known) {
        if (isDrop) {
          var did = resolveEntry(s, action.slice(5));
          var ddef = CATALOG[baseOf(did)];
          takeOff(s, did);
          s.inventory.splice(s.inventory.indexOf(did), 1);
          addLog(
            s,
            "order",
            "你丢下了" + (ddef ? ddef.name : "一件物品") + "。",
            events
          );
        } else if (s.hero.stance !== action) {
          s.hero.stance = action;
          if (isUse) {
            var ud = CATALOG[action.slice(4)];
            addLog(
              s,
              "order",
              "你掏出了" + (ud ? ud.name : "道具") + "。",
              events
            );
          } else {
            addLog(s, "order", "你决定" + ACT_LABEL[action] + "。", events);
          }
        }
      } else {
        addLog(
          s,
          "illegal",
          "无法识别的指令「" + action + "」，你继续按原姿势行动。",
          events
        );
      }
    }
    var equipId = pickCommand(commands, "equip");
    if (equipId && !doEquip(s, equipId, events)) {
      addLog(s, "illegal", "装不上「" + equipId + "」。", events);
    }
    var nar = pickNarrate(commands);
    if (nar) {
      for (var i = s.log.length - 1; i >= 0; i--) {
        if (s.log[i].tick === nar.tick && s.log[i].kind === nar.kind) {
          if (!s.log[i].flavor) {
            s.log[i].flavor = String(nar.text).slice(0, 24);
          }
          break;
        }
      }
      if (nar.pop && s.flavor_bank && s.flavor_bank[nar.pop]) {
        s.flavor_bank[nar.pop].shift();
        if (!s.flavor_bank[nar.pop].length) delete s.flavor_bank[nar.pop];
      }
    }
    var bk = pickBrain(commands, "bank");
    if (bk && !Array.isArray(bk) && typeof bk === "object") {
      if (!s.flavor_bank) s.flavor_bank = {};
      var total = 0;
      for (var fb in s.flavor_bank) total += s.flavor_bank[fb].length;
      for (var bkind in bk) {
        if (bkind.length > 16 || !Array.isArray(bk[bkind])) continue;
        var add = [];
        var arr2 = bk[bkind];
        for (var bi = 0; bi < arr2.length && add.length < 4 && total + add.length < 60; bi++) {
          var bl = String(arr2[bi] || "").replace(/\s+/g, " ").trim().slice(0, 20);
          if (bl) add.push(bl);
        }
        if (add.length) {
          var cur = s.flavor_bank[bkind] || [];
          s.flavor_bank[bkind] = cur.concat(add).slice(0, 8);
          total += add.length;
        }
      }
    }
    var ev = pickBrain(commands, "event_variants");
    if (ev && !Array.isArray(ev) && typeof ev === "object") {
      if (!s.event_variants) s.event_variants = {};
      var evTotal = 0;
      for (var evk in s.event_variants) evTotal += s.event_variants[evk].length;
      for (var evid in ev) {
        if (EVENT_IDS.indexOf(evid) < 0 || !Array.isArray(ev[evid])) continue;
        var curPool = s.event_variants[evid] || [];
        var arr3 = ev[evid];
        for (var ei = 0; ei < arr3.length && curPool.length < 2 && evTotal < 12; ei++) {
          var evo = arr3[ei];
          if (!evo || typeof evo !== "object") continue;
          var et = String(evo.title || "").replace(/\s+/g, " ").trim().slice(0, 10);
          var ed = String(evo.desc || "").replace(/\s+/g, " ").trim().slice(0, 40);
          if (et && ed) {
            curPool.push({ title: et, desc: ed });
            evTotal++;
          }
        }
        if (curPool.length) s.event_variants[evid] = curPool;
      }
    }
    var wh = pickBrain(commands, "whisper");
    if (wh && wh.sig && wh.text && s.whisper_sig !== wh.sig) {
      addLog(s, "whisper", "暗处的低语：" + String(wh.text).slice(0, 40), events);
      s.whisper_sig = wh.sig;
    }
    var lo = pickBrain(commands, "lore");
    if (lo && lo.base && CATALOG[lo.base] && lo.text) {
      if (!s.item_lore) {
        s.item_lore = {};
      }
      if (!s.item_lore[lo.base]) {
        s.item_lore[lo.base] = String(lo.text).slice(0, 80);
      }
    }
    var pr = pickBrain(commands, "prologue");
    if (pr && pr.text && !s.prologue_text) {
      s.prologue_text = String(pr.text).slice(0, 80);
      var pl = addLog(s, "prologue", "【序章】你的故事开始了。", events);
      pl.flavor = s.prologue_text;
    }
    var ep = pickBrain(commands, "epitaph");
    if (ep && ep.text && !s.epitaph) {
      s.epitaph = String(ep.text).slice(0, 60);
    }
    var dm = pickBrain(commands, "dm");
    if (dm && !s.ending && s.depth >= TUNING.dm_min_depth && s.tick - (s.dm_tick || -99) >= TUNING.dm_cooldown) {
      var dmLog = null;
      if (dm.move === "tremor") {
        var tdmg = 2 + rint(s, 0, 2);
        s.hero.hp = Math.max(0, s.hero.hp - tdmg);
        dmLog = "甬道骤然震颤——地牢之主在震怒，落石砸中了你（-" + tdmg + "）。";
      } else if (dm.move === "hex") {
        s.flags.dm_hex = true;
        dmLog = "低沉的咒文从岩缝渗出——地牢之主盯上了你的剑。";
      } else if (dm.move === "ambush") {
        s.flags.dm_ambush = true;
        dmLog = "黑暗深处传来窸窣的脚步——有什么被唤醒了。";
      }
      if (dmLog) {
        addLog(s, "dm", dmLog, events);
        s.dm_tick = s.tick;
      }
    }
    if (gmOps.length && !s.ending) {
      applyGmOps(s, gmOps, events);
    }
    if (s.ending) {
      s.actions = legalActions(s);
      return { state: s, events };
    }
    if (s.pending) {
      var p = s.pending;
      if (typeof p.left !== "number") {
        p.left = TUNING.event_deadline;
      }
      var chooseId = pickCommand(commands, "choose");
      var valid = false;
      if (chooseId) {
        for (var oi = 0; oi < p.options.length; oi++) {
          if (p.options[oi].id === chooseId) {
            valid = typeof p.options[oi].cost !== "number" || s.gold >= p.options[oi].cost;
            break;
          }
        }
      }
      if (chooseId && !valid) {
        addLog(s, "illegal", "这个选择现在行不通，事件仍悬而未决。", events);
      } else if (chooseId) {
        applyChoice(s, chooseId, events);
      } else if (p.left <= 0) {
        addLog(s, "event", "你犹豫太久，命运替你做了选择。", events);
        applyChoice(s, p.default, events);
      } else {
        p.left -= 1;
      }
    }
    if (hasAction || hasEquip || gmOps.length) {
      heroStatusTick(s, events);
    }
    if (!s.foe && !s.pending && s.status === "explore" && s.flags.events_this_layer === 0 && s.tick > 0 && // 开局首层不立即触发
    !pickCommand(commands, "choose") && // 同轮刚做完抉择不再开新事件房
    pickCommand(commands, "action") !== "descend" && pickCommand(commands, "action") !== "explore" && pct(s, TUNING.event_pct)) {
      openEvent(s, events);
    }
    if (action) {
      var stance = s.hero.stance;
      var tookAction = false;
      var freshFoe = false;
      if (stance === "attack") {
        if (s.foe) {
          if (s.flags.dm_hex) {
            s.flags.dm_hex = false;
            addLog(
              s,
              "curse",
              "地牢之主的咒文缠上你的手腕——这一击落空了。",
              events
            );
            tookAction = true;
          } else {
            var dmg = Math.max(1, effAtk(s) + rint(s, 0, 2) - (s.foe.armor || 0));
            s.foe.hp = Math.max(0, s.foe.hp - dmg);
            addLog(
              s,
              "hit",
              "你击中" + s.foe.name + "，造成 " + dmg + " 点伤害。",
              events
            );
            var w = s.equip.weapon ? CATALOG[baseOf(s.equip.weapon)] : null;
            if (w && w.on_hit && s.foe.hp > 0 && pct(s, w.on_hit.pct)) {
              if (!s.foe.statuses) {
                s.foe.statuses = {};
              }
              s.foe.statuses[w.on_hit.status] = {
                turns: TUNING.foe_status.turns,
                dmg: TUNING.foe_status.dmg
              };
              addLog(
                s,
                "hit",
                s.foe.name + (w.on_hit.status === "burn" ? "被点燃了！" : "中毒了！"),
                events
              );
            }
            tookAction = true;
          }
        }
      } else if (stance === "guard") {
        if (s.foe) {
          if (pct(s, TUNING.guard_counter_pct)) {
            var cdmg = Math.max(
              1,
              Math.floor(effAtk(s) / 2) + rint(s, 0, 1) - (s.foe.armor || 0)
            );
            s.foe.hp = Math.max(0, s.foe.hp - cdmg);
            addLog(
              s,
              "guard",
              "你举盾格挡——顺势一记反击，" + s.foe.name + "吃了 " + cdmg + " 点伤害。",
              events
            );
          } else {
            addLog(s, "guard", "你举盾格挡，稳住阵脚。", events);
          }
          tookAction = true;
        }
      } else if (stance === "potion") {
        if (s.potions > 0) {
          s.potions -= 1;
          var heal = TUNING.potion_heal;
          if (s.foe && s.foe.boss) {
            heal = Math.ceil(heal * TUNING.potion_boss_mult);
          } else if (s.foe && s.foe.elite) {
            heal = Math.ceil(heal * TUNING.potion_elite_mult);
          }
          var ph = Math.min(s.hero.hp_max, s.hero.hp + heal) - s.hero.hp;
          s.hero.hp += ph;
          addLog(
            s,
            "potion",
            "你喝下药水，回复 " + ph + " 点体力。" + (s.foe && (s.foe.boss || s.foe.elite) ? "强敌当前，药力奔涌。" : ""),
            events
          );
          s.hero.stance = "attack";
        } else {
          illegal = "potion";
          s.hero.stance = "attack";
        }
      } else if (stance.indexOf("use:") === 0) {
        var uid = stance.slice(4);
        var udef = CATALOG[uid];
        if (udef && udef.kind === "consumable" && s.inventory.indexOf(uid) >= 0) {
          if (udef.use === "heal") {
            s.inventory.splice(s.inventory.indexOf(uid), 1);
            var uheal = udef.heal || 0;
            if (s.foe && s.foe.boss) {
              uheal = Math.ceil(uheal * TUNING.potion_boss_mult);
            } else if (s.foe && s.foe.elite) {
              uheal = Math.ceil(uheal * TUNING.potion_elite_mult);
            }
            var uh = Math.min(s.hero.hp_max, s.hero.hp + uheal) - s.hero.hp;
            s.hero.hp += uh;
            addLog(
              s,
              "potion",
              "你喝下" + udef.name + "，回复 " + uh + " 点体力。" + (s.foe && (s.foe.boss || s.foe.elite) ? "强敌当前，药力奔涌。" : ""),
              events
            );
          } else if (udef.use === "bomb") {
            if (s.foe) {
              s.inventory.splice(s.inventory.indexOf(uid), 1);
              var bd = 10 + 2 * s.depth;
              s.foe.hp = Math.max(0, s.foe.hp - bd);
              addLog(
                s,
                "hit",
                "火油弹在" + s.foe.name + "脚下炸开，" + bd + " 点伤害。",
                events
              );
            } else {
              illegal = uid;
            }
          } else if (udef.use === "shield") {
            s.inventory.splice(s.inventory.indexOf(uid), 1);
            s.statuses.shield = {
              turns: TUNING.shield.turns,
              armor: TUNING.shield.armor
            };
            addLog(
              s,
              "event",
              "圣光裹住你（受伤 -" + TUNING.shield.armor + "，" + TUNING.shield.turns + " 回合）。",
              events
            );
          } else if (udef.use === "antidote") {
            if (s.statuses.poison) {
              s.inventory.splice(s.inventory.indexOf(uid), 1);
              delete s.statuses.poison;
              addLog(s, "event", "苦涩的药汁压下了毒素。", events);
            } else {
              illegal = uid;
            }
          } else if (udef.use === "might") {
            s.inventory.splice(s.inventory.indexOf(uid), 1);
            s.statuses.might = {
              turns: TUNING.might.turns,
              atk: TUNING.might.atk
            };
            addLog(
              s,
              "event",
              "秘药入喉，肌肉贲张（攻击 +" + TUNING.might.atk + "）。",
              events
            );
          } else if (udef.use === "identify") {
            var unids = (s.unidentified || []).filter(function(b) {
              return s.inventory.some(function(e) {
                return baseOf(e) === b;
              });
            });
            if (unids.length === 0) {
              illegal = uid;
            } else {
              s.inventory.splice(s.inventory.indexOf(uid), 1);
              if (pct(s, TUNING.scroll_break_pct)) {
                var victims = s.inventory.filter(function(e) {
                  return unids.indexOf(baseOf(e)) >= 0;
                });
                var victimEntry = victims[rint(s, 0, victims.length - 1)];
                var vBase = baseOf(victimEntry);
                s.inventory.splice(s.inventory.indexOf(victimEntry), 1);
                var vui = s.unidentified.indexOf(vBase);
                if (vui >= 0) s.unidentified.splice(vui, 1);
                addLog(
                  s,
                  "curse",
                  "古卷哗啦碎裂——铭文终究未显，裂页还把「" + CATALOG[vBase].name + "」划坏了（损毁）。",
                  events
                );
              } else {
                var names2 = [];
                unids.forEach(function(b) {
                  markIdentified(s, b);
                  names2.push(CATALOG[b].name);
                });
                var idEv = addLog(
                  s,
                  "event",
                  "古卷铭文流转，谜团解开：" + names2.join("、") + "。",
                  events
                );
                idEv.ids = unids.slice();
              }
            }
          } else if (udef.use === "bag") {
            s.inventory.splice(s.inventory.indexOf(uid), 1);
            s.bag_cap = (s.bag_cap || TUNING.inv_cap) + 2;
            addLog(
              s,
              "event",
              "暗袋撑开，针脚如活物般游走——这一趟探险，背包能多装 2 种物件了（当前容量 " + s.bag_cap + "）。",
              events
            );
          }
        } else {
          illegal = uid;
        }
        if (!illegal) {
          s.hero.stance = "attack";
        } else {
          s.hero.stance = "attack";
        }
      } else if (stance === "flee") {
        if (s.foe) {
          var escaped = pct(s, fleeChance(s));
          s.hero.hp = Math.min(s.hero.hp_max, s.hero.hp + TUNING.flee_regen);
          if (escaped) {
            var lost = Math.min(s.gold, TUNING.flee_gold_loss);
            s.gold -= lost;
            addLog(
              s,
              "flee",
              "你甩开" + s.foe.name + "退回入口，丢掉 " + lost + " 金。",
              events
            );
            s.foe = null;
            s.hero.stance = "attack";
          } else {
            addLog(s, "flee", "逃跑失败，" + s.foe.name + "挡住了去路。", events);
          }
          tookAction = true;
        } else {
          illegal = "flee";
          s.hero.stance = "attack";
        }
      } else if (stance === "descend") {
        if (!s.foe && !s.pending && (s.foes_left || 0) <= 0) {
          s.depth += 1;
          s.foes_left = minFoes(s.depth);
          s.flags.events_this_layer = 0;
          s.flags.explores_this_layer = 0;
          s.hero.hp = Math.min(s.hero.hp_max, s.hero.hp + TUNING.descend_regen);
          addLog(
            s,
            "descend",
            "你沿石阶下行，来到第 " + s.depth + " 层。",
            events
          );
          if (s.depth % TUNING.boss_every === 0) {
            s.foe = spawn(s);
            addLog(
              s,
              "spawn",
              "黑暗中一双眼睛睁开——" + s.foe.name + "镇守此层（体力 " + s.foe.hp + "，攻击 " + s.foe.atk + "）！不掀翻它就别想继续往下。",
              events
            );
          }
          s.hero.stance = "attack";
        } else {
          illegal = "descend";
          s.hero.stance = "attack";
        }
        tookAction = true;
      } else if (stance === "explore") {
        if (s.foe || s.pending) {
          illegal = "explore";
          s.hero.stance = "attack";
        } else if ((s.flags.explores_this_layer || 0) >= TUNING.explores_max && (s.foes_left || 0) <= 0) {
          addLog(
            s,
            "explore",
            "这一层已被你翻了个底朝天，再摸也摸不出什么了。",
            events
          );
          s.hero.stance = "attack";
          tookAction = true;
        } else {
          var foeBefore = !!s.foe;
          s.flags.explores_this_layer = (s.flags.explores_this_layer || 0) + 1;
          exploreRoll(s, events);
          s.hero.stance = "attack";
          tookAction = true;
          freshFoe = !foeBefore && !!s.foe;
        }
      }
      if (illegal) {
        var il = CATALOG[illegal] ? CATALOG[illegal].name : ACT_LABEL[illegal] || illegal;
        if (s.pending) {
          addLog(s, "illegal", "抉择未定，「" + il + "」先放一放。", events);
        } else if (illegal === "descend" && (s.foes_left || 0) > 0) {
          addLog(
            s,
            "illegal",
            "石阶被封着——黑暗里有东西守着它。探索把它们惊出来。",
            events
          );
        } else if (!s.foe) {
          addLog(s, "illegal", "现在不能用" + il + "。", events);
        } else {
          addLog(s, "illegal", "现在不能用" + il + "，你改为攻击。", events);
        }
      }
      foeStatusTick(s, events);
      if (s.foe && s.foe.hp <= 0) {
        resolveKill(s, events);
      }
      if (s.foe && s.foe.hp > 0) {
        if (freshFoe && !pct(s, TUNING.ambush_pct)) {
          addLog(s, "spawn", "它还没反应过来——你抢到了先机。", events);
        } else {
          if (s.foe.intent === "狂暴") {
            s.foe.atk += 1;
          }
          var mdmg = s.foe.atk + rint(s, 0, 2);
          if (tookAction && stance === "guard") {
            mdmg = Math.ceil(mdmg / TUNING.guard_reduce);
          }
          mdmg = Math.max(1, mdmg - armorSum(s));
          s.hero.hp = Math.max(0, s.hero.hp - mdmg);
          addLog(
            s,
            "hurt",
            s.foe.name + "反击，你受到 " + mdmg + " 点伤害。",
            events
          );
          if (s.foe.intent === "剧毒" && pct(s, 30) && !s.statuses.poison) {
            s.statuses.poison = {
              turns: TUNING.foe_status.turns,
              dmg: TUNING.hero_status_dmg.poison
            };
            addLog(s, "hurt", "它的爪子带着毒——你中毒了。", events);
          }
        }
      }
    }
    if (s.hero.hp <= 0) {
      s.status = "dead";
      if (!s.ending) {
        s.ending = "death";
        s.ending_tick = s.tick;
      }
      addLog(
        s,
        "death",
        "你倒在第 " + s.depth + " 层，" + s.kills + " 只怪物陪葬。",
        events
      );
    }
    s.actions = legalActions(s);
    return { state: s, events };
  }
  function snapshot(args) {
    var s = JSON.parse(JSON.stringify(args.state));
    s.catalog = CATALOG;
    s.origin_dice = ORIGIN_DICE;
    return s;
  }
  function over(args) {
    var s = args.state;
    if (s.hero && s.hero.hp <= 0) {
      if (s.ending && (s.epitaph || s.tick - (s.ending_tick || 0) >= 2)) {
        return {
          over: true,
          result: {
            winner: "monsters",
            reason: "hero_died",
            depth: s.depth,
            boss_kills: s.boss_kills || 0,
            epitaph: s.epitaph || ""
          }
        };
      }
      return { over: null };
    }
    return { over: null };
  }
  globalThis.newmatch = newmatch;
  globalThis.tick = tick;
  globalThis.snapshot = snapshot;
  globalThis.over = over;
})();
