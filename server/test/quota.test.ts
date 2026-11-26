import { PGlite } from "@electric-sql/pglite";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { AiGate, DRAWS_CAP_TEXT, limitsOf, OFF_TEXT, VOICE_CAP_TEXT, quotaDay, quotaResetAt, tariffKindOf, todayView } from "../src/access.ts";
import { createApi } from "../src/api.ts";
import { hashPassword } from "../src/auth.ts";
import { config } from "../src/config.ts";
import { Store } from "../src/db.ts";
import { PgDriver } from "../src/driver.ts";
import { flushFeatures, resetFeatureEvents } from "../src/feature-events.ts";
import type { LlmCall } from "../src/llm.ts";
import { Pipeline } from "../src/pipeline.ts";
import {
  applyTariffs, checkTariffPatch, checkTariffValue, LIMIT_TEXT, loadTariffs, overrideTariffs, PAID_LIMIT_TEXT, TARIFF_SPEC, tariffs, type TariffValues,
  unitPrices, undoTariff,
} from "../src/tariffs.ts";
import { voiceSeconds } from "../src/voice.ts";
import * as web from "../../web/src/tariffs.ts";

// Лимиты в штуках (этап 2 тарифов, 24.11.2026, access.ts AiGate + таблица ai_quota, шаг 32): запросы к ИИ, картинки и секунды
// голоса на человека в день по его поясу; атомарно; подарок — свои лимиты; друзья и владелец — без лимитов; 0 — нельзя;
// текст при упоре — из тарифов; /api/me — остаток на сегодня.

const BACKENDS: Record<string, () => Promise<Store>> = {
  sqlite: () => Store.open(":memory:"),
  postgres: async () => {
    const pg = new PGlite();
    return Store.over(new PgDriver(pg, (fn) => pg.transaction((tx) => fn(tx)), () => pg.close()));
  },
};
const OWNER = "900";
const DAY = 86_400_000;
const VLAD = "Asia/Vladivostok"; // UTC+10 без перехода на летнее время
const iso = (t: number) => new Date(t).toISOString();

/** Свежая база и тарифы по умолчанию поверх своих чисел. */
async function fresh(p: Partial<TariffValues> = {}, open = BACKENDS.sqlite) {
  const store = await open();
  await loadTariffs(store);
  overrideTariffs(p);
  return store;
}
const trial = (store: Store, login: string, tz = VLAD, extra: { trialLenDays?: number; chatId?: string } = {}) =>
  store.createUser({ login, passwordHash: "x", tz, plan: "trial", accessUntil: iso(Date.now() + 5 * DAY), trialLenDays: extra.trialLenDays ?? 7, chatId: extra.chatId });

