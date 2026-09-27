// 系统设置弹窗：网关地址 / Admin Token / 冒险者大名 / 种子。
// 首页无 token 自动弹出；保存后仅关闭弹窗（进入由首页「进入」按钮触发）。
// TSX 下 v-model 手写：value + onInput（.trim/.number 修饰符同样手抄）。
import { defineComponent } from "vue";
import { assertToken } from "../api";
import { useGameStore } from "../stores/game";
import { useSettingsStore } from "../stores/settings";

export default defineComponent({
  name: "SettingsModal",
  emits: ["saved", "close"],
  data() {
    const st = useSettingsStore();
    return {
      st,
      game: useGameStore(),
      form: { base: st.base, token: st.token, name: st.name, seed: st.seed },
      err: "",
    };
  },
  methods: {
    save() {
      try {
        const token = String(this.form.token || "").trim();
        if (token) assertToken(token);
        if (!token && !confirm("未填写 Admin Token，建局会被网关拒绝。仍要保存吗？")) return;
        this.st.base = String(this.form.base || "").trim();
        this.st.token = token;
        this.st.name = String(this.form.name || "").trim() || "无名者";
        this.st.seed = Number(this.form.seed) || 0;
        this.st.save();
        this.$emit("saved");
      } catch (e) {
        this.err = e instanceof Error ? e.message : String(e);
      }
    },
    close() {
      this.$emit("close");
    },
  },
  render() {
    const inputVal = (e: Event): string => (e.target as HTMLInputElement).value;
    return (
      <div
        class="overlay"
        onClick={(e) => {
          if (e.target === e.currentTarget) this.close();
        }}
      >
        <div class="panel modal">
          <header class="p-head">
            <h3>系统设置</h3>
          </header>
          <div class="form">
            <label>
              网关地址
              <input
                value={this.form.base}
                placeholder="留空 = 本页面同源网关"
                spellcheck={false}
                onInput={(e) => (this.form.base = inputVal(e).trim())}
              />
            </label>
            <label>
              Admin Token（/v1/games 与 /admin 同权限，本机 loopback 也必须填）
              <input
                type="password"
                value={this.form.token}
                autocomplete="off"
                spellcheck={false}
                onInput={(e) => (this.form.token = inputVal(e))}
              />
            </label>
            <label>
              冒险者大名（死亡结算录入下潜榜）
              <input
                value={this.form.name}
                autocomplete="off"
                spellcheck={false}
                maxlength={24}
                onInput={(e) => (this.form.name = inputVal(e))}
              />
            </label>
            <div class="row2">
              <label>
                种子（留空 = 每局随机；同种子 = 同地牢，可复现）
                <input
                  type="number"
                  min={0}
                  placeholder="留空随机"
                  value={this.form.seed ? String(this.form.seed) : ""}
                  onInput={(e) => (this.form.seed = Number(inputVal(e)) || 0)}
                />
              </label>
            </div>
            <p class="hint">设置保存在本机浏览器（localStorage），只影响这个页面。</p>
            {this.err ? <p class="err">{this.err}</p> : null}
            <div class="modal-acts">
              <button class="btn primary" onClick={() => this.save()}>
                保存
              </button>
              <button class="btn ghost" onClick={() => this.close()}>
                取消
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  },
});
