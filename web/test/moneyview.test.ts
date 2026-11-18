import assert from "node:assert/strict";
import { test } from "node:test";
import { catColor, catKey, dayGroups, monthForecast, OTHER_COLOR } from "../src/moneyview.ts";
import type { MoneyRow } from "../src/types.ts";

// Экран «Деньги» (web/src/screens/Money.tsx), ревью 18.11.2026: у категории свой цвет везде, прогноз до конца
// месяца, записи по дням.

let id = 0;
const row = (day_key: string, amount: number, category = "", kind: MoneyRow["kind"] = "expense"): MoneyRow =>
  ({ id: ++id, day_key, kind, amount, currency: "RUB", category, note: "" });

test("цвет категории не зависит от порядка и регистра", () => {
  assert.equal(catColor("Кафе"), catColor("кафе"));
  assert.equal(catColor(" кафе "), catColor("кафе"));
  assert.equal(catColor("продукты"), catColor("продукты"));
  assert.equal(catKey(""), "другое");
  assert.equal(catColor(""), OTHER_COLOR);
});

test("частые категории — разного цвета, красного среди них нет", () => {
  const main = ["продукты", "дом", "кафе", "транспорт", "развлечения", "подписки", "еда", "связь", "здоровье", "одежда"];
  const colors = main.map(catColor);
  assert.equal(new Set(colors).size, main.length, colors.join(" "));
  for (const c of colors) assert.ok(/^#[0-9a-f]{6}$/.test(c), c);
  assert.ok(!colors.includes("#e0566a"), "красный — только для перерасхода");
});

test("незнакомая категория получает постоянный цвет", () => {
  assert.equal(catColor("котики"), catColor("котики"));
  assert.ok(/^#[0-9a-f]{6}$/.test(catColor("котики")));
});

test("прогноз текущего месяца: темп за прошедшие дни × дней в месяце", () => {
  const rows = [row("2026-11-02", 18_000), row("2026-11-18", 22_001), row("2026-11-10", 5000, "зарплата", "income")];
  const f = monthForecast(rows, "2026-11", "2026-11-18");
  assert.ok(f);
  assert.equal(f.today, 18);
  assert.equal(Math.round(f.perDay), 2222);
  assert.equal(Math.round(f.total), 66_668);
});

test("прогноза нет для прошлого и будущего месяца и без расходов", () => {
  assert.equal(monthForecast([row("2026-10-02", 100)], "2026-10", "2026-11-18"), null);
  assert.equal(monthForecast([], "2026-12", "2026-11-18"), null);
  assert.equal(monthForecast([row("2026-11-10", 5000, "зарплата", "income")], "2026-11", "2026-11-18"), null);
});

test("записи по дням: свежий день сверху, итог дня со знаком", () => {
  const rows = [row("2026-11-17", 300), row("2026-11-18", 2000), row("2026-11-18", 381), row("2026-11-17", 1000, "зарплата", "income")];
  const g = dayGroups(rows);
  assert.deepEqual(g.map((x) => x.day), ["2026-11-18", "2026-11-17"]);
  assert.equal(g[0].total, -2381);
  assert.equal(g[0].rows.length, 2);
  assert.equal(g[1].total, 700);
  // Внутри дня — последняя запись сверху.
  assert.equal(g[0].rows[0].amount, 381);
});
