import assert from "node:assert/strict";
import { test } from "node:test";
import type { EventRow } from "../src/db.ts";
import { PERSONAS } from "../src/personas.ts";
import { tomorrowText } from "../src/report.ts";

// Облачко «Завтра» (scheduler.ts → tomorrowText, 18.11.2026): начинается с обращения голосом характера («Хозяин, вот планы
// на завтра»), потом день словами («Четверг, 19 ноября» — без «Чт:»), сначала дела на весь день, потом по времени.

const ev = (title: string, time: string | null, end_time: string | null = null) =>
  ({ id: 1, title, time, end_time, date_iso: "2026-11-19" }) as unknown as EventRow;

test("завтра: обращение, день словами, «весь день» первым", () => {
  const text = tomorrowText([ev("Продать акции", "19:00"), ev("Обед", "13:00", "14:00"), ev("Листинг акций", null)], "2026-11-19", PERSONAS.strict.tomorrow);
  const lines = text.split("\n");
  assert.ok(lines[0].startsWith("🌙 Хозяин"), lines[0]); // 🌙 — по нему notices.ts узнаёт раздел «tomorrow»
  assert.equal(lines[1], "Четверг, 19 ноября");
  assert.deepEqual(lines.slice(2), ["• весь день — Листинг акций", "• 13:00–14:00 — Обед", "• 19:00 — Продать акции"]);
  assert.ok(!/Чт:/.test(text));
});

test("у каждого характера своё обращение к хозяину", () => {
  const all = Object.values(PERSONAS).map((p) => p.tomorrow);
  for (const t of all) assert.match(t, /^Хозяин/);
  assert.equal(new Set(all).size, all.length);
});

test("название с < и > экранируется (Telegram — HTML)", () => {
  assert.match(tomorrowText([ev("a <b> c", "10:00")], "2026-11-19", "Хозяин:"), /a &lt;b&gt; c/);
});
