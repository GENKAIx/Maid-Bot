// Платный доступ на сайте (24.11.2026, сервер — server/src/access.ts и billing.ts): блок «Тариф» в настройках и отказ ИИ
// в строке ввода. Сервер отвечает 402 (нет пробы или подписки) с { error, pay_url, messageId, saved } — это не выход
// со входа (401 стирает ключ, api.ts), а просьба оформить подписку; 429 — слишком часто или дневной потолок.
import { ApiError } from "./api";

/** /api/me → access (server/src/access.ts accessView). */
export interface Access {
  /** frozen — аккаунт заморожен админом (server/src/admin-account.ts): вход закрыт, сайт видит это только до выхода. */
  plan: "owner" | "friend" | "paid" | "trial" | "expired" | "frozen";
  until: string | null;
  canceled: boolean;
  trial_left_days: number | null;
  /** Цена подписки в звёздах (сервер api.ts priceOf): у идущей подписки — её цена при оформлении, у остальных — цена новых счетов
   *  (тарифы из базы, server/src/tariffs.ts). Старый сервер не присылает — 150. */
  price?: number;
  /** Остаток лимитов в штуках на сегодня (server/src/access.ts todayView): запросы, картинки, секунды голоса и время сброса —
   *  полночь по поясу человека. Друзья, владелец и без доступа — null; старый сервер — нет поля. */
  today?: Today | null;
}
export interface Today { calls: Used; draws: Used; voice_sec: Used; resets_at: string }
interface Used { used: number; limit: number }

/** Ссылка на оплату — только https://t.me/… (счёт Telegram Stars); любую другую не открываем. */
export const isPayUrl = (u: unknown): u is string => typeof u === "string" && u.length <= 512 && /^https:\/\/t\.me\/\S+$/.test(u);

/** Отказ ИИ от сервера: текст горничной, ссылка на оплату (только у 402), записано ли сообщение заметкой. */
export interface Refused {
  text: string;
  payUrl: string | null;
  messageId: number | null;
  saved: boolean;
}

/** 402 и 429 с полями отказа (server/src/api.ts refuse) — иначе null. 429 без полей (вход, счётчики) — тоже отказ, без ссылки. */
export function refusedOf(e: unknown): Refused | null {
  if (!(e instanceof ApiError) || (e.status !== 402 && e.status !== 429)) return null;
  const d = e.data;
  return {
    text: e.message,
    payUrl: e.status === 402 && isPayUrl(d.pay_url) ? d.pay_url : null,
    messageId: typeof d.messageId === "number" ? d.messageId : null,
    saved: d.saved === true,
  };
}

/** Что делать строке ввода с отказом (Composer.tsx refused): очистить ли (текст записан заметкой), красное ли облачко,
 *  сколько висит, можно ли отменить заметку «↩». Голос, отклонённый до распознавания, и /ask не записаны — строка остаётся. */
export function refusedView(no: Refused | null): { clear: boolean; error: boolean; ms: number; undoId: number | null } {
  return {
    clear: Boolean(no?.saved),
    error: !no?.payUrl,
    ms: no?.payUrl ? 40000 : 14000,
    undoId: no?.saved && no.messageId ? no.messageId : null,
  };
}

const dayText = (iso: string) => new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
const daysWord = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? "день" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? "дня" : "дней");


/** Остатки на сегодня полосками для блока «Тариф» (27.11.2026, дизайн v2): запросы к Рине, картинки (только если они есть
 *  на тарифе) и аудиоразбор в минутах. used/limit — в тех же единицах, что подпись (голос — в минутах). Нет данных — []. */
export interface TodayBar { title: string; used: number; limit: number; left: number }
export function todayBars(t: Today | null | undefined): TodayBar[] {
  if (!t) return [];
  const bar = (title: string, used: number, limit: number): TodayBar => ({ title, used: Math.min(used, limit), limit, left: Math.max(0, limit - used) });
  const out = [bar("Запросы к Рине", t.calls.used, t.calls.limit)];
  if (t.draws.limit > 0) out.push(bar("Картинки", t.draws.used, t.draws.limit));
  out.push(bar("Аудиоразбор, мин", Math.ceil(t.voice_sec.used / 60), Math.floor(t.voice_sec.limit / 60)));
  return out;
}

