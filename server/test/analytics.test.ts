import { PGlite } from "@electric-sql/pglite";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import {
  analyticsReport, ANALYTICS_CACHE_MS, ANALYTICS_DAYS, cachedAnalytics, parseAnalyticsQuery, resetAnalyticsCache,
  type AnalyticsDays, type AnalyticsReportId, type AnalyticsResponse, type AnalyticsStep,
} from "../src/admin-analytics.ts";
import { createApi } from "../src/api.ts";
import { hashPassword } from "../src/auth.ts";
import { config } from "../src/config.ts";
import { COLLECT_SINCE_KEY, Store } from "../src/db.ts";
import { PgDriver } from "../src/driver.ts";
import { FEATURES, FUNCTIONS } from "../src/feature-list.ts";
import { Pipeline } from "../src/pipeline.ts";
import { overrideTariffs } from "../src/tariffs.ts";
import { addDays, dayKey } from "../src/time.ts";

// Аналитика, этап 1 (24.11.2026, docs/review/аналитика-макет-2026-11-24.html): GET /api/admin/analytics — семь отчётов на SQLite
// и Postgres, текущий и прошлый период, шаги час / день / неделя, 400 на недопустимые сочетания, кэш 60 с, без текстов и имён.

const BACKENDS: Record<string, () => Promise<Store>> = {
  sqlite: () => Store.open(":memory:"),
  postgres: async () => {
    const pg = new PGlite();
    return Store.over(new PgDriver(pg, (fn) => pg.transaction((tx) => fn(tx)), () => pg.close()));
  },
};

const NOW = new Date("2026-11-24T12:00:00Z");
const TZ = "Europe/Moscow";
const H = 3_600_000, DAY = 86_400_000;
const SECRET = "секретный текст сообщения";
const OWNER_CHAT = "1001";
config.defaultTimezone = TZ;
overrideTariffs({ starUsd: 0.013 }); // курс ⭐→$ не из .env (STAR_USD)
config.allowedChatIds.splice(0, Infinity, OWNER_CHAT);
config.adminChatIds.splice(0, Infinity);

const ago = (days: number, hours = 0) => new Date(NOW.getTime() - days * DAY - hours * H);
const at = (s: string) => new Date(s);
const dk = (d: Date) => dayKey(d, TZ);
const T = dk(NOW); // 2026-11-24 (и по Москве, и по UTC)

async function each(fn: (store: Store, name: string) => Promise<void>) {
  for (const [name, open] of Object.entries(BACKENDS)) {
    const store = await open();
    try {
      await fn(store, name);
    } finally {
      await store.close();
    }
  }
}
const run = (store: Store, report: AnalyticsReportId, days: AnalyticsDays, step: AnalyticsStep) => analyticsReport(store, { report, days, step }, NOW);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const data = (r: AnalyticsResponse) => r.data as any;

let seq = 0;
async function person(store: Store, opts: { created?: Date; plan?: string; until?: Date | null; chat?: string; canceled?: boolean } = {}) {
  const login = `loginsecret${++seq}`;
  const u = await store.createUser({
    login, passwordHash: "x", tz: TZ, name: `Секретное Имя ${login}`, chatId: opts.chat ?? `77700${seq}`, plan: opts.plan ?? "",
    accessUntil: opts.until ? opts.until.toISOString() : null, at: opts.created ?? at("2026-09-01T12:00:00Z"),
  });
  if (opts.canceled) await store.updateUser(u.id, { sub_canceled: 1 });
  return u.id;
}
async function msg(store: Store, userId: number, source: string, when: Date, sourceId?: string) {
  return (await store.saveMessage({ userId, source, sourceId: sourceId ?? `s${++seq}`, text: SECRET, dayKey: dk(when), at: when })).message;
}
async function pay(store: Store, charge: string, userId: number, amount: number, kind: string, paid: Date, expires: Date | null = null, currency = "XTR") {
  await store.addPayment({
    charge_id: charge, user_id: userId, tg_user_id: "tg-secret-555", amount, currency, payload: "payload-secret", kind,
    paid_at: paid.toISOString(), expires_at: expires ? expires.toISOString() : null,
  });
}

test("корзины: длины d / h / w, прошлый период той же длины, ключи часа — ISO UTC", async () => {
  await each(async (store, name) => {
    for (const report of ["money", "subs", "ai", "act", "ret", "feat", "parse"] as AnalyticsReportId[]) {
      for (const days of ANALYTICS_DAYS) {
        const steps: AnalyticsStep[] = days <= 7 ? ["h", "d"] : ["d", "w"];
        for (const step of steps) {
          const r = await run(store, report, days, step);
          const m = r.meta;
          const want = step === "h" ? 24 * days : step === "d" ? days : Math.ceil(days / 7);
          const where = `${name} ${report} ${days} ${step}`;
          assert.equal(m.buckets.length, want, where);
          assert.equal(m.prev_buckets.length, want, `${where}: прошлый той же длины`);
          assert.equal(r.report, report);
          assert.equal(m.star_usd, 0.013);
          assert.equal(m.cached, false);
          assert.equal(m.zone, ["money", "subs", "ai"].includes(report) ? "utc" : "user", where);
          if (step === "h") {
            for (const b of m.buckets) assert.match(b.key, /^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/, where);
            assert.equal(m.buckets.at(-1)!.key, "2026-11-24T12:00:00.000Z", `${where}: последний час — нынешний`);
            assert.equal(m.period.to, "2026-11-24T13:00:00.000Z");
            assert.equal(m.prev.to, m.period.from, `${where}: прошлый — сразу перед текущим`);
            assert.equal(m.buckets[0].days, 1 / 24);
          } else {
            assert.equal(m.today, T);
            assert.equal(m.period.to, T);
            assert.equal(m.period.from, addDays(T, 1 - days));
            assert.deepEqual(m.prev, { from: addDays(T, 1 - 2 * days), to: addDays(T, -days) }, where);
            assert.equal(m.buckets.at(-1)!.to, T);
            assert.equal(m.buckets[0].from, m.period.from);
            assert.equal(m.buckets.reduce((s, b) => s + b.days, 0), days, `${where}: корзины покрывают период`);
          }
          // Ряды — по длине корзин.
          const d = data(r);
          if (d.series) for (const [k, v] of Object.entries(d.series)) {
            if (Array.isArray(v)) assert.equal(v.length, want, `${where}: series.${k}`);
            else for (const [k2, v2] of Object.entries(v as object)) assert.equal((v2 as unknown[]).length, want, `${where}: series.${k}.${k2}`);
          }
        }
      }
    }
    const w30 = (await run(store, "money", 30, "w")).meta.buckets;
    assert.deepEqual(w30.map((b) => [b.from, b.to, b.days]), [
      ["2026-10-26", "2026-10-27", 2], ["2026-10-28", "2026-11-03", 7], ["2026-11-04", "2026-11-10", 7], ["2026-11-11", "2026-11-17", 7], ["2026-11-18", "2026-11-24", 7],
    ], "30 дней — 5 корзин, первая — 2 дня");
    assert.equal((await run(store, "act", 90, "w")).meta.buckets[0].days, 6);
    const w365 = (await run(store, "act", 365, "w")).meta;
    assert.equal(w365.buckets.length, 53);
    assert.equal(w365.buckets[0].days, 1);
    assert.equal(w365.prev_buckets.at(-1)!.to, addDays(T, -365));
  });
});

