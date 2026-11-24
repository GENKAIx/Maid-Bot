import type { AnalyticsRange, Store } from "./db.ts";
import { addDays, dayKey, timeOf, zonedToUtc } from "./time.ts";
import { HttpError } from "./api.ts";
import { quantile } from "./admin-stats.ts";
import { CHAT_FAILED } from "./pipeline.ts";
import { config } from "./config.ts";
import { ownerIds } from "./access.ts";
import { FEATURE_GROUPS, FUNCTIONS } from "./feature-list.ts";

// Аналитика, этап 1 (24.11.2026, docs/review/аналитика-макет-2026-11-24.html): GET /api/admin/analytics?report=&days=&step=.
// Семь отчётов (деньги, подписки, расход на ИИ, активность, удержание, функции, разбор) — за интервал и за прошлый той же длины,
// по корзинам «час / день / неделя». Только счётчики, суммы и номера аккаунтов (user_id): без текстов, имён, логинов, chat id,
// Telegram id, charge_id, payload и названий приложений. Деньги — по UTC, люди — по поясу каждого человека.
// «Активный» (одно определение на все отчёты): в этот день (по своему поясу) есть сообщение с ИИ или без (отметка кнопкой, push,
// правка мышью; импорт и поправки к ответам не в счёт) или минута присутствия с любого клиента (store.analyticsActiveDays).
// Ответ считается не чаще раза в ANALYTICS_CACHE_MS на сочетание отчёт × интервал × шаг (кэш в памяти процесса).

export type AnalyticsReportId = "money" | "subs" | "ai" | "act" | "ret" | "feat" | "parse";
export type AnalyticsStep = "h" | "d" | "w";
export type AnalyticsDays = 1 | 7 | 30 | 90 | 365;
export const ANALYTICS_DAYS: AnalyticsDays[] = [1, 7, 30, 90, 365];
/** cur — текущий период, prev — прошлый той же длины (для стрелки). null — «—». */
export type Pair = { cur: number | null; prev: number | null };
export type AnalyticsNote = "hour_from_calls" | "no_hourly_features" | "days_for_hours" | "latency_30d_only" | "prev_before_data";

export interface AnalyticsBucket {
  /** d: "ГГГГ-ММ-ДД"; w: первый день корзины "ГГГГ-ММ-ДД"; h: начало часа ISO UTC "2026-11-24T13:00:00.000Z". */
  key: string;
  /** d и w: дни включительно (from == to у d); h: ISO [from, to). */
  from: string; to: string;
  /** Сколько дней в корзине: d — 1, h — 1/24, w — 1..7 (первая бывает неполной). */
  days: number;
}
export interface AnalyticsMeta {
  report: AnalyticsReportId; days: AnalyticsDays; step: AnalyticsStep;
  generated_at: string; cached: boolean;
  /** Как разложены дни: "user" — по поясу человека, "utc" — деньги. */
  zone: "user" | "utc";
  /** Последний день периода (сегодня по поясу сервера или UTC — по zone). */
  today: string;
  period: { from: string; to: string };
  prev: { from: string; to: string };
  buckets: AnalyticsBucket[];
  /** Корзины прошлого периода (та же длина; ряды prev_* — по ним). */
  prev_buckets: AnalyticsBucket[];
  star_usd: number;
  since: { payments: string | null; billing_events: string | null; feature_events: string | null; gate: string | null; llm_calls: string | null; presence: string | null };
  notes: AnalyticsNote[];
}
export type AnalyticsResponse =
  | { meta: AnalyticsMeta; report: "money"; data: MoneyData }
  | { meta: AnalyticsMeta; report: "subs"; data: SubsData }
  | { meta: AnalyticsMeta; report: "ai"; data: AiData }
  | { meta: AnalyticsMeta; report: "act"; data: ActData }
  | { meta: AnalyticsMeta; report: "ret"; data: RetData }
  | { meta: AnalyticsMeta; report: "feat"; data: FeatData }
  | { meta: AnalyticsMeta; report: "parse"; data: ParseData };

export interface MoneyData {
  kpi: {
    revenue_stars: Pair;        // чистая: оплаты в периоде − возвраты в периоде
    revenue_sub_stars: Pair;    // оплаты kind first|renew (по paid_at)
    revenue_once_stars: Pair;   // оплаты kind once
    refunds_stars: Pair;        // сумма amount с refunded_at в периоде (положительное число)
    revenue_micro: Pair;        // round(revenue_stars × star_usd × 1e6)
    ai_micro: Pair;             // расход ИИ (1.6)
    margin_micro: Pair;         // revenue_micro − ai_micro
    active: Pair;               // 1.4
    payers: Pair;               // различные user_id с оплатой в периоде (возвращённые не в счёт)
    arpu_stars: Pair;           // revenue_stars / active; active=0 → null
    arppu_stars: Pair;          // revenue_stars / payers; payers=0 → null
    ltv_stars: Pair;            // всё время до конца окна: Σ(оплаты) − Σ(возвраты) / различные платившие (без полностью возвращённых); 0 платящих → null
    avg_check_stars: Pair;      // Σ amount оплат в периоде (без вычета возвратов) / число этих оплат; 0 оплат → null
    payments: Pair;             // число оплат в периоде
    ai_per_active_micro: Pair;  // ai_micro / active; active=0 → null
  };
  series: {
    sub_stars: number[]; once_stars: number[];
    refund_stars: number[];                 // положительные; рисуются ВНИЗ от нуля
    revenue_micro: number[]; ai_micro: number[];
    active: number[];
    arpu_stars: (number | null)[];          // чистые звёзды корзины / активные корзины
    ai_per_active_micro: (number | null)[]; // ai корзины / активные корзины
  };
}

export interface SubsData {
  price_stars: number;            // config.billing.price
  trial_days: number;             // config.billing.trialDays
  kpi: {
    active_subs: Pair;            // cur: plan='paid' AND access_until >= now (как planCounts). prev: на начало периода по payments: различные user_id, у которых есть оплата first|renew|once с paid_at <= T < expires_at и не возвращённая к T
    trials: Pair;                 // cur: plan='trial' AND access_until >= now AND (access_until − created_at) <= (trialDays+1) дн. (подарок /invite — не проба, см. endedOf). prev: null
    trials_ending_3d: Pair;       // те же пробы с access_until <= now+3 дн.; prev: null
    autorenew: Pair;              // plan='paid', срок жив, sub_canceled=0; prev: null
    churn_risk: Pair;             // plan='paid', срок жив, sub_canceled=1; prev: null
    trial_conversion: Pair;       // доля 0..1: оплатившие / решённые; решённых 0 → null
    trial_decided: Pair;          // в когорте пробы, у кого конец + 3 дн. <= now
    trial_pending: number;        // в когорте, у кого 3 дня ещё не прошли
    new_subs: Pair;               // payments kind first в периоде
    renewals: Pair;               // payments kind renew в периоде
    cancels: Pair;                // billing_events kind canceled в периоде (правило since)
    expired: Pair;                // billing_events kind expired в периоде (правило since)
    refunds: Pair;                // payments с refunded_at в периоде (число)
  };
  series: {
    new: number[]; renewed: number[];        // вверх
    canceled: (number | null)[];             // положительные; рисуются ВНИЗ; null — корзина раньше since billing_events
    expired: (number | null)[];              // так же, вниз
    trial_conversion: (number | null)[];     // по корзине конца пробы
  };
  /** «Кто скоро решит»: до 10 строк, ближайшие сверху. */
  soon: SubsSoonRow[];
}
export interface SubsSoonRow {
  user_id: number;
  what: "trial" | "no_renew";   // проба кончается / подписка без автопродления
  left_days: number;            // ceil((access_until − now) / сутки), не меньше 0
  days_with_us: number;         // floor((now − created_at) / сутки)
  active_days_7: number;        // различные активные дни (1.4) за 7 последних дней по его поясу
  ai_micro_30: number;          // llm_usage за 30 дней UTC
}

