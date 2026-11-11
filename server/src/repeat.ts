import { z } from "zod";
import type { EventRow, Store, User } from "./db.ts";
import { planEventReminders } from "./scheduler.ts";
import { addDays } from "./time.ts";

// Повтор плана (ПКМ по плану в виджете → «Повторять…» → окно настройки). Серия — первый план с repeat и его копии с series = его id.
// repeat — JSON настройки: kind (день, неделя, месяц), every (каждые N), days (дни недели для «недели», 0 — воскресенье),
// count (сколько всего раз вместе с первым) или until (последний день); ни того ни другого — без конца.
// Без конца копии создаются заранее на HORIZON дней вперёд и дальше раз в день досоздаются (Scheduler); с концом — сразу все.
// У каждой копии свой статус (отменить одно занятие — не трогать остальные). До какой даты серия уже разложена — в kv,
// чтобы перенесённую копию не создать заново на старом месте.

const MAX_COUNT = 100;
export const RepeatSpec = z.object({
  kind: z.enum(["day", "week", "month"]),
  every: z.number().int().min(1).max(12).default(1),
  days: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  count: z.number().int().min(2).max(MAX_COUNT).nullable().optional(),
  until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});
export type RepeatSpec = z.infer<typeof RepeatSpec>;
/** Насколько вперёд раскладывать серию без конца. */
export const HORIZON = 56;
/** Серия с концом — не дальше двух лет. */
const FAR = 730;

/** Старые значения repeat (до окна настройки) и JSON → настройка; '' — не повторяется. */
export function specOf(repeat: string | undefined, start: string): RepeatSpec | null {
  if (!repeat) return null;
  const dow = weekday(start);
  switch (repeat) {
    case "daily": return { kind: "day", every: 1 };
    case "weekdays": return { kind: "week", every: 1, days: [1, 2, 3, 4, 5] };
    case "weekly": return { kind: "week", every: 1, days: [dow] };
    case "biweekly": return { kind: "week", every: 2, days: [dow] };
    case "monthly": return { kind: "month", every: 1 };
  }
  try {
    return RepeatSpec.parse(JSON.parse(repeat));
  } catch {
    return null;
  }
}

const weekday = (day: string) => new Date(`${day}T12:00:00Z`).getUTCDay();
const lastOfMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const pad = (n: number) => String(n).padStart(2, "0");

/** Все даты серии после start по порядку до last (включая); start — первый план, он сам не входит. Учитывает count и until. */
export function seriesDates(start: string, spec: RepeatSpec, last: string): string[] {
  const out: string[] = [];
  const end = spec.until && spec.until < last ? spec.until : last;
  const room = spec.count ? spec.count - 1 : Infinity;
  if (spec.kind === "month") {
    const [y0, m0, d0] = start.split("-").map(Number);
    for (let i = spec.every; out.length < room; i += spec.every) {
      const y = y0 + Math.floor((m0 - 1 + i) / 12);
      const m = ((m0 - 1 + i) % 12) + 1;
      // 31-е в коротком месяце — последний день месяца.
      const day = `${y}-${pad(m)}-${pad(Math.min(d0, lastOfMonth(y, m)))}`;
      if (day > end) break;
      out.push(day);
    }
    return out;
  }
  if (spec.kind === "day") {
    for (let day = addDays(start, spec.every); day <= end && out.length < room; day = addDays(day, spec.every)) out.push(day);
    return out;
  }
  // Неделя: дни недели в каждой every-й неделе, считая от недели первого плана (неделя — с понедельника).
  const days = new Set(spec.days?.length ? spec.days : [weekday(start)]);
  const monday = addDays(start, -((weekday(start) + 6) % 7));
  for (let day = addDays(start, 1); day <= end && out.length < room; day = addDays(day, 1)) {
    const week = Math.floor((Date.parse(day) - Date.parse(monday)) / (7 * 864e5));
    if (week % spec.every === 0 && days.has(weekday(day))) out.push(day);
  }
  return out;
}

const laidKey = (id: number) => `series:${id}:laid`;

/** Досоздать копии серии: без конца — до today + HORIZON, с концом — до конца. Возвращает созданные даты. */
export async function extendSeries(store: Store, u: User, head: EventRow, today: string, now = new Date()): Promise<string[]> {
  const spec = specOf(head.repeat, head.date_iso);
  if (!spec || head.status === "deleted" || head.status === "purged") return [];
  const finite = Boolean(spec.count || spec.until);
  const until = finite ? addDays(head.date_iso, FAR) : addDays(today, HORIZON);
  const laid = (await store.kvGet(laidKey(head.id))) ?? head.date_iso;
  if (laid >= until) return [];
  const made: string[] = [];
  for (const day of seriesDates(head.date_iso, spec, until)) {
    if (day <= laid) continue;
    const id = await store.addEvent({
      user_id: u.id, title: head.title, date_iso: day, time: head.time, end_time: head.end_time, details: head.details,
      domain: head.domain, message_id: null, series: head.id,
    });
    await planEventReminders(store, u, (await store.event(id))!, now);
    made.push(day);
  }
  await store.kvSet(laidKey(head.id), until);
  return made;
}

/**
 * Сделать план повторяющимся (или перестать: spec = null). План становится началом серии: будущие активные копии старой серии
 * после него убираются, новые раскладываются заново. Прошлые и уже отмеченные занятия остаются как были.
 */
export async function setRepeat(store: Store, u: User, e: EventRow, spec: RepeatSpec | null, today: string, now = new Date()) {
  const oldHead = e.series ?? (e.repeat ? e.id : null);
  let removed = 0;
  if (oldHead !== null) {
    for (const x of await store.allEvents(u.id)) {
      const inSeries = x.series === oldHead || x.id === oldHead;
      if (!inSeries || x.id === e.id || x.date_iso <= e.date_iso || x.status !== "active") continue;
      await store.updateEvent(x.id, { status: "deleted" });
      await store.cancelReminders("event", x.id);
      removed++;
    }
    // Старое начало серии (если это не сам план) больше не продолжает серию.
    if (oldHead !== e.id) await store.updateEvent(oldHead, { repeat: "" });
  }
  await store.updateEvent(e.id, { repeat: spec ? JSON.stringify(spec) : "", series: null });
  await store.kvSet(laidKey(e.id), e.date_iso);
  const head = (await store.event(e.id))!;
  const dates = spec ? await extendSeries(store, u, head, today, now) : [];
  return { event: head, dates, made: dates.length, removed, endless: Boolean(spec && !spec.count && !spec.until) };
}