test("параметры: 400 на недопустимые сочетания и незнакомые значения", () => {
  const q = (s: string) => parseAnalyticsQuery(`/api/admin/analytics?${s}`);
  assert.deepEqual(q("report=money"), { report: "money", days: 30, step: "d" }, "по умолчанию 30 дней, шаг день");
  assert.deepEqual(q("report=act&days=7&step=h"), { report: "act", days: 7, step: "h" });
  assert.deepEqual(q("report=ret&days=365&step=w"), { report: "ret", days: 365, step: "w" });
  for (const bad of ["report=money&days=30&step=h", "report=money&days=7&step=w", "report=nope", "report=money&days=14", "", "report=money&step=x", "report=money&days=abc"]) {
    assert.throws(() => q(bad), (e: { status?: number }) => e.status === 400, bad);
  }
  assert.throws(() => q("report=money&days=30&step=h"), /только для 24 ч и 7 дней/);
});

test("ручка: 401 без входа, 404 не админу, 403 без кода, 400 на неверное, 200 с кодом — тем же путём, что сайт", async () => {
  const FRIEND = "2002";
  config.allowedChatIds.splice(0, Infinity, OWNER_CHAT, FRIEND);
  const store = await Store.open(":memory:");
  await store.createUser({ login: "owner", passwordHash: await hashPassword("owner-pass-1"), tz: TZ, chatId: OWNER_CHAT, name: "Хозяин" });
  await store.createUser({ login: "friend", passwordHash: await hashPassword("friend-pass-1"), tz: TZ, chatId: FRIEND });
  const codes: string[] = [];
  const server = createApi({ store, pipeline: new Pipeline(store, async () => "{}"), adminCode: async (_u: unknown, text: string) => void codes.push(text.match(/\d{6}/)![0]) }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (p: string, token: string, body?: unknown) => {
    const r = await fetch(base + p, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  };
  const login = async (l: string, pw: string) => (await (await fetch(base + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: l, password: pw }) })).json()).token as string;
  try {
    resetAnalyticsCache();
    const owner = await login("owner", "owner-pass-1");
    const friend = await login("friend", "friend-pass-1");
    const p = "/api/admin/analytics?report=money&days=30&step=d";
    assert.equal((await call(p, "")).status, 401);
    assert.equal((await call(p, friend)).status, 404, "не админ — как будто адреса нет");
    assert.equal((await call(p, owner)).status, 403, "без кода");
    await call("/api/admin/code", owner, {});
    assert.equal((await call("/api/admin/confirm", owner, { code: codes[0] })).status, 200);
    for (const bad of ["report=money&days=30&step=h", "report=money&days=7&step=w", "report=nope", "report=money&days=14"]) {
      const r = await call(`/api/admin/analytics?${bad}`, owner);
      assert.equal(r.status, 400, bad);
      assert.ok(typeof r.body.error === "string" && /[а-я]/.test(r.body.error), `${bad}: текст по-русски`);
    }
    for (const report of ["money", "subs", "ai", "act", "ret", "feat", "parse"]) {
      const r = await call(`/api/admin/analytics?report=${report}&days=7&step=h`, owner);
      assert.equal(r.status, 200, report);
      assert.equal((r.body.meta as { report: string }).report, report);
      assert.ok(!JSON.stringify(r.body).includes(OWNER_CHAT), `${report}: chat id в ответе`);
    }
    const second = await call(p, owner);
    assert.equal((second.body.meta as { cached: boolean }).cached, false);
    assert.equal(((await call(p, owner)).body.meta as { cached: boolean }).cached, true, "второй запрос — из кэша");
  } finally {
    server.close();
    await store.close();
    config.allowedChatIds.splice(0, Infinity, OWNER_CHAT);
  }
});

test("активный: сообщение, только минута присутствия, отметка кнопкой — да; авто-пропуск планировщика, импорт, поправка — нет", async () => {
  await each(async (store, name) => {
    const [a, b, c, d, e, f] = [await person(store), await person(store), await person(store), await person(store), await person(store), await person(store)];
    await msg(store, a, "telegram", ago(0, 1));
    await store.bumpPresence(b, T, 14, "web");
    await msg(store, c, "telegram", ago(0, 2), `mark:7:${T}`);
    await store.raw("INSERT INTO habit_marks (habit_id, day_key, status, at, message_id) VALUES (?, ?, ?, ?, NULL)", 99, T, "skip", NOW.toISOString());
    await msg(store, e, "import", ago(0, 3));
    await msg(store, f, "desktop", ago(0, 1), "correct:1:x");
    void d;
    for (const [report, step, days] of [["act", "d", 7], ["act", "h", 1], ["money", "d", 7], ["ai", "h", 7], ["feat", "d", 1]] as [AnalyticsReportId, AnalyticsStep, AnalyticsDays][]) {
      const r = data(await run(store, report, days, step));
      assert.deepEqual(r.kpi?.active ?? r.active, { cur: 3, prev: 0 }, `${name} ${report} ${days} ${step}`);
    }
    const act = data(await run(store, "act", 7, "d"));
    assert.deepEqual(act.kpi.requests, { cur: 1, prev: 0 }, `${name}: поправка и импорт — не обращения`);
    assert.deepEqual(act.kpi.manual, { cur: 1, prev: 0 }, `${name}: отметка кнопкой — без ИИ`);
    const ret = data(await run(store, "ret", 30, "d"));
    assert.equal(ret.kpi.dau.cur, 3);
    // На шаге «час» присутствие (14:00 по Москве = 11:00 UTC) — в своей корзине.
    const h = await run(store, "ret", 1, "h");
    const i11 = h.meta.buckets.findIndex((x) => x.key === "2026-11-24T11:00:00.000Z");
    assert.ok(data(h).series.active[i11] >= 2, `${name}: час 11 UTC — минута присутствия и сообщение`);
  });
});

