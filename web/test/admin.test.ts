import assert from "node:assert/strict";
import { test } from "node:test";
import { accountCan, accountIdOf, accountPlanText, accountQuery, adminNavGroups, ADMIN_GROUPS, ADM_WEEKDAYS, ADMIN_ACTIONS, ADMIN_LIVE_STAGE, ADMIN_SECTIONS, adminSection, ago, BILLING_EVENT_NAMES, CLIENT_NAMES, ERROR_NAMES, msText, ROUTE_NAMES, sortRows, uptimeText, usd, usedText } from "../src/admin.ts";
import { planView } from "../src/billing.ts";

// Этап 2: раздел «Здоровье сервера» живой; подписи клиентов, веток и ошибок; время ответа и работы сервера.
test("админка, этап 2: «Здоровье» живое, подписи и форматы", () => {
  assert.equal(adminSection("health"), "health");
  const health = ADMIN_SECTIONS.find((s) => s.id === "health")!;
  assert.ok(health.stage <= ADMIN_LIVE_STAGE, "Здоровье — не «появится»");
  for (const id of ["users", "spend", "audience", "quality"]) assert.ok(ADMIN_SECTIONS.find((s) => s.id === id)!.stage <= ADMIN_LIVE_STAGE, id);
  for (const c of ["web", "desktop", "widget", "quick", "iphone", "telegram-widget", "telegram", "other"]) assert.ok(CLIENT_NAMES[c], c);
  for (const r of ["weather", "chat", "parse", "clarify", "draw", "answer", "talk", "apply", "correct"]) assert.ok(ROUTE_NAMES[r], r);
  for (const e of ["timeout", "net", "http_429", "http_5xx", "http_4xx", "bad_body", "empty", "no_key", "other"]) assert.ok(ERROR_NAMES[e], e);
  assert.equal(ADM_WEEKDAYS.length, 7);
  assert.equal(msText(null), "—");
  assert.equal(msText(840), "840 мс");
  assert.equal(msText(12_300), "12.3 с");
  assert.equal(uptimeText(45), "45 с");
  assert.equal(uptimeText(12 * 60 + 5), "12 мин");
  assert.equal(uptimeText(3 * 3600 + 5 * 60), "3 ч 5 мин");
  assert.equal(uptimeText(2 * 86400 + 4 * 3600), "2 дн. 4 ч");
});

// Разделы админки по адресу /admin/<раздел> (web/src/admin.ts).
test("админка: раздел по адресу, незнакомый — Обзор; журнал подписан", () => {
  assert.equal(adminSection(undefined), "overview");
  assert.equal(adminSection("log"), "log");
  assert.equal(adminSection("nope"), "overview");
  assert.equal(new Set(ADMIN_SECTIONS.map((s) => s.id)).size, ADMIN_SECTIONS.length);
  for (const a of ["code", "enter", "wrong", "leave"]) assert.ok(ADMIN_ACTIONS[a], a);
});

// Этап 1: сортировка таблицы людей, деньги, «когда».
test("админка: сортировка таблицы, деньги и «когда»", () => {
  const rows = [{ name: "Боря", cost: 0.5 }, { name: "Аня", cost: 2 }, { name: "Вера", cost: 0 }];
  assert.deepEqual(sortRows(rows, "cost", true).map((r) => r.name), ["Аня", "Боря", "Вера"]);
  assert.deepEqual(sortRows(rows, "name", false).map((r) => r.name), ["Аня", "Боря", "Вера"]);
  assert.equal(usd(0), "$0");
  assert.equal(usd(0.0123), "$0.012");
  assert.equal(usd(1.5), "$1.50");
  const now = new Date("2026-11-24T12:00:00Z");
  assert.equal(ago(null, now), "—");
  assert.equal(ago("2026-11-23T10:00:00Z", now), "вчера");
  assert.equal(ago("2026-11-14T12:00:00Z", now), "10 дн. назад");
});

test("меню админки: каждый раздел в своей категории, с иконкой, без пустых категорий, порядок — по ADMIN_GROUPS", async () => {
  const { readFileSync } = await import("node:fs");
  const icons = readFileSync(new URL("../src/icons.tsx", import.meta.url), "utf8");
  const nav = adminNavGroups();
  assert.deepEqual(nav.map((g) => g.group), [...ADMIN_GROUPS]);
  assert.equal(nav.flatMap((g) => g.items).length, ADMIN_SECTIONS.length, "все разделы в меню, ни один не потерян");
  for (const s of ADMIN_SECTIONS) assert.ok(icons.includes(`"${s.icon}":`), `иконка ${s.icon} есть в icons.tsx`);
  assert.deepEqual(nav[0].items.map((s) => s.id), ["overview", "analytics"]);
});

