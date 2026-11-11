import { PGlite } from "@electric-sql/pglite";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApi, usageReport } from "../src/api.ts";
import { hashPassword } from "../src/auth.ts";
import { config } from "../src/config.ts";
import { Store } from "../src/db.ts";
import { callOpenRouterDraw } from "../src/draw.ts";
import { PgDriver } from "../src/driver.ts";
import { callLlm, onLlmUsage, type LlmCall, type LlmUsage } from "../src/llm.ts";
import { Pipeline } from "../src/pipeline.ts";
import { transcribe } from "../src/voice.ts";

// Расход: каждый запрос к модели, картинка и голосовое — строка дня × назначения × модели, с деньгами, если провайдер их сообщил.

const BACKENDS: Record<string, () => Promise<Store>> = {
  sqlite: () => Store.open(":memory:"),
  postgres: async () => {
    const pg = new PGlite();
    return Store.over(new PgDriver(pg, (fn) => pg.transaction((tx) => fn(tx)), () => pg.close()));
  },
};

for (const [base, open] of Object.entries(BACKENDS)) {
  test(`${base}: расход складывается по дням, назначениям и моделям; старый месяц из kv прибавляется`, async () => {
    const store = await open();
    await store.kvSet("llm:2026-11", JSON.stringify({ calls: 5, input: 1000, output: 100 })); // как копилось до шага 11
    await store.addUsage(new Date("2026-11-03T10:00:00Z"), { kind: "parse", model: "m1", input: 1200, output: 300, cost: 0.0021 });
    await store.addUsage(new Date("2026-11-03T22:00:00Z"), { kind: "parse", model: "m1", input: 800, output: 100, cost: 0.0009 });
    await store.addUsage(new Date("2026-11-04T08:00:00Z"), { kind: "draw", model: "img", input: 0, output: 0, cost: 0.039 });
    await store.addUsage(new Date("2026-11-04T09:00:00Z"), { kind: "voice", model: "whisper", input: 0, output: 0, cost: null });
    await store.addUsage(new Date("2026-10-30T09:00:00Z"), { kind: "chat", model: "m1", input: 10, output: 10, cost: 0.5 });

    const rows = await store.usageDays("2026-11-01", "2026-11-30");
    assert.deepEqual(rows.map((r) => [r.day, r.kind, r.calls, r.input, r.output, r.priced]), [
      ["2026-11-03", "parse", 2, 2000, 400, 2],
      ["2026-11-04", "draw", 1, 0, 0, 1],
      ["2026-11-04", "voice", 1, 0, 0, 0],
    ]);
    assert.ok(Math.abs(rows[0].cost - 0.003) < 1e-9);
    const month = await store.llmUsage("2026-11");
    assert.deepEqual({ ...month, cost: Math.round(month.cost * 1e6) }, { calls: 9, input: 3000, output: 500, cost: 42000, priced: 3 });
    assert.deepEqual(await store.llmUsage("2026-09"), { calls: 0, input: 0, output: 0, cost: 0, priced: 0 });
    await store.close();
  });
}

test("отчёт расхода: все дни подряд, назначения и модели — дороже выше", () => {
  const r = usageReport([
    { day: "2026-11-10", kind: "parse", model: "m1", calls: 3, input: 3000, output: 600, cost: 0.01, priced: 3 },
    { day: "2026-11-11", kind: "draw", model: "img", calls: 1, input: 0, output: 0, cost: 0.04, priced: 1 },
    { day: "2026-11-11", kind: "parse", model: "m1", calls: 1, input: 900, output: 100, cost: 0.002, priced: 1 },
    { day: "2026-10-01", kind: "chat", model: "m1", calls: 9, input: 9, output: 9, cost: 9, priced: 9 }, // вне окна — не считается
  ], 7, { calls: 0, input: 0, output: 0, cost: 0, priced: 0 }, "2026-11-11");
  assert.equal(r.days.length, 7);
  assert.deepEqual([r.from, r.to], ["2026-11-05", "2026-11-11"]);
  assert.equal(r.days[0].calls, 0);
  assert.equal(r.days[6].calls, 2);
  assert.ok(Math.abs(r.days[6].kinds.draw - 0.04) < 1e-9);
  assert.deepEqual(r.kinds.map((k) => [k.kind, k.calls]), [["draw", 1], ["parse", 4]]);
  assert.deepEqual(r.models.map((k) => k.model), ["img", "m1"]);
  assert.equal(r.total.calls, 5);
});

