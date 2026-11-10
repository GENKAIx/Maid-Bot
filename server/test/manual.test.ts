import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../src/db.ts";
import { Pipeline } from "../src/pipeline.ts";

// Правки мышью (виджет, сайт) пишутся в журнал: «Отменить» и «Вернуть» откатывают их, как сказанное словами.

test("правка мышью: удаление задачи и перенос плана отменяются", async () => {
  const store = await Store.open(":memory:");
  const u = await store.ensureUser("100", "Тест", "Europe/Moscow");
  const pipe = new Pipeline(store, async () => "{}");
  const t = await store.addTask({ user_id: u.id, title: "Купить хлеб", priority: "normal", category: "", due_date: "2026-11-10", notes: "", message_id: null });
  const id = await pipe.manual(u, "🗑 Купить хлеб", async (log) => {
    await log("tasks", t, { status: "open", due_date: "2026-11-10" });
    await store.updateTask(t, { status: "deleted" });
  });
  assert.equal((await store.task(t))!.status, "deleted");
  await pipe.undo(u, id);
  assert.equal((await store.task(t))!.status, "open");

  const e = await store.addEvent({ user_id: u.id, title: "Врач", date_iso: "2026-11-11", time: "10:00", end_time: null, details: "", domain: "life", message_id: null });
  await pipe.manual(u, "↪ Врач", async (log) => {
    await log("events", e, { status: "active", date_iso: "2026-11-11", time: "10:00", end_time: null });
    await store.updateEvent(e, { date_iso: "2026-11-12" });
  });
  await pipe.undo(u); // последнее — перенос плана
  assert.equal((await store.event(e))!.date_iso, "2026-11-11");
  assert.equal((await store.task(t))!.status, "open");
});

test("правка привычки мышью: переименование, конец и удаление откатываются, отметки остаются", async () => {
  const store = await Store.open(":memory:");
  const u = await store.ensureUser("101", "Тест", "Europe/Moscow");
  const pipe = new Pipeline(store, async () => "{}");
  const h = await store.addHabit({ user_id: u.id, title: "Зарядка", days: "1234567", times: "[]", start_date: "2026-11-01", end_date: null, message_id: null });
  await store.markHabit(h, "2026-11-05", "done", null);
  const before = { status: "active", title: "Зарядка", end_date: null, quiet: 0 };
  await pipe.manual(u, "✎ Зарядка", async (log) => {
    await log("habits", h, before);
    await store.updateHabit(h, { title: "Утренняя зарядка", quiet: 1, end_date: "2026-11-09" });
  });
  const stop = await pipe.manual(u, "🗑 Утренняя зарядка", async (log) => {
    await log("habits", h, { ...before, title: "Утренняя зарядка", quiet: 1, end_date: "2026-11-09" });
    await store.updateHabit(h, { status: "stopped" });
  });
  assert.equal((await store.habit(h))!.status, "stopped");
  await pipe.undo(u, stop);
  assert.equal((await store.habit(h))!.status, "active");
  await pipe.undo(u);
  const back = (await store.habit(h))!;
  assert.deepEqual([back.title, back.quiet, back.end_date], ["Зарядка", 0, null]);
  assert.equal((await store.marksOf(u.id, "2026-11-01", "2026-11-30")).length, 1);
});
