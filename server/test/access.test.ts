import { PGlite } from "@electric-sql/pglite";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { accessOf, AiGate, GRACE_MS, RATE_AGAIN, refusalText } from "../src/access.ts";
import { createApi } from "../src/api.ts";
import { hashPassword } from "../src/auth.ts";
import { Billing, type StarsApi } from "../src/billing.ts";
import { Store, type User } from "../src/db.ts";
import { PgDriver } from "../src/driver.ts";
import { signUp } from "../src/invite.ts";
import type { LlmCall } from "../src/llm.ts";
import { Pipeline, RETRY_AFTER_MIN } from "../src/pipeline.ts";
import { Scheduler } from "../src/scheduler.ts";
import { setSignupsOpen } from "../src/tariffs.ts";
import { zonedToUtc } from "../src/time.ts";

// Платный доступ (24.11.2026, access.ts): одна проверка перед ИИ. Без пробы и подписки модель не зовётся нигде — сообщение
// записывается заметкой (state done, фоновый повтор его не берёт), утро и вечер — без слов горничной, API — 402, а не 401.

const TZ = "Europe/Moscow";
const OWNER = "900";
const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString();

const BACKENDS: Record<string, () => Promise<Store>> = {
  sqlite: () => Store.open(":memory:"),
  postgres: async () => {
    const pg = new PGlite();
    return Store.over(new PgDriver(pg, (fn) => pg.transaction((tx) => fn(tx)), () => pg.close()));
  },
};

/** Модель-заглушка, которая считает вызовы. */
function countingLlm(answer: unknown = { reply: "Записала.", diary: [{ section: "notes", text: "x" }] }) {
  const calls: unknown[] = [];
  const llm: LlmCall = async (m) => (calls.push(m), typeof answer === "string" ? answer : JSON.stringify(answer));
  return { calls, llm };
}
const user = (p: Partial<User>): User => ({ id: 1, chat_id: "5", plan: "", access_until: null, sub_canceled: 0, sub_charge_id: null, ...p } as User);

test("доступ: владелец, друг, проба и подписка до срока (+1 ч запаса), дальше — закрыто", () => {
  const now = new Date("2026-11-24T12:00:00Z");
  const t = now.getTime();
  assert.equal(accessOf(user({ chat_id: OWNER }), now, [OWNER]).plan, "owner");
  assert.equal(accessOf(user({ plan: "friend" }), now, [OWNER]).ok, true);
  const trial = accessOf(user({ plan: "trial", access_until: iso(t + 2.5 * DAY) }), now, [OWNER]);
  assert.deepEqual([trial.ok, trial.plan, trial.trialLeftDays], [true, "trial", 3]);
  assert.equal(accessOf(user({ plan: "paid", access_until: iso(t - GRACE_MS / 2) }), now, [OWNER]).ok, true, "в пределах запаса");
  const gone = accessOf(user({ plan: "paid", access_until: iso(t - GRACE_MS - 1000), sub_charge_id: "c1" }), now, [OWNER]);
  assert.deepEqual([gone.ok, gone.plan, gone.ended], [false, "expired", "paid"]);
  const none = accessOf(user({ plan: "" }), now, [OWNER]);
  assert.deepEqual([none.ok, none.ended], [false, "trial"]);
  // Подарок по /invite (срок от создания записи дольше пробы) кончается своими словами, не «Пробная неделя».
  const gift = accessOf(user({ plan: "trial", created_at: iso(t - 40 * DAY), access_until: iso(t - 10 * DAY) }), now, [OWNER]);
  assert.equal(gift.ended, "gift");
  assert.match(refusalText("access", gift), /^Подарочный доступ закончился — я сохранила всё/);
  const week = accessOf(user({ plan: "trial", created_at: iso(t - 8 * DAY), access_until: iso(t - DAY) }), now, [OWNER]);
  assert.match(refusalText("access", week), /^Пробная неделя закончилась — я сохранила всё, что было\. Чтобы я снова разбирала сообщения, оформите подписку ⭐150 в месяц/);
  assert.equal(accessOf(user({ plan: "free", access_until: iso(t + DAY) }), now, [OWNER]).ok, false, "free — закрыто, даже если срок впереди");
});

