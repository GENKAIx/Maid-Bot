// Калькулятор раздела «Тарифы» (25.11.2026, screens/AdminTariffs.tsx): «что будет, если людей станет столько-то и они станут
// активнее». Чистый расчёт по числам из полей (действующие или ещё не применённые) и экономике тарифов из GET /api/admin/tariffs —
// ничего не применяет на сервере. Месяц — 30 дней (подписка Telegram продлевается каждые 30 дней).
//
// Расход на человека в день:
//   средний — расход ИИ на человека за день на тарифе (economy.avg_day_usd: расход / человеко-дни на тарифе в окне 30 дней, не / 30 —
//   человек на пробе в окне не больше trialDays); старый сервер без avg_day_usd — avg_month_usd / min(30, длина срока: trialDays,
//   giftDays, у подписки 30), с пометкой «оценка» (avgEstimated); не больше того, что пускают лимиты;
//   у лимита — человек выбирает все лимиты в штуках (запросы, картинки, минуты голоса) по средним ценам единиц за 30 дней
//   (unit_prices), но не больше денежного предохранителя тарифа; запросов 0 — ИИ на тарифе закрыт, расход 0 (calcLimitDay — та же
//   цифра и в карточках тарифов); если в этой сумме есть оценочные цены, а люди уже тратят больше — «у лимита» не ниже измеренного
//   среднего (limitRaised): заниженная оценка не срезает данные, срезает только предохранитель;
//   ползунок активности (0…1) ведёт прямой от среднего к лимиту.
// Цены единицы нет (штук ещё не брали) — оценка из «Общих потолков» (цена вызова без цены: остальное, рисунок, голос; у голоса —
// как за минуту), в ответе помечена estimated. Среднего у тарифа нет (людей не было) — среднее другого тарифа (avg: "other"), нет
// ни у кого — 0 (avg: "none").
// Проба и подарок вместе не тратят больше общего потолка проб в день (trialPoolDayUsd, access.ts — подарок в базе тоже plan
// 'trial'): сверх него расход срезается (pool: true).

import { worstDay, type PlanEconomy, type TariffsData, type TariffValues, type UnitPrices } from "./tariffs";

export type CalcPlan = "trial" | "paid" | "gift";
export const CALC_PLANS: CalcPlan[] = ["trial", "paid", "gift"];
export const CALC_DAYS = 30;
/** Пресеты ползунка активности: доля пути от «как сейчас в среднем» до «каждый день у лимита». */
export const CALC_PRESETS = [0, 0.25, 0.5, 1];

export interface CalcInput { people: Record<CalcPlan, number>; activity: number }
export interface CalcPrices { call: number; draw: number; voiceMin: number; estimated: ("call" | "draw" | "voiceMin")[] }
export interface CalcRow {
  id: CalcPlan;
  people: number;
  /** На человека в день, $: средний (уже под лимитами), у лимита, при выбранной активности. */
  avgDayUsd: number;
  avg: "data" | "other" | "none";
  /** Среднее за день — оценка: сервер не дал avg_day_usd, 30-дневный расход поделён на длину срока. */
  avgEstimated: boolean;
  limitDayUsd: number;
  limitBy: "cap" | "limits" | "closed";
  /** «У лимита» посчитано и по оценочным ценам (нет цены единицы за 30 дней); limitRaised — поднято до измеренного среднего. */
  limitEstimated: boolean;
  limitRaised: boolean;
  personDayUsd: number;
  /** Все люди тарифа, $: в день и в месяц при выбранной активности (после общего потолка проб). */
  dayUsd: number;
  monthUsd: number;
  /** Худший случай за месяц: все у лимитов в штуках; все у денежного предохранителя (абсолютный потолок сервера). */
  worstMonthUsd: number;
  capMonthUsd: number;
  revenueMonthUsd: number;
}
export interface CalcResult {
  rows: CalcRow[];
  prices: CalcPrices;
  dayUsd: number;
  monthUsd: number;
  revenueMonthUsd: number;
  profitMonthUsd: number;
  worstMonthUsd: number;
  worstProfitMonthUsd: number;
  capMonthUsd: number;
  capProfitMonthUsd: number;
  /** Общий потолок проб срезал расход пробы и подарка: при выбранной активности, в худшем случае, у предохранителя. */
  pool: { now: boolean; worst: boolean; cap: boolean };
}

/** Цены единиц: из данных за 30 дней, нет — оценка из «Общих потолков». */
export function calcPrices(v: TariffValues, unit?: UnitPrices | null): CalcPrices {
  const estimated: CalcPrices["estimated"] = [];
  const pick = (got: number | null | undefined, est: number, k: CalcPrices["estimated"][number]) => {
    if (got != null && Number.isFinite(got)) return got;
    estimated.push(k);
    return est;
  };
  return {
    call: pick(unit?.call_usd, v.unpricedOtherUsd, "call"),
    draw: pick(unit?.draw_usd, v.unpricedDrawUsd, "draw"),
    voiceMin: pick(unit?.voice_min_usd, v.unpricedVoiceUsd, "voiceMin"),
    estimated,
  };
}

/** Число людей из поля: целое от 0; пусто или негодное — null (в расчёт идёт 0, поле красное). */
export function calcPeople(text: string): number | null {
  const t = text.trim();
  if (!/^\d{1,7}$/.test(t)) return null;
  return Number(t);
}

