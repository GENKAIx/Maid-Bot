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
  publicUrl: env("PUBLIC_URL").replace(/\/$/, ""),
  llm: {
    baseUrl: env("LLM_BASE_URL", "https://api.openai.com/v1").replace(/\/$/, ""),
    apiKey: env("LLM_API_KEY"),
    model: env("LLM_MODEL", "gpt-4o-mini"),
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
};

export type Config = typeof config;
