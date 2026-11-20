// Меню сайта и вкладки «Настроек» без React (App.tsx, screens/SettingsTabs.tsx). 19.11.2026: Виджет стал вкладкой «Настроек»,
// Поиск — строкой под логотипом (и Ctrl+K), Каталог — ссылкой внизу «Возможностей». 20.11.2026: Персонализация — снова
// своим пунктом меню, сразу под «Профилем», со счётчиком заполненного «О вас» в названии («2/7»).

export type NavTab = { id: string; path: string; title: string; icon: string; more?: boolean; group?: "track" | "tools" };

/** Порядок — от частого к редкому: каждый день, учёт, служебное. group — разделитель перед группой в меню.
 *  Профиль и Персонализация — на ПК сразу под логотипом, на телефоне — первыми в «Ещё». */
export const NAV_TABS: NavTab[] = [
  { id: "today", path: "/", title: "Сегодня", icon: "today" },
  { id: "plans", path: "/plans", title: "Планы", icon: "plans" },
  { id: "habits", path: "/habits", title: "Привычки", icon: "habits" },
  { id: "diary", path: "/diary", title: "Дневник", icon: "diary" },
  { id: "profile", path: "/profile", title: "Профиль", icon: "profile", more: true },
  { id: "persona", path: "/persona", title: "Персонализация", icon: "persona", more: true },
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

/** Сколько полей в «Персонализации → О вас» (screens/AboutYou.tsx; сервер отдаёт заполненные в /api/you → filled). */
export const YOU_FIELDS = 7;

/** Счётчик в названии пункта меню: у Персонализации — «2/7» по заполненному «О вас»; пока не знаем — ничего. */
export function navCount(id: string, filled: number | null): string | null {
  if (id !== "persona" || filled === null) return null;
  return `${Math.min(filled, YOU_FIELDS)}/${YOU_FIELDS}`;
}

export type SettingsTabId = "widget" | "app";

/** Вкладки «Настроек»: виджет на рабочем столе (только в программе на ПК) и техническое. */
export function settingsTabs(desk: boolean): { id: SettingsTabId; title: string }[] {
  return [
    ...(desk ? [{ id: "widget" as const, title: "Виджет" }] : []),
    { id: "app", title: "Программа" },
  ];
}

/** Открытая вкладка по адресу /settings/<вкладка>; без неё и с незнакомой — первая. */
export function settingsTab(arg: string | undefined, desk: boolean): SettingsTabId {
  const tabs = settingsTabs(desk);
  return tabs.find((t) => t.id === arg)?.id ?? tabs[0].id;
}

/** Прежние адреса: виджет на ПК и старые закладки открывают /widget и /maid; /settings/maid и /settings/persona —
 *  Персонализация, пока она была вкладкой «Настроек» (19–20.11.2026). */
export function oldPath(path: string): string | null {
  const moved: Record<string, string> = { "/maid": "/persona", "/settings/maid": "/persona", "/settings/persona": "/persona", "/widget": "/settings/widget" };
  return moved[path.replace(/\/+$/, "")] ?? null;
}