/** Средний расход человека за день на тарифе, $: avg_day_usd с сервера; нет (старый сервер) — avg_month_usd / min(30, длина срока). */
export function calcAvgDay(v: TariffValues, id: CalcPlan, e?: PlanEconomy): { usd: number; estimated: boolean } | null {
  const d = e?.avg_day_usd;
  if (d != null && Number.isFinite(d)) return { usd: d, estimated: false };
  const m = e?.avg_month_usd;
  if (m == null || !Number.isFinite(m)) return null;
  const len = id === "trial" ? v.trialDays : id === "gift" ? v.giftDays : CALC_DAYS;
  return { usd: m / Math.min(CALC_DAYS, Math.max(1, Number.isFinite(len) ? len : CALC_DAYS)), estimated: true };
}

export interface CalcLimit { usd: number; by: "cap" | "limits" | "closed"; estimated: boolean; raised: boolean }
/** «У лимита» на человека в день — одна цифра для калькулятора и карточек тарифов. own — своё измеренное среднее за день (нет — null). */
export function calcLimitDay(v: TariffValues, id: CalcPlan, prices: CalcPrices, own: number | null): CalcLimit {
  if (v[`${id}Calls`] === 0) return { usd: 0, by: "closed", estimated: false, raised: false };
  const w = worstDay(v, id, { call_usd: prices.call, draw_usd: prices.draw, voice_min_usd: prices.voiceMin });
  const n = { call: v[`${id}Calls`], draw: v[`${id}Draws`], voiceMin: v[`${id}VoiceMin`] };
  const estimated = w.by === "limits" && prices.estimated.some((k) => n[k] > 0);
  if (estimated && own != null && own > w.usd) {
    const cap = v[`${id}DayUsd`];
    return own >= cap ? { usd: cap, by: "cap", estimated, raised: true } : { usd: own, by: "limits", estimated, raised: true };
  }
  return { ...w, estimated, raised: false };
}

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
const safe = (n: number) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

export function tariffCalc(v: TariffValues, economy: TariffsData["economy"], unit: UnitPrices | null | undefined, input: CalcInput): CalcResult {
  const prices = calcPrices(v, unit);
  const t = clamp01(input.activity);
  const perDay = (id: CalcPlan) => calcAvgDay(v, id, economy[id]);
  const other = (["paid", "trial", "gift"] as const).map(perDay).find((x) => x != null);
  const rows: CalcRow[] = CALC_PLANS.map((id) => {
    const people = safe(input.people[id]);
    const own = perDay(id);
    const lim = calcLimitDay(v, id, prices, own?.usd ?? null);
    const w = { usd: lim.usd, by: lim.by };
    const src = own ?? other ?? null;
    const raw = src?.usd ?? 0;
    const avgDayUsd = Math.min(raw, w.usd);
    const personDayUsd = avgDayUsd + t * (w.usd - avgDayUsd);
    const cap = w.by === "closed" ? 0 : v[`${id}DayUsd`];
    return {
      id, people, avgDayUsd, avg: own != null ? "data" : other != null ? "other" : "none", avgEstimated: src?.estimated ?? false,
      limitDayUsd: w.usd, limitBy: w.by, limitEstimated: lim.estimated, limitRaised: lim.raised, personDayUsd,
      dayUsd: personDayUsd * people, monthUsd: 0,
      worstMonthUsd: w.usd * people * CALC_DAYS, capMonthUsd: cap * people * CALC_DAYS,
      revenueMonthUsd: id === "paid" ? people * v.price * v.starUsd : 0,
    };
  });
  // Общий потолок проб: проба и подарок вместе — не больше trialPoolDayUsd в день (доли сохраняются).
  const pool = { now: false, worst: false, cap: false };
  const free = rows.filter((r) => r.id !== "paid");
  const squeeze = (get: (r: CalcRow) => number, set: (r: CalcRow, x: number) => void, limit: number) => {
    const sum = free.reduce((s, r) => s + get(r), 0);
    if (sum <= limit + 1e-12) return false;
    for (const r of free) set(r, (get(r) / sum) * limit);
    return true;
  };
  pool.now = squeeze((r) => r.dayUsd, (r, x) => { r.dayUsd = x; }, v.trialPoolDayUsd);
  pool.worst = squeeze((r) => r.worstMonthUsd, (r, x) => { r.worstMonthUsd = x; }, v.trialPoolDayUsd * CALC_DAYS);
  pool.cap = squeeze((r) => r.capMonthUsd, (r, x) => { r.capMonthUsd = x; }, v.trialPoolDayUsd * CALC_DAYS);
  for (const r of rows) r.monthUsd = r.dayUsd * CALC_DAYS;
  const sum = (k: "dayUsd" | "monthUsd" | "worstMonthUsd" | "capMonthUsd" | "revenueMonthUsd") => rows.reduce((s, r) => s + r[k], 0);
  const revenueMonthUsd = sum("revenueMonthUsd");
  return {
    rows, prices,
    dayUsd: sum("dayUsd"), monthUsd: sum("monthUsd"),
    revenueMonthUsd, profitMonthUsd: revenueMonthUsd - sum("monthUsd"),
    worstMonthUsd: sum("worstMonthUsd"), worstProfitMonthUsd: revenueMonthUsd - sum("worstMonthUsd"),
    capMonthUsd: sum("capMonthUsd"), capProfitMonthUsd: revenueMonthUsd - sum("capMonthUsd"),
    pool,
  };
}
