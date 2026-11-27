import { MONTHS_GEN, addDays } from "./format";
import { daysBetween } from "./habitview";
import { hhmm, medianMin } from "./timechart";
import type { HabitStats, MarkTimes } from "./types";

// Чистые расчёты раскрытой привычки на странице «Привычки» (27.11.2026, макет «Привычки: месяц сеткой»):
// клетки ×N, отрезок графика «Во сколько отмечали» и рамка обзора, серия и вехи, сутки, дни недели, год по месяцам,
// отклик на напоминание, ритм дня у ×N, наблюдение Рины. Только по данным сервера — чисел не выдумываем: мало данных — null.
// Проверка — web/test/habit-panel.test.ts.

export type MarkPoint = MarkTimes["points"][number];

export function plural(n: number, one: string, few: string, many: string): string {
  const m = n % 10, h = n % 100;
  return m === 1 && h !== 11 ? one : m >= 2 && m <= 4 && (h < 12 || h > 14) ? few : many;
}
export const daysText = (n: number) => `${n} ${plural(n, "день", "дня", "дней")}`;
export const timesText = (n: number) => `${n} ${plural(n, "раз", "раза", "раз")}`;
export const marksText = (n: number) => `${n} ${plural(n, "отметка", "отметки", "отметок")}`;
/** Минуты → «40 мин», «1 ч 5 мин», «2 ч». */
export function durText(min: number): string {
  const m = Math.round(Math.abs(min)), h = Math.floor(m / 60), x = m % 60;
  return h ? `${h} ч${x ? ` ${x} мин` : ""}` : `${x} мин`;
}
const isoWd = (day: string) => new Date(Date.parse(`${day}T12:00:00Z`)).getUTCDay() || 7;
/** День по расписанию «1234567» (1 — понедельник). */
export const dueByDays = (days: string, day: string) => days.includes(String(isoWd(day)));
const WD_LONG = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
/** «Чт, 26 ноября» (год — если не этот). */
export function dayName(day: string, thisYear: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return `${WD_LONG[isoWd(day) - 1]}, ${d} ${MONTHS_GEN[m - 1]}${y !== thisYear ? ` ${y}` : ""}`;
}

// ── сетка месяца ──

/** Огонёк серии взрослеет по длине: 0 — до 7 дней (приглушённый), 1 — с 7 (тёплый), 2 — с 30 (синий), 3 — со 100 (золотой). */
export const fireTier = (streak: number) => (streak >= 100 ? 3 : streak >= 30 ? 2 : streak >= 7 ? 1 : 0);

/** Подпись нормы у ×N: «8 раз в день»; у обычной привычки — пусто. Единицу из слов человека («стр.», «км») сюда не берём:
 *  per_day — число отметок, а не страниц. */
export function perDayText(perDay: number): string {
  return perDay <= 1 ? "" : `${timesText(perDay)} в день`;
}

export interface GridDay { day: string; due: boolean; status: string | null; count?: number; need?: number }
/** Состояние клетки: done — сделано, skip — пропуск, part — отмечено не всё (count < need), empty — по расписанию, без отметки,
 *  rest — не по расписанию, future — впереди, off — до начала привычки. */
export type CellKind = "done" | "skip" | "part" | "empty" | "rest" | "future" | "off";
export function cellKind(x: GridDay, today: string, start: string): CellKind {
  if (x.day < start) return "off";
  if (x.status === "done") return "done";
  if (x.status === "skipped") return "skip";
  if ((x.count ?? 0) > 0) return "part";
  if (x.day > today) return "future";
  return x.due ? "empty" : "rest";
}
/** Доля заливки снизу у ×N: 5 из 8 — 0,625; сделано — 1. */
export const cellFill = (x: GridDay) => (x.status === "done" ? 1 : x.status === "skipped" ? 0 : Math.min(1, (x.count ?? 0) / Math.max(1, x.need ?? 1)));

