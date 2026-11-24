import { PGlite } from "@electric-sql/pglite";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { AiGate } from "../src/access.ts";
import { createApi } from "../src/api.ts";
import { hashPassword } from "../src/auth.ts";
import { Billing, signPayload, type StarsApi } from "../src/billing.ts";
import { BILLING_KINDS, Store } from "../src/db.ts";
import { PgDriver } from "../src/driver.ts";
import { acceptUsage, countPersona, flushFeatures, resetFeatureEvents, USAGE_MAX_KEYS } from "../src/feature-events.ts";
import { CLIENT_FEATURES, FEATURE_GROUPS, FEATURES, REACT_MOODS, REACT_NAMES, TOUR_STEP_NAMES } from "../src/feature-list.ts";
import { createInvite, redeemInvite, signUp } from "../src/invite.ts";
import { Pipeline } from "../src/pipeline.ts";
import { ALBUM } from "../src/album.ts";

// Этап 0 аналитики (24.11.2026, docs/review/аналитика-макет-2026-11-24.html, «начать записывать»): журнал подписки (шаг 28,
// billing_events), отказы ИИ по причинам (gate.*), выбор характера (onboarding.persona), новые имена белого списка для программы
// на ПК (экскурсия, реакции, праздники), присутствие — 400 дней.

const BACKENDS: Record<string, () => Promise<Store>> = {
  sqlite: () => Store.open(":memory:"),
  postgres: async () => {
    const pg = new PGlite();
    return Store.over(new PgDriver(pg, (fn) => pg.transaction((tx) => fn(tx)), () => pg.close()));
  },
};
const TZ = "Europe/Moscow";
const DAY = 86_400_000;
const SECRET = "test-billing-secret";
const iso = (t: number) => new Date(t).toISOString();
const ALL = ["2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z"] as const;
const journal = async (store: Store, userId?: number) =>
  (await store.billingEvents(...ALL)).filter((e) => userId === undefined || e.user_id === userId);
const features = async (store: Store) =>
  ((await (store as any).all("SELECT user_id, client, feature, count FROM feature_events ORDER BY feature, client")) as Record<string, unknown>[])
    .map((r) => [Number(r.user_id), String(r.client), String(r.feature), Number(r.count)]);

function fakeTelegram(): StarsApi {
  return {
    createInvoiceLink: async () => "https://t.me/$inv",
    answerPreCheckoutQuery: async () => true,
    refundStarPayment: async () => true,
    editUserStarSubscription: async () => true,
    sendMessage: async () => ({}),
  };
}

