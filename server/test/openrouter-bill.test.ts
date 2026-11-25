import { PGlite } from "@electric-sql/pglite";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApi } from "../src/api.ts";
import { hashPassword } from "../src/auth.ts";
import { config } from "../src/config.ts";
import { Store } from "../src/db.ts";
import { PgDriver } from "../src/driver.ts";
import { Pipeline } from "../src/pipeline.ts";
import {
  billModels, OPENROUTER_EVERY_MS, OPENROUTER_STATE_KEY, OpenRouterBill, OpenRouterBillError, parseActivity, parseCredits, parseKeyUsage,
  reconcileDays, reconcileFlag, spentView, utcWeekStart,
} from "../src/openrouter-bill.ts";

// «Счёт OpenRouter» (openrouter-bill.ts): разбор ответов /activity, /credits, /key по формату документации OpenRouter, хранение без
// дублей, статусы (нет ключа, 401/403, таймаут, кривой JSON), сверка по дням и ручка админки. Настоящий OpenRouter не вызывается.

const NOW = new Date("2026-11-25T12:00:00Z");
const KEY = "sk-or-v1-management-SECRET-0123456789";
const LLM_KEY = "sk-or-v1-llm-SECRET-9876543210";

/** Строка /api/v1/activity как в документации (с лишним полем). */
const act = (date: string, model: string, usage: number, x: Record<string, unknown> = {}) => ({
  date, model, model_permaslug: `${model}-2025-04-14`, endpoint_id: "550e8400-e29b-41d4-a716-446655440000", provider_name: "OpenAI",
  usage, byok_usage_inference: 0, requests: 5, prompt_tokens: 50, completion_tokens: 125, reasoning_tokens: 25, cached_tokens: 10, extra_field: "x", ...x,
});

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;
/** Подмена fetch: ответ по адресу; запоминает адреса и заголовки Authorization. */
function fakeFetch(route: Route) {
  const calls: { url: string; auth: string }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, auth: String((init?.headers as Record<string, string>)?.Authorization ?? "") });
    return route(url, init);
  }) as typeof fetch;
  return { f, calls };
}
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const okRoute = (activity: unknown[]): Route => (url) =>
  url.endsWith("/activity") ? json({ data: activity })
  : url.endsWith("/credits") ? json({ data: { total_credits: 100.5, total_usage: 25.75 } })
  : url.endsWith("/key") ? json({ data: { label: "x", usage: 20, usage_daily: 0.4, usage_weekly: 2, usage_monthly: 8, byok_usage_daily: 0, is_management_key: false } })
  : json({ error: { code: 404, message: "no" } }, 404);

const BASES: [string, () => Promise<Store>][] = [
  ["SQLite", () => Store.open(":memory:")],
  ["Postgres (PGlite)", async () => {
    const pg = new PGlite();
    return Store.over(new PgDriver(pg, (fn) => pg.transaction((tx) => fn(tx)), () => pg.close()));
  }],
];

