import { PGlite } from "@electric-sql/pglite";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import * as webpush from "web-push";
import { AiGate } from "../src/access.ts";
import { Alerts } from "../src/alerts.ts";
import { Billing, type StarsApi } from "../src/billing.ts";
import { ANNOUNCE_PREFIX, deliverToWidget, resetAnnounceCache, siteAnnouncements } from "../src/announce.ts";
import { createApi } from "../src/api.ts";
import { hashPassword } from "../src/auth.ts";
import { config } from "../src/config.ts";
import { Store } from "../src/db.ts";
import { PgDriver } from "../src/driver.ts";
import { Pipeline, RETRY_AFTER_MIN } from "../src/pipeline.ts";
import { daysToCap, PROGNOSIS_MIN_DAYS, prognosisView, trendLine } from "../src/prognosis.ts";
import { createPromo, PROMO_TEXT, PROMO_TRIES, redeemPromo, resetPromoTries } from "../src/promo.ts";
import { Push } from "../src/push.ts";
import { Scheduler } from "../src/scheduler.ts";
import { createTicket, SUPPORT_PER_DAY, supportOf, ticketAction, ticketCard, ticketsView } from "../src/support.ts";
import { loadSwitches, overrideSwitches, refreshSwitches, setSwitch, SWITCH_RELOAD_MS, switchOffText, switchOn } from "../src/switches.ts";
import { loadTariffs, tariffs } from "../src/tariffs.ts";
import { zonedToUtc } from "../src/time.ts";

// Этап 6 «Тарифы и управление»: переключатели функций (switches.ts), промокоды (promo.ts), обращения (support.ts), объявления
// (announce.ts), прогноз (prognosis.ts). Тем же путём, что админка сайта: вход → код из «Telegram» → /api/admin/*; Postgres — PGlite.

const OWNER = "1001";
const TZ = "Europe/Moscow";
const DAY = 86_400_000;
const NOW = new Date("2026-11-24T12:00:00Z");
const iso = (t: number) => new Date(t).toISOString();

const sqlite = () => Store.open(":memory:");
async function postgres() {
  const pg = new PGlite();
  return Store.over(new PgDriver(pg, (fn) => pg.transaction((tx) => fn(tx)), () => pg.close()));
}
const BASES: [string, () => Promise<Store>][] = [["sqlite", sqlite], ["postgres", postgres]];

async function people(store: Store) {
  const trial = await store.createUser({ login: "anya", passwordHash: "x", tz: TZ, chatId: "11", name: "Аня", plan: "trial", accessUntil: iso(NOW.getTime() + 2 * DAY), trialLenDays: 7 });
  const paid = await store.createUser({ login: "boris", passwordHash: "x", tz: TZ, chatId: "12", name: "Борис", plan: "paid", accessUntil: iso(NOW.getTime() + 10 * DAY) });
  await store.updateUser(paid.id, { sub_charge_id: "charge-boris-0001" });
  const friend = await store.createUser({ login: "vera", passwordHash: "x", tz: TZ, chatId: "13", name: "Вера", plan: "friend" });
  const ended = await store.createUser({ login: "gleb", passwordHash: "x", tz: TZ, chatId: "14", name: "Глеб", plan: "free", accessUntil: iso(NOW.getTime() - 5 * DAY), trialLenDays: 7 });
  return { trial: (await store.user(trial.id))!, paid: (await store.user(paid.id))!, friend: (await store.user(friend.id))!, ended: (await store.user(ended.id))! };
}

for (const [name, open] of BASES) {
  test(`${name}: шаг 36 — переключатели, промокоды, обращения, объявления; одно применение кода на человека`, async () => {
    const store = await open();
    try {
      assert.equal(await store.kvGet("schema_version"), "38");
      const p = await people(store);
      await store.setFeatureSwitch("draw", false, NOW, 1);
      await store.setFeatureSwitch("draw", true, NOW, 2);
      assert.deepEqual((await store.featureSwitches()).map((r) => [r.id, r.enabled, r.updated_by]), [["draw", 1, 2]]);
      const id = (await store.addPromoCode({ code: "RINA30", days: 30, max_uses: 1, ends_at: null, at: NOW, by: 1 }))!;
      assert.equal(await store.addPromoCode({ code: "RINA30", days: 7, max_uses: 5, ends_at: null, at: NOW, by: 1 }), null, "такой код уже есть");
      // Последнее применение — двоим сразу: достаётся одному.
      const both = await Promise.all([store.takePromo(p.trial.id, id, 30, NOW), store.takePromo(p.ended.id, id, 30, NOW)]);
      assert.deepEqual(both.slice().sort(), ["gone", "ok"]);
      assert.equal((await store.promoById(id))!.used, 1);
      const winner = both[0] === "ok" ? p.trial.id : p.ended.id;
      assert.equal(await store.takePromo(winner, id, 30, NOW), "mine", "второй раз тот же человек — нет");
      const t = await store.addTicket({ user_id: p.trial.id, topic: "payment", text: "не прошла оплата", at: NOW });
      assert.equal(await store.ticketsSince(iso(NOW.getTime() - 1000)), 1);
      assert.ok(!("text" in (await store.ticketList())[0]), "в списке нет текста");
      await store.updateTicket(t, { answer: "проверила", status: "closed", at: NOW });
      assert.deepEqual([(await store.ticket(t))!.status, (await store.ticket(t))!.answer], ["closed", "проверила"]);
      const a = await store.addAnnouncement({ text: "Обновляю сервер", audience: "all", site: true, widget: true, ends_at: null, at: NOW, by: 1 });
      assert.equal(await store.markAnnouncementSeen(a, p.trial.id, NOW), true);
      assert.equal(await store.markAnnouncementSeen(a, p.trial.id, NOW), false, "второй раз — нет");
      assert.equal((await store.announcementReach()).get(a), 1);
      await store.addPayment({ charge_id: "c1", user_id: p.paid.id, tg_user_id: "12", amount: 150, currency: "XTR", payload: "", kind: "first", paid_at: iso(NOW.getTime() - DAY), expires_at: null });
      assert.deepEqual(await store.starDays(iso(NOW.getTime() - 3 * DAY)), [{ day: "2026-11-23", stars: 150, n: 1 }]);
    } finally {
      await store.close();
    }
  });
}