/** Что шлёт щелчок по клетке (POST /api/habits/:id/mark). Обычная: пусто → сделал → пропуск → сделал …;
 *  ×N: всегда ещё одна отметка (step 1; на полной сервер ответит «уже отмечено N/N», с пропуска — первая отметка). В пропуск
 *  щелчок ×N не превращается: пропуск стёр бы времена всех отметок дня — он только кнопкой в панели. */
export function clickMark(x: { status: string | null; need?: number }): { status: "done" | "skipped" } | { step: 1 } {
  if ((x.need ?? 1) <= 1) return { status: x.status === "done" ? "skipped" : "done" };
  return { step: 1 };
}

/** Итог месяца по строке: сделано из запланированного до сегодня. Сегодня, ещё не сделанное, в счёт не идёт. */
export function monthTally(days: GridDay[], today: string): { done: number; due: number } {
  let done = 0, due = 0;
  for (const x of days) {
    if (x.day > today) continue;
    const ok = x.status === "done";
    if (ok || (x.due && x.day < today)) { due++; if (ok) done++; }
  }
  return { done, due };
}

// ── отрезок графика и рамка обзора ──

/** Отрезок — индексы дней от начала окна (0 — первый день привычки), включительно. */
export interface Span { a: number; b: number }
export const PRESETS: [number, string][] = [[7, "7 дней"], [30, "30 дней"], [90, "3 месяца"], [365, "Год"], [0, "Всё"]];
/** Отрезок кнопкой: последние v дней (0 — всё) из total. */
export const presetSpan = (total: number, v: number): Span => ({ a: v ? Math.max(0, total - v) : 0, b: Math.max(0, total - 1) });
/** Отрезок не короче 3 дней и внутри окна. */
export function fixSpan(s: Span, total: number): Span {
  const last = Math.max(0, total - 1);
  if (total <= 3) return { a: 0, b: last };
  let a = Math.max(0, Math.min(s.a, last)), b = Math.max(0, Math.min(s.b, last));
  if (a > b) [a, b] = [b, a];
  if (b - a < 2) { a = Math.max(0, Math.min(a, last - 2)); b = a + 2; }
  return { a, b };
}
/** День под указателем: доля ширины полосы → индекс. */
export const dayIndexAt = (frac: number, total: number) => Math.max(0, Math.min(total - 1, Math.floor(frac * total)));
/** Протягивание по полосе обзора: l, r — край рамки, m — вся рамка, n — новый отрезок от дня нажатия k0 до дня под указателем k. */
export function dragSpan(mode: "l" | "r" | "m" | "n", start: Span, k0: number, k: number, total: number): Span {
  const dk = k - k0, last = total - 1;
  if (mode === "l") return { a: Math.max(0, Math.min(start.a + dk, start.b - 2)), b: start.b };
  if (mode === "r") return { a: start.a, b: Math.min(last, Math.max(start.b + dk, start.a + 2)) };
  if (mode === "m") { const len = start.b - start.a, a = Math.max(0, Math.min(start.a + dk, last - len)); return { a, b: a + len }; }
  return { a: Math.min(k0, k), b: Math.max(k0, k) };
}
/** Стрелки на рамке: сдвиг на день; с Shift — правый край шире или уже. */
export function keySpan(s: Span, dir: -1 | 1, shift: boolean, total: number): Span {
  if (shift) return { a: s.a, b: Math.min(total - 1, Math.max(s.a + 2, s.b + dir)) };
  if (s.a + dir < 0 || s.b + dir > total - 1) return s;
  return { a: s.a + dir, b: s.b + dir };
}
/** «3 — 27 ноября», «28 октября — 27 ноября», «28 октября 2025 — 27 ноября 2026»; год пишется, если он не этот. */
export function rangeText(a: string, b: string, thisYear: number): string {
  const [ya, ma, da] = a.split("-").map(Number), [yb, mb, db] = b.split("-").map(Number);
  const yrB = yb !== thisYear ? ` ${yb}` : "";
  if (ya === yb && ma === mb) return da === db ? `${db} ${MONTHS_GEN[mb - 1]}${yrB}` : `${da} — ${db} ${MONTHS_GEN[mb - 1]}${yrB}`;
  if (ya === yb) return `${da} ${MONTHS_GEN[ma - 1]} — ${db} ${MONTHS_GEN[mb - 1]}${yrB}`;
  return `${da} ${MONTHS_GEN[ma - 1]} ${ya} — ${db} ${MONTHS_GEN[mb - 1]} ${yb}`;
}
export const pointsIn = (pts: MarkPoint[], a: string, b: string) => pts.filter((p) => p.day >= a && p.day <= b);

