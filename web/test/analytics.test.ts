import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ADMIN_LIVE_STAGE, ADMIN_SECTIONS, adminSection, AI_GROUP_NAMES, AI_GROUPS, analyticsDelta, analyticsFixStep, analyticsStepOk, analyticsTab,
  ANALYTICS_DAYS, ANALYTICS_NOTE_TEXT, ANALYTICS_REPORTS, bucketLabel, csvFileName, DIST_NAMES, microText, numText, PARSE_KIND_NAMES, PARSE_KINDS,
  seriesCsv, shareText, toCsv, type AnalyticsBucket, type AnalyticsMeta, type AnalyticsNote, type AnalyticsReportId, type AnalyticsResponse,
  type AnalyticsStep, type Pair,
} from "../src/admin.ts";
import { axisText, chartRange, niceMax, tickEvery } from "../src/adminCharts.tsx";
import { AnaReport } from "../src/screens/AdminAnalytics.tsx";

// Раздел «Аналитика» админки (этап 5, 24.11.2026): web/src/admin.ts (типы, шаг, стрелка, форматы, CSV), adminCharts.tsx (оси),
// screens/AdminAnalytics.tsx (отчёты рисуются из готового ответа GET /api/admin/analytics — здесь подставной ответ, без сервера).

test("аналитика: раздел живой, адрес /admin/analytics, меню отчётов", () => {
  const s = ADMIN_SECTIONS.find((x) => x.id === "analytics")!;
  assert.ok(s, "раздел есть");
  assert.equal(s.title, "Аналитика");
  assert.equal(ADMIN_SECTIONS[1].id, "analytics", "вторым пунктом после «Обзора»");
  assert.ok(s.stage <= ADMIN_LIVE_STAGE, "живой, не «появится»");
  assert.equal(adminSection("analytics"), "analytics");
  assert.equal(analyticsTab(undefined), "money");
  assert.equal(analyticsTab("ret"), "ret");
  assert.equal(analyticsTab("fun"), "fun");
  assert.equal(analyticsTab("nope"), "money");
  const ids = ANALYTICS_REPORTS.flatMap((g) => g.items.map((i) => i.id));
  assert.deepEqual(ids, ["money", "subs", "ai", "act", "ret", "fun", "feat", "rina", "parse"]);
  assert.deepEqual(ANALYTICS_REPORTS.flatMap((g) => g.items).filter((i) => i.stub).map((i) => i.id), ["fun", "rina"], "заглушки этапа 2");
  assert.deepEqual(ANALYTICS_REPORTS.map((g) => g.group), ["Деньги", "Люди", "Рина и функции"]);
});

test("аналитика: шаг выправляется под интервал, как fixStep макета и сервер", () => {
  assert.equal(analyticsFixStep(1, "d"), "h");
  assert.equal(analyticsFixStep(1, "w"), "h");
  assert.equal(analyticsFixStep(30, "h"), "d");
  assert.equal(analyticsFixStep(7, "w"), "d");
  assert.equal(analyticsFixStep(7, "h"), "h");
  assert.equal(analyticsFixStep(90, "w"), "w");
  // Каждый выправленный шаг сайт может послать (сервер не ответит 400).
  for (const days of ANALYTICS_DAYS) for (const step of ["h", "d", "w"] as AnalyticsStep[]) {
    const f = analyticsFixStep(days, step);
    assert.ok(analyticsStepOk(days, f), `${days} ${step} → ${f}`);
    assert.ok(f !== "h" || days <= 7, "час — только до 7 дней");
    assert.ok(f !== "w" || days >= 30, "неделя — только от 30 дней");
  }
  assert.equal(analyticsStepOk(30, "h"), false);
  assert.equal(analyticsStepOk(7, "w"), false);
});

