// Чистые расчёты графиков времени суток: «Во сколько отмечали» в раскрытой привычке (HabitMarkChart.tsx) — шкала, медиана, куски
// линии; подсказка над точкой — и у «Сна и оценки дня». Отрезки, полосы «обычно» и подписи дней — habitpanel.ts.
// Проверка — web/test/timechart.test.ts.

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

/** Верх подсказки над точкой на высоте y: обычно на 30 px выше; у верхнего края — на 10 px ниже точки, чтобы её не закрыть. */
export const tipTop = (y: number) => (y < 30 ? y + 10 : y - 30);

/** Левый край подсказки шириной tipW у точки x на графике шириной w: по центру над точкой, у краёв — прижата к краю
 *  (не вылезает и не переносится). */
export const tipLeft = (x: number, tipW: number, w: number, pad = 4) =>
  Math.max(pad, Math.min(x - tipW / 2, w - tipW - pad));
