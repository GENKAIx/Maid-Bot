import { numText } from "./admin";

// «Здоровье сервера» → нагрузка (часть 2 «Тарифы и управление», 25.11.2026): типы ответа GET /api/admin/health/load (копия
// server/src/server-metrics.ts serverLoad) и чистые функции для плашек, подписей графиков и «Сколько выдержит» — их проверяет
// web/test/server-health.test.ts, экран — screens/AdminLoad.tsx.

export type HealthRange = "1h" | "24h" | "7d";
export const HEALTH_RANGE_NAMES: [HealthRange, string][] = [["1h", "1 ч"], ["24h", "24 ч"], ["7d", "7 дн"]];

export interface MetricNow {
  at: string; cpu_proc: number; cpu_ms: number; cpu_sys: number | null; load1: number | null; cores: number;
  rss_mb: number; heap_mb: number; heap_total_mb: number; mem_total_mb: number; mem_free_mb: number; mem_limit_mb: number; mem_pct: number;
  loop_p50: number; loop_p99: number; loop_max: number; http: number; http_p50: number | null; http_p95: number | null; http_5xx: number;
  bot: number; llm: number; llm_err: number; active: number; queue: number; queue_peak: number;
  db_mb: number | null; disk_free_mb: number | null; disk_total_mb: number | null; uptime: number; tick_ms: number;
}
type Peak = "cpu_sys" | "cpu_proc" | "mem_pct" | "rss_mb" | "loop_p99" | "loop_max" | "http" | "http_p95" | "http_5xx" | "llm" | "queue_peak" | "active" | "db_mb";
export type LoadSeriesKey =
  | "cpu_sys" | "cpu_proc" | "cpu_proc_max" | "mem_pct" | "rss_mb" | "heap_mb" | "loop_p50" | "loop_p99" | "loop_max" | "http" | "http_p50"
  | "http_p95" | "http_5xx" | "bot" | "llm" | "llm_err" | "queue_peak" | "active" | "active_max";
export interface CapacityLimit { id: "cpu" | "memory" | "model"; people: number | null; per: number | null; budget: number | null; note: string }
export interface Capacity {
  status: "ok" | "few"; minutes: number; need: number; peak_active: number; max_active: number;
  people: number | null; bottleneck: CapacityLimit["id"] | null; limits: CapacityLimit[];
}
export interface ServerLoad {
  now: MetricNow | null; last_at: string | null; since: string | null; samples: number;
  peak: Record<Peak, number | null>; llm_rpm: number | null; keep_days: number;
  range: HealthRange; step_min: number; t: string[]; series: Record<LoadSeriesKey, (number | null)[]>;
  capacity: Capacity;
}

/** Порог «перегружен» — как правило оповещения server_load (85%). */
export const LOAD_WARN_PCT = 85;

export const pctText = (v: number | null | undefined) => (v == null ? "—" : `${numText(v, v < 10 ? 1 : 0)}%`);
export function mbText(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return v >= 1024 ? `${numText(v / 1024, v >= 10_240 ? 0 : 1)} ГБ` : `${numText(v, v < 10 ? 1 : 0)} МБ`;
}
export const msLoad = (v: number | null | undefined) => (v == null ? "—" : v < 1000 ? `${numText(v, v < 10 ? 1 : 0)} мс` : `${numText(v / 1000, 1)} с`);
export const perMin = (v: number | null | undefined) => (v == null ? "—" : numText(v, v < 10 ? 1 : 0));

/** spare — настоящий запас (процессор, память, модель до LLM_RPM, диск), null — у плашки запаса нет; extra — прочая подпись без слова «запас». */
export interface LoadTile { id: string; title: string; now: string; peak: string; spare: string | null; extra: string | null; warn: boolean }

