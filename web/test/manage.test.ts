import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Маленькое хранилище вместо localStorage браузера (закрытые объявления).
const mem = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k),
};

const {
  ADMIN_ACTIONS, ADMIN_GROUPS, ADMIN_SECTIONS, adminNavGroups, adminSection, capDaysText, fewDataText, growTitle, newsTextError, promoCodeError, promoStateText, ticketAnswerText, TICKET_STATUS_NAMES, waitText,
} = await import("../src/admin.ts");
const { closedNews, closeNews, MY_TICKET_STATUS, NEWS_KEY, promoInput, visibleNews } = await import("../src/announce.ts");
const { promoAllowed } = await import("../src/billing.ts");
const { NewsPage, PrognosisPage, PromoPage, SwitchesPage, TicketCardPage, TicketsPage } = await import("../src/screens/AdminManage.tsx");
const { NewsList } = await import("../src/NewsBar.tsx");
const { SupportView } = await import("../src/screens/Support.tsx");

// Этап 6 «Тарифы и управление»: меню, подписи журнала, помощники и рендер разделов по готовым данным (без сети).

const NOW = new Date("2026-11-24T12:00:00Z");
const noop = () => {};

test("админка, этап 6: разделы в своих категориях, «Связь с людьми» — перед «Системой», подписи действий", () => {
  const where: Record<string, string> = { promo: "Люди и деньги", prognosis: "Люди и деньги", switches: "Продукт", tickets: "Связь с людьми", news: "Связь с людьми" };
  for (const [id, group] of Object.entries(where)) {
    assert.equal(adminSection(id), id);
    assert.equal(ADMIN_SECTIONS.find((s) => s.id === id)!.group, group, id);
  }
  assert.ok(ADMIN_GROUPS.indexOf("Связь с людьми") === ADMIN_GROUPS.indexOf("Система") - 1);
  assert.deepEqual(adminNavGroups().find((g) => g.group === "Связь с людьми")!.items.map((s) => s.id), ["tickets", "news"]);
  for (const a of ["switch_on", "switch_off", "promo_create", "promo_on", "promo_off", "ticket_status", "ticket_answer", "announce_create", "announce_on", "announce_off"]) assert.ok(ADMIN_ACTIONS[a], a);
});

test("помощники: состояние кода, проверка кода и текста, ожидание, дни до потолка, статусы", () => {
  assert.deepEqual(promoStateText("on"), { text: "работает", tone: "ok" });
  assert.equal(promoStateText("empty").text, "кончился");
  assert.equal(promoStateText("ended").text, "срок вышел");
  assert.equal(promoStateText("off").tone, "warn");
  assert.equal(promoCodeError(""), null, "пусто — сгенерировать");
  assert.equal(promoCodeError("spring-26"), null);
  assert.ok(promoCodeError("ой"));
  assert.ok(promoCodeError("ABC"), "меньше 4 знаков");
  assert.equal(newsTextError("Ночью обновляю сервер"), null);
  assert.equal(newsTextError("  "), "напишите текст");
  assert.equal(newsTextError("<b>"), "без знаков < и >");
  assert.equal(newsTextError("две\nстроки"), "одной строкой");
  assert.equal(newsTextError("я".repeat(201)), "не длиннее 200 знаков");
  assert.equal(waitText(null, NOW), "—");
  assert.equal(waitText("2026-11-24T11:55:00Z", NOW), "5 мин");
  assert.equal(waitText("2026-11-24T09:00:00Z", NOW), "3 ч");
  assert.equal(waitText("2026-11-21T12:00:00Z", NOW), "3 д");
  assert.equal(capDaysText(null), "не упрёмся при нынешнем темпе");
  assert.equal(capDaysText(0), "уже на потолке");
  assert.equal(capDaysText(12), "через 12 дн.");
  assert.equal(fewDataText(3, 7), "мало данных: 3 дн.");
  assert.equal(fewDataText(7, 7), null);
  assert.equal(growTitle(0.02), "Расход за день растёт на");
  assert.equal(growTitle(-0.03), "Расход за день снижается на");
  assert.equal(ticketAnswerText("telegram"), "Ответ ушёл в Telegram и в уведомления.");
  assert.match(ticketAnswerText("feed_tg_failed"), /Telegram не принял/);
  assert.equal(ticketAnswerText("feed"), "Ответ ушёл в уведомления.");
  assert.equal(TICKET_STATUS_NAMES.work, "в работе");
  assert.equal(MY_TICKET_STATUS.new, "получено");
});

