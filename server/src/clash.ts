import type { EventRow, Store } from "./db.ts";

// План лёг на занятое время: горничная спрашивает «Сдвинуть на 15:00?» кнопками «Сдвинуть» / «Оставить».
// Только предупреждение: оба плана уже записаны, молчание или «Оставить» — всё как есть, и про эту пару больше не спрашивает.
// Правила наложения — те же, что у виджета (desktop/renderer/clock.js clashOf): промежутки перекрываются, точка внутри
// промежутка или две точки в одно время; встык (14:00–15:00 и 15:00) — не наложение.

/** Сдвиг после плана без конца: столько минут считаем его длиной. */
export const POINT_MINUTES = 60;

/** Что спросить: план eventId (новый или перенесённый) лёг на withId. shiftTo — куда сдвинуть, null — до конца дня некуда. */
export interface Clash {
  eventId: number;
  title: string;
  withId: number;
  withTitle: string;
  /** Время занятого плана: «14:00–15:00» или «14:00». */
  span: string;
  shiftTo: string | null;
}

const mins = (t: string | null | undefined) => {
  const m = t?.match(/^(\d{1,2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const hhmm = (n: number) => `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
/** [начало, конец] в минутах; у плана без конца конец = начало. null — без времени. */
const range = (e: Pick<EventRow, "time" | "end_time">): [number, number] | null => {
  const s = mins(e.time);
  if (s === null) return null;
  const end = mins(e.end_time);
  return [s, end !== null && end > s ? end : s];
};

/** Накладываются ли два плана по времени (на одном дне). */
export function overlaps(a: Pick<EventRow, "time" | "end_time">, b: Pick<EventRow, "time" | "end_time">): boolean {
  const ra = range(a), rb = range(b);
  if (!ra || !rb) return false;
  const [s, ae] = ra, [bs, be] = rb;
  if (ae === s && be === bs) return s === bs;
  if (ae === s) return s >= bs && s < be;
  if (be === bs) return bs >= s && bs < ae;
  return s < be && bs < ae;
}

/** Куда сдвинуть план, чтобы ни на что не ложиться: сразу после конца того, на что лёг, и так дальше. null — за полночь. */
export function shiftTime(e: Pick<EventRow, "id" | "time" | "end_time">, day: Pick<EventRow, "id" | "time" | "end_time">[]): { time: string; end: string | null } | null {
  const r = range(e);
  if (!r) return null;
  const len = r[1] - r[0];
  let start = r[0];
  for (let guard = 0; guard < 50; guard++) {
    const at = { time: hhmm(start), end_time: len ? hhmm(start + len) : null };
    const hit = day.find((b) => b.id !== e.id && overlaps(at, b));
    if (!hit) return start === r[0] ? null : { time: at.time, end: at.end_time };
    const [bs, be] = range(hit)!;
    start = Math.max(start + 1, be > bs ? be : bs + POINT_MINUTES);
    if (start + len > 23 * 60 + 59) return null;
  }
  return null;
}

const spanOf = (e: Pick<EventRow, "time" | "end_time">) => {
  const r = range(e)!;
  return r[1] > r[0] ? `${hhmm(r[0])}–${hhmm(r[1])}` : hhmm(r[0]);
};
const pairKey = (a: number, b: number) => (a < b ? [a, b] : [b, a]) as [number, number];

/** Первое наложение у планов ids (только что записанных или перенесённых). Пары внутри ids не считаются —
 *  два плана в одно время одним сообщением сказаны нарочно. «Оставить» прежде — пара не спрашивается. */
export async function findClash(s: Store, userId: number, ids: number[]): Promise<Clash | null> {
  for (const id of ids) {
    const e = await s.event(id);
    if (!e || e.user_id !== userId || e.status !== "active" || !range(e)) continue;
    const day = (await s.eventsBetween(userId, e.date_iso, e.date_iso)).filter((x) => range(x));
    for (const b of day) {
      if (b.id === e.id || ids.includes(b.id) || !overlaps(e, b)) continue;
      if (await s.clashKept(userId, ...pairKey(e.id, b.id))) continue;
      const to = shiftTime(e, day);
      return { eventId: e.id, title: e.title, withId: b.id, withTitle: b.title, span: spanOf(b), shiftTo: to?.time ?? null };
    }
  }
  return null;
}

/** Строка вопроса в ответе горничной (HTML, как весь ответ). */
export const clashLine = (c: Clash, esc: (t: string) => string) =>
  `⚠ В ${c.span} у тебя уже «${esc(c.withTitle)}».${c.shiftTo ? ` Сдвинуть «${esc(c.title)}» на ${c.shiftTo}?` : ""}`;

export const keepPair = (s: Store, userId: number, a: number, b: number) => s.keepClash(userId, ...pairKey(a, b));