test("переключатели: по умолчанию всё включено; выключить — с причиной, в журнал, сразу на этом процессе и раз в минуту на другом", async () => {
  const store = await sqlite();
  try {
    overrideSwitches([]);
    await loadTariffs(store);
    await loadSwitches(store);
    for (const id of ["ai", "draw", "voice", "push", "signups"] as const) assert.equal(switchOn(id), true, id);
    await assert.rejects(setSwitch(store, 1, { id: "draw", on: false }), /причину/);
    await assert.rejects(setSwitch(store, 1, { id: "nope", on: false, reason: "проверка" }), /нет такой функции/);
    await assert.rejects(setSwitch(store, 1, { id: "draw", on: true, reason: "проверка" }), /уже так/);
    const v = await setSwitch(store, 1, { id: "draw", on: false, reason: "дорого сегодня" }, NOW);
    assert.equal(v.switches.find((s) => s.id === "draw")!.on, false);
    assert.equal(switchOn("draw"), false, "сразу на этом процессе");
    const log = await store.adminLog(5);
    assert.deepEqual([log[0].action, log[0].detail, log[0].reason], ["switch_off", "draw", "дорого сегодня"]);
    // «Другой процесс»: состояние в памяти — как до изменения; перечитывает не раньше чем через минуту.
    overrideSwitches([]);
    assert.equal(await refreshSwitches(store, NOW.getTime() + 1000), false, "минута не прошла");
    assert.equal(switchOn("draw"), true);
    assert.equal(await refreshSwitches(store, NOW.getTime() + SWITCH_RELOAD_MS), true);
    assert.equal(switchOn("draw"), false, "перечитал из базы");
    // Регистрация — тот же выключатель, что в тарифах (signupsOpen), со строкой истории тарифов.
    await setSwitch(store, 1, { id: "signups", on: false, reason: "наплыв" }, NOW);
    assert.equal(tariffs().signupsOpen, false);
    assert.equal(switchOn("signups"), false);
    assert.equal((await store.adminLog(1))[0].action, "tariff");
    await setSwitch(store, 1, { id: "signups", on: true, reason: "прошло" }, NOW);
    await setSwitch(store, 1, { id: "draw", on: true, reason: "вернула" }, NOW);
    assert.equal(switchOn("draw"), true);
  } finally {
    overrideSwitches([]);
    await store.close();
  }
});

test("переключатели: выключенные картинки, голос и ИИ — понятный отказ в AiGate (и другу), счётчики не тронуты; push не уходит", async () => {
  const store = await sqlite();
  try {
    const p = await people(store);
    const gate = new AiGate(store, { owners: () => [OWNER], clock: () => NOW });
    overrideSwitches(["draw"]);
    const d = await gate.check(p.trial, { take: { draws: 1 } });
    assert.deepEqual(d.ok ? null : [d.why, d.reason, d.text], ["money", "switch_off", switchOffText("draw")]);
    assert.equal((await gate.check(p.trial, { take: { calls: 1 } })).ok, true, "переписка работает");
    assert.equal((await gate.check(p.friend, { take: { draws: 1 } })).ok, false, "и другу выключено");
    overrideSwitches(["voice"]);
    const v = await gate.check(p.trial, { take: { calls: 1, voiceSec: 20 } });
    assert.deepEqual(v.ok ? null : v.text, switchOffText("voice"));
    const q = await store.quotaOf(p.trial.id, "2026-11-24");
    assert.equal(q.voice_sec, 0, "секунды не взяты");
    overrideSwitches(["ai"]);
    const a = await gate.check(p.paid, { take: { calls: 1 } });
    assert.deepEqual(a.ok ? null : [a.why, a.text], ["money", switchOffText("ai")]);
    // Конвейер: сообщение при выключенном ИИ — заметкой, модель не зовётся.
    let llm = 0;
    const pipeline = new Pipeline(store, async () => (llm++, "{}"));
    pipeline.gate = gate;
    const r = await pipeline.handle({ user: p.trial, source: "app", sourceId: "s1", text: "купить хлеб", at: NOW });
    assert.equal(llm, 0);
    assert.match(r.text, /Разбор сообщений ненадолго выключен/);
    assert.match(r.text, /записала заметкой/);
    // Push выключен — никому, даже с подпиской.
    overrideSwitches(["push"]);
    const push = new Push(store, { ...webpush.generateVAPIDKeys(), subject: "mailto:test@example.com" });
    await store.addPushSub({ endpoint: "https://push.example/1", userId: p.trial.id, keys: { p256dh: "x", auth: "y" }, label: "тест" });
    assert.equal(await push.send(p.trial, "привет", "happy"), 0);
  } finally {
    overrideSwitches([]);
    await store.close();
  }
});

