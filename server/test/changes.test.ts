import assert from "node:assert/strict";
import { test } from "node:test";
import { changesList } from "../src/report.ts";

const none = { sections: [], summary: false, events: 0, tasks: 0, dates: 0, memory: 0, edits: [] };

test("только строка в хронике дня — ответ без «📓 …» (обычное сообщение, без «Отменить»)", () => {
  assert.deepEqual(changesList({ ...none, summary: true }), []);
});

test("запись в раздел дневника — «📓 раздел» остаётся", () => {
  const out = changesList({ ...none, sections: ["hobby"] as never, summary: true });
  assert.equal(out.length, 1);
  assert.match(out[0], /^📓 /);
});
