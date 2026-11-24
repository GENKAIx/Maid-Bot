import assert from "node:assert/strict";
import { test } from "node:test";
import { adminNavGroups, ADMIN_GROUPS, ADM_WEEKDAYS, ADMIN_ACTIONS, ADMIN_LIVE_STAGE, ADMIN_SECTIONS, adminSection, ago, CLIENT_NAMES, ERROR_NAMES, msText, ROUTE_NAMES, sortRows, uptimeText, usd } from "../src/admin.ts";

// Этап 2: раздел «Здоровье сервера» живой; подписи клиентов, веток и ошибок; время ответа и работы сервера.
test("админка, этап 2: «Здоровье» живое, подписи и форматы", () => {
  assert.equal(adminSection("health"), "health");
  const health = ADMIN_SECTIONS.find((s) => s.id === "health")!;
  assert.ok(health.stage <= ADMIN_LIVE_STAGE, "Здоровье — не «появится»");
  for (const id of ["users", "spend", "audience", "quality"]) assert.ok(ADMIN_SECTIONS.find((s) => s.id === id)!.stage <= ADMIN_LIVE_STAGE, id);
  for (const c of ["web", "desktop", "widget", "quick", "iphone", "telegram-widget", "telegram", "other"]) assert.ok(CLIENT_NAMES[c], c);
  for (const r of ["weather", "chat", "parse", "clarify", "draw", "answer", "talk", "apply", "correct"]) assert.ok(ROUTE_NAMES[r], r);
  for (const e of ["timeout", "net", "http_429", "http_5xx", "http_4xx", "bad_body", "empty", "no_key", "other"]) assert.ok(ERROR_NAMES[e], e);
  assert.equal(ADM_WEEKDAYS.length, 7);
  assert.equal(msText(null), "—");
  assert.equal(msText(840), "840 мс");
  assert.equal(msText(12_300), "12.3 с");
  assert.equal(uptimeText(45), "45 с");
  assert.equal(uptimeText(12 * 60 + 5), "12 мин");
  assert.equal(uptimeText(3 * 3600 + 5 * 60), "3 ч 5 мин");
  assert.equal(uptimeText(2 * 86400 + 4 * 3600), "2 дн. 4 ч");
});

// Разделы админки по адресу /admin/<раздел> (web/src/admin.ts).
test("админка: раздел по адресу, незнакомый — Обзор; журнал подписан", () => {
  assert.equal(adminSection(undefined), "overview");
  assert.equal(adminSection("log"), "log");
  assert.equal(adminSection("nope"), "overview");
  assert.equal(new Set(ADMIN_SECTIONS.map((s) => s.id)).size, ADMIN_SECTIONS.length);
  for (const a of ["code", "enter", "wrong", "leave"]) assert.ok(ADMIN_ACTIONS[a], a);
});

// Этап 1: сортировка таблицы людей, деньги, «когда».
test("админка: сортировка таблицы, деньги и «когда»", () => {
  const rows = [{ name: "Боря", cost: 0.5 }, { name: "Аня", cost: 2 }, { name: "Вера", cost: 0 }];
  assert.deepEqual(sortRows(rows, "cost", true).map((r) => r.name), ["Аня", "Боря", "Вера"]);
  assert.deepEqual(sortRows(rows, "name", false).map((r) => r.name), ["Аня", "Боря", "Вера"]);
  assert.equal(usd(0), "$0");
  assert.equal(usd(0.0123), "$0.012");
  assert.equal(usd(1.5), "$1.50");
  const now = new Date("2026-11-24T12:00:00Z");
  assert.equal(ago(null, now), "—");
  assert.equal(ago("2026-11-23T10:00:00Z", now), "вчера");
  assert.equal(ago("2026-11-14T12:00:00Z", now), "10 дн. назад");
});

test("меню админки: каждый раздел в своей категории, с иконкой, без пустых категорий, порядок — по ADMIN_GROUPS", async () => {
  const { readFileSync } = await import("node:fs");
  const icons = readFileSync(new URL("../src/icons.tsx", import.meta.url), "utf8");
  const nav = adminNavGroups();
  assert.deepEqual(nav.map((g) => g.group), [...ADMIN_GROUPS]);
  assert.equal(nav.flatMap((g) => g.items).length, ADMIN_SECTIONS.length, "все разделы в меню, ни один не потерян");
  for (const s of ADMIN_SECTIONS) assert.ok(icons.includes(`"${s.icon}":`), `иконка ${s.icon} есть в icons.tsx`);
  assert.deepEqual(nav[0].items.map((s) => s.id), ["overview", "analytics"]);
});