for (const [name, open] of BASES) {
  test(`${name}: промокод — дни к сроку, один на человека, исчерпан, выключен, просрочен; подписка с продлением и друг — нет`, async () => {
    const store = await open();
    try {
      resetPromoTries();
      const p = await people(store);
      await assert.rejects(createPromo(store, 1, { code: "SPRING", days: 7, max_uses: 2 }, NOW), /причину/);
      await assert.rejects(createPromo(store, 1, { code: "ой", days: 7, max_uses: 2, reason: "акция" }, NOW), /латиница/);
      await assert.rejects(createPromo(store, 1, { code: "SPRING", days: 0, max_uses: 2, reason: "акция" }, NOW), /дней/);
      await assert.rejects(createPromo(store, 1, { code: "SPRING", days: 7, max_uses: 2, until: "2026-11-01", reason: "акция" }, NOW), /прошёл/);
      const c = await createPromo(store, 1, { code: " spring ", days: 7, max_uses: 2, until: "2026-12-31", reason: "акция зимы" }, NOW);
      assert.equal(c.code, "SPRING");
      await assert.rejects(createPromo(store, 1, { code: "SPRING", days: 7, max_uses: 2, reason: "акция" }, NOW), /уже есть/);
      const g = await createPromo(store, 1, { generate: true, days: 30, max_uses: 1, reason: "стрим" }, NOW);
      assert.match(g.code, /^[A-Z2-9]{8}$/);
      assert.equal((await store.adminLog(1))[0].reason, "стрим");
      // Проба: +7 дней от конца пробы, проба остаётся пробой.
      const r = await redeemPromo(store, p.trial, "spring", NOW, [OWNER]);
      assert.equal(r.until, iso(Date.parse(p.trial.access_until!) + 7 * DAY));
      assert.equal(r.text, PROMO_TEXT.done(7, r.until));
      const u = (await store.user(p.trial.id))!;
      assert.deepEqual([u.plan, u.trial_len_days], ["trial", 7]);
      assert.deepEqual((await store.billingEventsOf(p.trial.id)).map((e) => [e.kind, e.amount]), [["promo", 7]]);
      await assert.rejects(redeemPromo(store, u, g.code, NOW, [OWNER]), (e: Error) => e.message === PROMO_TEXT.again, "один человек — один код");
      // Кончившийся срок — от сегодня, подарком нет: кончилась проба — снова проба.
      const e = await redeemPromo(store, p.ended, "SPRING", NOW, [OWNER]);
      assert.equal(e.until, iso(NOW.getTime() + 7 * DAY));
      assert.equal((await store.user(p.ended.id))!.plan, "trial");
      // Код кончился (2 из 2).
      const third = await store.createUser({ login: "dima", passwordHash: "x", tz: TZ, chatId: "15", plan: "trial", accessUntil: iso(NOW.getTime() + DAY), trialLenDays: 7 });
      await assert.rejects(redeemPromo(store, third, "SPRING", NOW, [OWNER]), (x: Error) => x.message === PROMO_TEXT.empty);
      // Подписка с продлением, друг, владелец — без попыток и без поиска кода.
      await assert.rejects(redeemPromo(store, p.paid, g.code, NOW, [OWNER]), (x: Error) => x.message === PROMO_TEXT.sub);
      await assert.rejects(redeemPromo(store, p.friend, g.code, NOW, [OWNER]), (x: Error) => x.message === PROMO_TEXT.free);
      // Выключенный и просроченный.
      const off = await createPromo(store, 1, { code: "OFFCODE", days: 3, max_uses: 10, reason: "проба" }, NOW);
      await store.setPromoEnabled(off.id, false);
      await assert.rejects(redeemPromo(store, third, "OFFCODE", NOW, [OWNER]), (x: Error) => x.message === PROMO_TEXT.off);
      await createPromo(store, 1, { code: "SHORT", days: 3, max_uses: 10, until: "2026-11-25", reason: "проба" }, NOW);
      await assert.rejects(redeemPromo(store, third, "SHORT", new Date("2026-11-26T00:00:01Z"), [OWNER]), (x: Error) => x.message === PROMO_TEXT.off);
      // А в срок — работает.
      assert.equal((await redeemPromo(store, third, "SHORT", NOW, [OWNER])).days, 3);
      const view = (await store.promoCodes()).find((x) => x.code === "SPRING")!;
      assert.deepEqual([view.used, view.max_uses], [2, 2]);
    } finally {
      await store.close();
    }
  });
}

test("промокод: перебор — после 5 неудачных попыток за 15 минут 429, верный код в это время тоже ждёт", async () => {
  const store = await sqlite();
  try {
    resetPromoTries();
    const p = await people(store);
    await createPromo(store, 1, { code: "GOODCODE", days: 7, max_uses: 10, reason: "акция" }, NOW);
    for (let i = 0; i < PROMO_TRIES; i++) await assert.rejects(redeemPromo(store, p.trial, `BAD${i}X`, NOW, [OWNER]), (x: Error) => x.message === PROMO_TEXT.bad);
    await assert.rejects(redeemPromo(store, p.trial, "GOODCODE", NOW, [OWNER]), (x: Error & { status?: number }) => x.status === 429 && /через 15 мин/.test(x.message));
    assert.equal((await redeemPromo(store, p.trial, "GOODCODE", new Date(NOW.getTime() + 16 * 60_000), [OWNER])).days, 7, "через 15 минут — можно");
  } finally {
    await store.close();
  }
});

