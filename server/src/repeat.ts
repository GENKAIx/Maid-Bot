import type { EventRow, Store, User } from "./db.ts";
import { planEventReminders } from "./scheduler.ts";
import { addDays } from "./time.ts";

// Повтор плана (ПКМ по плану в виджете → «Каждую неделю» …). Серия — первый план с repeat и его копии с series = его id.
// Копии создаются заранее на HORIZON дней вперёд и дальше раз в день досоздаются (Scheduler): у каждой копии свой статус
// (отменить одно занятие — не трогать остальные). До какой даты серия уже разложена — в kv, чтобы перенесённую копию
// не создать заново на старом месте.

export const REPEATS = ["daily", "weekdays", "weekly", "biweekly", "monthly"] as const;
export type Repeat = (typeof REPEATS)[number];
/** Насколько вперёд раскладывать серию. */
export const HORIZON = 56;

const weekday = (day: string) => new Date(`${day}T12:00:00Z`).getUTCDay();
const lastOfMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Даты серии после from (не включая) до until (включая); start — первый день серии (от него считаются недели и число месяца). */
export function repeatDates(start: string, kind: Repeat, from: string, until: string): string[] {
  const out: string[] = [];
  if (kind === "monthly") {
    const [y0, m0, d0] = start.split("-").map(Number);
    for (let i = 1; i < 400; i++) {
      const y = y0 + Math.floor((m0 - 1 + i) / 12);
      const m = ((m0 - 1 + i) % 12) + 1;
      // 31-е в коротком месяце — последний день месяца.
      const day = `${y}-${String(m).padStart(2, "0")}-${String(Math.min(d0, lastOfMonth(y, m))).padStart(2, "0")}`;
      if (day > until) break;
      if (day > from) out.push(day);
    }
    return out;
  }
  const step = kind === "weekly" ? 7 : kind === "biweekly" ? 14 : 1;
  for (let day = addDays(start, step); day <= until; day = addDays(day, step)) {
    if (day <= from) continue;
    if (kind === "weekdays" && [0, 6].includes(weekday(day))) continue;
    out.push(day);
  }
  return out;
}

const laidKey = (id: number) => `series:${id}:laid`;

/** Досоздать копии серии до today + HORIZON. Возвращает, сколько создано. */
export async function extendSeries(store: Store, u: User, head: EventRow, today: string, now = new Date()): Promise<number> {
  if (!head.repeat || head.status === "deleted") return 0;
  const until = addDays(today, HORIZON);
  const laid = (await store.kvGet(laidKey(head.id))) ?? head.date_iso;
  if (laid >= until) return 0;
  let made = 0;
  for (const day of repeatDates(head.date_iso, head.repeat as Repeat, laid, until)) {
    const id = await store.addEvent({
      user_id: u.id, title: head.title, date_iso: day, time: head.time, end_time: head.end_time, details: head.details,
      domain: head.domain, message_id: null, series: head.id,
    });
    await planEventReminders(store, u, (await store.event(id))!, now);
    made++;
  }
  await store.kvSet(laidKey(head.id), until);
  return made;
}

/**
 * Сделать план повторяющимся (или перестать: kind = ""). План становится началом серии: будущие активные копии старой серии
 * после него убираются, новые раскладываются заново. Прошлые и уже отмеченные занятия остаются как были.
 */
export async function setRepeat(store: Store, u: User, e: EventRow, kind: Repeat | "", today: string, now = new Date()) {
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
  await store.updateEvent(e.id, { repeat: kind, series: null });
  await store.kvSet(laidKey(e.id), e.date_iso);
  const head = (await store.event(e.id))!;
  const made = kind ? await extendSeries(store, u, head, today, now) : 0;
  return { event: head, made, removed };
}
