import assert from "node:assert/strict";
import { test } from "node:test";
import { Billing, type StarsApi } from "../src/billing.ts";
import { Store, type User } from "../src/db.ts";
import type { Button } from "../src/scheduler.ts";
import { makeSend } from "../src/send.ts";
import { createTicket, ticketAction } from "../src/support.ts";

// Общий Send (send.ts, 28.11.2026): письма о подписке, ответы на обращения и письма об аккаунте идут через него —
// лента, Web Push и Telegram; кнопка-ссылка оплаты видна только в Telegram.

const TZ = "Europe/Moscow";
const NOW = new Date("2026-11-24T12:00:00Z");
const DAY = 86_400_000;

async function setup(tgOk = () => true) {
  const store = await Store.open(":memory:");
  const pushed: { user: number; text: string; buttons?: Button[] }[] = [];
  const tg: { chat: string; text: string; buttons?: Button[] }[] = [];
  const fails: unknown[] = [];
  const parts = makeSend({
    store,
    push: { send: async (u, text, _e, buttons) => (pushed.push({ user: u.id, text, buttons }), 1) },
    telegram: async (u, text, _e, buttons) => {
      if (!tgOk()) throw new Error("403: bot was blocked by the user");
      tg.push({ chat: u.chat_id ?? "", text, buttons });
    },
    onTelegramFail: (e) => fails.push(e),
  });
  const api = {
    createInvoiceLink: async () => "https://t.me/$inv1",
    sendMessage: async () => { throw new Error("в обход Send писать нельзя"); },
  } as unknown as StarsApi;
  const billing = new Billing(store, api, { secret: "s", price: 150, clock: () => NOW });
  billing.deliver = parts.deliver;
  const withTg = await store.createUser({ login: "anya", passwordHash: "x", tz: TZ, chatId: "11", plan: "trial", accessUntil: new Date(NOW.getTime() - DAY).toISOString() });
  const webOnly = await store.createUser({ login: "web", passwordHash: "x", tz: TZ, plan: "trial", accessUntil: new Date(NOW.getTime() - DAY).toISOString() });
  return { store, ...parts, billing, pushed, tg, fails, withTg, webOnly };
}
const feedOf = async (store: Store, u: User) => (await store.noticesAll(u.id, 10)).map((n) => ({ text: n.text, kind: n.kind, buttons: n.buttons }));

test("Send: лента, Web Push и Telegram; кнопка-ссылка — только в Telegram; deliver говорит, куда письмо легло", async () => {
  let ok = true;
  const s = await setup(() => ok);
  try {
    const link: Button = { text: "Оформить ⭐150", data: "", url: "https://t.me/$inv1" };
    await s.send(s.withTg, "Письмо", "neutral", [link], "other");
    assert.deepEqual(await feedOf(s.store, s.withTg), [{ text: "Письмо", kind: "other", buttons: "" }]);
    assert.deepEqual(s.pushed, [{ user: s.withTg.id, text: "Письмо", buttons: [] }]);
    assert.deepEqual(s.tg, [{ chat: "11", text: "Письмо", buttons: [link] }]);
    assert.deepEqual(await s.deliver(s.webOnly, "Без Telegram", "neutral", undefined, "other"), { feed: true, push: 1, telegram: false });
    assert.equal(s.tg.length, 1, "Telegram не привязан — туда не пишем");
    // Telegram не принял: send бросает (как раньше) и считает сбой, deliver — отвечает telegram: false; в ленте и push письмо есть.
    ok = false;
    await assert.rejects(s.send(s.withTg, "Сбой", "neutral"), /403/);
    assert.deepEqual(await s.deliver(s.withTg, "Сбой 2", "neutral"), { feed: true, push: 1, telegram: false });
    assert.equal(s.fails.length, 2);
    assert.deepEqual(s.pushed.map((x) => x.text), ["Письмо", "Без Telegram", "Сбой", "Сбой 2"]);
  } finally {
    await s.store.close();
  }
});

test("подписка: письмо о конце пробы идёт через Send — и в Web Push, и человеку без Telegram; кнопка оплаты — в Telegram", async () => {
  const s = await setup();
  try {
    await s.billing.expire(new Date(NOW.getTime() + 2 * 3600_000));
    for (const u of [s.withTg, s.webOnly]) {
      assert.equal((await s.store.user(u.id))!.plan, "free");
      assert.equal(s.pushed.filter((x) => x.user === u.id && /Пробная неделя закончилась/.test(x.text)).length, 1, "Web Push ушёл");
      const feed = await feedOf(s.store, u);
      assert.equal(feed.length, 1);
      assert.deepEqual([feed[0].kind, feed[0].buttons], ["other", ""], "вид other, кнопки-ссылки в ленте нет");
    }
    assert.equal(s.tg.length, 1, "в Telegram — только тому, у кого он привязан");
    assert.match(s.tg[0].text, /Пробная неделя закончилась/);
    assert.deepEqual(s.tg[0].buttons, [{ text: "Оформить ⭐150", data: "", url: "https://t.me/$inv1" }]);
    assert.ok(s.pushed.every((x) => !x.buttons?.length), "в push кнопки оплаты нет");
    // Знаки < > & в письме — экранированы (текст Send — HTML для Telegram).
    assert.deepEqual(await s.billing.notify(s.webOnly, "1 < 2 & 3", false), { feed: true, telegram: false });
    assert.equal(s.pushed.at(-1)?.text, "1 &lt; 2 &amp; 3");
  } finally {
    await s.store.close();
  }
});

test("ответ на обращение идёт через Send: Web Push уходит; Telegram не принял — «только в ленте», обращение не закрыто", async () => {
  let ok = false;
  const s = await setup(() => ok);
  try {
    const tell = (x: User, text: string) => s.billing.notify(x, text, false);
    const ids: number[] = [];
    for (let i = 0; i < 2; i++) ids.push((await createTicket(s.store, s.withTg, { topic: "payment", text: `вопрос ${i}` }, NOW)).id);
    const web = (await createTicket(s.store, s.webOnly, { topic: "bug", text: "с сайта" }, NOW)).id;

    const bad = await ticketAction({ store: s.store, tell }, 1, ids[0], "answer", { text: "Проверила", close: true, reason: "ответ" }, NOW);
    assert.deepEqual([bad.delivered, bad.status], ["feed_tg_failed", "work"]);
    ok = true;
    const good = await ticketAction({ store: s.store, tell }, 1, ids[1], "answer", { text: "Готово", close: true, reason: "ответ" }, NOW);
    assert.deepEqual([good.delivered, good.status], ["telegram", "closed"]);
    assert.ok(s.tg.at(-1)?.text.includes("Готово") && !s.tg.at(-1)?.buttons, "в Telegram без кнопки оплаты");
    const site = await ticketAction({ store: s.store, tell }, 1, web, "answer", { text: "Исправили", close: true, reason: "ответ" }, NOW);
    assert.deepEqual([site.delivered, site.status], ["feed", "closed"]);
    assert.deepEqual(s.pushed.map((x) => [x.user, /Проверила|Готово|Исправили/.exec(x.text)?.[0]]),
      [[s.withTg.id, "Проверила"], [s.withTg.id, "Готово"], [s.webOnly.id, "Исправили"]], "каждый ответ ушёл и в Web Push");
    assert.ok((await feedOf(s.store, s.webOnly)).some((n) => n.text.includes("Исправили") && n.kind === "other"));
  } finally {
    await s.store.close();
  }
});
