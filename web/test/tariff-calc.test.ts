import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { calcAvgDay, calcLimitDay, calcPeople, calcPrices, tariffCalc } from "../src/tariffCalc.ts";
import { unitMoney, type PlanEconomy, type TariffsData, type TariffValues } from "../src/tariffs.ts";
import { Calculator, limitText, TariffsPage } from "../src/screens/AdminTariffs.tsx";

// Калькулятор раздела «Тарифы» (25.11.2026, web/src/tariffCalc.ts): чистый расчёт на краях и рисунок в разделе.

const DEF: TariffValues = {
  price: 150, trialDays: 7, giftDays: 30, signupsOpen: true, signupsPerHour: 30, signupsPerDay: 150, aiBurst: 10, aiWindowMs: 60_000,
  trialDayUsd: 0.3, paidDayUsd: 0.5, trialPoolDayUsd: 10, unpricedDrawUsd: 0.03, unpricedVoiceUsd: 0.005, unpricedOtherUsd: 0.003, starUsd: 0.013,
  trialCalls: 60, trialDraws: 3, trialVoiceMin: 10, paidCalls: 400, paidDraws: 20, paidVoiceMin: 60,
  giftDayUsd: 0.3, giftCalls: 60, giftDraws: 3, giftVoiceMin: 10,
  limitText: "На сегодня мои силы кончились — продолжу завтра утром. Хотите больше — в подписке лимит выше.",
  paidLimitText: "На сегодня мои силы кончились — продолжу завтра утром.",
};
const none: PlanEconomy = { people: 0, spenders: 0, avg_month_usd: null, worst_month_usd: null, worst_day_usd: null, capped_days: 0 };
const ECON: TariffsData["economy"] = {
  trial: { ...none, people: 10, avg_month_usd: 0.6, avg_day_usd: 0.02 },
  paid: { ...none, people: 4, avg_month_usd: 1.5, avg_day_usd: 0.05 },
  gift: { ...none, people: 2, avg_month_usd: 0.3, avg_day_usd: 0.01 },
};
const PRICES = { call_usd: 0.001, draw_usd: 0.01, voice_min_usd: 0.002 };
const near = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) < 1e-9, `${what}: ${a} ≠ ${b}`);
const ppl = (trial: number, paid: number, gift: number) => ({ trial, paid, gift });

test("калькулятор: как сейчас, у лимита и посередине; доход подписок и итог за 30 дней", () => {
  const r = tariffCalc(DEF, ECON, PRICES, { people: ppl(10, 4, 2), activity: 0 });
  const [trial, paid, gift] = r.rows;
  near(trial.avgDayUsd, 0.02, "проба: среднее в день");
  near(trial.limitDayUsd, 0.11, "проба у лимита: 60 × 0.001 + 3 × 0.01 + 10 × 0.002");
  assert.equal(trial.limitBy, "limits");
  near(paid.limitDayUsd, 0.5, "подписка у лимита: 0.72 по штукам, но предохранитель 0.5");
  assert.equal(paid.limitBy, "cap");
  near(r.dayUsd, 10 * 0.02 + 4 * 0.05 + 2 * 0.01, "в день всего");
  near(r.monthUsd, r.dayUsd * 30, "месяц — 30 дней");
  near(r.revenueMonthUsd, 4 * 150 * 0.013, "доход: подписчики × цена × курс");
  near(r.profitMonthUsd, r.revenueMonthUsd - r.monthUsd, "итог");
  near(gift.revenueMonthUsd, 0, "подарок дохода не даёт");
  const full = tariffCalc(DEF, ECON, PRICES, { people: ppl(10, 4, 2), activity: 1 });
  near(full.monthUsd, full.worstMonthUsd, "100% — все у лимитов = худший случай");
  near(full.worstMonthUsd, (10 * 0.11 + 4 * 0.5 + 2 * 0.11) * 30, "худший месяц");
  near(full.capMonthUsd, (10 * 0.3 + 4 * 0.5 + 2 * 0.3) * 30, "все у предохранителя");
  const half = tariffCalc(DEF, ECON, PRICES, { people: ppl(10, 4, 2), activity: 0.5 });
  near(half.rows[0].personDayUsd, (0.02 + 0.11) / 2, "50% — посередине");
  near(tariffCalc(DEF, ECON, PRICES, { people: ppl(1, 1, 1), activity: 7 }).rows[0].personDayUsd, 0.11, "активность больше 1 — как 1");
});