/** Квантиль p (0..1) с линейной серединой; пусто — null. */
export function quant(arr: number[], p: number): number | null {
  if (!arr.length) return null;
  const s = [...arr].sort((x, y) => x - y), i = (s.length - 1) * p, lo = Math.floor(i);
  return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo);
}
const byDay = (pts: MarkPoint[]) => {
  const m = new Map<string, MarkPoint[]>();
  for (const p of pts) m.set(p.day, [...(m.get(p.day) ?? []), p]);
  return m;
};

/** Полоса «обычно»: у обычной привычки и ×2–3 — у каждой по счёту отметки середина половины отметок (от четверти до трёх
 *  четвертей) и медиана; у ×4 и больше — окно «обычно с первой до последней» (медианы первой и последней отметки дня).
 *  Меньше двух отметок — полосы нет. */
export interface Band { lo: number; hi: number; med: number | null; win?: boolean; i?: number }
export function usualBands(pts: MarkPoint[], perDay: number): Band[] {
  const out: Band[] = [];
  if (perDay <= 3) {
    for (let i = 1; i <= perDay; i++) {
      const ts = pts.filter((p) => p.n === i).map((p) => p.min);
      if (ts.length >= 2) out.push({ lo: quant(ts, 0.25)!, hi: quant(ts, 0.75)!, med: quant(ts, 0.5)!, i: i - 1 });
    }
    return out;
  }
  const first: number[] = [], last: number[] = [];
  for (const day of byDay(pts).values()) { first.push(day[0].min); if (day.length > 1) last.push(day.at(-1)!.min); }
  if (first.length >= 2 && last.length >= 2) out.push({ lo: quant(first, 0.5)!, hi: quant(last, 0.5)!, med: null, win: true });
  return out;
}
export const bandText = (b: Band) => (b.win ? `обычно с ${hhmm(b.lo)} до ${hhmm(b.hi)}` : `обычно около ${hhmm(b.med!)}`);

/** Подписи дней по X: длинный отрезок (> 75 дней) — начала месяцев («янв 2026» у января), короче — 2–5 дат через равные шаги. */
export function xLabels(a: string, n: number, plotW: number): { k: number; label: string; month: boolean }[] {
  const MS = MONTHS_GEN.map((m) => m.slice(0, 3));
  if (n > 75) {
    const firsts: { k: number; label: string; month: boolean }[] = [];
    for (let k = 0; k < n; k++) {
      const d = addDays(a, k);
      if (d.endsWith("-01")) { const mo = Number(d.slice(5, 7)) - 1; firsts.push({ k, label: `${MS[mo]}${mo === 0 ? ` ${d.slice(0, 4)}` : ""}`, month: true }); }
    }
    const every = Math.ceil(firsts.length / Math.max(2, Math.floor(plotW / 70)));
    return firsts.filter((_, i) => i % every === 0);
  }
  const cnt = n <= 1 ? 1 : Math.min(5, Math.max(2, Math.floor(plotW / 100)));
  const ks = cnt === 1 ? [0] : [...new Set(Array.from({ length: cnt }, (_, i) => Math.round((i * (n - 1)) / (cnt - 1))))];
  return ks.map((k) => { const d = addDays(a, k); return { k, label: `${Number(d.slice(8))} ${MS[Number(d.slice(5, 7)) - 1]}`, month: false }; });
}

// ── серия ──

