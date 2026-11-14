import assert from "node:assert/strict";
import { test } from "node:test";
import { config } from "../src/config.ts";
import { activeModel, callLlm, LITE_MODEL, type LlmUsage, onLlmUsage, setLiteModel } from "../src/llm.ts";

// Дешёвая модель (/model у владельца): запросы уходят ей, расход пишется на неё; не ответила — отвечает основная.

/** Подменить fetch: fail(model) — отвечать ошибкой 400 этой модели; возвращает модели запросов и учёт. */
async function withModels(fail: (model: string) => boolean, run: () => Promise<void>) {
  const real = globalThis.fetch;
  const sent: string[] = [];
  const got: LlmUsage[] = [];
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    const model = JSON.parse(String(init?.body)).model as string;
    sent.push(model);
    if (fail(model)) return new Response("bad request", { status: 400 });
    return Response.json({ choices: [{ message: { content: `ответ ${model}` } }], usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.001 } });
  }) as typeof fetch;
  onLlmUsage((u) => got.push(u));
  try { await run(); } finally { globalThis.fetch = real; onLlmUsage(null); }
  return { sent, got };
}

const saved = { ...config.llm };
const setup = (baseUrl: string) => Object.assign(config.llm, { baseUrl, apiKey: "k", model: "anthropic/claude-sonnet-5.5" });
const restore = () => { Object.assign(config.llm, saved); setLiteModel(false); };

test("по умолчанию — основная модель; включили дешёвую — запрос и расход на неё", async () => {
  setup("https://openrouter.ai/api/v1");
  try {
    assert.equal(activeModel(), "anthropic/claude-sonnet-5.5");
    setLiteModel(true);
    assert.equal(activeModel(), LITE_MODEL);
    let text = "";
    const { sent, got } = await withModels(() => false, async () => { text = await callLlm([{ role: "user", content: "привет" }], { kind: "chat" }); });
    assert.equal(text, `ответ ${LITE_MODEL}`);
    assert.deepEqual(sent, [LITE_MODEL]);
    assert.deepEqual(got.map((u) => u.model), [LITE_MODEL]);
    setLiteModel(false);
    assert.equal(activeModel(), "anthropic/claude-sonnet-5.5");
  } finally { restore(); }
});

test("дешёвая не ответила — тот же запрос основной", async () => {
  setup("https://openrouter.ai/api/v1");
  setLiteModel(true);
  try {
    let text = "";
    const { sent } = await withModels((m) => m === LITE_MODEL, async () => { text = await callLlm([{ role: "user", content: "привет" }], { json: true }); });
    assert.deepEqual(sent, [LITE_MODEL, "anthropic/claude-sonnet-5.5"]);
    assert.equal(text, "ответ anthropic/claude-sonnet-5.5");
  } finally { restore(); }
});

test("основная тоже не ответила — ошибка, как раньше", async () => {
  setup("https://openrouter.ai/api/v1");
  setLiteModel(true);
  try {
    await withModels(() => true, async () => {
      await assert.rejects(callLlm([{ role: "user", content: "привет" }]), /LLM 400/);
    });
  } finally { restore(); }
});

test("не через OpenRouter дешёвая не включается (идентификатор его)", async () => {
  setup("https://api.openai.com/v1");
  setLiteModel(true);
  try {
    assert.equal(activeModel(), "anthropic/claude-sonnet-5.5");
    const { sent } = await withModels(() => false, async () => { await callLlm([{ role: "user", content: "привет" }]); });
    assert.deepEqual(sent, ["anthropic/claude-sonnet-5.5"]);
  } finally { restore(); }
});
