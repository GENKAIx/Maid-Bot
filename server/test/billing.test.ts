import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApi } from "../src/api.ts";
import { hashPassword } from "../src/auth.ts";
import { Billing, readPayload, signPayload, SUB_PERIOD_SEC, TERMS_TEXT, type StarsApi } from "../src/billing.ts";
import { config } from "../src/config.ts";
import { Store } from "../src/db.ts";
import { Pipeline } from "../src/pipeline.ts";
import { WIDGET_UPDATES } from "../src/widget.ts";

// Подписка Telegram Stars (billing.ts). Telegram подменён заглушкой: каждый вызов пишется в журнал, сеть не нужна.

const TZ = "Europe/Moscow";
const SECRET = "test-billing-secret";
const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString();

function fakeTelegram() {
  const log: { m: string; a: unknown[] }[] = [];
  const api: StarsApi = {
    createInvoiceLink: async (...a) => (log.push({ m: "link", a }), `https://t.me/$inv${log.length}`),
    answerPreCheckoutQuery: async (...a) => (log.push({ m: "pre", a }), true),
    refundStarPayment: async (...a) => (log.push({ m: "refund", a }), true),
    editUserStarSubscription: async (...a) => (log.push({ m: "edit", a }), true),
    sendMessage: async (...a) => (log.push({ m: "send", a }), {}),
  };
  return { api, log, of: (m: string) => log.filter((x) => x.m === m) };
}

async function setup(now = Date.parse("2026-11-24T12:00:00Z")) {
  const store = await Store.open(":memory:");
  const tg = fakeTelegram();
  const clock = { t: now };
  const billing = new Billing(store, tg.api, { secret: SECRET, price: 150, owners: ["900"], clock: () => new Date(clock.t) });
  const u = await store.createUser({ login: "anya", passwordHash: "x", tz: TZ, chatId: "11", plan: "trial", accessUntil: iso(now + 2 * DAY) });
  return { store, tg, billing, u, clock };
}

test("payload: подпись сервера, не длиннее 128 байт; подделка и чужой секрет — null", () => {
  const p = signPayload(SECRET, 123456);
  assert.ok(Buffer.byteLength(p) <= 128);
  assert.match(p, /^s1:123456:/);
  assert.equal(readPayload(SECRET, p), 123456);
  assert.equal(readPayload("other", p), null);
  assert.equal(readPayload(SECRET, p.replace("s1:123456", "s1:123457")), null);
  assert.equal(readPayload(SECRET, "мусор"), null);
});

test("ссылка: createInvoiceLink — XTR, пустой provider_token, одна цена 150, период 2592000; на сутки из kv", async () => {
  const { store, tg, billing, u, clock } = await setup();
  const url = await billing.link(u);
  assert.equal(url, "https://t.me/$inv1");
  const [title, desc, payload, provider, currency, prices, other] = tg.of("link")[0].a as [string, string, string, string, string, unknown, unknown];
  assert.ok(title && desc);
  assert.equal(readPayload(SECRET, payload), u.id);
  assert.deepEqual([provider, currency, prices, other], ["", "XTR", [{ label: "Подписка на месяц", amount: 150 }], { subscription_period: SUB_PERIOD_SEC }]);
  assert.equal(SUB_PERIOD_SEC, 2592000);
  assert.equal(await billing.link(u), url);
  assert.equal(tg.of("link").length, 1);
  clock.t += DAY + 1;
  assert.notEqual(await billing.link(u), url, "через сутки — новая");
  await store.close();
});

