import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ADMIN_ACTIONS, openRouterDiffText, openRouterStatus, signedUsd, type OpenRouterData, type OpenRouterStatus } from "../src/admin.ts";
import { OpenRouterPanel, tokText } from "../src/screens/AdminOpenRouter.tsx";

// «Счёт OpenRouter» в «Расходах на модель»: статусы, разница по дням, рендер блока при каждом статусе (без сети).

const day = (d: string, bill: number | null, ours: number, flag = false, today = false) => ({
  day: d, bill, byok: bill == null ? null : 0, requests: bill == null ? null : 4, ours, ours_calls: 3, ours_unpriced: 0,
  diff: bill == null ? null : bill - ours, flag, today,
});
function data(x: Partial<OpenRouterData> = {}): OpenRouterData {
  return {
    status: "ok", has_key: true, error: "", checked_at: "2026-11-25T11:00:00Z", ok_at: "2026-11-25T11:00:00Z",
    credits: { total: 100.5, used: 25.75, left: 74.75 }, credits_at: "2026-11-25T11:00:00Z",
    spent: { daily: 0.4, weekly: 2, monthly: 8, byok_daily: 0, byok_weekly: 0, byok_monthly: 0, keys: 1, missing: 0 }, spent_at: "2026-11-25T11:00:00Z",
    from: "2026-11-23", to: "2026-11-25",
    days: [day("2026-11-23", 1.5, 0.4, true), day("2026-11-24", 0.5, 0.5), day("2026-11-25", null, 0.07, false, true)],
    models: [{ model: "openai/gpt-4.1", providers: ["Azure", "OpenAI"], cost: 2, byok: 0, requests: 8, prompt: 2_500, completion: 3_200_000, reasoning: 0, share: 1 }],
    total: { bill: 2, byok: 0, requests: 8, ours: 0.9 }, every_min: 60, gap_s: 60, share: 0.1, usd: 0.01, ...x,
  };
}
const render = (d: OpenRouterData) => renderToStaticMarkup(createElement(OpenRouterPanel, { data: d, onFresh: () => {}, note: null, setNote: () => {} }));

test("статусы по-человечески; действие в журнале названо", () => {
  assert.equal(openRouterStatus({ status: "ok", error: "" }).tone, "ok");
  assert.match(openRouterStatus({ status: "no_key", error: "" }).text, /ключ не задан/);
  assert.match(openRouterStatus({ status: "bad_key", error: "" }).text, /управляющий ключ/);
  assert.match(openRouterStatus({ status: "no_net", error: "нет ответа за 15 с" }).text, /нет связи.*15 с/);
  assert.equal(openRouterStatus({ status: "error", error: "OpenRouter ответил 500" }).text, "OpenRouter ответил 500");
  assert.match(openRouterStatus({ status: "never", error: "" }).text, /ещё не загружали/);
  assert.equal(ADMIN_ACTIONS.openrouter_refresh, "обновил счёт OpenRouter");
});

test("разница дня и деньги со знаком; токены коротко", () => {
  assert.equal(openRouterDiffText({ bill: 1.5, ours: 0.4, diff: 1.1 }), "+$1.10 (73%)");
  assert.equal(openRouterDiffText({ bill: 0, ours: 0.05, diff: -0.05 }), "−$0.050 (100%)");
  assert.equal(openRouterDiffText({ bill: 0.5, ours: 0.5, diff: 0 }), "$0");
  assert.equal(openRouterDiffText({ bill: null, ours: 0.3, diff: null }), "—");
  assert.equal(signedUsd(0), "$0");
  assert.deepEqual([tokText(950), tokText(12_500), tokText(3_200_000)], ["950", "13 тыс.", "3,2 млн"]);
});

test("рендер: загружено — баланс, потрачено, график, модели, сверка с подсветкой и пояснением", () => {
  const h = render(data());
  for (const s of ["Счёт OpenRouter", "Остаток кредитов", "$74.75", "куплено $100.50", "$0.40", "$8.00", "openai/gpt-4.1", "Azure, OpenAI",
    "2,5 тыс.", "3,2 млн", "100%", "Сверка по дням", "adm-or-flag", "+$1.10 (73%)", "сегодня — OpenRouter считает только завершённые дни",
    "BYOK", "RunPod", "запаздывает", "Обновить", "Причина"]) assert.ok(h.includes(s), `есть «${s}»`);
  assert.equal(h.match(/adm-or-flag/g)?.length, 1, "подсвечен один день");
  assert.ok(h.includes("<svg"), "график");
});

