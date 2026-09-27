// 系统设置 store：网关地址 / Admin Token / 冒险者大名 / 开局面板参数，localStorage 持久化。
import { defineStore } from "pinia";

const KEY = "dungeon.settings.v1";
// 守主遗产（跨局结转）：按玩家大名存物品条目（可含 "id@depth" 实例），与 wap 变体共用同一 key。
const LEGACY_KEY = "dungeon.legacy.v1";
export const LEGACY_CAP = 3; // 保留槽位上限：多次结转也不超过 3
// 已鉴定名录（秘密资料）：按玩家大名存 base id 列表，建局经 props.identified 注入。
const IDENT_KEY = "dungeon.identified.v1";
// 来历传说：按玩家大名存 base id -> 传说文本（narrator 席 LLM 撰写，跨局携带）。
const LORE_KEY = "dungeon.lore.v1";

function readLegacy(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (raw) return JSON.parse(raw) as Record<string, string[]>;
  } catch {
    /* 坏数据当没存过 */
  }
  return {};
}

function readIdent(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(IDENT_KEY);
    if (raw) return JSON.parse(raw) as Record<string, string[]>;
  } catch {
    /* 坏数据当没存过 */
  }
  return {};
}

function readLore(): Record<string, Record<string, string>> {
  try {
    const raw = localStorage.getItem(LORE_KEY);
    if (raw) return JSON.parse(raw) as Record<string, Record<string, string>>;
  } catch {
    /* 坏数据当没存过 */
  }
  return {};
}

export const useSettingsStore = defineStore("settings", {
  state: () => ({
    base: "", // 网关地址，留空 = 同源（页面由 /play 托管时直接可用）
    token: "",
    name: "无名者",
    seed: 0, // 留空（0）= 每局随机；同种子可复现
    loaded: false,
  }),
  getters: {
    baseUrl(state): string {
      const v = state.base.trim();
      return v ? v.replace(/\/+$/, "") : location.origin;
    },
    hasToken(state): boolean {
      return state.token.trim().length > 0;
    },
  },
  actions: {
    load() {
      try {
        const raw = localStorage.getItem(KEY);
        if (raw) {
          const obj = JSON.parse(raw) as Record<string, unknown>;
          if (typeof obj.base === "string") this.base = obj.base;
          if (typeof obj.token === "string") this.token = obj.token;
          if (typeof obj.name === "string") this.name = obj.name;
          if (typeof obj.seed === "number") this.seed = obj.seed;
        }
      } catch {
        /* 坏数据当没配过 */
      }
      this.loaded = true;
    },
    save() {
      const { base, token, name, seed } = this;
      localStorage.setItem(KEY, JSON.stringify({ base, token, name, seed }));
    },
    // 当前大名的守主遗产（物品条目列表，已按槽位上限截断的存储在本地）
    legacyFor(name: string): string[] {
      const arr = readLegacy()[name] || [];
      return arr.slice(0, LEGACY_CAP);
    },
    saveLegacy(name: string, items: string[]) {
      const all = readLegacy();
      const list = items.slice(0, LEGACY_CAP);
      if (list.length) all[name] = list;
      else delete all[name];
      localStorage.setItem(LEGACY_KEY, JSON.stringify(all));
    },
    // 秘密资料：历局鉴定过的装备 base id（跨局携带，「使用过一次即永久知道」）
    identifiedFor(name: string): string[] {
      return readIdent()[name] || [];
    },
    saveIdentified(name: string, ids: string[]) {
      const all = readIdent();
      const list = Array.from(new Set(ids));
      if (list.length) all[name] = list;
      else delete all[name];
      localStorage.setItem(IDENT_KEY, JSON.stringify(all));
    },
    // 来历传说：narrator 席为鉴定装备写的短文（跨局携带，鉴定过就不再重写）
    loreFor(name: string): Record<string, string> {
      return readLore()[name] || {};
    },
    saveLore(name: string, lore: Record<string, string>) {
      const all = readLore();
      const cur = all[name] || {};
      const merged = Object.assign({}, cur, lore);
      const keys = Object.keys(merged);
      if (keys.length) all[name] = merged;
      else delete all[name];
      localStorage.setItem(LORE_KEY, JSON.stringify(all));
    },
  },
});
