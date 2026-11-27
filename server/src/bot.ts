import fs from "node:fs";
import path from "node:path";
import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";
import { config, ROOT } from "./config.ts";
import { issueToken, notePresence } from "./auth.ts";
import { accountsText } from "./accounts.ts";
import { createInvite, INVITE_DAYS, installerUrl, isMember, redeemInvite, signUp, type Invited } from "./invite.ts";
import { accessOf, FROZEN_TEXT, isFrozen, RATE_AGAIN, type Access } from "./access.ts";
import { Billing, billingSecret, TERMS_TEXT, type StarsApi } from "./billing.ts";
import { setSignupsOpen, signupsEnvClosed, signupsOpenNow, tariffs } from "./tariffs.ts";
import type { Store, User } from "./db.ts";
import { habitLine, habitsOfDay, markRefusal } from "./habits.ts";
import type { Pipeline, Proposal, Reply } from "./pipeline.ts";
import { PERSONAS, type Emotion } from "./personas.ts";
import { datesText, esc, memoryText, plansText, tasksText, todayText } from "./report.ts";
import {
  HABIT_DATA, RATE, habitButtons, habitLaterRows, habitPickRows, rateDay, replanEvents, snoozeDayRefusal, snoozeOptions, type Button, type Scheduler,
  type Send,
} from "./scheduler.ts";
import { dayKey, isTime } from "./time.ts";
import { decideTrait } from "./profile.ts";
import { youButton } from "./you.ts";
import { sttReady, transcribe, VOICE_MAX_BYTES, voiceSeconds } from "./voice.ts";
import { activeModel, asUser, IMAGE_MAX_BYTES, IMAGE_TYPES, isOpenRouter, LITE_MODEL, setLiteModel } from "./llm.ts";
import { asksForList, WIDGET_CAPTION, WIDGET_HTML, widgetQuery, widgetState } from "./widget.ts";
import { countFeature, countPersona } from "./feature-events.ts";
import { noteActive } from "./server-metrics.ts";

// Telegram: обычный текст — запись (без режимов), команды — просмотр и настройки.

export function emotionImage(personaId: string, emotion: Emotion): string | null {
  const file = path.join(ROOT, "assets", "emotions", personaId, `${emotion}.png`);
  return fs.existsSync(file) ? file : null;
}

