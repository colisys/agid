// 装备条目（"id@depth"）展示助手：与 rules 的实例属性公式保持一致
// （主属性每 gear_every=3 层 +1，获取时定格；消耗品是裸 id）。
export function baseOf(entry: string): string {
  const i = entry.indexOf("@");
  return i < 0 ? entry : entry.slice(0, i);
}

export function gearDepth(entry: string): number {
  const i = entry.indexOf("@");
  return i < 0 ? 1 : parseInt(entry.slice(i + 1), 10) || 1;
}

// 实例属性 = 基础值 + floor((深度-1)/3)；v 无基础值时返回 0。
export function gearStat(v: number | undefined, entry: string): number {
  if (!v) return 0;
  return v + Math.floor((gearDepth(entry) - 1) / 3);
}
