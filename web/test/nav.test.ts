import assert from "node:assert/strict";
import { test } from "node:test";
import { NAV_TABS, oldPath, settingsTab, settingsTabs } from "../src/nav.ts";

// Меню сайта (web/src/App.tsx), 19.11.2026: Персонализация, Виджет и Настройки — один экран «Настройки» с вкладками;
// Поиск — строкой под логотипом (и Ctrl+K), а не пунктом меню; Каталог из меню убран (ссылка — внизу «Возможностей»).

test("в меню нет Персонализации, Виджета, Поиска и Каталога; Настройки есть", () => {
  const titles = NAV_TABS.map((t) => t.title);
  for (const gone of ["Персонализация", "Виджет", "Поиск", "Каталог"]) assert.ok(!titles.includes(gone), `${gone} в меню`);
  assert.ok(titles.includes("Настройки"));
  assert.ok(titles.includes("Корзина") && titles.includes("Возможности"));
});

test("порядок меню прежний: Профиль, каждый день, учёт, служебное", () => {
  assert.deepEqual(NAV_TABS.map((t) => t.id), [
    "today", "plans", "habits", "diary", "profile", "notes", "health", "money", "stats", "trash", "history", "album", "features", "settings",
  ]);
});

test("вкладки настроек: Горничная, Виджет (только в программе на ПК), Программа", () => {
  assert.deepEqual(settingsTabs(true).map((t) => t.title), ["Горничная", "Виджет", "Программа"]);
  assert.deepEqual(settingsTabs(false).map((t) => t.title), ["Горничная", "Программа"]);
});

test("вкладка по адресу: без вкладки и с незнакомой — Горничная; Виджет вне программы — Горничная", () => {
  assert.equal(settingsTab(undefined, true), "maid");
  assert.equal(settingsTab("app", true), "app");
  assert.equal(settingsTab("widget", true), "widget");
  assert.equal(settingsTab("widget", false), "maid");
  assert.equal(settingsTab("что-то", true), "maid");
});

test("старые адреса ведут на вкладки настроек (виджет на ПК открывает /widget)", () => {
  assert.equal(oldPath("/maid"), "/settings/maid");
  assert.equal(oldPath("/widget"), "/settings/widget");
  assert.equal(oldPath("/settings"), null);
  assert.equal(oldPath("/catalog"), null);
  assert.equal(oldPath("/"), null);
});