test("money: оплата и возврат в разных корзинах, чистая выручка = сумма ряда, ARPU null без активных, $ по курсу", async () => {
  await each(async (store, name) => {
    const u3 = await person(store), u4 = await person(store);
    await pay(store, "charge-1", u3, 150, "first", at("2026-11-20T10:00:00Z"));
    await pay(store, "charge-2", u4, 150, "renew", at("2026-11-05T10:00:00Z"));
    await store.setPaymentRefunded("charge-2", "2026-11-21T10:00:00Z");
    await pay(store, "charge-3", u3, 50, "once", at("2026-11-12T10:00:00Z"));
    await pay(store, "charge-4", u4, 150, "first", at("2026-10-10T10:00:00Z"));
    await pay(store, "charge-5", u3, 999, "once", at("2026-11-15T10:00:00Z"), null, "USD");
    await store.addUsage(NOW, { kind: "chat", model: "main", input: 1, output: 1, cost: 0.5, userId: u3 });
    const r = data(await run(store, "money", 30, "d"));
    const k = r.kpi;
    assert.deepEqual(k.revenue_sub_stars, { cur: 300, prev: 150 }, name);
    assert.deepEqual(k.revenue_once_stars, { cur: 50, prev: 0 }, "не XTR — мимо");
    assert.deepEqual(k.refunds_stars, { cur: 150, prev: 0 });
    assert.deepEqual(k.revenue_stars, { cur: 200, prev: 150 });
    assert.deepEqual(k.revenue_micro, { cur: 2_600_000, prev: 1_950_000 }, "200 ⭐ × 0,013 $");
    assert.deepEqual(k.ai_micro, { cur: 500_000, prev: 0 });
    assert.deepEqual(k.margin_micro, { cur: 2_100_000, prev: 1_950_000 });
    assert.deepEqual(k.active, { cur: 0, prev: 0 });
    assert.deepEqual(k.arpu_stars, { cur: null, prev: null }, "0 активных — null");
    assert.deepEqual(k.ai_per_active_micro, { cur: null, prev: null });
    assert.deepEqual(k.payers, { cur: 1, prev: 1 }, "возвращённая оплата — не платящий");
    assert.deepEqual(k.arppu_stars, { cur: 200, prev: 150 });
    assert.deepEqual(k.payments, { cur: 3, prev: 1 });
    assert.deepEqual(k.avg_check_stars, { cur: 350 / 3, prev: 150 });
    assert.deepEqual(k.ltv_stars, { cur: 175, prev: 150 }, "(500 − 150) / 2 платящих");
    const s = r.series;
    const net = s.sub_stars.reduce((x: number, v: number, i: number) => x + v + s.once_stars[i] - s.refund_stars[i], 0);
    assert.equal(net, k.revenue_stars.cur, "чистая выручка = Σ ряда");
    assert.equal(s.refund_stars[29], 0);
    assert.equal(s.refund_stars[26], 150, "возврат 21.11 — в своей корзине");
    assert.equal(s.sub_stars[10], 150, "оплата 05.11 — в своей");
    const w = data(await run(store, "money", 30, "w")).series;
    assert.deepEqual(w.sub_stars, [0, 0, 150, 0, 150]);
    assert.deepEqual(w.once_stars, [0, 0, 0, 50, 0]);
    assert.deepEqual(w.refund_stars, [0, 0, 0, 0, 150]);
    assert.deepEqual(w.revenue_micro, [0, 0, 1_950_000, 650_000, 0]);
    // Появился активный — ARPU и ИИ на активного.
    await msg(store, u3, "telegram", at("2026-11-20T10:00:00Z"));
    const k2 = data(await run(store, "money", 30, "d")).kpi;
    assert.deepEqual(k2.arpu_stars, { cur: 200, prev: null });
    assert.deepEqual(k2.ai_per_active_micro, { cur: 500_000, prev: null });
    // Шаг «час»: расход — по журналу вызовов.
    const h = await run(store, "money", 1, "h");
    assert.ok(h.meta.notes.includes("hour_from_calls"));
  });
});

test("subs: снимок пробы, подарка и подписок; конверсия пробы с отложенными; отмены — null до начала журнала", async () => {
  await each(async (store, name) => {
    await person(store, { chat: OWNER_CHAT, created: at("2026-11-05T10:00:00Z") }); // владелец — не в когорте пробы
    await person(store, { plan: "friend", created: at("2026-11-02T10:00:00Z") });
    const u1 = await person(store, { plan: "trial", created: at("2026-11-20T10:00:00Z"), until: at("2026-11-27T10:00:00Z") });
    await person(store, { plan: "trial", created: at("2026-11-22T10:00:00Z"), until: at("2026-12-22T10:00:00Z") }); // подарок /invite
    const u3 = await person(store, { plan: "paid", created: at("2026-11-03T10:00:00Z"), until: at("2026-12-09T10:00:00Z") });
    const u4 = await person(store, { plan: "paid", created: at("2026-09-01T12:00:00Z"), until: at("2026-11-28T00:00:00Z"), canceled: true });
    await person(store, { plan: "free", created: at("2026-11-01T10:00:00Z"), until: at("2026-11-08T10:00:00Z") }); // решил, не оплатил
    await person(store, { plan: "free", created: at("2026-11-15T10:00:00Z"), until: at("2026-11-22T10:00:00Z") }); // 3 дня ещё не прошли
    await pay(store, "c-u3", u3, 150, "first", at("2026-11-09T10:00:00Z"), at("2026-12-09T10:00:00Z"));
    await pay(store, "c-u4a", u4, 150, "first", at("2026-10-10T10:00:00Z"), at("2026-11-09T10:00:00Z"));
    await pay(store, "c-u4b", u4, 150, "renew", at("2026-11-09T11:00:00Z"), at("2026-12-09T11:00:00Z"));
    await store.addBillingEvent({ user_id: u1, kind: "trial_started", at: at("2026-11-20T10:00:00Z") });
    await store.addBillingEvent({ user_id: u4, kind: "canceled", at: ago(0, 3) });
    await msg(store, u1, "telegram", ago(0, 1));
    await msg(store, u1, "telegram", ago(2));
    await store.addUsage(ago(1), { kind: "parse", model: "m", input: 1, output: 1, cost: 0.2, userId: u1 });
    const r = await run(store, "subs", 30, "d");
    const k = data(r).kpi;
    assert.deepEqual(k.active_subs, { cur: 2, prev: 1 }, `${name}: prev — по оплатам на начало периода`);
    assert.deepEqual(k.trials, { cur: 1, prev: null }, "подарок — не проба");
    assert.deepEqual(k.trials_ending_3d, { cur: 1, prev: null });
    assert.deepEqual(k.autorenew, { cur: 1, prev: null });
    assert.deepEqual(k.churn_risk, { cur: 1, prev: null });
    assert.deepEqual(k.trial_decided, { cur: 2, prev: 0 });
    assert.deepEqual(k.trial_conversion, { cur: 0.5, prev: null }, "решённых 0 — null");
    assert.equal(k.trial_pending, 1);
    assert.deepEqual(k.new_subs, { cur: 1, prev: 1 });
    assert.deepEqual(k.renewals, { cur: 1, prev: 0 });
    assert.deepEqual(k.refunds, { cur: 0, prev: 0 });
    assert.deepEqual(k.cancels, { cur: null, prev: null }, "журнал с 20.11 — окна раньше: null");
    assert.ok(r.meta.notes.includes("prev_before_data"));
    assert.equal(r.meta.since.billing_events, "2026-11-20");
    const s = data(r).series;
    assert.equal(s.canceled[29], 1);
    assert.equal(s.canceled[25], 0, "корзина 20.11 — уже в журнале");
    assert.equal(s.canceled[24], null, "корзина 19.11 — раньше журнала");
    const i08 = r.meta.buckets.findIndex((b) => b.key === "2026-11-08"), i10 = r.meta.buckets.findIndex((b) => b.key === "2026-11-10");
    assert.equal(s.trial_conversion[i08], 0);
    assert.equal(s.trial_conversion[i10], 1);
    assert.equal(s.trial_conversion[0], null);
    assert.equal(s.new[i08 + 1], 1);
    assert.deepEqual(data(r).soon, [
      { user_id: u1, what: "trial", left_days: 3, days_with_us: 4, active_days_7: 2, ai_micro_30: 200_000 },
      { user_id: u4, what: "no_renew", left_days: 4, days_with_us: 84, active_days_7: 0, ai_micro_30: 0 },
    ]);
    // Окно в один день — внутри журнала: отмена видна.
    const one = data(await run(store, "subs", 1, "d")).kpi;
    assert.deepEqual(one.cancels, { cur: 1, prev: 0 });
    assert.deepEqual(one.expired, { cur: 0, prev: 0 });
  });
});

