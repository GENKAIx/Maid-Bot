import assert from "node:assert/strict";
import { test } from "node:test";
import { createBot } from "../src/bot.ts";
import { config } from "../src/config.ts";
import { Store } from "../src/db.ts";
import { Pipeline } from "../src/pipeline.ts";
import { makeSend } from "../src/send.ts";

// Send бота (bot.ts send) и письмо о подписке через общий Send, как собрано в index.ts (billing.deliver = deliver):
// кнопка с url уходит в Telegram ссылкой, обычная — callback_data. Bot API перехвачен, сети нет.

const DAY = 86_400_000;

async function stand() {
  config.telegramToken = "123456:test-token";
  config.allowedChatIds.splice(0, Infinity, "9001");
  config.adminChatIds.splice(0, Infinity);
  const store = await Store.open(":memory:");
  const tg = createBot(store, new Pipeline(store, async () => "{}"), () => null);
  const calls: { method: string; payload: Record<string, any> }[] = [];
  tg.bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, any> });
    const result: unknown = method === "createInvoiceLink" ? "https://t.me/$test"
      : method.startsWith("send") ? { message_id: calls.length, date: 0, chat: { id: 55, type: "private" }, text: "" }
      : true;
    return { ok: true, result } as never;
  });
  const u = await store.createUser({ login: "anya", passwordHash: "x", tz: "Europe/Moscow", chatId: "55", plan: "trial", accessUntil: new Date(Date.now() - DAY).toISOString() });
  const sent = () => calls.filter((c) => c.method === "sendMessage" || c.method === "sendPhoto");
  return { store, tg, u, sent };
}

test("send бота: кнопка с url — ссылка, обычная — callback_data; больше пяти — рядами по пять", async () => {
  const s = await stand();
  await s.tg.send(s.u, "Письмо", "neutral", [{ text: "Оформить", data: "", url: "https://t.me/$inv" }, { text: "Да", data: "habit:1:2026-11-28:done" }]);
  const rows = s.sent().at(-1)!.payload.reply_markup.inline_keyboard;
  assert.deepEqual(rows, [[{ text: "Оформить", url: "https://t.me/$inv" }, { text: "Да", callback_data: "habit:1:2026-11-28:done" }]]);

  await s.tg.send(s.u, "Оценка", "neutral", Array.from({ length: 10 }, (_, i) => ({ text: String(i + 1), data: `rate:${i + 1}` })));
  assert.deepEqual(s.sent().at(-1)!.payload.reply_markup.inline_keyboard.map((r: unknown[]) => r.length), [5, 5]);

  await s.tg.send(s.u, "Без кнопок", "neutral");
  assert.equal(s.sent().at(-1)!.payload.reply_markup, undefined);
  await s.store.close();
});

test("письмо о подписке через общий Send (как в index.ts): в Telegram — с кнопкой-ссылкой оплаты, в ленте кнопки нет", async () => {
  const s = await stand();
  const { deliver } = makeSend({ store: s.store, push: { send: async () => 0 }, telegram: s.tg.send });
  s.tg.billing.deliver = deliver;
  const r = await s.tg.billing.notify(s.u, "Пробная неделя закончилась.");
  assert.deepEqual(r, { feed: true, telegram: true });
  const m = s.sent().at(-1)!;
  assert.equal(String(m.payload.chat_id), "55");
  const [[button]] = m.payload.reply_markup.inline_keyboard;
  assert.equal(button.url, "https://t.me/$test");
  assert.match(button.text, /^Оформить ⭐\d+$/);
  assert.equal(button.callback_data, undefined);
  assert.equal((await s.store.noticesAll(s.u.id, 10))[0].buttons, "");
  await s.store.close();
});
