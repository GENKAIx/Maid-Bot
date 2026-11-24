import fs from "node:fs";
import path from "node:path";

/** Корень проекта, откуда читаются .env и относительные пути. */
export const ROOT = path.resolve(import.meta.dirname, "..", "..");

function loadEnv(file: string) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    if (k && process.env[k] === undefined) process.env[k] = t.slice(i + 1).trim();
  }
}

loadEnv(path.join(ROOT, ".env"));

const env = (k: string, d = "") => process.env[k]?.trim() || d;
const fromRoot = (p: string) => (p ? path.resolve(ROOT, p) : "");

export const config = {
  telegramToken: env("TELEGRAM_BOT_TOKEN"),
  allowedChatIds: env("ALLOWED_CHAT_IDS")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  /** Кто входит в админку сайта (/admin, admin.ts). Пусто — первый из ALLOWED_CHAT_IDS (тот же владелец, что у DESKTOP_TOKEN):
   *  если в ALLOWED_CHAT_IDS несколько человек, админом становится только первый, остальные — лишь через этот список. */
  adminChatIds: env("ADMIN_CHAT_IDS")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  publicUrl: env("PUBLIC_URL").replace(/\/$/, ""),
  llm: {
    baseUrl: env("LLM_BASE_URL", "https://api.openai.com/v1").replace(/\/$/, ""),
    apiKey: env("LLM_API_KEY"),
    model: env("LLM_MODEL", "gpt-4o-mini"),
  },
  /** Распознавание голоса (/audio/transcriptions). Пусто — те же адрес и ключ, что у LLM. */
  stt: {
    baseUrl: env("STT_BASE_URL", env("LLM_BASE_URL", "https://api.openai.com/v1")).replace(/\/$/, ""),
    apiKey: env("STT_API_KEY", env("LLM_API_KEY")),
    model: "",
  },
  /** Картинки по просьбе («нарисуй кота»): RunPod, модель Z-Image Turbo ($0,005 за картинку); нет ключа RunPod — OpenRouter
   *  (по умолчанию Gemini 2.5 Flash Image, ~$0,04 за картинку; ключ — OPENROUTER_API_KEY или ключ LLM, если LLM идёт через OpenRouter).
   *  Нет ни того, ни другого — горничная не рисует. */
  drawing: {
    apiKey: env("RUNPOD_API_KEY"),
    model: env("RUNPOD_DRAW_MODEL", "z-image-turbo"),
    openrouterKey: env("OPENROUTER_API_KEY"),
    openrouterModel: env("OPENROUTER_DRAW_MODEL", "google/gemini-2.5-flash-image"),
  },
  port: Number(env("PORT", "3000")),
  /** Postgres (Render). Если задан — главнее файла SQLite. */
  databaseUrl: env("DATABASE_URL"),
  dbFile: fromRoot(env("DB_FILE", "data/maid.sqlite")),
  defaultTimezone: env("DEFAULT_TIMEZONE", "Europe/Moscow"),
  desktopToken: env("DESKTOP_TOKEN"),
  /** Web Push: ключи VAPID (npm --workspace server run vapid), subject — mailto: или https://. Пусто — push выключен. */
  push: {
    publicKey: env("VAPID_PUBLIC_KEY"),
    privateKey: env("VAPID_PRIVATE_KEY"),
    subject: env("VAPID_SUBJECT", "mailto:maid@example.com"),
  },
  /** Собранное веб-приложение (npm --workspace web run build); сервер отдаёт его с корня. */
  webDir: fromRoot(env("WEB_DIR", "web/dist")),
  /** Установщик программы для ПК и latest.yml (tools/release-desktop.py кладёт их сюда); программа обновляется отсюда — /desktop/. */
  desktopDir: fromRoot(env("DESKTOP_DIR", "data/desktop")),
  /** Платный доступ (access.ts, billing.ts): подписка Telegram Stars, проба для новых, защита открытого бота. */
  billing: {
    /** Цена подписки в звёздах (XTR) за месяц; Telegram продлевает её сам раз в 30 дней. */
    price: 150,
    /** Пробный срок полного доступа для каждого нового человека (/start в боте), дней. */
    trialDays: 7,
    /** Подарок по /invite, дней (продлевает срок и тем, у кого запись уже есть). */
    giftDays: 30,
    /** Аварийный выключатель регистрации незнакомцев: SIGNUPS_OPEN=0 — /start без приглашения отвечает «закрыто». */
    signupsOpen: env("SIGNUPS_OPEN", "1") !== "0",
    /** Новых учётных записей через /start — не больше стольких за час и за сутки (на весь сервер). Владелец ещё может закрыть
     *  регистрацию командой /signups off (kv signups:closed) — без правки .env. */
    signupsPerHour: 30,
    signupsPerDay: 150,
    /** Частота ИИ на человека (пробные и платные; друзьям и владельцу — без ограничения): не больше aiBurst вызовов за aiWindowMs.
     *  Окном, а не промежутком: альбом из 3 фото и пачка пересланных сообщений проходят. Сверх — сообщение «не удалось»,
     *  его разберёт фоновый повтор (pipeline.ts retryFailed). */
    aiBurst: 10,
    aiWindowMs: 60_000,
    /** Потолок расхода ИИ на человека в день (UTC, по llm_usage), доллары: на пробе и по подписке. Друзьям и владельцу — без потолка. */
    trialDayUsd: 0.3,
    paidDayUsd: 1.5,
    /** Общий потолок расхода всех проб за день (UTC), доллары: наплыв одноразовых аккаунтов не съест бюджет сервера. */
    trialPoolDayUsd: 10,
    /** Цена вызова, если провайдер её не вернул (прямой OpenAI, Groq, RunPod), доллары — для потолков (db.ts daySpend). */
    unpricedUsd: { draw: 0.03, voice: 0.005, other: 0.003 },
  },
};

// Имя модели распознавания у каждого сервиса своё: OpenRouter — «openai/whisper-large-v3», Groq — «whisper-large-v3», OpenAI — «whisper-1».
config.stt.model = env(
  "STT_MODEL",
  /openrouter\.ai/.test(config.stt.baseUrl) ? "openai/whisper-large-v3" : /groq\.com/.test(config.stt.baseUrl) ? "whisper-large-v3" : "whisper-1",
);

if (!config.drawing.openrouterKey && /openrouter\.ai/.test(config.llm.baseUrl)) config.drawing.openrouterKey = config.llm.apiKey;

export type Config = typeof config;