test("ai: шаг d — llm_usage, шаг h — llm_calls; время ответа только за 30 дней; полосы; доля упёршихся в потолок", async () => {
  await each(async (store, name) => {
    const u1 = await person(store), u2 = await person(store);
    const u3 = await person(store, { plan: "paid", until: at("2026-12-10T00:00:00Z") });
    await msg(store, u1, "telegram", ago(0, 1));
    await store.bumpPresence(u2, T, 10, "desktop");
    await msg(store, u3, "telegram", ago(0, 2));
    await pay(store, "c-sub", u3, 150, "first", at("2026-11-20T10:00:00Z"), at("2026-12-20T10:00:00Z"));
    await store.addUsage(NOW, { kind: "parse", model: "lite", input: 1, output: 1, cost: 0.1, userId: u1 });
    await store.addUsage(NOW, { kind: "chat", model: "main", input: 1, output: 1, cost: 0.3, userId: u1 });
    await store.addUsage(NOW, { kind: "draw", model: "pic", input: 1, output: 1, cost: null, userId: u2 });
    await store.addUsage(ago(4), { kind: "summary", model: "lite", input: 1, output: 1, cost: 0.05 });
    await store.addLlmCall(ago(8), { kind: "chat", model: "main", ms: 2000, cost: 0.001, userId: u1 });
    await store.addLlmCall(ago(0, 0.5), { kind: "parse", model: "lite", ms: 1000, cost: 0.01, userId: u1 });
    await store.addLlmCall(ago(0, 0.3), { kind: "chat", model: "main", ms: 3000, cost: 0.02, userId: u1 });
    await store.addLlmCall(ago(0, 0.2), { kind: "chat", model: "main", ms: 5000, cost: null, error: "timeout", userId: u1 });
    await store.addLlmCall(ago(0, 2), { kind: "draw", model: "pic", ms: 8000, cost: null, userId: u2 });
    await store.addFeatureCounts([
      { user_id: u1, day_key: T, client: "telegram", feature: "gate.day_cap", count: 2 },
      // Тот же человек упёрся и в лимит в штуках — в «Упёрлись в лимит» он один (различные люди).
      { user_id: u1, day_key: T, client: "web", feature: "gate.calls_cap", count: 1 },
      { user_id: u2, day_key: addDays(T, -1), client: "web", feature: "gate.burst", count: 1 },
    ]);
    const d7 = await run(store, "ai", 7, "d");
    const a = data(d7);
    assert.equal(a.source, "llm_usage", name);
    assert.deepEqual(a.kpi.total_micro, { cur: 450_000, prev: 0 });
    assert.deepEqual(a.kpi.calls, { cur: 4, prev: 0 });
    assert.deepEqual(a.kpi.unpriced_calls, { cur: 1, prev: 0 }, "рисунок без цены");
    assert.equal(a.series.parse[6], 100_000);
    assert.equal(a.series.talk[6], 300_000);
    assert.equal(a.series.background[2], 50_000, "сводка 20.11 — фон");
    assert.equal(a.series.draw[6], 0);
    assert.deepEqual(a.kpi.top_user, { user_id: u1, micro: 400_000 });
    assert.equal(a.kpi.forecast_month_micro, Math.round(50_000 / 7 * 30));
    assert.deepEqual(a.kpi.active, { cur: 3, prev: 0 });
    assert.equal(a.kpi.subscribers, 1);
    assert.equal(a.kpi.subscriber_avg_micro, 0);
    assert.equal(a.kpi.subscriber_avg_revenue_micro, 1_950_000);
    assert.deepEqual(a.kpi.capped_users, { cur: null, prev: null }, "счётчики gate.* с 23.11 — неделя раньше: null");
    assert.deepEqual(a.models.map((m: { model: string }) => m.model), ["main", "lite", "pic"]);
    const main = a.models[0];
    assert.deepEqual([main.micro, main.calls, main.top_kind, main.p50_ms, main.p95_ms, main.timed], [300_000, 1, "chat", 3000, 3000, 1], "время — только удачные попытки за период");
    assert.equal(a.models[1].top_kind, "parse");
    assert.equal(a.models[0].share, 300_000 / 450_000);
    assert.equal(a.dist_users, 3);
    assert.deepEqual(a.dist.map((x: { users: number }) => x.users), [2, 0, 1, 0, 0, 0], "с нулём — в первую полосу");
    assert.equal(a.dist[0].share, 2 / 3);
    assert.deepEqual(a.limits, { trial_day_micro: 300_000, paid_day_micro: 500_000, trial_pool_day_micro: 10_000_000 });
    // Один день — внутри счётчиков gate.*.
    const one = data(await run(store, "ai", 1, "d")).kpi;
    assert.deepEqual(one.capped_users, { cur: 1, prev: 0 });
    assert.deepEqual(one.capped_share, { cur: 1 / 3, prev: null });
    // Час — по журналу вызовов.
    const h = await run(store, "ai", 1, "h");
    assert.equal(data(h).source, "llm_calls");
    assert.ok(h.meta.notes.includes("hour_from_calls"));
    assert.deepEqual(data(h).kpi.total_micro, { cur: 30_000, prev: 0 });
    assert.deepEqual(data(h).kpi.calls, { cur: 3, prev: 0 }, "без неудачной попытки");
    assert.deepEqual(data(h).kpi.unpriced_calls, { cur: 1, prev: 0 });
    assert.equal(data(h).series.talk.at(-2), 20_000, "час 11 UTC");
    // 90 дней — журнал вызовов короче: времени ответа нет.
    const d90 = await run(store, "ai", 90, "d");
    assert.ok(d90.meta.notes.includes("latency_30d_only"));
    for (const m of data(d90).models) assert.deepEqual([m.p50_ms, m.p95_ms, m.timed], [null, null, 0]);
  });
});