test("обращения: тема и текст, не больше 3 в сутки; оповещение — только число; список без текста, карточка с текстом; ответ — человеку", async () => {
  const store = await sqlite();
  try {
    const p = await people(store);
    await assert.rejects(createTicket(store, p.trial, { topic: "nope", text: "помогите пожалуйста" }, NOW), /Выберите тему/);
    await assert.rejects(createTicket(store, p.trial, { topic: "bug", text: "ой" }, NOW), /подробнее/);
    const ids: number[] = [];
    for (let i = 0; i < SUPPORT_PER_DAY; i++) ids.push((await createTicket(store, p.trial, { topic: "bug", text: `секрет Ани ${i}` }, new Date(NOW.getTime() + i))).id);
    await assert.rejects(createTicket(store, p.trial, { topic: "bug", text: "ещё одно обращение" }, NOW), (e: Error & { status?: number }) => e.status === 429);
    assert.equal((await createTicket(store, p.trial, { topic: "idea", text: "через сутки можно" }, new Date(NOW.getTime() + DAY + 10))).id > 0, true);
    // Оповещение support_new: одно письмо, только число.
    const sent: string[] = [];
    const alerts = new Alerts(store, { notify: async (t) => (sent.push(t), 1), publicUrl: "https://maid.test" });
    await alerts.rules(new Date(NOW.getTime() - 60_000)); // отметка — до обращений
    await store.once("digest:2026-11-25");
    await alerts.check(new Date(NOW.getTime() + DAY + 60_000), true);
    const mail = sent.filter((t) => /обращений/.test(t));
    assert.equal(mail.length, 1);
    assert.match(mail[0], /Новых обращений: 4/);
    assert.ok(!mail[0].includes("секрет") && !mail[0].includes("Аня"), "без текстов и имён");
    // Список — без текста; карточка — с текстом.
    const list = await ticketsView(store, NOW);
    assert.ok(!JSON.stringify(list).includes("секрет"));
    assert.deepEqual([list.counts.new, list.tickets[0].account], [4, `#${p.trial.id}`]);
    const card = await ticketCard(store, ids[0], NOW);
    assert.equal(card.text, "секрет Ани 0");
    // Ответ: письмо человеку, статус, журнал админа без текста ответа; причина обязательна.
    const told: string[] = [];
    const deps = { store, tell: async (_u: unknown, t: string) => (told.push(t), { feed: true, telegram: true }) };
    await assert.rejects(ticketAction(deps, 1, ids[0], "answer", { text: "Проверила оплату" }, NOW), /причину/);
    const after = await ticketAction(deps, 1, ids[0], "answer", { text: "Проверила оплату", close: true, reason: "ответ по оплате" }, NOW);
    assert.deepEqual([after.status, after.answer], ["closed", "Проверила оплату"]);
    assert.deepEqual(told, [`💬 Ответ на ваше обращение №${ids[0]}:\nПроверила оплату`]);
    const log = (await store.adminLog(1))[0];
    assert.equal(log.action, "ticket_answer");
    assert.ok(!log.detail.includes("Проверила"), "в журнал — без текста ответа");
    assert.equal(log.reason, "ответ по оплате");
    await ticketAction(deps, 1, ids[1], "status", { status: "work", reason: "смотрю" }, NOW);
    assert.equal((await ticketCard(store, ids[1], NOW)).status, "work");
    await assert.rejects(ticketAction(deps, 1, ids[1], "status", { status: "work", reason: "смотрю" }, NOW), /уже так/);
    await assert.rejects(ticketAction(deps, 1, 9999, "status", { status: "work", reason: "смотрю" }, NOW), /нет обращения/);
  } finally {
    await store.close();
  }
});

test("объявления: кому и где; сайт — свои плашки; виджет — строкой в ленту один раз; выключенное и просроченное — нет", async () => {
  const store = await sqlite();
  try {
    resetAnnounceCache();
    const p = await people(store);
    const now = new Date();
    const add = (audience: string, site: boolean, widget: boolean, text: string, ends: string | null = null) => store.addAnnouncement({ text, audience, site, widget, ends_at: ends, at: now, by: 1 });
    const all = await add("all", true, true, "Ночью обновляю сервер");
    await add("paid", true, false, "Спасибо подписчикам");
    await add("trial", false, true, "Проба кончается — не забудьте");
    const old = await add("all", true, false, "Старое", iso(now.getTime() - 1000));
    const off = await add("all", true, true, "Выключенное");
    await store.setAnnouncementEnabled(off, false, now);
    resetAnnounceCache();
    assert.deepEqual((await siteAnnouncements(store, p.trial, now)).map((a) => a.text), ["Ночью обновляю сервер"]);
    assert.deepEqual((await siteAnnouncements(store, p.paid, now)).map((a) => a.text).sort(), ["Ночью обновляю сервер", "Спасибо подписчикам"]);
    assert.ok(!(await siteAnnouncements(store, p.trial, now)).some((a) => a.id === old), "просроченное — нет");
    assert.equal(await deliverToWidget(store, p.trial, now), 2, "всем + пробе");
    assert.equal(await deliverToWidget(store, p.trial, now), 0, "второй раз — нет");
    const feed = (await store.noticesAll(p.trial.id, 10)).map((n) => n.text);
    assert.deepEqual(feed.slice().sort(), [ANNOUNCE_PREFIX + "Ночью обновляю сервер", ANNOUNCE_PREFIX + "Проба кончается — не забудьте"].sort());
    assert.equal(await deliverToWidget(store, p.paid, now), 1, "подписчику — только «всем» (своё — только на сайт)");
    assert.equal((await store.announcementReach()).get(all), 2);
  } finally {
    await store.close();
  }
});

