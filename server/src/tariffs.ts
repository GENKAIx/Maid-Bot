import "./config.ts"; // .env — в process.env до чтения значений по умолчанию
import { accessOf, ownerIds } from "./access.ts";
import type { Store } from "./db.ts";

// Тарифы из базы (24.11.2026, этап 1 макета docs/review/тарифы-и-управление-макет-2026-11-24.html). Числа платного доступа —
// цена, сроки, регистрация, частота ИИ, денежные потолки, оценки цены — живут в таблице tariff_settings (шаг 30); нет строки —
// значение по умолчанию (tariffDefaults: прежние числа config.billing, SIGNUPS_OPEN и STAR_USD из .env). Все читают текущие
// значения одной функцией tariffs(): AiGate, Billing (цена счёта), signUp и redeemInvite, бот, планировщик, аналитика.
// Сервер перечитывает таблицу раз в TARIFF_RELOAD_MS (watchTariffs в index.ts) и сразу после «Применить» на этом процессе
// (чтение, начатое раньше, не перетирает более новое — счётчик поколений в loadTariffs). Изменения на процессе идут по одному
// (очередь saveLock): каждое читает числа заново и меняет только свои поля, поэтому два одновременных не откатывают друг друга.
// Каждое изменение — строка tariff_history (кто, когда, все числа до и после, причина) и запись в журнал админки (admin_log).
// Проверка чисел — checkTariffPatch по TARIFF_SPEC; копия один в один — web/src/tariffs.ts (тест tariffs.test.ts сверяет).

export const TARIFF_RELOAD_MS = 60_000;

export type TariffKey =
  | "price" | "trialDays" | "giftDays" | "signupsOpen" | "signupsPerHour" | "signupsPerDay" | "aiBurst" | "aiWindowMs"
  | "trialDayUsd" | "paidDayUsd" | "trialPoolDayUsd" | "unpricedDrawUsd" | "unpricedVoiceUsd" | "unpricedOtherUsd" | "starUsd";
export type TariffValues = { [K in TariffKey]: K extends "signupsOpen" ? boolean : number };
export type TariffSpec = { kind: "int" | "num" | "bool"; min?: number; max?: number };

/** Что можно менять и в каких границах: int — целое, num — дробное (не больше 4 знаков после запятой), bool — да/нет. */
export const TARIFF_SPEC: Record<TariffKey, TariffSpec> = {
  /** Цена подписки в звёздах (XTR) за месяц. Уже оформленную подписку Telegram продлевает по цене при оформлении. */
  price: { kind: "int", min: 1, max: 10_000 },
  /** Проба для каждого нового (/start в боте), дней. */
  trialDays: { kind: "int", min: 1, max: 365 },
  /** Подарок по /invite, дней. */
  giftDays: { kind: "int", min: 1, max: 365 },
  /** Регистрация незнакомцев (/start без приглашения); /signups off|on в боте пишет сюда же. SIGNUPS_OPEN=0 в .env закрывает
   *  поверх этого числа (signupsOpenNow). */
  signupsOpen: { kind: "bool" },
  /** Новых учётных записей за час и за сутки — на весь сервер. */
  signupsPerHour: { kind: "int", min: 1, max: 10_000 },
  signupsPerDay: { kind: "int", min: 1, max: 100_000 },
  /** Частота ИИ на человека (проба и подписка): не больше aiBurst вызовов за aiWindowMs (1…3600 с, в миллисекундах — целые секунды). */
  aiBurst: { kind: "int", min: 1, max: 1000 },
  aiWindowMs: { kind: "int", min: 1000, max: 3_600_000 },
  /** Потолок расхода ИИ на человека в день (UTC), доллары: проба и подписка; общий потолок всех проб за день. Ноль нельзя:
   *  AiGate сравнивает «расход ≥ потолка», 0 закрыл бы ИИ всем на плане (и подписчикам, которые уже заплатили), а не снял потолок. */
  trialDayUsd: { kind: "num", min: 0.01, max: 100 },
  paidDayUsd: { kind: "num", min: 0.01, max: 100 },
  trialPoolDayUsd: { kind: "num", min: 0.01, max: 100 },
  /** Цена вызова, если провайдер её не вернул (для потолков), доллары: рисунок, голос, остальное. */
  unpricedDrawUsd: { kind: "num", min: 0, max: 100 },
  unpricedVoiceUsd: { kind: "num", min: 0, max: 100 },
  unpricedOtherUsd: { kind: "num", min: 0, max: 100 },
  /** Сколько $ разработчик получает за 1 ⭐ (оценка) — только аналитика и экономика тарифа. */
  starUsd: { kind: "num", min: 0, max: 1 },
};
export const TARIFF_KEYS = Object.keys(TARIFF_SPEC) as TariffKey[];

