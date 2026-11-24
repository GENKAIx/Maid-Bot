import { PGlite } from "@electric-sql/pglite";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { AiGate, endedOf, trialLenOf } from "../src/access.ts";
import { createApi } from "../src/api.ts";
import { hashPassword } from "../src/auth.ts";
import { Billing, signPayload, type StarsApi } from "../src/billing.ts";
import { config } from "../src/config.ts";
import { Store } from "../src/db.ts";
import { PgDriver } from "../src/driver.ts";
import { createInvite, redeemInvite, signUp } from "../src/invite.ts";
import { Pipeline } from "../src/pipeline.ts";
import {
  applyTariffs, checkTariffPatch, checkTariffValue, loadTariffs, overrideTariffs, refreshTariffs, setSignupsOpen, signupsEnvClosed, signupsOpenNow,
  TARIFF_RELOAD_MS, TARIFF_SPEC, tariffDefaults, tariffs, tariffsView, undoTariff,
} from "../src/tariffs.ts";
import * as web from "../../web/src/tariffs.ts";

// Тарифы из базы (24.11.2026, этап 1, server/src/tariffs.ts): миграция 30 на SQLite и Postgres, значения по умолчанию — прежние
// config.billing, перечитывание раз в минуту, «Применить» меняет поведение AiGate, цены счёта и регистрации; 400 на негодные числа;
// откат; журнал; не админ — 404, без кода — 403; проверка на сайте (web/src/tariffs.ts) совпадает с серверной.

const BACKENDS: Record<string, () => Promise<Store>> = {
  sqlite: () => Store.open(":memory:"),
  postgres: async () => {
    const pg = new PGlite();
    return Store.over(new PgDriver(pg, (fn) => pg.transaction((tx) => fn(tx)), () => pg.close()));
  },
};
const TZ = "Europe/Moscow";
const DAY = 86_400_000;

for (const [kind, open] of Object.entries(BACKENDS)) {
  test(`${kind}: шаг 30 — таблицы тарифов; выключатель /signups off из kv переезжает в tariff_settings, ключ kv удаляется`, async () => {
    const store = await open();
    try {
      await store.driver.exec("DROP TABLE tariff_settings; DROP TABLE tariff_history; ALTER TABLE users DROP COLUMN trial_len_days;");
      await store.kvSet("schema_version", "29");
      await store.kvSet("signups:closed", "1");
      const again = await Store.over(store.driver);
      assert.equal(await again.kvGet("schema_version"), "31");
      assert.equal(await again.kvGet("signups:closed"), undefined, "старое место удалено");
      assert.deepEqual((await again.tariffSettings()).map((r) => [r.key, r.value]), [["signupsOpen", "false"]]);
      assert.equal((await loadTariffs(again)).signupsOpen, false);
      // Пустая база — только значения по умолчанию.
      const clean = await open();
      assert.deepEqual(await clean.tariffSettings(), []);
      assert.deepEqual(await loadTariffs(clean), tariffDefaults());
      // Запись, история, экономика по llm_usage — на этой базе.
      const id = await clean.saveTariffs([{ key: "price", value: "200" }], { at: "2026-11-24T12:00:00.000Z", user_id: 5, source: "admin", before_json: "{}", after_json: "{}", reason: "проверка" });
      assert.deepEqual((await clean.tariffSettings()).map((r) => [r.key, r.value]), [["price", "200"]]);
      await clean.saveTariffs([{ key: "price", value: "300" }], { at: "2026-11-24T12:00:30.000Z", user_id: 6, source: "admin", before_json: "{}", after_json: "{}", reason: "ещё" });
      assert.deepEqual((await clean.tariffSettings()).map((r) => [r.key, r.value]), [["price", "300"]], "повтор того же поля — обновление строки");
      assert.equal((await clean.tariffHistoryRow(id))?.reason, "проверка");
      await clean.saveTariffs([{ key: "price", value: null }], { at: "2026-11-24T12:01:00.000Z", user_id: 5, source: "undo", before_json: "{}", after_json: "{}", reason: "назад" });
      assert.deepEqual(await clean.tariffSettings(), []);
      assert.deepEqual((await clean.tariffHistory()).map((h) => h.source), ["undo", "admin", "admin"]);
      const p = await clean.createUser({ login: "pp", passwordHash: "x", tz: TZ, plan: "paid", accessUntil: new Date(Date.now() + DAY).toISOString() });
      const f = await clean.createUser({ login: "ff", passwordHash: "x", tz: TZ, plan: "friend" });
      await clean.addUsage(new Date("2026-11-24T10:00:00Z"), { kind: "chat", model: "m", input: 1, output: 1, cost: 0.5, userId: p.id });
      await clean.addUsage(new Date("2026-11-24T10:00:00Z"), { kind: "draw", model: "m", input: 1, output: 1, cost: null, userId: p.id });
      await clean.addUsage(new Date("2026-11-24T10:00:00Z"), { kind: "chat", model: "m", input: 1, output: 1, cost: 9, userId: f.id });
      const rows = await clean.planDaySpend("2026-11-01", ["trial", "paid"], { draw: 0.03, voice: 0, other: 0 });
      assert.deepEqual(rows, [{ user_id: p.id, plan: "paid", day: "2026-11-24", micro: 530_000 }], "друг не в счёт, рисунок без цены — по оценке");
      await clean.close();
    } finally {
      await store.close();
    }
  });
}