for (const [kind, open] of Object.entries(BACKENDS)) {
  test(`${kind}: шаг 32 — таблица ai_quota; прибавка не выше лимита, возврат, остаток, очистка старше 40 дней`, async () => {
    const store = await open();
    try {
      await store.driver.exec("DROP TABLE ai_quota; ALTER TABLE users DROP COLUMN frozen_at; ALTER TABLE admin_log DROP COLUMN reason;");
      // Шаг 39 (habits.finished_at) — миграция добавит снова.
      await store.driver.exec("ALTER TABLE habits DROP COLUMN finished_at;");
      await store.kvSet("schema_version", "31");
      const again = await Store.over(store.driver);
      assert.equal(await again.kvGet("schema_version"), "39");
      assert.equal(await again.takeQuota(1, "2026-11-24", "calls", 1, 2), true);
      assert.equal(await again.takeQuota(1, "2026-11-24", "calls", 1, 2), true);
      assert.equal(await again.takeQuota(1, "2026-11-24", "calls", 1, 2), false, "третий сверх лимита 2");
      assert.equal(await again.takeQuota(1, "2026-11-24", "voice_sec", 61, 60), false, "больше лимита сразу — без строки");
      assert.equal(await again.takeQuota(1, "2026-11-24", "voice_sec", 40, 60), true);
      assert.equal(await again.takeQuota(1, "2026-11-24", "voice_sec", 30, 60), false, "40 + 30 > 60 — не взято вовсе");
      assert.equal(await again.takeQuota(2, "2026-11-24", "draws", 1, 0), false, "лимит 0 — нельзя");
      assert.deepEqual(await again.quotaOf(1, "2026-11-24"), { calls: 2, draws: 0, voice_sec: 40 });
      await again.giveQuota(1, "2026-11-24", "calls", 1);
      await again.giveQuota(1, "2026-11-24", "voice_sec", 100);
      assert.deepEqual(await again.quotaOf(1, "2026-11-24"), { calls: 1, draws: 0, voice_sec: 0 }, "возврат не ниже нуля");
      assert.deepEqual(await again.quotaOf(1, "2026-11-25"), { calls: 0, draws: 0, voice_sec: 0 }, "другой день — с нуля");
      // Одновременно 40 прибавок при лимите 7 — ровно 7 (ни одной лишней).
      const r = await Promise.all(Array.from({ length: 40 }, () => again.takeQuota(3, "2026-11-24", "calls", 1, 7)));
      assert.equal(r.filter(Boolean).length, 7);
      assert.equal((await again.quotaOf(3, "2026-11-24")).calls, 7);
      await again.takeQuota(3, "2026-10-01", "calls", 1, 7);
      assert.equal((await again.quotaRows("2026-01-01")).length, 4);
      await again.pruneStats(new Date("2026-11-24T12:00:00Z"));
      assert.deepEqual((await again.quotaRows("2026-01-01")).map((q) => q.day).sort(), ["2026-11-24", "2026-11-24", "2026-11-24"], "старше 40 дней — удалено");
    } finally {
      await store.close();
    }
  });

  test(`${kind}: одновременные запросы человека не превышают лимит запросов ни на один`, async () => {
    const store = await fresh({ trialCalls: 5, aiBurst: 1000 }, open);
    try {
      const u = await trial(store, "par");
      const gate = new AiGate(store, { owners: () => [] });
      const v = await Promise.all(Array.from({ length: 30 }, () => gate.check(u, { take: { calls: 1 } })));
      assert.equal(v.filter((x) => x.ok).length, 5);
      assert.ok(v.filter((x) => !x.ok).every((x) => !x.ok && x.reason === "calls_cap" && x.why === "money"));
      assert.equal((await store.quotaOf(u.id, quotaDay(u, new Date()))).calls, 5);
    } finally {
      await store.close();
    }
  });
}

test("счёт запросов и сброс в полночь по поясу человека: во Владивостоке новый день — в 14:00 UTC", async () => {
  const store = await fresh({ trialCalls: 2, aiBurst: 1000 });
  let now = new Date("2026-11-24T13:30:00Z"); // 23:30 во Владивостоке
  const gate = new AiGate(store, { owners: () => [], clock: () => now });
  const u = await trial(store, "vlad");
  assert.equal((await gate.check(u, { take: { calls: 1 } })).ok, true);
  assert.equal((await gate.check(u, { take: { calls: 1 } })).ok, true);
  const no = await gate.check(u, { take: { calls: 1 } });
  assert.deepEqual(no.ok ? null : [no.why, no.reason, no.text], ["money", "calls_cap", LIMIT_TEXT], "третий — упор: текст из тарифов, как денежный потолок (429)");
  assert.equal(quotaResetAt(u, now), "2026-11-24T14:00:00.000Z", "сброс — полночь по Владивостоку");
  assert.equal((await gate.check(u)).ok, true, "без take (фон) — не считается и не упирается");
  now = new Date("2026-11-24T14:00:30Z"); // 00:00 25.11 во Владивостоке; в UTC ещё 24.11
  assert.equal(quotaDay(u, now), "2026-11-25");
  assert.equal((await gate.check(u, { take: { calls: 1 } })).ok, true, "после его полуночи — снова можно");
  // Москвич в тот же момент ещё в 24.11 (17:00): его счёт свой и по своему дню.
  const m = await trial(store, "msk", "Europe/Moscow");
  assert.equal(quotaDay(m, now), "2026-11-24");
  await store.close();
});

test("секунды голоса: от клиента (не короче размера при 128 кбит/с), без длительности — по размеру при 32 кбит/с; вверх до целых", () => {
  assert.equal(voiceSeconds(40_000), 10, "виджет: 40 КБ при 4000 Б/с — 10 с");
  assert.equal(voiceSeconds(40_001), 11, "вверх до целых");
  assert.equal(voiceSeconds(0), 1, "не меньше секунды");
  assert.equal(voiceSeconds(40_000, 12.2), 13, "сайт прислал 12.2 с — 13");
  assert.equal(voiceSeconds(160_000, 1), 10, "занизить нельзя: 160 КБ — не меньше 10 с");
  assert.equal(voiceSeconds(1000, 7), 7, "Telegram: voice.duration");
});