test("разбор /activity: формат документации, лишние и пропущенные поля, строки разных endpoint складываются", () => {
  const rows = parseActivity({
    data: [
      act("2026-11-20", "openai/gpt-4.1", 0.015, { byok_usage_inference: 0.012 }),
      act("2026-11-20", "openai/gpt-4.1", 0.005, { endpoint_id: "другой" }),
      act("2026-11-20", "openai/gpt-4.1", 0.001, { provider_name: "Azure" }),
      { date: "2026-11-21", model: "google/gemini-2.5-flash", usage: "0.5" }, // нет токенов и провайдера, число строкой
      { date: "плохо", model: "x", usage: 1 },
      { date: "2026-11-21", usage: 1 }, // нет модели
      { date: "2026-11-22", model_permaslug: "anthropic/claude-x-2026", usage: 0.2, requests: -3 },
      null, 7,
    ],
  })!;
  assert.equal(rows.length, 4);
  const openai = rows.find((r) => r.model === "openai/gpt-4.1" && r.provider === "OpenAI")!;
  assert.deepEqual(
    [openai.micro_usd, openai.byok_micro, openai.requests, openai.prompt_tokens, openai.completion_tokens, openai.reasoning_tokens, openai.cached_tokens],
    [20_000, 12_000, 10, 100, 250, 50, 20],
  );
  assert.equal(rows.find((r) => r.provider === "Azure")!.micro_usd, 1000, "другой провайдер — отдельная строка");
  const g = rows.find((r) => r.model === "google/gemini-2.5-flash")!;
  assert.deepEqual([g.micro_usd, g.requests, g.provider, g.prompt_tokens], [500_000, 0, "", 0]);
  assert.equal(rows.find((r) => r.model === "anthropic/claude-x-2026")!.requests, 0, "без модели — по permaslug; отрицательное — 0");
  assert.equal(parseActivity({ data: "нет" }), null);
  assert.equal(parseActivity(null), null);
  assert.equal(parseActivity({ error: { code: 403 } }), null);
  assert.deepEqual(parseActivity({ data: [] }), []);
});

test("разбор /credits и /key", () => {
  assert.deepEqual(parseCredits({ data: { total_credits: 100.5, total_usage: 25.75, more: 1 } }), { total_credits: 100.5, total_usage: 25.75 });
  assert.equal(parseCredits({ data: { total_credits: 1 } }), null);
  assert.equal(parseCredits({}), null);
  assert.equal(parseCredits("x"), null);
  assert.deepEqual(parseKeyUsage({ data: { usage_daily: 1, usage_weekly: 3, usage_monthly: 9, byok_usage_daily: 0.5 } }),
    { daily: 1, weekly: 3, monthly: 9, byok_daily: 0.5, byok_weekly: 0, byok_monthly: 0 });
  assert.deepEqual(parseKeyUsage({ data: { usage_daily: 2 } }), { daily: 2, weekly: 2, monthly: 2, byok_daily: 0, byok_weekly: 0, byok_monthly: 0 });
  assert.equal(parseKeyUsage({ data: { usage: 5 } }), null);
});

for (const [name, open] of BASES) {
  test(`${name}: загрузка — хранение без дублей, повтор того же дня заменяет; баланс; ключ — только в заголовке`, async () => {
    const store = await open();
    try {
      let activity = [act("2026-11-20", "openai/gpt-4.1", 0.015), act("2026-11-24", "openai/gpt-4.1", 1.25), act("2026-11-25", "x/today", 9)];
      const { f, calls } = fakeFetch((url, init) => okRoute(activity)(url, init));
      const bill = new OpenRouterBill(store, { key: KEY, usageKeys: [LLM_KEY, LLM_KEY, ""], fetch: f });
      const s = await bill.refresh(NOW);
      assert.equal(s.status, "ok");
      assert.equal(s.rows, 2, "сегодняшняя строка — вне окна 30 завершённых дней");
      assert.deepEqual(s.credits, { total_credits: 100.5, total_usage: 25.75 });
      assert.deepEqual([s.spent?.daily, s.spent?.weekly, s.spent?.monthly, s.spent?.keys], [0.4, 2, 8, 1], "одинаковые ключи — один раз");
      assert.equal(s.covered_from, "2026-10-26");
      assert.equal(s.covered_to, "2026-11-24");
      assert.deepEqual(calls.map((c) => c.url.replace("https://openrouter.ai/api/v1", "")), ["/activity", "/credits", "/key"]);
      assert.equal(calls[0].auth, `Bearer ${KEY}`);
      assert.equal(calls[2].auth, `Bearer ${LLM_KEY}`, "/key — ключом сервера");
      // Повторная загрузка того же дня — замена, а не сумма; день, пропавший из ответа, — тоже уходит.
      activity = [act("2026-11-24", "openai/gpt-4.1", 1.5)];
      await bill.refresh(new Date(NOW.getTime() + 3600_000));
      const rows = await store.openRouterBill("2026-10-01", "2026-11-30");
      assert.deepEqual(rows.map((r) => [r.day, r.model, r.micro_usd]), [["2026-11-24", "openai/gpt-4.1", 1_500_000]]);
      const raw = (await store.kvGet(OPENROUTER_STATE_KEY))!;
      assert.ok(!raw.includes("SECRET"), "в kv ключа нет");
    } finally {
      await store.close();
    }
  });
}

