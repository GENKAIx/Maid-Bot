import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApi } from "../src/api.ts";
import { hashPassword } from "../src/auth.ts";
import { Store } from "../src/db.ts";
import { Pipeline } from "../src/pipeline.ts";

// «Сегодня» на сайте: галочку привычки поставили по ошибке — снять; «Отменить» возвращает отметку.

test("снять отметку привычки: отметка уходит, отмена её возвращает, чужую не трогает", async () => {
  const store = await Store.open(":memory:");
  const u = await store.ensureUser("100", "Тест", "Europe/Moscow");
  await store.updateUser(u.id, { login: "owner", password_hash: await hashPassword("secret-pass-1") });
  const habit = (user_id: number, title: string) =>
    store.addHabit({ user_id, title, days: "1234567", times: "[]", start_date: "2026-11-01", end_date: null, message_id: null });
  const h = await habit(u.id, "Зарядка");
  const other = await habit((await store.ensureUser("200", "Чужой", "Europe/Moscow")).id, "Чужая");

  const server = createApi({ store, pipeline: new Pipeline(store, async () => "{}") }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, body: unknown, token?: string) => {
    const r = await fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json()) as { undo?: number | null; token?: string } };
  };
  const marks = async () => (await store.marksOf(u.id, "2026-11-10", "2026-11-10")).filter((x) => x.habit_id === h);
  try {
    const token = (await call("/api/login", { login: "owner", password: "secret-pass-1", label: "test" })).json.token!;

    await call(`/api/habits/${h}/mark`, { status: "done", day: "2026-11-10" }, token);
    assert.equal((await marks())[0]?.status, "done");

    const un = await call(`/api/habits/${h}/unmark`, { day: "2026-11-10" }, token);
    assert.equal(un.status, 200);
    assert.equal((await marks()).length, 0, "отметка снята");

    await call("/api/undo", { messageId: un.json.undo }, token);
    assert.equal((await marks())[0]?.status, "done", "отмена вернула отметку");

    // Снять, когда отметки нет, — ничего не делает.
    await call(`/api/habits/${h}/unmark`, { day: "2026-11-10" }, token);
    const none = await call(`/api/habits/${h}/unmark`, { day: "2026-11-10" }, token);
    assert.equal(none.json.undo, null);

    assert.equal((await call(`/api/habits/${other}/unmark`, {}, token)).status, 404);
    assert.equal((await call(`/api/habits/${h}/unmark`, { day: "10.11" }, token)).status, 400);
  } finally {
    server.close();
  }
});