test("pre_checkout: плохая подпись, цена, валюта, чужой Telegram — отказ; верный — да (ответ уходит в Telegram)", async () => {
  const { store, tg, billing, u } = await setup();
  const payload = signPayload(SECRET, u.id);
  const q = (over: object) => ({ id: "q", from: { id: 11 }, currency: "XTR", total_amount: 150, invoice_payload: payload, ...over });
  assert.equal((await billing.preCheckout(q({ invoice_payload: "s1:1:abc:zzzzzzzzzzzzzzzzzzzzzz" }))).ok, false);
  assert.equal((await billing.preCheckout(q({ total_amount: 1 }))).ok, false);
  assert.equal((await billing.preCheckout(q({ currency: "USD" }))).ok, false);
  await store.createUser({ login: "other", passwordHash: "x", tz: TZ, chatId: "22" });
  const bound = await billing.preCheckout(q({ from: { id: 22 } }));
  assert.equal(bound.ok, false);
  assert.match(bound.error!, /уже привязан/);
  assert.equal((await billing.preCheckout(q({}))).ok, true);
  assert.deepEqual(tg.of("pre").map((x) => x.a[1]), [false, false, false, false, true]);
  assert.ok((tg.of("pre")[0].a[2] as { error_message: string }).error_message);
  await store.close();
});

test("оплата: первая → paid до даты Telegram; повтор того же charge_id — ничего; продление сдвигает срок; друг остаётся другом", async () => {
  const { store, tg, billing, u, clock } = await setup();
  const exp = Math.floor((clock.t + 30 * DAY) / 1000);
  const pay = { currency: "XTR", total_amount: 150, invoice_payload: signPayload(SECRET, u.id), telegram_payment_charge_id: "ch1", subscription_expiration_date: exp, is_recurring: true as const, is_first_recurring: true as const };
  const first = await billing.paid({ id: 11 }, pay);
  assert.deepEqual([first?.kind, first?.duplicate, first?.until], ["first", false, iso(exp * 1000)]);
  let me = (await store.user(u.id))!;
  assert.deepEqual([me.plan, me.access_until, me.sub_charge_id, me.tg_user_id, Number(me.sub_canceled)], ["paid", iso(exp * 1000), "ch1", "11", 0]);
  assert.equal((await billing.paid({ id: 11 }, pay))?.duplicate, true);
  assert.equal((await store.paymentsOf(u.id)).length, 1);
  // Продление: новое charge_id, is_recurring без is_first_recurring.
  clock.t += 30 * DAY;
  const exp2 = exp + 30 * 86400;
  const renew = await billing.paid({ id: 11 }, { ...pay, telegram_payment_charge_id: "ch2", is_first_recurring: undefined, subscription_expiration_date: exp2 });
  assert.equal(renew?.kind, "renew");
  me = (await store.user(u.id))!;
  assert.deepEqual([me.access_until, me.sub_charge_id], [iso(exp2 * 1000), "ch1"], "charge_id подписки — от первой оплаты");
  assert.equal((await store.paymentsOf(u.id)).length, 2);
  // Владельцу об оплатах теперь пишет правило payment (alerts.ts) по журналу подписки — одним письмом и без логина.
  assert.ok(!tg.of("send").some((x) => x.a[0] === "900"), "Billing сам владельцу об оплате не пишет");
  assert.deepEqual((await store.billingEventsSince(["paid_first", "renewed"], "0000")).n, 2, "обе оплаты — в журнале для правила");
  // Друг оплатил — оплата записана, план прежний.
  const f = await store.createUser({ login: "fr", passwordHash: "x", tz: TZ, chatId: "33", plan: "friend" });
  await billing.paid({ id: 33 }, { ...pay, invoice_payload: signPayload(SECRET, f.id), telegram_payment_charge_id: "ch3" });
  assert.equal((await store.user(f.id))!.plan, "friend");
  await store.close();
});

test("оплата с сайта без Telegram: чат НЕ привязывается (ссылку мог оплатить кто угодно), только tg_user_id; незнакомая оплата — владельцу", async () => {
  const { store, tg, billing } = await setup();
  const site = await store.createUser({ login: "site", passwordHash: "x", tz: TZ });
  const got = await billing.paid({ id: 44 }, { currency: "XTR", total_amount: 150, invoice_payload: signPayload(SECRET, site.id), telegram_payment_charge_id: "s1", is_first_recurring: true, is_recurring: true });
  assert.deepEqual([got?.user.chat_id, got?.user.tg_user_id, got?.user.plan], [null, "44", "paid"]);
  assert.equal(await store.userByChat("44"), undefined, "плательщик не стал «своим» для бота");
  assert.equal(await billing.paid({ id: 55 }, { currency: "XTR", total_amount: 150, invoice_payload: "чужой", telegram_payment_charge_id: "s2" }), null);
  assert.ok(tg.of("send").some((x) => /без учётной записи/.test(String(x.a[1]))));
  await store.close();
});