for (const [kind, open] of Object.entries(BACKENDS)) {
  test(`${kind}: шаг 27 — все, кто был в базе, становятся друзьями (бесплатно навсегда), новые — без плана`, async () => {
    const store = await open();
    const old = await store.ensureUser("1", "Старый", TZ);
    await store.driver.exec("ALTER TABLE users DROP COLUMN plan; ALTER TABLE users DROP COLUMN access_until; ALTER TABLE users DROP COLUMN tg_user_id;" +
      " ALTER TABLE users DROP COLUMN sub_charge_id; ALTER TABLE users DROP COLUMN sub_canceled; DROP TABLE payments; ALTER TABLE users DROP COLUMN trial_len_days; ALTER TABLE users DROP COLUMN frozen_at; ALTER TABLE admin_log DROP COLUMN reason;");
    await store.kvSet("schema_version", "26");
    const again = await Store.over(store.driver);
    assert.equal(await again.kvGet("schema_version"), "38");
    const was = (await again.user(old.id))!;
    assert.deepEqual([was.plan, was.access_until, Number(was.sub_canceled), was.name], ["friend", null, 0, "Старый"]);
    assert.equal(accessOf(was, new Date(), []).ok, true);
    const fresh = await again.ensureUser("2", "Новый", TZ);
    assert.equal(fresh.plan, "");
    assert.equal(accessOf(fresh, new Date(), []).ok, false);
    assert.equal(await again.addPayment({ charge_id: "c", user_id: 1, tg_user_id: "1", amount: 150, currency: "XTR", payload: "p", kind: "first", paid_at: iso(Date.now()), expires_at: null }), true);
    assert.equal(await again.addPayment({ charge_id: "c", user_id: 1, tg_user_id: "1", amount: 150, currency: "XTR", payload: "p", kind: "first", paid_at: iso(Date.now()), expires_at: null }), false, "тот же charge_id");
    await again.close();
  });
}

test("частота окном и денежный потолок: 3 подряд проходят, сверх окна — rate; потолок пробы — по расходу дня; друг — без ограничений", async () => {
  const store = await Store.open(":memory:");
  let t = Date.parse("2026-11-24T12:00:00Z");
  const gate = new AiGate(store, { owners: () => [OWNER], clock: () => new Date(t), burst: 3, windowMs: 60_000, trialDayUsd: 0.3, paidDayUsd: 1.5 });
  const u = await store.createUser({ login: "new", passwordHash: "x", tz: TZ, chatId: "7", plan: "trial", accessUntil: iso(t + 7 * DAY) });
  // Альбом из трёх фото — три обновления в одну секунду: все проходят.
  for (let i = 0; i < 3; i++) assert.equal((await gate.check(u)).ok, true, "сообщение из пачки");
  const fast = await gate.check(u);
  assert.equal(fast.ok ? "" : fast.why, "rate");
  assert.equal((await gate.check(u, { rate: false })).ok, true, "фоновый повтор — без проверки частоты");
  t += 60_000;
  assert.equal((await gate.check(u)).ok, true, "окно прошло");
  await store.addUsage(new Date(t), { kind: "parse", model: "m", input: 1, output: 1, cost: 0.31, userId: u.id });
  t += 60_000;
  const rich = await gate.check(u);
  assert.equal(rich.ok ? "" : rich.why, "money");
  // Подписка: потолок выше.
  await store.updateUser(u.id, { plan: "paid", access_until: iso(t + 30 * DAY) });
  assert.equal((await gate.check((await store.user(u.id))!)).ok, true);
  // Друг — ни частоты, ни потолка.
  const f = await store.createUser({ login: "fr", passwordHash: "x", tz: TZ, chatId: "8", plan: "friend" });
  await store.addUsage(new Date(t), { kind: "parse", model: "m", input: 1, output: 1, cost: 50, userId: f.id });
  for (let i = 0; i < 5; i++) assert.equal((await gate.check(f)).ok, true);
  await store.close();
});

