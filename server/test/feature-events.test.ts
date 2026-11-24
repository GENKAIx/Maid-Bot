import { PGlite } from "@electric-sql/pglite";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { adminFeatures } from "../src/admin-stats.ts";
import { createApi } from "../src/api.ts";
import { hashPassword, tokenHash } from "../src/auth.ts";
import { config } from "../src/config.ts";
import { Store } from "../src/db.ts";
import { PgDriver } from "../src/driver.ts";
import { acceptUsage, countFeature, featureClient, flushFeatures, resetFeatureEvents, USAGE_BATCH_MS, USAGE_DAY_MAX, USAGE_MAX_COUNT, USAGE_MAX_KEYS } from "../src/feature-events.ts";
import { CLIENT_FEATURES, featureOfApi, FEATURES } from "../src/feature-list.ts";
import { Pipeline } from "../src/pipeline.ts";
import { dayKey } from "../src/time.ts";

// Этап 3 админки (шаг 26 базы): счётчики фич — белый список, пачки от клиентов (срез, ограничитель), счёт на сервере
// (ручки API, ветки разбора), запись пачкой из памяти, отчёт «Использование функций» без текстов и chat id.

const BACKENDS: Record<string, () => Promise<Store>> = {
  sqlite: () => Store.open(":memory:"),
  postgres: async () => {
    const pg = new PGlite();
    return Store.over(new PgDriver(pg, (fn) => pg.transaction((tx) => fn(tx)), () => pg.close()));
  },
};
const TZ = config.defaultTimezone;
const NOW = new Date("2026-11-24T12:00:00Z");
const DAY = 86_400_000;
const rows = (store: Store) =>
  ((store as any).all("SELECT * FROM feature_events ORDER BY feature, client, day_key") as Promise<Record<string, unknown>[]>)
    .then((r) => r.map((x) => [Number(x.user_id), x.day_key, x.client, x.feature, Number(x.count)]));

test("белый список: имена уникальны, у серверных ручек — разбор пути, клиент не шлёт серверные имена", () => {
  assert.equal(new Set(FEATURES.map((f) => f.id)).size, FEATURES.length);
  for (const f of FEATURES) {
    assert.match(f.id, /^[a-z][a-z0-9_.]{1,40}$/, f.id);
    assert.ok(f.title, `${f.id}: нет названия`);
    if (f.api) assert.equal(f.by, "server", `${f.id}: ручку считает сервер`);
    if (f.group === "site" || f.group === "widget") assert.equal(f.by, "client", f.id);
  }
  assert.equal(featureOfApi("POST", "/api/habits/12/mark"), "habit.mark");
  assert.equal(featureOfApi("POST", "/api/habits/12"), "habit.edit");
  assert.equal(featureOfApi("GET", "/api/habits/12/stats"), "habit.stats");
  assert.equal(featureOfApi("POST", "/api/tasks"), "task.add");
  assert.equal(featureOfApi("POST", "/api/events/usage"), null, "сами счётчики — не фича");
  assert.equal(featureOfApi("GET", "/api/tasks"), null, "чтение экрана — не фича");
  assert.equal(featureOfApi("POST", "/api/habits/x/mark"), null);
  assert.ok(CLIENT_FEATURES.has("screen.today") && CLIENT_FEATURES.has("widget.fold"));
  assert.ok(!CLIENT_FEATURES.has("habit.mark") && !CLIENT_FEATURES.has("bot.today"));
  assert.deepEqual(["web", "widget", "quick", "desktop", "iphone", "", "telegram-widget"].map(featureClient),
    ["web", "desktop", "desktop", "desktop", "iphone", "other", "telegram-widget"]);
});

