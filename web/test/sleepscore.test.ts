import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { hoursAxis, sleepScorePairs, sleepScorePoints, sleepScoreSummary, sleepScoreTakeaway, sleepScoreTip, sleepThreshold } from "../src/sleepscore.ts";
import type { SleepDay } from "../src/sleep.ts";

// «Статистика → Сон»: график «Сон и оценка дня» (web/src/sleepscore.ts, SleepScoreChart в charts.tsx).

const sleep = (rows: [string, number][]) => new Map<string, SleepDay>(rows.map(([day, hours]) => [day, { day, hours }]));
const pair = (day: string, hours: number, score: number) => ({ day, hours, score });

test("пара — сон и оценка одного и того же дня; дни без одного из двух не попадают", () => {
  const s = sleep([["2026-11-01", 8], ["2026-11-02", 6], ["2026-11-04", 9]]);
  s.set("2026-11-03", { day: "2026-11-03" }); // запись без часов
  const scores = new Map([["2026-11-01", 7], ["2026-11-03", 5], ["2026-11-04", 9], ["2026-11-05", 4]]);
  const p = sleepScorePairs(["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"], s, scores);
  assert.deepEqual(p, [pair("2026-11-01", 8, 7), pair("2026-11-04", 9, 9)]);
  // Только дни периода.
  assert.deepEqual(sleepScorePairs(["2026-11-04"], s, scores), [pair("2026-11-04", 9, 9)]);
});

test("меньше 6 пар (две группы по 3 дня) — вывода нет", () => {
  assert.equal(sleepScoreTakeaway([pair("a", 8, 7), pair("b", 6, 4), pair("c", 9, 8), pair("d", 5, 3)]), null);
});

test("порог — целый час, группы не меньше 3 дней и как можно ровнее", () => {
  assert.equal(sleepThreshold([5, 6, 6.5, 8, 9, 9.5]), 7);
  // Целый час не делит 3 на 3 — берётся полчаса.
  assert.equal(sleepThreshold([7.1, 7.2, 7.3, 7.6, 7.7, 7.8]), 7.5);
  assert.equal(sleepThreshold([8, 8, 8, 8, 8]), null);
  // Каждая группа ≥ 3: из 7 дней не делить 1 к 6.
  const t = sleepThreshold([4, 8, 8.5, 9, 9, 9.5, 10])!;
  const hi = [4, 8, 8.5, 9, 9, 9.5, 10].filter((h) => h >= t).length;
  assert.ok(hi >= 3 && 7 - hi >= 3);
});

test("вывод: средняя оценка после сна от порога и меньше", () => {
  const ps = [pair("a", 9, 8), pair("b", 9.5, 7), pair("c", 10, 9), pair("d", 5, 4), pair("e", 6, 3), pair("f", 6.5, 5)];
  assert.equal(sleepScoreTakeaway(ps), "После 8 ч и больше — в среднем 8,0, после меньше 8 ч — 4,0");
  assert.equal(sleepScoreTakeaway([8, 8, 8.5, 8, 8, 7.5].map((h, i) => pair(String(i), h, 6))), "Сон почти всегда около 8 ч, оценка в среднем 6,0");
  // На две группы по 3 дня не делится, а разброс широкий — не «почти всегда около», а «Мало дней…».
  assert.equal(sleepScoreTakeaway([4, 5, 9, 9, 9, 9].map((h, i) => pair(String(i), h, 6))), null);
  assert.equal(sleepScoreTakeaway([4, 6, 8, 9, 10].map((h, i) => pair(String(i), h, 6))), null, "5 дней — ещё мало");
  assert.match(sleepScoreSummary(ps), /^Сон и оценка дня: 6 дн. После 8 ч/);
});

test("совпадающие точки склеиваются, подсказка называет дни", () => {
  const pts = sleepScorePoints([pair("2026-11-12", 9, 8), pair("2026-11-14", 9.05, 8), pair("2026-11-15", 9, 7)]);
  assert.equal(pts.length, 2);
  assert.equal(sleepScoreTip(pts[0]), "12 ноя, 14 ноя: сон 9 ч, оценка 8");
  assert.equal(sleepScoreTip({ days: ["2026-11-12"], hours: 7.5, score: 8 }), "12 ноя: сон 7,5 ч, оценка 8");
  assert.equal(sleepScoreTip({ days: ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04"], hours: 8, score: 6 }), "1 ноя, 2 ноя и ещё 2: сон 8 ч, оценка 6");
});

test("ось часов: не уже 4 ч, подписи целыми часами", () => {
  assert.deepEqual(hoursAxis([7.5, 8]), { lo: 5, hi: 9, ticks: [5, 6, 7, 8, 9] });
  assert.deepEqual(hoursAxis([3, 13]).ticks, [4, 6, 8, 10, 12]);
  assert.equal(hoursAxis([]).hi - hoursAxis([]).lo, 4);
});

test("вкладка «Сон»: график под шкалой, весь период, «Мало дней…», таблица и подпись для диктора", () => {
  const stats = readFileSync(new URL("../src/screens/Stats.tsx", import.meta.url), "utf8");
  assert.match(stats, /sleepScorePairs\(allDays, sd, dayScores\(metrics\)\)/);
  assert.match(stats, /Мало дней, где есть и сон, и оценка/);
  const charts = readFileSync(new URL("../src/charts.tsx", import.meta.url), "utf8");
  const chart = charts.slice(charts.indexOf("export function SleepScoreChart"));
  assert.match(chart, /aria-label=\{sleepScoreSummary\(pairs\)\}/);
  assert.match(chart, /<summary>Таблицей<\/summary>/);
  assert.match(chart, /stroke="var\(--panel\)" strokeWidth=\{2\}/);
  assert.match(chart, /r=\{12\}/); // попадание 24 px
});
