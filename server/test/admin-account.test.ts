import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { AiGate, FROZEN_TEXT, quotaDay, todayView } from "../src/access.ts";
import { createApi } from "../src/api.ts";
import { hashPassword } from "../src/auth.ts";
import { Billing, signPayload, type StarsApi } from "../src/billing.ts";
import { createBot } from "../src/bot.ts";
import { config } from "../src/config.ts";
import { Store } from "../src/db.ts";
import type { LlmCall } from "../src/llm.ts";
import { Pipeline } from "../src/pipeline.ts";
import { Scheduler } from "../src/scheduler.ts";
import { zonedToUtc } from "../src/time.ts";

// Этап 3 «Тарифы и управление» (admin-account.ts): карточка аккаунта по номеру и действия с ним — продлить, подарок, лимит на
// сегодня, возврат звёзд (через Billing.refund), заморозка. Тем же путём, что админка сайта: вход → код из «Telegram» → /api/admin/*.
// Telegram подменён заглушкой — видно, что и кому ушло.

const OWNER = "1001";
const TZ = "Europe/Moscow";
const DAY = 86_400_000;
const SECRET = "test-billing-secret";
const iso = (t: number) => new Date(t).toISOString();

function fakeTelegram() {
  const log: { m: string; a: unknown[] }[] = [];
  const api: StarsApi = {
    createInvoiceLink: async (...a) => (log.push({ m: "link", a }), "https://t.me/$inv"),
    answerPreCheckoutQuery: async (...a) => (log.push({ m: "pre", a }), true),
    refundStarPayment: async (...a) => (log.push({ m: "refund", a }), true),
    editUserStarSubscription: async (...a) => (log.push({ m: "edit", a }), true),
    sendMessage: async (...a) => (log.push({ m: "send", a }), {}),
  };
  return { api, log, of: (m: string) => log.filter((x) => x.m === m), to: (chat: string) => log.filter((x) => x.m === "send" && String(x.a[0]) === chat).map((x) => String(x.a[1])) };
}

async function stand() {
  config.allowedChatIds.splice(0, Infinity, OWNER);
  config.adminChatIds.splice(0, Infinity);
  const store = await Store.open(":memory:");
  const tg = fakeTelegram();
  const billing = new Billing(store, tg.api, { secret: SECRET, price: 150 });
  const owner = await store.createUser({ login: "owner", passwordHash: await hashPassword("owner-pass-1"), tz: TZ, chatId: OWNER, name: "Хозяин" });
  const anya = await store.createUser({ login: "anya", passwordHash: await hashPassword("anya-pass-1"), tz: TZ, chatId: "11", name: "Аня", plan: "trial", accessUntil: iso(Date.now() + 2 * DAY), trialLenDays: 7 });
  const codes: string[] = [];
  const pipeline = new Pipeline(store, async () => "{}");
  pipeline.gate = new AiGate(store, { owners: () => [OWNER] });
  const server = createApi({ store, pipeline, billing, adminCode: async (_u, text) => void codes.push(text.match(/\d{6}/)![0]) }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = async (l: string, pw: string) => {
    const r = await fetch(base + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: l, password: pw }) });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const callAs = async (token: string, p: string, body?: unknown) => {
    const r = await fetch(base + p, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> };
  };
  const token = String((await login("owner", "owner-pass-1")).body.token);
  await callAs(token, "/api/admin/code", {});
  assert.equal((await callAs(token, "/api/admin/confirm", { code: codes[0] })).status, 200);
  const call = (p: string, body?: unknown) => callAs(token, p, body);
  return { store, tg, billing, owner, anya, call, callAs, login, close: async () => { server.close(); await store.close(); } };
}

const noPrivate = (body: unknown) => {
  const json = JSON.stringify(body);
  for (const bad of ["Аня", "Хозяин", '"anya"', '"owner"', '"11"', OWNER, "chat_id", "login", "name", "password_hash", "tg_user_id"]) {
    assert.ok(!json.includes(bad), `в ответе админки: ${bad}`);
  }
};

