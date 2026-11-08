import { webhookCallback } from "grammy";
import { createApi } from "./api.ts";
import { createBot } from "./bot.ts";
import { config } from "./config.ts";
import { Store } from "./db.ts";
import { callLlm, llmReady } from "./llm.ts";
import { Pipeline } from "./pipeline.ts";
import { Scheduler, type Send } from "./scheduler.ts";

// Запуск. Чего не хватает в .env — та часть выключена, остальное работает.
// База: DATABASE_URL (Postgres на Render) или файл SQLite из DB_FILE.

const store = await Store.open(config.databaseUrl || config.dbFile);
console.log(`[start] база: ${config.databaseUrl ? "Postgres" : "SQLite " + config.dbFile}`);
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

const server = createApi({ store, pipeline, send, webhook, webDir: config.webDir });
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
  if (tg && !config.publicUrl) await tg.bot.stop();
  server.close();
  await store.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