for (const [kind, open] of Object.entries(BACKENDS)) {
  test(`${kind}: шаг 28 — таблица журнала подписки; запись, выборка за [from, to), незнакомый вид — ошибка`, async () => {
    const store = await open();
    try {
      await store.driver.exec("DROP TABLE billing_events; ALTER TABLE users DROP COLUMN trial_len_days; ALTER TABLE users DROP COLUMN frozen_at; ALTER TABLE admin_log DROP COLUMN reason;");
      await store.kvSet("schema_version", "27");
      const again = await Store.over(store.driver);
      assert.equal(await again.kvGet("schema_version"), "35");
      const t = Date.parse("2026-11-24T12:00:00Z");
      await again.addBillingEvent({ user_id: 5, kind: "trial_started", at: new Date(t) });
      await again.addBillingEvent({ user_id: 5, kind: "paid_first", at: new Date(t + DAY), charge_id: "ch1", amount: 150 });
      await again.addBillingEvent({ user_id: 6, kind: "canceled", at: new Date(t + 2 * DAY) });
      const got = await again.billingEvents(iso(t), iso(t + 2 * DAY));
      assert.deepEqual(got.map((e) => [e.user_id, e.kind, e.charge_id, e.amount, e.at]), [
        [5, "trial_started", null, null, iso(t)],
        [5, "paid_first", "ch1", 150, iso(t + DAY)],
      ], "конец интервала не входит");
      assert.ok(got.every((e) => typeof e.id === "number" && e.id > 0));
      await assert.rejects(again.addBillingEvent({ user_id: 5, kind: "bonus" as never }), /bad billing kind/);
      // Ничего личного: только номер человека, время, вид, charge_id и звёзды.
      const cols = Object.keys(((await (again as any).all("SELECT * FROM billing_events")) as Record<string, unknown>[])[0]).sort();
      assert.deepEqual(cols, ["amount", "at", "charge_id", "id", "kind", "user_id"]);
    } finally {
      await store.close();
    }
  });

  test(`${kind}: присутствие хранится 400 дней (было 90), журнал вызовов модели — 30`, async () => {
    const store = await open();
    try {
      const u = await store.ensureUser("1", "Тест", TZ);
      const now = new Date("2026-11-24T12:00:00Z");
      for (const d of ["2025-10-19", "2025-10-21", "2026-08-01"]) await store.bumpPresence(u.id, d, 10, "web");
      await store.addLlmCall(new Date(now.getTime() - 31 * DAY), { kind: "parse", model: "m", ms: 5, cost: 0.001 });
      await store.pruneStats(now);
      const days = ((await (store as any).all("SELECT day_key FROM presence ORDER BY day_key")) as { day_key: string }[]).map((r) => r.day_key);
      assert.deepEqual(days, ["2025-10-21", "2026-08-01"]);
      assert.equal(((await (store as any).all("SELECT id FROM llm_calls")) as unknown[]).length, 0);
    } finally {
      await store.close();
    }
  });
}

test("журнал подписки: первая оплата, повтор того же charge_id (ничего), продление, отмена, возобновление, возврат, конец срока", async () => {
  const store = await Store.open(":memory:");
  const clock = { t: Date.parse("2026-11-24T12:00:00Z") };
  const billing = new Billing(store, fakeTelegram(), { secret: SECRET, price: 150, owners: [], clock: () => new Date(clock.t) });
  const u = await store.createUser({ login: "anya", passwordHash: "x", tz: TZ, chatId: "11", plan: "trial", accessUntil: iso(clock.t + 2 * DAY) });
  const exp = Math.floor((clock.t + 30 * DAY) / 1000);
  const pay = { currency: "XTR", total_amount: 150, invoice_payload: signPayload(SECRET, u.id), telegram_payment_charge_id: "ch1", subscription_expiration_date: exp, is_recurring: true as const, is_first_recurring: true as const };
  const t0 = clock.t;
  await billing.paid({ id: 11 }, pay);
  await billing.paid({ id: 11 }, pay); // повтор обновления Telegram
  assert.deepEqual((await journal(store, u.id)).map((e) => [e.kind, e.charge_id, e.amount, e.at]), [["paid_first", "ch1", 150, iso(t0)]], "оплата → строка, повтор — нет");
  clock.t += DAY;
  assert.equal((await billing.cancel((await store.user(u.id))!)).ok, true);
  assert.equal((await billing.cancel((await store.user(u.id))!)).ok, true, "уже отменено — без второй строки");
  clock.t += DAY;
  assert.equal((await billing.resume((await store.user(u.id))!)).ok, true);
  clock.t += 28 * DAY;
  await billing.paid({ id: 11 }, { ...pay, telegram_payment_charge_id: "ch2", is_first_recurring: undefined, subscription_expiration_date: exp + 30 * 86400 });
  clock.t += DAY;
  assert.equal((await billing.refund(u.id, 900)).ok, true);
  assert.deepEqual((await journal(store, u.id)).map((e) => [e.kind, e.charge_id, e.amount]), [
    ["paid_first", "ch1", 150], ["canceled", null, null], ["resumed", null, null], ["renewed", "ch2", 150], ["refunded", "ch2", 150],
  ]);
  // Telegram следом присылает refunded_payment — уже учтено, второй строки нет.
  await billing.refunded({ currency: "XTR", total_amount: 150, invoice_payload: pay.invoice_payload, telegram_payment_charge_id: "ch2" });
  assert.equal((await journal(store, u.id)).filter((e) => e.kind === "refunded").length, 1);
  // Конец срока — со временем планировщика и по тому, что кончилось: проба — trial_ended, подарок — gift_ended, подписка — expired.
  const late = await store.createUser({ login: "late", passwordHash: "x", tz: TZ, chatId: "12", plan: "trial", accessUntil: iso(clock.t - 2 * DAY), at: new Date(clock.t - 9 * DAY) });
  const gift = await store.createUser({ login: "gift", passwordHash: "x", tz: TZ, chatId: "13", plan: "trial", accessUntil: iso(clock.t - 2 * DAY), at: new Date(clock.t - 32 * DAY) });
  const sub = await store.createUser({ login: "sub", passwordHash: "x", tz: TZ, chatId: "14", plan: "paid", accessUntil: iso(clock.t - 2 * DAY), at: new Date(clock.t - 60 * DAY) });
  await billing.expire();
  await billing.expire();
  assert.deepEqual((await journal(store, late.id)).map((e) => [e.kind, e.at]), [["trial_ended", iso(clock.t)]], "один раз");
  assert.deepEqual((await journal(store, gift.id)).map((e) => e.kind), ["gift_ended"], "подарок — не «истекла подписка»");
  assert.deepEqual((await journal(store, sub.id)).map((e) => e.kind), ["expired"], "expired — только конец подписки");
  for (const e of await journal(store)) assert.ok((BILLING_KINDS as readonly string[]).includes(e.kind));
  await store.close();
});