test("пачка от клиента: белый список, срез счёта, ограничитель раз в минуту на человека и клиента", () => {
  resetFeatureEvents();
  const u = { id: 1, tz: TZ };
  const t = NOW.getTime();
  const r = acceptUsage(u, "web", { "screen.today": 3, "screen.plans": 10_000, "habit.mark": 5, "nope.x": 1, "screen.notes": 0, "screen.money": -2, "screen.trash": 2.7 }, t);
  assert.deepEqual(r, { ok: true, accepted: 3, dropped: 4 }, "серверное имя, незнакомое, ноль и минус — мимо");
  const again = acceptUsage(u, "web", { "screen.today": 1 }, t + 10_000);
  assert.deepEqual(again, { ok: false, wait: 50 });
  assert.equal(acceptUsage(u, "widget", { "widget.fold": 1 }, t + 10_000).ok, true, "программа на ПК — свой ограничитель");
  assert.equal(acceptUsage(u, "quick", { "widget.quick": 1 }, t + 20_000).ok, false, "быстрая запись — та же программа");
  assert.equal(acceptUsage({ id: 2, tz: TZ }, "web", { "screen.today": 1 }, t + 10_000).ok, true, "другой человек — свой");
  assert.equal(acceptUsage(u, "web", { "screen.today": 1 }, t + USAGE_BATCH_MS).ok, true, "через минуту — можно");
  assert.equal(USAGE_MAX_COUNT, 500);
  resetFeatureEvents();
});

test("пачки: за день одной фичи у человека — не больше USAGE_DAY_MAX, сколько клиентов ни подставляй", async () => {
  resetFeatureEvents();
  const store = await Store.open(":memory:");
  try {
    const u = await store.ensureUser("1", "Тест", TZ);
    const t = NOW.getTime();
    for (const c of ["web", "desktop", "iphone", "", "nope"]) acceptUsage(u, c, { "screen.today": 500 }, t);
    for (const c of ["web", "desktop"]) acceptUsage(u, c, { "screen.today": 500, "screen.plans": 1 }, t + USAGE_BATCH_MS);
    acceptUsage(u, "web", { "screen.today": 500 }, t + DAY); // завтра — снова можно
    await flushFeatures(store, t, true);
    const got = await rows(store);
    const on = (f: string, day: string) => got.filter((r) => r[3] === f && r[1] === day).reduce((a, r) => a + Number(r[4]), 0);
    assert.equal(on("screen.today", dayKey(NOW, TZ)), USAGE_DAY_MAX);
    assert.equal(on("screen.plans", dayKey(NOW, TZ)), 2, "другая фича — свой потолок");
    assert.equal(on("screen.today", dayKey(new Date(t + DAY), TZ)), 500);
  } finally {
    resetFeatureEvents();
    await store.close();
  }
});