test("калькулятор: 0 людей — всё по нулям, без NaN; негодное число людей — 0", () => {
  const r = tariffCalc(DEF, ECON, PRICES, { people: ppl(0, 0, 0), activity: 1 });
  for (const k of ["dayUsd", "monthUsd", "revenueMonthUsd", "profitMonthUsd", "worstMonthUsd", "capMonthUsd", "capProfitMonthUsd"] as const) assert.equal(r[k], 0, k);
  assert.deepEqual(r.pool, { now: false, worst: false, cap: false });
  const odd = tariffCalc(DEF, ECON, PRICES, { people: { trial: -5, paid: NaN, gift: 2.7 }, activity: NaN });
  assert.deepEqual(odd.rows.map((x) => x.people), [0, 0, 2]);
  assert.ok(Number.isFinite(odd.monthUsd));
  assert.equal(calcPeople(" 12 "), 12);
  for (const t of ["", "-1", "1.5", "abc", "1e3", "99999999"]) assert.equal(calcPeople(t), null, t);
});

test("калькулятор: нет данных — цены единиц из «Общих потолков» с пометкой «оценка», среднее другого тарифа или 0", () => {
  const p = calcPrices(DEF, null);
  assert.deepEqual(p, { call: 0.003, draw: 0.03, voiceMin: 0.005, estimated: ["call", "draw", "voiceMin"] });
  assert.deepEqual(calcPrices(DEF, { ...PRICES, draw_usd: null }).estimated, ["draw"], "только чего нет");
  const r = tariffCalc(DEF, { trial: none, paid: { ...none, people: 4, avg_month_usd: 1.5 } }, undefined, { people: ppl(10, 4, 3), activity: 0 });
  assert.equal(r.rows[1].avg, "data");
  assert.equal(r.rows[0].avg, "other", "у пробы своего среднего нет — берётся среднее подписки");
  near(r.rows[0].avgDayUsd, 0.05, "0.05 ≤ лимита пробы (60 × 0.003 + 3 × 0.03 + 10 × 0.005 = 0.32 → предохранитель 0.3)");
  assert.equal(r.rows[2].avg, "other", "старый сервер без gift");
  const empty = tariffCalc(DEF, { trial: none, paid: none }, null, { people: ppl(5, 5, 5), activity: 0 });
  assert.ok(empty.rows.every((x) => x.avg === "none" && x.avgDayUsd === 0), "среднего нет ни у кого — 0");
  assert.equal(empty.monthUsd, 0);
  assert.ok(empty.worstMonthUsd > 0, "худший случай всё равно по лимитам и оценкам");
});

test("калькулятор: лимит 0 и предохранитель меньше лимитов", () => {
  const closed = tariffCalc({ ...DEF, trialCalls: 0 }, ECON, PRICES, { people: ppl(10, 0, 0), activity: 1 });
  assert.equal(closed.rows[0].limitBy, "closed");
  assert.equal(closed.monthUsd, 0, "запросов 0 — ИИ закрыт, даже прежнее среднее не тратится");
  assert.equal(closed.capMonthUsd, 0, "и предохранитель не тратится");
  const noDraws = tariffCalc({ ...DEF, trialDraws: 0, trialVoiceMin: 0 }, ECON, { ...PRICES, draw_usd: null }, { people: ppl(1, 0, 0), activity: 1 });
  near(noDraws.rows[0].limitDayUsd, 0.06, "картинок и голоса 0 — только запросы");
  // Предохранитель $0.01 меньше и лимитов ($0.11), и прежнего среднего ($0.02): всё упирается в него.
  const tight = tariffCalc({ ...DEF, trialDayUsd: 0.01 }, ECON, PRICES, { people: ppl(10, 0, 0), activity: 0 });
  assert.equal(tight.rows[0].limitBy, "cap");
  near(tight.rows[0].avgDayUsd, 0.01, "среднее не выше того, что пускает предохранитель");
  near(tight.worstMonthUsd, 10 * 0.01 * 30, "худший — по предохранителю");
  near(tight.capMonthUsd, tight.worstMonthUsd, "у предохранителя — столько же");
  // Лимиты урезали: прежнее среднее подписки $0.05 больше нового лимита 10 × 0.001 = $0.01.
  const cut = tariffCalc({ ...DEF, paidCalls: 10, paidDraws: 0, paidVoiceMin: 0 }, ECON, PRICES, { people: ppl(0, 4, 0), activity: 0 });
  near(cut.rows[1].avgDayUsd, 0.01, "новые лимиты из полей срезают среднее");
});

