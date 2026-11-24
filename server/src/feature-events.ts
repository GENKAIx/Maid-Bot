import type { Store, User } from "./db.ts";
import { familyOf } from "./auth.ts";
import { CLIENT_FEATURES, FEATURE_IDS } from "./feature-list.ts";
import { dayKey } from "./time.ts";

// Счётчики фич (этап 3 админки, таблица feature_events): человек × день (по его поясу) × клиент × фича → сколько раз.
// Без текстов. Всё копится в памяти и пишется в базу пачкой не чаще раза в минуту (flushFeatures — такт планировщика,
// index.ts) и при остановке сервера: запись на каждый запрос SQLite (синхронный) не тянет. Упал процесс — теряется
// не больше минуты счётчиков. Сервер считает сам то, что видит (ручки API, команды бота, ветки разбора), клиенты присылают
// остальное пачкой (POST /api/events/usage, acceptUsage).

/** Клиенты в счётчиках: сайт, программа на ПК (виджет и быстрая запись — её окна), айфон, бот, список-виджет Telegram, push. */
export const FEATURE_CLIENTS = ["web", "desktop", "iphone", "telegram", "telegram-widget", "push", "other"];
/** Клиент из заголовка X-Maid-Client (уже по белому списку, auth.ts clientMeta) → клиент счётчика; пусто — «other». */
export const featureClient = (client: string) => {
  const c = familyOf(client);
  return FEATURE_CLIENTS.includes(c) ? c : "other";
};
/** Какие клиенты могут присылать пачки сами (бот, push и список-виджет Telegram считает только сервер). */
const BATCH_CLIENTS = ["web", "desktop", "iphone"];

/** Ключей в памяти не больше стольких (сотни фич × люди × клиенты — с запасом); сверх — новые ключи до записи не берутся. */
const PENDING_MAX = 20_000;
const pending = new Map<string, number>();
const keyOf = (userId: number, day: string, client: string, feature: string) => `${userId}\t${day}\t${client}\t${feature}`;

/** Ещё n использований фичи (имя — из белого списка feature-list.ts, иначе ничего). День — по поясу человека. */
export function countFeature(u: Pick<User, "id" | "tz">, client: string, feature: string, n = 1, at = new Date()) {
  if (!FEATURE_IDS.has(feature) || !(n >= 1)) return;
  const key = keyOf(u.id, dayKey(at, u.tz), featureClient(client), feature);
  if (!pending.has(key) && pending.size >= PENDING_MAX) return;
  pending.set(key, (pending.get(key) ?? 0) + Math.floor(n));
}

/** Выбор характера Рины (бот — кнопка, сайт — POST /api/settings с другим характером): onboarding.persona — каждый выбор,
 *  onboarding.persona.first — первый у человека (отметка kv «persona-first:<id>», не чистится). Кто выбирал до 24.11.2026 (до
 *  счётчика), у того первым посчитается первый выбор после. */
export async function countPersona(store: Pick<Store, "once">, u: Pick<User, "id" | "tz">, client: string, at = new Date()) {
  countFeature(u, client, "onboarding.persona", 1, at);
  if (await store.once(`persona-first:${u.id}`)) countFeature(u, client, "onboarding.persona.first", 1, at);
}

/** Пачка от клиента: не чаще раза в USAGE_BATCH_MS на человека и клиента (чаще — 429, клиент оставляет счёт у себя и пришлёт
 *  со следующей пачкой); фич в пачке — до USAGE_MAX_KEYS (больше — 400); счёт фичи — 1…USAGE_MAX_COUNT (больше — срезается).
 *  Незнакомые имена и те, что сервер считает сам, отбрасываются молча (старый клиент не должен падать). */
export const USAGE_BATCH_MS = 60_000;
export const USAGE_MAX_KEYS = 100;
export const USAGE_MAX_COUNT = 500;
/** Из пачек за день у человека одной фичи берётся не больше стольких (все клиенты вместе): скрипт с ключом, шлющий пачки
 *  от разных клиентов, не раздует «раз» в отчёте. Память — до перезапуска сервера; сверх — срезается молча. */
