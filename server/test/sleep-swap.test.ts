import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApi } from "../src/api.ts";
import { hashPassword } from "../src/auth.ts";
import { Store } from "../src/db.ts";
import { featureOfApi } from "../src/feature-list.ts";
import { Pipeline } from "../src/pipeline.ts";

// Перетащить сон на другой день (POST /api/sleep/swap, полоса на шкале сна в «Статистике», 27.11.2026): на пустой день сон
// переезжает, на день со сном — дни меняются местами. Записи не переписываются, только перекладываются (текст, заметка, число —
// как были); остальное за дни не трогается; «↩ Отменить» (POST /api/undo) возвращает оба дня.

test("сон: перенос, обмен, отмена обоих, проверки", async () => {
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
  const restOf = async (day: string) => (await store.diaryOf(u.id, day)).filter((r) => r.section !== "sleep").map((r) => r.text);
  const A = "2026-11-08", B = "2026-11-12", C = "2026-11-14";
  try {
    const { json: { token } } = await call("/api/login", { login: "owner", password: "secret-pass-1" });
    await store.addDiary(u.id, A, "sleep", "лёг в 1:00, встал в 9:00. снились кошмары", null);
    await store.setDayMetric({ user_id: u.id, day_key: A, key: "sleep_hours", label: "Сон", value: 8, unit: "ч", source: "manual" });
    await store.addDiary(u.id, A, "mood", "хорошее настроение", null);
    await store.addDiary(u.id, B, "sleep", "спал 6 часов", null);
    await store.setDayMetric({ user_id: u.id, day_key: B, key: "sleep_hours", label: "Сон", value: 6, unit: "ч", source: "" });
    await store.setDayMetric({ user_id: u.id, day_key: B, key: "steps", label: "Шаги", value: 9000, unit: "", source: "" });
    await store.addDiary(other.id, C, "sleep", "лёг в 23:00, встал в 7:00", null);

    // Перенос на пустой день: всё как было, только день другой.
    const mv = await call("/api/sleep/swap", { from: A, to: C }, token);
    assert.equal(mv.status, 200, JSON.stringify(mv.json));
    assert.equal(mv.json.swapped, false);
    assert.equal(typeof mv.json.undo, "number");
    assert.deepEqual((await store.recentMessages(u.id, 1)).map((m) => m.reply), ["😴 Сон 8 ноя → 14 ноя"], "в истории — короткие даты, не ISO");
    assert.deepEqual(await sleepOf(u.id, A), []);
    assert.deepEqual(await hoursOf(u.id, A), []);
    assert.deepEqual(await sleepOf(u.id, C), ["лёг в 1:00, встал в 9:00. снились кошмары"]);
    assert.deepEqual(await hoursOf(u.id, C), [8]);
    assert.deepEqual(await restOf(A), ["хорошее настроение"], "не сон остаётся на своём дне");
    assert.deepEqual(await sleepOf(other.id, C), ["лёг в 23:00, встал в 7:00"], "чужой сон не трогается");

    // Отмена переноса.
    assert.equal((await call("/api/undo", { messageId: mv.json.undo }, token)).status, 200);
    assert.deepEqual(await sleepOf(u.id, A), ["лёг в 1:00, встал в 9:00. снились кошмары"]);
    assert.deepEqual(await hoursOf(u.id, A), [8]);
    assert.deepEqual(await sleepOf(u.id, C), []);
    assert.deepEqual(await hoursOf(u.id, C), []);

    // Обмен двух дней со сном; шаги дня B остаются на месте.
    const sw = await call("/api/sleep/swap", { from: A, to: B }, token);
    assert.equal(sw.status, 200, JSON.stringify(sw.json));
    assert.equal(sw.json.swapped, true);
    assert.deepEqual(await sleepOf(u.id, A), ["спал 6 часов"]);
    assert.deepEqual(await hoursOf(u.id, A), [6]);
    assert.deepEqual(await sleepOf(u.id, B), ["лёг в 1:00, встал в 9:00. снились кошмары"]);
    assert.deepEqual(await hoursOf(u.id, B), [8]);
    assert.deepEqual((await store.metricsRange(u.id, B, B, "steps")).map((m) => m.value), [9000]);

    // Отмена обмена — оба дня как были.
    assert.equal((await call("/api/undo", { messageId: sw.json.undo }, token)).status, 200);
    assert.deepEqual(await sleepOf(u.id, A), ["лёг в 1:00, встал в 9:00. снились кошмары"]);
    assert.deepEqual(await hoursOf(u.id, A), [8]);
    assert.deepEqual(await sleepOf(u.id, B), ["спал 6 часов"]);
    assert.deepEqual(await hoursOf(u.id, B), [6]);

    // Проверки: тот же день, без сна, будущий, не дата, без входа.
    assert.equal((await call("/api/sleep/swap", { from: A, to: A }, token)).status, 400);
    assert.equal((await call("/api/sleep/swap", { from: C, to: A }, token)).status, 400, "на C сна нет");
    assert.equal((await call("/api/sleep/swap", { from: A, to: "2099-01-01" }, token)).status, 400);
    assert.equal((await call("/api/sleep/swap", { from: "8 ноя", to: B }, token)).status, 400);
    assert.equal((await call("/api/sleep/swap", { from: A, to: B })).status, 401);
    assert.deepEqual(await sleepOf(u.id, A), ["лёг в 1:00, встал в 9:00. снились кошмары"], "отказ ничего не меняет");

    assert.equal(featureOfApi("POST", "/api/sleep/swap"), "sleep.swap");
    assert.equal(featureOfApi("POST", "/api/sleep"), "sleep");
  } finally {
    server.close();
    await store.close();
  }
});