test("аналитика: стрелка к прошлому периоду", () => {
  assert.equal(analyticsDelta(null, 5), null);
  assert.equal(analyticsDelta(5, null), null);
  assert.equal(analyticsDelta(5, 0), null, "prev = 0 — «—»");
  assert.equal(analyticsDelta(100, 100.2), null, "меньше 0,5 % — «—»");
  assert.equal(analyticsDelta(120, 100), 0.2);
  assert.equal(analyticsDelta(75, 100), -0.25);
  assert.equal(analyticsDelta(0, 10), -1);
});

test("аналитика: CSV — кавычки, запятые, переводы строк, null, BOM; имя файла", () => {
  const csv = toCsv(["name", "share_0_1"], [["a,b", 0.125], ['он сказал "да"', null], ["две\nстроки", 3]]);
  assert.ok(csv.startsWith("﻿"), "BOM");
  assert.equal(csv.slice(1), 'name,share_0_1\r\n"a,b",0.125\r\n"он сказал ""да""",\r\n"две\nстроки",3');
  assert.equal(toCsv(["x"], [[Number.NaN]]).slice(1), "x\r\n", "не число — пусто");
  assert.equal(csvFileName("ai", "models", 30, "2026-11-24"), "maid-ai-models-30d-2026-11-24.csv");
  const b: AnalyticsBucket[] = [{ key: "2026-11-23", from: "2026-11-23", to: "2026-11-23", days: 1 }, { key: "2026-11-24", from: "2026-11-24", to: "2026-11-24", days: 1 }];
  assert.equal(seriesCsv(b, [{ name: "ai_micro_usd", values: [10, null] }]).slice(1),
    "bucket,from,to,days,ai_micro_usd\r\n2026-11-23,2026-11-23,2026-11-23,1,10\r\n2026-11-24,2026-11-24,2026-11-24,1,");
});

test("аналитика: деньги в micro, доли, числа", () => {
  assert.equal(microText(null), "—");
  assert.equal(microText(0), "$0");
  assert.equal(microText(610_000), "61¢");
  assert.equal(microText(4_000), "0,4¢");
  assert.equal(microText(50_000), "5¢");
  assert.equal(microText(1_230_000), "$1,23");
  assert.equal(microText(2_500_000), "$2,50");
  assert.equal(microText(1_234_560_000), "$1 235");
  assert.equal(microText(-1_230_000), "−$1,23", "маржа в минус");
  assert.equal(shareText(null), "—");
  assert.equal(shareText(0.123), "12,3%");
  assert.equal(shareText(0.5), "50%");
  assert.equal(shareText(0), "0%");
  assert.equal(shareText(1), "100%");
  assert.equal(numText(null), "—");
  assert.equal(numText(Number.NaN), "—");
  assert.equal(numText(2380), "2 380");
  assert.equal(numText(6.4, 1), "6,4");
  assert.equal(numText(6, 1), "6");
  assert.equal(numText(-3), "−3");
});

test("аналитика: подписи корзин — час местным временем, день, неделя (неполная подписана)", () => {
  const h: AnalyticsBucket = { key: "2026-11-24T13:00:00.000Z", from: "2026-11-24T13:00:00.000Z", to: "2026-11-24T14:00:00.000Z", days: 1 / 24 };
  const t = new Date(h.key);
  assert.equal(bucketLabel(h, "h"), `${t.getDate()}.${String(t.getMonth() + 1).padStart(2, "0")} ${String(t.getHours()).padStart(2, "0")}:00`);
  assert.match(bucketLabel(h, "h"), /^\d{1,2}\.\d\d \d\d:00$/);
  assert.equal(bucketLabel({ key: "2026-11-24", from: "2026-11-24", to: "2026-11-24", days: 1 }, "d"), "24 нояб.");
  assert.equal(bucketLabel({ key: "2026-11-18", from: "2026-11-18", to: "2026-11-24", days: 7 }, "w"), "18 нояб.");
  assert.equal(bucketLabel({ key: "2026-10-26", from: "2026-10-26", to: "2026-10-27", days: 2 }, "w"), "26 окт. (2 дн.)");
});

