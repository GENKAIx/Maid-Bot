import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";
import { config, ROOT } from "./config.ts";
import type { Store, User } from "./db.ts";
import type { Pipeline, Reply } from "./pipeline.ts";
import { PERSONAS, type Emotion } from "./personas.ts";
import { datesText, memoryText, plansText, tasksText, todayText } from "./report.ts";
import type { Scheduler, Send } from "./scheduler.ts";
import { dayKey } from "./time.ts";

// Telegram: обычный текст — запись (без режимов), команды — просмотр и настройки.

export function emotionImage(personaId: string, emotion: Emotion): string | null {
  const file = path.join(ROOT, "assets", "emotions", personaId, `${emotion}.png`);
  return fs.existsSync(file) ? file : null;
}

export function createBot(store: Store, pipeline: Pipeline, scheduler: () => Scheduler | null) {
  const bot = new Bot(config.telegramToken);

  const allowed = (chatId: string) => config.allowedChatIds.includes(chatId);
  const userOf = (ctx: Context): User | null => {
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

  bot.command("start", async (ctx) => {
    const u = userOf(ctx);
    if (!u) return;
    await ctx.reply(
      "Я ваша горничная. Пишите как есть — что было за день, что запланировано, что не забыть. " +
        "Я сама разложу: дневник, планы, задачи, важные даты.\n\n" +
        "/today — сегодня\n/plans — планы\n/tasks — задачи\n/dates — важные даты\n/memory — что я помню\n" +
        "/ask текст — просто поговорить\n/undo — отменить последнее\n/summary — итог дня\n/persona — характер\n" +
        "/token — ключ для приложения на ПК",
    );
  });
  bot.command("chatid", (ctx) => ctx.reply(`chat id: <code>${ctx.chat.id}</code>`, { parse_mode: "HTML" }));

  const view = (fn: (u: User, today: string) => string) => async (ctx: Context) => {
    const u = userOf(ctx);
    if (!u) return;
    await ctx.reply(fn(u, dayKey(new Date(), u.tz)), { parse_mode: "HTML" });
  };
  bot.command("today", view((u, d) => todayText(store, u, d)));
  bot.command("plans", view((u, d) => plansText(store, u, d)));
  bot.command("tasks", view((u, d) => tasksText(store, u, d)));
  bot.command("dates", view((u, d) => datesText(store, u, d)));
  bot.command("memory", view((u) => memoryText(store, u)));

  bot.command("summary", async (ctx) => {
    const u = userOf(ctx);
    const s = scheduler();
    if (!u || !s) return;
    await ctx.reply(await s.eveningText(u, dayKey(new Date(), u.tz)), { parse_mode: "HTML" });
  });

  bot.command("undo", async (ctx) => {
    const u = userOf(ctx);
    if (!u) return;
    await ctx.reply(pipeline.undo(u));
  });

  bot.command("ask", async (ctx) => {
    const u = userOf(ctx);
    if (!u || !ctx.message) return;
    const text = ctx.match.trim();
    if (!text) return ctx.reply("Напишите после /ask, о чём поговорить.");
    await ctx.replyWithChatAction("typing");
    await answer(ctx, u, await pipeline.handle({ user: u, source: "telegram", sourceId: String(ctx.message.message_id), text, chatOnly: true }));
  });

  bot.command("persona", async (ctx) => {
    const u = userOf(ctx);
    if (!u) return;
    const kb = new InlineKeyboard();
    for (const p of Object.values(PERSONAS)) kb.text(`${p.id === u.persona ? "● " : ""}${p.name}`, `persona:${p.id}`).row();
    await ctx.reply("Какой мне быть?", { reply_markup: kb });
  });

  bot.command("token", async (ctx) => {
    const u = userOf(ctx);
    if (!u) return;
    const token = crypto.randomBytes(24).toString("base64url");
    store.kvSet(`token:${token}`, String(u.id));
    await ctx.reply(`Ключ для приложения на ПК (никому не показывайте):\n<code>${token}</code>`, { parse_mode: "HTML" });
  });

  bot.callbackQuery(/^(undo|note|persona):(.+)$/, async (ctx) => {
    const u = userOf(ctx);
    if (!u) return ctx.answerCallbackQuery();
    const [, kind, arg] = ctx.match;
    let text: string;
    if (kind === "persona") {
      if (!PERSONAS[arg]) return ctx.answerCallbackQuery();
      store.updateUser(u.id, { persona: arg });
      text = `Теперь я — ${PERSONAS[arg].name.toLowerCase()}.`;
    } else if (kind === "undo") text = pipeline.undo(u, Number(arg));
    else text = pipeline.asNote(u, Number(arg));
    await ctx.answerCallbackQuery({ text: text.slice(0, 190) });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    await ctx.reply(text);
  });

  bot.on("message:text", async (ctx) => {
    const u = userOf(ctx);
    if (!u) return;
    await ctx.replyWithChatAction("typing").catch(() => {});
    const r = await pipeline.handle({
      user: u, source: "telegram", sourceId: String(ctx.message.message_id), text: ctx.message.text,
      at: new Date(ctx.message.date * 1000),
    });
    if (!r.duplicate) await answer(ctx, u, r);
  });

  bot.catch((e) => console.error("[bot]", e.error));

  const send: Send = async (u, text, emotion) => {
    const img = emotionImage(u.persona, emotion);
    if (img && text.length <= 1000) await bot.api.sendPhoto(u.chat_id, new InputFile(img), { caption: text, parse_mode: "HTML" });
    else await bot.api.sendMessage(u.chat_id, text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  };

  return { bot, send };
}