export type AiGroup = "parse" | "talk" | "draw" | "voice" | "background" | "other";
/** Назначения llm_usage.kind → группа (USAGE_KINDS из server/src/llm.ts). Незнакомый kind → other. */
export const AI_GROUPS: { id: AiGroup; kinds: string[] }[] = [
  { id: "parse", kinds: ["parse", "correct"] },
  { id: "talk", kinds: ["chat", "answer"] },
  { id: "draw", kinds: ["draw"] },
  { id: "voice", kinds: ["voice"] },
  { id: "background", kinds: ["summary", "patterns"] },
  { id: "other", kinds: ["other"] },
];
export interface AiData {
  source: "llm_usage" | "llm_calls";
  kpi: {
    total_micro: Pair; calls: Pair;
    unpriced_calls: Pair;              // llm_usage: calls − priced (у них цена 0 — честно показать); на h — llm_calls с micro_usd=0 и error_code=''
    forecast_month_micro: number | null; // Σ за 7 полных прошедших дней UTC / 7 × 30; не зависит от интервала
    capped_users: Pair;                // различные user_id с feature gate.day_cap > 0 в днях окна (правило since по meta.since.gate)
    capped_share: Pair;                // capped_users / active; active=0 → null
    active: Pair;
    top_user: { user_id: number; micro: number } | null; // самый дорогой за период (user_id > 0)
    subscribers: number;               // plan='paid' со живым сроком сейчас
    subscriber_avg_micro: number | null;          // средний расход ИИ подписчика за период
    subscriber_avg_revenue_micro: number | null;  // чистые звёзды подписки за период / subscribers × star_usd × 1e6
  };
  groups: { id: AiGroup; kinds: string[] }[]; // = AI_GROUPS
  series: Record<AiGroup, number[]>;          // micro по корзинам
  /** «Сколько людей тратят сколько» — ВСЕГДА за 30 дней UTC до сегодня, среди активных за эти 30 дней (с нулём — в первую полосу). */
  dist: { id: "lt5c" | "5to20c" | "20to50c" | "50cto1" | "1to3" | "gt3"; from_micro: number; to_micro: number | null; users: number; share: number | null }[];
  dist_users: number;
  /** Модели за период: доля расхода, вызовы, главное назначение, время ответа. Сортировка по micro по убыванию. */
  models: { model: string; micro: number; share: number | null; calls: number; top_kind: string; p50_ms: number | null; p95_ms: number | null; timed: number }[];
  limits: { trial_day_micro: number; paid_day_micro: number; trial_pool_day_micro: number }; // из config.billing × 1e6
}

export interface ActData {
  kpi: {
    signups: Pair;              // users.created_at в периоде (день — dayKey(created_at, users.tz); на h — по created_at)
    requests: Pair;             // messages ADMIN_AI_SQL, source<>'import' (обращения к ИИ)
    manual: Pair;               // messages ADMIN_MANUAL_SQL (отметки кнопкой, push, правки мышью — «без ИИ»)
    active: Pair;
    requests_per_active: Pair;  // requests / active
    manual_per_active: Pair;    // manual / active
    payers_share: Pair;         // (активные с оплатой XTR в периоде) / active
  };
  /** Источники сообщений с ИИ по убыванию объёма (telegram, desktop, app, iphone…), подписи — SOURCE_NAMES. */
  sources: string[];
  series: {
    signups: number[];
    requests: number[];
    requests_by_source: Record<string, number[]>;
    manual: number[];
  };
  /** 24 числа: среднее число сообщений (requests + manual) в местный час суток за день периода = всего в этот час / days. */
  hours: number[];
  /** Неделя × час: минуты присутствия, сложенные по людям, ВСЕГДА за 28 дней до сегодня (как нынешняя «Аудитория»). Строки пн…вс, столбцы 0…23. */
  heat: number[][];
  heat_days: 28;
}

export interface RetData {
  /** Цифры на «сегодня» t; prev — та же точка неделю назад (t−7), независимо от интервала (как в макете). */
  kpi: {
    dau: Pair;          // активные в день t
    wau: Pair;          // в [t−6, t]
    mau: Pair;          // в [t−29, t]
    stickiness: Pair;   // (Σ по дням [t−29,t] активных за день / 30) / mau; mau=0 → null
    gone: Pair;         // последний активный день в [t−59, t−14] (активны за 60 дней, но не за 14)
  };
  series: {
    active: number[];       // d — активные за день; h — за час; w — различные активные в 7-дневной корзине
    prev_active: number[];  // то же для prev_buckets (рисуется пунктиром по индексу)
  };
  /** Мост MAU: prev = [t−59, t−30], cur = [t−29, t]. */
  bridge: { prev_mau: number; stayed: number; left: number; new: number; returned: number; mau: number };
  /** Когорты: строка — неделя регистрации (пн-вс по поясу человека, как и недели его активности), новые снизу. */
  cohorts: { week: string; size: number; cells: ({ share: number; users: number } | null)[] }[];
  cohort_cols: number; // число столбцов Н+0…Н+(cohort_cols−1)
}

export interface FeatData {
  groups: Record<string, string>;   // FEATURE_GROUPS
  since: string | null;             // MIN(day_key) feature_events
  active: Pair;
  kpi: {
    used: Pair;          // число функций из FUNCTIONS (группы site, widget, bot, common) с uses > 0
    total: number;       // FUNCTIONS.length
    per_person: Pair;    // среднее число разных фич на человека — среди тех, у кого есть хоть одна; нет таких → null
    people: Pair;        // различные user_id с любой фичей
    unused: Pair;        // FUNCTIONS.length − used
  };
  rows: {
    id: string; title: string; group: string; by: "client" | "server";
    uses: Pair; people: Pair;
    share: Pair;                    // people / active (доля активных)
    clients: Record<string, number>; // uses.cur по клиентам
    spark: number[] | null;         // uses по корзинам; на шаге h — null
  }[];                              // сортировка по uses.cur по убыванию
  unused: string[];                 // id фич с uses.cur = 0 (за ИНТЕРВАЛ; подпись сайта — «ни разу за интервал»)
}

export type ParseKind = "tasks" | "plans" | "diary" | "habits" | "money" | "other" | "talk";
export const PARSE_KINDS: ParseKind[] = ["tasks", "plans", "diary", "habits", "money", "other", "talk"];
export interface ParseData {
  kpi: {
    requests: Pair;            // как act.requests
    undone: Pair;              // из requests: у сообщения есть actions.undone=1
    corrections: Pair;         // messages source_id LIKE 'correct:%'
    undone_share: Pair;        // undone / requests
    corrections_share: Pair;   // corrections / requests
    failed_now: number;        // adminStuckMessages(…).failed — сейчас, без интервала
    failed_retry: number;      // .failed24 — ждут повтора
    clarify_now: number;
    p50_ms: Pair; p95_ms: Pair; // llm_calls kind IN (parse, chat, answer), удачные; правило 1.6
  };
  kinds: ParseKind[];          // = PARSE_KINDS
  series: {
    requests: number[];
    kinds: Record<ParseKind, number[]>;
    err_share: (number | null)[]; // (undone + corrections) / requests корзины; requests=0 → null
  };
}

// ——— Параметры запроса

export const ANALYTICS_REPORT_IDS: AnalyticsReportId[] = ["money", "subs", "ai", "act", "ret", "feat", "parse"];
export const ANALYTICS_STEPS: AnalyticsStep[] = ["h", "d", "w"];
/** Ответ живёт столько в кэше (на сочетание отчёт × интервал × шаг). Короче опроса сайта (60 с, web/src/admin.ts
 *  ANALYTICS_REFRESH_MS) с запасом на разброс задержки сети: следующий опрос всегда получает новый подсчёт. */
export const ANALYTICS_CACHE_MS = 55_000;
export interface AnalyticsQuery { report: AnalyticsReportId; days: AnalyticsDays; step: AnalyticsStep }