test("журнал подписки: проба при регистрации — trial_started, приглашение — gift (новому и продление срока), сбой журнала не роняет оплату", async () => {
  const store = await Store.open(":memory:");
  const now = new Date("2026-11-24T12:00:00Z");
  const a = await signUp(store, { id: "21", name: "Аня" }, TZ, now, { open: true, perHour: 5, perDay: 5, trialDays: 7 });
  assert.ok(a && typeof a === "object");
  const gifted = await redeemInvite(store, await createInvite(store, now), { id: "22", name: "Вася" }, TZ, now, 30);
  const again = await redeemInvite(store, await createInvite(store, now), { id: "21", name: "Аня" }, TZ, now, 30);
  assert.ok(gifted && again);
  assert.deepEqual((await journal(store)).map((e) => [e.user_id, e.kind, e.at]), [
    [a.user.id, "trial_started", now.toISOString()], [gifted.user.id, "gift", now.toISOString()], [a.user.id, "gift", now.toISOString()],
  ]);
  // Журнал сломался (нет таблицы) — оплата всё равно проходит.
  await store.driver.exec("DROP TABLE billing_events;");
  const billing = new Billing(store, fakeTelegram(), { secret: SECRET, price: 150, owners: [], clock: () => now });
  const got = await billing.paid({ id: 21 }, { currency: "XTR", total_amount: 150, invoice_payload: signPayload(SECRET, a.user.id), telegram_payment_charge_id: "x1", is_recurring: true, is_first_recurring: true });
  assert.equal(got?.user.plan, "paid");
  await store.close();
});

