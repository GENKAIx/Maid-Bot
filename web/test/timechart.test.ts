import assert from "node:assert/strict";
import { test } from "node:test";
import { DAY_END, hhmm, lineRuns, medianMin, timeScale, tipLeft, tipTop, toMin } from "../src/timechart.ts";

// График «Во сколько отмечали» в раскрытой привычке: шкала времени, медиана, куски линии, подсказка над точкой
// (отрезки, полосы «обычно» и подписи дней — web/test/habit-panel.test.ts).

test("шкала времени: целые часы с запасом, позже — выше, не уже 2 часов, не больше 5 подписей", () => {
  // 12:04 и 12:40, напоминание 12:00 → с запасом 30 мин: 11:00–14:00 по часу.
  assert.deepEqual(timeScale([724, 760, 720]), { lo: 660, hi: 840, ticks: [660, 720, 780, 840] });
  // 07:15 … 23:50 → 06:00–23:59 по 6 часов, «24:00» не подписывается.
  const wide = timeScale([435, 1430]);
  assert.equal(wide.hi, DAY_END);
  assert.deepEqual(wide.ticks.map(hhmm), ["06:00", "12:00", "18:00"]);
  assert.deepEqual(timeScale([1439]).ticks.map(hhmm), ["21:00", "22:00", "23:00"]);
  assert.deepEqual(timeScale([]).ticks.map(hhmm), ["00:00", "06:00", "12:00", "18:00"]);
  for (const mins of [[0], [1439], [1420, 1439], [300, 302], [60, 1400], [600, 900], [0, 1439]]) {
    const s = timeScale(mins);
    assert.ok(s.lo >= 0 && s.hi <= DAY_END && s.hi - s.lo >= 120, `диапазон ${mins}`);
    assert.ok(s.ticks.every((t) => t <= 1380), `подписи не позже 23:00 ${mins}`);
    assert.ok(s.ticks.length >= 2 && s.ticks.length <= 5, `подписи ${mins}`);
    assert.ok(mins.every((m) => m >= s.lo && m <= s.hi), `всё внутри ${mins}`);
    assert.ok(s.ticks.every((t) => t % 60 === 0));
  }
});

test("медиана, часы-минуты, куски линии", () => {
  assert.equal(medianMin([]), null);
  assert.equal(medianMin([760, 700, 724]), 724);
  assert.equal(medianMin([700, 760]), 730);
  assert.equal(hhmm(730), "12:10");
  assert.equal(toMin("08:05"), 485);
  const pts = [{ day: "a", gap: false }, { day: "b", gap: false }, { day: "c", gap: true }, { day: "d", gap: true }, { day: "e", gap: false }];
  assert.deepEqual(lineRuns(pts).map((r) => r.map((p) => p.day).join("")), ["ab", "c", "de"], "сплошные куски");
});

test("подсказка у краёв по своей ширине, у верхнего края — под точкой", () => {
  assert.equal(tipLeft(160, 100, 320), 110, "в середине — по центру");
  assert.equal(tipLeft(310, 100, 320), 216, "у правого края — прижата вправо");
  assert.equal(tipLeft(45, 100, 320), 4, "у левого края — прижата влево");
  assert.equal(tipTop(100), 70);
  assert.equal(tipTop(12), 22);
});