export const MILESTONES = [7, 30, 100, 365];
/** Расписание «1234567» по клеткам срока ({day, due}): дни недели, где был день по расписанию. Видно меньше недели — null
 *  (сервер отдаёт месяц без строки расписания: в ответе /api/habits поле days — уже клетки). */
export function scheduleFrom(cells: { day: string; due: boolean }[]): string | null {
  const seen = new Set<number>(), due = new Set<number>();
  for (const c of cells) { const w = isoWd(c.day); seen.add(w); if (c.due) due.add(w); }
  if (seen.size < 7) return null;
  return [...due].sort().join("");
}
/** По расписанию ли день: клетки года (сервер), дальше — по строке расписания и сроку; не знаем — null. */
export function dueFn(year: HabitStats["year"], schedule: string | null, start: string, end: string | null): (day: string) => boolean | null {
  const cell = new Map(year.map((c) => [c.day, c.s] as const));
  return (day) => {
    if (day < start || (end && day > end)) return false;
    const s = cell.get(day);
    if (s) return s !== "rest" && s !== "off";
    return schedule === null ? null : dueByDays(schedule, day);
  };
}

/** Серия и дорога к рекорду. todayOpen — сегодня по расписанию и ещё не сделано: если отметить, серия станет streak+1.
 *  beatOn — день, когда без пропусков побьёте рекорд (isDue — по расписанию ли день; не знаем или после конца срока — null). */
export function streakView(o: { streak: number; best: number; todayOpen: boolean; isDue: (day: string) => boolean | null; today: string }) {
  const best = Math.max(o.best, o.streak);
  const record = o.streak >= best && o.streak > 0;
  let need = 0, beatOn: string | null = null;
  if (!record && best > 0) {
    need = best - o.streak + 1;
    let d = o.todayOpen ? o.today : addDays(o.today, 1), c = 0;
    for (let i = 0; i < 3000 && c < need; i++, d = addDays(d, 1)) {
      const due = o.isDue(d);
      if (due === null) break;
      if (due) { c++; if (c === need) beatOn = d; }
    }
  }
  const next = MILESTONES.find((m) => m > o.streak) ?? null;
  return {
    best, record, need, beatOn, next, toNext: next ? next - o.streak : 0,
    pct: best ? Math.min(100, (o.streak / best) * 100) : 0,
    milestones: MILESTONES.map((m) => ({ m, got: best >= m })),
  };
}

// ── сутки циферблатом ──

/** Точка на циферблате (центр 100,100): 00:00 — сверху, по часовой. */
export function clockPos(min: number, r: number): [number, number] {
  const a = (min / 1440) * Math.PI * 2 - Math.PI / 2;
  return [+(100 + r * Math.cos(a)).toFixed(1), +(100 + r * Math.sin(a)).toFixed(1)];
}
/** Отметки на циферблате: ближе к краю — недавние дни отрезка [a, b]. */
export function clockDots(pts: MarkPoint[], a: string, b: string): { x: number; y: number }[] {
  const span = Math.max(1, daysBetween(a, b));
  return pts.map((p) => { const [x, y] = clockPos(p.min, 30 + (daysBetween(a, p.day) / span) * 42); return { x, y }; });
}
/** Час под указателем: смещение от центра → 0..23. */
export function hourAt(dx: number, dy: number): number {
  let a = Math.atan2(dy, dx) + Math.PI / 2;
  if (a < 0) a += Math.PI * 2;
  return Math.floor((a / (Math.PI * 2)) * 24) % 24;
}

// ── дни недели ──

