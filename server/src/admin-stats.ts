import type { Store } from "./db.ts";
import { addDays, dayKey } from "./time.ts";
import { usageReport } from "./api.ts";
import { config } from "./config.ts";

// Админка, этап 1 (24.11.2026, docs/review/админка-2026-11-24.html): отчёты на данных, которые уже есть в базе.
// Только счётчики, имена и логины — без текстов сообщений и chat id. Обращения к горничной — сообщения, разобранные моделью
// (Telegram, сайт и виджет, айфон; без поправок к ответам); «без ИИ» — отметки кнопкой, из push, правки мышью. Импорт прошлого
// не считается. Дни активности — по поясу человека (messages.day_key), расход — по UTC (как llm_usage, подписано на сайте).

const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString();
const utcDay = (d: Date) => d.toISOString().slice(0, 10);
/** «Сегодня» админки — по поясу сервера по умолчанию (DEFAULT_TIMEZONE). */
const today = (now: Date) => dayKey(now, config.defaultTimezone);

async function people(store: Store, now: Date) {
  const rows = (await store.accounts(utcDay(now).slice(0, 7), iso(now.getTime() - 7 * DAY))).filter((x) => x.id);
  return new Map(rows.map((x) => [x.id, { id: x.id, name: x.name || x.login || `#${x.id}`, login: x.login, created_at: x.created_at }]));
}

/** Прогноз месяца (дни UTC): потрачено до вчера + среднее за 7 полных прошедших дней × дни с сегодняшнего до конца месяца.
 *  Сегодняшний неполный день в среднее не берётся — иначе утром прогноз занижен; сам сегодня — не меньше уже потраченного. */
async function forecast(store: Store, now: Date) {
  const utc = utcDay(now);
  const month = await store.llmUsage(utc.slice(0, 7));
  const days = await store.usageDays(addDays(utc, -7), utc);
  const todayCost = days.filter((r) => r.day === utc).reduce((s, r) => s + r.cost, 0);
  const avg = days.filter((r) => r.day !== utc).reduce((s, r) => s + r.cost, 0) / 7;
  const daysIn = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  // Сегодня — не меньше уже потраченного; дальше — по среднему.
  return { month, todayCost, forecast: Math.max(0, month.cost - todayCost) + Math.max(todayCost, avg) + avg * (daysIn - now.getUTCDate()) };
}

export async function adminOverview(store: Store, now = new Date()) {
  const who = await people(store, now);
  const week = iso(now.getTime() - 7 * DAY);
  const t = today(now);
  const active = await store.adminActiveDays(addDays(t, -29));
  const usersIn = (from: string) => new Set(active.filter((a) => a.day >= from).map((a) => a.user_id)).size;
  const { month, todayCost, forecast: spendForecast } = await forecast(store, now);
  const q = await store.adminQuality(addDays(t, -6));
  const sum = (k: "requests" | "failed" | "clarify" | "undone") => q.reduce((s, r) => s + r[k], 0);
  return {
    users: who.size,
    new_week: [...who.values()].filter((x) => x.created_at >= week).length,
    active_day: usersIn(t), active_week: usersIn(addDays(t, -6)), active_month: usersIn(addDays(t, -29)),
    spend_today: todayCost, spend_month: month.cost, spend_forecast: spendForecast, unpriced_month: month.calls - month.priced,
    requests_week: sum("requests"), failed_week: sum("failed"), clarify_week: sum("clarify"), undone_week: sum("undone"),
  };
}

/** Таблица людей: когда пришёл, последнее обращение, за 30 дней — обращений, с ИИ и без, отмен; расход за 30 дней, месяц и всего. */
export async function adminUsers(store: Store, now = new Date()) {
  const who = await people(store, now);
  const since = iso(now.getTime() - 30 * DAY);
  const stats = new Map((await store.adminUserStats(since)).map((r) => [r.user_id, r]));
  const utc = utcDay(now);
  const spend30 = new Map((await store.adminSpendByUser(addDays(utc, -29), utc)).map((r) => [r.user_id, r]));
  const spendMonth = new Map((await store.adminSpendByUser(`${utc.slice(0, 7)}-01`, utc)).map((r) => [r.user_id, r]));
  const spendAll = new Map((await store.adminSpendByUser("0000-01-01", utc)).map((r) => [r.user_id, r]));
  return [...who.values()].map((p) => {
    const s = stats.get(p.id);
    return {
      id: p.id, name: p.name, login: p.login, created_at: p.created_at, last_at: s?.last_at ?? null,
      total: s?.total ?? 0, n30: s?.n30 ?? 0, ai30: s?.ai30 ?? 0, manual30: s?.manual30 ?? 0, undone30: s?.undone30 ?? 0,
      cost30: spend30.get(p.id)?.cost ?? 0, background30: spend30.get(p.id)?.background ?? 0,
      cost_month: spendMonth.get(p.id)?.cost ?? 0, cost_total: spendAll.get(p.id)?.cost ?? 0,
    };
  }).sort((a, b) => b.cost30 - a.cost30 || b.n30 - a.n30);
}

/** Расход всего сервера: отчёт как на сайте (по дням, назначениям, моделям, итог месяца) + по людям + прогноз. */
export async function adminSpend(store: Store, days: number, now = new Date()) {
  const n = Math.min(90, Math.max(7, days || 30));
  const utc = utcDay(now);
  const from = addDays(utc, 1 - n);
  const report = usageReport(await store.usageDays(from, utc), n, await store.llmUsage(utc.slice(0, 7)), utc);
  const who = await people(store, now);
  const byUser = (await store.adminSpendByUser(from, utc))
    .map((r) => ({ user_id: r.user_id, name: r.user_id ? (who.get(r.user_id)?.name ?? `#${r.user_id}`) : "без человека", calls: r.calls, cost: r.cost, background: r.background }))
    .sort((a, b) => b.cost - a.cost);
  return { ...report, byUser, forecast: (await forecast(store, now)).forecast };
}

