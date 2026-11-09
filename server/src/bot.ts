import fs from "node:fs";
import path from "node:path";
import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";
import { config, ROOT } from "./config.ts";
import { issueToken } from "./auth.ts";
import type { Store, User } from "./db.ts";
import { habitLine, habitsOfDay } from "./habits.ts";
import type { Pipeline, Reply } from "./pipeline.ts";
import { PERSONAS, type Emotion } from "./personas.ts";
import { datesText, memoryText, plansText, tasksText, todayText } from "./report.ts";
import type { Scheduler, Send } from "./scheduler.ts";
import { dayKey } from "./time.ts";
import { sttReady, transcribe, VOICE_MAX_BYTES } from "./voice.ts";
import { WIDGET_CAPTION, WIDGET_HTML, widgetQuery, widgetState } from "./widget.ts";

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

  const replyKeyboard = (r: Reply) =>
    r.undoable ? new InlineKeyboard().text("↩ Отменить", `undo:${r.messageId}`).text("📝 Это просто заметка", `note:${r.messageId}`) : undefined;

  async function answer(ctx: Context, u: User, r: Reply) {
    const markup = replyKeyboard(r);
    const img = emotionImage(u.persona, r.emotion);
    if (img && r.text.length <= 1000) {
      await ctx.replyWithPhoto(new InputFile(img), { caption: r.text, parse_mode: "HTML", reply_markup: markup });
    } else {
      await ctx.reply(r.text, { parse_mode: "HTML", reply_markup: markup, link_preview_options: { is_disabled: true } });
    }
  }

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

  bot.command("list", async (ctx) => {
    const u = await userOf(ctx);
    if (!u) return;
    try {
      await raw.sendWidget({ chat_id: ctx.chat.id, html: WIDGET_HTML, caption: WIDGET_CAPTION, allow_queries: true, chat_data: await widgetState(store, u) });
    } catch (e) {
      console.error("[bot] widget", e);
      await ctx.reply("Не получилось показать список-виджет. Обновите Telegram или посмотрите /today.");
    }
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

  bot.callbackQuery(/^habit:(\d+):(\d{4}-\d{2}-\d{2}):(done|skipped)$/, async (ctx) => {
    const u = await userOf(ctx);
    if (!u) return ctx.answerCallbackQuery();
    const [, id, day, status] = ctx.match;
    const text = await pipeline.markHabit(u, Number(id), day, status as "done" | "skipped", "telegram");
    await ctx.answerCallbackQuery({ text: text.replace(/<[^>]+>/g, "").slice(0, 190) });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
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
    await ctx.replyWithChatAction("typing").catch(() => {});
    const r = await pipeline.handle({
      user: u, source: "telegram", sourceId: String(ctx.message.message_id), text: ctx.message.text,
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
