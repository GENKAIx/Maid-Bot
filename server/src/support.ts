import { accessOf, ownerIds } from "./access.ts";
import type { Store, TicketRow, TicketStatus, User } from "./db.ts";
import { dayKey, zonedToUtc } from "./time.ts";

// Обращения (этап 6 «Тарифы и управление», 24.11.2026; макет — вкладка «Обращения»). Человек пишет сам — на сайте, «Настройки →
// Написать нам» (POST /api/support): тема из списка и текст. Не больше SUPPORT_PER_DAY за календарный день человека (с полуночи по его поясу; 429). Новое обращение —
// правило оповещений support_new (alerts.ts): владельцу в Telegram приходит только число новых, без текстов.
// Админка: список — номер обращения, аккаунт #id, тема, статус (новое / в работе / закрыто), даты — без текста. Текст и ответ видны
// только в карточке обращения (GET /api/admin/tickets/<номер>) — единственное место админки с текстом человека: человек сам написал
// его владельцу (правило «в админке без текстов» — глава 07 каталога, исключение записано там же). Ответ уходит человеку от бота в
// Telegram и в ленту уведомлений (виджет и сайт); статус и ответ — с причиной в журнал админа (в журнал — без текста ответа).

export const SUPPORT_PER_DAY = 3;
export const SUPPORT_TEXT_MIN = 5;
export const SUPPORT_TEXT_MAX = 2000;
export const SUPPORT_TOPICS = {
  payment: "Оплата и подписка",
  bug: "Что-то не работает",
  desktop: "Программа на ПК",
  idea: "Идея",
  other: "Другое",
} as const;
export type SupportTopic = keyof typeof SUPPORT_TOPICS;
export const TICKET_STATUSES: readonly TicketStatus[] = ["new", "work", "closed"];

/** Тексты человеку (на согласование). */
export const SUPPORT_TEXT = {
  sent: (id: number) => `Спасибо! Обращение №${id} передала — ответ придёт в Telegram и сюда, в уведомления.`,
  many: `Сегодня уже ${SUPPORT_PER_DAY} обращения — ответим на них; новое можно завтра.`,
  short: `Напишите чуть подробнее — хотя бы ${SUPPORT_TEXT_MIN} знаков.`,
  long: `Слишком длинно — не больше ${SUPPORT_TEXT_MAX} знаков.`,
  topic: "Выберите тему.",
  answer: (id: number, text: string) => `💬 Ответ на ваше обращение №${id}:\n${text}`,
};

export class SupportError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const DAY = 86_400_000;
// eslint-disable-next-line no-control-regex -- управляющие знаки и есть то, что убираем
const clean = (s: string) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();

/** Новое обращение человека. */
export async function createTicket(store: Store, u: User, body: unknown, now = new Date()) {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (typeof b.topic !== "string" || !Object.hasOwn(SUPPORT_TOPICS, b.topic)) throw new SupportError(400, SUPPORT_TEXT.topic);
  const text = clean(typeof b.text === "string" ? b.text : "");
  if (text.length < SUPPORT_TEXT_MIN) throw new SupportError(400, SUPPORT_TEXT.short);
  if (text.length > SUPPORT_TEXT_MAX) throw new SupportError(400, SUPPORT_TEXT.long);
  // Обращения «в работе» считаются вместе с записанными и отмечаются до первого await: пачка одновременных запросов не проходит
  // мимо лимита (все увидели бы одно и то же число в базе).
  const busy = ticketsInFlight.get(u.id) ?? 0;
  ticketsInFlight.set(u.id, busy + 1);
  try {
    if ((await store.ticketsOfSince(u.id, supportDayStart(u, now))) + busy >= SUPPORT_PER_DAY) throw new SupportError(429, SUPPORT_TEXT.many);
    const id = await store.addTicket({ user_id: u.id, topic: b.topic, text, at: now });
    return { id, text: SUPPORT_TEXT.sent(id) };
  } finally {
    const left = (ticketsInFlight.get(u.id) ?? 1) - 1;
    if (left > 0) ticketsInFlight.set(u.id, left);
    else ticketsInFlight.delete(u.id);
  }
}
/** Сколько обращений человека сейчас записывается (в памяти процесса). */
const ticketsInFlight = new Map<number, number>();
/** Начало «сегодня» человека (полночь по его поясу, ISO): лимит — на календарный день, как обещают тексты «сегодня» и «завтра». */
const supportDayStart = (u: Pick<User, "tz">, now: Date): string => zonedToUtc(dayKey(now, u.tz), "00:00", u.tz).toISOString();

/** «Написать нам» у человека: темы, сколько ещё можно сегодня, свои обращения с ответами (это его же тексты). */
export async function supportOf(store: Store, u: User, now = new Date()) {
  const today = await store.ticketsOfSince(u.id, supportDayStart(u, now));
  return {
    topics: Object.entries(SUPPORT_TOPICS).map(([id, title]) => ({ id, title })),
    per_day: SUPPORT_PER_DAY, left_today: Math.max(0, SUPPORT_PER_DAY - today), text_max: SUPPORT_TEXT_MAX,
    tickets: (await store.ticketsOf(u.id, 10)).map((t) => ({ id: t.id, topic: t.topic, text: t.text, status: t.status, created_at: t.created_at, answer: t.answer || null, answered_at: t.answered_at })),
  };
}

const reasonOf = (v: unknown): string => {
  const r = typeof v === "string" ? v.trim() : "";
  if (r.length < 3) throw new SupportError(400, "напишите причину (хотя бы 3 знака)");
  if (r.length > 300) throw new SupportError(400, "причина — не длиннее 300 знаков");
  return r;
};

