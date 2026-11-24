import util from "node:util";

// Секреты в логах (24.11.2026). grammY кладёт адрес запроса с токеном бота в текст ошибки
// («request to https://api.telegram.org/bot<токен>/setWebhook failed»), и он попадал в docker logs.
// Всё, что сервер пишет через console, и падение процесса проходят здесь: известные секреты из .env
// заменяются на «<скрыто>», любой токен Telegram-бота (цифры:строка) — на «<токен бота>».

const BOT_TOKEN_RE = /\d{6,12}:[A-Za-z0-9_-]{30,}/g;
const METHODS = ["log", "info", "warn", "error", "debug"] as const;
let installed = false;

/** Убирает секреты из строки. Короче 8 символов не считаются секретом (иначе зацепит обычные слова). */
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join("<скрыто>");
  return out.replace(BOT_TOKEN_RE, "<токен бота>");
}

/** Один раз при запуске: console.* и необработанные ошибки печатаются уже без секретов. Падение остаётся падением (код 1). */
export function installLogRedaction(secrets: readonly string[]): void {
  if (installed) return;
  installed = true;
  const list = secrets.filter(Boolean);
  for (const k of METHODS) {
    const orig = console[k].bind(console);
    console[k] = (...args: unknown[]) => orig(redactSecrets(util.format(...args), list));
  }
  const die = (e: unknown) => {
    console.error("[fatal]", e);
    process.exit(1);
  };
  process.on("uncaughtException", die);
  process.on("unhandledRejection", die);
}