test("голос в лимите: секунды суммируются; не влезает — voice_cap, взятый запрос возвращается; refund после сбоя распознавания", async () => {
  const store = await fresh({ trialVoiceMin: 1, aiBurst: 1000 });
  const gate = new AiGate(store, { owners: () => [] });
  const u = await trial(store, "voice");
  const day = quotaDay(u, new Date());
  const a = await gate.check(u, { take: { calls: 1, voiceSec: 40 } });
  assert.equal(a.ok, true);
  const b = await gate.check(u, { take: { calls: 1, voiceSec: 25 } });
  assert.deepEqual(b.ok ? null : [b.reason, b.text], ["voice_cap", VOICE_CAP_TEXT], "40 + 25 > 60 с: своя фраза про голос");
  assert.deepEqual(await store.quotaOf(u.id, day), { calls: 1, draws: 0, voice_sec: 40 }, "запрос второго голосового вернулся");
  const c = await gate.check(u, { take: { calls: 1, voiceSec: 20 } });
  assert.equal(c.ok, true, "40 + 20 = 60 — ровно лимит");
  await gate.refund(u, c.ok ? c.taken : undefined);
  assert.deepEqual(await store.quotaOf(u.id, day), { calls: 1, draws: 0, voice_sec: 40 }, "сбой распознавания — взятое вернулось");
  await store.close();
});

test("лимит 0 — функции на тарифе нет: картинки закрыты своим текстом, остальное работает", async () => {
  const store = await fresh({ trialDraws: 0, aiBurst: 1000 });
  const gate = new AiGate(store, { owners: () => [] });
  const u = await trial(store, "nodraw");
  const no = await gate.check(u, { take: { draws: 1 } });
  assert.deepEqual(no.ok ? null : [no.why, no.reason, no.text], ["money", "draws_cap", OFF_TEXT]);
  assert.equal((await gate.check(u, { take: { calls: 1 } })).ok, true);
  await store.close();
});

test("подарок по /invite — свой тариф: свои лимиты в штуках и свой денежный предохранитель (не пробы)", async () => {
  const store = await fresh({ trialCalls: 5, giftCalls: 1, giftDayUsd: 0.04, trialDayUsd: 0.3, aiBurst: 1000 });
  const gate = new AiGate(store, { owners: () => [] });
  const g = await trial(store, "gift", VLAD, { trialLenDays: 0 });
  const t = await trial(store, "tr");
  assert.equal(tariffKindOf(g, gate.access(g)), "gift");
  assert.equal(tariffKindOf(t, gate.access(t)), "trial");
  assert.equal((await gate.check(g, { take: { calls: 1 } })).ok, true);
  const no = await gate.check(g, { take: { calls: 1 } });
  assert.equal(!no.ok && no.reason, "calls_cap", "у подарка 1 запрос");
  for (let i = 0; i < 3; i++) assert.equal((await gate.check(t, { take: { calls: 1 } })).ok, true, "у пробы — 5");
  // Денежный предохранитель подарка: $0.05 за сегодня при 0.04 — день у потолка; у пробы тот же расход — ниже 0.3.
  await store.addUsage(new Date(), { kind: "chat", model: "m", input: 1, output: 1, cost: 0.05, userId: g.id });
  await store.addUsage(new Date(), { kind: "chat", model: "m", input: 1, output: 1, cost: 0.05, userId: t.id });
  const cap = await gate.check(g);
  assert.equal(!cap.ok && cap.reason, "day_cap");
  assert.equal((await gate.check(t)).ok, true);
  assert.deepEqual(limitsOf("gift"), { calls: 1, draws: 3, voice_sec: 600 });
  await store.close();
});

test("друзья и владелец — без лимитов в штуках: при нулевых лимитах проходят и ничего не считается", async () => {
  const store = await fresh({ trialCalls: 0, paidCalls: 0, giftCalls: 0, trialDraws: 0, paidDraws: 0, trialVoiceMin: 0 });
  const gate = new AiGate(store, { owners: () => [OWNER] });
  const f = await store.createUser({ login: "fr", passwordHash: "x", tz: VLAD, plan: "friend" });
  const o = await store.createUser({ login: "ow", passwordHash: "x", tz: VLAD, chatId: OWNER, plan: "trial", accessUntil: iso(Date.now() + DAY) });
  for (const u of [f, o]) {
    for (let i = 0; i < 3; i++) assert.equal((await gate.check(u, { take: { calls: 1, draws: 1, voiceSec: 120 } })).ok, true);
    assert.deepEqual(await store.quotaOf(u.id, quotaDay(u, new Date())), { calls: 0, draws: 0, voice_sec: 0 });
    assert.equal(await todayView(store, u, gate.access(u)), null, "остатка нет — без лимита");
  }
  await store.close();
});

