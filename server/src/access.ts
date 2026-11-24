import { config } from "./config.ts";
import type { Store, User } from "./db.ts";

// Платный доступ (24.11.2026): одна проверка «можно ли тратить ИИ на этого человека» для бота, сайта, конвейера и планировщика.
// Бесплатно навсегда — всё без модели: просмотр своих данных, кнопки и отметки, ручные правки, push-кнопки, напоминания и вопросы
// про привычки. Платно — всё, что зовёт модель: разбор новых сообщений, разговор, ответы, /ask, голос, фото, рисунки, поправки,
// слова горничной утром и вечером, закономерности, фоновый повтор разбора.
// Кто с доступом: владелец (ALLOWED_CHAT_IDS и ADMIN_CHAT_IDS), друг (plan = friend: все, кто был в базе до шага 27, и записи из
// командной строки), проба или подарок (trial) и подписка (paid) — пока не кончился access_until (+ GRACE_MS запаса на продление).

/** Запас после конца срока: продление Telegram может прийти чуть позже. */
export const GRACE_MS = 60 * 60_000;

export type Plan = "owner" | "friend" | "paid" | "trial" | "expired";
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

/** Подарок по /invite хранится как trial, но срок у него длиннее пробы: от создания записи дальше trialDays + 1 дня. */
export const endedOf = (u: User): Ended => {
  if (u.plan === "paid" || u.sub_charge_id) return "paid";
  const made = Date.parse(u.created_at ?? "");
  const until = Date.parse(u.access_until ?? "");
  return Number.isFinite(made) && Number.isFinite(until) && until - made > (config.billing.trialDays + 1) * 86_400_000 ? "gift" : "trial";
};

/** Владельцы — всегда с доступом. */
export const ownerIds = (): string[] => [...new Set([...config.allowedChatIds, ...config.adminChatIds])];

export function accessOf(u: User, now = new Date(), owners = ownerIds()): Access {
  const base = { until: null, canceled: Boolean(Number(u.sub_canceled ?? 0)), trialLeftDays: null, ended: null };
  if (u.chat_id && owners.includes(String(u.chat_id))) return { ...base, ok: true, plan: "owner" };
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

export type Refusal = "access" | "rate" | "money";
export type Verdict = { ok: true } | { ok: false; why: Refusal; text: string };

/** Срок кончился (отказ ИИ и письмо планировщика): пробная неделя — словами пользователя; подарок и подписка — свои первые слова. */
export function endedText(e: Ended | null, price = config.billing.price): string {
  const what = e === "gift" ? "Подарочный доступ закончился" : e === "paid" ? "Подписка закончилась" : "Пробная неделя закончилась";
  return `${what} — я сохранила всё, что было. Чтобы я снова разбирала сообщения, оформите подписку ⭐${price} в месяц`;
}

/** Слишком часто, а сообщение не сохранить для повтора (голос, картинка, /ask) — просьба прислать ещё раз. */
export const RATE_AGAIN = "Много сообщений подряд — пришлите это ещё раз через минуту, пожалуйста.";

/** Тексты отказа. access и money — сообщение записывается заметкой (pipeline.ts blocked); rate — сообщение «не удалось»,
 *  его разберёт фоновый повтор. */
export function refusalText(why: Refusal, a: Access | null, price = config.billing.price): string {
  if (why === "rate") return "Много сообщений подряд — это разберу чуть позже сама (или нажмите «Повторить»).";
  if (why === "money") return "На сегодня лимит разбора исчерпан — завтра продолжу как обычно.";
  return endedText(a?.ended ?? null, price);
}

export interface GateOptions {
  owners?: () => string[];
  clock?: () => Date;
  burst?: number;
  windowMs?: number;
  trialDayUsd?: number;
  paidDayUsd?: number;
  trialPoolDayUsd?: number;
}

/** Проверка перед вызовом модели: доступ (accessOf), частота (не больше burst вызовов за windowMs) и денежные потолки за день
 *  (llm_usage, UTC: свой у человека и общий у всех проб). Частота и потолки — только для пробы и подписки: друзья и владелец без
 *  ограничений. Частота хранится в памяти и отмечается сразу, до первого await: одновременные запросы не проходят пачкой
 *  (из 50 одновременных пройдут burst, остальные — rate). */
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
  /** rate: false — без частоты (фоновый повтор; разбор голосового — частоту отметили до распознавания). */
  async check(u: User, o: { rate?: boolean } = {}): Promise<Verdict> {
    const now = this.now();
    const a = this.access(u, now);
    if (!a.ok) return { ok: false, why: "access", text: refusalText("access", a) };
    if (a.plan === "owner" || a.plan === "friend") return { ok: true };
    if (o.rate !== false && !this.take(u.id, now.getTime())) return { ok: false, why: "rate", text: refusalText("rate", a) };
    const day = now.toISOString().slice(0, 10);
    const est = config.billing.unpricedUsd;
    const cap = a.plan === "paid" ? (this.opts.paidDayUsd ?? config.billing.paidDayUsd) : (this.opts.trialDayUsd ?? config.billing.trialDayUsd);
    if ((await this.store.daySpend(u.id, day, est)) >= cap) return { ok: false, why: "money", text: refusalText("money", a) };
    if (a.plan === "trial" && (await this.store.trialsDaySpend(day, est)) >= (this.opts.trialPoolDayUsd ?? config.billing.trialPoolDayUsd)) {
      return { ok: false, why: "money", text: refusalText("money", a) };
    }
    return { ok: true };
  }
  /** Окно частоты: есть место — вызов отмечен (синхронно), нет — false. */
  private take(id: number, t: number): boolean {
    const win = this.opts.windowMs ?? config.billing.aiWindowMs;
    const burst = this.opts.burst ?? config.billing.aiBurst;
    const list = (this.calls.get(id) ?? []).filter((x) => t - x < win);
    if (list.length >= burst) return void this.calls.set(id, list), false;
    list.push(t);
    this.calls.set(id, list);
    if (this.calls.size > 10_000) for (const [k, v] of this.calls) if (!v.some((x) => t - x < win)) this.calls.delete(k);
    return true;
  }
}
