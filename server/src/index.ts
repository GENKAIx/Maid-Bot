import path from "node:path";
import { webhookCallback } from "grammy";
import { createApi } from "./api.ts";
import { createBot } from "./bot.ts";
import { config } from "./config.ts";
import { Store } from "./db.ts";
import { callLlm, isOpenRouter, llmReady, onLlmCall, onLlmUsage, setLiteModel } from "./llm.ts";
import { backupName, exportJson } from "./backup.ts";
import type { User } from "./db.ts";
import { NOTICES_KEEP } from "./notices.ts";
import { Pipeline } from "./pipeline.ts";
import { callDraw, drawReady } from "./draw.ts";
import { WIDGET_UPDATES } from "./widget.ts";
import { Push } from "./push.ts";
import { Scheduler, type Send } from "./scheduler.ts";
import { DbCopies, dbFileBytes, sendEach } from "./snapshot.ts";
import { webhookSecret } from "./webhook.ts";
import { Alerts, noteSendFailure } from "./alerts.ts";
import { isAdmin } from "./auth.ts";
import { flushFeatures } from "./feature-events.ts";
import { AiGate } from "./access.ts";
import { Billing, billingSecret } from "./billing.ts";
import { installLogRedaction } from "./log-redact.ts";
import { loadTariffs, watchTariffs } from "./tariffs.ts";
import { loadSwitches, watchSwitches } from "./switches.ts";
import { loadPrompts, watchPrompts } from "./prompts.ts";
import { noteBotUpdate, noteLlmCall, ServerMeter } from "./server-metrics.ts";
import { OpenRouterBill } from "./openrouter-bill.ts";

// Запуск. Чего не хватает в .env — та часть выключена, остальное работает.
// База: DATABASE_URL (Postgres на Render) или файл SQLite из DB_FILE.

// Сначала — чтобы ни одна строка лога (и падение) не вывела токен бота или ключи.
installLogRedaction([config.telegramToken, config.llm.apiKey, config.stt.apiKey, config.drawing.apiKey, config.drawing.openrouterKey,
  config.databaseUrl, config.desktopToken, config.push.privateKey, config.openrouterManagementKey]);

const store = await Store.open(config.databaseUrl || config.dbFile);
console.log(`[start] база: ${config.databaseUrl ? "Postgres" : "SQLite " + config.dbFile}`);
// Тарифы из базы (tariffs.ts): прочитать сейчас и перечитывать раз в минуту — админка меняет их без выкладки.
await loadTariffs(store);
watchTariffs(store);
// Переключатели функций (этап 6, switches.ts): из базы при запуске и раз в минуту — как тарифы.
await loadSwitches(store);
watchSwitches(store);
// Промпты (prompts.ts): действующие версии из базы при запуске и раз в минуту — админка правит тексты для ИИ без выкладки.
await loadPrompts(store);
watchPrompts(store);
const pipeline = new Pipeline(store, callLlm, config.publicUrl);
if (drawReady()) pipeline.draw = callDraw;
// Платный доступ (access.ts): одна проверка перед ИИ — в конвейере (сообщения, поправки, повтор), планировщике, боте и API.
const gate = new AiGate(store);
pipeline.gate = gate;
// «Записать в профиль?» (you.ts aboutOffer) — как уведомление с кнопками: Telegram, push, облачко виджета.
pipeline.onAbout = (u, text, buttons) => send(u, text, "neutral", buttons, "note");
// Расход модели, рисования и голоса — по дням и назначениям (таблица llm_usage), на сайте — «Настройки» → «Расход».
onLlmUsage((x) => void store.addUsage(new Date(), x).catch((e) => console.error("[usage]", e)));
// Каждая попытка (и удачная, и упавшая) — строкой в журнал llm_calls: время ответа, цена, код ошибки (админка → «Здоровье»).
onLlmCall((x) => {
  noteLlmCall(Boolean(x.error)); // и в «вызовы модели в минуту» нагрузки сервера (server-metrics.ts)
  void store.addLlmCall(new Date(), x).catch((e) => console.error("[llm calls]", e));
});

// Дешёвая модель вместо основной — если владелец выбрал её командой /model.
setLiteModel((await store.kvGet("model:lite")) === "1");

if (!llmReady()) console.warn("[start] LLM_API_KEY не задан — разбор сообщений не работает");

const push = new Push(store, config.push);
if (!push.ready) console.warn("[start] VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY не заданы — push выключен (npm --workspace server run vapid)");

