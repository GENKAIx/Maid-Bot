import assert from "node:assert/strict";
import { test } from "node:test";
import { todayJson } from "../src/api.ts";
import { Store } from "../src/db.ts";
import type { ChatMessage, LlmCall } from "../src/llm.ts";
import { Pipeline } from "../src/pipeline.ts";
import { DAY_START_HOUR, userDay, zonedToUtc } from "../src/time.ts";

// День человека начинается в DAY_START_HOUR (04:00): ночь — ещё вчера. Даты планов и разбор «завтра» — по календарю.

const TZ = "Europe/Moscow";
const NIGHT = zonedToUtc("2026-11-14", "01:30", TZ); // суббота, 01:30 — ещё пятница человека

test("userDay: до 04:00 — вчерашний день, с 04:00 — новый", () => {
  assert.equal(DAY_START_HOUR, 4);
  assert.equal(userDay(NIGHT, TZ), "2026-11-13");
  assert.equal(userDay(zonedToUtc("2026-11-14", "03:59", TZ), TZ), "2026-11-13");
  assert.equal(userDay(zonedToUtc("2026-11-14", "04:00", TZ), TZ), "2026-11-14");
  assert.equal(userDay(zonedToUtc("2026-11-13", "23:30", TZ), TZ), "2026-11-13");
});

test("ночью: «сегодня» в виджете — вчерашний день, планы субботы — впереди", async () => {
  const store = await Store.open(":memory:");
  const u = await store.ensureUser("100", "Тест", TZ);
  await store.addEvent({ user_id: u.id, title: "Пятница", date_iso: "2026-11-13", time: "23:00", end_time: null, details: "", domain: "", message_id: null });
  await store.addEvent({ user_id: u.id, title: "Суббота", date_iso: "2026-11-14", time: "22:00", end_time: null, details: "", domain: "", message_id: null });
  const t = await todayJson(store, u, NIGHT);
  assert.equal(t.day, "2026-11-13");
  assert.deepEqual(t.events.map((e) => e.title), ["Пятница"]);
  assert.ok(t.upcoming.some((e) => e.title === "Суббота"));
});

test("ночью: запись без даты — во вчерашний день, план «завтра» — по календарю", async () => {
  const store = await Store.open(":memory:");
  const u = await store.ensureUser("100", "Тест", TZ);
  const calls: ChatMessage[][] = [];
  const llm: LlmCall = async (messages) => {
    calls.push(messages);
    return JSON.stringify({
      diary: [{ section: "food", text: "пельмени" }],
      events: [{ title: "Встреча", date_iso: "2026-11-15", time: "15:00" }],
    });
  };
  await new Pipeline(store, llm).handle({ user: u, source: "telegram", sourceId: "1", text: "Съел пельмени, завтра в 15 встреча", at: NIGHT });
  assert.equal((await store.diaryOf(u.id, "2026-11-13")).filter((d) => d.section === "food").length, 1);
  assert.equal((await store.diaryOf(u.id, "2026-11-14")).length, 0);
  const prompt = calls[0].map((m) => m.content).join("\n");
  assert.match(prompt, /Сегодня 2026-11-14/); // календарь для дат
  assert.match(prompt, /его день — 2026-11-13/); // и подсказка про ночь
  assert.equal((await store.eventsBetween(u.id, "2026-11-15", "2026-11-15")).length, 1);
});
