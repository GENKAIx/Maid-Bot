import { daysInMonth } from "./format";
import type { MoneyRow } from "./types";

// Экран «Деньги» без React: цвет категории, прогноз до конца месяца, записи по дням (ревью 18.11.2026).

export const OTHER_COLOR = "#9aa0aa";

/** Цвета частых категорий: один и тот же в столбиках, в списке категорий и в записях. Красного нет — он для перерасхода. */
const KNOWN: Record<string, string> = {
  продукты: "#8b6cf0",
  дом: "#2fa86e",
  кафе: "#e98a2e",
  транспорт: "#3d8fe0",
  развлечения: "#e86aa8",
  подписки: "#d9a92c",
  еда: "#c9733f",
  связь: "#2bb3b1",
  здоровье: "#6fbf4a",
  одежда: "#b072d6",
  игры: "#5b6fd8",
  обучение: "#3fa0a8",
  подарки: "#d6609b",
  долг: "#8a7a6a",
  перевод: "#7a8aa0",
  заказ: "#a88b3c",
  другое: OTHER_COLOR,
};
const SPARE = ["#5aa36b", "#c78a55", "#6a8fd0", "#a46fc0", "#3e9e9a", "#b8913a", "#d07a8f", "#7f9a45"];

export function catKey(category: string) {
  return category.trim().toLowerCase() || "другое";
}

export function catColor(category: string) {
  const k = catKey(category);
  if (KNOWN[k]) return KNOWN[k];
  let h = 0;
  for (const ch of k) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return SPARE[h % SPARE.length];
}

/** Прогноз расходов текущего месяца при нынешнем темпе; для прошлых и будущих месяцев — null. */
export function monthForecast(rows: MoneyRow[], month: string, today: string) {
  if (today.slice(0, 7) !== month) return null;
  const spent = rows.filter((r) => r.kind === "expense" && r.day_key.startsWith(month)).reduce((s, r) => s + r.amount, 0);
  if (!spent) return null;
  const day = Number(today.slice(8, 10));
  const perDay = spent / day;
  return { today: day, perDay, total: perDay * daysInMonth(month) };
}

/** Записи по дням: свежий день сверху, внутри — последняя запись сверху; total — доходы минус расходы. */
export function dayGroups(rows: MoneyRow[]) {
  const sorted = [...rows].sort((a, b) => b.day_key.localeCompare(a.day_key) || b.id - a.id);
  const out: { day: string; total: number; rows: MoneyRow[] }[] = [];
  for (const r of sorted) {
    let g = out[out.length - 1];
    if (!g || g.day !== r.day_key) out.push((g = { day: r.day_key, total: 0, rows: [] }));
    g.rows.push(r);
    g.total += r.kind === "income" ? r.amount : -r.amount;
  }
  return out;
}