test("аналитика: оси графиков", () => {
  assert.equal(niceMax(0), 1);
  assert.equal(niceMax(-5), 1);
  assert.equal(niceMax(7), 10);
  assert.equal(niceMax(180), 200);
  assert.equal(niceMax(230), 250);
  assert.equal(niceMax(0.04), 0.05);
  // Стопка: вверх — сумма положительных, вниз — сумма рядов со знаком −1; null — пусто.
  assert.deepEqual(chartRange("stack", [{ name: "a", color: "", values: [3, 9] }, { name: "b", color: "", values: [4, null] }, { name: "r", color: "", values: [2, 0], sign: -1 }]), { min: -2, max: 10 });
  assert.deepEqual(chartRange("stack", [{ name: "a", color: "", values: [0, 0] }]), { min: 0, max: 1 }, "все нули — ось 0…1, не NaN");
  assert.deepEqual(chartRange("line", [{ name: "a", color: "", values: [null, 4, 12] }]), { min: 0, max: 20 });
  assert.deepEqual(chartRange("line", [{ name: "m", color: "", values: [-30, 70] }]), { min: -50, max: 100 });
  assert.equal(tickEvery(30, 700), 3);
  assert.equal(tickEvery(5, 700), 1);
  assert.equal(tickEvery(168, 300), 42);
  assert.equal(axisText(1200), "1,2k");
  assert.equal(axisText(2.5), "2,5");
});

test("аналитика: у каждой группы ИИ, вида записи и полосы расхода — русское имя; сноски подписаны", () => {
  for (const g of AI_GROUPS) assert.ok(AI_GROUP_NAMES[g.id], g.id);
  for (const k of PARSE_KINDS) assert.ok(PARSE_KIND_NAMES[k], k);
  for (const id of ["lt5c", "5to20c", "20to50c", "50cto1", "1to3", "gt3"] as const) assert.ok(DIST_NAMES[id], id);
  for (const n of ["hour_from_calls", "no_hourly_features", "days_for_hours", "latency_30d_only", "prev_before_data"] as AnalyticsNote[]) assert.ok(ANALYTICS_NOTE_TEXT[n], n);
});

// ——— Подставной ответ ручки.
const P = (cur: number | null, prev: number | null = null): Pair => ({ cur, prev });
const days3: AnalyticsBucket[] = ["2026-11-22", "2026-11-23", "2026-11-24"].map((k) => ({ key: k, from: k, to: k, days: 1 }));

function metaOf(report: AnalyticsReportId, notes: AnalyticsNote[] = [], buckets = days3): AnalyticsMeta {
  return {
    report, days: 7, step: "d", generated_at: "2026-11-24T14:00:00.000Z", cached: false, zone: ["money", "subs", "ai"].includes(report) ? "utc" : "user",
    today: "2026-11-24", period: { from: "2026-11-18", to: "2026-11-24" }, prev: { from: "2026-11-11", to: "2026-11-17" },
    buckets, prev_buckets: buckets, star_usd: 0.013,
    since: { payments: "2026-11-24", billing_events: "2026-11-24", feature_events: "2026-11-24", gate: "2026-11-24", llm_calls: "2026-11-01", presence: "2026-10-01" },
    notes,
  };
}