test("прогноз: средние за 7 и 30 дней × 30, рост и дни до потолка, продления по датам окончания", async () => {
  assert.deepEqual(trendLine([1, 2, 3]), { slope: 1, last: 3 });
  assert.equal(daysToCap({ slope: 1, last: 3 }, 10), 7);
  assert.equal(daysToCap({ slope: 0, last: 3 }, 10), null, "не растёт — не упрёмся");
  assert.equal(daysToCap({ slope: -1, last: 12 }, 10), 0, "уже выше");
  const store = await sqlite();
  try {
    await loadTariffs(store);
    const p = await people(store);
    // Расход: последние 7 дней по $1 у пробы, раньше — по $0,50.
    for (let i = 1; i <= 30; i++) await store.addUsage(new Date(NOW.getTime() - i * DAY), { kind: "parse", model: "m", input: 1, output: 1, cost: i <= 7 ? 1 : 0.5, userId: p.trial.id });
    await store.addPayment({ charge_id: "c-renew", user_id: p.paid.id, tg_user_id: "12", amount: 150, currency: "XTR", payload: "", kind: "first", paid_at: iso(NOW.getTime() - 3 * DAY), expires_at: null });
    await store.updateUser(p.paid.id, { sub_charge_id: "c-renew" });
    const ending = await store.createUser({ login: "egor", passwordHash: "x", tz: TZ, chatId: "16", plan: "paid", accessUntil: iso(NOW.getTime() + 5 * DAY) });
    await store.updateUser(ending.id, { sub_charge_id: "c-x", sub_canceled: 1 });
    const f = await prognosisView(store, NOW);
    assert.equal(f.series.length, 30);
    assert.ok(Math.abs(f.spend.month.by7 - 30) < 1e-6, "7 дней по $1 → $30 в месяц");
    assert.ok(Math.abs(f.spend.month.by30 - (7 * 1 + 23 * 0.5)) < 1e-6);
    assert.ok(f.spend.slope_per_day > 0, "расход растёт");
    assert.ok(f.trial_pool.days_to_cap !== null && f.trial_pool.days_to_cap > 0, "до потолка проб $10 — сколько-то дней");
    // Оплата одна, 3 дня назад: среднее — по 3 дням с данными, а не по 7 («мало данных: 3 дн.» на сайте).
    assert.equal(f.income.stars.data_days, 3);
    assert.ok(Math.abs(f.income.stars.by7 - 150 / 3 * 30) < 1e-6);
    assert.deepEqual([f.renewals.n, f.renewals.stars, f.renewals.ending_without_renew], [1, 150, 1]);
    assert.deepEqual(f.renewals.by_day, [{ day: p.paid.access_until!.slice(0, 10), n: 1, stars: 150 }]);
    assert.ok(!JSON.stringify(f).includes("Борис") && !JSON.stringify(f).includes("user_id"), "без людей");
  } finally {
    await store.close();
  }
});

