// Меню сайта и вкладки «Настроек» без React (App.tsx, screens/SettingsTabs.tsx). 19.11.2026: Персонализация и Виджет стали
// вкладками «Настроек», Поиск — строкой под логотипом (и Ctrl+K), Каталог — ссылкой внизу «Возможностей».

export type NavTab = { id: string; path: string; title: string; icon: string; more?: boolean; group?: "track" | "tools" };

/** Порядок — от частого к редкому: каждый день, учёт, служебное. group — разделитель перед группой в меню.
 *  Профиль — на ПК сразу под логотипом, на телефоне — первым в «Ещё». */
export const NAV_TABS: NavTab[] = [
  { id: "today", path: "/", title: "Сегодня", icon: "today" },
  { id: "plans", path: "/plans", title: "Планы", icon: "plans" },
  { id: "habits", path: "/habits", title: "Привычки", icon: "habits" },
  { id: "diary", path: "/diary", title: "Дневник", icon: "diary" },
  { id: "profile", path: "/profile", title: "Профиль", icon: "profile", more: true },
  { id: "notes", path: "/notes", title: "Заметки", icon: "notes", more: true },
  { id: "health", path: "/health", title: "Здоровье", icon: "health", more: true, group: "track" },
  { id: "money", path: "/money", title: "Деньги", icon: "money", more: true },
  { id: "stats", path: "/stats", title: "Статистика", icon: "stats", more: true },
  { id: "trash", path: "/trash", title: "Корзина", icon: "trash", more: true, group: "tools" },
  { id: "history", path: "/history", title: "История", icon: "history", more: true },
  { id: "album", path: "/album", title: "Альбом", icon: "album", more: true },
  { id: "features", path: "/features", title: "Возможности", icon: "features", more: true },
  { id: "settings", path: "/settings", title: "Настройки", icon: "settings", more: true },
];

export type SettingsTabId = "maid" | "widget" | "app";

/** Вкладки «Настроек»: как пишет горничная, виджет на рабочем столе (только в программе на ПК), техническое. */
export function settingsTabs(desk: boolean): { id: SettingsTabId; title: string }[] {
  return [
    { id: "maid", title: "Горничная" },
    ...(desk ? [{ id: "widget" as const, title: "Виджет" }] : []),
    { id: "app", title: "Программа" },
  ];
}

/** Открытая вкладка по адресу /settings/<вкладка>; без неё и с незнакомой — первая. */
export function settingsTab(arg: string | undefined, desk: boolean): SettingsTabId {
  return settingsTabs(desk).find((t) => t.id === arg)?.id ?? "maid";
}

/** Прежние адреса разделов, ставших вкладками: виджет на ПК и старые закладки открывают /widget и /maid. */
export function oldPath(path: string): string | null {
  const moved: Record<string, string> = { "/maid": "/settings/maid", "/widget": "/settings/widget" };
  return moved[path.replace(/\/+$/, "")] ?? null;
}