test("act: регистрации, обращения по источнику, часы суток, неделя × час", async () => {
  await each(async (store, name) => {
    const u1 = await person(store, { created: ago(1) }), u2 = await person(store, { created: ago(10) });
    await msg(store, u1, "telegram", at("2026-11-24T07:10:00Z")); // 10:10 по Москве
    await msg(store, u1, "desktop", at("2026-11-24T07:20:00Z"));
    await msg(store, u2, "telegram", at("2026-11-23T07:00:00Z"));
    await msg(store, u2, "web", at("2026-11-23T08:00:00Z")); // без ИИ
    await store.bumpPresence(u2, T, 10, "desktop");
    await pay(store, "c1", u2, 150, "first", at("2026-11-22T10:00:00Z"));
    const r = await run(store, "act", 7, "d");
    const a = data(r);
    assert.deepEqual(a.kpi.signups, { cur: 1, prev: 1 }, name);
    assert.deepEqual(a.kpi.requests, { cur: 3, prev: 0 });
    assert.deepEqual(a.kpi.manual, { cur: 1, prev: 0 });
    assert.deepEqual(a.kpi.active, { cur: 2, prev: 0 });
    assert.deepEqual(a.kpi.requests_per_active, { cur: 1.5, prev: null });
    assert.deepEqual(a.kpi.payers_share, { cur: 0.5, prev: null });
    assert.deepEqual(a.sources, ["telegram", "desktop"]);
    assert.deepEqual(a.series.requests_by_source.telegram.slice(5), [1, 1]);
    assert.equal(a.hours[10], 3 / 7, "местный час — по поясу человека (07 UTC = 10 по Москве)");
    assert.equal(a.hours[7], 0);
    assert.equal(a.hours[11], 1 / 7);
    assert.equal(a.heat.length, 7);
    assert.equal(a.heat_days, 28);
    assert.equal(a.heat[1][10], 1, "вторник 10:00 — минута присутствия");
  });
});

test("ret: мост MAU сходится, кто пропал, когорта будущей недели — null", async () => {
  await each(async (store, name) => {
    const r1 = await person(store), r2 = await person(store), r3 = await person(store, { created: ago(5) }), r4 = await person(store);
    await msg(store, r1, "telegram", ago(0, 1));
    await msg(store, r1, "telegram", ago(40));
    await msg(store, r2, "telegram", ago(35));
    await msg(store, r3, "telegram", ago(0, 2));
    await msg(store, r4, "telegram", ago(10));
    const r = data(await run(store, "ret", 30, "d"));
    const b = r.bridge;
    assert.deepEqual(b, { prev_mau: 2, stayed: 1, left: 1, new: 1, returned: 1, mau: 3 }, name);
    assert.equal(b.stayed + b.new + b.returned, b.mau);
    assert.equal(b.stayed + b.left, b.prev_mau);
    assert.deepEqual(r.kpi.dau, { cur: 2, prev: 0 });
    assert.deepEqual(r.kpi.wau, { cur: 2, prev: 1 });
    assert.deepEqual(r.kpi.mau, { cur: 3, prev: 2 });
    assert.deepEqual(r.kpi.gone, { cur: 1, prev: 2 });
    assert.equal(r.kpi.stickiness.cur, 3 / 30 / 3);
    assert.equal(r.series.active[29], 2);
    assert.equal(r.series.active[19], 1, "r4 10 дней назад");
    assert.equal(r.series.prev_active.length, 30);
    assert.equal(r.series.prev_active[24], 1, "r2 35 дней назад — в прошлом периоде");
    assert.equal(r.cohorts.length, 8);
    assert.equal(r.cohort_cols, 8);
    const last = r.cohorts.at(-1);
    assert.equal(last.week, "2026-11-23");
    for (const c of last.cells.slice(1)) assert.equal(c, null, "неделя ещё не наступила");
    const mine = r.cohorts.find((c: { week: string }) => c.week === "2026-11-16");
    assert.equal(mine.size, 1);
    assert.deepEqual(mine.cells.slice(0, 3), [{ share: 0, users: 0 }, { share: 1, users: 1 }, null]);
    for (const c of r.cohorts.filter((x: { size: number }) => !x.size)) assert.ok(c.cells.every((x: unknown) => x === null), "пустая когорта — все null");
    const y = data(await run(store, "ret", 365, "w"));
    assert.equal(y.cohorts.length, 52);
    assert.equal(y.cohort_cols, 13);
  });
});

test("feat: spark на шаге h — null, «не трогали», доля активных, правило since", async () => {
  await each(async (store, name) => {
    const [f0, f1, f2] = [FEATURES[0].id, FEATURES[1].id, FEATURES[2].id];
    const u1 = await person(store), u2 = await person(store), u3 = await person(store);
    await msg(store, u1, "telegram", ago(0, 1));
    await msg(store, u2, "telegram", ago(0, 1));
    await store.addFeatureCounts([
      { user_id: u1, day_key: T, client: "web", feature: f0, count: 3 },
      { user_id: u2, day_key: T, client: "desktop", feature: f0, count: 1 },
      { user_id: u1, day_key: addDays(T, -10), client: "web", feature: f1, count: 2 },
      { user_id: u3, day_key: addDays(T, -20), client: "web", feature: f2, count: 1 },
      { user_id: u3, day_key: T, client: "web", feature: "no.such.feature", count: 5 },
    ]);
    const r = await run(store, "feat", 7, "d");
    const d = data(r);
    assert.equal(d.since, addDays(T, -20), name);
    const row = (id: string) => d.rows.find((x: { id: string }) => x.id === id);
    assert.equal(d.rows[0].id, f0, "сортировка по разам");
    assert.deepEqual(row(f0).uses, { cur: 4, prev: 0 });
    assert.deepEqual(row(f0).people, { cur: 2, prev: 0 });
    assert.deepEqual(row(f0).share, { cur: 1, prev: null }, "оба активных");
    assert.deepEqual(row(f0).clients, { web: 3, desktop: 1 });
    assert.equal(row(f0).spark[6], 4);
    assert.deepEqual(row(f1).uses, { cur: 0, prev: 2 });
    assert.ok(d.unused.includes(f1) && !d.unused.includes(f0));
    assert.ok(!d.rows.some((x: { id: string }) => x.id === "no.such.feature"), "имена вне белого списка — мимо");
    assert.deepEqual(d.kpi.used, { cur: 1, prev: 1 });
    assert.deepEqual(d.kpi.people, { cur: 2, prev: 1 });
    assert.deepEqual(d.kpi.per_person, { cur: 1, prev: 1 });
    assert.deepEqual(d.kpi.unused, { cur: FUNCTIONS.length - 1, prev: FUNCTIONS.length - 1 });
    assert.equal(d.kpi.total, FUNCTIONS.length);
    const h = await run(store, "feat", 1, "h");
    assert.ok(data(h).rows.every((x: { spark: unknown }) => x.spark === null), "по часам функций нет");
    assert.ok(h.meta.notes.includes("no_hourly_features") && h.meta.notes.includes("days_for_hours"));
    assert.equal(data(h).rows.find((x: { id: string }) => x.id === f0).uses.cur, 4, "за дни, которые задевает окно часов");
    const m30 = await run(store, "feat", 30, "d");
    assert.deepEqual(data(m30).rows.find((x: { id: string }) => x.id === f0).uses, { cur: null, prev: null }, "счётчики начались позже начала окна");
    assert.ok(m30.meta.notes.includes("prev_before_data"));
  });
});