test("статусы: нет ключа, 401, 403, таймаут, нет сети, 500, кривой JSON — без падения; прошлые данные и время удачи остаются", async () => {
  const store = await Store.open(":memory:");
  try {
    const none = fakeFetch(() => json({}));
    const s0 = await new OpenRouterBill(store, { fetch: none.f }).refresh(NOW);
    assert.equal(s0.status, "no_key");
    assert.equal(none.calls.length, 0, "без ключа — ни одного запроса");

    let mode = "ok";
    const { f } = fakeFetch(async (url, init) => {
      if (mode === "401") return json({ error: { code: 401, message: "Missing Authentication header" } }, 401);
      if (mode === "403") return json({ error: { code: 403, message: "Only management keys can perform this operation" } }, 403);
      if (mode === "500") return json({ error: { code: 500, message: "Internal Server Error" } }, 500);
      if (mode === "bad") return new Response("<html>не json", { status: 200 });
      if (mode === "shape") return json({ items: [] });
      if (mode === "net") throw new TypeError("fetch failed");
      if (mode === "slow") return new Promise<Response>((_, fail) => init?.signal?.addEventListener("abort", () => fail(init.signal!.reason)));
      return okRoute([act("2026-11-24", "openai/gpt-4.1", 2)])(url, init);
    });
    const bill = new OpenRouterBill(store, { key: KEY, fetch: f, timeoutMs: 50 });
    const ok = await bill.refresh(NOW);
    assert.equal(ok.status, "ok");
    const want: Record<string, [string, RegExp]> = {
      "401": ["bad_key", /управляющий ключ/], "403": ["bad_key", /403/], slow: ["no_net", /нет ответа/], net: ["no_net", /нет связи/],
      "500": ["error", /500/], bad: ["error", /не разобрался/], shape: ["error", /не разобрался/],
    };
    for (const [m, [status, text]] of Object.entries(want)) {
      mode = m;
      const s = await bill.refresh(new Date(NOW.getTime() + 60_000));
      assert.equal(s.status, status, m);
      assert.match(s.error, text, m);
      assert.ok(!s.error.includes("SECRET") && !s.error.includes("Only management"), "текст — наш, без ключа и тела ответа");
      assert.equal(s.ok_at, NOW.toISOString(), `${m}: время последней удачной загрузки`);
      assert.deepEqual(s.credits, { total_credits: 100.5, total_usage: 25.75 }, `${m}: баланс прежний`);
      assert.equal((await store.openRouterBill("2026-11-24", "2026-11-24")).length, 1, `${m}: строки прежние`);
    }
  } finally {
    await store.close();
  }
});

test("раз в час: без ключа запросов нет; с ключом — не чаще часа по времени прошлой попытки", async () => {
  const store = await Store.open(":memory:");
  try {
    const { f, calls } = fakeFetch(okRoute([]));
    const bill = new OpenRouterBill(store, { key: KEY, fetch: f });
    await bill.hourly(NOW);
    assert.equal(calls.filter((c) => c.url.endsWith("/activity")).length, 1);
    await bill.hourly(new Date(NOW.getTime() + OPENROUTER_EVERY_MS - 1000));
    assert.equal(calls.filter((c) => c.url.endsWith("/activity")).length, 1, "меньше часа — ждём");
    await bill.hourly(new Date(NOW.getTime() + OPENROUTER_EVERY_MS));
    assert.equal(calls.filter((c) => c.url.endsWith("/activity")).length, 2);
    const nk = fakeFetch(okRoute([]));
    const s2 = await Store.open(":memory:");
    const nobody = new OpenRouterBill(s2, { fetch: nk.f });
    await nobody.hourly(NOW);
    await nobody.hourly(new Date(NOW.getTime() + 5 * OPENROUTER_EVERY_MS));
    assert.equal(nk.calls.length, 0);
    assert.equal((await nobody.state()).status, "no_key");
    await s2.close();
  } finally {
    await store.close();
  }
});

