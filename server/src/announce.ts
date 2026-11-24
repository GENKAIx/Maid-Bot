import { accessOf, ownerIds, tariffKindOf } from "./access.ts";
import type { AnnouncementRow, Store, User } from "./db.ts";

// Объявления (этап 6 «Тарифы и управление», 24.11.2026; макет — вкладка «Объявления»). Владелец пишет короткое объявление: текст,
// кому (все / на пробе и подарке / подписчики), где — плашка на сайте и/или реплика Рины в виджете, срок (включительно) или без
// срока; включить и выключить. Сайт берёт свои объявления GET /api/announcements и показывает плашку с крестиком (закрытие
// запоминается на устройстве, web/src/announce.ts). Виджет — по образцу уведомлений: при опросе ленты (/api/notices) объявление
// ложится человеку в ленту одной строкой, один раз (announcement_seen) — виджет скажет его, как любое письмо, без новой версии.
// Рассылки в Telegram всем сразу нет (сознательно: нужна очередь по лимитам Telegram и отдельное подтверждение — не этот этап).
// Каждое действие — с причиной в журнал администратора; в журнал — номер и кому, без текста.

export const ANNOUNCE_TEXT_MAX = 200;
export const ANNOUNCE_AUDIENCES = { all: "всем", trial: "на пробе и подарке", paid: "подписчикам" } as const;
export type Audience = keyof typeof ANNOUNCE_AUDIENCES;
/** Действующие объявления кэшируются на процессе не дольше этого (опрос ленты виджета — раз в 5 с у каждого). */
export const ANNOUNCE_CACHE_MS = 60_000;
/** Объявление в ленте виджета начинается так — человек видит, что это от владельца, а не напоминание. */
export const ANNOUNCE_PREFIX = "📢 ";

export class AnnounceError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** Действует ли сейчас (включено и срок не вышел). */
export const announceLive = (a: Pick<AnnouncementRow, "enabled" | "ends_at">, now = new Date()) => Boolean(a.enabled) && (!a.ends_at || Date.parse(a.ends_at) > now.getTime());

/** Подходит ли человеку: все — каждому; проба — проба и подарок; подписка — идущая подписка (accessOf). */
export function announceFor(a: Pick<AnnouncementRow, "audience">, u: User, now = new Date(), owners = ownerIds()): boolean {
  if (a.audience === "all") return true;
  const kind = tariffKindOf(u, accessOf(u, now, owners));
  return a.audience === "paid" ? kind === "paid" : a.audience === "trial" ? kind === "trial" || kind === "gift" : false;
}

let cache: { at: number; rows: AnnouncementRow[] } | null = null;
/** Действующие объявления (из кэша не старше ANNOUNCE_CACHE_MS). */
async function live(store: Store, now: Date): Promise<AnnouncementRow[]> {
  if (!cache || now.getTime() - cache.at >= ANNOUNCE_CACHE_MS || now.getTime() < cache.at) cache = { at: now.getTime(), rows: await store.announcements(100) };
  return cache.rows.filter((a) => announceLive(a, now));
}
/** Сбросить кэш (после изменения и в тестах). */
export const resetAnnounceCache = () => void (cache = null);

/** Плашки сайта для человека: id и текст. */
export async function siteAnnouncements(store: Store, u: User, now = new Date()) {
  return (await live(store, now)).filter((a) => a.site && announceFor(a, u, now)).map((a) => ({ id: a.id, text: a.text }));
}

/** Опрос ленты виджета: ещё не полученные объявления «в виджет» — строкой в ленту (один раз на человека). Сколько легло. */
export async function deliverToWidget(store: Store, u: User, now = new Date()): Promise<number> {
  const mine = (await live(store, now)).filter((a) => a.widget && announceFor(a, u, now));
  if (!mine.length) return 0;
  const seen = new Set(await store.announcementsSeen(u.id));
  let n = 0;
  // Старые раньше новых: в ленте в том же порядке, что их писали.
  for (const a of mine.filter((x) => !seen.has(x.id)).sort((x, y) => x.id - y.id)) {
    if (!(await store.markAnnouncementSeen(a.id, u.id, now))) continue;
    await store.addNotice(u.id, ANNOUNCE_PREFIX + a.text, "happy", "", "other");
    n++;
  }
  return n;
}

const reasonOf = (v: unknown): string => {
  const r = typeof v === "string" ? v.trim() : "";
  if (r.length < 3) throw new AnnounceError(400, "напишите причину (хотя бы 3 знака)");
  if (r.length > 300) throw new AnnounceError(400, "причина — не длиннее 300 знаков");
  return r;
};