test("отказ по деньгам ничего не съедает: денежный потолок проверяется до штук", async () => {
  const store = await fresh({ trialDayUsd: 0.01, aiBurst: 1000 });
  const gate = new AiGate(store, { owners: () => [] });
  const u = await trial(store, "poor");
  await store.addUsage(new Date(), { kind: "chat", model: "m", input: 1, output: 1, cost: 0.02, userId: u.id });
  const v = await gate.check(u, { take: { calls: 1, draws: 1 } });
  assert.equal(!v.ok && v.reason, "day_cap");
  assert.deepEqual(await store.quotaOf(u.id, quotaDay(u, new Date())), { calls: 0, draws: 0, voice_sec: 0 });
  await store.close();
});

test("текст при упоре: подписчику — без фразы про подписку; меняется в «Тарифах» (история, откат); проверка строки сайт = сервер", async () => {
  const store = await fresh({ paidCalls: 1, trialCalls: 1, aiBurst: 1000 });
  const gate = new AiGate(store, { owners: () => [] });
  const p = await store.createUser({ login: "pd", passwordHash: "x", tz: VLAD, plan: "paid", accessUntil: iso(Date.now() + 10 * DAY) });
  await gate.check(p, { take: { calls: 1 } });
  const no = await gate.check(p, { take: { calls: 1 } });
  assert.equal(!no.ok && no.text, PAID_LIMIT_TEXT);
  assert.ok(!PAID_LIMIT_TEXT.includes("подписк"));
  overrideTariffs({ paidCalls: 1, trialCalls: 1 }); // applyTariffs ниже перечитает базу — свои числа пишем в неё же
  await applyTariffs(store, 1, { paidCalls: 1, trialCalls: 1 }, "для теста");
  const r = await applyTariffs(store, 1, { limitText: "Устала, отдохну до утра.", paidLimitText: "Отдохну до утра." }, "новый текст");
  assert.deepEqual(r.changes.map((c) => c.key).sort(), ["limitText", "paidLimitText"]);
  const t = await trial(store, "tt");
  await gate.check(t, { take: { calls: 1 } });
  const nt = await gate.check(t, { take: { calls: 1 } });
  assert.equal(!nt.ok && nt.text, "Устала, отдохну до утра.");
  assert.match((await store.adminLog())[0].detail, /limitText изменён, paidLimitText изменён|paidLimitText изменён, limitText изменён/, "в журнал — без самого текста");
  await undoTariff(store, 1, r.id, "вернуть");
  assert.equal(tariffs().limitText, LIMIT_TEXT);
  // Негодные строки — 400 с той же причиной, что на сайте.
  const bad: [unknown, RegExp][] = [
    [{ limitText: "" }, /напишите текст/], [{ limitText: "   " }, /напишите текст/], [{ limitText: "x".repeat(301) }, /не длиннее 300/],
    [{ limitText: "a <b>" }, /без знаков/], [{ limitText: "a & b" }, /без знаков/], [{ paidLimitText: "a\u0007b" }, /служебных/], [{ limitText: 5 }, /нужен текст/],
    [{ trialCalls: -1 }, /не меньше 0/], [{ giftDraws: 100_001 }, /не больше 100000/], [{ paidVoiceMin: 1.5 }, /целое/], [{ giftDayUsd: 0 }, /не меньше 0.01/],
  ];
  for (const [patch, re] of bad) {
    await assert.rejects(applyTariffs(store, 1, patch, "причина"), (e: Error & { status?: number }) => re.test(e.message) && e.status === 400, JSON.stringify(patch));
    assert.deepEqual(web.checkTariffPatch(patch), checkTariffPatch(patch), `сайт и сервер: ${JSON.stringify(patch)}`);
  }
  assert.equal(checkTariffValue("limitText", "Две строки\nтекста"), null, "перевод строки можно");
  assert.equal(checkTariffValue("trialCalls", 0), null, "0 — можно (значит «нельзя на тарифе»)");
  await store.close();
});

