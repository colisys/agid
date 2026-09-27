// 英雄面板：体力/经验/姿态/状态徽章 + 装备三槽 + 背包（同类累积 ×N）。
// 背包条目是 "id@depth" 实例：属性按获取层数定格；未鉴定条目显示 ???，
// 名字/属性一律查 catalog；换装是免费动作（equip 指令，不耗回合）。
// TSX 版：TSX 编译期就能查类型，导入的常量直接用，不用再经 data/methods 转手。
import { defineComponent } from "vue";
import type { ItemDef, State } from "../../shared";
import { baseOf, gearStat } from "../entry";
import { ACTION_LABEL, SLOT_LABEL, SLOT_ORDER, STATUS_LABEL } from "../labels";
import { useGameStore } from "../stores/game";
import { useSettingsStore } from "../stores/settings";

interface InvGroup {
  entry: string;
  base: string;
  it: ItemDef;
  count: number;
  unid: boolean;
  equipped: boolean;
  stat: string;
}

export default defineComponent({
  name: "HeroPanel",
  data() {
    return { game: useGameStore(), settings: useSettingsStore(), slots: [...SLOT_ORDER] };
  },
  computed: {
    s(): State | null {
      return this.game.snapshot;
    },
    hero() {
      return this.game.snapshot?.hero ?? null;
    },
    hpPct(): number {
      const h = this.hero;
      return h && h.hp_max > 0 ? Math.max(0, Math.min(100, (h.hp * 100) / h.hp_max)) : 0;
    },
    hpClass(): string {
      return this.hpPct <= 30 ? "crit" : this.hpPct <= 60 ? "hurt" : "ok";
    },
    xpPct(): number {
      const s = this.s;
      return s && s.xp_next > 0 ? Math.min(100, (s.xp * 100) / s.xp_next) : 0;
    },
    bagCap(): number {
      return this.s?.bag_cap || 6;
    },
    statuses(): Array<{ key: string; turns: number | undefined; dmg: number | undefined }> {
      const out: Array<{ key: string; turns: number | undefined; dmg: number | undefined }> = [];
      const st = this.s?.statuses || {};
      for (const k of Object.keys(st)) out.push({ key: k, turns: st[k]?.turns, dmg: st[k]?.dmg });
      return out;
    },
    // 背包按条目分组：完全相同的 entry（同类+同深度实例）累积 ×N；
    // 未鉴定条目名字与属性都隐藏（???）。
    invGroups(): InvGroup[] {
      const s = this.s;
      if (!s) return [];
      const unid = s.unidentified || [];
      const map = new Map<string, InvGroup>();
      for (const entry of s.inventory || []) {
        const base = baseOf(entry);
        const it = this.game.catalog[base];
        if (!it) continue;
        const isUnid = unid.indexOf(base) >= 0;
        const equipped = !!it.slot && baseOf(s.equip[it.slot] || "") === base;
        const g =
          map.get(entry) ||
          ({
            entry,
            base,
            it,
            count: 0,
            unid: isUnid,
            equipped,
            stat: this.statLineOf(it, entry, isUnid),
          } as InvGroup);
        g.count += 1;
        map.set(entry, g);
      }
      return Array.from(map.values());
    },
  },
  methods: {
    slotLabel(slot: string): string {
      return SLOT_LABEL[slot] || slot;
    },
    statusLabel(key: string): string {
      return STATUS_LABEL[key] || key;
    },
    stanceLabel(): string {
      const st = this.hero?.stance;
      if (!st) return "—";
      return st.startsWith("use:") ? "使用道具" : ACTION_LABEL[st] || st;
    },
    // 装备槽里的条目（可能是 "id@depth"）；未鉴定显示 ???
    slotEntry(slot: string): string | null {
      return (this.s?.equip[slot as "weapon"] as string) || null;
    },
    slotName(slot: string): string {
      const e = this.slotEntry(slot);
      if (!e) return "—";
      const it = this.game.catalog[baseOf(e)];
      if (!it) return e;
      return this.isUnidEntry(e) ? "？？？" : it.name;
    },
    slotStat(slot: string): string {
      const e = this.slotEntry(slot);
      if (!e) return "";
      const it = this.game.catalog[baseOf(e)];
      if (!it) return "";
      return this.statLineOf(it, e, this.isUnidEntry(e));
    },
    slotDesc(slot: string): string {
      const e = this.slotEntry(slot);
      const it = e ? this.game.catalog[baseOf(e)] : null;
      return it ? it.desc : "";
    },
    isUnidEntry(entry: string): boolean {
      return (this.s?.unidentified || []).indexOf(baseOf(entry)) >= 0;
    },
    // 来历传说：narrator 席（LLM）为已鉴定装备写的短文，跨局携带
    loreOf(base: string): string {
      const lo = this.s?.item_lore;
      return (lo && lo[base]) || "";
    },
    // 实例属性串：主属性按 @depth 定格；未鉴定一律「属性不明」。
    statLineOf(it: ItemDef, entry: string, unid: boolean): string {
      if (unid) return "属性不明";
      const parts: string[] = [];
      const atk = gearStat(it.atk, entry);
      const armor = gearStat(it.armor, entry);
      const hpMax = gearStat(it.hp_max, entry);
      if (atk) parts.push("攻+" + atk);
      if (armor) parts.push("甲+" + armor);
      if (hpMax) parts.push("血上限+" + hpMax);
      if (it.heal) parts.push("回复" + it.heal);
      return parts.join(" · ") || it.desc;
    },
    groupAt(n: number): InvGroup | null {
      return this.invGroups[n - 1] || null;
    },
    equip(entry: string) {
      this.game.send({ equip: entry });
    },
    // 丢弃走 action 指令（drop:<entry>）：占一个回合，合法性归服务端裁决
    drop(entry: string) {
      this.game.send({ action: "drop:" + entry });
    },
  },
  render() {
    const hero = this.hero;
    const s = this.s;
    return (
      <section class="panel hero-panel">
        <header class="p-head">
          <h3>冒险者</h3>
          <span class="who">{this.settings.name}</span>
        </header>

        {hero ? (
          <div class="hero-body">
            <div class="statrow">
              <span class="k">体力</span>
              <span class="bar hp">
                <i class={this.hpClass} style={{ width: this.hpPct + "%" }}></i>
              </span>
              <span class="num">
                {hero.hp}/{hero.hp_max}
              </span>
            </div>
            <div class="statrow">
              <span class="k">经验</span>
              <span class="bar xp">
                <i style={{ width: this.xpPct + "%" }}></i>
              </span>
              <span class="num">
                Lv{s!.level} · {s!.xp}/{s!.xp_next}
              </span>
            </div>
            <div class="statrow">
              <span class="k">攻击</span>
              <span class="num strong">{hero.atk}</span>
              <span class="k gap">姿态</span>
              <span class="num">{this.stanceLabel()}</span>
            </div>

            {this.statuses.length ? (
              <div class="chips">
                {this.statuses.map((st) => (
                  <span
                    key={st.key}
                    class={["chip", { good: st.key === "shield" || st.key === "might" }]}
                  >
                    {this.statusLabel(st.key)}
                    {st.turns != null ? <> {st.turns}轮</> : null}
                    {st.dmg ? <> -{st.dmg}/轮</> : null}
                  </span>
                ))}
              </div>
            ) : null}

            <div class="equips">
              {this.slots.map((slot) => (
                <div key={slot} class="eq-slot">
                  <span class="eq-k">{this.slotLabel(slot)}</span>
                  {this.slotEntry(slot) ? (
                    <span
                      class={["eq-v", { mystery: this.isUnidEntry(this.slotEntry(slot)!) }]}
                      title={this.slotDesc(slot)}
                    >
                      {this.slotName(slot)} <em>{this.slotStat(slot)}</em>
                    </span>
                  ) : (
                    <span class="eq-v empty">—</span>
                  )}
                </div>
              ))}
            </div>

            <div class="bag">
              <div class="bag-head">
                背包 {this.invGroups.length}/{this.bagCap} · 金币 {s!.gold}
              </div>
              <div class="bag-grid">
                {Array.from({ length: this.bagCap }, (_, i) => i + 1).map((n) => {
                  const g = this.groupAt(n);
                  return (
                    <div key={n} class={["cell", { filled: !!g }]}>
                      {g ? (
                        <>
                          <span
                            class={["it-name", { mystery: g.unid }]}
                            title={
                              g.unid
                                ? "属性不明——穿上它或用鉴定古卷揭晓"
                                : g.it.desc
                            }
                          >
                            {g.unid ? "？？？" : g.it.name}
                            {g.count > 1 ? <span class="mult">×{g.count}</span> : null}
                          </span>
                          <span class="it-stat">{g.stat}</span>
                          {this.loreOf(g.base) ? (
                            <span class="it-lore" title={this.loreOf(g.base)}>
                              ✦ {this.loreOf(g.base)}
                            </span>
                          ) : null}
                          <span class="it-acts">
                            {g.it.slot && !g.equipped && !this.game.over ? (
                              <button disabled={this.game.sending} onClick={() => this.equip(g.entry)}>
                                装备
                              </button>
                            ) : g.equipped ? (
                              <span class="on-cur">已装备</span>
                            ) : null}
                            {!this.game.over ? (
                              <button
                                title="丢弃（耗一回合）"
                                disabled={this.game.sending}
                                onClick={() => this.drop(g.entry)}
                              >
                                丢
                              </button>
                            ) : null}
                          </span>
                        </>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        ) : null}
      </section>
    );
  },
});
