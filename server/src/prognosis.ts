import { accessOf, isFrozen, ownerIds } from "./access.ts";
import type { Store } from "./db.ts";
import { tariffs, unpricedOf } from "./tariffs.ts";
import { addDays } from "./time.ts";

// Прогноз (этап 6 «Тарифы и управление», 24.11.2026; макет — вкладка «Прогноз»). Только числа, без людей: расход на ИИ и доход
// звёздами на месяц линейно — среднее за последние 7 и 30 полных дней (сегодня неполный — не в среднем; дни — с первого дня с
// данными, data_days) × 30; рост расхода — прямая по 30 дням (наименьшие квадраты, тоже с первого дня с данными; меньше
// PROGNOSIS_MIN_DAYS — «мало данных») и через сколько дней при нём расход за день упрётся в общий потолок проб и в порог
// оповещения «расход за день»; продления подписок по датам окончания на 30 дней вперёд (идущие с продлением — сколько и на сколько звёзд;
// с отменённым продлением — сколько закончится). Отличие от макета: в макете — годовой прогноз по допущениям, которые двигает
// владелец; здесь — по фактическим дням (допущения без данных были бы выдумкой), а сценарии — потом, когда наберётся история.

const DAY = 86_400_000;
export const PROGNOSIS_DAYS = 30;
/** Меньше стольких дней с данными — прямую и дни до потолка не считаем («мало данных»). */
export const PROGNOSIS_MIN_DAYS = 7;

/** Прямая по точкам (x — номер дня, y — значение): наклон в день и значение на последнем дне. Меньше 2 точек — наклон 0. */
export function trendLine(ys: number[]): { slope: number; last: number } {
  const n = ys.length;
  if (n < 2) return { slope: 0, last: ys[0] ?? 0 };
  const mx = (n - 1) / 2, my = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (i - mx) * (ys[i] - my); den += (i - mx) ** 2; }
  const slope = den ? num / den : 0;
  return { slope, last: my + slope * (n - 1 - mx) };
}
/** Через сколько дней прямая дорастёт до cap: уже выше — 0; не растёт — null (не упрёмся при нынешнем темпе). */
export function daysToCap(t: { slope: number; last: number }, cap: number): number | null {
  if (t.last >= cap) return 0;
  if (t.slope <= 1e-12) return null;
  return Math.ceil((cap - t.last) / t.slope);
}

export async function prognosisView(store: Store, now = new Date()) {
  const t = tariffs();
  const utc = now.toISOString().slice(0, 10);
  const from = addDays(utc, -PROGNOSIS_DAYS);
  const days = Array.from({ length: PROGNOSIS_DAYS }, (_, i) => addDays(from, i)); // 30 полных дней до вчера
  const cost = new Map<string, number>();
  for (const r of await store.usageDays(from, utc)) cost.set(r.day, (cost.get(r.day) ?? 0) + r.cost);
  const trial = new Map<string, number>();
  for (const r of await store.planDaySpend(from, ["trial"], unpricedOf(t))) trial.set(r.day, (trial.get(r.day) ?? 0) + r.micro / 1e6);
  const stars = new Map<string, number>();
  for (const r of await store.starDays(`${from}T00:00:00.000Z`)) stars.set(r.day, r.stars);
  const series = days.map((d) => ({ day: d, cost: cost.get(d) ?? 0, trial: trial.get(d) ?? 0, stars: stars.get(d) ?? 0 }));
  // Дни считаются с первого дня с данными: нули до запуска ИИ или оплаты не занижают среднее и не рисуют рост.
  const dataDays = (k: "cost" | "trial" | "stars") => {
    const i = series.findIndex((r) => r[k] > 0);
    return i < 0 ? 0 : series.length - i;
  };
  const avg = (k: "cost" | "stars", n: number) => {
    const m = Math.min(n, dataDays(k));
    return m ? series.slice(-m).reduce((s, r) => s + r[k], 0) / m : 0;
  };
  const month = (k: "cost" | "stars") => ({ by7: avg(k, 7) * 30, by30: avg(k, 30) * 30, data_days: dataDays(k) });
  const trendOf = (k: "cost" | "trial") => trendLine(series.slice(-Math.max(1, dataDays(k))).map((r) => r[k]));
  const enough = (k: "cost" | "trial") => dataDays(k) >= PROGNOSIS_MIN_DAYS;

  const spendTrend = trendOf("cost");
  const trialTrend = trendOf("trial");
  const alertRow = (await store.alertRules()).find((r) => r.id === "spend_day");
  const alertCap = alertRow?.threshold ?? Math.round(t.trialPoolDayUsd * 0.8 * 100) / 100;

  // Продления по датам окончания: следующие 30 дней.
  const owners = ownerIds();
  const until = now.getTime() + PROGNOSIS_DAYS * DAY;
  const renew = new Map<string, { n: number; stars: number }>();
  let ending = 0, renewN = 0, renewStars = 0;
  for (const u of await store.users()) {
    if (u.plan !== "paid" || !u.access_until || isFrozen(u)) continue;
    const end = Date.parse(u.access_until);
    if (!(end >= now.getTime() && end < until) || !accessOf(u, now, owners).ok) continue;
    if (Number(u.sub_canceled) || !u.sub_charge_id) { ending++; continue; }
    const first = await store.payment(u.sub_charge_id);
    const price = first && first.currency === "XTR" && !first.refunded_at ? first.amount : t.price;
    const d = u.access_until.slice(0, 10);
    const r = renew.get(d) ?? { n: 0, stars: 0 };
    r.n++; r.stars += price;
    renew.set(d, r);
    renewN++; renewStars += price;
  }
  const todayCost = (cost.get(utc) ?? 0);
  const todayTrial = (trial.get(utc) ?? 0);
  return {
    days: PROGNOSIS_DAYS, star_usd: t.starUsd,
    min_days: PROGNOSIS_MIN_DAYS,
    // Мало данных (data_days < min_days) — наклон 0 и дней до потолка нет: сайт пишет «мало данных: N дн.».
    spend: {
      month: month("cost"), today: todayCost, data_days: dataDays("cost"), slope_per_day: enough("cost") ? spendTrend.slope : 0, trend_last: spendTrend.last,
      alert_cap: alertCap, days_to_alert: enough("cost") ? daysToCap(spendTrend, alertCap) : null,
    },
    trial_pool: {
      cap: t.trialPoolDayUsd, today: todayTrial, data_days: dataDays("trial"), slope_per_day: enough("trial") ? trialTrend.slope : 0, trend_last: trialTrend.last,
      days_to_cap: enough("trial") ? daysToCap(trialTrend, t.trialPoolDayUsd) : null,
    },
    income: { stars: month("stars"), usd: { by7: month("stars").by7 * t.starUsd, by30: month("stars").by30 * t.starUsd } },
    renewals: { n: renewN, stars: renewStars, usd: renewStars * t.starUsd, ending_without_renew: ending, by_day: [...renew].sort(([a], [b]) => a.localeCompare(b)).map(([day, r]) => ({ day, ...r })) },
    series,
  };
}
