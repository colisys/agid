// Shared type contracts for the dungeon pack (rules + brains).
// Types only: esbuild erases them at build time, so every entry still ships as
// one self-contained IIFE with zero runtime imports — QuickJS eats a single
// file and the only I/O channel stays `host.*` (brains) or nothing (rules).

// ---- items ----------------------------------------------------------------

export interface ItemDef {
  id: string;
  name: string;
  kind: "consumable" | "weapon" | "armor" | "trinket" | "cursed";
  slot?: "weapon" | "armor" | "trinket"; // equippables only (cursed included)
  price: number; // merchant base price; 0 = never sold
  desc: string;
  atk?: number; // weapon / cursed_ring
  armor?: number; // armor pieces / lead_boots
  hp_max?: number; // amulet: applied on equip/unequip
  heal?: number; // consumable heal
  use?: "heal" | "bomb" | "shield" | "antidote" | "might" | "identify" | "bag";
  on_hit?: { status: "burn" | "poison"; pct: number };
  regen?: number; // per-tick heal (ring_regen)
  drain?: number; // per-tick self damage (cursed_ring)
  flee_pct?: number; // lead_boots: flee chance modifier
  event_pct?: number; // lantern: safer events / dark paths
  lucky?: boolean; // charm: kinder drop table
}

// ---- runtime state --------------------------------------------------------

export interface StatusInst {
  turns: number;
  dmg?: number;
  atk?: number;
  armor?: number;
}

export interface Opt {
  id: string;
  label: string;
  desc: string;
  cost?: number;
}

export interface Pending {
  event_id: string;
  title: string;
  desc?: string; // LLM 动态补的场景描述（纯展示，规则永不解析）
  options: Opt[];
  deadline_tick: number; // 开启时的 s.tick + event_deadline（展示/脑席 memo 键用；判定已改用 left）
  left: number; // 决策倒计时（拍），归零自动执行 default——不占轮数
  default: string;
  wares?: string[]; // merchant: item id per buy<ix> option
}

export interface Foe {
  name: string;
  hp: number;
  hp_max: number;
  atk: number;
  xp: number;
  gold: number;
  boss?: boolean;
  elite?: boolean;
  intent?: string; // 狂暴 / 铁壁 / 剧毒
  armor?: number; // 铁壁 passive
  statuses?: Record<string, StatusInst>; // burn/poison inflicted by weapons
}

export interface Hero {
  hp: number;
  hp_max: number;
  atk: number;
  stance: string;
}

export interface LogLine {
  tick: number;
  kind: string;
  text: string;
  flavor?: string;
  ids?: string[]; // 机器可读载荷：鉴定行带上被解谜的 base id（narrator 写传说用）
}

export interface Narrate {
  tick: number;
  kind: string;
  text: string;
  pop?: string; // 文案来自 flavor_bank：规则端顺带弹出该场景的一句
}

// oracle 席（Jev 顾问）的低语：sig 用于规则侧去重，text 是给玩家看的建议。
export interface Whisper {
  sig: string;
  text: string;
}

// narrator 席为鉴定出的装备写的来历传说。
export interface Lore {
  base: string;
  text: string;
}

// dm 席（Jev 地牢之主）的对抗指令。
export interface DmMove {
  move: "ambush" | "hex" | "tremor";
}

export interface Equip {
  weapon: string | null;
  armor: string | null;
  trinket: string | null;
}

export interface Flags {
  events_this_layer: number;
  elites_slain: number;
  explores_this_layer: number; // 本层已主动探索次数（上限 explores_max）
  dm_ambush?: boolean; // 地牢之主「伏击」：下一只普通怪加强
  dm_hex?: boolean; // 地牢之主「诅咒」：下一次攻击落空
}

