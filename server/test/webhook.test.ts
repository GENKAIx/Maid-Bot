import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Bot, webhookCallback } from "grammy";
import { createApi } from "../src/api.ts";
import { Store } from "../src/db.ts";
import { Pipeline } from "../src/pipeline.ts";
import { webhookSecret } from "../src/webhook.ts";

// /webhook с секретом (24.11.2026): без заголовка X-Telegram-Bot-Api-Secret-Token или с чужим — 401 и обновление
// не доходит до бота; с верным — доходит. Тем же путём, что в index.ts: webhookCallback(..., { secretToken }) → createApi.

test("webhookSecret: годится для Telegram, постоянный, не совпадает с токеном и зависит от него", () => {
  const a = webhookSecret("123:abc");
  assert.match(a, /^[A-Za-z0-9_-]{1,256}$/);
  assert.equal(webhookSecret("123:abc"), a);
  assert.notEqual(webhookSecret("123:abd"), a);
  assert.ok(!a.includes("abc"));
});

test("/webhook: без секрета и с чужим — 401, с верным — обновление доходит до бота", async () => {
  const token = "123:test-token";
  const bot = new Bot(token, { botInfo: { id: 123, is_bot: true, first_name: "Maid", username: "maid_test_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } as never });
  const got: string[] = [];
  bot.on("message:text", (ctx) => void got.push(ctx.message.text));
  const store = await Store.open(":memory:");
  const webhook = webhookCallback(bot, "http", { secretToken: webhookSecret(token) });
  const server = createApi({ store, pipeline: new Pipeline(store, async () => "{}"), webhook }).listen(0);
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhook`;
  const update = (text: string) => JSON.stringify({ update_id: got.length + 1, message: { message_id: 1, date: 0, chat: { id: 42, type: "private" }, from: { id: 42, is_bot: false, first_name: "X" }, text } });
  const post = (text: string, secret?: string) =>
    fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(secret ? { "x-telegram-bot-api-secret-token": secret } : {}) }, body: update(text) });
  try {
    assert.equal((await post("подделка")).status, 401);
    assert.equal((await post("подделка 2", "wrong")).status, 401);
    assert.deepEqual(got, []);
    assert.equal((await post("настоящее", webhookSecret(token))).status, 200);
    assert.deepEqual(got, ["настоящее"]);
  } finally {
    server.close();
    await store.close();
  }
});