/** Аудитория: активные по дням (за день, 7 и 30 дней), удержание по неделям прихода, кто пропал, откуда пишут. */
export async function adminAudience(store: Store, now = new Date()) {
  const t = today(now);
  const from = addDays(t, -119);
  const active = await store.adminActiveDays(from);
  const byDay = new Map<string, Set<number>>();
  for (const a of active) (byDay.get(a.day) ?? byDay.set(a.day, new Set()).get(a.day)!).add(a.user_id);
  const within = (end: string, len: number) => {
    const s = new Set<number>();
    for (let i = 0; i < len; i++) for (const id of byDay.get(addDays(end, -i)) ?? []) s.add(id);
    return s.size;
  };
  const series = Array.from({ length: 30 }, (_, i) => {
    const day = addDays(t, i - 29);
    return { day, dau: byDay.get(day)?.size ?? 0, wau: within(day, 7), mau: within(day, 30) };
  });
  // Удержание: люди по неделе прихода (последние 8 недель), доля активных в каждую следующую неделю.
  const who = await people(store, now);
  const weekOf = (day: string) => {
    const d = new Date(`${day}T00:00:00Z`);
    return addDays(day, -((d.getUTCDay() + 6) % 7));
  };
  const thisWeek = weekOf(t);
  const activeWeeks = new Map<number, Set<string>>();
  for (const a of active) (activeWeeks.get(a.user_id) ?? activeWeeks.set(a.user_id, new Set()).get(a.user_id)!).add(weekOf(a.day));
  const cohorts = Array.from({ length: 8 }, (_, i) => {
    const week = addDays(thisWeek, -7 * (7 - i));
    const members = [...who.values()].filter((p) => p.created_at && weekOf(dayKey(new Date(p.created_at), config.defaultTimezone)) === week);
    const weeks = Array.from({ length: 7 - i }, (_, k) => {
      const w = addDays(week, 7 * (k + 1));
      return members.length ? members.filter((p) => activeWeeks.get(p.id)?.has(w)).length / members.length : null;
    });
    return { week, size: members.length, weeks };
  });
  // Пропали: обращались в последние 60 дней, но не в последние 14.
  const last = new Map<number, string>();
  for (const a of active) if (!last.has(a.user_id) || a.day > last.get(a.user_id)!) last.set(a.user_id, a.day);
  const gone = [...last].filter(([, d]) => d < addDays(t, -13) && d >= addDays(t, -59))
    .map(([id, d]) => ({ user_id: id, name: who.get(id)?.name ?? `#${id}`, last_day: d })).sort((a, b) => b.last_day.localeCompare(a.last_day));
  const sources = await store.adminSources(iso(now.getTime() - 30 * DAY));
  return { today: t, series, cohorts, gone, sources };
}

/** Качество разбора по дням за n дней. */
export async function adminQualityReport(store: Store, days: number, now = new Date()) {
  const n = Math.min(90, Math.max(7, days || 30));
  const t = today(now);
  const rows = new Map((await store.adminQuality(addDays(t, 1 - n))).map((r) => [r.day, r]));
  const series = Array.from({ length: n }, (_, i) => {
    const day = addDays(t, i - n + 1);
    return rows.get(day) ?? { day, requests: 0, failed: 0, clarify: 0, corrections: 0, undone: 0 };
  });
  const total = series.reduce((s, r) => ({ requests: s.requests + r.requests, failed: s.failed + r.failed, clarify: s.clarify + r.clarify, corrections: s.corrections + r.corrections, undone: s.undone + r.undone }),
    { requests: 0, failed: 0, clarify: 0, corrections: 0, undone: 0 });
  return { series, total };
}

// ——— Тревоги владельцу в Telegram (scheduler.extra, раз в такт). Один раз на событие (store.once): перерасход за день —
// раз в сутки, всплеск неразобранных — раз в час. Пороги: расход дня больше ADMIN_ALERT_SPEND_X × среднего за 14 дней
// и не меньше ADMIN_ALERT_SPEND_MIN долларов; неразобранных за час — ADMIN_ALERT_FAILED и больше.
export const ADMIN_ALERT_SPEND_X = 3;
export const ADMIN_ALERT_SPEND_MIN = 0.5;
export const ADMIN_ALERT_FAILED = 3;

export async function adminAlerts(store: Store, now = new Date()): Promise<string[]> {
  const out: string[] = [];
  const utc = utcDay(now);
  const rows = await store.usageDays(addDays(utc, -14), utc);
  const todayCost = rows.filter((r) => r.day === utc).reduce((s, r) => s + r.cost, 0);
  const avg = rows.filter((r) => r.day !== utc).reduce((s, r) => s + r.cost, 0) / 14;
  if (todayCost >= ADMIN_ALERT_SPEND_MIN && todayCost > ADMIN_ALERT_SPEND_X * avg && (await store.once(`alert:spend:${utc}`))) {
    out.push(`⚠️ Расход модели сегодня: $${todayCost.toFixed(2)} — в ${avg ? (todayCost / avg).toFixed(1) : "∞"} раза больше обычного ($${avg.toFixed(2)} в день за 2 недели). Подробности — админка → Расходы.`);
  }
  const failed = await store.adminFailedSince(iso(now.getTime() - 60 * 60_000));
  if (failed >= ADMIN_ALERT_FAILED && (await store.once(`alert:failed:${iso(now.getTime()).slice(0, 13)}`))) {
    out.push(`⚠️ За последний час не разобрано сообщений: ${failed}. Модель или сеть сбоят — админка → Обзор.`);
  }
  return out;
}
