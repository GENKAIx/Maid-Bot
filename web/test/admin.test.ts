import assert from "node:assert/strict";
import { test } from "node:test";
import { ADMIN_ACTIONS, ADMIN_SECTIONS, adminSection, ago, sortRows, usd } from "../src/admin.ts";

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
