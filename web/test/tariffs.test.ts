import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ADMIN_ACTIONS, ADMIN_SECTIONS, adminNavGroups, adminSection } from "../src/admin.ts";
import { planView } from "../src/billing.ts";
import {
  changeText, checkTariffValue, fromInput, money, PART_KEYS, TARIFF_KEYS, tariffDiff, tariffWarnings, toInput, undoPreview, type TariffsData,
  type TariffValues,
} from "../src/tariffs.ts";
import { TariffsPage, UndoPreview } from "../src/screens/AdminTariffs.tsx";

// Разделы «Тарифы» и «Общие потолки» (24.11.2026, этап 1): web/src/tariffs.ts и screens/AdminTariffs.tsx рисуются из подставного
// ответа GET /api/admin/tariffs, без сервера. Что проверка на сайте совпадает с серверной — server/test/tariffs.test.ts.

const DEF: TariffValues = {
  price: 150, trialDays: 7, giftDays: 30, signupsOpen: true, signupsPerHour: 30, signupsPerDay: 150, aiBurst: 10, aiWindowMs: 60_000,
  trialDayUsd: 0.3, paidDayUsd: 1.5, trialPoolDayUsd: 10, unpricedDrawUsd: 0.03, unpricedVoiceUsd: 0.005, unpricedOtherUsd: 0.003, starUsd: 0.013,
};
const none = { people: 0, spenders: 0, avg_month_usd: null, worst_month_usd: null, worst_day_usd: null, capped_days: 0 };
const DATA: TariffsData = {
  values: DEF, defaults: DEF, overridden: [], reload_ms: 60_000,
  history: [{ id: 3, at: "2026-11-24T10:00:00Z", who: "#1", source: "admin", reason: "пробуем цену", changes: [{ key: "price", from: 120, to: 150 }] }],
  economy: { trial: none, paid: { people: 4, spenders: 3, avg_month_usd: 0.8, worst_month_usd: 2.4, worst_day_usd: 1.1, capped_days: 0 } },
  now: { trial_pool_today_usd: 3.4, signups_hour: 4, signups_day: 23 },
};
const noop = async () => null;
const page = (part: "plans" | "caps", draft?: Partial<TariffValues>, data = DATA) =>
  renderToStaticMarkup(createElement(TariffsPage, { data, part, onApply: noop, onUndo: noop, draft }));

test("меню: «Тарифы» и «Общие потолки» — в «Люди и деньги» после «Оплат», с иконками; журнал подписан", () => {
  const g = adminNavGroups().find((x) => x.group === "Люди и деньги")!;
  assert.deepEqual(g.items.map((s) => s.id), ["users", "payments", "tariffs", "caps", "audience"]);
  assert.equal(adminSection("tariffs"), "tariffs");
  assert.equal(adminSection("caps"), "caps");
  assert.deepEqual(ADMIN_SECTIONS.filter((s) => s.id === "tariffs" || s.id === "caps").map((s) => s.icon), ["adm-tag", "adm-gauge"]);
  assert.ok(ADMIN_ACTIONS.tariff && ADMIN_ACTIONS.tariff_undo);
});

test("поля: окно частоты в секундах ↔ миллисекунды сервера; ошибка — та же проверка, что на сервере", () => {
  assert.equal(toInput("aiWindowMs", 60_000), "60");
  assert.deepEqual(fromInput("aiWindowMs", "30"), { value: 30_000, error: null });
  assert.deepEqual(fromInput("trialDayUsd", "0,5"), { value: 0.5, error: null }, "запятая — как точка");
  assert.equal(fromInput("price", "-1").error, checkTariffValue("price", -1));
  assert.match(fromInput("price", "1.5").error!, /целое/);
  assert.match(fromInput("price", "").error!, /нужно число/);
  assert.match(fromInput("aiWindowMs", "0").error!, /не меньше 1000/);
  assert.match(fromInput("aiWindowMs", "0.5").error!, /целые секунды/);
  assert.match(fromInput("trialDays", "400").error!, /не больше 365/);
  assert.deepEqual([...PART_KEYS.plans, ...PART_KEYS.caps].sort(), [...TARIFF_KEYS].sort(), "каждое поле — ровно в одном разделе");
});

