// Dungeon crawl rules pack v2: realtime tick-driven text dungeon with items,
// event rooms, statuses and elite foes.
//
// Required exports (as globals): newmatch, tick, snapshot, over.
// Rules only do numbers: no host.* access (no LLM, no Jev), no wall clock.
// Randomness comes from a deterministic PRNG whose 32-bit state lives in
// state.rng, so "same seed + same command sequence -> same outcome" holds and
// headless runs stay reproducible. The Jev/LLM brains only ever choose among
// the options the rules lay out — they are players, not referees.
//
// State v2 adds on top of v1:
//   inventory (item ids, cap 6), equip slots, hero statuses,
//   pending (event-room decision with a tick deadline), flags.
// Commands per seat:
//   { action } sticky posture | "use:<id>" one-shot consumable
//   { choose: optionId }       event-room decision (before deadline)
//   { equip: itemId }          free action, does not consume the turn
//   { narrate }                narrator seat flavor merge
//
// TUNING below mirrors tuning.json (inlined so the pack hot-swaps as one file).

import type { ItemDef, LogLine, Pending, State, StatusInst } from "./shared";

var TUNING = {
  tick_ms: 2000,
  boss_every: 5, // 每 5 层一个守主（第 5/10/15…层），属性随深度增强
  hero_hp: 30,
  hero_atk: 6,
  guard_reduce: 2, // divisor applied to incoming damage before armor
  guard_regen: 3, // （已弃用，v5.6 格挡改概率反击）保留键位防旧存档/旧 tuning 报错
  guard_counter_pct: 40, // 格挡触发反击的概率%
  potion_boss_mult: 1.5, // 守主战药效倍率
  potion_elite_mult: 1.2, // 精英战药效倍率
  ambush_pct: 30, // 探索搅醒敌人时，敌人抢先出手的机会%（其余情况你抢到先机）
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
    d_gold: 3,
  },
  monster_names: ["岩缝鼠", "腐骨兵", "毒雾蛛", "石壁蝠", "失落卫士", "幽影"],
  // 守主基线必须全面压制同期的精英怪，否则决战没有分量；每深一个
  // 里程碑（boss_every 层）整体再抬一档，深渊没有尽头。
  boss: { name: "地牢之主", hp: 150, atk: 16, xp: 100, gold: 400 },

  // v2
  log_cap: 60,
  inv_cap: 6,
  event_pct: 85, // chance per cleared layer (non-boss) to open a room
  event_deadline: 6, // ticks to decide before the default kicks in
  explores_max: 6, // 每层主动探索次数上限（防翻箱刷资源；探索是主循环，上限放宽）
  min_foes_cap: 3, // 每层最低击杀配额上限（1 + 每过 5 层 +1，封顶）
  gear_every: 3, // 装备主属性：每 3 层深度 +1（获取时定格，已装备的不涨）
  scroll_break_pct: 20, // 鉴定古卷失败率：被鉴定装备直接损坏
  unid_pct: 35, // 装备类掉落为「未鉴定」的概率
  dm_cooldown: 5, // 地牢之主两次得手之间至少隔几个 tick（规则侧冷却）
  dm_min_depth: 3, // 浅层不欺负新人：地牢之主从这个深度开始出手
  elite_pct_base: 0, // 精英概率 = base + per_depth * depth（base 0：第 1 层 4%，浅层别上精英）
  elite_pct_per_depth: 4,
  elite: { hp: 1.7, atk: 1.5, xp: 2, gold: 2.5 },
  intents: ["狂暴", "铁壁", "剧毒"],
  foe_status: { turns: 3, dmg: 2 }, // weapon-inflicted burn/poison on foes
  hero_status_dmg: { poison: 2, burn: 2 }, // fixed per-tick, no rng
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
    potion_big: 5,
  },
  drop_none_lucky: 15, // charm replaces the `none` weight with this
  gold_pack: [8, 18],
  merchant_scale: [0.4, 0.4], // price = ceil(base * (0.4 + 0.4 * depth))
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
      desc: "回复 16 点体力。",
    },
    {
      id: "potion_big",
      name: "大红药",
      kind: "consumable",
      price: 25,
      use: "heal",
      heal: 30,
      desc: "回复 30 点体力。",
    },
    {
      id: "bomb",
      name: "火油弹",
      kind: "consumable",
      price: 20,
      use: "bomb",
      desc: "对当前敌人造成 10+2×层数 伤害。",
    },
    {
      id: "scroll_shield",
      name: "圣光卷轴",
      kind: "consumable",
      price: 18,
      use: "shield",
      desc: "获得 3 回合圣盾（受伤 -2）。",
    },
    {
      id: "antidote",
      name: "解毒剂",
      kind: "consumable",
      price: 10,
      use: "antidote",
      desc: "解除中毒。",
    },
    {
      id: "elixir",
      name: "巨人秘药",
      kind: "consumable",
      price: 22,
      use: "might",
      desc: "5 回合内攻击 +3。",
    },
    {
      id: "rust_sword",
      name: "锈剑",
      kind: "weapon",
      slot: "weapon",
      price: 15,
      atk: 1,
      desc: "攻击 +1。",
    },
    {
      id: "iron_sword",
      name: "铁剑",
      kind: "weapon",
      slot: "weapon",
      price: 40,
      atk: 3,
      desc: "攻击 +3。",
    },
    {
      id: "flame_blade",
      name: "焰刃",
      kind: "weapon",
      slot: "weapon",
      price: 70,
      atk: 5,
      on_hit: { status: "burn", pct: 25 },
      desc: "攻击 +5，25% 点燃敌人。",
    },
    {
      id: "viper_dagger",
      name: "毒牙匕首",
      kind: "weapon",
      slot: "weapon",
      price: 55,
      atk: 2,
      on_hit: { status: "poison", pct: 30 },
      desc: "攻击 +2，30% 使敌人中毒。",
    },
    {
      id: "leather",
      name: "皮甲",
      kind: "armor",
      slot: "armor",
      price: 20,
      armor: 1,
      desc: "受伤 -1。",
    },
    {
      id: "chain",
      name: "锁子甲",
      kind: "armor",
      slot: "armor",
      price: 45,
      armor: 2,
      desc: "受伤 -2。",
    },
    {
      id: "plate",
      name: "板甲",
      kind: "armor",
      slot: "armor",
      price: 80,
      armor: 4,
      desc: "受伤 -4。",
    },
    {
      id: "lantern",
      name: "提灯",
      kind: "trinket",
      slot: "trinket",
      price: 30,
      event_pct: 15,
      desc: "事件与暗道判定更安全（+15%）。",
    },
    {
      id: "amulet",
      name: "生命护符",
      kind: "trinket",
      slot: "trinket",
      price: 35,
      hp_max: 8,
      desc: "装备时体力上限 +8。",
    },
    {
      id: "ring_regen",
      name: "回环戒",
      kind: "trinket",
      slot: "trinket",
      price: 50,
      regen: 2,
      desc: "每回合回复 2 点体力。",
    },
    {
      id: "charm",
      name: "幸运符",
      kind: "trinket",
      slot: "trinket",
      price: 40,
      lucky: true,
      desc: "掉落更慷慨。",
    },
    {
      id: "scroll_identify",
      name: "鉴定古卷",
      kind: "consumable",
      price: 26,
      use: "identify",
      desc: "火漆封缄的残卷，展开的刹那，蒙尘装备的铭文将自行显形。羊皮古旧，两成机率失灵并蚀坏一件——鉴定有险，落笔无悔。",
    },
    {
      id: "pack_expander",
      name: "扩容袋",
      kind: "consumable",
      price: 30,
      use: "bag",
      desc: "失传匠人的折迭革囊。撑开暗袋，这一趟探险背包多容 2 种物件；归窟之后针脚自散，一切如初。",
    },
    {
      id: "cursed_ring",
      name: "血诅戒",
      kind: "cursed",
      slot: "trinket",
      price: 0,
      atk: 4,
      drain: 1,
      desc: "攻击 +4，但每回合流失 1 点体力（祭坛可移除）。",
    },
    {
      id: "lead_boots",
      name: "铅靴",
      kind: "cursed",
      slot: "armor",
      price: 0,
      armor: 2,
      flee_pct: -20,
      desc: "受伤 -2，但逃跑概率 -20%。",
    },
  ] as ItemDef[],
};

var LOG_CAP = TUNING.log_cap;

// ---- 装备实例（id@depth） ----------------------------------------------------
// inventory / equip 中的装备类条目是 "id@depth"：@ 后为获取（掉落/购买）时的
// 层数，主属性按它定格——新获得的道具随层数变强，已经装备的不跟着涨。
// 消耗品没有后缀（效果与层数无关）。旧存档由 migrate() 补后缀。
function baseOf(entry: string): string {
  var i = entry.indexOf("@");
  return i < 0 ? entry : entry.slice(0, i);
}
function gearDepth(entry: string): number {
  var i = entry.indexOf("@");
  return i < 0 ? 1 : parseInt(entry.slice(i + 1), 10) || 1;
}
function stampDepth(id: string, depth: number): string {
  return id + "@" + depth;
}
function gearAtk(entry: string): number {
  var def = CATALOG[baseOf(entry)];
  return def && def.atk
    ? def.atk + Math.floor((gearDepth(entry) - 1) / TUNING.gear_every)
    : 0;
}
function gearArmor(entry: string): number {
  var def = CATALOG[baseOf(entry)];
  return def && def.armor
    ? def.armor + Math.floor((gearDepth(entry) - 1) / TUNING.gear_every)
    : 0;
}
function gearHpMax(entry: string): number {
  var def = CATALOG[baseOf(entry)];
  return def && def.hp_max
    ? def.hp_max + Math.floor((gearDepth(entry) - 1) / TUNING.gear_every)
    : 0;
}
function isUnid(s: State, entry: string): boolean {
  return !!s.unidentified && s.unidentified.indexOf(baseOf(entry)) >= 0;
}
// 鉴定成功（穿上/古卷成功）后的落账：从未鉴定表移除、加入已鉴定表。
function markIdentified(s: State, base: string): void {
  if (!s.unidentified) s.unidentified = [];
  if (!s.identified) s.identified = [];
  var ui = s.unidentified.indexOf(base);
  if (ui >= 0) s.unidentified.splice(ui, 1);
  if (s.identified.indexOf(base) < 0) s.identified.push(base);
}

