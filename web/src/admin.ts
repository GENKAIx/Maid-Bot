// Админка сайта (/admin) без React: разделы и подписи журнала. Ревью — docs/review/админка-2026-11-24.html.
// Каркас (24.11.2026): Обзор и Журнал; этап 1 (24.11.2026): Пользователи, Расходы, Аудитория, Качество разбора — на готовых данных.
// Этап 2 (24.11.2026): онлайн, устройства, карта часов, версии виджета, дорогие сообщения и раздел «Здоровье сервера».
// stage — с какого этапа раздел живой (ADMIN_LIVE_STAGE и меньше — живой, больше — «появится на этапе N»).

export const ADMIN_LIVE_STAGE = 2;

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

/** Клиент входа (заголовок X-Maid-Client; у старых — по метке входа, server/src/auth.ts). */
export const CLIENT_NAMES: Record<string, string> = {
  web: "Сайт", desktop: "Программа на ПК", "desktop-key": "Ключ ПК (сервер)", widget: "Виджет на ПК", quick: "Быстрая запись", iphone: "Айфон",
  "telegram-widget": "Виджет Telegram", telegram: "Telegram", other: "Другое",
};

/** Ветка разбора сообщения (messages.route, server/src/pipeline.ts). */
export const ROUTE_NAMES: Record<string, string> = {
  weather: "Погода", chat: "Разговор", parse: "Разбор упал", clarify: "Уточнение", draw: "Рисование", answer: "Ответ на вопрос",
  talk: "Болтовня", apply: "Запись", correct: "Поправка",
};

/** Код ошибки попытки модели (llm_calls.error_code, server/src/llm.ts). */
export const ERROR_NAMES: Record<string, string> = {
  timeout: "Тайм-аут", net: "Нет сети", http_429: "Лимит (429)", http_5xx: "Сбой провайдера (5xx)", http_4xx: "Отказ (4xx)",
  bad_body: "Плохой ответ", empty: "Пустой ответ", no_key: "Нет ключа", other: "Другое",
};

/** Дни недели карты часов (строки — с понедельника). */
export const ADM_WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

/** Время ответа: 840 → «840 мс», 12 300 → «12.3 с»; нет данных — «—». */
export function msText(v: number | null): string {
  if (v == null) return "—";
  return v < 1000 ? `${Math.round(v)} мс` : `${(v / 1000).toFixed(1)} с`;
}

/** Сколько работает сервер: «45 с», «12 мин», «3 ч 5 мин», «2 дн. 4 ч». */
export function uptimeText(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (h < 1) return `${m} мин`;
  if (d < 1) return `${h} ч ${m % 60} мин`;
  return `${d} дн. ${h % 24} ч`;
}

/** Сортировка таблицы людей: по ключу, числа — по убыванию, строки — по алфавиту; повторный щелчок — наоборот. */
export function sortRows<T extends Record<string, unknown>>(rows: T[], key: keyof T, desc: boolean): T[] {
  const k = (r: T) => r[key] ?? "";
  return [...rows].sort((a, b) => {
    const x = k(a), y = k(b);
    const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "ru");
    return desc ? -c : c;
  });
}