test("сверка по дням: нет наших записей, нет данных OpenRouter, расхождение, края порогов, сегодня", () => {
  assert.equal(reconcileFlag(1, 1.05), false, "5% — не подсвечивать");
  assert.equal(reconcileFlag(1, 1.2), true, "больше 10% и больше $0.01");
  assert.equal(reconcileFlag(0.05, 0.08), true);
  assert.equal(reconcileFlag(0.005, 0.012), false, "разница меньше $0.01 — даже при 140%");
  assert.equal(reconcileFlag(0, 0), false);
  const row = (day: string, usd: number) => ({ day, model: "m", provider: "p", micro_usd: Math.round(usd * 1e6), byok_micro: 0, requests: 3, prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0, cached_tokens: 0 });
  const days = reconcileDays("2026-11-20", "2026-11-25",
    [row("2026-11-21", 0.5), row("2026-11-22", 1), row("2026-11-23", 0.2), row("2026-11-23", 0.1)],
    [{ day: "2026-11-20", micro: 300_000, calls: 4, unpriced: 1 }, { day: "2026-11-22", micro: 1_000_000, calls: 9, unpriced: 0 }, { day: "2026-11-25", micro: 70_000, calls: 2, unpriced: 0 }],
    { from: "2026-11-21", to: "2026-11-24" });
  const by = Object.fromEntries(days.map((d) => [d.day, d]));
  assert.equal(days.length, 6);
  assert.deepEqual([by["2026-11-20"].bill, by["2026-11-20"].flag, by["2026-11-20"].ours], [null, false, 0.3], "вне загруженного окна — нет данных, не ноль");
  assert.deepEqual([by["2026-11-21"].bill, by["2026-11-21"].ours, by["2026-11-21"].flag], [0.5, 0, true], "нет наших записей — расхождение");
  assert.deepEqual([by["2026-11-22"].flag, by["2026-11-22"].diff], [false, 0]);
  assert.ok(Math.abs(by["2026-11-23"].bill! - 0.3) < 1e-9, "строки одного дня складываются");
  assert.equal(by["2026-11-23"].requests, 6);
  assert.deepEqual([by["2026-11-24"].bill, by["2026-11-24"].flag], [0, false], "в окне без строк — ноль, ноль против нуля — без подсветки");
  assert.deepEqual([by["2026-11-25"].today, by["2026-11-25"].bill, by["2026-11-25"].flag, by["2026-11-25"].ours], [true, null, false, 0.07]);
  assert.equal(reconcileDays("2026-11-20", "2026-11-21", [], [], null).every((d) => d.bill == null && !d.flag), true, "ни разу не загружали");
  const models = billModels([row("2026-11-21", 0.5), { ...row("2026-11-22", 1.5), provider: "q" }, { ...row("2026-11-22", 1), model: "b" }]);
  assert.deepEqual(models.map((m) => [m.model, m.cost, m.requests, m.providers.join(",")]), [["m", 2, 6, "p,q"], ["b", 1, 3, "p"]]);
  assert.ok(Math.abs(models[0].share - 2 / 3) < 1e-9);
});

