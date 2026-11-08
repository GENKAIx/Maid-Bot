import { webhookCallback } from "grammy";
import { createApi } from "./api.ts";
import { createBot } from "./bot.ts";
import { config } from "./config.ts";
import { Store } from "./db.ts";
import { callLlm, llmReady } from "./llm.ts";
import { Pipeline } from "./pipeline.ts";
import { Scheduler, type Send } from "./scheduler.ts";
import { SheetsMirror, sheetsReady } from "./sheets.ts";

// Запуск. Чего не хватает в .env — та часть выключена, остальное работает.

const store = new Store(config.dbFile);
const pipeline = new Pipeline(store, callLlm);

if (!llmReady()) console.warn("[start] LLM_API_KEY не задан — разбор сообщений не работает");

let send: Send | undefined;
let scheduler: Scheduler | null = null;
let webhook: ((req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => unknown) | undefined;

const tg = config.telegramToken ? createBot(store, pipeline, () => scheduler) : null;
if (tg) {
  send = tg.send;
  if (config.publicUrl) webhook = webhookCallback(tg.bot, "http");
} else console.warn("[start] TELEGRAM_BOT_TOKEN не задан — бот выключен");

if (send) {
  scheduler = new Scheduler(store, llmReady() ? callLlm : null, send);
  scheduler.start();
}

let mirror: SheetsMirror | null = null;
if (sheetsReady()) {
  mirror = new SheetsMirror(store, () => {
    const owner = config.allowedChatIds[0];
    return owner ? store.userByChat(owner) : store.users()[0];
  });
  store.onChange = (tbl, userId) => mirror!.mark(tbl, userId);
  mirror.start();
  console.log("[start] зеркало в Google Таблицу включено");
} else console.warn("[start] Google Таблица не подключена — зеркало выключено");

const server = createApi({ store, pipeline, send, webhook });
server.listen(config.port, async () => {
  console.log(`[start] сервер: http://localhost:${config.port}`);
  if (!tg) return;
  if (config.publicUrl) {
    await tg.bot.api.setWebhook(`${config.publicUrl}/webhook`);
    console.log("[start] бот: webhook", `${config.publicUrl}/webhook`);
  } else {
    await tg.bot.api.deleteWebhook();
    void tg.bot.start({ onStart: (me) => console.log(`[start] бот @${me.username}: long polling`) });
  }
});

const shutdown = async () => {
  scheduler?.stop();
  mirror?.stop();
  await mirror?.flush();
  if (tg && !config.publicUrl) await tg.bot.stop();
  server.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
