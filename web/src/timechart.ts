import { MONTHS_GEN, parts, shortDay } from "./format";
import { daysBetween } from "./habitview";

// Чистые расчёты графика «Во сколько отмечали» (статистика привычки, 26.11.2026): шкала времени суток, медиана, куски линии,
// подписи. Проверка — web/test/timechart.test.ts.

/** Минуты с полуночи → «ЧЧ:ММ». */
export const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(Math.round(min) % 60).padStart(2, "0")}`;
/** «ЧЧ:ММ» → минуты с полуночи. */
export const toMin = (t: string) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };

/** Верх шкалы — 23:59: подписи не доходят до «24:00» (самая поздняя — 23:00). */
export const DAY_END = 1439;

/** Шкала по Y: от ближайшего часа ниже самого раннего (точки и напоминания, с запасом 30 мин) до часа выше самого позднего,
 *  не уже 2 часов, в пределах суток (верх — не позже 23:59); шаг подписей 1/2/3/4/6/12 ч — не больше 5 подписей,
 *  края кратны шагу, подписи — не позже 23:00. */
export function timeScale(mins: number[]): { lo: number; hi: number; ticks: number[] } {
  if (!mins.length) return { lo: 0, hi: DAY_END, ticks: [0, 360, 720, 1080] };
  let lo = Math.max(0, Math.floor((Math.min(...mins) - 30) / 60) * 60);
  let hi = Math.min(DAY_END, Math.ceil((Math.max(...mins) + 30) / 60) * 60);
  while (hi - lo < 120) { if (lo > 0) lo -= 60; if (hi - lo < 120 && hi < DAY_END) hi = Math.min(DAY_END, hi + 60); }
  const step = [1, 2, 3, 4, 6, 12].map((h) => h * 60).find((s) => (Math.ceil(hi / s) * s - Math.floor(lo / s) * s) / s <= 4) ?? 720;
  lo = Math.floor(lo / step) * step;
  hi = Math.min(DAY_END, Math.ceil(hi / step) * step);
  const ticks: number[] = [];
  for (let t = lo; t <= hi; t += step) ticks.push(t);
  return { lo, hi, ticks };
}

/** Подписи оси Y (26.11.2026): часы шкалы и напоминания «🔔 12:00» на своей высоте. Час ближе minGap px к напоминанию
 *  не подписывается, и линию сетки у него не рисуем; у двух близких напоминаний подпись — у первого. */
export function axisLabels(ticks: number[], remind: number[], y: (min: number) => number, minGap = 14):
  { min: number; y: number; label: string; bell: boolean }[] {
  const bells: { min: number; y: number; label: string; bell: boolean }[] = [];
  for (const r of [...new Set(remind)].sort((a, b) => a - b)) {
    if (bells.some((b) => Math.abs(b.y - y(r)) < minGap)) continue;
    bells.push({ min: r, y: y(r), label: `🔔 ${hhmm(r)}`, bell: true });
  }
  const hours = ticks.filter((t) => bells.every((b) => Math.abs(b.y - y(t)) >= minGap)).map((t) => ({ min: t, y: y(t), label: hhmm(t), bell: false }));
  return [...hours, ...bells];
}

/** Медиана минут (чётное число — среднее двух средних), округлённая до минуты; пусто — null. */
export function medianMin(mins: number[]): number | null {
  if (!mins.length) return null;
  const s = [...mins].sort((a, b) => a - b);
  const k = s.length >> 1;
  return Math.round(s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2);
}

/** Сплошные куски линии: новый кусок — где gap (до точки был день по расписанию без отметки со временем). */
export function lineRuns<T extends { gap: boolean }>(points: T[]): T[][] {
  const runs: T[][] = [];
  for (const p of points) {
    if (!runs.length || p.gap) runs.push([p]);
    else runs.at(-1)!.push(p);
  }
  return runs;
}

/** Мостики через пропуски (26.11.2026): от последней точки куска до первой следующего — бледный пунктир, так что линия
 *  непрерывна и одиночная точка тоже соединена с соседями. */
export function gapLinks<T extends { gap: boolean }>(points: T[]): [T, T][] {
  const out: [T, T][] = [];
  for (let i = 1; i < points.length; i++) if (points[i].gap) out.push([points[i - 1], points[i]]);
  return out;
}

/** Размер точек: соседи ближе 12 px — мелкие (r 2.5, обводка 1.5), иначе обычные (r 4, обводка 2); наведённая — на 1.5 больше. */
export function markerSize(xs: number[]): { r: number; ring: number; hover: number } {
  let gap = Infinity;
  for (let i = 1; i < xs.length; i++) gap = Math.min(gap, Math.abs(xs[i] - xs[i - 1]));
  return gap < 12 ? { r: 2.5, ring: 1.5, hover: 4 } : { r: 4, ring: 2, hover: 5.5 };
}

/** Доля дня в окне [from, to]: 0 — первый день (слева), 1 — последний. Окно в один день — середина. */
export const dayPos = (day: string, from: string, to: string) => {
  const span = daysBetween(from, to);
  return span > 0 ? daysBetween(from, day) / span : 0.5;
};

/** Подписи дней по X: первый, середина, последний («28 окт», «11 ноя», «26 ноя»); короткое окно — только края. */
export function dayTicks(from: string, to: string): { day: string; label: string }[] {
  const span = daysBetween(from, to);
  const days = span <= 0 ? [from] : span < 8 ? [from, to] : [from, addDay(from, Math.round(span / 2)), to];
  return days.map((day) => ({ day, label: shortDay(day) }));
}

const addDay = (key: string, n: number) => new Date(Date.parse(`${key}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const WD = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];

