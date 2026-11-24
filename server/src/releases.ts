import type { Store } from "./db.ts";
import { cmpVersion, crashShare } from "./crashes.ts";
import { addDays } from "./time.ts";

// Поэтапный выпуск программы на ПК (этап 5 «Тарифы и управление», 24.11.2026; макет — вкладка «Выпуски виджета»).
// electron-updater (desktop/src/updates.js) читает stagingPercentage из latest.yml и сравнивает его со своим stagingUserId — случайным
// UUID в userData/.updaterId: доля = последние 4 байта UUID / 0xffffffff, обновление видно, если доля < процент/100
// (node_modules/electron-updater/out/AppUpdater.js isStagingMatch). Поля нет или не число — обновление видят все; 0 — никто (пауза);
// 100 — все. Уже обновившиеся не откатываются: одинаковую версию electron-updater не ставит, а старее — только с allowDowngrade (у нас
// выключен), да и установщик на сервере лежит один, последний.
// Файл на диске не меняется: сервер при отдаче /desktop/latest.yml подставляет процент из настройки выпуска (kv «desktop:release»).
// Новая версия в latest.yml (не та, что в настройке) — сервер сам начинает выпуск: процент — из stagingPercentage файла (его пишет
// tools/release-desktop.py, по умолчанию 20) или RELEASE_START_PERCENT. Самая первая версия, которую сервер видит без настройки, считается
// уже выпущенной (100%) — иначе выкладка сервера с этой правкой вдруг закрыла бы обновление 80% людей.
// Процент, пауза и «продолжить» — в админке «Выпуски» с причиной (журнал админа). Автопауза — правило оповещений release_crash (alerts.ts).

export const RELEASE_KEY = "desktop:release";
export const RELEASE_START_PERCENT = 20;
/** Автопауза: людей с падением на новой версии — не меньше стольких (иначе «в 2 раза» от одного человека). */
export const RELEASE_CRASH_MIN_USERS = 3;
/** Окно сравнения долей падений новой и прошлой версии, дней. */
export const RELEASE_CRASH_DAYS = 7;
/** Сравнение с прошлой версией — только если на ней за окно было не меньше стольких людей (иначе 0 из 4 даёт «в бесконечность раз»). */
export const RELEASE_CRASH_MIN_PREV = 20;
/** Первая версия программы, которая шлёт падения (desktop/src/crashes.js): у версий старше падений нет вовсе — сравнивать не с чем.
 *  Копия — web/src/admin.ts. */
export const CRASH_FIRST_VERSION = "0.1.93";

export interface Release {
  version: string;
  /** Доля людей, которым видно обновление, 1…100 (на паузе хранится прежняя — «Продолжить» вернёт её). */
  percent: number;
  paused: boolean;
  started_at: string;
  /** Версия до этой (с ней сравниваются падения); пусто — неизвестно. */
  prev: string;
  /** Когда выпуск поставила на паузу автопауза (один раз на версию: после «Продолжить» сама больше не встаёт). */
  auto_paused_at: string | null;
  updated_at: string;
  /** Кто менял последним: #id админа, 0 — сервер сам. */
  by: number;
}

const VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,4}$/;
export class ReleaseError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Версия из latest.yml (строка «version: 1.2.3»); нет или не такого вида — null. */
export function ymlVersion(yml: string): string | null {
  const v = /^version:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(yml)?.[1] ?? "";
  return VERSION.test(v) ? v : null;
}
/** stagingPercentage из latest.yml (0…100) или null. */
export function ymlStaging(yml: string): number | null {
  const m = /^stagingPercentage:\s*(\d{1,3})\s*$/m.exec(yml);
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= 100 ? n : null;
}
/** latest.yml с нашим процентом: прежняя строка stagingPercentage убирается; null — без строки (обновление видят все). */
export function withStaging(yml: string, percent: number | null): string {
  let out = yml.replace(/^stagingPercentage:.*(?:\r?\n|$)/gm, "");
  if (percent == null) return out;
  if (out && !out.endsWith("\n")) out += "\n";
  return `${out}stagingPercentage: ${percent}\n`;
}
/** Какой процент отдать в latest.yml: пауза — 0, 100 — без строки, иначе процент. */
export const servedPercent = (r: Release | null): number | null => (!r ? null : r.paused ? 0 : r.percent >= 100 ? null : r.percent);

