import type { MetricRow } from "./types";

// «Дневник»: оценка дня (rating_day, 1–10) в клетке календаря — кружок с числом справа сверху — и средняя за месяц под календарём.
// Цвет кружка — расходящаяся шкала: низкая — красная, середина — серая, высокая — зелёная (токены --score-* в styles.css).
// Проверка — web/test/dayscore.test.ts.

/** Оценка каждого дня — первая строка rating_day за день, как в «Статистике» (dayFacts) и на сервере (dayRating). */
export function dayScores(metrics: MetricRow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of metrics) if (m.key === "rating_day" && !out.has(m.day_key)) out.set(m.day_key, m.value);
  return out;
}

/** Ступень цвета: 1–2 и 3–4 — красная ветвь, 5–6 — середина, 7–8 и 9–10 — зелёная ветвь (по две оценки на ступень). */
export type ScoreTone = "low2" | "low1" | "mid" | "high1" | "high2";
export function scoreTone(v: number): ScoreTone {
  const n = scoreNum(v);
  return n <= 2 ? "low2" : n <= 4 ? "low1" : n <= 6 ? "mid" : n <= 8 ? "high1" : "high2";
}

/** Число в кружке: целое от 1 до 10. */
export const scoreNum = (v: number) => Math.min(10, Math.max(1, Math.round(v)));

/** Строка подсказки клетки. */
/** Сдвиг цифры в кружке оценки, в em (26.11.2026). Шрифт Onest 700, line-height 1: чернила цифр сидят на 0,03 em выше центра
 *  строки, а «1», «2», «3», «7», «10» — чуть левее центра своей ширины. Замерено по пикселям для каждой оценки 1–10;
 *  с этим сдвигом центр цифры совпадает с центром кружка. Цифры без tabular-nums: моноширинная «1» уезжала влево на 0,17 em. */
const SCORE_NUDGE_X: Record<number, number> = { 1: 0.04, 2: 0.015, 3: 0.015, 7: 0.01, 10: 0.015 };
export const scoreNudge = (v: number) => `translate(${SCORE_NUDGE_X[scoreNum(v)] ?? 0}em, 0.03em)`;
export const scoreTip = (v: number) => `Оценка дня: ${scoreNum(v)}/10`;

/** Средняя оценка за месяц («2026-11») — только дни этого месяца с оценкой; нет ни одной — undefined. */
export function monthAverage(scores: Map<string, number>, month: string): number | undefined {
  let sum = 0, n = 0;
  for (const [d, v] of scores) if (d.startsWith(`${month}-`)) { sum += v; n++; }
  return n ? sum / n : undefined;
}

/** «6,4»: один знак после запятой, всегда (7 → «7,0»). */
export const avgText = (v: number) => v.toLocaleString("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** Наклейки в клетке с оценкой: чуть мельче и не заходят под кружок справа сверху.
 *  Место кружка — x > 52 %, y < 46 % клетки: с запасом для самой узкой клетки (~33 px при ширине экрана 320 px, кружок 12 px — с 57 % по x, до 41 % по y).
 *  Размер s передавать уже итоговый (с увеличением выбранной наклейки в режиме фильтра). */
export const BADGE_ZONE = { x: 52, y: 46 };
export function clearBadge<T extends { x: number; y: number; s: number }>(spots: T[]): T[] {
  return spots.map((p) => {
    let s = p.s * 0.88;
    let y = p.y;
    if (p.x + s / 2 > BADGE_ZONE.x && y - s / 2 < BADGE_ZONE.y) {
      // Ниже кружка; не влезает по высоте (крупная одна наклейка) — уменьшить до места под кружком.
      s = Math.min(s, 100 - BADGE_ZONE.y - 1);
      y = Math.min(BADGE_ZONE.y + s / 2 + 1, 100 - s / 2);
    }
    return { ...p, s, y };
  });
}