/** ?report=&days=&step= → запрос; незнакомое значение или недопустимое сочетание — 400 (сайт сам выправляет шаг, как fixStep макета). */
export function parseAnalyticsQuery(url: string | undefined): AnalyticsQuery {
  const sp = new URL(url ?? "/", "http://local").searchParams;
  const report = sp.get("report") ?? "";
  if (!ANALYTICS_REPORT_IDS.includes(report as AnalyticsReportId)) throw new HttpError(400, "неизвестный отчёт аналитики");
  const rawDays = sp.get("days");
  const days = rawDays == null || rawDays === "" ? 30 : Number(rawDays);
  if (!ANALYTICS_DAYS.includes(days as AnalyticsDays)) throw new HttpError(400, "интервал — 1, 7, 30, 90 или 365 дней");
  const step = sp.get("step") || "d";
  if (!ANALYTICS_STEPS.includes(step as AnalyticsStep)) throw new HttpError(400, "шаг — час (h), день (d) или неделя (w)");
  if (step === "h" && days > 7) throw new HttpError(400, "шаг «час» — только для 24 ч и 7 дней");
  if (step === "w" && days < 30) throw new HttpError(400, "шаг «неделя» — только для 30 дней и больше");
  return { report: report as AnalyticsReportId, days: days as AnalyticsDays, step: step as AnalyticsStep };
}

// ——— Окна и корзины

const DAY = 86_400_000;
const HOUR = 3_600_000;
const iso = (t: number) => new Date(t).toISOString();
const isoDay = (t: number) => iso(t).slice(0, 10);
const dayMs = (d: string) => Date.parse(`${d}T00:00:00.000Z`);
const hourMs = (h13: string) => Date.parse(`${h13}:00:00.000Z`);
const pad = (n: number) => String(n).padStart(2, "0");
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
const div = (a: number | null, b: number | null) => (a == null || b == null || !b ? null : a / b);
const roundOrNull = (x: number | null) => (x == null ? null : Math.round(x));

/** Окно (текущий или прошлый период): корзины и границы. d/w — дни включительно (fromMs/toMs — те же дни, прочитанные как UTC);
 *  h — часы UTC [fromMs, toMs), fromDay/toDay — дни, которые окно задевает (по UTC или по поясу сервера — по zone). */
interface Win {
  step: AnalyticsStep;
  buckets: AnalyticsBucket[];
  fromDay: string; toDay: string;
  fromMs: number; toMs: number;
  dayIdx: Map<string, number>;
  /** Только у текущего окна: завтрашний день (toDay + 1) — у кого пояс впереди, местное «сегодня» уже оно; его строки (day_key
   *  по поясу человека) ложатся в последнюю корзину, а не пропадают до полуночи сервера. */
  late?: string;
}

function daysWin(endDay: string, days: number, step: "d" | "w"): Win {
  const fromDay = addDays(endDay, 1 - days);
  const buckets: AnalyticsBucket[] = [];
  if (step === "d") for (let i = 0; i < days; i++) {
    const d = addDays(fromDay, i);
    buckets.push({ key: d, from: d, to: d, days: 1 });
  } else for (let i = Math.ceil(days / 7) - 1; i >= 0; i--) {
    // Корзины по 7 дней от конца; первая (самая ранняя) обрезана началом периода.
    const to = addDays(endDay, -7 * i);
    const from = addDays(to, -6) < fromDay ? fromDay : addDays(to, -6);
    buckets.push({ key: from, from, to, days: Math.round((dayMs(to) - dayMs(from)) / DAY) + 1 }); // не daysBetween: он сдвигает месяц на 1
  }
  const dayIdx = new Map<string, number>();
  buckets.forEach((b, i) => { for (let d = b.from; d <= b.to; d = addDays(d, 1)) dayIdx.set(d, i); });
  return { step, buckets, fromDay, toDay: endDay, fromMs: dayMs(fromDay), toMs: dayMs(addDays(endDay, 1)), dayIdx };
}

function hoursWin(endMs: number, hours: number, zone: "user" | "utc"): Win {
  const fromMs = endMs - hours * HOUR;
  const buckets = Array.from({ length: hours }, (_, j) => {
    const s = fromMs + j * HOUR;
    return { key: iso(s), from: iso(s), to: iso(s + HOUR), days: 1 / 24 };
  });
  const dayOf = (t: number) => (zone === "utc" ? isoDay(t) : dayKey(new Date(t), config.defaultTimezone));
  return { step: "h", buckets, fromDay: dayOf(fromMs), toDay: dayOf(endMs - 1), fromMs, toMs: endMs, dayIdx: new Map() };
}

/** Корзина дня (d/w); на шаге h день в корзину не ложится — -1. */
const ofDay = (w: Win, day: string) => (w.step === "h" ? -1 : (w.dayIdx.get(day) ?? -1));
/** Корзина момента: h — час, d/w — день UTC. Вне окна — -1. */
function ofMs(w: Win, t: number): number {
  if (!Number.isFinite(t)) return -1;
  if (w.step !== "h") return ofDay(w, isoDay(t));
  return t >= w.fromMs && t < w.toMs ? Math.floor((t - w.fromMs) / HOUR) : -1;
}
/** Строка сообщений (день по поясу человека и час UTC «ГГГГ-ММ-ДДTЧЧ») → корзина. */
const ofRow = (w: Win, r: { day: string; hour: string }) => (w.step === "h" ? ofMs(w, hourMs(r.hour)) : ofDay(w, r.day));
const inDays = (w: Win, day: string) => (day >= w.fromDay && day <= w.toDay) || day === w.late;
/** Последний день выборки окна по day_key (с завтрашним у текущего). */
const lastDay = (w: Win) => w.late ?? w.toDay;
const zeros = (w: Win) => w.buckets.map(() => 0);
const periodOf = (w: Win) => (w.step === "h" ? { from: iso(w.fromMs), to: iso(w.toMs) } : { from: w.fromDay, to: w.toDay });

type Since = AnalyticsMeta["since"];
type AUser = Awaited<ReturnType<Store["analyticsUsers"]>>[number];

interface Ctx {
  store: Store; q: AnalyticsQuery; now: Date; nowMs: number;
  zone: "user" | "utc"; today: string;
  cur: Win; prev: Win;
  since: Since; notes: Set<AnalyticsNote>;
  users: AUser[]; tzOf: (id: number) => string;
}

const ZONES: Record<AnalyticsReportId, "user" | "utc"> = { money: "utc", subs: "utc", ai: "utc", act: "user", ret: "user", feat: "user", parse: "user" };

const pair = (c: Ctx, f: (w: Win) => number | null): Pair => ({ cur: f(c.cur), prev: f(c.prev) });
/** Сообщения за оба окна разом: дни (d/w) или часы (h). */
const msgRange = (c: Ctx): AnalyticsRange => (c.q.step === "h" ? { fromIso: iso(c.prev.fromMs), toIso: iso(c.cur.toMs) } : { fromDay: c.prev.fromDay, toDay: lastDay(c.cur) });

/** Правило since: окно начинается раньше первой записи источника (или источник пуст) — цифра этого окна null, код prev_before_data. */
function gated<T>(c: Ctx, w: Win, src: string | null, v: () => T): T | null {
  if (!src || w.fromDay < src.slice(0, 10)) {
    c.notes.add("prev_before_data");
    return null;
  }
  return v();
}
/** Время ответа — только из журнала llm_calls (30 дней): окно целиком внутри последних 30 дней. */
const latencyOk = (c: Ctx, w: Win) => w.fromMs >= c.nowMs - 30 * DAY;

// ——— Активные (1.4)

interface ActiveSets { buckets: Set<number>[]; all: Set<number> }
async function activeSets(c: Ctx): Promise<{ cur: ActiveSets; prev: ActiveSets }> {
  const mk = (w: Win): ActiveSets => ({ buckets: w.buckets.map(() => new Set<number>()), all: new Set<number>() });
  const out = { cur: mk(c.cur), prev: mk(c.prev) };
  const put = (id: number, at: (w: Win) => number) => {
    for (const [w, s] of [[c.cur, out.cur], [c.prev, out.prev]] as const) {
      const i = at(w);
      if (i < 0) continue;
      s.buckets[i].add(id);
      s.all.add(id);
    }
  };
  if (c.q.step === "h") {
    const r = await c.store.analyticsActiveHours(iso(c.prev.fromMs), iso(c.cur.toMs));
    for (const m of r.messages) put(m.user_id, (w) => ofMs(w, hourMs(m.hour)));
    // Присутствие — местные день и час человека → UTC по его поясу.
    for (const p of r.presence) {
      if (p.hour < 0 || p.hour > 23) continue;
      const t = zonedToUtc(p.day, `${pad(p.hour)}:00`, c.tzOf(p.user_id)).getTime();
      put(p.user_id, (w) => ofMs(w, t));
    }
  } else {
    for (const a of await c.store.analyticsActiveDays(c.prev.fromDay, lastDay(c.cur))) put(a.user_id, (w) => ofDay(w, a.day));
  }
  return out;
}

