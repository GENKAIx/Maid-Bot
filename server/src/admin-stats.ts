import type { Store } from "./db.ts";
import { addDays, dayKey, timeOf } from "./time.ts";
import { usageReport } from "./api.ts";
import { clientFromLabel, desktopTokenSeen, SESSION_IDLE_DAYS } from "./auth.ts";
import { CHAT_FAILED } from "./pipeline.ts";
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

// Этап 2 (24.11.2026): данные шага 24 — входы с клиентом и версией (sessions), минуты присутствия по часам (presence),
// вызовы модели на сообщение (messages.llm_calls / route) и журнал попыток модели (llm_calls). Запасной DESKTOP_TOKEN
// сессий не пишет — его последний заход и версия только в памяти процесса (auth.ts, desktopTokenSeen), после перезапуска пусто.

/** «Онлайн сейчас» — вход за последние столько минут. */
export const ADMIN_ONLINE_MIN = 5;
/** Клиент входа: заголовок X-Maid-Client, у старых клиентов без него — по метке входа. */
const clientOf = (s: { client: string; label: string }) => s.client || clientFromLabel(s.label);
/** Клиенты программы на ПК (виджет и быстрая запись — её окна). */
const DESKTOP_CLIENTS = ["desktop", "widget", "quick"];

/** Сравнение версий «1.2.3» по числам, новее — раньше; пустая — в конце. */
export function cmpVersion(a: string, b: string): number {
  if (!a || !b) return a ? -1 : b ? 1 : 0;
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
  return 0;
}

/** Перцентиль q (0..1) по возрастающему списку — ближайший ранг; пусто — null. */
export function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

/** Кто онлайн сейчас по клиентам: вход за ADMIN_ONLINE_MIN минут (last_seen пишется раз в минуту), DESKTOP_TOKEN — из памяти,
 *  Telegram — был запрос в этот час по поясу человека (у бота входа нет, точнее часа не знаем). */