/** Ответы всех семи отчётов; empty — «ничего не знаем»: null везде, где тип разрешает, пустые ряды и списки. */
export function responses(empty: boolean): AnalyticsResponse[] {
  const v = (n: number) => (empty ? null : n);
  const arr = (...xs: number[]) => (empty ? [0, 0, 0] : xs);
  const nul = (...xs: (number | null)[]) => (empty ? [null, null, null] : xs);
  return [
    { meta: metaOf("money", ["prev_before_data"]), report: "money", data: {
      kpi: {
        revenue_stars: P(v(290), v(150)), revenue_sub_stars: P(v(300), v(150)), revenue_once_stars: P(v(40)), refunds_stars: P(v(50)),
        revenue_micro: P(v(3_770_000)), ai_micro: P(v(2_400_000), v(2_000_000)), margin_micro: P(v(1_370_000)), active: P(v(12), v(10)), payers: P(v(2)),
        arpu_stars: P(v(24.2)), arppu_stars: P(v(145)), ltv_stars: P(v(410)), avg_check_stars: P(v(170)), payments: P(v(2)), ai_per_active_micro: P(v(200_000), v(150_000)),
      },
      series: { sub_stars: arr(150, 0, 150), once_stars: arr(0, 40, 0), refund_stars: arr(0, 50, 0), revenue_micro: arr(1, 2, 3), ai_micro: arr(1, 2, 3),
        active: arr(5, 6, 7), arpu_stars: nul(30, null, 21), ai_per_active_micro: nul(100, 200, null) },
    } },
    { meta: metaOf("subs"), report: "subs", data: {
      price_stars: 150, trial_days: 7,
      kpi: { active_subs: P(v(3), v(2)), trials: P(v(4)), trials_ending_3d: P(v(1)), autorenew: P(v(2)), churn_risk: P(v(1)), trial_conversion: P(v(0.25), v(0.2)),
        trial_decided: P(v(4)), trial_pending: empty ? 0 : 2, new_subs: P(v(1)), renewals: P(v(1)), cancels: P(v(1)), expired: P(v(0)), refunds: P(v(0)) },
      series: { new: arr(1, 0, 0), renewed: arr(0, 1, 0), canceled: nul(null, 1, 0), expired: nul(null, 0, 0), trial_conversion: nul(null, 0.5, null) },
      soon: empty ? [] : [{ user_id: 1042, what: "trial", left_days: 1, days_with_us: 6, active_days_7: 6, ai_micro_30: 310_000 },
        { user_id: 877, what: "no_renew", left_days: 3, days_with_us: 64, active_days_7: 7, ai_micro_30: 480_000 }],
    } },
    { meta: metaOf("ai", ["latency_30d_only"]), report: "ai", data: {
      source: "llm_usage",
      kpi: { total_micro: P(v(5_000_000), v(4_000_000)), calls: P(v(900)), unpriced_calls: P(v(3)), forecast_month_micro: v(21_000_000), capped_users: P(v(1)),
        capped_share: P(v(0.08)), active: P(v(12)), top_user: empty ? null : { user_id: 877, micro: 2_840_000 }, subscribers: empty ? 0 : 3,
        subscriber_avg_micro: v(610_000), subscriber_avg_revenue_micro: v(1_950_000) },
      groups: AI_GROUPS,
      series: { parse: arr(1, 2, 3), talk: arr(1, 1, 1), draw: arr(0, 0, 1), voice: arr(0, 0, 0), background: arr(1, 0, 0), other: arr(0, 0, 0) },
      dist: [
        { id: "lt5c", from_micro: 0, to_micro: 50_000, users: empty ? 0 : 5, share: v(0.41) },
        { id: "5to20c", from_micro: 50_000, to_micro: 200_000, users: empty ? 0 : 4, share: v(0.33) },
        { id: "20to50c", from_micro: 200_000, to_micro: 500_000, users: 0, share: v(0) },
        { id: "50cto1", from_micro: 500_000, to_micro: 1_000_000, users: 0, share: v(0) },
        { id: "1to3", from_micro: 1_000_000, to_micro: 3_000_000, users: empty ? 0 : 3, share: v(0.25) },
        { id: "gt3", from_micro: 3_000_000, to_micro: null, users: 0, share: v(0) },
      ],
      dist_users: empty ? 0 : 12,
      models: empty ? [] : [{ model: "test/model-main", micro: 3_000_000, share: 0.6, calls: 500, top_kind: "chat", p50_ms: 2400, p95_ms: 6100, timed: 480 },
        { model: "test/model-lite", micro: 2_000_000, share: 0.4, calls: 400, top_kind: "parse", p50_ms: null, p95_ms: null, timed: 0 }],
      limits: { trial_day_micro: 300_000, paid_day_micro: 1_500_000, trial_pool_day_micro: 10_000_000 },
    } },
    { meta: metaOf("act"), report: "act", data: {
      kpi: { signups: P(v(4), v(2)), requests: P(v(120), v(100)), manual: P(v(80)), active: P(v(12)), requests_per_active: P(v(10)), manual_per_active: P(v(6.7)), payers_share: P(v(0.167)) },
      sources: empty ? [] : ["telegram", "desktop"],
      series: { signups: arr(1, 2, 1), requests: arr(40, 40, 40), requests_by_source: empty ? {} : { telegram: [30, 20, 10], desktop: [10, 20, 30] }, manual: arr(20, 30, 30) },
      hours: Array.from({ length: 24 }, (_, h) => (empty ? 0 : h % 5)),
      heat: Array.from({ length: 7 }, () => Array.from({ length: 24 }, (_, h) => (empty ? 0 : h))),
      heat_days: 28,
    } },
    { meta: metaOf("ret"), report: "ret", data: {
      kpi: { dau: P(v(5), v(4)), wau: P(v(9)), mau: P(v(12)), stickiness: P(v(0.31)), gone: P(v(2), v(3)) },
      series: { active: arr(4, 5, 5), prev_active: arr(3, 4, 4) },
      bridge: empty ? { prev_mau: 0, stayed: 0, left: 0, new: 0, returned: 0, mau: 0 } : { prev_mau: 10, stayed: 7, left: 3, new: 4, returned: 1, mau: 12 },
      cohorts: empty ? [] : [{ week: "2026-11-10", size: 5, cells: [{ share: 1, users: 5 }, { share: 0.4, users: 2 }, null] }, { week: "2026-11-17", size: 0, cells: [null, null, null] }],
      cohort_cols: 3,
    } },
    { meta: metaOf("feat", ["days_for_hours"]), report: "feat", data: {
      groups: { site: "Сайт", widget: "Виджет" }, since: empty ? null : "2026-11-24", active: P(v(12)),
      kpi: { used: P(v(1)), total: 2, per_person: P(v(1.5)), people: P(v(3)), unused: P(v(1)) },
      rows: [
        { id: "habit.mark", title: "Отметить привычку", group: "widget", by: "client", uses: P(v(30), v(20)), people: P(v(3)), share: P(v(0.25)), clients: { widget: 30 }, spark: empty ? null : [10, 10, 10] },
        { id: "export.data", title: "Экспорт данных", group: "site", by: "client", uses: P(v(0)), people: P(v(0)), share: P(v(0)), clients: {}, spark: null },
      ],
      unused: ["export.data"],
    } },
    { meta: metaOf("parse"), report: "parse", data: {
      kpi: { requests: P(v(120)), undone: P(v(5)), corrections: P(v(3)), undone_share: P(v(0.042)), corrections_share: P(v(0.025)),
        failed_now: empty ? 0 : 2, failed_retry: empty ? 0 : 1, clarify_now: 0, p50_ms: P(v(2100), v(2300)), p95_ms: P(v(6000)) },
      kinds: PARSE_KINDS,
      series: { requests: arr(40, 40, 40), kinds: Object.fromEntries(PARSE_KINDS.map((k) => [k, arr(5, 6, 7)])) as Record<(typeof PARSE_KINDS)[number], number[]>, err_share: nul(0.05, null, 0.1) },
    } },
  ];
}