// ——— Расход на ИИ: d/w — дневные итоги llm_usage (UTC), h — журнал llm_calls по часу.

interface AiRow { at: string; user_id: number; kind: string; model: string; calls: number; unpriced: number; micro: number }
async function aiRows(c: Ctx): Promise<{ source: "llm_usage" | "llm_calls"; rows: AiRow[]; pos: (w: Win, r: AiRow) => number }> {
  if (c.q.step === "h") {
    c.notes.add("hour_from_calls");
    const rows = (await c.store.analyticsCalls(iso(c.prev.fromMs), iso(c.cur.toMs))).map((r) => ({
      at: r.at, user_id: r.user_id, kind: r.kind, model: r.model, calls: r.ok ? 1 : 0, unpriced: r.ok && !r.micro ? 1 : 0, micro: r.micro,
    }));
    return { source: "llm_calls", rows, pos: (w, r) => ofMs(w, Date.parse(r.at)) };
  }
  const rows = (await c.store.analyticsUsage(c.prev.fromDay, c.cur.toDay)).map((r) => ({
    at: r.day, user_id: r.user_id, kind: r.kind, model: r.model, calls: r.calls, unpriced: Math.max(0, r.calls - r.priced), micro: r.micro,
  }));
  return { source: "llm_usage", rows, pos: (w, r) => ofDay(w, r.at) };
}
/** Окно расхода доступно: llm_usage — всегда; llm_calls — по правилу since. */
const aiOk = (c: Ctx, w: Win) => c.q.step !== "h" || gated(c, w, c.since.llm_calls, () => true) === true;

// ——— Оплаты

type APay = Awaited<ReturnType<Store["analyticsPayments"]>>[number];
const SUB_KINDS = ["first", "renew"];
const isPaid = (p: APay) => SUB_KINDS.includes(p.kind) || p.kind === "once";

function payStats(w: Win, pays: APay[]) {
  const sub = zeros(w), once = zeros(w), refund = zeros(w), subRefund = zeros(w);
  let count = 0, paidSum = 0, newSubs = 0, renewals = 0, refunds = 0;
  const payers = new Set<number>(), anyPayers = new Set<number>();
  for (const p of pays) {
    if (!isPaid(p)) continue;
    const i = ofMs(w, Date.parse(p.paid_at));
    if (i >= 0) {
      (p.kind === "once" ? once : sub)[i] += p.amount;
      count++;
      paidSum += p.amount;
      if (p.kind === "first") newSubs++;
      if (p.kind === "renew") renewals++;
      anyPayers.add(p.user_id);
      if (!p.refunded_at || Date.parse(p.refunded_at) >= w.toMs) payers.add(p.user_id);
    }
    if (p.refunded_at) {
      const j = ofMs(w, Date.parse(p.refunded_at));
      if (j >= 0) {
        refund[j] += p.amount;
        if (p.kind !== "once") subRefund[j] += p.amount;
        refunds++;
      }
    }
  }
  const net = sub.map((s, i) => s + once[i] - refund[i]);
  return { sub, once, refund, subRefund, net, count, paidSum, payers, anyPayers, newSubs, renewals, refunds };
}

/** LTV до конца окна: (Σ оплат − Σ возвратов) / различные платившие без полностью возвращённых; 0 платящих — null. */
function ltv(w: Win, pays: APay[]): number | null {
  let total = 0;
  const who = new Set<number>();
  for (const p of pays) {
    if (!isPaid(p)) continue;
    if (Date.parse(p.paid_at) < w.toMs) {
      total += p.amount;
      if (!p.refunded_at || Date.parse(p.refunded_at) >= w.toMs) who.add(p.user_id);
    }
    if (p.refunded_at && Date.parse(p.refunded_at) < w.toMs) total -= p.amount;
  }
  return who.size ? total / who.size : null;
}

const starMicro = (stars: number | null) => (stars == null ? null : Math.round(stars * config.billing.starUsd * 1e6));

// ——— Отчёты

async function moneyReport(c: Ctx): Promise<MoneyData> {
  const pays = await c.store.analyticsPayments(iso(c.cur.toMs));
  const act = await activeSets(c);
  const ai = await aiRows(c);
  const st = { cur: payStats(c.cur, pays), prev: payStats(c.prev, pays) };
  const S = (w: Win) => (w === c.cur ? st.cur : st.prev);
  const A = (w: Win) => (w === c.cur ? act.cur : act.prev);
  const aiSeries = (w: Win) => {
    const out = zeros(w);
    for (const r of ai.rows) { const i = ai.pos(w, r); if (i >= 0) out[i] += r.micro; }
    return out;
  };
  const aiB = { cur: aiSeries(c.cur), prev: aiSeries(c.prev) };
  const B = (w: Win) => (w === c.cur ? aiB.cur : aiB.prev);
  const aiTotal = (w: Win) => (aiOk(c, w) ? sum(B(w)) : null);
  const revenue = (w: Win) => sum(S(w).net);
  const revMicro = (w: Win) => starMicro(revenue(w));
  const activeN = (w: Win) => A(w).all.size;
  const cur = st.cur;
  const activeB = act.cur.buckets.map((s) => s.size);
  return {
    kpi: {
      revenue_stars: pair(c, revenue),
      revenue_sub_stars: pair(c, (w) => sum(S(w).sub)),
      revenue_once_stars: pair(c, (w) => sum(S(w).once)),
      refunds_stars: pair(c, (w) => sum(S(w).refund)),
      revenue_micro: pair(c, revMicro),
      ai_micro: pair(c, aiTotal),
      margin_micro: pair(c, (w) => { const a = aiTotal(w); return a == null ? null : revMicro(w)! - a; }),
      active: pair(c, activeN),
      payers: pair(c, (w) => S(w).payers.size),
      arpu_stars: pair(c, (w) => div(revenue(w), activeN(w))),
      arppu_stars: pair(c, (w) => div(revenue(w), S(w).payers.size)),
      ltv_stars: pair(c, (w) => ltv(w, pays)),
      avg_check_stars: pair(c, (w) => div(S(w).paidSum, S(w).count)),
      payments: pair(c, (w) => S(w).count),
      ai_per_active_micro: pair(c, (w) => roundOrNull(div(aiTotal(w), activeN(w)))),
    },
    series: {
      sub_stars: cur.sub, once_stars: cur.once, refund_stars: cur.refund,
      revenue_micro: cur.net.map((x) => starMicro(x)!),
      ai_micro: aiB.cur,
      active: activeB,
      arpu_stars: cur.net.map((x, i) => div(x, activeB[i])),
      ai_per_active_micro: aiB.cur.map((x, i) => roundOrNull(div(x, activeB[i]))),
    },
  };
}

/** Проба по пробной неделе, не подарок /invite (access.ts endedOf): от создания записи до конца — не дольше trialDays + 1 дня. */
const isTrialSpan = (u: AUser) => {
  const made = Date.parse(u.created_at), until = Date.parse(u.access_until ?? "");
  return Number.isFinite(made) && Number.isFinite(until) && until - made <= (config.billing.trialDays + 1) * DAY;
};

