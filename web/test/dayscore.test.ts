import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { avgText, BADGE_ZONE, clearBadge, dayScores, monthAverage, scoreNum, scoreTip, scoreTone } from "../src/dayscore.ts";
import type { MetricRow } from "../src/types.ts";

// «Дневник» (web/src/screens/Diary.tsx): оценка дня кружком в клетке календаря и средняя за месяц под ним.

const metric = (day_key: string, key: string, value: number): MetricRow =>
  ({ id: 0, day_key, key, label: key, value, unit: "", note: "", source: "" });

test("оценка дня — первая строка rating_day за день, другие показатели не путаются", () => {
  const s = dayScores([metric("2026-11-01", "steps", 9000), metric("2026-11-01", "rating_day", 7), metric("2026-11-01", "rating_day", 3), metric("2026-11-02", "rating_day", 9)]);
  assert.deepEqual([...s], [["2026-11-01", 7], ["2026-11-02", 9]]);
  assert.equal(dayScores([metric("2026-11-01", "steps", 5)]).size, 0);
});

test("цвет кружка: две красные ступени, серая середина, две зелёные — по две оценки на ступень", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(scoreTone), ["low2", "low2", "low1", "low1", "mid", "mid", "high1", "high1", "high2", "high2"]);
  assert.equal(scoreTone(0), "low2");
  assert.equal(scoreTone(12), "high2");
});

test("число в кружке и подсказка: целое 1–10", () => {
  assert.equal(scoreNum(6.6), 7);
  assert.equal(scoreNum(0), 1);
  assert.equal(scoreNum(11), 10);
  assert.equal(scoreTip(7), "Оценка дня: 7/10");
});

test("средняя за месяц — только дни этого месяца с оценкой; нет оценок — нет строки", () => {
  const s = new Map([["2026-11-01", 7], ["2026-11-02", 6], ["2026-11-30", 6], ["2026-10-31", 1], ["2026-12-01", 10]]);
  assert.equal(avgText(monthAverage(s, "2026-11")!), "6,3");
  assert.equal(monthAverage(s, "2026-09"), undefined);
  assert.equal(avgText(7), "7,0");
  assert.equal(avgText(6.44), "6,4");
});

test("наклейки в клетке с оценкой не заходят под кружок справа сверху", () => {
  const out = clearBadge([{ x: 72, y: 36, s: 38, r: 0 }, { x: 30, y: 70, s: 40, r: 5 }, { x: 52, y: 56, s: 62, r: 0 }]);
  for (const p of out) {
    const underBadge = p.x + p.s / 2 > BADGE_ZONE.x && p.y - p.s / 2 < BADGE_ZONE.y;
    assert.equal(underBadge, false, JSON.stringify(p));
    assert.ok(p.y + p.s / 2 <= 100, "не вылезает за низ клетки");
  }
  assert.equal(out[1].y, 70, "наклейка слева внизу остаётся на месте");
  assert.equal(out[1].r, 5);
});

test("место кружка с запасом накрывает кружок в самой узкой клетке; крупная выбранная наклейка тоже обходит его", () => {
  // 320 px: клетка ~32,6×34 px, кружок 12 px с отступом 2 px справа и сверху.
  const cellW = 32.6, cellH = 34;
  assert.ok(BADGE_ZONE.x <= ((cellW - 14) / cellW) * 100);
  assert.ok(BADGE_ZONE.y >= (14 / cellH) * 100);
  const [big] = clearBadge([{ x: 66, y: 40, s: 62 * 1.3, r: 0 }]);
  assert.equal(big.x + big.s / 2 > BADGE_ZONE.x && big.y - big.s / 2 < BADGE_ZONE.y, false, JSON.stringify(big));
});

test("пустая клетка календаря не роняет «Дневник»: scatter при 0 наклеек — пусто (26.11.2026)", () => {
  const src = readFileSync(new URL("../src/screens/Diary.tsx", import.meta.url), "utf8");
  // Наклейки считаются для каждой клетки; без этой проверки SPOTS[-1].map падал на любом пустом дне.
  assert.match(src, /function scatter\(day: string, n: number\) \{[\s\S]*?if \(n <= 0\) return \[\];[\s\S]*?SPOTS\[Math\.min\(n, CELL_MAX\) - 1\]/);
});
