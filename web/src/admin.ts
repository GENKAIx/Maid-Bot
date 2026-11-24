// Админка сайта (/admin) без React: разделы и подписи журнала. Ревью — docs/review/админка-2026-11-24.html.
// Каркас (24.11.2026): Обзор и Журнал; этап 1 (24.11.2026): Пользователи, Расходы, Аудитория, Качество разбора — на готовых данных.
// stage — с какого этапа раздел живой (ADMIN_LIVE_STAGE и меньше — живой, больше — «появится на этапе N»).

export const ADMIN_LIVE_STAGE = 1;

export type AdminSectionId = "overview" | "users" | "spend" | "audience" | "quality" | "features" | "showcase" | "health" | "log";

export const ADMIN_SECTIONS: { id: AdminSectionId; title: string; stage: number }[] = [
  { id: "overview", title: "Обзор", stage: 0 },
  { id: "users", title: "Пользователи", stage: 1 },
  { id: "spend", title: "Расходы на модель", stage: 1 },
  { id: "audience", title: "Аудитория", stage: 1 },
  { id: "quality", title: "Качество разбора", stage: 1 },
  { id: "features", title: "Использование функций", stage: 3 },
  { id: "showcase", title: "Витрина анимаций", stage: 4 },
  { id: "health", title: "Здоровье сервера", stage: 2 },
  { id: "log", title: "Журнал админки", stage: 0 },
];

/** Раздел по адресу /admin/<раздел>; незнакомый и пустой — Обзор. */
export function adminSection(arg: string | undefined): AdminSectionId {
  return ADMIN_SECTIONS.find((s) => s.id === arg)?.id ?? "overview";
}

export const ADMIN_ACTIONS: Record<string, string> = {
  code: "запросил код в Telegram",
  enter: "вошёл в админку",
  wrong: "ввёл неверный код",
  leave: "вышел из админки",
};

/** Деньги: $0.123 → «$0.12», мелочь — с тремя знаками, ноль — «$0». */
export function usd(v: number): string {
  if (!v) return "$0";
  return v < 0.1 ? `$${v.toFixed(3)}` : `$${v.toFixed(2)}`;
}

/** «Когда»: сегодня — время, вчера — «вчера», раньше — «N дн. назад», больше месяца — дата. */
export function ago(iso: string | null, now = new Date()): string {
  if (!iso) return "—";
  const d = Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000);
  if (d <= 0) return new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  if (d === 1) return "вчера";
  if (d < 31) return `${d} дн. назад`;
  return new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "numeric" });
}

/** Источник сообщения по-человечески. */
export const SOURCE_NAMES: Record<string, string> = {
  telegram: "Telegram", desktop: "Сайт и виджет", app: "Приложение", iphone: "Айфон", button: "Кнопки", push: "Push", panel: "Правки мышью",
};

/** Сортировка таблицы людей: по ключу, числа — по убыванию, строки — по алфавиту; повторный щелчок — наоборот. */
export function sortRows<T extends Record<string, unknown>>(rows: T[], key: keyof T, desc: boolean): T[] {
  const k = (r: T) => r[key] ?? "";
  return [...rows].sort((a, b) => {
    const x = k(a), y = k(b);
    const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "ru");
    return desc ? -c : c;
  });
}
