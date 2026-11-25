import type { OpenRouterBillRow, Store } from "./db.ts";
import { addDays } from "./time.ts";

// «Счёт OpenRouter» (админка → «Расходы на модель»): расход так, как его считает сам OpenRouter (страница openrouter.ai/activity),
// рядом с нашими записями (llm_usage — usage.cost из ответов). Документация OpenRouter (25.11.2026):
//  • GET https://openrouter.ai/api/v1/activity — нужен управляющий ключ (Management, раньше Provisioning), Authorization: Bearer.
//    Ответ { data: [{ date: "ГГГГ-ММ-ДД", model, model_permaslug, endpoint_id, provider_name, usage ($ кредитов), byok_usage_inference
//    ($ по своим ключам), requests, prompt_tokens, completion_tokens, reasoning_tokens, cached_tokens }] } — последние 30 завершённых
//    дней UTC (сегодняшнего нет), строка на день × модель × endpoint. Фильтр ?date=ГГГГ-ММ-ДД — один день (не нужен: берём всё окно).
//  • GET https://openrouter.ai/api/v1/credits — тоже управляющий ключ: { data: { total_credits, total_usage } } (куплено и потрачено, $).
//  • GET https://openrouter.ai/api/v1/key — любым ключом, про сам этот ключ: { data: { usage_daily, usage_weekly, usage_monthly, … } }
//    (текущие день, неделя пн–вс и месяц UTC). Берём ключами самого сервера (LLM, рисование, голос — те, что идут через OpenRouter).
// Ключи не попадают ни в базу, ни в ответ ручки, ни в журнал админа, ни в лог: в состоянии только статус и числа.

export const OPENROUTER_API = "https://openrouter.ai/api/v1";
/** Сколько ждать ответа OpenRouter на один запрос. */
export const OPENROUTER_TIMEOUT_MS = 15_000;
/** Сама загрузка — раз в час (такт планировщика); кнопка «Обновить» — не чаще раза в минуту. */
export const OPENROUTER_EVERY_MS = 3600_000;
export const OPENROUTER_REFRESH_GAP_MS = 60_000;
/** Окно /api/v1/activity: последние 30 завершённых дней UTC. */
export const OPENROUTER_WINDOW_DAYS = 30;
/** Состояние загрузки (kv, JSON BillState). */
export const OPENROUTER_STATE_KEY = "openrouter:bill";
/** Расхождение «по счёту» и «по нашим записям» подсвечивается, если больше обоих порогов. */
export const RECONCILE_SHARE = 0.1;
export const RECONCILE_USD = 0.01;

