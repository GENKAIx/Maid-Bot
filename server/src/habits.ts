import type { HabitRow, MarkRow, Store, User } from "./db.ts";
import { esc } from "./report.ts";
import { addDays, dayKey, timeOf, weekdayOf } from "./time.ts";

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
  /** Когда отметили этот день (markTime): «ЧЧ:ММ» в поясе человека; at_day — день отметки, если задним числом. Нет отметки или
   *  минус в полночь — null. */
  at_time: string | null;
  at_day: string | null;
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

/** Когда отметили, в поясе человека (26.11.2026): at_time — «ЧЧ:ММ»; at_day — день отметки, только если он не день клетки
 *  (отметили задним числом: «отмечено 26 ноя в 10:02»), иначе null. Минус, поставленный сам в полночь, — без времени. */
export function markTime(m: Pick<MarkRow, "status" | "message_id" | "at" | "day_key"> | undefined, tz: string): { at_time: string | null; at_day: string | null } {
  if (!m || isAutoMinus(m)) return { at_time: null, at_day: null };
  const at = new Date(m.at);
  if (Number.isNaN(at.getTime())) return { at_time: null, at_day: null };
  const day = dayKey(at, tz);
  return { at_time: timeOf(at, tz), at_day: day === m.day_key ? null : day };
}

/** Завершённая привычка (26.11.2026) — единственное правило: идёт (status active) и её закончили вручную (finished_at) или срок
 *  прошёл (end_date раньше сегодня в поясе человека — со следующего дня после конца, само, без планировщика). Удалённые
 *  (stopped, deleted) — не завершённые: их нет нигде. */
export function habitFinished(h: Pick<HabitRow, "status" | "end_date" | "finished_at">, today: string): boolean {
  return h.status === "active" && (Boolean(h.finished_at) || (h.end_date != null && h.end_date < today));
}

/** Как было — для журнала отмены: «Отменить» возвращает всё (статус, название, срок, «закончена», время напоминаний). */
export const habitBefore = (h: HabitRow) => ({
  status: h.status, title: h.title, end_date: h.end_date, finished_at: h.finished_at ?? null, quiet: h.quiet ?? 0, times: h.times,
});

/** Закончить вручную (сайт, виджет, чат — одна логика): конец — сегодня, если сегодня уже отмечена, иначе вчера; не раньше начала
 *  и не позже прежнего конца. Уже завершённая или удалённая — null (ничего не менять: повтор не продлевает прошедший срок). */
export async function finishPatch(store: Store, h: HabitRow, today: string, now = new Date()): Promise<Pick<HabitRow, "end_date" | "finished_at"> | null> {
  if (h.status !== "active" || habitFinished(h, today)) return null;
  const marked = (await store.marksOf(h.user_id, today, today)).some((x) => x.habit_id === h.id);
  let end = marked ? today : addDays(today, -1);
  if (end < h.start_date) end = h.start_date;
  if (h.end_date && h.end_date < end) end = h.end_date;
  return { end_date: end, finished_at: now.toISOString() };
}

/** «↺ Вернуть»: снова идёт, без отметки «закончена»; срок, который уже прошёл (или закончили вручную), снимается — будущий конец
 *  курса остаётся. Удалённую тоже возвращает (status active). */
export function reopenPatch(h: HabitRow, today: string): Pick<HabitRow, "status" | "finished_at"> & { end_date?: null } {
  const ended = Boolean(h.finished_at) || (h.end_date != null && h.end_date < today);
  return { status: "active", finished_at: null, ...(ended ? { end_date: null } : {}) };
}

/** Почему этот день не отметить (null — можно): удалённая, после конца срока (завершённая), до начала. Старые кнопки в Telegram
 *  получают этот текст ответом, сайт — ошибкой 409. */
export function markRefusal(h: Pick<HabitRow, "status" | "start_date" | "end_date">, day: string): string | null {
  if (h.status !== "active") return "Этой привычки больше нет.";
  if (h.end_date && day > h.end_date) return "Эта привычка уже завершена.";
  if (day < h.start_date) return "Привычка тогда ещё не началась.";
  return null;
}


