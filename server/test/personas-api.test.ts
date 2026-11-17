import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApi } from "../src/api.ts";
import { hashPassword } from "../src/auth.ts";
import { Store } from "../src/db.ts";
import { PERSONAS } from "../src/personas.ts";
import { Pipeline } from "../src/pipeline.ts";

// Характер горничной на сайте (страница «Горничная», 17.11.2026): список характеров с примером фраз (GET /api/personas)
// и смена характера (POST /api/settings). Раньше характер выбирался только в Telegram (/persona), а настройка принимала
// любую строку — опечатка тихо превращала горничную в строгую.

test("характеры: список с примерами, смена на сайте, неизвестный — 400", async () => {
  const store = await Store.open(":memory:");
  await store.createUser({ login: "owner", passwordHash: await hashPassword("secret-pass-1"), tz: "Europe/Moscow" });
  const server = createApi({ store, pipeline: new Pipeline(store, async () => "{}") }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, body?: unknown, token?: string) => {
    const r = await fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };
  try {
    const { json: { token } } = await call("/api/login", { login: "owner", password: "secret-pass-1" });
    const list = (await call("/api/personas", undefined, token)).json;
    assert.deepEqual(list.map((p: any) => p.id), Object.keys(PERSONAS));
    for (const p of list) {
      assert.ok(p.name, `нет названия у ${p.id}`);
      assert.ok(p.samples.length >= 2, `нет примеров фраз у ${p.id}`);
      assert.equal(p.voice, undefined, "промпт характера наружу не отдаётся");
    }
    assert.equal((await call("/api/personas")).status, 401);

    const me = (await call("/api/settings", { persona: "sassy" }, token)).json;
    assert.equal(me.persona, "sassy");
    assert.equal((await call("/api/me", undefined, token)).json.persona, "sassy");
    assert.equal((await call("/api/settings", { persona: "нет-такого" }, token)).status, 400);
    assert.equal((await call("/api/me", undefined, token)).json.persona, "sassy", "неизвестный характер всё же записался");
  } finally {
    server.close();
    await store.close();
  }
});