test("карточка аккаунта: только числа и номер; нет такого #id — 404; не админу — 404, без кода — 403", async () => {
  const s = await stand();
  try {
    const card = await s.call(`/api/admin/account/${s.anya.id}`);
    assert.equal(card.status, 200);
    const c = card.body;
    assert.deepEqual([c.id, c.plan, c.kind, c.frozen_at, c.protected, c.live_sub], [s.anya.id, "trial", "trial", null, false, false]);
    assert.deepEqual([c.today.calls.used, c.today.calls.limit, c.today.calls.bonus], [0, 60, 0]);
    assert.equal(c.week.length, 7, "активность — 7 дней");
    for (const k of ["payments", "events", "week", "devices", "log"]) assert.ok(Array.isArray(c[k]), k);
    noPrivate(c);
    assert.equal((await s.call("/api/admin/account/99999")).status, 404);
    assert.equal((await s.call("/api/admin/account/99999/extend", { days: 7, reason: "проверка" })).status, 404, "действие с несуществующим — 404");
    assert.equal((await s.call(`/api/admin/account/${s.anya.id}/nope`, { reason: "проверка" })).status, 404, "незнакомое действие — 404");
    assert.equal((await s.call(`/api/admin/account/${s.owner.id}`)).body.protected, true, "владельца заморозить нельзя — видно в карточке");
    // Не админ (Аня) — адреса нет; админ на другом устройстве без кода — 403.
    const anyaToken = String((await s.login("anya", "anya-pass-1")).body.token);
    assert.equal((await s.callAs(anyaToken, `/api/admin/account/${s.anya.id}`)).status, 404);
    assert.equal((await s.callAs(anyaToken, `/api/admin/account/${s.anya.id}/extend`, { days: 7, reason: "сам себе" })).status, 404);
    const other = String((await s.login("owner", "owner-pass-1")).body.token);
    assert.equal((await s.callAs(other, `/api/admin/account/${s.anya.id}`)).status, 403);
    assert.equal((await s.callAs(other, `/api/admin/account/${s.anya.id}/freeze`, { reason: "без кода" })).status, 403);
  } finally {
    await s.close();
  }
});

test("продлить срок: проба — от конца срока; проверка дней и причины; журнал с причиной и параметрами; письмо в Telegram", async () => {
  const s = await stand();
  try {
    const p = `/api/admin/account/${s.anya.id}/extend`;
    for (const bad of [{ days: 0, reason: "сбой" }, { days: 366, reason: "сбой" }, { days: 1.5, reason: "сбой" }, { days: "7", reason: "сбой" }, { days: 7 }, { days: 7, reason: "  " }, { days: 7, reason: "ой" }]) {
      assert.equal((await s.call(p, bad)).status, 400, JSON.stringify(bad));
    }
    const before = Date.parse((await s.store.user(s.anya.id))!.access_until!);
    const r = await s.call(p, { days: 7, reason: "сбой оплаты 24.11" });
    assert.equal(r.status, 200);
    const u = (await s.store.user(s.anya.id))!;
    assert.equal(Date.parse(u.access_until!), before + 7 * DAY, "к концу нынешнего срока");
    assert.deepEqual([u.plan, Number(u.trial_len_days)], ["trial", 7], "проба осталась пробой");
    assert.equal(r.body.card.until, u.access_until);
    const ev = await s.store.billingEventsOf(s.anya.id);
    assert.deepEqual(ev.map((e) => e.kind), ["admin_extend"]);
    const log = (await s.call("/api/admin/log")).body as unknown as { who: string; action: string; detail: string; reason: string }[];
    assert.deepEqual([log[0].who, log[0].action, log[0].reason], [`#${s.owner.id}`, "extend", "сбой оплаты 24.11"]);
    assert.match(log[0].detail, new RegExp(`^#${s.anya.id} \\+7 дн\\. → до \\d{4}-\\d\\d-\\d\\d$`));
    noPrivate(log);
    assert.match(s.tg.to("11").at(-1)!, /доступ продлён до/);
    // Друг и владелец — сроков нет.
    const friend = await s.store.createUser({ login: "fr", passwordHash: "x", tz: TZ, plan: "friend" });
    assert.equal((await s.call(`/api/admin/account/${friend.id}/extend`, { days: 7, reason: "проверка" })).status, 409);
    assert.equal((await s.call(`/api/admin/account/${s.owner.id}/extend`, { days: 7, reason: "проверка" })).status, 409);
    // Кончившаяся проба — снова проба от сегодня.
    const old = await s.store.createUser({ login: "old", passwordHash: "x", tz: TZ, plan: "free", accessUntil: iso(Date.now() - 10 * DAY), trialLenDays: 7 });
    await s.call(`/api/admin/account/${old.id}/extend`, { days: 3, reason: "не успел" });
    const o = (await s.store.user(old.id))!;
    assert.equal(o.plan, "trial");
    assert.ok(Math.abs(Date.parse(o.access_until!) - (Date.now() + 3 * DAY)) < 60_000, "от сегодня");
    assert.equal((await s.call(`/api/admin/account/${old.id}`)).body.kind, "trial");
  } finally {
    await s.close();
  }
});