/** Значения по умолчанию — прежние числа config.billing; STAR_USD из .env — значение по умолчанию курса. Регистрация по умолчанию
 *  открыта всегда (смысл строки tariff_settings не зависит от .env); SIGNUPS_OPEN=0 — аварийный выключатель поверх (signupsOpenNow). */
export function tariffDefaults(env: Record<string, string | undefined> = process.env): TariffValues {
  return {
    price: 150, trialDays: 7, giftDays: 30,
    signupsOpen: true,
    signupsPerHour: 30, signupsPerDay: 150,
    aiBurst: 10, aiWindowMs: 60_000,
    trialDayUsd: 0.3, paidDayUsd: 1.5, trialPoolDayUsd: 10,
    unpricedDrawUsd: 0.03, unpricedVoiceUsd: 0.005, unpricedOtherUsd: 0.003,
    starUsd: Number(env.STAR_USD?.trim() || "0.013") || 0.013,
  };
}

/** SIGNUPS_OPEN=0 в .env — регистрация закрыта, что бы ни стояло в тарифах (как до тарифов из базы). */
export const signupsEnvClosed = (env: Record<string, string | undefined> = process.env): boolean => (env.SIGNUPS_OPEN?.trim() || "1") === "0";

/** Одно значение: null — подходит, иначе почему нет (по-русски, для 400 и подсказки под полем). Та же проверка — web/src/tariffs.ts.
 *  Поле ищется только среди своих ключей TARIFF_SPEC: constructor, toString, __proto__ из прототипа — «неизвестное поле». */
export function checkTariffValue(key: string, v: unknown): string | null {
  const s = Object.hasOwn(TARIFF_SPEC, key) ? TARIFF_SPEC[key as TariffKey] : undefined;
  if (!s) return `неизвестное поле ${key}`;
  if (s.kind === "bool") return typeof v === "boolean" ? null : `${key}: нужно да или нет`;
  if (typeof v !== "number" || !Number.isFinite(v)) return `${key}: нужно число`;
  if (s.kind === "int" && !Number.isInteger(v)) return `${key}: нужно целое число`;
  if (s.kind === "num" && Math.abs(v * 1e4 - Math.round(v * 1e4)) > 1e-6) return `${key}: не больше 4 знаков после запятой`;
  if (key === "aiWindowMs" && v % 1000 !== 0) return `${key}: целые секунды`;
  if (s.min !== undefined && v < s.min) return `${key}: не меньше ${s.min}`;
  if (s.max !== undefined && v > s.max) return `${key}: не больше ${s.max}`;
  return null;
}

/** Набор изменений из запроса: объект с известными полями и годными значениями; иначе — текст ошибки (400). */
export function checkTariffPatch(raw: unknown): { ok: true; patch: Partial<TariffValues> } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "нужен объект с числами" };
  const keys = Object.keys(raw);
  if (!keys.length) return { ok: false, error: "нечего менять" };
  for (const k of keys) {
    const why = checkTariffValue(k, (raw as Record<string, unknown>)[k]);
    if (why) return { ok: false, error: why };
  }
  return { ok: true, patch: raw as Partial<TariffValues> };
}

