import { config } from "./config.ts";
import type { Store, User } from "./db.ts";
import { countFeature } from "./feature-events.ts";
import { tariffs, unpricedOf, type TariffValues } from "./tariffs.ts";
import { addDays, dayKey, zonedToUtc } from "./time.ts";

// Платный доступ (24.11.2026): одна проверка «можно ли тратить ИИ на этого человека» для бота, сайта, конвейера и планировщика.
// Бесплатно навсегда — всё без модели: просмотр своих данных, кнопки и отметки, ручные правки, push-кнопки, напоминания и вопросы
// про привычки. Платно — всё, что зовёт модель: разбор новых сообщений, разговор, ответы, /ask, голос, фото, рисунки, поправки,
// слова горничной утром и вечером, закономерности, фоновый повтор разбора.
// Кто с доступом: владелец (ALLOWED_CHAT_IDS и ADMIN_CHAT_IDS), друг (plan = friend: все, кто был в базе до шага 27, и записи из
// командной строки), проба или подарок (trial) и подписка (paid) — пока не кончился access_until (+ GRACE_MS запаса на продление).

/** Запас после конца срока: продление Telegram может прийти чуть позже. */
export const GRACE_MS = 60 * 60_000;

export type Plan = "owner" | "friend" | "paid" | "trial" | "expired" | "frozen";
export interface Access {
  ok: boolean;
  plan: Plan;
  /** Конец срока (ISO) у пробы и подписки; у владельца и друга — null. */
  until: string | null;
  /** Продление подписки отменено (доступ до until). */
  canceled: boolean;
  /** Сколько дней пробы осталось (вверх до целого); не на пробе — null. */
  trialLeftDays: number | null;
  /** Чем был кончившийся срок (для текста отказа и письма): проба, подарок по /invite или подписка. Не кончился — null. */
  ended: Ended | null;
}
export type Ended = "trial" | "gift" | "paid";

/** Проба у записей до шага 31 — всегда 7 дней: до тарифов из базы её не меняли. */
export const LEGACY_TRIAL_DAYS = 7;

/** Вид бесплатного срока (plan trial): длина пробы в днях при выдаче; 0 — подарок по /invite. Записан при выдаче
 *  (users.trial_len_days, шаг 31), поэтому смена тарифа trialDays в админке не меняет смысл уже выданных сроков. Записи до шага 31
 *  (null) — по длине срока: от создания записи дальше прежней пробы + 1 дня — подарок. */
export function trialLenOf(u: Pick<User, "trial_len_days" | "created_at" | "access_until">): number {
  if (u.trial_len_days != null) return Number(u.trial_len_days);
  const made = Date.parse(u.created_at ?? "");
  const until = Date.parse(u.access_until ?? "");
  return Number.isFinite(made) && Number.isFinite(until) && until - made > (LEGACY_TRIAL_DAYS + 1) * 86_400_000 ? 0 : LEGACY_TRIAL_DAYS;
}

/** Что кончилось: подписка (plan paid; или уже free, но была оплата подписки), подарок (trialLenOf 0) или проба. Сначала — план:
 *  у бывшего подписчика sub_charge_id остаётся, и подарок из админки поверх (plan trial, admin-account.ts) — подарок, а не подписка. */
export const endedOf = (u: User): Ended => {
  if (u.plan === "paid") return "paid";
  if (u.plan !== "trial" && u.sub_charge_id) return "paid";
  return trialLenOf(u) === 0 ? "gift" : "trial";
};

/** Аккаунт заморожен админом (шаг 33, admin-account.ts): ИИ, вход на сайт и в программу и ответы бота закрыты, данные остаются.
 *  Владельца заморозить нельзя (admin-account.ts), поэтому в accessOf владелец проверяется раньше. */
export const isFrozen = (u: Pick<User, "frozen_at">): boolean => Boolean(u.frozen_at);
/** Что отвечают замороженному: бот на любое сообщение (bot.ts), вход на сайт (api.ts), отказ ИИ (refusalText). */
export const FROZEN_TEXT = "Аккаунт приостановлен — я пока не отвечаю. Все записи сохранены, ничего не удалено. Вопросы — /paysupport в боте.";

