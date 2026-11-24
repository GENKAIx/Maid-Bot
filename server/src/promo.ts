import crypto from "node:crypto";
import { isFrozen, ownerIds } from "./access.ts";
import { extendPatch, renewingSub } from "./admin-account.ts";
import type { PromoRow, Store, User } from "./db.ts";

// Промокоды, которые дарят дни (этап 6 «Тарифы и управление», 24.11.2026; макет — вкладка «Промокоды»). Звёздную подписку нельзя
// продать со скидкой, поэтому код дарит дни — как «Продлить» в карточке аккаунта (admin-account.ts extendPatch): идёт проба,
// подарок или подписка без продления — дни прибавляются к сроку; срок кончился — доступ от сегодня (проба — снова пробой, иначе
// подарком). Идущую подписку с продлением код не трогает: Telegram в свой день поставит конец оплаченного месяца, и добавленные дни
// пропали бы — человеку честно говорим, что код не для него. Друзьям и владельцу код не нужен (доступ и так навсегда).
// Один человек — один промокод (promo_uses.user_id — ключ), код применяется не больше max_uses раз и до ends_at. Перебор кодов —
// не больше PROMO_TRIES неудачных попыток за PROMO_WINDOW_MS на человека (в памяти процесса), потом 429.
// Админка (POST /api/admin/promo…): создать (свой код или сгенерировать), выключить и включить — с причиной в журнал админа.
// Готовых кодов в коде и в миграции нет: все создаёт владелец.

export const PROMO_DAYS_MAX = 365;
export const PROMO_USES_MAX = 100_000;
export const PROMO_TRIES = 5;
export const PROMO_WINDOW_MS = 15 * 60_000;
/** Код: латиница и цифры, можно дефис; 4–20 знаков; хранится заглавными. */
export const PROMO_RE = /^[A-Z0-9-]{4,20}$/;
/** Знаки сгенерированного кода — без похожих (0/O, 1/I/L). */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** Тексты человеку (на согласование). */
export const PROMO_TEXT = {
  bad: "Такого кода нет — проверьте буквы и цифры.",
  off: "Этот код больше не действует.",
  empty: "Этот код уже закончился.",
  again: "Вы уже применили промокод — второй не добавится.",
  free: "У вас и так полный доступ навсегда — код не нужен.",
  sub: "У вас идёт подписка — промокод для тех, у кого её нет.",
  frozen: "Аккаунт приостановлен — код сейчас не применить.",
  tries: (min: number) => `Слишком много попыток — попробуйте через ${min} мин.`,
  done: (days: number, until: string) => `Готово: +${days} ${daysWord(days)}, доступ — до ${until.slice(0, 10).split("-").reverse().join(".")} ✨`,
};

const daysWord = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? "день" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? "дня" : "дней");

export class PromoError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export const normCode = (v: unknown): string => (typeof v === "string" ? v.trim().toUpperCase().replace(/\s+/g, "") : "");
export function generateCode(len = 8): string {
  let s = "";
  for (let i = 0; i < len; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return s;
}

/** Состояние кода одной строкой (и для админки, и для отказа человеку). */
export function promoState(p: Pick<PromoRow, "enabled" | "used" | "max_uses" | "ends_at">, now = new Date()): "on" | "off" | "ended" | "empty" {
  if (!p.enabled) return "off";
  if (p.used >= p.max_uses) return "empty";
  if (p.ends_at && Date.parse(p.ends_at) <= now.getTime()) return "ended";
  return "on";
}

/** Неудачные попытки по человеку: моменты за окно. */
const fails = new Map<number, number[]>();
/** Только для тестов. */
export const resetPromoTries = () => fails.clear();
function waitMs(userId: number, now: number): number {
  const list = (fails.get(userId) ?? []).filter((t) => now - t < PROMO_WINDOW_MS);
  fails.set(userId, list);
  return list.length >= PROMO_TRIES ? PROMO_WINDOW_MS - (now - list[0]) : 0;
}
function failed(userId: number, now: number) {
  fails.set(userId, [...(fails.get(userId) ?? []), now]);
  if (fails.size > 10_000) for (const [k, v] of fails) if (!v.some((t) => now - t < PROMO_WINDOW_MS)) fails.delete(k);
}
/** Снять одну отметку попытки (успех или отказ, который не считается). */
function unfail(userId: number, at: number) {
  const list = fails.get(userId);
  const i = list ? list.indexOf(at) : -1;
  if (list && i >= 0) list.splice(i, 1);
}

/** Человек вводит код (POST /api/promo): ответ — текст и новый конец срока. Отказ — PromoError с понятным текстом. */
export async function redeemPromo(store: Store, u: User, raw: unknown, now = new Date(), owners = ownerIds()) {
  const t = now.getTime();
  const wait = waitMs(u.id, t);
  if (wait) throw new PromoError(429, PROMO_TEXT.tries(Math.max(1, Math.ceil(wait / 60_000))));
  const code = normCode(raw);
  if (!PROMO_RE.test(code)) {
    failed(u.id, t);
    throw new PromoError(400, PROMO_TEXT.bad);
  }
  // Условия человека — до поиска кода (и до отметки попытки): друг и подписчик не тратят попытки перебора и не узнают, есть ли
  // такой код.
  if (u.plan === "friend" || (Boolean(u.chat_id) && owners.includes(String(u.chat_id)))) throw new PromoError(409, PROMO_TEXT.free);
  if (isFrozen(u)) throw new PromoError(409, PROMO_TEXT.frozen);
  if (renewingSub(u, now)) throw new PromoError(409, PROMO_TEXT.sub);
  // Попытка отмечается сразу, до первого await (как частота в AiGate): пачка одновременных запросов не проходит мимо PROMO_TRIES.
  // Успех и отказ, который не считается (count = false), отметку снимают.
  failed(u.id, t);
  let keep = false;
  const no = (status: number, text: string, count = true): never => {
    keep = count;
    throw new PromoError(status, text);
  };
  try {
    return await redeemTry(store, u, code, now, no);
  } finally {
    if (!keep) unfail(u.id, t);
  }
}
async function redeemTry(store: Store, u: User, code: string, now: Date, no: (status: number, text: string, count?: boolean) => never) {
  if (await store.promoUseOf(u.id)) no(409, PROMO_TEXT.again, false);
  const p = await store.promoByCode(code);
  if (!p) return no(404, PROMO_TEXT.bad);
  const st = promoState(p, now);
  if (st === "empty") no(409, PROMO_TEXT.empty);
  if (st !== "on") no(409, PROMO_TEXT.off);
  const took = await store.takePromo(u.id, p.id, p.days, now);
  if (took === "mine") no(409, PROMO_TEXT.again, false);
  if (took === "gone") no(409, PROMO_TEXT.empty);
  const { patch, until } = extendPatch(u, p.days, now);
  try {
    await store.updateUser(u.id, patch);
  } catch (e) {
    await store.dropPromoUse(u.id, p.id, true);
    throw e;
  }
  try {
    await store.addBillingEvent({ user_id: u.id, kind: "promo", at: now, amount: p.days });
  } catch (e) {
    console.error("[promo] журнал подписки", (e as Error).message);
  }
  return { ok: true, days: p.days, until, text: PROMO_TEXT.done(p.days, until) };
}

const reasonOf = (v: unknown): string => {
  const r = typeof v === "string" ? v.trim() : "";
  if (r.length < 3) throw new PromoError(400, "напишите причину (хотя бы 3 знака)");
  if (r.length > 300) throw new PromoError(400, "причина — не длиннее 300 знаков");
  return r;
};
const intIn = (v: unknown, min: number, max: number, what: string): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new PromoError(400, `${what}: целое от ${min} до ${max}`);
  return v;
};