// ——— Текущие значения процесса.
let live: TariffValues = tariffDefaults();
let loadedAt = -Infinity;
/** Поколения чтений: started — сколько начато, applied — номер последнего применённого. Ответ, начатый раньше применённого, — мимо. */
let started = 0, applied = 0;

/** Текущие числа тарифов (то, что действует сейчас на этом процессе). */
export const tariffs = (): Readonly<TariffValues> => live;
/** Открыта ли регистрация сейчас: тариф signupsOpen и не закрыто в .env (signUp, /signups в боте). */
export const signupsOpenNow = (): boolean => live.signupsOpen && !signupsEnvClosed();
/** Только для тестов: подставить числа без базы (до следующего loadTariffs). */
export function overrideTariffs(p: Partial<TariffValues>): void {
  live = { ...live, ...p };
}
/** Оценка цены вызова без цены от провайдера — для потолков (db.ts daySpend / trialsDaySpend). */
export const unpricedOf = (t: Readonly<TariffValues> = live) => ({ draw: t.unpricedDrawUsd, voice: t.unpricedVoiceUsd, other: t.unpricedOtherUsd });

/** Числа из строк tariff_settings поверх значений по умолчанию; битая или негодная строка — пропускается (в лог). */
function merge(rows: { key: string; value: string }[], base = tariffDefaults()): TariffValues {
  const out = { ...base } as Record<TariffKey, number | boolean>;
  for (const r of rows) {
    let v: unknown;
    try { v = JSON.parse(r.value); } catch { v = undefined; }
    if (checkTariffValue(r.key, v)) {
      console.error("[tariffs] пропущена строка", r.key);
      continue;
    }
    out[r.key as TariffKey] = v as number | boolean;
  }
  return out as TariffValues;
}

/** Перечитать таблицу сейчас. Чтение, начатое раньше уже применённого (фоновое перечитывание ушло до «Применить», а вернулось
 *  после), ничего не меняет: иначе старые числа вернулись бы на минуту. */
export async function loadTariffs(store: Store, now = Date.now()): Promise<Readonly<TariffValues>> {
  const my = ++started;
  const rows = await store.tariffSettings();
  if (my > applied) {
    applied = my;
    live = merge(rows);
    loadedAt = now;
  }
  return live;
}
/** Перечитать, если с прошлого чтения прошло TARIFF_RELOAD_MS; true — перечитали. */
export async function refreshTariffs(store: Store, now = Date.now()): Promise<boolean> {
  if (now - loadedAt < TARIFF_RELOAD_MS) return false;
  await loadTariffs(store, now);
  return true;
}
/** Перечитывать раз в минуту (index.ts). Возвращает «остановить». */
export function watchTariffs(store: Store, clock: () => number = Date.now): () => void {
  const t = setInterval(() => void refreshTariffs(store, clock()).catch((e) => console.error("[tariffs]", (e as Error).message)), TARIFF_RELOAD_MS / 4);
  t.unref?.();
  return () => clearInterval(t);
}

export class TariffError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export type TariffSource = "admin" | "undo" | "bot";
export interface TariffChange { key: TariffKey; from: number | boolean; to: number | boolean }

const changesOf = (before: TariffValues, after: TariffValues): TariffChange[] =>
  TARIFF_KEYS.filter((k) => before[k] !== after[k]).map((k) => ({ key: k, from: before[k], to: after[k] }));

/** Подпись для журнала админки (admin_log.detail, до 200 знаков): «price 150→200, trialDays 7→5». */
const changesText = (c: TariffChange[]) => c.map((x) => `${x.key} ${x.from}→${x.to}`).join(", ");

/** Изменения тарифов на этом процессе — по одному: следующее начинается, когда прошлое записано и перечитано. */
let saveLock: Promise<unknown> = Promise.resolve();
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const r = saveLock.then(fn, fn);
  saveLock = r.catch(() => {});
  return r;
}