test("возврат: refunded_payment снимает доступ (повтор — ничего); /refund владельца зовёт refundStarPayment и пишет в журнал", async () => {
  const { store, tg, billing, u, clock } = await setup();
  const pay = { currency: "XTR", total_amount: 150, invoice_payload: signPayload(SECRET, u.id), telegram_payment_charge_id: "r1", subscription_expiration_date: Math.floor((clock.t + 30 * DAY) / 1000), is_recurring: true as const, is_first_recurring: true as const };
  await billing.paid({ id: 11 }, pay);
  const r = await billing.refund(u.id, 900);
  assert.equal(r.ok, true);
  assert.deepEqual(tg.of("refund")[0].a, [11, "r1"]);
  const me = (await store.user(u.id))!;
  assert.equal(me.plan, "free");
  assert.ok(Date.parse(me.access_until!) <= clock.t);
  assert.ok((await store.payment("r1"))!.refunded_at);
  // Telegram следом присылает refunded_payment — уже учтено.
  assert.equal(await billing.refunded(pay), null);
  assert.deepEqual((await store.adminLog()).map((x) => [x.action, x.detail]), [["refund", `#${u.id} ⭐150`]]);
  assert.equal((await billing.refund(u.id, 900)).ok, false, "больше нечего возвращать");
  await store.close();
});

test("отмена продления: editUserStarSubscription(tg, charge, true), доступ до конца срока; без подписки — нечего отменять", async () => {
  const { store, tg, billing, u, clock } = await setup();
  assert.equal((await billing.cancel(u)).ok, false);
  const exp = Math.floor((clock.t + 30 * DAY) / 1000);
  await billing.paid({ id: 11 }, { currency: "XTR", total_amount: 150, invoice_payload: signPayload(SECRET, u.id), telegram_payment_charge_id: "c1", subscription_expiration_date: exp, is_recurring: true, is_first_recurring: true });
  const r = await billing.cancel((await store.user(u.id))!);
  assert.equal(r.ok, true);
  assert.deepEqual(tg.of("edit")[0].a, [11, "c1", true]);
  const me = (await store.user(u.id))!;
  assert.deepEqual([me.plan, Number(me.sub_canceled), me.access_until], ["paid", 1, iso(exp * 1000)]);
  await store.close();
});

test("сроки: кончившаяся проба → free и письмо с кнопкой оплаты (один раз); за 3 дня до конца отменённой подписки — напоминание", async () => {
  const { store, tg, billing, u, clock } = await setup();
  clock.t += 2 * DAY + 2 * 3600_000; // проба кончилась, запас в час прошёл
  await billing.expire();
  assert.equal((await store.user(u.id))!.plan, "free");
  const mail = tg.of("send").filter((x) => x.a[0] === "11");
  assert.equal(mail.length, 1);
  assert.match(String(mail[0].a[1]), /Пробная неделя закончилась/);
  assert.ok((mail[0].a[2] as { reply_markup: { inline_keyboard: { url: string }[][] } }).reply_markup.inline_keyboard[0][0].url.startsWith("https://t.me/$"));
  assert.ok((await store.noticesAll(u.id, 10)).some((n) => /Пробная неделя/.test(n.text)), "и в ленту уведомлений");
  await billing.expire();
  assert.equal(tg.of("send").filter((x) => x.a[0] === "11").length, 1, "второй раз не пишет");
  // Отменённая подписка, конец через 2 дня.
  const p = await store.createUser({ login: "paid", passwordHash: "x", tz: TZ, chatId: "66", plan: "paid", accessUntil: iso(clock.t + 2 * DAY) });
  await store.updateUser(p.id, { sub_canceled: 1, sub_charge_id: "x", tg_user_id: "66" });
  await billing.expire();
  await billing.expire();
  const remind = tg.of("send").filter((x) => x.a[0] === "66");
  assert.equal(remind.length, 1);
  assert.match(String(remind[0].a[1]), /продление отменено/);
  await store.close();
});

