// Админка сайта (/admin) без React: разделы и подписи журнала. Ревью — docs/review/админка-2026-11-24.html.
// Каркас (24.11.2026): живые — Обзор (сколько людей) и Журнал; остальные разделы показывают, на каком этапе появятся.

export type AdminSectionId = "overview" | "users" | "spend" | "audience" | "features" | "showcase" | "health" | "log";

export const ADMIN_SECTIONS: { id: AdminSectionId; title: string; stage: number }[] = [
  { id: "overview", title: "Обзор", stage: 0 },
  { id: "users", title: "Пользователи", stage: 1 },
  { id: "spend", title: "Расходы на модель", stage: 1 },
  { id: "audience", title: "Аудитория", stage: 1 },
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