test("продлить оплаченную подписку: сдвигается access_until, подписка Telegram остаётся; продление Telegram берёт больший срок", async () => {
  const s = await stand();
  try {
    const exp = Math.floor((Date.now() + 30 * DAY) / 1000);
    await s.billing.paid({ id: 11 }, { currency: "XTR", total_amount: 150, invoice_payload: signPayload(SECRET, s.anya.id), telegram_payment_charge_id: "charge-aaaa11112222", subscription_expiration_date: exp, is_recurring: true, is_first_recurring: true });
    assert.equal((await s.call(`/api/admin/account/${s.anya.id}`)).body.live_sub, true);
    assert.equal((await s.call(`/api/admin/account/${s.anya.id}/grant`, { days: 30, reason: "подарок" })).status, 409, "поверх оплаченной подписки подарок не выдать");
    assert.equal((await s.call(`/api/admin/account/${s.anya.id}/extend`, { days: 10, reason: "компенсация сбоя" })).status, 200);
    const u = (await s.store.user(s.anya.id))!;
    assert.deepEqual([u.plan, u.sub_charge_id, Number(u.sub_canceled)], ["paid", "charge-aaaa11112222", 0]);
    assert.equal(Date.parse(u.access_until!), exp * 1000 + 10 * DAY);
    assert.match(s.tg.to("11").at(-1)!, /по своему графику/, "человеку — что Telegram списывает как раньше");
    assert.equal(s.tg.of("edit").length, 0, "подписку в Telegram не трогали");
    // Продление Telegram в свой день: срок — больший из оплаченного и нынешнего.
    await s.billing.paid({ id: 11 }, { currency: "XTR", total_amount: 150, invoice_payload: signPayload(SECRET, s.anya.id), telegram_payment_charge_id: "charge-renew", subscription_expiration_date: exp + 30 * 86400, is_recurring: true });
    assert.equal(Date.parse((await s.store.user(s.anya.id))!.access_until!), (exp + 30 * 86400) * 1000);
  } finally {
    await s.close();
  }
});

test("выдать подарок без оплаты: план trial, вид подарок, без sub_charge_id; журнал admin_grant; конец — gift_ended в Billing.expire", async () => {
  const s = await stand();
  try {
    const gone = await s.store.createUser({ login: "gone", passwordHash: "x", tz: TZ, chatId: "22", plan: "free", accessUntil: iso(Date.now() - DAY), trialLenDays: 7 });
    for (const bad of [{ days: 0, reason: "сбой" }, { days: 400, reason: "сбой" }, { days: 30 }]) {
      assert.equal((await s.call(`/api/admin/account/${gone.id}/grant`, bad)).status, 400, JSON.stringify(bad));
    }
    const r = await s.call(`/api/admin/account/${gone.id}/grant`, { days: 30, reason: "бета-тестер" });
    assert.equal(r.status, 200);
    let u = (await s.store.user(gone.id))!;
    assert.deepEqual([u.plan, Number(u.trial_len_days), u.sub_charge_id], ["trial", 0, null]);
    assert.deepEqual([r.body.card.plan, r.body.card.kind, r.body.card.live_sub], ["trial", "gift", false]);
    assert.deepEqual((await s.store.billingEventsOf(gone.id)).map((e) => e.kind), ["admin_grant"]);
    assert.match(s.tg.to("22").at(-1)!, /подарок/);
    assert.equal(s.billing.payable(u), null, "подарок — не подписка: оформить настоящую можно");
    const log = (await s.call("/api/admin/log")).body as unknown as { action: string; detail: string; reason: string }[];
    assert.deepEqual([log[0].action, log[0].reason], ["grant", "бета-тестер"]);
    assert.match(log[0].detail, new RegExp(`^#${gone.id} подарок 30 дн\\.`));
    // Срок кончился — планировщик переводит в free как подарок (не «подписка истекла»).
    await s.billing.expire(new Date(Date.now() + 31 * DAY + 2 * 3600_000));
    u = (await s.store.user(gone.id))!;
    assert.equal(u.plan, "free");
    assert.deepEqual((await s.store.billingEventsOf(gone.id)).map((e) => e.kind), ["gift_ended", "admin_grant"]);
    assert.match(s.tg.to("22").at(-1)!, /Подарочный доступ закончился/);
  } finally {
    await s.close();
  }
});