// Этап 3 «Тарифы и управление»: раздел «Аккаунт» по адресу /admin/account/<номер>, подписи журнала и карточки.
test("админка, этап 3: «Аккаунт» — номер из адреса и поиска, подписи действий и журнала подписки, что можно сделать", () => {
  assert.equal(adminSection("account"), "account");
  const acc = ADMIN_SECTIONS.find((s) => s.id === "account")!;
  assert.ok(acc.stage <= ADMIN_LIVE_STAGE && acc.group === "Люди и деньги");
  assert.equal(accountIdOf("/admin/account/1042"), 1042);
  assert.equal(accountIdOf("/admin/account/"), null);
  assert.equal(accountIdOf("/admin/account/abc"), null);
  assert.equal(accountIdOf("/admin/users"), null);
  assert.equal(accountQuery(" #1042 "), 1042);
  assert.equal(accountQuery("1042"), 1042);
  assert.equal(accountQuery("0"), null);
  assert.equal(accountQuery("Аня"), null, "по имени не ищем — только номер");
  for (const a of ["extend", "grant", "bonus", "freeze", "unfreeze", "refund", "refund-fail", "tariff", "paysupport-answer"]) assert.ok(ADMIN_ACTIONS[a], a);
  for (const k of ["paid_first", "paid_once", "renewed", "canceled", "resumed", "refunded", "expired", "trial_ended", "gift_ended", "trial_started", "gift", "admin_extend", "admin_grant"]) {
    assert.ok(BILLING_EVENT_NAMES[k], k);
  }
  const base = { kind: null, until: "2026-12-01T00:00:00Z", canceled: false, ended: null } as const;
  assert.match(accountPlanText({ ...base, plan: "paid", kind: "paid" }), /^Подписка до /);
  assert.match(accountPlanText({ ...base, plan: "trial", kind: "gift" }), /^Подарок до /);
  assert.match(accountPlanText({ ...base, plan: "trial", kind: "trial" }), /^Проба до /);
  assert.equal(accountPlanText({ ...base, plan: "frozen" }), "Заморожен");
  assert.match(accountPlanText({ ...base, plan: "expired", ended: "paid" }), /Срок кончился \(подписка\)/);
  assert.equal(usedText({ used: 37, limit: 420, bonus: 20 }), "37 из 420 (+20)");
  assert.equal(usedText({ used: 120, limit: 600, bonus: 0 }, true), "2 из 10 мин");
  const card = { plan: "trial", kind: "trial", live_sub: false, frozen_at: null, protected: false } as const;
  assert.deepEqual(accountCan(card), { extend: true, grant: true, bonus: true, freeze: true, unfreeze: false });
  assert.equal(accountCan({ ...card, plan: "paid", kind: "paid", live_sub: true }).grant, false, "поверх оплаченной подписки подарок не выдать");
  assert.deepEqual(accountCan({ ...card, plan: "owner", kind: null, protected: true }), { extend: false, grant: false, bonus: false, freeze: false, unfreeze: false });
  assert.deepEqual(accountCan({ ...card, plan: "frozen", kind: null, frozen_at: "2026-11-24T00:00:00Z" }), { extend: false, grant: false, bonus: false, freeze: false, unfreeze: true }, "замороженному — сначала разморозить");
  assert.equal(accountCan({ ...card, plan: "paid", kind: "paid", live_sub: false }).grant, false, "подписка с отменённым продлением ещё идёт — подарок не выдать");
  const v = planView({ plan: "frozen", until: null, canceled: false, trial_left_days: null });
  assert.deepEqual([v.title, v.pay, v.cancel, v.resume], ["Приостановлен", false, false, false], "замороженному не предлагаем оплату");
});

test("админка, этап 3: карточка аккаунта рисуется — номер, тариф, сегодня, оплаты, действия; без имён", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { AccountCardView } = await import("../src/screens/AdminAccount.tsx");
  const card = {
    id: 1042, created_at: "2026-10-03T10:00:00Z", days_with_us: 52, plan: "paid", kind: "paid", until: "2026-12-01T00:00:00Z", canceled: false,
    live_sub: true, frozen_at: null, protected: false, ended: null,
    today: { day: "2026-11-24", resets_at: "2026-11-24T21:00:00Z", calls: { used: 37, limit: 420, bonus: 20 }, draws: { used: 2, limit: 20, bonus: 0 }, voice_sec: { used: 60, limit: 3600, bonus: 0 }, spend_usd: 0.05, cap_usd: 0.5 },
    payments: [{ charge: "…12345678", amount: 150, currency: "XTR", kind: "first", paid_at: "2026-11-01T10:00:00Z", expires_at: "2026-12-01T00:00:00Z", refunded_at: null, refundable: true }],
    events: [{ at: "2026-11-01T10:00:00Z", kind: "paid_first", amount: 150 }, { at: "2026-11-20T10:00:00Z", kind: "admin_extend", amount: null }],
    week: Array.from({ length: 7 }, (_, i) => ({ day: `2026-11-${18 + i}`, ai: i, manual: 1, minutes: 10, calls: i * 2, usd: 0.01 })),
    devices: [{ client: "widget", version: "0.1.92", last_seen: "2026-11-24T11:00:00Z", count: 1 }],
    last_seen: "2026-11-24T11:00:00Z",
    log: [{ at: "2026-11-20T10:00:00Z", who: "#1", action: "extend", detail: "#1042 +7 дн. → до 2026-12-08", reason: "сбой оплаты" }],
  } as const;
  const html = renderToStaticMarkup(createElement(AccountCardView, { card: card as never, onCard: () => {} }));
  for (const want of ["#1042", "Подписка до", "37 из 420 (+20)", "⭐150", "…12345678", "Первая оплата подписки", "Админ продлил срок", "Продлить срок", "Выдать подарок", "Поднять лимит на сегодня", "Вернуть звёзды", "Заморозить аккаунт", "продлил срок", "сбой оплаты"]) {
    assert.ok(html.includes(want), `нет «${want}»`);
  }
  assert.ok(!html.includes("Разморозить"), "не заморожен — кнопки «Разморозить» нет");
});