test("значения по умолчанию — ровно прежние config.billing; STAR_USD из .env — по умолчанию, SIGNUPS_OPEN=0 — поверх тарифа", () => {
  assert.deepEqual(tariffDefaults({}), {
    price: 150, trialDays: 7, giftDays: 30, signupsOpen: true, signupsPerHour: 30, signupsPerDay: 150, aiBurst: 10, aiWindowMs: 60_000,
    trialDayUsd: 0.3, paidDayUsd: 1.5, trialPoolDayUsd: 10, unpricedDrawUsd: 0.03, unpricedVoiceUsd: 0.005, unpricedOtherUsd: 0.003, starUsd: 0.013,
  });
  assert.equal(tariffDefaults({ SIGNUPS_OPEN: "0" }).signupsOpen, true, "смысл строки tariff_settings не зависит от .env");
  assert.equal(signupsEnvClosed({ SIGNUPS_OPEN: "0" }), true);
  assert.equal(signupsEnvClosed({ SIGNUPS_OPEN: " 1 " }), false);
  assert.equal(signupsEnvClosed({}), false);
  assert.equal(tariffDefaults({ STAR_USD: "0.02" }).starUsd, 0.02);
  assert.equal(tariffDefaults({ STAR_USD: "мусор" }).starUsd, 0.013);
  for (const k of Object.keys(TARIFF_SPEC)) assert.equal(checkTariffValue(k, tariffDefaults({})[k as keyof typeof TARIFF_SPEC]), null, `по умолчанию ${k} проходит проверку`);
});

test("перечитывание раз в минуту (подставные часы): чужая запись в базе видна не раньше чем через TARIFF_RELOAD_MS", async () => {
  const store = await Store.open(":memory:");
  let t = 1_000_000;
  await loadTariffs(store, t);
  assert.equal(tariffs().aiBurst, 10);
  // Другой процесс записал новое число прямо в базу.
  await store.saveTariffs([{ key: "aiBurst", value: "3" }], { at: new Date().toISOString(), user_id: 1, source: "admin", before_json: "{}", after_json: "{}", reason: "x" });
  t += 30_000;
  assert.equal(await refreshTariffs(store, t), false);
  assert.equal(tariffs().aiBurst, 10, "через полминуты — ещё старое");
  t += TARIFF_RELOAD_MS - 30_000;
  assert.equal(await refreshTariffs(store, t), true);
  assert.equal(tariffs().aiBurst, 3, "через минуту — новое");
  // Битая строка — пропускается, остальное читается.
  await store.saveTariffs([{ key: "price", value: "-5" }], { at: new Date().toISOString(), user_id: 1, source: "admin", before_json: "{}", after_json: "{}", reason: "x" });
  assert.equal((await loadTariffs(store)).price, 150);
  await store.close();
});