test("сайт: закрытые объявления запоминаются на устройстве; промокод из поля; поле промокода — только где код поможет", () => {
  mem.clear();
  assert.deepEqual(closedNews(), []);
  closeNews(3);
  closeNews(3);
  closeNews(5);
  assert.deepEqual(closedNews(), [3, 5]);
  assert.deepEqual(visibleNews([{ id: 5, text: "б" }, { id: 7, text: "в" }, { id: 3, text: "а" }, { id: 6, text: "г" }], closedNews()).map((n) => n.id), [6, 7]);
  mem.set(NEWS_KEY, "не json");
  assert.deepEqual(closedNews(), [], "битое хранилище — как пустое");
  assert.equal(promoInput(" spring 26 "), "SPRING26");
  assert.equal(promoInput("ой"), null);
  const base = { until: null, canceled: false, trial_left_days: 3 };
  assert.equal(promoAllowed({ ...base, plan: "trial" }), true);
  assert.equal(promoAllowed({ ...base, plan: "expired" }), true);
  assert.equal(promoAllowed({ ...base, plan: "paid" }), false, "подписка с продлением");
  assert.equal(promoAllowed({ ...base, plan: "paid", canceled: true }), true);
  for (const plan of ["owner", "friend", "frozen"] as const) assert.equal(promoAllowed({ ...base, plan }), false, plan);
  assert.equal(promoAllowed(undefined), false);
});

test("рендер: переключатели, промокоды, прогноз", () => {
  const sw = renderToStaticMarkup(createElement(SwitchesPage, {
    data: { reload_ms: 60_000, env_closed: true, switches: [
      { id: "draw", title: "Картинки", hint: "дорого", off_text: "Картинки ненадолго выключены — остальное работает как обычно.", on: false, updated_at: "2026-11-24T10:00:00Z", updated_by: "#1" },
      { id: "voice", title: "Голосовые", hint: "", off_text: "Голосовые выключены", on: true, updated_at: null, updated_by: null },
    ] }, onChanged: noop, note: null, setNote: noop,
  }));
  assert.match(sw, /Картинки ненадолго выключены/);
  assert.match(sw, />Включить</);
  assert.match(sw, />Выключить</);
  assert.match(sw, /SIGNUPS_OPEN=0/);
  assert.match(sw, /Причина/);
  const pr = renderToStaticMarkup(createElement(PromoPage, {
    data: { days_max: 365, uses_max: 100_000, tries: 5, window_min: 15, codes: [
      { id: 1, code: "RINA30", days: 30, used: 14, max_uses: 50, ends_at: "2026-12-31T23:59:59.999Z", created_at: "2026-11-24T10:00:00Z", created_by: "#1", state: "on" },
      { id: 2, code: "BETA", days: 14, used: 20, max_uses: 20, ends_at: null, created_at: "2026-11-01T10:00:00Z", created_by: "#1", state: "empty" },
    ] }, onChanged: noop, note: { ok: true, text: "Код RINA30 создан. Записано в журнал админа." }, setNote: noop,
  }));
  assert.match(pr, /RINA30/);
  assert.match(pr, /14 \/ 50/);
  assert.match(pr, /31\.12\.2026/);
  assert.match(pr, /кончился/);
  assert.match(pr, /без срока/);
  assert.match(pr, /Записано в журнал админа/);
  const prognosis = {
    days: 30, star_usd: 0.013, min_days: 7,
    spend: { month: { by7: 30, by30: 18.5, data_days: 30 }, today: 0.4, data_days: 30, slope_per_day: 0.02, trend_last: 1, alert_cap: 8, days_to_alert: 350 },
    trial_pool: { cap: 10, today: 0.4, data_days: 30, slope_per_day: 0.02, trend_last: 1, days_to_cap: 5 },
    income: { stars: { by7: 642.9, by30: 150, data_days: 30 }, usd: { by7: 8.36, by30: 1.95 } },
    renewals: { n: 1, stars: 150, usd: 1.95, ending_without_renew: 1, by_day: [{ day: "2026-12-04", n: 1, stars: 150 }] },
    series: [{ day: "2026-11-23", cost: 1, trial: 1, stars: 150 }],
  };
  const fc = renderToStaticMarkup(createElement(PrognosisPage, { data: prognosis }));
  assert.match(fc, /\$30\.00 · \$18\.50/);
  assert.match(fc, /через 5 дн\./);
  assert.match(fc, /04\.12\.2026/);
  assert.match(fc, /без продления кончится: 1/);
  assert.match(fc, /Расход за день растёт на/);
  // Расход падает — «снижается на» без минуса; мало данных — вместо прямой и дней до потолка.
  const down = renderToStaticMarkup(createElement(PrognosisPage, { data: { ...prognosis, spend: { ...prognosis.spend, slope_per_day: -0.03 } } }));
  assert.match(down, /Расход за день снижается на/);
  assert.ok(!/растёт на/.test(down) && !/−\$0\.03/.test(down), "без «растёт на −$0,03»");
  const few = renderToStaticMarkup(createElement(PrognosisPage, { data: { ...prognosis, spend: { ...prognosis.spend, data_days: 3, days_to_alert: null }, trial_pool: { ...prognosis.trial_pool, data_days: 3, days_to_cap: null } } }));
  assert.match(few, /мало данных: 3 дн\./);
  assert.match(few, /данных 3 дн\./);
});