test("калькулятор: проба и подарок вместе — не больше общего потолка проб в день", () => {
  const r = tariffCalc({ ...DEF, trialPoolDayUsd: 1 }, ECON, PRICES, { people: ppl(30, 0, 10), activity: 1 });
  // 30 × 0.11 + 10 × 0.11 = 4.4 > 1 — срезается до 1 с сохранением долей.
  assert.ok(r.pool.now && r.pool.worst && r.pool.cap);
  near(r.dayUsd, 1, "в день — не больше потолка проб");
  near(r.rows[0].dayUsd, 0.75, "проба — 3/4");
  near(r.worstMonthUsd, 30, "худший месяц проб — потолок × 30");
  const paid = tariffCalc({ ...DEF, trialPoolDayUsd: 0.01 }, ECON, PRICES, { people: ppl(0, 4, 0), activity: 1 });
  assert.equal(paid.pool.now, false, "подписку общий потолок проб не трогает");
  near(paid.dayUsd, 2, "4 × 0.5");
});

test("калькулятор в «Тарифах»: вверху раздела, люди по умолчанию из экономики, пересчёт по неприменённым полям", () => {
  const data: TariffsData = {
    values: DEF, defaults: DEF, overridden: [], reload_ms: 60_000, history: [], economy: ECON, unit_prices: PRICES,
    now: { trial_pool_today_usd: 0, signups_hour: 0, signups_day: 0 },
  };
  const noop = async () => null;
  const html = renderToStaticMarkup(createElement(TariffsPage, { data, part: "plans", onApply: noop, onUndo: noop }));
  assert.ok(html.indexOf("Калькулятор") < html.indexOf("Подписка приносит"), "калькулятор — вверху");
  for (const s of ["Людей на пробе", "Людей на подписке", "Людей с подарком", "Активность", "как сейчас", "25%", "50%", "100%", "Доход от подписок в месяц", "Итог в месяц", "Худший случай за месяц"]) {
    assert.ok(html.includes(s), s);
  }
  assert.match(html, /aria-label="Людей на подписке"[^>]*value="4"|value="4"[^>]*aria-label="Людей на подписке"/, "люди — из экономики");
  assert.ok(html.includes("$7.80"), "доход 4 × 150 × 0.013");
  assert.ok(!html.includes("Оценка:"), "цены есть — без пометки «оценка»");
  const drafted = renderToStaticMarkup(createElement(TariffsPage, { data, part: "plans", onApply: noop, onUndo: noop, draft: { price: 300 } }));
  assert.ok(drafted.includes("$15.60"), "неприменённая цена 300 — доход пересчитан");
  const est = renderToStaticMarkup(createElement(Calculator, { d: DEF, data: { ...data, unit_prices: undefined }, start: { people: { paid: "x" } } }));
  assert.ok(est.includes("Оценка:"), "цен нет — пометка «оценка»");
  assert.ok(est.includes("целое число от 0"), "негодное число людей — подсказка");
  assert.ok(est.includes("adm-tf-num err"));
});

// ——— Исправления по разбору этапа 8 (25.11.2026).

