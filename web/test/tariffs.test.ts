import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ADMIN_ACTIONS, ADMIN_SECTIONS, adminNavGroups, adminSection } from "../src/admin.ts";
import { planView, todayText } from "../src/billing.ts";
import {
  changeText, checkTariffValue, fromInput, money, PART_KEYS, TARIFF_KEYS, tariffDiff, tariffWarnings, toInput, undoPreview, worstDay, type TariffsData,
  type TariffValues,
} from "../src/tariffs.ts";
import { TariffsPage, UndoPreview } from "../src/screens/AdminTariffs.tsx";

// Разделы «Тарифы» и «Общие потолки» (24.11.2026, этап 1): web/src/tariffs.ts и screens/AdminTariffs.tsx рисуются из подставного
// ответа GET /api/admin/tariffs, без сервера. Что проверка на сайте совпадает с серверной — server/test/tariffs.test.ts.

const DEF: TariffValues = {
  price: 150, trialDays: 7, giftDays: 30, signupsOpen: true, signupsPerHour: 30, signupsPerDay: 150, aiBurst: 10, aiWindowMs: 60_000,
  trialDayUsd: 0.3, paidDayUsd: 0.5, trialPoolDayUsd: 10, unpricedDrawUsd: 0.03, unpricedVoiceUsd: 0.005, unpricedOtherUsd: 0.003, starUsd: 0.013,
  trialCalls: 60, trialDraws: 3, trialVoiceMin: 10, paidCalls: 400, paidDraws: 20, paidVoiceMin: 60,
  giftDayUsd: 0.3, giftCalls: 60, giftDraws: 3, giftVoiceMin: 10,
  limitText: "На сегодня мои силы кончились — продолжу завтра утром. Хотите больше — в подписке лимит выше.",
  paidLimitText: "На сегодня мои силы кончились — продолжу завтра утром.",
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

test("изменения и предупреждения: худший случай подписки больше выручки, новая цена — только для новых", () => {
  const d = { ...DEF, price: 200 };
  assert.deepEqual(tariffDiff(d, DEF), [{ key: "price", from: 150, to: 200 }]);
  assert.equal(changeText({ key: "price", from: 150, to: 200 }), "Подписка: цена: 150 ⭐ / 30 дн. → 200 ⭐ / 30 дн.");
  assert.equal(changeText({ key: "aiWindowMs", from: 60_000, to: 30_000 }), "Окно частоты: 60 с → 30 с");
  // Длинный текст, правка после 60-го знака: в «было → стало» видно, что поменялось (не «тот же текст… → тот же текст…»).
  const lim = "На сегодня мои силы кончились — продолжу завтра утром. Хотите больше — в подписке лимит выше.";
  const t = changeText({ key: "limitText", from: lim, to: lim.replace("в подписке лимит выше", "оформите подписку") });
  const [was, now] = t.split(" → ");
  assert.notEqual(was.replace(/^[^:]+: /, ""), now, t);
  assert.match(was, /в подписке лимит выше/);
  assert.match(now, /оформите подписку/);
  assert.equal(changeText({ key: "limitText", from: "Коротко.", to: "Иначе." }), "Текст при упоре в лимит (проба и подарок): «Коротко.» → «Иначе.»");
  const w = tariffWarnings(d, DEF, "plans");
  // Средних цен нет — худший случай по предохранителю: $0.50 × 30 = $15 > 200 ⭐ × $0.013 = $2.60.
  assert.equal(w[0].kind, "bad");
  assert.match(w[0].text, /\$15\.00.*предохранитель.*\$2\.60/);
  assert.ok(w.some((x) => /только для новых счетов/.test(x.text)));
  assert.ok(!w.some((x) => /живёт по лимитам пробы/.test(x.text)), "подарок — свой тариф, пометки нет");
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

// ——— Этап 2 (24.11.2026): лимиты в штуках, подарок — свой тариф, тексты при упоре, худший случай по средним ценам, остаток на сайте.

test("«Тарифы»: у пробы, подписки и подарка — запросы, картинки, голос и денежный предохранитель; подарок — своя карточка", () => {
  const html = page("plans", undefined, { ...DATA, economy: { ...DATA.economy, gift: { ...none, people: 2, quota_days: 1 } } });
  for (const s of ["Запросов к ИИ в день", "Картинок в день", "Голоса в день", "Денежный предохранитель", "шт.", "мин", "Дней у лимита шт."]) assert.ok(html.includes(s), s);
  assert.equal(html.split(">Запросов к ИИ в день<").length - 1, 3, "у трёх тарифов");
  assert.ok(!html.includes("Лимиты — как у пробы"), "пометки «живёт по лимитам пробы» нет");
  assert.ok(!html.includes("считаются вместе с пробой"));
  assert.ok(html.includes("приглашённые владельцем · 2 чел."), "у подарка свои люди");
  assert.ok(html.includes("(предохр.)"), "средних цен нет — худший случай по предохранителю");
});

test("худший случай: по лимитам в штуках и средним ценам, но не выше предохранителя; нет цены у нужной штуки — по предохранителю", () => {
  const prices = { call_usd: 0.001, draw_usd: 0.01, voice_min_usd: 0.002 };
  // Подписка: 400 × 0.001 + 20 × 0.01 + 60 × 0.002 = 0.72 > 0.5 — упирается в предохранитель.
  assert.deepEqual(worstDay(DEF, "paid", prices), { usd: 0.5, by: "cap" });
  // Проба: 60 × 0.001 + 3 × 0.01 + 10 × 0.002 = 0.11 < 0.3.
  const t = worstDay(DEF, "trial", prices);
  assert.equal(t.by, "limits");
  assert.ok(Math.abs(t.usd - 0.11) < 1e-9);
  assert.deepEqual(worstDay(DEF, "trial", { ...prices, draw_usd: null }), { usd: 0.3, by: "cap" }, "цены картинки нет");
  assert.deepEqual(worstDay({ ...DEF, trialDraws: 0 }, "trial", { ...prices, draw_usd: null }).by, "limits", "картинок 0 — их цена не нужна");
  const cheap = { ...DEF, paidCalls: 100, paidDraws: 5, paidVoiceMin: 10 }; // 0.1 + 0.05 + 0.02 = $0.17/день → $5.10 > $1.95 (150 ⭐)
  const w = tariffWarnings(cheap, cheap, "plans", false, prices);
  assert.equal(w[0].kind, "bad");
  assert.match(w[0].text, /\$5\.10: человек каждый день выбирает все лимиты в штуках/);
  assert.ok(!tariffWarnings({ ...cheap, paidCalls: 10, paidDraws: 1, paidVoiceMin: 0 }, cheap, "plans", false, prices).some((x) => x.kind === "bad"), "$0.02/день × 30 < выручки");
  assert.ok(tariffWarnings({ ...DEF, giftCalls: 0 }, DEF, "plans").some((x) => /у подарка — 0/.test(x.text)), "0 запросов — ИИ закрыт совсем");
});

test("«Общие потолки»: карточка «Что увидит человек, когда лимит кончился» — два текста, изменение в плашке, негодный текст — ошибка", () => {
  const html = page("caps");
  assert.ok(html.includes("Что увидит человек, когда лимит кончился"));
  assert.ok(html.includes("Хотите больше — в подписке лимит выше."));
  assert.equal(html.split("<textarea").length - 1, 2);
  const ch = page("caps", { paidLimitText: "Отдохну до утра." });
  assert.ok(ch.includes("Не применено: 1"));
  assert.ok(ch.includes("Текст при упоре в лимит (подписка): «На сегодня мои силы кончились — продолжу завтра утром.» → «Отдохну до утра.»"));
  assert.ok(page("caps", { limitText: "a <b>" }).includes("limitText: без знаков &lt; &gt; &amp;"));
  assert.deepEqual(fromInput("limitText", "  Устала.  "), { value: "Устала.", error: null }, "пробелы по краям — прочь");
  assert.match(fromInput("limitText", "   ").error!, /напишите текст/);
  assert.ok(!page("plans").includes("Что увидит человек"), "тексты — в «Общих потолках»");
});

test("блок «Тариф» на сайте: остаток на сегодня простыми словами; друзья и старый сервер — без строки", () => {
  const t = { calls: { used: 12, limit: 60 }, draws: { used: 1, limit: 3 }, voice_sec: { used: 130, limit: 600 }, resets_at: "2026-11-24T21:00:00.000Z" };
  assert.match(todayText(t)!, /^Сегодня осталось: 48 запросов из 60, 2 картинки из 3, 7 мин голоса из 10\. Обновится /);
  assert.match(todayText({ ...t, draws: { used: 0, limit: 0 }, calls: { used: 60, limit: 60 } })!, /0 запросов из 60, картинок на тарифе нет/);
  assert.match(todayText({ ...t, calls: { used: 59, limit: 60 } })!, /1 запрос из 60/);
  assert.equal(todayText(null), null);
  assert.equal(todayText(undefined), null);
});
