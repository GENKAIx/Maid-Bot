import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApi } from "../src/api.ts";
import { hashPassword } from "../src/auth.ts";
import { Store, type User } from "../src/db.ts";
import type { ChatMessage, LlmCall } from "../src/llm.ts";
import * as webpush from "web-push";
import { PERSONAS } from "../src/personas.ts";
import { Pipeline } from "../src/pipeline.ts";
import { Push } from "../src/push.ts";
import { rateButtons, rateDay, Scheduler, type Button } from "../src/scheduler.ts";
import { zonedToUtc } from "../src/time.ts";

// Оценка дня под вечерним итогом: от 1 до 10 (в виджете — звёзды) → показатель «Оценка дня» (rating_day, /10), одна на день.

const DAY = "2026-11-14";
const TZ = "Europe/Moscow";

async function setup() {
  const store = await Store.open(":memory:");
  const u = await store.createUser({ login: "owner", passwordHash: await hashPassword("secret-pass-1"), tz: TZ });
  return { store, u };
}
const ratings = async (store: Store, userId: number, day = DAY) => (await store.metricsRange(userId, day, day, "rating_day")).map((m) => m.value);
/** Оценка дня словами в чате («оценка дня 7») — так её пишет разбор (pipeline.ts): новая строка, источник text. */
const typed = (store: Store, userId: number, value: number, day = DAY) =>
  store.addMetric({ user_id: userId, day_key: day, key: "rating_day", label: "Оценка дня", value, unit: "/10", note: "", source: "text", message_id: null });
/** Вечерний итог дня DAY, как его шлёт планировщик в 22:01: текст, кнопки и вид письма. */
async function evening(store: Store, u: User) {
  const sent: { text: string; buttons?: Button[]; kind?: string }[] = [];
  await new Scheduler(store, async () => "Хороший день.", async (_u, text, _e, buttons, kind) => void sent.push({ text, buttons, kind }))
    .tick(zonedToUtc(DAY, "22:01", TZ));
  const ev = sent.find((x) => /Итог дня/.test(x.text));
  assert.ok(ev, "итога нет");
  return ev;
}
/** Оценка дня так, как её выбирает сайт (web/src/dayrate.ts, dayFacts): первая подходящая строка из /api/metrics. */
const siteRating = async (store: Store, userId: number) =>
  (await store.metricsRange(userId, DAY, DAY)).find((x) => x.day_key === DAY && x.key === "rating_day")?.value;