test("Telegram присылает pre_checkout_query (allowed_updates), условия — что продаётся, продление, отмена, возврат, /paysupport", () => {
  assert.ok((WIDGET_UPDATES as string[]).includes("pre_checkout_query"));
  const t = TERMS_TEXT(150, 7);
  for (const w of ["⭐150", "автоматически", "/cancel_sub", "3 дней", "/paysupport", "7 дней"]) assert.ok(t.includes(w), w);
});

test("админка: список оплат без payload и chat id, звёзды и подписчики в «Обзоре», возврат кнопкой — с записью в журнал", async () => {
  const OWNER = "1001";
  config.allowedChatIds.splice(0, Infinity, OWNER);
  config.adminChatIds.splice(0, Infinity);
  const store = await Store.open(":memory:");
  const tg = fakeTelegram();
  const billing = new Billing(store, tg.api, { secret: SECRET });
  await store.createUser({ login: "owner", passwordHash: await hashPassword("owner-pass-1"), tz: TZ, chatId: OWNER, name: "Хозяин" });
  const buyer = await store.createUser({ login: "buyer", passwordHash: "x", tz: TZ, chatId: "77", plan: "trial", accessUntil: iso(Date.now() + DAY) });
  await store.createUser({ login: "tri", passwordHash: "x", tz: TZ, chatId: "78", plan: "trial", accessUntil: iso(Date.now() + DAY) });
  await billing.paid({ id: 77 }, { currency: "XTR", total_amount: 150, invoice_payload: signPayload(SECRET, buyer.id), telegram_payment_charge_id: "charge-secret-12345678", subscription_expiration_date: Math.floor((Date.now() + 30 * DAY) / 1000), is_recurring: true, is_first_recurring: true });
  const codes: string[] = [];
  const server = createApi({ store, pipeline: new Pipeline(store, async () => "{}"), billing, adminCode: async (_u, text) => void codes.push(text.match(/\d{6}/)![0]) }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const token = (await (await fetch(base + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: "owner", password: "owner-pass-1" }) })).json()).token as string;
    const call = async (p: string, body?: unknown) => {
      const r = await fetch(base + p, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    assert.equal((await call("/api/admin/payments")).status, 403, "без кода — нет");
    await call("/api/admin/code", {});
    assert.equal((await call("/api/admin/confirm", { code: codes[0] })).status, 200);
    const list = await call("/api/admin/payments");
    const rows = list.body as unknown as Record<string, unknown>[];
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].name, rows[0].amount, rows[0].kind, rows[0].charge], ["buyer", 150, "first", "…12345678"]);
    const raw = JSON.stringify(rows);
    assert.ok(!raw.includes("charge-secret") && !raw.includes("s1:") && !raw.includes('"77"'), "ни payload, ни charge_id целиком, ни chat id");
    const ov = (await call("/api/admin/overview")).body.billing as Record<string, number>;
    assert.deepEqual([ov.stars_30, ov.subscribers, ov.trials], [150, 1, 1]);
    assert.equal((await call("/api/admin/refund", { user_id: buyer.id })).status, 400, "без причины — нет возврата");
    assert.equal(tg.of("refund").length, 0);
    const ref = await call("/api/admin/refund", { user_id: buyer.id, reason: "просил вернуть" });
    assert.equal(ref.status, 200);
    assert.deepEqual(tg.of("refund")[0].a, [77, "charge-secret-12345678"]);
    const log = (await call("/api/admin/log")).body as unknown as { action: string; detail: string }[];
    assert.ok(log.some((x) => x.action === "refund" && x.detail === `#${buyer.id} ⭐150` && (x as { reason?: string }).reason === "просил вернуть"));
    assert.equal(((await call("/api/admin/overview")).body.billing as Record<string, number>).stars_30, 0, "возвращённые — не доход");
    assert.equal((await call("/api/admin/refund", { user_id: buyer.id, reason: "ещё раз" })).status, 409);
  } finally {
    server.close();
    await store.close();
  }
});