/** no_key — ключ не задан; bad_key — 401/403 (нужен управляющий ключ); no_net — нет связи или ответа; error — другой ответ. */
export type BillStatus = "never" | "no_key" | "ok" | "bad_key" | "no_net" | "error";
export interface BillState {
  status: BillStatus;
  /** Короткое пояснение по-русски (наш текст, без ответа сервера целиком). */
  error: string;
  checked_at: string | null;
  ok_at: string | null;
  rows: number;
  credits: { total_credits: number; total_usage: number } | null;
  credits_at: string | null;
  /** Потрачено по ключам сервера (/api/v1/key): сегодня, неделя, месяц UTC (на spent_at); keys — сколько ключей сложено,
   *  missing — сколько ключей не ответило (их расхода в сумме нет). */
  spent: { daily: number; weekly: number; monthly: number; byok_daily: number; byok_weekly: number; byok_monthly: number; keys: number; missing?: number } | null;
  spent_at: string | null;
  /** Дни, за которые счёт загружен хоть раз (за пределами — «нет данных», а не ноль). */
  covered_from: string | null;
  covered_to: string | null;
}
const EMPTY: BillState = {
  status: "never", error: "", checked_at: null, ok_at: null, rows: 0, credits: null, credits_at: null, spent: null, spent_at: null,
  covered_from: null, covered_to: null,
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
const cnt = (v: unknown) => Math.max(0, Math.round(num(v) ?? 0));
const micro = (v: unknown) => Math.round((num(v) ?? 0) * 1e6);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Ответ /api/v1/activity → строки день × модель × провайдер (строки разных endpoint одной модели и провайдера складываются).
 *  Строка без даты ГГГГ-ММ-ДД или без модели пропускается; лишние поля не мешают; нет массива data — null (не тот ответ). */
export function parseActivity(json: unknown): OpenRouterBillRow[] | null {
  const data = (json as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return null;
  const by = new Map<string, OpenRouterBillRow>();
  for (const x of data) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    const day = typeof o.date === "string" ? o.date.slice(0, 10) : "";
    const model = typeof o.model === "string" && o.model.trim() ? o.model.trim().slice(0, 120)
      : typeof o.model_permaslug === "string" && o.model_permaslug.trim() ? o.model_permaslug.trim().slice(0, 120) : "";
    if (!DAY_RE.test(day) || !model) continue;
    const provider = typeof o.provider_name === "string" ? o.provider_name.trim().slice(0, 80) : "";
    const k = `${day}\u0000${model}\u0000${provider}`;
    const r = by.get(k) ?? { day, model, provider, micro_usd: 0, byok_micro: 0, requests: 0, prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0, cached_tokens: 0 };
    r.micro_usd += micro(o.usage);
    r.byok_micro += micro(o.byok_usage_inference);
    r.requests += cnt(o.requests);
    r.prompt_tokens += cnt(o.prompt_tokens);
    r.completion_tokens += cnt(o.completion_tokens);
    r.reasoning_tokens += cnt(o.reasoning_tokens);
    r.cached_tokens += cnt(o.cached_tokens);
    by.set(k, r);
  }
  return [...by.values()];
}

/** Ответ /api/v1/credits → куплено и потрачено ($); не тот ответ — null. */
export function parseCredits(json: unknown): { total_credits: number; total_usage: number } | null {
  const d = (json as { data?: Record<string, unknown> } | null)?.data;
  if (!d || typeof d !== "object") return null;
  const total = num(d.total_credits), used = num(d.total_usage);
  if (total == null || used == null) return null;
  return { total_credits: total, total_usage: used };
}

/** Ответ /api/v1/key → расход ключа за текущие день, неделю и месяц UTC ($); нет usage_daily — null. */
export function parseKeyUsage(json: unknown): { daily: number; weekly: number; monthly: number; byok_daily: number; byok_weekly: number; byok_monthly: number } | null {
  const d = (json as { data?: Record<string, unknown> } | null)?.data;
  if (!d || typeof d !== "object") return null;
  const daily = num(d.usage_daily);
  if (daily == null) return null;
  return {
    daily, weekly: num(d.usage_weekly) ?? daily, monthly: num(d.usage_monthly) ?? num(d.usage_weekly) ?? daily,
    byok_daily: num(d.byok_usage_daily) ?? 0, byok_weekly: num(d.byok_usage_weekly) ?? 0, byok_monthly: num(d.byok_usage_monthly) ?? 0,
  };
}

type Got = { ok: true; json: unknown } | { ok: false; status: Exclude<BillStatus, "ok" | "never" | "no_key">; error: string };

/** Один GET к OpenRouter: ошибки — статусом и нашим текстом (без ключа и без тела ответа). */
async function getJson(fetcher: typeof fetch, url: string, key: string, timeoutMs: number): Promise<Got> {
  // Свой таймер, а не AbortSignal.timeout: тот не держит процесс и в тестах не срабатывает; снимается в finally.
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(new DOMException("timeout", "TimeoutError")), timeoutMs);
  try {
    return await getJsonWith(fetcher, url, key, timeoutMs, stop.signal);
  } finally {
    clearTimeout(timer);
  }
}
async function getJsonWith(fetcher: typeof fetch, url: string, key: string, timeoutMs: number, signal: AbortSignal): Promise<Got> {
  let r: Response;
  try {
    r = await fetcher(url, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }, signal });
  } catch (e) {
    const name = (e as Error)?.name ?? "";
    return { ok: false, status: "no_net", error: signal.aborted || name === "TimeoutError" || name === "AbortError" ? `нет ответа за ${Math.max(1, Math.round(timeoutMs / 1000))} с` : "нет связи с OpenRouter" };
  }
  if (r.status === 401 || r.status === 403) {
    await r.body?.cancel().catch(() => {});
    return { ok: false, status: "bad_key", error: `ключ не подходит (OpenRouter ответил ${r.status}) — нужен управляющий ключ` };
  }
  if (!r.ok) {
    await r.body?.cancel().catch(() => {});
    return { ok: false, status: "error", error: `OpenRouter ответил ${r.status}` };
  }
  try {
    return { ok: true, json: JSON.parse(await r.text()) };
  } catch (e) {
    const name = (e as Error)?.name ?? "";
    if (signal.aborted || name === "TimeoutError" || name === "AbortError") return { ok: false, status: "no_net", error: `нет ответа за ${Math.max(1, Math.round(timeoutMs / 1000))} с` };
    return { ok: false, status: "error", error: "ответ OpenRouter не разобрался" };
  }
}