/** Что из привычек идёт в этот день, с отметками и сериями. */
export async function habitsOfDay(store: Store, u: User, day: string, today = dayKey(new Date(), u.tz)): Promise<HabitDay[]> {
  // Закончили вручную сегодня, уже отметив, — конец сегодня, но в списке сегодняшнего дня её больше нет: она в «Завершённых».
  // Прошлые дни (история /api/day) показывают её как была — с отметкой.
  const list = (await store.habitsOn(u.id, day))
    .filter((h) => dueOn(h, day) && !(day >= today && h.finished_at && dayKey(new Date(h.finished_at), u.tz) <= day));
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
      ...markTime(today, u.tz),
    };
  });
}

/** Сетка месяца для приложения: каждый день — запланирован ли, что и когда отмечено (at_time, at_day — markTime).
 *  Завершённые (habitFinished) в сетку не идут — они в finishedHabits. */
export async function habitMonth(store: Store, u: User, month: string, today = dayKey(new Date(), u.tz)) {
  const from = `${month}-01`;
  let to = from;
  while (addDays(to, 1).slice(0, 7) === month) to = addDays(to, 1);
  const habits = (await store.activeHabits(u.id)).filter((h) => !habitFinished(h, today));
  const marks = await store.marksOf(u.id, from, to);
  return habits.map((h) => {
    const days: { day: string; due: boolean; status: string | null; amount: number | null; unit: string; at_time: string | null; at_day: string | null }[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const m = marks.find((x) => x.habit_id === h.id && x.day_key === d);
      days.push({ day: d, due: dueOn(h, d), status: m?.status ?? null, amount: m?.amount == null ? null : Number(m.amount), unit: m?.unit ?? "", ...markTime(m, u.tz) });
    }
    return { ...h, times: timesOf(h), days };
  });
}

/** Карточка завершённой привычки (раздел «Завершённые» на сайте): done из planned — сделано из запланированного за весь срок
 *  [start_date, end_date], best — лучшая серия (считает habitStatsOf, как статистика). */
export interface FinishedHabit {
  id: number;
  title: string;
  start_date: string;
  end_date: string;
  finished_at: string | null;
  done: number;
  planned: number;
  best: number;
}