/** Владельцы — всегда с доступом. */
export const ownerIds = (): string[] => [...new Set([...config.allowedChatIds, ...config.adminChatIds])];

export function accessOf(u: User, now = new Date(), owners = ownerIds()): Access {
  const base = { until: null, canceled: Boolean(Number(u.sub_canceled ?? 0)), trialLeftDays: null, ended: null };
  if (u.chat_id && owners.includes(String(u.chat_id))) return { ...base, ok: true, plan: "owner" };
  if (isFrozen(u)) return { ...base, ok: false, plan: "frozen" };
  if (u.plan === "friend") return { ...base, ok: true, plan: "friend" };
  const until = u.access_until ?? null;
  const live = Boolean(until) && Date.parse(until!) + GRACE_MS > now.getTime();
  if ((u.plan === "trial" || u.plan === "paid") && live) {
    const left = u.plan === "trial" ? Math.max(0, Math.ceil((Date.parse(until!) - now.getTime()) / 86_400_000)) : null;
    return { ...base, ok: true, plan: u.plan, until, trialLeftDays: left };
  }
  return { ...base, ok: false, plan: "expired", until, ended: endedOf(u) };
}

/** Для клиентов (/api/me): план, срок, отменено ли продление, дней пробы. */
export const accessView = (a: Access) => ({ plan: a.plan, until: a.until, canceled: a.canceled, trial_left_days: a.trialLeftDays });

// ——— Лимиты в штуках (этап 2 тарифов, 24.11.2026). У каждого тарифа (проба, подарок по /invite, подписка) — запросы к ИИ,
// картинки и секунды голоса на человека в день; день — по поясу человека (users.tz), сброс в его полночь. Счёт — таблица ai_quota
// (шаг 32), атомарно: прибавка проходит, только если не выводит за лимит (db.ts takeQuota). Друзья и владелец — без лимитов.

/** Тариф человека с доступом: подписка, подарок (проба с trialLenOf 0) или проба; владелец, друг и кончившийся срок — null. */
export type TariffKind = "trial" | "gift" | "paid";
export function tariffKindOf(u: User, a: Access): TariffKind | null {
  if (!a.ok) return null;
  if (a.plan === "paid") return "paid";
  if (a.plan === "trial") return trialLenOf(u) === 0 ? "gift" : "trial";
  return null;
}
/** Что считается: calls — обращения человека к ИИ, draws — рисунки, voice_sec — секунды распознанного голоса. */
export type Quota = "calls" | "draws" | "voice_sec";
export const QUOTAS: readonly Quota[] = ["calls", "draws", "voice_sec"];
export type Limits = Record<Quota, number>;
/** Лимиты тарифа на день (голос — в секундах). 0 — функция на тарифе недоступна. */
export function limitsOf(kind: TariffKind, t: Readonly<TariffValues> = tariffs()): Limits {
  if (kind === "paid") return { calls: t.paidCalls, draws: t.paidDraws, voice_sec: t.paidVoiceMin * 60 };
  if (kind === "gift") return { calls: t.giftCalls, draws: t.giftDraws, voice_sec: t.giftVoiceMin * 60 };
  return { calls: t.trialCalls, draws: t.trialDraws, voice_sec: t.trialVoiceMin * 60 };
}
/** Денежный предохранитель тарифа, $ в день (UTC, llm_usage). */
export function dayCapOf(kind: TariffKind, t: Readonly<TariffValues> = tariffs()): number {
  return kind === "paid" ? t.paidDayUsd : kind === "gift" ? t.giftDayUsd : t.trialDayUsd;
}
/** Текст при упоре в лимит в штуках: подписчику — без фразы про подписку (paidLimitText), пробе и подарку — limitText. */
export const limitTextOf = (kind: TariffKind, t: Readonly<TariffValues> = tariffs()): string => (kind === "paid" ? t.paidLimitText : t.limitText);
/** Лимит 0 — функции на тарифе нет: «завтра продолжу» тут было бы неправдой. */
export const OFF_TEXT = "Этого на вашем тарифе нет — остальное работает как обычно.";
/** Кончились картинки или голос, а запросы ещё есть: общий limitTextOf («силы кончились — продолжу завтра») был бы неправдой —
 *  переписка работает, а просьба нарисовать никуда не откладывается. Своя фраза про эту функцию. */
