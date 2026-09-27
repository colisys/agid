// 游戏日志流：最新在最上（倒序），新一条高亮，旁白「」短句斜体琥珀色。
import { defineComponent } from "vue";
import { useGameStore } from "../stores/game";

export default defineComponent({
  name: "LogPanel",
  data() {
    return { game: useGameStore() };
  },
  computed: {
    // 倒序展示：最新轮数在最上方，无需滚动就能看到刚发生的事。
    log() {
      return (this.game.snapshot?.log || []).slice().reverse();
    },
    tick(): number {
      return this.game.snapshot?.tick || 0;
    },
  },
  methods: {
    isFresh(e: { tick: number }): boolean {
      return e.tick === this.tick;
    },
  },
  render() {
    const log = this.log;
    return (
      <section class="panel log-panel">
        <header class="p-head">
          <h3>探险志</h3>
        </header>
        <div class="log-body">
          {log.map((e, i) => (
            <div key={log.length - 1 - i} class={["line", e.kind, { fresh: this.isFresh(e) }]}>
              {e.flavor ? <span class="flavor">「{e.flavor}」</span> : null}
              <span class="t">第{e.tick}轮</span> {e.text}
            </div>
          ))}
          {log.length === 0 ? <div class="line dim">火把还未点亮。</div> : null}
        </div>
      </section>
    );
  },
});