test("отказы ИИ: gate.no_access, gate.burst, gate.day_cap, gate.trial_pool — с клиентом запроса; без клиента (фон) — не в счёт", async () => {
  resetFeatureEvents();
  const store = await Store.open(":memory:");
  try {
    let t = Date.parse("2026-11-24T12:00:00Z");
    const gate = new AiGate(store, { owners: () => ["900"], clock: () => new Date(t), burst: 2, windowMs: 60_000, trialDayUsd: 0.3, paidDayUsd: 5, trialPoolDayUsd: 1 });
    const late = await store.createUser({ login: "late", passwordHash: "x", tz: TZ, chatId: "1", plan: "trial", accessUntil: iso(t - 2 * DAY) });
    assert.equal((await gate.check(late, { client: "web" })).ok, false);
    assert.equal((await gate.check(late)).ok, false, "фон — не в счёт");
    const fast = await store.createUser({ login: "fast", passwordHash: "x", tz: TZ, chatId: "2", plan: "trial", accessUntil: iso(t + 5 * DAY) });
    for (let i = 0; i < 2; i++) assert.equal((await gate.check(fast, { client: "telegram" })).ok, true);
    const third = await gate.check(fast, { client: "telegram" });
    assert.equal(third.ok ? "" : third.why, "rate");
    // Свой потолок: человек на пробе потратил больше 0,3 $ за день.
    t += 120_000;
    await store.addUsage(new Date(t), { kind: "parse", model: "m", input: 1, output: 1, cost: 0.31, userId: fast.id });
    const cap = await gate.check(fast, { client: "desktop" });
    assert.equal(cap.ok ? "" : cap.why, "money");
    // Общий потолок проб: другой на пробе почти ничего не тратил, но все пробы вместе — больше 1 $.
    const other = await store.createUser({ login: "other", passwordHash: "x", tz: TZ, chatId: "3", plan: "trial", accessUntil: iso(t + 5 * DAY) });
    await store.addUsage(new Date(t), { kind: "parse", model: "m", input: 1, output: 1, cost: 0.8, userId: late.id });
    await store.updateUser(late.id, { plan: "trial", access_until: iso(t + DAY) }); // её расход считается в общий потолок проб
    const pool = await gate.check(other, { client: "web" });
    assert.equal(pool.ok ? "" : pool.why, "money");
    await flushFeatures(store, t, true);
    assert.deepEqual(await features(store), [
      [fast.id, "desktop", "gate.day_cap", 1],
      [late.id, "web", "gate.no_access", 1],
      [fast.id, "telegram", "gate.burst", 1],
      [other.id, "web", "gate.trial_pool", 1],
    ].sort((x, y) => String(x[2]).localeCompare(String(y[2])) || String(x[1]).localeCompare(String(y[1]))));
  } finally {
    resetFeatureEvents();
    await store.close();
  }
});

test("отказы ИИ в конвейере: сообщение с клиентом — gate.no_access этого клиента; фоновый повтор — нет", async () => {
  resetFeatureEvents();
  const store = await Store.open(":memory:");
  try {
    const pipe = new Pipeline(store, async () => "{}");
    pipe.gate = new AiGate(store, { owners: () => ["900"] });
    const u = await store.createUser({ login: "late", passwordHash: "x", tz: TZ, chatId: "7", plan: "trial", accessUntil: iso(Date.now() - 2 * DAY) });
    const r = await pipe.handle({ user: u, source: "desktop", sourceId: "1", text: "купить молоко", client: "widget" });
    assert.equal(r.blocked, "access");
    await pipe.handle({ user: u, source: "desktop", sourceId: "2", text: "ещё", background: true, client: "widget" });
    await flushFeatures(store, Date.now(), true);
    assert.deepEqual((await features(store)).filter((r) => String(r[2]).startsWith("gate.")), [[u.id, "desktop", "gate.no_access", 1]]);
  } finally {
    resetFeatureEvents();
    await store.close();
  }
});

