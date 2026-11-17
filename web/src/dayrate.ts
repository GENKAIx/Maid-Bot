import { dur } from "./format";
import { clock, type SleepDay } from "./sleep";
import type { ActivityRow, MetricRow } from "./types";

// «Статистика»: вкладки сверху и «Оценка дня» — по дню оценка (rating_day, из вечернего итога) и коротко, что было:
// компьютер и игры, сон, записи в дневнике, шаги, спорт. Проверка — web/test/dayrate.test.ts.

export const STAT_TABS = [
  { id: "pc", title: "Компьютер" },
  { id: "sleep", title: "Сон" },
  { id: "body", title: "Шаги и спорт" },
  { id: "rating", title: "Оценка дня" },
] as const;
export type StatTab = (typeof STAT_TABS)[number]["id"];

export interface DayFacts {
  day: string;
  rating?: number;
  pcSec: number;
  gameSec: number;
  sleep?: SleepDay;
  notes: number;
  steps?: number;
  sportMin?: number;
}

/** Сводка по дням: свежие сверху, дни без единого факта пропущены. */
export function dayFacts(days: string[], src: { activity: ActivityRow[]; metrics: MetricRow[]; sleep: Map<string, SleepDay>; notes: { day: string; n: number }[] }): DayFacts[] {
  const m = (day: string, key: string) => src.metrics.find((x) => x.day_key === day && x.key === key)?.value;
  return [...days].reverse().map((day) => {
    const a = src.activity.filter((x) => x.day_key === day);
    const sleep = src.sleep.get(day);
    return {
      day,
      rating: m(day, "rating_day"),
      pcSec: a.reduce((s, x) => s + x.active_sec, 0),
      gameSec: a.reduce((s, x) => s + x.games.reduce((g, y) => g + y.sec, 0), 0),
      sleep: sleep?.hours ? sleep : undefined,
      notes: src.notes.find((x) => x.day === day)?.n ?? 0,
      steps: m(day, "steps") || undefined,
      sportMin: m(day, "sport_min") || undefined,
    };
  }).filter((f) => f.rating !== undefined || f.pcSec || f.gameSec || f.sleep || f.notes || f.steps || f.sportMin);
}

function plural(n: number, one: string, few: string, many: string) {
  const a = n % 10, b = n % 100;
  return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
}

/** Короткие пункты дня: только то, что было. */
export function factChips(f: DayFacts): string[] {
  const out: string[] = [];
  const pc = Math.min(86400, Math.max(f.pcSec, f.gameSec)); // как в «Компьютере»: не меньше игр и не больше суток
  if (pc) out.push(`🖥 ${dur(pc)}${f.gameSec ? ` (игры ${dur(f.gameSec)})` : ""}`);
  if (f.sleep?.hours) {
    const s = f.sleep;
    const h = `${s.hours!.toLocaleString("ru-RU", { maximumFractionDigits: 1 })} ч`;
    out.push(`😴 ${h}${s.bed !== undefined && s.wake !== undefined ? `, ${clock(s.bed)}–${clock(s.wake)}` : ""}`);
  }
  if (f.notes) out.push(`📝 ${f.notes} ${plural(f.notes, "запись", "записи", "записей")}`);
  if (f.steps) out.push(`👣 ${Math.round(f.steps).toLocaleString("ru-RU")}`);
  if (f.sportMin) out.push(`🏃 ${Math.round(f.sportMin)} мин`);
  return out;
}

/** Цвет оценки из 10: 1–4 — низкая, 5–7 — средняя, 8–10 — высокая. */
export const rateTone = (v: number) => (v >= 8 ? "high" : v >= 5 ? "mid" : "low");
