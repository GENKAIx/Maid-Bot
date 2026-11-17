import assert from "node:assert/strict";
import { test } from "node:test";
import { dayParts, STAT_DEFAULT, STAT_RANGES } from "../src/pcday.ts";

// Статистика (web/src/screens/Stats.tsx): вид «День» и круг суток «за ПК / из них игры / не за ПК».

// 17.11.2026: по умолчанию — месяц (просьба владельца), а не один день.
test("статистика открывается на месяце; периоды по порядку", () => {
  assert.equal(STAT_DEFAULT, "month");
  assert.equal(STAT_RANGES.find((r) => r.id === STAT_DEFAULT)?.days, 30);
  assert.equal(STAT_RANGES[0].id, "day");
  assert.deepEqual(STAT_RANGES.map((r) => r.title), ["День", "Неделя", "Месяц", "3 месяца", "Год"]);
});

test("круг суток: игры внутри времени за ПК, вместе — целые сутки", () => {
  assert.deepEqual(dayParts(3 * 3600, 3600), { pc: 3 * 3600, games: 3600, pcRest: 2 * 3600, off: 21 * 3600 });
  // Прежний трекер: игр больше, чем «за ПК», — за ПК не меньше игр.
  assert.deepEqual(dayParts(1800, 3600), { pc: 3600, games: 3600, pcRest: 0, off: 82800 });
  // Больше суток (сложили два источника) — не больше круга.
  const p = dayParts(30 * 3600, 2 * 3600);
  assert.equal(p.pc + p.off, 86400);
  assert.deepEqual(dayParts(0, 0), { pc: 0, games: 0, pcRest: 0, off: 86400 });
});