var ACTIONS = ["attack", "guard", "potion", "flee", "descend", "explore"];
var ACT_LABEL: Record<string, string> = {
  attack: "攻击",
  guard: "格挡",
  potion: "喝药",
  flee: "逃跑",
  descend: "下潜",
  explore: "探索",
};
var EVENTS = ["merchant", "altar", "chest", "fork", "adventurer", "gambler"];
// 事件动态文案池的白名单（= EVENTS；pit 不算房）。narrator 也按这份投递。
var EVENT_IDS = EVENTS;

// v5.2 出身骰（8 面）：好坏面的概率直接体现在骰面权重上——
// 好 4/9 ≈ 44%，坏 2/9 ≈ 22%，平凡 3/9 ≈ 33%。数值全部规则端计算
// （LLM 只负责把它写进背景故事），同 seed 同出身。骰面表经
// snapshot.origin_dice 下发，前端渲染骰子与概率，不硬编码。
var ORIGIN_DICE = [
  {
    face: 1,
    kind: "hp",
    label: "将门之后",
    desc: "体魄强健（体力上限 +5）",
    weight: 1,
  },
  {
    face: 2,
    kind: "atk",
    label: "猎户之子",
    desc: "锋芒初露（攻击 +2）",
    weight: 1,
  },
  {
    face: 3,
    kind: "gold",
    label: "商贾遗孤",
    desc: "行囊鼓胀（金币 +60）",
    weight: 1,
  },
  {
    face: 4,
    kind: "item",
    label: "拾荒的命",
    desc: "命运赠礼（一件开局装备）",
    weight: 1,
  },
  {
    face: 5,
    kind: "wound",
    label: "老兵旧伤",
    desc: "旧伤未愈（体力上限 -3）",
    weight: 1,
  },
  {
    face: 6,
    kind: "poor",
    label: "囊中羞涩",
    desc: "出门少带一瓶药水（药水 -1）",
    weight: 1,
  },
  { face: 7, kind: "none", label: "平凡出身", desc: "无事发生", weight: 2 },
  { face: 8, kind: "none", label: "平凡出身", desc: "无事发生", weight: 1 },
];

// id -> def, exported through snapshot() so brains and the page never hardcode
// item stats; this table stays the single source of truth.
var CATALOG: Record<string, ItemDef> = {};
TUNING.items.forEach(function (it) {
  CATALOG[it.id] = it;
});

// ---- deterministic PRNG (mulberry32) ---------------------------------------
// Each draw advances state.rng, which is part of the replicated state, so the
// whole match stays reproducible from (seed, command sequence).