test("parse: виды записей и «разговор без записи», доля ошибок, время ответа", async () => {
  await each(async (store, name) => {
    const u = await person(store);
    const p1 = await msg(store, u, "telegram", ago(0, 1));
    await store.logAction(u, p1.id, "add", "tasks", 1);
    const p2 = await msg(store, u, "desktop", ago(0, 1));
    await store.logAction(u, p2.id, "add", "events", 1);
    await store.logAction(u, p2.id, "add", "diary", 1);
    await store.logAction(u, p2.id, "add", "diary", 2);
    const p3 = await msg(store, u, "telegram", ago(0, 1));
    await store.setMessage(p3.id, { state: "failed" });
    const p4 = await msg(store, u, "iphone", ago(0, 1));
    await store.logAction(u, p4.id, "add", "tasks", 2);
    await store.markUndone((await store.actionsOf(p4.id))[0].id);
    await msg(store, u, "desktop", ago(0, 1), "correct:1:x");
    const p6 = await msg(store, u, "button", ago(0, 1));
    await store.logAction(u, p6.id, "mark", "habit_marks", 1);
    await store.addLlmCall(ago(10), { kind: "answer", model: "m", ms: 800, cost: 0.001, userId: u });
    await store.addLlmCall(ago(0, 1), { kind: "parse", model: "m", ms: 1200, cost: 0.001, userId: u });
    await store.addLlmCall(ago(0, 1), { kind: "draw", model: "p", ms: 9000, cost: 0.001, userId: u });
    const r = await run(store, "parse", 7, "d");
    const k = data(r).kpi;
    assert.deepEqual(k.requests, { cur: 4, prev: 0 }, name);
    assert.deepEqual(k.undone, { cur: 1, prev: 0 });
    assert.deepEqual(k.corrections, { cur: 1, prev: 0 });
    assert.deepEqual(k.undone_share, { cur: 0.25, prev: null });
    assert.deepEqual(k.corrections_share, { cur: 0.25, prev: null });
    assert.equal(k.failed_now, 1);
    assert.equal(k.failed_retry, 1);
    assert.equal(k.clarify_now, 0);
    assert.deepEqual(k.p50_ms, { cur: 1200, prev: null }, "рисование не в счёт; прошлое окно — раньше журнала");
    const kinds = data(r).series.kinds;
    assert.deepEqual(Object.fromEntries(Object.entries(kinds).map(([x, v]) => [x, (v as number[])[6]])), { tasks: 2, plans: 1, diary: 1, habits: 0, money: 0, other: 0, talk: 1 },
      "разные сообщения × вид; отметка кнопкой — не разбор");
    assert.equal(data(r).series.err_share[6], 0.5);
    assert.equal(data(r).series.err_share[0], null);
    assert.deepEqual(data(r).kinds, ["tasks", "plans", "diary", "habits", "money", "other", "talk"]);
    const h = data(await run(store, "parse", 1, "h"));
    assert.equal(h.series.kinds.tasks.at(-2), 2, "час 11 UTC");
    assert.ok(data(await run(store, "parse", 90, "d")).kpi.p50_ms.cur === null);
  });
});

test("кэш: второй вызов — из кэша с тем же временем подсчёта; через минуту и после сброса — пересчёт", async () => {
  await each(async (store, name) => {
    resetAnalyticsCache();
    const q = { report: "act" as const, days: 7 as const, step: "d" as const };
    const [a, b] = await Promise.all([cachedAnalytics(store, q, NOW), cachedAnalytics(store, q, NOW)]);
    assert.equal(a.meta.cached, false, name);
    assert.equal(b.meta.cached, true, "параллельный — тот же подсчёт");
    const c = await cachedAnalytics(store, q, new Date(NOW.getTime() + 30_000));
    assert.equal(c.meta.cached, true);
    assert.equal(c.meta.generated_at, a.meta.generated_at);
    const d = await cachedAnalytics(store, q, new Date(NOW.getTime() + ANALYTICS_CACHE_MS + 1000));
    assert.equal(d.meta.cached, false, "через минуту — заново");
    assert.notEqual(d.meta.generated_at, a.meta.generated_at);
    assert.equal((await cachedAnalytics(store, { ...q, step: "h" }, NOW)).meta.cached, false, "другой шаг — свой ключ");
    resetAnalyticsCache();
    assert.equal((await cachedAnalytics(store, q, NOW)).meta.cached, false, "после сброса — пересчёт");
  });
});

/** Одно хранилище со всем сразу: люди с именами и логинами, тексты, оплаты с Telegram id и charge_id. */
async function seedAll(store: Store) {
  const u1 = await person(store, { plan: "trial", created: ago(3), until: at("2026-11-27T10:00:00Z") });
  const u2 = await person(store, { plan: "paid", until: at("2026-11-28T00:00:00Z"), canceled: true });
  const m = await msg(store, u1, "telegram", ago(0, 1));
  await store.logAction(u1, m.id, "add", "tasks", 1);
  await msg(store, u2, "web", ago(2));
  await store.bumpPresence(u2, T, 9, "desktop");
  await pay(store, "charge-secret-xyz", u2, 150, "first", ago(5), ago(-25));
  await store.addBillingEvent({ user_id: u2, kind: "paid_first", at: ago(5), charge_id: "charge-secret-xyz", amount: 150 });
  await store.addUsage(NOW, { kind: "chat", model: "main", input: 1, output: 1, cost: 0.2, userId: u1 });
  await store.addLlmCall(ago(0, 1), { kind: "chat", model: "main", ms: 1500, cost: 0.01, userId: u1 });
  await store.addFeatureCounts([{ user_id: u1, day_key: T, client: "web", feature: FEATURES[0].id, count: 1 }]);
}

test("приватность: в ответах всех отчётов нет текстов, имён, логинов, chat id, Telegram id, charge_id и payload", async () => {
  await each(async (store, name) => {
    await seedAll(store);
    for (const report of ["money", "subs", "ai", "act", "ret", "feat", "parse"] as AnalyticsReportId[]) {
      for (const [days, step] of [[7, "d"], [7, "h"], [30, "w"]] as [AnalyticsDays, AnalyticsStep][]) {
        const json = JSON.stringify(await run(store, report, days, step));
        for (const bad of [SECRET, "Секретное Имя", "loginsecret", "77700", "tg-secret-555", "charge-secret", "payload-secret"]) {
          assert.ok(!json.includes(bad), `${name} ${report} ${days}${step}: «${bad}» в ответе`);
        }
        for (const key of ["text", "name", "login", "chat_id", "tg_user_id", "charge_id", "payload", "password_hash"]) {
          assert.ok(!json.includes(`"${key}"`), `${name} ${report}: поле ${key}`);
        }
      }
    }
  });
});