const WD_DAT = ["по понедельникам", "по вторникам", "по средам", "по четвергам", "по пятницам", "по субботам", "по воскресеньям"];
const WD_IN = ["в понедельник", "во вторник", "в среду", "в четверг", "в пятницу", "в субботу", "в воскресенье"];
const pctOf = (r: { done: number; planned: number }) => (r.planned ? Math.round((r.done / r.planned) * 100) : null);
/** Дни недели за всё время: % по дню, лучший и слабый (среди дней, где было хотя бы 3 запланированных), подпись. */
export function weekView(w: HabitStats["weekdays"]) {
  const p = w.map(pctOf);
  const rated = p.map((v, i) => ({ i, v, n: w[i].planned })).filter((x) => x.v !== null && x.n >= 3) as { i: number; v: number }[];
  if (rated.length < 2) return { p, hi: null, lo: null, text: "Пока мало отметок, чтобы сравнить дни." };
  const srt = [...rated].sort((x, y) => y.v - x.v || x.i - y.i);
  const hi = srt[0], lo = srt.at(-1)!;
  if (hi.v === lo.v) return { p, hi: hi.i, lo: null, text: `Все дни держатся ровно, ${hi.v} %.` };
  return { p, hi: hi.i, lo: lo.i, text: `Лучше всего ${WD_DAT[hi.i]} (${hi.v} %), слабее ${WD_DAT[lo.i]}: ${lo.v} %.` };
}
/** Дни недели по выбранному отрезку [a, b] из клеток года (сделано / запланировано по дню недели; сегодня, ещё не отмеченное,
 *  не в счёт). Отрезок короче 3 месяцев — берутся 3 месяца до b (wide: подпись «за 3 месяца»), иначе по дням не сравнить. */
export function weekFromYear(year: HabitStats["year"], a: string, b: string): { w: HabitStats["weekdays"]; wide: boolean } {
  const from = daysBetween(a, b) < 83 && addDays(b, -89) < a ? addDays(b, -89) : a;
  const w = Array.from({ length: 7 }, () => ({ done: 0, planned: 0 }));
  for (const c of year) {
    if (c.day < from || c.day > b || (c.s !== "done" && c.s !== "miss")) continue;
    const x = w[isoWd(c.day) - 1];
    x.planned++;
    if (c.s === "done") x.done++;
  }
  return { w, wide: from !== a };
}
/** Где чаще пропуски: день недели с самым низким процентом, если он хуже остальных на 15 % и больше. */
export function weakDay(w: HabitStats["weekdays"]): string | null {
  const rated = w.map((x, i) => ({ i, p: pctOf(x), n: x.planned })).filter((x) => x.p !== null && x.n >= 3) as { i: number; p: number }[];
  if (rated.length < 3) return null;
  const worst = rated.reduce((a, b) => (b.p < a.p ? b : a));
  const rest = rated.filter((x) => x !== worst);
  const avg = rest.reduce((s, x) => s + x.p, 0) / rest.length;
  if (avg - worst.p < 15) return null;
  return `Чаще всего пропускаете ${WD_IN[worst.i]}: ${worst.p} % против ${Math.round(avg)} % в другие дни.`;
}

// ── год по месяцам ──

export interface YearMonth { month: string; offset: number; weeks: number; cells: (Pick<HabitStats["year"][number], "s" | "k" | "p"> & { day: string })[]; done: number; planned: number }
/** Последние 12 месяцев (с этим) из клеток года: у месяца — сдвиг первого дня (0 — понедельник), число недель-столбцов,
 *  сделано из запланированного (сегодня, ещё не отмеченное, не в счёт). best — лучший месяц, где запланировано от 6 дней. */
export function yearMonths(year: HabitStats["year"], today: string): { months: YearMonth[]; best: YearMonth | null } {
  const cell = new Map(year.map((c) => [c.day, c] as const));
  const [ty, tm] = today.split("-").map(Number);
  const months: YearMonth[] = [];
  let best: YearMonth | null = null;
  for (let j = 11; j >= 0; j--) {
    const dt = new Date(Date.UTC(ty, tm - 1 - j, 1));
    const month = dt.toISOString().slice(0, 7);
    const nd = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
    const cells: YearMonth["cells"] = [];
    let done = 0, planned = 0;
    for (let d = 1; d <= nd; d++) {
      const day = `${month}-${String(d).padStart(2, "0")}`;
      const c = cell.get(day);
      const s = c?.s ?? "off";
      cells.push({ day, s, ...(c?.k ? { k: c.k } : {}), ...(c?.p !== undefined ? { p: c.p } : {}) });
      if (s === "done") { done++; planned++; } else if (s === "miss") planned++;
    }
    const offset = isoWd(`${month}-01`) - 1;
    const m = { month, offset, weeks: Math.ceil((offset + nd) / 7), cells, done, planned };
    if (planned >= 6 && (!best || done / planned >= best.done / best.planned)) best = m;
    months.push(m);
  }
  return { months, best };
}

