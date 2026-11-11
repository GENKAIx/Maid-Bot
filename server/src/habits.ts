import type { HabitRow, MarkRow, Store, User } from "./db.ts";
import { esc } from "./report.ts";
import { addDays, weekdayOf } from "./time.ts";

// Привычки: расписание (дни недели, время напоминаний, срок), отметки по дням и серии.

/** 1 — понедельник … 7 — воскресенье. */
export const isoWeekday = (day: string) => weekdayOf(day) || 7;

export function dueOn(h: HabitRow, day: string): boolean {
  return h.status === "active" && day >= h.start_date && (!h.end_date || day <= h.end_date) && h.days.includes(String(isoWeekday(day)));
}

export function timesOf(h: HabitRow): string[] {
  try {
    const t = JSON.parse(h.times);
    return Array.isArray(t) ? t.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Серия: сколько запланированных дней подряд сделано. Несделанное сегодня серию ещё не рвёт. */
export function streak(h: HabitRow, done: Set<string>, today: string): number {
  let n = 0;
  let day = today;
  if (dueOn(h, day) && !done.has(day)) day = addDays(day, -1);
  for (let i = 0; i < 800 && day >= h.start_date; i++, day = addDays(day, -1)) {
    if (!dueOn({ ...h, status: "active" }, day)) continue;
    if (!done.has(day)) break;
    n++;
  }
  return n;
}

export interface HabitDay {
  habit: HabitRow;
  times: string[];
  status: MarkRow["status"] | null;
  streak: number;
  /** Сделано из запланированного за срок (или за 30 дней, если срока нет). */
  doneDays: number;
  plannedDays: number;
  /** Курс со сроком («каждый день месяц»): каждый день срока. Прошедший день без «сделал» — промах. */
  course: CourseDay[] | null;
  /** Вчера по расписанию и не отмечено «сделал» — «none» (можно спасти задним числом), иначе его отметка; не по расписанию — null. */
  yesterday: "done" | "skipped" | "none" | null;
}

/** done — сделано; miss — прошёл без отметки или «пропуск»; today — сегодня, ещё не отмечено; wait — впереди; rest — не по расписанию. */
export interface CourseDay {
  day: string;
  s: "done" | "miss" | "today" | "wait" | "rest";
}

/** Не больше ~3 месяцев: длиннее — это уже не курс, а привычка, плашка с днями не нужна. */
export const COURSE_MAX_DAYS = 92;

export function courseDays(h: HabitRow, marks: Map<string, MarkRow["status"]>, today: string): CourseDay[] | null {
  if (!h.end_date) return null;
  const out: CourseDay[] = [];
  for (let d = h.start_date; d <= h.end_date && out.length <= COURSE_MAX_DAYS; d = addDays(d, 1)) {
    const m = marks.get(d);
    const s: CourseDay["s"] = !dueOn({ ...h, status: "active" }, d) ? "rest"
      : m === "done" ? "done"
      : m === "skipped" ? "miss"
      : d < today ? "miss"
      : d === today ? "today"
      : "wait";
    out.push({ day: d, s });
  }
  return out.length > COURSE_MAX_DAYS ? null : out;
}

function yesterdayOf(h: HabitRow, own: MarkRow[], day: string): HabitDay["yesterday"] {
  const y = addDays(day, -1);
  if (y < h.start_date || !dueOn({ ...h, status: "active" }, y)) return null;
  const m = own.find((x) => x.day_key === y);
  // Минус, поставленный сам в полночь (без сообщения, autoMinus), — как «не отмечено»: вчера ещё можно спасти.
  return !m || isAutoMinus(m) ? "none" : m.status;
}

/** Минус за день без ответа ставит планировщик в полночь — отметка без сообщения. */
export const isAutoMinus = (m: Pick<MarkRow, "status" | "message_id">) => m.status === "skipped" && m.message_id === null;


/** Что из привычек идёт в этот день, с отметками и сериями. */
export async function habitsOfDay(store: Store, u: User, day: string): Promise<HabitDay[]> {
  const list = (await store.habitsOn(u.id, day)).filter((h) => dueOn(h, day));
  if (!list.length) return [];
  const from = list.reduce((m, h) => (h.start_date < m ? h.start_date : m), day);
  const marks = await store.marksOf(u.id, addDays(from, -1), day);
  return list.map((h) => {
    const own = marks.filter((m) => m.habit_id === h.id);
    const done = new Set(own.filter((m) => m.status === "done").map((m) => m.day_key));
    const today = own.find((m) => m.day_key === day);
    const byDay = new Map(own.map((m) => [m.day_key, m.status] as const));
    const end = h.end_date ?? day;
    let planned = 0;
    for (let d = h.end_date ? h.start_date : addDays(day, -29); d <= end; d = addDays(d, 1)) if (dueOn(h, d)) planned++;
    return {
      habit: h,
      times: timesOf(h),
      status: today?.status ?? null,
      streak: streak(h, done, day),
      doneDays: [...done].filter((d) => d <= end && (h.end_date || d > addDays(day, -30))).length,
      plannedDays: planned,
      course: courseDays(h, byDay, day),
      yesterday: yesterdayOf(h, own, day),
    };
  });
}

/** Сетка месяца для приложения: каждый день — запланирован ли и что отмечено. */
export async function habitMonth(store: Store, u: User, month: string) {
  const from = `${month}-01`;
  let to = from;
  while (addDays(to, 1).slice(0, 7) === month) to = addDays(to, 1);
  const habits = await store.activeHabits(u.id);
  const marks = await store.marksOf(u.id, from, to);
  return habits.map((h) => {
    const days: { day: string; due: boolean; status: string | null }[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      days.push({ day: d, due: dueOn(h, d), status: marks.find((m) => m.habit_id === h.id && m.day_key === d)?.status ?? null });
    }
    return { ...h, times: timesOf(h), days };
  });
}

export function habitLine(d: HabitDay): string {
  const mark = d.status === "done" ? "✅" : d.status === "skipped" ? "➖" : "⬜";
  const at = d.times.length ? ` <i>${d.times.join(", ")}</i>` : "";
  const fire = d.streak >= 2 ? ` 🔥${d.streak}` : "";
  return `${mark} ${esc(d.habit.title)}${at}${fire}`;
}

const WEEK = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];
export function scheduleText(h: Pick<HabitRow, "days" | "start_date" | "end_date">): string {
  const days = h.days === "1234567" ? "каждый день" : h.days.split("").map((c) => WEEK[Number(c) - 1]).join(", ");
  return `${days}${h.end_date ? `, до ${h.end_date}` : ""}`;
}
