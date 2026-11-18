import assert from "node:assert/strict";
import { test } from "node:test";
import { linkDays } from "../src/ask.ts";
import { Store } from "../src/db.ts";
import type { ChatMessage, LlmCall } from "../src/llm.ts";
import { Pipeline } from "../src/pipeline.ts";
import { zonedToUtc } from "../src/time.ts";

// Ответ на вопрос по записям (pipeline.ts: answer; ask.ts: linkDays), 18.11.2026: на «Как я спал на этой неделе?» ответ
// оборвался на полуслове («…записано, что до половины»), про одну ночь было «среднее 10,5 ч», дни-кнопки шли 16, 18, 17.
// Теперь оборванный хвост отрезается до последнего законченного предложения, ответу дан запас длины (ANSWER_MAX_TOKENS),
// модели сказано не звать «средним» один день, кнопки дней — по дате.

const AT = zonedToUtc("2026-11-18", "23:51", "Europe/Moscow");

async function ask(reply: string) {
  const store = await Store.open(":memory:");
  const u = await store.ensureUser("100", "Тест", "Europe/Moscow");
  const calls: { messages: ChatMessage[]; maxTokens?: number }[] = [];
  const answers: unknown[] = [{ question: "как я спал на этой неделе?", lookup: { from: "2026-11-16", to: "2026-11-18" } }, reply];
  const llm: LlmCall = async (messages, opts) => {
    calls.push({ messages, maxTokens: opts?.maxTokens });
    const a = answers.shift();
    return typeof a === "string" ? a : JSON.stringify(a);
  };
  const r = await new Pipeline(store, llm).handle({ user: u, source: "telegram", sourceId: "q1", text: "Как я спал на этой неделе?", at: AT });
  await store.close();
  return { r, calls };
}

test("ответ оборвался на полуслове — остаются законченные предложения", async () => {
  const { r } = await ask("За 2026-11-17 вы спали 10,5 ч: легли в половину второго. Про 2026-11-18 записано, что до половины");
  assert.equal(r.text.split("\n")[0], "За 17 ноября вы спали 10,5 ч: легли в половину второго.");
  assert.deepEqual(r.days, ["2026-11-17"], "день из отрезанного хвоста — без кнопки");
});

test("законченный ответ не трогается", async () => {
  const { r } = await ask("Сон записан только за 2026-11-17 — 10,5 ч.");
  assert.equal(r.text.split("\n")[0], "Сон записан только за 17 ноября — 10,5 ч.");
});

test("кнопки дней — по дате, а не по порядку в тексте", () => {
  const { days } = linkDays("Было 2026-11-16, потом 2026-11-18, а ещё 2026-11-17.", "", "2026-11-18");
  assert.deepEqual(days, ["2026-11-16", "2026-11-17", "2026-11-18"]);
});

test("ответу — запас длины, а про один день — не «среднее»", async () => {
  const { calls } = await ask("Ок.");
  const answer = calls[1];
  assert.ok((answer.maxTokens ?? 0) >= 1500, `запас длины ответа: ${answer.maxTokens}`);
  assert.match(answer.messages[0].content, /за один день — не называй это средним/);
});