// ——— Ручка админки: тем же путём, что сайт (вход → код из «Telegram» → /api/admin/*).
const OWNER = "987654321";
test("админка: GET /api/admin/openrouter и «Обновить» — 404 не админу, 403 без кода, причина, журнал, раз в минуту, без ключа в ответе", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maid-orbill-"));
  config.allowedChatIds.splice(0, Infinity, OWNER);
  config.adminChatIds.splice(0, Infinity);
  const store = await Store.open(path.join(dir, "maid.sqlite"));
  await store.createUser({ login: "owner", passwordHash: await hashPassword("owner-pass-1"), tz: "Europe/Moscow", chatId: OWNER, name: "Хозяин" });
  await store.createUser({ login: "anya", passwordHash: await hashPassword("anya-pass-1"), tz: "Europe/Moscow", chatId: "11", name: "Аня" });
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
  await store.addUsage(new Date(`${yesterday}T10:00:00Z`), { kind: "parse", model: "openai/gpt-4.1", input: 10, output: 5, cost: 0.4, userId: 2 });
  const { f, calls } = fakeFetch(okRoute([act(yesterday, "openai/gpt-4.1", 1), act(yesterday, "openai/gpt-4.1", 0.5, { provider_name: "Azure" })]));
  const openrouter = new OpenRouterBill(store, { key: KEY, usageKeys: [LLM_KEY], fetch: f });
  const tg: string[] = [];
  const server = createApi({ store, pipeline: new Pipeline(store, async () => "{}"), adminCode: async (_u, text) => void tg.push(text), openrouter }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (token: string, p: string, body?: unknown) => {
    const r = await fetch(base + p, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, text: await r.text() };
  };
  const login = async (l: string, pw: string) => String((await (await fetch(base + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: l, password: pw }) })).json()).token);
  try {
    const anya = await login("anya", "anya-pass-1");
    assert.equal((await call(anya, "/api/admin/openrouter")).status, 404, "не админу — адреса нет");
    assert.equal((await call(anya, "/api/admin/openrouter/refresh", { reason: "проверка" })).status, 404);
    const owner = await login("owner", "owner-pass-1");
    assert.equal((await call(owner, "/api/admin/openrouter")).status, 403, "без кода");
    assert.equal((await call(owner, "/api/admin/openrouter/refresh", { reason: "проверка" })).status, 403);
    await call(owner, "/api/admin/code", {});
    assert.equal((await call(owner, "/api/admin/confirm", { code: tg.at(-1)!.match(/\d{6}/)![0] })).status, 200);

    const v0 = JSON.parse((await call(owner, "/api/admin/openrouter")).text);
    assert.equal(v0.status, "never", "ещё не загружали");
    assert.equal(v0.has_key, true);
    assert.equal(calls.length, 0, "GET не ходит в OpenRouter");

    assert.equal((await call(owner, "/api/admin/openrouter/refresh", {})).status, 400, "без причины");
    assert.equal(calls.length, 0);
    const r1 = await call(owner, "/api/admin/openrouter/refresh", { reason: "сверка счёта" });
    assert.equal(r1.status, 200);
    const v = JSON.parse(r1.text);
    assert.equal(v.status, "ok");
    assert.equal(v.days.length, 31);
    assert.equal(v.to, today);
    const y = v.days.find((d: { day: string }) => d.day === yesterday);
    assert.deepEqual([y.bill, y.ours, y.flag, y.requests], [1.5, 0.4, true, 10]);
    assert.equal(v.models[0].model, "openai/gpt-4.1");
    assert.deepEqual(v.models[0].providers, ["Azure", "OpenAI"]);
    assert.deepEqual(v.credits, { total: 100.5, used: 25.75, left: 74.75 });
    assert.equal(v.spent.daily, 0.4);
    for (const bad of [KEY, LLM_KEY, "SECRET", "Аня", "anya", "Хозяин", OWNER]) assert.ok(!r1.text.includes(bad), `нет «${bad}» в ответе`);

    const again = await call(owner, "/api/admin/openrouter/refresh", { reason: "ещё раз" });
    assert.equal(again.status, 429, "не чаще раза в минуту");
    assert.match(JSON.parse(again.text).error, /раза в минуту/);

    const log = await store.adminLog(10);
    const mine = log.filter((x) => x.action === "openrouter_refresh");
    assert.equal(mine.length, 1, "одна запись: 400 и 429 не пишутся");
    assert.equal(mine[0].reason, "сверка счёта");
    assert.match(mine[0].detail, /статус: ok/);
    assert.ok(!JSON.stringify(log).includes("SECRET"), "ключа нет в журнале");
    const j = await call(owner, "/api/admin/log");
    assert.ok(!j.text.includes("SECRET"));
  } finally {
    server.close();
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ошибка от кнопки — класс с кодом", () => {
  const e = new OpenRouterBillError(429, "x");
  assert.equal(e.status, 429);
});