for (const [name, open] of Object.entries(BACKENDS)) {
  test(`${name}: запись пачкой раз в минуту, счёт прибавляется, день — по поясу человека, срок 400 дней`, async () => {
    resetFeatureEvents();
    const store = await open();
    try {
      const a = await store.ensureUser("1001", "Аня", TZ);
      const tokyo = { ...(await store.ensureUser("2002", "Боря", "Asia/Tokyo")), tz: "Asia/Tokyo" };
      const late = new Date("2026-11-24T20:00:00Z"); // в Токио уже 25-е
      countFeature(a, "web", "screen.today", 1, late);
      countFeature(a, "web", "screen.today", 2, late);
      countFeature(tokyo, "telegram", "bot.today", 1, late);
      countFeature(a, "web", "no.such.feature", 5, late);
      assert.equal(await flushFeatures(store, late.getTime()), 2);
      countFeature(a, "web", "screen.today", 4, late);
      assert.equal(await flushFeatures(store, late.getTime() + 30_000), 0, "раньше минуты — ждёт");
      assert.equal(await flushFeatures(store, late.getTime() + 60_000), 1);
      assert.deepEqual(await rows(store), [
        [tokyo.id, "2026-11-25", "telegram", "bot.today", 1],
        [a.id, dayKey(late, TZ), "web", "screen.today", 7],
      ]);
      // Сбой записи — счёт остаётся в памяти до следующего раза.
      countFeature(a, "web", "screen.plans", 1, late);
      const real = store.addFeatureCounts.bind(store);
      store.addFeatureCounts = async () => { throw new Error("база занята"); };
      await assert.rejects(flushFeatures(store, late.getTime(), true));
      store.addFeatureCounts = real;
      assert.equal(await flushFeatures(store, late.getTime(), true), 1);
      // Срок: старше 400 дней — удаляется.
      await store.addFeatureCounts([
        { user_id: a.id, day_key: "2025-10-19", client: "web", feature: "screen.today", count: 1 },
        { user_id: a.id, day_key: "2025-10-21", client: "web", feature: "screen.today", count: 1 },
      ]);
      await store.pruneStats(NOW);
      const days = (await rows(store)).map((r) => r[1]);
      assert.ok(!days.includes("2025-10-19") && days.includes("2025-10-21"));
    } finally {
      resetFeatureEvents();
      await store.close();
    }
  });

  test(`${name}: отчёт «Использование функций» — 30 дней, люди, 8 недель, последний раз, неиспользуемые, клиенты`, async () => {
    const store = await open();
    try {
      const a = await store.ensureUser("1001", "Аня", TZ);
      const b = await store.ensureUser("2002", "Боря", TZ);
      const day = (n: number) => dayKey(new Date(NOW.getTime() - n * DAY), TZ);
      await store.addFeatureCounts([
        { user_id: a.id, day_key: day(0), client: "web", feature: "screen.today", count: 3 },
        { user_id: b.id, day_key: day(1), client: "desktop", feature: "screen.today", count: 2 },
        { user_id: a.id, day_key: day(8), client: "web", feature: "screen.today", count: 5 }, // прошлая неделя
        { user_id: a.id, day_key: day(40), client: "web", feature: "habit.mark", count: 9 }, // за 30 дней — нет, в неделях — есть
        { user_id: a.id, day_key: day(100), client: "telegram", feature: "bot.today", count: 1 }, // только «последний раз»
        { user_id: a.id, day_key: day(0), client: "web", feature: "removed.feature", count: 1 }, // убрана из списка — не в отчёте
      ]);
      const r = await adminFeatures(store, NOW);
      assert.equal(r.today, day(0));
      assert.equal(r.since, day(100));
      const f = (id: string) => r.features.find((x) => x.id === id)!;
      const t = f("screen.today");
      assert.deepEqual([t.all.uses30, t.all.people30, t.all.last], [10, 2, day(0)]);
      assert.deepEqual(t.all.weeks, [0, 0, 0, 0, 0, 0, 5, 5]);
      assert.deepEqual([t.clients.web.uses30, t.clients.web.people30, t.clients.desktop.uses30, t.clients.desktop.last], [8, 1, 2, day(1)]);
      assert.equal(t.group, "site");
      const h = f("habit.mark");
      assert.deepEqual([h.all.uses30, h.all.people30, h.all.weeks[2], h.all.last], [0, 0, 9, day(40)]);
      assert.deepEqual([f("bot.today").all.last, f("bot.today").all.weeks.reduce((s, x) => s + x, 0)], [day(100), 0]);
      assert.ok(r.unused.includes("habit.mark") && r.unused.includes("bot.today") && !r.unused.includes("screen.today"));
      assert.equal(r.features.length, FEATURES.length);
      assert.ok(!r.features.some((x) => x.id === "removed.feature"));
      assert.deepEqual(r.clients, [{ client: "web", uses30: 8, people30: 1 }, { client: "desktop", uses30: 2, people30: 1 }],
        "клиенты — только по фичам из списка, за 30 дней");
      const j = JSON.stringify(r);
      assert.ok(!j.includes("1001") && !j.includes("2002") && !j.includes("Аня"), "chat id и имена в отчёте фич");
    } finally {
      await store.close();
    }
  });
}