/** Проверка текста объявления (и на сайте под полем): null — годится. */
export function announceTextError(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return "напишите текст";
  if (v.trim().length > ANNOUNCE_TEXT_MAX) return `не длиннее ${ANNOUNCE_TEXT_MAX} знаков`;
  if (/[<>]/.test(v)) return "без знаков < и >";
  // eslint-disable-next-line no-control-regex -- управляющие знаки и есть то, что ищем
  if (/[\u0000-\u001f\u007f]/.test(v)) return "одной строкой, без служебных знаков";
  return null;
}

/** Новое объявление (POST /api/admin/announcements): text, audience, site, widget (хоть одно), until «ГГГГ-ММ-ДД» или пусто. */
export async function createAnnouncement(store: Store, by: number, body: unknown, now = new Date()) {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const reason = reasonOf(b.reason);
  const why = announceTextError(b.text);
  if (why) throw new AnnounceError(400, `текст: ${why}`);
  if (typeof b.audience !== "string" || !Object.hasOwn(ANNOUNCE_AUDIENCES, b.audience)) throw new AnnounceError(400, "кому: all, trial или paid");
  const site = b.site === true, widget = b.widget === true;
  if (!site && !widget) throw new AnnounceError(400, "где показать: сайт, виджет или оба");
  let ends: string | null = null;
  if (b.until != null && b.until !== "") {
    if (typeof b.until !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(b.until) || Number.isNaN(Date.parse(`${b.until}T00:00:00Z`))) throw new AnnounceError(400, "срок — дата ГГГГ-ММ-ДД");
    ends = new Date(Date.parse(`${b.until}T00:00:00Z`) + 86_400_000 - 1).toISOString();
    if (Date.parse(ends) <= now.getTime()) throw new AnnounceError(400, "срок уже прошёл");
  }
  const id = await store.addAnnouncement({ text: (b.text as string).trim(), audience: b.audience, site, widget, ends_at: ends, at: now, by });
  await store.addAdminLog(by, "announce_create", `№${id}: ${ANNOUNCE_AUDIENCES[b.audience as Audience]}, ${[site && "сайт", widget && "виджет"].filter(Boolean).join(" и ")}${ends ? `, до ${ends.slice(0, 10)}` : ""}`, now, reason);
  resetAnnounceCache();
  return { id, ...(await announcementsView(store, now)) };
}

/** Выключить или включить (POST /api/admin/announcements/toggle { id, on, reason }). Уже легшее в ленту виджета не убирается. */
export async function toggleAnnouncement(store: Store, by: number, body: unknown, now = new Date()) {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const reason = reasonOf(b.reason);
  if (typeof b.id !== "number" || !Number.isInteger(b.id) || b.id < 1 || b.id > 2_147_483_647) throw new AnnounceError(400, "нужен номер объявления");
  if (typeof b.on !== "boolean") throw new AnnounceError(400, "вкл — да или нет");
  const a = await store.announcement(b.id);
  if (!a) throw new AnnounceError(404, "нет такого объявления");
  if (Boolean(a.enabled) === b.on) throw new AnnounceError(400, "уже так");
  await store.setAnnouncementEnabled(a.id, b.on, now);
  await store.addAdminLog(by, b.on ? "announce_on" : "announce_off", `№${a.id}`, now, reason);
  resetAnnounceCache();
  return announcementsView(store, now);
}

/** Раздел «Объявления»: объявления владельца (их текст — его же), сколько людей подходит сейчас и сколько получили в виджете. */
export async function announcementsView(store: Store, now = new Date()) {
  const users = await store.users();
  const owners = ownerIds();
  const reach = await store.announcementReach();
  const audience = Object.fromEntries(Object.keys(ANNOUNCE_AUDIENCES).map((k) => [k, users.filter((u) => accessOf(u, now, owners).ok && announceFor({ audience: k }, u, now, owners)).length]));
  return {
    text_max: ANNOUNCE_TEXT_MAX, audiences: ANNOUNCE_AUDIENCES, cache_ms: ANNOUNCE_CACHE_MS,
    /** Сколько людей с доступом подходит под «кому» сейчас — подсказка «увидят примерно N». */
    people: audience,
    items: (await store.announcements(100)).map((a) => ({
      id: a.id, text: a.text, audience: a.audience, site: Boolean(a.site), widget: Boolean(a.widget), enabled: Boolean(a.enabled), ends_at: a.ends_at,
      live: announceLive(a, now), created_at: a.created_at, created_by: `#${a.created_by}`, widget_got: reach.get(a.id) ?? 0,
    })),
  };
}
