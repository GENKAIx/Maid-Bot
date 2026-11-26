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
// tools/release-desktop.py: по умолчанию 100 — сразу всем, поэтапно — только с --percent=N) или RELEASE_START_PERCENT (тоже 100: решение
// владельца 26.11.2026 — «делай всегда для 100%, если я не прошу об обратном»). Самая первая версия, которую сервер видит без настройки,
// тоже считается выпущенной (100%).
// «Что нового» (26.11.2026): у выпуска — короткий список пунктов для владельца. tools/release-desktop.py кладёт рядом с latest.yml файл
// notes-<версия>.json ({ version, notes }); сервер, впервые увидев версию, переносит пункты в историю (kv «desktop:release-notes», последние
// RELEASE_NOTES_KEEP). Правка — в админке «Выпуски» с причиной (журнал release_notes). Пока истории в базе нет — она начинается с NOTES_SEED.
// Процент, пауза и «продолжить» — в админке «Выпуски» с причиной (журнал админа). Автопауза — правило оповещений release_crash (alerts.ts).

export const RELEASE_KEY = "desktop:release";
export const RELEASE_START_PERCENT = 100;
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

/** Пункты «что нового» из notes-<версия>.json рядом с latest.yml (api.ts читает файл); нет файла — null. */
export type NotesOf = (version: string) => Promise<string[] | null>;

/** Настройка выпуска для версии из latest.yml: та же — как есть; другая — новый выпуск (с процентом из файла или по умолчанию — 100%);
 *  настройки нет — эта версия считается выпущенной (100%). Начало выпуска — в журнал админа от сервера (один раз на версию);
 *  пункты «что нового» новой версии (notesOf) — в историю выпусков. */
export async function releaseFor(store: Store, yml: string, now = new Date(), notesOf?: NotesOf): Promise<Release | null> {
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
  await noteRelease(store, v, (await notesOf?.(v).catch(() => null)) ?? [], now);
  if (await store.once(`release-start:${v}`)) {
    await store.addAdminLog(0, "release_start", first ? `${v}: первая известная версия — 100%` : `${v}: ${r.paused ? "на паузе" : `${r.percent}%`}, прошлая ${r.prev}`,
      now, first ? "сервер увидел версию без настройки выпуска" : "в latest.yml новая версия");
  }
  return r;
}