test("новые поля тарифов: проверка на сайте — копия серверной (числа и строки)", () => {
  assert.deepEqual(web.TARIFF_SPEC, TARIFF_SPEC);
  const samples: unknown[] = [0, 1, -1, 1.5, 0.01, 100_000, 100_001, "", " ", "ок", "x".repeat(300), "x".repeat(301), "<", "&", "a\tb", "a\nb", true, null];
  for (const k of ["trialCalls", "trialDraws", "trialVoiceMin", "paidCalls", "paidDraws", "paidVoiceMin", "giftDayUsd", "giftCalls", "giftDraws", "giftVoiceMin", "limitText", "paidLimitText"]) {
    for (const v of samples) assert.equal(web.checkTariffValue(k, v), checkTariffValue(k, v), `${k}=${JSON.stringify(v)}`);
  }
});

test("конвейер: обращение — один запрос, рисунок — одна картинка; упор — сообщение заметкой с текстом из тарифов; фон не считается", async () => {
  resetFeatureEvents();
  const store = await fresh({ trialCalls: 3, trialDraws: 1, aiBurst: 1000 });
  let answer: unknown = { draw: { prompt: "a cat", title: "Кот" }, reply: "Рисую!" };
  const asked: unknown[] = [];
  const llm: LlmCall = async (m) => (asked.push(m), JSON.stringify(answer));
  const pipe = new Pipeline(store, llm);
  pipe.gate = new AiGate(store, { owners: () => [] });
  let drawn = 0;
  pipe.draw = async () => (drawn++, { mime: "image/png", data: "eA==" });
  const u = await trial(store, "pipe");
  const day = () => store.quotaOf(u.id, quotaDay(u, new Date()));
  const at = new Date();
  const r1 = await pipe.handle({ user: u, source: "telegram", sourceId: "1", text: "нарисуй кота", at, client: "telegram" });
  assert.ok(r1.drawing, "нарисовала");
  const r2 = await pipe.handle({ user: u, source: "telegram", sourceId: "2", text: "нарисуй ещё кота", at, client: "telegram" });
  assert.equal(r2.drawing, undefined);
  assert.equal(r2.text, DRAWS_CAP_TEXT, "картинки кончились — своя фраза (запросы ещё есть)");
  assert.equal(drawn, 1);
  assert.deepEqual(await day(), { calls: 2, draws: 1, voice_sec: 0 });
  answer = { reply: "Записала.", diary: [{ section: "notes", text: "x" }] };
  await pipe.handle({ user: u, source: "telegram", sourceId: "3", text: "купить молоко", at, client: "telegram" });
  const before = asked.length;
  const r4 = await pipe.handle({ user: u, source: "telegram", sourceId: "4", text: "позвонить маме", at, client: "telegram" });
  assert.equal(asked.length, before, "четвёртое — модель не звали");
  assert.equal(r4.blocked, "money");
  assert.match(r4.text, new RegExp(`^${LIMIT_TEXT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(r4.text, /записала заметкой/);
  assert.equal(r4.undoable, true);
  // Фоновый повтор (background) — без счёта: упавшее раньше сообщение разбирается и при выбранном лимите.
  const { message } = await store.saveMessage({ userId: u.id, source: "telegram", sourceId: "5", text: "старое", dayKey: quotaDay(u, at), at });
  await store.setMessage(message.id, { state: "failed", reply: "other" });
  const bg = await pipe.retry(u, message.id, at, undefined, true);
  assert.equal(bg.blocked, undefined);
  assert.deepEqual(await day(), { calls: 3, draws: 1, voice_sec: 0 });
  // Отказы — в счётчиках фич gate.calls_cap и gate.draws_cap.
  await flushFeatures(store, Date.now(), true);
  const f = (await store.analyticsFeatureUsers("2000-01-01", "2100-01-01", ["gate.calls_cap", "gate.draws_cap"])).map((r) => r.feature).sort();
  assert.deepEqual(f, ["gate.calls_cap", "gate.draws_cap"]);
  resetFeatureEvents();
  await store.close();
});

test("API: упор в лимит — 429 с текстом, messageId и saved (как дневной потолок); голос — 429 до распознавания, saved false; /api/me — остаток", async () => {
  const keep = { allowed: [...config.allowedChatIds], admin: [...config.adminChatIds] };
  config.allowedChatIds.splice(0, Infinity);
  config.adminChatIds.splice(0, Infinity);
  const store = await fresh({ trialCalls: 2, trialVoiceMin: 0, aiBurst: 1000 });
  const pipe = new Pipeline(store, async () => JSON.stringify({ reply: "Записала.", diary: [{ section: "notes", text: "x" }] }));
  pipe.gate = new AiGate(store, { owners: () => [] });
  const u = await store.createUser({ login: "lim", passwordHash: await hashPassword("lim-pass-1"), tz: VLAD, plan: "trial", accessUntil: iso(Date.now() + 5 * DAY), trialLenDays: 7 });
  await store.createUser({ login: "fri", passwordHash: await hashPassword("fri-pass-1"), tz: VLAD, plan: "friend" });
  const server = createApi({ store, pipeline: pipe }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const login = async (l: string, pw: string) => (await (await fetch(base + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: l, password: pw }) })).json()).token as string;
    const token = await login("lim", "lim-pass-1");
    const call = async (p: string, body?: unknown, tk = token) => {
      const r = await fetch(base + p, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tk}` }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    assert.equal((await call("/api/input", { text: "купить молоко", id: "a1" })).status, 200);
    const v = await call("/api/voice", { audio: Buffer.from("x".repeat(100)).toString("base64"), sec: 3 });
    assert.equal(v.status, 429, "голос на тарифе 0 мин — до распознавания");
    assert.equal(v.body.error, OFF_TEXT);
    assert.equal(v.body.saved, false);
    assert.equal((await call("/api/input", { text: "купить хлеб", id: "a2" })).status, 200, "запрос голосового вернулся — второй проходит");
    const r = await call("/api/input", { text: "позвонить маме", id: "a3" });
    assert.equal(r.status, 429);
    assert.match(String(r.body.error), /^На сегодня мои силы кончились/);
    assert.equal(r.body.saved, true);
    assert.equal(typeof r.body.messageId, "number");
    const me = await call("/api/me");
    const today = (me.body.access as { today: Record<string, unknown> }).today;
    assert.deepEqual(today, {
      calls: { used: 2, limit: 2 }, draws: { used: 0, limit: 3 }, voice_sec: { used: 0, limit: 0 }, resets_at: quotaResetAt(u, new Date()),
    });
    assert.equal(((await call("/api/me", undefined, await login("fri", "fri-pass-1"))).body.access as { today: unknown }).today, null, "друг — без лимита");
  } finally {
    server.close();
    await store.close();
    config.allowedChatIds.splice(0, Infinity, ...keep.allowed);
    config.adminChatIds.splice(0, Infinity, ...keep.admin);
  }
});

