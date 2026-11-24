import type { CrashEventRow, Store, User } from "./db.ts";
import { addDays, dayKey } from "./time.ts";

// Падения программы на ПК (этап 5 «Тарифы и управление», 24.11.2026; макет docs/review/тарифы-и-управление-макет-2026-11-24.html,
// вкладка «Падения»). Программа (desktop/src/crashes.js) ловит ошибки главного процесса и окон, склеивает одинаковые и раз в 10 минут
// шлёт пачку на POST /api/events/crash: только тип ошибки (имя класса или причина падения процесса), место в коде (файл:строка:столбец
// внутри программы, без путей ПК), версию, процесс, отпечаток сообщения (12 знаков хеша — само сообщение не уходит) и сколько раз.
// Сервер берёт только эти поля и по белому списку (crashItem); незнакомое молча отбрасывается. Пишется в crash_events (день × версия ×
// процесс × тип × место × отпечаток → раз и людей) и в desktop_days (человек × день × версия → сколько падений) — из второй и доля людей
// с падением по версии. Все дни — по поясу человека, хранение 90 дней (db.ts pruneStats).

/** Процессы программы: главный, окна (виджет, быстрая запись, главное окно) и служебные Chromium (видеочасть, прочие). */
export const CRASH_PROCESSES = ["main", "widget", "quick", "window", "gpu", "utility", "child"] as const;
/** Пачка — не больше стольких записей (больше — 400); счёт записи — 1…CRASH_MAX_COUNT (больше — срезается). */
export const CRASH_MAX_ITEMS = 50;
export const CRASH_MAX_COUNT = 1000;
/** Пачка от человека — не чаще раза в столько (чаще — 429; программа оставит записи у себя и пришлёт со следующей). */
export const CRASH_BATCH_MS = 60_000;
/** Новых строк crash_events (день × версия × процесс × тип × место × отпечаток) от человека за день — не больше стольких; дальше
 *  новые места отбрасываются (уже виденные считаются). Иначе один ключ мог бы слать по 50 новых мест в минуту. */
export const CRASH_DAY_KEYS = 200;
/** Версий программы у человека за день (desktop_days) — не больше стольких: обновление за день даёт 2, больше — подделка. */
export const DESKTOP_DAY_VERSIONS = 3;

const VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,4}$/;
/** Имя класса ошибки (TypeError) или причина падения процесса Electron (crashed, oom, launch-failed). */
const KIND = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
/** Место: «-» (не нашлось кадра программы) или src/… | renderer/… : строка : столбец — путь внутри программы, без диска и папок ПК. */
const PLACE = /^(?:-|(?:src|renderer)(?:\/[A-Za-z0-9_.-]{1,60}){1,4}:\d{1,6}:\d{1,6})$/;
/** Отпечаток сообщения: 12 знаков sha256 нормализованного текста или пусто. */
const FP = /^(?:[0-9a-f]{12})?$/;

export interface CrashItem { version: string; process: string; kind: string; place: string; fingerprint: string; count: number }

