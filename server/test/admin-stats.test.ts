import { PGlite } from "@electric-sql/pglite";
import assert from "node:assert/strict";
import { test } from "node:test";
import { adminAlerts, adminAudience, adminOverview, adminQualityReport, adminSpend, adminUsers, ADMIN_ALERT_FAILED } from "../src/admin-stats.ts";
import { config } from "../src/config.ts";
import { Store } from "../src/db.ts";
import { PgDriver } from "../src/driver.ts";
import { dayKey } from "../src/time.ts";

// Админка, этап 1 (24.11.2026): отчёты на готовых данных — на SQLite и на Postgres. Обращения с ИИ — Telegram/сайт/айфон
// без поправок; без ИИ — кнопки, push, правки мышью; импорт прошлого не в счёт. В ответах — без текстов и chat id.

const BACKENDS: Record<string, () => Promise<Store>> = {
  sqlite: () => Store.open(":memory:"),
  postgres: async () => {
    const pg = new PGlite();
    return Store.over(new PgDriver(pg, (fn) => pg.transaction((tx) => fn(tx)), () => pg.close()));
  },
};

const NOW = new Date("2026-11-24T12:00:00Z");
const TZ = config.defaultTimezone;
const SECRET = "секретный текст сообщения";

async function seed(store: Store) {
  const a = await store.ensureUser("1001", "Аня", TZ);
  const b = await store.ensureUser("2002", "Боря", TZ);
  let n = 0;
  const msg = async (userId: number, source: string, at: Date, opts: { state?: "failed" | "clarify"; sourceId?: string } = {}) => {
    const { message } = await store.saveMessage({ userId, source, sourceId: opts.sourceId ?? `s${++n}`, text: SECRET, dayKey: dayKey(at, TZ), at });
    if (opts.state) await store.setMessage(message.id, { state: opts.state });
    return message;
  };
  const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
  // Аня: 3 обращения с ИИ сегодня, одно — с отменой; 1 отметка кнопкой; 1 поправка к ответу; 1 импорт давно.
  const m1 = await msg(a.id, "telegram", hoursAgo(1));
  await msg(a.id, "desktop", hoursAgo(2), { state: "clarify" });
  await msg(a.id, "telegram", hoursAgo(3), { state: "failed" });
  await msg(a.id, "button", hoursAgo(4));
  // Отметка привычки кнопкой в Telegram (bot.ts, «mark:…») и на сайте (web) — без ИИ, даже если сообщение в ошибке.
  await msg(a.id, "telegram", hoursAgo(5), { sourceId: "mark:7:2026-11-24" });
  await msg(a.id, "web", hoursAgo(6), { state: "failed" });
  await msg(a.id, "desktop", hoursAgo(1), { sourceId: "correct:1:x" });
  await msg(a.id, "import", new Date("2026-01-05T10:00:00Z"));
  await store.logAction(a.id, m1.id, "add", "tasks", 1);
  await store.markUndone((await store.actionsOf(m1.id))[0].id);
  // Боря: был активен 20 дней назад и пропал.
  await msg(b.id, "telegram", new Date(NOW.getTime() - 20 * 86_400_000));
  // Расход: Аня — разбор $0.30 и сводка $0.10 сегодня; Боря — $0.05 20 дней назад; ничей — $0.01.
  await store.addUsage(NOW, { kind: "parse", model: "m", input: 1, output: 1, cost: 0.3, userId: a.id });
  await store.addUsage(NOW, { kind: "summary", model: "m", input: 1, output: 1, cost: 0.1, userId: a.id });
  await store.addUsage(new Date(NOW.getTime() - 20 * 86_400_000), { kind: "parse", model: "m", input: 1, output: 1, cost: 0.05, userId: b.id });
  await store.addUsage(NOW, { kind: "other", model: "m", input: 1, output: 1, cost: 0.01 });
  return { a, b };
}

const clean = (x: unknown) => {
  const j = JSON.stringify(x);
  assert.ok(!j.includes(SECRET), "текст сообщения в ответе админки");
  assert.ok(!j.includes("1001") && !j.includes("2002"), "chat id в ответе админки");
};