// --- после ревью (24.11.2026): вторая подписка, отмена и возобновление, возврат, подарок ---

const firstPay = (userId: number, charge: string, expSec: number) => ({
  currency: "XTR", total_amount: 150, invoice_payload: signPayload(SECRET, userId), telegram_payment_charge_id: charge,
  subscription_expiration_date: expSec, is_recurring: true as const, is_first_recurring: true as const,
});

test("вторая подписка не продаётся: пока идёт (до конца больше суток) — ссылки нет, pre_checkout отказывает; за сутки до конца — можно; другу и владельцу — нельзя", async () => {
  const { store, billing, u, clock } = await setup();
  await billing.paid({ id: 11 }, firstPay(u.id, "c1", Math.floor((clock.t + 30 * DAY) / 1000)));
  const me = (await store.user(u.id))!;
  assert.equal(await billing.link(me), null, "ссылки нет — вторая подписка списала бы звёзды дважды");
  assert.match(billing.payable(me)!, /уже идёт/);
  const q = { id: "q", from: { id: 11 }, currency: "XTR", total_amount: 150, invoice_payload: signPayload(SECRET, u.id) };
  const again = await billing.preCheckout(q);
  assert.equal(again.ok, false, "оплата по старой ссылке тоже не проходит");
  assert.equal((await billing.preCheckout({ ...q, from: { id: 99 } })).ok, false, "и чужим Telegram — тоже");
  // Отменённая — не «оформить снова», а возобновить.
  await store.updateUser(u.id, { sub_canceled: 1 });
  assert.match(billing.payable((await store.user(u.id))!)!, /\/resume_sub/);
  // Сутки до конца — оплату принимаем (автопродление, если оно идёт через pre_checkout, не отклоняем).
  clock.t += 29.5 * DAY;
  assert.equal(billing.payable((await store.user(u.id))!), null);
  assert.equal((await billing.preCheckout(q)).ok, true);
  const f = await store.createUser({ login: "fr", passwordHash: "x", tz: TZ, chatId: "33", plan: "friend" });
  assert.equal(await billing.link(f), null);
  assert.equal((await billing.preCheckout({ ...q, from: { id: 33 }, invoice_payload: signPayload(SECRET, f.id) })).ok, false, "другу платить не нужно");
  await store.close();
});

test("продление после /cancel_sub (возобновили в Telegram) снимает «отменено»; /resume_sub — editUserStarSubscription(…, false)", async () => {
  const { store, tg, billing, u, clock } = await setup();
  const exp = Math.floor((clock.t + 30 * DAY) / 1000);
  await billing.paid({ id: 11 }, firstPay(u.id, "c1", exp));
  await billing.cancel((await store.user(u.id))!);
  assert.equal(Number((await store.user(u.id))!.sub_canceled), 1);
  const back = await billing.resume((await store.user(u.id))!);
  assert.equal(back.ok, true);
  assert.deepEqual(tg.of("edit").at(-1)!.a, [11, "c1", false]);
  assert.equal(Number((await store.user(u.id))!.sub_canceled), 0);
  // Снова отменили, а потом возобновили в самом Telegram — пришло продление.
  await billing.cancel((await store.user(u.id))!);
  clock.t += 30 * DAY;
  await billing.paid({ id: 11 }, { ...firstPay(u.id, "c2", exp + 30 * 86400), is_first_recurring: undefined });
  const me = (await store.user(u.id))!;
  assert.deepEqual([Number(me.sub_canceled), me.sub_charge_id], [0, "c1"]);
  assert.equal((await billing.resume(me)).text.startsWith("Подписка и так продлевается"), true);
  await store.close();
});