export const DRAWS_CAP_TEXT = "Картинки на сегодня кончились — новые будут после полуночи. Остальное работает как обычно.";
export const VOICE_CAP_TEXT = "Голосовые на сегодня кончились — новые будут после полуночи. Текстом пишите как обычно.";
const CAP_TEXT: Partial<Record<Quota, string>> = { draws: DRAWS_CAP_TEXT, voice_sec: VOICE_CAP_TEXT };
/** Прибавка к лимиту на один день от админа (admin-account.ts «Поднять лимит на сегодня»): строки ai_quota с видом bonus_<штука>
 *  на день человека — завтра это другой день_key, прибавки там нет. Сами счётчики (calls, draws, voice_sec) прибавка не трогает. */
export const BONUS_PREFIX = "bonus_";
/** Ключ дня счётчиков (ГГГГ-ММ-ДД по поясу человека) и момент сброса — его следующая полночь (ISO). */
export const quotaDay = (u: Pick<User, "tz">, now: Date): string => dayKey(now, u.tz);
export const quotaResetAt = (u: Pick<User, "tz">, now: Date): string => zonedToUtc(addDays(quotaDay(u, now), 1), "00:00", u.tz).toISOString();
/** Смена пояса (you.ts saveYou) не открывает новый день счётчиков: взятое за текущий день старого пояса переносится в текущий
 *  день нового (там — не меньше, чем было в старом). Иначе сменой пояса туда, где другая дата, лимиты обходятся. */
export async function carryQuota(store: Store, userId: number, fromTz: string, toTz: string, now = new Date()): Promise<void> {
  const from = dayKey(now, fromTz);
  const to = dayKey(now, toTz);
  if (from === to) return;
  const [a, b] = [await store.quotaOf(userId, from), await store.quotaOf(userId, to)];
  for (const q of QUOTAS) if (a[q] > b[q]) await store.takeQuota(userId, to, q, a[q] - b[q], Number.MAX_SAFE_INTEGER);
}

/** Сколько взять со счётчиков за этот запрос: calls — обращение, draws — рисунок, voiceSec — секунды голоса (вверх до целых). */
export interface Take { calls?: number; draws?: number; voiceSec?: number }
/** Что взяли (для возврата при сбое распознавания): день и штуки. */
export interface Taken { day: string; items: [Quota, number][] }

/** Остаток на сегодня для /api/me (сайт): по каждой штуке used и limit, когда сброс. Друзья, владелец и без доступа — null. */
export interface TodayView { calls: { used: number; limit: number }; draws: { used: number; limit: number }; voice_sec: { used: number; limit: number }; resets_at: string }
export async function todayView(store: Store, u: User, a: Access, now = new Date()): Promise<TodayView | null> {
  const kind = tariffKindOf(u, a);
  if (!kind) return null;
  const lim = await todayLimits(store, u, kind, quotaDay(u, now));
  const used = await store.quotaOf(u.id, quotaDay(u, now));
  const one = (q: Quota) => ({ used: Math.min(used[q], lim[q]), limit: lim[q] });
  return { calls: one("calls"), draws: one("draws"), voice_sec: one("voice_sec"), resets_at: quotaResetAt(u, now) };
}

/** Лимиты на день day: тариф плюс прибавка админа на этот день (BONUS_PREFIX). */
export async function todayLimits(store: Store, u: Pick<User, "id">, kind: TariffKind, day: string, t: Readonly<TariffValues> = tariffs()): Promise<Limits> {
  const lim = limitsOf(kind, t);
  const plus = await store.quotaBonus(u.id, day);
  return { calls: lim.calls + plus.calls, draws: lim.draws + plus.draws, voice_sec: lim.voice_sec + plus.voice_sec };
}

