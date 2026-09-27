// 动作按钮组 + 事件房决策面板。按钮完全由服务端下发的 legal actions 生成：
// 合法性归规则，前端不猜；use:<id> 经 catalog 查名，前端不硬编码道具表。
import { defineComponent } from "vue";
import type { ItemDef } from "../../shared";
import { ACTION_LABEL } from "../labels";
import { useGameStore } from "../stores/game";

export default defineComponent({
  name: "ActionsPanel",
  data() {
    return { game: useGameStore() };
  },
  computed: {
    s() {
      return this.game.snapshot;
    },
    canAct(): boolean {
      return !this.game.over && !this.game.dead && !this.game.sending && !!this.s;
    },
    pending() {
      return this.game.snapshot?.pending ?? null;
    },
    // 事件房倒计时：pending.left 剩余拍数（总窗 6 拍，仅展示用；不占轮数）
    deadlineLeft(): number {
      const s = this.s;
      if (!s?.pending) return 0;
      return Math.max(0, s.pending.left || 0);
    },
    deadlinePct(): number {
      return Math.max(0, Math.min(100, (this.deadlineLeft * 100) / 6));
    },
  },
  methods: {
    // 动作标签：姿态直查文案表；use:<id> 查 catalog
    label(a: string): string {
      if (a.startsWith("use:")) {
        const it = this.game.catalog[a.slice(4)];
        return "用·" + (it ? it.name : a.slice(4));
      }
      return ACTION_LABEL[a] || a;
    },
    tip(a: string): string {
      if (!a.startsWith("use:")) return "";
      const it: ItemDef | undefined = this.game.catalog[a.slice(4)];
      return it && it.desc ? it.name + "：" + it.desc : "";
    },
    isOn(a: string): boolean {
      return this.s?.hero?.stance === a;
    },
    act(a: string) {
      this.game.send({ action: a });
    },
    choose(id: string) {
      this.game.send({ choose: id });
    },
  },
  render() {
    const pending = this.pending;
    return (
      <div class="acts-wrap">
        {pending ? (
          <section class="panel event-panel">
            <header class="p-head">
              <h3>⚑ {pending.title}</h3>
            </header>
            {pending.desc ? <p class="ev-desc">{pending.desc}</p> : null}
            <div class="deadline">
              决定时间还剩
              <span class="bar dl">
                <i style={{ width: this.deadlinePct + "%" }}></i>
              </span>
              {this.deadlineLeft} 轮（超时默认：{pending.default}）
            </div>
            <div class="opts">
              {pending.options.map((o) => (
                <button key={o.id} class="opt" disabled={!this.canAct} onClick={() => this.choose(o.id)}>
                  {o.label}
                  {typeof o.cost === "number" ? <span class="cost">（{o.cost}金）</span> : null}
                </button>
              ))}
            </div>
          </section>
        ) : null}

        <section class="panel acts-panel">
          <header class="p-head">
            <h3>行动</h3>
            {this.game.sending ? (
              <span class="sending">结算中……</span>
            ) : this.canAct ? (
              <span class="hint">点一次，结算一轮</span>
            ) : null}
          </header>
          <div class="acts">
            {(this.s ? this.s.actions : []).map((a) => (
              <button
                key={a}
                class={["act", { on: this.isOn(a), warn: a === "descend" }]}
                disabled={!this.canAct}
                title={this.tip(a)}
                onClick={() => this.act(a)}
              >
                {this.label(a)}
              </button>
            ))}
          </div>
        </section>
      </div>
    );
  },
});