test("поднять лимит на сегодня: +N запросов только на сегодняшний день человека, завтра — снова по тарифу", async () => {
  const s = await stand();
  try {
    const now = new Date();
    const gate = new AiGate(s.store, { owners: () => [OWNER], clock: () => now });
    const u = (await s.store.user(s.anya.id))!;
    const day = quotaDay(u, now);
    assert.ok(await s.store.takeQuota(u.id, day, "calls", 60, 60), "весь лимит пробы выбран");
    assert.equal((await gate.check(u, { rate: false, take: { calls: 1 } })).ok, false);
    const p = `/api/admin/account/${u.id}/bonus`;
    for (const bad of [{ what: "calls", n: 0, reason: "срочно" }, { what: "calls", n: 1001, reason: "срочно" }, { what: "money", n: 5, reason: "срочно" }, { what: "calls", n: 5 }]) {
      assert.equal((await s.call(p, bad)).status, 400, JSON.stringify(bad));
    }
    const r = await s.call(p, { what: "calls", n: 2, reason: "срочный отчёт" });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.card.today.calls.limit, r.body.card.today.calls.bonus, r.body.card.today.calls.used], [62, 2, 60]);
    assert.equal((await todayView(s.store, u, gate.access(u), now))!.calls.limit, 62, "сайт видит поднятый лимит");
    assert.equal((await gate.check(u, { rate: false, take: { calls: 1 } })).ok, true);
    assert.equal((await gate.check(u, { rate: false, take: { calls: 1 } })).ok, true);
    assert.equal((await gate.check(u, { rate: false, take: { calls: 1 } })).ok, false, "прибавка — ровно +2");
    assert.deepEqual(await s.store.quotaOf(u.id, day), { calls: 62, draws: 0, voice_sec: 0 }, "счётчик взятого не тронут прибавкой");
    // Голос — в минутах, хранится в секундах.
    await s.call(p, { what: "voice_min", n: 5, reason: "длинное голосовое" });
    assert.equal((await s.store.quotaBonus(u.id, day)).voice_sec, 300);
    // Завтра (день человека) — прибавки нет, лимит по тарифу.
    const tomorrow = new Date(now.getTime() + DAY);
    assert.deepEqual(await s.store.quotaBonus(u.id, quotaDay(u, tomorrow)), { calls: 0, draws: 0, voice_sec: 0 });
    assert.equal((await todayView(s.store, u, gate.access(u, tomorrow), tomorrow))!.calls.limit, 60);
    const log = (await s.call("/api/admin/log")).body as unknown as { action: string; detail: string; reason: string }[];
    assert.ok(log.some((x) => x.action === "bonus" && x.detail === `#${u.id} +2 запросов на ${day}` && x.reason === "срочный отчёт"));
    // Без доступа (срок кончился) и другу — нечего поднимать.
    const gone = await s.store.createUser({ login: "gone", passwordHash: "x", tz: TZ, plan: "free", accessUntil: iso(Date.now() - DAY) });
    assert.equal((await s.call(`/api/admin/account/${gone.id}/bonus`, { what: "calls", n: 5, reason: "проверка" })).status, 409);
    const friend = await s.store.createUser({ login: "fr", passwordHash: "x", tz: TZ, plan: "friend" });
    assert.equal((await s.call(`/api/admin/account/${friend.id}/bonus`, { what: "calls", n: 5, reason: "проверка" })).status, 409);
  } finally {
    await s.close();
  }
});

test("вернуть звёзды из карточки: через Billing.refund (refundStarPayment), с причиной; устаревшая оплата — 409 без возврата", async () => {
  const s = await stand();
  try {
    const pay = (charge: string, at: number) => s.billing.paid({ id: 11 }, { currency: "XTR", total_amount: 150, invoice_payload: signPayload(SECRET, s.anya.id), telegram_payment_charge_id: charge, subscription_expiration_date: Math.floor(at / 1000), is_recurring: true, is_first_recurring: true });
    await pay("charge-old-00000001", Date.now() + 30 * DAY);
    const card = (await s.call(`/api/admin/account/${s.anya.id}`)).body;
    assert.deepEqual(card.payments.map((p: { charge: string; refundable: boolean }) => [p.charge, p.refundable]), [["…00000001", true]]);
    assert.ok(!JSON.stringify(card).includes("charge-old"), "charge_id целиком не отдаётся");
    assert.equal((await s.call("/api/admin/refund", { user_id: s.anya.id, charge: "…00000001" })).status, 400, "без причины — 400");
    assert.equal((await s.call("/api/admin/refund", { user_id: s.anya.id, charge: "…99999999", reason: "просил вернуть" })).status, 409, "не та оплата");
    assert.equal(s.tg.of("refund").length, 0, "ничего не вернули");
    const r = await s.call("/api/admin/refund", { user_id: s.anya.id, charge: "…00000001", reason: "просил вернуть" });
    assert.equal(r.status, 200);
    assert.deepEqual(s.tg.of("refund")[0].a, [11, "charge-old-00000001"]);
    const after = (await s.call(`/api/admin/account/${s.anya.id}`)).body;
    assert.ok(after.payments[0].refunded_at);
    assert.equal(after.plan, "expired", "доступ снят");
    assert.ok(after.log.some((x: { action: string; reason: string }) => x.action === "refund" && x.reason === "просил вернуть"), "в журнале карточки");
  } finally {
    await s.close();
  }
});

