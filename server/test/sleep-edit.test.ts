import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApi } from "../src/api.ts";
import { hashPassword } from "../src/auth.ts";
import { Store } from "../src/db.ts";
import { Pipeline } from "../src/pipeline.ts";

// Ручная правка сна (POST /api/sleep; щелчок по дню на шкале сна в «Статистике», 18.11.2026). Сон — записи дневника
// в разделе «сон» и число sleep_hours; правка заменяет их за день одной записью «лёг в …, встал в …» (старые — в удалённые,
// не пропадают совсем), удаление убирает сон за день.

test("сон: добавить, исправить, удалить; чужой день не трогается", async () => {
  const store = await Store.open(":memory:");
  const u = await store.createUser({ login: "owner", passwordHash: await hashPassword("secret-pass-1"), tz: "Europe/Moscow" });
  const other = await store.createUser({ login: "other", passwordHash: await hashPassword("secret-pass-2"), tz: "Europe/Moscow" });
  const server = createApi({ store, pipeline: new Pipeline(store, async () => "{}") }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, body?: unknown, token?: string) => {
    const r = await fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };
  const sleepOf = async (uid: number, day: string) => (await store.diaryOf(uid, day)).filter((r) => r.section === "sleep").map((r) => r.text);
  const hoursOf = async (uid: number, day: string) => (await store.metricsRange(uid, day, day, "sleep_hours")).map((m) => m.value);
  try {
    const { json: { token } } = await call("/api/login", { login: "owner", password: "secret-pass-1" });
    const day = "2026-11-15";
    // Было: запись от горничной и часы сна из другой записи.
    await store.addDiary(u.id, day, "sleep", "лёг в 1:00, встал в 9:00", null);
    await store.setDayMetric({ user_id: u.id, day_key: day, key: "sleep_hours", label: "Сон", value: 8, unit: "ч", source: "" });
    await store.addDiary(other.id, day, "sleep", "лёг в 23:00, встал в 7:00", null);

    // Исправить: одна запись вместо старой, часы пересчитаны (через полночь).
    const r = await call("/api/sleep", { day, bed: "1:30", wake: "10:00", note: "просыпался ночью" }, token);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.hours, 8.5);
    assert.deepEqual(await sleepOf(u.id, day), ["лёг в 1:30, встал в 10:00. просыпался ночью"]);
    assert.deepEqual(await hoursOf(u.id, day), [8.5]);
    // Повторная правка — снова одна запись, а не две.
    await call("/api/sleep", { day, bed: "23:00", wake: "07:15" }, token);
    assert.deepEqual(await sleepOf(u.id, day), ["лёг в 23:00, встал в 7:15"]);
    assert.deepEqual(await hoursOf(u.id, day), [8.25]);

    // Добавить на пустой день.
    await call("/api/sleep", { day: "2026-11-10", bed: "02:00", wake: "11:00" }, token);
    assert.deepEqual(await sleepOf(u.id, "2026-11-10"), ["лёг в 2:00, встал в 11:00"]);

    // Удалить сон за день.
    assert.equal((await call("/api/sleep", { day, clear: true }, token)).status, 200);
    assert.deepEqual(await sleepOf(u.id, day), []);
    assert.deepEqual(await hoursOf(u.id, day), []);

    // Чужой сон на месте; неверное время и будущий день — 400; без входа — 401.
    assert.deepEqual(await sleepOf(other.id, day), ["лёг в 23:00, встал в 7:00"]);
    assert.equal((await call("/api/sleep", { day, bed: "25:00", wake: "07:00" }, token)).status, 400);
    assert.equal((await call("/api/sleep", { day, bed: "23:00" }, token)).status, 400);
    assert.equal((await call("/api/sleep", { day: "2099-01-01", bed: "23:00", wake: "07:00" }, token)).status, 400);
    assert.equal((await call("/api/sleep", { day, bed: "23:00", wake: "07:00" })).status, 401);
  } finally {
    server.close();
    await store.close();
  }
});