// ——— Ручки: тем же путём, что сайт.
async function stand() {
  config.allowedChatIds.splice(0, Infinity, OWNER);
  config.adminChatIds.splice(0, Infinity);
  const store = await sqlite();
  await loadTariffs(store);
  overrideSwitches([]);
  resetAnnounceCache();
  resetPromoTries();
  await store.createUser({ login: "owner", passwordHash: await hashPassword("owner-pass-1"), tz: TZ, chatId: OWNER, name: "Хозяин" });
  const anya = await store.createUser({ login: "anya", passwordHash: await hashPassword("anya-pass-1"), tz: TZ, chatId: "11", name: "Аня", plan: "trial", accessUntil: iso(Date.now() + 2 * DAY), trialLenDays: 7 });
  const codes: string[] = [];
  const pipeline = new Pipeline(store, async () => "{}");
  pipeline.gate = new AiGate(store, { owners: () => [OWNER] });
  const server = createApi({ store, pipeline, adminCode: async (_u, text) => void codes.push(text.match(/\d{6}/)![0]) }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = async (l: string, pw: string) => {
    const r = await fetch(base + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: l, password: pw }) });
    return String(((await r.json()) as { token: string }).token);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ответы разных ручек
  const callAs = async (token: string, p: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const r = await fetch(base + p, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const owner = await login("owner", "owner-pass-1");
  const person = await login("anya", "anya-pass-1");
  return { store, anya, owner, person, codes, callAs, close: async () => { server.close(); await store.close(); } };
}

const ADMIN_GET = ["/api/admin/switches", "/api/admin/promo", "/api/admin/tickets", "/api/admin/tickets/1", "/api/admin/announcements", "/api/admin/prognosis"];

const noPrivate = (body: unknown, extra: string[] = []) => {
  const json = JSON.stringify(body);
  for (const bad of ["Аня", "Хозяин", '"anya"', '"owner"', '"11"', OWNER, "chat_id", "login", "password_hash", "tg_user_id", ...extra]) assert.ok(!json.includes(bad), `в ответе админки: ${bad}`);
};

test("ручки этапа 6: не админу — 404, без кода — 403; с кодом — разделы без имён; действия с причиной — в журнал", async () => {
  const s = await stand();
  try {
    for (const p of ADMIN_GET) {
      assert.equal((await s.callAs(s.person, p)).status, 404, `не админу: ${p}`);
      assert.equal((await s.callAs(s.owner, p)).status, 403, `без кода: ${p}`);
    }
    assert.equal((await s.callAs(s.person, "/api/admin/switches", { id: "draw", on: false, reason: "x123" })).status, 404);
    await s.callAs(s.owner, "/api/admin/code", {});
    assert.equal((await s.callAs(s.owner, "/api/admin/confirm", { code: s.codes[0] })).status, 200);
    const call = (p: string, body?: unknown) => s.callAs(s.owner, p, body);
    // Человек пишет обращение и вводит промокод — с сайта.
    const sup = await s.callAs(s.person, "/api/support");
    assert.deepEqual([sup.status, sup.body.left_today], [200, 3]);
    const t = await s.callAs(s.person, "/api/support", { topic: "payment", text: "секрет: не прошла оплата" });
    assert.equal(t.status, 200);
    assert.match(t.body.text, /Обращение №\d+ передала/);
    assert.equal((await call("/api/admin/promo", { code: "WINTER", days: 7, max_uses: 5 })).status, 400, "без причины");
    assert.equal((await call("/api/admin/promo", { code: "WINTER", days: 7, max_uses: 5, reason: "зимняя акция" })).status, 200);
    const promo = await s.callAs(s.person, "/api/promo", { code: "winter" });
    assert.equal(promo.status, 200);
    assert.match(promo.body.text, /^Готово: \+7 дней/);
    assert.equal((await s.callAs(s.person, "/api/promo", { code: "winter" })).body.error, PROMO_TEXT.again);
    // Разделы — без имён, логинов, chat id; список обращений — без текста.
    for (const p of ADMIN_GET.filter((x) => !x.includes("/tickets/"))) {
      const r = await call(p);
      assert.equal(r.status, 200, p);
      noPrivate(r.body, ["секрет"]);
    }
    const card = await call(`/api/admin/tickets/${t.body.id}`);
    assert.equal(card.body.text, "секрет: не прошла оплата", "текст — только в карточке");
    noPrivate(card.body);
    assert.equal((await call("/api/admin/tickets/99999")).status, 404);
    assert.equal((await call("/api/admin/tickets/99999999999")).status, 404, "больше int4 — 404");
    const ans = await call(`/api/admin/tickets/${t.body.id}/answer`, { text: "Проверила — всё прошло", reason: "ответ" });
    assert.equal(ans.status, 200);
    const feed = (await s.store.noticesAll(s.anya.id, 5)).map((n) => n.text);
    assert.ok(feed.some((x) => x.includes("Проверила — всё прошло")), "ответ — в ленте человека");
    // Переключатель.
    assert.equal((await call("/api/admin/switches", { id: "draw", on: false })).status, 400);
    const sw = await call("/api/admin/switches", { id: "draw", on: false, reason: "дорого" });
    assert.equal(sw.body.switches.find((x: { id: string }) => x.id === "draw").on, false);
    await call("/api/admin/switches", { id: "draw", on: true, reason: "вернула" });
    // Объявление: на сайте человека — плашка; в виджете — строкой в ленту при опросе (after > 0).
    assert.equal((await call("/api/admin/announcements", { text: "Ночью <b>", audience: "all", site: true, reason: "работы" })).status, 400, "без < >");
    assert.equal((await call("/api/admin/announcements", { text: "Ночью обновляю", audience: "all", reason: "работы" })).status, 400, "где показать");
    const an = await call("/api/admin/announcements", { text: "Ночью обновляю сервер", audience: "all", site: true, widget: true, reason: "работы" });
    assert.equal(an.status, 200);
    assert.deepEqual((await s.callAs(s.person, "/api/announcements")).body.map((x: { text: string }) => x.text), ["Ночью обновляю сервер"]);
    await s.callAs(s.person, "/api/notices?after=0");
    assert.ok(!(await s.store.noticesAll(s.anya.id, 10)).some((n) => n.text.includes("Ночью")), "первый опрос — только запоминает место");
    const last = (await s.store.noticesAll(s.anya.id, 1))[0].id;
    const got = await s.callAs(s.person, `/api/notices?after=${last}`);
    assert.ok(got.body.some((n: { text: string }) => n.text === ANNOUNCE_PREFIX + "Ночью обновляю сервер"));
    assert.equal((await call("/api/admin/announcements/toggle", { id: an.body.id, on: false, reason: "сделано" })).status, 200);
    assert.deepEqual((await s.callAs(s.person, "/api/announcements")).body, []);
    // Журнал: каждое действие — с причиной.
    const log = await s.store.adminLog(50);
    for (const a of ["promo_create", "ticket_answer", "switch_off", "switch_on", "announce_create", "announce_off"]) {
      const row = log.find((r) => r.action === a);
      assert.ok(row && row.reason.length >= 3, `${a} с причиной`);
    }
    noPrivate((await call("/api/admin/log")).body, ["секрет", "Проверила", "Ночью"]);
  } finally {
    overrideSwitches([]);
    await s.close();
  }
});

// ——— Исправления этапа 6 (проверка 24.11.2026).
test("выключены «Ответы ИИ»: планировщик без модели (утро, закономерности, итог), фоновый повтор ждёт включения; голосовое — текст голосовых", async () => {
  const store = await sqlite();
  try {
    const p = await people(store);
    const gate = new AiGate(store, { owners: () => [OWNER], clock: () => NOW });
    let llm = 0;
    const sent: { text: string; kind?: string }[] = [];
    const sch = new Scheduler(store, async () => (llm++, "Хороший день."), async (_u, text, _e, _b, kind) => void sent.push({ text, kind }));
    sch.aiFor = (u, now) => gate.allowed(u, now);
    overrideSwitches(["ai"]);
    assert.equal(gate.allowed(p.friend, NOW), false, "и другу фоновые работы без модели");
    await sch.tick(zonedToUtc("2026-11-25", "09:01", TZ));
    await sch.tick(zonedToUtc("2026-11-25", "13:01", TZ));
    await sch.tick(zonedToUtc("2026-11-25", "22:00", TZ));
    assert.equal(llm, 0, "ни утро, ни закономерности, ни итог дня не звали модель");
    assert.ok(sent.some((s) => s.kind === "morning"), "утро пришло");
    assert.ok(sent.some((s) => s.kind === "evening"), "итог пришёл — цифрами");
    // Фоновый повтор: при выключенном ИИ не трогает упавшее сообщение (не тратит попытки и не пишет заметкой).
    const pipe = new Pipeline(store, async () => (llm++, "{}"));
    pipe.gate = gate;
    const { message } = await store.saveMessage({ userId: p.trial.id, source: "telegram", sourceId: "r1", text: "купить хлеб", dayKey: "2026-11-24", at: new Date(NOW.getTime() - 3600_000) });
    await store.setMessage(message.id, { state: "failed", reply: "other" });
    const told: string[] = [];
    for (const m of RETRY_AFTER_MIN) await pipe.retryFailed(async (_u, t) => void told.push(t), new Date(NOW.getTime() + m * 60_000));
    assert.equal((await store.message(message.id))!.state, "failed", "ждёт включения");
    assert.equal(await store.kvGet(`retry:${message.id}`), undefined, "попытки не потрачены");
    assert.deepEqual([llm, told], [0, []]);
    // Голосовое при выключенном ИИ — «напишите текстом», а не «записи работают как обычно» (его заметкой не записать).
    const v = await gate.check(p.trial, { take: { calls: 1, voiceSec: 10 } });
    assert.deepEqual(v.ok ? null : [v.reason, v.text], ["switch_off", switchOffText("voice")]);
    // Включили — модель снова зовётся (у друга — итог со словами горничной).
    overrideSwitches([]);
    await sch.tick(zonedToUtc("2026-11-26", "22:00", TZ));
    assert.ok(llm > 0);
  } finally {
    overrideSwitches([]);
    await store.close();
  }
});

for (const [name, open] of BASES) {
  test(`${name}: промокод — 20 одновременных неверных кодов: к базе идут не больше ${PROMO_TRIES}, остальные 429; друг попыток не тратит`, async () => {
    const store = await open();
    try {
      resetPromoTries();
      const p = await people(store);
      let looked = 0;
      const byCode = store.promoByCode.bind(store);
      store.promoByCode = (c: string) => (looked++, byCode(c));
      const all = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => redeemPromo(store, p.trial, `BADX${i}`, NOW, [OWNER])));
      const st = all.map((x) => (x.status === "rejected" ? (x.reason as { status: number }).status : 200));
      assert.deepEqual([st.filter((s) => s === 404).length, st.filter((s) => s === 429).length], [PROMO_TRIES, 20 - PROMO_TRIES]);
      assert.equal(looked, PROMO_TRIES, "сверено с базой не больше PROMO_TRIES кодов");
      // Отказ по условиям человека попытку не тратит: десять раз разом — 409, не 429.
      const fr = await Promise.allSettled(Array.from({ length: 10 }, () => redeemPromo(store, p.friend, "GOODCODE", NOW, [OWNER])));
      assert.ok(fr.every((x) => x.status === "rejected" && (x.reason as { status: number }).status === 409));
      // Успех и «уже применили» отметку снимают: потом — 409, а не 429.
      await createPromo(store, 1, { code: "GOODCODE", days: 7, max_uses: 10, reason: "акция" }, NOW);
      assert.equal((await redeemPromo(store, p.ended, "GOODCODE", NOW, [OWNER])).days, 7);
      for (let i = 0; i < PROMO_TRIES + 2; i++) {
        await assert.rejects(redeemPromo(store, p.ended, "GOODCODE", NOW, [OWNER]), (x: Error & { status?: number }) => x.status === 409, "уже применил — не 429");
      }
    } finally {
      await store.close();
    }
  });

  test(`${name}: обращения — 10 одновременных: записано ровно ${SUPPORT_PER_DAY}; лимит — на календарный день человека`, async () => {
    const store = await open();
    try {
      const p = await people(store);
      const all = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => createTicket(store, p.trial, { topic: "bug", text: `обращение ${i}` }, NOW)));
      assert.equal(all.filter((x) => x.status === "fulfilled").length, SUPPORT_PER_DAY);
      assert.ok(all.filter((x) => x.status === "rejected").every((x) => (x.reason as { status: number }).status === 429));
      assert.equal((await store.ticketsOf(p.trial.id, 50)).length, SUPPORT_PER_DAY);
      // Три обращения в 22:00–23:00 по Москве — после полуночи «завтра» уже можно.
      for (const t of ["22:00", "22:30", "23:00"]) await createTicket(store, p.paid, { topic: "idea", text: "поздно вечером" }, zonedToUtc("2026-11-24", t, TZ));
      await assert.rejects(createTicket(store, p.paid, { topic: "idea", text: "ещё одно вечером" }, zonedToUtc("2026-11-24", "23:30", TZ)), (e: Error & { status?: number }) => e.status === 429);
      const night = zonedToUtc("2026-11-25", "00:30", TZ);
      assert.equal((await supportOf(store, p.paid, night)).left_today, SUPPORT_PER_DAY);
      assert.ok((await createTicket(store, p.paid, { topic: "idea", text: "уже завтра" }, night)).id > 0);
    } finally {
      await store.close();
    }
  });
}