export async function readRelease(store: Pick<Store, "kvGet">): Promise<Release | null> {
  try {
    const r = JSON.parse((await store.kvGet(RELEASE_KEY)) ?? "null") as Release | null;
    return r && VERSION.test(r.version) ? r : null;
  } catch {
    return null;
  }
}
const saveRelease = (store: Pick<Store, "kvSet">, r: Release) => store.kvSet(RELEASE_KEY, JSON.stringify(r));

/** Настройка выпуска для версии из latest.yml: та же — как есть; другая — новый выпуск (с процентом из файла или по умолчанию);
 *  настройки нет — эта версия считается выпущенной (100%). Начало выпуска — в журнал админа от сервера (один раз на версию). */
export async function releaseFor(store: Store, yml: string, now = new Date()): Promise<Release | null> {
  const v = ymlVersion(yml);
  if (!v) return null;
  const cur = await readRelease(store);
  if (cur?.version === v) return cur;
  const first = !cur;
  const percent = first ? 100 : ymlStaging(yml) ?? RELEASE_START_PERCENT;
  // Прошлый выпуск не дошёл до всех (стоял на паузе или меньше 100%) — сравнивать с той, что была до него: иначе исправление
  // сравнивалось бы с плохой версией и автопауза для него фактически молчала.
  const prev = !cur ? "" : (cur.paused || cur.percent < 100) && cur.prev ? cur.prev : cur.version;
  const r: Release = {
    version: v, percent: percent === 0 ? RELEASE_START_PERCENT : percent, paused: !first && percent === 0, started_at: now.toISOString(), prev,
    auto_paused_at: null, updated_at: now.toISOString(), by: 0,
  };
  await saveRelease(store, r);
  if (await store.once(`release-start:${v}`)) {
    await store.addAdminLog(0, "release_start", first ? `${v}: первая известная версия — 100%` : `${v}: ${r.paused ? "на паузе" : `${r.percent}%`}, прошлая ${r.prev}`,
      now, first ? "сервер увидел версию без настройки выпуска" : "в latest.yml новая версия");
  }
  return r;
}

/** latest.yml для отдачи: процент из настройки выпуска подставлен (файл на диске тот же). */
export async function servedYml(store: Store, yml: string, now = new Date()): Promise<string> {
  const r = await releaseFor(store, yml, now);
  return r ? withStaging(yml, servedPercent(r)) : yml;
}

const reasonOf = (x: unknown) => {
  const s = typeof x === "string" ? x.trim() : "";
  if (s.length < 3) throw new ReleaseError(400, "напишите причину (хотя бы 3 знака)");
  if (s.length > 300) throw new ReleaseError(400, "причина — не длиннее 300 знаков");
  return s;
};

/** Изменить выпуск из админки: { version, percent? (1…100), paused? (да/нет), reason }. version — какой выпуск видел админ:
 *  вышла другая — 409 (иначе процент новой версии поставили бы, глядя на старую). В журнал — что было и стало. */
export async function changeRelease(store: Store, adminId: number, body: unknown, now = new Date()): Promise<Release> {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const reason = reasonOf(b.reason);
  const r = await readRelease(store);
  if (!r) throw new ReleaseError(404, "выпусков ещё не было: сервер не видел latest.yml");
  if (b.version !== r.version) throw new ReleaseError(409, `сейчас выпускается ${r.version} — обновите страницу`);
  const next = { ...r };
  const what: string[] = [];
  if ("percent" in b) {
    const p = b.percent;
    if (typeof p !== "number" || !Number.isInteger(p) || p < 1 || p > 100) throw new ReleaseError(400, "процент — целое от 1 до 100");
    if (p !== r.percent) { next.percent = p; what.push(`${r.percent}% → ${p}%`); }
  }
  if ("paused" in b) {
    if (typeof b.paused !== "boolean") throw new ReleaseError(400, "пауза — да или нет");
    if (b.paused !== r.paused) { next.paused = b.paused; what.push(b.paused ? "пауза" : "продолжен"); }
  }
  if (!what.length) throw new ReleaseError(400, "ничего не изменилось");
  next.updated_at = now.toISOString();
  next.by = adminId;
  await saveRelease(store, next);
  const action = "paused" in b && b.paused !== r.paused ? (next.paused ? "release_pause" : "release_resume") : "release_percent";
  await store.addAdminLog(adminId, action, `${r.version}: ${what.join("; ")}`, now, reason);
  return next;
}