export interface State {
  seed: number;
  rng: number;
  tick: number;
  depth: number;
  foes_left: number; // 本层最低击杀配额余量（杀够才放行下潜，防直冲深层）
  level: number;
  xp: number;
  xp_next: number;
  gold: number;
  potions: number;
  kills: number;
  status: string; // explore | dead
  boss_kills: number; // 击倒的守主数（排行榜用，跨层累计）
  hero: Hero;
  foe: Foe | null;
  actions: string[]; // legal postures, incl "use:<id>"
  log: LogLine[];
  // v2
  inventory: string[]; // 装备类带获取深度后缀 "id@depth"（属性定格），消耗品为裸 id；同类可累积
  equip: Equip; // 三槽同样带 "@depth"
  statuses: Record<string, StatusInst>; // hero-side: poison/burn/shield/might
  pending: Pending | null;
  flags: Flags;
  // v3 秘密资料：装备类掉落可能「未鉴定」（??? ），古卷鉴定有损坏风险
  unidentified?: string[]; // 背包中未鉴定的 base id 列表
  identified?: string[]; // 本局已鉴定的 base id 列表（UI 经 props 跨局携带）
  bag_cap?: number; // 背包容量（按种类数）；扩容袋本局有效
  item_lore?: Record<string, string>; // 已鉴定装备的来历传说（narrator 撰写，props 跨局携带）
  whisper_sig?: string; // 已低语过的情境签名（oracle 去重）
  epitaph?: string; // 旁白席撰写的墓志铭（终局宽限期内回传，随 result 呈现）
  // 终局宽限：死亡当 tick 不立刻落终，给旁白席一回合看到死讯回传墓志铭
  ending?: string; // "death" 终局阶段标记
  ending_tick?: number; // 进入终局的 tick
  dm_tick?: number; // 地牢之主上次得手的 tick（规则侧冷却）
  resumes?: number; // 本局从存档恢复的次数（榜单「续命×N」展示用）
  gm_used?: number; // 后台 GM 操作在本局的生效次数
  prologue_boon?: { kind: string; label: string }; // 开局恩赐（出身骰掷面，规则端计算，LLM 写故事）
  prologue_text?: string; // narrator 席生成的背景故事（随首轮回传，一次）
  dice_face?: number; // 出身骰掷中的面（1~8，UI 高亮对应骰面）
  flavor_bank?: Record<string, string[]>; // 旁白文案库（narrator 批量预生成，随 SSE 热更）
  event_variants?: Record<string, EventVariant[]>; // 事件房动态文案池（narrator 异步预生成，开房时弹出即用）
}

// 事件房 LLM 变体：只换 title/desc 表现层，机制选项与数值永远归规则。
export interface EventVariant {
  title: string;
  desc: string;
}

// GM 操作（能力展示：网关侧 Python 后端经 gm 脑席操纵活动对局 state）。
// 合法性全部归规则——pm.py 只排队转发，rules.tick 逐条校验执行。
export interface GmOps {
  ops?: Array<{
    op: string; // grant_gold | set_hp | heal_full | set_atk | add_item | del_item
    amount?: number;
    value?: number;
    id?: string; // add_item 的道具 id（catalog base）
    entry?: string; // del_item 的背包条目（"id@depth"）
  }>;
}

// Snapshot = full state plus the static item catalog (so brains and the page
// never hardcode item stats; the rules table stays the single source).
export interface Snapshot extends State {
  catalog: Record<string, ItemDef>;
}

// ---- brain contract -------------------------------------------------------

export interface Commands {
  action?: string; // posture ("attack"...) or one-shot "use:<id>"
  choose?: string; // event option id (valid while pending)
  equip?: string; // item id to equip (free action)
  narrate?: Narrate; // narrator seat only
  bank?: Record<string, string[]>; // narrator: 批量补文案库 {kind: [句子...]}
  lore?: Lore; // narrator seat: item lore for identified gear
  epitaph?: { text: string }; // narrator seat: death epitaph
  whisper?: Whisper; // oracle seat (Jev advisor)
  dm?: DmMove; // dm seat (Jev dungeon master)
  gm?: GmOps; // gm seat: ops queued by the pm backend (capability demo)
  prologue?: { text: string }; // narrator seat: opening backstory (once, first tick)
  event_variants?: Record<string, EventVariant[]>; // narrator seat: 事件房动态文案（异步预生成回传）
}

export interface DecideArgs {
  snapshot: Snapshot;
  memory: Record<string, unknown>;
}

export interface DecideResult {
  commands: Commands;
  memory: Record<string, unknown>;
}

// ---- host bridge ----------------------------------------------------------
// host 的类型在 quickjs.d.ts（QuickJSBrainHost / QuickJSRulesHost）。
// 各入口文件按席位自行声明：脑席 declare const host: QuickJSBrainHost;
// 规则席不声明——规则脚本里出现 host.* 就是编译错误（规则只算数）。