test("рендер при каждом статусе: без падения, понятный текст, без счёта — без графика и таблицы моделей", () => {
  const empty = { credits: null, spent: null, ok_at: null, models: [], total: { bill: 0, byok: 0, requests: 0, ours: 0 }, days: [day("2026-11-24", null, 0.5), day("2026-11-25", null, 0.07, false, true)] };
  const cases: [OpenRouterStatus, Partial<OpenRouterData>, RegExp][] = [
    ["never", empty, /ещё не загружали/],
    ["no_key", { ...empty, has_key: false, error: "ключ не задан (OPENROUTER_MANAGEMENT_KEY)" }, /ключ не задан/],
    ["bad_key", { ...empty, error: "ключ не подходит (OpenRouter ответил 403) — нужен управляющий ключ" }, /управляющий ключ/],
    ["no_net", { ...empty, error: "нет ответа за 15 с" }, /нет связи с OpenRouter/],
    ["error", { ...empty, error: "ответ OpenRouter не разобрался" }, /не разобрался/],
  ];
  for (const [status, x, text] of cases) {
    const h = render(data({ status, ...x }));
    assert.match(h, text, status);
    assert.ok(!h.includes("<svg"), `${status}: без графика`);
    assert.ok(!h.includes("По моделям за 30 дней"), `${status}: без таблицы моделей`);
    assert.ok(h.includes("нет данных OpenRouter"), `${status}: сверка показывает «нет данных»`);
    assert.ok(h.includes("Остаток кредитов") && h.includes("—"), `${status}: прочерки вместо чисел`);
  }
  assert.ok(render(data({ status: "no_key", has_key: false, ...empty })).includes("disabled"), "без ключа кнопка неактивна");
  // Ошибка после удачной загрузки: прежние данные видны, статус — ошибка.
  const stale = render(data({ status: "no_net", error: "нет связи с OpenRouter", checked_at: "2026-11-25T12:00:00Z" }));
  assert.match(stale, /нет связи/);
  assert.ok(stale.includes("openai/gpt-4.1"), "прошлые данные остаются");
  // Счёт загружен, но строк нет — пояснение, а не пустая таблица.
  const zero = render(data({ models: [], days: [day("2026-11-24", 0, 0), day("2026-11-25", null, 0, false, true)], total: { bill: 0, byok: 0, requests: 0, ours: 0 } }));
  assert.ok(zero.includes("За 30 дней OpenRouter расхода не видел."));
});

test("время цифр: баланс и «потрачено» с меткой «на …»; не обновились — «не обновилось»; прошлый день UTC — прочерк «устарело»", () => {
  const fresh = render(data());
  assert.ok(fresh.includes("по ключу сервера, день UTC · на "), "у «Сегодня» — время цифр");
  assert.ok(fresh.includes("по ключу сервера, неделя пн–вс UTC") && fresh.includes("по ключу сервера, месяц с 1-го числа UTC"), "неделя и месяц — тоже по ключам сервера");
  assert.ok(!fresh.includes("не обновилось"), "свежие — без пометки");
  // /credits и /key не ответили, /activity загрузился позже: прежние цифры помечены.
  const old = render(data({ ok_at: "2026-11-25T14:00:00Z", checked_at: "2026-11-25T14:00:00Z", credits_at: "2026-11-22T10:00:00Z", spent_at: "2026-11-25T11:00:00Z" }));
  assert.equal(old.match(/не обновилось, данные на/g)?.length, 4, "баланс и три плашки «потрачено»");
  // Сервер отдал daily = null (spent_at — вчера по UTC): прочерк и «устарело», а не вчерашняя сумма.
  const stale = render(data({ spent: { daily: null, weekly: 2, monthly: 8, byok_daily: null, byok_weekly: 0, byok_monthly: 0, keys: 1, missing: 0 }, spent_at: "2026-11-24T23:30:00Z" }));
  assert.ok(stale.includes("устарело: данные на"), "«Сегодня» — устарело");
  assert.ok(stale.includes('<span>Сегодня</span><b class="adm-num">—</b>'), "вчерашние $0.40 не показаны как сегодняшние");
  assert.ok(stale.includes("$2.00") && stale.includes("$8.00"));
  // Один ключ сервера не ответил — видно.
  assert.ok(render(data({ spent: { daily: 0.4, weekly: 2, monthly: 8, byok_daily: 0, byok_weekly: 0, byok_monthly: 0, keys: 1, missing: 1 } })).includes("не ответило ключей: 1"));
});

test("пояснение: счёт — весь аккаунт OpenRouter, наши записи — только этот сервер", () => {
  const h = render(data());
  assert.ok(h.includes("по всему аккаунту") && h.includes("ваши личные и тестовые") && h.includes("только этот сервер"));
  assert.ok(h.includes("весь аккаунт OpenRouter · наши записи"), "плашка «За 30 дн.» подписана");
});

test("длинный статус блока переносится (на телефоне не вылезает за панель)", async () => {
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("../src/admin.css", import.meta.url), "utf8");
  assert.match(css, /\.adm-or-status \.adm-al-st \{[^}]*white-space: normal;[^}]*overflow-wrap: anywhere;/);
  const h = render(data({ status: "no_key", has_key: false }));
  assert.match(h, /<p class="adm-or-status"><span class="adm-al-st warn">ключ не задан/);
});
