const TOKEN_KEY = "obs_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

/** 构建时由 VITE_APP_BASE 注入（nginx /obs/ 前缀部署）；开发环境为 "/"。 */
const APP_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

/** 把根相对 API 路径补上部署前缀，如 "/api/x" → "/obs/api/x"。 */
function apiUrl(path: string): string {
  return APP_BASE ? `${APP_BASE}${path}` : path;
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(apiUrl(path), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });

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