/** Сделано из запланированного на отрезке [a, b] по клеткам года; отрезок старше года — null (нечего считать). */
export function tallyYear(year: HabitStats["year"], a: string, b: string): { done: number; planned: number } | null {
  if (!year.length || a < year[0].day) return null;
  let done = 0, planned = 0;
  for (const c of year) if (c.day >= a && c.day <= b) { if (c.s === "done") { done++; planned++; } else if (c.s === "miss") planned++; }
  return { done, planned };
}

// ── отклик на напоминание и ритм ──

/** Ближайшее напоминание перед отметкой (самое позднее не позже неё; раньше всех — первое): отметка минус оно, в минутах. */
const sinceRemind = (min: number, remind: number[]) => min - ([...remind].reverse().find((r) => r <= min) ?? remind[0]);
/** Отклик на напоминание у обычной привычки: через сколько после напоминания отмечают (медиана; минус — раньше),
 *  обычный разброс (половина межквартильного, не меньше минуты), самая ранняя и поздняя отметка. Меньше 3 отметок — null;
 *  без напоминаний — after и spread null. */
export function responseView(pts: MarkPoint[], remind: number[]) {
  if (pts.length < 3) return null;
  const ts = pts.map((p) => p.min);
  const base = { early: Math.min(...ts), late: Math.max(...ts), usual: medianMin(ts)! };
  if (!remind.length) return { ...base, after: null, spread: null };
  const dl = ts.map((t) => sinceRemind(t, remind));
  return { ...base, after: Math.round(quant(dl, 0.5)!), spread: Math.max(1, Math.round((quant(dl, 0.75)! - quant(dl, 0.25)!) / 2)) };
}

/** Ритм дня у ×N на отрезке: в среднем отметок за день по расписанию (isDue; сегодня не в счёт), сколько дней норма набрана,
 *  медианы первой и последней отметки дня, обычный промежуток между отметками. Меньше 3 отметок — null. */
export function rhythmView(o: { pts: MarkPoint[]; perDay: number; isDue: (day: string) => boolean | null; a: string; b: string; today: string }) {
  if (o.pts.length < 3) return null;
  const by = byDay(o.pts);
  let planned = 0, marks = 0, full = 0;
  for (let d = o.a; d <= o.b && d < o.today; d = addDays(d, 1)) {
    if (!o.isDue(d)) continue;
    planned++;
    const n = by.get(d)?.length ?? 0;
    marks += n;
    if (n >= o.perDay) full++;
  }
  const first: number[] = [], last: number[] = [], gaps: number[] = [];
  for (const day of by.values()) {
    first.push(day[0].min);
    if (day.length > 1) last.push(day.at(-1)!.min);
    for (let i = 1; i < day.length; i++) gaps.push(day[i].min - day[i - 1].min);
  }
  return {
    avg: planned ? marks / planned : null, planned, full,
    first: medianMin(first), last: medianMin(last), gap: gaps.length ? Math.round(quant(gaps, 0.5)!) : null,
  };
}

// ── «Рина заметила» ──

/** Совет Рины кнопкой: time — новое время напоминания «ЧЧ:ММ»; replace — какое из нынешних оно заменяет (null — добавить ещё
 *  одно). Только когда напоминания есть (у тихой привычки советовать нечего) и их меньше 4 при добавлении (больше сервер не берёт). */
export interface RinaAct { time: string; replace: string | null; label: string }
/** Времена напоминаний после совета: заменить или добавить, по порядку, без повторов. */
export const applyRinaAct = (remind: string[], act: RinaAct) =>
  [...new Set(act.replace ? remind.map((t) => (t === act.replace ? act.time : t)) : [...remind, act.time])].sort();
