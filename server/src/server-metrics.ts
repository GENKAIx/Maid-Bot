import fs from "node:fs";
import os from "node:os";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import type { ServerMetricRow, Store } from "./db.ts";

// «Здоровье сервера» подробно (часть 2 этапа «Тарифы и управление», 25.11.2026): раз в минуту — снимок нагрузки в таблицу
// server_metrics (шаг 37), 7 дней, чистка раз в час. Хранение в таблице, а не в kv: перезапуск истории не теряет, чтение за
// период и чистка — по ключу at, без разбора одного большого JSON.
// Снимок дешёвый: счётчики за минуту копятся в памяти простыми числами (noteHttp, noteBotUpdate, noteLlmCall, noteActive,
// noteQueue), сам снимок — process.cpuUsage, os.cpus, process.memoryUsage, гистограмма задержки цикла, stat файла базы и statfs
// диска: доли миллисекунды (tick_ms пишется в строку; server/test/server-metrics.test.ts проверяет, что тик — миллисекунды).
// Людей не хранит: «активных» — только число разных за минуту (Set в памяти очищается каждой минутой).

export const SERVER_METRICS_TICK_MS = 60_000;
export const SERVER_METRICS_KEEP_DAYS = 7;
/** Сколько времён ответа за минуту держать для p50/p95 (больше — равномерная выборка: каждый запрос с равным шансом). */
export const HTTP_SAMPLE_MAX = 4096;
/** Шаг гистограммы задержки цикла, мс (из значений вычитается: таймер сам срабатывает не чаще). */
const LOOP_RESOLUTION_MS = 20;
const MB = 1024 * 1024;
const MIN = 60_000;
const DAY = 86_400_000;

// ——— Счётчики текущей минуты (в памяти процесса; снимок их забирает и обнуляет).
const minute = { http: 0, http5xx: 0, seen: 0, times: [] as number[], bot: 0, llm: 0, llmErr: 0, active: new Set<number>(), queuePeak: 0 };

/** Запрос закончился (api.ts, событие close — и после ответа, и при обрыве): время от входа до конца ответа или до обрыва, код.
 *  Оборванный клиентом до конца ответа (таймаут fetch, закрытая вкладка) — тоже в счёт и в p50/p95, и считается ошибкой (в http_5xx):
 *  при перегрузке обрываются как раз самые долгие. */
export function noteHttp(ms: number, status: number, aborted = false) {
  minute.http++;
  if (status >= 500 || aborted) minute.http5xx++;
  minute.seen++;
  if (minute.times.length < HTTP_SAMPLE_MAX) minute.times.push(ms);
  else {
    const j = Math.floor(Math.random() * minute.seen);
    if (j < HTTP_SAMPLE_MAX) minute.times[j] = ms;
  }
}
/** Пришёл апдейт Telegram (вебхук или long polling — index.ts, обёртка bot.handleUpdate). */
export const noteBotUpdate = () => void minute.bot++;
/** Попытка вызова модели (index.ts, onLlmCall — то же, что пишется в llm_calls). */
export function noteLlmCall(failed: boolean) {
  minute.llm++;
  if (failed) minute.llmErr++;
}
/** Человек что-то сделал (запрос API, сообщение боту) — в счёт «активных за минуту»; хранится только число. */
export function noteActive(userId: number) {
  if (minute.active.size < 100_000) minute.active.add(userId);
}
/** Сколько разборов сейчас в работе (pipeline.ts inFlight) — для наибольшей очереди за минуту. */
export function noteQueue(n: number) {
  if (n > minute.queuePeak) minute.queuePeak = n;
}
/** Для тестов: начать минуту с нуля. */
export function resetServerMeter() {
  Object.assign(minute, { http: 0, http5xx: 0, seen: 0, times: [], bot: 0, llm: 0, llmErr: 0, active: new Set<number>(), queuePeak: 0 });
}

