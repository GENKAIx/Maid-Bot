import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApi } from "../src/api.ts";
import { hashPassword } from "../src/auth.ts";
import { Store } from "../src/db.ts";
import type { ChatMessage, LlmCall } from "../src/llm.ts";
import { notesData, sameNote, shelfKey } from "../src/notes.ts";
import { buildPrompt, normalize } from "../src/parse.ts";
import { Pipeline } from "../src/pipeline.ts";
import { zonedToUtc } from "../src/time.ts";

// Заметки «на потом» (notes.ts): что посмотреть, во что поиграть, что почитать, идеи — на полках.
// 18.11.2026: фильмы и игры записывались задачами или в дневник и потом не находились. Всё без сети: модель — подставная.

const TZ = "Europe/Moscow";
const AT = zonedToUtc("2026-11-18", "14:30", TZ);
const CTX = { today: "2026-11-18", now: "14:30", text: "x" };

async function setup(answers: unknown[]) {
  const store = await Store.open(":memory:");
  const u = await store.ensureUser("400", "Тест", TZ);
  const calls: ChatMessage[][] = [];
  const llm: LlmCall = async (messages) => {
    calls.push(messages);
    const a = answers.shift();
    return typeof a === "string" ? a : JSON.stringify(a ?? {});
  };
  return { store, u, calls, pipe: new Pipeline(store, llm) };
}
const msg = (text: string, id: string) => ({ source: "telegram", sourceId: id, text, at: AT });

