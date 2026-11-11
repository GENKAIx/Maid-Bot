import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApi } from "../src/api.ts";
import { hashPassword } from "../src/auth.ts";
import { Store } from "../src/db.ts";
import { Pipeline } from "../src/pipeline.ts";

// Поиск (GET /api/search): задачи и планы по словам без учёта регистра и «ё», с корзиной; удалённое навсегда и чужое — нет.

test("поиск: слова, регистр, ё, корзина, purged, чужие", async () => {
  const store = await Store.open(":memory:");
  const u = await store.ensureUser("300", "Тест", "Europe/Moscow");
  const other = await store.ensureUser("301", "Чужой", "Europe/Moscow");
  await store.updateUser(u.id, { login: "owner", password_hash: await hashPassword("secret-pass-1") });
  const task = (user: number, title: string, notes = "") =>
    store.addTask({ user_id: user, title, priority: "normal", category: "", due_date: null, notes, message_id: null });
  await task(u.id, "Купить ёлку", "к Новому году");
  const binned = await task(u.id, "Ёлочные игрушки");
  await store.updateTask(binned, { status: "deleted" });
  const purged = await task(u.id, "Ёлка на работу");
  await store.updateTask(purged, { status: "deleted" });
  await store.purgeTrash(u.id, new Date(Date.now() - 14 * 86_400_000).toISOString(), { tasks: [purged] });
  await task(other.id, "Чужая елка");
  await task(u.id, "Позвонить маме");
  await store.addEvent({ user_id: u.id, title: "Ярмарка", date_iso: "2026-12-20", time: "12:00", end_time: null, details: "купить елку", domain: "life", message_id: null });

  const server = createApi({ store, pipeline: new Pipeline(store, async () => "{}") }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const login = await (await fetch(base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ login: "owner", password: "secret-pass-1" }) })).json() as { token: string };
    const find = async (q: string) => (await (await fetch(`${base}/api/search?q=${encodeURIComponent(q)}`, { headers: { Authorization: `Bearer ${login.token}` } })).json()) as {
      tasks: { title: string; bin: string }[]; events: { title: string }[];
    };
    const r = await find("ЁЛ");
    assert.deepEqual(r.tasks.map((t) => [t.title, t.bin]), [["Купить ёлку", ""], ["Ёлочные игрушки", "trash"]]);
    assert.deepEqual(r.events.map((e) => e.title), ["Ярмарка"]);
    assert.deepEqual((await find("купить новому")).tasks.map((t) => t.title), ["Купить ёлку"]); // все слова, и в заметках
    assert.equal((await find("   ")).tasks.length, 0);
  } finally {
    server.close();
    await store.close();
  }
});
