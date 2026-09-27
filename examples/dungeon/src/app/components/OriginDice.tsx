// 出身骰卡：开局掷出的出身 + 完整骰面与概率表。骰面表来自 rules.snapshot
// 的 origin_dice（单一事实源，前端不硬编码）；骰子用内联 SVG 绘制，
// 不引入任何新静态资产。
import { defineComponent } from "vue";
import { useGameStore } from "../stores/game";

interface DieFace {
  face: number;
  kind: string;
  label: string;
  desc: string;
  weight: number;
}

export default defineComponent({
  name: "OriginDice",
  data() {
    return { game: useGameStore() };
  },
  computed: {
    faces(): DieFace[] {
      // SSE raw state 不带 origin_dice；REST 开局快照有。回退静态兜底表。
      const snap = this.game.snapshot as
        | (Record<string, unknown> & { origin_dice?: DieFace[] })
        | null;
      if (snap && snap.origin_dice && snap.origin_dice.length) return snap.origin_dice;
      return [];
    },
    total(): number {
      return this.faces.reduce((a, f) => a + f.weight, 0);
    },
    rolled(): number {
      return this.game.snapshot?.dice_face || 0;
    },
    rolledFace(): DieFace | null {
      return this.faces.find((f) => f.face === this.rolled) || null;
    },
    tone(): string {
      const k = this.rolledFace?.kind || "";
      if (k === "wound" || k === "poor") return "bad";
      if (k === "none") return "mid";
      return "good";
    },
  },
  render() {
    const faces = this.faces;
    if (!faces.length || !this.rolled) return null; // 恢复局/无数据时不渲染
    const r = this.rolled;
    return (
      <section class="panel dice-panel">
        <header class="p-head">
          <h3>出身骰</h3>
          <span class="hint">开局掷出 · 概率在骰面上</span>
        </header>
        <div class="dice-body">
          <svg class={["die", this.tone]} viewBox="0 0 64 64" width="56" height="56">
            <rect x="4" y="4" width="56" height="56" rx="10" />
            <text x="32" y="43" text-anchor="middle" class="die-num">
              {r}
            </text>
          </svg>
          <div class="dice-hit">
            <b>{this.rolledFace?.label}</b>
            <span class="hint">{this.rolledFace?.desc}</span>
          </div>
        </div>
        <div class="dice-table">
          {faces.map((f) => (
            <div
              key={f.face}
              class={["df-row", { hit: f.face === r }]}
              title={f.desc}
            >
              <span class="df-face">{f.face}</span>
              <span class="df-label">{f.label}</span>
              <span class="df-odd">{Math.round((f.weight * 100) / this.total)}%</span>
            </div>
          ))}
        </div>
      </section>
    );
  },
});
