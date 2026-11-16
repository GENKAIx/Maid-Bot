import { PGlite } from "@electric-sql/pglite";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApi } from "../src/api.ts";
import { hashPassword } from "../src/auth.ts";
import { Store } from "../src/db.ts";
import { PgDriver } from "../src/driver.ts";
import { historyOf, kindOf, NOTICE_KINDS, reminderKind } from "../src/notices.ts";
import { Pipeline } from "../src/pipeline.ts";
import { habitButtons, rateButtons, Scheduler } from "../src/scheduler.ts";
import { zonedToUtc } from "../src/time.ts";

// «История» на сайте: письма горничной с видом (утро, план, привычка…), отбор по виду, старые письма без вида.

const TZ = "Europe/Moscow";
const DAY = "2026-11-17";

const BACKENDS: Record<string, () => Promise<Store>> = {
  sqlite: () => Store.open(":memory:"),
  postgres: async () => {
    const pg = new PGlite();
    return Store.over(new PgDriver(pg, (fn) => pg.transaction((tx) => fn(tx)), () => pg.close()));
  },
};

for (const [name, open] of Object.entries(BACKENDS)) {
  test(`${name}: история — вид письма хранится, отбор по виду, «старше», лишнее удаляется`, async () => {
    const store = await open();
    const u = await store.createUser({ login: "owner", passwordHash: await hashPassword("secret-pass-1"), tz: TZ });
    const other = await store.createUser({ login: "guest", passwordHash: await hashPassword("secret-pass-2"), tz: TZ });
    await store.addNotice(u.id, "☀️ Доброе утро", "happy", "", "morning");
    await store.addNotice(u.id, "⏰ Через 1 ч: Врач", "neutral", "", "plan");
    await store.addNotice(u.id, "Зарядка — сделали?", "neutral", JSON.stringify(habitButtons(1, DAY)), "habit");
    await store.addNotice(u.id, "Итог дня", "proud", JSON.stringify(rateButtons(DAY)), "evening");
    await store.addNotice(other.id, "чужое", "neutral", "", "plan");

    const all = await historyOf(store, u.id);
    assert.deepEqual(all.items.map((x) => x.kind), ["evening", "habit", "plan", "morning"]); // свежие сверху, чужого нет
    assert.equal(all.more, false);
    assert.deepEqual(Object.keys(all.items[0]).sort(), ["at", "emotion", "id", "kind", "text"]); // кнопки наружу не идут
    assert.deepEqual((await historyOf(store, u.id, { kinds: ["morning", "evening"] })).items.map((x) => x.kind), ["evening", "morning"]);
    const page = await historyOf(store, u.id, { limit: 2 });
    assert.equal(page.items.length, 2);
    assert.equal(page.more, true);
    assert.deepEqual((await historyOf(store, u.id, { before: page.items[1].id })).items.map((x) => x.kind), ["plan", "morning"]);

    await store.pruneNotices(u.id, 2);
    assert.deepEqual((await historyOf(store, u.id)).items.map((x) => x.kind), ["evening", "habit"]);
    assert.equal((await historyOf(store, other.id)).items.length, 1);
  });
}

test("история: письма без вида (до 17.11.2026) — вид по кнопкам и началу текста", () => {
  const row = (text: string, buttons = "") => ({ id: 1, user_id: 1, text, emotion: "neutral", buttons, at: "", kind: "" });
  assert.equal(kindOf(row("☀️ Доброе утро")), "morning");
  assert.equal(kindOf(row("🌙 Завтра, вторник")), "tomorrow");
  assert.equal(kindOf(row("🎂 Завтра день рождения мамы")), "date");
  assert.equal(kindOf(row("🎮 Уже 2 ч в играх")), "game");
  assert.equal(kindOf(row("⏰ Пора: Созвон")), "plan");
  assert.equal(kindOf(row("📅 Сегодня: Врач")), "plan");
  assert.equal(kindOf(row("Зарядка?", JSON.stringify(habitButtons(3, DAY)))), "habit");
  assert.equal(kindOf(row("Сегодня сделано…", JSON.stringify(rateButtons(DAY)))), "evening");
  assert.equal(kindOf(row("Так и не смогла разобрать")), "other");
  assert.equal(kindOf({ ...row("☀️ что угодно"), kind: "note" }), "note"); // записанный вид сильнее догадки
  assert.equal(reminderKind(habitButtons(3, DAY)), "habit");
  assert.equal(reminderKind(undefined), "plan");
});

test("история: планировщик ставит вид — утро и итог дня", async () => {
  const store = await Store.open(":memory:");
  const u = await store.createUser({ login: "owner", passwordHash: await hashPassword("secret-pass-1"), tz: TZ });
  const kinds: (string | undefined)[] = [];
  const sch = new Scheduler(store, null, async (_u, _t, _e, _b, kind) => void kinds.push(kind));
  await sch.tick(zonedToUtc(DAY, "09:01", TZ));
  await sch.tick(zonedToUtc(DAY, "22:01", TZ));
  assert.ok(kinds.includes("morning"), `нет утра: ${kinds}`);
  assert.ok(kinds.includes("evening"), `нет итога: ${kinds}`);
  assert.ok(kinds.every((k) => k && (NOTICE_KINDS as readonly string[]).includes(k)), `письмо без вида: ${kinds}`);
});

test("история: ручка /api/history", async () => {
  const store = await Store.open(":memory:");
  const u = await store.createUser({ login: "owner", passwordHash: await hashPassword("secret-pass-1"), tz: TZ });
  await store.addNotice(u.id, "☀️ Доброе утро", "happy", "", "morning");
  await store.addNotice(u.id, "⏰ Пора: Созвон", "neutral", "", "plan");
  const server = createApi({ store, pipeline: new Pipeline(store, async () => "{}") }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, token?: string) => {
    const r = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };
  try {
    const { json: { token } } = await call("POST", "/api/login", { login: "owner", password: "secret-pass-1" });
    const all = await call("GET", "/api/history", undefined, token);
    assert.deepEqual(all.json.items.map((x: any) => x.kind), ["plan", "morning"]);
    assert.deepEqual((await call("GET", "/api/history?kinds=morning,нет", undefined, token)).json.items.map((x: any) => x.kind), ["morning"]);
    assert.equal((await call("GET", "/api/history?limit=1", undefined, token)).json.more, true);
    assert.equal((await call("GET", "/api/history")).status, 401);
  } finally {
    server.close();
  }
});
