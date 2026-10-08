const TOKEN_KEY = "obs_token";
const ROLE_KEY = "obs_role";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function getRole(): string {
  return localStorage.getItem(ROLE_KEY) ?? "";
}

export function setRole(role: string): void {
  localStorage.setItem(ROLE_KEY, role);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(ROLE_KEY);
  rolePromise = null;
}

/** 构建时由 VITE_APP_BASE 注入（nginx /obs/ 前缀部署）；开发环境为 "/"。 */
const APP_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

/** 把根相对 API 路径补上部署前缀，如 "/api/x" → "/obs/api/x"。 */
function apiUrl(path: string): string {
  return APP_BASE ? `${APP_BASE}${path}` : path;
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  // 仅在有 body 时声明 JSON 头：Fastify 5 对「JSON 头 + 空 body」会 400
  // （FST_ERR_CTP_EMPTY_JSON_BODY，鉴权前即拒），曾导致无 body 的 DELETE 全挂。
  const headers: Record<string, string> = {
    ...(init?.body != null ? { "Content-Type": "application/json" } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...((init?.headers as Record<string, string>) ?? {}),
  };
  const res = await fetch(apiUrl(path), { ...init, headers });

  if (res.status === 401) {
    clearToken();
    if (!window.location.pathname.startsWith(`${APP_BASE}/login`)) {
      window.location.href = `${APP_BASE}/login`;
    }
    throw new Error("Unauthorized");
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(body.slice(0, 200) || res.statusText);
  }

  return res.json() as Promise<T>;
}

export function queryString(params: Record<string, string | number | undefined | null>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

/** 登录前签发的旧 token 没有 localStorage role：用 /api/auth/me 补一次（模块级缓存）。 */
let rolePromise: Promise<string> | null = null;

export function ensureRole(): Promise<string> {
  if (!getToken()) return Promise.resolve("");
  if (getRole()) return Promise.resolve(getRole());
  if (!rolePromise) {
    rolePromise = apiFetch<{ role: string }>("/api/auth/me")
      .then((res) => {
        setRole(res.role);
        return res.role;
      })
      .catch(() => {
        rolePromise = null;
        return "";
      });
  }
  return rolePromise;
}