test("частота: 50 одновременных запросов — проходят только burst (вызов отмечается до первого await)", async () => {
  const store = await Store.open(":memory:");
  const gate = new AiGate(store, { owners: () => [OWNER], burst: 3, windowMs: 60_000 });
  const u = await store.createUser({ login: "flood", passwordHash: "x", tz: TZ, chatId: "7", plan: "trial", accessUntil: iso(Date.now() + DAY) });
  const all = await Promise.all(Array.from({ length: 50 }, () => gate.check(u)));
  assert.equal(all.filter((v) => v.ok).length, 3);
  await store.close();
});

for (const [kind, open] of Object.entries(BACKENDS)) {
  test(`потолок (${kind}) видит вызовы без цены (оценка по виду), а общий потолок проб закрывает пробы, но не подписку`, async () => {
    const store = await open();
    const t = Date.parse("2026-11-24T12:00:00Z");
    const at = new Date(t);
    const u = await store.createUser({ login: "a", passwordHash: "x", tz: TZ, chatId: "7", plan: "trial", accessUntil: iso(t + DAY) });
    for (let i = 0; i < 10; i++) await store.addUsage(at, { kind: "draw", model: "runpod", input: 0, output: 0, cost: null, userId: u.id });
    await store.addUsage(at, { kind: "parse", model: "m", input: 1, output: 1, cost: 0.01, userId: u.id });
    const est = { draw: 0.03, voice: 0.005, other: 0.003 };
    assert.ok(Math.abs((await store.daySpend(u.id, "2026-11-24", est)) - 0.31) < 1e-9, "10 рисунков без цены по $0,03 + $0,01");
    assert.equal(await store.daySpend(u.id, "2026-11-24"), 0.01, "без оценки — только известная цена");
    const gate = new AiGate(store, { owners: () => [OWNER], clock: () => at, burst: 100, trialDayUsd: 0.3, trialPoolDayUsd: 100 });
    const v = await gate.check(u);
    assert.equal(v.ok ? "" : v.why, "money", "рисунки без цены тоже упираются в потолок");
    // Общий потолок проб: у каждого по чуть-чуть, вместе — больше пула.
    const b = await store.createUser({ login: "b", passwordHash: "x", tz: TZ, chatId: "8", plan: "trial", accessUntil: iso(t + DAY) });
    const p = await store.createUser({ login: "p", passwordHash: "x", tz: TZ, chatId: "9", plan: "paid", accessUntil: iso(t + 30 * DAY) });
    const pool = new AiGate(store, { owners: () => [OWNER], clock: () => at, burst: 100, trialDayUsd: 5, paidDayUsd: 5, trialPoolDayUsd: 0.3 });
    const vb = await pool.check(b);
    assert.equal(vb.ok ? "" : vb.why, "money", "у b расхода нет, но пробы вместе уже потратили пул");
    assert.equal((await pool.check(p)).ok, true, "подписка — вне пула проб");
    assert.ok(Math.abs((await store.trialsDaySpend("2026-11-24", est)) - 0.31) < 1e-9);
    await store.close();
  });
}

