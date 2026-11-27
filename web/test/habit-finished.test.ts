import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { cellTitle, finishedSummary, habitPlace, markTip } from "../src/habitview.ts";

// Страница «Привычки» (26.11.2026): время отметки в подсказке клетки и в «Сегодня», карточка «Завершённые», «?h=» на завершённую.
// Время и день отметки уже в поясе человека — их считает сервер (at_time, at_day).

test("время отметки: сделано, пропуск, задним числом, минус в полночь", () => {
  assert.equal(markTip({ status: "done", at_time: "21:14", at_day: null }), "сделано в 21:14");
  assert.equal(markTip({ status: "skipped", at_time: "21:14", at_day: null }), "пропуск в 21:14");
  assert.equal(markTip({ status: "done", at_time: "10:02", at_day: "2026-11-26" }), "отмечено 26 ноя в 10:02");
  // Минус в полночь и пустая клетка — без времени.
  assert.equal(markTip({ status: "skipped", at_time: null, at_day: null }), "");
  assert.equal(markTip({ status: null }), "");
});

test("подсказка клетки сетки", () => {
  assert.equal(cellTitle({ day: "2026-11-26", due: true, status: "done", at_time: "21:14", at_day: null }), "2026-11-26 — сделано в 21:14");
  assert.equal(cellTitle({ day: "2026-11-25", due: true, status: "done", at_time: "10:02", at_day: "2026-11-26" }), "2026-11-25 — сделано · отмечено 26 ноя в 10:02");
  assert.equal(cellTitle({ day: "2026-11-24", due: true, status: "skipped", at_time: null, at_day: null }), "2026-11-24 — пропуск");
  assert.equal(cellTitle({ day: "2026-11-27", due: true, status: null }), "2026-11-27 — запланировано");
  assert.equal(cellTitle({ day: "2026-11-23", due: false, status: null }), "2026-11-23");
  assert.equal(cellTitle({ day: "2026-11-26", due: true, status: "done", amount: 35, unit: "стр.", at_time: "08:05", at_day: null }), "2026-11-26 — сделано в 08:05 · 35 стр.");
});

test("строка завершённой привычки", () => {
  assert.equal(finishedSummary({ start_date: "2026-10-03", end_date: "2026-11-25", done: 42, planned: 50 }), "3 окт – 25 ноя · 42 из 50 (84 %)");
  assert.equal(finishedSummary({ start_date: "2026-11-26", end_date: "2026-11-26", done: 0, planned: 0 }), "26 ноя · 0 из 0");
});

test("?h= находит привычку в сетке, в «Завершённых» или нигде", () => {
  const data = { habits: [{ id: 1 }], finished: [{ id: 7 }] } as unknown as Parameters<typeof habitPlace>[0];
  assert.equal(habitPlace(data, 1), "grid");
  assert.equal(habitPlace(data, 7), "finished");
  assert.equal(habitPlace(data, 9), null);
  assert.equal(habitPlace({ habits: [] } as unknown as Parameters<typeof habitPlace>[0], 7), null);
});

test("страница привычек: «Завершить», карточка «Завершённые», «Вернуть», ?h= на завершённую, время в «Сегодня»", () => {
  const src = readFileSync(new URL("../src/screens/Habits.tsx", import.meta.url), "utf8");
  assert.match(src, /edit\(h, \{ finish: true \}\)/);
  // «🏁» — одна иконка, а 🔔 со временем не ужимается в «🔔…» (снимок стенда 26.11.2026).
  assert.match(src, /aria-label="Завершить привычку">\s*🏁\s*</);
  assert.match(src, /edit\(f, \{ reopen: true \}\)/);
  assert.match(src, /Завершённые \(\{data\.finished\.length\}\)/);
  assert.match(src, /<details open=\{doneOpen\}/);
  // ?h= на завершённую: раскрыть «Завершённые» и её статистику; строка тоже несёт data-habit-row для прокрутки.
  assert.match(src, /place === "finished"\) \{\s*setDoneOpen\(true\);\s*setDoneStats\(id\);/);
  // Прокрутка к завершённой — только когда «Завершённые» и её статистика уже раскрыты (иначе у строки нет места на экране).
  assert.match(src, /scrollDone\.current = id;/);
  assert.match(src, /if \(id == null \|\| !doneOpen \|\| doneStats !== id\) return;[\s\S]*scrollIntoView[\s\S]*\}, \[doneOpen, doneStats\]\);/);
  assert.match(src, /data-habit-row=\{f\.id\}/);
  assert.match(src, /<HabitStatsPanel [^>]*finished \/>/);
  // «закончилась …» больше нет: такие привычки не в сетке.
  assert.doesNotMatch(src, /закончилась/);
  // Открыто ли — в localStorage, обёрнуто в try.
  assert.match(src, /try \{ return localStorage\.getItem\(DONE_OPEN_KEY\)/);
  const today = readFileSync(new URL("../src/screens/Today.tsx", import.meta.url), "utf8");
  assert.match(today, /h\.status === "done" && h\.at_time && <span className="habit-at"/);
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.hg-done-text \{[^}]*overflow-wrap: anywhere/);
  assert.match(css, /\.hg-done-head \{[^}]*flex-wrap: wrap/);
  assert.match(css, /\.hg-done \.hp-gr \{[^}]*minmax\(min\(250px, 100%\), 1fr\)/, "блоки статистики не шире карточки на 320 px");
});
