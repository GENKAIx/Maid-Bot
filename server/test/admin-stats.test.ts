import { PGlite } from "@electric-sql/pglite";
import assert from "node:assert/strict";
import { test } from "node:test";
import { adminAlerts, adminAudience, adminHealth, adminOverview, adminQualityReport, adminSpend, adminUsers, ADMIN_ALERT_FAILED, cmpVersion, quantile } from "../src/admin-stats.ts";
import { authByToken, notePresence, resetSeen, tokenHash } from "../src/auth.ts";
import { config } from "../src/config.ts";
import { Store } from "../src/db.ts";
import { CHAT_FAILED } from "../src/pipeline.ts";
import { PgDriver } from "../src/driver.ts";
import { dayKey, timeOf } from "../src/time.ts";

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

// Этап 2 (24.11.2026): данные шага 24 — входы с клиентом и версией, минуты присутствия, вызовы модели на сообщение, журнал попыток.
// Время — настоящее: DESKTOP_TOKEN помнит последний заход по часам процесса.
for (const [name, open] of Object.entries(BACKENDS)) {
  test(`админка, этап 2 (${name}): онлайн, устройства, карта часов, версии, с ИИ / без, дорогие сообщения, здоровье`, async () => {
    resetSeen(); // память ограничителей — с прошлой базы
    const store = await open();
    const saved = { chats: [...config.allowedChatIds], desk: config.desktopToken };
    try {
      const T = new Date();
      const ago = (ms: number) => new Date(T.getTime() - ms).toISOString();
      const a = await store.ensureUser("1001", "Аня", TZ);
      const b = await store.ensureUser("2002", "Боря", TZ);
      const age = (token: string, ms: number) => store.raw("UPDATE sessions SET last_seen = ? WHERE token_hash = ?", ago(ms), tokenHash(token));
      // Входы: Аня — сайт и новая программа на ПК (сейчас); Боря — старая программа без заголовка (10 дней) и айфон (40 дней).
      await store.addSession(tokenHash("w1"), a.id, "web", { client: "web", version: "" });
      await store.addSession(tokenHash("pc1"), a.id, "Программа на ПК", { client: "desktop", version: "0.1.90" });
      await store.addSession(tokenHash("pc-old"), b.id, "Программа на ПК");
      await age("pc-old", 10 * 86_400_000);
      await store.addSession(tokenHash("ip"), b.id, "iphone");
      await age("ip", 40 * 86_400_000);
      // Просроченный вход (100 дней — дольше SESSION_IDLE_DAYS) — ни в устройствах, ни в версиях.
      await store.addSession(tokenHash("dead"), b.id, "web", { client: "web", version: "" });
      await age("dead", 100 * 86_400_000);
      // Ключ ПК из настроек (DESKTOP_TOKEN) — у владельца (Аня), версия в памяти.
      config.allowedChatIds.splice(0, Infinity, "1001");
      config.desktopToken = "desk-admin-test";
      assert.equal((await authByToken(store, "desk-admin-test", { client: "", version: "0.1.88" }))?.via, "desktop");
      // Telegram — Боря в этот час.
      await notePresence(store, b, "telegram", T);
      // Карта часов: в другой час сегодня Аня 2 минуты с сайта, Боря 1 минуту из Telegram — в одной клетке 3.
      const day = dayKey(T, TZ);
      const hx = (Number(timeOf(T, TZ).slice(0, 2)) + 12) % 24;
      await store.bumpPresence(a.id, day, hx, "web");
      await store.bumpPresence(a.id, day, hx, "web");
      await store.bumpPresence(b.id, day, hx, "telegram");

      // Сообщения Ани: разбор с переспросом (2 вызова), погода (0), старое без ветки из Telegram (по источнику — с ИИ),
      // кнопка (без ИИ), поправка (1 вызов — ни там ни там).
      const msg = async (source: string, sourceId: string, calls: number, route: string) => {
        const { message } = await store.saveMessage({ userId: a.id, source, sourceId, text: SECRET, dayKey: day, at: new Date(T.getTime() - 3_600_000) });
        if (route) await store.addMessageCalls(message.id, calls, route);
        return message;
      };
      await msg("telegram", "t1", 2, "apply");
      const wx = await msg("telegram", "t2", 0, "weather");
      const old = await msg("telegram", "t3", 0, "");
      await msg("button", "b1", 0, "");
      await msg("desktop", "correct:1:x", 1, "correct");
      await store.setMessage(old.id, { state: "failed" });
      // Упавший разговор фоновый повтор пропускает — в «ещё в повторах» не идёт.
      const { message: chat } = await store.saveMessage({ userId: b.id, source: "telegram", sourceId: "t4", text: SECRET, dayKey: day, at: new Date(T.getTime() - 3_600_000) });
      await store.setMessage(chat.id, { state: "failed", reply: `${CHAT_FAILED}Error: упало` });
      await store.setMessage(wx.id, { state: "clarify" });

      // Журнал попыток: 10 удачных разборов по 100…1000 мс за сутки и один на 5 с три дня назад; тайм-аут; сбой голоса 3 дня назад.
      for (let i = 1; i <= 10; i++) await store.addLlmCall(new Date(T.getTime() - 3_600_000), { kind: "parse", model: "m1", ms: i * 100, cost: 0.001, userId: a.id });
      await store.addLlmCall(new Date(T.getTime() - 3 * 86_400_000), { kind: "parse", model: "m1", ms: 5000, cost: 0.001, userId: a.id });
      await store.addLlmCall(new Date(T.getTime() - 2 * 3_600_000), { kind: "parse", model: "m1", ms: 60_000, cost: null, error: "timeout", userId: a.id });
      await store.addLlmCall(new Date(T.getTime() - 3 * 86_400_000), { kind: "voice", model: "v", ms: 10, cost: null, error: "http_5xx" });
      // Напоминания: одно ждёт 10 минут (просрочено), другое — 30 секунд (ещё нет).
      await store.addReminder(a.id, "task", 1, new Date(T.getTime() - 10 * 60_000), SECRET);
      await store.addReminder(a.id, "task", 2, new Date(T.getTime() - 30_000), SECRET);

      const ov = await adminOverview(store, T);
      clean(ov);
      assert.equal(ov.online.total, 2, "Аня (сайт, ПК) и Боря (Telegram); старые входы — нет");
      assert.deepEqual(Object.fromEntries(ov.online.clients.map((c) => [c.client, c.users])), { web: 1, desktop: 1, telegram: 1 });

      const users = await adminUsers(store, T);
      clean(users);
      const anya = users.find((u) => u.name === "Аня")!;
      const borya = users.find((u) => u.name === "Боря")!;
      assert.equal(anya.ai30, 2, "с ИИ: разбор (llm_calls > 0) и старое из Telegram (по источнику)");
      assert.equal(anya.manual30, 2, "без ИИ: погода (0 вызовов) и кнопка");
      assert.equal(anya.n30, 5);
      assert.deepEqual(anya.devices.map((d) => [d.client, d.version]).sort(), [["desktop", "0.1.90"], ["desktop-key", "0.1.88"], ["web", ""]], "ключ ПК — отдельной строкой");
      assert.deepEqual(borya.devices.map((d) => [d.client, d.version]), [["desktop", ""], ["iphone", ""]], "сначала последний вход");
      assert.ok(!JSON.stringify(users).includes("Программа на ПК"), "метка входа наружу не идёт");

      const aud = await adminAudience(store, T);
      clean(aud);
      assert.equal(aud.heat.length, 7);
      assert.ok(aud.heat.every((r) => r.length === 24));
      assert.equal(aud.heat[(new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7][hx], 3, "клетка — сумма минут всех людей");
      assert.deepEqual(aud.versions.map((v) => [v.version, v.devices, v.users]), [["0.1.90", 1, 1], ["0.1.88", 1, 1], ["", 1, 1]], "айфон и вход старше 30 дней — не в счёт");
      const tg = aud.clients.find((c) => c.client === "telegram")!;
      assert.deepEqual([tg.users, tg.minutes], [1, 2]);
      assert.deepEqual(aud.clients.find((c) => c.client === "web"), { client: "web", users: 1, minutes: 2 });

      const spend = await adminSpend(store, 30, T);
      clean(spend);
      assert.deepEqual(spend.heavy.map((m) => [m.name, m.route, m.calls]), [["Аня", "apply", 2], ["Аня", "correct", 1]]);
      assert.deepEqual(spend.routes.map((r) => [r.route, r.messages, r.calls]).sort(), [["apply", 1, 2], ["correct", 1, 1], ["weather", 1, 0]]);

      const h = await adminHealth(store, T);
      clean(h);
      assert.deepEqual(h.errors.map((e) => [e.kind, e.code, e.day, e.week]).sort(), [["parse", "timeout", 1, 1], ["voice", "http_5xx", 0, 1]]);
      const parse = h.kinds.find((k) => k.kind === "parse")!;
      assert.deepEqual([parse.day, parse.week, parse.errors_day, parse.errors_week], [11, 12, 1, 1]);
      assert.deepEqual(h.models.map((m) => [m.model, m.day.n, m.day.p50, m.day.p95, m.week.n, m.week.p50, m.week.p95]), [["m1", 10, 500, 1000, 11, 600, 5000]]);
      assert.deepEqual(h.messages, { failed: 2, clarify: 1, failed24: 1 });
      assert.equal(h.reminders.n, 1);
      assert.ok(h.reminders.oldest && h.reminders.oldest < ago(9 * 60_000));
      assert.ok(h.uptime_sec >= 0 && typeof h.version === "string" && typeof h.built_at === "string");
    } finally {
      config.allowedChatIds.splice(0, Infinity, ...saved.chats);
      config.desktopToken = saved.desk;
      await store.close();
    }
  });
}

test("админка, этап 2: перцентили и порядок версий", () => {
  assert.equal(quantile([], 0.5), null);
  assert.equal(quantile([7], 0.95), 7);
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2);
  assert.equal(quantile([1, 2, 3, 4], 0.95), 4);
  assert.deepEqual(["0.1.9", "", "0.1.10", "1.0.0"].sort(cmpVersion), ["1.0.0", "0.1.10", "0.1.9", ""]);
});