const html = (r: AnalyticsResponse) => renderToStaticMarkup(createElement(AnaReport, { res: r }));
const TITLES: Record<AnalyticsReportId, string[]> = {
  money: ["Деньги", "Выручка во времени", "Выручка и расход на ИИ", "Выручка на активного", "Расход ИИ на активного", "STAR_USD"],
  subs: ["Подписка «Горничная» ⭐150 / месяц", "Подписки во времени", "Конверсия пробы во времени", "Кто скоро решит"],
  ai: ["Расход на ИИ", "Расход по назначениям", "Сколько людей тратят сколько", "Модели"],
  act: ["Приток и объём", "Обращения по источнику", "Без ИИ на активного", "Записи и отметки", "Неделя × час", "Активный"],
  ret: ["Удержание", "Мост MAU", "Активные по дням", "Когорты по неделям регистрации"],
  feat: ["Функции", "Самые частые", "Ни разу за интервал"],
  parse: ["Разбор", "Что записывается", "Доля отмен и поправок"],
};

test("аналитика: каждый отчёт рисуется на подставном ответе — подписи, «Как считаются цифры», без NaN", () => {
  for (const r of responses(false)) {
    const h = html(r);
    for (const t of TITLES[r.report]) assert.ok(h.includes(t), `${r.report}: ${t}`);
    assert.ok(h.includes("Как считаются цифры"), r.report);
    assert.doesNotMatch(h, /NaN|undefined|Infinity/, r.report);
    assert.ok(h.includes("<svg") || r.report === "feat", `${r.report}: график`);
  }
  const money = html(responses(false)[0]);
  assert.ok(money.includes("+93,3%"), "стрелка выручки: 290 к 150");
  assert.ok(money.includes("ana-dl up bad"), "рост расхода на ИИ — красным (inverse)");
  assert.ok(money.includes(ANALYTICS_NOTE_TEXT.prev_before_data), "сноска meta.notes");
  assert.doesNotMatch(money, /badge|записывать|посчитать из того/, "меток макета «есть / посчитать / записывать» нет");
  const subs = html(responses(false)[1]);
  assert.ok(subs.includes("#1042") && subs.includes("без автопродления"), "«Кто скоро решит» — номером, без имени");
  assert.ok(subs.includes(">CSV<"), "у таблицы — CSV");
  const ai = html(responses(false)[2]);
  assert.ok(ai.includes("test/model-main") && ai.includes("2.4 с"), "модели и время ответа");
  assert.ok(ai.includes(ANALYTICS_NOTE_TEXT.latency_30d_only));
  const act = html(responses(false)[3]);
  assert.ok(act.includes("Telegram") && act.includes("Сайт и виджет"), "источники — подписи SOURCE_NAMES");
  assert.ok(act.includes("«Обзоре»"), "оговорка про «Обзор»");
  const ret = html(responses(false)[4]);
  assert.ok(ret.includes("40%") && ret.includes("Н+2"), "когорта: доля и столбцы");
  const feat = html(responses(false)[5]);
  assert.ok(feat.includes("Экспорт данных"), "«Ни разу за интервал» — по названию");
  assert.ok(feat.includes(ANALYTICS_NOTE_TEXT.days_for_hours));
  assert.ok(html(responses(false)[6]).includes("Разговор без записи"));
});