const quant = (sorted: number[], q: number): number | null => {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
};
const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
function sysTimes() {
  let idle = 0, total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total, cores: Math.max(1, os.cpus().length) };
}
/** Потолок памяти процесса: ограничение контейнера (cgroup), если оно меньше всей памяти машины, иначе вся память. */
function memLimit(total: number) {
  const c = (process as { constrainedMemory?: () => number | undefined }).constrainedMemory?.() ?? 0;
  return c > 0 && c < total ? c : total;
}

/** Квота процессора контейнера, ядер: cgroup v2 «cpu.max» («50000 100000» → 0,5; «max 100000» → null — без квоты). Не разобрать — undefined. */
export function parseCpuMax(text: string): number | null | undefined {
  const [q, p] = text.trim().split(/\s+/);
  if (q === "max") return null;
  const quota = Number(q), period = Number(p ?? 100_000);
  return quota > 0 && period > 0 ? quota / period : undefined;
}
let quotaRead: { v: number | null | "unknown" } | null = null;
/** Квота процессора контейнера, ядер (читается один раз): null — квоты нет (или не Linux — контейнера нет), "unknown" — на Linux не прочитать. */
export function cpuQuota(): number | null | "unknown" {
  if (quotaRead) return quotaRead.v;
  let v: number | null | "unknown" = null;
  if (process.platform === "linux") {
    try {
      v = parseCpuMax(fs.readFileSync("/sys/fs/cgroup/cpu.max", "utf8")) ?? "unknown";
    } catch {
      try { // cgroup v1
        const q = Number(fs.readFileSync("/sys/fs/cgroup/cpu/cpu.cfs_quota_us", "utf8")), p = Number(fs.readFileSync("/sys/fs/cgroup/cpu/cpu.cfs_period_us", "utf8"));
        v = q < 0 ? null : q > 0 && p > 0 ? q / p : "unknown";
      } catch { v = "unknown"; }
    }
  }
  quotaRead = { v };
  return v;
}
/** Доля одного ядра, доступная процессу: квота меньше ядра — она, иначе ядро (Node считает в одном потоке). */
const coreShare = (q: number | null | "unknown" | undefined) => (typeof q === "number" && q > 0 ? Math.min(1, q) : 1);

export interface ServerMeterDeps {
  /** Размер базы, байт (null — не измерить: Postgres). */
  dbBytes?: () => number | null;
  /** Папка на диске, где лежит база (свободное место — fs.statfs); нет — не мерить. */
  diskPath?: string | null;
  /** Разборов в работе сейчас (Pipeline.inWork). */
  queue?: () => number;
  /** Квота процессора контейнера, ядер (null — нет); по умолчанию — cpuQuota(). cpu_proc считается от min(1, квота) ядра. */
  cpuQuota?: number | null;
}

/** Снимок раз в минуту: sample() — посчитать строку (и обнулить счётчики минуты), tick() — записать и раз в час почистить. */
export class ServerMeter {
  private cpu = process.cpuUsage();
  private wall = performance.now();
  private sys = sysTimes();
  private loop = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastPrune = 0;
  private share: number;
  constructor(private store: Store, private deps: ServerMeterDeps = {}) {
    this.loop.enable();
    this.share = coreShare("cpuQuota" in deps ? deps.cpuQuota : cpuQuota());
  }