/** Только поля TARIFF_SPEC (лишние ключи в запись и историю не попадают). */
const pick = (p: Partial<TariffValues>) => Object.fromEntries(TARIFF_KEYS.filter((k) => Object.hasOwn(p, k)).map((k) => [k, p[k]])) as Partial<TariffValues>;
const SAME = "ничего не меняется — значения те же";

/** Снимок всех чисел из before_json / after_json строки истории; битый — null. */
function snapshot(json: string): TariffValues | null {
  try {
    const o = JSON.parse(json) as unknown;
    if (!o || typeof o !== "object") return null;
    return merge(Object.entries(o as Record<string, unknown>).map(([key, v]) => ({ key, value: JSON.stringify(v) })));
  } catch {
    return null;
  }
}

/** Записать поля patch поверх чисел, прочитанных здесь же (под saveLock): в tariff_settings — отличные от значений по умолчанию
 *  (равные — строка убирается), строка истории, журнал админки (action), и сразу перечитать на этом процессе. Остальные поля не
 *  трогаются. Ничего не поменялось — null (без строки истории). */
function save(store: Store, by: number, patch: Partial<TariffValues>, reason: string, source: TariffSource, action: string, now: Date) {
  return locked(async () => {
    const before = merge(await store.tariffSettings());
    const next = { ...before, ...pick(patch) } as TariffValues;
    const changes = changesOf(before, next);
    if (!changes.length) return null;
    const defaults = tariffDefaults();
    const set = changes.map((c) => ({ key: c.key, value: defaults[c.key] === c.to ? null : JSON.stringify(c.to) }));
    const at = now.toISOString();
    const id = await store.saveTariffs(set, { at, user_id: by, source, before_json: JSON.stringify(before), after_json: JSON.stringify(next), reason });
    await store.addAdminLog(by, action, `#${id} ${changesText(changes)}`, now);
    await loadTariffs(store, now.getTime());
    return { id, changes, values: tariffs() };
  });
}

const needReason = (reason: unknown): string => {
  const r = typeof reason === "string" ? reason.trim() : "";
  if (r.length < 3) throw new TariffError(400, "напишите причину (хотя бы 3 знака)");
  if (r.length > 300) throw new TariffError(400, "причина — не длиннее 300 знаков");
  return r;
};

/** «Применить» в админке: patch — только меняемые поля (checkTariffPatch), причина обязательна. */
export async function applyTariffs(store: Store, by: number, patch: unknown, reason: unknown, now = new Date()) {
  const why = needReason(reason);
  const p = checkTariffPatch(patch);
  if (!p.ok) throw new TariffError(400, p.error);
  const r = await save(store, by, p.patch, why, "admin", "tariff", now);
  if (!r) throw new TariffError(400, SAME);
  return r;
}

/** Самый большой номер строки истории: id в Postgres — INTEGER (int4), больше — ошибка базы, а не «нет записи». */
const MAX_HISTORY_ID = 2_147_483_647;

/** «Вернуть как было»: поля, которые поменяла запись истории id, — как до неё (from из её before_json); поля, которые она не
 *  трогала, остаются как сейчас (более поздние правки других полей не отменяются). Причина обязательна. */
export async function undoTariff(store: Store, by: number, id: unknown, reason: unknown, now = new Date()) {
  const why = needReason(reason);
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0 || id > MAX_HISTORY_ID) throw new TariffError(400, "нужен номер записи истории");
  const row = await store.tariffHistoryRow(id);
  if (!row) throw new TariffError(404, "нет такой записи истории");
  const b = snapshot(row.before_json), a = snapshot(row.after_json);
  const own = b && a ? changesOf(b, a) : [];
  if (!own.length) throw new TariffError(400, "в этой записи ничего не менялось");
  const back = Object.fromEntries(own.map((c) => [c.key, c.from])) as Partial<TariffValues>;
  const r = await save(store, by, back, `откат #${id}: ${why}`, "undo", "tariff_undo", now);
  if (!r) throw new TariffError(400, `${SAME} (уже как до #${id})`);
  return r;
}