/** Плашки «сейчас / пик за сутки / запас». Нет свежего снимка — «сейчас» прочерком; запас — от пика за сутки. */
export function loadTiles(v: ServerLoad): LoadTile[] {
  const n = v.now, p = v.peak;
  const limited = n ? n.mem_limit_mb > 0 && n.mem_limit_mb < n.mem_total_mb : false;
  const memBase = n ? (limited ? n.mem_limit_mb : n.mem_total_mb) : null;
  const left = (peak: number | null) => (peak == null ? "—" : pctText(Math.max(0, 100 - peak)));
  const rpmLeft = v.llm_rpm ? (p.llm == null ? `${v.llm_rpm} в мин` : `${perMin(Math.max(0, v.llm_rpm - p.llm))} в мин`) : null;
  return [
    { id: "cpu_proc", title: "Процессор процесса (одно ядро)", now: pctText(n?.cpu_proc), peak: pctText(p.cpu_proc), spare: left(p.cpu_proc), extra: null, warn: (n?.cpu_proc ?? 0) > LOAD_WARN_PCT },
    { id: "cpu_sys", title: n ? `Процессор машины (${n.cores} яд.)` : "Процессор машины", now: pctText(n?.cpu_sys), peak: pctText(p.cpu_sys), spare: left(p.cpu_sys), extra: null, warn: (n?.cpu_sys ?? 0) > LOAD_WARN_PCT },
    {
      id: "mem", title: limited ? "Память (потолок контейнера)" : "Память машины", now: pctText(n?.mem_pct), peak: pctText(p.mem_pct),
      spare: p.mem_pct == null || memBase == null ? "—" : mbText((memBase * Math.max(0, 100 - p.mem_pct)) / 100), extra: null, warn: (n?.mem_pct ?? 0) > LOAD_WARN_PCT,
    },
    { id: "rss", title: "Память процесса", now: mbText(n?.rss_mb), peak: mbText(p.rss_mb), spare: null, extra: n ? `куча ${mbText(n.heap_mb)}` : null, warn: false },
    { id: "loop", title: "Задержка цикла, p99", now: msLoad(n?.loop_p99), peak: msLoad(p.loop_p99), spare: null, extra: `наибольшая ${msLoad(p.loop_max)}`, warn: (n?.loop_p99 ?? 0) > 100 },
    { id: "http", title: "Запросы в минуту", now: perMin(n?.http), peak: perMin(p.http), spare: null, extra: `p95 ${msLoad(n?.http_p95)}`, warn: false },
    { id: "http_p95", title: "Время ответа, p95", now: msLoad(n?.http_p95), peak: msLoad(p.http_p95), spare: null, extra: `p50 ${msLoad(n?.http_p50)}`, warn: (n?.http_p95 ?? 0) > 2000 },
    { id: "http_5xx", title: "Ответы 5xx и обрывы в минуту", now: perMin(n?.http_5xx), peak: perMin(p.http_5xx), spare: null, extra: null, warn: (n?.http_5xx ?? 0) > 0 },
    { id: "llm", title: "Вызовы модели в минуту", now: perMin(n?.llm), peak: perMin(p.llm), spare: rpmLeft, extra: rpmLeft ? null : "потолок не задан", warn: false },
    { id: "queue", title: "Очередь разбора", now: perMin(n?.queue), peak: perMin(p.queue_peak), spare: null, extra: n ? `активных ${n.active}` : null, warn: false },
    {
      id: "db", title: "База", now: mbText(n?.db_mb), peak: mbText(p.db_mb),
      spare: n?.disk_free_mb == null ? null : `${mbText(n.disk_free_mb)} на диске${n.disk_total_mb ? ` (${pctText((n.disk_free_mb / n.disk_total_mb) * 100)})` : ""}`,
      extra: n?.disk_free_mb == null ? "диск не измерить" : null,
      warn: n?.disk_free_mb != null && n.disk_total_mb ? n.disk_free_mb / n.disk_total_mb < 0.1 : false,
    },
  ];
}

/** Подписи оси времени: в 1 ч и 24 ч — «чч:мм», в 7 дн — «дд.мм чч:00» (по часам того, кто смотрит). */
export function loadLabels(t: string[], range: HealthRange, tz?: string): string[] {
  const f = new Intl.DateTimeFormat("ru-RU", range === "7d"
    ? { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: tz }
    : { hour: "2-digit", minute: "2-digit", timeZone: tz });
  return t.map((x) => f.format(new Date(x)).replace(",", ""));
}

export const CAPACITY_NAMES: Record<CapacityLimit["id"], { title: string; per: (v: number | null) => string; budget: (v: number | null) => string }> = {
  cpu: { title: "Процессор", per: (v) => (v == null ? "—" : `${numText(v, v < 10 ? 1 : 0)} мс в мин`), budget: (v) => (v == null ? "—" : `${numText(v)} мс в мин`) },
  memory: { title: "Память", per: (v) => (v == null ? "—" : mbText(v)), budget: (v) => (v == null ? "—" : `${mbText(v)} свободно`) },
  model: { title: "Модель (провайдер)", per: (v) => (v == null ? "—" : `${numText(v, 2)} вызова в мин`), budget: (v) => (v == null ? "не известен" : `${numText(v)} в мин`) },
};

/** Подпись плашки под «сейчас»: «пик … · запас …» (запас — только где он посчитан) и прочее без слова «запас». */
export const tileNote = (t: LoadTile) => [`пик ${t.peak}`, t.spare != null ? `запас ${t.spare}` : null, t.extra].filter(Boolean).join(" · ");

/** Итог «Сколько выдержит»: число людей и что упрётся первым, или «мало данных». */
export function capacityHeadline(c: Capacity): { value: string; hint: string } {
  if (c.status === "few") return { value: "мало данных", hint: `минут с людьми за 7 дней: ${c.minutes} из нужных ${c.need}` };
  if (c.people == null) return { value: "не видно потолка", hint: "ни одно ограничение не посчитать — нужно больше замеров" };
  return { value: `≈ ${numText(c.people)} чел.`, hint: `одновременно активных; первым упрётся ${c.bottleneck ? CAPACITY_NAMES[c.bottleneck].title.toLowerCase() : "—"} · в час пик за 7 дн. в среднем ${numText(c.peak_active, 1)} активных` };
}