  sample(now = new Date()): ServerMetricRow {
    const t0 = performance.now();
    const wall = Math.max(1, t0 - this.wall);
    const d = process.cpuUsage(this.cpu);
    this.cpu = process.cpuUsage();
    this.wall = t0;
    const cpuMs = (d.user + d.system) / 1000;
    const s = sysTimes();
    const dTotal = s.total - this.sys.total, dIdle = s.idle - this.sys.idle;
    this.sys = s;
    const mem = process.memoryUsage();
    const total = os.totalmem(), free = os.freemem();
    const lp = (q: number) => (this.loop.count ? Math.max(0, this.loop.percentile(q) / 1e6 - LOOP_RESOLUTION_MS) : 0);
    const loop = { p50: lp(50), p99: lp(99), max: this.loop.count ? Math.max(0, this.loop.max / 1e6 - LOOP_RESOLUTION_MS) : 0 };
    this.loop.reset();
    const times = minute.times.sort((a, b) => a - b);
    let disk: { free: number; total: number } | null = null;
    if (this.deps.diskPath) {
      try {
        const st = fs.statfsSync(this.deps.diskPath);
        disk = { free: st.bavail * st.bsize, total: st.blocks * st.bsize };
      } catch { /* нет statfs или папки — без диска */ }
    }
    let db: number | null = null;
    try { db = this.deps.dbBytes?.() ?? null; } catch { /* не измерить */ }
    let queue = 0;
    try { queue = this.deps.queue?.() ?? 0; } catch { /* нет очереди */ }
    const load = os.loadavg()[0];
    const row: ServerMetricRow = {
      at: new Date(Math.floor(now.getTime() / MIN) * MIN).toISOString(),
      cpu_proc: r1((cpuMs / (wall * this.share)) * 100), cpu_ms: r1(cpuMs),
      cpu_sys: dTotal > 0 ? r1(Math.min(100, Math.max(0, (1 - dIdle / dTotal) * 100))) : null,
      load1: Number.isFinite(load) ? r2(load) : null, cores: s.cores,
      rss_mb: r1(mem.rss / MB), heap_mb: r1(mem.heapUsed / MB), heap_total_mb: r1(mem.heapTotal / MB),
      mem_total_mb: r1(total / MB), mem_free_mb: r1(free / MB), mem_limit_mb: r1(memLimit(total) / MB),
      loop_p50: r2(loop.p50), loop_p99: r2(loop.p99), loop_max: r2(loop.max),
      http: minute.http, http_p50: times.length ? r1(quant(times, 0.5)!) : null, http_p95: times.length ? r1(quant(times, 0.95)!) : null, http_5xx: minute.http5xx,
      bot: minute.bot, llm: minute.llm, llm_err: minute.llmErr, active: minute.active.size,
      queue, queue_peak: Math.max(queue, minute.queuePeak),
      db_mb: db == null ? null : r1(db / MB), disk_free_mb: disk ? r1(disk.free / MB) : null, disk_total_mb: disk ? r1(disk.total / MB) : null,
      uptime: Math.round(process.uptime()), tick_ms: 0,
    };
    resetServerMeter();
    row.tick_ms = r2(performance.now() - t0);
    return row;
  }

  /** Снимок в базу; раз в час — удалить старше SERVER_METRICS_KEEP_DAYS. */
  async tick(now = new Date()): Promise<ServerMetricRow> {
    const row = this.sample(now);
    await this.store.addServerMetric(row);
    if (now.getTime() - this.lastPrune >= 3600_000) {
      this.lastPrune = now.getTime();
      await this.store.pruneServerMetrics(new Date(now.getTime() - SERVER_METRICS_KEEP_DAYS * DAY).toISOString());
    }
    return row;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch((e) => console.error("[metrics]", e)), SERVER_METRICS_TICK_MS);
    this.timer.unref();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.loop.disable();
  }
}

// ——— Отчёт для админки: ряды за 1 ч / 24 ч / 7 дн, «сейчас» и пик за сутки, оценка «Сколько выдержит».

