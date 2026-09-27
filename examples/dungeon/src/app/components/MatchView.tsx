// 对局主视图：顶栏 + 三栏布局（英雄面板 / 敌人与行动 / 日志），死亡或行动上限
// 耗尽时出现结算层（自动提交下潜榜）。死亡时可自选守主遗产结转件（搜打撤：
// 带走什么由你决定，上限 = 本局击倒守主数，最多 3）。窄屏单列堆叠。
import { defineComponent } from "vue";
import type { ItemDef } from "../../shared";
import { baseOf, gearStat } from "../entry";
import ActionsPanel from "./ActionsPanel";
import FoePanel from "./FoePanel";
import HeroPanel from "./HeroPanel";
import LogPanel from "./LogPanel";
import OriginDice from "./OriginDice";
import { useGameStore } from "../stores/game";
import { useSettingsStore } from "../stores/settings";

export default defineComponent({
  name: "MatchView",
  data() {
    return {
      game: useGameStore(),
      settings: useSettingsStore(),
      legacyPick: [] as string[], // 结算卡勾选的结转条目
      legacySaved: false,
    };
  },
  computed: {
    // 墓志铭：narrator 席在终局宽限里回传、随 done 帧 result 带来的句子。
    epitaph(): string {
      const r = this.game.result as { epitaph?: string } | null;
      return (r && r.epitaph) || "";
    },
    // 可保留件数：死亡时按本局击倒守主数（每杀一个多留一件），上限 3。
    // 活着离开（行动上限耗尽）不算死亡，不开放结转。
    keepCap(): number {
      const snap = this.game.snapshot;
      if (!snap || this.game.result?.winner !== "monsters") return 0;
      return Math.min(snap.boss_kills || 0, 3);
    },
    invEntries(): Array<{ entry: string; label: string; stat: string }> {
      const snap = this.game.snapshot;
      if (!snap) return [];
      const unid = snap.unidentified || [];
      return (snap.inventory || []).map((entry) => {
        const base = baseOf(entry);
        const it: ItemDef | undefined = this.game.catalog[base];
        const isUnid = unid.indexOf(base) >= 0;
        let stat = "";
        if (it) {
          if (isUnid) stat = "属性不明";
          else {
            const parts: string[] = [];
            const atk = gearStat(it.atk, entry);
            const armor = gearStat(it.armor, entry);
            const hpMax = gearStat(it.hp_max, entry);
            if (atk) parts.push("攻+" + atk);
            if (armor) parts.push("甲+" + armor);
            if (hpMax) parts.push("血上限+" + hpMax);
            stat = parts.join(" · ");
          }
        }
        return {
          entry,
          label: isUnid ? "？？？（未知装备）" : it?.name || entry,
          stat,
        };
      });
    },
    savedNames(): string {
      return this.settings
        .legacyFor(this.settings.name.trim() || "无名者")
        .map((e) => this.game.catalog[baseOf(e)]?.name || e)
        .join("、");
    },
  },
  methods: {
    giveUp() {
      this.game.giveUp();
    },
    // 中断续玩：把 SSE raw state 存进 pm 后端（跨浏览器可恢复）
    save() {
      this.game.saveGame();
    },
    again() {
      this.game.again();
    },
    leave() {
      this.game.leave();
    },
    togglePick(entry: string) {
      const i = this.legacyPick.indexOf(entry);
      if (i >= 0) this.legacyPick.splice(i, 1);
      else if (this.legacyPick.length < this.keepCap) this.legacyPick.push(entry);
    },
    confirmLegacy() {
      const name = this.settings.name.trim() || "无名者";
      this.settings.saveLegacy(name, this.legacyPick);
      this.legacySaved = true;
    },
  },
  render() {
    const snap = this.game.snapshot;
    return (
      <div class="match">
        <header class="topbar">
          <div class="crumbs">
            <span class="depth">第 {snap?.depth} 层</span>
            <span class="sep">·</span>等级 {snap?.level}
            <span class="sep">·</span>第 {snap?.tick} 轮
          </div>
          <div class="meta">
            金币 {snap?.gold} · 药水 {snap?.potions} · 击杀 {snap?.kills}
            {snap?.boss_kills ? <> · 守主×{snap.boss_kills}</> : null}
            {this.game.runSeed ? <> · 种子 {this.game.runSeed}</> : null}
          </div>
          <button class="btn ghost" disabled={this.game.saveBusy} title="存到网关侧 pm 后端（中断续玩）" onClick={() => this.save()}>
            {this.game.saveBusy ? "存档中…" : this.game.saved ? "已存档 · 再存" : "存档"}
          </button>
          <button class="btn ghost" onClick={() => this.giveUp()}>
            放弃
          </button>
        </header>

        {this.game.loading ? (
          <div class="loading">火把点亮中……</div>
        ) : (
          <div class="cols">
            <div class="left">
              <HeroPanel />
              <OriginDice />
            </div>
            <div class="mid">
              <FoePanel />
              <ActionsPanel />
            </div>
            <LogPanel />
          </div>
        )}

        {this.game.over && snap ? (
          <div class="overlay">
            <div class="over-card">
              <div class="rune">☠</div>
              <h2>{this.game.resultText}</h2>
              {this.epitaph ? <p class="epitaph">「{this.epitaph}」</p> : null}
              {this.game.scoreRank ? (
                <p class="rank">已录入下潜榜 · 当前第 {this.game.scoreRank} 名</p>
              ) : null}

              {this.keepCap > 0 && !this.legacySaved ? (
                <div class="legacy-pick">
                  <p class="lp-title">
                    守主的遗产：挑选 {this.keepCap} 件随你结转（不选则散落深渊）
                  </p>
                  <div class="lp-list">
                    {this.invEntries.map((e) => (
                      <button
                        key={e.entry}
                        class={["lp-item", { picked: this.legacyPick.indexOf(e.entry) >= 0 }]}
                        onClick={() => this.togglePick(e.entry)}
                      >
                        <span class="nm">{e.label}</span>
                        {e.stat ? <span class="st">{e.stat}</span> : null}
                      </button>
                    ))}
                  </div>
                  <p class="hint">
                    已选 {this.legacyPick.length}/{this.keepCap} ——
                    死亡结算录入下潜榜后，下次进入将自动带入所选物品。
                  </p>
                  <button class="btn primary" onClick={() => this.confirmLegacy()}>
                    确认结转（{this.legacyPick.length} 件）
                  </button>
                </div>
              ) : this.legacySaved && this.legacyPick.length ? (
                <p class="rank">
                  守主遗产（{this.legacyPick.length}/3 槽）已结转：{this.savedNames}
                </p>
              ) : null}

              {this.game.error ? <p class="err">{this.game.error}</p> : null}
              <div class="over-acts">
                <button class="btn primary" onClick={() => this.again()}>
                  再入地牢
                </button>
                <button class="btn ghost" onClick={() => this.leave()}>
                  返回首页
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    );
  },
});