async function subsReport(c: Ctx): Promise<SubsData> {
  const nowIso = c.now.toISOString();
  const pays = await c.store.analyticsPayments(iso(Math.max(c.cur.toMs, c.nowMs + 1)));
  const st = { cur: payStats(c.cur, pays), prev: payStats(c.prev, pays) };
  const S = (w: Win) => (w === c.cur ? st.cur : st.prev);
  const live = (u: AUser) => u.access_until != null && u.access_until >= nowIso;
  const paid = c.users.filter((u) => u.plan === "paid" && live(u));
  const trials = c.users.filter((u) => u.plan === "trial" && live(u) && isTrialSpan(u));
  const in3 = iso(c.nowMs + 3 * DAY);
  // Подписчики на момент T по оплатам: оплата идёт с paid_at до expires_at и к T не возвращена.
  const subsAt = (t: number) => new Set(pays.filter((p) => isPaid(p) && Date.parse(p.paid_at) <= t && p.expires_at != null && t < Date.parse(p.expires_at)
    && (!p.refunded_at || Date.parse(p.refunded_at) > t)).map((p) => p.user_id)).size;
  // Когорта пробы: не друзья и не владельцы, конец пробы (создание + trialDays) — в окне; оплатил — невозвращённая оплата
  // с создания записи до конца пробы + 3 дня; решено — эти 3 дня прошли. Подарок /invite — не проба: не берём, у кого в журнале
  // есть gift (и кто принял приглашение посреди пробы), и тех, у кого без единой оплаты срок длиннее пробы (как isTrialSpan).
  const gifted = new Set((await c.store.billingEvents(iso(0), iso(c.nowMs + DAY))).filter((e) => e.kind === "gift").map((e) => e.user_id));
  const payersEver = new Set(pays.filter(isPaid).map((p) => p.user_id));
  const onTrial = (u: AUser) => !gifted.has(u.id) && (payersEver.has(u.id) || isTrialSpan(u));
  const cohort = c.users.filter((u) => u.plan !== "friend" && !u.owner && Number.isFinite(Date.parse(u.created_at)) && onTrial(u)).map((u) => {
    const made = Date.parse(u.created_at), end = made + config.billing.trialDays * DAY;
    const paidIt = pays.some((p) => p.user_id === u.id && !p.refunded_at && Date.parse(p.paid_at) >= made && Date.parse(p.paid_at) <= end + 3 * DAY);
    return { end, decided: end + 3 * DAY <= c.nowMs, paid: paidIt };
  });
  const conv = (w: Win) => {
    const dec = w.buckets.map(() => 0), ok = w.buckets.map(() => 0);
    let pending = 0;
    for (const x of cohort) {
      const i = ofMs(w, x.end);
      if (i < 0) continue;
      if (!x.decided) { pending++; continue; }
      dec[i]++;
      if (x.paid) ok[i]++;
    }
    return { dec, ok, pending };
  };
  const cv = { cur: conv(c.cur), prev: conv(c.prev) };
  const CV = (w: Win) => (w === c.cur ? cv.cur : cv.prev);
  // Отмены и концы подписки — журнал подписки (с 24.11.2026): окно раньше начала записи — null. expired — только подписка
  // (конец пробы и подарка — trial_ended и gift_ended, они в «Конверсии пробы»).
  const ev = await c.store.billingEvents(iso(c.prev.fromMs), iso(c.cur.toMs));
  const evCount = (w: Win, kind: string) => {
    const out = zeros(w);
    for (const e of ev) if (e.kind === kind) { const i = ofMs(w, Date.parse(e.at)); if (i >= 0) out[i]++; }
    return out;
  };
  const evSeries = (kind: string) => {
    const xs = evCount(c.cur, kind), since = c.since.billing_events;
    return c.cur.buckets.map((b, i) => (since && b.from.slice(0, 10) >= since.slice(0, 10) ? xs[i] : null));
  };
  // «Кто скоро решит»: пробы и подписки без автопродления, кончаются за 7 дней.
  const week = iso(c.nowMs + 7 * DAY);
  const soonUsers = [
    ...trials.filter((u) => u.access_until! <= week).map((u) => ({ u, what: "trial" as const })),
    ...paid.filter((u) => u.sub_canceled === 1 && u.access_until! <= week).map((u) => ({ u, what: "no_renew" as const })),
  ].sort((a, b) => a.u.access_until!.localeCompare(b.u.access_until!)).slice(0, 10);
  let soon: SubsSoonRow[] = [];
  if (soonUsers.length) {
    const utc = isoDay(c.nowMs);
    const act = await c.store.analyticsActiveDays(addDays(utc, -8), addDays(utc, 1));
    const spend = new Map<number, number>();
    for (const r of await c.store.analyticsUsage(addDays(utc, -29), utc)) spend.set(r.user_id, (spend.get(r.user_id) ?? 0) + r.micro);
    soon = soonUsers.map(({ u, what }) => {
      const t = dayKey(c.now, c.tzOf(u.id)), from = addDays(t, -6);
      return {
        user_id: u.id, what,
        left_days: Math.max(0, Math.ceil((Date.parse(u.access_until!) - c.nowMs) / DAY)),
        days_with_us: Math.max(0, Math.floor((c.nowMs - Date.parse(u.created_at)) / DAY)),
        active_days_7: new Set(act.filter((a) => a.user_id === u.id && a.day >= from && a.day <= t).map((a) => a.day)).size,
        ai_micro_30: spend.get(u.id) ?? 0,
      };
    });
  }
  return {
    price_stars: config.billing.price,
    trial_days: config.billing.trialDays,
    kpi: {
      active_subs: { cur: paid.length, prev: subsAt(c.cur.fromMs) },
      trials: { cur: trials.length, prev: null },
      trials_ending_3d: { cur: trials.filter((u) => u.access_until! <= in3).length, prev: null },
      autorenew: { cur: paid.filter((u) => u.sub_canceled !== 1).length, prev: null },
      churn_risk: { cur: paid.filter((u) => u.sub_canceled === 1).length, prev: null },
      trial_conversion: pair(c, (w) => div(sum(CV(w).ok), sum(CV(w).dec))),
      trial_decided: pair(c, (w) => sum(CV(w).dec)),
      trial_pending: cv.cur.pending,
      new_subs: pair(c, (w) => S(w).newSubs),
      renewals: pair(c, (w) => S(w).renewals),
      cancels: pair(c, (w) => gated(c, w, c.since.billing_events, () => sum(evCount(w, "canceled")))),
      expired: pair(c, (w) => gated(c, w, c.since.billing_events, () => sum(evCount(w, "expired")))),
      refunds: pair(c, (w) => S(w).refunds),
    },
    series: {
      new: countKind(c.cur, pays, "first"),
      renewed: countKind(c.cur, pays, "renew"),
      canceled: evSeries("canceled"),
      expired: evSeries("expired"),
      trial_conversion: cv.cur.ok.map((x, i) => div(x, cv.cur.dec[i])),
    },
    soon,
  };
}

function countKind(w: Win, pays: APay[], kind: string) {
  const out = zeros(w);
  for (const p of pays) if (p.kind === kind) { const i = ofMs(w, Date.parse(p.paid_at)); if (i >= 0) out[i]++; }
  return out;
}

const groupOf = (kind: string): AiGroup => AI_GROUPS.find((g) => g.kinds.includes(kind))?.id ?? "other";
const DIST: { id: AiData["dist"][number]["id"]; from: number; to: number | null }[] = [
  { id: "lt5c", from: 0, to: 50_000 }, { id: "5to20c", from: 50_000, to: 200_000 }, { id: "20to50c", from: 200_000, to: 500_000 },
  { id: "50cto1", from: 500_000, to: 1_000_000 }, { id: "1to3", from: 1_000_000, to: 3_000_000 }, { id: "gt3", from: 3_000_000, to: null },
];

