import assert from "node:assert/strict";
import { test } from "node:test";
import { ageText, dateGroups, formOf } from "../src/dates.ts";
import type { DateItem } from "../src/types.ts";

// Вкладка «Даты» в «Планах» (screens/Dates.tsx), 19.11.2026: даты не простынёй, а «Скоро» (30 дней) и по месяцам;
// возраст — «исполнится 30», только если год известен; форма правки открывается с днём, месяцем и годом даты.

let id = 0;
const item = (on: string, inDays: number, extra: Partial<DateItem> = {}): DateItem =>
  ({ id: ++id, title: "x", date_iso: on, type: "birthday", person: "", yearly: 1, on, inDays, age: null, year_known: false, ...extra });

test("скоро — 30 дней, остальное по месяцам по порядку, через Новый год", () => {
  const list = [item("2026-11-25", 6), item("2026-12-18", 29), item("2026-12-20", 31), item("2027-01-14", 56), item("2027-01-03", 45), item("2026-12-30", 41)];
  const g = dateGroups(list, 2026);
  assert.deepEqual(g.soon.map((x) => x.on), ["2026-11-25", "2026-12-18"]);
  assert.deepEqual(g.months.map((m) => [m.title, m.items.map((x) => x.on)]), [
    ["Декабрь", ["2026-12-20", "2026-12-30"]],
    ["Январь 2027", ["2027-01-03", "2027-01-14"]],
  ]);
});

test("возраст словами: только когда год известен", () => {
  assert.equal(ageText(item("2026-12-03", 14, { age: 30, year_known: true })), "исполнится 30");
  assert.equal(ageText(item("2026-12-03", 14, { age: 1, year_known: true })), "исполнится 1");
  assert.equal(ageText(item("2026-12-03", 14, { age: 5, year_known: true, type: "anniversary" })), "5 лет");
  assert.equal(ageText(item("2026-12-03", 14, { age: 22, year_known: true, type: "other" })), "22 года");
  assert.equal(ageText(item("2026-12-03", 14, { age: 1, year_known: false })), "");
  assert.equal(ageText(item("2026-12-03", 14, { age: 0, year_known: true })), "");
});

test("форма правки: день, месяц и год (год — только известный)", () => {
  assert.deepEqual(formOf(item("2026-12-03", 14, { date_iso: "1996-12-03", year_known: true, title: "ДР Ивана" })),
    { title: "ДР Ивана", day: 3, month: 12, year: "1996", type: "birthday", yearly: true });
  assert.deepEqual(formOf(item("2026-12-03", 14, { date_iso: "2026-12-03", year_known: false, type: "other", yearly: 0 })),
    { title: "x", day: 3, month: 12, year: "", type: "other", yearly: false });
  assert.deepEqual(formOf(null), { title: "", day: 1, month: 1, year: "", type: "birthday", yearly: true });
});