export type Refusal = "access" | "rate" | "money";
/** reason — почему (счётчик gate.<reason>); у удачного taken — что взяли со счётчиков (refund вернёт). */
export type Verdict = { ok: true; taken?: Taken } | { ok: false; why: Refusal; text: string; reason: GateReason };

/** Срок кончился (отказ ИИ и письмо планировщика): пробная неделя — словами пользователя; подарок и подписка — свои первые слова. */
export function endedText(e: Ended | null, price = tariffs().price): string {
  const what = e === "gift" ? "Подарочный доступ закончился" : e === "paid" ? "Подписка закончилась" : "Пробная неделя закончилась";
  return `${what} — я сохранила всё, что было. Чтобы я снова разбирала сообщения, оформите подписку ⭐${price} в месяц`;
}

/** Слишком часто, а сообщение не сохранить для повтора (голос, картинка, /ask) — просьба прислать ещё раз. */
export const RATE_AGAIN = "Много сообщений подряд — пришлите это ещё раз через минуту, пожалуйста.";

/** Тексты отказа. access и money — сообщение записывается заметкой (pipeline.ts blocked); rate — сообщение «не удалось»,
 *  его разберёт фоновый повтор. */
export function refusalText(why: Refusal, a: Access | null, price = tariffs().price): string {
  if (why === "rate") return "Много сообщений подряд — это разберу чуть позже сама (или нажмите «Повторить»).";
  if (why === "money") return "На сегодня лимит разбора исчерпан — завтра продолжу как обычно.";
  if (a?.plan === "frozen") return FROZEN_TEXT;
  return endedText(a?.ended ?? null, price);
}

/** Почему не пустили к модели — счётчик фич gate.<причина> (feature-list.ts, группа «Доступ»): no_access — нет доступа (проба,
 *  подарок или подписка кончились), burst — слишком часто, day_cap — свой дневной потолок расхода, trial_pool — общий потолок проб,
 *  calls_cap / draws_cap / voice_cap — кончился лимит в штуках на сегодня (запросы, картинки, голос). */
export type GateReason = "no_access" | "burst" | "day_cap" | "trial_pool" | "calls_cap" | "draws_cap" | "voice_cap";
const CAP_REASON: Record<Quota, GateReason> = { calls: "calls_cap", draws: "draws_cap", voice_sec: "voice_cap" };

export interface GateOptions {
  owners?: () => string[];
  clock?: () => Date;
  burst?: number;
  windowMs?: number;
  trialDayUsd?: number;
  paidDayUsd?: number;
  giftDayUsd?: number;
  trialPoolDayUsd?: number;
}

/** Проверка перед вызовом модели: доступ (accessOf), частота (не больше burst вызовов за windowMs), денежные потолки за день
 *  (llm_usage, UTC: свой у человека по тарифу и общий у всех проб) и лимиты в штуках (take: ai_quota, день по поясу человека).
 *  Частота, потолки и лимиты — только для пробы, подарка и подписки: друзья и владелец без ограничений. Частота хранится в памяти
 *  и отмечается сразу, до первого await: одновременные запросы не проходят пачкой (из 50 одновременных пройдут burst, остальные —
 *  rate). Штуки берутся последними (после денежных проверок — отказ по деньгам ничего не съедает), каждая — одной атомарной
 *  прибавкой «если не выше лимита»; не хватило одной — уже взятые возвращаются. Отказ по штукам — why money (как денежный
 *  потолок: 429, сообщение заметкой), текст — limitTextOf (лимит 0 — OFF_TEXT; картинки и голос — DRAWS_CAP_TEXT и VOICE_CAP_TEXT). */
export class AiGate {
  private calls = new Map<number, number[]>();
  constructor(private store: Store, private opts: GateOptions = {}) {}

