import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApi } from "../src/api.ts";
import { hashPassword } from "../src/auth.ts";
import { Store } from "../src/db.ts";
import { timesOf } from "../src/habits.ts";
import { Pipeline } from "../src/pipeline.ts";
import { habitAskTimes } from "../src/scheduler.ts";

// Страница «Привычки»: время напоминаний меняется прямо в строке привычки; пусто — общее время из настроек; «Отменить» возвращает старое.

test("время напоминаний привычки: сохраняется по порядку, пусто — общее, отмена возвращает, неверное — 400", async () => {
  const store = await Store.open(":memory:");
  const u = await store.ensureUser("100", "Тест", "Europe/Moscow");
  await store.updateUser(u.id, { login: "owner", password_hash: await hashPassword("secret-pass-1") });
  const h = await store.addHabit({ user_id: u.id, title: "Пить Аевит", days: "1234567", times: "[\"09:00\"]", start_date: "2026-11-01", end_date: null, message_id: null });
  const other = await store.addHabit({ user_id: (await store.ensureUser("200", "Чужой", "Europe/Moscow")).id, title: "Чужая", days: "1234567", times: "[]", start_date: "2026-11-01", end_date: null, message_id: null });

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
  const times = async () => timesOf((await store.habit(h))!);
  try {
    const token = (await call("/api/login", { login: "owner", password: "secret-pass-1", label: "test" })).json.token!;

    const set = await call(`/api/habits/${h}`, { times: ["21:30", "08:15", "21:30"] }, token);
    assert.equal(set.status, 200);
    assert.deepEqual(await times(), ["08:15", "21:30"], "по порядку, без повторов");
    assert.deepEqual(habitAskTimes({ habit_first: "12:00", habit_last: "23:00" }, await times()), ["08:15", "21:30", "23:00"]);

    await call("/api/undo", { messageId: set.json.undo }, token);
    assert.deepEqual(await times(), ["09:00"], "отмена вернула старое время");

    await call(`/api/habits/${h}`, { times: [] }, token);
    assert.deepEqual(await times(), []);
    assert.deepEqual(habitAskTimes({ habit_first: "12:00", habit_last: "23:00" }, []), ["12:00", "23:00"], "пусто — общее время");

    assert.equal((await call(`/api/habits/${h}`, { times: ["25:00"] }, token)).status, 400);
    assert.equal((await call(`/api/habits/${h}`, { times: ["9:00"] }, token)).status, 400);
    assert.equal((await call(`/api/habits/${h}`, { times: ["01:00", "02:00", "03:00", "04:00", "05:00"] }, token)).status, 400);
    assert.equal((await call(`/api/habits/${other}`, { times: ["10:00"] }, token)).status, 404);
  } finally {
    server.close();
  }
});
