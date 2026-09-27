// 网关 REST / SVC 访问层：地址与 Admin Token 来自 settings store（localStorage 持久化）。
import { useSettingsStore } from "./stores/settings";

// HTTP 头只允许 ISO-8859-1：混入中文等字符时 fetch 直接抛晦涩错误，这里先拦下给提示。
export function assertToken(t: string): void {
  if (/[^\x00-\xff]/.test(t))
    throw new Error(
      "Admin Token 含非 ASCII 字符（可能误贴了中文或被浏览器自动填充），请重新填写",
    );
}

function throwStatus(method: string, path: string, status: number, text: string): never {
  throw new Error(method + " " + path + " → " + status + " " + text.slice(0, 160));
}

// 建局、建局列表这类「服务器级」操作仍需 Admin Token；对局自己的接口
// （快照 / 事件流 / 指令）用建局时下发的 player_token 就够——见 api()。
export async function api(
  method: string,
  path: string,
  body?: unknown,
  playerToken?: string,
): Promise<any> {
  const st = useSettingsStore();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  // 优先用对局自己的令牌：它只对这一局有效，泄出去也开不了别的对局。
  const t = (playerToken || "").trim() || st.token.trim();
  if (t) {
    assertToken(t);
    headers["X-Admin-Token"] = t;
  }
  const r = await fetch(st.baseUrl + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throwStatus(method, path, r.status, await r.text());
  return r.json();
}

// /svc 是包内服务的网关反代：现在由 manifest 的 http.public 显式声明哪些路由
// 免凭据（未声明的一律要 Admin Token），所以这里带上 token 而不是假设公开。
export async function svc(path: string, body?: unknown): Promise<any> {
  return svcCall("solver", path, body === undefined ? "GET" : "POST", body);
}

// pm 服务（监听/操纵/存档）：写操作（/op、/save、DELETE）由网关按 manifest
// 拦下并要求 Admin Token，服务端还会再校验一次 PM_TOKEN。
export async function pmCall(
  path: string,
  method: "GET" | "POST" | "DELETE" = "GET",
  body?: unknown,
): Promise<any> {
  return svcCall("pm", path, method, body);
}

async function svcCall(
  service: string,
  path: string,
  method: "GET" | "POST" | "DELETE",
  body?: unknown,
): Promise<any> {
  const st = useSettingsStore();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const t = st.token.trim();
  if (t) {
    assertToken(t);
    headers["X-Admin-Token"] = t;
  }
  const r = await fetch(st.baseUrl + "/svc/dungeon/" + service + path, {
    method,
    headers: body === undefined ? undefined : headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throwStatus("svc " + service + " " + method, path, r.status, await r.text());
  return r.json();
}

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