/** Память занята, %: у контейнера с потолком — процесс от потолка, иначе машина (всего − свободно). */
export function memUsedPct(r: Pick<ServerMetricRow, "rss_mb" | "mem_total_mb" | "mem_free_mb" | "mem_limit_mb">): number {
  if (r.mem_limit_mb > 0 && r.mem_limit_mb < r.mem_total_mb) return (r.rss_mb / r.mem_limit_mb) * 100;
  return r.mem_total_mb > 0 ? ((r.mem_total_mb - r.mem_free_mb) / r.mem_total_mb) * 100 : 0;
}
/** Процессор для оповещения, %: больший из «машина» и «процесс от одного ядра» (Node считает в одном потоке — его ядро и есть потолок). */
export const cpuPct = (r: Pick<ServerMetricRow, "cpu_sys" | "cpu_proc">) => Math.max(r.cpu_sys ?? 0, r.cpu_proc);

export const HEALTH_RANGES = { "1h": { min: 60, step: 1 }, "24h": { min: 1440, step: 5 }, "7d": { min: 7 * 1440, step: 60 } } as const;
export type HealthRange = keyof typeof HEALTH_RANGES;
export const healthRange = (v: string | null | undefined): HealthRange => (v && Object.hasOwn(HEALTH_RANGES, v) ? (v as HealthRange) : "24h");

/** Ряды графиков: средние за шаг (счётчики — «в минуту»), у пиков (наибольшая задержка, очередь, людей) — наибольшее, у ошибок
 *  (5xx и обрывы, модель с ошибкой) — сумма за шаг: редкая ошибка на 7 дн. не округляется в ноль. Шага без снимков (сервер не
 *  работал) — null: на графике разрыв. */
const SERIES = {
  cpu_sys: "avg", cpu_proc: "avg", cpu_proc_max: "max", mem_pct: "avg", rss_mb: "avg", heap_mb: "avg",
  loop_p50: "avg", loop_p99: "avg", loop_max: "max", http: "avg", http_p50: "avg", http_p95: "avg", http_5xx: "sum",
  bot: "avg", llm: "avg", llm_err: "sum", queue_peak: "max", active: "avg", active_max: "max",
} as const;
type SeriesKey = keyof typeof SERIES;
const valueOf = (r: ServerMetricRow, k: SeriesKey): number | null =>
  k === "mem_pct" ? memUsedPct(r) : k === "cpu_proc_max" ? r.cpu_proc : k === "active_max" ? r.active : (r[k] as number | null);

export function healthSeries(rows: ServerMetricRow[], range: HealthRange, now = new Date()) {
  const { min, step } = HEALTH_RANGES[range];
  const n = Math.round(min / step);
  const end = Math.floor(now.getTime() / (step * MIN)) * step * MIN + step * MIN; // конец последнего (текущего) шага
  const start = end - n * step * MIN;
  const keys = Object.keys(SERIES) as SeriesKey[];
  const acc = keys.map(() => Array.from({ length: n }, () => ({ s: 0, n: 0, m: -Infinity })));
  for (const r of rows) {
    const i = Math.floor((Date.parse(r.at) - start) / (step * MIN));
    if (i < 0 || i >= n) continue;
    keys.forEach((k, ki) => {
      const v = valueOf(r, k);
      if (v == null || !Number.isFinite(v)) return;
      const a = acc[ki][i];
      a.s += v; a.n++; a.m = Math.max(a.m, v);
    });
  }
  const series = Object.fromEntries(keys.map((k, ki) => [k, acc[ki].map((a) => (a.n ? r2(SERIES[k] === "max" ? a.m : SERIES[k] === "sum" ? a.s : a.s / a.n) : null))])) as Record<SeriesKey, (number | null)[]>;
  return { range, step_min: step, t: Array.from({ length: n }, (_, i) => new Date(start + i * step * MIN).toISOString()), series };
}

// ——— «Сколько выдержит»: оценка одновременно активных людей по замерам (не нагрузочный тест).
/** Меньше стольких минут с активными людьми — «мало данных». */
export const CAPACITY_MIN_MINUTES = 30;
/** Потолок, до которого считаем запас: 85% (как правило оповещения server_load). */
export const CAPACITY_TARGET = 0.85;
/** Час пик — 10% самых людных минут, но не меньше 10 минут. */
const PEAK_SHARE = 0.1;
const PEAK_MIN = 10;
/** Простой — минут без людей не меньше стольких, иначе база «без людей» не известна (берём 0 — оценка осторожнее). */
const IDLE_MIN = 10;
/** Память на человека меньше — «от людей не растёт заметно» (ограничения по памяти не видно). */
const MEM_PER_MIN_MB = 0.05;

