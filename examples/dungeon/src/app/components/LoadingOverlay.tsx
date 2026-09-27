// 世界加载层（v5.4）：点「进入地牢」后的全屏动画——像素风进度条 + 轮换文案，
// 泰拉瑞亚/我的世界加载味。挂载时起计时器伪造推进（真实进度不可知），
// SSE 首帧到达（game.loading 变 false）后由父级卸载。
import { defineComponent } from "vue";
import { useGameStore } from "../stores/game";

// 轮换文案：世界生成的各阶段（顺序播放，循环）
const TIPS = [
  "正在雕刻岩层与甬道……",
  "点燃第一支火把……",
  "投掷出身骰，决定你的来历……",
  "往宝箱里塞进战利品……",
  "唤醒沉睡在黑暗中的东西……",
  "商人正在清点他的货物……",
  "地牢之主睁开了眼睛……",
  "石阶向下延伸，看不到尽头……",
];

export default defineComponent({
  name: "LoadingOverlay",
  data() {
    return { game: useGameStore(), tipIx: 0, pct: 4, timer: 0 };
  },
  computed: {
    tip(): string {
      return TIPS[this.tipIx % TIPS.length];
    },
  },
  mounted() {
    // 像素游戏式步进：进度走走停停，永不自己到 100（100 由真实首帧触发卸载）
    this.timer = window.setInterval(() => {
      this.tipIx += 1;
      if (this.pct < 90) {
        this.pct = Math.min(90, this.pct + Math.floor(3 + Math.random() * 9));
      }
    }, 650);
  },
  beforeUnmount() {
    window.clearInterval(this.timer);
  },
  render() {
    return (
      <div class="world-loading">
        <div class="wl-box">
          <div class="wl-title">正在生成地牢</div>
          <div class="wl-bar">
            <i style={{ width: this.pct + "%" }}></i>
          </div>
          <div class="wl-tip">{this.tip}</div>
          <div class="wl-pct">{this.pct}%</div>
        </div>
      </div>
    );
  },
});
