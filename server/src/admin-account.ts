import type { Billing } from "./billing.ts";
import type { BillingKind, Store, User } from "./db.ts";
import {
  accessOf, BONUS_PREFIX, dayCapOf, endedOf, GRACE_MS, isFrozen, ownerIds, quotaDay, quotaResetAt, tariffKindOf, todayLimits, trialLenOf,
  type Quota,
} from "./access.ts";
import { resetAnalyticsCache } from "./admin-analytics.ts";
import { forgetPresence } from "./auth.ts";
import { forgetCrashUser } from "./crashes.ts";
import { forgetFeatureUser } from "./feature-events.ts";
import { tariffs, unpricedOf } from "./tariffs.ts";
import { addDays, dayKey } from "./time.ts";

// Действия с аккаунтом по номеру (этап 3 «Тарифы и управление», 24.11.2026; макет docs/review/тарифы-и-управление-макет-2026-11-24.html,
// вкладка «Аккаунт»). Карточка аккаунта — только числа и номер (#id): тариф, срок, остаток лимитов сегодня, оплаты (хвост charge_id),
// журнал подписки, активность за 7 дней. Действия — POST /api/admin/account/<id>/<действие> (api.ts), у каждого — обязательная
// причина и строка в журнале админа (admin_log: параметры в detail — номера и числа, причина — в reason):
//  • extend — продлить срок на 1..365 дней: проба, подарок и подписка — от конца нынешнего срока; кончившийся — от сегодня (подписку
//    заново не создать — станет подарком). У оплаченной подписки сдвигается только access_until: Telegram спишет звёзды в свой день,
//    и срок станет концом оплаченного месяца (billing.ts paid берёт больший), добавленные дни поверх оплаты не складываются.
//  • grant — подарок без оплаты на 1..365 дней (plan trial, trial_len_days 0 — тот же вид, что подарок по /invite: тариф «Подарок»,
//    конец — gift_ended в Billing.expire; sub_charge_id не ставится). Не путать с оплаченной подпиской: она в подписчиках и в
//    аналитике по оплатам, а подарок — нет. Пока идёт оплаченная подписка — нельзя (для неё есть extend).
//  • bonus — поднять лимит на сегодня (день человека, по его поясу): +N запросов, картинок или минут голоса. Строка ai_quota
//    bonus_<штука> на сегодняшний день: завтра — другой день, прибавки нет; сами счётчики не трогаются.
//  • freeze / unfreeze — заморозить и разморозить: users.frozen_at; ИИ закрыт (access.ts), входы на сайте и в программе закрыты
//    (сессии удаляются, вход по паролю — 403), бот на всё отвечает FROZEN_TEXT (кроме /cancel_sub), напоминания не уходят; данные
//    не удаляются. Идущая подписка Telegram при заморозке отменяется (Billing.cancel: продление выключено, журнал canceled), при
//    разморозке человеку — как возобновить (/resume_sub). Продлить и подарить замороженному нельзя (409): сначала разморозить.
//    Владельца (ADMIN_CHAT_IDS, ALLOWED_CHAT_IDS) и самого себя заморозить нельзя.
//  • delete — удалить аккаунт насовсем (тестовые аккаунты: проверить регистрацию заново с того же Telegram). Кроме причины — confirm:
//    номер аккаунта, набранный вручную (цифры, можно с «#»; не совпал — 400). Владельца, админа и самого себя — нельзя (403). Идущая
//    подписка — сперва отменить продление, как при заморозке; не вышло — 409, удаление не начинается (после него Telegram id и
//    charge_id стёрты, и отменить подписку с сервера уже нечем). Всё — одной транзакцией (Store.deleteAccount: строки человека во
//    всех таблицах, его ключи kv — и отметки /paysupport по Telegram id, оплаты и журнал подписки — отвязать на номер −id, расход
//    модели — на 0), строка журнала админа — в той же транзакции; сбой — откат всего, строка delete-fail (и «продление отменено»,
//    если отменилось) и 500 админу, письма нет. Память сервера про номер (частота ИИ, присутствие, счётчики фич и падений, кэш
//    аналитики) — забыть; через SWEEP_AFTER_MS — Store.sweepOrphans: убрать то, что дописали начатые до удаления дела. Письмо
//    человеку — после удаления, только в Telegram (tellChat; ленты уже нет). Отменить нельзя: вернуть — только из ночной копии базы.
// Возврат звёзд — не здесь: POST /api/admin/refund (Billing.refund) с причиной и хвостом выбранной оплаты.
// Человеку о продлении, подарке, прибавке и заморозке — короткое письмо (tell: Telegram, если привязан, и лента уведомлений).