/** Подсказка точки: «чт 26 ноя — 12:04». */
export const pointTip = (p: { day: string; time: string }) => `${WD[parts(p.day).date.getDay()]} ${shortDay(p.day)} — ${p.time}`;

/** Подпись для чтения с экрана: «Во сколько отмечали с 28 октября по 26 ноября: 18 дней, обычно около 12:40; напоминание в 12:00». */
export function timeSummary(t: { from: string; to: string; points: { min: number }[]; remind: string[] }): string {
  const long = (d: string) => { const { m, d: dd } = parts(d); return `${dd} ${MONTHS_GEN[m - 1]}`; };
  const med = medianMin(t.points.map((p) => p.min));
  return `Во сколько отмечали с ${long(t.from)} по ${long(t.to)}: дней с отметкой — ${t.points.length}${med === null ? "" : `, обычно около ${hhmm(med)}`}`
    + (t.remind.length ? `; напоминание в ${t.remind.join(", ")}` : "");
}

/** Полосы попадания для подсказки (26.11.2026): каждая точка владеет отрезком X от середины к левому соседу до середины к правому,
 *  крайние — до краёв графика [left, right]. Полосы не перекрываются, поэтому под курсором всегда ближайший день. */
export function hitBands(xs: number[], left: number, right: number): { x: number; w: number }[] {
  return xs.map((cx, i) => {
    const a = i ? (xs[i - 1] + cx) / 2 : left;
    const b = i < xs.length - 1 ? (xs[i + 1] + cx) / 2 : right;
    return { x: a, w: Math.max(0, b - a) };
  });
}

/** Верх подсказки над точкой на высоте y: обычно на 30 px выше; у верхнего края — на 10 px ниже точки, чтобы её не закрыть. */
export const tipTop = (y: number) => (y < 30 ? y + 10 : y - 30);

/** Левый край подсказки шириной tipW у точки x на графике шириной w: по центру над точкой, у краёв — прижата к краю
 *  (не вылезает и не переносится). */
export const tipLeft = (x: number, tipW: number, w: number, pad = 4) =>
  Math.max(pad, Math.min(x - tipW / 2, w - tipW - pad));