test("заморозка: входы закрыты, вход по паролю — 403, ИИ закрыт; владельца и себя — нельзя; разморозка возвращает всё", async () => {
  const s = await stand();
  try {
    const anyaToken = String((await s.login("anya", "anya-pass-1")).body.token);
    assert.equal((await s.callAs(anyaToken, "/api/me")).status, 200);
    const p = `/api/admin/account/${s.anya.id}`;
    assert.equal((await s.call(`${p}/freeze`, {})).status, 400, "без причины — 400");
    assert.equal((await s.call(`/api/admin/account/${s.owner.id}/freeze`, { reason: "проверка" })).status, 409, "владельца — нельзя");
    assert.equal((await s.call(`${p}/unfreeze`, { reason: "проверка" })).status, 409, "не заморожен");
    const r = await s.call(`${p}/freeze`, { reason: "спам в бота" });
    assert.equal(r.status, 200);
    assert.ok(r.body.card.frozen_at);
    assert.equal(r.body.card.plan, "frozen");
    assert.equal((await s.call(`${p}/freeze`, { reason: "ещё раз" })).status, 409, "уже заморожен");
    assert.equal((await s.callAs(anyaToken, "/api/me")).status, 401, "входы закрыты");
    const again = await s.login("anya", "anya-pass-1");
    assert.equal(again.status, 403);
    assert.equal(again.body.error, FROZEN_TEXT);
    assert.equal((await s.login("anya", "wrong-pass")).status, 401, "неверный пароль — как обычно");
    const u = (await s.store.user(s.anya.id))!;
    const gate = new AiGate(s.store, { owners: () => [OWNER] });
    const v = await gate.check(u, { take: { calls: 1 } });
    assert.equal(v.ok, false);
    assert.equal(!v.ok && v.text, FROZEN_TEXT);
    assert.equal(gate.allowed(u), false, "фоновые работы тоже не идут");
    assert.equal(u.plan, "trial", "срок и данные не тронуты");
    assert.equal(s.billing.payable(u)?.includes("приостановлен"), true, "оплатить нельзя");
    assert.match(s.tg.to("11").at(-1)!, /приостановлен/);
    const log = (await s.call("/api/admin/log")).body as unknown as { action: string; detail: string; reason: string }[];
    assert.deepEqual([log[0].action, log[0].detail, log[0].reason], ["freeze", `#${s.anya.id} входов закрыто: 1`, "спам в бота"]);
    // Разморозить.
    assert.equal((await s.call(`${p}/unfreeze`, { reason: "разобрались" })).status, 200);
    const back = await s.login("anya", "anya-pass-1");
    assert.equal(back.status, 200);
    assert.equal((await s.callAs(String(back.body.token), "/api/me")).status, 200);
    assert.equal((await gate.check((await s.store.user(s.anya.id))!, { rate: false })).ok, true);
    assert.match(s.tg.to("11").at(-1)!, /снова работает/);
  } finally {
    await s.close();
  }
});

test("заморозка: админа (ADMIN_CHAT_IDS) заморозить нельзя — и самого себя тоже", async () => {
  const s = await stand();
  try {
    // Админ — из ADMIN_CHAT_IDS (он же входит в ownerIds): его аккаунт защищён.
    config.adminChatIds.splice(0, Infinity, OWNER);
    assert.equal((await s.call(`/api/admin/account/${s.owner.id}/freeze`, { reason: "сам себя" })).status, 409);
    assert.equal((await s.store.user(s.owner.id))!.frozen_at ?? null, null);
  } finally {
    await s.close();
  }
});

test("заморозка: срок кончается молча — без письма; Billing.expire работает как обычно", async () => {
  const store = await Store.open(":memory:");
  const tg = fakeTelegram();
  const billing = new Billing(store, tg.api, { secret: SECRET, price: 150 });
  const u = await store.createUser({ login: "z", passwordHash: "x", tz: TZ, chatId: "33", plan: "trial", accessUntil: iso(Date.now() - 2 * 3600_000), trialLenDays: 7 });
  await store.updateUser(u.id, { frozen_at: new Date().toISOString() });
  await billing.expire();
  assert.equal((await store.user(u.id))!.plan, "free");
  assert.equal(tg.to("33").length, 0, "замороженному не пишем");
  await store.close();
});

