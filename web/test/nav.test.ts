import assert from "node:assert/strict";
import { test } from "node:test";
import { hubs, NAV_TABS, navCount, oldPath, settingsTab, settingsTabs, whereAmI, YOU_FIELDS } from "../src/nav.ts";

// Меню сайта (web/src/App.tsx). 27.11.2026 (дизайн v2): пять разделов (Сегодня, Планы, Дневник, Обзор, Рина) и Настройки,
// экраны — вкладки своего раздела; шторки «Ещё» нет. Поиск — строкой в шапке (и Ctrl+K), Каталог — ссылкой внизу «Возможностей».

test("разделы меню: пять главных и Настройки, у «Сегодня» вкладок нет", () => {
  assert.deepEqual(hubs(false).map((h) => h.title), ["Сегодня", "Планы", "Дневник", "Обзор", "Рина", "Настройки"]);
  assert.deepEqual(hubs(false)[0].tabs, []);
  const tabs = (id: string, desk = false) => hubs(desk).find((h) => h.id === id)!.tabs.map((t) => t.title);
  assert.deepEqual(tabs("plans"), ["Неделя", "Привычки", "Даты"]);
  assert.deepEqual(tabs("diary"), ["Дни", "Заметки", "История"]);
  assert.deepEqual(tabs("stats"), ["Статистика", "Деньги", "Здоровье"]);
  assert.deepEqual(tabs("rina"), ["Персонализация", "Профиль", "Альбом", "Возможности"]);
  assert.deepEqual(tabs("settings", true), ["Виджет", "Программа", "Корзина"]);
  assert.deepEqual(tabs("settings", false), ["Программа", "Корзина"]);
});

test("каждый экран сайта, кроме «Сегодня», — вкладка ровно одного раздела; вкладки ведут на экраны", () => {
  const all = hubs(true).flatMap((h) => h.tabs);
  for (const t of NAV_TABS) {
    if (t.id === "today") continue;
    const n = all.filter((x) => x.path === t.path || x.path.startsWith(t.path + "/")).length;
    assert.ok(n >= 1, `экрана ${t.id} нет в меню`);
  }
  const keys = all.map((t) => t.key);
  assert.equal(new Set(keys).size, keys.length, "вкладка в двух разделах");
});

test("где я: раздел и вкладка по адресу", () => {
  const at = (p: string, desk = false) => whereAmI(p, desk);
  assert.deepEqual(at("/"), { hub: "today", tab: null });
  assert.deepEqual(at("/plans"), { hub: "plans", tab: "plans" });
  assert.deepEqual(at("/plans/dates"), { hub: "plans", tab: "plans/dates" });
  assert.deepEqual(at("/habits/2026-11"), { hub: "plans", tab: "habits" });
  assert.deepEqual(at("/diary/2026-11-08"), { hub: "diary", tab: "diary" });
  assert.deepEqual(at("/notes"), { hub: "diary", tab: "notes" });
  assert.deepEqual(at("/history/tasks"), { hub: "diary", tab: "history" });
  assert.deepEqual(at("/money"), { hub: "stats", tab: "money" });
  assert.deepEqual(at("/persona"), { hub: "rina", tab: "persona" });
  assert.deepEqual(at("/features"), { hub: "rina", tab: "features" });
  assert.deepEqual(at("/trash"), { hub: "settings", tab: "trash" });
  assert.deepEqual(at("/settings"), { hub: "settings", tab: "settings/app" });
  assert.deepEqual(at("/settings", true), { hub: "settings", tab: "settings/widget" });
  assert.deepEqual(at("/settings/widget"), { hub: "settings", tab: "settings/app" }, "виджет вне программы — Программа");
  assert.deepEqual(at("/search/кофе"), { hub: null, tab: null });
  assert.deepEqual(at("/catalog"), { hub: null, tab: null });
  assert.deepEqual(at("/непонятно"), { hub: "today", tab: null });
});

test("счётчик Персонализации: «N/7» по заполненному «О вас», у других вкладок — нет", () => {
  assert.equal(YOU_FIELDS, 7);
  assert.equal(navCount("persona", 0), "0/7");
  assert.equal(navCount("persona", 3), "3/7");
  assert.equal(navCount("persona", 9), "7/7", "больше 7 не бывает");
  assert.equal(navCount("persona", null), null, "пока не знаем — без счётчика");
  assert.equal(navCount("profile", 3), null);
});

test("вкладки настроек: Виджет (только в программе на ПК), Программа; Персонализации среди них нет", () => {
  assert.deepEqual(settingsTabs(true).map((t) => t.title), ["Виджет", "Программа"]);
  assert.deepEqual(settingsTabs(false).map((t) => t.title), ["Программа"]);
});

test("вкладка по адресу: без вкладки и с незнакомой — первая; Виджет вне программы — Программа", () => {
  assert.equal(settingsTab(undefined, true), "widget");
  assert.equal(settingsTab(undefined, false), "app");
  assert.equal(settingsTab("app", true), "app");
  assert.equal(settingsTab("widget", true), "widget");
  assert.equal(settingsTab("widget", false), "app");
  assert.equal(settingsTab("persona", true), "widget");
});

test("старые адреса: Персонализация — /persona (была вкладкой «Настроек»), виджет на ПК открывает /widget", () => {
  assert.equal(oldPath("/maid"), "/persona");
  assert.equal(oldPath("/settings/maid"), "/persona");
  assert.equal(oldPath("/settings/persona"), "/persona");
  assert.equal(oldPath("/settings/persona/"), "/persona");
  assert.equal(oldPath("/widget"), "/settings/widget");
  assert.equal(oldPath("/persona"), null);
  assert.equal(oldPath("/settings"), null);
  assert.equal(oldPath("/catalog"), null);
  assert.equal(oldPath("/"), null);
});