export interface CapacityLimit {
  id: "cpu" | "memory" | "model";
  /** Сколько одновременно активных выдержит по этому ограничению; null — не видно (нет данных или нет потолка). */
  people: number | null;
  /** Нагрузка на одного активного: мс процессора в минуту, МБ памяти, вызовов модели в минуту. */
  per: number | null;
  /** Чем ограничено: мс процессора в минуту (одно ядро × 85%), МБ памяти до 85%, вызовов модели в минуту у провайдера. */
  budget: number | null;
  note: string;
}
export interface Capacity {
  status: "ok" | "few";
  /** Минут с активными людьми за 7 дней и сколько нужно. */
  minutes: number; need: number;
  /** Активных в среднем в час пик (по выбранным минутам) и наибольшее за минуту. */
  peak_active: number; max_active: number;
  people: number | null; bottleneck: CapacityLimit["id"] | null;
  limits: CapacityLimit[];
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? quant(s, 0.5)! : 0;
};

/** Столбцы, которых хватает оценке (отчёт читает за 7 дней только их). */
export const CAPACITY_COLS = ["at", "active", "cpu_ms", "rss_mb", "llm", "mem_total_mb", "mem_free_mb", "mem_limit_mb"] as const;
type CapacityRow = Pick<ServerMetricRow, (typeof CAPACITY_COLS)[number]>;
export interface CapacityOpts {
  rpm?: number;
  /** Квота процессора контейнера, ядер: null/нет — без квоты (одно ядро), "unknown" — не прочитать (в заметке). */
  cpuQuota?: number | null | "unknown";
}

/** Оценка по снимкам: час пик — самые людные минуты; нагрузка на человека = (в пик − в простое) / людей в пик. Процессор считается
 *  от одного ядра (Node — один поток) или от квоты контейнера, если она меньше, память — до 85% потолка, модель — по LLM_RPM, если задан. */