test("бот: замороженному — один ответ на всё, разбора и записи нет; /paysupport работает; после разморозки — как обычно", async () => {
  config.telegramToken = "123456:test-token";
  config.allowedChatIds.splice(0, Infinity, OWNER);
  config.adminChatIds.splice(0, Infinity);
  const store = await Store.open(":memory:");
  let llmCalls = 0;
  const llm: LlmCall = async () => (llmCalls++, JSON.stringify({ reply: "Записала.", diary: [{ section: "notes", text: "x" }] }));
  const pipe = new Pipeline(store, llm);
  pipe.gate = new AiGate(store, { owners: () => [OWNER] });
  const { bot } = createBot(store, pipe, () => null);
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    const chat = { id: Number((payload as { chat_id?: number }).chat_id ?? 0), type: "private" };
    const result: unknown = method === "getMe" ? { id: 1, is_bot: true, first_name: "Maid", username: "maid_test_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false }
      : method.startsWith("send") ? { message_id: calls.length, date: 0, chat, text: "" } : true;
    return { ok: true, result } as never;
  });
  await bot.init();
  let n = 0;
  const text = (t: string) => bot.handleUpdate({
    update_id: ++n,
    message: { message_id: n, date: Math.floor(Date.now() / 1000), chat: { id: 55, type: "private", first_name: "А" }, from: { id: 55, is_bot: false, first_name: "А" }, text: t,
      ...(t.startsWith("/") ? { entities: [{ type: "bot_command", offset: 0, length: t.split(" ")[0].length }] } : {}) },
  } as never);
  const last = () => String(calls.filter((c) => c.method === "sendMessage" || c.method === "sendPhoto").at(-1)?.payload.text ?? calls.filter((c) => c.method === "sendPhoto").at(-1)?.payload.caption);
  try {
    const u = await store.createUser({ login: "z", passwordHash: "x", tz: TZ, chatId: "55", plan: "trial", accessUntil: iso(Date.now() + 5 * DAY), trialLenDays: 7 });
    await store.updateUser(u.id, { frozen_at: new Date().toISOString() });
    await text("купить молоко завтра");
    assert.equal(last(), FROZEN_TEXT);
    assert.equal(llmCalls, 0, "ИИ не звали");
    await text("/today");
    assert.equal(last(), FROZEN_TEXT, "и на команды — тот же ответ");
    await text("/token");
    assert.equal(last(), FROZEN_TEXT, "ключ для виджета не выдаётся");
    assert.equal((await store.sessionsOf(u.id)).length, 0);
    await text("/paysupport меня заморозили");
    assert.ok(calls.some((c) => String(c.payload.chat_id) === OWNER && /меня заморозили/.test(String(c.payload.text))), "вопрос дошёл владельцу");
    await store.updateUser(u.id, { frozen_at: null });
    await text("купить молоко завтра");
    assert.notEqual(last(), FROZEN_TEXT);
    assert.ok(llmCalls > 0, "после разморозки — разбор как обычно");
    await new Promise((r) => setTimeout(r, 1100)); // обновление списка-виджета идёт через секунду — дождаться до закрытия базы
  } finally {
    await store.close();
  }
});

test("заморозка: планировщик не пишет замороженному — ни напоминаний, ни утра, ни итога; после разморозки — снова пишет", async () => {
  const store = await Store.open(":memory:");
  const sent: { text: string; kind?: string }[] = [];
  const sch = new Scheduler(store, null, async (_u, text, _e, _b, kind) => void sent.push({ text, kind }));
  const u = await store.createUser({ login: "z", passwordHash: "x", tz: TZ, chatId: "7", plan: "trial", accessUntil: "2026-12-30T00:00:00Z", trialLenDays: 7 });
  await store.updateUser(u.id, { frozen_at: "2026-11-24T00:00:00Z" });
  await store.addReminder(u.id, "event", 1, zonedToUtc("2026-11-24", "21:59", TZ), "⏰ Через 1 ч: Врач");
  for (const t of ["09:01", "13:01", "22:00"]) await sch.tick(zonedToUtc("2026-11-24", t, TZ));
  assert.equal(sent.length, 0, "замороженному — ничего");
  await store.updateUser(u.id, { frozen_at: null });
  await sch.tick(zonedToUtc("2026-11-25", "09:01", TZ));
  assert.ok(sent.some((x) => x.kind === "morning"), "после разморозки утро пришло");
  await store.close();
});

// Исправления этапа 3 (24.11.2026, после проверки): заморозка и подписка Telegram, вид срока бывшего подписчика, продление
// замороженного, отменённое продление в карточке, номер больше int4.

const payFirst = (s: Awaited<ReturnType<typeof stand>>, charge: string, exp: number) =>
  s.billing.paid({ id: 11 }, { currency: "XTR", total_amount: 150, invoice_payload: signPayload(SECRET, s.anya.id), telegram_payment_charge_id: charge, subscription_expiration_date: exp, is_recurring: true, is_first_recurring: true });

