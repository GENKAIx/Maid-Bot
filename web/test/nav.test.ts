import assert from "node:assert/strict";
import { test } from "node:test";
import { NAV_TABS, navCount, oldPath, settingsTab, settingsTabs, YOU_FIELDS } from "../src/nav.ts";

// Меню сайта (web/src/App.tsx), 19.11.2026: Виджет и Настройки — один экран «Настройки» с вкладками; Поиск — строкой под
// логотипом (и Ctrl+K), а не пунктом меню; Каталог из меню убран (ссылка — внизу «Возможностей»).
// 20.11.2026: Персонализация — снова своим пунктом, сразу под «Профилем», со счётчиком «О вас» в названии («2/7»).

test("в меню нет Виджета, Поиска и Каталога; Персонализация и Настройки есть", () => {
  const titles = NAV_TABS.map((t) => t.title);
  for (const gone of ["Виджет", "Поиск", "Каталог"]) assert.ok(!titles.includes(gone), `${gone} в меню`);
  assert.ok(titles.includes("Настройки") && titles.includes("Персонализация"));
  assert.ok(titles.includes("Корзина") && titles.includes("Возможности"));
});

test("порядок меню: Персонализация сразу после Профиля", () => {
  assert.deepEqual(NAV_TABS.map((t) => t.id), [
    "today", "plans", "habits", "diary", "profile", "persona", "notes", "health", "money", "stats", "trash", "history", "album", "features", "settings",
  ]);
  const p = NAV_TABS.find((t) => t.id === "persona")!;
  assert.equal(p.path, "/persona");
  assert.ok(p.more, "на телефоне — в «Ещё», рядом с Профилем");
});

test("счётчик Персонализации: «N/7» по заполненному «О вас», у других пунктов — нет", () => {
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
