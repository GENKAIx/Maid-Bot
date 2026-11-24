// Запросы к серверу. Ключ входа — в localStorage; без него любой запрос ведёт на экран входа.

const KEY = "maid.token";

// Ключ сервера — только латиница, цифры и знаки. Испорченный (например, из старой программы на ПК) fetch не отправит —
// вместо «Нет связи: … non ISO-8859-1 code point» стираем его, и сайт показывает вход.
const keyOk = (t: string) => /^[\x21-\x7e]{1,4000}$/.test(t);
export const getToken = () => {
  const t = localStorage.getItem(KEY) ?? "";
  if (t && !keyOk(t)) localStorage.removeItem(KEY);
  return keyOk(t) ? t : "";
};
export const setToken = (t: string) => (t ? localStorage.setItem(KEY, t) : localStorage.removeItem(KEY));

/** data — всё тело ответа с ошибкой: у 402 (нужна подписка) там pay_url, messageId, saved (billing.ts refusedOf). */
export class ApiError extends Error {
  constructor(public status: number, message: string, public data: Record<string, unknown> = {}) {
    super(message);
  }
}

// Кто спрашивает — для статистики админки (server/src/auth.ts: clientMeta). Версия — время сборки (vite.config.ts);
// вне сборки Vite (тесты tsx) её нет — заголовок пустой, сервер считает «не сообщает».
// Сайт в главном окне программы на ПК — тоже «web», но ходит с ключом программы: сервер оставляет этот вход «Программой на ПК»
// и версию сайта ему не пишет (server/src/auth.ts, sessionMeta).
declare const __APP_VERSION__: string;
const appVersion = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "";
export const clientHeaders = (): Record<string, string> => ({ "X-Maid-Client": "web", "X-Maid-Version": appVersion });

let onUnauthorized: (() => void) | null = null;
export const whenUnauthorized = (fn: () => void) => (onUnauthorized = fn);

export async function api<T = unknown>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
  const token = getToken();
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json", ...clientHeaders(), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  // Только 401 — выход со входа. 402 (пробная неделя или подписка кончились) вход не трогает: ключ остаётся,
  // ошибка несёт текст и ссылку на оплату (billing.ts refusedOf).
  if (res.status === 401 && path !== "/api/login") {
    setToken("");
    onUnauthorized?.();
  }
  if (!res.ok) throw new ApiError(res.status, data.error ?? `сервер ${res.status}`, data && typeof data === "object" ? (data as Record<string, unknown>) : {});
  return data as T;
}

export const get = <T,>(path: string) => api<T>("GET", path);
export const post = <T,>(path: string, body: unknown = {}) => api<T>("POST", path, body);
export const del = <T,>(path: string) => api<T>("DELETE", path);