export function createBot(store: Store, pipeline: Pipeline, scheduler: () => Scheduler | null) {
  const bot = new Bot(config.telegramToken);
  // Оплата (billing.ts): платежи и вопросы о них — админам (ADMIN_CHAT_IDS, пусто — первый из ALLOWED_CHAT_IDS, как в админке сайта).
  const payAdmins = config.adminChatIds.length ? config.adminChatIds : config.allowedChatIds.slice(0, 1);
  const billing = new Billing(store, bot.api satisfies StarsApi, { secret: billingSecret(config.telegramToken), owners: payAdmins });
  // Цена — текущая из тарифов (tariffs.ts): поменяли в админке — бот пишет новую сразу.
  const price = () => tariffs().price;
  const dmy = (iso: string | null) => (iso ?? "").slice(0, 10).split("-").reverse().join(".");
  /** Кнопка оплаты под отказом и письмом; Telegram не дал ссылку — без кнопки. */
  const payKeyboard = async (u: User) => {
    const url = await billing.link(u);
    return url ? new InlineKeyboard().url(`Оформить ⭐${price()}`, url) : undefined;
  };
  /** Строка о доступе (/start). */
  const accessLine = (a: Access) =>
    a.plan === "owner" || a.plan === "friend" ? "Доступ: бесплатно навсегда."
      : a.plan === "trial" ? `Пробный доступ: осталось ${a.trialLeftDays} дн. Потом — подписка ⭐${price()} в месяц (/terms).`
      : a.plan === "paid" ? `Подписка до ${dmy(a.until)}${a.canceled ? " (продление отменено)" : ""}.`
      : `Разбор сообщений закрыт — нужна подписка ⭐${price()} в месяц (/terms). Просмотр записей, отметки и напоминания — бесплатно.`;

  // Платежи — ДО фильтра незнакомцев: pre_checkout_query приходит без чата, successful_payment — из чата, который мог ещё не быть
  // привязан к записи (оплатили по ссылке с сайта). Ответ на pre_checkout — за 10 с, только чтение из базы.
  bot.on("pre_checkout_query", async (ctx) => {
    await billing.preCheckout(ctx.preCheckoutQuery);
  });
  bot.on("message:successful_payment", async (ctx) => {
    const got = await billing.paid(ctx.from, ctx.message.successful_payment);
    if (!got) return void (await ctx.reply("Оплата пришла, но я не нашла вашу учётную запись. Напишите /paysupport — разберёмся и вернём звёзды."));
    if (got.duplicate) return;
    // Замороженному (admin-account.ts) — не «я всё разберу»: оплата записана, но бот, ИИ и вход закрыты до разморозки.
    if (isFrozen(got.user)) {
      return void (await ctx.reply(`Оплата получена, срок — до ${dmy(got.until)}. Но аккаунт приостановлен — я пока не отвечаю. ` +
        "Отменить продление — /cancel_sub, вопросы и возврат — /paysupport."));
    }
    await ctx.reply(got.kind === "renew" ? `Подписка продлена до ${dmy(got.until)}. Спасибо! ✨` : `Спасибо! ✨ Подписка оформлена до ${dmy(got.until)} — пишите, я всё разберу.`);
  });
  bot.on("message:refunded_payment", async (ctx) => {
    const u = await billing.refunded(ctx.message.refunded_payment);
    if (u) await ctx.reply(`Вернула ⭐${ctx.message.refunded_payment.total_amount}. Подписка закрыта; записи остаются, просмотр и отметки — бесплатно.`);
  });
  // Обязательные для бота с оплатой команды — всем, даже незнакомцам.
  bot.command("terms", (ctx) => ctx.reply(TERMS_TEXT(), { parse_mode: "HTML" }));
  // Вопрос об оплате — админам. Только в личке и не чаще раза в 10 минут от одного человека: иначе это открытая пересылка владельцу.
  // Ответ человеку — владелец командой /answer <tg id> <текст> (tg id есть в пересланном вопросе).
  bot.command("paysupport", async (ctx) => {
    if (ctx.chat.type !== "private") return ctx.reply("Вопрос об оплате напишите мне в личные сообщения: /paysupport и текст.");
    const q = ctx.match.trim().slice(0, 1500);
    if (!q) return ctx.reply("Напишите вопрос об оплате одним сообщением: /paysupport и текст. Например: «/paysupport списались звёзды, а доступа нет». Отвечу здесь же.");
    if (!(await store.once(`paysupport:${ctx.from?.id ?? 0}:${Math.floor(Date.now() / 600_000)}`))) {
      return ctx.reply("Вопрос уже передан — ответим здесь, в чате. Следующий можно отправить через 10 минут.");
    }
    const u = await store.userByTg(String(ctx.from?.id ?? ""));
    const last = u ? (await store.paymentsOf(u.id))[0] : undefined;
    const who = u ? `#${u.id} ${u.login ?? ""}` : "без учётной записи";
    for (const a of payAdmins) {
      await bot.api.sendMessage(a, `💬 /paysupport от ${esc(who)} (tg ${ctx.from?.id ?? "?"})` +
        `${last ? `, последняя оплата ⭐${last.amount} ${last.paid_at.slice(0, 10)}${last.refunded_at ? " (возвращена)" : ""}` : ""}:\n${esc(q)}`, { parse_mode: "HTML" }).catch(() => {});
    }
    await ctx.reply("Передала вопрос. Ответим здесь, в чате, обычно в течение суток.");
  });
  // Владелец: ответ на /paysupport — сообщение от бота человеку по его tg id (из пересланного вопроса), в журнал admin_log.
  bot.command("answer", async (ctx) => {
    if (!owner(ctx) && !payAdmins.includes(String(ctx.chat.id))) return;
    const m = /^(\d{1,15})\s+([\s\S]{1,3000})$/.exec(ctx.match.trim());
    if (!m) return ctx.reply("Напишите так: /answer <tg id> <текст ответа> — tg id есть в пересланном вопросе /paysupport.");
    try {
      await bot.api.sendMessage(m[1], `💬 Ответ на ваш вопрос об оплате:\n${esc(m[2])}`, { parse_mode: "HTML" });
    } catch (e) {
      return ctx.reply(`Не дошло: ${esc((e as Error).message.slice(0, 120))}`, { parse_mode: "HTML" });
    }
    const me = await store.userByChat(String(ctx.chat.id));
    // В журнал — номер аккаунта, а не Telegram id (журнал админки показывает только #id).
    const to = await store.userByTg(m[1]);
    await store.addAdminLog(me?.id ?? 0, "paysupport-answer", to ? `#${to.id}` : "без учётной записи", new Date());
    await ctx.reply("Отправила.");
  });

  // Свои — владелец (ALLOWED_CHAT_IDS) и друзья, принявшие приглашение (invite.ts).
  const allowed = (chatId: string) => isMember(store, chatId, config.allowedChatIds);
  const owner = (ctx: Context) => config.allowedChatIds.includes(String(ctx.chat?.id ?? ""));
  // Запись заводится сама только владельцу; остальным — та, что есть (одним запросом): аккаунт могли удалить между фильтром
  // «свой» и этим местом, и ensureUser завёл бы запись без пробы, мимо signUp — /start потом не дал бы пробу.
  const memberUser = async (chat: string, name: string): Promise<User | null> =>
    !chat ? null : config.allowedChatIds.includes(chat) ? store.ensureUser(chat, name, config.defaultTimezone) : (await store.userByChat(chat)) ?? null;
  const userOf = (ctx: Context): Promise<User | null> => memberUser(String(ctx.chat?.id ?? ""), ctx.from?.first_name ?? "");

  const undoRow = (kb: InlineKeyboard, messageId: number) => kb.text("↩ Отменить", `undo:${messageId}`).text("📝 Это просто заметка", `note:${messageId}`);
  const replyKeyboard = (r: Reply) => {
    if (r.proposal) return proposalKeyboard(r.proposal, r.undoable ? r.messageId : null);
    if (r.failed) return new InlineKeyboard().text("🔁 Повторить", `retry:${r.messageId}`).text("📝 Оставить заметкой", `note:${r.messageId}`);
    if (r.clash) {
      // План лёг на занятое время: «Сдвинуть на 15:00» (если есть куда) и «Оставить»; ниже — «Отменить» / «Это просто заметка».
      const c = r.clash, key = `clash:${r.messageId}:${c.eventId}:${c.withId}`;
      const kb = new InlineKeyboard();
      if (c.shiftTo) kb.text(`➜ Сдвинуть на ${c.shiftTo}`, `${key}:s`);
      kb.text("Оставить", `${key}:k`).row();
      return r.undoable ? undoRow(kb, r.messageId) : kb;
    }
    return r.undoable ? undoRow(new InlineKeyboard(), r.messageId) : undefined;
  };
  // Вопрос «добавить?»: у нескольких пунктов — галочка на каждом (щелчок снимает/ставит), ниже ситуативная кнопка
  // напоминания, «Добавить в …» и «Не надо»; под ними, если было что записать, — «Отменить» / «Это просто заметка».
  function proposalKeyboard(p: Proposal, undoId: number | null) {
    const kb = new InlineKeyboard();
    if (p.items.length > 1) {
      p.items.forEach((it, i) => kb.text(`${p.picked.includes(i) ? "☑" : "☐"} ${it.title}`.slice(0, 60), `prop:${p.id}:t:${i}`).row());
    }
    if (p.remind) kb.text(`✅ ${p.remind.label}`.slice(0, 60), `prop:${p.id}:r`).row();
    kb.text(`✅ ${p.add}`, `prop:${p.id}:a`).text("Не надо", `prop:${p.id}:n`).row();
    if (undoId) undoRow(kb, undoId);
    return kb;
  }

  async function answer(ctx: Context, u: User, r: Reply) {
    // ИИ закрыт (access.ts): под отказом — кнопка оплаты (нет пробы и подписки) или ничего (частота, дневной потолок).
    const markup = r.blocked ? (r.blocked === "access" ? await payKeyboard(u) : undefined) : replyKeyboard(r);
    // Нарисованная картинка — вместо картинки настроения.
    const img = r.drawing ? new InputFile(Buffer.from(r.drawing.data, "base64"), `drawing-${r.drawing.id}.jpg`) : emotionImage(u.persona, r.emotion);
    const sent = img && r.text.length <= 1000
      ? await ctx.replyWithPhoto(img instanceof InputFile ? img : new InputFile(img), { caption: r.text, parse_mode: "HTML", reply_markup: markup })
      : await ctx.reply(r.text, { parse_mode: "HTML", reply_markup: markup, link_preview_options: { is_disabled: true } });
    // Запомнить, где висит вопрос: ответят в приложении или он истечёт — кнопки отсюда уберутся.
    if (r.proposal) await store.updateProposal(r.proposal.id, { tg_chat: String(sent.chat.id), tg_msg: sent.message_id });
  }

  // Вопрос закрыт (где угодно): в Telegram заменить строку вопроса итогом и убрать кнопки вопроса.
  pipeline.onProposal = async (_u, p, text) => {
    if (!p.tg_chat || !p.tg_msg) return;
    const kb = (await store.actionsOf(p.message_id)).length ? undoRow(new InlineKeyboard(), p.message_id) : undefined;
    const opts = { parse_mode: "HTML" as const, reply_markup: kb };
    await bot.api.editMessageText(p.tg_chat, p.tg_msg, text, { ...opts, link_preview_options: { is_disabled: true } })
      .catch(() => bot.api.editMessageCaption(p.tg_chat!, p.tg_msg!, { caption: text, ...opts }))
      .catch((e) => console.warn("[bot] вопрос не поправить:", e.message));
  };

  const HELP =
    "Я ваша горничная. Пишите как есть — что было за день, что запланировано, что не забыть. " +
    "Я сама разложу: дневник, планы, задачи, важные даты.\n\n" +
    "/list — список на сегодня с галочками\n/today — сегодня\n/plans — планы\n/tasks — задачи\n/dates — важные даты\n/memory — что я помню\n" +
    "/ask текст — просто поговорить\n/undo — отменить последнее\n/summary — итог дня\n/persona — характер\n" +
    "/habits — привычки на сегодня\n/token — ключ для виджета на айфоне\n" +
    "/terms — условия и подписка\n/cancel_sub — отменить продление\n/resume_sub — возобновить продление\n/paysupport — вопрос об оплате";

  /** Новая запись (по приглашению или /start): логин и пароль, адрес сервера и установщик, справка. */
  async function welcome(ctx: Context, got: Invited, gift: boolean) {
    const name = ctx.from?.first_name ?? "";
    const setup = installerUrl(config.desktopDir, config.publicUrl);
    await ctx.reply(
      `Добро пожаловать${name ? `, ${esc(name)}` : ""}! ✨\n\n` +
        (gift ? `🎁 Вам подарок — полный доступ до ${dmy(got.until)}.\n\n`
          : `Первые ${tariffs().trialDays} дней — полный доступ бесплатно (до ${dmy(got.until)}), потом — подписка ⭐${price()} в месяц. Условия — /terms.\n\n`) +
        (setup ? `<b>Программа для ПК:</b> <a href="${esc(setup)}">скачать установщик</a>\n` : "") +
        "При первом запуске впишите адрес сервера, потом войдите логином и паролем — так же и на сайте.\n\n" +
        `Адрес сервера: <code>${esc(config.publicUrl)}</code>\nЛогин: <code>${esc(got.login ?? "")}</code>\nПароль: <code>${esc(got.password ?? "")}</code>\n` +
        "Пароль никому не показывайте.",
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
    );
    await ctx.reply(HELP);
  }

  // Приглашение (/start <код>) — подарок на giftDays дней (тарифы): новому — запись, у кого запись есть — продление срока.
  // О новых владельцу пишет сводка раз в сутки (правило newcomers в alerts.ts), не по одному. false — код не подошёл.
  async function acceptInvite(ctx: Context, chat: string, code: string): Promise<boolean> {
    const got = await redeemInvite(store, code, { id: chat, name: ctx.from?.first_name ?? "", username: ctx.from?.username }, config.defaultTimezone);
    if (!got) return false;
    if (got.login) await welcome(ctx, got, true);
    else if (!got.until) await ctx.reply("У вас и так бесплатный доступ навсегда — приглашение осталось для кого-нибудь ещё.");
    else await ctx.reply(`🎁 Подарок принят: полный доступ до ${dmy(got.until)}.`);
    return true;
  }
  // Незнакомец без приглашения: своя запись с пробой. Выключатель SIGNUPS_OPEN и потолок новых в час — в signUp (invite.ts).
  async function signUpStranger(ctx: Context, chat: string) {
    const got = await signUp(store, { id: chat, name: ctx.from?.first_name ?? "", username: ctx.from?.username }, config.defaultTimezone);
    if (got === "closed") return void (await ctx.reply("Регистрация сейчас закрыта. Загляните чуть позже."));
    // Потолок регистраций владельцу пишет правило signup_cap (alerts.ts) — с числами и «снова ниже потолка».
    if (got === "busy") return void (await ctx.reply("Сейчас очень много новых — попробуйте через час, пожалуйста."));
    if (got) await welcome(ctx, got, false);
  }

  // Чужим — chat id (владелец добавляет себя), а в личке — /start: по приглашению (/start <код>) — подарок, без кода — проба.
  bot.use(async (ctx, next) => {
    const chat = String(ctx.chat?.id ?? "");
    if (chat && !(await allowed(chat))) {
      const start = /^\/start(?:@\w+)?(?:\s+(\S+))?/.exec(ctx.message?.text ?? "");
      if (start && ctx.chat?.type === "private") {
        // Код не подошёл (устарел, использован) — обычная проба.
        if (!start[1] || !(await acceptInvite(ctx, chat, start[1]))) await signUpStranger(ctx, chat);
      } else if (ctx.message?.text?.startsWith("/chatid")) await ctx.reply(`chat id: <code>${chat}</code>`, { parse_mode: "HTML" });
      else if (ctx.message && ctx.chat?.type === "private") await ctx.reply("Здравствуйте! Чтобы начать, нажмите /start.");
      return;
    }
    await next();
  });
  // Замороженный аккаунт (admin-account.ts): на любое сообщение — один ответ FROZEN_TEXT, на кнопку — то же всплывающим окном;
  // ничего не разбирается и не записывается, данные остаются. /terms и /paysupport стоят выше фильтра — работают и замороженному;
  // /cancel_sub пропускается: остановить списания звёзд человек может и в заморозке (возобновить — /resume_sub — только после неё).
  bot.use(async (ctx, next) => {
    const chat = String(ctx.chat?.id ?? "");
    const u = chat ? await store.userByChat(chat) : undefined;
    if (!u || !isFrozen(u)) return next();
    if (/^\/cancel_sub(?:@\w+)?(?:\s|$)/.test(ctx.message?.text ?? "")) return next();
    if (ctx.callbackQuery) return void (await ctx.answerCallbackQuery({ text: FROZEN_TEXT, show_alert: true }).catch(() => {}));
    if (ctx.message && ctx.chat?.type === "private") await ctx.reply(FROZEN_TEXT);
  });
  // Всё, что дальше делается по сообщению, — для этого человека: расход ИИ на его счёт (llm.ts, asUser).
  // Заодно минута присутствия «telegram» (таблица presence) — не чаще раза в минуту на человека (ограничитель в notePresence).
  bot.use(async (ctx, next) => {
    const chat = String(ctx.chat?.id ?? "");
    const u = chat ? await store.userByChat(chat) : undefined;
    if (u) void notePresence(store, u, "telegram");
    if (u) noteActive(u.id); // «активных за минуту» для «Здоровья сервера» — только число
    if (u) countBot(u, ctx);
    return u ? asUser(u.id, next) : next();
  });
  /** Счётчики фич (feature-events.ts): команда, кнопка под сообщением (голосовое — после распознавания, ниже). Незнакомое имя
   *  белый список отбросит. */
  const BUTTON_FEATURES: Record<string, string> = {
    habit: "habit.mark", trait: "trait.edit", you: "you.button", rate: "rate", prop: "proposal", clash: "clash",
    retry: "retry", undo: "undo", note: "as_note", persona: "bot.persona", model: "bot.model",
  };
  function countBot(u: User, ctx: Context) {
    const cmd = /^\/([a-z_]+)(@\w+)?(\s|$)/i.exec(ctx.message?.text ?? "")?.[1]?.toLowerCase();
    // /list считает сам список (showList) — и по команде, и по слову «список».
    if (cmd && cmd !== "list") countFeature(u, "telegram", `bot.${cmd}`);
    const data = ctx.callbackQuery?.data ?? "";
    // У вопроса про привычку в счёт — одно нажатие на ответ: «Да», «Нет», «Позже»; шаги «Позже» (время, «Выбрать», «←») — нет.
    const button = /^habit:.*:(back|pick|step|s\d+|t\d+)$/.test(data) ? undefined : BUTTON_FEATURES[data.split(":")[0]];
    if (button) countFeature(u, "telegram", button);
  }

  // Виджет «Список на сегодня» (Bot API 10.4). grammy этих методов и обновлений ещё не знает — вызываем напрямую.
  type WidgetQueryUpdate = { id: string; from: { id: number }; chat?: { id: number }; message_id?: number; data: string; type?: { type: string } };
  const raw = bot.api.raw as unknown as Record<string, (p: Record<string, unknown>) => Promise<unknown>>;
  bot.use(async (ctx, next) => {
    const q = (ctx.update as { widget_query?: WidgetQueryUpdate }).widget_query;
    if (!q) return next();
    const chat = String(q.chat?.id ?? q.from.id);
    const u = q.type?.type === "data" ? await memberUser(chat, "") : null;
    if (!u || isFrozen(u)) return void (await raw.answerWidgetQuery({ widget_query_id: q.id }).catch(() => {}));
    countFeature(u, "telegram-widget", "bot.widget");
    const state = await widgetQuery(store, pipeline, u, q.data);
    await raw.answerWidgetQuery({ widget_query_id: q.id, data: state });
    if (q.chat && q.message_id) await raw.editMessageWidgetData({ chat_id: q.chat.id, message_id: q.message_id, chat_data: state }).catch(() => {});
  });

  // Последний присланный список живой: бот обновляет его после каждого изменения (kv widget:<id> = {chat, msg}).
  const widgetKey = (u: User) => `widget:${u.id}`;
  async function showList(ctx: Context, u: User) {
    countFeature(u, "telegram", "bot.list");
    try {
      const m = (await raw.sendWidget({
        chat_id: ctx.chat!.id, html: WIDGET_HTML, caption: WIDGET_CAPTION, allow_queries: true, chat_data: await widgetState(store, u),
      })) as { message_id?: number };
      if (m?.message_id) await store.kvSet(widgetKey(u), JSON.stringify({ chat: ctx.chat!.id, msg: m.message_id }));
    } catch (e) {
      console.error("[bot] widget", e);
      await ctx.reply("Не получилось показать список-виджет. Обновите Telegram или посмотрите /today.");
    }
  }
  // Изменения часто идут пачкой (несколько записей одним сообщением) — обновить один раз, через секунду.
  const refreshTimers = new Map<number, ReturnType<typeof setTimeout>>();
  pipeline.onChange = (u) => {
    clearTimeout(refreshTimers.get(u.id));
    refreshTimers.set(u.id, setTimeout(() => {
      refreshTimers.delete(u.id);
      void refreshList(u).then(() => cheer(u)).catch((e) => console.error("[bot] widget refresh", e));
    }, 1000));
  };
  async function refreshList(u: User) {
    const saved = await store.kvGet(widgetKey(u));
    if (!saved) return;
    const { chat, msg } = JSON.parse(saved) as { chat: number; msg: number };
    try {
      await raw.editMessageWidgetData({ chat_id: chat, message_id: msg, chat_data: await widgetState(store, u) });
    } catch (e) {
      // Сообщение удалили или оно слишком старое — больше не трогаем. «Не изменилось» — не ошибка.
      if (!/not modified/i.test(String((e as Error).message))) await store.kvSet(widgetKey(u), "");
    }
  }

  // Всё на сегодня сделано — горничная радуется стикером (один раз за день; отменили и снова сделали — без повтора).
  const CHEER_STICKER = path.join(ROOT, "server", "assets", "maid", "done.webm");
  const CHEERS = ["Всё на сегодня сделано — умница! ✨", "Ни одного хвоста на сегодня. Горжусь! ✨", "Список пуст, день закрыт. Отдыхайте ✨"];
  async function cheer(u: User) {
    if (!u.chat_id || !fs.existsSync(CHEER_STICKER)) return;
    const st = JSON.parse(await widgetState(store, u)) as { a: [string, string, number][]; m?: number };
    if (!st.a.length || st.m || st.a.some((x) => !(x[2] & 1))) return;
    const today = dayKey(new Date(), u.tz);
    if ((await store.kvGet(`cheer:${u.id}`)) === today) return;
    await store.kvSet(`cheer:${u.id}`, today);
    const id = await store.kvGet("sticker:done");
    const m = await bot.api.sendSticker(u.chat_id, id || new InputFile(CHEER_STICKER, "done.webm"));
    if (!id && m.sticker?.file_id) await store.kvSet("sticker:done", m.sticker.file_id);
    await bot.api.sendMessage(u.chat_id, CHEERS[Math.floor(Math.random() * CHEERS.length)]);
  }

  bot.command("list", async (ctx) => {
    const u = await userOf(ctx);
    if (u) await showList(ctx, u);
  });

  bot.command("start", async (ctx) => {
    const u = await userOf(ctx);
    if (!u) return;
    // Своя запись уже есть, а пришли по приглашению — подарок продлевает срок.
    const code = ctx.match.trim();
    if (code && (await acceptInvite(ctx, String(ctx.chat.id), code))) return;
    await ctx.reply(`${HELP}\n\n${accessLine(accessOf((await store.user(u.id)) ?? u))}`);
  });
  // Владелец: закрыть или открыть регистрацию незнакомцев (/start без приглашения) — в kv, без правки .env.
  bot.command("signups", async (ctx) => {
    if (!owner(ctx)) return;
    const arg = ctx.match.trim().toLowerCase();
    // Тот же выключатель, что «Общие потолки» в админке (тариф signupsOpen, tariffs.ts): с историей и в журнал админки.
    if (arg === "off" || arg === "on") await setSignupsOpen(store, (await store.userByChat(String(ctx.chat.id)))?.id ?? 0, arg === "on");
    // SIGNUPS_OPEN=0 в .env закрывает поверх тарифа — сказать об этом, иначе «/signups on» выглядел бы сломанным.
    const env = signupsEnvClosed() ? " (SIGNUPS_OPEN=0 в .env сервера — закрыта, что бы ни стояло здесь)" : "";
    await ctx.reply(`Регистрация новых: ${signupsOpenNow() ? "открыта" : "закрыта"}${env}. /signups off — закрыть, /signups on — открыть (или в админке сайта → «Общие потолки»).`);
  });
  // Возобновить отменённое продление — та же подписка, без второй оплаты.
  bot.command("resume_sub", async (ctx) => {
    const u = await userOf(ctx);
    if (!u) return;
    await ctx.reply((await billing.resume(u)).text);
  });
  // Отменить продление подписки: доступ — до конца оплаченного месяца.
  bot.command("cancel_sub", async (ctx) => {
    const u = await userOf(ctx);
    if (!u) return;
    await ctx.reply((await billing.cancel(u)).text);
  });
  // Владелец: вернуть звёзды за последнюю оплату человека (#id — из /accounts или админки сайта), доступ снимается.
  bot.command("refund", async (ctx) => {
    const u = owner(ctx) ? await userOf(ctx) : null;
    if (!u) return;
    const id = Number(ctx.match.trim().replace(/^#/, ""));
    if (!Number.isInteger(id) || id <= 0) return ctx.reply("Напишите так: /refund <номер пользователя>, например /refund 12.");
    await ctx.reply((await billing.refund(id, u.id)).text);
  });
  // Владелец: кто есть, кто когда писал и сколько ушло на ИИ (accounts.ts).
  bot.command("accounts", async (ctx) => {
    const u = owner(ctx) ? await userOf(ctx) : null;
    if (!u) return;
    await ctx.reply(await accountsText(store, config.allowedChatIds, u.tz), { parse_mode: "HTML" });
  });
  // Владелец: ссылка-приглашение для друга (одноразовая, на INVITE_DAYS дней).
  bot.command("invite", async (ctx) => {
    if (!owner(ctx)) return;
    const code = await createInvite(store);
    await ctx.reply(
      `Приглашение для друга — одноразовое, ссылка живёт ${INVITE_DAYS} дней:\nhttps://t.me/${ctx.me.username}?start=${code}\n\n` +
        `Это подарок: ${tariffs().giftDays} дней полного доступа. Новый человек получит логин и пароль для сайта и программы на ПК и ссылку на установщик, ` +
        "а у кого запись уже есть — продление срока.",
      { link_preview_options: { is_disabled: true } },
    );
  });
  // Владелец: какая модель отвечает — основная (LLM_MODEL) или дешёвая (LITE_MODEL); выбор в kv model:lite, index.ts читает его при запуске.
  const modelMenu = () => {
    const lite = activeModel() === LITE_MODEL;
    return {
      text: `Модель сейчас: <code>${esc(activeModel())}</code>` +
        (isOpenRouter(config.llm.baseUrl) ? "" : "\nДешёвая модель работает только через OpenRouter."),
      kb: new InlineKeyboard().text(`${lite ? "" : "● "}Основная`, "model:main").text(`${lite ? "● " : ""}Haiku 5.5 (дешёвая)`, "model:lite"),
    };
  };
  bot.command("model", async (ctx) => {
    if (!owner(ctx)) return;
    const m = modelMenu();
    await ctx.reply(m.text, { parse_mode: "HTML", reply_markup: m.kb });
  });
  bot.callbackQuery(/^model:(main|lite)$/, async (ctx) => {
    if (!owner(ctx)) return ctx.answerCallbackQuery();
    const lite = ctx.match[1] === "lite";
    setLiteModel(lite);
    await store.kvSet("model:lite", lite ? "1" : "0");
    const m = modelMenu();
    await ctx.answerCallbackQuery({ text: lite ? "Отвечает Haiku 5.5" : "Отвечает основная модель" });
    await ctx.editMessageText(m.text, { parse_mode: "HTML", reply_markup: m.kb }).catch(() => {});
  });
  bot.command("chatid", (ctx) => ctx.reply(`chat id: <code>${ctx.chat.id}</code>`, { parse_mode: "HTML" }));

  const view = (fn: (u: User, today: string) => Promise<string>) => async (ctx: Context) => {
    const u = await userOf(ctx);
    if (!u) return;
    await ctx.reply(await fn(u, dayKey(new Date(), u.tz)), { parse_mode: "HTML" });
  };
  bot.command("today", view((u, d) => todayText(store, u, d)));
  bot.command("plans", view((u, d) => plansText(store, u, d)));
  bot.command("tasks", view((u, d) => tasksText(store, u, d)));
  bot.command("dates", view((u, d) => datesText(store, u, d)));
  bot.command("memory", view((u) => memoryText(store, u)));

  bot.command("habits", async (ctx) => {
    const u = await userOf(ctx);
    if (!u) return;
    const today = dayKey(new Date(), u.tz);
    const list = await habitsOfDay(store, u, today);
    if (!list.length) return ctx.reply("На сегодня привычек нет. Напишите, например: «каждый день в 8 утра зарядка, 30 дней».");
    const kb = new InlineKeyboard();
    for (const d of list) if (!d.status) kb.text(`✅ ${d.habit.title}`.slice(0, 60), `habit:${d.habit.id}:${today}:done`).row();
    await ctx.reply(`<b>Привычки сегодня</b>\n${list.map(habitLine).join("\n")}`, { parse_mode: "HTML", reply_markup: kb });
  });

  bot.command("summary", async (ctx) => {
    const u = await userOf(ctx);
    const s = scheduler();
    if (!u || !s) return;
    // Итог дня со словами горничной — вызов модели: частота и потолки, как у сообщения (без доступа eveningText сам идёт без модели).
    const v = pipeline.gate && pipeline.gate.allowed(u) ? await pipeline.gate.check(u, { client: "telegram", take: { calls: 1 } }) : null;
    if (v && !v.ok) return void (await ctx.reply(v.why === "rate" ? "Много сообщений подряд — попросите итог через минуту, пожалуйста." : v.text));
    await ctx.reply(await s.eveningText(u, dayKey(new Date(), u.tz)), { parse_mode: "HTML" });
  });

  bot.command("undo", async (ctx) => {
    const u = await userOf(ctx);
    if (!u) return;
    await ctx.reply(await pipeline.undo(u));
  });

  bot.command("ask", async (ctx) => {
    const u = await userOf(ctx);
    if (!u || !ctx.message) return;
    const text = ctx.match.trim();
    if (!text) return ctx.reply("Напишите после /ask, о чём поговорить.");
    await ctx.replyWithChatAction("typing");
    await answer(ctx, u, await pipeline.handle({ user: u, source: "telegram", sourceId: String(ctx.message.message_id), text, chatOnly: true, client: "telegram" }));
  });

  bot.command("persona", async (ctx) => {
    const u = await userOf(ctx);
    if (!u) return;
    const kb = new InlineKeyboard();
    for (const p of Object.values(PERSONAS)) kb.text(`${p.id === u.persona ? "● " : ""}${p.name}`, `persona:${p.id}`).row();
    await ctx.reply("Какой мне быть?", { reply_markup: kb });
  });

  bot.command("token", async (ctx) => {
    const u = await userOf(ctx);
    if (!u) return;
    const token = await issueToken(store, u.id, "telegram /token");
    await ctx.reply(`Ключ для виджета на айфоне (никому не показывайте):\n<code>${token}</code>`, { parse_mode: "HTML" });
  });

  /** Ряды кнопок → клавиатура Telegram. */
  const rowsKeyboard = (rows: Button[][]) => {
    const kb = new InlineKeyboard();
    rows.forEach((r, i) => {
      if (i) kb.row();
      for (const b of r) kb.text(b.text, b.data);
    });
    return kb;
  };
  // Вопрос про привычку: «✅ Да» / «✖ Нет» — отметка; «⏰ Позже» (later, и старое «⏳ Ещё нет») — второй шаг на той же клавиатуре:
  // «15 мин | 30 мин | 1 ч | 2 ч», «Выбрать» (pick — сетка полных часов) и «←» (back — первый ряд; step — из сетки ко второму шагу);
  // s<мин> и t<ЧЧММ> — отложить. Ответ — всплывашкой, клавиатура снимается (как у отметки). До полуночи уже ничего не успеть:
  // на later (первое нажатие, и старое «⏳ Ещё нет») — прежний ответ habitLater, на шаги — почему нельзя (день кончился и т. п.).
  bot.callbackQuery(HABIT_DATA, async (ctx) => {
    const u = await userOf(ctx);
    if (!u) return ctx.answerCallbackQuery();
    const [, idText, day, act] = ctx.match;
    const id = Number(idText), now = new Date();
    const plain = (text: string) => text.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    const popup = (text: string) => ctx.answerCallbackQuery({ text: plain(text).slice(0, 190) });
    const close = () => ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    const show = (rows: Button[][]) => ctx.editMessageReplyMarkup({ reply_markup: rowsKeyboard(rows) }).catch(() => {});
    const step = async (rows: Button[][]) => {
      await ctx.answerCallbackQuery();
      await show(rows);
    };
    if (act === "done" || act === "skipped") {
      await popup(await pipeline.markHabit(u, id, day, act, "telegram"));
      return void (await close());
    }
    const h = await store.habit(id);
    const marked = async () => (await store.marksOf(u.id, day, day)).some((m) => m.habit_id === id);
    const refused = !h || h.user_id !== u.id ? "Нет такой привычки." : markRefusal(h, day) ?? ((await marked()) ? `${h.title} — уже отмечено.` : null);
    const opt = snoozeOptions(u, day, now);
    if (refused || !opt.steps.length) {
      const why = refused ?? (act === "later" ? await pipeline.habitLater(u, id, day, now) : snoozeDayRefusal(day, dayKey(now, u.tz)) ?? "До 00:00 уже не успеть.");
      await popup(why);
      return void (await close());
    }
    if (act === "later" || act === "step") return void (await step(habitLaterRows(id, day, opt)));
    if (act === "back") return void (await step([habitButtons(id, day)]));
    if (act === "pick") return void (await step(opt.hours.length ? habitPickRows(id, day, opt.hours) : habitLaterRows(id, day, opt)));
    const when = act[0] === "s" ? { in: Number(act.slice(1)) } : { at: `${act.slice(1, 3)}:${act.slice(3)}` };
    if ("at" in when && !isTime(when.at)) return void (await step(habitLaterRows(id, day, opt)));
    const r = await pipeline.habitSnooze(u, id, day, when, now);
    await popup(r.text);
    // Не вышло (время прошло, до полуночи не успеть) — второй шаг с тем, что ещё можно; уже отмечено — клавиатура снимается.
    if (r.ok || (await marked())) await close();
    else await show(habitLaterRows(id, day, opt));
  });

  // Закономерность: добавить в дебафы профиля или нет.
  bot.callbackQuery(/^trait:(\d+):(yes|no)$/, async (ctx) => {
    const u = await userOf(ctx);
    if (!u) return ctx.answerCallbackQuery();
    const text = await decideTrait(store, u, Number(ctx.match[1]), ctx.match[2] === "yes");
    await ctx.answerCallbackQuery({ text: text.replace(/<[^>]+>/g, "").slice(0, 190) });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  });

  // «Записать в профиль?» и вопросы Рины о вас (you.ts): ответ — всплывашкой, кнопки убираются.
  bot.callbackQuery(/^you:\w+:\w+$/, async (ctx) => {
    const u = await userOf(ctx);
    if (!u) return ctx.answerCallbackQuery();
    const r = await youButton(store, u, ctx.match[0]).catch(() => ({ text: "Не поняла кнопку.", tzChanged: false }));
    if (r.tzChanged) await replanEvents(store, (await store.user(u.id))!);
    await ctx.answerCallbackQuery({ text: r.text.slice(0, 190) });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  });

  // Оценка дня под вечерним итогом: повторное нажатие заменяет оценку, поэтому кнопки остаются.
  bot.callbackQuery(RATE, async (ctx) => {
    const u = await userOf(ctx);
    if (!u) return ctx.answerCallbackQuery();
    const text = await rateDay(store, u, ctx.match[1], Number(ctx.match[2])).catch(() => "Не поняла оценку.");
    await ctx.answerCallbackQuery({ text });
  });

  // Вопрос «добавить?»: t:N — галочка пункта, r — с напоминанием, a — в список, n — не надо.
  bot.callbackQuery(/^prop:(\d+):(t:\d+|r|a|n)$/, async (ctx) => {
    const u = await userOf(ctx);
    if (!u) return ctx.answerCallbackQuery();
    const [, id, act] = ctx.match;
    if (act.startsWith("t:")) {
      const p = await pipeline.toggleProposal(u, Number(id), Number(act.slice(2)));
      if (!p) return ctx.answerCallbackQuery({ text: "Этот вопрос уже закрыт." });
      const msg = await store.proposal(p.id);
      const undoId = msg && (await store.actionsOf(msg.message_id)).length ? msg.message_id : null;
      await ctx.editMessageReplyMarkup({ reply_markup: proposalKeyboard(p, undoId) }).catch(() => {});
      return ctx.answerCallbackQuery();
    }
    const r = await pipeline.decideProposal(u, Number(id), act === "r" ? "remind" : act === "a" ? "add" : "decline");
    await ctx.answerCallbackQuery({ text: r.text.replace(/<[^>]+>/g, "").slice(0, 190) });
  });

  // «Сдвинуть» / «Оставить» после наложения: строка вопроса заменяется итогом, остаются «Отменить» / «Это просто заметка».
  bot.callbackQuery(/^clash:(\d+):(\d+):(\d+):(s|k)$/, async (ctx) => {
    const u = await userOf(ctx);
    if (!u) return ctx.answerCallbackQuery();
    const [, msgId, eventId, withId, act] = ctx.match;
    const r = await pipeline.decideClash(u, Number(msgId), Number(eventId), Number(withId), act === "s" ? "shift" : "keep");
    await ctx.answerCallbackQuery({ text: r.text.replace(/<[^>]+>/g, "").slice(0, 190) });
    const kb = (await store.actionsOf(Number(msgId))).length ? undoRow(new InlineKeyboard(), Number(msgId)) : undefined;
    const opts = { parse_mode: "HTML" as const, reply_markup: kb };
    if (r.reply) {
      await ctx.editMessageText(r.reply, { ...opts, link_preview_options: { is_disabled: true } })
        .catch(() => ctx.editMessageCaption({ caption: r.reply!, ...opts }))
        .catch(() => ctx.editMessageReplyMarkup({ reply_markup: kb }).catch(() => {}));
    } else await ctx.editMessageReplyMarkup({ reply_markup: kb }).catch(() => {});
  });

  bot.callbackQuery(/^retry:(\d+)$/, async (ctx) => {
    const u = await userOf(ctx);
    if (!u) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery({ text: "Пробую ещё раз…" });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    const r = await pipeline.retry(u, Number(ctx.match[1]), new Date(), "telegram");
    await answer(ctx, u, r);
  });

  bot.callbackQuery(/^(undo|note|persona):(.+)$/, async (ctx) => {
    const u = await userOf(ctx);
    if (!u) return ctx.answerCallbackQuery();
    const [, kind, arg] = ctx.match;
    let text: string;
    if (kind === "persona") {
      if (!PERSONAS[arg]) return ctx.answerCallbackQuery();
      await store.updateUser(u.id, { persona: arg });
      await countPersona(store, u, "telegram");
      text = `Теперь я — ${PERSONAS[arg].name.toLowerCase()}.`;
    } else if (kind === "undo") text = await pipeline.undo(u, Number(arg));
    else text = await pipeline.asNote(u, Number(arg));
    await ctx.answerCallbackQuery({ text: text.slice(0, 190) });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    await ctx.reply(text);
  });

  bot.on("message:text", async (ctx) => {
    const u = await userOf(ctx);
    if (!u) return;
    if (asksForList(ctx.message.text)) return void (await showList(ctx, u));
    await ctx.replyWithChatAction("typing").catch(() => {});
    const r = await pipeline.handle({
      user: u, source: "telegram", sourceId: String(ctx.message.message_id), text: ctx.message.text,
      at: new Date(ctx.message.date * 1000), client: "telegram",
    });
    if (!r.duplicate) await answer(ctx, u, r);
  });

  // Фото или картинка файлом (чек, билет, скриншот): скачать и разобрать вместе с подписью.
  bot.on(["message:photo", "message:document"], async (ctx) => {
    const u = await userOf(ctx);
    if (!u) return;
    const doc = ctx.message.document;
    if (doc && !IMAGE_TYPES.includes(doc.mime_type ?? "")) return void (await ctx.reply("Из файлов понимаю только картинки: фото, скриншоты, чеки."));
    const photo = ctx.message.photo?.at(-1); // самый крупный размер
    const media = photo ?? doc;
    if (!media || (media.file_size ?? 0) > IMAGE_MAX_BYTES) return void (await ctx.reply("Слишком большая картинка."));
    await ctx.replyWithChatAction("typing").catch(() => {});
    let data: string;
    try {
      const file = await ctx.api.getFile(media.file_id);
      const res = await fetch(`https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`файл ${res.status}`);
      data = Buffer.from(await res.arrayBuffer()).toString("base64");
    } catch (e) {
      console.error("[bot] photo", e);
      return void (await ctx.reply("Не получилось скачать картинку, пришли ещё раз."));
    }
    const r = await pipeline.handle({
      user: u, source: "telegram", sourceId: String(ctx.message.message_id), text: (ctx.message.caption ?? "").slice(0, 4000),
      images: [{ data, mime: photo ? "image/jpeg" : doc!.mime_type! }],
      at: new Date(ctx.message.date * 1000), client: "telegram",
    });
    if (!r.duplicate) await answer(ctx, u, r);
  });

  // Голосовое: скачать, распознать, показать, что услышала, и дальше как текст.
  bot.on(["message:voice", "message:audio"], async (ctx) => {
    const u = await userOf(ctx);
    if (!u) return;
    if (!sttReady()) return void (await ctx.reply("Голосовые пока не понимаю: распознавание речи не настроено."));
    const media = ctx.message.voice ?? ctx.message.audio;
    if (!media || (media.file_size ?? 0) > VOICE_MAX_BYTES) return void (await ctx.reply("Слишком длинное голосовое."));
    // Повтор доставки того же голосового (Telegram прислал обновление ещё раз): уже разобранное и то, что ещё идёт, — без второго
    // списания и второго распознавания (pipeline.delivered, pipeline.inFlight).
    const sourceId = String(ctx.message.message_id);
    if (await pipeline.delivered(u, "telegram", sourceId)) return;
    await pipeline.inFlight(`voice:${u.id}:telegram:${sourceId}`, async () => {
      // Распознавание — тоже ИИ (и платное, даже если услышали тишину): доступ, частота и потолок — до него. Частота отмечена здесь,
      // разбор ниже второй раз её не считает (gated).
      // Лимит в штуках (access.ts): голосовое — один запрос к ИИ и его секунды (voice.duration от Telegram; нет — по размеру).
      const v = await pipeline.gate?.check(u, { client: "telegram", take: { calls: 1, voiceSec: voiceSeconds(media.file_size ?? 0, media.duration) } });
      if (v && !v.ok) return void (await ctx.reply(v.why === "rate" ? RATE_AGAIN : v.text, { reply_markup: v.why === "access" ? await payKeyboard(u) : undefined }));
      await ctx.replyWithChatAction("typing").catch(() => {});
      let heard: string;
      try {
        const file = await ctx.api.getFile(media.file_id);
        const res = await fetch(`https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`, { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`файл ${res.status}`);
        heard = await transcribe(Buffer.from(await res.arrayBuffer()), media.mime_type ?? "audio/ogg");
      } catch (e) {
        if (v?.ok) await pipeline.gate?.refund(u, v.taken);
        console.error("[bot] voice", e);
        return void (await ctx.reply("Не получилось распознать голосовое, попробуй ещё раз."));
      }
      if (!heard) return void (await ctx.reply("Ничего не расслышала."));
      countFeature(u, "telegram", "voice"); // распознано — тогда и в счёт (сбой и тишина — нет)
      await ctx.reply(`🎙 <i>${heard.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</i>`, { parse_mode: "HTML" });
      const r = await pipeline.handle({
        user: u, source: "telegram", sourceId, text: heard.slice(0, 4000),
        at: new Date(ctx.message.date * 1000), client: "telegram", gated: true,
      });
      if (!r.duplicate) await answer(ctx, u, r);
    });
  });

  bot.catch((e) => console.error("[bot]", e.error));

  const send: Send = async (u, text, emotion, buttons) => {
    if (!u.chat_id) return;
    let markup: InlineKeyboard | undefined;
    if (buttons?.length) {
      markup = new InlineKeyboard();
      // Много кнопок (оценка дня — десять) — рядами по пять: в один ряд Telegram столько не берёт.
      buttons.forEach((b, i) => {
        if (i && i % 5 === 0 && buttons.length > 5) markup!.row();
        markup!.text(b.text, b.data);
      });
    }
    const img = emotionImage(u.persona, emotion);
    if (img && text.length <= 1000) {
      await bot.api.sendPhoto(u.chat_id, new InputFile(img), { caption: text, parse_mode: "HTML", reply_markup: markup });
    } else {
      await bot.api.sendMessage(u.chat_id, text, { parse_mode: "HTML", reply_markup: markup, link_preview_options: { is_disabled: true } });
    }
  };

  /** Файл в чат (резервная копия). */
  const sendFile = async (u: User, name: string, data: Buffer, caption: string) => {
    if (!u.chat_id) return;
    await bot.api.sendDocument(u.chat_id, new InputFile(data, name), { caption });
  };

  return { bot, send, sendFile, billing };
}