test("конвейер: слишком часто — сообщение не заметкой, а «не удалось»: фоновый повтор его потом разбирает; картинка и /ask — просьба прислать ещё раз", async () => {
  const store = await Store.open(":memory:");
  const { calls, llm } = countingLlm();
  const pipe = new Pipeline(store, llm);
  pipe.gate = new AiGate(store, { owners: () => [OWNER], burst: 1, windowMs: 60_000 });
  const u = await store.createUser({ login: "fast", passwordHash: "x", tz: TZ, chatId: "7", plan: "trial", accessUntil: iso(Date.now() + DAY) });
  const at = new Date();
  assert.equal((await pipe.handle({ user: u, source: "telegram", sourceId: "1", text: "купить молоко", at })).failed, undefined);
  const r = await pipe.handle({ user: u, source: "telegram", sourceId: "2", text: "позвонить маме", at });
  assert.deepEqual([r.failed, r.blocked, r.undoable], [true, undefined, false]);
  assert.match(r.text, /разберу чуть позже/);
  assert.equal((await store.message(r.messageId))!.state, "failed", "не done — его возьмёт retryFailed");
  assert.equal((await store.diaryRange(u.id, "0000-01-01", "9999-12-31")).filter((d) => d.text === "позвонить маме").length, 0, "заметкой не записано");
  const pic = await pipe.handle({ user: u, source: "telegram", sourceId: "3", text: "", images: [{ data: "eA==", mime: "image/jpeg" }], at });
  assert.equal(pic.text, RATE_AGAIN);
  const ask = await pipe.handle({ user: u, source: "telegram", sourceId: "4", text: "как дела?", chatOnly: true, at });
  assert.equal(ask.text, RATE_AGAIN);
  assert.equal(calls.length, 1);
  const sent: string[] = [];
  await pipe.retryFailed(async (_u, text) => void sent.push(text), new Date(at.getTime() + RETRY_AFTER_MIN[0] * 60_000 + 1000));
  assert.equal(calls.length, 2, "фоновый повтор разобрал (частота ему не мешает)");
  assert.equal((await store.message(r.messageId))!.state, "done");
  assert.match(sent[0] ?? "", /Разобрала «позвонить маме»/);
  await store.close();
});

test("конвейер без доступа: модель не зовётся, текст — заметкой, сообщение done; фоновый повтор его не берёт", async () => {
  const store = await Store.open(":memory:");
  const { calls, llm } = countingLlm();
  const pipe = new Pipeline(store, llm);
  pipe.gate = new AiGate(store, { owners: () => [OWNER] });
  const u = await store.createUser({ login: "late", passwordHash: "x", tz: TZ, chatId: "7", plan: "trial", accessUntil: iso(Date.now() - 2 * DAY) });
  const at = new Date();
  const r = await pipe.handle({ user: u, source: "telegram", sourceId: "1", text: "купить молоко", at });
  assert.equal(calls.length, 0, "ни одного вызова модели");
  assert.equal(r.blocked, "access");
  assert.match(r.text, /Пробная неделя закончилась — я сохранила всё, что было\. Чтобы я снова разбирала сообщения, оформите подписку ⭐150 в месяц/);
  assert.match(r.text, /записала заметкой/);
  assert.equal(r.undoable, true);
  const m = (await store.message(r.messageId))!;
  assert.equal(m.state, "done");
  const notes = (await store.diaryRange(u.id, "0000-01-01", "9999-12-31")).filter((d) => d.section === "notes");
  assert.deepEqual(notes.map((d) => d.text), ["купить молоко"]);
  // Повтор доставки — прежний ответ, без второй заметки.
  assert.equal((await pipe.handle({ user: u, source: "telegram", sourceId: "1", text: "купить молоко", at })).duplicate, true);
  // /ask без доступа — без заметки (это вопрос, не запись), но тоже done.
  const ask = await pipe.handle({ user: u, source: "telegram", sourceId: "2", text: "как дела?", chatOnly: true, at });
  assert.deepEqual([ask.blocked, ask.undoable], ["access", false]);
  // Поправка к ответу — тоже ИИ (до отмены: у отменённого ответа поправка честно отвечает «поправлять нечего» без модели и без проверки).
  const c = await pipe.correct(u, r.messageId, "не молоко, а кефир", { sourceId: "c1" });
  assert.equal(c?.blocked, "access");
  assert.equal(calls.length, 0);
  // Отменить заметку можно, как обычную запись.
  await pipe.undo(u, r.messageId);
  assert.equal((await store.diaryRange(u.id, "0000-01-01", "9999-12-31")).filter((d) => d.section === "notes").length, 0);
  // Упавшее раньше сообщение (было на пробе) — фоновый повтор его не трогает, пока доступа нет.
  const { message } = await store.saveMessage({ userId: u.id, source: "telegram", sourceId: "3", text: "старое", dayKey: "2026-11-20", at: new Date(Date.now() - 3600_000) });
  await store.setMessage(message.id, { state: "failed", reply: "other" });
  const sent: string[] = [];
  await pipe.retryFailed(async (_u, text) => void sent.push(text), new Date(Date.now() + RETRY_AFTER_MIN[0] * 60_000));
  assert.equal(calls.length, 0);
  assert.equal((await store.message(message.id))!.state, "failed");
  assert.deepEqual(sent, []);
  // Проба продлена (подарок) — снова разбирает.
  await store.updateUser(u.id, { access_until: iso(Date.now() + DAY) });
  const ok = await pipe.handle({ user: (await store.user(u.id))!, source: "telegram", sourceId: "4", text: "купить хлеб", at });
  assert.equal(ok.blocked, undefined);
  assert.equal(calls.length, 1);
  await store.close();
});

