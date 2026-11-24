import crypto from "node:crypto";
import { tariffs } from "./tariffs.ts";
import type { BillingKind, Store, User } from "./db.ts";
import { accessOf, endedOf, endedText, GRACE_MS, isFrozen } from "./access.ts";
import { esc } from "./report.ts";

// Подписка Telegram Stars (24.11.2026): ⭐price в месяц, Telegram сам продлевает её каждые 30 дней (subscription_period 2592000).
// Продать подписку можно только ссылкой createInvoiceLink (у sendInvoice периода нет): бот ставит её на кнопку, сайт и виджет
// открывают её в Telegram. В payload — чья это оплата, с подписью сервера: s1:<userId>:<nonce>:<sig> (≤ 128 байт).
// Обработчики оплаты стоят в боте ДО фильтра незнакомцев (bot.ts): pre_checkout_query приходит без чата, а successful_payment —
// из чата, который ещё может быть не привязан. Повтор того же обновления ничего не меняет: ключ payments — charge_id.
// Отдельного сообщения «подписку отменили в настройках Telegram» нет: доступ держится на access_until (+ GRACE_MS), а планировщик
// раз в час переводит кончившиеся сроки в free и пишет человеку (expire). Все вызовы Telegram — через StarsApi: тесты подменяют его.

/** Период подписки Telegram Stars — всегда 30 дней. */
export const SUB_PERIOD_SEC = 2_592_000;
/** Ссылка на оплату живёт в kv столько (новая — после): createInvoiceLink не дёргается на каждый отказ. */
export const LINK_TTL_MS = 24 * 3600_000;
/** За сколько до конца отменённой подписки напомнить. */
export const REMIND_BEFORE_MS = 3 * 86_400_000;
/** Подписка идёт и до конца больше суток — новую оплату не принимаем (вторая подписка списывала бы звёзды дважды). Ближе к концу —
 *  принимаем: не проверено, проходит ли автопродление через pre_checkout_query, и отклонить его нельзя. */
export const RENEW_WINDOW_MS = 86_400_000;

/** Те методы Bot API, что нужны оплате (bot.api подходит как есть; тесты подставляют заглушку). */
export interface StarsApi {
  createInvoiceLink(title: string, description: string, payload: string, provider_token: string, currency: string,
    prices: { label: string; amount: number }[], other?: { subscription_period?: number }): Promise<string>;
  answerPreCheckoutQuery(pre_checkout_query_id: string, ok: boolean, other?: { error_message?: string }): Promise<true>;
  refundStarPayment(user_id: number, telegram_payment_charge_id: string): Promise<true>;
  editUserStarSubscription(user_id: number, telegram_payment_charge_id: string, is_canceled: boolean): Promise<true>;
  sendMessage(chat_id: number | string, text: string, other?: {
    parse_mode?: "HTML"; link_preview_options?: { is_disabled?: boolean };
    reply_markup?: { inline_keyboard: { text: string; url: string }[][] };
  }): Promise<unknown>;
}

/** Секрет подписи payload — из токена бота, как секрет вебхука (webhook.ts): в .env ничего добавлять не надо. */
export function billingSecret(botToken: string): string {
  return crypto.createHmac("sha256", botToken).update("maid-billing-payload").digest("hex");
}

const sigOf = (secret: string, body: string) => crypto.createHmac("sha256", secret).update(body).digest("base64url").slice(0, 22);

export function signPayload(secret: string, userId: number, nonce = crypto.randomBytes(6).toString("base64url")): string {
  const body = `s1:${userId}:${nonce}`;
  return `${body}:${sigOf(secret, body)}`;
}
/** Чья оплата: номер пользователя, если подпись верна; иначе null. */
export function readPayload(secret: string, payload: string): number | null {
  const m = /^s1:(\d{1,12}):([\w-]{1,24}):([\w-]{22})$/.exec(payload);
  if (!m) return null;
  const want = Buffer.from(sigOf(secret, `s1:${m[1]}:${m[2]}`));
  const got = Buffer.from(m[3]);
  return want.length === got.length && crypto.timingSafeEqual(want, got) ? Number(m[1]) : null;
}

export interface PreCheckout { id: string; from: { id: number }; currency: string; total_amount: number; invoice_payload: string }
export interface Paid {
  currency: string; total_amount: number; invoice_payload: string; telegram_payment_charge_id: string;
  subscription_expiration_date?: number; is_recurring?: true; is_first_recurring?: true;
}
export interface Refunded { currency: string; total_amount: number; invoice_payload: string; telegram_payment_charge_id: string }