export class AccountError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export const ACCOUNT_DAYS_MAX = 365;
/** Самый большой номер аккаунта: users.id в Postgres — INTEGER (int4), больше — ошибка базы (500), а не «нет аккаунта» (api.ts). */
export const MAX_ACCOUNT_ID = 2_147_483_647;
/** Наибольшая прибавка за одно действие «Поднять лимит на сегодня». */
export const BONUS_MAX = { calls: 1000, draws: 100, voice_min: 120 } as const;
export type BonusWhat = keyof typeof BONUS_MAX;
/** Через сколько после удаления ещё раз убрать хвосты удалённого (Store.sweepOrphans). */
export const SWEEP_AFTER_MS = 120_000;
export const ACCOUNT_ACTIONS = ["extend", "grant", "bonus", "freeze", "unfreeze", "delete"] as const;
export type AccountAction = (typeof ACCOUNT_ACTIONS)[number];

/** Строки журнала админа про один аккаунт (карточка): действия отсюда, возврат звёзд и тестовые аккаунты (admin-tests.ts). */
const ACCOUNT_LOG = new Set<string>([
  ...ACCOUNT_ACTIONS, "refund", "refund-fail", "delete-fail", "ticket_answer", "ticket_status", "test_create", "test_token", "test_reset",
]);

export interface AccountDeps {
  store: Store;
  /** Письмо человеку (Telegram и лента); нет — только лента уведомлений. */
  tell?: (u: User, text: string) => Promise<void>;
  /** Отменить продление подписки Telegram (Billing.cancel) — при заморозке, чтобы звёзды не списывались, пока доступ закрыт. */
  cancelSub?: (u: User) => Promise<{ ok: boolean; text: string }>;
  owners?: () => string[];
  clock?: () => Date;
  /** Письмо только в Telegram, по chat_id (без ленты) — удалённому: его записи users и ленты уже нет. */
  tellChat?: (chatId: string, text: string) => Promise<void>;
  /** Забыть номер в памяти, которой у этого модуля нет (частота ИИ у AiGate) — после удаления аккаунта. */
  forget?: (id: number) => void;
}

const DAY = 86_400_000;
const dmy = (iso: string) => iso.slice(0, 10).split("-").reverse().join(".");

/** Номер аккаунта, набранный вручную для подтверждения (удаление, сброс тестового — admin-tests.ts): цифрами, по желанию с «#»
 *  («01042» — это #1042, как поле на сайте, accountQuery). Не тот номер — 400. */