/** Когда обновятся остатки: «обновятся 25 ноября в 00:00» (полночь по поясу человека, в часах браузера). Нет даты — null. */
export function resetText(t: Today | null | undefined): string | null {
  const at = t ? new Date(t.resets_at) : null;
  if (!at || !Number.isFinite(at.getTime())) return null;
  return `обновятся ${at.toLocaleString("ru-RU", { day: "numeric", month: "long" })} в ${at.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`;
}

/** Сколько дней осталось — число в кольце блока «Тариф»: проба — trial_left_days, подписка — дни до until (вверх). Без срока — null. */
export function daysLeft(a: Access | null | undefined, now = Date.now()): number | null {
  if (!a) return null;
  if (a.plan === "trial") return a.trial_left_days ?? null;
  if (a.plan === "paid" && a.until) {
    const ms = new Date(a.until).getTime() - now;
    return Number.isFinite(ms) ? Math.max(0, Math.ceil(ms / 86_400_000)) : null;
  }
  return null;
}

export interface PlanView { title: string; text: string; pay: boolean; cancel: boolean; resume: boolean }

/** Что показать в блоке «Тариф»: название, пояснение, нужна ли кнопка оплаты, «Отменить продление» и «Возобновить продление».
 *  Отменённую подписку оплатой заново не предлагаем, пока она идёт (вторая подписка списала бы звёзды дважды, сервер её и не
 *  примет — billing.ts payable), — её возобновляют (та же подписка, POST /api/billing/resume). */
export function planView(a: Access | null | undefined, price = a?.price ?? 150): PlanView {
  const no = { pay: false, cancel: false, resume: false };
  if (!a) return { ...no, title: "—", text: "Сервер не сообщил тариф." };
  if (a.plan === "owner") return { ...no, title: "Владелец", text: "Всё бесплатно и без ограничений." };
  if (a.plan === "friend") return { ...no, title: "Друг", text: "Бесплатно навсегда — спасибо, что с нами с самого начала." };
  if (a.plan === "frozen") return { ...no, title: "Приостановлен", text: "Аккаунт приостановлен — записи сохранены. Вопросы — /paysupport в боте." };
  if (a.plan === "trial") {
    const n = a.trial_left_days ?? 0;
    const until = a.until ? ` (до ${dayText(a.until)})` : "";
    return { ...no, title: "Пробный период", text: `Осталось ${n} ${daysWord(n)}${until}. Потом — подписка ⭐${price} в месяц, чтобы я и дальше разбирала сообщения.`, pay: true };
  }
  if (a.plan === "paid") {
    const until = a.until ? dayText(a.until) : "—";
    return a.canceled
      ? { ...no, title: "Подписка", text: `Продление отменено, доступ — до ${until}. Передумали — возобновите продление здесь или в Telegram (Настройки → Мои звёзды → Подписки).`, resume: true }
      : { ...no, title: "Подписка", text: `⭐${price} в месяц, следующее списание — ${until}. Отменить можно здесь или в настройках Telegram.`, cancel: true };
  }
  return {
    ...no,
    title: "Без подписки",
    text: `ИИ выключен: я не разбираю новые сообщения, но всё записанное, отметки, кнопки и напоминания остаются бесплатно. Подписка — ⭐${price} в месяц.`,
    pay: true,
  };
}

/** Показать ли поле «Промокод» в блоке «Тариф» (этап 6, server/src/promo.ts): проба, кончившийся срок и подписка без продления.
 *  Владельцу и другу код не нужен, приостановленному не применить, идущую подписку с продлением код не продлевает. */
export function promoAllowed(a: Access | null | undefined): boolean {
  if (!a) return false;
  if (a.plan === "trial" || a.plan === "expired") return true;
  return a.plan === "paid" && a.canceled;
}
