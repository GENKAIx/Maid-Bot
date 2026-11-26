import { PGlite } from "@electric-sql/pglite";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Alerts } from "../src/alerts.ts";
import { createApi } from "../src/api.ts";
import { hashPassword } from "../src/auth.ts";
import { config } from "../src/config.ts";
import { Store, type ServerMetricRow } from "../src/db.ts";
import { PgDriver } from "../src/driver.ts";
import { Pipeline } from "../src/pipeline.ts";
import {
  CAPACITY_MIN_MINUTES, healthRange, healthSeries, LOAD_CACHE_MS, memUsedPct, noteActive, noteBotUpdate, noteHttp, noteLlmCall, noteQueue,
  parseCpuMax, resetServerMeter, SERVER_METRICS_KEEP_DAYS, serverCapacity, ServerMeter, serverLoad,
} from "../src/server-metrics.ts";
import http from "node:http";

// Часть 2 «Тарифы и управление»: «Здоровье сервера» подробно — снимок раз в минуту (server-metrics.ts), хранение 7 дней в
// server_metrics (шаг 37), ряды графиков, «Сколько выдержит», правило оповещения server_load и ручка админки.

const MIN = 60_000;
const NOW = new Date("2026-11-25T12:00:30Z");
const TZ = "Europe/Moscow";

/** Снимок с разумными значениями по умолчанию; at — за столько минут до NOW. */
function row(ago: number, x: Partial<ServerMetricRow> = {}): ServerMetricRow {
  return {
    at: new Date(Math.floor((NOW.getTime() - ago * MIN) / MIN) * MIN).toISOString(),
    cpu_proc: 5, cpu_ms: 3000, cpu_sys: 10, load1: 0.2, cores: 2, rss_mb: 200, heap_mb: 80, heap_total_mb: 120,
    mem_total_mb: 4000, mem_free_mb: 2000, mem_limit_mb: 4000, loop_p50: 0.5, loop_p99: 3, loop_max: 8,
    http: 20, http_p50: 4, http_p95: 30, http_5xx: 0, bot: 2, llm: 1, llm_err: 0, active: 0, queue: 0, queue_peak: 0,
    db_mb: 12, disk_free_mb: 9000, disk_total_mb: 20000, uptime: 3600, tick_ms: 0.4, ...x,
  };
}

const BASES: [string, () => Promise<Store>][] = [
  ["SQLite", () => Store.open(":memory:")],
  ["Postgres (PGlite)", async () => {
    const pg = new PGlite();
    return Store.over(new PgDriver(pg, (fn) => pg.transaction((tx) => fn(tx)), () => pg.close()));
  }],
];

