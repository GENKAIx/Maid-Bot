import assert from "node:assert/strict";
import { test } from "node:test";
import { dayFacts, factChips, rateTone, STAT_TABS } from "../src/dayrate.ts";
import type { ActivityRow, MetricRow } from "../src/types.ts";

// Статистика (web/src/screens/Stats.tsx): вкладки сверху и «Оценка дня» — по дню оценка и коротко, что было.

const metric = (day_key: string, key: string, value: number): MetricRow =>
  ({ id: 0, day_key, key, label: key, value, unit: "", note: "", source: "" });
const act = (day_key: string, active_sec: number, games: number): ActivityRow =>
  ({ day_key, source: "pc", active_sec, afk_sec: 0, apps: [], games: games ? [{ name: "Game", sec: games }] : [] });

test("вкладки: Компьютер, Сон, Шаги и спорт, в конце — Оценка дня", () => {
  assert.deepEqual(STAT_TABS.map((t) => t.title), ["Компьютер", "Сон", "Шаги и спорт", "Оценка дня"]);
});

test("сводка дня: оценка, компьютер, сон, записи, шаги, спорт; свежие дни сверху, пустые пропущены", () => {
  const days = ["2026-11-15", "2026-11-16", "2026-11-17"];
  const rows = dayFacts(days, {
    activity: [act("2026-11-17", 9 * 3600, 3600), act("2026-11-17", 600, 0)],
    metrics: [metric("2026-11-17", "rating_day", 8), metric("2026-11-17", "steps", 8200), metric("2026-11-17", "sport_min", 30),
      metric("2026-11-15", "rating_day", 3)],
    sleep: new Map([["2026-11-17", { day: "2026-11-17", bed: 1.5, wake: 9, hours: 7.5 }]]),
    notes: [{ day: "2026-11-17", n: 4 }, { day: "2026-11-01", n: 9 }],
  });
  assert.deepEqual(rows.map((r) => r.day), ["2026-11-17", "2026-11-15"]);
  const [d] = rows;
  assert.equal(d.rating, 8);
  assert.equal(d.pcSec, 9 * 3600 + 600);
  assert.equal(d.gameSec, 3600);
  assert.equal(d.notes, 4);
  assert.deepEqual(factChips(d), ["🖥 9 ч 10 мин (игры 1 ч)", "😴 7,5 ч, 1:30–9:00", "📝 4 записи", `👣 ${(8200).toLocaleString("ru-RU")}`, "🏃 30 мин"]);
  // Только оценка — строка без пунктов.
  assert.equal(rows[1].rating, 3);
  assert.deepEqual(factChips(rows[1]), []);
});

test("сводка дня: нет игр, сон без времени, одна запись", () => {
  const [d] = dayFacts(["2026-11-10"], {
    activity: [act("2026-11-10", 1800, 0)],
    metrics: [metric("2026-11-10", "sleep_hours", 6)],
    sleep: new Map([["2026-11-10", { day: "2026-11-10", hours: 6 }]]),
    notes: [{ day: "2026-11-10", n: 1 }],
  });
  assert.equal(d.rating, undefined);
  assert.deepEqual(factChips(d), ["🖥 30 мин", "😴 6 ч", "📝 1 запись"]);
});

test("цвет оценки: низкая, средняя, высокая", () => {
  assert.deepEqual([1, 4, 5, 7, 8, 10].map(rateTone), ["low", "low", "mid", "mid", "high", "high"]);
});
