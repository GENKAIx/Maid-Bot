// Даты, длительности, названия разделов — то же, что показывает бот.

export const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
export const MONTHS = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
export const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const WD = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];

export const SECTIONS: Record<string, string> = {
  notes: "Заметки", sleep: "Сон", food: "Еда", sport: "Спорт", health: "Здоровье", hobby: "Хобби", mood: "Настроение",
  summary: "Итог", tags: "Теги", pc: "Компьютер", games: "Игры",
};
export const SECTION_ORDER = ["summary", "sleep", "sport", "food", "health", "mood", "hobby", "notes", "tags"];
export const HEALTH_TOPICS: Record<string, string> = {
  pressure: "Давление", heart: "Сердце", head: "Голова", stomach: "Живот", teeth: "Зубы", skin: "Кожа",
  meds: "Таблетки", doctor: "Врачи", cold: "Простуда", injury: "Травмы", back: "Спина", eyes: "Глаза",
  allergy: "Аллергия", weight: "Вес", sleep: "Сон", other: "Другое",
};

export function parts(key: string) {
  const [y, m, d] = key.split("-").map(Number);
  return { y, m, d, date: new Date(y, m - 1, d) };
}
/** «8 ноября, суббота» */
export function humanDay(key: string, withYear = false) {
  const { y, m, d, date } = parts(key);
  return `${d} ${MONTHS_GEN[m - 1]}${withYear ? ` ${y}` : ""}, ${WD[date.getDay()]}`;
}
/** «8 ноя» */
export function shortDay(key: string) {
  const { m, d } = parts(key);
  return `${d} ${MONTHS_GEN[m - 1].slice(0, 3)}`;
}
export function todayKey(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
export function addDays(key: string, n: number) {
  const { date } = parts(key);
  date.setDate(date.getDate() + n);
  return todayKey(date);
}
export function addMonths(month: string, n: number) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
export function daysInMonth(month: string) {
  const [y, m] = month.split("-").map(Number);
  return new Date(y, m, 0).getDate();
}
/** Дни месяца сеткой по неделям, начиная с понедельника; null — пустая клетка. */
export function monthGrid(month: string): (string | null)[] {
  const [y, m] = month.split("-").map(Number);
  const first = new Date(y, m - 1, 1).getDay() || 7;
  const cells: (string | null)[] = Array(first - 1).fill(null);
  for (let d = 1; d <= daysInMonth(month); d++) cells.push(`${month}-${String(d).padStart(2, "0")}`);
  while (cells.length % 7) cells.push(null);
  return cells;
}
export function monthTitle(month: string) {
  const [y, m] = month.split("-").map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}
export function dur(sec: number) {
  const t = Math.round(sec / 60);
  const h = Math.floor(t / 60);
  return h ? `${h} ч ${t % 60 ? `${t % 60} мин` : ""}`.trim() : `${t} мин`;
}
export function dateWhen(inDays: number) {
  return inDays === 0 ? "сегодня" : inDays === 1 ? "завтра" : inDays === 2 ? "послезавтра" : `через ${inDays} дн.`;
}
export function money(n: number, cur: string) {
  const s = Math.round(n).toLocaleString("ru-RU");
  return `${s} ${cur === "RUB" ? "₽" : cur === "USD" ? "$" : cur === "EUR" ? "€" : cur}`;
}
/** Ответ бота приходит в HTML Telegram — оставляем только текст. */
export function plainReply(s: string) {
  return s.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
export function metricText(m: { value: number; unit: string }) {
  const v = Number.isInteger(m.value) ? m.value.toLocaleString("ru-RU") : m.value.toLocaleString("ru-RU", { maximumFractionDigits: 1 });
  return m.unit.startsWith("/") ? `${v}${m.unit}` : `${v} ${m.unit}`.trim();
}