test("запросы к messages — с границей времени и по индексу (SQLite EXPLAIN QUERY PLAN)", async () => {
  const store = await Store.open(":memory:");
  try {
    await seedAll(store);
    const seen: { sql: string; args: unknown[] }[] = [];
    const drv = store.driver as unknown as { all: (sql: string, args?: unknown[]) => Promise<unknown[]> };
    const orig = drv.all.bind(store.driver);
    drv.all = (sql, args = []) => {
      if (/\bFROM messages\b/.test(sql)) seen.push({ sql, args });
      return orig(sql, args);
    };
    for (const report of ["money", "subs", "ai", "act", "ret", "feat", "parse"] as AnalyticsReportId[]) {
      for (const [days, step] of [[30, "d"], [7, "h"], [365, "w"]] as [AnalyticsDays, AnalyticsStep][]) await run(store, report, days, step);
    }
    drv.all = orig;
    assert.ok(seen.length >= 5, "отчёты читают сообщения");
    let checked = 0;
    for (const { sql, args } of seen) {
      assert.match(sql, /day_key >= \?|received_at >= \?|state IN \('failed', 'clarify'\)/, `без границы времени: ${sql.slice(0, 120)}`);
      const plan = (await store.driver.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, args)).map((r) => r.detail);
      for (const line of plan.filter((l) => /^(SCAN|SEARCH) (m|messages)\b/.test(l))) {
        assert.match(line, /^SEARCH .* USING (COVERING )?INDEX (messages_day|messages_at|messages_state)\b/, `${line}\n${sql.slice(0, 160)}`);
        checked++;
      }
    }
    assert.ok(checked >= seen.length, "план разобран у каждого запроса");
    assert.equal(await store.kvGet("schema_version"), "39", "шаг 29 — индекс messages_day, шаг 30 — тарифы из базы, шаг 31 — вид бесплатного срока, шаг 32 — лимиты в штуках, шаг 33 — заморозка и причина в журнале админа, шаг 34 — оповещения и копии базы, шаг 35 — падения виджета и дни программы по версиям, шаг 36 — переключатели, промокоды, обращения и объявления, шаг 37 — нагрузка сервера раз в минуту, шаг 38 — счёт OpenRouter, шаг 39 — habits.finished_at");
  } finally {
    await store.close();
  }
});

// ——— Исправления по проверке раздела (24.11.2026).

/** Человек со своим поясом и сообщение с day_key по этому поясу. */
async function local(store: Store, tz: string, created: Date, plan = "") {
  const u = await store.createUser({ login: `loginsecret${++seq}`, passwordHash: "x", tz, name: "Секретное Имя", chatId: `77700${seq}`, plan, at: created });
  return u.id;
}
async function localMsg(store: Store, userId: number, tz: string, when: Date) {
  await store.saveMessage({ userId, source: "telegram", sourceId: `s${++seq}`, text: SECRET, dayKey: dayKey(when, tz), at: when });
}

test("subs: подарок /invite и принявший приглашение посреди пробы — не в когорте конверсии пробы", async () => {
  await each(async (store, name) => {
    const t1 = await person(store, { plan: "free", created: at("2026-11-01T10:00:00Z"), until: at("2026-11-08T10:00:00Z") }); // не оплатил
    const t2 = await person(store, { plan: "paid", created: at("2026-11-02T10:00:00Z"), until: at("2026-12-08T10:00:00Z") });
    await pay(store, "c-t2", t2, 150, "first", at("2026-11-08T10:00:00Z"), at("2026-12-08T10:00:00Z"));
    // Подарок на 30 дней (запись — trial) с журналом и без (подарок до журнала: срок длиннее пробы, оплат нет).
    const g1 = await person(store, { plan: "trial", created: at("2026-11-03T10:00:00Z"), until: at("2026-12-03T10:00:00Z") });
    await store.addBillingEvent({ user_id: g1, kind: "gift", at: at("2026-11-03T10:00:00Z") });
    await person(store, { plan: "trial", created: at("2026-11-04T10:00:00Z"), until: at("2026-12-04T10:00:00Z") });
    // На пробе с 05.11, 07.11 принял приглашение — срок уехал; в когорте «не оплатил за 3 дня» он быть не должен.
    const g3 = await person(store, { plan: "trial", created: at("2026-11-05T10:00:00Z"), until: at("2026-12-12T10:00:00Z") });
    await store.addBillingEvent({ user_id: g3, kind: "gift", at: at("2026-11-07T10:00:00Z") });
    const k = data(await run(store, "subs", 30, "d")).kpi;
    assert.deepEqual(k.trial_decided, { cur: 2, prev: 0 }, `${name}: только две пробы`);
    assert.deepEqual(k.trial_conversion, { cur: 0.5, prev: null }, `${t1}: 1 из 2`);
  });
});

test("subs: «Истекли» — только конец подписки; концы пробы и подарка (trial_ended, gift_ended) не в счёт", async () => {
  await each(async (store, name) => {
    await store.kvSet(COLLECT_SINCE_KEY, "2026-11-01T00:00:00.000Z");
    const u = await person(store);
    for (const kind of ["expired", "trial_ended", "trial_ended", "gift_ended"] as const) await store.addBillingEvent({ user_id: u, kind, at: ago(0, 2) });
    const r = data(await run(store, "subs", 1, "d"));
    assert.deepEqual(r.kpi.expired, { cur: 1, prev: 0 }, name);
    assert.equal(r.series.expired.at(-1), 1);
  });
});

test("правило since: журнал подписки и отказы ИИ — с начала записи (kv при шаге 28), пустой источник после него — 0, а не null", async () => {
  await each(async (store, name) => {
    assert.ok(await store.kvGet(COLLECT_SINCE_KEY), `${name}: новая база отмечает начало записи`);
    await store.kvSet(COLLECT_SINCE_KEY, "2026-11-20T08:00:00.000Z");
    const u = await person(store);
    await msg(store, u, "telegram", ago(0, 1));
    const ai1 = await run(store, "ai", 1, "d");
    assert.deepEqual(data(ai1).kpi.capped_users, { cur: 0, prev: 0 }, "отказов не было — 0");
    assert.deepEqual(data(ai1).kpi.capped_share, { cur: 0, prev: null });
    const subs1 = data(await run(store, "subs", 1, "d"));
    assert.deepEqual(subs1.kpi.cancels, { cur: 0, prev: 0 }, "пустой журнал — 0");
    assert.deepEqual(subs1.kpi.expired, { cur: 0, prev: 0 });
    // Первый отказ позже начала записи — окна с 20.11 всё равно считаются. Упор в лимит в штуках (голос) — тоже «упёрся в лимит».
    await store.addFeatureCounts([{ user_id: u, day_key: T, client: "web", feature: "gate.voice_cap", count: 1 }]);
    const ai3 = data(await run(store, "ai", 1, "d")).kpi;
    assert.deepEqual(ai3.capped_users, { cur: 1, prev: 0 });
    assert.equal((await store.analyticsSince()).gate, "2026-11-20T08:00:00.000Z", "раньшее из отметки и первой записи");
    // Окно раньше начала записи — null.
    const ai7 = await run(store, "ai", 7, "d");
    assert.deepEqual(data(ai7).kpi.capped_users, { cur: null, prev: null });
    assert.ok(ai7.meta.notes.includes("prev_before_data"));
    // Без отметки (база прошла шаг 28 до неё) — как раньше: по первой записи.
    await store.kvDel(COLLECT_SINCE_KEY);
    assert.equal((await store.analyticsSince()).billing_events, null);
    assert.equal((await store.analyticsSince()).gate, T);
  });
});

