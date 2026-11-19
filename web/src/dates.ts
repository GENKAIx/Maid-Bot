import { MONTHS } from "./format";
import type { DateItem } from "./types";

// Вкладка «Даты» в «Планах» без React (screens/Dates.tsx): группы, возраст словами, поля формы.

export const SOON_DAYS = 30;

export const DATE_TYPES: { id: string; title: string }[] = [
  { id: "birthday", title: "День рождения" },
  { id: "anniversary", title: "Годовщина" },
  { id: "holiday", title: "Праздник" },
  { id: "deadline", title: "Срок" },
  { id: "other", title: "Другое" },
];

/** «Скоро» — ближайшие SOON_DAYS дней; остальное — по месяцам наступления, по порядку («Январь 2027» — если не этот год). */
export function dateGroups(list: DateItem[], thisYear = new Date().getFullYear()) {
  const sorted = [...list].sort((a, b) => a.on.localeCompare(b.on) || a.id - b.id);
  const soon = sorted.filter((x) => x.inDays <= SOON_DAYS);
  const months: { key: string; title: string; items: DateItem[] }[] = [];
  for (const x of sorted.filter((x) => x.inDays > SOON_DAYS)) {
    const key = x.on.slice(0, 7);
    let g = months[months.length - 1];
    if (!g || g.key !== key) {
      const y = Number(key.slice(0, 4));
      months.push((g = { key, title: `${MONTHS[Number(key.slice(5)) - 1]}${y === thisYear ? "" : ` ${y}`}`, items: [] }));
    }
    g.items.push(x);
  }
  return { soon, months };
}

const years = (n: number) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? "год" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? "года" : "лет"}`;

/** «исполнится 30» у дня рождения, «5 лет» у остального; год неизвестен — пусто (раньше было «· 1»). */
export function ageText(x: DateItem) {
  if (!x.year_known || !x.age || x.age < 1) return "";
  return x.type === "birthday" ? `исполнится ${x.age}` : years(x.age);
}

export type DateForm = { title: string; day: number; month: number; year: string; type: string; yearly: boolean };

/** Поля формы: новая дата (null) или правка существующей; год — только настоящий. */
export function formOf(x: DateItem | null): DateForm {
  if (!x) return { title: "", day: 1, month: 1, year: "", type: "birthday", yearly: true };
  return {
    title: x.title, day: Number(x.date_iso.slice(8, 10)), month: Number(x.date_iso.slice(5, 7)),
    year: x.year_known ? x.date_iso.slice(0, 4) : "", type: x.type, yearly: Boolean(x.yearly),
  };
}
