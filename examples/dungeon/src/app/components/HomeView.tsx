// 首页：火光标题 + 大「进入」按钮 + 守主遗产整理（搜打撤：本轮带什么由你定）
// + 下潜排行榜。像大多数游戏一样，一屏一事。
import { defineComponent } from "vue";
import type { ItemDef } from "../../shared";
import { baseOf, gearStat } from "../entry";
import { useGameStore } from "../stores/game";
import { useSettingsStore } from "../stores/settings";

export default defineComponent({
  name: "HomeView",
  emits: ["enter", "settings"],
  data() {
    return { game: useGameStore(), settings: useSettingsStore() };
  },
  computed: {
    board() {
      return this.game.board;
    },
    // 道具表：本局拉过的用内存，否则退回 localStorage 缓存（首页也能显示名字）。
    catalog(): Record<string, ItemDef> {
      if (Object.keys(this.game.catalog).length) return this.game.catalog;
      return this.game.loadCatalogCache();
    },
    legacy(): string[] {
      return this.settings.legacyFor(this.settings.name.trim() || "无名者");
    },
    // 遗产条目展示：名字 + 实例属性（@depth 定格）。
    legacyItems(): Array<{ entry: string; label: string; stat: string }> {
      return this.legacy.map((entry) => {
        const it = this.catalog[baseOf(entry)];
        const parts: string[] = [];
        if (it) {
          const atk = gearStat(it.atk, entry);
          const armor = gearStat(it.armor, entry);
          const hpMax = gearStat(it.hp_max, entry);
          if (atk) parts.push("攻+" + atk);
          if (armor) parts.push("甲+" + armor);
          if (hpMax) parts.push("血上限+" + hpMax);
        }
        return { entry, label: it?.name || entry, stat: parts.join(" · ") };
      });
    },
  },
  methods: {
    // 从遗产里丢弃一件（只改本地存储，不占回合；规则端建局时还会再校验）。
    dropLegacy(entry: string) {
      const name = this.settings.name.trim() || "无名者";
      this.settings.saveLegacy(
        name,
        this.legacy.filter((e) => e !== entry),
      );
    },
    // 中断续玩：pm 后端存档（每玩家一份），继续 = props.resume 规则端 hydrate
    refreshSave() {
      this.game.loadSaved();
    },
    resume() {
      this.game.resumeGame();
    },
    dropSave() {
      this.game.deleteSaved();
    },
  },
  mounted() {
    this.refreshSave(); // 页面打开即查 pm 后端有没有本玩家的存档
  },
  render() {
    return (
      <main class="home">
        <div class="glow"></div>
        <h1 class="title">地牢探险</h1>
        <p class="sub">无限下潜 · 每 5 层有守主镇巢 · 深度即成绩 · 搜打撤：死亡时可带走战利品</p>
        <p class="who">
          冒险者：{this.settings.name}
          {/* 注意：别用 <>单段文本</> —— Fragment 只有一个字符串子节点时 children
              是纯字符串，Vue patch 按数组遍历会抛 read-only '0'。 */}
          {!this.settings.hasToken ? "（未配置 Token）" : null}
        </p>

        {this.game.saved ? (
          <section class="panel save-box">
            <header class="p-head">
              <h3>未竟的探险</h3>
              <span class="hint">pm 后端存档 · 可跨浏览器恢复</span>
            </header>
            <div class="lp-row">
              <span class="nm">
                第 {this.game.saved.depth} 层 · 第 {this.game.saved.tick} 轮
              </span>
              <button class="btn primary tiny" disabled={this.game.busy} onClick={() => this.resume()}>
                继续冒险
              </button>
              <button class="btn ghost tiny" title="删除存档（不可恢复）" onClick={() => this.dropSave()}>
                删档
              </button>
            </div>
          </section>
        ) : null}

        {this.legacyItems.length ? (
          <section class="panel legacy-box">
            <header class="p-head">
              <h3>守主遗产</h3>
              <span class="hint">{this.legacyItems.length}/3 槽 · 本轮带入，进入后不可更换</span>
            </header>
            <div class="lp-list">
              {this.legacyItems.map((e) => (
                <div key={e.entry} class="lp-row">
                  <span class="nm">{e.label}</span>
                  {e.stat ? <span class="st">{e.stat}</span> : null}
                  <button
                    class="btn ghost tiny"
                    title="留在这儿别带走（下局将散落深渊）"
                    onClick={() => this.dropLegacy(e.entry)}
                  >
                    留下
                  </button>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <button class="enter" disabled={this.game.busy} onClick={() => this.$emit("enter")}>
          {this.game.busy ? "点 火 中……" : "进  入  地  牢"}
        </button>
        {this.game.error ? <p class="err">{this.game.error}</p> : null}

        <div class="home-acts">
          <button class="btn ghost" onClick={() => this.$emit("settings")}>
            系统设置
          </button>
        </div>

        <section class="panel board">
          <header class="p-head">
            <h3>下潜排行榜</h3>
            <span class="hint">前 20 · 深度优先</span>
          </header>
          {this.board.length ? (
            <div class="rows">
              {this.board.map((e, i) => (
                <div key={i} class={["row", { top3: i < 3 }]}>
                  <span class="rk">#{i + 1}</span>
                  <span class="nm">{e.name}</span>
                  <span class="sc">
                    第{e.depth}层{e.boss_kills ? <> · 守主×{e.boss_kills}</> : null} · {e.ticks}轮
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div class="dim">还没有人留下足迹。</div>
          )}
        </section>
      </main>
    );
  },
});