test("экономика в «Тарифах»: средние цены единиц лимита из расхода в дни со счётчиками; нет штук — null", () => {
  const est = { draw: 0.03, voice: 0.005, other: 0.003 };
  assert.deepEqual(unitPrices([], [], est), { call_usd: null, draw_usd: null, voice_min_usd: null });
  const quota = [
    { user_id: 1, day: "2026-11-23", kind: "calls", n: 10 }, { user_id: 1, day: "2026-11-23", kind: "draws", n: 2 },
    { user_id: 1, day: "2026-11-23", kind: "voice_sec", n: 120 },
  ];
  const usage = [
    { day: "2026-11-23", user_id: 1, kind: "parse", calls: 10, priced: 10, micro: 20_000 },
    { day: "2026-11-23", user_id: 1, kind: "draw", calls: 2, priced: 0, micro: 0 },
    { day: "2026-11-23", user_id: 1, kind: "voice", calls: 2, priced: 2, micro: 8_000 },
    { day: "2026-11-22", user_id: 1, kind: "parse", calls: 50, priced: 50, micro: 900_000 }, // день без счётчиков — не в счёт
  ];
  const p = unitPrices(quota, usage, est);
  assert.equal(p.call_usd, 0.002);
  assert.equal(p.draw_usd, 0.03, "без цены — по оценке");
  assert.equal(p.voice_min_usd, 0.004);
});

test("остаток на сегодня: используется не больше лимита; лимит уменьшили — used не выше нового лимита", async () => {
  const store = await fresh({ aiBurst: 1000 });
  const u = await trial(store, "left");
  const gate = new AiGate(store, { owners: () => [] });
  await store.takeQuota(u.id, quotaDay(u, new Date()), "calls", 50, 60);
  overrideTariffs({ trialCalls: 10 });
  const t = await todayView(store, u, gate.access(u));
  assert.deepEqual(t?.calls, { used: 10, limit: 10 });
  assert.equal(!((await gate.check(u, { take: { calls: 1 } })).ok), true);
  await store.close();
});
