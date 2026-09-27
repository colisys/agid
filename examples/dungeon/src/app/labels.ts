// 展示用文案表：动作/状态/槽位的中文标签。
// 道具名与属性不在此硬编码——一律查快照 catalog（规则表是唯一事实源）。
export const ACTION_LABEL: Record<string, string> = {
  attack: "攻击",
  guard: "格挡",
  potion: "喝药",
  flee: "逃跑",
  descend: "下潜",
  explore: "探索",
};

export const STATUS_LABEL: Record<string, string> = {
  poison: "中毒",
  burn: "灼烧",
  shield: "圣盾",
  might: "巨力",
};

export const SLOT_LABEL: Record<string, string> = {
  weapon: "武器",
  armor: "护甲",
  trinket: "饰品",
};

export const SLOT_ORDER = ["weapon", "armor", "trinket"] as const;