export class OpenRouterBillError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface OpenRouterBillOpts {
  /** Управляющий ключ (OPENROUTER_MANAGEMENT_KEY); пусто — «ключ не задан». */
  key?: string;
  /** Ключи сервера, которыми он ходит в OpenRouter (LLM, рисование, голос) — для «потрачено сегодня/неделя/месяц» (/api/v1/key). */
  usageKeys?: string[];
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Загрузка и хранение счёта OpenRouter: раз в час (hourly из такта планировщика) и по кнопке (manual), одна загрузка за раз. */
export class OpenRouterBill {
  private readonly key: string;
  private readonly usageKeys: string[];
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private running: Promise<BillState> | null = null;
  /** Время последнего принятого нажатия «Обновить» (в памяти): пауза в минуту считается и от него, а не только от checked_at,
   *  который пишется лишь в конце загрузки. */
  private manualAt: number | null = null;

  constructor(private readonly store: Store, opts: OpenRouterBillOpts = {}) {
    this.key = (opts.key ?? "").trim();
    this.usageKeys = [...new Set((opts.usageKeys ?? []).map((k) => k.trim()).filter(Boolean))];
    this.fetcher = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? OPENROUTER_TIMEOUT_MS;
  }
  get hasKey() { return Boolean(this.key); }

  async state(): Promise<BillState> {
    try {
      const v = JSON.parse((await this.store.kvGet(OPENROUTER_STATE_KEY)) ?? "null");
      return v && typeof v === "object" ? { ...EMPTY, ...v } : { ...EMPTY };
    } catch {
      return { ...EMPTY };
    }
  }
  private save(s: BillState) { return this.store.kvSet(OPENROUTER_STATE_KEY, JSON.stringify(s)); }

  /** Загрузить сейчас (одновременный второй вызов ждёт первый). Ошибки не бросаются — только статус. */
  refresh(now = new Date()): Promise<BillState> {
    if (!this.running) this.running = this.load(now).finally(() => { this.running = null; });
    return this.running;
  }

  /** Такт планировщика: раз в OPENROUTER_EVERY_MS (по времени прошлой попытки); без ключа — только статус, без запросов. */
  async hourly(now = new Date()): Promise<void> {
    const s = await this.state();
    const last = s.checked_at ? Date.parse(s.checked_at) : 0;
    if (!this.key && s.status === "no_key") return;
    // Ключ появился после перезапуска (было «ключ не задан») — загрузить сразу, не ждать часа.
    if (now.getTime() - last < OPENROUTER_EVERY_MS && s.status !== "never" && s.status !== "no_key") return;
    await this.refresh(now);
  }