test("ответ на обращение: Telegram не принял — в журнал «только в ленте», обращение не закрыто; принял — «в Telegram»", async () => {
  const store = await sqlite();
  try {
    const p = await people(store);
    const ids: number[] = [];
    for (let i = 0; i < 2; i++) ids.push((await createTicket(store, p.trial, { topic: "payment", text: `секрет ${i}` }, NOW)).id);
    let ok = false;
    const api = { sendMessage: async () => { if (!ok) throw new Error("403: bot was blocked by the user"); return {}; } } as unknown as StarsApi;
    const billing = new Billing(store, api, { secret: "s" });
    const tell = (x: Parameters<typeof billing.notify>[0], text: string) => billing.notify(x, text, false);
    const bad = await ticketAction({ store, tell }, 1, ids[0], "answer", { text: "Проверила", close: true, reason: "ответ по оплате" }, NOW);
    assert.deepEqual([bad.delivered, bad.status], ["feed_tg_failed", "work"], "не закрыто: человек мог не увидеть");
    assert.match((await store.adminLog(1))[0].detail, /Telegram не принял — ответ только в ленте/);
    assert.ok((await store.noticesAll(p.trial.id, 5)).some((n) => n.text.includes("Проверила")), "в ленте есть");
    ok = true;
    const good = await ticketAction({ store, tell }, 1, ids[1], "answer", { text: "Готово", close: true, reason: "ответ по оплате" }, NOW);
    assert.deepEqual([good.delivered, good.status], ["telegram", "closed"]);
    assert.match((await store.adminLog(1))[0].detail, /ответ ушёл в Telegram, закрыто/);
    // Без бота (нет api) — тоже не «в Telegram».
    const noBot = new Billing(store, null, { secret: "s" });
    assert.deepEqual(await noBot.notify(p.trial, "x", false), { feed: true, telegram: false });
  } finally {
    await store.close();
  }
});