test("потрачено: прошлый день, неделя, месяц UTC — не выдаётся за текущий; сломанный ключ — сумма ответивших и сколько не ответило", async () => {
  assert.deepEqual(["2026-11-25", "2026-11-23", "2026-11-29", "2026-11-30"].map(utcWeekStart), ["2026-11-23", "2026-11-23", "2026-11-23", "2026-11-30"]);
  const sp = { daily: 4.2, weekly: 10, monthly: 30, byok_daily: 0.1, byok_weekly: 0.2, byok_monthly: 0.3, keys: 2, missing: 0 };
  assert.equal(spentView(sp, "2026-11-25T23:30:00Z", new Date("2026-11-25T23:59:00Z"))?.daily, 4.2, "тот же день");
  const nextDay = spentView(sp, "2026-11-25T23:30:00Z", new Date("2026-11-26T00:30:00Z"))!;
  assert.deepEqual([nextDay.daily, nextDay.byok_daily, nextDay.weekly, nextDay.monthly], [null, null, 10, 30], "новый день: «сегодня» — нет");
  const nextWeek = spentView(sp, "2026-11-29T23:30:00Z", new Date("2026-11-30T00:30:00Z"))!;
  assert.deepEqual([nextWeek.daily, nextWeek.weekly, nextWeek.monthly], [null, null, 30], "новая неделя (пн)");
  const nextMonth = spentView(sp, "2026-11-30T23:30:00Z", new Date("2026-12-01T00:30:00Z"))!;
  assert.deepEqual([nextMonth.daily, nextMonth.weekly, nextMonth.monthly, nextMonth.byok_monthly], [null, 10, null, null], "новый месяц, та же неделя");
  assert.equal(spentView(null, null, NOW), null);

  const store = await Store.open(":memory:");
  try {
    const DRAW_KEY = "sk-or-v1-draw-SECRET-1111";
    let mode = "ok";
    const { f } = fakeFetch((url, init) => {
      if (mode === "net") throw new TypeError("fetch failed");
      const auth = String((init?.headers as Record<string, string>)?.Authorization ?? "");
      if (mode === "drawBroken" && url.endsWith("/key") && auth.includes(DRAW_KEY)) return json({ error: { code: 401, message: "revoked" } }, 401);
      return okRoute([])(url, init);
    });
    const bill = new OpenRouterBill(store, { key: KEY, usageKeys: [LLM_KEY, DRAW_KEY], fetch: f });
    const late = new Date("2026-11-25T23:30:00Z");
    const s1 = await bill.refresh(late);
    assert.deepEqual([s1.spent?.daily, s1.spent?.keys, s1.spent?.missing], [0.8, 2, 0]);
    // 00:30 UTC: OpenRouter не ответил — spent прежний со своим временем, но «Сегодня» в ответе ручки — прочерк, не вчерашние $0.80.
    mode = "net";
    const morning = new Date("2026-11-26T00:30:00Z");
    await bill.refresh(morning);
    const v = await bill.view(morning);
    assert.equal(v.spent_at, late.toISOString(), "время цифр — прежнее");
    assert.equal(v.spent?.daily, null, "вчерашний день не показан как сегодняшний");
    assert.equal(v.spent?.weekly, 4, "неделя та же");
    // Ключ рисования отозван (401) навсегда — сумма по ответившему ключу, свежая, и сколько не ответило.
    mode = "drawBroken";
    const s3 = await bill.refresh(new Date("2026-11-26T01:30:00Z"));
    assert.deepEqual([s3.spent?.daily, s3.spent?.keys, s3.spent?.missing, s3.spent_at], [0.4, 1, 1, "2026-11-26T01:30:00.000Z"]);
    const v3 = await bill.view(new Date("2026-11-26T01:31:00Z"));
    assert.deepEqual([v3.spent?.daily, v3.spent?.missing], [0.4, 1]);
  } finally {
    await store.close();
  }
});

