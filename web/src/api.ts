// Запросы к серверу. Ключ входа — в localStorage; без него любой запрос ведёт на экран входа.

const KEY = "maid.token";

export const getToken = () => localStorage.getItem(KEY) ?? "";
export const setToken = (t: string) => (t ? localStorage.setItem(KEY, t) : localStorage.removeItem(KEY));

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

let onUnauthorized: (() => void) | null = null;
export const whenUnauthorized = (fn: () => void) => (onUnauthorized = fn);

export async function api<T = unknown>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
  const token = getToken();
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (res.status === 401 && path !== "/api/login") {
    setToken("");
    onUnauthorized?.();
  }
  if (!res.ok) throw new ApiError(res.status, data.error ?? `сервер ${res.status}`);
  return data as T;
}

export const get = <T,>(path: string) => api<T>("GET", path);
export const post = <T,>(path: string, body: unknown = {}) => api<T>("POST", path, body);
export const del = <T,>(path: string) => api<T>("DELETE", path);