async function aiReport(c: Ctx): Promise<AiData> {
  const ai = await aiRows(c);
  const act = await activeSets(c);
  const A = (w: Win) => (w === c.cur ? act.cur : act.prev);
  const inWin = (w: Win) => ai.rows.filter((r) => ai.pos(w, r) >= 0);
  const curRows = inWin(c.cur), prevRows = inWin(c.prev);
  const R = (w: Win) => (w === c.cur ? curRows : prevRows);
  const tot = (w: Win, f: (r: AiRow) => number) => (aiOk(c, w) ? R(w).reduce((s, r) => s + f(r), 0) : null);
  // Упёрлись в свой дневной потолок: счётчик gate.day_cap (с 24.11.2026) за дни окна.
  if (c.q.step === "h") c.notes.add("days_for_hours");
  const caps = new Map<Win, number>();
  for (const w of [c.cur, c.prev]) caps.set(w, (await c.store.analyticsFeatureUsers(w.fromDay, lastDay(w), ["gate.day_cap"])).length);
  const capped = (w: Win) => gated(c, w, c.since.gate, () => caps.get(w)!);
  // Самый дорогой за период.
  const byUser = new Map<number, number>();
  for (const r of curRows) if (r.user_id > 0) byUser.set(r.user_id, (byUser.get(r.user_id) ?? 0) + r.micro);
  let top: { user_id: number; micro: number } | null = null;
  for (const [user_id, micro] of byUser) if (micro > 0 && (!top || micro > top.micro || (micro === top.micro && user_id < top.user_id))) top = { user_id, micro };
  // Подписчики сейчас: средний расход за период и средняя чистая выручка подписки за период.
  const nowIso = c.now.toISOString();
  const subs = new Set(c.users.filter((u) => u.plan === "paid" && u.access_until != null && u.access_until >= nowIso).map((u) => u.id));
  const subSpend = curRows.filter((r) => subs.has(r.user_id)).reduce((s, r) => s + r.micro, 0);
  const pays = await c.store.analyticsPayments(iso(c.cur.toMs));
  const ps = payStats(c.cur, pays);
  const subNet = sum(ps.sub) - sum(ps.subRefund);
  // Прогноз месяца: 7 полных прошедших дней UTC.
  const utc = isoDay(c.nowMs);
  const last7 = await c.store.analyticsUsage(addDays(utc, -7), addDays(utc, -1));
  // Распределение — всегда за 30 дней UTC до сегодня, среди активных за эти дни.
  const usage30 = await c.store.analyticsUsage(addDays(utc, -29), utc);
  const spent30 = new Map<number, number>();
  for (const r of usage30) spent30.set(r.user_id, (spent30.get(r.user_id) ?? 0) + r.micro);
  const active30 = new Set((await c.store.analyticsActiveDays(addDays(utc, -29), addDays(utc, 1))).map((a) => a.user_id));
  const dist = DIST.map((d) => ({ id: d.id, from_micro: d.from, to_micro: d.to, users: 0, share: null as number | null }));
  for (const id of active30) {
    const m = spent30.get(id) ?? 0;
    const k = DIST.findIndex((d) => m >= d.from && (d.to == null || m < d.to));
    dist[k < 0 ? 0 : k].users++;
  }
  for (const d of dist) d.share = div(d.users, active30.size);
  // Модели за период; время ответа — по журналу llm_calls (30 дней), удачные попытки.
  const models = new Map<string, { micro: number; calls: number; kinds: Map<string, { micro: number; calls: number }> }>();
  for (const r of curRows) {
    const m = models.get(r.model) ?? models.set(r.model, { micro: 0, calls: 0, kinds: new Map() }).get(r.model)!;
    m.micro += r.micro;
    m.calls += r.calls;
    const k = m.kinds.get(r.kind) ?? m.kinds.set(r.kind, { micro: 0, calls: 0 }).get(r.kind)!;
    k.micro += r.micro;
    k.calls += r.calls;
  }
  const timesOk = latencyOk(c, c.cur) && gated(c, c.cur, c.since.llm_calls, () => true) === true;
  if (!latencyOk(c, c.cur)) c.notes.add("latency_30d_only");
  const times = new Map<string, number[]>();
  if (timesOk) for (const r of await c.store.analyticsCalls(iso(c.cur.fromMs), iso(c.cur.toMs))) if (r.ok) (times.get(r.model) ?? times.set(r.model, []).get(r.model)!).push(r.ms);
  const totalCur = curRows.reduce((s, r) => s + r.micro, 0);
  const series = Object.fromEntries(AI_GROUPS.map((g) => [g.id, zeros(c.cur)])) as Record<AiGroup, number[]>;
  for (const r of curRows) series[groupOf(r.kind)][ai.pos(c.cur, r)] += r.micro;
  return {
    source: ai.source,
    kpi: {
      total_micro: pair(c, (w) => tot(w, (r) => r.micro)),
      calls: pair(c, (w) => tot(w, (r) => r.calls)),
      unpriced_calls: pair(c, (w) => tot(w, (r) => r.unpriced)),
      forecast_month_micro: Math.round(last7.reduce((s, r) => s + r.micro, 0) / 7 * 30),
      capped_users: pair(c, capped),
      capped_share: pair(c, (w) => div(capped(w), A(w).all.size)),
      active: pair(c, (w) => A(w).all.size),
      top_user: top,
      subscribers: subs.size,
      subscriber_avg_micro: roundOrNull(div(subSpend, subs.size)),
      subscriber_avg_revenue_micro: roundOrNull(div(starMicro(subNet), subs.size)),
    },
    groups: AI_GROUPS,
    series,
    dist,
    dist_users: active30.size,
    models: [...models].map(([model, m]) => {
      const top_kind = [...m.kinds].sort((a, b) => b[1].micro - a[1].micro || b[1].calls - a[1].calls || a[0].localeCompare(b[0]))[0]?.[0] ?? "";
      const t = [...(times.get(model) ?? [])].sort((a, b) => a - b);
      return {
        model, micro: m.micro, share: div(m.micro, totalCur), calls: m.calls, top_kind,
        p50_ms: timesOk ? quantile(t, 0.5) : null, p95_ms: timesOk ? quantile(t, 0.95) : null, timed: timesOk ? t.length : 0,
      };
    }).sort((a, b) => b.micro - a.micro || b.calls - a.calls || a.model.localeCompare(b.model)),
    limits: {
      trial_day_micro: Math.round(config.billing.trialDayUsd * 1e6),
      paid_day_micro: Math.round(config.billing.paidDayUsd * 1e6),
      trial_pool_day_micro: Math.round(config.billing.trialPoolDayUsd * 1e6),
    },
  };
}

/** Карта «день недели × час» за 28 дней до сегодня: минуты присутствия, сложенные по людям (как adminAudience). */
async function heat28(c: Ctx): Promise<number[][]> {
  const heat = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  for (const r of await c.store.adminPresenceHeat(addDays(c.today, -27))) {
    if (r.hour < 0 || r.hour > 23 || r.day > c.today) continue;
    heat[(new Date(`${r.day}T00:00:00Z`).getUTCDay() + 6) % 7][r.hour] += r.minutes;
  }
  return heat;
}

async function actReport(c: Ctx): Promise<ActData> {
  const rows = await c.store.analyticsMessages(msgRange(c));
  const act = await activeSets(c);
  const A = (w: Win) => (w === c.cur ? act.cur : act.prev);
  const pays = await c.store.analyticsPayments(iso(c.cur.toMs));
  const ps = { cur: payStats(c.cur, pays), prev: payStats(c.prev, pays) };
  const counts = (w: Win) => {
    const requests = zeros(w), manual = zeros(w);
    const bySource = new Map<string, number[]>();
    for (const r of rows) {
      const i = ofRow(w, r);
      if (i < 0) continue;
      requests[i] += r.ai;
      manual[i] += r.manual;
      if (r.ai) (bySource.get(r.source) ?? bySource.set(r.source, zeros(w)).get(r.source)!)[i] += r.ai;
    }
    // Регистрации: день — по поясу человека (на шаге h — момент).
    const signups = zeros(w);
    for (const u of c.users) {
      const t = Date.parse(u.created_at);
      if (!Number.isFinite(t)) continue;
      const i = w.step === "h" ? ofMs(w, t) : ofDay(w, dayKey(new Date(t), c.tzOf(u.id)));
      if (i >= 0) signups[i]++;
    }
    return { requests, manual, bySource, signups };
  };
  const k = { cur: counts(c.cur), prev: counts(c.prev) };
  const K = (w: Win) => (w === c.cur ? k.cur : k.prev);
  const activeN = (w: Win) => A(w).all.size;
  const payersShare = (w: Win) => {
    const p = (w === c.cur ? ps.cur : ps.prev).anyPayers;
    return div([...A(w).all].filter((id) => p.has(id)).length, activeN(w));
  };
  const total = (m: Map<string, number[]>, s: string) => sum(m.get(s) ?? []);
  const sources = [...new Set([...k.cur.bySource.keys(), ...k.prev.bySource.keys()])]
    .sort((a, b) => total(k.cur.bySource, b) - total(k.cur.bySource, a) || total(k.prev.bySource, b) - total(k.prev.bySource, a) || a.localeCompare(b));
  // Часы суток — местный час человека (сообщения сведены по часу UTC; у поясов со сдвигом не на целый час — по началу часа).
  const hours = Array<number>(24).fill(0);
  for (const r of rows) {
    if (ofRow(c.cur, r) < 0) continue;
    const h = Number(timeOf(new Date(hourMs(r.hour)), c.tzOf(r.user_id)).slice(0, 2));
    if (h >= 0 && h < 24) hours[h] += r.ai + r.manual;
  }
  return {
    kpi: {
      signups: pair(c, (w) => sum(K(w).signups)),
      requests: pair(c, (w) => sum(K(w).requests)),
      manual: pair(c, (w) => sum(K(w).manual)),
      active: pair(c, activeN),
      requests_per_active: pair(c, (w) => div(sum(K(w).requests), activeN(w))),
      manual_per_active: pair(c, (w) => div(sum(K(w).manual), activeN(w))),
      payers_share: pair(c, payersShare),
    },
    sources,
    series: {
      signups: k.cur.signups,
      requests: k.cur.requests,
      requests_by_source: Object.fromEntries(sources.map((s) => [s, k.cur.bySource.get(s) ?? zeros(c.cur)])),
      manual: k.cur.manual,
    },
    hours: hours.map((x) => x / c.q.days),
    heat: await heat28(c),
    heat_days: 28,
  };
}