/** Создать код (POST /api/admin/promo): code — свой (PROMO_RE) или generate: true; days, max_uses, until — «ГГГГ-ММ-ДД»
 *  включительно (до конца этого дня UTC) или пусто — без срока; причина обязательна. */
export async function createPromo(store: Store, by: number, body: unknown, now = new Date()) {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const reason = reasonOf(b.reason);
  const days = intIn(b.days, 1, PROMO_DAYS_MAX, "дней");
  const max = intIn(b.max_uses, 1, PROMO_USES_MAX, "сколько раз");
  let ends: string | null = null;
  if (b.until != null && b.until !== "") {
    if (typeof b.until !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(b.until) || Number.isNaN(Date.parse(`${b.until}T00:00:00Z`))) throw new PromoError(400, "срок — дата ГГГГ-ММ-ДД");
    ends = new Date(Date.parse(`${b.until}T00:00:00Z`) + 86_400_000 - 1).toISOString();
    if (Date.parse(ends) <= now.getTime()) throw new PromoError(400, "срок уже прошёл");
  }
  let code = b.generate === true ? generateCode() : normCode(b.code);
  if (!PROMO_RE.test(code)) throw new PromoError(400, "код: латиница, цифры и дефис, 4–20 знаков");
  let id = await store.addPromoCode({ code, days, max_uses: max, ends_at: ends, at: now, by });
  // Сгенерированный совпал с существующим (почти невозможно) — ещё попытка; свой — 409.
  for (let i = 0; !id && b.generate === true && i < 5; i++) {
    code = generateCode();
    id = await store.addPromoCode({ code, days, max_uses: max, ends_at: ends, at: now, by });
  }
  if (!id) throw new PromoError(409, `код ${code} уже есть`);
  await store.addAdminLog(by, "promo_create", `${code}: +${days} дн., ${max} раз${ends ? `, до ${ends.slice(0, 10)}` : ""}`, now, reason);
  return { id, code, ...(await promoView(store, now)) };
}

/** Выключить или включить код (POST /api/admin/promo/toggle): причина обязательна. Применённые дни не отнимаются. */
export async function togglePromo(store: Store, by: number, body: unknown, now = new Date()) {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const reason = reasonOf(b.reason);
  const id = intIn(b.id, 1, 2_147_483_647, "номер кода");
  if (typeof b.on !== "boolean") throw new PromoError(400, "вкл — да или нет");
  const p = await store.promoById(id);
  if (!p) throw new PromoError(404, "нет такого кода");
  if (Boolean(p.enabled) === b.on) throw new PromoError(400, "уже так");
  await store.setPromoEnabled(id, b.on);
  await store.addAdminLog(by, b.on ? "promo_on" : "promo_off", `${p.code}: применён ${p.used} из ${p.max_uses}`, now, reason);
  return promoView(store, now);
}

/** Раздел «Промокоды»: коды, сколько применено, срок, состояние. Кто применил — не показываем (только число). */
export async function promoView(store: Store, now = new Date()) {
  return {
    days_max: PROMO_DAYS_MAX, uses_max: PROMO_USES_MAX, tries: PROMO_TRIES, window_min: PROMO_WINDOW_MS / 60_000,
    codes: (await store.promoCodes()).map((p) => ({
      id: p.id, code: p.code, days: p.days, used: p.used, max_uses: p.max_uses, ends_at: p.ends_at, created_at: p.created_at,
      created_by: `#${p.created_by}`, state: promoState(p, now),
    })),
  };
}
