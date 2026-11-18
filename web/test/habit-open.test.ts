import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { habitFromSearch } from "../src/screens/Habits.tsx";

// Щелчок по названию привычки в виджете на ПК открывает «/habits?h=12»: страница раскрывает статистику этой привычки
// и подсвечивает её строку (Habits.tsx, styles.css .hg-flash).

test("привычка из адреса: только целое число в h", () => {
  assert.equal(habitFromSearch("?h=12"), 12);
  assert.equal(habitFromSearch("?x=1&h=7"), 7);
  assert.equal(habitFromSearch(""), null);
  assert.equal(habitFromSearch("?h="), null);
  assert.equal(habitFromSearch("?h=abc"), null);
  assert.equal(habitFromSearch("?h=-3"), null);
  assert.equal(habitFromSearch("?h=1.5"), null);
});

test("страница привычек: по ?h= раскрывает статистику, подсвечивает строку и чистит адрес", () => {
  const src = readFileSync(new URL("../src/screens/Habits.tsx", import.meta.url), "utf8");
  assert.match(src, /habitFromSearch\(location\.search\)/);
  assert.match(src, /setStats\(id\);\s*setFlash\(id\);/);
  assert.match(src, /history\.replaceState\(null, "", location\.pathname\)/);
  assert.match(src, /data-habit-row=\{h\.id\}/);
  assert.match(src, /scrollIntoView/);
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.hg-title\.hg-flash \{[^}]*animation: hg-flash-title/);
  assert.match(css, /\.hg-cell\.hg-flash \{[^}]*animation: hg-flash-cell/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{\s*\.hg-title\.hg-flash \{ animation: none/);
});
