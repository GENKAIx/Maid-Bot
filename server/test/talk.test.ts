import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../src/db.ts";
import type { ChatMessage, LlmCall } from "../src/llm.ts";
import { buildPrompt } from "../src/parse.ts";
import { persona } from "../src/personas.ts";
import { Pipeline, TALK_RULES } from "../src/pipeline.ts";
import { zonedToUtc } from "../src/time.ts";

// Разговор (talk в разборе): с горничной разговаривают — ответ разговором (как /ask), записанное — строками под ним;
// обычная запись — одна короткая реплика без второго запроса к модели. Без сети: LLM подставная.

const TZ = "Europe/Moscow";
const AT = zonedToUtc("2026-11-08", "14:30", TZ);

async function setup(parse: unknown, chat: string | Error = "Поздравляю! Давно к этому шли? Как отметишь?") {
  const store = await Store.open(":memory:");
  const u = await store.ensureUser("100", "Тест", TZ);
  const calls: { kind?: string; messages: ChatMessage[] }[] = [];
  const llm: LlmCall = async (messages, opts) => {
    calls.push({ kind: opts?.kind, messages });
    if (opts?.kind === "parse") return JSON.stringify(parse);
    if (chat instanceof Error) throw chat;
    return chat;
  };
  return { store, u, calls, pipe: new Pipeline(store, llm) };
}
const msg = (text: string, id: string) => ({ source: "telegram", sourceId: id, text, at: AT });

test("с горничной разговаривают — ответ разговором, факты записаны и показаны под ответом", async () => {
  const { store, u, calls, pipe } = await setup({
    diary: [{ section: "notes", text: "повысили до тимлида" }], summary: "[14:30] Повысили до тимлида",
    talk: true, emotion: "happy", reply: "Ого, поздравляю.",
  });
  const r = await pipe.handle({ user: u, ...msg("Представляешь, меня повысили до тимлида!", "1") });
  assert.deepEqual(calls.map((c) => c.kind), ["parse", "chat"]);
  assert.match(r.text, /^Поздравляю! Давно к этому шли\? Как отметишь\?/);
  assert.ok(!r.text.includes("Ого, поздравляю."), "вместо разговора — короткая реплика");
  assert.ok((await store.diaryOf(u.id, "2026-11-08")).some((d) => d.text.includes("тимлид")), "факт из разговора не записан");
  assert.ok(r.undoable && r.text.split("\n").length > 1, "записанное не показано под ответом");
  assert.equal(r.emotion, "happy");
  const sys = String(calls[1].messages[0].content);
  assert.ok(sys.includes(TALK_RULES) && sys.includes(persona(u.persona).voice), "в разговоре нет правил разговора или голоса характера");
  assert.equal(calls[1].messages.at(-1)?.content, "Представляешь, меня повысили до тимлида!");
});

test("обычная запись — одна короткая реплика, без второго запроса", async () => {
  const { calls, u, pipe } = await setup({ diary: [{ section: "food", text: "каша" }], summary: "[14:30] Каша", talk: false, reply: "Записала кашу." });
  const r = await pipe.handle({ user: u, ...msg("Съел кашу", "2") });
  assert.deepEqual(calls.map((c) => c.kind), ["parse"]);
  assert.match(r.text, /^Записала кашу\./);
});

test("разбор без talk (старая модель не прислала) — как обычная запись", async () => {
  const { calls, u, pipe } = await setup({ summary: "[14:30] Привет", reply: "Привет!" });
  await pipe.handle({ user: u, ...msg("привет", "3") });
  assert.deepEqual(calls.map((c) => c.kind), ["parse"]);
});

test("разговор не удался — короткая реплика, сообщение не потеряно", async () => {
  const { store, u, pipe } = await setup({ summary: "[14:30] Грустно", talk: true, reply: "Обнимаю." }, new Error("сеть"));
  const r = await pipe.handle({ user: u, ...msg("что-то грустно сегодня", "4") });
  assert.match(r.text, /^Обнимаю\./);
  assert.equal((await store.recentMessages(u.id, 5)).at(-1)?.state, "done");
});

test("промпт разбора: talk описан, болтовня — talk", () => {
  const p = buildPrompt({ today: "2026-11-08", now: "14:30", tz: TZ, events: [], tasks: [], dates: [], memory: [], habits: [], recent: [] }, persona("kind").voice);
  assert.match(p, /"talk": true, если пользователь хочет поговорить с тобой/);
  assert.match(p, /talk true — с тобой разговаривают/);
  assert.match(p, /Только поболтать \(без фактов\) — всё пустое, кроме talk, reply и emotion/);
});
