import { shortDay, todayKey } from "./format";

// Корзина (screens/Trash.tsx, 27.11.2026 — дизайн v2): сколько записи ещё лежать, подпись «удалится через N дней»,
// полоска срока и самая срочная запись для строки Рины. Сервер держит удалённое TRASH_DAYS дней, считая от времени удаления.

const DAY = 86_400_000;

/** «день / дня / дней» по числу. */
export function daysWord(n: number) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a >= 11 && a <= 14) return "дней";
  if (b === 1) return "день";
  if (b >= 2 && b <= 4) return "дня";
  return "дней";
}

/** Сколько ещё пролежит: целые дни вверх (не меньше 1) и доля оставшегося срока 0…1 для полоски. Без даты — null. */
export function trashLeft(iso: string | null, days: number, now = Date.now()): { n: number; part: number } | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() + days * DAY - now;
  return { n: Math.max(1, Math.ceil(ms / DAY)), part: days > 0 ? Math.min(1, Math.max(0, ms / (days * DAY))) : 0 };
}

/** Подпись срока: «удалится в течение суток», «удалится завтра», «удалится через 12 дней». */
export function leftText(n: number) {
  if (n <= 1) return "удалится в течение суток";
  if (n === 2) return "удалится завтра";
  return `удалится через ${n} ${daysWord(n)}`;
}

/** Меньше 3 дней до исчезновения — пора предупредить (красная полоска, строка Рины). */
export const soon = (n: number) => n <= 3;

/** Когда удалено: «сегодня 14:05», «вчера», «8 ноя». */
export function deletedWhen(iso: string | null, now = new Date()) {
  if (!iso) return "";
  const d = new Date(iso);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const ago = Math.round((day(now) - day(d)) / DAY);
  if (ago === 0) return `сегодня ${d.toTimeString().slice(0, 5)}`;
  if (ago === 1) return "вчера";
  return shortDay(todayKey(d));
}

/** Самая срочная запись (меньше всего осталось), если ей осталось не больше 3 дней, — для строки Рины. */
export function soonest<T extends { title: string; at: string | null }>(items: T[], days: number, now = Date.now()): (T & { n: number }) | null {
  let best: (T & { n: number }) | null = null;
  for (const x of items) {
    const l = trashLeft(x.at, days, now);
    if (l && soon(l.n) && (!best || new Date(x.at!).getTime() < new Date(best.at!).getTime())) best = { ...x, n: l.n };
  }
  return best;
}

/** Строка Рины про самую срочную запись. */
export function soonestText(n: number) {
  return n <= 1 ? "сотрётся уже в течение суток" : n === 2 ? "сотрётся уже завтра" : `сотрётся через ${n} ${daysWord(n)}`;
}
