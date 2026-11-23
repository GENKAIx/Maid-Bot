import crypto from "node:crypto";

// Секрет адреса /webhook (24.11.2026, ревью архитектуры). Раньше /webhook принимал любой POST: зная chat id владельца,
// можно было прислать поддельное обновление, и бот выполнил бы его как сообщение владельца (записи, /undo, характер).
// Теперь Telegram при setWebhook получает secret_token и шлёт его в заголовке X-Telegram-Bot-Api-Secret-Token,
// а webhookCallback отвечает 401 на запрос без него. Секрет выводится из токена бота — в .env ничего добавлять не надо,
// сменили токен — сменился и секрет (setWebhook при запуске передаёт новый). Telegram разрешает 1–256 символов A-Z a-z 0-9 _ -.
export function webhookSecret(botToken: string): string {
  return crypto.createHmac("sha256", botToken).update("maid-webhook-secret").digest("hex");
}