async function onlineNow(store: Store, now: Date) {
  const since = iso(now.getTime() - ADMIN_ONLINE_MIN * 60_000);
  const by = new Map<string, Set<number>>();
  const add = (client: string, id: number) => (by.get(client) ?? by.set(client, new Set()).get(client)!).add(id);
  for (const s of await store.adminSessions(since)) add(clientOf(s), s.user_id);
  for (const d of desktopTokenSeen()) if (d.at >= since) add("desktop", d.userId);
  const tz = new Map((await store.users()).map((u) => [u.id, u.tz]));
  const days = [...new Set([...tz.values()].map((z) => dayKey(now, z)))];
  for (const p of await store.adminPresenceUsers("telegram", days)) {
    const z = tz.get(p.user_id);
    if (z && p.day === dayKey(now, z) && p.hour === Number(timeOf(now, z).slice(0, 2))) add("telegram", p.user_id);
  }
  const all = new Set<number>();
  for (const s of by.values()) for (const id of s) all.add(id);
  return { total: all.size, clients: [...by].map(([client, s]) => ({ client, users: s.size })).sort((a, b) => b.users - a.users) };
}

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
    online: await onlineNow(store, now),
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
  // Устройства (этап 2): входы человека по клиенту и версии — сколько входов и когда последний; метка входа наружу не идёт.
  const devices = new Map<number, Map<string, { client: string; version: string; last_seen: string; count: number }>>();
  const device = (id: number, client: string, version: string, at: string) => {
    const m = devices.get(id) ?? devices.set(id, new Map()).get(id)!;
    const d = m.get(`${client} ${version}`);
    if (d) { d.count++; if (at > d.last_seen) d.last_seen = at; } else m.set(`${client} ${version}`, { client, version, last_seen: at, count: 1 });
  };
  // Только живые входы: просроченный (не заходили SESSION_IDLE_DAYS дней) удаляется при первой попытке им войти, а до того не в счёт.
  for (const s of await store.adminSessions(iso(now.getTime() - SESSION_IDLE_DAYS * DAY))) device(s.user_id, clientOf(s), s.version, s.last_seen);
  // Ключ ПК из настроек сервера — отдельной строкой, не «ещё один вход программы».
  for (const d of desktopTokenSeen()) device(d.userId, "desktop-key", d.version, d.at);
  return [...who.values()].map((p) => {
    const s = stats.get(p.id);
    return {
      devices: [...(devices.get(p.id)?.values() ?? [])].sort((a, b) => b.last_seen.localeCompare(a.last_seen)),
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
  // Дорогие сообщения (этап 2): больше всего вызовов модели (messages.llm_calls, с шага 24) — кто, когда, ветка, без текста.
  // Цены у сообщения нет: журнал попыток (llm_calls) с сообщением не связан, а угадывать по человеку и времени — нечестно.
  const since = iso(now.getTime() - n * DAY);
  const heavy = (await store.adminHeavyMessages(since)).map((m) => ({
    name: who.get(m.user_id)?.name ?? `#${m.user_id}`, at: m.received_at, source: m.source, route: m.route, calls: m.llm_calls,
  }));
  return { ...report, byUser, forecast: (await forecast(store, now)).forecast, heavy, routes: await store.adminRoutes(since) };
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
  // Этап 2. Карта «день недели × час» за 28 дней: минуты с запросами, сложенные по всем людям (не по человеку; час — по поясу
  // каждого). Строки — пн…вс, столбцы — 0…23.
  const heat = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  for (const r of await store.adminPresenceHeat(addDays(t, -27))) {
    if (r.hour < 0 || r.hour > 23) continue;
    heat[(new Date(`${r.day}T00:00:00Z`).getUTCDay() + 6) % 7][r.hour] += r.minutes;
  }
  // Версии программы на ПК: входы за 30 дней по версии (пустая — старая программа без заголовка) + DESKTOP_TOKEN из памяти.
  const ver = new Map<string, { devices: number; users: Set<number> }>();
  const addVer = (v: string, id: number) => {
    const x = ver.get(v) ?? ver.set(v, { devices: 0, users: new Set() }).get(v)!;
    x.devices++;
    x.users.add(id);
  };
  const month = iso(now.getTime() - 30 * DAY);
  for (const s of await store.adminSessions(month)) if (DESKTOP_CLIENTS.includes(clientOf(s))) addVer(s.version, s.user_id);
  for (const d of desktopTokenSeen()) if (d.at >= month) addVer(d.version, d.userId);
  const versions = [...ver].map(([version, x]) => ({ version, devices: x.devices, users: x.users.size })).sort((a, b) => cmpVersion(a.version, b.version));
  const clients = await store.adminPresenceClients(addDays(t, -6));
  return { today: t, series, cohorts, gone, sources, heat, versions, clients };
}

/** Здоровье сервера (этап 2): ошибки и время ответа модели за сутки и 7 дней (журнал llm_calls — каждая попытка), сообщения
 *  в ошибке и в уточнении, просроченные напоминания (ждут дольше 2 минут — такт планировщика стоит), время работы и версия. */
export async function adminHealth(store: Store, now = new Date()) {
  const daySince = iso(now.getTime() - DAY);
  const week = iso(now.getTime() - 7 * DAY);
  const kinds = new Map<string, { kind: string; day: number; week: number; errors_day: number; errors_week: number }>();
  const errors: { kind: string; code: string; day: number; week: number }[] = [];
  for (const r of await store.adminLlmErrors(week, daySince)) {
    const k = kinds.get(r.kind) ?? kinds.set(r.kind, { kind: r.kind, day: 0, week: 0, errors_day: 0, errors_week: 0 }).get(r.kind)!;
    k.day += r.day;
    k.week += r.week;
    if (r.error_code) {
      k.errors_day += r.day;
      k.errors_week += r.week;
      errors.push({ kind: r.kind, code: r.error_code, day: r.day, week: r.week });
    }
  }
  // Время удачных ответов по моделям: p50 и p95 — в JS (в SQLite нет percentile_cont).
  const times = new Map<string, { day: number[]; week: number[] }>();
  for (const r of await store.adminLlmTimes(week)) {
    const t = times.get(r.model) ?? times.set(r.model, { day: [], week: [] }).get(r.model)!;
    t.week.push(r.ms);
    if (r.at >= daySince) t.day.push(r.ms);
  }
  const stat = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return { n: s.length, p50: quantile(s, 0.5), p95: quantile(s, 0.95) };
  };
  const models = [...times].map(([model, t]) => ({ model, day: stat(t.day), week: stat(t.week) })).sort((a, b) => b.week.n - a.week.n);
  return {
    kinds: [...kinds.values()].sort((a, b) => b.week - a.week),
    errors: errors.sort((a, b) => b.week - a.week),
    models,
    messages: await store.adminStuckMessages(daySince, CHAT_FAILED),
    reminders: await store.adminOverdueReminders(iso(now.getTime() - 2 * 60_000)),
    uptime_sec: Math.round(process.uptime()),
    version: process.env.MAID_VERSION || "—",
    built_at: process.env.BUILT_AT || "—",
  };
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