/** Раздел «Обращения»: счётчики и список без текстов. */
export async function ticketsView(store: Store, now = new Date()) {
  const rows = await store.ticketList(200);
  const week = new Date(now.getTime() - 7 * DAY).toISOString();
  const answered = rows.filter((r) => r.answered_at && r.created_at >= new Date(now.getTime() - 30 * DAY).toISOString());
  const open = rows.filter((r) => r.status !== "closed");
  return {
    per_day: SUPPORT_PER_DAY,
    topics: SUPPORT_TOPICS,
    counts: {
      new: rows.filter((r) => r.status === "new").length,
      work: rows.filter((r) => r.status === "work").length,
      week: rows.filter((r) => r.created_at >= week).length,
      /** Самое старое незакрытое (ISO) — сколько ждёт. */
      oldest_open: open.length ? open[open.length - 1].created_at : null,
      /** Среднее время до ответа за 30 дней, часы; ответов не было — null. */
      answer_hours: answered.length ? answered.reduce((s, r) => s + (Date.parse(r.answered_at!) - Date.parse(r.created_at)), 0) / answered.length / 3600_000 : null,
    },
    tickets: rows.map((r) => ({ id: r.id, account: `#${r.user_id}`, user_id: r.user_id, topic: r.topic, status: r.status, created_at: r.created_at, updated_at: r.updated_at, answered: Boolean(r.answered_at) })),
  };
}

/** Карточка обращения: здесь — и только здесь — текст человека и ответ. */
export async function ticketCard(store: Store, id: number, now = new Date()) {
  const t = await store.ticket(id);
  if (!t) throw new SupportError(404, `нет обращения №${id}`);
  const u = await store.user(t.user_id);
  return {
    id: t.id, account: `#${t.user_id}`, user_id: t.user_id, topic: t.topic, status: t.status, text: t.text, answer: t.answer || null,
    created_at: t.created_at, updated_at: t.updated_at, answered_at: t.answered_at,
    plan: u ? accessOf(u, now, ownerIds()).plan : null,
    /** Есть ли у человека Telegram — куда уйдёт ответ (иначе только в ленту уведомлений). */
    telegram: Boolean(u?.chat_id),
  };
}

export interface TicketDeps {
  store: Store;
  /** Письмо человеку общим Send (billing.notify: лента уведомлений, Web Push, Telegram) — ответ, куда письмо на деле легло;
   *  нет (тесты без billing) — только лента. */
  tell?: (u: User, text: string) => Promise<{ feed: boolean; telegram: boolean }>;
}
/** Куда на деле ушёл ответ: в Telegram (и в ленту), только в ленту (Telegram не привязан) или Telegram не принял — только в ленту. */
export type TicketDelivery = "telegram" | "feed" | "feed_tg_failed";
export const TICKET_DELIVERY_TEXT: Record<TicketDelivery, string> = {
  telegram: "ответ ушёл в Telegram",
  feed: "ответ ушёл в ленту",
  feed_tg_failed: "Telegram не принял — ответ только в ленте",
};

/** Статус (POST …/status { status, reason }) или ответ (POST …/answer { text, close?, reason }). */
export async function ticketAction(deps: TicketDeps, by: number, id: number, action: string, body: unknown, now = new Date()) {
  const { store } = deps;
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const t: TicketRow | undefined = await store.ticket(id);
  if (!t) throw new SupportError(404, `нет обращения №${id}`);
  const reason = reasonOf(b.reason);
  if (action === "status") {
    if (typeof b.status !== "string" || !(TICKET_STATUSES as string[]).includes(b.status)) throw new SupportError(400, "статус: new, work или closed");
    if (b.status === t.status) throw new SupportError(400, "уже так");
    await store.updateTicket(id, { status: b.status as TicketStatus, at: now });
    await store.addAdminLog(by, "ticket_status", `#${t.user_id} обращение №${id}: ${t.status} → ${b.status}`, now, reason);
  } else if (action === "answer") {
    const text = clean(typeof b.text === "string" ? b.text : "");
    if (text.length < 2) throw new SupportError(400, "напишите ответ");
    if (text.length > SUPPORT_TEXT_MAX) throw new SupportError(400, `ответ — не длиннее ${SUPPORT_TEXT_MAX} знаков`);
    const u = await store.user(t.user_id);
    if (!u) throw new SupportError(404, `нет аккаунта #${t.user_id}`);
    const msg = SUPPORT_TEXT.answer(id, text);
    let got: { feed: boolean; telegram: boolean };
    try {
      if (deps.tell) got = await deps.tell(u, msg);
      else got = (await store.addNotice(u.id, msg, "neutral", "", "other"), { feed: true, telegram: false });
    } catch (e) {
      throw new SupportError(502, `ответ не ушёл: ${(e as Error).message}`);
    }
    if (!got.feed && !got.telegram) throw new SupportError(502, "ответ не ушёл: ни в Telegram, ни в ленту");
    // Telegram привязан, но не принял (бот заблокирован, чат удалён) — обращение не закрываем сами: человек ответа мог не увидеть.
    const delivery: TicketDelivery = got.telegram ? "telegram" : u.chat_id && deps.tell ? "feed_tg_failed" : "feed";
    const status: TicketStatus = b.close === true && delivery !== "feed_tg_failed" ? "closed" : "work";
    await store.updateTicket(id, { answer: text, status, at: now });
    await store.addAdminLog(by, "ticket_answer", `#${t.user_id} обращение №${id}: ${TICKET_DELIVERY_TEXT[delivery]}${status === "closed" ? ", закрыто" : ""}`, now, reason);
    return { ...(await ticketCard(store, id, now)), delivered: delivery };
  } else throw new SupportError(404, "нет такого действия");
  return { ...(await ticketCard(store, id, now)), delivered: undefined as TicketDelivery | undefined };
}