test("аналитика: пустые данные — «—» и понятная подпись, не NaN", () => {
  for (const r of responses(true)) {
    const h = html(r);
    assert.doesNotMatch(h, /NaN|undefined|Infinity/, r.report);
    assert.ok(h.includes("—"), `${r.report}: «—»`);
  }
  const [, subs, ai, , ret, feat] = responses(true).map(html);
  assert.ok(subs.includes("никто не решает"));
  assert.ok(ai.includes("модель не звали") && ai.includes("активных не было"));
  assert.ok(ret.includes("Когорт пока нет"));
  assert.ok(feat.includes("Счётчиков функций пока нет") && feat.includes("пока пусто"), "нет данных — так и сказано");
  assert.ok(!feat.includes("Все функции хоть раз использовались") && !feat.includes("функциями не пользовались"), "а не «все использовались»");
});

test("аналитика: шаг «час» и «неделя» — подписи корзин и пустой ряд не роняют график", () => {
  const hours: AnalyticsBucket[] = [0, 1].map((i) => {
    const from = new Date(Date.UTC(2026, 10, 24, 12 + i)).toISOString();
    return { key: from, from, to: new Date(Date.UTC(2026, 10, 24, 13 + i)).toISOString(), days: 1 / 24 };
  });
  const r = responses(false)[4];
  const meta = { ...metaOf("ret", [], hours), step: "h" as const, days: 1 as const };
  const h = renderToStaticMarkup(createElement(AnaReport, { res: { ...r, meta, data: { ...(r.data as object), series: { active: [1, 2], prev_active: [0, 1] } } } as AnalyticsResponse }));
  assert.ok(h.includes("Активные по часам"));
  assert.ok(h.includes(bucketLabel(hours[0], "h")));
  const weeks: AnalyticsBucket[] = [{ key: "2026-10-26", from: "2026-10-26", to: "2026-10-27", days: 2 }, { key: "2026-10-28", from: "2026-10-28", to: "2026-11-03", days: 7 }];
  const w = renderToStaticMarkup(createElement(AnaReport, { res: { ...r, meta: { ...metaOf("ret", [], weeks), step: "w", days: 30 }, data: { ...(r.data as object), series: { active: [1, 2], prev_active: [0, 1] } } } as AnalyticsResponse }));
  assert.ok(w.includes("26 окт. (2 дн.)"), "неполная неделя подписана");
  const none = renderToStaticMarkup(createElement(AnaReport, { res: { ...r, meta: metaOf("ret", [], []), data: { ...(r.data as object), series: { active: [], prev_active: [] } } } as AnalyticsResponse }));
  assert.ok(none.includes("Нет корзин за интервал"));
});

