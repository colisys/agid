// 敌人卡：名字/阶级标（★守主 ▲精英）/意图/体力条/所中状态。无怪时显示层况。
import { defineComponent } from "vue";
import { STATUS_LABEL } from "../labels";
import { useGameStore } from "../stores/game";

export default defineComponent({
  name: "FoePanel",
  data() {
    return { game: useGameStore() };
  },
  computed: {
    s() {
      return this.game.snapshot;
    },
    foe() {
      return this.game.snapshot?.foe ?? null;
    },
    hpPct(): number {
      const f = this.foe;
      return f && f.hp_max > 0 ? Math.max(0, Math.min(100, (f.hp * 100) / f.hp_max)) : 0;
    },
    mark(): string {
      const f = this.foe;
      if (!f) return "";
      return f.boss ? "★" : f.elite ? "▲" : "";
    },
    layerCleared(): boolean {
      const s = this.s;
      return !!s && !s.foe && !s.pending;
    },
    foeStatuses(): Array<{ key: string; turns: number }> {
      const out: Array<{ key: string; turns: number }> = [];
      const st = this.foe?.statuses || {};
      for (const k of Object.keys(st)) out.push({ key: k, turns: st[k]?.turns || 0 });
      return out;
    },
  },
  methods: {
    statusLabel(key: string): string {
      return STATUS_LABEL[key] || key;
    },
  },
  render() {
    const foe = this.foe;
    const s = this.s;
    return (
      <section class={["panel", "foe-panel", { boss: !!(foe && foe.boss) }]}>
        <header class="p-head">
          <h3>眼前之敌</h3>
        </header>

        {foe ? (
          <div class="foe-body">
            <div class="foe-name">
              <span class="mark">{this.mark}</span>
              {foe.name}
              <span class="atk">攻 {foe.atk}</span>
              {foe.intent ? <span class="tag intent">意图·{foe.intent}</span> : null}
            </div>
            <div class="statrow">
              <span class="bar foe-hp">
                <i style={{ width: this.hpPct + "%" }}></i>
              </span>
              <span class="num">
                {foe.hp}/{foe.hp_max}
              </span>
            </div>
            {this.foeStatuses.length ? (
              <div class="chips">
                {this.foeStatuses.map((st) => (
                  <span key={st.key} class="chip">
                    {this.statusLabel(st.key)} {st.turns}轮
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        ) : s ? (
          <div class="foe-empty">
            {(s.foes_left || 0) > 0
              ? (() => {
                  // 文案库 quota 场景（LLM 预生成，随 SSE 热更）：按 tick 轮换，
                  // 没入库时静态文案兜底。不剧透具体数量。
                  const lines = s.flavor_bank?.quota || [];
                  if (lines.length)
                    return lines[(s.tick || 0) % lines.length];
                  return "石阶被封着——黑暗里有东西守着它。没人知道它们蛰伏了多久，一动，便会惊醒。";
                })()
              : "这一层暂时安静。可下潜，或再探索探索——黑暗里东西不少。"}
          </div>
        ) : null}
      </section>
    );
  },
});
