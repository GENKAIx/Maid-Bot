import assert from "node:assert/strict";
import { test } from "node:test";
import { AiGate } from "../src/access.ts";
import { signPayload, billingSecret } from "../src/billing.ts";
import { createBot } from "../src/bot.ts";
import { config } from "../src/config.ts";
import { Store } from "../src/db.ts";
import type { LlmCall } from "../src/llm.ts";
import { Pipeline } from "../src/pipeline.ts";

// Бот с оплатой (bot.ts): настоящий grammY, но все вызовы Bot API перехватываются (сеть не нужна). Проверяем порядок
// обработчиков: платежи — до фильтра незнакомцев; незнакомец по /start получает пробу; без доступа — отказ с кнопкой оплаты.

const OWNER = "9001";

async function stand() {
  config.telegramToken = "123456:test-token";
  config.allowedChatIds.splice(0, Infinity, OWNER);
  config.adminChatIds.splice(0, Infinity);
  const store = await Store.open(":memory:");
  let llmCalls = 0;
  const llm: LlmCall = async () => (llmCalls++, JSON.stringify({ reply: "Записала.", diary: [{ section: "notes", text: "x" }] }));
  const pipe = new Pipeline(store, llm);
  pipe.gate = new AiGate(store, { owners: () => [OWNER] });
  const { bot } = createBot(store, pipe, () => null);
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    const chat = { id: Number((payload as { chat_id?: number }).chat_id ?? 0), type: "private" };
    const result: unknown = method === "getMe" ? { id: 1, is_bot: true, first_name: "Maid", username: "maid_test_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false }
      : method === "createInvoiceLink" ? "https://t.me/$test"
      : method.startsWith("send") ? { message_id: calls.length, date: 0, chat, text: "" }
      : true;
    return { ok: true, result } as never;
  });
  await bot.init();
  let n = 0;
  const msg = (from: number, extra: Record<string, unknown>) => bot.handleUpdate({
    update_id: ++n,
    message: { message_id: n, date: Math.floor(Date.now() / 1000), chat: { id: from, type: "private", first_name: "Аня" }, from: { id: from, is_bot: false, first_name: "Аня", username: "anya" }, ...extra },
  } as never);
  const text = (from: number, t: string) => msg(from, { text: t, ...(t.startsWith("/") ? { entities: [{ type: "bot_command", offset: 0, length: t.split(" ")[0].length }] } : {}) });
  return { store, bot, calls, msg, text, llmCalls: () => llmCalls, sent: () => calls.filter((c) => c.method === "sendMessage" || c.method === "sendPhoto") };
}

test("бот: незнакомец по /start — запись с пробой и логином; второй /start — справка с остатком пробы", async () => {
  const s = await stand();
  await s.text(55, "/start");
  const u = (await s.store.userByChat("55"))!;
  assert.equal(u.plan, "trial");
  assert.equal(u.login, "anya");
  assert.ok(s.sent().some((c) => /Логин: <code>anya<\/code>/.test(String(c.payload.text)) && /дней — полный доступ бесплатно/.test(String(c.payload.text))));
  assert.ok(!s.sent().some((c) => c.payload.chat_id === OWNER), "о каждом новом владельцу не пишем — сводка раз в сутки");
  await s.text(55, "/start");
  assert.match(String(s.sent().at(-1)!.payload.text), /Пробный доступ: осталось 7 дн/);
  await s.store.close();
});

test("бот: незнакомцу без /start — только подсказка; /terms и /paysupport отвечают и ему", async () => {
  const s = await stand();
  await s.text(66, "привет");
  assert.equal(await s.store.userByChat("66"), undefined, "записи не создано");
  assert.match(String(s.sent().at(-1)!.payload.text), /нажмите \/start/);
  await s.text(66, "/terms");
  assert.match(String(s.sent().at(-1)!.payload.text), /Условия/);
  await s.text(66, "/paysupport где мои звёзды");
  assert.ok(s.sent().some((c) => String(c.payload.chat_id) === OWNER && /где мои звёзды/.test(String(c.payload.text))), "вопрос — владельцу");
  await s.store.close();
});

test("бот: pre_checkout_query без чата — ответ; successful_payment из не привязанного чата проходит фильтр и даёт доступ записи (чат не привязывается)", async () => {
  const s = await stand();
  // Запись с сайта, без Telegram: оплатила по ссылке из /api/billing/link.
  const site = await s.store.createUser({ login: "site", passwordHash: "x", tz: "Europe/Moscow" });
  const payload = signPayload(billingSecret(config.telegramToken), site.id);
  await s.bot.handleUpdate({ update_id: 900, pre_checkout_query: { id: "pq1", from: { id: 77, is_bot: false, first_name: "С" }, currency: "XTR", total_amount: 150, invoice_payload: payload } } as never);
  const pre = s.calls.find((c) => c.method === "answerPreCheckoutQuery")!;
  assert.deepEqual([pre.payload.pre_checkout_query_id, pre.payload.ok], ["pq1", true]);
  const exp = Math.floor(Date.now() / 1000) + 30 * 86400;
  await s.msg(77, { successful_payment: { currency: "XTR", total_amount: 150, invoice_payload: payload, telegram_payment_charge_id: "chg1", provider_payment_charge_id: "", subscription_expiration_date: exp, is_recurring: true, is_first_recurring: true } });
  const me = (await s.store.user(site.id))!;
  assert.deepEqual([me.plan, me.chat_id, me.tg_user_id, me.sub_charge_id], ["paid", null, "77", "chg1"]);
  assert.match(String(s.sent().find((c) => String(c.payload.chat_id) === "77")!.payload.text), /Подписка оформлена/);
  await s.store.close();
});

