// Deterministic fallback policy shared by adventurer (always) and sage (when
// Jev is muted or failed). Pure functions over the snapshot: no rng, no host,
// no state mutation — the same input always yields the same commands, which is
// what keeps headless `--verify` runs reproducible.
import type { ItemDef, Snapshot } from "./shared";

export var RISKY_OPTS = ["tunnel", "loot", "bet10", "bet30"]; // 自伤/赌注类：残血时剔除

export function has(list: string[], x: string): boolean {
  return list.indexOf(x) >= 0;
}

export function hpRatio(snap: Snapshot): number {
  var h = snap.hero;
  return h && h.hp_max ? h.hp / h.hp_max : 1;
}

var GUARD_RUN_CAP = 3; // 格挡连用上限，不能无限龟
var TRINKET_PRIO = ["lantern", "charm", "ring_regen", "amulet", "cursed_ring"];

// 装备条目（"id@depth"）辅助：与 rules 的实例属性公式保持一致
// （主属性每 gear_every=3 层深度 +1，获取时定格）。
function baseOf(entry: string): string {
  var i = entry.indexOf("@");
  return i < 0 ? entry : entry.slice(0, i);
}
function gearDepth(entry: string): number {
  var i = entry.indexOf("@");
  return i < 0 ? 1 : parseInt(entry.slice(i + 1), 10) || 1;
}
function gearScaled(v: number | undefined, entry: string): number {
  if (!v) return 0;
  return v + Math.floor((gearDepth(entry) - 1) / 3);
}
// 未鉴定条目对脑（和界面）隐藏真实属性。
function isUnid(snap: Snapshot, entry: string): boolean {
  var u = snap.unidentified || [];
  return u.indexOf(baseOf(entry)) >= 0;
}

// 事件房启发式：稳字当头，从不赌。
export function pickPendingOption(snap: Snapshot): string {
  var p = snap.pending;
  if (!p) {
    return "";
  }
  var gold = snap.gold || 0;
  var cat = snap.catalog || {};
  if (p.event_id === "merchant") {
    var best = "",
      bestScore = -1;
    for (var i = 0; i < p.options.length; i++) {
      var o = p.options[i];
      if (typeof o.cost !== "number" || o.cost > gold) {
        continue;
      }
      var it = p.wares ? cat[p.wares[parseInt(o.id.slice(3), 10)]] : null;
      if (!it) {
        continue;
      }
      var score =
        (it.atk || 0) * 2 +
        (it.armor || 0) * 2 +
        (it.heal || 0) / 8 +
        (it.hp_max || 0);
      if (score > bestScore) {
        bestScore = score;
        best = o.id;
      }
    }
    return best || "leave";
  }
  if (p.event_id === "altar") {
    var cursed =
      !!snap.equip &&
      (baseOf(snap.equip.trinket || "") === "cursed_ring" ||
        baseOf(snap.equip.armor || "") === "lead_boots");
    if (cursed) {
      return "pray";
    } // 先去诅咒，白赚
    return hpRatio(snap) > 0.6 ? "pray" : "leave";
  }
  if (p.event_id === "chest") {
    return hpRatio(snap) > 0.5 ? "open" : "leave";
  }
  if (p.event_id === "fork") {
    return !!(snap.equip && baseOf(snap.equip.trinket || "") === "lantern")
      ? "tunnel"
      : "path";
  }
  if (p.event_id === "adventurer") {
    return (snap.potions || 0) > 1 ? "give" : "leave";
  }
  if (p.event_id === "gambler") {
    return "leave";
  } // 十赌九输
  return p.default;
}

// 战斗姿态回退：v1 adventurer 的优先级 + v2 道具位。
export function pickFallbackAction(
  snap: Snapshot,
  mem: Record<string, unknown>,
): string {
  var actions = snap.actions || [];
  var ratio = hpRatio(snap);
  var streak =
    typeof mem.guard_streak === "number" ? (mem.guard_streak as number) : 0;

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
  // v5 探索驱动：idle 层先翻一翻（遭遇给经验/掉落，宝箱给油水），翻够几处
  // 或次数用尽再下潜；下一层是守主巢穴时尽量带着饱满状态进去。
  // v5.1 击杀配额：foes_left > 0 时石阶不放行，继续探索直到配额达成
  //（配额未完成时探索无上限，且后期每次探索必遭遇——一定凑得齐）。
  if (has(actions, "explore")) {
    var explored = (snap.flags && snap.flags.explores_this_layer) || 0;
    var quota = (snap as unknown as { foes_left?: number }).foes_left || 0;
    var nextIsBoss = ((snap.depth || 0) + 1) % 5 === 0;
    if (quota > 0 || explored < 4 || (nextIsBoss && ratio < 0.85)) {
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

function hasNonCursedArmor(
  inv: string[],
  cat: Record<string, { slot?: string; kind?: string }>,
): boolean {
  for (var i = 0; i < inv.length; i++) {
    var it = cat[baseOf(inv[i])];
    if (it && it.slot === "armor" && it.kind !== "cursed") {
      return true;
    }
  }
  return false;
}

// 自动换装（免费动作，每 tick 最多换一件，确定性）：
// 武器取攻击最高；护甲取减伤最高但铅靴只在别无选择时穿；饰品按固定优先级。
// 背包条目是 "id@depth" 实例：比较按实例属性（base + 深度加成），返回完整条目；
// 未鉴定条目属性不明，一律不参与比较。
export function bestEquipDiff(snap: Snapshot): string | null {
  var cat = snap.catalog || ({} as Record<string, ItemDef>);
  var inv = snap.inventory || [];
  var eq = snap.equip || { weapon: null, armor: null, trinket: null };
  var i: number, entry: string, it: ItemDef | undefined;

  var best: string | null = null;
  var bestScore =
    eq.weapon && !isUnid(snap, eq.weapon) ? gearScaled(cat[baseOf(eq.weapon)]?.atk, eq.weapon) : -1;
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
  bestScore =
    eq.armor && !isUnid(snap, eq.armor) ? gearScaled(cat[baseOf(eq.armor)]?.armor, eq.armor) : -1;
  var alt = hasNonCursedArmor(
    inv,
    cat as Record<string, { slot?: string; kind?: string }>,
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