test("оценка дня: десять кнопок от 1 до 10, нажатие пишет «Оценку дня», повторное — заменяет", async () => {
  const { store, u } = await setup();
  const b = rateButtons(DAY);
  assert.deepEqual(b.map((x) => x.text), ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
  assert.deepEqual([b[0].data, b[9].data], ["rate:2026-11-14:1", "rate:2026-11-14:10"]);
  assert.match(await rateDay(store, u, DAY, 4), /⭐ 4\/10/);
  assert.match(await rateDay(store, u, DAY, 9), /⭐ 9\/10/);
  assert.deepEqual(await ratings(store, u.id), [9]);
  const [m] = await store.metricsRange(u.id, DAY, DAY, "rating_day");
  assert.equal(m.label, "Оценка дня");
  assert.equal(m.unit, "/10");
  for (const bad of [0, 11, 5.5]) await assert.rejects(rateDay(store, u, DAY, bad));
});

test("оценка дня: вечерний итог уходит с кнопками, итог видит оценки прошлых дней", async () => {
  const { store, u } = await setup();
  await rateDay(store, u, "2026-11-12", 3);
  let seen: ChatMessage[] = [];
  const llm: LlmCall = async (m) => ((seen = m), "Хороший день.");
  const sent: { text: string; buttons?: Button[] }[] = [];
  const sch = new Scheduler(store, llm, async (_u, text, _e, buttons) => void sent.push({ text, buttons }));
  await sch.tick(zonedToUtc(DAY, "22:01", TZ));
  const ev = sent.find((x) => /Итог дня/.test(x.text));
  assert.ok(ev, "итога нет");
  assert.deepEqual(ev.buttons?.map((x) => x.data), rateButtons(DAY).map((x) => x.data));
  assert.match(ev.text, /\n\nНа сколько оцениваете этот день\?$/); // вопрос перед звёздами, голосом характера (строгая — на «вы»)
  assert.doesNotMatch(ev.text, /⭐ Оценка дня:/); // оценён только позавчерашний день — сегодняшний ещё спрашиваем
  assert.match(seen.map((m) => m.content).join("\n"), /2026-11-12 Оценка дня: 3\/10/);
});

test("оценка дня: день уже оценён (звёздами в виджете или словами в чате) — итог без кнопок, вместо вопроса «⭐ Оценка дня: 7/10»", async () => {
  for (const rate of [
    (store: Store, u: User) => rateDay(store, u, DAY, 7), // POST /api/rate и кнопка — источник evening
    (store: Store, u: User) => typed(store, u.id, 7), // «оценка дня 7» в чате — источник text
  ]) {
    const { store, u } = await setup();
    await rate(store, u);
    const ev = await evening(store, u);
    assert.equal(ev.buttons?.length ?? 0, 0, "кнопки оценки под уже оценённым днём");
    assert.match(ev.text, /\n\n⭐ Оценка дня: 7\/10$/);
    for (const p of Object.values(PERSONAS)) assert.ok(!ev.text.includes(p.rate), `вопрос «${p.rate}» под уже оценённым днём`);
    assert.equal(ev.kind, "evening"); // в «Истории» — по-прежнему вечерний итог
  }
});

test("оценка дня: несколько оценок за день — в итоге та же, что на сайте: первая по порядку базы, откуда бы ни была", async () => {
  // Сайт берёт первую строку rating_day за день из /api/metrics (по дню и номеру строки) — сверяем, что он так и делает.
  const site = readFileSync(new URL("../../web/src/dayrate.ts", import.meta.url), "utf8");
  assert.match(site, /metrics\.find\(\(x\) => x\.day_key === day && x\.key === key\)\?\.value/);
  assert.match(site, /rating: m\(day, "rating_day"\)/);
  const cases: { title: string; steps: (store: Store, u: User) => Promise<unknown>; want: number }[] = [
    { title: "сначала в чате 6, потом звёзды 9", steps: async (s, u) => { await typed(s, u.id, 6); await rateDay(s, u, DAY, 9); }, want: 6 },
    { title: "сначала звёзды 4, потом в чате 8", steps: async (s, u) => { await rateDay(s, u, DAY, 4); await typed(s, u.id, 8); }, want: 4 },
    // Повторное нажатие звезды меняет ту же строку — её место первой не меняется.
    { title: "звёзды 4, в чате 8, звёзды 5", steps: async (s, u) => { await rateDay(s, u, DAY, 4); await typed(s, u.id, 8); await rateDay(s, u, DAY, 5); }, want: 5 },
    { title: "в чате 3 и 8", steps: async (s, u) => { await typed(s, u.id, 3); await typed(s, u.id, 8); }, want: 3 },
    // Удалённая (в корзине) не в счёт ни на сайте, ни в итоге.
    { title: "в чате 2 (удалена), звёзды 9", steps: async (s, u) => { await s.setMetricDeleted(await typed(s, u.id, 2), true); await rateDay(s, u, DAY, 9); }, want: 9 },
  ];
  for (const c of cases) {
    const { store, u } = await setup();
    await c.steps(store, u);
    assert.equal(await siteRating(store, u.id), c.want, `сайт: ${c.title}`);
    const ev = await evening(store, u);
    assert.match(ev.text, new RegExp(`\\n\\n⭐ Оценка дня: ${c.want}/10$`), `итог: ${c.title}`);
    assert.equal(ev.buttons?.length ?? 0, 0, `итог: ${c.title}`);
  }
});

test("оценка дня: кнопка в виджете (/api/rate)", async () => {
  const { store, u } = await setup();
  const server = createApi({ store, pipeline: new Pipeline(store, async () => "{}") }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, body: unknown, token?: string) => {
    const r = await fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };
  try {
    const { json: { token } } = await call("/api/login", { login: "owner", password: "secret-pass-1" });
    const r = await call("/api/rate", { day: DAY, value: 5 }, token);
    assert.equal(r.status, 200);
    assert.match(r.json.text, /⭐ 5\/10/);
    assert.deepEqual(await ratings(store, u.id), [5]);
    assert.equal((await call("/api/rate", { day: DAY, value: 11 }, token)).status, 400);
    assert.equal((await call("/api/rate", { day: "вчера", value: 5 }, token)).status, 400);
    assert.equal((await call("/api/rate", { day: DAY, value: 5 })).status, 401);
  } finally {
    server.close();
  }
});

test("оценка дня: в push-уведомлении кнопок оценки нет — десять чисел туда не помещаются", async () => {
  const { store, u } = await setup();
  const push = new Push(store, { ...webpush.generateVAPIDKeys(), subject: "mailto:test@example.com" });
  const p = push.payload(u, "Итог дня\nСделано 4 из 5", rateButtons(DAY));
  assert.deepEqual(p.actions, []);
  assert.equal(p.act, "");
});