test("такт планировщика не ждёт загрузку: hourlyInBackground возвращается сразу, вторая загрузка не начинается", async () => {
  const store = await Store.open(":memory:");
  try {
    let release!: () => void;
    const gate = new Promise<void>((ok) => { release = ok; });
    const { f, calls } = fakeFetch(async (url, init) => { await gate; return okRoute([])(url, init); });
    const bill = new OpenRouterBill(store, { key: KEY, fetch: f });
    const t0 = Date.now();
    assert.equal(bill.hourlyInBackground(NOW), undefined);
    assert.ok(Date.now() - t0 < 100, "вернулся сразу");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls.filter((c) => c.url.endsWith("/activity")).length, 1, "загрузка пошла");
    bill.hourlyInBackground(new Date(NOW.getTime() + 30_000));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls.filter((c) => c.url.endsWith("/activity")).length, 1, "следующий такт — без второй загрузки");
    release();
    for (let i = 0; i < 50 && (await bill.state()).status !== "ok"; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal((await bill.state()).status, "ok", "загрузка закончилась сама");
  } finally {
    await store.close();
  }
});

test("«Обновить» во время загрузки — 429 без второй строки журнала; пауза в минуту — от нажатия, а не от конца загрузки", async () => {
  const store = await Store.open(":memory:");
  try {
    let release!: () => void;
    const gate = new Promise<void>((ok) => { release = ok; });
    const { f, calls } = fakeFetch(async (url, init) => { await gate; return okRoute([])(url, init); });
    const bill = new OpenRouterBill(store, { key: KEY, fetch: f });
    const first = bill.manual(1, "сверка", NOW);
    await assert.rejects(bill.manual(1, "ещё раз", new Date(NOW.getTime() + 5_000)), (e: OpenRouterBillError) => e.status === 429 && /уже обновляется|раза в минуту/.test(e.message));
    await new Promise((r) => setTimeout(r, 20));
    await assert.rejects(bill.manual(1, "третий", new Date(NOW.getTime() + 10_000)), (e: OpenRouterBillError) => e.status === 429 && /уже обновляется/.test(e.message));
    release();
    assert.equal((await first).status, "ok");
    // Загрузка кончилась (checked_at = NOW), но 40 с с нажатия — всё ещё рано.
    await assert.rejects(bill.manual(1, "четвёртый", new Date(NOW.getTime() + 40_000)), (e: OpenRouterBillError) => e.status === 429 && /раза в минуту/.test(e.message));
    const log = (await store.adminLog(10)).filter((x) => x.action === "openrouter_refresh");
    assert.equal(log.length, 1, "в журнале одна запись");
    assert.equal(log[0].reason, "сверка");
    assert.equal(calls.filter((c) => c.url.endsWith("/activity")).length, 1);
    // Через минуту — можно.
    assert.equal((await bill.manual(1, "через минуту", new Date(NOW.getTime() + 61_000))).status, "ok");
  } finally {
    await store.close();
  }
});