test("«Применить» меняет поведение сразу: частота AiGate, денежный потолок, цена счёта, регистрация; откат возвращает как было", async () => {
  const store = await Store.open(":memory:");
  await loadTariffs(store);
  const now = new Date();
  const trial = await store.createUser({ login: "tr", passwordHash: "x", tz: TZ, chatId: "50", plan: "trial", accessUntil: new Date(now.getTime() + 5 * DAY).toISOString() });
  const gate = new AiGate(store, { owners: () => [] });
  for (let i = 0; i < 3; i++) assert.equal((await gate.check(trial)).ok, true, `по умолчанию 10 за минуту — ${i + 1}-й проходит`);
  const r = await applyTariffs(store, 7, { aiBurst: 3, trialDayUsd: 0.01, price: 200, signupsOpen: false }, "наплыв из канала");
  assert.deepEqual(r.changes.map((c) => c.key).sort(), ["aiBurst", "price", "signupsOpen", "trialDayUsd"]);
  const v = await gate.check(trial);
  assert.equal(v.ok, false);
  assert.equal(!v.ok && v.why, "rate", "четвёртый за минуту — уже сверх нового окна");
  // Денежный потолок: новый человек, расход $0.02 за сегодня при потолке $0.01.
  const t2 = await store.createUser({ login: "tr2", passwordHash: "x", tz: TZ, chatId: "51", plan: "trial", accessUntil: new Date(now.getTime() + 5 * DAY).toISOString() });
  await store.addUsage(now, { kind: "chat", model: "m", input: 1, output: 1, cost: 0.02, userId: t2.id });
  const money = await gate.check(t2);
  assert.equal(!money.ok && money.why, "money");
  // Цена счёта: новая ссылка — по новой цене, отказ пишет новую цену.
  const amounts: number[] = [];
  const api = { createInvoiceLink: async (...a: unknown[]) => (amounts.push((a[5] as { amount: number }[])[0].amount), "https://t.me/$x"), answerPreCheckoutQuery: async () => true } as unknown as StarsApi;
  const billing = new Billing(store, api, { secret: "s" });
  const exp = await store.createUser({ login: "ex", passwordHash: "x", tz: TZ, chatId: "52", plan: "free", accessUntil: new Date(now.getTime() - DAY).toISOString() });
  await billing.link(exp);
  assert.deepEqual(amounts, [200]);
  assert.equal((await billing.preCheckout({ id: "q", from: { id: 52 }, currency: "XTR", total_amount: 200, invoice_payload: signPayload("s", exp.id) })).ok, true);
  assert.equal((await billing.preCheckout({ id: "q", from: { id: 52 }, currency: "XTR", total_amount: 150, invoice_payload: signPayload("s", exp.id) })).ok, false, "старый счёт на 150 — «цена изменилась»");
  // Регистрация закрыта.
  assert.equal(await signUp(store, { id: "60", name: "Н" }, TZ, now), "closed");
  // Откат — всё как было.
  const back = await undoTariff(store, 7, r.id, "ошиблись");
  assert.deepEqual(back.values, tariffDefaults());
  assert.deepEqual(await store.tariffSettings(), [], "равное значению по умолчанию — строки нет");
  assert.equal(typeof (await signUp(store, { id: "60", name: "Н" }, TZ, now)), "object", "регистрация снова открыта");
  // Цена вернулась — старая ссылка за 200 не годится, новая — за 150.
  await billing.link(exp);
  assert.deepEqual(amounts, [200, 150]);
  // Журнал админки и история.
  const log = await store.adminLog();
  assert.deepEqual(log.map((l) => l.action), ["tariff_undo", "tariff"]);
  assert.match(log[1].detail, /^#\d+ .*price 150→200/);
  const hist = await store.tariffHistory();
  assert.deepEqual(hist.map((h) => [h.source, h.user_id]), [["undo", 7], ["admin", 7]]);
  assert.match(hist[0].reason, /^откат #\d+: ошиблись$/);
  assert.equal(JSON.parse(hist[1].before_json).price, 150);
  assert.equal(JSON.parse(hist[1].after_json).price, 200);
  await store.close();
});

test("цена поменялась — бывший подписчик по старой ссылке (старая сумма) получает отказ; принимается только нынешняя цена", async () => {
  const store = await Store.open(":memory:");
  await loadTariffs(store);
  // Подписка за ⭐150 кончилась (expire перевёл в free), sub_charge_id остался; ссылка из письма об окончании — бессрочная.
  const u = await store.createUser({ login: "sub", passwordHash: "x", tz: TZ, chatId: "70", plan: "free", accessUntil: new Date(Date.now() - 5 * DAY).toISOString() });
  await store.addPayment({ charge_id: "c1", user_id: u.id, tg_user_id: "70", amount: 150, currency: "XTR", payload: "p", kind: "first", paid_at: new Date(Date.now() - 35 * DAY).toISOString(), expires_at: u.access_until });
  await store.updateUser(u.id, { sub_charge_id: "c1", tg_user_id: "70" });
  const billing = new Billing(store, { answerPreCheckoutQuery: async () => true } as unknown as StarsApi, { secret: "s" });
  const q = (amount: number) => billing.preCheckout({ id: "q", from: { id: 70 }, currency: "XTR", total_amount: amount, invoice_payload: signPayload("s", u.id) });
  for (const price of [300, 100]) {
    await applyTariffs(store, 1, { price }, `цена ${price}`);
    const old = await q(150);
    assert.equal(old.ok, false, `цена ${price}: старая сумма 150 — отказ`);
    assert.match(old.error ?? "", /Цена изменилась/);
    assert.equal((await q(price)).ok, true, `цена ${price}: нынешняя — проходит`);
  }
  await store.close();
});

test("проверка чисел: неизвестное поле, дробь в целом, меньше нуля, за границей, без причины, ничего не меняется — ошибка", async () => {
  const store = await Store.open(":memory:");
  await loadTariffs(store);
  const bad: [unknown, RegExp][] = [
    [{ nope: 1 }, /неизвестное поле/], [{ price: 1.5 }, /целое/], [{ price: 0 }, /не меньше 1/], [{ price: 10_001 }, /не больше 10000/],
    [{ trialDays: 366 }, /не больше 365/], [{ aiBurst: 1001 }, /не больше 1000/], [{ aiWindowMs: 3_601_000 }, /не больше/], [{ aiWindowMs: 1500 }, /целые секунды/],
    [{ paidDayUsd: -0.1 }, /не меньше 0/], [{ paidDayUsd: 100.5 }, /не больше 100/], [{ trialDayUsd: "1" }, /нужно число/], [{ signupsOpen: 1 }, /да или нет/],
    [{ trialDayUsd: 0.12345 }, /4 знаков/], [{}, /нечего менять/], [[1], /нужен объект/], [null, /нужен объект/],
    // Ноль у денежного потолка закрыл бы ИИ всем на плане («расход ≥ 0»), а не снял потолок.
    [{ paidDayUsd: 0 }, /paidDayUsd: не меньше 0.01/], [{ trialDayUsd: 0 }, /не меньше 0.01/], [{ trialPoolDayUsd: 0 }, /не меньше 0.01/],
    // Имена из прототипа Object — не поля тарифа.
    [{ price: 200, constructor: 5 }, /неизвестное поле constructor/], [{ price: 200, toString: 1 }, /неизвестное поле toString/],
    [{ hasOwnProperty: 1 }, /неизвестное поле/], [{ valueOf: 1 }, /неизвестное поле/], [JSON.parse('{"__proto__": 1, "price": 200}'), /неизвестное поле __proto__/],
  ];
  for (const [patch, re] of bad) {
    await assert.rejects(applyTariffs(store, 1, patch, "причина"), (e: Error & { status?: number }) => re.test(e.message) && e.status === 400, JSON.stringify(patch));
    // Сайт говорит то же самое.
    const w = web.checkTariffPatch(patch), s = checkTariffPatch(patch);
    assert.deepEqual(w, s, `сайт и сервер: ${JSON.stringify(patch)}`);
  }
  await assert.rejects(applyTariffs(store, 1, { price: 200 }, ""), /причину/);
  await assert.rejects(applyTariffs(store, 1, { price: 150 }, "то же"), /ничего не меняется/);
  await assert.rejects(undoTariff(store, 1, 999, "нет такой"), (e: Error & { status?: number }) => e.status === 404);
  assert.deepEqual(await store.tariffSettings(), [], "ничего не записано");
  await store.close();
});

test("проверка на сайте (web/src/tariffs.ts) — копия серверной один в один", () => {
  assert.deepEqual(web.TARIFF_SPEC, TARIFF_SPEC);
  const samples: unknown[] = [0, 1, 1.5, -1, 0.3, 0.12345, 100, 100.1, 1000, 1001, 3_600_000, 3_600_001, 1500, 60_000, 10_000, 10_001, 365, 366, true, "1", null, NaN];
  for (const k of [...Object.keys(TARIFF_SPEC), "unknown", "constructor", "toString", "__proto__", "hasOwnProperty"]) {
    for (const v of samples) assert.equal(web.checkTariffValue(k, v), checkTariffValue(k, v), `${k}=${String(v)}`);
  }
  for (const k of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) assert.match(checkTariffValue(k, 5) ?? "", /неизвестное поле/, k);
});

test("/signups on|off в боте — тот же выключатель тарифов (с историей), а не kv", async () => {
  const store = await Store.open(":memory:");
  await loadTariffs(store);
  await setSignupsOpen(store, 0, false);
  assert.equal(tariffs().signupsOpen, false);
  assert.equal(await store.kvGet("signups:closed"), undefined);
  assert.equal(await setSignupsOpen(store, 0, false), null, "уже закрыта — без новой строки");
  await setSignupsOpen(store, 0, true);
  assert.deepEqual((await store.tariffHistory()).map((h) => [h.source, h.user_id, h.reason]), [["bot", 0, "/signups on в боте"], ["bot", 0, "/signups off в боте"]]);
  await store.close();
});

// ——— Ручки админки тем же путём, что сайт: вход, код из «Telegram», данные.
async function stand() {
  const OWNER = "1001", FRIEND = "2002";
  config.allowedChatIds.splice(0, Infinity, OWNER, FRIEND);
  config.adminChatIds.splice(0, Infinity);
  const store = await Store.open(":memory:");
  await loadTariffs(store);
  await store.createUser({ login: "owner", passwordHash: await hashPassword("owner-pass-1"), tz: TZ, chatId: OWNER, name: "Хозяин Секретов" });
  await store.createUser({ login: "friend", passwordHash: await hashPassword("friend-pass-1"), tz: TZ, chatId: FRIEND });
  const codes: string[] = [];
  const server = createApi({ store, pipeline: new Pipeline(store, async () => "{}"), adminCode: async (_u, text) => void codes.push(text.match(/\d{6}/)![0]) }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (p: string, token: string, body?: unknown) => {
    const r = await fetch(base + p, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown>, text: "" };
  };
  const login = async (l: string, pw: string) => (await (await fetch(base + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: l, password: pw }) })).json()).token as string;
  return { store, codes, call, login, close: async () => { server.close(); await store.close(); } };
}