test("изменения и предупреждения: потолок подписки больше выручки, новая цена — только для новых, подарок по лимитам пробы", () => {
  const d = { ...DEF, price: 200 };
  assert.deepEqual(tariffDiff(d, DEF), [{ key: "price", from: 150, to: 200 }]);
  assert.equal(changeText({ key: "price", from: 150, to: 200 }), "Подписка: цена: 150 ⭐ / 30 дн. → 200 ⭐ / 30 дн.");
  assert.equal(changeText({ key: "aiWindowMs", from: 60_000, to: 30_000 }), "Окно частоты: 60 с → 30 с");
  const w = tariffWarnings(d, DEF, "plans");
  // $1.50 × 30 = $45 > 200 ⭐ × $0.013 = $2.60 — при нынешних числах это правда.
  assert.equal(w[0].kind, "bad");
  assert.match(w[0].text, /\$45\.00.*\$2\.60/);
  assert.ok(w.some((x) => /только для новых счетов/.test(x.text)));
  assert.ok(w.some((x) => /Подарок по \/invite сейчас живёт по лимитам пробы/.test(x.text)));
  assert.ok(!tariffWarnings({ ...DEF, paidDayUsd: 0.05 }, DEF, "plans").some((x) => x.kind === "bad"), "потолок $1.50 за месяц < выручки — без красного");
  const c = tariffWarnings({ ...DEF, signupsOpen: false, signupsPerDay: 10, trialPoolDayUsd: 0.1 }, DEF, "caps");
  assert.equal(c.length, 3);
  assert.equal(money(null), "—");
  assert.equal(money(0.012), "$0.012");
});

test("«Тарифы»: карточки с полями и единицами, экономика из данных, нет данных — «—», история с откатом; без изменений — плашки нет", () => {
  const html = page("plans");
  for (const s of ["Проба", "Подписка", "Подарок по /invite", "Друзья и владелец", "⭐ / 30 дн.", "$/день", "Вернуть как было", "пробуем цену", "#1"]) assert.ok(html.includes(s), s);
  assert.ok(html.includes("Telegram продлевает по цене при оформлении"), "подсказка у цены");
  assert.ok(html.includes("$0.80"), "средний расход подписчика из ответа");
  assert.ok(html.includes("Проба в среднем стоит"));
  assert.match(html, /Проба в среднем стоит<\/span><b class="adm-num ">—<\/b>/, "у пробы данных нет — «—»");
  assert.ok(!html.includes("Не применено"), "без изменений плашки нет");
  assert.ok(!html.includes("Регистраций в час"), "общие потолки — в своём разделе");
});

test("плашка изменений: что поменялось, причина, «Применить» выключено без причины; ошибка в поле — применить нельзя", () => {
  const html = page("plans", { price: 200 });
  assert.ok(html.includes("Не применено: 1"));
  assert.ok(html.includes("Подписка: цена: 150 ⭐ / 30 дн. → 200 ⭐ / 30 дн."));
  assert.match(html, /<button class="adm-btn primary" disabled="">Применить<\/button>/, "без причины — выключено");
  assert.ok(html.includes("Сбросить"));
  assert.ok(html.includes("adm-tf-num ch"), "изменённое поле подсвечено");
  const bad = page("plans", { price: -5 });
  assert.ok(bad.includes("Есть ошибки в полях"));
  assert.ok(bad.includes("price: не меньше 1"));
});

