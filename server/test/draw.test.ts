import { PGlite } from "@electric-sql/pglite";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApi } from "../src/api.ts";
import { config } from "../src/config.ts";
import { callDraw } from "../src/draw.ts";
import { hashPassword } from "../src/auth.ts";
import { Store } from "../src/db.ts";
import { PgDriver } from "../src/driver.ts";
import type { LlmCall } from "../src/llm.ts";
import { normalize } from "../src/parse.ts";
import { Pipeline } from "../src/pipeline.ts";
import { zonedToUtc } from "../src/time.ts";

// «Нарисуй …»: разбор отдаёт draw, рисовалка (здесь заглушка вместо RunPod) — картинку, она хранится и отдаётся по id.

const TZ = "Europe/Moscow";
const AT = zonedToUtc("2026-11-11", "20:00", TZ);
const BACKENDS: Record<string, () => Promise<Store>> = {
  sqlite: () => Store.open(":memory:"),
  postgres: async () => {
    const pg = new PGlite();
    return Store.over(new PgDriver(pg, (fn) => pg.transaction((tx) => fn(tx)), () => pg.close()));
  },
};
const PNG = Buffer.from("fake-picture").toString("base64");
const msg = (text: string, id: string) => ({ source: "app", sourceId: id, text, at: AT });

test("разбор: draw — описание по-английски и подпись, пустое описание — не рисовать", () => {
  const ctx = { today: "2026-11-11", now: "20:00", text: "нарисуй кота" };
  assert.deepEqual(normalize({ draw: { prompt: "  a cat in a hat  ", title: "Кот в шляпе" } }, ctx).draw, { prompt: "a cat in a hat", title: "Кот в шляпе" });
  assert.equal(normalize({ draw: { prompt: "   " } }, ctx).draw, null);
  assert.equal(normalize({ summary: "s" }, ctx).draw, null);
});

test("RunPod: runsync не дождался — спросить статус, картинку скачать в base64; FAILED — ошибка", async () => {
  const was = { fetch: globalThis.fetch, key: config.drawing.apiKey };
  const calls: string[] = [];
  let fail = false;
  config.drawing.apiKey = "test-key";
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    const json = (x: unknown) => new Response(JSON.stringify(x), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url.endsWith("/runsync")) {
      assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer test-key");
      assert.equal(JSON.parse(String(init?.body)).input.prompt, "a cat");
      return json({ id: "job1", status: "IN_PROGRESS" });
    }
    if (url.endsWith("/status/job1")) return json(fail ? { id: "job1", status: "FAILED", error: "nsfw" } : { id: "job1", status: "COMPLETED", output: { result: "https://image.runpod.ai/x/output.jpeg", cost: 0.005 } });
    return new Response(Buffer.from("fake-picture"), { status: 200, headers: { "Content-Type": "image/jpeg" } });
  }) as typeof fetch;
  try {
    assert.deepEqual(await callDraw("a cat"), { mime: "image/jpeg", data: PNG });
    assert.deepEqual(calls, [
      "POST https://api.runpod.ai/v2/z-image-turbo/runsync",
      "GET https://api.runpod.ai/v2/z-image-turbo/status/job1",
      "GET https://image.runpod.ai/x/output.jpeg",
    ]);
    fail = true;
    await assert.rejects(callDraw("a cat"), /FAILED nsfw/);
  } finally {
    globalThis.fetch = was.fetch;
    config.drawing.apiKey = was.key;
  }
});

for (const [kind, open] of Object.entries(BACKENDS)) {
  test(`${kind}: «нарисуй кота» — картинка в ответе, в базе и по /api/drawings/:id; без ключа и при сбое — словами`, async () => {
    const store = await open();
    const u = await store.ensureUser("100", "Тест", TZ);
    const other = await store.ensureUser("200", "Чужой", TZ);
    const answers: unknown[] = [
      { draw: { prompt: "a fluffy cat in a top hat, watercolor", title: "Кот в шляпе" }, reply: "Сейчас нарисую!", emotion: "happy" },
      { draw: { prompt: "a sunset", title: "Закат" } },
      { draw: { prompt: "a dog", title: "Собака" } },
    ];
    const llm: LlmCall = async () => JSON.stringify(answers.shift() ?? {});
    const pipe = new Pipeline(store, llm);
    const asked: string[] = [];
    pipe.draw = async (prompt) => (asked.push(prompt), { mime: "image/jpeg", data: PNG });

    const r = await pipe.handle({ user: u, ...msg("нарисуй кота в шляпе", "1") });
    assert.deepEqual(asked, ["a fluffy cat in a top hat, watercolor"]);
    assert.equal(r.text, "Сейчас нарисую!");
    assert.equal(r.emotion, "happy");
    assert.equal(r.undoable, false);
    assert.ok(r.drawing);
    assert.deepEqual({ ...r.drawing, id: 0 }, { id: 0, mime: "image/jpeg", data: PNG, title: "Кот в шляпе" });
    const row = await store.drawing(r.drawing.id);
    assert.equal(row?.user_id, u.id);
    assert.equal(row?.message_id, r.messageId);
    assert.equal(row?.prompt, "a fluffy cat in a top hat, watercolor");
    assert.equal((await store.message(r.messageId))?.state, "done");
    assert.equal((await store.diaryOf(u.id, "2026-11-11")).length, 0);

    // Сбой рисовалки — тревожный ответ без картинки, ничего не сохраняется.
    pipe.draw = async () => { throw new Error("RunPod 500"); };
    const bad = await pipe.handle({ user: u, ...msg("нарисуй закат", "2") });
    assert.equal(bad.drawing, undefined);
    assert.equal(bad.emotion, "worried");
    assert.match(bad.text, /Закат/);

    // Ключа нет — так и сказать.
    pipe.draw = null;
    const none = await pipe.handle({ user: u, ...msg("нарисуй собаку", "3") });
    assert.equal(none.drawing, undefined);
    assert.match(none.text, /RUNPOD_API_KEY/);

    await store.updateUser(u.id, { login: "owner", password_hash: await hashPassword("secret-pass-1") });
    await store.updateUser(other.id, { login: "other", password_hash: await hashPassword("secret-pass-2") });
    const server = createApi({ store, pipeline: pipe }).listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const tokenOf = async (login: string, password: string) =>
      ((await (await fetch(base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ login, password }) })).json()) as any).token as string;
    const get = (path: string, token: string) => fetch(base + path, { headers: { Authorization: `Bearer ${token}` } });
    try {
      const mine = await tokenOf("owner", "secret-pass-1");
      const got = await get(`/api/drawings/${r.drawing.id}`, mine);
      assert.equal(got.status, 200);
      assert.deepEqual(await got.json(), { id: r.drawing.id, mime: "image/jpeg", data: PNG, title: "Кот в шляпе", prompt: "a fluffy cat in a top hat, watercolor" });
      assert.equal((await get(`/api/drawings/${r.drawing.id + 99}`, mine)).status, 404);
      // Чужую картинку не отдать.
      assert.equal((await get(`/api/drawings/${r.drawing.id}`, await tokenOf("other", "secret-pass-2"))).status, 404);
    } finally {
      server.close();
      await store.close();
    }
  });
}
