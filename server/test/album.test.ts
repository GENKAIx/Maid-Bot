import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { ALBUM, albumOf, albumSee } from "../src/album.ts";
import { createApi } from "../src/api.ts";
import { hashPassword } from "../src/auth.ts";
import { Store } from "../src/db.ts";
import { Pipeline } from "../src/pipeline.ts";

// Альбом реакций: виджет шлёт имя анимации при первом показе, сайт читает, что открыто.

async function setup() {
  const store = await Store.open(":memory:");
  const u = await store.createUser({ login: "owner", passwordHash: await hashPassword("secret-pass-1"), tz: "Europe/Moscow" });
  return { store, u };
}

test("альбом: 41 анимация, увиденное открывается один раз и хранит дату первого показа", async () => {
  const { store, u } = await setup();
  assert.equal(ALBUM.length, 41);
  assert.equal(new Set(ALBUM).size, 41);
  assert.deepEqual(await albumOf(store, u.id), {});
  const first = await albumSee(store, u.id, ["tea", "forget"], new Date("2026-11-16T10:00:00Z"));
  assert.deepEqual(first.fresh, ["tea", "forget"]);
  const again = await albumSee(store, u.id, ["tea", "smitten"], new Date("2026-11-17T10:00:00Z"));
  assert.deepEqual(again.fresh, ["smitten"]);
  const seen = await albumOf(store, u.id);
  assert.equal(seen.tea, "2026-11-16T10:00:00.000Z");
  assert.equal(seen.smitten, "2026-11-17T10:00:00.000Z");
  assert.deepEqual(Object.keys(seen).sort(), ["forget", "smitten", "tea"]);
});

test("альбом: у каждого свой, чужое имя анимации не записывается", async () => {
  const { store, u } = await setup();
  const other = await store.createUser({ login: "guest", passwordHash: await hashPassword("secret-pass-2"), tz: "Europe/Moscow" });
  await albumSee(store, u.id, ["happy", "нет такой"]);
  assert.deepEqual(Object.keys(await albumOf(store, u.id)), ["happy"]);
  assert.deepEqual(await albumOf(store, other.id), {});
});

test("альбом: ручки /api/album", async () => {
  const { store, u } = await setup();
  const server = createApi({ store, pipeline: new Pipeline(store, async () => "{}") }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, token?: string) => {
    const r = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };
  try {
    const { json: { token } } = await call("POST", "/api/login", { login: "owner", password: "secret-pass-1" });
    const empty = await call("GET", "/api/album", undefined, token);
    assert.deepEqual(empty.json, { seen: {}, total: 41 });
    const r = await call("POST", "/api/album", { moods: ["idle", "hello"] }, token);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.fresh, ["idle", "hello"]);
    assert.deepEqual((await call("POST", "/api/album", { moods: ["idle"] }, token)).json.fresh, []);
    assert.deepEqual(Object.keys((await call("GET", "/api/album", undefined, token)).json.seen).sort(), ["hello", "idle"]);
    assert.deepEqual(Object.keys(await albumOf(store, u.id)).sort(), ["hello", "idle"]);
    assert.equal((await call("POST", "/api/album", { moods: ["dance"] }, token)).status, 400);
    assert.equal((await call("POST", "/api/album", { moods: [] }, token)).status, 400);
    assert.equal((await call("GET", "/api/album")).status, 401);
  } finally {
    server.close();
  }
});