  /** Для такта планировщика: запустить hourly и не ждать — медленный OpenRouter (до 3 запросов по 15 с) не держит такт с
   *  напоминаниями. Две загрузки сразу не пойдут: refresh отдаёт уже идущую. */
  hourlyInBackground(now = new Date()): void {
    void this.hourly(now).catch((e) => console.error("[openrouter-bill]", e));
  }

  /** Кнопка «Обновить» в админке: не чаще раза в минуту (429), с причиной — в журнал админа. */
  async manual(adminId: number, reason: string, now = new Date()): Promise<BillState> {
    // Проверки до первого await: второе нажатие во время загрузки (её checked_at ещё не записан) — 429 без строки в журнале.
    if (this.running) throw new OpenRouterBillError(429, "счёт уже обновляется — подождите");
    const t = now.getTime();
    const gapWait = (last: number) => Math.ceil((last + OPENROUTER_REFRESH_GAP_MS - t) / 1000);
    const tooSoon = (wait: number) => new OpenRouterBillError(429, `обновлять — не чаще раза в минуту, через ${wait} с`);
    if (this.manualAt != null) {
      const w = gapWait(this.manualAt);
      if (w > 0 && w <= OPENROUTER_REFRESH_GAP_MS / 1000) throw tooSoon(w);
    }
    const before = this.manualAt;
    this.manualAt = t;
    const s = await this.state();
    const wait = gapWait(s.checked_at ? Date.parse(s.checked_at) : 0);
    if (wait > 0 && wait <= OPENROUTER_REFRESH_GAP_MS / 1000) { this.manualAt = before; throw tooSoon(wait); }
    // Пока читали состояние, могла начаться часовая загрузка — она и обновит.
    if (this.running) { this.manualAt = before; throw new OpenRouterBillError(429, "счёт уже обновляется — подождите"); }
    const r = await this.refresh(now);
    await this.store.addAdminLog(adminId, "openrouter_refresh", `статус: ${r.status}${r.status === "ok" ? `, строк ${r.rows}` : ""}`, now, reason);
    return r;
  }

  private async load(now: Date): Promise<BillState> {
    const prev = await this.state();
    const at = now.toISOString();
    if (!this.key) {
      const s: BillState = { ...prev, status: "no_key", error: "ключ не задан (OPENROUTER_MANAGEMENT_KEY)", checked_at: at };
      await this.save(s);
      return s;
    }
    const today = at.slice(0, 10);
    const from = addDays(today, -OPENROUTER_WINDOW_DAYS), to = addDays(today, -1);
    let s: BillState = { ...prev, checked_at: at };
    const act = await getJson(this.fetcher, `${OPENROUTER_API}/activity`, this.key, this.timeoutMs);
    const rows = act.ok ? parseActivity(act.json) : null;
    if (!act.ok) s = { ...s, status: act.status, error: act.error };
    else if (!rows) s = { ...s, status: "error", error: "ответ OpenRouter не разобрался" };
    else {
      await this.store.replaceOpenRouterBill(from, to, rows);
      s = {
        ...s, status: "ok", error: "", ok_at: at, rows: rows.filter((r) => r.day >= from && r.day <= to).length,
        covered_from: s.covered_from && s.covered_from < from ? s.covered_from : from,
        covered_to: s.covered_to && s.covered_to > to ? s.covered_to : to,
      };
      // Баланс — тем же управляющим ключом; не вышло — остаётся прошлый (со своим временем).
      const cr = await getJson(this.fetcher, `${OPENROUTER_API}/credits`, this.key, this.timeoutMs);
      const credits = cr.ok ? parseCredits(cr.json) : null;
      if (credits) s = { ...s, credits, credits_at: at };
    }
    // Потрачено сегодня/неделя/месяц — ключами сервера (/api/v1/key отвечает про сам ключ): сумма ответивших, сколько не ответило —
    // в missing; не ответил ни один — остаётся прошлое со своим spent_at (view не выдаст его за текущий день, неделю, месяц).
    if (this.usageKeys.length && s.status !== "no_net") {
      const got = await Promise.all(this.usageKeys.map(async (k) => {
        const r = await getJson(this.fetcher, `${OPENROUTER_API}/key`, k, this.timeoutMs);
        return r.ok ? parseKeyUsage(r.json) : null;
      }));
      const ok = got.filter((g) => g != null);
      if (ok.length) {
        const sum = { daily: 0, weekly: 0, monthly: 0, byok_daily: 0, byok_weekly: 0, byok_monthly: 0, keys: ok.length, missing: got.length - ok.length };
        for (const g of ok) for (const k of ["daily", "weekly", "monthly", "byok_daily", "byok_weekly", "byok_monthly"] as const) sum[k] += g[k];
        s = { ...s, spent: sum, spent_at: at };
      }
    }
    await this.save(s);
    if (s.status !== "ok") console.warn("[openrouter-bill]", s.status, s.error);
    return s;
  }