/** Все завершённые привычки человека, свежие (по концу срока) сверху. */
export async function finishedHabits(store: Store, u: User, today: string): Promise<FinishedHabit[]> {
  const list = (await store.activeHabits(u.id)).filter((h) => habitFinished(h, today));
  if (!list.length) return [];
  const cap = addDays(today, -1830);
  const first = list.reduce((m, h) => (h.start_date < m ? h.start_date : m), today);
  const marks = await store.marksOf(u.id, first < cap ? cap : first, today);
  return list.map((h) => {
    const own = marks.filter((m) => m.habit_id === h.id);
    const st = habitStatsOf(h, new Map(own.map((m) => [m.day_key, m.status] as const)), today);
    // Завершённая всегда со сроком: вручную он ставится (finishPatch), иначе она не завершена; запасной — сегодня.
    // Старые записи (виджет до 26.11.2026 не сверял с началом) бывают с концом раньше начала — конец не раньше начала.
    const end = h.end_date ?? today;
    return { id: h.id, title: h.title, start_date: h.start_date, end_date: end < h.start_date ? h.start_date : end, finished_at: h.finished_at ?? null, done: st.total.done, planned: st.total.planned, best: st.best };
  }).sort((a, b) => b.end_date.localeCompare(a.end_date) || b.id - a.id);
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

/** Клетка тепловой карты: done — сделано; miss — запланировано, прошло, не сделано (или «пропуск»); today — сегодня, ещё
 * не отмечено; wait — впереди; rest — не по расписанию; off — вне срока привычки (до начала или после конца). */
export type StatCell = "done" | "miss" | "today" | "wait" | "rest" | "off";
export interface HabitStats {
  id: number;
  title: string;
  start_date: string;
  end_date: string | null;
  /** Год клетками: с понедельника 52 недели назад по воскресенье этой недели. */
  year: { day: string; s: StatCell }[];
  streak: number;
  best: number;
  /** Сделано / запланировано (сегодня, ещё не отмеченное, не считается) — за 30 дней, 90 и за всё время. */
  rate30: { done: number; planned: number };
  rate90: { done: number; planned: number };
  total: { done: number; planned: number };
  /** По дням недели за всё время: 0 — понедельник … 6 — воскресенье. */
  weekdays: { done: number; planned: number }[];
  /** Последние 12 месяцев (с этим), ГГГГ-ММ. */
  months: { month: string; done: number; planned: number }[];
  /** Сколько сделано — если человек хоть раз называл число («прочитал 35 страниц»); суммы в единице последнего числа.
   *  week — с понедельника, month — с 1-го, best — лучший день, days — последние 30 дней (null — числа нет). */
  amount: { unit: string; week: number; month: number; total: number; best: { day: string; value: number }; days: { day: string; value: number | null }[] } | null;
}

/** Статистика привычки из её отметок. Удалённая или законченная — по своему расписанию, как будто активна. */
export function habitStatsOf(h: HabitRow, marks: Map<string, MarkRow["status"]>, today: string, amounts = new Map<string, { amount: number; unit: string }>()): HabitStats {
  const live = { ...h, status: "active" };
  const cell = (d: string): StatCell => {
    if (d < h.start_date || (h.end_date && d > h.end_date)) return "off";
    if (!dueOn(live, d)) return "rest";
    const m = marks.get(d);
    if (m === "done") return "done";
    if (d > today) return "wait";
    if (m === "skipped" || d < today) return "miss";
    return "today";
  };
  const weekStart = addDays(today, -(isoWeekday(today) - 1));
  const year: HabitStats["year"] = [];
  for (let d = addDays(weekStart, -52 * 7); d <= addDays(weekStart, 6); d = addDays(d, 1)) year.push({ day: d, s: cell(d) });

  const weekdays = Array.from({ length: 7 }, () => ({ done: 0, planned: 0 }));
  const months = new Map<string, { done: number; planned: number }>();
  const [ty, tm] = today.slice(0, 7).split("-").map(Number);
  for (let i = 11; i >= 0; i--) months.set(new Date(Date.UTC(ty, tm - 1 - i, 1)).toISOString().slice(0, 7), { done: 0, planned: 0 });
  const total = { done: 0, planned: 0 };
  const rate30 = { done: 0, planned: 0 };
  const rate90 = { done: 0, planned: 0 };
  let best = 0;
  let run = 0;
  const last = h.end_date && h.end_date < today ? h.end_date : today;
  // Не дальше ~5 лет назад — на случай очень старой даты начала.
  for (let d = h.start_date < addDays(today, -1830) ? addDays(today, -1830) : h.start_date; d <= last; d = addDays(d, 1)) {
    const s = cell(d);
    if (s !== "done" && s !== "miss") continue; // today (ещё не отмечено) — не в счёт
    const ok = s === "done" ? 1 : 0;
    run = ok ? run + 1 : 0;
    best = Math.max(best, run);
    total.done += ok; total.planned++;
    const w = weekdays[isoWeekday(d) - 1];
    w.done += ok; w.planned++;
    const mo = months.get(d.slice(0, 7));
    if (mo) { mo.done += ok; mo.planned++; }
    if (d > addDays(today, -30)) { rate30.done += ok; rate30.planned++; }
    if (d > addDays(today, -90)) { rate90.done += ok; rate90.planned++; }
  }
  const done = new Set([...marks].filter(([, s]) => s === "done").map(([d]) => d));
  return {
    id: h.id, title: h.title, start_date: h.start_date, end_date: h.end_date, year,
    streak: streak(live, done, today), best, rate30, rate90, total, weekdays,
    months: [...months].map(([month, v]) => ({ month, ...v })),
    amount: amountStats(amounts, today),
  };
}

function amountStats(amounts: Map<string, { amount: number; unit: string }>, today: string): HabitStats["amount"] {
  const all = [...amounts].filter(([d]) => d <= today).sort(([a], [b]) => a.localeCompare(b));
  if (!all.length) return null;
  const unit = all.at(-1)![1].unit;
  const mine = new Map(all.filter(([, v]) => v.unit === unit).map(([d, v]) => [d, v.amount] as const));
  const sum = (from: string) => [...mine].filter(([d]) => d >= from).reduce((a, [, v]) => a + v, 0);
  let best = { day: "", value: 0 };
  for (const [day, value] of mine) if (value > best.value) best = { day, value };
  const days: { day: string; value: number | null }[] = [];
  for (let d = addDays(today, -29); d <= today; d = addDays(d, 1)) days.push({ day: d, value: mine.get(d) ?? null });
  return { unit, week: sum(addDays(today, -(isoWeekday(today) - 1))), month: sum(`${today.slice(0, 7)}-01`), total: sum(""), best, days };
}

/** «Во сколько отмечали» (26.11.2026) — график под «По дням недели» / «По месяцам». Окно — последние 30 дней срока: у идущей —
 *  по сегодня, у законченной — по конец срока (не раньше начала). points — дни со «сделал», по порядку: time «ЧЧ:ММ» и min (минут с
 *  полуночи) в поясе человека; пропуски, минус в полночь и отмеченные задним числом (время другого дня ничего не говорит) — не идут.
 *  gap — между этой точкой и прошлой был день по расписанию без такой отметки: линия на нём рвётся. remind — время напоминаний,
 *  как у 🔔 на странице: своё время привычки, нет своего — общее из настроек (habit_first), «без напоминаний» — пусто. */
export interface MarkTimes {
  from: string;
  to: string;
  points: { day: string; time: string; min: number; gap: boolean }[];
  remind: string[];
}

export function markTimesOf(h: HabitRow, marks: MarkRow[], today: string, tz: string, first: string): MarkTimes {
  const to = h.end_date && h.end_date < today ? h.end_date : today;
  const back = addDays(to, -29);
  const from = back < h.start_date ? (h.start_date < to ? h.start_date : to) : back;
  const byDay = new Map(marks.filter((m) => m.habit_id === h.id).map((m) => [m.day_key, m] as const));
  const live = { ...h, status: "active" };
  const points: MarkTimes["points"] = [];
  let gap = false;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const m = byDay.get(d);
    const t = m?.status === "done" ? markTime(m, tz) : null;
    if (t?.at_time && !t.at_day) {
      const [hh, mm] = t.at_time.split(":").map(Number);
      points.push({ day: d, time: t.at_time, min: hh * 60 + mm, gap: points.length > 0 && gap });
      gap = false;
    } else if (dueOn(live, d) && d < today) gap = true; // сегодня, ещё не отмеченное, линию не рвёт
  }
  const remind = h.quiet ? [] : timesOf(h).length ? [...timesOf(h)].sort() : [first];
  return { from, to, points, remind };
}

export async function habitStats(store: Store, u: User, h: HabitRow, today: string): Promise<HabitStats & { mark_times: MarkTimes }> {
  const from = h.start_date < addDays(today, -1830) ? addDays(today, -1830) : h.start_date;
  const yearFrom = addDays(today, -380);
  const marks = (await store.marksOf(u.id, from < yearFrom ? from : yearFrom, addDays(today, 7))).filter((m) => m.habit_id === h.id);
  const amounts = new Map(marks.filter((m) => m.amount != null).map((m) => [m.day_key, { amount: Number(m.amount), unit: m.unit ?? "" }] as const));
  return {
    ...habitStatsOf(h, new Map(marks.map((m) => [m.day_key, m.status] as const)), today, amounts),
    mark_times: markTimesOf(h, marks, today, u.tz, u.habit_first),
  };
}