  private now() {
    return this.opts.clock?.() ?? new Date();
  }
  access(u: User, now = this.now()): Access {
    return accessOf(u, now, this.opts.owners?.() ?? ownerIds());
  }
  /** Только доступ (без частоты и денег): фоновые работы планировщика и повтор разбора. */
  allowed(u: User, now = this.now()): boolean {
    return this.access(u, now).ok;
  }
  /** rate: false — без частоты (фоновый повтор; разбор голосового — частоту отметили до распознавания).
   *  client — клиент запроса человека (сайт, виджет, бот…): отказ идёт в счётчик gate.<причина>. Без client (фоновый повтор,
   *  планировщик) — не считается: человек этого отказа не видел. */
  async check(u: User, o: { rate?: boolean; client?: string; take?: Take } = {}): Promise<Verdict> {
    const now = this.now();
    const no = (why: Refusal, reason: GateReason, a: Access, text = refusalText(why, a)): Verdict => {
      if (o.client) countFeature(u, o.client, `gate.${reason}`, 1, now);
      return { ok: false, why, text, reason };
    };
    const a = this.access(u, now);
    if (!a.ok) return no("access", "no_access", a);
    if (a.plan === "owner" || a.plan === "friend") return { ok: true };
    if (o.rate !== false && !this.take(u.id, now.getTime())) return no("rate", "burst", a);
    const day = now.toISOString().slice(0, 10);
    const t = tariffs();
    const est = unpricedOf(t);
    const kind = tariffKindOf(u, a)!;
    const cap = kind === "paid" ? (this.opts.paidDayUsd ?? t.paidDayUsd) : kind === "gift" ? (this.opts.giftDayUsd ?? t.giftDayUsd) : (this.opts.trialDayUsd ?? t.trialDayUsd);
    if ((await this.store.daySpend(u.id, day, est)) >= cap) return no("money", "day_cap", a);
    if (a.plan === "trial" && (await this.store.trialsDaySpend(day, est)) >= (this.opts.trialPoolDayUsd ?? t.trialPoolDayUsd)) {
      return no("money", "trial_pool", a);
    }
    const want = ([["calls", o.take?.calls], ["draws", o.take?.draws], ["voice_sec", o.take?.voiceSec]] as [Quota, number | undefined][])
      .map(([q, n]): [Quota, number] => [q, Math.max(0, Math.ceil(n ?? 0))])
      .filter(([, n]) => n > 0);
    if (!want.length) return { ok: true };
    const qday = quotaDay(u, now);
    const lim = await todayLimits(this.store, u, kind, qday, t);
    const got: [Quota, number][] = [];
    for (const [q, n] of want) {
      if (!(await this.store.takeQuota(u.id, qday, q, n, lim[q]))) {
        for (const [bq, bn] of got) await this.store.giveQuota(u.id, qday, bq, bn);
        return no("money", CAP_REASON[q], a, lim[q] === 0 ? OFF_TEXT : (CAP_TEXT[q] ?? limitTextOf(kind, t)));
      }
      got.push([q, n]);
    }
    return { ok: true, taken: { day: qday, items: got } };
  }
  /** Вернуть взятое: человек ничего не получил (не распознали голос, модель или художник не ответили, поправке модель не нужна). */
  async refund(u: User, taken: Taken | undefined): Promise<void> {
    if (!taken) return;
    for (const [q, n] of taken.items) await this.store.giveQuota(u.id, taken.day, q, n);
  }
  /** Окно частоты: есть место — вызов отмечен (синхронно), нет — false. */
  private take(id: number, t: number): boolean {
    const win = this.opts.windowMs ?? tariffs().aiWindowMs;
    const burst = this.opts.burst ?? tariffs().aiBurst;
    const list = (this.calls.get(id) ?? []).filter((x) => t - x < win);
    if (list.length >= burst) return void this.calls.set(id, list), false;
    list.push(t);
    this.calls.set(id, list);
    if (this.calls.size > 10_000) for (const [k, v] of this.calls) if (!v.some((x) => t - x < win)) this.calls.delete(k);
    return true;
  }
}
