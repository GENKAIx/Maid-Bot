import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApi } from "../src/api.ts";
import { hashPassword } from "../src/auth.ts";
import { Store } from "../src/db.ts";
import { Pipeline } from "../src/pipeline.ts";

// Удаление записи дневника и сна за день с отменой (28.11.2026): DELETE /api/diary/:id и POST /api/sleep {clear} отдают undo —
// номер служебного сообщения; POST /api/undo с ним возвращает убранное (плашка «Отменить» на сайте, 8 секунд).

test("дневник и сон: удаление отдаёт undo, отмена возвращает запись", async () => {
  const store = await Store.open(":memory:");
  const u = await store.createUser({ login: "owner", passwordHash: await hashPassword("secret-pass-1"), tz: "Europe/Moscow" });
  const other = await store.createUser({ login: "other", passwordHash: await hashPassword("secret-pass-2"), tz: "Europe/Moscow" });
  const server = createApi({ store, pipeline: new Pipeline(store, async () => "{}") }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, body?: unknown, token?: string, method?: string) => {
    const r = await fetch(base + path, {
      method: method ?? (body ? "POST" : "GET"),
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };
  const textsOf = async (uid: number, day: string) => (await store.diaryOf(uid, day)).map((r) => r.text);
  const hoursOf = async (uid: number, day: string) => (await store.metricsRange(uid, day, day, "sleep_hours")).map((m) => m.value);
  const day = "2026-11-20";
  try {
    const { json: { token } } = await call("/api/login", { login: "owner", password: "secret-pass-1" });
    const long = "Очень длинная запись про день: ".repeat(4).trim();
    const id = await store.addDiary(u.id, day, "mood", "хорошее настроение", null);
    const longId = await store.addDiary(u.id, day, "work", long, null);
    const alien = await store.addDiary(other.id, day, "mood", "чужая запись", null);

    // Удалить: запись пропала, в ответе номер для отмены, в истории — короткая строка.
    const del = await call(`/api/diary/${id}`, undefined, token, "DELETE");
    assert.equal(del.status, 200, JSON.stringify(del.json));
    assert.equal(del.json.ok, true);
    assert.equal(typeof del.json.undo, "number");
    assert.deepEqual(await textsOf(u.id, day), [long]);
    assert.deepEqual((await store.recentMessages(u.id, 1)).map((m) => m.reply), ["🗑 хорошее настроение"]);

    // Отменить: запись снова на месте, тем же номером строки.
    assert.equal((await call("/api/undo", { messageId: del.json.undo }, token)).status, 200);
    assert.deepEqual((await store.diaryOf(u.id, day)).map((r) => r.id).sort((a, b) => a - b), [id, longId].sort((a, b) => a - b));

    // Длинный текст в истории обрезан.
    const del2 = await call(`/api/diary/${longId}`, undefined, token, "DELETE");
    const reply = (await store.recentMessages(u.id, 1))[0].reply ?? "";
    assert.ok(reply.endsWith("…") && reply.length <= 64, reply);
    assert.equal((await call("/api/undo", { messageId: del2.json.undo }, token)).status, 200);
    assert.equal((await textsOf(u.id, day)).length, 2);

    // Чужую запись удалить нельзя, она на месте; без входа — 401.
    assert.equal((await call(`/api/diary/${alien}`, undefined, token, "DELETE")).status, 404);
    assert.deepEqual(await textsOf(other.id, day), ["чужая запись"]);
    assert.equal((await call(`/api/diary/${id}`, undefined, undefined, "DELETE")).status, 401);

    // Сон: «Удалить сон» убирает запись и часы и отдаёт undo; отмена возвращает оба.
    const sday = "2026-11-21";
    await call("/api/sleep", { day: sday, bed: "23:00", wake: "07:00" }, token);
    assert.deepEqual(await hoursOf(u.id, sday), [8]);
    const clear = await call("/api/sleep", { day: sday, clear: true }, token);
    assert.equal(clear.status, 200, JSON.stringify(clear.json));
    assert.equal(typeof clear.json.undo, "number");
    assert.deepEqual(await textsOf(u.id, sday), []);
    assert.deepEqual(await hoursOf(u.id, sday), []);
    assert.deepEqual((await store.recentMessages(u.id, 1)).map((m) => m.reply), ["🗑 Сон 21 ноя"]);
    assert.equal((await call("/api/undo", { messageId: clear.json.undo }, token)).status, 200);
    assert.deepEqual(await textsOf(u.id, sday), ["лёг в 23:00, встал в 7:00"]);
    assert.deepEqual(await hoursOf(u.id, sday), [8]);

    // Сна за день нет — убирать нечего: undo пустой, служебного сообщения нет.
    const before = (await store.recentMessages(u.id, 50)).length;
    const none = await call("/api/sleep", { day: "2026-11-22", clear: true }, token);
    assert.equal(none.status, 200);
    assert.equal(none.json.undo, null);
    assert.equal((await store.recentMessages(u.id, 50)).length, before);
  } finally {
    server.close();
    await store.close();
  }
});