test("калькулятор: средний день пробы — по дням на тарифе (avg_day_usd), без него — не / 30, а / длину пробы", () => {
  const e: TariffsData["economy"] = { trial: { ...none, people: 10, avg_month_usd: 0.35, avg_day_usd: 0.1 }, paid: none };
  const r = tariffCalc(DEF, e, PRICES, { people: ppl(100, 0, 0), activity: 0 });
  near(r.rows[0].avgDayUsd, 0.1, "проба: $0.10 в день с сервера, а не 0.35 / 30");
  assert.equal(r.rows[0].avgEstimated, false);
  near(r.monthUsd, 100 * 0.1 * 30, "100 человек × $0.10 × 30 (потолок проб снят ниже)");
  // Старый сервер без avg_day_usd: проба 7 дней — 30-дневный расход делится на 7, подарок — на min(30, giftDays), подписка — на 30.
  const old = { ...none, people: 10, avg_month_usd: 0.35 };
  near(calcAvgDay(DEF, "trial", old)!.usd, 0.05, "0.35 / 7, не 0.35 / 30");
  assert.equal(calcAvgDay(DEF, "trial", old)!.estimated, true, "с пометкой «оценка»");
  near(calcAvgDay({ ...DEF, giftDays: 60 }, "gift", old)!.usd, 0.35 / 30, "подарок длиннее 30 дней — / 30");
  near(calcAvgDay(DEF, "paid", old)!.usd, 0.35 / 30);
  assert.equal(calcAvgDay(DEF, "trial", none), null, "расхода нет — null");
  const html = renderToStaticMarkup(createElement(Calculator, { d: DEF, data: { values: DEF, defaults: DEF, overridden: [], reload_ms: 0, history: [], economy: { trial: old, paid: none }, unit_prices: PRICES, now: { trial_pool_today_usd: 0, signups_hour: 0, signups_day: 0 } } }));
  assert.ok(html.includes("сервер не дал среднего за день"), "оценка среднего — с пометкой");
});

test("калькулятор: оценочные цены не срезают измеренное среднее — «у лимита» не ниже того, что люди уже тратят", () => {
  const e: TariffsData["economy"] = { trial: none, paid: { ...none, people: 4, avg_month_usd: 3, avg_day_usd: 0.1 } };
  const v = { ...DEF, paidCalls: 20, paidDraws: 0, paidVoiceMin: 0 }; // 20 × 0.003 (оценка) = $0.06 < $0.10 измеренных
  const r = tariffCalc(v, e, null, { people: ppl(0, 4, 0), activity: 0 });
  const paid = r.rows[1];
  near(paid.avgDayUsd, 0.1, "среднее — как в данных, не $0.06");
  near(paid.limitDayUsd, 0.1, "у лимита — не ниже среднего");
  assert.ok(paid.limitEstimated && paid.limitRaised);
  near(tariffCalc(v, e, null, { people: ppl(0, 4, 0), activity: 1 }).rows[1].personDayUsd, 0.1, "100% не меньше «как сейчас»");
  near(tariffCalc({ ...v, paidDayUsd: 0.08 }, e, null, { people: ppl(0, 4, 0), activity: 0 }).rows[1].avgDayUsd, 0.08, "срезает только предохранитель");
  // Настоящие цены — прежнее правило: новые лимиты срезают среднее.
  near(tariffCalc(v, e, PRICES, { people: ppl(0, 4, 0), activity: 0 }).rows[1].avgDayUsd, 0.02, "цены из данных: 20 × 0.001");
  const html = renderToStaticMarkup(createElement(Calculator, { d: v, data: { values: v, defaults: v, overridden: [], reload_ms: 0, history: [], economy: e, unit_prices: undefined, now: { trial_pool_today_usd: 0, signups_hour: 0, signups_day: 0 } } }));
  assert.ok(html.includes("не ниже измеренного среднего"), "подъём — с пометкой");
  assert.ok(html.includes("$0.10 (оценка)"), "у лимита — с пометкой «оценка»");
});