let scheduler: Scheduler | null = null;
let webhook: ((req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => unknown) | undefined;

const tg = config.telegramToken ? createBot(store, pipeline, () => scheduler) : null;
if (tg) {
  // Апдейты бота в минуту (server-metrics.ts): и вебхук, и long polling идут через handleUpdate.
  const handle = tg.bot.handleUpdate.bind(tg.bot);
  tg.bot.handleUpdate = (update, webhookReplyEnvelope) => (noteBotUpdate(), handle(update, webhookReplyEnvelope));
  if (config.publicUrl) webhook = webhookCallback(tg.bot, "http", { secretToken: webhookSecret(config.telegramToken) });
} else console.warn("[start] TELEGRAM_BOT_TOKEN не задан — бот выключен");
// Подписка Telegram Stars (billing.ts): без бота ссылок на оплату нет, сроки всё равно кончаются по расписанию.
const billing = tg?.billing ?? new Billing(store, null, { secret: billingSecret(config.telegramToken || "no-bot") });

// Уведомление уходит всюду, где пользователь есть: в Telegram и на все push-подписки браузеров.
const send: Send = async (u, text, emotion, buttons, kind) => {
  await store.addNotice(u.id, text, emotion, buttons?.length ? JSON.stringify(buttons) : "", kind ?? "");
  await store.pruneNotices(u.id, NOTICES_KEEP);
  const jobs: Promise<unknown>[] = [push.send(u, text, emotion, buttons)];
  // Сбой отправки в Telegram — в счёт правила send_fail (alerts.ts; «бот заблокирован» не в счёт) и дальше, как раньше.
  if (tg && u.chat_id) jobs.push(tg.send(u, text, emotion, buttons).catch((e) => { noteSendFailure(e); throw e; }));
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
// Код входа в админку сайта (admin.ts) и оповещения владельцу (alerts.ts) — только в Telegram, не в ленту уведомлений: её видит и виджет на ПК.
const adminCode = tg ? async (u: User, text: string) => void (await tg.send(u, text, "neutral").catch((e) => { noteSendFailure(e); throw e; })) : undefined;
/** Все админы (isAdmin) с Telegram — получатели оповещений и ночной копии базы. */
const owners = async () => (await store.users()).filter((u) => isAdmin(u, "session"));
// Оповещения владельцу по порогам (alerts.ts): правила в базе, проверка раз в 5 минут из такта планировщика.
const alerts = new Alerts(store, {
  notify: async (text) => {
    let n = 0;
    if (adminCode) for (const u of await owners()) await adminCode(u, text).then(() => n++, (e) => console.error("[alerts]", e));
    return n;
  },
  dbBytes: () => (config.databaseUrl ? null : dbFileBytes(config.dbFile)),
  webhookErrorAt: tg && config.publicUrl ? async () => ((await tg.bot.api.getWebhookInfo()).last_error_date ?? 0) * 1000 || null : undefined,
});
// Ночная копия всей базы (snapshot.ts): 04:00 по поясу владельца, снимок в snapshots/ рядом с базой, сжатый — владельцу в Telegram.
const snapshotDir = config.dbFile && !config.databaseUrl ? path.join(path.dirname(config.dbFile), "snapshots") : null;
const copies = new DbCopies(store, {
  dir: snapshotDir,
  dbFile: config.databaseUrl ? null : config.dbFile,
  send: tg
    ? async (name, data, caption) => sendEach((await owners()).filter((u) => u.chat_id), (u) => tg.sendFile(u, name, data, caption))
    : undefined,
});
// «Счёт OpenRouter» (openrouter-bill.ts): управляющим ключом — /activity и /credits; «потрачено сегодня/неделя/месяц» — ключами
// самого сервера, которые идут через OpenRouter (LLM, рисование, голос). Раз в час из такта планировщика и по кнопке в админке.
const openrouter = new OpenRouterBill(store, {
  key: config.openrouterManagementKey,
  usageKeys: [isOpenRouter(config.llm.baseUrl) ? config.llm.apiKey : "", config.drawing.apiKey ? "" : config.drawing.openrouterKey,
    isOpenRouter(config.stt.baseUrl) ? config.stt.apiKey : ""],
});
scheduler = new Scheduler(store, llmReady() ? callLlm : null, send, backup);
scheduler.aiFor = (u, now) => gate.allowed(u, now);
scheduler.extra = async (now) => {
  // Счётчики фич из памяти — в базу, не чаще раза в минуту (feature-events.ts).
  await flushFeatures(store, now.getTime()).catch((e) => console.error("[features]", e));
  await pipeline.retryFailed((u, text, emotion) => send(u, text, emotion), now);
  // Раз в час: кончившиеся пробы и подписки → free с письмом и кнопкой оплаты; за 3 дня до конца отменённой — напоминание.
  if (await store.once(`billing:${now.toISOString().slice(0, 13)}`)) await billing.expire(now).catch((e) => console.error("[billing]", e));
  // Ночная копия — до проверки правил: неудача сразу попадает в правило backup.
  const tz = (await owners())[0]?.tz ?? config.defaultTimezone;
  if (await copies.due(now, tz)) {
    const r = await copies.run(now).catch((e) => (console.error("[snapshot]", e), null));
    if (r) console.log("[snapshot]", r.status, r.file, r.problem || r.note || "");
  }
  // Оповещения владельцу (alerts.ts): раз в 5 минут, сводка новичков — раз в сутки после 06:00 UTC.
  await alerts.check(now).catch((e) => console.error("[alerts]", e));
  // Счёт OpenRouter — раз в час, без ожидания: медленный OpenRouter не держит такт с напоминаниями; ошибки — статусом в админке.
  openrouter.hourlyInBackground(now);
};
scheduler.start();
// Нагрузка сервера раз в минуту (server-metrics.ts): снимок в server_metrics, 7 дней; админка → «Здоровье сервера».
const meter = new ServerMeter(store, {
  dbBytes: () => (config.databaseUrl ? null : dbFileBytes(config.dbFile)),
  diskPath: config.databaseUrl ? process.cwd() : path.dirname(config.dbFile),
  queue: () => pipeline.inWork,
});
meter.start();
// Вопросы «добавить?» без ответа дольше суток — закрыть (ничего не создают).
const sweep = setInterval(() => void pipeline.sweepProposals().catch((e) => console.error("[proposals]", e)), 10 * 60_000);
void pipeline.sweepProposals().catch(() => {});

let botName: string | undefined;
const server = createApi({ store, pipeline, send, webhook, webDir: config.webDir, desktopDir: config.desktopDir, push, botName: () => botName, adminCode, billing, alerts, copies, llmRpm: config.llm.rpm, openrouter });
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
  meter.stop();
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
