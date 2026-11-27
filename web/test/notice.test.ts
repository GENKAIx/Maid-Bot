import assert from "node:assert/strict";
import { test } from "node:test";
import { NOTE_MS, backupName, backupProblem, failNote, noteMs, noteRole, shortText } from "../src/notice.ts";

// Плашка сообщения на экранах (components.tsx NoteBar): сколько висит, как читается, тексты сбоя; резервная копия.

test("плашка: итог висит 8 секунд и читается как status, сбой — до закрытия и как alert", () => {
  assert.equal(NOTE_MS, 8000);
  assert.equal(noteMs({ text: "«Купить хлеб» — сделано", undo: 5 }), 8000);
  assert.equal(noteMs({ text: "Не получилось", bad: true }), 0);
  assert.equal(noteRole({ text: "Сохранено." }), "status");
  assert.equal(noteRole({ text: "Не сохранилось", bad: true }), "alert");
});

test("плашка: причина сбоя и короткий текст записи", () => {
  assert.deepEqual(failNote("Не получилось удалить запись", new Error("сервер 500")), { text: "Не получилось удалить запись: сервер 500", bad: true });
  assert.deepEqual(failNote("Не получилось вернуть", "что-то"), { text: "Не получилось вернуть: нет связи с сервером", bad: true });
  assert.equal(shortText("коротко"), "коротко");
  assert.equal(shortText("а".repeat(80)), `${"а".repeat(60)}…`);
  assert.equal(shortText("слово и ещё слово", 9), "слово и е…");
});

test("резервная копия: имя файла и причина отказа", () => {
  assert.equal(backupName('attachment; filename="maid-2026-11-28.json"'), "maid-2026-11-28.json");
  assert.equal(backupName(null), "maid-backup.json");
  assert.equal(backupProblem(402, { error: "нужна подписка" }), "нужна подписка");
  assert.equal(backupProblem(500, {}), "сервер ответил 500");
  assert.equal(backupProblem(502, null), "сервер ответил 502");
});