for (const [name, open] of Object.entries(BACKENDS)) {
  test(`админка, этап 1 (${name}): пользователи, расход, аудитория, качество, обзор`, async () => {
    const store = await open();
    try {
      await seed(store);
      const users = await adminUsers(store, NOW);
      clean(users);
      const anya = users.find((u) => u.name === "Аня")!;
      assert.equal(anya.ai30, 3, "с ИИ: telegram + desktop, без поправки и импорта");
      assert.equal(anya.manual30, 3, "без ИИ: кнопка, отметка в Telegram, сайт");
      assert.equal(anya.n30, 7, "за 30 дней — всё, кроме импорта");
      assert.equal(anya.undone30, 1, "отменённое сообщение");
      assert.ok(Math.abs(anya.cost30 - 0.4) < 1e-9 && Math.abs(anya.background30 - 0.1) < 1e-9);
      assert.equal(users[0].name, "Аня", "сначала — кто больше тратит");

      const spend = await adminSpend(store, 30, NOW);
      clean(spend);
      assert.deepEqual(spend.byUser.map((r) => r.name), ["Аня", "Боря", "без человека"]);
      assert.deepEqual(spend.byUser.map((r) => r.user_id), [anya.id, users.find((u) => u.name === "Боря")!.id, 0], "ключ строки — id, не имя");
      assert.ok(Math.abs(spend.total.cost - 0.46) < 1e-9);
      assert.ok(spend.forecast >= spend.month.cost);

      const aud = await adminAudience(store, NOW);
      clean(aud);
      assert.equal(aud.series.at(-1)!.dau, 1);
      assert.equal(aud.series.at(-1)!.mau, 2);
      assert.deepEqual(aud.gone.map((g) => g.name), ["Боря"]);
      assert.ok(aud.gone[0].user_id > 0);
      assert.ok(!aud.sources.some((s) => s.source === "import"));

      const q = await adminQualityReport(store, 7, NOW);
      assert.equal(q.series.length, 7);
      assert.deepEqual({ ...q.total }, { requests: 3, failed: 1, clarify: 1, corrections: 1, undone: 1 }, "ошибка у сообщения без ИИ — не в счёт качества");

      const ov = await adminOverview(store, NOW);
      clean(ov);
      assert.equal(ov.users, 2);
      assert.equal(ov.active_day, 1);
      assert.equal(ov.active_month, 2);
      assert.ok(Math.abs(ov.spend_today - 0.41) < 1e-9);
      assert.equal(ov.failed_week, 1);
    } finally {
      await store.close();
    }
  });
}

test("тревоги владельцу: перерасход и неразобранные — по одному разу", async () => {
  const store = await Store.open(":memory:");
  try {
    const u = await store.ensureUser("1001", "Аня", TZ);
    for (let i = 1; i <= 14; i++) await store.addUsage(new Date(NOW.getTime() - i * 86_400_000), { kind: "parse", model: "m", input: 1, output: 1, cost: 0.1, userId: u.id });
    assert.deepEqual(await adminAlerts(store, NOW), [], "обычный день — тихо");
    await store.addUsage(NOW, { kind: "parse", model: "m", input: 1, output: 1, cost: 0.9, userId: u.id });
    for (let i = 0; i < ADMIN_ALERT_FAILED; i++) {
      const { message } = await store.saveMessage({ userId: u.id, source: "telegram", sourceId: `f${i}`, text: "x", dayKey: dayKey(NOW, TZ), at: new Date(NOW.getTime() - 10 * 60_000) });
      await store.setMessage(message.id, { state: "failed" });
    }
    const first = await adminAlerts(store, NOW);
    assert.equal(first.length, 2);
    assert.match(first[0], /Расход модели сегодня: \$0\.90/);
    assert.match(first[1], /не разобрано сообщений: 3/);
    assert.deepEqual(await adminAlerts(store, NOW), [], "второй раз в тот же день и час — молчит");
  } finally {
    await store.close();
  }
});

test("прогноз расхода: среднее за 7 полных дней, сегодняшний неполный день не занижает", async () => {
  const store = await Store.open(":memory:");
  try {
    const u = await store.ensureUser("1001", "Аня", TZ);
    for (let i = 1; i <= 7; i++) await store.addUsage(new Date(NOW.getTime() - i * 86_400_000), { kind: "parse", model: "m", input: 1, output: 1, cost: 0.1, userId: u.id });
    const morning = new Date("2026-11-24T01:00:00Z");
    await store.addUsage(morning, { kind: "parse", model: "m", input: 1, output: 1, cost: 0.01, userId: u.id });
    // До вчера — $0.70, впереди 7 дней (24–30 ноября) по $0.10.
    const ov = await adminOverview(store, morning);
    assert.ok(Math.abs(ov.spend_forecast - 1.4) < 1e-9, String(ov.spend_forecast));
    const spend = await adminSpend(store, 7, morning);
    assert.ok(Math.abs(spend.forecast - 1.4) < 1e-9, String(spend.forecast));
  } finally {
    await store.close();
  }
});
