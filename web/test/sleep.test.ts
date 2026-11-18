import assert from "node:assert/strict";
import { test } from "node:test";
import { sleepDraft } from "../src/sleep.tsx";

// Правка сна на шкале (web/src/sleep.tsx: SleepEditor, sleepDraft): форма открывается со временем, которое уже видно на полосе;
// у пустого дня — 23:00 и 7:00. 18.11.2026.

test("форма сна: время с полосы, у пустого дня — 23:00–07:00", () => {
  assert.deepEqual(sleepDraft({ day: "2026-11-15", bed: 1.5, wake: 10, hours: 8.5 }), { bed: "01:30", wake: "10:00" });
  assert.deepEqual(sleepDraft({ day: "2026-11-15", bed: 23.25, wake: 7, hours: 7.75 }), { bed: "23:15", wake: "07:00" });
  // Известны только часы и подъём — отбой считается назад.
  assert.deepEqual(sleepDraft({ day: "2026-11-15", wake: 9, hours: 8 }), { bed: "01:00", wake: "09:00" });
  assert.deepEqual(sleepDraft({ day: "2026-11-15" }), { bed: "23:00", wake: "07:00" });
  // Только часы, без времени — тоже по умолчанию.
  assert.deepEqual(sleepDraft({ day: "2026-11-15", hours: 6 }), { bed: "23:00", wake: "07:00" });
});