test("снимок: счётчики минуты, задержка цикла, память; после снимка минута с нуля; тик — миллисекунды", async () => {
  const store = await Store.open(":memory:");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maid-metrics-"));
  const meter = new ServerMeter(store, { dbBytes: () => 5 * 1024 * 1024, diskPath: dir, queue: () => 2 });
  try {
    resetServerMeter();
    for (let i = 1; i <= 100; i++) noteHttp(i, i === 100 ? 503 : 200);
    noteBotUpdate(); noteBotUpdate();
    noteLlmCall(false); noteLlmCall(true);
    noteActive(7); noteActive(7); noteActive(8);
    noteQueue(5);
    const busyUntil = Date.now() + 30;
    while (Date.now() < busyUntil) { /* немного процессора */ }
    const r = meter.sample(NOW);
    assert.equal(r.at, "2026-11-25T12:00:00.000Z", "минута, без секунд");
    assert.equal(r.http, 100);
    assert.equal(r.http_5xx, 1);
    assert.ok(r.http_p50! >= 49 && r.http_p50! <= 52, `p50 ${r.http_p50}`);
    assert.ok(r.http_p95! >= 94 && r.http_p95! <= 96, `p95 ${r.http_p95}`);
    assert.deepEqual([r.bot, r.llm, r.llm_err, r.active], [2, 2, 1, 2], "активных — разных людей");
    assert.deepEqual([r.queue, r.queue_peak], [2, 5]);
    assert.equal(r.db_mb, 5);
    assert.ok(r.disk_total_mb! > 0 && r.disk_free_mb! >= 0, "statfs");
    assert.ok(r.cpu_ms > 0 && r.cpu_proc > 0, "процессор процесса");
    assert.ok(r.rss_mb > 0 && r.mem_total_mb > 0 && r.mem_limit_mb > 0 && r.mem_limit_mb <= r.mem_total_mb);
    assert.ok(r.cores >= 1);
    const n = meter.sample(new Date(NOW.getTime() + MIN));
    assert.deepEqual([n.http, n.http_5xx, n.bot, n.llm, n.active, n.queue_peak, n.http_p50], [0, 0, 0, 0, 0, 2, null], "минута с нуля");

    // Тик (снимок + запись в базу) — миллисекунды. Наполним минуту, как в час пик: 5000 запросов (больше выборки p50/p95).
    // Время по часам зависит от соседей (в npm test файлы идут параллельно — тик ждёт чужие процессы), поэтому проверяется процессор,
    // который тратит сам тик; время по часам — только в лог.
    const ticks: number[] = [];
    let cpu = 0;
    for (let i = 0; i < 30; i++) {
      for (let k = 0; k < 5000; k++) noteHttp(k % 300, 200);
      const t0 = performance.now(), c0 = process.cpuUsage();
      await meter.tick(new Date(NOW.getTime() + (i + 2) * MIN));
      const c = process.cpuUsage(c0);
      cpu += (c.user + c.system) / 1000;
      ticks.push(performance.now() - t0);
    }
    ticks.sort((a, b) => a - b);
    const med = ticks[15], worst = ticks.at(-1)!;
    console.log(`[metrics] тик: медиана ${med.toFixed(2)} мс, худший ${worst.toFixed(2)} мс, процессор в среднем ${(cpu / 30).toFixed(2)} мс, сам снимок ${(await store.serverMetrics("0")).at(-1)!.tick_ms} мс`);
    assert.ok(cpu / 30 < 20, `процессор на тик ${cpu / 30} мс`);
    assert.equal((await store.serverMetrics("0")).length, 30);
  } finally {
    meter.stop();
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const [name, open] of BASES) {
  test(`${name}: хранение снимков — та же минута не дублируется, чтение за период, чистка старше 7 дней`, async () => {
    const store = await open();
    try {
      assert.equal(await store.kvGet("schema_version"), "40");
      await store.addServerMetric(row(8 * 1440, { http: 1 }));
      await store.addServerMetric(row(6 * 1440, { http: 2 }));
      await store.addServerMetric(row(5, { http: 3, cpu_sys: null, db_mb: null, disk_free_mb: null, disk_total_mb: null, http_p50: null }));
      await store.addServerMetric(row(5, { http: 99 }));
      await store.addServerMetric(row(0, { http: 4, mem_total_mb: 65_000_000, cpu_ms: 59_999.5 }));
      const all = await store.serverMetrics("0");
      assert.deepEqual(all.map((r) => r.http), [1, 2, 3, 4], "по времени; повтор минуты — первый остаётся");
      const five = all[2];
      assert.equal(five.cpu_sys, null);
      assert.equal(five.db_mb, null);
      assert.equal(five.http_p50, null);
      assert.equal(typeof five.cores, "number");
      assert.equal(all[3].mem_total_mb, 65_000_000, "большие числа — без переполнения");
      assert.equal(all[3].cpu_ms, 59_999.5, "дроби сохраняются");
      assert.equal((await store.serverMetrics(new Date(NOW.getTime() - 10 * MIN).toISOString())).length, 2);
      // Чистку делает тик (раз в час): старше 7 дней — нет.
      const meter = new ServerMeter(store);
      await meter.tick(NOW);
      meter.stop();
      const left = await store.serverMetrics("0");
      assert.ok(!left.some((r) => r.http === 1), "8 дней назад — удалено");
      assert.ok(left.some((r) => r.http === 2), "6 дней — осталось");
      assert.equal(SERVER_METRICS_KEEP_DAYS, 7);
      assert.equal(await store.pruneServerMetrics(new Date(NOW.getTime() + MIN).toISOString()), left.length);
    } finally {
      await store.close();
    }
  });
}

test("ряды графиков: шаг 1 / 5 / 60 минут, разрыв, средние и пики", () => {
  const rows = [row(3, { cpu_sys: 20, loop_max: 5, queue_peak: 1 }), row(2, { cpu_sys: 40, loop_max: 50, queue_peak: 4 }), row(0, { cpu_sys: 60, active: 3 })];
  const h = healthSeries(rows, "1h", NOW);
  assert.equal(h.step_min, 1);
  assert.equal(h.t.length, 60);
  assert.equal(h.t.at(-1), "2026-11-25T12:00:00.000Z", "последний шаг — текущая минута");
  assert.deepEqual(h.series.cpu_sys.slice(-4), [20, 40, null, 60], "минута без снимка — null");
  const d = healthSeries(rows, "24h", NOW);
  assert.equal(d.step_min, 5);
  assert.equal(d.t.length, 288);
  // 11:57 и 11:58 — в шаге 11:55, 12:00 — в своём.
  assert.equal(d.series.cpu_sys.at(-2), 30, "среднее");
  assert.equal(d.series.loop_max.at(-2), 50, "наибольшая задержка — пик, не среднее");
  assert.equal(d.series.queue_peak.at(-2), 4);
  assert.equal(d.series.active_max.at(-1), 3);
  const w = healthSeries(rows, "7d", NOW);
  assert.equal(w.t.length, 168);
  assert.equal(w.step_min, 60);
  assert.equal(w.series.http.filter((v) => v != null).length, 2, "11:xx и 12:xx");
  // Память: машина без потолка контейнера — занято от всей; с потолком — процесс от потолка.
  assert.equal(memUsedPct(row(0)), 50);
  assert.equal(memUsedPct(row(0, { mem_limit_mb: 400, rss_mb: 300 })), 75);
});

test("«Сколько выдержит»: мало данных, процессор с простоем и без, память не растёт, модель с потолком и без", () => {
  // Мало минут с людьми — «мало данных».
  const few = [...Array.from({ length: 100 }, (_, i) => row(200 + i)), ...Array.from({ length: CAPACITY_MIN_MINUTES - 1 }, (_, i) => row(i, { active: 4 }))];
  const f = serverCapacity(few);
  assert.equal(f.status, "few");
  assert.equal(f.minutes, CAPACITY_MIN_MINUTES - 1);
  assert.equal(f.people, null);
  assert.deepEqual(serverCapacity([]).status, "few", "пусто — тоже мало данных");

  // Простой: 1000 мс процессора, 200 МБ; в пик 10 человек — 6000 мс и 300 МБ: на человека 500 мс и 10 МБ, по 2 вызова модели.
  const idle = Array.from({ length: 60 }, (_, i) => row(100 + i, { cpu_ms: 1000, rss_mb: 200, llm: 0 }));
  const peak = Array.from({ length: 40 }, (_, i) => row(i, { active: 10, cpu_ms: 6000, rss_mb: 300, llm: 20 }));
  const c = serverCapacity([...idle, ...peak], { rpm: 500 });
  assert.equal(c.status, "ok");
  assert.equal(c.peak_active, 10);
  const cpu = c.limits.find((l) => l.id === "cpu")!;
  assert.equal(cpu.per, 500);
  assert.equal(cpu.people, Math.floor((51_000 - 1000) / 500), "одно ядро × 85% минус простой");
  const mem = c.limits.find((l) => l.id === "memory")!;
  assert.equal(mem.per, 10);
  // Без потолка контейнера: свободно 2000 + своё 300 − 15% от 4000 − простой 200 = 1500 МБ.
  assert.equal(mem.people, 150);
  const model = c.limits.find((l) => l.id === "model")!;
  assert.equal(model.per, 2);
  assert.equal(model.people, 250);
  assert.equal(c.people, 100, "меньшее из ограничений");
  assert.equal(c.bottleneck, "cpu");

  // Потолок провайдера не известен — у модели нет числа, итог — по остальным.
  const noRpm = serverCapacity([...idle, ...peak]);
  assert.equal(noRpm.limits.find((l) => l.id === "model")!.people, null);
  assert.match(noRpm.limits.find((l) => l.id === "model")!.note, /LLM_RPM/);
  assert.equal(noRpm.people, 100);

  // Нет минут без людей и память ровная: вся нагрузка процессора — на людей, ограничения по памяти не видно.
  const flat = Array.from({ length: 40 }, (_, i) => row(i, { active: 5, cpu_ms: 2500, rss_mb: 200 }));
  const fl = serverCapacity(flat, { rpm: 1000 });
  assert.equal(fl.limits.find((l) => l.id === "cpu")!.per, 500);
  assert.equal(fl.limits.find((l) => l.id === "cpu")!.people, 102);
  assert.equal(fl.limits.find((l) => l.id === "memory")!.people, null);
  assert.equal(fl.limits.find((l) => l.id === "model")!.people, 5000, "1000 в минуту / 0,2 вызова на человека");

  // В пик процессора не больше, чем в простое (шум) — оценка не уходит в бесконечность.
  const noisy = serverCapacity([...Array.from({ length: 20 }, (_, i) => row(100 + i, { cpu_ms: 3000 })), ...Array.from({ length: 40 }, (_, i) => row(i, { active: 2, cpu_ms: 2000 }))]);
  assert.equal(noisy.limits.find((l) => l.id === "cpu")!.per, 1000);
  assert.ok(Number.isFinite(noisy.people!));

  // Контейнер с потолком 1000 МБ: до 85% — 850 минус простой 200 → 650 / 10 МБ.
  const box = serverCapacity([...idle, ...peak].map((r) => ({ ...r, mem_limit_mb: 1000 })));
  assert.equal(box.limits.find((l) => l.id === "memory")!.people, 65);
  assert.equal(box.bottleneck, "memory");

  // Памяти уже не хватает — ноль, а не меньше нуля.
  const full = serverCapacity([...idle, ...peak].map((r) => ({ ...r, mem_free_mb: 10 })));
  assert.equal(full.limits.find((l) => l.id === "memory")!.people, 0);
});

test("отчёт нагрузки: «сейчас» только свежий, пик за сутки, ряды выбранного интервала", async () => {
  const store = await Store.open(":memory:");
  try {
    await store.addServerMetric(row(2 * 1440, { cpu_sys: 99 }));
    await store.addServerMetric(row(60, { cpu_sys: 70, http_5xx: 3 }));
    await store.addServerMetric(row(10, { cpu_sys: 30 }));
    let v = await serverLoad(store, "24h", NOW);
    assert.equal(v.now, null, "последний снимок 10 минут назад — не «сейчас»");
    assert.equal(v.peak.cpu_sys, 70, "пик — за сутки (99 позавчера не в счёт)");
    assert.equal(v.peak.http_5xx, 3);
    assert.equal(v.samples, 3);
    assert.equal(v.t.length, 288);
    assert.equal(v.capacity.status, "few");
    await store.addServerMetric(row(1, { cpu_sys: 40 }));
    v = await serverLoad(store, "1h", NOW, { rpm: 300 });
    assert.equal(v.now?.cpu_sys, 40);
    assert.equal(v.now?.mem_pct, 50);
    assert.equal(v.llm_rpm, 300);
    assert.equal(v.t.length, 60);
  } finally {
    await store.close();
  }
});

test("оповещение server_load: процессор или память выше 85% всё окно — письмо, антиспам, «снова норма»; мало снимков — молчит", async () => {
  const store = await Store.open(":memory:");
  try {
    await store.once("digest:2026-11-25");
    const sent: string[] = [];
    const a = new Alerts(store, { notify: async (t) => (sent.push(t), 1), publicUrl: "https://maid.test" });
    const load = () => sent.filter((t) => /Сервер нагружен|нагрузка сервера/.test(t));
    const at = (m: number) => new Date(NOW.getTime() + m * MIN);
    const put = async (from: number, to: number, x: Partial<ServerMetricRow>) => {
      for (let m = from; m <= to; m++) await store.addServerMetric({ ...row(0, x), at: new Date(Math.floor(at(m).getTime() / MIN) * MIN).toISOString() });
    };
    const rule = async () => (await a.view(at(0))).rules.find((r) => r.id === "server_load")!;
    assert.deepEqual([(await rule()).threshold, (await rule()).window_min, (await rule()).enabled], [85, 10, true]);

    // 5 минут под нагрузкой — окно (10 мин) не набрано: не трогаем.
    await put(-4, 0, { cpu_sys: 95 });
    let r = (await a.check(at(0), true))!.find((x) => x.id === "server_load")!;
    assert.equal(r.value, null);
    assert.equal(load().length, 0);

    // Одна минута окна ниже порога — не «дольше 10 минут».
    await put(1, 4, { cpu_sys: 95 });
    await put(5, 5, { cpu_sys: 50 });
    r = (await a.check(at(5), true))!.find((x) => x.id === "server_load")!;
    assert.equal(r.hit, false);
    assert.equal(load().length, 0);

    // 10 минут подряд память 90% (процессор в норме) — письмо.
    await put(6, 16, { cpu_sys: 10, mem_free_mb: 400 });
    r = (await a.check(at(16), true))!.find((x) => x.id === "server_load")!;
    assert.equal(r.hit, true);
    assert.equal(r.sent, "fire");
    assert.equal(load().length, 1);
    assert.match(load()[0], /память 90% и выше всё окно \(порог 85%, окно 10 мин\)/);
    assert.match(load()[0], /Здоровье сервера/);

    // Держится, но «не чаще раза в 60 минут» — молчит.
    await put(17, 26, { cpu_sys: 10, mem_free_mb: 400 });
    r = (await a.check(at(26), true))!.find((x) => x.id === "server_load")!;
    assert.equal(r.hit, true);
    assert.equal(load().length, 1, "антиспам");

    // Прошло: «снова норма».
    await put(27, 40, { cpu_sys: 20, cpu_proc: 30, mem_free_mb: 2000 });
    r = (await a.check(at(40), true))!.find((x) => x.id === "server_load")!;
    assert.equal(r.hit, false);
    assert.equal(r.sent, "ok");
    assert.match(load().at(-1)!, /Снова норма: нагрузка сервера ниже порога — сейчас процессор 30%, память 50%/);

    // Node в одном потоке: процесс — 97% ядра при машине 40% — тоже «процессор» (час после прошлого письма прошёл).
    await put(41, 80, { cpu_sys: 40, cpu_proc: 97 });
    r = (await a.check(at(80), true))!.find((x) => x.id === "server_load")!;
    assert.equal(r.hit, true);
    assert.match(load().at(-1)!, /процессор 97%/);
  } finally {
    await store.close();
  }
});

// ——— Ручка админки: тем же путём, что сайт (вход → код из «Telegram» → /api/admin/*).
const OWNER = "987654321";
test("админка: GET /api/admin/health/load — 404 не админу, 403 без кода, интервалы, без имён и путей", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maid-load-"));
  config.allowedChatIds.splice(0, Infinity, OWNER);
  config.adminChatIds.splice(0, Infinity);
  const store = await Store.open(path.join(dir, "maid.sqlite"));
  await store.createUser({ login: "owner", passwordHash: await hashPassword("owner-pass-1"), tz: TZ, chatId: OWNER, name: "Хозяин" });
  await store.createUser({ login: "anya", passwordHash: await hashPassword("anya-pass-1"), tz: TZ, chatId: "11", name: "Аня" });
  const tg: string[] = [];
  const server = createApi({ store, pipeline: new Pipeline(store, async () => "{}"), adminCode: async (_u, text) => void tg.push(text), llmRpm: 600 }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (token: string, p: string, body?: unknown) => {
    const r = await fetch(base + p, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> };
  };
  const login = async (l: string, pw: string) => String((await (await fetch(base + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: l, password: pw }) })).json()).token);
  try {
    const meter = new ServerMeter(store, { diskPath: dir, dbBytes: () => 1024 });
    const anya = await login("anya", "anya-pass-1");
    assert.equal((await call(anya, "/api/admin/health/load")).status, 404, "не админу — адреса нет");
    const owner = await login("owner", "owner-pass-1");
    assert.equal((await call(owner, "/api/admin/health/load")).status, 403, "без кода");
    await call(owner, "/api/admin/code", {});
    assert.equal((await call(owner, "/api/admin/confirm", { code: tg.at(-1)!.match(/\d{6}/)![0] })).status, 200);
    // Запросы выше прошли через сервер — снимок их видит (запросы, активные люди).
    const snap = await meter.tick();
    meter.stop();
    assert.ok(snap.http >= 5, `запросов ${snap.http}`);
    assert.ok(snap.active >= 1);
    for (const [range, n] of [["1h", 60], ["24h", 288], ["7d", 168], ["что-то", 288]] as const) {
      const v = await call(owner, `/api/admin/health/load?range=${range}`);
      assert.equal(v.status, 200, range);
      assert.equal(v.body.t.length, n, range);
      assert.ok(v.body.now, "свежий снимок");
      assert.equal(v.body.llm_rpm, 600);
      assert.equal(v.body.capacity.status, "few");
      const txt = JSON.stringify(v.body);
      for (const bad of ["Аня", "anya", "Хозяин", "owner", OWNER, dir, dir.replace(/\\/g, "\\\\")]) assert.ok(!txt.includes(bad), `нет «${bad}» в ответе`);
    }
    const h = await call(owner, "/api/admin/health");
    assert.equal(h.status, 200, "прежний отчёт здоровья на месте");
    assert.ok(Array.isArray(h.body.errors));
  } finally {
    server.close();
    await store.close();
    resetServerMeter();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ——— Этап 9, исправления «Здоровья сервера».
test("интервал: только свои ключи — range=constructor, toString, __proto__ → 24h, а не 500", async () => {
  for (const bad of ["constructor", "toString", "__proto__", "hasOwnProperty", "", null, undefined]) assert.equal(healthRange(bad), "24h", String(bad));
  assert.deepEqual(["1h", "24h", "7d"].map(healthRange), ["1h", "24h", "7d"]);
  const store = await Store.open(":memory:");
  try {
    await store.addServerMetric(row(1));
    const v = await serverLoad(store, healthRange("constructor"), NOW);
    assert.equal(v.range, "24h");
    assert.equal(v.t.length, 288);
  } finally {
    await store.close();
  }
});

test("ряды ошибок — сумма за шаг: одна 5xx за час на 7 дн. — 1, а не 0,02", () => {
  const rows = [row(30, { http_5xx: 1, llm_err: 2 }), ...Array.from({ length: 50 }, (_, i) => row(i + 1, { http_5xx: 0, llm_err: 0 }))];
  const w = healthSeries(rows, "7d", NOW);
  assert.equal(w.series.http_5xx.at(-2), 1, "11:xx — одна ошибка за шаг");
  assert.equal(w.series.llm_err.at(-2), 2);
  const d = healthSeries([row(3, { http_5xx: 1 }), row(2, { http_5xx: 2 })], "24h", NOW);
  assert.equal(d.series.http_5xx.at(-2), 3, "24 ч — сумма за 5 минут");
  assert.equal(d.series.http.at(-2), 20, "запросы — по-прежнему среднее в минуту");
});

test("отчёт нагрузки: ряды читаются только за интервал, пик и «Сколько выдержит» — раз в минуту и нужными столбцами", async () => {
  const store = await Store.open(":memory:");
  try {
    for (let i = 0; i < 3 * 1440; i += 30) await store.addServerMetric(row(i));
    const calls: { since: string; cols: readonly string[] | undefined }[] = [];
    const orig = store.serverMetrics.bind(store);
    store.serverMetrics = (async (since: string, cols?: readonly string[]) => (calls.push({ since, cols }), orig(since, cols as never))) as typeof store.serverMetrics;
    const v1 = await serverLoad(store, "1h", NOW);
    const full = calls.filter((c) => !c.cols);
    assert.equal(full.length, 1, "полные строки — один раз, для рядов");
    assert.equal(full[0].since, new Date(NOW.getTime() - 60 * MIN).toISOString(), "ряды 1 ч — только последний час");
    const week = calls.find((c) => c.cols && c.since === new Date(NOW.getTime() - SERVER_METRICS_KEEP_DAYS * 1440 * MIN).toISOString())!;
    assert.ok(week, "за 7 дней — только для оценки");
    assert.ok(week.cols!.length <= 10 && !week.cols!.includes("heap_mb"), `столбцы оценки: ${week.cols}`);
    assert.equal(v1.samples, 144);
    calls.length = 0;
    const v2 = await serverLoad(store, "24h", new Date(NOW.getTime() + LOAD_CACHE_MS - 1000));
    assert.deepEqual(calls.map((c) => c.cols), [undefined], "в пределах минуты — только ряды выбранного интервала");
    assert.deepEqual(v2.capacity, v1.capacity);
    calls.length = 0;
    await serverLoad(store, "24h", new Date(NOW.getTime() + LOAD_CACHE_MS + 1000));
    assert.equal(calls.length, 3, "минута прошла — пересчёт");
  } finally {
    await store.close();
  }
});

test("«Сколько выдержит»: квота процессора контейнера — потолок от квоты; не прочитать — в заметке", () => {
  assert.equal(parseCpuMax("50000 100000\n"), 0.5);
  assert.equal(parseCpuMax("max 100000"), null);
  assert.equal(parseCpuMax("200000 100000"), 2);
  assert.equal(parseCpuMax("мусор"), undefined);
  const idle = Array.from({ length: 60 }, (_, i) => row(100 + i, { cpu_ms: 1000, rss_mb: 200, llm: 0 }));
  const peak = Array.from({ length: 40 }, (_, i) => row(i, { active: 10, cpu_ms: 6000, rss_mb: 300, llm: 20 }));
  const half = serverCapacity([...idle, ...peak], { cpuQuota: 0.5 }).limits.find((l) => l.id === "cpu")!;
  assert.equal(half.budget, 25_500, "полядра × 60 000 × 85%");
  assert.equal(half.people, Math.floor((25_500 - 1000) / 500));
  assert.match(half.note, /квота контейнера 0,5 ядра/);
  const two = serverCapacity([...idle, ...peak], { cpuQuota: 2 }).limits.find((l) => l.id === "cpu")!;
  assert.equal(two.budget, 51_000, "квота больше ядра — всё равно одно ядро (Node — один поток)");
  const unk = serverCapacity([...idle, ...peak], { cpuQuota: "unknown" }).limits.find((l) => l.id === "cpu")!;
  assert.equal(unk.budget, 51_000);
  assert.match(unk.note, /квота процессора контейнера не прочитана — не учтена/);
  assert.doesNotMatch(serverCapacity([...idle, ...peak]).limits.find((l) => l.id === "cpu")!.note, /квота/);
});

test("снимок: процессор процесса — от квоты контейнера, если она меньше ядра", async () => {
  const store = await Store.open(":memory:");
  const whole = new ServerMeter(store, { cpuQuota: null }), half = new ServerMeter(store, { cpuQuota: 0.5 });
  try {
    const until = Date.now() + 60;
    while (Date.now() < until) { /* процессор */ }
    const a = whole.sample(NOW), b = half.sample(NOW);
    // Оба считали почти одно и то же время с создания; у «полядра» процент вдвое выше на ту же работу.
    assert.ok(a.cpu_proc > 0 && b.cpu_proc > a.cpu_proc * 1.5, `${a.cpu_proc} → ${b.cpu_proc}`);
  } finally {
    whole.stop(); half.stop();
    await store.close();
  }
});

test("HTTP: оборванный клиентом до конца ответа запрос — в счёт запросов и ошибок", async () => {
  const store = await Store.open(":memory:");
  const server = createApi({ store, pipeline: new Pipeline(store, async () => "{}") }).listen(0);
  const port = (server.address() as AddressInfo).port;
  const meter = new ServerMeter(store);
  try {
    resetServerMeter();
    // Тело обещано на 1000 байт, пришло 10 — сервер ждёт тело, клиент уходит по таймауту.
    await new Promise<void>((done) => {
      const req = http.request({ port, host: "127.0.0.1", method: "POST", path: "/api/login", headers: { "content-type": "application/json", "content-length": 1000 } });
      req.on("error", () => done());
      req.write('{"login":"');
      setTimeout(() => { req.destroy(); done(); }, 100);
    });
    await new Promise((r) => setTimeout(r, 150));
    const ok = await fetch(`http://127.0.0.1:${port}/api/nope`);
    await ok.text();
    await new Promise((r) => setTimeout(r, 50));
    const snap = meter.sample(NOW);
    assert.equal(snap.http, 2, "оборванный и обычный");
    assert.equal(snap.http_5xx, 1, "оборванный — ошибка");
    assert.ok(snap.http_p95! >= 50, `время оборванного в p95: ${snap.http_p95}`);
  } finally {
    meter.stop();
    server.close();
    await store.close();
    resetServerMeter();
  }
});

test("оповещение server_load: одна просевшая минута среди нагрузки — не «снова норма»; норма всё окно — да", async () => {
  const store = await Store.open(":memory:");
  try {
    await store.once("digest:2026-11-25");
    const sent: string[] = [];
    const a = new Alerts(store, { notify: async (t) => (sent.push(t), 1), publicUrl: "https://maid.test" });
    const load = () => sent.filter((t) => /Сервер нагружен|нагрузка сервера/.test(t));
    const at = (m: number) => new Date(NOW.getTime() + m * MIN);
    const put = async (from: number, to: number, x: Partial<ServerMetricRow>) => {
      for (let m = from; m <= to; m++) await store.addServerMetric({ ...row(0, x), at: new Date(Math.floor(at(m).getTime() / MIN) * MIN).toISOString() });
    };
    const check = async (m: number) => (await a.check(at(m), true))!.find((x) => x.id === "server_load")!;
    await put(0, 10, { cpu_sys: 92 });
    assert.equal((await check(10)).sent, "fire");
    // Процессор 88–95%, одна минута 84%: тревога держится, «снова норма» не приходит.
    await put(11, 14, { cpu_sys: 90 });
    await put(15, 15, { cpu_sys: 84 });
    await put(16, 20, { cpu_sys: 95 });
    let r = await check(20);
    assert.equal(r.hit, true, "одна просевшая минута — всё ещё нагружен");
    assert.notEqual(r.sent, "ok");
    assert.equal(load().length, 1, "ни «снова норма», ни лишнего письма");
    // Норма — пока в окне есть минуты выше порога, тревога держится; норма всё окно — «снова норма».
    await put(21, 25, { cpu_sys: 30, cpu_proc: 20 });
    r = await check(25);
    assert.equal(r.hit, true, "в окне ещё минуты выше порога");
    await put(26, 31, { cpu_sys: 30, cpu_proc: 20 });
    r = await check(31);
    assert.equal(r.hit, false);
    assert.equal(r.sent, "ok");
    assert.match(load().at(-1)!, /Снова норма/);
  } finally {
    await store.close();
  }
});