export interface BillingOptions {
  secret: string;
  /** Цена для тестов; без неё — текущая из тарифов (tariffs.ts price), читается на каждый счёт. */
  price?: number;
  /** Кому писать о платежах (владельцы); пусто — никому. */
  owners?: string[];
  clock?: () => Date;
}

const day = (iso: string) => iso.slice(0, 10).split("-").reverse().join(".");

export class Billing {
  constructor(private store: Store, private api: StarsApi | null, private opts: BillingOptions) {}
  /** Цена нового счёта — текущая из тарифов: новая цена действует на новые счета, уже оформленную подписку Telegram продлевает
   *  по цене при оформлении. */
  private get price(): number {
    return this.opts.price ?? tariffs().price;
  }
  private now() {
    return this.opts.clock?.() ?? new Date();
  }
  get ready() {
    return Boolean(this.api);
  }

  /** Можно ли этому человеку оплатить: null — можно, иначе почему нет. Владельцу и другу платить не нужно; у кого подписка идёт
   *  (и до конца больше RENEW_WINDOW_MS) — вторая не нужна, отменённую возобновляют (/resume_sub). */
  payable(u: User, now = this.now()): string | null {
    const a = accessOf(u, now);
    if (a.plan === "owner" || a.plan === "friend") return "У вас и так бесплатный доступ навсегда — платить не нужно.";
    if (isFrozen(u)) return "Аккаунт приостановлен — оплата сейчас недоступна. Вопросы — /paysupport в боте.";
    if (a.plan === "paid" && Date.parse(a.until ?? "") - now.getTime() > RENEW_WINDOW_MS) {
      return a.canceled
        ? `Подписка и так идёт до ${day(a.until!)}. Чтобы она продлевалась дальше, возобновите продление: /resume_sub в боте или в Telegram (Настройки → Мои звёзды → Подписки).`
        : `Подписка уже идёт до ${day(a.until!)} и продлится сама — вторая не нужна.`;
    }
    return null;
  }

  /** Ссылка на оплату подписки (на сутки в kv paylink:<id>); бота нет, платить не нужно (payable) или Telegram не ответил — null. */
  async link(u: User): Promise<string | null> {
    if (!this.api || this.payable(u)) return null;
    const now = this.now().getTime();
    try {
      // Ссылка помнит свою цену: цену поменяли в админке (tariffs.ts) — старая ссылка не годится, нужна новая.
      const saved = JSON.parse((await this.store.kvGet(`paylink:${u.id}`)) ?? "null") as { url: string; at: number; price?: number } | null;
      if (saved && now - saved.at < LINK_TTL_MS && (saved.price ?? this.price) === this.price) return saved.url;
    } catch { /* битая запись — новая ссылка */ }
    try {
      const url = await this.api.createInvoiceLink(
        "Горничная · месяц", "Разбор сообщений, ответы, голос и фото — в боте, на сайте и в программе на ПК. Продлевается каждый месяц.",
        signPayload(this.opts.secret, u.id), "", "XTR", [{ label: "Подписка на месяц", amount: this.price }], { subscription_period: SUB_PERIOD_SEC },
      );
      await this.store.kvSet(`paylink:${u.id}`, JSON.stringify({ url, at: now, price: this.price }));
      return url;
    } catch (e) {
      console.error("[billing] ссылка", (e as Error).message);
      return null;
    }
  }