/** Доли падений новой версии выпуска и прошлой за RELEASE_CRASH_DAYS дней (для автопаузы и раздела «Выпуски»). */
export async function releaseCrashes(store: Store, r: Release, now = new Date()) {
  const rows = await store.crashVersions(addDays(now.toISOString().slice(0, 10), -(RELEASE_CRASH_DAYS - 1)));
  const cur = rows.find((x) => x.version === r.version) ?? { version: r.version, active: 0, crashed: 0, crashes: 0 };
  const prev = r.prev ? rows.find((x) => x.version === r.prev) ?? { version: r.prev, active: 0, crashed: 0, crashes: 0 } : null;
  return { cur, prev, curShare: crashShare(cur), prevShare: prev ? crashShare(prev) : 0 };
}

/** Во сколько раз доля людей с падением новой версии больше, чем у прошлой; null — сравнивать нельзя (why — почему):
 *  no_prev — прошлой нет или на ней за окно никого; old_prev — прошлая не шлёт падений (старше CRASH_FIRST_VERSION);
 *  few_prev — на прошлой меньше RELEASE_CRASH_MIN_PREV людей; no_cur — на новой ещё никого. У прошлой 0 падений — её доля берётся
 *  не ниже 1/людей («хотя бы один упал бы»), а не 0 — иначе любая доля новой была бы «в бесконечность раз больше». */
export function crashRatio(cur: { active: number; crashed: number }, prev: { version: string; active: number; crashed: number } | null):
  { x: number | null; why: "ok" | "no_prev" | "old_prev" | "few_prev" | "no_cur" } {
  if (!prev || !prev.active) return { x: null, why: "no_prev" };
  if (cmpVersion(prev.version, CRASH_FIRST_VERSION) < 0) return { x: null, why: "old_prev" };
  if (prev.active < RELEASE_CRASH_MIN_PREV) return { x: null, why: "few_prev" };
  if (!cur.active) return { x: null, why: "no_cur" };
  return { x: crashShare(cur) / (Math.max(1, prev.crashed) / prev.active), why: "ok" };
}

/** Выпуск закончен: всем (100%, не на паузе) и идёт дольше окна сравнения — автопауза его уже не проверяет (на прошлой версии
 *  к этому времени почти никого не остаётся, сравнение теряет смысл). */
export const releaseDone = (r: Release, now = new Date()) =>
  !r.paused && r.percent >= 100 && now.getTime() - Date.parse(r.started_at) >= RELEASE_CRASH_DAYS * 86_400_000;

/** Автопауза (правило release_crash сработало): выпуск — на паузу, если он не на паузе и сама пауза ещё не вставала на этой версии.
 *  true — поставили сейчас. В журнал админа — от сервера, с цифрами. */
export async function autoPause(store: Store, why: string, now = new Date()): Promise<boolean> {
  const r = await readRelease(store);
  if (!r || r.paused || r.auto_paused_at) return false;
  await saveRelease(store, { ...r, paused: true, auto_paused_at: now.toISOString(), updated_at: now.toISOString(), by: 0 });
  await store.addAdminLog(0, "release_autopause", `${r.version}: ${r.percent}% → пауза`, now, why.slice(0, 300));
  return true;
}

/** Раздел «Выпуски»: настройка, что сейчас в latest.yml и что отдаётся, люди по версиям за 7 дней, доли падений новой и прошлой. */
export async function releasesView(store: Store, yml: string | null, now = new Date()) {
  const file = yml ? ymlVersion(yml) : null;
  const r = yml ? await releaseFor(store, yml, now) : await readRelease(store);
  const vers = (await store.crashVersions(addDays(now.toISOString().slice(0, 10), -6))).sort((a, b) => cmpVersion(b.version, a.version));
  const people = vers.reduce((s, v) => s + v.active, 0);
  const crash = r ? await releaseCrashes(store, r, now) : null;
  return {
    release: r, file_version: file, served: servedPercent(r), start_percent: RELEASE_START_PERCENT,
    min_users: RELEASE_CRASH_MIN_USERS, crash_days: RELEASE_CRASH_DAYS,
    versions: vers.map((v) => ({ version: v.version, active: v.active, share_people: people ? v.active / people : 0, crashed: v.crashed, crash_share: crashShare(v) })),
    crash: crash && { version: crash.cur.version, active: crash.cur.active, crashed: crash.cur.crashed, share: crash.curShare,
      prev: crash.prev && { version: crash.prev.version, active: crash.prev.active, crashed: crash.prev.crashed, share: crash.prevShare } },
  };
}