  /** Ответ ручки GET /api/admin/openrouter: состояние, по дням за 30 дней + сегодня (сверка), по моделям. Без ключей. */
  async view(now = new Date()) {
    const s = await this.state();
    const today = now.toISOString().slice(0, 10);
    const from = addDays(today, -OPENROUTER_WINDOW_DAYS);
    const bill = await this.store.openRouterBill(from, today);
    const ours = await this.store.usageByDay(from, today);
    const days = reconcileDays(from, today, bill, ours, s.covered_from && s.covered_to ? { from: s.covered_from, to: s.covered_to } : null);
    const models = billModels(bill);
    const total = {
      bill: days.reduce((a, d) => a + (d.bill ?? 0), 0), byok: days.reduce((a, d) => a + (d.byok ?? 0), 0),
      requests: days.reduce((a, d) => a + (d.requests ?? 0), 0),
      // Наши — только за дни, где есть и счёт: иначе сравнение нечестное.
      ours: days.reduce((a, d) => a + (d.bill == null ? 0 : d.ours), 0),
    };
    const credits = s.credits ? { total: s.credits.total_credits, used: s.credits.total_usage, left: s.credits.total_credits - s.credits.total_usage } : null;
    return {
      status: (this.key ? s.status : "no_key") as BillStatus, has_key: this.hasKey, error: this.key ? s.error : "ключ не задан (OPENROUTER_MANAGEMENT_KEY)",
      checked_at: s.checked_at, ok_at: s.ok_at, credits, credits_at: s.credits_at, spent: spentView(s.spent, s.spent_at, now), spent_at: s.spent_at,
      from, to: today, days, models, total, every_min: OPENROUTER_EVERY_MS / 60_000, gap_s: OPENROUTER_REFRESH_GAP_MS / 1000,
      share: RECONCILE_SHARE, usd: RECONCILE_USD,
    };
  }
}

/** Понедельник недели UTC для дня ГГГГ-ММ-ДД (неделя OpenRouter — пн–вс). */
export function utcWeekStart(day: string): string {
  return addDays(day, -((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7));
}

/** «Потрачено» для ручки: число за день, неделю, месяц — только если spent_at в том же дне, неделе, месяце UTC, что и now;
 *  иначе null (в админке — прочерк «устарело»), чтобы вчерашний usage_daily не показывался как сегодняшний. */
export function spentView(spent: BillState["spent"], at: string | null, now: Date) {
  if (!spent || !at) return null;
  const was = at.slice(0, 10), today = now.toISOString().slice(0, 10);
  const day = was === today, week = utcWeekStart(was) === utcWeekStart(today), month = was.slice(0, 7) === today.slice(0, 7);
  return {
    daily: day ? spent.daily : null, weekly: week ? spent.weekly : null, monthly: month ? spent.monthly : null,
    byok_daily: day ? spent.byok_daily : null, byok_weekly: week ? spent.byok_weekly : null, byok_monthly: month ? spent.byok_monthly : null,
    keys: spent.keys, missing: spent.missing ?? 0,
  };
}

export interface BillDay {
  day: string;
  /** По счёту OpenRouter, $ (null — нет данных: сегодня или день вне загруженного окна). */
  bill: number | null; byok: number | null; requests: number | null;
  /** По нашим записям (llm_usage, день UTC), $; вызовы и из них без цены. */
  ours: number; ours_calls: number; ours_unpriced: number;
  diff: number | null; flag: boolean;
  /** today — OpenRouter считает только завершённые дни. */
  today: boolean;
}

/** Расхождение заметное: больше RECONCILE_USD и больше RECONCILE_SHARE от большего из двух. */
export const reconcileFlag = (bill: number, ours: number) => {
  const d = Math.abs(bill - ours);
  return d > RECONCILE_USD + 1e-9 && d > RECONCILE_SHARE * Math.max(bill, ours) + 1e-12;
};

/** Сверка по дням UTC from..to: счёт OpenRouter против наших записей. В загруженном окне день без строк счёта — ноль (OpenRouter
 *  расхода не видел), вне окна и сегодня — нет данных. */
export function reconcileDays(
  from: string, to: string, bill: OpenRouterBillRow[], ours: { day: string; micro: number; calls: number; unpriced: number }[],
  covered: { from: string; to: string } | null,
): BillDay[] {
  const b = new Map<string, { micro: number; byok: number; requests: number }>();
  for (const r of bill) {
    const x = b.get(r.day) ?? { micro: 0, byok: 0, requests: 0 };
    x.micro += r.micro_usd; x.byok += r.byok_micro; x.requests += r.requests;
    b.set(r.day, x);
  }
  const o = new Map(ours.map((r) => [r.day, r]));
  const out: BillDay[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    const has = b.get(day);
    const inWindow = covered != null && day >= covered.from && day <= covered.to;
    const known = Boolean(has) || inWindow;
    const bv = known ? (has?.micro ?? 0) / 1e6 : null;
    const our = o.get(day);
    const ov = (our?.micro ?? 0) / 1e6;
    out.push({
      day, bill: bv, byok: known ? (has?.byok ?? 0) / 1e6 : null, requests: known ? (has?.requests ?? 0) : null,
      ours: ov, ours_calls: our?.calls ?? 0, ours_unpriced: our?.unpriced ?? 0,
      diff: bv == null ? null : bv - ov, flag: bv != null && reconcileFlag(bv, ov), today: day === to,
    });
  }
  return out;
}

/** По моделям за окно: деньги, BYOK, запросы, токены, доля денег; провайдеры — через запятую. Дороже — выше. */
export function billModels(bill: OpenRouterBillRow[]) {
  const by = new Map<string, { model: string; providers: Set<string>; micro: number; byok: number; requests: number; prompt: number; completion: number; reasoning: number }>();
  for (const r of bill) {
    const x = by.get(r.model) ?? { model: r.model, providers: new Set<string>(), micro: 0, byok: 0, requests: 0, prompt: 0, completion: 0, reasoning: 0 };
    if (r.provider) x.providers.add(r.provider);
    x.micro += r.micro_usd; x.byok += r.byok_micro; x.requests += r.requests;
    x.prompt += r.prompt_tokens; x.completion += r.completion_tokens; x.reasoning += r.reasoning_tokens;
    by.set(r.model, x);
  }
  const all = [...by.values()];
  const sum = all.reduce((a, x) => a + x.micro, 0);
  return all
    .map((x) => ({
      model: x.model, providers: [...x.providers].sort(), cost: x.micro / 1e6, byok: x.byok / 1e6, requests: x.requests,
      prompt: x.prompt, completion: x.completion, reasoning: x.reasoning, share: sum ? x.micro / sum : 0,
    }))
    .sort((a, b) => b.cost - a.cost || b.requests - a.requests || a.model.localeCompare(b.model));
}