test("API: POST /api/events/usage — вход нужен, клиент по заголовку, 429 чаще минуты, 400 много фич; ручки и ветки считает сервер", async () => {
  resetFeatureEvents();
  const store = await Store.open(":memory:");
  const u = await store.createUser({ login: "owner", passwordHash: await hashPassword("owner-pass-1"), tz: TZ });
  const pipeline = new Pipeline(store, async () => JSON.stringify({ reply: "Записала.", diary: [{ section: "notes", text: "Молоко" }] }));
  const server = createApi({ store, pipeline }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const token = (await (await fetch(base + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: "owner", password: "owner-pass-1" }) })).json()).token as string;
    const call = (p: string, body: unknown, client = "web", tok = token) => fetch(base + p, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tok}`, "x-maid-client": client },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal((await call("/api/events/usage", { counts: { "screen.today": 1 } }, "web", "nope")).status, 401);
    const ok = await call("/api/events/usage", { counts: { "screen.today": 2, "habit.mark": 3 } });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true, accepted: 1, dropped: 1 });
    const busy = await call("/api/events/usage", { counts: { "screen.today": 1 } });
    assert.equal(busy.status, 429);
    assert.match(((await busy.json()) as { error: string }).error, /не чаще раза в минуту/);
    assert.equal((await call("/api/events/usage", { counts: { "widget.fold": 1 } }, "widget")).status, 200, "виджет — своя пачка");
    const many = Object.fromEntries(Array.from({ length: USAGE_MAX_KEYS + 1 }, (_, i) => [`x${i}`, 1]));
    assert.equal((await call("/api/events/usage", { counts: many }, "iphone")).status, 400);
    assert.equal((await call("/api/events/usage", { counts: { "screen.today": "много" } }, "iphone")).status, 400);
    // Ручки API: удачная — в счёт, неудачная (404) — нет; ветка разбора и что записано — с клиентом из заголовка.
    assert.equal((await call("/api/search?q=молоко", undefined)).status, 200);
    assert.equal((await call("/api/habits/999/unmark", {})).status, 404);
    assert.equal((await call("/api/input", { text: "купила молоко" }, "widget")).status, 200);
    await flushFeatures(store, Date.now(), true);
    assert.deepEqual((await rows(store)).map((r) => [r[2], r[3], r[4]]), [
      ["desktop", "rec.diary", 1],
      ["desktop", "record", 1],
      ["web", "screen.today", 2],
      ["web", "search", 1],
      ["desktop", "widget.fold", 1],
    ]);
    assert.ok((await rows(store)).every((r) => r[0] === u.id));
  } finally {
    server.close();
    resetFeatureEvents();
    await store.close();
  }
});

test("бот: у каждой команды и кнопки есть фича в белом списке (кроме /chatid — она для чужих)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/bot.ts", import.meta.url), "utf8");
  const ids = new Set(FEATURES.map((f) => f.id));
  const commands = [...src.matchAll(/bot\.command\("(\w+)"/g)].map((m) => m[1]).filter((c) => c !== "chatid");
  assert.ok(commands.length > 10);
  for (const c of commands) assert.ok(ids.has(`bot.${c}`), `нет фичи bot.${c}`);
  const buttons = src.match(/BUTTON_FEATURES: Record<string, string> = \{([^}]+)\}/)![1];
  for (const [, f] of buttons.matchAll(/:\s*"([\w.]+)"/g)) assert.ok(ids.has(f), `кнопка: нет фичи ${f}`);
});

test("разбор: ветка и записанное считаются только с клиентом (повтор доставки и фоновый повтор — нет)", async () => {
  resetFeatureEvents();
  const store = await Store.open(":memory:");
  try {
    const u = await store.ensureUser("1", "Тест", TZ);
    const pipe = new Pipeline(store, async () => JSON.stringify({ reply: "Записала.", diary: [{ section: "notes", text: "Хлеб" }] }));
    await pipe.handle({ user: u, source: "telegram", sourceId: "1", text: "купила хлеб", client: "telegram" });
    await pipe.handle({ user: u, source: "telegram", sourceId: "1", text: "купила хлеб", client: "telegram" }); // повтор доставки
    await pipe.handle({ user: u, source: "desktop", sourceId: "2", text: "купила хлеб" }); // без клиента (повтор, импорт)
    await flushFeatures(store, Date.now(), true);
    assert.deepEqual((await rows(store)).map((r) => [r[2], r[3], r[4]]), [["telegram", "rec.diary", 1], ["telegram", "record", 1]]);
  } finally {
    resetFeatureEvents();
    await store.close();
  }
});

test("в счёт — только удавшееся: упавший разговор и разбор — нет, «Повторить» с клиентом — да", async () => {
  resetFeatureEvents();
  const store = await Store.open(":memory:");
  try {
    const u = await store.ensureUser("1", "Тест", TZ);
    let down = true;
    const pipe = new Pipeline(store, async () => {
      if (down) throw Object.assign(new Error("провайдер упал: тело ответа"), { status: 503 });
      return JSON.stringify({ reply: "Записала.", diary: [{ section: "notes", text: "Хлеб" }] });
    });
    await pipe.handle({ user: u, source: "telegram", sourceId: "1", text: "как дела?", chatOnly: true, client: "telegram" });
    const failed = await pipe.handle({ user: u, source: "telegram", sourceId: "2", text: "купила хлеб", client: "telegram" });
    assert.equal(failed.failed, true);
    down = false;
    const again = await pipe.retry(u, failed.messageId!, new Date(), "web");
    assert.ok(!again.failed);
    await flushFeatures(store, Date.now(), true);
    assert.deepEqual((await rows(store)).map((r) => [r[2], r[3], r[4]]), [["web", "rec.diary", 1], ["web", "record", 1]]);
  } finally {
    resetFeatureEvents();
    await store.close();
  }
});

test("API: повтор /api/voice с тем же id — один раз; пачка счётчиков не отмечает присутствие", async () => {
  resetFeatureEvents();
  const stt = http.createServer((_req, res) => {
    _req.resume();
    _req.on("end", () => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ text: "купить хлеб" })); });
  }).listen(0);
  const saved = { ...config.stt };
  Object.assign(config.stt, { baseUrl: `http://127.0.0.1:${(stt.address() as AddressInfo).port}/v1`, apiKey: "test-stt", model: "whisper-1" });
  const store = await Store.open(":memory:");
  await store.createUser({ login: "owner", passwordHash: await hashPassword("owner-pass-1"), tz: TZ });
  const pipeline = new Pipeline(store, async () => JSON.stringify({ tasks: [{ title: "Купить хлеб" }], summary: "s" }));
  const server = createApi({ store, pipeline }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const token = (await (await fetch(base + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: "owner", password: "owner-pass-1" }) })).json()).token as string;
    const call = (p: string, body: unknown, client = "web") => fetch(base + p, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-maid-client": client },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const audio = Buffer.alloc(4000, 7).toString("base64");
    assert.equal((await call("/api/voice", { audio, id: "v1" }, "widget")).status, 200);
    const dup = await call("/api/voice", { audio, id: "v1" }, "widget"); // повтор после обрыва связи
    assert.equal(((await dup.json()) as { duplicate?: boolean }).duplicate, true);
    // Сессия давно без запросов: пачка счётчиков её не трогает, обычный запрос — отмечает.
    const presence = () => (store as any).all("SELECT client, minutes FROM presence") as Promise<{ client: string; minutes: number }[]>;
    const age = () => (store as any).run("UPDATE sessions SET last_seen = ? WHERE token_hash = ?", new Date(Date.now() - 5 * 60_000).toISOString(), tokenHash(token));
    await age();
    assert.equal((await call("/api/events/usage", { counts: { "screen.today": 1 } })).status, 200);
    assert.deepEqual(await presence(), [], "пачка — не присутствие");
    assert.equal((await call("/api/search?q=хлеб", undefined)).status, 200);
    assert.deepEqual((await presence()).map((x) => [x.client, Number(x.minutes)]), [["web", 1]]);
    await flushFeatures(store, Date.now(), true);
    assert.deepEqual((await rows(store)).filter((r) => r[3] === "voice").map((r) => [r[2], r[4]]), [["desktop", 1]]);
  } finally {
    server.close();
    stt.close();
    Object.assign(config.stt, saved);
    resetFeatureEvents();
    await store.close();
  }
});
