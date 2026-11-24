import { PGlite } from "@electric-sql/pglite";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApi } from "../src/api.ts";
import { hashPassword } from "../src/auth.ts";
import { config } from "../src/config.ts";
import { Store } from "../src/db.ts";
import { PgDriver } from "../src/driver.ts";
import { callLlm, httpError, type LlmCall } from "../src/llm.ts";
import { CHAT_FAILED, Pipeline } from "../src/pipeline.ts";

// Тело ответа провайдера (модель, голос) не попадает ни в messages.reply, ни в ответы API: там код сбоя или своя фраза.

const SECRET = "SECRET-provider-body-7f3a";
const BACKENDS: Record<string, () => Promise<Store>> = {
  sqlite: () => Store.open(":memory:"),
  postgres: async () => {
    const pg = new PGlite();
    return Store.over(new PgDriver(pg, (fn) => pg.transaction((tx) => fn(tx)), () => pg.close()));
  },
};
const replies = (store: Store) =>
  (store as any).all("SELECT id, state, reply FROM messages ORDER BY id") as Promise<{ id: number; state: string; reply: string | null }[]>;

test("провайдер отвечает ошибкой с телом: в базе и в ответах API — только код", async () => {
  // Подставной провайдер: модель и распознавание отвечают 400 с «секретным» телом.
  const fake = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => { res.statusCode = 400; res.end(`{"error":"${SECRET}"}`); });
  }).listen(0);
  const url = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1`;
  const savedLlm = { ...config.llm };
  const savedStt = { ...config.stt };
  Object.assign(config.llm, { baseUrl: url, apiKey: "test-llm", model: "test-model" });
  Object.assign(config.stt, { baseUrl: url, apiKey: "test-stt", model: "whisper-1" });
  const errs: unknown[] = [];
  const quiet = console.error;
  console.error = (...a: unknown[]) => void errs.push(a);

  const store = await Store.open(":memory:");
  const u = await store.ensureUser("100", "Тест", "Europe/Moscow");
  await store.updateUser(u.id, { login: "owner", password_hash: await hashPassword("secret-pass-1") });
  const pipeline = new Pipeline(store, callLlm);
  const server = createApi({ store, pipeline }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (path: string, body: unknown, token?: string) => {
    const r = await fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: r.status, text: await r.text() };
  };
  try {
    const { token } = JSON.parse((await post("/api/login", { login: "owner", password: "secret-pass-1" })).text);
    const parse = await post("/api/input", { text: "купить хлеб", id: "p1" }, token);
    const chat = await post("/api/input", { text: "как дела?", ask: true, id: "c1" }, token);
    const voice = await post("/api/voice", { audio: Buffer.alloc(2000, 7).toString("base64"), mime: "audio/webm", id: "v1" }, token);
    for (const r of [parse, chat, voice]) assert.ok(!r.text.includes(SECRET), r.text);
    assert.equal(JSON.parse(parse.text).failed, true);
    assert.equal(voice.status, 502);
    assert.match(JSON.parse(voice.text).error, /^не получилось распознать голос \(http_4xx\)/);

    const rows = await replies(store);
    assert.deepEqual(rows.map((r) => [r.state, r.reply]), [["failed", "http_4xx"], ["failed", `${CHAT_FAILED}http_4xx`]]);
    const again = await post(`/api/messages/${rows[0].id}/retry`, {}, token);
    assert.ok(!again.text.includes(SECRET), again.text);
    assert.ok(!JSON.stringify(await replies(store)).includes(SECRET));
    // Журнал сервера тело видит — так и задумано (console.error).
    assert.ok(errs.some((a) => (a as unknown[]).some((x) => String(x).includes(SECRET))));
  } finally {
    console.error = quiet;
    Object.assign(config.llm, savedLlm);
    Object.assign(config.stt, savedStt);
    server.close();
    fake.close();
    await store.close();
  }
});

test("фоновый повтор: упавший разбор с кодом повторяется, упавший разговор (chat:) — нет", async () => {
  const store = await Store.open(":memory:");
  const u = await store.ensureUser("100", "Тест", "Europe/Moscow");
  const llm: LlmCall = async () => { throw httpError(400, SECRET, true); };
  const pipe = new Pipeline(store, llm);
  const at = new Date("2026-11-24T10:00:00Z");
  const quiet = console.error;
  console.error = () => {};
  try {
    const p = await pipe.handle({ user: u, source: "web", sourceId: "p1", text: "купить хлеб", at });
    const c = await pipe.handle({ user: u, source: "web", sourceId: "c1", text: "как дела?", chatOnly: true, at });
    assert.equal(p.failed, true);
    await pipe.retryFailed(async () => {}, new Date(at.getTime() + 3 * 60_000));
    assert.equal(await store.kvGet(`retry:${p.messageId}`), "1");
    assert.equal(await store.kvGet(`retry:${c.messageId}`), undefined);
    assert.ok(!JSON.stringify(await replies(store)).includes(SECRET));
  } finally {
    console.error = quiet;
    await store.close();
  }
});

for (const [kind, open] of Object.entries(BACKENDS)) {
  test(`${kind}: шаг 25 стирает старые тексты ошибок у упавших сообщений, признак chat: остаётся`, async () => {
    const store = await open();
    const u = await store.ensureUser("1", "Тест", "Europe/Moscow");
    const add = async (id: string, state: string, reply: string) => {
      const { message } = await store.saveMessage({ userId: u.id, source: "web", sourceId: id, text: "т", dayKey: "2026-11-24" });
      await store.setMessage(message.id, { state, reply } as any);
    };
    await add("a", "failed", `Error: LLM 400: ${SECRET}`);
    await add("b", "failed", `${CHAT_FAILED}Error: LLM 400: ${SECRET}`);
    await add("c", "done", "Записала.");
    // Столбцы шага 27 (платный доступ) — убрать: миграция с шага 24 добавит их снова.
    await store.driver.exec("ALTER TABLE users DROP COLUMN plan; ALTER TABLE users DROP COLUMN access_until; ALTER TABLE users DROP COLUMN tg_user_id; ALTER TABLE users DROP COLUMN sub_charge_id; ALTER TABLE users DROP COLUMN sub_canceled; ALTER TABLE users DROP COLUMN trial_len_days;");
    await store.kvSet("schema_version", "24");
    const again = await Store.over(store.driver);
    assert.equal(await again.kvGet("schema_version"), "31");
    assert.deepEqual((await replies(again)).map((r) => r.reply), ["other", `${CHAT_FAILED}other`, "Записала."]);
    await again.close();
  });
}