test("аналитика: в разделе нет имён, логинов и chat_id — только номера аккаунтов", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/screens/AdminAnalytics.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(src, /chat_id|tg_user_id|\.login\b|charge_id|\.payload\b|\.text\b/, "раздел не читает личных полей");
  assert.match(src, /visibilityState === "visible"/, "обновление — только на видимой вкладке");
  assert.match(src, /clearInterval/, "таймер снимается");
  assert.match(src, /maid\.adminAnalytics/, "интервал и шаг — в localStorage");
});

test("аналитика: окно раньше начала счётчиков функций — «копятся с …», а не «все использовались» и «не пользовались»", () => {
  const r = responses(false)[5];
  const d = r.data as { kpi: object; rows: { uses: Pair }[] };
  const nul = { ...r, data: { ...d, kpi: { ...d.kpi, used: P(null), per_person: P(null), people: P(null), unused: P(null) },
    rows: d.rows.map((x) => ({ ...x, uses: P(null), people: P(null), share: P(null) })), unused: [] } } as AnalyticsResponse;
  const h = html(nul);
  assert.ok(h.includes("Счётчики функций копятся с 24 нояб."), h.slice(0, 200));
  assert.ok(!h.includes("Все функции хоть раз использовались"));
  assert.ok(!h.includes("За интервал функциями не пользовались"));
});

test("аналитика: подсказка стрелки — в единицах карточки (доллары, проценты, секунды, звёзды), а не в сырых числах ответа", () => {
  const [money, subs, ai, , , , parse] = responses(false).map(html);
  assert.ok(ai.includes("прошлый период: $4,00"), "micro$ → доллары");
  assert.ok(!ai.includes("прошлый период: 4 000 000") && !ai.includes("прошлый период: 4000000"));
  assert.ok(money.includes("прошлый период: $2,00"), "расход на ИИ");
  assert.ok(money.includes("прошлый период: 150 ⭐"), "выручка — звёзды");
  assert.ok(subs.includes("прошлый период: 20%"), "доля → проценты");
  assert.ok(parse.includes("прошлый период: 2.3 с"), "мс → секунды");
});

test("аналитика: «Расход на ИИ» на шаге «час» показывает сноску days_for_hours", () => {
  const r = responses(false)[2];
  const h = html({ ...r, meta: { ...r.meta, notes: ["hour_from_calls", "days_for_hours"] } } as AnalyticsResponse);
  assert.ok(h.includes(ANALYTICS_NOTE_TEXT.days_for_hours));
});