test("планировщик: у кого нет доступа — утро и итог без слов горничной и без закономерностей; напоминания идут", async () => {
  const store = await Store.open(":memory:");
  const { calls, llm } = countingLlm("Хороший день.");
  const sent: { text: string; kind?: string }[] = [];
  const sch = new Scheduler(store, llm, async (_u, text, _e, _b, kind) => void sent.push({ text, kind }));
  const gate = new AiGate(store, { owners: () => [OWNER] });
  sch.aiFor = (u, now) => gate.allowed(u, now);
  const u = await store.createUser({ login: "late", passwordHash: "x", tz: TZ, chatId: "7", plan: "free", accessUntil: "2026-11-01T00:00:00Z" });
  await store.addReminder(u.id, "event", 1, zonedToUtc("2026-11-24", "21:59", TZ), "⏰ Через 1 ч: Врач");
  await sch.tick(zonedToUtc("2026-11-24", "09:01", TZ));
  await sch.tick(zonedToUtc("2026-11-24", "13:01", TZ));
  await sch.tick(zonedToUtc("2026-11-24", "22:00", TZ));
  assert.equal(calls.length, 0, "ни утро, ни вечер, ни закономерности не звали модель");
  assert.ok(sent.some((s) => s.kind === "morning"), "утро пришло");
  assert.ok(sent.some((s) => s.kind === "evening" && /Итог дня/.test(s.text)), "итог пришёл — цифрами");
  assert.ok(sent.some((s) => s.text.startsWith("⏰")), "напоминание пришло");
  // С доступом — вечер со словами горничной.
  await store.updateUser(u.id, { plan: "friend" });
  await sch.tick(zonedToUtc("2026-11-25", "22:00", TZ));
  assert.equal(calls.length, 1);
  await store.close();
});

