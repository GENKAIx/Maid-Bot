import fs from "node:fs";
import path from "node:path";
import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";
import { config, ROOT } from "./config.ts";
import { issueToken } from "./auth.ts";
import type { Store, User } from "./db.ts";
import { habitLine, habitsOfDay } from "./habits.ts";
import type { Pipeline, Proposal, Reply } from "./pipeline.ts";
import { PERSONAS, type Emotion } from "./personas.ts";
import { datesText, memoryText, plansText, tasksText, todayText } from "./report.ts";
import type { Scheduler, Send } from "./scheduler.ts";
import { dayKey } from "./time.ts";
import { decideTrait } from "./profile.ts";
import { sttReady, transcribe, VOICE_MAX_BYTES } from "./voice.ts";
import { IMAGE_MAX_BYTES, IMAGE_TYPES } from "./llm.ts";
import { asksForList, WIDGET_CAPTION, WIDGET_HTML, widgetQuery, widgetState } from "./widget.ts";

// Telegram: обычный текст — запись (без режимов), команды — просмотр и настройки.

export function emotionImage(personaId: string, emotion: Emotion): string | null {
  const file = path.join(ROOT, "assets", "emotions", personaId, `${emotion}.png`);
  return fs.existsSync(file) ? file : null;
}

export function createBot(store: Store, pipeline: Pipeline, scheduler: () => Scheduler | null) {
  const bot = new Bot(config.telegramToken);

  const allowed = (chatId: string) => config.allowedChatIds.includes(chatId);
  const userOf = async (ctx: Context): Promise<User | null> => {
    const chat = String(ctx.chat?.id ?? "");
    if (!chat || !allowed(chat)) return null;
    return store.ensureUser(chat, ctx.from?.first_name ?? "", config.defaultTimezone);
  };

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
    const markup = replyKeyboard(r);
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

  // Чужим — только chat id, чтобы владелец мог себя добавить.
  bot.use(async (ctx, next) => {
    const chat = String(ctx.chat?.id ?? "");
    if (chat && !allowed(chat)) {
      if (ctx.message?.text?.startsWith("/chatid")) await ctx.reply(`chat id: <code>${chat}</code>`, { parse_mode: "HTML" });
      return;
    }
    await next();
  });

  // Виджет «Список на сегодня» (Bot API 10.4). grammy этих методов и обновлений ещё не знает — вызываем напрямую.
  type WidgetQueryUpdate = { id: string; from: { id: number }; chat?: { id: number }; message_id?: number; data: string; type?: { type: string } };
  const raw = bot.api.raw as unknown as Record<string, (p: Record<string, unknown>) => Promise<unknown>>;
  bot.use(async (ctx, next) => {
    const q = (ctx.update as { widget_query?: WidgetQueryUpdate }).widget_query;
    if (!q) return next();
    const chat = String(q.chat?.id ?? q.from.id);
    if (!allowed(chat) || q.type?.type !== "data") return void (await raw.answerWidgetQuery({ widget_query_id: q.id }).catch(() => {}));
    const u = await store.ensureUser(chat, "", config.defaultTimezone);
    const state = await widgetQuery(store, pipeline, u, q.data);
    await raw.answerWidgetQuery({ widget_query_id: q.id, data: state });
    if (q.chat && q.message_id) await raw.editMessageWidgetData({ chat_id: q.chat.id, message_id: q.message_id, chat_data: state }).catch(() => {});
  });

  // Последний присланный список живой: бот обновляет его после каждого изменения (kv widget:<id> = {chat, msg}).
  const widgetKey = (u: User) => `widget:${u.id}`;
  async function showList(ctx: Context, u: User) {
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
    await ctx.reply(
      "Я ваша горничная. Пишите как есть — что было за день, что запланировано, что не забыть. " +
        "Я сама разложу: дневник, планы, задачи, важные даты.\n\n" +
        "/list — список на сегодня с галочками\n/today — сегодня\n/plans — планы\n/tasks — задачи\n/dates — важные даты\n/memory — что я помню\n" +
        "/ask текст — просто поговорить\n/undo — отменить последнее\n/summary — итог дня\n/persona — характер\n" +
        "/habits — привычки на сегодня\n/token — ключ для приложения на ПК",
    );
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
    await answer(ctx, u, await pipeline.handle({ user: u, source: "telegram", sourceId: String(ctx.message.message_id), text, chatOnly: true }));
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
    await ctx.reply(`Ключ для приложения на ПК (никому не показывайте):\n<code>${token}</code>`, { parse_mode: "HTML" });
  });

  bot.callbackQuery(/^habit:(\d+):(\d{4}-\d{2}-\d{2}):(done|skipped|later)$/, async (ctx) => {
    const u = await userOf(ctx);
    if (!u) return ctx.answerCallbackQuery();
    const [, id, day, status] = ctx.match;
    const text = status === "later"
      ? await pipeline.habitLater(u, Number(id), day)
      : await pipeline.markHabit(u, Number(id), day, status as "done" | "skipped", "telegram");
    await ctx.answerCallbackQuery({ text: text.replace(/<[^>]+>/g, "").slice(0, 190) });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  });

  // Закономерность: добавить в дебафы профиля или нет.
  bot.callbackQuery(/^trait:(\d+):(yes|no)$/, async (ctx) => {
    const u = await userOf(ctx);
    if (!u) return ctx.answerCallbackQuery();
    const text = await decideTrait(store, u, Number(ctx.match[1]), ctx.match[2] === "yes");
    await ctx.answerCallbackQuery({ text: text.replace(/<[^>]+>/g, "").slice(0, 190) });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
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
    const r = await pipeline.retry(u, Number(ctx.match[1]));
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
      at: new Date(ctx.message.date * 1000),
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
      at: new Date(ctx.message.date * 1000),
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
    await ctx.replyWithChatAction("typing").catch(() => {});
    let heard: string;
    try {
      const file = await ctx.api.getFile(media.file_id);
      const res = await fetch(`https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`файл ${res.status}`);
      heard = await transcribe(Buffer.from(await res.arrayBuffer()), media.mime_type ?? "audio/ogg");
    } catch (e) {
      console.error("[bot] voice", e);
      return void (await ctx.reply("Не получилось распознать голосовое, попробуй ещё раз."));
    }
    if (!heard) return void (await ctx.reply("Ничего не расслышала."));
    await ctx.reply(`🎙 <i>${heard.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</i>`, { parse_mode: "HTML" });
    const r = await pipeline.handle({
      user: u, source: "telegram", sourceId: String(ctx.message.message_id), text: heard.slice(0, 4000),
      at: new Date(ctx.message.date * 1000),
    });
    if (!r.duplicate) await answer(ctx, u, r);
  });

  bot.catch((e) => console.error("[bot]", e.error));

  const send: Send = async (u, text, emotion, buttons) => {
    if (!u.chat_id) return;
    let markup: InlineKeyboard | undefined;
    if (buttons?.length) {
      markup = new InlineKeyboard();
      for (const b of buttons) markup.text(b.text, b.data);
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

  return { bot, send, sendFile };
}