export function confirmedId(v: unknown, id: number, what: string) {
  const typed = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim().replace(/^#/, "") : "";
  if (!/^\d{1,12}$/.test(typed) || Number(typed) !== id) throw new AccountError(400, `наберите номер аккаунта (${id}) — так видно, что ${what} тот самый`);
}

/** Забыть номер в памяти сервера (частота ИИ — forget у AiGate, присутствие, счётчики фич и падений, кэш аналитики) — после
 *  удаления аккаунта и сброса тестового (admin-tests.ts). */
export function forgetAccount(id: number, forget?: (id: number) => void) {
  forgetPresence(id);
  forgetFeatureUser(id);
  forgetCrashUser(id);
  forget?.(id);
  resetAnalyticsCache();
}

/** Причина — обязательна: 3..300 знаков. */
export function accountReason(v: unknown): string {
  const r = typeof v === "string" ? v.trim() : "";
  if (r.length < 3) throw new AccountError(400, "напишите причину (хотя бы 3 знака)");
  if (r.length > 300) throw new AccountError(400, "причина — не длиннее 300 знаков");
  return r;
}
function intIn(v: unknown, min: number, max: number, what: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new AccountError(400, `${what}: целое от ${min} до ${max}`);
  return v;
}
const isOwner = (u: User, owners: string[]) => Boolean(u.chat_id) && owners.includes(String(u.chat_id));
/** Идёт ли срок пробы, подарка или подписки (с запасом GRACE_MS, как accessOf) — по записи, без учёта заморозки. */
const liveTerm = (u: User, now: Date) =>
  (u.plan === "trial" || u.plan === "paid") && Boolean(u.access_until) && Date.parse(u.access_until!) + GRACE_MS > now.getTime();
/** Идёт оплаченная подписка и Telegram её продлевает (продление не отменено): в свой день спишет звёзды. */
export const renewingSub = (u: User, now: Date) => u.plan === "paid" && Boolean(u.sub_charge_id) && !Number(u.sub_canceled) && liveTerm(u, now);

/** Продлить срок на days (действие «Продлить» и промокод, promo.ts): идёт срок — от его конца (проба остаётся пробой своего вида);
 *  кончился — от сейчас: кончилась проба — снова проба того же вида, подарок и подписка — подарок (подписку без оплаты не
 *  возобновить). Только запись — что поменять в users и новый конец; проверки (друг, заморозка, подписка) — у вызывающего. */
export function extendPatch(u: User, days: number, now: Date): { patch: Partial<User>; until: string } {
  if (liveTerm(u, now)) {
    const until = new Date(Math.max(now.getTime(), Date.parse(u.access_until!)) + days * DAY).toISOString();
    // Вид срока — явно: у записей до шага 31 он вычисляется по длине срока, и продление превратило бы пробу в подарок.
    return { until, patch: u.plan === "trial" ? { access_until: until, trial_len_days: trialLenOf(u) } : { access_until: until } };
  }
  const until = new Date(now.getTime() + days * DAY).toISOString();
  const ended = endedOf(u);
  return { until, patch: { plan: "trial", access_until: until, trial_len_days: ended === "trial" ? trialLenOf(u) : 0 } };
}

/** Карточка аккаунта: только числа и номер. Нет такого — 404. */
export async function accountCard(store: Store, id: number, now = new Date(), owners = ownerIds()) {
  const u = await store.user(id);
  if (!u) throw new AccountError(404, `нет аккаунта #${id}`);
  const a = accessOf(u, now, owners);
  const kind = tariffKindOf(u, a);
  const day = quotaDay(u, now);
  let today = null;
  if (kind) {
    const lim = await todayLimits(store, u, kind, day);
    const used = await store.quotaOf(u.id, day);
    const plus = await store.quotaBonus(u.id, day);
    const one = (q: Quota) => ({ used: used[q], limit: lim[q], bonus: plus[q] });
    today = {
      day, resets_at: quotaResetAt(u, now), calls: one("calls"), draws: one("draws"), voice_sec: one("voice_sec"),
      spend_usd: await store.daySpend(u.id, now.toISOString().slice(0, 10), unpricedOf()), cap_usd: dayCapOf(kind),
    };
  }
  const pays = await store.paymentsOf(u.id);
  const last = pays.find((p) => !p.refunded_at);
  const t = dayKey(now, u.tz);
  const from = addDays(t, -6);
  const rows = new Map((await store.accountDays(u.id, addDays(from, -1), addDays(t, 1))).map((r) => [r.day, r]));
  const week = Array.from({ length: 7 }, (_, i) => {
    const d = addDays(from, i);
    const r = rows.get(d);
    return { day: d, ai: r?.ai ?? 0, manual: r?.manual ?? 0, minutes: r?.minutes ?? 0, calls: r?.calls ?? 0, usd: (r?.micro ?? 0) / 1e6 };
  });
  const devices = new Map<string, { client: string; version: string; last_seen: string; count: number }>();
  for (const s of await store.accountSessions(u.id)) {
    const k = `${s.client} ${s.version}`;
    const d = devices.get(k);
    if (d) d.count++;
    else devices.set(k, { ...s, count: 1 });
  }
  return {
    id: u.id,
    created_at: u.created_at,
    days_with_us: Math.max(0, Math.floor((now.getTime() - Date.parse(u.created_at)) / DAY)),
    plan: a.plan,
    kind,
    until: u.access_until ?? null,
    canceled: a.canceled,
    /** Идёт оплаченная подписка Telegram и продление не отменено (по ней спишутся звёзды). */
    live_sub: renewingSub(u, now),
    frozen_at: u.frozen_at ?? null,
    /** 1 — тестовый аккаунт (admin-tests.ts): ему можно «Сбросить к чистому» и выдать ключ для ПК. */
    is_test: Number(u.is_test ?? 0) === 1 ? 1 : 0,
    /** Владельца и админа заморозить нельзя. */
    protected: isOwner(u, owners),
    /** Что кончилось бы (или кончилось): проба, подарок, подписка. */
    ended: a.ok ? null : endedOf(u),
    today,
    payments: pays.map((p) => ({
      charge: `…${p.charge_id.slice(-8)}`, amount: p.amount, currency: p.currency, kind: p.kind, paid_at: p.paid_at,
      expires_at: p.expires_at, refunded_at: p.refunded_at, refundable: p === last,
    })),
    events: (await store.billingEventsOf(u.id, 50)).map((e) => ({ at: e.at, kind: e.kind, amount: e.amount })),
    week,
    devices: [...devices.values()],
    last_seen: (await store.accountSessions(u.id))[0]?.last_seen ?? null,
    // Только действия с аккаунтом: у строк тарифов «#N» в начале — номер строки истории, а не аккаунта.
    log: (await store.adminLog(200, u.id)).filter((r) => ACCOUNT_LOG.has(r.action)).slice(0, 30)
      .map((r) => ({ at: r.at, who: `#${r.user_id}`, action: r.action, detail: r.detail, reason: r.reason })),
  };
}

/** Действие с аккаунтом id от админа by: проверка, изменение, строка журнала подписки (продление и подарок), журнал админа,
 *  письмо человеку. Ответ — что сделано и карточка после. */
export async function accountAction(deps: AccountDeps, by: User, id: number, action: string, body: unknown) {
  const { store } = deps;
  const now = deps.clock?.() ?? new Date();
  const owners = deps.owners?.() ?? ownerIds();
  if (!(ACCOUNT_ACTIONS as readonly string[]).includes(action)) throw new AccountError(404, "нет такого действия");
  const u = await store.user(id);
  if (!u) throw new AccountError(404, `нет аккаунта #${id}`);
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const reason = accountReason(b.reason);
  const tell = async (text: string) => {
    try {
      if (deps.tell) await deps.tell(u, text);
      else await store.addNotice(u.id, text, "neutral", "", "other");
    } catch (e) {
      console.error("[account] письмо", (e as Error).message);
    }
  };
  const log = (act: string, detail: string) => store.addAdminLog(by.id, act, `#${u.id} ${detail}`.trim(), now, reason);
  const billingEvent = async (kind: BillingKind) => {
    try {
      await store.addBillingEvent({ user_id: u.id, kind, at: now });
    } catch (e) {
      console.error("[account] журнал подписки", (e as Error).message);
    }
  };
  const free = u.plan === "friend" || isOwner(u, owners);
  /** Идёт подписка — отменить продление (заморозка и удаление): canceled, failed или "" (подписки нет). */
  const stopRenewal = async (): Promise<"" | "canceled" | "failed"> => {
    if (!(u.sub_charge_id && !Number(u.sub_canceled) && liveTerm(u, now))) return "";
    const r = deps.cancelSub ? await deps.cancelSub(u).catch((e: Error) => ({ ok: false, text: e.message })) : { ok: false, text: "оплата выключена" };
    return r.ok ? "canceled" : "failed";
  };
  let text: string;

  if (action === "delete") {
    if (u.id === by.id || isOwner(u, owners)) throw new AccountError(403, "владельца и админа удалить нельзя");
    confirmedId(b.confirm, u.id, "удаляете");
    // Продление не отменилось — не удалять: после удаления Telegram id и charge_id стёрты, отменить подписку с сервера уже нечем.
    const sub = await stopRenewal();
    if (sub === "failed") {
      throw new AccountError(409, "сначала отмените продление подписки: Telegram не ответил (или оплата выключена) — повторите позже, аккаунт не удалён");
    }
    const chat = u.chat_id ? String(u.chat_id) : "";
    let r: { deleted: number; detached: number };
    try {
      r = await store.deleteAccount(u.id, (n) =>
        log("delete", `удалён аккаунт, строк удалено: ${n.deleted}, отвязано (деньги): ${n.detached}${sub === "canceled" ? ", продление отменено" : ""}`));
    } catch (e) {
      // Откат: аккаунт на месте, письма не было. Продление (если было) уже отменено — это в журнал и админу.
      console.error("[account] удаление", (e as Error).message);
      await store.addAdminLog(by.id, "delete-fail", `#${u.id} удаление не прошло${sub === "canceled" ? ", продление отменено" : ""}`, now, reason)
        .catch((x: Error) => console.error("[account] журнал", x.message));
      throw new AccountError(500, `Удаление #${u.id} не прошло (ошибка базы), аккаунт на месте.` +
        (sub === "canceled" ? " Продление подписки Telegram при этом уже отменено." : ""));
    }
    forgetAccount(u.id, deps.forget);
    // Что дописали уже начатые дела (ответ модели, обход планировщика, пачка счётчиков) — убрать ещё раз чуть позже.
    const sweep = setTimeout(() => void store.sweepOrphans().catch((e: Error) => console.error("[account] хвосты", e.message)), SWEEP_AFTER_MS);
    sweep.unref?.();
    // Письмо — после удаления и только в Telegram (лента удалена вместе со всем): не удалилось — письма нет.
    if (chat && deps.tellChat) {
      await deps.tellChat(chat, "Аккаунт удалён администратором — все записи стёрты. Чтобы начать заново, напишите /start.")
        .catch((e: Error) => console.error("[account] письмо", e.message));
    }
    text = `Аккаунт #${u.id} удалён: строк ${r.deleted}, оплат и расхода отвязано ${r.detached}.` +
      (sub === "canceled" ? " Продление подписки Telegram отменено." : "");
    return { ok: true, text, deleted: u.id, card: null };
  }

  if (action === "extend" || action === "grant") {
    const days = intIn(b.days, 1, ACCOUNT_DAYS_MAX, "дней");
    if (free) throw new AccountError(409, `у #${u.id} бесплатный доступ навсегда — сроков нет`);
    // Замороженному доступ закрыт: письмо «доступ продлён» его бы обмануло — сначала разморозить.
    if (isFrozen(u)) throw new AccountError(409, `#${u.id} заморожен — сначала разморозьте`);
    const live = liveTerm(u, now);
    if (action === "extend") {
      const { patch, until } = extendPatch(u, days, now);
      await store.updateUser(u.id, patch);
      await billingEvent("admin_extend");
      await log("extend", `+${days} дн. → до ${until.slice(0, 10)}`);
      await tell(renewingSub(u, now)
        ? `Добавила вам дней: доступ — до ${dmy(until)}. Подписка в Telegram списывается по своему графику, как раньше.`
        : `Хорошие новости: доступ продлён до ${dmy(until)} ✨`);
      text = `#${u.id}: срок продлён на ${days} дн., до ${dmy(until)}.`;
    } else {
      if (u.plan === "paid" && live) throw new AccountError(409, `у #${u.id} идёт подписка — продлите срок вместо подарка`);
      const base = u.plan === "trial" && live ? Math.max(now.getTime(), Date.parse(u.access_until!)) : now.getTime();
      const until = new Date(base + days * DAY).toISOString();
      await store.updateUser(u.id, { plan: "trial", access_until: until, trial_len_days: 0 });
      await billingEvent("admin_grant");
      await log("grant", `подарок ${days} дн. → до ${until.slice(0, 10)}`);
      await tell(`🎁 Вам подарок — полный доступ до ${dmy(until)}.`);
      text = `#${u.id}: подарок на ${days} дн., до ${dmy(until)}.`;
    }
  } else if (action === "bonus") {
    const what = b.what;
    if (what !== "calls" && what !== "draws" && what !== "voice_min") throw new AccountError(400, "что поднять: calls, draws или voice_min");
    const n = intIn(b.n, 1, BONUS_MAX[what], what === "calls" ? "запросов" : what === "draws" ? "картинок" : "минут");
    const kind = tariffKindOf(u, accessOf(u, now, owners));
    if (free) throw new AccountError(409, `у #${u.id} нет лимитов — поднимать нечего`);
    if (!kind) throw new AccountError(409, `у #${u.id} нет доступа к ИИ — сначала продлите срок или разморозьте`);
    const q: Quota = what === "voice_min" ? "voice_sec" : what;
    const day = quotaDay(u, now);
    await store.addQuota(u.id, day, `${BONUS_PREFIX}${q}`, what === "voice_min" ? n * 60 : n);
    const word = what === "calls" ? "запросов" : what === "draws" ? "картинок" : "мин голоса";
    await log("bonus", `+${n} ${word} на ${day}`);
    await tell(`На сегодня у вас больше сил: +${n} ${word}. Завтра всё как обычно.`);
    text = `#${u.id}: +${n} ${word} на сегодня (${dmy(day)}).`;
  } else if (action === "freeze") {
    if (u.id === by.id || isOwner(u, owners)) throw new AccountError(409, "владельца и админа заморозить нельзя");
    if (isFrozen(u)) throw new AccountError(409, `#${u.id} уже заморожен`);
    // Продление подписки Telegram — отменить: иначе звёзды списываются каждый месяц, а доступ закрыт. Не вышло (Telegram не
    // ответил, бот выключен) — заморозка всё равно идёт, админу — предупреждение, человеку — как отменить самому.
    const sub = await stopRenewal();
    await store.updateUser(u.id, { frozen_at: now.toISOString() });
    const closed = await store.dropSessionsOf(u.id);
    await log("freeze", `входов закрыто: ${closed}${sub === "canceled" ? ", продление отменено" : sub === "failed" ? ", продление НЕ отменено" : ""}`);
    // Письмо — уже замороженному: бот не ответит, но сообщение дойдёт (tell — не через планировщик).
    await tell("Аккаунт приостановлен. Все записи сохранены, ничего не удалено." +
      (sub === "canceled" ? " Продление подписки отменено — звёзды больше не спишутся."
        : sub === "failed" ? " Продление подписки можно отменить в Telegram: Настройки → Мои звёзды → Подписки, или командой /cancel_sub." : "") +
      " Вопросы — /paysupport в боте.");
    text = `#${u.id} заморожен, входов закрыто: ${closed}.` +
      (sub === "canceled" ? " Продление подписки Telegram отменено." : sub === "failed" ? " Продление подписки Telegram отменить не вышло — звёзды могут списаться." : "");
  } else {
    if (!isFrozen(u)) throw new AccountError(409, `#${u.id} не заморожен`);
    await store.updateUser(u.id, { frozen_at: null });
    await log("unfreeze", "");
    // Продление отменено (при заморозке или самим человеком), а оплаченный срок ещё идёт — подсказать, как возобновить.
    const resume = u.plan === "paid" && u.sub_charge_id && Number(u.sub_canceled) && liveTerm(u, now)
      ? ` Продление подписки отменено — возобновить: /resume_sub в боте.` : "";
    await tell(`Аккаунт снова работает ✨ На сайте и в программе войдите заново — старые входы закрылись при заморозке.${resume}`);
    text = `#${u.id} разморожен.`;
  }
  return { ok: true, text, card: await accountCard(store, u.id, now, owners) };
}