/** Подменить fetch на время теста: отвечает answer(url), запоминает тела запросов; возвращает, что пришло в учёт. */
async function withFetch(answer: (url: string) => unknown, run: (bodies: any[]) => Promise<void>) {
  const real = globalThis.fetch;
  const bodies: any[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    bodies.push(typeof init?.body === "string" ? JSON.parse(init.body) : init?.body);
    return new Response(JSON.stringify(answer(String(url))), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const got: LlmUsage[] = [];
  onLlmUsage((u) => got.push(u));
  try { await run(bodies); } finally { globalThis.fetch = real; onLlmUsage(null); }
  return got;
}

test("модель через OpenRouter: просит цену, сообщает назначение, токены и доллары", async () => {
  const saved = { ...config.llm };
  Object.assign(config.llm, { baseUrl: "https://openrouter.ai/api/v1", apiKey: "k", model: "x/model" });
  try {
    let sent: any[] = [];
    const got = await withFetch(
      () => ({ choices: [{ message: { content: "ок" } }], usage: { prompt_tokens: 120, completion_tokens: 30, cost: 0.00042 } }),
      async (b) => { await callLlm([{ role: "user", content: "привет" }], { kind: "chat" }); sent = b; },
    );
    assert.deepEqual(sent[0].usage, { include: true });
    assert.deepEqual(got, [{ kind: "chat", model: "x/model", input: 120, output: 30, cost: 0.00042 }]);
    // Не OpenRouter: лишнего поля нет, цены нет, назначение по умолчанию — «другое».
    Object.assign(config.llm, { baseUrl: "https://api.openai.com/v1" });
    const got2 = await withFetch(
      () => ({ choices: [{ message: { content: "ок" } }], usage: { prompt_tokens: 5, completion_tokens: 1 } }),
      async (b) => { await callLlm([{ role: "user", content: "привет" }]); sent = b; },
    );
    assert.equal(sent[0].usage, undefined);
    assert.deepEqual(got2, [{ kind: "other", model: "x/model", input: 5, output: 1, cost: null }]);
  } finally {
    Object.assign(config.llm, saved);
  }
});

test("картинка OpenRouter и голосовое тоже считаются", async () => {
  const savedD = { ...config.drawing };
  const savedS = { ...config.stt };
  Object.assign(config.drawing, { openrouterKey: "k", openrouterModel: "google/img" });
  Object.assign(config.stt, { baseUrl: "https://openrouter.ai/api/v1", apiKey: "k", model: "openai/whisper-large-v3" });
  try {
    const got = await withFetch(
      (url) => url.includes("transcriptions")
        ? { text: "привет", usage: { input_tokens: 40, cost: 0.0003 } }
        : { choices: [{ message: { images: [{ image_url: { url: `data:image/png;base64,${Buffer.from("p").toString("base64")}` } }] } }], usage: { prompt_tokens: 20, completion_tokens: 1290, cost: 0.0387 } },
      async () => {
        await callOpenRouterDraw("a cat");
        assert.equal(await transcribe(Buffer.from("audio"), "audio/webm"), "привет");
      },
    );
    assert.deepEqual(got, [
      { kind: "draw", model: "google/img", input: 20, output: 1290, cost: 0.0387 },
      { kind: "voice", model: "openai/whisper-large-v3", input: 40, output: 0, cost: 0.0003 },
    ]);
  } finally {
    Object.assign(config.drawing, savedD);
    Object.assign(config.stt, savedS);
  }
});

test("разбор сообщения помечает запрос как «parse»", async () => {
  const store = await Store.open(":memory:");
  const u = await store.ensureUser("100", "Тест", "Europe/Moscow");
  const kinds: (string | undefined)[] = [];
  const llm: LlmCall = async (_m, o) => (kinds.push(o?.kind), JSON.stringify({ tasks: [{ title: "Купить хлеб" }], summary: "s" }));
  await new Pipeline(store, llm).handle({ user: u, source: "app", sourceId: "1", text: "купить хлеб", at: new Date("2026-11-11T12:00:00Z") });
  assert.deepEqual(kinds, ["parse"]);
});

test("/api/usage: дни, назначения, итог месяца; без входа — 401", async () => {
  const store = await Store.open(":memory:");
  const u = await store.ensureUser("100", "Тест", "Europe/Moscow");
  await store.updateUser(u.id, { login: "owner", password_hash: await hashPassword("secret-pass-1") });
  await store.addUsage(new Date(), { kind: "draw", model: "img", input: 0, output: 0, cost: 0.04 });
  const server = createApi({ store, pipeline: new Pipeline(store, async () => "{}") }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(base + "/api/usage")).status, 401);
    const login = await fetch(base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ login: "owner", password: "secret-pass-1" }) });
    const { token } = (await login.json()) as { token: string };
    const r = (await (await fetch(base + "/api/usage?days=14", { headers: { Authorization: `Bearer ${token}` } })).json()) as any;
    assert.equal(r.days.length, 14);
    assert.equal(r.days.at(-1).calls, 1);
    assert.deepEqual(r.kinds.map((k: any) => k.kind), ["draw"]);
    assert.ok(Math.abs(r.month.cost - 0.04) < 1e-9);
  } finally {
    server.close();
  }
});