test("заморозка отменяет продление подписки Telegram (звёзды не спишутся); разморозка подсказывает /resume_sub", async () => {
  const s = await stand();
  try {
    await payFirst(s, "charge-sub-00000001", Math.floor((Date.now() + 30 * DAY) / 1000));
    const r = await s.call(`/api/admin/account/${s.anya.id}/freeze`, { reason: "спам в бота" });
    assert.equal(r.status, 200);
    assert.deepEqual(s.tg.of("edit").map((x) => x.a), [[11, "charge-sub-00000001", true]], "продление выключено в Telegram");
    const u = (await s.store.user(s.anya.id))!;
    assert.deepEqual([u.plan, Number(u.sub_canceled)], ["paid", 1], "оплаченный срок остался, продление отменено");
    assert.ok((await s.store.billingEventsOf(s.anya.id)).some((e) => e.kind === "canceled"), "в журнале подписки — canceled");
    assert.match(r.body.text, /Продление подписки Telegram отменено/);
    assert.match(s.tg.to("11").at(-1)!, /Продление подписки отменено — звёзды больше не спишутся/);
    const log = (await s.call("/api/admin/log")).body as unknown as { action: string; detail: string }[];
    assert.deepEqual([log[0].action, log[0].detail], ["freeze", `#${s.anya.id} входов закрыто: 0, продление отменено`]);
    assert.equal((await s.call(`/api/admin/account/${s.anya.id}/unfreeze`, { reason: "разобрались" })).status, 200);
    assert.match(s.tg.to("11").at(-1)!, /\/resume_sub/);
  } finally {
    await s.close();
  }
  // Telegram не ответил — заморозка идёт, админ предупреждён, человеку — как отменить самому.
  const s2 = await stand();
  try {
    await payFirst(s2, "charge-sub-00000002", Math.floor((Date.now() + 30 * DAY) / 1000));
    s2.tg.api.editUserStarSubscription = async () => {
      throw new Error("Telegram down");
    };
    const r2 = await s2.call(`/api/admin/account/${s2.anya.id}/freeze`, { reason: "спам в бота" });
    assert.equal(r2.status, 200);
    assert.ok(r2.body.card.frozen_at);
    assert.match(r2.body.text, /отменить не вышло/);
    assert.match(s2.tg.to("11").at(-1)!, /Мои звёзды → Подписки/);
    assert.equal(Number((await s2.store.user(s2.anya.id))!.sub_canceled), 0);
  } finally {
    await s2.close();
  }
});

test("продлить или подарить после кончившейся подписки — подарок: в конце gift_ended и «подарок закончился», а не второе expired", async () => {
  const s = await stand();
  try {
    await s.store.updateUser(s.anya.id, { access_until: iso(Date.now() - 3 * DAY) }); // проба кончилась раньше — срок по оплате
    await payFirst(s, "charge-sub-00000003", Math.floor((Date.now() - 2 * DAY) / 1000));
    await s.billing.expire();
    let u = (await s.store.user(s.anya.id))!;
    assert.deepEqual([u.plan, u.sub_charge_id], ["free", "charge-sub-00000003"]);
    assert.equal((await s.store.billingEventsOf(s.anya.id)).filter((e) => e.kind === "expired").length, 1);
    for (const action of ["extend", "grant"]) {
      assert.equal((await s.call(`/api/admin/account/${s.anya.id}/${action}`, { days: 7, reason: "компенсация" })).status, 200, action);
      u = (await s.store.user(s.anya.id))!;
      assert.deepEqual([u.plan, Number(u.trial_len_days)], ["trial", 0], action);
      assert.equal((await s.call(`/api/admin/account/${s.anya.id}`)).body.kind, "gift", action);
      await s.billing.expire(new Date(Date.parse(u.access_until!) + 2 * 3600_000));
      const ev = (await s.store.billingEventsOf(s.anya.id)).map((e) => e.kind);
      assert.equal(ev.filter((k) => k === "expired").length, 1, `${action}: отток подписки посчитан один раз`);
      assert.equal(ev[0], "gift_ended", action);
      assert.match(s.tg.to("11").at(-1)!, /Подарочный доступ закончился/, action);
    }
  } finally {
    await s.close();
  }
});

test("замороженному продлить и подарить нельзя (409, письма нет): сначала разморозить", async () => {
  const s = await stand();
  try {
    assert.equal((await s.call(`/api/admin/account/${s.anya.id}/freeze`, { reason: "спам" })).status, 200);
    const before = (await s.store.user(s.anya.id))!;
    const sent = s.tg.to("11").length;
    for (const action of ["extend", "grant"]) {
      const r = await s.call(`/api/admin/account/${s.anya.id}/${action}`, { days: 30, reason: "компенсация" });
      assert.equal(r.status, 409, action);
      assert.match(String(r.body.error), /разморозьте/, action);
    }
    const after = (await s.store.user(s.anya.id))!;
    assert.deepEqual([after.plan, after.access_until], [before.plan, before.access_until], "срок не тронут");
    assert.equal(s.tg.to("11").length, sent, "письма «доступ продлён» нет");
  } finally {
    await s.close();
  }
});