function nextRand(s: State): number {
  s.rng = (s.rng + 0x6d2b79f5) >>> 0;
  var t = s.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
  t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function rint(s: State, lo: number, hi: number): number {
  return lo + Math.floor(nextRand(s) * (hi - lo + 1));
}
function pct(s: State, p: number): boolean {
  return nextRand(s) * 100 < p;
}
function weightedPick(s: State, table: Record<string, number>): string {
  var total = 0,
    k = "";
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

// ---- helpers ---------------------------------------------------------------

function addLog(
  s: State,
  kind: string,
  text: string,
  out?: LogLine[],
): LogLine {
  var e: LogLine = { tick: s.tick, kind: kind, text: text };
  s.log.push(e);
  if (s.log.length > LOG_CAP) {
    s.log = s.log.slice(s.log.length - LOG_CAP);
  }
  if (out) {
    out.push(e);
  }
  return e;
}

// v5 探索驱动：层里不再有强制清剿的怪队。新层是安静的：玩家自由下潜/探索，
// 敌人在探索时随机搅醒（exploreRoll 的遭遇分支），属于消磨回合的遭遇。
// 唯一的强制项是每层**最低击杀配额**（v5.1）：杀够 minFoes(depth) 才放行下潜，
// 堵住「无脑直冲深层白嫖深层数值」的漏洞；配额未完成且探索次数将尽时，
// 最后一次探索必定搅醒遭遇，保证配额永远可达（不软锁）。
// 守主巢穴（每 5 层）仍是面对面的墙：下潜进去就撞上守主。
function minFoes(depth: number): number {
  if (depth % TUNING.boss_every === 0) {
    return 0;
  } // 守主层由守主自己把门
  return Math.min(
    1 + Math.floor((depth - 1) / TUNING.boss_every),
    TUNING.min_foes_cap,
  );
}

function owned(s: State, id: string): boolean {
  var b = baseOf(id);
  return (
    s.inventory.some(function (e) {
      return baseOf(e) === b;
    }) ||
    baseOf(s.equip.weapon || "") === b ||
    baseOf(s.equip.armor || "") === b ||
    baseOf(s.equip.trinket || "") === b
  );
}

function armorSum(s: State): number {
  var n = 0;
  if (s.equip.armor) {
    n += gearArmor(s.equip.armor);
  }
  if (s.statuses.shield) {
    n += s.statuses.shield.armor || 0;
  }
  return n;
}

function effAtk(s: State): number {
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

function fleeChance(s: State): number {
  var p = TUNING.flee_pct;
  if (baseOf(s.equip.armor || "") === "lead_boots") {
    p += CATALOG.lead_boots.flee_pct || 0;
  }
  return p;
}

function lampBonus(s: State): number {
  return baseOf(s.equip.trinket || "") === "lantern"
    ? CATALOG.lantern.event_pct || 0
    : 0;
}

// v1/v2 matches surviving a hot swap get the new fields for free: gear entries
// gain a "@depth" stamp at the current depth, unidentified/identified/bag_cap
// initialize to sane defaults.
function migrate(s: State): void {
  if (!Array.isArray(s.inventory)) {
    s.inventory = [];
  }
  if (!s.equip) {
    s.equip = { weapon: null, armor: null, trinket: null };
  }
  var d = s.depth || 1;
  var stamp = function (e: string): string {
    return typeof e === "string" &&
      CATALOG[baseOf(e)] &&
      CATALOG[baseOf(e)].slot &&
      e.indexOf("@") < 0
      ? stampDepth(e, d)
      : e;
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

// Stable slot scan (p0, p1, ...) so command resolution never depends on JSON
// key order.
function pickCommand(
  commands: Record<
    string,
    {
      action?: string;
      choose?: string;
      equip?: string;
      narrate?: { tick: number; kind: string; text: string };
    }
  >,
  key: "action" | "choose" | "equip",
): string | null {
  for (var i = 0; i < 8; i++) {
    var c = commands["p" + i];
    if (c && typeof c[key] === "string") {
      return c[key] as string;
    }
  }
  return null;
}
function pickNarrate(
  commands: Record<string, { narrate?: import("./shared").Narrate }>,
): import("./shared").Narrate | null {
  for (var i = 0; i < 8; i++) {
    var c = commands["p" + i];
    if (
      c &&
      c.narrate &&
      typeof c.narrate.tick === "number" &&
      typeof c.narrate.kind === "string" &&
      c.narrate.text
    ) {
      return c.narrate;
    }
  }
  return null;
}

// 脑席扩展通道（v4）：narrator 的 lore/epitaph、oracle 的 whisper、dm 的
// 对抗指令。全部沿用「脑席发 commands、规则只做确定性合并」的模式——规则
// 永远拿不到 host.*，文案与决策都由带能力的脑席经模型产出。
//
// 同一个读取器也覆盖后端服务通道（v6）：网关的 match bridge 把后端投递的
// 指令放在保留席位 `__svc__` 上，规则从这里读。后端不冒充任何玩家座位——
// 复盘时一眼能分清「玩家做的」和「后台做的」。
function pickBrain<T>(
  commands: Record<string, Record<string, unknown>>,
  key: string,
): T | null {
  var svc = commands["__svc__"] as Record<string, unknown> | undefined;
  if (svc && svc[key]) {
    return svc[key] as T;
  }
  for (var i = 0; i < 8; i++) {
    var c = commands["p" + i] as Record<string, unknown> | undefined;
    if (c && c[key]) {
      return c[key] as T;
    }
  }
  return null;
}

// ---- GM 后台通道（v5 能力展示）---------------------------------------------
// 网关侧 Python 服务（services/pm.py）经 match bridge 直投 commands.gm（落在
// __svc__ 保留席位）到这里。合法性全部归规则：逐条白名单校验，非法即忽略。
function collectGmOps(
  commands: Record<string, Record<string, unknown>>,
): Array<Record<string, unknown>> {
  var gm = pickBrain<{ ops?: unknown }>(commands, "gm");
  if (!gm || !gm.ops || !(gm.ops as unknown[]).length) return [];
  var out: Array<Record<string, unknown>> = [];
  var raw = gm.ops as unknown[];
  for (var i = 0; i < raw.length && out.length < 8; i++) {
    if (raw[i] && typeof raw[i] === "object")
      out.push(raw[i] as Record<string, unknown>);
  }
  return out;
}

function applyGmOps(
  s: State,
  ops: Array<Record<string, unknown>>,
  events: LogLine[],
): boolean {
  var applied = false;
  for (var i = 0; i < ops.length; i++) {
    var o = ops[i];
    var op = typeof o.op === "string" ? o.op : "";
    var hero = s.hero;
    if (op === "grant_gold") {
      var amt = Math.max(
        -500,
        Math.min(500, Math.floor(Number(o.amount) || 0)),
      );
      if (!amt) continue;
      s.gold = Math.max(0, s.gold + amt);
      addLog(
        s,
        "gm",
        "[后台] 金币 " + (amt > 0 ? "+" : "") + amt + "（现 " + s.gold + "）。",
        events,
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
        events,
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
      markIdentified(s, id); // 后台发的装备不算谜团
      addLog(
        s,
        "gm",
        "[后台] 一件「" + def.name + "」凭空出现在你的背包里。",
        events,
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
          "[后台] 「" +
            (CATALOG[baseOf(hit)] ? CATALOG[baseOf(hit)].name : hit) +
            "」被后台收走了。",
          events,
        );
        applied = true;
      } else {
        // 可能穿在身上（doEquip 已把条目移出背包）：按 base 匹配装备槽
        var eqAll = s.equip as unknown as Record<string, string | null>;
        var eqSlots: Array<"weapon" | "armor" | "trinket"> = [
          "weapon",
          "armor",
          "trinket",
        ];
        for (var di = 0; di < eqSlots.length; di++) {
          var worn = eqAll[eqSlots[di]] || "";
          if (worn && baseOf(worn) === baseOf(want) && CATALOG[baseOf(want)]) {
            takeOff(s, worn);
            addLog(
              s,
              "gm",
              "[后台] 「" + CATALOG[baseOf(want)].name + "」从你身上被收走了。",
              events,
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

// ---- spawns ----------------------------------------------------------------

// 地牢之主「伏击」：下一只普通怪被预先唤醒（守主不受伏击加成，里程碑体面）。
function applyAmbush(s: State, f: import("./shared").Foe): void {
  if (!f.boss && s.flags && s.flags.dm_ambush) {
    s.flags.dm_ambush = false;
    f.hp = Math.floor(f.hp * 1.3);
    f.hp_max = f.hp;
    f.atk += 1;
    f.name = "伏击·" + f.name;
  }
}

function spawn(s: State): import("./shared").Foe {
  var M = TUNING.monster;
  var d = s.depth;
  if (d % TUNING.boss_every === 0) {
    // 守主：每个里程碑整体抬一档（m=1 → 150/16，m=2 → 240/20 …）
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
      boss: true,
    };
  }
  var name = TUNING.monster_names[rint(s, 0, TUNING.monster_names.length - 1)];
  var hp = M.hp + M.d_hp * (d - 1) + rint(s, 0, 3);
  var f: import("./shared").Foe = {
    name: name,
    hp: hp,
    hp_max: hp,
    atk: M.atk + M.d_atk * (d - 1),
    xp: M.xp + M.d_xp * (d - 1),
    gold: M.gold + M.d_gold * (d - 1),
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

// ---- items -----------------------------------------------------------------

// 背包容量按「种类数」计：同类装备/消耗品可累积（×N），再多也不占新格。
function invKinds(s: State): number {
  var seen: Record<string, boolean> = {};
  var n = 0;
  s.inventory.forEach(function (e) {
    var b = baseOf(e);
    if (!seen[b]) {
      seen[b] = true;
      n += 1;
    }
  });
  return n;
}

function giveItem(s: State, id: string, out: LogLine[]): void {
  var def = CATALOG[id];
  if (!def) {
    return;
  }
  if (id === "potion") {
    // 药水走独立计数，不占格子
    s.potions += 1;
    addLog(s, "item", "你拾取了一瓶药水。", out);
    return;
  }
  var hasBase = s.inventory.some(function (e) {
    return baseOf(e) === id;
  });
  if (invKinds(s) >= (s.bag_cap || TUNING.inv_cap) && !hasBase) {
    // 全新品种且背包已满：折金（同类累积不受限；扩容袋临时扩的格子也算数）
    var g = Math.max(5, Math.ceil(def.price / 2));
    s.gold += g;
    addLog(
      s,
      "item",
      "背包装不下了，「" + def.name + "」折成了 " + g + " 金。",
      out,
    );
    return;
  }
  if (def.slot) {
    // 装备类：属性按获取时的层数定格（新获得才随层变强）；掉落有概率未鉴定
    // （历局已鉴定过的种类不会再蒙尘）。
    s.inventory.push(stampDepth(id, s.depth));
    var everKnown = !!s.identified && s.identified.indexOf(id) >= 0;
    if (!everKnown && pct(s, TUNING.unid_pct)) {
      if (!s.unidentified) s.unidentified = [];
      if (s.unidentified.indexOf(id) < 0) s.unidentified.push(id);
      var slotName =
        def.slot === "weapon" ? "武器" : def.slot === "armor" ? "护甲" : "饰品";
      addLog(
        s,
        "item",
        "你获得了一件" +
          slotName +
          "——铭文晦涩如谜，属性不明（???）。古卷可解其谜。",
        out,
      );
    } else {
      markIdentified(s, id);
      addLog(s, "item", "你获得了「" + def.name + "」：" + def.desc, out);
    }
    return;
  }
  s.inventory.push(id); // 消耗品：裸 id，同类累积
  addLog(s, "item", "你获得了「" + def.name + "」：" + def.desc, out);
}

function sellablePool(s: State, kind: string): ItemDef[] {
  return TUNING.items.filter(function (it) {
    return it.kind === kind && it.price > 0 && !owned(s, it.id);
  });
}

function randomGiveOfKind(s: State, kind: string, out: LogLine[]): void {
  var pool = sellablePool(s, kind);
  if (pool.length === 0) {
    var g = rint(s, TUNING.gold_pack[0], TUNING.gold_pack[1]);
    s.gold += g;
    addLog(s, "item", "你翻出 " + g + " 金。", out);
    return;
  }
  giveItem(s, pool[rint(s, 0, pool.length - 1)].id, out);
}

function cursedItem(s: State): string {
  return ["cursed_ring", "lead_boots"][rint(s, 0, 1)];
}

// 卸下装备中的物品（若它正穿在对应槽位）：回滚 hp_max 类属性。
// 供换装/丢弃/变卖共用——丢弃穿在身上的装备也要先卸下。
// 参数是背包条目（可能是 "id@depth"），槽位比较一律按 base。
function takeOff(s: State, entry: string): void {
  var def = CATALOG[baseOf(entry)];
  if (!def || !def.slot) return;
  var eq = s.equip as unknown as Record<string, string | null>;
  if (baseOf(eq[def.slot] || "") !== baseOf(entry)) return;
  eq[def.slot] = null;
  var hp = gearHpMax(entry);
  if (hp) {
    s.hero.hp_max -= hp;
    s.hero.hp = Math.min(s.hero.hp, s.hero.hp_max);
  }
}

// 裸 id 容错：把 "id" 解析成背包中第一个 "id@depth" 实例条目（API 直发兼容）。
function resolveEntry(s: State, id: string): string {
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

function doEquip(s: State, entry: string, out: LogLine[]): boolean {
  entry = resolveEntry(s, entry);
  var base = baseOf(entry);
  var def = CATALOG[base];
  var ix = s.inventory.indexOf(entry);
  if (!def || !def.slot || ix < 0) {
    return false;
  }
  var slot = def.slot;
  var eq = s.equip as unknown as Record<string, string | null>;
  if (baseOf(eq[slot] || "") === base) {
    return true;
  } // already worn; not an error
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
  // 穿上即鉴定：上手一试便知斤两（相比古卷，这条路永远安全）。
  if (isUnid(s, entry)) {
    markIdentified(s, base);
    addLog(s, "equip", "你换上了" + def.name + "——上手一试，" + def.desc, out);
  } else {
    addLog(s, "equip", "你换上了" + def.name + "。", out);
  }
  return true;
}

// ---- events ----------------------------------------------------------------

function merchantPrice(s: State, def: ItemDef): number {
  return Math.ceil(
    def.price * (TUNING.merchant_scale[0] + TUNING.merchant_scale[1] * s.depth),
  );
}

// 变卖价：买入价的一半（向上保底 1 金），越深商人给得越多。
function sellPrice(s: State, def: ItemDef): number {
  return Math.max(1, Math.floor(merchantPrice(s, def) / 2));
}

function buildEvent(s: State, id: string): Pending {
  var dl = s.tick + TUNING.event_deadline;
  if (id === "merchant") {
    var p: Pending = {
      event_id: id,
      title: "一个裹着黑袍的流浪商人",
      options: [],
      deadline_tick: dl,
      left: TUNING.event_deadline,
      default: "leave",
      wares: [],
    };
    var pool = TUNING.items.filter(function (it) {
      return it.price > 0 && it.id !== "potion" && !owned(s, it.id);
    });
    for (var i = 0; i < 2 && pool.length > 0; i++) {
      p.wares!.push(pool.splice(rint(s, 0, pool.length - 1), 1)[0].id);
    }
    if (p.wares!.length === 0) {
      return buildEvent(s, "chest");
    } // 没货改开宝箱
    p.wares!.forEach(function (wid, ix) {
      var def = CATALOG[wid];
      p.options.unshift({
        id: "buy" + ix,
        label: "买·" + def.name,
        desc: def.desc,
        cost: merchantPrice(s, def),
      });
    });
    // 变卖：背包里每件有价物品都可以出手（装备已随 doEquip 移出背包，不存在
    // 「穿在身上的」歧义）；诅咒物也不例外——这是祭坛之外摆脱诅咒的第二条路。
    s.inventory.forEach(function (entry) {
      var base = baseOf(entry);
      var d = CATALOG[base];
      if (!d || d.price <= 0) return;
      var known = !isUnid(s, entry);
      var gain = sellPrice(s, d);
      p.options.push({
        id: "sell:" + entry,
        label: "卖·" + (known ? d.name : "???") + "（+" + gain + "金）",
        desc: known ? d.desc : "来历不明，商人倒是不挑。",
      });
    });
    p.options.push({ id: "leave", label: "离开", desc: "捂紧钱袋" });
    return p;
  }
  if (id === "altar") {
    var cursed =
      baseOf(s.equip.trinket || "") === "cursed_ring" ||
      baseOf(s.equip.armor || "") === "lead_boots";
    var pray = cursed
      ? "移除身上的诅咒物品"
      : "献祭 " + TUNING.pray_hp + " 体力，获得 5 回合力量";
    return {
      event_id: id,
      title: "一座刻满纹路的古老祭坛",
      deadline_tick: dl,
      left: TUNING.event_deadline,
      default: "leave",
      options: [
        { id: "pray", label: "祈祷", desc: pray },
        { id: "smash", label: "砸坛", desc: "搜走香火钱（8~20 金）" },
        { id: "leave", label: "离开", desc: "敬而远之" },
      ],
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
        { id: "leave", label: "离开", desc: "不值得冒险" },
      ],
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
          desc: "有灯 65% 宝物，否则可能遭遇埋伏",
        },
        { id: "stay", label: "原路", desc: "不作他想" },
      ],
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
        { id: "leave", label: "离开", desc: "各自安好" },
      ],
    };
  }
  // gambler
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
        cost: TUNING.bet_low.cost,
      },
      {
        id: "bet30",
        label: "押 30 金",
        desc: "45% 拿回 70 金",
        cost: TUNING.bet_high.cost,
      },
      { id: "leave", label: "走开", desc: "十赌九输" },
    ],
  };
}

function openEvent(s: State, out: LogLine[]): void {
  var id = EVENTS[rint(s, 0, EVENTS.length - 1)];
  var p = buildEvent(s, id);
  // 动态文案：池里有预生成的变体就弹出即用（title/desc 纯展示，机制照旧）
  var pool = s.event_variants && s.event_variants[id];
  if (pool && pool.length) {
    var v = pool.shift() as { title: string; desc: string };
    p.title = v.title;
    p.desc = v.desc;
  }
  s.pending = p;
  s.flags.events_this_layer = 1;
  addLog(s, "event", "你发现了" + p.title + "。", out);
}

// ---- idle 主动探索 ----------------------------------------------------------
// 驻留层（idle 态）的加权随机翻找：宝箱（可藏陷阱）、遭遇战、空洞（跳层
// 事件）、路过的事件房、一无所获。收益随深度涨，风险同步加深。
// 遭遇战与守主无关——守主驻守巢穴，是下潜撞上的；探索搅醒的是普通怪/精英。
function encounterSpawn(s: State): import("./shared").Foe {
  var M = TUNING.monster;
  var d = s.depth;
  var name = TUNING.monster_names[rint(s, 0, TUNING.monster_names.length - 1)];
  var hp = M.hp + M.d_hp * (d - 1) + rint(s, 0, 3);
  var f: import("./shared").Foe = {
    name: name,
    hp: hp,
    hp_max: hp,
    atk: M.atk + M.d_atk * (d - 1),
    xp: M.xp + M.d_xp * (d - 1),
    gold: M.gold + M.d_gold * (d - 1),
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

function exploreRoll(s: State, out: LogLine[]): void {
  var r = rint(s, 0, 99);
  // 配额保底：本层最低击杀配额未完成、且这已是最后一次探索——必定搅醒
  // 遭遇（否则 6 次全空手有小概率把玩家困在本层，配额永远凑不齐）。
  var quotaUnmet = (s.foes_left || 0) > 0;
  var lastExplore = (s.flags.explores_this_layer || 0) >= TUNING.explores_max;
  if (quotaUnmet && lastExplore) {
    r = 30; // 落在遭遇区间（24~63）
  }
  if (r < 24) {
    // 宝箱：15% 是伪装的陷阱箱，其余真宝箱给金，幸运符更慷慨。
    if (pct(s, 15)) {
      var trap = 4 + s.depth + rint(s, 0, 3);
      s.hero.hp = Math.max(0, s.hero.hp - trap);
      addLog(
        s,
        "explore",
        "箱子咬人！机关毒针扎掉你 " + trap + " 点体力。",
        out,
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
    // 遭遇战：探索驱动模式的主菜——沉睡的东西被你搅醒了。
    // 战斗在随后的行动轮正常进行。
    s.foe = encounterSpawn(s);
    addLog(
      s,
      "spawn",
      "你搅醒了" +
        s.foe.name +
        "（体力 " +
        s.foe.hp +
        "，攻击 " +
        s.foe.atk +
        "）" +
        (s.foe.intent ? "，意图：" + s.foe.intent + "。" : "。"),
      out,
    );
  } else if (r < 78) {
    // 空洞：跳下去直达更深处（随机 1~2 层 + 摔伤），或是绕开。
    var pitDmg = 6 + 2 * s.depth;
    s.pending = {
      event_id: "pit",
      title: "深不见底的黑洞",
      options: [
        {
          id: "jump",
          label: "跳下去",
          desc: "直达下方 1~2 层，摔伤（体力 -" + pitDmg + " 左右）",
        },
        { id: "skip", label: "绕开", desc: "继续驻留本层" },
      ],
      default: "skip",
      deadline_tick: s.tick + TUNING.event_deadline,
      left: TUNING.event_deadline,
    };
    addLog(s, "event", "地面塌陷出一个深不见底的黑洞，风声呜咽。", out);
  } else if (r < 88) {
    openEvent(s, out); // 撞见了路过的商人/赌徒/祭坛……
  } else {
    // kind "nothing"：空手而归（事实行确定性，旁白/文案库在 narrator 侧接手）
    addLog(s, "nothing", "你翻找了一阵，只有碎石和蛛网。", out);
  }
}

function applyChoice(s: State, optId: string, out: LogLine[]): void {
  var p = s.pending!;
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
            "你把" +
              (isUnid(s, sentry) ? "???（" + sdef.name + "）" : sdef.name) +
              "卖给了商人，进账 " +
              gain +
              " 金。",
            out,
          );
        } else {
          addLog(s, "sell", "那件东西已经不在背包里了。", out);
        }
        break;
      }
      if (optId.indexOf("buy") !== 0) {
        break;
      } // leave / default：什么都不做
      var ix = parseInt(optId.slice(3), 10);
      var wid = p.wares![ix];
      var def = CATALOG[wid];
      var price = merchantPrice(s, def);
      // 容量守卫：全新品种且背包已满时买不进（不扣钱）；同类累积不受限。
      var hasBase = s.inventory.some(function (e) {
        return baseOf(e) === wid;
      });
      if (invKinds(s) >= (s.bag_cap || TUNING.inv_cap) && !hasBase) {
        addLog(s, "buy", "背包已经塞满了，商人耸耸肩把货收了回去。", out);
        break;
      }
      s.gold -= price;
      // 买下的装备按当前层数定格属性；明码标价的货不算未鉴定。
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
          var eq = s.equip as unknown as Record<string, string | null>;
          var cid = eq[slot]!;
          eq[slot] = null;
          s.inventory.push(cid);
          addLog(
            s,
            "curse",
            "祭坛的火光一闪，" + CATALOG[baseOf(cid)].name + "上的诅咒消散了。",
            out,
          );
        } else {
          s.hero.hp = Math.max(1, s.hero.hp - TUNING.pray_hp);
          s.statuses.might = {
            turns: TUNING.might.turns,
            atk: TUNING.might.atk,
          };
          addLog(
            s,
            "event",
            "你献上血，力量涌进四肢（攻击 +" +
              TUNING.might.atk +
              "，" +
              TUNING.might.turns +
              " 回合）。",
            out,
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
          out,
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
            "暗道里窜出了" +
              s.foe.name +
              "（体力 " +
              s.foe.hp +
              "，攻击 " +
              s.foe.atk +
              "）！",
            out,
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
      } // leave：十赌九输，不走
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
        "你纵身跃入黑暗，跌落在第 " +
          s.depth +
          " 层——摔掉 " +
          pitHurt +
          " 点体力。",
        out,
      );
      break;
    }
  }
  void t;
  s.pending = null;
}

// ---- legal actions ---------------------------------------------------------

function legalActions(s: State): string[] {
  var out: string[] = [];
  if (s.pending) {
    // 决策期间不能下潜/迎击；消耗品仍可用（决策也是回合，药不能停）。
  } else if (s.foe) {
    out.push("attack", "guard", "flee");
  } else {
    // idle 态（本层驻留）：下潜或探索。下潜要求击杀配额已达成（杀够才放行，
    // 堵直冲深层的漏洞）；探索随时可开——配额未完成时上限不生效（保底可达）。
    if ((s.foes_left || 0) <= 0) {
      out.push("descend");
    }
    if (
      (s.flags.explores_this_layer || 0) < TUNING.explores_max ||
      (s.foes_left || 0) > 0
    ) {
      out.push("explore");
    }
  }
  if (s.potions > 0) {
    out.push("potion");
  }
  s.inventory.forEach(function (id) {
    var def = CATALOG[id];
    if (def && def.kind === "consumable") {
      out.push("use:" + id);
    }
  });
  return out;
}

// ---- level up / kills ------------------------------------------------------

function levelUp(s: State, out: LogLine[]): void {
  while (s.xp >= s.xp_next) {
    s.xp -= s.xp_next;
    s.level += 1;
    s.xp_next = TUNING.xp_base + (s.level - 1) * TUNING.xp_step;
    s.hero.hp_max += TUNING.level_hp;
    s.hero.atk += TUNING.level_atk;
    // 升级只补一部分血：血线压力留给药水与格挡，不能靠升级白嫖满血。
    s.hero.hp = Math.min(s.hero.hp_max, s.hero.hp + TUNING.level_heal);
    addLog(
      s,
      "levelup",
      "你升到 " +
        s.level +
        " 级，体力上限 " +
        s.hero.hp_max +
        "，攻击 " +
        s.hero.atk +
        "。",
      out,
    );
  }
}

function resolveKill(s: State, out: LogLine[]): void {
  var f = s.foe!;
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
    randomGiveOfKind(s, ["weapon", "armor", "trinket"][rint(s, 0, 2)], out); // 精英必掉一件
  } else {
    var w: Record<string, number> = Object.assign({}, TUNING.drop);
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
        out,
      );
    } else if (cat === "gold_pack") {
      var g = rint(s, TUNING.gold_pack[0], TUNING.gold_pack[1]);
      s.gold += g;
      addLog(
        s,
        "kill",
        "你击败了" +
          f.name +
          "，获得 " +
          f.xp +
          " 经验、" +
          (f.gold + g) +
          " 金（含一袋散金）。",
        out,
      );
    } else if (cat === "potion") {
      s.potions += 1;
      addLog(
        s,
        "kill",
        "你击败了" +
          f.name +
          "，获得 " +
          f.xp +
          " 经验、" +
          f.gold +
          " 金、一瓶药水。",
        out,
      );
    } else {
      var kind = cat === "potion_big" ? "consumable" : cat; // weapon/armor/trinket
      addLog(
        s,
        "kill",
        "你击败了" + f.name + "，获得 " + f.xp + " 经验、" + f.gold + " 金。",
        out,
      );
      randomGiveOfKind(s, kind, out);
      if (cat === "potion_big") {
        /* handled via catalog kind above */
      }
    }
  }
  var wasBoss = !!f.boss;
  s.foe = null;
  if (wasBoss) {
    // 守主倒下不是终点：领奖、记数、继续下潜——深渊没有尽头。
    s.boss_kills = (s.boss_kills || 0) + 1;
    addLog(
      s,
      "win",
      "第 " +
        s.depth +
        " 层守主倒下！战利品到手（累计击倒守主 " +
        s.boss_kills +
        "）。深渊仍在继续。",
      out,
    );
  }
  levelUp(s, out);
}

// ---- required exports ------------------------------------------------------

function newmatch(args: {
  seed?: number;
  props?: {
    legacy?: unknown;
    identified?: unknown;
    lore?: unknown;
    resume?: unknown;
  };
}) {
  var seedIn = args && args.seed ? args.seed : 0;
  var s: State = {
    seed: seedIn,
    rng: seedIn >>> 0 || 0x9e3779b9,
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
      stance: "attack",
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
    flags: { events_this_layer: 0, elites_slain: 0, explores_this_layer: 0 },
  };
  addLog(s, "enter", "你走进第 1 层地牢，火把在石壁上噼啪作响。");
  // v5.2 出身骰：按骰面权重掷出身——数值全部规则端计算（LLM 只负责把它写进
  // 背景故事），同 seed 同出身，确定性不破。骰面表经 snapshot.origin_dice 下发。
  var oTable: Record<string, number> = {};
  ORIGIN_DICE.forEach(function (f) {
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
  // 中断续玩：props.resume 是 UI 经 pm 服务保存的整份 state（SSE raw state）。
  // 白名单 hydrate：以新局为底逐字段校验拷贝，非法/缺字段回退新局默认值——
  // 与 legacy 同哲学（前端/后端存储不可信，规则端独立校验）。恢复时忽略
  // seed 参数（用存档里的 rng 续），legacy/identified/lore 也以存档为准。
  var resume = args && args.props && (args.props.resume as unknown);
  if (resume && typeof resume === "object" && !(resume as any).ending) {
    var r = resume as Record<string, unknown>;
    var num = (v: unknown, lo: number, hi: number, dflt: number): number => {
      var n = Math.floor(Number(v));
      return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
    };
    // 基础数值字段：全部夹紧到合法区间
    s.tick = num(r.tick, 0, 100000, 0);
    s.depth = num(r.depth, 1, 1000, 1);
    s.level = num(r.level, 1, 99, 1);
    s.xp = num(r.xp, 0, 1e9, 0);
    s.gold = num(r.gold, 0, 1e9, 0);
    s.potions = num(r.potions, 0, 99, 0);
    s.kills = num(r.kills, 0, 1e9, 0);
    s.boss_kills = num(r.boss_kills, 0, 1e9, 0);
    s.bag_cap = num(r.bag_cap, TUNING.inv_cap, 24, TUNING.inv_cap);
    s.foes_left = num(r.foes_left, 0, 9, minFoes(s.depth));
    if (typeof r.rng === "number" && isFinite(r.rng)) s.rng = r.rng >>> 0;
    var rs = r.seed as unknown;
    if (typeof rs === "number" && isFinite(rs)) s.seed = rs | 0;
    // 英雄：字段封顶校验
    var rh = r.hero as Record<string, unknown> | undefined;
    if (rh && typeof rh === "object") {
      s.hero.hp_max = num(rh.hp_max, 1, 9999, TUNING.hero_hp);
      s.hero.hp = num(rh.hp, 0, s.hero.hp_max, s.hero.hp_max);
      s.hero.atk = num(rh.atk, 1, 999, TUNING.hero_atk);
      var st = typeof rh.stance === "string" ? (rh.stance as string) : "attack";
      if (ACTIONS.indexOf(st) >= 0) s.hero.stance = st;
    }
    // 装备槽：entry 的 base 必须在 catalog 且 slot 匹配
    var re = r.equip as Record<string, unknown> | undefined;
    if (re && typeof re === "object") {
      var slots: Array<"weapon" | "armor" | "trinket"> = [
        "weapon",
        "armor",
        "trinket",
      ];
      for (var si = 0; si < slots.length; si++) {
        var ev = re[slots[si]];
        var eb = typeof ev === "string" ? baseOf(ev) : "";
        var ed = eb ? CATALOG[eb] : null;
        if (ed && ed.slot === slots[si]) s.equip[slots[si]] = ev as string;
      }
    }
    // 背包：base 校验 + 容量上限（同类累积压缩）
    if (Array.isArray(r.inventory)) {
      var inv: string[] = [];
      for (var ii = 0; ii < (r.inventory as unknown[]).length; ii++) {
        var iv = (r.inventory as unknown[])[ii];
        var ib = typeof iv === "string" ? baseOf(iv) : "";
        if (
          ib &&
          CATALOG[ib] &&
          inv.length < (s.bag_cap || TUNING.inv_cap) + 8
        ) {
          inv.push(iv as string);
        }
      }
      s.inventory = inv;
    }
    // 谜团/已鉴定名录/传说：沿用校验过的注入路径
    if (Array.isArray(r.unidentified)) {
      s.unidentified = (r.unidentified as unknown[]).filter(function (u) {
        return typeof u === "string" && !!CATALOG[u as string];
      }) as string[];
    }
    if (Array.isArray(r.identified)) {
      for (var fi = 0; fi < (r.identified as unknown[]).length; fi++) {
        var fv = (r.identified as unknown[])[fi];
        if (typeof fv === "string" && CATALOG[fv]) markIdentified(s, fv);
      }
    }
    if (r.item_lore && typeof r.item_lore === "object") {
      var lo2: Record<string, string> = {};
      var loN = 0;
      for (var lk in r.item_lore as Record<string, unknown>) {
        var lv = (r.item_lore as Record<string, unknown>)[lk];
        if (CATALOG[lk] && typeof lv === "string" && loN < 40) {
          lo2[lk] = (lv as string).slice(0, 80);
          loN++;
        }
      }
      s.item_lore = lo2;
    }
    // 随身未鉴定装备要保持「未解之谜」状态一致
    s.unidentified = (s.unidentified || []).filter(function (u) {
      return s.inventory.some(function (e) {
        return baseOf(e) === u;
      });
    });
    for (var wi = 0; wi < s.inventory.length; wi++) {
      if (!isUnid(s, s.inventory[wi]))
        markIdentified(s, baseOf(s.inventory[wi]));
    }
    // 状态效果：只收已知键，回合/伤害夹紧
    if (r.statuses && typeof r.statuses === "object") {
      var st2: Record<string, { turns: number; dmg?: number }> = {};
      for (var sk in r.statuses as Record<string, unknown>) {
        var sv = (r.statuses as Record<string, unknown>)[sk] as Record<
          string,
          unknown
        >;
        if (sv && typeof sv === "object" && sk.length < 24) {
          st2[sk] = {
            turns: num(sv.turns, 0, 99, 0),
            dmg: sv.dmg === undefined ? undefined : num(sv.dmg, 0, 99, 0),
          };
        }
      }
      s.statuses = st2;
    }
    // 敌人：字段封顶（不校验名字表——普通怪/精英/守主都可能）
    var rf = r.foe as Record<string, unknown> | undefined;
    if (rf && typeof rf === "object" && num(rf.hp, 0, 1e9, 0) > 0) {
      s.foe = {
        name: String(rf.name || "???").slice(0, 40),
        hp: num(rf.hp, 1, 1e9, 1),
        hp_max: num(rf.hp_max, 1, 1e9, 1),
        atk: num(rf.atk, 0, 999, 1),
        boss: !!rf.boss,
        elite: !!rf.elite,
        intent:
          typeof rf.intent === "string"
            ? (rf.intent as string).slice(0, 16)
            : undefined,
        statuses: {},
      } as State["foe"];
    }
    // 事件房：只在字段形状完整时恢复，否则丢弃（最坏情况拿默认选项）
    var rp = r.pending as Record<string, unknown> | undefined;
    if (
      rp &&
      typeof rp === "object" &&
      typeof rp.event_id === "string" &&
      Array.isArray(rp.options)
    ) {
      var hp0 = rp as unknown as State["pending"] & { left?: unknown };
      hp0.left =
        typeof hp0.left === "number" ? hp0.left : TUNING.event_deadline;
      s.pending = hp0;
    }
    // 事件动态文案池：id 白名单 + 截断（旧存档没有就算了，narrator 会补）
    if (r.event_variants && typeof r.event_variants === "object") {
      var evh: Record<string, { title: string; desc: string }[]> = {};
      var rv = r.event_variants as Record<string, unknown>;
      var evn = 0;
      for (var vk in rv) {
        if (!Array.isArray(rv[vk]) || evn >= 12) continue;
        var vl: { title: string; desc: string }[] = [];
        var va = rv[vk] as unknown[];
        for (var vi = 0; vi < va.length && vl.length < 2 && evn < 12; vi++) {
          var vo = va[vi] as Record<string, unknown> | null;
          if (!vo || typeof vo !== "object") continue;
          var vt = String(vo.title || "")
            .trim()
            .slice(0, 10);
          var vd = String(vo.desc || "")
            .trim()
            .slice(0, 40);
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
    // 日志截尾保留（环即真相，仅展示用）
    if (Array.isArray(r.log)) {
      s.log = (r.log as unknown[]).slice(-200) as State["log"];
    }
    // 行为状态字与 flags：只收已知键（恢复局的行为分支依赖它们）
    if (typeof r.status === "string" && r.status.length < 16) {
      s.status = r.status as State["status"];
    }
    if (r.flags && typeof r.flags === "object") {
      var rf2 = r.flags as Record<string, unknown>;
      var fk = ["events_this_layer", "explores_this_layer", "elites_slain"];
      for (var fi2 = 0; fi2 < fk.length; fi2++) {
        if (typeof rf2[fk[fi2]] === "number") {
          (s.flags as unknown as Record<string, unknown>)[fk[fi2]] =
            rf2[fk[fi2]];
        }
      }
      if (typeof rf2.dm_hex === "boolean") s.flags.dm_hex = rf2.dm_hex;
      if (typeof rf2.dm_ambush === "boolean") s.flags.dm_ambush = rf2.dm_ambush;
    }
    if (typeof r.xp_next === "number" && isFinite(r.xp_next as number)) {
      s.xp_next = Math.max(1, Math.min(1e9, Math.floor(r.xp_next as number)));
    }
    s.resumes = ((r.resumes as number) | 0) + 1;
    // 序章字段一并恢复（boon 数值已在存档里生效，这里只恢复展示态）
    var rb = r.prologue_boon as Record<string, unknown> | undefined;
    if (rb && typeof rb === "object" && typeof rb.kind === "string") {
      s.prologue_boon = {
        kind: rb.kind as string,
        label: String(rb.label || "").slice(0, 40),
      };
    }
    if (typeof r.prologue_text === "string") {
      s.prologue_text = (r.prologue_text as string).slice(0, 80);
    }
    addLog(s, "enter", "你从第 " + s.depth + " 层的存档中醒来，火把重新燃起。");
    s.actions = legalActions(s); // 恢复局立即可操作（新局是预计算好的）
    return { state: s };
  }
  // 守主遗产：props.legacy 是上一局死亡时结转的物品条目列表（可含 "id@depth"
  // 实例，UI 经建局 props 传入）。规则端独立校验：base 必须在 catalog、去重、
  // 上限 3——前端存储不可信。装备条目保留原 @depth（遗产的属性定格不重置）。
  var legacy = (args &&
    args.props &&
    (args.props.legacy as unknown)) as unknown[];
  if (legacy && legacy.length) {
    var names: string[] = [];
    for (var i = 0; i < legacy.length && s.inventory.length < 3; i++) {
      var lid = typeof legacy[i] === "string" ? (legacy[i] as string) : "";
      var lbase = lid ? baseOf(lid) : "";
      var ldef = lbase ? CATALOG[lbase] : null;
      if (!ldef || s.inventory.indexOf(lid) >= 0) continue;
      s.inventory.push(lid);
      markIdentified(s, lbase); // 随身带进来的东西，早已知根知底
      names.push(ldef.name);
    }
    if (names.length) {
      addLog(s, "legacy", "守主的遗产与你同行：" + names.join("、") + "。");
    }
  }
  // 已鉴定名录跨局携带：props.identified 是历局鉴定的 base id 列表（UI 存储）。
  var knownIds = (args &&
    args.props &&
    (args.props.identified as unknown)) as unknown[];
  if (knownIds && knownIds.length) {
    var known: string[] = s.identified || (s.identified = []);
    for (var ki = 0; ki < knownIds.length; ki++) {
      var kid =
        typeof knownIds[ki] === "string" ? (knownIds[ki] as string) : "";
      if (kid && CATALOG[kid] && known.indexOf(kid) < 0) {
        known.push(kid);
      }
    }
  }
  // 来历传说跨局携带：props.lore 是 base id -> 传说文本（narrator 历局撰写）。
  // 只收已知 catalog 条目，总量封顶防 64KB 记忆上限被长文本撑爆。
  var loreIn = (args && args.props && (args.props.lore as unknown)) as Record<
    string,
    unknown
  > | null;
  if (loreIn && typeof loreIn === "object") {
    var loreOut: Record<string, string> = {};
    var loreN = 0;
    for (var lb in loreIn) {
      var lv = loreIn[lb];
      if (loreN >= 40) break;
      if (
        Object.prototype.hasOwnProperty.call(loreIn, lb) &&
        CATALOG[lb] &&
        typeof lv === "string" &&
        lv
      ) {
        loreOut[lb] = (lv as string).slice(0, 80);
        loreN += 1;
      }
    }
    s.item_lore = loreOut;
  }
  s.actions = legalActions(s);
  return { state: s };
}

function heroStatusTick(s: State, out: LogLine[]): void {
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
      out,
    );
  }
  var regen =
    baseOf(s.equip.trinket || "") === "ring_regen"
      ? CATALOG.ring_regen.regen || 0
      : 0;
  var drain =
    baseOf(s.equip.trinket || "") === "cursed_ring"
      ? CATALOG.cursed_ring.drain || 0
      : 0;
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

function foeStatusTick(s: State, out: LogLine[]): void {
  var f = s.foe;
  if (!f || !f.statuses) {
    return;
  }
  for (var k in f.statuses) {
    var st: StatusInst = f.statuses[k];
    f.hp = Math.max(0, f.hp - (st.dmg || 0));
    addLog(
      s,
      "hit",
      f.name +
        (k === "burn" ? "身上还燃着火" : "的伤口泛着紫黑") +
        "（-" +
        st.dmg +
        "）。",
      out,
    );
    st.turns -= 1;
    if (st.turns <= 0) {
      delete f.statuses[k];
    }
  }
}

function tick(args: {
  state: State;
  commands?: Record<
    string,
    {
      action?: string;
      choose?: string;
      equip?: string;
      narrate?: { tick: number; kind: string; text: string };
    }
  >;
}) {
  var s = JSON.parse(JSON.stringify(args.state)) as State;
  var commands = args.commands || {};
  var events: LogLine[] = [];
  // Defensive: a broken initial state must not throw (it would kill the loop).
  if (!s.hero || !s.hero.hp_max) {
    return { state: s, events: events };
  }
  migrate(s);

  // 行为驱动：人类玩家没下任何指令时世界完全静止——不推进、不掉血、
  // 不倒计时（引擎对带外部席位的对局会挂起等指令，指令一到立刻结算一轮）。
  // 例外：事件房决策期（pending）。决策期没有敌人，世界自己走表——
  // 倒计时实时流逝，超时自动执行默认选项（对磨蹭的玩家也是安全网）。
  // 全脑局（headless/演示）里脑席每 tick 都会下指令，因此永远不受影响。
  var gmOps = collectGmOps(commands);
  var hasAction = !!pickCommand(commands, "action");
  var hasEquip = !!pickCommand(commands, "equip");
  var hasChoose = !!pickCommand(commands, "choose");
  if (
    !s.pending &&
    !s.ending &&
    !hasAction &&
    !hasEquip &&
    !hasChoose &&
    gmOps.length === 0
  ) {
    return { state: s, events: events, wait: true };
  }

  // 轮数只记「真实行动轮」（行动/换装/GM 操作）。事件抉择与决策期的倒计时
  // 空转轮不占轮数——玩家在事件房思考多久都不该烧轮（v5.6）。
  if (s.ending || hasAction || hasEquip || gmOps.length) {
    s.tick = (s.tick || 0) + 1;
  }

  // 1. Commands. Postures are sticky; equip is a free action; choose resolves
  //    event rooms in step 3.
  var action = hasAction ? pickCommand(commands, "action") : null;
  var illegal: string | null = null;
  if (action) {
    var isUse = action.indexOf("use:") === 0;
    var isDrop = action.indexOf("drop:") === 0;
    var known =
      ACTIONS.indexOf(action) >= 0 ||
      (isUse &&
        s.inventory.indexOf(action.slice(4)) >= 0 &&
        CATALOG[action.slice(4)] &&
        CATALOG[action.slice(4)].kind === "consumable") ||
      (isDrop && s.inventory.indexOf(resolveEntry(s, action.slice(5))) >= 0);
    if (known) {
      if (isDrop) {
        // 丢弃：一次性动作，占一个回合但不改姿态；穿在身上的先卸下。
        var did = resolveEntry(s, action.slice(5));
        var ddef = CATALOG[baseOf(did)];
        takeOff(s, did);
        s.inventory.splice(s.inventory.indexOf(did), 1);
        addLog(
          s,
          "order",
          "你丢下了" + (ddef ? ddef.name : "一件物品") + "。",
          events,
        );
      } else if (s.hero.stance !== action) {
        s.hero.stance = action;
        if (isUse) {
          var ud = CATALOG[action.slice(4)];
          addLog(
            s,
            "order",
            "你掏出了" + (ud ? ud.name : "道具") + "。",
            events,
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
        events,
      );
    }
  }
  var equipId = pickCommand(commands, "equip");
  if (equipId && !doEquip(s, equipId, events)) {
    addLog(s, "illegal", "装不上「" + equipId + "」。", events);
  }

  // 2. Narrator seat: merge flavor text onto the matching fact line
  //    (matched by tick *and* kind so multi-line ticks still line up).
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
    // 旁白来自文案库时，规则端顺带弹出已用的那句（库随 SSE 热更到前端）
    if (nar.pop && s.flavor_bank && s.flavor_bank[nar.pop]) {
      s.flavor_bank[nar.pop].shift();
      if (!s.flavor_bank[nar.pop].length) delete s.flavor_bank[nar.pop];
    }
  }

  // 2b-0. 文案库补货（narrator 一次性批量回传：{kind: [句子...]}）：
  //       kind 白名单校验、每句截断、全库总句数封顶 60——LLM 输出不可信，
  //       规则只收干净的。批量协议避免开局逐场景请求把前几轮卡成灾难。
  var bk = pickBrain<Record<string, unknown>>(commands, "bank");
  if (bk && !Array.isArray(bk) && typeof bk === "object") {
    if (!s.flavor_bank) s.flavor_bank = {};
    var total = 0;
    for (var fb in s.flavor_bank) total += s.flavor_bank[fb].length;
    for (var bkind in bk) {
      if (bkind.length > 16 || !Array.isArray(bk[bkind])) continue;
      var add: string[] = [];
      var arr2 = bk[bkind] as unknown[];
      for (
        var bi = 0;
        bi < arr2.length && add.length < 4 && total + add.length < 60;
        bi++
      ) {
        var bl = String(arr2[bi] || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 20);
        if (bl) add.push(bl);
      }
      if (add.length) {
        var cur = s.flavor_bank[bkind] || [];
        s.flavor_bank[bkind] = cur.concat(add).slice(0, 8);
        total += add.length;
      }
    }
  }

  // 2b-0b. 事件房动态文案池（narrator 异步预生成回传）：id 白名单、title/desc
  //        截断、每 id 池上限 2、全池上限 12——LLM 输出不可信，规则只收干净的。
  var ev = pickBrain<Record<string, unknown>>(commands, "event_variants");
  if (ev && !Array.isArray(ev) && typeof ev === "object") {
    if (!s.event_variants) s.event_variants = {};
    var evTotal = 0;
    for (var evk in s.event_variants) evTotal += s.event_variants[evk].length;
    for (var evid in ev) {
      if (EVENT_IDS.indexOf(evid) < 0 || !Array.isArray(ev[evid])) continue;
      var curPool = s.event_variants[evid] || [];
      var arr3 = ev[evid] as unknown[];
      for (
        var ei = 0;
        ei < arr3.length && curPool.length < 2 && evTotal < 12;
        ei++
      ) {
        var evo = arr3[ei] as Record<string, unknown> | null;
        if (!evo || typeof evo !== "object") continue;
        var et = String(evo.title || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 10);
        var ed = String(evo.desc || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 40);
        if (et && ed) {
          curPool.push({ title: et, desc: ed });
          evTotal++;
        }
      }
      if (curPool.length) s.event_variants[evid] = curPool;
    }
  }

  // 2a. Oracle 低语（Jev 顾问）：sig 去重，同一段建议只念一次。
  var wh = pickBrain<import("./shared").Whisper>(commands, "whisper");
  if (wh && wh.sig && wh.text && s.whisper_sig !== wh.sig) {
    addLog(s, "whisper", "暗处的低语：" + String(wh.text).slice(0, 40), events);
    s.whisper_sig = wh.sig;
  }

  // 2b. Narrator 的来历传说：落到 s.item_lore（每种装备只写一次）。
  var lo = pickBrain<import("./shared").Lore>(commands, "lore");
  if (lo && lo.base && CATALOG[lo.base] && lo.text) {
    if (!s.item_lore) {
      s.item_lore = {};
    }
    if (!s.item_lore[lo.base]) {
      s.item_lore[lo.base] = String(lo.text).slice(0, 80);
    }
  }

  // 2b-1. narrator 序章：开局背景故事（首轮回传一次）。LLM 文案放 flavor
  //      （--verify 已排除 flavor），事实行确定性。
  var pr = pickBrain<{ text?: string }>(commands, "prologue");
  if (pr && pr.text && !s.prologue_text) {
    s.prologue_text = String(pr.text).slice(0, 80);
    var pl = addLog(s, "prologue", "【序章】你的故事开始了。", events);
    pl.flavor = s.prologue_text;
  }

  // 2c. Narrator 的墓志铭：只收一次（终局宽限期内回传）。
  var ep = pickBrain<{ text?: string }>(commands, "epitaph");
  if (ep && ep.text && !s.epitaph) {
    s.epitaph = String(ep.text).slice(0, 60);
  }

  // 2d. 地牢之主（Jev 对抗席）：规则侧冷却 + 浅层豁免 + 终局免战。
  //     效果全部是确定性数值操作：落石直伤 / 下次攻击落空 / 下只怪被伏击。
  var dm = pickBrain<import("./shared").DmMove>(commands, "dm");
  if (
    dm &&
    !s.ending &&
    s.depth >= TUNING.dm_min_depth &&
    s.tick - (s.dm_tick || -99) >= TUNING.dm_cooldown
  ) {
    var dmLog: string | null = null;
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

  // 2e. GM 后台操作：pm 服务经 match bridge 投递的 state 操纵。终局免战；
  //     GM 轮不结算战斗（无 p0 action，下方结算守卫只认显式行动）。
  if (gmOps.length && !s.ending) {
    applyGmOps(s, gmOps, events);
  }

  // 2f. 终局宽限：死亡 tick 已标记 ending，这里跳过一切结算，只吸收脑席
  //     回传的墓志铭（2c），随后由 over() 落终。至多两 tick，绝不久留。
  if (s.ending) {
    s.actions = legalActions(s);
    return { state: s, events: events };
  }

  // 3. Event-room resolution: an explicit choice wins; silence past the
  //    deadline takes the default. This deadline is also what makes a slow or
  //    dead Jev harmless — the worst case is the default option.
  if (s.pending) {
    var p = s.pending;
    // 倒计时独立于轮数（轮数在决策期不再前进）：每过一拍 -1，归零走默认。
    if (typeof (p as unknown as Record<string, unknown>).left !== "number") {
      (p as unknown as Record<string, unknown>).left = TUNING.event_deadline;
    }
    var chooseId = pickCommand(commands, "choose");
    var valid = false;
    if (chooseId) {
      for (var oi = 0; oi < p.options.length; oi++) {
        if (p.options[oi].id === chooseId) {
          valid =
            typeof p.options[oi].cost !== "number" ||
            s.gold >= (p.options[oi].cost as number);
          break;
        }
      }
    }
    if (chooseId && !valid) {
      addLog(s, "illegal", "这个选择现在行不通，事件仍悬而未决。", events);
    } else if (chooseId) {
      applyChoice(s, chooseId, events);
    } else if ((p as unknown as { left: number }).left <= 0) {
      addLog(s, "event", "你犹豫太久，命运替你做了选择。", events);
      applyChoice(s, p.default, events);
    } else {
      (p as unknown as { left: number }).left -= 1;
    }
  }

  // 4. Hero statuses: fixed per-tick numbers (no rng), then decrement.
  //    只随真实行动轮消耗——决策期思考/倒计时不烧状态回合。
  if (hasAction || hasEquip || gmOps.length) {
    heroStatusTick(s, events);
  }

  // 5. Event room: fires on a freshly cleared layer, once per layer, before
  //    the hero could descend. 85% of clear layers host a decision.
  //    玩家明确要下潜或探索（action === "descend"/"explore"）时不开启：
  //    尊重明确的行动意图，事件房等玩家先做点别的（喝药/换装/丢垃圾）再露面。
  //    否则会出现同一 tick 内「你决定下潜/探索 → 商人开张 → 行动非法」的自相矛盾日志。
  if (
    !s.foe &&
    !s.pending &&
    s.status === "explore" &&
    s.flags.events_this_layer === 0 &&
    s.tick > 0 && // 开局首层不立即触发
    !pickCommand(commands, "choose") && // 同轮刚做完抉择不再开新事件房
    pickCommand(commands, "action") !== "descend" &&
    pickCommand(commands, "action") !== "explore" &&
    pct(s, TUNING.event_pct)
  ) {
    openEvent(s, events);
  }

  // 7+8. Combat settlement. 战斗（攻击/格挡/逃跑/下潜/喝药等姿态结算与怪物
  //    反击）只在玩家明确提交了 action 指令的回合发生——equip / choose /
  //    事件超时轮不算行动，绝不触发残留姿态的攻击（换装备不该白挥一刀，
  //    离开商人也不该挨一刀）。
  if (action) {
    var stance = s.hero.stance;
    var tookAction = false;
    var freshFoe = false; // 本轮探索刚搅醒的敌人（抢先出手判定用）
    if (stance === "attack") {
      if (s.foe) {
        if (s.flags.dm_hex) {
          // 地牢之主「诅咒」：下一次攻击必然落空（回合照常流逝）。
          s.flags.dm_hex = false;
          addLog(
            s,
            "curse",
            "地牢之主的咒文缠上你的手腕——这一击落空了。",
            events,
          );
          tookAction = true;
        } else {
          var dmg = Math.max(1, effAtk(s) + rint(s, 0, 2) - (s.foe.armor || 0));
          s.foe.hp = Math.max(0, s.foe.hp - dmg);
          addLog(
            s,
            "hit",
            "你击中" + s.foe.name + "，造成 " + dmg + " 点伤害。",
            events,
          );
          var w = s.equip.weapon ? CATALOG[baseOf(s.equip.weapon)] : null;
          if (w && w.on_hit && s.foe.hp > 0 && pct(s, w.on_hit.pct)) {
            if (!s.foe.statuses) {
              s.foe.statuses = {};
            }
            s.foe.statuses[w.on_hit.status] = {
              turns: TUNING.foe_status.turns,
              dmg: TUNING.foe_status.dmg,
            };
            addLog(
              s,
              "hit",
              s.foe.name +
                (w.on_hit.status === "burn" ? "被点燃了！" : "中毒了！"),
              events,
            );
          }
          tookAction = true;
        }
      }
      // No foe: a swing at nothing, quietly ignored.
    } else if (stance === "guard") {
      if (s.foe) {
        // 格挡（v5.6）：不再固定回血——有几率触发顺势反击，敌人随机吃反伤。
        if (pct(s, TUNING.guard_counter_pct)) {
          var cdmg = Math.max(
            1,
            Math.floor(effAtk(s) / 2) + rint(s, 0, 1) - (s.foe.armor || 0),
          );
          s.foe.hp = Math.max(0, s.foe.hp - cdmg);
          addLog(
            s,
            "guard",
            "你举盾格挡——顺势一记反击，" +
              s.foe.name +
              "吃了 " +
              cdmg +
              " 点伤害。",
            events,
          );
        } else {
          addLog(s, "guard", "你举盾格挡，稳住阵脚。", events);
        }
        tookAction = true;
      }
      // 无怪可挡时格挡没有收益。
    } else if (stance === "potion") {
      if (s.potions > 0) {
        s.potions -= 1;
        // 药效随敌人类型浮动（v5.6）：强敌当前肾上腺素拉满——守主战 150%、
        // 精英战 120%，平时不变。否则守主线根本站不住，战斗失去意义。
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
          "你喝下药水，回复 " +
            ph +
            " 点体力。" +
            (s.foe && (s.foe.boss || s.foe.elite)
              ? "强敌当前，药力奔涌。"
              : ""),
          events,
        );
        s.hero.stance = "attack"; // one-shot
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
          // 药效随敌人类型浮动（v5.6）：守主战 150%、精英战 120%——否则
          // 强敌战线上药水杯水车薪，boss 战失去意义。
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
            "你喝下" +
              udef.name +
              "，回复 " +
              uh +
              " 点体力。" +
              (s.foe && (s.foe.boss || s.foe.elite)
                ? "强敌当前，药力奔涌。"
                : ""),
            events,
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
              events,
            );
          } else {
            illegal = uid; // 没有目标，不舍弹
          }
        } else if (udef.use === "shield") {
          s.inventory.splice(s.inventory.indexOf(uid), 1);
          s.statuses.shield = {
            turns: TUNING.shield.turns,
            armor: TUNING.shield.armor,
          };
          addLog(
            s,
            "event",
            "圣光裹住你（受伤 -" +
              TUNING.shield.armor +
              "，" +
              TUNING.shield.turns +
              " 回合）。",
            events,
          );
        } else if (udef.use === "antidote") {
          if (s.statuses.poison) {
            s.inventory.splice(s.inventory.indexOf(uid), 1);
            delete s.statuses.poison;
            addLog(s, "event", "苦涩的药汁压下了毒素。", events);
          } else {
            illegal = uid; // 没中毒不舍得用
          }
        } else if (udef.use === "might") {
          s.inventory.splice(s.inventory.indexOf(uid), 1);
          s.statuses.might = {
            turns: TUNING.might.turns,
            atk: TUNING.might.atk,
          };
          addLog(
            s,
            "event",
            "秘药入喉，肌肉贲张（攻击 +" + TUNING.might.atk + "）。",
            events,
          );
        } else if (udef.use === "identify") {
          // 鉴定古卷：背包里有未鉴定装备才舍得用。80% 全部鉴定成功；
          // 20% 古卷失灵——碎片划过之处，随机一件未鉴定装备直接损坏。
          var unids = (s.unidentified || []).filter(function (b) {
            return s.inventory.some(function (e) {
              return baseOf(e) === b;
            });
          });
          if (unids.length === 0) {
            illegal = uid; // 没有谜团可解，卷轴留在包里
          } else {
            s.inventory.splice(s.inventory.indexOf(uid), 1);
            if (pct(s, TUNING.scroll_break_pct)) {
              var victims = s.inventory.filter(function (e) {
                return unids.indexOf(baseOf(e)) >= 0;
              });
              var victimEntry = victims[rint(s, 0, victims.length - 1)];
              var vBase = baseOf(victimEntry);
              s.inventory.splice(s.inventory.indexOf(victimEntry), 1);
              var vui = s.unidentified!.indexOf(vBase);
              if (vui >= 0) s.unidentified!.splice(vui, 1);
              addLog(
                s,
                "curse",
                "古卷哗啦碎裂——铭文终究未显，裂页还把「" +
                  CATALOG[vBase].name +
                  "」划坏了（损毁）。",
                events,
              );
            } else {
              var names2: string[] = [];
              unids.forEach(function (b) {
                markIdentified(s, b);
                names2.push(CATALOG[b].name);
              });
              // ids 载荷给 narrator 席：为解谜的装备写来历传说（LLM）。
              var idEv = addLog(
                s,
                "event",
                "古卷铭文流转，谜团解开：" + names2.join("、") + "。",
                events,
              );
              idEv.ids = unids.slice();
            }
          }
        } else if (udef.use === "bag") {
          // 扩容袋：本次探索（本局）背包格子 +2；同类累积不占新格的规则不变。
          s.inventory.splice(s.inventory.indexOf(uid), 1);
          s.bag_cap = (s.bag_cap || TUNING.inv_cap) + 2;
          addLog(
            s,
            "event",
            "暗袋撑开，针脚如活物般游走——这一趟探险，背包能多装 2 种物件了（当前容量 " +
              s.bag_cap +
              "）。",
            events,
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
            events,
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
          events,
        );
        // 守主巢穴（每 5 层）：下潜进去就面对面——必须翻越的墙。
        if (s.depth % TUNING.boss_every === 0) {
          s.foe = spawn(s);
          addLog(
            s,
            "spawn",
            "黑暗中一双眼睛睁开——" +
              s.foe.name +
              "镇守此层（体力 " +
              s.foe.hp +
              "，攻击 " +
              s.foe.atk +
              "）！不掀翻它就别想继续往下。",
            events,
          );
        }
        s.hero.stance = "attack"; // one-shot; ignore the stale order
      } else {
        illegal = "descend";
        s.hero.stance = "attack";
      }
      tookAction = true;
    } else if (stance === "explore") {
      // 主动探索（idle 态专属）：摸宝箱、搅醒遭遇、空洞、商队……每层上限
      // explores_max 次，防翻箱刷资源；击杀配额未完成时上限不生效（配额保底：
      // 达到上限后的每次探索在 exploreRoll 里必定搅醒遭遇）。敌人不再排队
      // 等你——它们就是在这里随机冒出来的。
      if (s.foe || s.pending) {
        illegal = "explore";
        s.hero.stance = "attack";
      } else if (
        (s.flags.explores_this_layer || 0) >= TUNING.explores_max &&
        (s.foes_left || 0) <= 0
      ) {
        addLog(
          s,
          "explore",
          "这一层已被你翻了个底朝天，再摸也摸不出什么了。",
          events,
        );
        s.hero.stance = "attack";
        tookAction = true;
      } else {
        var foeBefore = !!s.foe; // 探索是否搅醒了新敌人（决定它能否抢先出手）
        s.flags.explores_this_layer = (s.flags.explores_this_layer || 0) + 1;
        exploreRoll(s, events);
        s.hero.stance = "attack"; // one-shot
        tookAction = true;
        freshFoe = !foeBefore && !!s.foe;
      }
    }

    // An impossible order falls back to attacking and is never silent.
    // 文案分语境：没有敌人时「你改为攻击」是谎话（无处挥拳，玩家会困惑），
    // 抉择未定时下潜被拦是商人/守卫挡路，也不是「改为攻击」。
    if (illegal) {
      var il = CATALOG[illegal]
        ? CATALOG[illegal].name
        : ACT_LABEL[illegal] || illegal;
      if (s.pending) {
        addLog(s, "illegal", "抉择未定，「" + il + "」先放一放。", events);
      } else if (illegal === "descend" && (s.foes_left || 0) > 0) {
        addLog(
          s,
          "illegal",
          "石阶被封着——黑暗里有东西守着它。探索把它们惊出来。",
          events,
        );
      } else if (!s.foe) {
        addLog(s, "illegal", "现在不能用" + il + "。", events);
      } else {
        addLog(s, "illegal", "现在不能用" + il + "，你改为攻击。", events);
      }
    }

    // 7b. Weapon statuses + deaths from statuses, before the counterattack.
    foeStatusTick(s, events);
    if (s.foe && s.foe.hp <= 0) {
      resolveKill(s, events);
    }

    // 8. Monster counter-attack (only when it survived the hero's action).
    //    探索刚搅醒的敌人：低概率抢先出手（TUNING.ambush_pct），否则你抢到
    //    先机——它本回合不动，下一轮才照常反击。
    if (s.foe && s.foe.hp > 0) {
      if (freshFoe && !pct(s, TUNING.ambush_pct)) {
        addLog(s, "spawn", "它还没反应过来——你抢到了先机。", events);
      } else {
        if (s.foe.intent === "狂暴") {
          s.foe.atk += 1;
        } // 越打越凶
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
          events,
        );
        if (s.foe.intent === "剧毒" && pct(s, 30) && !s.statuses.poison) {
          s.statuses.poison = {
            turns: TUNING.foe_status.turns,
            dmg: TUNING.hero_status_dmg.poison,
          };
          addLog(s, "hurt", "它的爪子带着毒——你中毒了。", events);
        }
      }
    }
  } // end if (action) — equip/choose/超时轮不结算战斗

  // 9. Kill / progress (status kills resolved above).

  // 10. Death closes the run — but not immediately: mark the ending phase so
  //     over() grants a grace tick for the narrator seat to see the death line
  //     and return an epitaph (LLM-written). Bounded, never hangs.
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
      events,
    );
  }

  s.actions = legalActions(s);
  return { state: s, events: events };
}

function snapshot(args: { state: State }) {
  // v2: full information + the static item catalog (brains/页面不硬编码道具表).
  // v5.2: origin_dice 骰面表一并下发（前端渲染出身骰与概率，单一事实源）。
  var s = JSON.parse(JSON.stringify(args.state)) as State & {
    catalog?: Record<string, ItemDef>;
    origin_dice?: Array<{
      face: number;
      kind: string;
      label: string;
      desc: string;
      weight: number;
    }>;
  };
  s.catalog = CATALOG;
  s.origin_dice = ORIGIN_DICE;
  return s;
}

function over(args: { state: State }) {
  var s = args.state;
  if (s.hero && s.hero.hp <= 0) {
    // 终局宽限：第一 tick 只标记（narrator 要在下一个 tick 才能读到死讯并
    // 回传墓志铭）。墓志铭一到、或宽限两 tick 耗尽，才真正落终。
    if (s.ending && (s.epitaph || s.tick - (s.ending_tick || 0) >= 2)) {
      return {
        over: true,
        result: {
          winner: "monsters",
          reason: "hero_died",
          depth: s.depth,
          boss_kills: s.boss_kills || 0,
          epitaph: s.epitaph || "",
        },
      };
    }
    return { over: null };
  }
  return { over: null };
} // 时间上限（max_ticks）耗尽由引擎统一收尾，成绩同样有效

// quickjs-go locates entries on the global object; the IIFE wrapper keeps
// top-level declarations closure-local, so export them explicitly.
(globalThis as Record<string, unknown>).newmatch = newmatch;
(globalThis as Record<string, unknown>).tick = tick;
(globalThis as Record<string, unknown>).snapshot = snapshot;
(globalThis as Record<string, unknown>).over = over;