test("рендер: обращения — список без текста, карточка с текстом и ответом; объявления — предпросмотр; плашка и «Написать нам»", () => {
  const topics = { payment: "Оплата и подписка", bug: "Что-то не работает" };
  const list = renderToStaticMarkup(createElement(TicketsPage, {
    data: { per_day: 3, topics, counts: { new: 1, work: 1, week: 2, oldest_open: "2026-11-22T12:00:00Z", answer_hours: 5.2 }, tickets: [
      { id: 58, account: "#1201", user_id: 1201, topic: "payment", status: "new", created_at: "2026-11-24T10:00:00Z", updated_at: "2026-11-24T10:00:00Z", answered: false },
      { id: 57, account: "#1042", user_id: 1042, topic: "bug", status: "work", created_at: "2026-11-22T12:00:00Z", updated_at: "2026-11-23T12:00:00Z", answered: true },
    ] }, onOpen: noop, now: NOW,
  }));
  assert.match(list, /#1201/);
  assert.match(list, /Оплата и подписка/);
  assert.match(list, /новое/);
  assert.match(list, /2 д/);
  assert.match(list, /5 ч/);
  const card = renderToStaticMarkup(createElement(TicketCardPage, {
    card: { id: 58, account: "#1201", user_id: 1201, topic: "payment", status: "closed", text: "Не прошла оплата", answer: "Проверила", created_at: "2026-11-24T10:00:00Z", updated_at: "2026-11-24T10:00:00Z", answered_at: "2026-11-24T11:00:00Z", plan: "trial", telegram: false },
    topics, onBack: noop, onChanged: noop, note: null, setNote: noop,
  }));
  assert.match(card, /Не прошла оплата/);
  assert.match(card, /Проверила/);
  assert.match(card, /только в уведомления/);
  assert.match(card, /Открыть снова/);
  const news = renderToStaticMarkup(createElement(NewsPage, {
    data: { text_max: 200, audiences: { all: "всем", trial: "на пробе и подарке", paid: "подписчикам" }, cache_ms: 60_000, people: { all: 399, trial: 64, paid: 118 }, items: [
      { id: 2, text: "Ночью обновляю сервер", audience: "all", site: true, widget: true, enabled: true, ends_at: null, live: true, created_at: "2026-11-24T10:00:00Z", created_by: "#1", widget_got: 12 },
    ] }, onChanged: noop, note: null, setNote: noop,
  }));
  assert.match(news, /Плашка на сайте/);
  assert.match(news, /примерно 399 чел\./);
  assert.match(news, /показывается/);
  assert.match(news, />12</);
  const bar = renderToStaticMarkup(createElement(NewsList, { items: [{ id: 1, text: "Ночью обновляю сервер" }], onClose: noop }));
  assert.match(bar, /Ночью обновляю сервер/);
  assert.match(bar, /Закрыть объявление/);
  assert.equal(renderToStaticMarkup(createElement(NewsList, { items: [], onClose: noop })), "");
  const sup = renderToStaticMarkup(createElement(SupportView, {
    info: { topics: [{ id: "bug", title: "Что-то не работает" }], per_day: 3, left_today: 0, text_max: 2000, tickets: [
      { id: 7, topic: "bug", text: "окно пропало", status: "closed", created_at: "2026-11-24T10:00:00Z", answer: "Исправили в 0.1.93", answered_at: "2026-11-24T11:00:00Z" },
    ] }, onSent: noop,
  }));
  assert.match(sup, /Написать нам/);
  assert.match(sup, /новое можно завтра/);
  assert.match(sup, /Исправили в 0\.1\.93/);
  assert.match(sup, /закрыто/);
});
