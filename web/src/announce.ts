// Объявления владельца на сайте (этап 6 «Тарифы и управление», 24.11.2026; сервер — server/src/announce.ts, GET /api/announcements):
// плашка над экраном с крестиком. Закрытое запоминается на этом устройстве (localStorage; нет хранилища — плашка просто вернётся
// при следующей загрузке, сайт от этого не ломается). «Написать нам» и промокод — тут же: короткие помощники для «Настроек».

export interface News { id: number; text: string }
export const NEWS_KEY = "maid.newsClosed";
/** Больше закрытых не храним (старые объявления всё равно выключат). */
const KEEP = 50;

export function closedNews(): number[] {
  try {
    const v = JSON.parse(localStorage.getItem(NEWS_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is number => Number.isInteger(x)) : [];
  } catch {
    return [];
  }
}
export function closeNews(id: number): void {
  try {
    localStorage.setItem(NEWS_KEY, JSON.stringify([...closedNews().filter((x) => x !== id), id].slice(-KEEP)));
  } catch {
    /* нет хранилища — закроется до перезагрузки */
  }
}
/** Что показать: не закрытые на этом устройстве, старые сверху. */
export const visibleNews = (items: News[], closed: number[]): News[] => items.filter((n) => !closed.includes(n.id)).sort((a, b) => a.id - b.id);

/** Обращения человека: статусы его словами (server/src/support.ts). */
export const MY_TICKET_STATUS: Record<string, string> = { new: "получено", work: "в работе", closed: "закрыто" };

/** Промокод из поля: заглавными, без пробелов; null — так код не выглядит (как на сервере promo.ts PROMO_RE). */
export function promoInput(v: string): string | null {
  const c = v.trim().toUpperCase().replace(/\s+/g, "");
  return /^[A-Z0-9-]{4,20}$/.test(c) ? c : null;
}
