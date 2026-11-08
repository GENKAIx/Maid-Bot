import { webhookCallback } from "grammy";
import { createApi } from "./api.ts";
import { createBot } from "./bot.ts";
import { config } from "./config.ts";
import { Store } from "./db.ts";
import { callLlm, llmReady } from "./llm.ts";
import { backupName, exportJson } from "./backup.ts";
import type { User } from "./db.ts";
import { Pipeline } from "./pipeline.ts";
import { Push } from "./push.ts";
import { Scheduler, type Send } from "./scheduler.ts";

// Запуск. Чего не хватает в .env — та часть выключена, остальное работает.
// База: DATABASE_URL (Postgres на Render) или файл SQLite из DB_FILE.

const store = await Store.open(config.databaseUrl || config.dbFile);
console.log(`[start] база: ${config.databaseUrl ? "Postgres" : "SQLite " + config.dbFile}`);
const pipeline = new Pipeline(store, callLlm, config.publicUrl);

if (!llmReady()) console.warn("[start] LLM_API_KEY не задан — разбор сообщений не работает");

const push = new Push(store, config.push);
if (!push.ready) console.warn("[start] VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY не заданы — push выключен (npm --workspace server run vapid)");

let scheduler: Scheduler | null = null;
let webhook: ((req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => unknown) | undefined;

const tg = config.telegramToken ? createBot(store, pipeline, () => scheduler) : null;
if (tg) {
  if (config.publicUrl) webhook = webhookCallback(tg.bot, "http");
} else console.warn("[start] TELEGRAM_BOT_TOKEN не задан — бот выключен");

// Уведомление уходит всюду, где пользователь есть: в Telegram и на все push-подписки браузеров.
const send: Send = async (u, text, emotion, buttons) => {
  await store.addNotice(u.id, text, emotion, buttons?.length ? JSON.stringify(buttons) : "");
  await store.pruneNotices(u.id);
  const jobs: Promise<unknown>[] = [push.send(u, text, emotion, buttons)];
  if (tg && u.chat_id) jobs.push(tg.send(u, text, emotion, buttons));
  await Promise.all(jobs);
};
// Резервная копия раз в сутки — в Telegram (если бот есть); в приложении — «Скачать копию».
const backup = tg
  ? async (u: User) => {
      if (!u.chat_id) return;
      const data = Buffer.from(JSON.stringify(await exportJson(store, u.id)));
      await tg.sendFile(u, backupName(u.login), data, "Резервная копия записей");
    }
  : undefined;
scheduler = new Scheduler(store, llmReady() ? callLlm : null, send, backup);
scheduler.start();

const server = createApi({ store, pipeline, send, webhook, webDir: config.webDir, push });
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