/** Короткое наблюдение по выбранному отрезку и дням недели (тоже по отрезку — weekFromYear). mood — какая картинка Рины
 *  (/maid/<mood>.webp); act — совет кнопкой (RinaAct) или null. */
export function rinaNote(o: { pts: MarkPoint[]; perDay: number; remind: string[]; weekdays: HabitStats["weekdays"]; streak: number; best: number }):
  { text: string; mood: "think" | "happy" | "worried"; act: RinaAct | null } {
  if (o.pts.length < 3) return { text: "Отметок на этом отрезке пока мало — давайте посмотрим отрезок подлиннее.", mood: "think", act: null };
  const rem = [...o.remind].map((t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; }).sort((a, b) => a - b);
  let text: string, mood: "think" | "happy" | "worried" = "happy", act: RinaAct | null = null;
  if (o.perDay > 1) {
    // Самый долгий перерыв между обычным временем соседних отметок, если между ними нет напоминания.
    const meds: number[] = [];
    for (let i = 1; i <= o.perDay; i++) { const ts = o.pts.filter((p) => p.n === i).map((p) => p.min); if (ts.length) meds.push(quant(ts, 0.5)!); }
    let gap: [number, number] | null = null;
    for (let i = 1; i < meds.length; i++) {
      const a = meds[i - 1], b = meds[i];
      if (!rem.some((r) => r > a + 15 && r < b - 15) && (!gap || b - a > gap[1] - gap[0])) gap = [a, b];
    }
    if (gap && gap[1] - gap[0] >= 150) {
      text = `Самый долгий перерыв — между ${hhmm(gap[0])} и ${hhmm(gap[1])}: ${durText(gap[1] - gap[0])} без отметок.`;
      mood = "think";
      const mid = Math.round((gap[0] + gap[1]) / 60) * 30;
      if (rem.length && rem.length < 4 && !rem.includes(mid)) {
        act = { time: hhmm(mid), replace: null, label: `Напоминать ещё в ${hhmm(mid)}` };
        text += ` Добавить напоминание на ${hhmm(mid)}?`;
      }
    }
    else text = "Отметки идут ровно, без долгих перерывов.";
  } else {
    const med = medianMin(o.pts.map((p) => p.min))!;
    const r = responseView(o.pts, rem);
    if (!r || r.after === null) text = `Обычно вы отмечаете около ${hhmm(med)}.`;
    else if (r.after >= 20 || r.after <= -20) {
      // Совет: напоминать за 10 минут до обычного времени (ровно по 10 минут); заменяется то напоминание, на которое отвечают.
      const sug = Math.max(0, Math.round(med / 10) * 10 - 10);
      const was = [...rem].reverse().find((x) => x <= med) ?? rem[0];
      const ok = sug !== was && !rem.includes(sug);
      if (r.after >= 20) { text = `Обычно вы отмечаете около ${hhmm(med)} — на ${durText(r.after)} позже напоминания.${ok ? ` Давайте я буду напоминать в ${hhmm(sug)}?` : ""}`; mood = "think"; }
      else text = `Вы справляетесь раньше напоминания, обычно к ${hhmm(med)}.${ok ? ` Могу напоминать в ${hhmm(sug)}.` : ""}`;
      if (ok) act = { time: hhmm(sug), replace: hhmm(was), label: `Напоминать в ${hhmm(sug)}` };
    }
    else text = `Напоминание попадает точно: ${r.after < 0 ? `отмечаете обычно за ${durText(r.after)} до него` : r.after === 0 ? "отмечаете сразу" : `отмечаете в среднем через ${durText(r.after)}`}.`;
  }
  const weak = weakDay(o.weekdays);
  if (weak) { text += ` ${weak}`; mood = "worried"; }
  const toRecord = Math.max(o.best, o.streak) - o.streak;
  if (o.streak > 0 && toRecord > 0 && toRecord <= 10) text += ` До нового рекорда всего ${daysText(toRecord + 1)}.`;
  return { text, mood, act };
}