test("бот: проба кончилась — текст заметкой, без ИИ, под ответом кнопка «Оформить ⭐150»; голос — без распознавания", async () => {
  const s = await stand();
  const u = await s.store.createUser({ login: "late", passwordHash: "x", tz: "Europe/Moscow", chatId: "88", plan: "trial", accessUntil: new Date(Date.now() - 3 * 86_400_000).toISOString() });
  await s.text(88, "купить молоко");
  assert.equal(s.llmCalls(), 0);
  const reply = s.sent().filter((c) => String(c.payload.chat_id) === "88").at(-1)!;
  assert.match(String(reply.payload.text ?? reply.payload.caption), /Пробная неделя закончилась/);
  const kb = (reply.payload.reply_markup as { inline_keyboard: { text: string; url?: string }[][] }).inline_keyboard;
  assert.deepEqual([kb[0][0].text, kb[0][0].url], ["Оформить ⭐150", "https://t.me/$test"]);
  assert.ok((await s.store.diaryRange(u.id, "0000-01-01", "9999-12-31")).some((d) => d.section === "notes" && d.text === "купить молоко"));
  // Просмотр — бесплатно.
  await s.text(88, "/tasks");
  assert.equal(s.llmCalls(), 0);
  await s.msg(88, { voice: { file_id: "v", file_unique_id: "v", duration: 1, file_size: 100 } });
  assert.ok(!s.calls.some((c) => c.method === "getFile"), "голосовое не скачивали и не распознавали");
  await s.store.close();
});

test("бот: /paysupport — не чаще раза в 10 минут от человека и только в личке; владелец отвечает /answer <tg id> — в журнал", async () => {
  const s = await stand();
  await s.text(66, "/paysupport где мои звёзды");
  await s.text(66, "/paysupport ну где же");
  const toOwner = s.sent().filter((c) => String(c.payload.chat_id) === OWNER);
  assert.equal(toOwner.length, 1, "второй вопрос за 10 минут — не пересылаем");
  assert.match(String(s.sent().at(-1)!.payload.text), /уже передан/);
  await s.bot.handleUpdate({
    update_id: 500, message: { message_id: 500, date: Math.floor(Date.now() / 1000), chat: { id: -100, type: "group", title: "г" }, from: { id: 67, is_bot: false, first_name: "Б" }, text: "/paysupport спам", entities: [{ type: "bot_command", offset: 0, length: 11 }] },
  } as never);
  assert.equal(s.sent().filter((c) => String(c.payload.chat_id) === OWNER).length, 1, "из группы — не пересылаем");
  await s.text(Number(OWNER), "/answer 66 Звёзды вернули");
  assert.ok(s.sent().some((c) => String(c.payload.chat_id) === "66" && /Звёзды вернули/.test(String(c.payload.text))));
  assert.ok((await s.store.adminLog()).some((x) => x.action === "paysupport-answer" && x.detail === "без учётной записи"), "в журнал — номер аккаунта или «без учётной записи», не Telegram id");
  // Не владелец — /answer молчит.
  const before = s.sent().length;
  await s.text(66, "/answer 1 привет");
  assert.equal(s.sent().filter((c) => String(c.payload.chat_id) === "1").length, 0);
  assert.ok(s.sent().length >= before);
  await s.store.close();
});

test("бот: /signups off закрывает регистрацию без .env, /signups on — открывает; незнакомец видит «закрыта»", async () => {
  const s = await stand();
  await s.text(Number(OWNER), "/signups off");
  assert.match(String(s.sent().at(-1)!.payload.text), /закрыта/);
  // Одно место (тарифы из базы, tariffs.ts): выключатель — в tariff_settings, kv signups:closed больше не пишется.
  assert.deepEqual((await s.store.tariffSettings()).map((r) => [r.key, r.value]), [["signupsOpen", "false"]]);
  assert.equal(await s.store.kvGet("signups:closed"), undefined);
  assert.equal((await s.store.tariffHistory())[0]?.source, "bot");
  await s.text(70, "/start");
  assert.equal(await s.store.userByChat("70"), undefined);
  assert.match(String(s.sent().at(-1)!.payload.text), /Регистрация сейчас закрыта/);
  await s.text(Number(OWNER), "/signups on");
  await s.text(70, "/start");
  assert.equal((await s.store.userByChat("70"))?.plan, "trial");
  assert.deepEqual(await s.store.tariffSettings(), [], "снова по умолчанию");
  await s.store.close();
});

test("бот: альбом из трёх фото на пробе — все три разобраны (частота окном, не «раз в 3 с»)", async () => {
  const s = await stand();
  await s.store.createUser({ login: "al", passwordHash: "x", tz: "Europe/Moscow", chatId: "71", plan: "trial", accessUntil: new Date(Date.now() + 86_400_000).toISOString() });
  for (let i = 0; i < 3; i++) await s.text(71, `пункт ${i + 1}`);
  assert.equal(s.llmCalls(), 3);
  assert.ok(!s.sent().some((c) => /Много сообщений подряд/.test(String(c.payload.text ?? c.payload.caption))));
  await s.store.close();
});