/** latest.yml для отдачи: процент из настройки выпуска подставлен (файл на диске тот же). */
export async function servedYml(store: Store, yml: string, now = new Date(), notesOf?: NotesOf): Promise<string> {
  const r = await releaseFor(store, yml, now, notesOf);
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
export async function releasesView(store: Store, yml: string | null, now = new Date(), notesOf?: NotesOf) {
  const file = yml ? ymlVersion(yml) : null;
  const r = yml ? await releaseFor(store, yml, now, notesOf) : await readRelease(store);
  // Файл заметок мог лечь позже latest.yml — пустые пункты выпускаемой версии дозаполняются из файла, пока их никто не правил.
  if (r && notesOf) {
    const have = (await readNotes(store)).find((x) => x.version === r.version);
    if (!have || (!have.notes.length && !have.edited_at)) {
      const notes = await notesOf(r.version).catch(() => null);
      if (notes?.length || !have) await noteRelease(store, r.version, notes ?? [], new Date(r.started_at));
    }
  }
  const vers = (await store.crashVersions(addDays(now.toISOString().slice(0, 10), -6))).sort((a, b) => cmpVersion(b.version, a.version));
  const people = vers.reduce((s, v) => s + v.active, 0);
  const crash = r ? await releaseCrashes(store, r, now) : null;
  return {
    release: r, file_version: file, served: servedPercent(r), start_percent: RELEASE_START_PERCENT,
    notes: await readNotes(store), notes_max_items: NOTES_MAX_ITEMS, notes_max_len: NOTE_MAX_LEN,
    min_users: RELEASE_CRASH_MIN_USERS, crash_days: RELEASE_CRASH_DAYS,
    versions: vers.map((v) => ({ version: v.version, active: v.active, share_people: people ? v.active / people : 0, crashed: v.crashed, crash_share: crashShare(v) })),
    crash: crash && { version: crash.cur.version, active: crash.cur.active, crashed: crash.cur.crashed, share: crash.curShare,
      prev: crash.prev && { version: crash.prev.version, active: crash.prev.active, crashed: crash.prev.crashed, share: crash.prevShare } },
  };
}

// ——— «Что нового» в выпуске (26.11.2026).

export const RELEASE_NOTES_KEY = "desktop:release-notes";
/** Сколько выпусков хранится в истории (старые уходят). */
export const RELEASE_NOTES_KEEP = 30;
/** Пунктов у выпуска — не больше (советуем 3–7). Копии — web/src/admin.ts и tools/release-desktop.py. */
export const NOTES_MAX_ITEMS = 12;
/** Длина пункта, знаков. */
export const NOTE_MAX_LEN = 200;

export interface ReleaseNotes {
  version: string;
  /** Когда сервер впервые увидел версию (ISO). */
  date: string;
  notes: string[];
  /** Когда пункты правили в админке; null — как пришли с выпуском. */
  edited_at: string | null;
  /** Кто правил последним: #id админа, 0 — пришли с выпуском. */
  by: number;
}

/** Уже вышедшие версии, у которых файла заметок не было (выпуски до 26.11.2026): пока истории в базе нет, она начинается с них. */
export const NOTES_SEED: readonly ReleaseNotes[] = [
  {
    version: "0.1.94", date: "2026-11-26T15:03:16.000Z", edited_at: null, by: 0,
    notes: [
      "Плашки задач под ответом горничной больше не шире самого сообщения.",
      "Когда горничная пишет, что задача «уже в списке», рядом стрелка «↗» — щелчок открывает эту задачу.",
      "Окошко «Сегодня» больше не прыгает, когда на него наводишь мышь.",
    ],
  },
  {
    version: "0.1.93", date: "2026-11-24T19:50:35.000Z", edited_at: null, by: 0,
    notes: [
      "Программа сама сообщает о падениях: только тип ошибки и место в коде, без текстов и путей с компьютера.",
      "Обновления можно выпускать поэтапно: сначала части людей, с паузой, если новая версия падает чаще.",
    ],
  },
];

const HTML_TAG = /<[a-z!/?]/i;
/** Пункты «что нового»: строки обрезаются, «- »/«• »/«* » в начале убираются, пустые выбрасываются. Ошибка — текстом:
 *  больше NOTES_MAX_ITEMS пунктов, пункт длиннее NOTE_MAX_LEN, похоже на HTML. */
export function cleanNotes(x: unknown): { notes: string[]; error: string | null } {
  const raw = Array.isArray(x) ? x : typeof x === "string" ? x.split(/\r?\n/) : null;
  if (!raw || raw.some((n) => typeof n !== "string")) return { notes: [], error: "пункты — список строк" };
  const notes = (raw as string[]).map((n) => n.replace(/^\s*(?:[-•*]\s+)?/, "").trim()).filter(Boolean);
  if (notes.length > NOTES_MAX_ITEMS) return { notes, error: `пунктов — не больше ${NOTES_MAX_ITEMS}` };
  const long = notes.findIndex((n) => n.length > NOTE_MAX_LEN);
  if (long >= 0) return { notes, error: `пункт ${long + 1} длиннее ${NOTE_MAX_LEN} знаков` };
  if (notes.some((n) => HTML_TAG.test(n))) return { notes, error: "без HTML: только простой текст" };
  return { notes, error: null };
}

/** Содержимое notes-<версия>.json: { version, notes } той же версии с годными пунктами — пункты; иначе null. */
export function notesFile(text: string, version: string): string[] | null {
  try {
    const j = JSON.parse(text) as { version?: unknown; notes?: unknown } | null;
    if (j?.version !== version) return null;
    const c = cleanNotes(j.notes);
    return c.error ? null : c.notes;
  } catch {
    return null;
  }
}

const isNotes = (x: unknown): x is ReleaseNotes => {
  const n = x as ReleaseNotes | null;
  return Boolean(n) && VERSION.test(String(n!.version)) && typeof n!.date === "string" && Array.isArray(n!.notes) && n!.notes.every((s) => typeof s === "string");
};
const byVersionDesc = (a: ReleaseNotes, b: ReleaseNotes) => cmpVersion(b.version, a.version);

/** История выпусков, новые сверху (не больше RELEASE_NOTES_KEEP). Записи в базе ещё нет — NOTES_SEED. */
export async function readNotes(store: Pick<Store, "kvGet">): Promise<ReleaseNotes[]> {
  const raw = await store.kvGet(RELEASE_NOTES_KEY);
  if (raw == null) return NOTES_SEED.map((n) => ({ ...n, notes: [...n.notes] }));
  try {
    const list = JSON.parse(raw) as unknown;
    return Array.isArray(list) ? list.filter(isNotes).sort(byVersionDesc).slice(0, RELEASE_NOTES_KEEP) : [];
  } catch {
    return [];
  }
}
const saveNotes = (store: Pick<Store, "kvSet">, list: ReleaseNotes[]) =>
  store.kvSet(RELEASE_NOTES_KEY, JSON.stringify([...list].sort(byVersionDesc).slice(0, RELEASE_NOTES_KEEP)));

/** Выпуск в историю: версии нет — заводится (с пунктами из файла или пустая); есть — пункты из файла заменяют прежние (пустые или из
 *  NOTES_SEED). Пункты, которые правил админ, файл не перетирает; пустой файл ничего не стирает. */
export async function noteRelease(store: Store, version: string, notes: string[], now = new Date()): Promise<void> {
  const list = await readNotes(store);
  const have = list.find((x) => x.version === version);
  if (have) {
    if (have.edited_at || !notes.length || JSON.stringify(have.notes) === JSON.stringify(notes)) return;
    have.notes = notes;
  } else list.push({ version, date: now.toISOString(), notes, edited_at: null, by: 0 });
  await saveNotes(store, list);
}

/** Изменить «что нового» из админки: { version, notes (список или текст — пункт на строку), reason }. Версия — из истории.
 *  В журнал — release_notes: версия и сколько пунктов было и стало (сами пункты — в истории). */
export async function editNotes(store: Store, adminId: number, body: unknown, now = new Date()): Promise<ReleaseNotes> {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const reason = reasonOf(b.reason);
  const v = typeof b.version === "string" ? b.version : "";
  const list = await readNotes(store);
  const have = list.find((x) => x.version === v);
  if (!have) throw new ReleaseError(404, `выпуска ${VERSION.test(v) ? v : "с таким номером"} нет в истории`);
  const c = cleanNotes(b.notes);
  if (c.error) throw new ReleaseError(400, c.error);
  if (JSON.stringify(c.notes) === JSON.stringify(have.notes)) throw new ReleaseError(400, "ничего не изменилось");
  const was = have.notes.length;
  Object.assign(have, { notes: c.notes, edited_at: now.toISOString(), by: adminId });
  await saveNotes(store, list);
  await store.addAdminLog(adminId, "release_notes", `${v}: пунктов ${was} → ${c.notes.length}`, now, reason);
  return have;
}
