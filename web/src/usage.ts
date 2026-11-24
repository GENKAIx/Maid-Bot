import { clientHeaders, getToken } from "./api";
import { NAV_TABS, oldPath } from "./nav";
import { parsePath } from "./router";

// Счётчики фич сайта для админки «Использование функций» (этап 3, server/src/feature-events.ts). Только имена и сколько раз:
// ни текстов, ни адресов страниц с днями. Копится в памяти вкладки, раз в 10 минут и при уходе со страницы уходит пачкой на
// POST /api/events/usage. sendBeacon заголовок Authorization не шлёт — поэтому fetch с keepalive. Имена — из белого списка
// сервера (server/src/feature-list.ts); незнакомое сервер молча отбросит, тест web/test/usage.test.ts сверяет со списком
// имя в каждом вызове track.
// localStorage «maid.usage» — общий у вкладок: в нём только неотправленный остаток и время последней принятой пачки.
// Вкладка забирает остаток себе при старте и перед пачкой (хранилище тут же пустеет — двух счётов одного не бывает) и кладёт
// туда своё, когда уходит, а сервер пачку сейчас не возьмёт (с прошлой не прошла минута — 429) или не ответил.

export const USAGE_FLUSH_MS = 10 * 60_000;
/** Пачки чаще не шлём: сервер их не берёт (USAGE_BATCH_MS) — у ушедшей страницы счёт пропал бы. */
export const USAGE_GAP_MS = 60_000;
/** Больше стольких раз одной фичи в пачке сервер не берёт (USAGE_MAX_COUNT) — здесь тоже не копим. */
export const USAGE_MAX_COUNT = 500;
/** Выход из аккаунта ждёт пачку не дольше. */
export const USAGE_LOGOUT_MS = 2000;
const KEY = "maid.usage";
const NAME = /^[a-z][a-z0-9_.]{1,40}$/;

/** Отправить пачку: true — дело сделано (принято или отброшено насовсем), false — оставить и прислать со следующей. */
export type UsageSend = (counts: Record<string, number>, keepalive: boolean) => Promise<boolean>;
export interface UsageKeep { load(): string | null; save(v: string): void }
type Counts = Record<string, number>;
type Kept = { at: number; counts: Counts };

export function usageCounter(send: UsageSend, keep?: UsageKeep, now = () => Date.now()) {
  let counts: Counts = {};
  let epoch = 0; // растёт при выходе из аккаунта: ответ на прежнюю пачку счёт уже не возвращает
  const add = (to: Counts, k: string, n: number) => { to[k] = Math.min(USAGE_MAX_COUNT, (to[k] ?? 0) + n); };
  const read = (): Kept => {
    const out: Kept = { at: 0, counts: {} };
    try {
      const v = JSON.parse(keep?.load() ?? "{}") as { at?: unknown; counts?: Record<string, unknown> };
      out.at = Number(v.at) || 0;
      for (const [k, n] of Object.entries(v.counts ?? {})) if (NAME.test(k) && Number(n) >= 1) add(out.counts, k, Math.floor(Number(n)));
    } catch { /* испорчено или недоступно — пусто */ }
    return out;
  };
  const write = (v: Kept) => { try { keep?.save(JSON.stringify(v)); } catch { /* хранилище недоступно — хватит памяти */ } };
  /** Остаток из хранилища (прошлый раз, другая вкладка) — себе в память; хранилище пустеет. */
  const take = () => {
    const s = read();
    if (!Object.keys(s.counts).length) return;
    for (const [k, n] of Object.entries(s.counts)) add(counts, k, n);
    write({ at: s.at, counts: {} });
  };
  /** Свой счёт — в хранилище (к лежащему там), память пустеет: уйдёт со следующей пачкой любой вкладки. */
  const stash = () => {
    if (!Object.keys(counts).length) return;
    const s = read();
    for (const [k, n] of Object.entries(counts)) add(s.counts, k, n);
    write(s);
    counts = {};
  };
  take();
  let busy = false;
  return {
    track(feature: string) {
      if (NAME.test(feature)) add(counts, feature, 1);
    },
    pending: () => ({ ...counts }),
    /** Пачку — на сервер; пока одна в пути, вторая не уходит. leaving — страница уходит (скрыта, закрыта): ответа можно
     *  не дождаться, поэтому если сервер сейчас пачку не возьмёт или не ответил — счёт в хранилище, а не в память. */
    async flush(leaving = false) {
      if (busy) return;
      if (!leaving) take();
      if (!Object.keys(counts).length) return;
      if (now() - read().at < USAGE_GAP_MS) { if (leaving) stash(); return; }
      busy = true;
      const batch = counts, mine = epoch;
      counts = {};
      let ok = false;
      try { ok = await send(batch, leaving); } catch { ok = false; }
      busy = false;
      if (mine !== epoch) return;
      if (ok) return write({ ...read(), at: now() });
      for (const [k, n] of Object.entries(batch)) add(counts, k, n);
      if (leaving) stash();
    },
    /** Выход из аккаунта: неотправленное — выбросить, и из хранилища тоже (иначе уйдёт под ключом следующего). */
    drop() {
      epoch++;
      counts = {};
      write({ at: read().at, counts: {} });
    },
  };
}