/** Неделя (пн) дня — как adminAudience. */
const weekOf = (day: string) => addDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7));

async function retReport(c: Ctx): Promise<RetData> {
  const t = c.today;
  const R = Math.min(52, Math.max(8, Math.ceil(c.q.days / 7)));
  const cols = Math.min(13, R);
  const thisWeek = weekOf(t);
  const firstWeek = addDays(thisWeek, -7 * (R - 1));
  const from = [addDays(t, -66), firstWeek].sort()[0];
  // Завтрашний day_key (пояс впереди сервера) — это «сегодня» того человека: считаем сегодняшним.
  const rows = (await c.store.analyticsActiveDays(from, addDays(t, 1))).map((a) => (a.day > t ? { ...a, day: t } : a));
  const byDay = new Map<string, Set<number>>();
  for (const a of rows) (byDay.get(a.day) ?? byDay.set(a.day, new Set()).get(a.day)!).add(a.user_id);
  const within = (end: string, len: number) => {
    const s = new Set<number>();
    for (let i = 0; i < len; i++) for (const id of byDay.get(addDays(end, -i)) ?? []) s.add(id);
    return s;
  };
  const at = (d: string) => {
    const mau = within(d, 30).size;
    let dauSum = 0;
    for (let i = 0; i < 30; i++) dauSum += byDay.get(addDays(d, -i))?.size ?? 0;
    // Пропали: последний активный день (не позже d) — в [d−59, d−14].
    const last = new Map<number, string>();
    for (const a of rows) if (a.day <= d && (!last.has(a.user_id) || a.day > last.get(a.user_id)!)) last.set(a.user_id, a.day);
    const gone = [...last.values()].filter((x) => x >= addDays(d, -59) && x <= addDays(d, -14)).length;
    return { dau: byDay.get(d)?.size ?? 0, wau: within(d, 7).size, mau, stickiness: div(dauSum / 30, mau), gone };
  };
  const now = at(t), week = at(addDays(t, -7));
  const P = (k: keyof typeof now): Pair => ({ cur: now[k], prev: week[k] });
  // Мост MAU: прошлые 30 дней [t−59, t−30] против нынешних [t−29, t].
  const curSet = within(t, 30), prevSet = within(addDays(t, -30), 30);
  const created = new Map(c.users.map((u) => [u.id, Number.isFinite(Date.parse(u.created_at)) ? dayKey(new Date(u.created_at), c.tzOf(u.id)) : ""]));
  let stayed = 0, fresh = 0, returned = 0;
  for (const id of curSet) {
    if (prevSet.has(id)) stayed++;
    else if ((created.get(id) ?? "") >= addDays(t, -29)) fresh++;
    else returned++;
  }
  const left = [...prevSet].filter((id) => !curSet.has(id)).length;
  // Когорты: неделя регистрации — по поясу человека, как и недели его активности (day_key); доля активных хоть раз в k-ю неделю после неё.
  const weeks = new Map<number, Set<string>>();
  for (const a of rows) (weeks.get(a.user_id) ?? weeks.set(a.user_id, new Set()).get(a.user_id)!).add(weekOf(a.day));
  const cohorts = Array.from({ length: R }, (_, i) => {
    const wk = addDays(firstWeek, 7 * i);
    const members = c.users.filter((u) => { const d = created.get(u.id); return !!d && weekOf(d > t ? t : d) === wk; });
    const cells = Array.from({ length: cols }, (_, k) => {
      const w = addDays(wk, 7 * k);
      if (!members.length || w > thisWeek) return null;
      const users = members.filter((u) => weeks.get(u.id)?.has(w)).length;
      return { share: users / members.length, users };
    });
    return { week: wk, size: members.length, cells };
  });
  const act = await activeSets(c);
  return {
    kpi: { dau: P("dau"), wau: P("wau"), mau: P("mau"), stickiness: P("stickiness"), gone: P("gone") },
    series: { active: act.cur.buckets.map((s) => s.size), prev_active: act.prev.buckets.map((s) => s.size) },
    bridge: { prev_mau: prevSet.size, stayed, left, new: fresh, returned, mau: curSet.size },
    cohorts,
    cohort_cols: cols,
  };
}

async function featReport(c: Ctx): Promise<FeatData> {
  if (c.q.step === "h") { c.notes.add("no_hourly_features"); c.notes.add("days_for_hours"); }
  // Только функции (FUNCTIONS): отказы ИИ, экскурсия и реакции Рины — свои отчёты. Счётчики сведены в SQL: раз — по фиче × клиенту ×
  // дню за оба окна, люди — пары фича × человек на каждое окно.
  const ids = FUNCTIONS.map((f) => f.id);
  const sums = await c.store.analyticsFeatureSums(c.prev.fromDay, lastDay(c.cur), ids);
  const who = new Map<Win, { feature: string; user_id: number }[]>();
  for (const w of [c.cur, c.prev]) who.set(w, await c.store.analyticsFeatureUsers(w.fromDay, lastDay(w), ids));
  const act = await activeSets(c);
  const A = (w: Win) => (w === c.cur ? act.cur : act.prev);
  const stats = (w: Win) => {
    const uses = new Map<string, number>(), people = new Map<string, number>(), perUser = new Map<number, number>();
    const clients = new Map<string, Record<string, number>>(), spark = new Map<string, number[]>();
    for (const r of sums) {
      if (!inDays(w, r.day)) continue;
      uses.set(r.feature, (uses.get(r.feature) ?? 0) + r.uses);
      const cl = clients.get(r.feature) ?? clients.set(r.feature, {}).get(r.feature)!;
      cl[r.client] = (cl[r.client] ?? 0) + r.uses;
      const i = ofDay(w, r.day);
      if (i >= 0) (spark.get(r.feature) ?? spark.set(r.feature, zeros(w)).get(r.feature)!)[i] += r.uses;
    }
    for (const p of who.get(w)!) {
      people.set(p.feature, (people.get(p.feature) ?? 0) + 1);
      perUser.set(p.user_id, (perUser.get(p.user_id) ?? 0) + 1);
    }
    const used = FUNCTIONS.filter((f) => (uses.get(f.id) ?? 0) > 0).length;
    return { uses, people, perUser, clients, spark, used };
  };
  const s = { cur: stats(c.cur), prev: stats(c.prev) };
  const S = (w: Win) => (w === c.cur ? s.cur : s.prev);
  const fe = c.since.feature_events;
  const g = (w: Win, v: () => number | null) => gated(c, w, fe, v);
  const out = FUNCTIONS.map((f) => {
    const uses = pair(c, (w) => g(w, () => S(w).uses.get(f.id) ?? 0));
    const people = pair(c, (w) => g(w, () => S(w).people.get(f.id) ?? 0));
    return {
      id: f.id, title: f.title, group: f.group, by: f.by, uses, people,
      share: { cur: div(people.cur, A(c.cur).all.size), prev: div(people.prev, A(c.prev).all.size) },
      clients: s.cur.clients.get(f.id) ?? {},
      spark: c.q.step === "h" ? null : (s.cur.spark.get(f.id) ?? zeros(c.cur)),
    };
  }).sort((a, b) => (b.uses.cur ?? -1) - (a.uses.cur ?? -1) || a.title.localeCompare(b.title));
  return {
    groups: FEATURE_GROUPS,
    since: fe,
    active: pair(c, (w) => A(w).all.size),
    kpi: {
      used: pair(c, (w) => g(w, () => S(w).used)),
      total: FUNCTIONS.length,
      per_person: pair(c, (w) => g(w, () => div(sum([...S(w).perUser.values()]), S(w).perUser.size))),
      people: pair(c, (w) => g(w, () => S(w).perUser.size)),
      unused: pair(c, (w) => g(w, () => FUNCTIONS.length - S(w).used)),
    },
    rows: out,
    unused: out.filter((r) => r.uses.cur === 0).map((r) => r.id),
  };
}