export const USAGE_DAY_MAX = 2000;
const lastBatch = new Map<string, number>();
const dayUsed = new Map<string, number>(); // человек \t день \t фича → сколько принято из пачек

export type UsageResult = { ok: true; accepted: number; dropped: number } | { ok: false; wait: number };
export function acceptUsage(u: Pick<User, "id" | "tz">, client: string, counts: Record<string, number>, now = Date.now()): UsageResult {
  const c = featureClient(client);
  const from = BATCH_CLIENTS.includes(c) ? c : "other";
  const k = `${u.id} ${from}`;
  const last = lastBatch.get(k);
  if (last !== undefined && now - last < USAGE_BATCH_MS) return { ok: false, wait: Math.ceil((USAGE_BATCH_MS - (now - last)) / 1000) };
  lastBatch.set(k, now);
  if (lastBatch.size > 5_000) for (const [x, t] of lastBatch) if (now - t >= USAGE_BATCH_MS) lastBatch.delete(x);
  const day = dayKey(new Date(now), u.tz);
  if (dayUsed.size > 50_000) {
    const old = dayKey(new Date(now - 36 * 3600_000), "UTC"); // старше вчерашнего в любом поясе
    for (const x of dayUsed.keys()) if (x.split("\t")[1] < old) dayUsed.delete(x);
  }
  let accepted = 0, dropped = 0;
  for (const [feature, n] of Object.entries(counts)) {
    const dk = `${u.id}\t${day}\t${feature}`;
    const used = dayUsed.get(dk) ?? 0;
    const v = Math.min(USAGE_MAX_COUNT, USAGE_DAY_MAX - used, Math.floor(Number(n)));
    if (!CLIENT_FEATURES.has(feature) || !(v >= 1)) { dropped++; continue; }
    dayUsed.set(dk, used + v);
    countFeature(u, from, feature, v, new Date(now));
    accepted++;
  }
  return { ok: true, accepted, dropped };
}

/** Пачку из памяти — в базу, если с прошлой записи прошла минута (force — сразу: остановка сервера, тесты). Не записалось —
 *  счёт возвращается в память до следующего раза. Возвращает, сколько строк записано. */
export const FEATURE_FLUSH_MS = 60_000;
let lastFlush = -Infinity;
export async function flushFeatures(store: Store, now = Date.now(), force = false): Promise<number> {
  if (!pending.size || (!force && now - lastFlush < FEATURE_FLUSH_MS)) return 0;
  lastFlush = now;
  const rows = [...pending].map(([k, count]) => {
    const [user_id, day_key, client, feature] = k.split("\t");
    return { user_id: Number(user_id), day_key, client, feature, count };
  });
  pending.clear();
  try {
    await store.addFeatureCounts(rows);
  } catch (e) {
    for (const r of rows) {
      const key = keyOf(r.user_id, r.day_key, r.client, r.feature);
      pending.set(key, (pending.get(key) ?? 0) + r.count);
    }
    throw e;
  }
  return rows.length;
}

/** Аккаунт удалён (admin-account.ts): его счёт из памяти не пишется в базу (иначе flushFeatures вернул бы строки удалённого), и
 *  ограничители пачек — забыть. */
export function forgetFeatureUser(userId: number) {
  for (const k of pending.keys()) if (k.startsWith(`${userId}	`)) pending.delete(k);
  for (const k of lastBatch.keys()) if (k.startsWith(`${userId} `)) lastBatch.delete(k);
  for (const k of dayUsed.keys()) if (k.startsWith(`${userId}	`)) dayUsed.delete(k);
}

/** Для тестов: забыть память счётчиков и ограничителя. */
export function resetFeatureEvents() {
  pending.clear();
  lastBatch.clear();
  dayUsed.clear();
  lastFlush = -Infinity;
}