test("объявление в виджет человеку с пустой лентой: первый опрос получает метку места, объявление и первое письмо — показываются", async () => {
  const s = await stand();
  try {
    const other = await s.store.createUser({ login: "zoya", passwordHash: "x", tz: TZ, chatId: "19", plan: "friend" });
    const before = await s.store.addNotice(other.id, "чужое письмо", "neutral");
    const first = await s.callAs(s.person, "/api/notices?after=0");
    assert.deepEqual(first.body.map((n: { id: number; text: string; kind: string }) => [n.id, n.text, n.kind]), [[before, "", "cursor"]], "только номер, без чужого текста");
    await s.store.addAnnouncement({ text: "Ночью обновляю сервер", audience: "all", site: false, widget: true, ends_at: null, at: new Date(), by: 1 });
    resetAnnounceCache();
    const got = await s.callAs(s.person, `/api/notices?after=${first.body[0].id}`);
    assert.deepEqual(got.body.map((n: { text: string }) => n.text), [ANNOUNCE_PREFIX + "Ночью обновляю сервер"]);
    const id = await s.store.addNotice(s.anya.id, "первое обычное письмо", "neutral");
    const next = await s.callAs(s.person, `/api/notices?after=${got.body[0].id}`);
    assert.deepEqual(next.body.map((n: { id: number }) => n.id), [id]);
  } finally {
    await s.close();
  }
});

test(`прогноз: мало данных — среднее по дням с данными, без прямой и дней до потолка (меньше ${PROGNOSIS_MIN_DAYS} дн.)`, async () => {
  const store = await sqlite();
  try {
    await loadTariffs(store);
    const p = await people(store);
    // 3 дня из 30, расход растёт: $1, $2, $3.
    for (let i = 1; i <= 3; i++) await store.addUsage(new Date(NOW.getTime() - i * DAY), { kind: "parse", model: "m", input: 1, output: 1, cost: 4 - i, userId: p.trial.id });
    const f = await prognosisView(store, NOW);
    assert.equal(f.spend.data_days, 3);
    assert.ok(Math.abs(f.spend.month.by30 - 2 * 30) < 1e-6, "по 3 дням: в среднем $2 в день → $60, а не $6");
    assert.ok(Math.abs(f.spend.month.by7 - 2 * 30) < 1e-6);
    assert.deepEqual([f.spend.slope_per_day, f.spend.days_to_alert, f.trial_pool.days_to_cap], [0, null, null], "мало данных — без прямой");
    assert.equal(f.min_days, PROGNOSIS_MIN_DAYS);
  } finally {
    await store.close();
  }
  const flat = await sqlite();
  try {
    await loadTariffs(flat);
    const p = await people(flat);
    // 10 дней по $1: месяц — $30, прямая ровная (нули до запуска в счёт не идут).
    for (let i = 1; i <= 10; i++) await flat.addUsage(new Date(NOW.getTime() - i * DAY), { kind: "parse", model: "m", input: 1, output: 1, cost: 1, userId: p.trial.id });
    const f = await prognosisView(flat, NOW);
    assert.equal(f.spend.data_days, 10);
    assert.ok(Math.abs(f.spend.month.by30 - 30) < 1e-6, "$30, а не $10");
    assert.ok(Math.abs(f.spend.slope_per_day) < 1e-9, "расход не растёт");
    assert.equal(f.spend.days_to_alert, null);
  } finally {
    await flat.close();
  }
});