test("подписка с отменённым продлением: в карточке не «списывается», письмо о продлении без обещания списаний", async () => {
  const s = await stand();
  try {
    await payFirst(s, "charge-sub-00000004", Math.floor((Date.now() + 30 * DAY) / 1000));
    assert.equal((await s.call(`/api/admin/account/${s.anya.id}`)).body.live_sub, true);
    assert.equal((await s.billing.cancel((await s.store.user(s.anya.id))!)).ok, true);
    const card = (await s.call(`/api/admin/account/${s.anya.id}`)).body;
    assert.deepEqual([card.plan, card.canceled, card.live_sub], ["paid", true, false]);
    assert.equal((await s.call(`/api/admin/account/${s.anya.id}/extend`, { days: 10, reason: "компенсация" })).status, 200);
    const letter = s.tg.to("11").at(-1)!;
    assert.doesNotMatch(letter, /по своему графику/);
    assert.match(letter, /доступ продлён до/);
    assert.equal((await s.call(`/api/admin/account/${s.anya.id}/grant`, { days: 10, reason: "подарок" })).status, 409, "срок подписки ещё идёт");
  } finally {
    await s.close();
  }
});

test("номер аккаунта больше int4 — 404 «нет аккаунта» (на Postgres это была бы ошибка базы); возврат — 400", async () => {
  const s = await stand();
  try {
    for (const id of ["99999999999", "2147483648"]) {
      assert.equal((await s.call(`/api/admin/account/${id}`)).status, 404, id);
      assert.equal((await s.call(`/api/admin/account/${id}/extend`, { days: 7, reason: "проверка" })).status, 404, id);
    }
    assert.equal((await s.call("/api/admin/account/2147483647")).status, 404, "в границе — обычное «нет аккаунта»");
    assert.equal((await s.call("/api/admin/refund", { user_id: 2_147_483_648, reason: "проверка" })).status, 400);
    assert.equal(s.tg.of("refund").length, 0);
  } finally {
    await s.close();
  }
});

test("бот: замороженный с подпиской может отменить продление (/cancel_sub); оплата во время заморозки — без «Спасибо, разберу»", async () => {
  config.telegramToken = "123456:test-token";
  config.allowedChatIds.splice(0, Infinity, OWNER);
  config.adminChatIds.splice(0, Infinity);
  const store = await Store.open(":memory:");
  const pipe = new Pipeline(store, async () => "{}");
  pipe.gate = new AiGate(store, { owners: () => [OWNER] });
  const { bot } = createBot(store, pipe, () => null);
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    const chat = { id: Number((payload as { chat_id?: number }).chat_id ?? 0), type: "private" };
    const result: unknown = method === "getMe" ? { id: 1, is_bot: true, first_name: "Maid", username: "maid_test_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false }
      : method.startsWith("send") ? { message_id: calls.length, date: 0, chat, text: "" } : true;
    return { ok: true, result } as never;
  });
  await bot.init();
  let n = 0;
  const from = { id: 55, is_bot: false, first_name: "А" };
  const msg = (extra: Record<string, unknown>) => bot.handleUpdate({
    update_id: ++n, message: { message_id: n, date: Math.floor(Date.now() / 1000), chat: { id: 55, type: "private", first_name: "А" }, from, ...extra },
  } as never);
  const text = (t: string) => msg({ text: t, ...(t.startsWith("/") ? { entities: [{ type: "bot_command", offset: 0, length: t.split(" ")[0].length }] } : {}) });
  const last = () => String(calls.filter((c) => c.method === "sendMessage").at(-1)?.payload.text);
  try {
    const u = await store.createUser({ login: "z", passwordHash: "x", tz: TZ, chatId: "55", plan: "paid", accessUntil: iso(Date.now() + 20 * DAY) });
    await store.updateUser(u.id, { sub_charge_id: "charge-zz", tg_user_id: "55", frozen_at: new Date().toISOString() });
    // Продление пришло во время заморозки: оплата записана, но ответ — что аккаунт приостановлен.
    await msg({ successful_payment: { currency: "XTR", total_amount: 150, invoice_payload: "", telegram_payment_charge_id: "charge-renew-zz", provider_payment_charge_id: "", is_recurring: true, subscription_expiration_date: Math.floor((Date.now() + 50 * DAY) / 1000) } });
    assert.doesNotMatch(last(), /Спасибо|разберу/);
    assert.match(last(), /приостановлен/);
    assert.ok(await store.payment("charge-renew-zz"), "оплата записана");
    await text("/today");
    assert.equal(last(), FROZEN_TEXT);
    await text("/resume_sub");
    assert.equal(last(), FROZEN_TEXT, "возобновить — только после разморозки");
    await text("/cancel_sub");
    assert.match(last(), /Продление отменено/);
    assert.ok(calls.some((c) => c.method === "editUserStarSubscription" && c.payload.is_canceled === true), "продление выключено в Telegram");
    assert.equal(Number((await store.user(u.id))!.sub_canceled), 1);
  } finally {
    await store.close();
  }
});
