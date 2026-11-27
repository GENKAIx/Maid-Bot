import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { noteAge, randomNote, shelfCounts, shownNotes } from "../src/notes.ts";
import type { NoteRow } from "../src/types.ts";

// Экран «Заметки» (web/src/notes.ts, screens/Notes.tsx): полки, поиск, давность и «Случайное».
// 18.11.2026: фильмы и игры «на потом» негде было найти — раздел заведён с полками.

const row = (id: number, shelf: string, title: string, status = "open", note = ""): NoteRow =>
  ({ id, shelf, title, note, status, rating: null, created_at: "2026-11-18T10:00:00.000Z", closed_at: null });
const NOTES = [row(5, "film", "Дюна 2", "open", "советовал Петя"), row(4, "game", "Hades"), row(3, "film", "Начало", "done"), row(2, "film", "Ёлки"), row(1, "idea", "Значки бафов")];

test("полка и поиск: все слова, регистр, «ё», пометка", () => {
  assert.deepEqual(shownNotes(NOTES, "film", "").map((n) => n.id), [5, 3, 2]);
  assert.deepEqual(shownNotes(NOTES, "all", "").length, 5);
  assert.deepEqual(shownNotes(NOTES, "all", "ЕЛК").map((n) => n.title), ["Ёлки"]);
  assert.deepEqual(shownNotes(NOTES, "all", "петя дюна").map((n) => n.title), ["Дюна 2"]);
  assert.deepEqual(shownNotes(NOTES, "game", "дюна"), []);
});

test("счётчики полок считают только ждущие", () => {
  assert.deepEqual(shelfCounts(NOTES), { all: 4, film: 2, game: 1, idea: 1 });
});

test("давность записи", () => {
  const now = new Date(2026, 10, 18, 12, 0);
  const ago = (days: number) => new Date(2026, 10, 18 - days, 23, 30).toISOString();
  assert.deepEqual([0, 1, 5, 21, 100, 800].map((d) => noteAge(ago(d), now)), ["сегодня", "вчера", "5 дн.", "3 нед.", "3 мес.", "2 г."]);
});

test("«Случайное»: только из ждущих и не то же самое второй раз подряд", () => {
  const film = shownNotes(NOTES, "film", "");
  assert.equal(randomNote(film, null, () => 0)?.title, "Дюна 2");
  assert.equal(randomNote(film, 5, () => 0)?.title, "Ёлки"); // прошлый раз выпала Дюна
  assert.equal(randomNote(film, 5, () => 0.999)?.title, "Ёлки");
  assert.equal(randomNote([row(9, "book", "Одна")], 9)?.id, 9); // выбирать не из чего — та же
  assert.equal(randomNote([row(3, "film", "Начало", "done")], null), null);
});

test("экран в меню и в адресах; готовое у полок с оценкой спрашивает оценку", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(readFileSync(new URL("../src/nav.ts", import.meta.url), "utf8"), /\{ id: "notes", path: "\/notes", title: "Заметки", icon: "notes" \}/);
  assert.match(app, /tab === "notes" \? <Notes version=\{version\} onChanged=\{onChanged\} \/>/);
  assert.match(readFileSync(new URL("../src/icons.tsx", import.meta.url), "utf8"), /\n  notes: "M/);
  const screen = readFileSync(new URL("../src/screens/Notes.tsx", import.meta.url), "utf8");
  assert.match(screen, /\?\.rated \? setRating\(/);
  assert.match(screen, /\{ status: "done", rating: r \}/);
  // Корзина и поиск знают про заметки.
  assert.match(readFileSync(new URL("../src/screens/Trash.tsx", import.meta.url), "utf8"), /post\(`\/api\/notes\/\$\{id\}`, \{ status: "open" \}\)/);
  assert.match(readFileSync(new URL("../src/screens/Search.tsx", import.meta.url), "utf8"), /found\.notes\.map/);
});