/** Ответ сервера → что делать с пачкой: 200 — принято; 429 (чаще минуты) и сбой сети/сервера — прислать позже;
 *  401 (вышли) и 400 (испорченная пачка) — выбросить. */
export const usageSent = (status: number) => status === 200 || status === 401 || status === 400;

const sendUsage: UsageSend = async (counts, keepalive) => {
  const token = getToken();
  if (!token) return true;
  const res = await fetch("/api/events/usage", {
    method: "POST", keepalive,
    headers: { "Content-Type": "application/json", ...clientHeaders(), Authorization: `Bearer ${token}` },
    body: JSON.stringify({ client: "web", counts }),
  });
  return usageSent(res.status);
};
const browserKeep: UsageKeep = { load: () => localStorage.getItem(KEY), save: (v) => localStorage.setItem(KEY, v) };

let usage: ReturnType<typeof usageCounter> | null = null;
const counter = () => (usage ??= usageCounter(sendUsage, typeof localStorage === "undefined" ? undefined : browserKeep));

/** Ещё одно использование фичи сайта. */
export const track = (feature: string) => counter().track(feature);
/** Выход из аккаунта: последняя пачка, пока ключ ещё действует (ждём не дольше USAGE_LOGOUT_MS), остаток — выбросить. */
export async function logoutUsage() {
  const c = counter();
  let t: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([c.flush(true), new Promise((r) => (t = setTimeout(r, USAGE_LOGOUT_MS)))]);
  clearTimeout(t);
  c.drop();
}
/** Ключ уже не действует (401) — счёт выбросить. */
export const dropUsage = () => counter().drop();

/** Экран по адресу → фича: пункты меню, поиск и каталог; незнакомый адрес показывает «Сегодня». Прежний адрес (/widget,
 *  /maid…) — null: его тут же сменит новый, и экран посчитается по нему. */
const SCREENS = new Set([...NAV_TABS.map((t) => t.id), "search", "catalog"]);
export function screenFeature(path: string): string | null {
  if (oldPath(path)) return null;
  const { tab } = parsePath(path);
  return `screen.${SCREENS.has(tab) ? tab : "today"}`;
}

/** Раз в 10 минут и при уходе со страницы (вкладка скрыта, закрыта) — пачку на сервер. Возвращает «выключить». */
export function startUsage(): () => void {
  const c = counter();
  const timer = setInterval(() => void c.flush(), USAGE_FLUSH_MS);
  const hide = () => document.visibilityState === "hidden" && void c.flush(true);
  const leave = () => void c.flush(true);
  document.addEventListener("visibilitychange", hide);
  addEventListener("pagehide", leave);
  return () => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", hide);
    removeEventListener("pagehide", leave);
  };
}
