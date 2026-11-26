import { avgText, scoreNum } from "./dayscore";
import { shortDay } from "./format";
import type { SleepDay } from "./sleep";

// «Статистика → Сон»: график «Сон и оценка дня» (27.11.2026) — точка на день: X — часы сна, Y — оценка дня (rating_day, 1–10).
// Пара — один и тот же day_key: сон дня D — ночь, после которой проснулся в день D (шкала сна — с 18:00 накануне до 18:00 дня D,
// бот пишет «лёг в 1:30, встал в 9:00» в день подъёма), оценка дня D ставится вечером того же дня — сон идёт раньше оценки.
// Проверка — web/test/sleepscore.test.ts.

export interface SleepScorePair { day: string; hours: number; score: number }
/** Точка графика: дни с одинаковыми часами (до четверти часа) и оценкой рисуются одной точкой. */
export interface SleepScorePoint { days: string[]; hours: number; score: number }

/** В каждой из двух групп вывода — не меньше стольких дней. */
export const SLEEP_SCORE_BAND = 3;
/** Меньше дней с парой — вывода нет, только «Мало дней…» (две группы по SLEEP_SCORE_BAND). */
export const SLEEP_SCORE_MIN = 2 * SLEEP_SCORE_BAND;
/** «Сон почти всегда около …» — только если весь сон укладывается в столько часов. */
const SLEEP_SCORE_NARROW = 1;

/** Дни периода, где есть и часы сна, и оценка; по порядку дней. */
export function sleepScorePairs(days: string[], sleep: Map<string, SleepDay>, scores: Map<string, number>): SleepScorePair[] {
  const out: SleepScorePair[] = [];
  for (const day of days) {
    const hours = sleep.get(day)?.hours;
    const score = scores.get(day);
    if (hours && hours > 0 && score !== undefined) out.push({ day, hours, score });
  }
  return out;
}

/** Склеить совпадающие точки (часы с точностью до 15 минут и та же оценка). */
export function sleepScorePoints(pairs: SleepScorePair[]): SleepScorePoint[] {
  const map = new Map<string, SleepScorePoint>();
  for (const p of pairs) {
    const hours = Math.round(p.hours * 4) / 4, score = scoreNum(p.score);
    const k = `${hours}|${score}`;
    const pt = map.get(k);
    if (pt) pt.days.push(p.day);
    else map.set(k, { days: [p.day], hours, score });
  }
  return [...map.values()];
}

/** «7,5 ч», «9 ч». */
export const sleepHoursText = (h: number) => `${h.toLocaleString("ru-RU", { maximumFractionDigits: 1 })} ч`;

/** Ось часов: целые часы вокруг данных (не уже 4 ч), подписи через 1 ч, на широком разбросе — через 2 ч. */
export function hoursAxis(hours: number[]): { lo: number; hi: number; ticks: number[] } {
  if (!hours.length) hours = [6, 9];
  let lo = Math.floor(Math.min(...hours)), hi = Math.ceil(Math.max(...hours));
  while (hi - lo < 4) { if (lo > 0) lo--; if (hi - lo < 4) hi++; }
  const step = hi - lo > 8 ? 2 : 1;
  const ticks: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) ticks.push(t);
  return { lo, hi, ticks };
}

/** Порог сна для вывода: целый час (если ни один не делит дни на две группы по SLEEP_SCORE_BAND — полчаса), при котором группы
 *  «столько и больше» и «меньше» ближе всего по числу дней; при равенстве — ближе к медиане. Нельзя разделить — null. */
export function sleepThreshold(hours: number[]): number | null {
  const sorted = [...hours].sort((a, b) => a - b);
  const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  for (const step of [1, 0.5]) {
    let best: { t: number; diff: number; dist: number } | null = null;
    for (let t = Math.ceil(sorted[0] / step) * step; t <= sorted[sorted.length - 1]; t += step) {
      const hi = sorted.filter((h) => h >= t).length, lo = sorted.length - hi;
      if (hi < SLEEP_SCORE_BAND || lo < SLEEP_SCORE_BAND) continue;
      const diff = Math.abs(hi - lo), dist = Math.abs(t - median);
      if (!best || diff < best.diff || (diff === best.diff && dist < best.dist)) best = { t, diff, dist };
    }
    if (best) return best.t;
  }
  return null;
}

/** Вывод под графиком одной строкой. Пар меньше SLEEP_SCORE_MIN или на две группы не делится при широком разбросе — null
 *  (тогда «Мало дней…»). */
export function sleepScoreTakeaway(pairs: SleepScorePair[]): string | null {
  if (pairs.length < SLEEP_SCORE_MIN) return null;
  const avg = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
  const t = sleepThreshold(pairs.map((p) => p.hours));
  if (t === null) {
    const hs = pairs.map((p) => p.hours);
    // Разброс широкий, а на две группы дней не хватает (часы 4, 5, 9, 9, 9, 9) — сравнивать не с чем: «Мало дней…».
    if (Math.max(...hs) - Math.min(...hs) > SLEEP_SCORE_NARROW) return null;
    return `Сон почти всегда около ${sleepHoursText(Math.round(avg(pairs.map((p) => p.hours)) * 2) / 2)}, оценка в среднем ${avgText(avg(pairs.map((p) => p.score)))}`;
  }
  const more = pairs.filter((p) => p.hours >= t).map((p) => p.score), less = pairs.filter((p) => p.hours < t).map((p) => p.score);
  return `После ${sleepHoursText(t)} и больше — в среднем ${avgText(avg(more))}, после меньше ${sleepHoursText(t)} — ${avgText(avg(less))}`;
}

/** Подсказка точки: «12 ноя: сон 9 ч, оценка 8»; несколько дней — «12 ноя, 14 ноя и ещё 2: …». */
export function sleepScoreTip(p: SleepScorePoint): string {
  const shown = p.days.slice(0, 2).map(shortDay).join(", ");
  const more = p.days.length > 2 ? ` и ещё ${p.days.length - 2}` : "";
  return `${shown}${more}: сон ${sleepHoursText(p.hours)}, оценка ${p.score}`;
}

/** Подпись графика для экранного диктора. */
export function sleepScoreSummary(pairs: SleepScorePair[]): string {
  const t = sleepScoreTakeaway(pairs);
  return `Сон и оценка дня: ${pairs.length} дн.${t ? ` ${t}` : ""}`;
}