test("«Общие потолки»: регистрация, частота, деньги, заполненность сейчас; по умолчанию — подпись у изменённого", () => {
  const data = { ...DATA, values: { ...DEF, signupsPerHour: 40 }, overridden: ["signupsPerHour"] };
  const html = page("caps", undefined, data);
  for (const s of ["Регистрация новых", "открыта", "Регистраций в час", "Окно частоты", "Общий потолок проб", "Рисунок без цены", "4 из 40", "23 из 150", "$3.40 из $10.00", "по умолчанию: 30 на сервер"]) {
    assert.ok(html.includes(s), s);
  }
  assert.ok(!html.includes("Подарок по /invite"));
  assert.ok(page("caps", { signupsOpen: false }).includes("Регистрация закрыта"), "предупреждение о закрытой регистрации");
});

test("блок «Тариф» на сайте: цена — из /api/me (тарифы из базы), старый сервер без цены — 150", () => {
  assert.match(planView({ plan: "expired", until: null, canceled: false, trial_left_days: null, price: 250 }).text, /⭐250/);
  assert.match(planView({ plan: "expired", until: null, canceled: false, trial_left_days: null }).text, /⭐150/);
});

test("денежный потолок 0 и имена из прототипа — ошибка в поле (как на сервере)", () => {
  for (const k of ["paidDayUsd", "trialDayUsd", "trialPoolDayUsd"] as const) assert.match(fromInput(k, "0").error!, /не меньше 0.01/, k);
  assert.equal(fromInput("paidDayUsd", "0.01").error, null);
  for (const k of ["constructor", "toString", "__proto__", "hasOwnProperty"]) assert.match(checkTariffValue(k, 5) ?? "", /неизвестное поле/, k);
  assert.match(page("plans", { paidDayUsd: 0 }), /Есть ошибки в полях/);
});

test("SIGNUPS_OPEN=0 в .env сервера — красное предупреждение в «Общих потолках»; старый сервер без поля — нет", () => {
  const w = tariffWarnings(DEF, DEF, "caps", true);
  assert.equal(w[0].kind, "bad");
  assert.match(w[0].text, /SIGNUPS_OPEN=0/);
  assert.ok(page("caps", undefined, { ...DATA, env_closed: true }).includes("SIGNUPS_OPEN=0"));
  assert.ok(!page("caps").includes("SIGNUPS_OPEN=0"));
});

test("«Вернуть как было»: перед откатом видно, что изменится (только поля строки), и какие более поздние строки трогали те же поля", () => {
  const history: TariffsData["history"] = [
    { id: 5, at: "2026-11-24T12:00:00Z", who: "владелец (бот)", source: "bot", reason: "наплыв", changes: [{ key: "signupsOpen", from: true, to: false }] },
    { id: 4, at: "2026-11-24T11:00:00Z", who: "#1", source: "admin", reason: "ещё", changes: [{ key: "price", from: 150, to: 200 }] },
    { id: 3, at: "2026-11-24T10:00:00Z", who: "#1", source: "admin", reason: "цена", changes: [{ key: "price", from: 120, to: 150 }] },
  ];
  const values = { ...DEF, price: 200, signupsOpen: false };
  assert.deepEqual(undoPreview(history[2], values, history), { changes: [{ key: "price", from: 200, to: 120 }], later: [4] }, "регистрация не трогается");
  assert.deepEqual(undoPreview(history[0], values, history), { changes: [{ key: "signupsOpen", from: false, to: true }], later: [] });
  assert.deepEqual(undoPreview(history[2], { ...values, price: 120 }, history).changes, [], "уже как до строки — менять нечего");
  const html = renderToStaticMarkup(createElement(UndoPreview, { h: history[2], data: { ...DATA, values, history } }));
  for (const s of ["Станет:", "Подписка: цена: 200 ⭐ / 30 дн. → 120 ⭐ / 30 дн.", "Остальные числа не меняются", "#4"]) assert.ok(html.includes(s), s);
  assert.ok(!html.includes("Регистрация новых"), "поле другой строки в откат не попадает");
});
