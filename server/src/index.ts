import path from "node:path";
import { webhookCallback } from "grammy";
import { createApi } from "./api.ts";
import { createBot } from "./bot.ts";
import { config } from "./config.ts";
import { Store } from "./db.ts";
import { callLlm, llmReady, onLlmCall, onLlmUsage, setLiteModel } from "./llm.ts";
import { backupName, exportJson } from "./backup.ts";
import type { User } from "./db.ts";
import { NOTICES_KEEP } from "./notices.ts";
import { Pipeline } from "./pipeline.ts";
import { callDraw, drawReady } from "./draw.ts";
import { WIDGET_UPDATES } from "./widget.ts";
import { Push } from "./push.ts";
import { Scheduler, type Send } from "./scheduler.ts";
import { takeSnapshot } from "./snapshot.ts";
import { webhookSecret } from "./webhook.ts";
import { adminAlerts } from "./admin-stats.ts";
import { isAdmin } from "./auth.ts";
import { flushFeatures } from "./feature-events.ts";

// Запуск. Чего не хватает в .env — та часть выключена, остальное работает.
// База: DATABASE_URL (Postgres на Render) или файл SQLite из DB_FILE.

const store = await Store.open(config.databaseUrl || config.dbFile);
console.log(`[start] база: ${config.databaseUrl ? "Postgres" : "SQLite " + config.dbFile}`);
const pipeline = new Pipeline(store, callLlm, config.publicUrl);
if (drawReady()) pipeline.draw = callDraw;
// «Записать в профиль?» (you.ts aboutOffer) — как уведомление с кнопками: Telegram, push, облачко виджета.
pipeline.onAbout = (u, text, buttons) => send(u, text, "neutral", buttons, "note");
// Расход модели, рисования и голоса — по дням и назначениям (таблица llm_usage), на сайте — «Настройки» → «Расход».
onLlmUsage((x) => void store.addUsage(new Date(), x).catch((e) => console.error("[usage]", e)));
// Каждая попытка (и удачная, и упавшая) — строкой в журнал llm_calls: время ответа, цена, код ошибки (админка → «Здоровье»).
onLlmCall((x) => void store.addLlmCall(new Date(), x).catch((e) => console.error("[llm calls]", e)));

// Дешёвая модель вместо основной — если владелец выбрал её командой /model.
setLiteModel((await store.kvGet("model:lite")) === "1");

if (!llmReady()) console.warn("[start] LLM_API_KEY не задан — разбор сообщений не работает");

const push = new Push(store, config.push);
if (!push.ready) console.warn("[start] VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY не заданы — push выключен (npm --workspace server run vapid)");

let scheduler: Scheduler | null = null;
let webhook: ((req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => unknown) | undefined;

const tg = config.telegramToken ? createBot(store, pipeline, () => scheduler) : null;
if (tg) {
  if (config.publicUrl) webhook = webhookCallback(tg.bot, "http", { secretToken: webhookSecret(config.telegramToken) });
} else console.warn("[start] TELEGRAM_BOT_TOKEN не задан — бот выключен");

// Уведомление уходит всюду, где пользователь есть: в Telegram и на все push-подписки браузеров.
const send: Send = async (u, text, emotion, buttons, kind) => {
  await store.addNotice(u.id, text, emotion, buttons?.length ? JSON.stringify(buttons) : "", kind ?? "");
  await store.pruneNotices(u.id, NOTICES_KEEP);
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
// Код входа в админку сайта (admin.ts) и тревоги владельцу (admin-stats.ts) — только в Telegram, не в ленту уведомлений: её видит и виджет на ПК.
const adminCode = tg ? async (u: User, text: string) => void (await tg.send(u, text, "neutral")) : undefined;
scheduler = new Scheduler(store, llmReady() ? callLlm : null, send, backup);
// Ночной снимок всей базы (SQLite) — раз в сутки после 00:00 UTC, в snapshots/ рядом с базой (snapshot.ts).
const snapshotDir = config.dbFile && !config.databaseUrl ? path.join(path.dirname(config.dbFile), "snapshots") : null;
scheduler.extra = async (now) => {
  // Счётчики фич из памяти — в базу, не чаще раза в минуту (feature-events.ts).
  await flushFeatures(store, now.getTime()).catch((e) => console.error("[features]", e));
  await pipeline.retryFailed((u, text, emotion) => send(u, text, emotion), now);
  // Тревоги владельцу (admin-stats.ts): перерасход за день, всплеск неразобранных — только в Telegram админам.
  if (adminCode) for (const text of await adminAlerts(store, now).catch((e) => (console.error("[alerts]", e), [] as string[]))) {
    for (const u of await store.users()) if (isAdmin(u, "session")) await adminCode(u, text).catch((e) => console.error("[alerts]", e));
  }
  if (snapshotDir && (await store.once(`snapshot:${now.toISOString().slice(0, 10)}`))) {
    await takeSnapshot(store, snapshotDir, now).then((f) => f && console.log("[snapshot]", f)).catch((e) => console.error("[snapshot]", e));
  }
};
scheduler.start();
// Вопросы «добавить?» без ответа дольше суток — закрыть (ничего не создают).
const sweep = setInterval(() => void pipeline.sweepProposals().catch((e) => console.error("[proposals]", e)), 10 * 60_000);
void pipeline.sweepProposals().catch(() => {});

let botName: string | undefined;
const server = createApi({ store, pipeline, send, webhook, webDir: config.webDir, desktopDir: config.desktopDir, push, botName: () => botName, adminCode });
server.listen(config.port, async () => {
  console.log(`[start] сервер: http://localhost:${config.port}`);
  if (!tg) return;
  tg.bot.api.getMe().then((me) => (botName = me.username)).catch((e) => console.warn("[start] имя бота:", e.message));
  if (config.publicUrl) {
    await tg.bot.api.setWebhook(`${config.publicUrl}/webhook`, { allowed_updates: WIDGET_UPDATES, secret_token: webhookSecret(config.telegramToken) });
    console.log("[start] бот: webhook", `${config.publicUrl}/webhook`);
  } else {
    await tg.bot.api.deleteWebhook();
    void tg.bot.start({ allowed_updates: WIDGET_UPDATES, onStart: (me) => console.log(`[start] бот @${me.username}: long polling`) });
  }
});

const shutdown = async () => {
  scheduler?.stop();
  clearInterval(sweep);
  if (tg && !config.publicUrl) await tg.bot.stop();
  // Запросы, что ещё идут, досчитывают свои счётчики фич — ждём их не дольше 3 с, потом пишем пачку и закрываем базу.
  await new Promise<void>((done) => {
    const t = setTimeout(done, 3000);
    server.close(() => (clearTimeout(t), done()));
    server.closeIdleConnections();
  });
  await flushFeatures(store, Date.now(), true).catch((e) => console.error("[features]", e));
  await store.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
