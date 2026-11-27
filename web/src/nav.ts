// Экраны сайта, разделы меню и вкладки разделов без React (App.tsx, screens/SettingsTabs.tsx).
// 27.11.2026 (дизайн v2, docs/design): вместо 15 пунктов меню и шторки «Ещё» — пять разделов (Сегодня, Планы, Дневник, Обзор,
// Рина) и Настройки; экраны стали вкладками своего раздела. Адреса экранов прежние. Поиск — строкой в шапке (и Ctrl+K).

export type NavTab = { id: string; path: string; title: string; icon: string };

/** Все экраны сайта (адрес → экран — App.tsx; счётчики фич — usage.ts; карта сайта — showcase). Меню из них строит HUBS. */
export const NAV_TABS: NavTab[] = [
  { id: "today", path: "/", title: "Сегодня", icon: "today" },
  { id: "plans", path: "/plans", title: "Планы", icon: "plans" },
  { id: "habits", path: "/habits", title: "Привычки", icon: "habits" },
  { id: "diary", path: "/diary", title: "Дневник", icon: "diary" },
  { id: "profile", path: "/profile", title: "Профиль", icon: "profile" },
  { id: "persona", path: "/persona", title: "Персонализация", icon: "persona" },
  { id: "notes", path: "/notes", title: "Заметки", icon: "notes" },
  { id: "health", path: "/health", title: "Здоровье", icon: "health" },
  { id: "money", path: "/money", title: "Деньги", icon: "money" },
  { id: "stats", path: "/stats", title: "Статистика", icon: "stats" },
  { id: "trash", path: "/trash", title: "Корзина", icon: "trash" },
  { id: "history", path: "/history", title: "История", icon: "history" },
  { id: "album", path: "/album", title: "Альбом", icon: "album" },
  { id: "features", path: "/features", title: "Возможности", icon: "features" },
  { id: "settings", path: "/settings", title: "Настройки", icon: "settings" },
];

export type HubId = "today" | "plans" | "diary" | "stats" | "rina" | "settings";
/** Вкладка раздела: key — какой экран открыт (см. whereAmI), path — куда ведёт. */
export type HubTab = { key: string; path: string; title: string };
export type Hub = { id: HubId; title: string; icon: string; path: string; tabs: HubTab[] };

/** Разделы меню: пять главных (слева на ПК, внизу на телефоне) и Настройки (внизу меню на ПК, шестерёнка в шапке на телефоне).
 *  У «Сегодня» вкладок нет. «Виджет» — только в программе на ПК (desk). */
export function hubs(desk: boolean): Hub[] {
  return [
    { id: "today", title: "Сегодня", icon: "today", path: "/", tabs: [] },
    { id: "plans", title: "Планы", icon: "plans", path: "/plans", tabs: [
      { key: "plans", path: "/plans", title: "Неделя" },
      { key: "habits", path: "/habits", title: "Привычки" },
      { key: "plans/dates", path: "/plans/dates", title: "Даты" },
    ] },
    { id: "diary", title: "Дневник", icon: "diary", path: "/diary", tabs: [
      { key: "diary", path: "/diary", title: "Дни" },
      { key: "notes", path: "/notes", title: "Заметки" },
      { key: "history", path: "/history", title: "История" },
    ] },
    { id: "stats", title: "Обзор", icon: "stats", path: "/stats", tabs: [
      { key: "stats", path: "/stats", title: "Статистика" },
      { key: "money", path: "/money", title: "Деньги" },
      { key: "health", path: "/health", title: "Здоровье" },
    ] },
    { id: "rina", title: "Рина", icon: "rina", path: "/persona", tabs: [
      { key: "persona", path: "/persona", title: "Персонализация" },
      { key: "profile", path: "/profile", title: "Профиль" },
      { key: "album", path: "/album", title: "Альбом" },
      { key: "features", path: "/features", title: "Возможности" },
    ] },
    { id: "settings", title: "Настройки", icon: "settings", path: "/settings", tabs: [
      ...settingsTabs(desk).map((t) => ({ key: `settings/${t.id}`, path: `/settings/${t.id}`, title: t.title })),
      { key: "trash", path: "/trash", title: "Корзина" },
    ] },
  ];
}

/** Какой раздел и какая вкладка открыты по адресу. Поиск и Каталог — вне разделов (hub null); незнакомый адрес — «Сегодня». */
export function whereAmI(path: string, desk: boolean): { hub: HubId | null; tab: string | null } {
  const [, a = "", b] = path.split("/");
  if (a === "search" || a === "catalog") return { hub: null, tab: null };
  if (a === "plans") return { hub: "plans", tab: b === "dates" ? "plans/dates" : "plans" };
  if (a === "settings") return { hub: "settings", tab: `settings/${settingsTab(b || undefined, desk)}` };
  for (const h of hubs(desk)) if (h.tabs.some((t) => t.key === a)) return { hub: h.id, tab: a };
  return { hub: "today", tab: null };
}

/** Сколько полей в «Персонализации → О вас» (screens/AboutYou.tsx; сервер отдаёт заполненные в /api/you → filled). */
export const YOU_FIELDS = 7;

/** Счётчик на вкладке: у Персонализации — «2/7» по заполненному «О вас»; пока не знаем — ничего. */
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