test("разбор: полки, повторы, незнакомая полка, правки заметок", () => {
  assert.equal(shelfKey("Фильм"), "film");
  assert.equal(shelfKey("anime"), "series");
  assert.equal(shelfKey("ерунда"), null);
  assert.ok(sameNote("Дюна 2", "дюна-2!") && !sameNote("Дюна", "Дюна 2"));

  const r = normalize({
    stash: [
      { shelf: "film", title: " Дюна 2 " }, { shelf: "film", title: "дюна 2" }, { shelf: "игры", title: "Hades", note: "советовал Петя" },
      { shelf: "podcast", title: "Что-то непонятное" }, { shelf: "book", title: "   " },
    ],
    shelves: ["film"], // без вопроса — не считается
    edits: [
      { action: "done", kind: "note", id: 5, rating: 8 }, { action: "done", kind: "note", id: 6, rating: 40 },
      { action: "move", kind: "note", id: 7, new_shelf: "сериал" }, { action: "move", kind: "note", id: 8 },
      { action: "rename", kind: "note", id: 9, new_title: "Дюна: часть вторая" }, { action: "cancel", kind: "note", id: 10 },
    ],
  }, CTX);
  assert.deepEqual(r.stash, [
    { shelf: "film", title: "Дюна 2", note: "" }, { shelf: "game", title: "Hades", note: "советовал Петя" }, { shelf: "other", title: "Что-то непонятное", note: "" },
  ]);
  assert.deepEqual(r.shelves, []);
  assert.deepEqual(r.edits.map((e) => [e.action, e.id, e.rating ?? null, e.newShelf ?? "", e.newTitle ?? ""]), [
    ["done", 5, 8, "", ""], ["done", 6, null, "", ""], ["move", 7, null, "series", ""], ["rename", 9, null, "", "Дюна: часть вторая"], ["cancel", 10, null, "", ""],
  ]);
  assert.match(r.dropped.join(";"), /заметка #8/);
  // Заметка — тоже содержание сообщения: хроника дня пишется.
  assert.match(normalize({ stash: [{ shelf: "film", title: "Дюна" }] }, { ...CTX, text: "фильм Дюна" }).summary, /фильм Дюна/);

  assert.deepEqual(normalize({ question: "что посмотреть?", shelves: ["film", "сериалы", "film", "мусор"] }, CTX).shelves, ["film", "series"]);
});

test("запрос к модели: правило заметок и список того, что уже на полках", () => {
  const p = buildPrompt({
    today: "2026-11-18", now: "14:30", tz: TZ, events: [], tasks: [], dates: [], memory: [], habits: [], recent: [],
    notes: [{ id: 12, user_id: 1, shelf: "film", title: "Дюна 2", note: "", status: "open", rating: null, message_id: null, created_at: "", closed_at: null }],
  }, "голос");
  assert.match(p, /"stash": \[\{"shelf": "film\|series\|game\|book\|idea\|other"/);
  assert.match(p, /Заметки на потом \(полка в скобках\):\n#12 \[film\] Дюна 2/);
  // Граница с планами и задачами названа прямо: с днём или временем — не заметка, дело — задача.
  assert.match(p, /Назван день или время[^\n]*НЕ stash/);
  assert.match(p, /«купить лампочку», «позвонить маме»\), — tasks/);
});

test("сообщение кладёт заметки на полки, второй раз то же не кладёт, «Отменить» убирает", async () => {
  const { store, u, pipe, calls } = await setup([
    { stash: [{ shelf: "film", title: "Дюна 2" }, { shelf: "game", title: "Hades", note: "советовал Петя" }], summary: "[14:30] записал фильм и игру" },
    { stash: [{ shelf: "film", title: "дюна 2" }, { shelf: "series", title: "Разделение" }] },
    { tasks: [{ title: "Купить лампочку" }] },
  ]);
  const r = await pipe.handle({ user: u, ...msg("фильм Дюна 2, поиграть в Hades — Петя советовал", "1") });
  assert.match(r.text, /📌 на полку «Фильмы»: Дюна 2/);
  assert.match(r.text, /📌 на полку «Игры»: Hades/);
  assert.deepEqual(r.changes?.map((c) => [c.kind, c.title, c.detail]), [["note", "Дюна 2", "Заметки · Фильмы"], ["note", "Hades", "Заметки · Игры · советовал Петя"]]);
  assert.ok(r.undoable);
  assert.deepEqual((await store.notesOf(u.id)).map((n) => [n.shelf, n.title, n.status]), [["game", "Hades", "open"], ["film", "Дюна 2", "open"]]);
  assert.equal((await store.openTasks(u.id)).length, 0);

  // То, что уже лежит, модель видит в запросе; повтор кодом тоже не проходит.
  const again = await pipe.handle({ user: u, ...msg("дюну 2 и сериал Разделение", "2") });
  assert.match(String(calls[1][0].content), /\[film\] Дюна 2/);
  assert.match(again.text, /уже на полке «Фильмы»: дюна 2/);
  assert.match(again.text, /на полку «Сериалы»: Разделение/);
  assert.equal((await store.notesOf(u.id)).length, 3);

  await pipe.undo(u, again.messageId);
  assert.deepEqual((await store.notesOf(u.id)).map((n) => n.title), ["Hades", "Дюна 2"]);
  assert.deepEqual((await store.trashNotes(u.id, "2000-01-01")).map((n) => n.title), ["Разделение"]);

  // Обычное дело остаётся задачей.
  await pipe.handle({ user: u, ...msg("надо купить лампочку", "3") });
  assert.deepEqual((await store.openTasks(u.id)).map((t) => t.title), ["Купить лампочку"]);
  assert.equal((await store.notesOf(u.id)).length, 2);
});

test("«посмотрел, 8 из 10» отмечает заметку готовой; переложить, убрать, отменить", async () => {
  const { store, u, pipe } = await setup([]);
  const dune = await store.addNote({ user_id: u.id, shelf: "film", title: "Дюна 2", note: "", message_id: null });
  const hades = await store.addNote({ user_id: u.id, shelf: "film", title: "Hades", note: "", message_id: null });
  const alien = await store.addNote({ user_id: (await store.ensureUser("401", "Чужой", TZ)).id, shelf: "film", title: "Чужая", note: "", message_id: null });
  const answers = [
    { edits: [{ action: "done", kind: "note", id: dune, rating: 8 }, { action: "move", kind: "note", id: hades, new_shelf: "game" }, { action: "cancel", kind: "note", id: alien }] },
    { edits: [{ action: "cancel", kind: "note", id: hades }] },
  ];
  const pipe2 = new Pipeline(store, async () => JSON.stringify(answers.shift() ?? {}));
  const r = await pipe2.handle({ user: u, ...msg("посмотрел Дюну, 8 из 10. Hades — это игра", "1") });
  assert.match(r.text, /✔ готово, «Фильмы»: Дюна 2 · 8\/10/);
  assert.match(r.text, /➜ на полку «Игры»: Hades/);
  const d = (await store.note(dune))!;
  assert.deepEqual([d.status, d.rating, Boolean(d.closed_at)], ["done", 8, true]);
  assert.equal((await store.note(hades))!.shelf, "game");
  assert.equal((await store.note(alien))!.status, "open"); // чужую по номеру не тронуть

  const gone = await pipe2.handle({ user: u, ...msg("убери Hades из заметок", "2") });
  assert.match(gone.text, /убрано из заметок: Hades/);
  assert.equal((await store.note(hades))!.status, "deleted");
  await pipe2.undo(u, gone.messageId);
  assert.equal((await store.note(hades))!.status, "open");
  await pipe2.undo(u, r.messageId);
  const back = (await store.note(dune))!;
  assert.deepEqual([back.status, back.rating, back.closed_at], ["open", null, null]);
  assert.equal((await store.note(hades))!.shelf, "film");
  assert.ok(pipe);
});

test("«что посмотреть?» — модели уходят заметки с нужных полок, а не дневник", async () => {
  const { store, u, pipe, calls } = await setup([{ question: "что посмотреть?", shelves: ["film", "series"] }, "Могу предложить «Дюну 2»."]);
  await store.addNote({ user_id: u.id, shelf: "film", title: "Дюна 2", note: "советовал Петя", message_id: null });
  const seen = await store.addNote({ user_id: u.id, shelf: "film", title: "Начало", note: "", message_id: null });
  await store.updateNote(seen, { status: "done", rating: 9 });
  await store.addNote({ user_id: u.id, shelf: "game", title: "Hades", note: "", message_id: null });
  await store.addDiary(u.id, "2026-11-17", "food", "секретная каша", null);
  const r = await pipe.handle({ user: u, ...msg("что посмотреть?", "1") });
  assert.equal(r.text, "Могу предложить «Дюну 2».");
  const sys = String(calls[1][0].content);
  assert.match(sys, /Полка «Фильмы», ждёт: 1\n- Дюна 2 \(советовал Петя\) — записано сегодня/);
  assert.match(sys, /уже готово: 1\n- Начало — оценка 9\/10/);
  assert.match(sys, /Полка «Сериалы»: пусто\./);
  assert.match(sys, /предложи одно на выбор/);
  assert.ok(!sys.includes("Hades") && !sys.includes("каша"));
  assert.equal((await store.notesOf(u.id)).length, 3); // вопрос ничего не записывает
});

test("notesData: поиск по словам и давность словами (дата стала бы ссылкой на дневник)", () => {
  const row = (id: number, shelf: string, title: string, days: number, status = "open") => ({
    id, user_id: 1, shelf, title, note: "", status, rating: null, message_id: null,
    created_at: new Date(AT.getTime() - days * 86_400_000).toISOString(), closed_at: null,
  });
  const rows = [row(3, "film", "Интерстеллар", 22), row(2, "game", "Космические рейнджеры", 100), row(1, "book", "Мастер и Маргарита", 0)];
  const found = notesData(rows, [], ["космич", "интерст"], AT);
  assert.match(found, /Полка «Фильмы», ждёт: 1\n- Интерстеллар — записано 3 нед\. назад/);
  assert.match(found, /Космические рейнджеры — записано 3 мес\. назад/);
  assert.ok(!found.includes("Мастер") && !/\d{4}-\d{2}-\d{2}/.test(found));
  assert.equal(notesData(rows, [], ["ничего"], AT), "");
});

test("API заметок: список, добавить, повтор, готово с оценкой, корзина, поиск, чужие", async () => {
  const store = await Store.open(":memory:");
  const u = await store.ensureUser("410", "Тест", TZ);
  const other = await store.ensureUser("411", "Чужой", TZ);
  await store.updateUser(u.id, { login: "owner", password_hash: await hashPassword("secret-pass-1") });
  const alien = await store.addNote({ user_id: other.id, shelf: "film", title: "Чужая Дюна", note: "", message_id: null });
  const pipeline = new Pipeline(store, async () => "{}");
  const server = createApi({ store, pipeline }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const login = await (await fetch(base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ login: "owner", password: "secret-pass-1" }) })).json() as { token: string };
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.token}` }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };
    const made = (await call("POST", "/api/notes", { title: "  Дюна 2 ", shelf: "film" })).body;
    assert.deepEqual([made.title, made.shelf, made.status], ["Дюна 2", "film", "open"]);
    assert.equal((await call("POST", "/api/notes", { title: "дюна 2", shelf: "film" })).body.duplicate, true);
    const idea = (await call("POST", "/api/notes", { title: "Значки бафов" })).body;
    assert.equal(idea.shelf, "other");
    assert.equal((await call("POST", "/api/notes", { title: "x", shelf: "podcast" })).status, 400);

    const list = (await call("GET", "/api/notes")).body;
    assert.deepEqual(list.shelves.map((s: any) => [s.key, s.rated]), [["film", true], ["series", true], ["game", true], ["book", true], ["idea", false], ["other", false]]);
    assert.deepEqual(list.notes.map((n: any) => n.title), ["Значки бафов", "Дюна 2"]);

    const done = (await call("POST", `/api/notes/${made.id}`, { status: "done", rating: 8 })).body;
    assert.deepEqual([done.status, done.rating], ["done", 8]);
    assert.equal((await call("POST", `/api/notes/${made.id}`, { rating: 11 })).status, 400);
    // «Вернуть» после «готово» — журнал отмены откатывает правку мышью.
    await pipeline.undo(u, done.undo);
    assert.deepEqual([(await store.note(made.id))!.status, (await store.note(made.id))!.rating], ["open", null]);
    await call("POST", `/api/notes/${made.id}`, { status: "done", rating: 8 });
    const reopened = (await call("POST", `/api/notes/${made.id}`, { status: "open" })).body;
    assert.deepEqual([reopened.status, reopened.rating], ["open", null]); // вернули на полку — оценка снята

    assert.equal((await call("POST", `/api/notes/${idea.id}`, { shelf: "idea", note: "для виджета" })).body.shelf, "idea");
    // Виджету ПК — сколько ждёт на полках (подсказки над строкой чата: «Что посмотреть?» — только когда есть что).
    assert.deepEqual((await call("GET", "/api/today")).body.notes, { film: 1, series: 0, game: 0, book: 0, idea: 1, other: 0 });
    assert.equal((await call("POST", `/api/notes/${alien}`, { status: "deleted" })).status, 404);
    assert.equal((await call("POST", `/api/notes/${idea.id}`, {})).status, 400);

    // Удалённая — в корзине и в поиске с пометкой; вернуть можно; «удалить навсегда» — нет нигде.
    await call("POST", `/api/notes/${idea.id}`, { status: "deleted" });
    assert.deepEqual((await call("GET", "/api/notes")).body.notes.map((n: any) => n.title), ["Дюна 2"]);
    assert.deepEqual((await call("GET", "/api/trash")).body.notes.map((n: any) => n.title), ["Значки бафов"]);
    const found = (await call("GET", `/api/search?q=${encodeURIComponent("ДЮН")}`)).body;
    assert.deepEqual(found.notes.map((n: any) => [n.title, n.bin]), [["Дюна 2", ""]]); // чужая не находится
    assert.deepEqual((await call("GET", `/api/search?q=${encodeURIComponent("виджета")}`)).body.notes.map((n: any) => [n.title, n.bin]), [["Значки бафов", "trash"]]);
    assert.deepEqual((await call("POST", "/api/trash/purge", { notes: [idea.id, made.id, alien] })).body, { tasks: 0, events: 0, notes: 1 });
    assert.equal((await call("GET", "/api/trash")).body.notes.length, 0);
    assert.equal((await call("GET", `/api/search?q=${encodeURIComponent("виджета")}`)).body.notes.length, 0);
    assert.equal((await call("POST", `/api/notes/${idea.id}`, { status: "open" })).status, 404);
    assert.equal((await store.note(alien))!.status, "open");
  } finally {
    server.close();
    await store.close();
  }
});
