import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../src/db.ts";

// Корзина (GET /api/trash): удалённые и отменённые задачи и планы за последние дни; вернули — из корзины ушло.

test("корзина: удалённое и отменённое видно, возвращённое и старое — нет", async () => {
  const store = await Store.open(":memory:");
  const u = await store.ensureUser("200", "Тест", "Europe/Moscow");
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const keep = await store.addTask({ user_id: u.id, title: "Открытая", priority: "normal", category: "", due_date: null, notes: "", message_id: null });
  const gone = await store.addTask({ user_id: u.id, title: "Удалённая", priority: "normal", category: "", due_date: null, notes: "", message_id: null });
  const done = await store.addTask({ user_id: u.id, title: "Сделанная", priority: "normal", category: "", due_date: null, notes: "", message_id: null });
  await store.updateTask(gone, { status: "deleted" });
  await store.updateTask(done, { status: "done" });
  const old = await store.addTask({ user_id: u.id, title: "Давняя", priority: "normal", category: "", due_date: null, notes: "", message_id: null });
  await store.updateTask(old, { status: "deleted" }, new Date(Date.now() - 20 * 86_400_000));
  assert.deepEqual((await store.trashTasks(u.id, since)).map((t) => t.title), ["Удалённая"]);

  const e = await store.addEvent({ user_id: u.id, title: "Врач", date_iso: "2026-11-11", time: null, end_time: null, details: "", domain: "life", message_id: null });
  await store.updateEvent(e, { status: "cancelled" });
  assert.deepEqual((await store.trashEvents(u.id, since)).map((x) => x.title), ["Врач"]);

  await store.updateTask(gone, { status: "open" });
  await store.updateEvent(e, { status: "active" });
  assert.equal((await store.trashTasks(u.id, since)).length, 0);
  assert.equal((await store.trashEvents(u.id, since)).length, 0);
  assert.ok(keep);
});

test("корзина: «удалить навсегда» убирает из корзины выбранное, «очистить» — всё", async () => {
  const store = await Store.open(":memory:");
  const u = await store.ensureUser("201", "Тест", "Europe/Moscow");
  const other = await store.ensureUser("202", "Чужой", "Europe/Moscow");
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const add = async (user: number, title: string) => {
    const id = await store.addTask({ user_id: user, title, priority: "normal", category: "", due_date: null, notes: "", message_id: null });
    await store.updateTask(id, { status: "deleted" });
    return id;
  };
  const a = await add(u.id, "А");
  await add(u.id, "Б");
  const open = await store.addTask({ user_id: u.id, title: "Открытая", priority: "normal", category: "", due_date: null, notes: "", message_id: null });
  const alien = await add(other.id, "Чужая");
  const e = await store.addEvent({ user_id: u.id, title: "Врач", date_iso: "2026-11-11", time: null, end_time: null, details: "", domain: "life", message_id: null });
  await store.updateEvent(e, { status: "cancelled" });

  // Открытую и чужую по номеру не тронуть.
  assert.deepEqual(await store.purgeTrash(u.id, since, { tasks: [a, open, alien] }), { tasks: 1, events: 0 });
  assert.deepEqual((await store.trashTasks(u.id, since)).map((t) => t.title), ["Б"]);
  assert.equal((await store.task(open))?.status, "open");
  assert.equal((await store.task(alien))?.status, "deleted");

  assert.deepEqual(await store.purgeTrash(u.id, since), { tasks: 1, events: 1 });
  assert.equal((await store.trashTasks(u.id, since)).length, 0);
  assert.equal((await store.trashEvents(u.id, since)).length, 0);
  assert.equal((await store.trashTasks(other.id, since)).length, 1);
});