test("карточки тарифов: «Худший случай/день» — та же цифра, что «у лимита» в калькуляторе", () => {
  const v = { ...DEF, trialCalls: 30, trialDraws: 0, trialVoiceMin: 0, trialDayUsd: 0.5, paidDayUsd: 0.7 };
  const data: TariffsData = {
    values: v, defaults: v, overridden: [], reload_ms: 60_000, history: [], economy: { trial: none, paid: none, gift: none }, unit_prices: { call_usd: null, draw_usd: null, voice_min_usd: null },
    now: { trial_pool_today_usd: 0, signups_hour: 0, signups_day: 0 },
  };
  const noop = async () => null;
  const html = renderToStaticMarkup(createElement(TariffsPage, { data, part: "plans", onApply: noop, onUndo: noop }));
  const calc = tariffCalc(v, data.economy, data.unit_prices, { people: ppl(1, 1, 1), activity: 1 }).rows[0];
  near(calc.limitDayUsd, 0.09, "30 × 0.003 по оценке");
  assert.ok(html.includes("$0.090 (оценка)"), "в карточке пробы — та же оценка, не предохранитель $0.50");
  assert.ok(!html.includes("$0.50 (предохр.)"), "предохранителя пробы в карточке нет");
  const closed = renderToStaticMarkup(createElement(TariffsPage, { data: { ...data, values: { ...v, paidCalls: 0 } }, part: "plans", onApply: noop, onUndo: noop, draft: { paidCalls: 0 } }));
  assert.ok(closed.includes("$0.00 (закрыт)"), "запросов 0 — и в карточке подписки $0, закрыт");
  assert.equal(limitText(calcLimitDay(v, "paid", calcPrices(v, null), null)), "$0.70 (предохр.)", "подписка: 400 × 0.003 + … > $0.70");
});

test("калькулятор: срез общим потолком проб помечен прямо в строке", () => {
  const v = { ...DEF, trialPoolDayUsd: 5, trialDayUsd: 0.1, trialCalls: 1000 };
  const r = tariffCalc(v, ECON, PRICES, { people: ppl(1000, 0, 0), activity: 1 });
  near(r.rows[0].personDayUsd, 0.1, "на человека — без среза");
  near(r.rows[0].dayUsd, 5, "в день — потолок проб");
  const data: TariffsData = { values: v, defaults: v, overridden: [], reload_ms: 0, history: [], economy: ECON, unit_prices: PRICES, now: { trial_pool_today_usd: 0, signups_hour: 0, signups_day: 0 } };
  const html = renderToStaticMarkup(createElement(Calculator, { d: v, data, start: { people: { trial: "1000", paid: "0", gift: "0" }, activity: 1 } }));
  assert.ok(html.includes("потолок проб: $0.0050/чел."), "в ячейке расхода — доля после потолка");
  const free = renderToStaticMarkup(createElement(Calculator, { d: DEF, data: { ...data, values: DEF }, start: { activity: 0 } }));
  assert.ok(!free.includes("потолок проб:"), "потолок не сработал — пометки нет");
});

test("мелкие суммы: цена запроса и расход на человека в день — две значащие цифры", () => {
  assert.equal(unitMoney(0.0003), "$0.00030");
  assert.equal(unitMoney(0.0005), "$0.00050");
  assert.equal(unitMoney(0.012), "$0.012");
  assert.equal(unitMoney(0.05), "$0.050");
  assert.equal(unitMoney(0.25), "$0.25");
  assert.equal(unitMoney(0), "$0.00");
  assert.equal(unitMoney(null), "—");
  const p = { call_usd: 0.0003, draw_usd: 0.01, voice_min_usd: 0.002 };
  const data: TariffsData = { values: DEF, defaults: DEF, overridden: [], reload_ms: 0, history: [], economy: { ...ECON, trial: { ...ECON.trial, avg_day_usd: 0.0003 } }, unit_prices: p, now: { trial_pool_today_usd: 0, signups_hour: 0, signups_day: 0 } };
  const html = renderToStaticMarkup(createElement(Calculator, { d: DEF, data }));
  assert.ok(html.includes("запрос $0.00030"), "цена запроса не «$0.000»");
  assert.ok(html.includes("средн. $0.00030"), "средний день не «$0.000»");
});