export function serverCapacity(rows: CapacityRow[], opts: CapacityOpts = {}): Capacity {
  const busy = rows.filter((r) => r.active > 0);
  const maxActive = busy.reduce((m, r) => Math.max(m, r.active), 0);
  const base = { minutes: busy.length, need: CAPACITY_MIN_MINUTES, max_active: maxActive };
  if (busy.length < CAPACITY_MIN_MINUTES) return { status: "few", ...base, peak_active: 0, people: null, bottleneck: null, limits: [] };
  const peak = [...busy].sort((a, b) => b.active - a.active || b.cpu_ms - a.cpu_ms).slice(0, Math.max(PEAK_MIN, Math.ceil(busy.length * PEAK_SHARE)));
  const pa = mean(peak.map((r) => r.active));
  const idle = rows.filter((r) => r.active === 0);
  const hasIdle = idle.length >= IDLE_MIN;
  const last = rows[rows.length - 1];

  // Процессор: одно ядро (или квота контейнера, если меньше) за минуту × 85%.
  const cpuBase = hasIdle ? median(idle.map((r) => r.cpu_ms)) : 0;
  const cpuPeak = mean(peak.map((r) => r.cpu_ms));
  let cpuPer = (cpuPeak - cpuBase) / pa;
  if (!(cpuPer > 0)) cpuPer = cpuPeak / pa; // в пик не тяжелее простоя — вся нагрузка на людей (осторожнее)
  cpuPer = Math.max(0.01, cpuPer);
  const share = coreShare(opts.cpuQuota);
  const cpuBudget = SERVER_METRICS_TICK_MS * share * CAPACITY_TARGET;
  const core = share < 1 ? `квота контейнера ${String(r2(share)).replace(".", ",")} ядра (cpu.max)` : "одно ядро";
  const quotaNote = opts.cpuQuota === "unknown" ? "; квота процессора контейнера не прочитана — не учтена" : "";
  const cpu: CapacityLimit = {
    id: "cpu", per: r2(cpuPer), budget: Math.round(cpuBudget),
    people: Math.max(0, Math.floor((cpuBudget - cpuBase) / cpuPer)),
    note: (hasIdle ? `${core}${share < 1 ? "" : " (Node — один поток)"} до 85%; без людей сервер тратит ${Math.round(cpuBase)} мс в минуту` : `${core} до 85%; минут без людей мало — вся нагрузка отнесена на людей`) + quotaNote,
  };

  // Память: до 85% потолка (контейнер) или машины (свободное + своё − 15% запаса).
  const rssBase = hasIdle ? median(idle.map((r) => r.rss_mb)) : Math.min(...rows.map((r) => r.rss_mb));
  const memPer = (mean(peak.map((r) => r.rss_mb)) - rssBase) / pa;
  const limited = last.mem_limit_mb > 0 && last.mem_limit_mb < last.mem_total_mb;
  const memBudget = Math.max(0, limited
    ? last.mem_limit_mb * CAPACITY_TARGET - rssBase
    : last.mem_free_mb + last.rss_mb - last.mem_total_mb * (1 - CAPACITY_TARGET) - rssBase);
  const memory: CapacityLimit = memPer >= MEM_PER_MIN_MB
    ? { id: "memory", per: r2(memPer), budget: Math.round(memBudget), people: Math.floor(memBudget / memPer), note: limited ? "до 85% потолка контейнера" : "до 85% памяти машины (с учётом других программ)" }
    : { id: "memory", per: memPer > 0 ? r2(memPer) : 0, budget: Math.round(memBudget), people: null, note: "память от людей заметно не растёт — ограничения по ней не видно" };

  // Модель: вызовов в минуту на активного в пик и потолок провайдера (LLM_RPM).
  const llmPer = mean(peak.map((r) => r.llm)) / pa;
  const rpm = opts.rpm ?? 0;
  const model: CapacityLimit = !(llmPer > 0)
    ? { id: "model", per: 0, budget: rpm || null, people: null, note: "в час пик модель не звали — не оценить" }
    : rpm > 0
      ? { id: "model", per: r2(llmPer), budget: rpm, people: Math.floor(rpm / llmPer), note: `потолок провайдера ${rpm} запросов в минуту (LLM_RPM)` }
      : { id: "model", per: r2(llmPer), budget: null, people: null, note: "потолок провайдера не известен — задайте LLM_RPM в .env" };

  const limits = [cpu, memory, model];
  const known = limits.filter((l) => l.people != null) as (CapacityLimit & { people: number })[];
  const worst = known.length ? known.reduce((a, b) => (b.people < a.people ? b : a)) : null;
  return { status: "ok", ...base, peak_active: r1(pa), people: worst?.people ?? null, bottleneck: worst?.id ?? null, limits };
}

/** Столбцы для пика за сутки. */
const PEAK_COLS = ["at", "cpu_sys", "cpu_proc", "rss_mb", "mem_total_mb", "mem_free_mb", "mem_limit_mb", "loop_p99", "loop_max", "http", "http_p95", "http_5xx", "llm", "queue_peak", "active", "db_mb"] as const;
type PeakRow = Pick<ServerMetricRow, (typeof PEAK_COLS)[number]>;
/** Пик за сутки и оценка по 7 дням меняются медленно: считаются не чаще раза в LOAD_CACHE_MS (как cachedAnalytics), и чтение — только
 *  нужные столбцы. Ряды выбранного интервала читаются каждый раз, но только за этот интервал. */