  /** Проверка перед оплатой (ответить за 10 с): подпись, человек, валюта и сумма, этот Telegram не привязан к другому. */
  async preCheckout(q: PreCheckout): Promise<{ ok: boolean; error?: string }> {
    const r = await this.checkout(q);
    await this.api?.answerPreCheckoutQuery(q.id, r.ok, r.ok ? undefined : { error_message: r.error })
      .catch((e) => console.error("[billing] pre_checkout", (e as Error).message));
    return r;
  }
  private async checkout(q: PreCheckout): Promise<{ ok: boolean; error?: string }> {
    const id = readPayload(this.opts.secret, q.invoice_payload);
    const u = id ? await this.store.user(id) : undefined;
    if (!u) return { ok: false, error: "Счёт устарел — откройте оплату заново из бота или с сайта." };
    // Только нынешняя цена: продление оформленной подписки идёт без pre_checkout_query (сразу successful_payment с is_recurring),
    // а старая ссылка на оплату бессрочна — принимать по ней старую сумму значило бы продавать новую подписку по прежней цене.
    if (q.currency !== "XTR" || q.total_amount !== this.price) return { ok: false, error: "Цена изменилась — откройте оплату заново." };
    const why = this.payable(u);
    if (why) return { ok: false, error: why };
    const other = await this.store.userByTg(String(q.from.id));
    if (other && other.id !== u.id) return { ok: false, error: `Этот Telegram уже привязан к другой учётной записи (${other.login ?? `#${other.id}`}).` };
    return { ok: true };
  }

  /** Оплата прошла (первая, продление или разовая). Повтор с тем же charge_id — duplicate, ничего не меняется.
   *  Чат к записи оплата НЕ привязывает (ссылку мог оплатить кто угодно, у кого она есть): запоминается только tg_user_id
   *  плательщика — для отмены продления и возврата. Срок — не короче нынешнего (подарок по /invite не пропадает при продлении). */
  async paid(from: { id: number }, p: Paid): Promise<{ user: User; kind: string; duplicate: boolean; until: string } | null> {
    const now = this.now();
    const tg = String(from.id);
    const id = readPayload(this.opts.secret, p.invoice_payload);
    const u = (id ? await this.store.user(id) : undefined) ?? (await this.store.userByTg(tg));
    if (!u) {
      console.error("[billing] оплата без учётной записи", p.telegram_payment_charge_id.slice(-8));
      await this.toOwners(`⚠ Оплата ⭐${p.total_amount} без учётной записи (charge …${esc(p.telegram_payment_charge_id.slice(-8))}). Нужен возврат вручную.`);
      return null;
    }
    const kind = p.is_first_recurring ? "first" : p.is_recurring ? "renew" : "once";
    const base = Math.max(now.getTime(), u.access_until && u.plan === "paid" ? Date.parse(u.access_until) : 0);
    const exp = p.subscription_expiration_date ? p.subscription_expiration_date * 1000 : base + SUB_PERIOD_SEC * 1000;
    const had = u.access_until && (u.plan === "paid" || u.plan === "trial") ? Date.parse(u.access_until) : 0;
    const until = new Date(Math.max(exp, Number.isFinite(had) ? had : 0)).toISOString();
    const fresh = await this.store.addPayment({
      charge_id: p.telegram_payment_charge_id, user_id: u.id, tg_user_id: tg, amount: p.total_amount, currency: p.currency,
      payload: p.invoice_payload, kind, paid_at: now.toISOString(), expires_at: until,
    });
    if (!fresh) return { user: u, kind, duplicate: true, until: u.access_until ?? until };
    // Друг остаётся другом (бесплатно навсегда), даже если оплатил: оплата только записывается.
    const patch: Partial<User> = { plan: u.plan === "friend" ? "friend" : "paid", access_until: until, tg_user_id: tg };
    // Продление списано — значит, подписка снова идёт (её могли возобновить в Telegram после /cancel_sub).
    patch.sub_canceled = 0;
    if (kind === "first" || !u.sub_charge_id) patch.sub_charge_id = p.telegram_payment_charge_id;
    await this.store.updateUser(u.id, patch);
    await this.journal(u.id, kind === "first" ? "paid_first" : kind === "renew" ? "renewed" : "paid_once", p.telegram_payment_charge_id, p.total_amount);
    await this.store.kvDel(`paylink:${u.id}`);
    await this.toOwners(`⭐ ${kind === "renew" ? "Продление" : "Оплата"}: ${esc(u.login ?? `#${u.id}`)}, ⭐${p.total_amount}, до ${day(until)}.`);
    return { user: (await this.store.user(u.id))!, kind, duplicate: false, until };
  }

  /** Возврат (наш refundStarPayment или спор в Telegram): пометить, доступ снять. Повтор — ничего не меняет. */
  async refunded(p: Refunded): Promise<User | null> {
    const pay = await this.store.payment(p.telegram_payment_charge_id);
    if (!pay) return null;
    const now = this.now().toISOString();
    if (!(await this.store.setPaymentRefunded(pay.charge_id, now))) return null;
    await this.journal(pay.user_id, "refunded", pay.charge_id, pay.amount);
    const u = await this.store.user(pay.user_id);
    if (!u) return null;
    if (u.plan === "paid") await this.store.updateUser(u.id, { plan: "free", access_until: now, sub_canceled: 1 });
    return (await this.store.user(u.id))!;
  }

  /** Идёт ли подписка Telegram у записи (по последней оплате, а не по плану: друг, который оплатил, тоже может её отменить). */
  private live(u: User): boolean {
    return Boolean(u.sub_charge_id && u.tg_user_id && Date.parse(u.access_until ?? "") + GRACE_MS > this.now().getTime());
  }

  /** Отменить продление (/cancel_sub, сайт): доступ остаётся до access_until. */
  async cancel(u: User): Promise<{ ok: boolean; text: string }> {
    if (!this.live(u)) return { ok: false, text: "Подписки нет — отменять нечего." };
    if (Number(u.sub_canceled)) return { ok: true, text: `Продление уже отменено. Доступ — до ${day(u.access_until ?? "")}.` };
    if (!this.api) return { ok: false, text: "Бот сейчас выключен — отмените подписку в настройках Telegram (Мои звёзды → Подписки)." };
    try {
      await this.api.editUserStarSubscription(Number(u.tg_user_id), u.sub_charge_id!, true);
    } catch (e) {
      console.error("[billing] отмена", (e as Error).message);
      return { ok: false, text: "Telegram не ответил — попробуйте позже или отмените в настройках Telegram (Мои звёзды → Подписки)." };
    }
    await this.store.updateUser(u.id, { sub_canceled: 1 });
    await this.journal(u.id, "canceled");
    return { ok: true, text: `Продление отменено. Доступ остаётся до ${day(u.access_until ?? "")}, звёзды больше не спишутся.` };
  }

  /** Возобновить отменённое продление (/resume_sub, сайт) — та же подписка, без второй оплаты. */
  async resume(u: User): Promise<{ ok: boolean; text: string }> {
    if (!this.live(u)) return { ok: false, text: "Подписки нет — её можно оформить заново." };
    if (!Number(u.sub_canceled)) return { ok: true, text: `Подписка и так продлевается. Следующее списание — ${day(u.access_until ?? "")}.` };
    if (!this.api) return { ok: false, text: "Бот сейчас выключен — возобновите подписку в настройках Telegram (Мои звёзды → Подписки)." };
    try {
      await this.api.editUserStarSubscription(Number(u.tg_user_id), u.sub_charge_id!, false);
    } catch (e) {
      console.error("[billing] возобновить", (e as Error).message);
      return { ok: false, text: "Telegram не ответил — попробуйте позже или возобновите в настройках Telegram (Мои звёзды → Подписки)." };
    }
    await this.store.updateUser(u.id, { sub_canceled: 0 });
    await this.journal(u.id, "resumed");
    return { ok: true, text: `Продление возобновлено: следующее списание — ${day(u.access_until ?? "")}.` };
  }

  /** Возврат последней оплаты человека (владелец: /refund в боте, кнопка в админке). by — кто вернул (журнал admin_log).
   *  reason — причина в журнал (в админке обязательна). charge — хвост charge_id выбранной в админке оплаты («…12345678», как в
   *  списке оплат): возвращается только последняя невозвращённая, и если выбрана другая (список устарел) — отказ без возврата. */
  async refund(userId: number, by: number, o: { reason?: string; charge?: string } = {}): Promise<{ ok: boolean; text: string }> {
    const u = await this.store.user(userId);
    if (!u) return { ok: false, text: `Нет пользователя #${userId}.` };
    const pay = (await this.store.paymentsOf(userId)).find((x) => !x.refunded_at);
    if (!pay) return { ok: false, text: `У #${userId} нет оплат для возврата.` };
    if (o.charge && o.charge.replace(/^…/, "") !== pay.charge_id.slice(-8)) {
      return { ok: false, text: "Вернуть можно только последнюю невозвращённую оплату — обновите список и выберите её." };
    }
    if (!this.api) return { ok: false, text: "Бот выключен — вернуть звёзды нельзя." };
    // Сначала — отменить продление: не проверено, закрывает ли подписку сам возврат; без этого через месяц звёзды спишутся снова.
    if (u.sub_charge_id && u.tg_user_id && !Number(u.sub_canceled)) {
      await this.api.editUserStarSubscription(Number(u.tg_user_id), u.sub_charge_id, true)
        .catch((e) => console.error("[billing] возврат: отмена продления", (e as Error).message));
    }
    try {
      await this.api.refundStarPayment(Number(pay.tg_user_id), pay.charge_id);
    } catch (e) {
      console.error("[billing] возврат", (e as Error).message);
      await this.store.addAdminLog(by, "refund-fail", `#${userId} ⭐${pay.amount}`, this.now(), o.reason ?? "");
      return { ok: false, text: `Telegram не вернул: ${(e as Error).message.slice(0, 120)}` };
    }
    await this.refunded({ currency: pay.currency, total_amount: pay.amount, invoice_payload: pay.payload, telegram_payment_charge_id: pay.charge_id });
    await this.store.addAdminLog(by, "refund", `#${userId} ⭐${pay.amount}`, this.now(), o.reason ?? "");
    return { ok: true, text: `Вернула ⭐${pay.amount} пользователю #${userId}, доступ снят.` };
  }

  /** Раз в час (планировщик): кончившиеся пробы и подписки → free с письмом и кнопкой оплаты; за 3 дня до конца отменённой
   *  подписки — напоминание. Блокирует ИИ не это, а accessOf (сразу по сроку), здесь — только письмо и план. */
  async expire(now = this.now()) {
    for (const u of await this.store.usersToExpire(new Date(now.getTime() - GRACE_MS).toISOString())) {
      const ended = endedOf(u);
      await this.store.updateUser(u.id, { plan: "free" });
      // Что кончилось — разными видами: подписка (expired), проба (trial_ended), подарок (gift_ended); в аналитике «Истекли» — только подписка.
      await this.journal(u.id, ended === "paid" ? "expired" : ended === "gift" ? "gift_ended" : "trial_ended", null, null, now);
      // Замороженному (admin-account.ts) горничная не пишет: срок кончается молча, план и журнал — как у всех.
      if (!isFrozen(u)) await this.notify({ ...u, plan: "free" }, `${endedText(ended, this.price)}.\nПросмотр записей, отметки и напоминания остаются бесплатно.`);
    }
    // Кнопки оплаты тут нет: новая подписка поверх идущей списала бы звёзды дважды, а оплаченные дни пропали бы.
    for (const u of await this.store.canceledEndingBetween(now.toISOString(), new Date(now.getTime() + REMIND_BEFORE_MS).toISOString())) {
      if (isFrozen(u) || !(await this.store.once(`subend:${u.id}:${(u.access_until ?? "").slice(0, 10)}`))) continue;
      await this.notify(u, `Подписка закончится ${day(u.access_until ?? "")} — продление отменено. Чтобы я и дальше разбирала сообщения, ` +
        "возобновите продление: /resume_sub или в Telegram (Настройки → Мои звёзды → Подписки).", false);
    }
  }

  /** Письмо в Telegram (pay — с кнопкой оплаты, если платить можно) и в ленту уведомлений (сайт, виджет). */
  async notify(u: User, text: string, pay = true) {
    await this.store.addNotice(u.id, text, "neutral", "", "other").catch(() => {});
    if (!this.api || !u.chat_id) return;
    const url = pay ? await this.link(u) : null;
    await this.api.sendMessage(u.chat_id, esc(text), {
      parse_mode: "HTML", link_preview_options: { is_disabled: true },
      ...(url ? { reply_markup: { inline_keyboard: [[{ text: `Оформить ⭐${this.price}`, url }]] } } : {}),
    }).catch((e) => console.error("[billing] письмо", (e as Error).message));
  }

  /** Строка журнала подписки (billing_events, шаг 28; аналитика). Сбой записи журнала — в лог, оплату и отмену не роняет. */
  private async journal(userId: number, kind: BillingKind, chargeId: string | null = null, amount: number | null = null, at = this.now()) {
    try {
      await this.store.addBillingEvent({ user_id: userId, kind, at, charge_id: chargeId, amount });
    } catch (e) {
      console.error("[billing] журнал", (e as Error).message);
    }
  }

  private async toOwners(text: string) {
    if (!this.api) return;
    for (const o of this.opts.owners ?? []) await this.api.sendMessage(o, text, { parse_mode: "HTML" }).catch(() => {});
  }
}

/** Условия (/terms; на сайте — тот же текст). */
export const TERMS_TEXT = (price = tariffs().price, trialDays = tariffs().trialDays) =>
  "<b>Условия «Горничной»</b>\n\n" +
  `• Что продаётся: подписка на месяц — горничная разбирает сообщения, отвечает, понимает голос и фото в боте, на сайте и в программе на ПК. Цена — ⭐${price} (Telegram Stars) за 30 дней.\n` +
  `• Новым — ${trialDays} дней полного доступа бесплатно.\n` +
  "• Подписка продлевается автоматически каждый месяц. Отменить можно когда угодно: в Telegram (Настройки → Мои звёзды → Подписки) или командой /cancel_sub. Доступ остаётся до конца оплаченного месяца; передумали — /resume_sub.\n" +
  "• Оплата во время пробы или подарка начинает оплаченный месяц сразу: оставшиеся бесплатные дни в него не добавляются.\n" +
  "• Без подписки бесплатно остаётся всё без ИИ: просмотр своих записей, отметки, кнопки, ручные правки, напоминания и вопросы про привычки. Записи не удаляются.\n" +
  "• Возврат — по просьбе в течение 3 дней после оплаты, если подпиской почти не пользовались.\n" +
  "• Вопросы об оплате — /paysupport.";