test("белый список: доступ, первый запуск и Рина — группы, кто считает, шаги экскурсии и все анимации альбома кроме «Ждёт»", () => {
  const byId = new Map(FEATURES.map((f) => [f.id, f]));
  assert.deepEqual([FEATURE_GROUPS.access, FEATURE_GROUPS.onboarding, FEATURE_GROUPS.rina], ["Доступ", "Первый запуск", "Рина"]);
  for (const id of ["gate.no_access", "gate.burst", "gate.day_cap", "gate.trial_pool"]) {
    assert.deepEqual([byId.get(id)?.group, byId.get(id)?.by], ["access", "server"], id);
    assert.ok(!CLIENT_FEATURES.has(id), `${id}: клиент не может прислать сам`);
  }
  for (const id of ["onboarding.persona", "onboarding.persona.first"]) assert.deepEqual([byId.get(id)?.group, byId.get(id)?.by], ["onboarding", "server"], id);
  const tour = ["onboarding.tour.start", ...TOUR_STEP_NAMES.map(([id]) => `onboarding.tour.step.${id}`), "onboarding.tour.done", "onboarding.tour.skip"];
  assert.equal(TOUR_STEP_NAMES.length, 11);
  for (const id of tour) assert.deepEqual([byId.get(id)?.group, byId.get(id)?.by], ["onboarding", "client"], id);
  assert.deepEqual([...REACT_MOODS], ALBUM.filter((m) => m !== "idle"));
  assert.deepEqual(Object.keys(REACT_NAMES).sort(), [...ALBUM].sort(), "у каждой анимации альбома — название");
  assert.ok(!byId.has("maid.react.idle"), "«Ждёт» — основа, не реакция");
  const rina = [...REACT_MOODS.map((m) => `maid.react.${m}`), "maid.sulk", "maid.party.flame", "maid.party.wave", "maid.party.salute", "maid.party.course", "maid.party.level"];
  for (const id of rina) assert.deepEqual([byId.get(id)?.group, byId.get(id)?.by], ["rina", "client"], id);
  assert.equal(byId.get("maid.react.thumbsup")?.title, "Реакция «Палец вверх»");
  // Всё, что программа на ПК может прислать, влезает в одну пачку (иначе 400 и вся пачка выброшена).
  const desktop = FEATURES.filter((f) => f.by === "client" && ["widget", "onboarding", "rina"].includes(f.group));
  assert.ok(desktop.length <= USAGE_MAX_KEYS, `${desktop.length} имён программы > ${USAGE_MAX_KEYS}`);
  // Пачка программы принимает новые имена и отбрасывает серверные.
  resetFeatureEvents();
  const r = acceptUsage({ id: 1, tz: TZ }, "widget", { "maid.react.happy": 3, "onboarding.tour.step.hello": 1, "maid.party.wave": 1, "gate.burst": 5, "onboarding.persona": 1, "maid.react.idle": 1 });
  assert.deepEqual(r, { ok: true, accepted: 3, dropped: 3 });
  resetFeatureEvents();
});

test("выбор характера: onboarding.persona — каждый выбор, .first — только первый у человека; сайт — только если характер другой", async () => {
  resetFeatureEvents();
  const store = await Store.open(":memory:");
  const u = await store.createUser({ login: "owner", passwordHash: await hashPassword("owner-pass-1"), tz: TZ });
  const server = createApi({ store, pipeline: new Pipeline(store, async () => "{}") }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await countPersona(store, u, "telegram");
    await countPersona(store, u, "telegram");
    const token = (await (await fetch(base + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: "owner", password: "owner-pass-1" }) })).json()).token as string;
    const set = (body: unknown) => fetch(base + "/api/settings", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-maid-client": "web" }, body: JSON.stringify(body),
    });
    assert.equal((await set({ persona: "strict" })).status, 200, "тот же характер (по умолчанию strict)");
    assert.equal((await set({ persona: "kind" })).status, 200);
    assert.equal((await set({ name: "Аня" })).status, 200, "без характера");
    await flushFeatures(store, Date.now(), true);
    assert.deepEqual((await features(store)).filter((r) => String(r[2]).startsWith("onboarding.")), [
      [u.id, "telegram", "onboarding.persona", 2],
      [u.id, "web", "onboarding.persona", 1],
      [u.id, "telegram", "onboarding.persona.first", 1],
    ]);
  } finally {
    server.close();
    resetFeatureEvents();
    await store.close();
  }
});
