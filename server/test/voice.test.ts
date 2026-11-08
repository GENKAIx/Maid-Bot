import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createApi } from "../src/api.ts";
import { hashPassword } from "../src/auth.ts";
import { config } from "../src/config.ts";
import { Store } from "../src/db.ts";
import type { LlmCall } from "../src/llm.ts";
import { Pipeline } from "../src/pipeline.ts";

// Голосовое из приложения: аудио уходит в /audio/transcriptions, услышанное — обычной записью, ответ с heard.

test("голосовое: распознаётся и записывается как текст", async () => {
  const got: { auth?: string; size: number; body: string }[] = [];
  const stt = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString("latin1");
    got.push({ auth: req.headers.authorization, size: body.length, body });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ text: req.url === "/v1/audio/transcriptions" ? "  купить хлеб  " : "" }));
  }).listen(0);
  const saved = { ...config.stt };
  Object.assign(config.stt, { baseUrl: `http://127.0.0.1:${(stt.address() as AddressInfo).port}/v1`, apiKey: "test-stt", model: "whisper-1" });

  const store = await Store.open(":memory:");
  const u = await store.ensureUser("100", "Тест", "Europe/Moscow");
  await store.updateUser(u.id, { login: "owner", password_hash: await hashPassword("secret-pass-1") });
  const seen: string[] = [];
  const llm: LlmCall = async (m) => (seen.push(m.at(-1)?.content ?? ""), JSON.stringify({ tasks: [{ title: "Купить хлеб" }], summary: "s" }));
  const server = createApi({ store, pipeline: new Pipeline(store, llm) }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (path: string, body: unknown, token?: string) => {
    const r = await fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json()) as any };
  };
  try {
    const { token } = (await post("/api/login", { login: "owner", password: "secret-pass-1" })).json;
    const audio = Buffer.alloc(40_000, 7).toString("base64");
    const r = await post("/api/voice", { audio, mime: "audio/webm;codecs=opus", id: "v1" }, token);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.heard, "купить хлеб");
    assert.equal(got[0].auth, "Bearer test-stt");
    assert.match(got[0].body, /name="model"\r\n\r\nwhisper-1/);
    assert.match(got[0].body, /filename="voice\.webm"/);
    assert.ok(got[0].size > 40_000);
    assert.ok(seen.some((t) => t.includes("купить хлеб")));
    assert.equal((await store.openTasks(u.id)).length, 1);

    assert.equal((await post("/api/voice", { audio, mime: "audio/webm" })).status, 401);
    const big = Buffer.alloc(5_100_000).toString("base64");
    assert.equal((await post("/api/voice", { audio: big, mime: "audio/webm" }, token)).status, 413);
    config.stt.baseUrl += "/nope";
    assert.equal((await post("/api/voice", { audio, mime: "audio/webm" }, token)).status, 422);
  } finally {
    Object.assign(config.stt, saved);
    server.close();
    stt.close();
    await store.close();
  }
});
