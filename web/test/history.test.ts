import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { byDay, HISTORY_FILTERS, KIND_NAMES } from "../src/history.ts";

// «История» (web/src/history.ts, screens/History.tsx): у каждого вида письма сервера есть подпись и отбор, письма
// раскладываются по дням в том же порядке, что пришли.

test("история: виды те же, что на сервере, у каждого подпись и ровно один отбор", () => {
  const server = readFileSync(new URL("../../server/src/notices.ts", import.meta.url), "utf8");
  const kinds = [...server.match(/export const NOTICE_KINDS = \[([^\]]+)\]/)![1].matchAll(/"(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(Object.keys(KIND_NAMES).sort(), [...kinds].sort());
  assert.deepEqual(HISTORY_FILTERS[0], { id: "all", title: "Все", kinds: [] });
  const filtered = HISTORY_FILTERS.flatMap((f) => f.kinds);
  assert.deepEqual([...filtered].sort(), [...kinds].sort(), "вид без отбора или в двух отборах");
  assert.equal(new Set(HISTORY_FILTERS.map((f) => f.id)).size, HISTORY_FILTERS.length);
});

test("история: письма по дням, порядок сохраняется", () => {
  const it = (id: number, at: string) => ({ id, kind: "plan", text: "x", emotion: "neutral", at });
  const days = byDay([it(5, "2026-11-17T09:00"), it(4, "2026-11-17T08:00"), it(3, "2026-11-16T22:00"), it(2, "2026-11-16T09:00")], (iso) => iso.slice(0, 10));
  assert.deepEqual(days.map((d) => [d.day, d.items.map((x) => x.id)]), [["2026-11-17", [5, 4]], ["2026-11-16", [3, 2]]]);
  assert.deepEqual(byDay([], (iso) => iso), []);
});