test("пояса: у кого пояс впереди, завтрашний day_key — в последней корзине, а не мимо окна", async () => {
  await each(async (store, name) => {
    // 18:00 UTC = 21:00 по Москве 24.11, а во Владивостоке уже 04:00 25.11.
    const now = new Date("2026-11-24T18:00:00Z");
    const VL = "Asia/Vladivostok";
    const u = await local(store, VL, at("2026-11-01T10:00:00Z"));
    await localMsg(store, u, VL, new Date(now.getTime() - H));
    await store.addFeatureCounts([
      { user_id: u, day_key: "2026-11-25", client: "web", feature: FEATURES[0].id, count: 2 },
      { user_id: u, day_key: "2026-10-01", client: "web", feature: FEATURES[1].id, count: 1 }, // счётчики копятся давно
    ]);
    const r = (report: AnalyticsReportId, days: AnalyticsDays = 7) => analyticsReport(store, { report, days, step: "d" }, now);
    const act = data(await r("act"));
    assert.deepEqual(act.kpi.active, { cur: 1, prev: 0 }, name);
    assert.deepEqual(act.kpi.requests, { cur: 1, prev: 0 });
    assert.equal(act.series.requests.at(-1), 1, "в последней корзине");
    const parse = data(await r("parse"));
    assert.deepEqual(parse.kpi.requests, { cur: 1, prev: 0 });
    assert.deepEqual(data(await r("money")).kpi.active, { cur: 1, prev: 0 }, "UTC-отчёт тоже");
    assert.deepEqual(data(await r("ret", 30)).kpi.dau, { cur: 1, prev: 0 });
    const feat = data(await r("feat", 1));
    assert.deepEqual(feat.rows.find((x: { id: string }) => x.id === FEATURES[0].id).uses, { cur: 2, prev: 0 });
  });
});

test("ret: неделя регистрации — по поясу человека, как и его активность (Н+0 — первые минуты)", async () => {
  await each(async (store, name) => {
    // Вс 22.11 23:00 по Москве = пн 23.11 01:00 в Екатеринбурге.
    const EK = "Asia/Yekaterinburg";
    const u = await local(store, EK, at("2026-11-22T20:00:00Z"));
    await localMsg(store, u, EK, at("2026-11-22T20:05:00Z"));
    const r = data(await run(store, "ret", 30, "d"));
    const wk = r.cohorts.find((c: { week: string }) => c.week === "2026-11-23");
    assert.equal(wk.size, 1, name);
    assert.deepEqual(wk.cells[0], { share: 1, users: 1 });
    assert.equal(r.cohorts.find((c: { week: string }) => c.week === "2026-11-16").size, 0);
  });
});

test("feat: в отчёте только функции — без отказов ИИ, шагов экскурсии и реакций Рины", async () => {
  await each(async (store, name) => {
    const u = await person(store);
    await msg(store, u, "telegram", ago(0, 1));
    await store.addFeatureCounts([
      { user_id: u, day_key: T, client: "web", feature: FEATURES[0].id, count: 1 },
      { user_id: u, day_key: T, client: "telegram", feature: "gate.day_cap", count: 3 },
      { user_id: u, day_key: T, client: "desktop", feature: "maid.react.happy", count: 40 },
      { user_id: u, day_key: T, client: "desktop", feature: "onboarding.tour.step.hello", count: 1 },
      { user_id: u, day_key: T, client: "desktop", feature: "maid.party.wave", count: 1 },
      { user_id: u, day_key: addDays(T, -30), client: "web", feature: FEATURES[1].id, count: 1 }, // счётчики копятся давно
    ]);
    const d = data(await run(store, "feat", 1, "d"));
    const service = /^(gate|maid|onboarding)\./;
    assert.ok(!d.rows.some((x: { id: string }) => service.test(x.id)), `${name}: rows`);
    assert.ok(!d.unused.some((id: string) => service.test(id)), "unused");
    assert.ok(FUNCTIONS.every((f) => ["site", "widget", "bot", "common"].includes(f.group)));
    assert.equal(d.kpi.total, FUNCTIONS.length);
    assert.ok(FUNCTIONS.length < FEATURES.length);
    assert.deepEqual(d.kpi.used, { cur: 1, prev: 0 });
    assert.deepEqual(d.kpi.per_person, { cur: 1, prev: null }, "отказы и анимации — не функции на человека");
    assert.equal(d.rows[0].id, FEATURES[0].id);
  });
});

test("feat и ai: счётчики функций сводятся в SQL — сырых строк feature_events по человеку и дню в JS нет", async () => {
  const store = await Store.open(":memory:");
  try {
    const u1 = await person(store), u2 = await person(store);
    await store.addFeatureCounts([
      { user_id: u1, day_key: T, client: "web", feature: FEATURES[0].id, count: 2 },
      { user_id: u2, day_key: T, client: "web", feature: FEATURES[0].id, count: 3 },
      { user_id: u2, day_key: T, client: "desktop", feature: FEATURES[0].id, count: 1 },
    ]);
    assert.deepEqual((await store.analyticsFeatureSums(T, T, [FEATURES[0].id])).sort((a, b) => a.client.localeCompare(b.client)),
      [{ feature: FEATURES[0].id, client: "desktop", day: T, uses: 1 }, { feature: FEATURES[0].id, client: "web", day: T, uses: 5 }], "по людям сведено");
    assert.equal((await store.analyticsFeatureUsers(T, T, [FEATURES[0].id])).length, 2, "пара фича × человек — одна строка");
    const seen: string[] = [];
    const drv = store.driver as unknown as { all: (sql: string, args?: unknown[]) => Promise<unknown[]> };
    const orig = drv.all.bind(store.driver);
    drv.all = (sql, args = []) => {
      if (/\bFROM feature_events\b/.test(sql)) seen.push(sql);
      return orig(sql, args);
    };
    for (const report of ["feat", "ai"] as AnalyticsReportId[]) await run(store, report, 365, "w");
    drv.all = orig;
    assert.ok(seen.length >= 2);
    for (const sql of seen) assert.match(sql, /GROUP BY|MIN\(day_key\)/, `без сведения: ${sql.slice(0, 120)}`);
  } finally {
    await store.close();
  }
});

test("кэш короче опроса сайта (60 с): опрос, пришедший чуть раньше минуты, — уже новый подсчёт", async () => {
  await each(async (store, name) => {
    resetAnalyticsCache();
    assert.ok(ANALYTICS_CACHE_MS <= 57_000, "запас на разброс задержки");
    const q = { report: "act" as const, days: 7 as const, step: "d" as const };
    await cachedAnalytics(store, q, NOW);
    const next = await cachedAnalytics(store, q, new Date(NOW.getTime() + 59_950));
    assert.equal(next.meta.cached, false, name);
  });
});