export const LOAD_CACHE_MS = 60_000;
type LoadSummary = { since: string | null; samples: number; last_at: string | null; peak: Record<string, number | null>; capacity: Capacity };
const loadCache = new WeakMap<Store, Map<string, { at: number; value: Promise<LoadSummary> }>>();

async function loadSummary(store: Store, now: Date, opts: CapacityOpts): Promise<LoadSummary> {
  const week = await store.serverMetrics(new Date(now.getTime() - SERVER_METRICS_KEEP_DAYS * DAY).toISOString(), CAPACITY_COLS);
  const day: PeakRow[] = await store.serverMetrics(new Date(now.getTime() - DAY).toISOString(), PEAK_COLS);
  const peakOf = (f: (r: PeakRow) => number | null) => {
    let m: number | null = null;
    for (const r of day) { const v = f(r); if (v != null && Number.isFinite(v) && (m == null || v > m)) m = v; }
    return m == null ? null : r2(m);
  };
  const peak = {
    cpu_sys: peakOf((r) => r.cpu_sys), cpu_proc: peakOf((r) => r.cpu_proc), mem_pct: peakOf(memUsedPct), rss_mb: peakOf((r) => r.rss_mb),
    loop_p99: peakOf((r) => r.loop_p99), loop_max: peakOf((r) => r.loop_max), http: peakOf((r) => r.http), http_p95: peakOf((r) => r.http_p95),
    http_5xx: peakOf((r) => r.http_5xx), llm: peakOf((r) => r.llm), queue_peak: peakOf((r) => r.queue_peak), active: peakOf((r) => r.active),
    db_mb: peakOf((r) => r.db_mb),
  };
  return { since: week[0]?.at ?? null, samples: week.length, last_at: week.at(-1)?.at ?? null, peak, capacity: serverCapacity(week, opts) };
}
function cachedSummary(store: Store, now: Date, opts: CapacityOpts): Promise<LoadSummary> {
  const key = `${opts.rpm ?? 0}|${opts.cpuQuota ?? ""}`;
  const m = loadCache.get(store) ?? loadCache.set(store, new Map()).get(store)!;
  const t = now.getTime();
  const hit = m.get(key);
  if (hit && t >= hit.at && t - hit.at < LOAD_CACHE_MS) return hit.value;
  const entry = { at: t, value: loadSummary(store, now, opts) };
  m.set(key, entry);
  entry.value.catch(() => { if (m.get(key) === entry) m.delete(key); });
  return entry.value;
}

/** Раздел «Здоровье сервера» → нагрузка: ряды за range, последний снимок (не старше 3 минут — иначе «нет свежего»), пик за сутки,
 *  оценка «Сколько выдержит» по 7 дням. Только числа — ни людей, ни путей на диске. */
export async function serverLoad(store: Store, range: HealthRange, now = new Date(), opts: CapacityOpts = {}) {
  const o: CapacityOpts = { ...opts, cpuQuota: "cpuQuota" in opts ? opts.cpuQuota : cpuQuota() };
  const rows = await store.serverMetrics(new Date(now.getTime() - HEALTH_RANGES[range].min * MIN).toISOString());
  const sum = await cachedSummary(store, now, o);
  const last = rows.at(-1) ?? null;
  const fresh = last && now.getTime() - Date.parse(last.at) <= 3 * MIN ? last : null;
  const lastAt = [last?.at, sum.last_at].filter((x): x is string => x != null).sort().at(-1) ?? null;
  return {
    now: fresh ? { ...fresh, mem_pct: r1(memUsedPct(fresh)) } : null,
    last_at: lastAt,
    since: sum.since,
    samples: Math.max(sum.samples, rows.length),
    peak: sum.peak,
    llm_rpm: opts.rpm || null,
    keep_days: SERVER_METRICS_KEEP_DAYS,
    ...healthSeries(rows, range, now),
    capacity: sum.capacity,
  };
}