test("ручки /api/admin/tariffs: не админ — 404, без кода — 403; GET, «Применить» с причиной, 400, откат, журнал; без имён", async () => {
  const s = await stand();
  try {
    const owner = await s.login("owner", "owner-pass-1");
    const friend = await s.login("friend", "friend-pass-1");
    for (const [p, b] of [["/api/admin/tariffs", undefined], ["/api/admin/tariffs", { values: { price: 200 }, reason: "x" }], ["/api/admin/tariffs/undo", { id: 1, reason: "x" }]] as const) {
      assert.equal((await s.call(p, friend, b)).status, 404, `не админ: ${p}`);
      assert.equal((await s.call(p, owner, b)).status, 403, `без кода: ${p}`);
    }
    await s.call("/api/admin/code", owner, {});
    assert.equal((await s.call("/api/admin/confirm", owner, { code: s.codes[0] })).status, 200);
    const g = await s.call("/api/admin/tariffs", owner);
    assert.equal(g.status, 200);
    assert.deepEqual(Object.keys(g.body).sort(), ["defaults", "economy", "env_closed", "history", "now", "overridden", "reload_ms", "values"]);
    assert.equal(g.body.env_closed, false);
    assert.deepEqual(g.body.values, tariffDefaults());
    assert.deepEqual(g.body.overridden, []);
    assert.equal((await s.call("/api/admin/tariffs", owner, { values: { price: 200 } })).status, 400, "без причины");
    const bad = await s.call("/api/admin/tariffs", owner, { values: { price: -1 }, reason: "тест" });
    assert.equal(bad.status, 400);
    assert.match(String(bad.body.error), /не меньше 1/);
    assert.equal((await s.call("/api/admin/tariffs", owner, { values: { what: 1 }, reason: "тест" })).status, 400, "неизвестное поле");
    assert.equal((await s.call("/api/admin/tariffs", owner, { values: { price: 200, constructor: 5, toString: 1 }, reason: "тест" })).status, 400, "имя из прототипа");
    assert.equal((await s.call("/api/admin/tariffs/undo", owner, { id: 1e20, reason: "тест" })).status, 400, "номер больше int4");
    const ok = await s.call("/api/admin/tariffs", owner, { values: { price: 200, aiWindowMs: 30_000 }, reason: "пробуем цену" });
    assert.equal(ok.status, 200);
    assert.equal(tariffs().price, 200, "на этом процессе — сразу");
    const after = await s.call("/api/admin/tariffs", owner);
    assert.deepEqual((after.body.overridden as string[]).sort(), ["aiWindowMs", "price"]);
    const h = (after.body.history as { id: number; who: string; source: string; reason: string; changes: { key: string; from: unknown; to: unknown }[] }[])[0];
    assert.equal(h.who, "#1", "номер аккаунта, не имя");
    assert.deepEqual([h.source, h.reason], ["admin", "пробуем цену"]);
    assert.deepEqual(h.changes, [{ key: "price", from: 150, to: 200 }, { key: "aiWindowMs", from: 60_000, to: 30_000 }]);
    assert.ok(!JSON.stringify(after.body).includes("Хозяин"), "без имён");
    assert.ok(!JSON.stringify(after.body).includes("owner"), "без логинов");
    assert.equal((await s.call("/api/admin/tariffs/undo", owner, { id: h.id })).status, 400, "откат без причины");
    assert.equal((await s.call("/api/admin/tariffs/undo", owner, { id: 99, reason: "нет такой" })).status, 404);
    assert.equal((await s.call("/api/admin/tariffs/undo", owner, { id: h.id, reason: "вернуть" })).status, 200);
    assert.equal(tariffs().price, 150);
    const log = (await s.call("/api/admin/log", owner)).body as unknown as { action: string }[];
    assert.deepEqual(log.slice(0, 2).map((r) => r.action), ["tariff_undo", "tariff"]);
    // Сайт видит цену новых счетов в /api/me.
    await s.call("/api/admin/tariffs", owner, { values: { price: 250 }, reason: "цена для сайта" });
    assert.equal(((await s.call("/api/me", friend)).body.access as { price: number }).price, 250);
  } finally {
    await s.close();
  }
});

