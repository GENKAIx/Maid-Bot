// Статистика (Stats.tsx): периоды и круг суток «за ПК / из них игры / не за ПК».

export type Range = "day" | "week" | "month" | "quarter" | "year";
/** Периоды статистики; стрелки листают на длину периода. Открывается на STAT_DEFAULT. */
export const STAT_RANGES: { id: Range; title: string; days: number; group: "day" | "week" | "month" }[] = [
  { id: "day", title: "День", days: 1, group: "day" },
  { id: "week", title: "Неделя", days: 7, group: "day" },
  { id: "month", title: "Месяц", days: 30, group: "day" },
  { id: "quarter", title: "3 месяца", days: 91, group: "week" },
  { id: "year", title: "Год", days: 365, group: "month" },
];

/** С какого периода открывается статистика (до 17.11.2026 — «День»). */
export const STAT_DEFAULT: Range = "month";

export const DAY_SEC = 86400;
/** Доли суток в секундах: игры, остальное время за ПК, не за ПК; вместе — ровно сутки. За ПК не меньше игр
 *  (в днях прежнего трекера игры бывали дольше «за ПК») и не больше суток. */
export function dayParts(pc: number, games: number) {
  const g = Math.min(Math.max(0, games), DAY_SEC);
  const p = Math.min(Math.max(pc, g), DAY_SEC);
  return { pc: p, games: g, pcRest: p - g, off: DAY_SEC - p };
}
