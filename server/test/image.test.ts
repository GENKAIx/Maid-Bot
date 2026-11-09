import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createApi } from "../src/api.ts";
import { hashPassword } from "../src/auth.ts";
import { config } from "../src/config.ts";
import { Store } from "../src/db.ts";
import { callLlm, type ChatMessage, type LlmCall } from "../src/llm.ts";
import { Pipeline } from "../src/pipeline.ts";

// Картинки: чек из приложения уходит модели вместе с подписью и записывается тратой.

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64").toString("base64");

async function setup(llm: LlmCall) {
  const store = await Store.open(":memory:");
  const u = await store.ensureUser("100", "Тест", "Europe/Moscow");
  await store.updateUser(u.id, { login: "owner", password_hash: await hashPassword("secret-pass-1") });
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
  const { token } = (await post("/api/login", { login: "owner", password: "secret-pass-1" })).json;
  return { store, u, server, post, token: token as string };
}

test("картинка: чек записывается тратой, подпись и картинка доходят до модели", async () => {
  const seen: ChatMessage[][] = [];
  const llm: LlmCall = async (m) => {
    seen.push(m);
    return JSON.stringify({
      money: [{ kind: "expense", amount: 1240, currency: "RUB", category: "продукты", note: "Пятёрочка: молоко, хлеб", day_iso: null }],
      summary: "чек из Пятёрочки на 1240",
      clarify: "А за что?",
    });
  };
  const { store, u, server, post, token } = await setup(llm);
  try {
    const r = await post("/api/input", { text: "ужин с Машей", image: { data: PNG, mime: "image/png" }, id: "i1" }, token);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const last = seen[0].at(-1)!;
    assert.equal(last.images?.length, 1);
    assert.equal(last.images?.[0].mime, "image/png");
    assert.equal(last.images?.[0].data, PNG);
    assert.match(last.content, /ужин с Машей[\s\S]*изображение/);
    // На картинку не переспрашивает — пишет, что разобрала.
    assert.ok(r.json.undoable);
    const money = await store.moneyRange(u.id, "2000-01-01", "2100-01-01");
    assert.equal(money.length, 1);
    assert.equal(money[0].amount, 1240);
    const msgs = await store.recentMessages(u.id, 5);
    assert.equal(msgs.at(-1)!.text, "📷 ужин с Машей");

    // Без подписи — тоже можно; без текста и картинки — нельзя; не картинка — нельзя.
    assert.equal((await post("/api/input", { image: { data: PNG, mime: "image/jpeg" }, id: "i2" }, token)).status, 200);
    assert.equal((await store.recentMessages(u.id, 5)).at(-1)!.text, "📷 Фото");
    assert.equal((await post("/api/input", { text: "" }, token)).status, 400);
    assert.equal((await post("/api/input", { image: { data: PNG, mime: "application/pdf" } }, token)).status, 400);
    // В истории следующего сообщения картинки уже нет — только подпись.
    await post("/api/input", { text: "купить хлеб", id: "t1" }, token);
    assert.ok(seen.at(-1)!.slice(0, -1).every((m) => !m.images));

    // Несколько картинок одним сообщением — все уходят модели, в истории «📷×N».
    const three = Array.from({ length: 3 }, () => ({ data: PNG, mime: "image/png" }));
    assert.equal((await post("/api/input", { text: "чеки за неделю", images: three, id: "m1" }, token)).status, 200);
    const multi = seen.at(-1)!.at(-1)!;
    assert.equal(multi.images?.length, 3);
    assert.match(multi.content, /изображений: 3/);
    assert.equal((await store.recentMessages(u.id, 10)).at(-1)!.text, "📷×3 чеки за неделю");
    // Больше шести — нельзя.
    const seven = Array.from({ length: 7 }, () => ({ data: PNG, mime: "image/png" }));
    assert.equal((await post("/api/input", { images: seven, id: "m2" }, token)).status, 400);
  } finally {
    server.close();
  }
});

test("картинка: уходит модели частями content в формате OpenAI", async () => {
  let body: any;
  const fake = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
  }).listen(0);
  const saved = { ...config.llm };
  Object.assign(config.llm, { baseUrl: `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1`, apiKey: "test", model: "m" });
  try {
    const pic = { mime: "image/png", data: PNG };
    assert.equal(await callLlm([{ role: "system", content: "s" }, { role: "user", content: "чеки", images: [pic, pic] }]), "ok");
    assert.equal(body.messages[0].content, "s");
    const part = { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } };
    assert.deepEqual(body.messages[1].content, [{ type: "text", text: "чеки" }, part, part]);
  } finally {
    Object.assign(config.llm, saved);
    fake.close();
  }
});