test("экономика тарифа в админке: из llm_usage за 30 дней; нет людей и расхода — null («—» на сайте)", async () => {
  const store = await Store.open(":memory:");
  await loadTariffs(store);
  const now = new Date("2026-11-24T12:00:00Z");
  const empty = await tariffsView(store, now);
  assert.deepEqual(empty.economy.paid, { people: 0, spenders: 0, avg_month_usd: null, worst_month_usd: null, worst_day_usd: null, capped_days: 0 });
  const until = new Date(now.getTime() + 10 * DAY).toISOString();
  const a = await store.createUser({ login: "a", passwordHash: "x", tz: TZ, plan: "paid", accessUntil: until });
  await store.createUser({ login: "b", passwordHash: "x", tz: TZ, plan: "paid", accessUntil: until });
  await store.addUsage(new Date("2026-11-20T10:00:00Z"), { kind: "chat", model: "m", input: 1, output: 1, cost: 1.6, userId: a.id });
  await store.addUsage(new Date("2026-11-21T10:00:00Z"), { kind: "chat", model: "m", input: 1, output: 1, cost: 0.4, userId: a.id });
  await store.addUsage(new Date("2026-10-01T10:00:00Z"), { kind: "chat", model: "m", input: 1, output: 1, cost: 50, userId: a.id }); // старше 30 дней
  const v = await tariffsView(store, now);
  assert.equal(v.economy.paid.people, 2);
  assert.equal(v.economy.paid.spenders, 1);
  assert.equal(v.economy.paid.avg_month_usd, 1, "$2 на двоих");
  assert.equal(v.economy.paid.worst_month_usd, 2);
  assert.equal(v.economy.paid.worst_day_usd, 1.6);
  assert.equal(v.economy.paid.capped_days, 1, "день $1.60 при потолке $1.50");
  assert.equal(v.economy.trial.avg_month_usd, null);
  await store.close();
});