test("напоминание за 3 дня до конца отменённой подписки — без кнопки оплаты, с /resume_sub; кончившийся подарок — «Подарочный доступ закончился»", async () => {
  const { store, tg, billing, clock } = await setup();
  const p = await store.createUser({ login: "paid", passwordHash: "x", tz: TZ, chatId: "66", plan: "paid", accessUntil: iso(clock.t + 2 * DAY) });
  await store.updateUser(p.id, { sub_canceled: 1, sub_charge_id: "x", tg_user_id: "66" });
  const gift = await store.createUser({ login: "gift", passwordHash: "x", tz: TZ, chatId: "67", plan: "trial", accessUntil: iso(clock.t - 2 * 3600_000), at: new Date(clock.t - 31 * DAY) });
  await billing.expire();
  const remind = tg.of("send").find((x) => x.a[0] === "66")!;
  assert.match(String(remind.a[1]), /\/resume_sub/);
  assert.equal((remind.a[2] as { reply_markup?: unknown }).reply_markup, undefined, "кнопки «Оформить» нет");
  const end = tg.of("send").find((x) => x.a[0] === "67")!;
  assert.match(String(end.a[1]), /^Подарочный доступ закончился — я сохранила всё/);
  assert.equal((await store.user(gift.id))!.plan, "free");
  await store.close();
});

test("отмена: друг, который оплатил, тоже может отменить продление; возврат сперва отменяет продление, неудачный — в журнал", async () => {
  const { store, tg, billing, clock } = await setup();
  const f = await store.createUser({ login: "fr", passwordHash: "x", tz: TZ, chatId: "33", plan: "friend" });
  await billing.paid({ id: 33 }, firstPay(f.id, "fc", Math.floor((clock.t + 30 * DAY) / 1000)));
  const me = (await store.user(f.id))!;
  assert.equal(me.plan, "friend");
  assert.equal((await billing.cancel(me)).ok, true);
  assert.deepEqual(tg.of("edit")[0].a, [33, "fc", true]);
  // Возврат у подписки с продлением: сначала editUserStarSubscription(…, true), потом refundStarPayment.
  const u2 = await store.createUser({ login: "b", passwordHash: "x", tz: TZ, chatId: "44", plan: "trial", accessUntil: iso(clock.t + DAY) });
  await billing.paid({ id: 44 }, firstPay(u2.id, "bc", Math.floor((clock.t + 30 * DAY) / 1000)));
  const before = tg.log.length;
  assert.equal((await billing.refund(u2.id, 900)).ok, true);
  assert.deepEqual(tg.log.slice(before).map((x) => [x.m, ...x.a.slice(0, 3)]).filter((x) => x[0] !== "send"), [["edit", 44, "bc", true], ["refund", 44, "bc"]]);
  // Неудачный возврат — запись refund-fail.
  const u3 = await store.createUser({ login: "c", passwordHash: "x", tz: TZ, chatId: "45", plan: "trial", accessUntil: iso(clock.t + DAY) });
  await billing.paid({ id: 45 }, firstPay(u3.id, "cc", Math.floor((clock.t + 30 * DAY) / 1000)));
  tg.api.refundStarPayment = async () => { throw new Error("CHARGE_ALREADY_REFUNDED"); };
  assert.equal((await billing.refund(u3.id, 900)).ok, false);
  assert.ok((await store.adminLog()).some((x) => x.action === "refund-fail" && x.detail === `#${u3.id} ⭐150`));
  await store.close();
});

test("подарок по /invite у платящего не пропадает при продлении: срок — не короче нынешнего", async () => {
  const { store, billing, u, clock } = await setup();
  const exp = Math.floor((clock.t + 30 * DAY) / 1000);
  await billing.paid({ id: 11 }, firstPay(u.id, "c1", exp));
  const gift = iso(exp * 1000 + 30 * DAY);
  await store.updateUser(u.id, { access_until: gift }); // redeemInvite: +30 дней от конца срока
  clock.t += 30 * DAY;
  await billing.paid({ id: 11 }, { ...firstPay(u.id, "c2", exp + 30 * 86400), is_first_recurring: undefined });
  assert.equal((await store.user(u.id))!.access_until, gift);
  await store.close();
});