test("регистрация незнакомца: проба на 7 дней; выключатель и потолок в час; уже есть запись — null", async () => {
  const store = await Store.open(":memory:");
  const now = new Date("2026-11-24T12:00:00Z");
  const o = { open: true, perHour: 2, perDay: 3, trialDays: 7 };
  const a = await signUp(store, { id: "11", name: "Аня", username: "anya" }, TZ, now, o);
  assert.ok(a && typeof a === "object");
  assert.deepEqual([a.login, a.user.plan, a.until], ["anya", "trial", iso(now.getTime() + 7 * DAY)]);
  assert.ok(a.password && a.password.length >= 8);
  assert.equal(await signUp(store, { id: "11", name: "Аня" }, TZ, now, o), null, "второй /start — та же запись");
  assert.equal(await signUp(store, { id: "12", name: "Б" }, TZ, now, { ...o, open: false }), "closed");
  assert.ok(typeof (await signUp(store, { id: "12", name: "Б" }, TZ, now, o)) === "object");
  assert.equal(await signUp(store, { id: "13", name: "В" }, TZ, now, o), "busy", "за час уже двое");
  assert.ok(typeof (await signUp(store, { id: "13", name: "В" }, TZ, new Date(now.getTime() + 3601_000), o)) === "object", "через час — можно");
  assert.equal(await signUp(store, { id: "14", name: "Г" }, TZ, new Date(now.getTime() + 7300_000), o), "busy", "за сутки уже трое");
  // Без o — текущие тарифы (tariffs.ts): владелец закрыл регистрацию (/signups off или админка) — «закрыто».
  await setSignupsOpen(store, 0, false);
  assert.equal(await signUp(store, { id: "15", name: "Д" }, TZ, new Date(now.getTime() + 2 * DAY)), "closed", "владелец закрыл (/signups off)");
  await setSignupsOpen(store, 0, true);
  await store.close();
});

test("API без доступа: 402 со ссылкой на оплату (не 401 — ключ живой), /api/me показывает доступ, ссылка на оплату работает", async () => {
  const store = await Store.open(":memory:");
  const { calls, llm } = countingLlm();
  const pipe = new Pipeline(store, llm);
  pipe.gate = new AiGate(store, { owners: () => [OWNER] });
  const links: string[] = [];
  const api = {
    createInvoiceLink: async (...a: unknown[]) => (links.push(String(a[2])), "https://t.me/$test-invoice"),
  } as unknown as StarsApi;
  const billing = new Billing(store, api, { secret: "s" });
  await store.createUser({ login: "late", passwordHash: await hashPassword("late-pass-1"), tz: TZ, chatId: "7", plan: "trial", accessUntil: iso(Date.now() - DAY) });
  const server = createApi({ store, pipeline: pipe, billing }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const token = (await (await fetch(base + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: "late", password: "late-pass-1" }) })).json()).token as string;
    const call = async (p: string, body?: unknown) => {
      const r = await fetch(base + p, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    const r = await call("/api/input", { text: "купить молоко", id: "m1" });
    assert.equal(r.status, 402);
    assert.equal(r.body.pay_url, "https://t.me/$test-invoice");
    assert.match(String(r.body.error), /Пробная неделя закончилась/);
    assert.equal(r.body.saved, true);
    assert.equal(calls.length, 0);
    const voice = await call("/api/voice", { audio: Buffer.from("x").toString("base64") });
    assert.equal(voice.status, 402, "голос — до распознавания");
    assert.equal(voice.body.saved, false, "голос нигде не записан — виджет оставит его в очереди");
    const me = await call("/api/me");
    assert.equal(me.status, 200, "ключ не стёрт: /api/me работает");
    assert.deepEqual(Object.keys(me.body.access as object).sort(), ["canceled", "plan", "price", "today", "trial_left_days", "until"]);
    assert.equal((me.body.access as { today: unknown }).today, null, "без доступа — остатка лимитов нет");
    assert.equal((me.body.access as { plan: string }).plan, "expired");
    assert.equal((await call("/api/today")).status, 200, "просмотр своих данных — бесплатно");
    const link = await call("/api/billing/link", {});
    assert.deepEqual([link.status, link.body.url], [200, "https://t.me/$test-invoice"]);
    assert.equal(links.length, 1, "ссылка из kv на сутки — Telegram второй раз не зовётся");
    assert.equal((await call("/api/billing/cancel", {})).status, 409, "подписки нет");
  } finally {
    server.close();
    await store.close();
  }
});