/** /signups on|off в боте: тот же выключатель signupsOpen, с историей (source bot). by — запись владельца (0 — без записи).
 *  Уже так — null. */
export function setSignupsOpen(store: Store, by: number, open: boolean, now = new Date()) {
  return save(store, by, { signupsOpen: open }, open ? "/signups on в боте" : "/signups off в боте", "bot", "tariff", now);
}

// ——— Что показать в админке (GET /api/admin/tariffs): только числа и номера аккаунтов, без имён и текстов людей.

const DAY = 86_400_000;
/** Экономика тарифа за 30 дней по llm_usage у тех, кто сейчас на этом плане (accessOf: срок идёт, без владельцев) — те же люди и
 *  в расходе, и в числе людей: среднее и худшее на человека, дни у денежного потолка.
 *  Нет людей или расхода — null (на сайте «—», ничего не выдумываем). Подарок по /invite хранится как проба — в trial. */
export interface PlanEconomy { people: number; spenders: number; avg_month_usd: number | null; worst_month_usd: number | null; worst_day_usd: number | null; capped_days: number }

export async function tariffsView(store: Store, now = new Date()) {
  const t = tariffs();
  const est = unpricedOf(t);
  const today = now.toISOString().slice(0, 10);
  const since = new Date(now.getTime() - 29 * DAY).toISOString().slice(0, 10);
  const owners = ownerIds();
  const ids = { trial: new Set<number>(), paid: new Set<number>() };
  for (const u of await store.users()) {
    const a = accessOf(u, now, owners);
    if (a.plan === "trial" || a.plan === "paid") ids[a.plan].add(u.id);
  }
  const people = { trial: ids.trial.size, paid: ids.paid.size };
  const rows = await store.planDaySpend(since, ["trial", "paid"], est);
  const economy = (plan: "trial" | "paid"): PlanEconomy => {
    // Только те, кого посчитали в people: кончившийся срок с прежним plan в базе и владельцы в расход не попадают.
    const mine = rows.filter((r) => ids[plan].has(r.user_id));
    const cap = (plan === "paid" ? t.paidDayUsd : t.trialDayUsd) * 1e6;
    const byUser = new Map<number, number>();
    for (const r of mine) byUser.set(r.user_id, (byUser.get(r.user_id) ?? 0) + r.micro);
    const n = people[plan];
    const sum = [...byUser.values()].reduce((s, v) => s + v, 0);
    return {
      people: n, spenders: byUser.size,
      avg_month_usd: n && mine.length ? sum / n / 1e6 : null,
      worst_month_usd: byUser.size ? Math.max(...byUser.values()) / 1e6 : null,
      worst_day_usd: mine.length ? Math.max(...mine.map((r) => r.micro)) / 1e6 : null,
      capped_days: mine.filter((r) => r.micro >= cap).length,
    };
  };
  const history = (await store.tariffHistory(50)).map((h) => {
    const b = snapshot(h.before_json), a = snapshot(h.after_json); // битая — без изменений
    return { id: h.id, at: h.at, who: h.user_id ? `#${h.user_id}` : "владелец (бот)", source: h.source, reason: h.reason, changes: b && a ? changesOf(b, a) : [] };
  });
  return {
    values: t,
    defaults: tariffDefaults(),
    overridden: (await store.tariffSettings()).map((r) => r.key),
    reload_ms: TARIFF_RELOAD_MS,
    /** SIGNUPS_OPEN=0 в .env: регистрация закрыта поверх тарифа (на сайте — предупреждение). */
    env_closed: signupsEnvClosed(),
    history,
    economy: { trial: economy("trial"), paid: economy("paid") },
    now: {
      trial_pool_today_usd: await store.trialsDaySpend(today, est),
      signups_hour: await store.countUsersSince(new Date(now.getTime() - 3600_000).toISOString()),
      signups_day: await store.countUsersSince(new Date(now.getTime() - DAY).toISOString()),
    },
  };
}