/** Запись пачки → чистая запись или null (что-то не по белому списку). Лишние поля (например, сообщение) не берутся вовсе. */
export function crashItem(x: unknown): CrashItem | null {
  if (!x || typeof x !== "object" || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const version = str(o.version), process = str(o.process), kind = str(o.kind), place = str(o.place), fingerprint = str(o.fp);
  if (!VERSION.test(version) || !(CRASH_PROCESSES as readonly string[]).includes(process) || !KIND.test(kind)) return null;
  if (place.length > 120 || !PLACE.test(place) || place.includes("..") || !FP.test(fingerprint)) return null;
  const n = Math.floor(Number(o.count));
  if (!(n >= 1)) return null;
  return { version, process, kind, place, fingerprint, count: Math.min(CRASH_MAX_COUNT, n) };
}

/** Версия годится в счёт: по виду 1.2.3 и не новее выпущенной (max — версия из latest.yml; null — файла нет, сравнивать не с чем). */
export const versionOk = (v: string, max: string | null) => VERSION.test(v) && (!max || cmpVersion(v, max) <= 0);

/** Человек × день → версии и сколько новых строк падений: пределы DESKTOP_DAY_VERSIONS и CRASH_DAY_KEYS. Память — до перезапуска. */
const dayUse = new Map<string, { versions: Set<string>; keys: number }>();
function useOf(userId: number, day: string) {
  const k = `${userId}\t${day}`;
  let x = dayUse.get(k);
  if (!x) {
    if (dayUse.size > 50_000) dayUse.clear();
    dayUse.set(k, (x = { versions: new Set(), keys: 0 }));
  }
  return x;
}
/** Можно ли отметить ещё эту версию у человека за день (уже отмеченная — можно всегда). */
function versionSlot(userId: number, day: string, version: string): boolean {
  const x = useOf(userId, day);
  if (x.versions.has(version)) return true;
  if (x.versions.size >= DESKTOP_DAY_VERSIONS) return false;
  x.versions.add(version);
  return true;
}

const lastBatch = new Map<number, number>();
/** Кто уже в счёте users за день по ключу: человек одной строки за день считается один раз. Память — до перезапуска сервера
 *  (после перезапуска тот же человек в тот же день может посчитаться ещё раз — редкий лишний счёт). */
const seenToday = new Set<string>();
const SEEN_MAX = 200_000;

export type CrashResult = { ok: true; accepted: number; dropped: number } | { ok: false; wait: number };

/** Пачка падений от человека: не чаще CRASH_BATCH_MS, записи — по белому списку; в базу — сразу (пачки редкие).
 *  maxVersion — выпущенная версия (latest.yml): записи новее неё отбрасываются; ещё отбрасываются версии сверх DESKTOP_DAY_VERSIONS
 *  за день и новые места сверх CRASH_DAY_KEYS за день. */
export async function acceptCrashes(store: Store, u: Pick<User, "id" | "tz">, items: unknown[], now = Date.now(), maxVersion: string | null = null): Promise<CrashResult> {
  const last = lastBatch.get(u.id);
  if (last !== undefined && now - last < CRASH_BATCH_MS) return { ok: false, wait: Math.ceil((CRASH_BATCH_MS - (now - last)) / 1000) };
  lastBatch.set(u.id, now);
  if (lastBatch.size > 5_000) for (const [k, t] of lastBatch) if (now - t >= CRASH_BATCH_MS) lastBatch.delete(k);
  if (seenToday.size > SEEN_MAX) seenToday.clear();
  const day = dayKey(new Date(now), u.tz);
  const rows = new Map<string, CrashEventRow>();
  const perVersion = new Map<string, number>();
  let dropped = 0;
  for (const x of items) {
    const it = crashItem(x);
    if (!it || !versionOk(it.version, maxVersion) || !versionSlot(u.id, day, it.version)) { dropped++; continue; }
    const key = [day, it.version, it.process, it.kind, it.place, it.fingerprint].join("\t");
    const who = `${key}\t${u.id}`;
    if (!seenToday.has(who)) {
      const use = useOf(u.id, day);
      if (use.keys >= CRASH_DAY_KEYS) { dropped++; continue; }
      use.keys++;
    }
    const row = rows.get(key) ?? { day_key: day, version: it.version, process: it.process, kind: it.kind, place: it.place, fingerprint: it.fingerprint, count: 0, users: 0 };
    row.count = Math.min(CRASH_MAX_COUNT, row.count + it.count);
    if (!seenToday.has(who)) { seenToday.add(who); row.users = 1; }
    rows.set(key, row);
    perVersion.set(it.version, (perVersion.get(it.version) ?? 0) + it.count);
  }
  await store.addCrashEvents([...rows.values()]);
  for (const [v, n] of perVersion) await store.markDesktopDay(u.id, day, v, Math.min(CRASH_MAX_COUNT, n));
  return { ok: true, accepted: items.length - dropped, dropped };
}

/** Человек пришёл с программой на ПК этой версии: отметка «был в этот день с этой версией» — не чаще раза в день на версию.
 *  Версия новее выпущенной (maxVersion) и версии сверх DESKTOP_DAY_VERSIONS за день не отмечаются. */
const daySeen = new Map<string, string>();
export async function noteDesktopDay(store: Store, u: Pick<User, "id" | "tz">, version: string, at = new Date(), maxVersion: string | null = null) {
  if (!versionOk(version, maxVersion)) return;
  const day = dayKey(at, u.tz);
  const k = `${u.id}\t${version}`;
  if (daySeen.get(k) === day) return;
  if (!versionSlot(u.id, day, version)) return;
  daySeen.set(k, day);
  if (daySeen.size > 50_000) daySeen.clear();
  await store.markDesktopDay(u.id, day, version, 0).catch((e) => console.error("[desktop-days]", e));
}

/** Для тестов: забыть ограничитель и отметки. */
export function resetCrashes() {
  lastBatch.clear();
  seenToday.clear();
  daySeen.clear();
  dayUse.clear();
}

/** Сравнение версий 1.2.3: <0 — a старше. */
export function cmpVersion(a: string, b: string): number {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

/** Доля людей с падением (0…1); нет людей — 0. */
export const crashShare = (v: { active: number; crashed: number } | undefined) => (v && v.active ? v.crashed / v.active : 0);

/** Раздел «Падения»: по версиям (новые сверху) — людей, с падением, доля, сравнение с прошлой версией, топ мест; график по дням.
 *  Только числа; места — внутри программы, без текста ошибок. days — окно (по поясу людей). */
export async function adminCrashes(store: Store, days = 30, now = new Date()) {
  const d = Math.min(90, Math.max(1, Math.floor(days) || 30));
  const today = now.toISOString().slice(0, 10);
  const from = addDays(today, -(d - 1));
  const vers = (await store.crashVersions(from)).sort((a, b) => cmpVersion(b.version, a.version));
  const all = await store.crashPlaces(addDays(today, -89)); // за всё хранимое — только «новое в этой версии»
  const firstOf = new Map<string, string>(); // место (без версии) → самая старая версия, где оно было
  for (const p of all) {
    const k = [p.process, p.kind, p.place, p.fingerprint].join("\t");
    const was = firstOf.get(k);
    if (!was || cmpVersion(p.version, was) < 0) firstOf.set(k, p.version);
  }
  const firstDay = new Map(all.map((p) => [[p.version, p.process, p.kind, p.place, p.fingerprint].join("|"), p.first])); // «впервые» — за 90 дней
  // Числа и порядок топа — за выбранный срок (а не за 90 дней): иначе старые падения места раздували бы его счёт в коротком окне.
  const inWindow = await store.crashPlaces(from);
  const versions = vers.map((v, i) => {
    const prev = vers[i + 1];
    const top = inWindow.filter((p) => p.version === v.version).slice(0, 10).map((p) => ({
      process: p.process, kind: p.kind, place: p.place, fingerprint: p.fingerprint, count: p.count, users: p.users,
      first: firstDay.get([p.version, p.process, p.kind, p.place, p.fingerprint].join("|")) ?? p.first, last: p.last,
      fresh: firstOf.get([p.process, p.kind, p.place, p.fingerprint].join("\t")) === v.version && Boolean(prev),
    }));
    return {
      version: v.version, active: v.active, crashed: v.crashed, crashes: v.crashes, share: crashShare(v),
      prev: prev ? { version: prev.version, active: prev.active, crashed: prev.crashed, share: crashShare(prev) } : null,
      top,
    };
  });
  const byDay = new Map((await store.crashDays(from)).map((x) => [x.day, x]));
  const series: { day: string; active: number; crashed: number; crashes: number }[] = [];
  for (let i = 0; i < d; i++) {
    const day = addDays(from, i);
    series.push(byDay.get(day) ?? { day, active: 0, crashed: 0, crashes: 0 });
  }
  return { days: d, from, versions, series, keep_days: 90 };
}