// ——— Исправления по разбору (24.11.2026): гонки, откат только своих полей, вид срока, SIGNUPS_OPEN, экономика, /api/me.

test("два изменения одновременно не откатывают друг друга; двойное «Применить» — одна строка истории", async () => {
  const store = await Store.open(":memory:");
  await loadTariffs(store);
  // Админ меняет цену, в тот же момент владелец пишет /signups off.
  const [a, b] = await Promise.all([applyTariffs(store, 7, { price: 200 }, "цена"), setSignupsOpen(store, 0, false)]);
  assert.ok(a && b);
  assert.equal(tariffs().price, 200, "цена не откатилась");
  assert.equal(tariffs().signupsOpen, false);
  assert.deepEqual((await store.tariffSettings()).map((r) => [r.key, r.value]), [["price", "200"], ["signupsOpen", "false"]]);
  const v = await tariffsView(store);
  assert.deepEqual(v.history.map((h) => h.changes.map((c) => `${c.key} ${c.from}→${c.to}`)), [["signupsOpen true→false"], ["price 150→200"]], "в истории — только свои поля");
  // Двойное нажатие «Применить»: второе видит, что уже так.
  const twice = await Promise.allSettled([applyTariffs(store, 7, { price: 250 }, "двойное"), applyTariffs(store, 7, { price: 250 }, "двойное")]);
  assert.deepEqual(twice.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  assert.match(String((twice.find((r) => r.status === "rejected") as PromiseRejectedResult).reason?.message), /ничего не меняется/);
  assert.equal((await store.tariffHistory()).length, 3);
  await store.close();
});

test("фоновое перечитывание, ушедшее до «Применить» и вернувшееся после, не возвращает старые числа", async () => {
  const store = await Store.open(":memory:");
  await loadTariffs(store, 0);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  // Ответ фонового чтения задерживается: строки прочитаны до записи, вернутся после неё.
  const slow = { tariffSettings: async () => { const rows = await store.tariffSettings(); await gate; return rows; } } as unknown as Store;
  const bg = refreshTariffs(slow, TARIFF_RELOAD_MS * 10);
  await applyTariffs(store, 7, { price: 200 }, "цена");
  assert.equal(tariffs().price, 200);
  release();
  await bg;
  assert.equal(tariffs().price, 200, "старый ответ не применён");
  // Следующее перечитывание — как обычно.
  await store.saveTariffs([{ key: "aiBurst", value: "4" }], { at: new Date().toISOString(), user_id: 1, source: "admin", before_json: "{}", after_json: "{}", reason: "x" });
  assert.equal((await loadTariffs(store)).aiBurst, 4);
  await store.close();
});

test("«Вернуть как было» возвращает только поля своей строки: более позднее закрытие регистрации остаётся", async () => {
  const store = await Store.open(":memory:");
  await loadTariffs(store);
  const p = await applyTariffs(store, 7, { price: 200 }, "цена");
  await setSignupsOpen(store, 0, false); // позже — экстренно закрыли регистрацию
  const back = await undoTariff(store, 7, p.id, "вернуть цену");
  assert.deepEqual(back.changes, [{ key: "price", from: 200, to: 150 }]);
  assert.equal(tariffs().price, 150);
  assert.equal(tariffs().signupsOpen, false, "регистрация осталась закрытой");
  await assert.rejects(undoTariff(store, 7, p.id, "ещё раз"), (e: Error & { status?: number }) => e.status === 400 && /уже как до/.test(e.message));
  // Строка без изменений (битая история) — откатывать нечего.
  const bad = await store.saveTariffs([], { at: new Date().toISOString(), user_id: 1, source: "admin", before_json: "{", after_json: "{}", reason: "x" });
  await assert.rejects(undoTariff(store, 7, bad, "битая"), /ничего не менялось/);
  await store.close();
});

for (const [kind, open] of Object.entries(BACKENDS)) {
  test(`${kind}: номер записи для отката больше int4 — 400, а не ошибка базы`, async () => {
    const store = await open();
    try {
      await loadTariffs(store);
      for (const id of [1e20, 3e9, 2_147_483_648, Number.MAX_SAFE_INTEGER + 2]) {
        await assert.rejects(undoTariff(store, 1, id, "тест"), (e: Error & { status?: number }) => e.status === 400 && /номер записи/.test(e.message), String(id));
      }
      await assert.rejects(undoTariff(store, 1, 2_147_483_647, "тест"), (e: Error & { status?: number }) => e.status === 404, "в границе — «нет такой записи»");
    } finally {
      await store.close();
    }
  });

  test(`${kind}: шаг 31 — вид бесплатного срока: подарок из журнала — 0, остальные старые — null (по длине срока)`, async () => {
    const store = await open();
    try {
      const now = new Date("2026-11-24T12:00:00Z");
      const t = await store.createUser({ login: "t", passwordHash: "x", tz: TZ, plan: "trial", accessUntil: new Date(now.getTime() + 7 * DAY).toISOString(), at: now });
      const g = await store.createUser({ login: "g", passwordHash: "x", tz: TZ, plan: "trial", accessUntil: new Date(now.getTime() + 30 * DAY).toISOString(), at: now });
      await store.addBillingEvent({ user_id: g.id, kind: "gift", at: now });
      await store.driver.exec("ALTER TABLE users DROP COLUMN trial_len_days;");
      await store.kvSet("schema_version", "30");
      const again = await Store.over(store.driver);
      assert.equal(await again.kvGet("schema_version"), "31");
      assert.equal((await again.user(t.id))!.trial_len_days, null);
      assert.equal(Number((await again.user(g.id))!.trial_len_days), 0);
      assert.equal(endedOf((await again.user(g.id))!), "gift");
      assert.equal(endedOf((await again.user(t.id))!), "trial");
    } finally {
      await store.close();
    }
  });
}

test("вид срока записан при выдаче: смена trialDays в админке не превращает пробы в подарки и наоборот", async () => {
  const store = await Store.open(":memory:");
  await loadTariffs(store);
  const now = new Date("2026-11-24T12:00:00Z");
  const o = { open: true, perHour: 100, perDay: 100, trialDays: 7 };
  const trial = (await signUp(store, { id: "301", name: "П" }, TZ, now, o)) as { user: { id: number } };
  const gift = await redeemInvite(store, await createInvite(store, now), { id: "302", name: "Д" }, TZ, now, 30);
  const mid = (await signUp(store, { id: "303", name: "С" }, TZ, now, o)) as { user: { id: number } };
  await redeemInvite(store, await createInvite(store, now), { id: "303", name: "С" }, TZ, now, 30); // подарок посреди пробы
  const u = async (id: number) => (await store.user(id))!;
  assert.deepEqual([(await u(trial.user.id)).trial_len_days, Number((await u(gift!.user.id)).trial_len_days), Number((await u(mid.user.id)).trial_len_days)], [7, 0, 0]);
  for (const trialDays of [3, 30]) {
    await applyTariffs(store, 1, { trialDays }, `проба ${trialDays}`);
    assert.equal(endedOf(await u(trial.user.id)), "trial", `trialDays=${trialDays}: 7-дневная проба — проба`);
    assert.equal(endedOf(await u(gift!.user.id)), "gift", `trialDays=${trialDays}: 30-дневный подарок — подарок`);
  }
  // Планировщик пишет в журнал вид по записи, а не по нынешнему тарифу (сейчас trialDays = 30).
  const later = new Date(now.getTime() + 40 * DAY);
  await new Billing(store, null, { secret: "s", clock: () => later }).expire(later);
  const ev = await store.billingEvents(now.toISOString(), new Date(later.getTime() + DAY).toISOString());
  const endOf = (id: number) => ev.filter((e) => e.user_id === id && /_ended$/.test(e.kind)).map((e) => e.kind);
  assert.deepEqual([endOf(trial.user.id), endOf(gift!.user.id), endOf(mid.user.id)], [["trial_ended"], ["gift_ended"], ["gift_ended"]]);
  // Записи до шага 31 (null) — по длине срока с прежней пробой 7 дней, тоже не по тарифу.
  const made = "2026-11-01T00:00:00.000Z", plus = (d: number) => new Date(Date.parse(made) + d * DAY).toISOString();
  assert.equal(trialLenOf({ trial_len_days: null, created_at: made, access_until: plus(7) }), 7);
  assert.equal(trialLenOf({ trial_len_days: null, created_at: made, access_until: plus(30) }), 0);
  await loadTariffs(store);
  await store.close();
});

test("SIGNUPS_OPEN=0 в .env закрывает регистрацию поверх строки signupsOpen=true в тарифах; без него — решает тариф", async () => {
  const store = await Store.open(":memory:");
  const was = process.env.SIGNUPS_OPEN;
  try {
    await loadTariffs(store);
    await setSignupsOpen(store, 0, false);
    await setSignupsOpen(store, 0, true); // открыли из админки — строки нет (по умолчанию и так открыта)
    await store.saveTariffs([{ key: "signupsOpen", value: "true" }], { at: new Date().toISOString(), user_id: 1, source: "admin", before_json: "{}", after_json: "{}", reason: "x" });
    await loadTariffs(store);
    process.env.SIGNUPS_OPEN = "0";
    assert.equal(signupsOpenNow(), false);
    assert.equal(await signUp(store, { id: "401", name: "Н" }, TZ), "closed", "аварийный выключатель в .env работает, как раньше");
    assert.equal((await tariffsView(store)).env_closed, true, "сайт видит, что закрыто в .env");
    delete process.env.SIGNUPS_OPEN;
    assert.equal(signupsOpenNow(), true);
    assert.equal(typeof (await signUp(store, { id: "401", name: "Н" }, TZ)), "object");
    // Строка «закрыта» значит «закрыта» при любом .env.
    process.env.SIGNUPS_OPEN = "1";
    await setSignupsOpen(store, 0, false);
    assert.equal(signupsOpenNow(), false);
  } finally {
    if (was === undefined) delete process.env.SIGNUPS_OPEN;
    else process.env.SIGNUPS_OPEN = was;
    await loadTariffs(store);
    await store.close();
  }
});

test("экономика тарифа: в расходе только те, кто сейчас на плане — без кончившихся сроков и владельцев", async () => {
  const keep = { allowed: [...config.allowedChatIds], admin: [...config.adminChatIds] };
  config.allowedChatIds.splice(0, Infinity, "900");
  config.adminChatIds.splice(0, Infinity);
  const store = await Store.open(":memory:");
  try {
    await loadTariffs(store);
    const now = new Date("2026-11-24T12:00:00Z");
    const live = new Date(now.getTime() + 3 * DAY).toISOString(), gone = new Date(now.getTime() - 5 * DAY).toISOString();
    const t = await store.createUser({ login: "t", passwordHash: "x", tz: TZ, plan: "trial", accessUntil: live });
    const spend = async (id: number, day: string, cost: number) => store.addUsage(new Date(`${day}T10:00:00Z`), { kind: "chat", model: "m", input: 1, output: 1, cost, userId: id });
    await spend(t.id, "2026-11-23", 0.2);
    // 20 бывших проб (plan в базе ещё trial, срок кончился) по $0.30 и владелец с plan trial, потративший $5.
    for (let i = 0; i < 20; i++) await spend((await store.createUser({ login: `x${i}`, passwordHash: "x", tz: TZ, plan: "trial", accessUntil: gone })).id, "2026-11-15", 0.3);
    await spend((await store.createUser({ login: "own", passwordHash: "x", tz: TZ, chatId: "900", plan: "trial", accessUntil: live })).id, "2026-11-22", 5);
    const e = (await tariffsView(store, now)).economy.trial;
    assert.deepEqual(e, { people: 1, spenders: 1, avg_month_usd: 0.2, worst_month_usd: 0.2, worst_day_usd: 0.2, capped_days: 0 });
  } finally {
    config.allowedChatIds.splice(0, Infinity, ...keep.allowed);
    config.adminChatIds.splice(0, Infinity, ...keep.admin);
    await store.close();
  }
});

test("/api/me: подписка кончилась, а plan в базе ещё paid — цена нынешняя (как у счёта), у идущей — цена при оформлении", async () => {
  const s = await stand();
  try {
    const mk = async (login: string, chat: string, until: number, charge: string) => {
      const u = await s.store.createUser({ login, passwordHash: await hashPassword(`${login}-pass-1`), tz: TZ, chatId: chat, plan: "paid", accessUntil: new Date(until).toISOString() });
      await s.store.addPayment({ charge_id: charge, user_id: u.id, tg_user_id: chat, amount: 150, currency: "XTR", payload: "p", kind: "first", paid_at: new Date(Date.now() - 31 * DAY).toISOString(), expires_at: u.access_until });
      await s.store.updateUser(u.id, { sub_charge_id: charge, tg_user_id: chat });
    };
    await mk("gone", "3003", Date.now() - 3 * 3600_000, "cg"); // срок и запас кончились, планировщик ещё не перевёл в free
    await mk("subs", "3004", Date.now() + 10 * DAY, "cs");
    await applyTariffs(s.store, 1, { price: 300 }, "новая цена");
    const me = async (login: string) => (await s.call("/api/me", await s.login(login, `${login}-pass-1`))).body.access as { plan: string; price: number };
    const g = await me("gone");
    assert.deepEqual([g.plan, g.price], ["expired", 300], "на сайте — та же цена, что у счёта по кнопке «Оформить»");
    assert.equal((await me("subs")).price, 150, "идущая подписка продлевается по цене при оформлении");
  } finally {
    await s.close();
  }
});
