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
