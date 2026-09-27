// 应用根组件：首页 ↔ 对局页切换 + 设置弹窗。
// 像大多数游戏一样，首页只放一个「进入」按钮；未配置 token 时自动弹系统设置。
import { defineComponent } from "vue";
import HomeView from "./components/HomeView";
import LoadingOverlay from "./components/LoadingOverlay";
import MatchView from "./components/MatchView";
import SettingsModal from "./components/SettingsModal";
import { useGameStore } from "./stores/game";
import { useSettingsStore } from "./stores/settings";

export default defineComponent({
  name: "App",
  data() {
    return { game: useGameStore(), settings: useSettingsStore(), showSettings: false };
  },
  computed: {
    inMatch(): boolean {
      return this.game.inMatch;
    },
  },
  methods: {
    onEnter() {
      if (!this.settings.hasToken) {
        this.showSettings = true; // 未配置 token：先弹系统设置
        return;
      }
      this.game.enter();
    },
    onSaved() {
      this.showSettings = false; // 保存只关闭弹窗；进入由玩家点首页「进入」按钮
    },
    onClose() {
      this.showSettings = false;
    },
  },
  mounted() {
    this.settings.load();
    if (!this.settings.hasToken) this.showSettings = true;
    this.game.loadBoard(); // 页面打开即拉下潜榜
  },
  render() {
    return (
      <div class="shell">
        {/* 世界生成加载层：建局请求在途或已进对局但首帧未到时全屏覆盖 */}
        {this.game.busy || (this.game.inMatch && this.game.loading) ? (
          <LoadingOverlay />
        ) : null}
        {!this.inMatch ? (
          <HomeView
            onEnter={() => this.onEnter()}
            onSettings={() => (this.showSettings = true)}
          />
        ) : (
          <MatchView />
        )}
        {this.showSettings ? (
          <SettingsModal onSaved={() => this.onSaved()} onClose={() => this.onClose()} />
        ) : null}
      </div>
    );
  },
});
