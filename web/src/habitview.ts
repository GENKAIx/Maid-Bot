import { shortDay } from "./format";
import type { HabitFinished, HabitMonth } from "./types";

// Чистые расчёты страницы «Привычки» (26.11.2026): время отметки в подсказке клетки, строка «Завершённых», куда ведёт «?h=».
// Клетки ×N, отрезок графика и блоки раскрытой привычки — habitpanel.ts.
// Проверка — web/test/habit-finished.test.ts.

/** Дней от a до b (ГГГГ-ММ-ДД), b позже — плюс. */
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);

type Marked = { status: string | null; at_time?: string | null; at_day?: string | null };

/** Когда отметили (время уже в поясе человека — считает сервер): «сделано в 21:14», «пропуск в 21:14»; отметили задним числом —
 *  «отмечено 26 ноя в 10:02». Нет отметки или времени (минус в полночь) — пусто. */
export function markTip(x: Marked): string {
  if (!x.status || !x.at_time) return "";
  if (x.at_day) return `отмечено ${shortDay(x.at_day)} в ${x.at_time}`;
  return `${x.status === "done" ? "сделано" : "пропуск"} в ${x.at_time}`;
}

/** Подсказка клетки сетки: «2026-11-26 — сделано в 21:14 · 35 стр.», задним числом — «… — сделано · отмечено 26 ноя в 10:02».
 *  ×N (27.11.2026): «2026-11-26 — отмечено 5 из 8 · последняя в 21:14», норма набрана — «сделано 8 из 8 · …». */
export function cellTitle(x: Marked & { day: string; due: boolean; amount?: number | null; unit?: string; count?: number; need?: number }): string {
  const need = x.need ?? 1, count = x.count ?? 0;
  const amount = x.amount != null ? ` · ${x.amount}${x.unit ? " " + x.unit : ""}` : "";
  if (need > 1 && count > 0 && x.status !== "skipped") {
    const when = !x.at_time ? "" : x.at_day ? `отмечено ${shortDay(x.at_day)} в ${x.at_time}` : `последняя в ${x.at_time}`;
    return `${x.day} — ${[`${x.status === "done" ? "сделано" : "отмечено"} ${Math.min(count, need)} из ${need}`, when].filter(Boolean).join(" · ")}${amount}`;
  }
  const tip = markTip(x);
  const word = x.status === "done" ? "сделано" : x.status === "skipped" ? "пропуск" : x.due ? "запланировано" : "";
  const what = tip && !x.at_day ? tip : [word, tip].filter(Boolean).join(" · ");
  return `${x.day}${what ? ` — ${what}` : ""}${amount}`;
}

/** Строка завершённой привычки после названия: «3 окт – 25 ноя · 42 из 50 (84 %)»; запланированных дней не было — без процента. */
export function finishedSummary(f: Pick<HabitFinished, "start_date" | "end_date" | "done" | "planned">): string {
  const span = f.start_date === f.end_date ? shortDay(f.start_date) : `${shortDay(f.start_date)} – ${shortDay(f.end_date)}`;
  return `${span} · ${f.done} из ${f.planned}${f.planned ? ` (${Math.round((f.done / f.planned) * 100)} %)` : ""}`;
}

/** Где на странице привычка из «?h=12»: в сетке месяца, в «Завершённых» или нигде (удалена, чужая). */
export function habitPlace(data: Pick<HabitMonth, "habits" | "finished">, id: number): "grid" | "finished" | null {
  if (data.habits.some((h) => h.id === id)) return "grid";
  if (data.finished?.some((f) => f.id === id)) return "finished";
  return null;
}
