// 对局 store：建局 / SSE 订阅 / 指令下发 / 结算与排行榜。
// 行为驱动：渲染只来自 SSE payload（订阅首帧即当前快照，无指令零推送）；
// 点一次按钮 = 下发一条指令 = 结算一轮。
import { defineStore } from "pinia";
import type { ItemDef, State } from "../../shared";
import { api, errText, pmCall, svc } from "../api";
import { useSettingsStore } from "./settings";

export interface BoardEntry {
  name: string;
  depth: number;
  boss_kills: number;
  ticks: number;
}

// 服务端 SnapshotMsg 的 json tag 全小写：match_id/tick/state/done/result
interface SseMsg {
  match_id: string;
  tick: number;
  state?: State;
  done: boolean;
  result?: { winner?: string; epitaph?: string } | null;
}

// 指令在途兜底计时器：SSE 帧正常会解除 sending，这里防网络异常时卡死在 loading。
let sendingTimer: ReturnType<typeof setTimeout> | null = null;
const SENDING_FALLBACK_MS = 6000;
// 死亡宽限兜底：done 帧迟迟不到时的收尾计时器（见 onMsg）
let deadTimer: ReturnType<typeof setTimeout> | null = null;

export const useGameStore = defineStore("game", {
  state: () => ({
    matchId: "",
    snapshot: null as State | null, // SSE 帧的原始 state（不带 catalog，catalog 单独缓存）
    catalog: {} as Record<string, ItemDef>,
    over: true,
    result: null as { winner?: string } | null,
    finalTicks: 0,
    scoreRank: null as number | null,
    error: "",
    busy: false, // 建局请求在途
    sending: false, // 指令请求在途（防连点）
    es: null as EventSource | null,
    board: [] as BoardEntry[], // 下潜排行榜（solver 服务，无需 token）
    saved: null as { depth?: number; tick?: number; saved_at?: number } | null, // pm 服务上的存档概要
    saveBusy: false, // 存档请求在途
    runSeed: 0, // 本局的种子（出身骰/确定性复现/pm 运行键，顶栏展示）
    // 建局时下发的对局令牌：只对本局有效（快照/事件流/指令），
    // 开不了别的对局，也停不了别人的局。
    playerToken: "",
  }),
  getters: {
    // 对局视图的依据是有没有 matchId：死亡结算（over=true）后仍停在结算层，
    // 直到玩家点「再入地牢」或「返回首页」——不能在 over 瞬间把玩家踢回首页。
    inMatch(state): boolean {
      return !!state.matchId;
    },
    loading(state): boolean {
      return !state.over && !state.snapshot; // 已建局但首帧未到
    },
    dead(state): boolean {
      return (
        state.snapshot?.status === "dead" || state.snapshot?.status === "won"
      );
    },
    resultText(state): string {
      const snap = state.snapshot;
      const depth = snap?.depth ?? 0;
      const bosses = snap?.boss_kills ?? 0;
      if (state.result?.winner === "hero")
        return `走出地牢！带着战利品归返（第 ${depth} 层 · ${state.finalTicks} 轮 · 守主×${bosses}）`;
      if (state.result?.winner === "monsters" || snap?.status === "dead")
        return `你永远留在了第 ${depth} 层（${state.finalTicks} 轮 · 击倒守主 ${bosses}）`;
      return `行到此层，行动上限已到（第 ${depth} 层 · ${state.finalTicks} 轮）`;
    },
  },
  actions: {
    reset() {
      this.es?.close();
      this.es = null;
      if (deadTimer) {
        clearTimeout(deadTimer);
        deadTimer = null;
      }
      this.matchId = "";
      this.snapshot = null;
      this.over = true;
      this.sending = false;
      this.result = null;
      this.finalTicks = 0;
      this.scoreRank = null;
      this.error = "";
    },
    // 建局：p0 = 你（人），p1 = 旁白席（LLM 文案/传说/墓志铭），p2 = 军师
    // 低语席（Jev 建议可听可不听），p3 = 地牢之主席（Jev 对抗，规则侧有冷却
    // 与浅层豁免兜底）。pm 后端经网关 match bridge 直接监听/操纵活局，
    // 不再需要 gm 脑席中转。
    async enter(resumeState?: State) {
      const st = useSettingsStore();
      const hero = st.name.trim() || "无名者";
      this.reset();
      this.busy = true;
      try {
        // seed 兼作 pm 后端的运行键（decide 入参没有 match_id）：留空自动取
        // 随机值保证唯一；resume 沿用存档 seed 由规则端恢复。
        const seed =
          resumeState?.seed ?? (Number(st.seed) || (Date.now() & 0x7fffffff));
        this.runSeed = seed;
        // 建局走 pm 服务（manifest 的 http.public + gateway_access）：
        // 服务用它自己的窄权限令牌代为建局，玩家浏览器因此完全不需要
        // operator 凭据。返回的 player_token 只对这一局有效。
        const m = await pmCall("/newmatch", "POST", {
          match: {
            game: "dungeon",
            seed,
            tick_ms: 2000,
            players: [
              { human: true },
              { brain: { brain: "narrator" } },
              { brain: { brain: "oracle" } },
              { brain: { brain: "dm" } },
            ],
            // 守主遗产：上局死亡结转的物品条目（规则端会再校验，上限 3）；
            // 秘密资料：历局鉴定名录，规则端据此决定掉落是否蒙尘；
            // 来历传说：历局 narrator 为鉴定装备写的短文，鉴定过就不再重写；
            // resume：中断续玩——规则端白名单 hydrate 整份存档 state。
            props: {
              legacy: st.legacyFor(hero),
              identified: st.identifiedFor(hero),
              lore: st.loreFor(hero),
              ...(resumeState ? { resume: resumeState } : {}),
            },
          },
        });
        this.matchId = m.match_id;
        this.playerToken = m.player_token || "";
        this.over = false;
        // 道具表只在 rules.snapshot() 里：开局 REST 拉一次缓存，
        // 之后所有道具名/属性展示都用这份静态表（规则表是唯一事实源）。
        try {
          const full = await api("GET", "/v1/games/" + this.matchId, undefined, this.playerToken);
          const snap = full.snapshot as
            | (State & { catalog?: Record<string, ItemDef> })
            | undefined;
          if (snap) {
            this.snapshot = snap;
            this.catalog = snap.catalog || {};
            this.cacheCatalog();
          }
        } catch {
          /* 快照拉不到也能玩：SSE 首帧马上会到，只是道具名先缺位 */
        }
        this.listen();
      } catch (e) {
        this.reset();
        this.error = "开局失败：" + errText(e);
      } finally {
        this.busy = false;
      }
    },
    listen() {
      const st = useSettingsStore();
      this.es?.close();
      // EventSource 带不了自定义头，令牌只能走查询串。优先用本局令牌。
      const tok = (this.playerToken || st.token).trim();
      const q = tok ? "?token=" + encodeURIComponent(tok) : "";
      const es = new EventSource(
        st.baseUrl + "/v1/games/" + this.matchId + "/events" + q,
      );
      this.es = es;
      es.addEventListener("tick", (ev) =>
        this.onMsg(JSON.parse((ev as MessageEvent).data)),
      );
      es.addEventListener("over", (ev) =>
        this.onMsg(JSON.parse((ev as MessageEvent).data)),
      );
      es.onerror = () => {
        /* over 后连接由服务端关闭，属正常 */
      };
    },
    onMsg(msg: SseMsg) {
      if (msg.done) {
        this.finish(msg.result || {}, msg.tick);
        return;
      }
      if (!msg.state) return;
      this.snapshot = msg.state;
      this.sending = false; // SSE 帧到达：指令已结算入快照，解除 loading
      // 秘密资料：本局鉴定名录即时落盘（下次建局经 props.identified 带入）
      const st = useSettingsStore();
      if (msg.state.identified && msg.state.identified.length) {
        st.saveIdentified(st.name.trim() || "无名者", msg.state.identified);
      }
      // 来历传说：narrator 席新写的条目即时落盘（下次建局经 props.lore 带入）
      if (msg.state.item_lore && Object.keys(msg.state.item_lore).length) {
        st.saveLore(st.name.trim() || "无名者", msg.state.item_lore);
      }
      if (msg.state.status === "dead" || msg.state.status === "won") {
        // 死亡≠立即落终：rules 进入终局宽限（1-2 tick），narrator 要趁宽限
        // 回传墓志铭，随 done 帧的 result.epitaph 一起到。正常等 done 帧；
        // 5 秒兜底防 SSE 断线时卡死（用手头快照尽力收尾）。
        const endStatus = msg.state.status;
        if (!deadTimer) {
          deadTimer = setTimeout(() => {
            deadTimer = null;
            const snap = this.snapshot as (State & { epitaph?: string }) | null;
            this.finish(
              {
                winner: endStatus === "won" ? "hero" : "monsters",
                epitaph: snap?.epitaph || "",
              },
              msg.tick,
            );
          }, 5000);
        }
      }
    },
    finish(result: { winner?: string; epitaph?: string }, ticks: number) {
      if (this.over) return;
      this.over = true;
      this.sending = false;
      if (deadTimer) {
        clearTimeout(deadTimer);
        deadTimer = null;
      }
      this.es?.close();
      this.es = null;
      this.result = result;
      this.finalTicks = ticks;
      // 守主遗产结转：死亡时由结算卡**自选**保留件（≤本局守主数，上限 3），
      // 玩家确认后写盘——搜打撤：带走什么由你决定，不选就什么都不留。
      this.submitScore(ticks);
    },
    // 道具表缓存到 localStorage：首页没进对局也能显示遗产条目的名字/属性。
    cacheCatalog() {
      try {
        localStorage.setItem(
          "dungeon.catalog.v1",
          JSON.stringify(this.catalog),
        );
      } catch {
        /* 存不下就算了 */
      }
    },
    loadCatalogCache(): Record<string, ItemDef> {
      try {
        const raw = localStorage.getItem("dungeon.catalog.v1");
        if (raw) return JSON.parse(raw) as Record<string, ItemDef>;
      } catch {
        /* 坏数据当没存过 */
      }
      return {};
    },
    // 下发指令（action / choose / equip）。指令合法性归规则，前端照发由服务端裁决。
    // sending 生命周期：POST 只是提交，**SSE 帧到达（onMsg）才解除**——HTTP 响应
    // 早于引擎异步结算，按响应解除会让连点穿透到同一轮。sending 同时驱动按钮禁用。
    async send(commands: { action?: string; choose?: string; equip?: string }) {
      if (this.sending || this.over || !this.matchId) return;
      this.sending = true;
      if (sendingTimer) clearTimeout(sendingTimer);
      sendingTimer = setTimeout(
        () => (this.sending = false),
        SENDING_FALLBACK_MS,
      );
      try {
        await api("POST", "/v1/games/" + this.matchId + "/commands", {
          player: "p0",
          commands,
        }, this.playerToken);
      } catch (e) {
        const m = errText(e);
        if (m.includes("match over")) this.finish({}, this.snapshot?.tick ?? 0);
        else {
          this.error = "指令失败：" + m;
          this.sending = false; // 请求本身失败：没有 SSE 帧会来，立即解除
        }
      }
    },
    async giveUp() {
      if (!this.matchId) return;
      try {
        await api("POST", "/v1/games/" + this.matchId + "/stop", {});
      } catch {
        /* 对局已卸载 */
      }
      this.reset();
      this.error = "本次探险已放弃。";
    },
    again() {
      this.enter();
    },
    leave() {
      this.reset();
    },
    // ---- pm 后端：中断续玩存档 + 首页「继续冒险」----
    // 存档原料就是 SSE 帧里的 raw state（与规则端 resume hydrate 对齐）。
    async saveGame() {
      if (this.saveBusy || this.over || !this.snapshot || !this.matchId) return;
      const st = useSettingsStore();
      this.saveBusy = true;
      try {
        await pmCall("/save", "POST", {
          name: st.name.trim() || "无名者",
          match_id: this.matchId,
          seed: this.snapshot.seed,
          state: this.snapshot,
        });
        this.saved = {
          depth: this.snapshot.depth,
          tick: this.snapshot.tick,
          saved_at: Math.floor(Date.now() / 1000),
        };
      } catch (e) {
        this.error = "存档失败：" + errText(e);
      } finally {
        this.saveBusy = false;
      }
    },
    async loadSaved() {
      const st = useSettingsStore();
      try {
        const r = await pmCall(
          "/save/" + encodeURIComponent(st.name.trim() || "无名者"),
        );
        if (r && r.state) {
          this.saved = { depth: r.state.depth, tick: r.state.tick, saved_at: r.saved_at };
          return r.state as State;
        }
      } catch {
        /* 无存档/服务不可用：静默 */
      }
      this.saved = null;
      return null;
    },
    async resumeGame() {
      const st = useSettingsStore();
      try {
        const r = await pmCall(
          "/save/" + encodeURIComponent(st.name.trim() || "无名者"),
        );
        if (r && r.state) await this.enter(r.state as State);
      } catch (e) {
        this.error = "读档失败：" + errText(e);
      }
    },
    async deleteSaved() {
      const st = useSettingsStore();
      try {
        await pmCall(
          "/save/" + encodeURIComponent(st.name.trim() || "无名者"),
          "DELETE",
        );
      } catch {
        /* 服务不可用就算了 */
      }
      this.saved = null;
    },
    // ---- 下潜排行榜（solver 服务：死亡/超时结算自动提交，打开页面即拉榜） ----
    async loadBoard() {
      try {
        const d = await svc("/top");
        this.board = d.entries || [];
      } catch {
        this.board = []; // 服务暂不可用，静默
      }
    },
    async submitScore(ticks: number) {
      const snap = this.snapshot;
      if (snap?.depth) {
        const st = useSettingsStore();
        try {
          const r = await svc("/score", {
            name: st.name.trim() || "无名者",
            depth: snap.depth,
            boss_kills: snap.boss_kills || 0,
            ticks,
            seed: snap.seed,
            resumes: snap.resumes || 0, // 续命次数：solver 榜单展示「续命×N」
          });
          this.scoreRank = typeof r.rank === "number" ? r.rank : null;
        } catch {
          /* 榜单服务不可用不影响结算 */
        }
      }
      this.loadBoard();
    },
  },
});