async function parseReport(c: Ctx): Promise<ParseData> {
  const rows = await c.store.analyticsMessages(msgRange(c));
  const kinds = await c.store.analyticsParseKinds(msgRange(c));
  const counts = (w: Win) => {
    const requests = zeros(w), undone = zeros(w), corrections = zeros(w);
    for (const r of rows) {
      const i = ofRow(w, r);
      if (i < 0) continue;
      requests[i] += r.ai;
      undone[i] += r.undone;
      corrections[i] += r.corrections;
    }
    return { requests, undone, corrections };
  };
  const k = { cur: counts(c.cur), prev: counts(c.prev) };
  const K = (w: Win) => (w === c.cur ? k.cur : k.prev);
  const byKind = Object.fromEntries(PARSE_KINDS.map((x) => [x, zeros(c.cur)])) as Record<ParseKind, number[]>;
  for (const r of kinds) {
    const i = ofRow(c.cur, r);
    if (i >= 0 && r.kind in byKind) byKind[r.kind as ParseKind][i] += r.n;
  }
  // Время ответа разбора и разговора — журнал llm_calls (30 дней), удачные попытки.
  const lat = new Map<Win, number[] | null>();
  for (const w of [c.cur, c.prev]) {
    if (!latencyOk(c, w)) { c.notes.add("latency_30d_only"); lat.set(w, null); continue; }
    if (gated(c, w, c.since.llm_calls, () => true) !== true) { lat.set(w, null); continue; }
    lat.set(w, (await c.store.analyticsCalls(iso(w.fromMs), iso(w.toMs))).filter((r) => r.ok && ["parse", "chat", "answer"].includes(r.kind)).map((r) => r.ms).sort((a, b) => a - b));
  }
  const q = (w: Win, p: number) => { const xs = lat.get(w); return xs ? quantile(xs, p) : null; };
  const stuck = await c.store.adminStuckMessages(iso(c.nowMs - DAY), CHAT_FAILED);
  const err = k.cur.requests.map((n, i) => div(k.cur.undone[i] + k.cur.corrections[i], n));
  return {
    kpi: {
      requests: pair(c, (w) => sum(K(w).requests)),
      undone: pair(c, (w) => sum(K(w).undone)),
      corrections: pair(c, (w) => sum(K(w).corrections)),
      undone_share: pair(c, (w) => div(sum(K(w).undone), sum(K(w).requests))),
      corrections_share: pair(c, (w) => div(sum(K(w).corrections), sum(K(w).requests))),
      failed_now: stuck.failed,
      failed_retry: stuck.failed24,
      clarify_now: stuck.clarify,
      p50_ms: pair(c, (w) => q(w, 0.5)),
      p95_ms: pair(c, (w) => q(w, 0.95)),
    },
    kinds: PARSE_KINDS,
    series: { requests: k.cur.requests, kinds: byKind, err_share: err },
  };
}

// ——— Сборка ответа и кэш

/** Посчитать отчёт сейчас (без кэша). */
export async function analyticsReport(store: Store, q: AnalyticsQuery, now = new Date()): Promise<AnalyticsResponse> {
  const zone = ZONES[q.report];
  const nowMs = now.getTime();
  const today = zone === "utc" ? isoDay(nowMs) : dayKey(now, config.defaultTimezone);
  let cur: Win, prev: Win;
  if (q.step === "h") {
    const end = Math.floor(nowMs / HOUR) * HOUR + HOUR; // текущий неполный час — последняя корзина
    cur = hoursWin(end, 24 * q.days, zone);
    prev = hoursWin(end - 24 * q.days * HOUR, 24 * q.days, zone);
  } else {
    cur = daysWin(today, q.days, q.step);
    prev = daysWin(addDays(today, -q.days), q.days, q.step);
  }
  cur.late = addDays(cur.toDay, 1);
  if (q.step !== "h") cur.dayIdx.set(cur.late, cur.buckets.length - 1);
  const raw = await store.analyticsSince();
  const day = (v: string | null) => (v == null ? null : v.slice(0, 10));
  const since: Since = {
    payments: day(raw.payments), billing_events: day(raw.billing_events), feature_events: day(raw.feature_events),
    gate: day(raw.gate), llm_calls: day(raw.llm_calls), presence: day(raw.presence),
  };
  const users = await store.analyticsUsers(ownerIds());
  const tz = new Map(users.map((u) => [u.id, validTz(u.tz)]));
  const c: Ctx = {
    store, q, now, nowMs, zone, today, cur, prev, since, notes: new Set(), users,
    tzOf: (id) => tz.get(id) ?? config.defaultTimezone,
  };
  const data = await ({ money: moneyReport, subs: subsReport, ai: aiReport, act: actReport, ret: retReport, feat: featReport, parse: parseReport }[q.report] as (c: Ctx) => Promise<unknown>)(c);
  const meta: AnalyticsMeta = {
    report: q.report, days: q.days, step: q.step, generated_at: now.toISOString(), cached: false, zone, today,
    period: periodOf(cur), prev: periodOf(prev), buckets: cur.buckets, prev_buckets: prev.buckets,
    star_usd: config.billing.starUsd, since, notes: [...c.notes],
  };
  return { meta, report: q.report, data } as AnalyticsResponse;
}

/** Пояс из базы, который понимает Intl; иначе — пояс сервера по умолчанию. */
function validTz(tz: string): string {
  try {
    if (tz) { dayKey(new Date(0), tz); return tz; }
  } catch { /* битый пояс — по умолчанию */ }
  return config.defaultTimezone;
}

type CacheEntry = { at: number; value: Promise<AnalyticsResponse> };
// На хранилище — свой набор (в тестах их несколько); в работе — одно, записей не больше 7 × 5 × 3 = 105.
let cache = new WeakMap<Store, Map<string, CacheEntry>>();

/** Сбросить кэш (тесты). */
export function resetAnalyticsCache() {
  cache = new WeakMap();
}

/** Отчёт через кэш на ANALYTICS_CACHE_MS: хранится промис — параллельные запросы не считают дважды; ошибка — запись удаляется. */
export async function cachedAnalytics(store: Store, q: AnalyticsQuery, now = new Date()): Promise<AnalyticsResponse> {
  const key = `${q.report}|${q.days}|${q.step}`;
  const m = cache.get(store) ?? cache.set(store, new Map()).get(store)!;
  const t = now.getTime();
  const hit = m.get(key);
  if (hit && t >= hit.at && t - hit.at < ANALYTICS_CACHE_MS) {
    const r = await hit.value;
    return { ...r, meta: { ...r.meta, cached: true } } as AnalyticsResponse;
  }
  const entry: CacheEntry = { at: t, value: analyticsReport(store, q, now) };
  m.set(key, entry);
  entry.value.catch(() => { if (m.get(key) === entry) m.delete(key); });
  return entry.value;
}
