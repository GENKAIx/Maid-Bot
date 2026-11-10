import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApi } from "../src/api.ts";
import { hashPassword, LOGIN_MAX_FAILS, LOGIN_WINDOW_MS, LoginGate, SESSION_IDLE_DAYS, tokenHash, userByToken } from "../src/auth.ts";
import { Store } from "../src/db.ts";
import type { LlmCall } from "../src/llm.ts";
import { Pipeline } from "../src/pipeline.ts";

// Защита входа: подбор пароля, срок неиспользуемых входов, выход на другом устройстве.

test("подбор пароля: после 5 неудач вход закрыт на 15 минут, верный пароль тоже не пускает; потом снова можно", async () => {
  let t = 1_000_000;
  const gate = new LoginGate(() => t);
  const store = await Store.open(":memory:");
  const u = await store.ensureUser("1", "", "Europe/Moscow");
  await store.updateUser(u.id, { login: "owner", password_hash: await hashPassword("secret-pass-1") });
  const llm: LlmCall = async () => "{}";
  const server = createApi({ store, pipeline: new Pipeline(store, llm), loginGate: gate }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = (password: string, name = "owner") =>
    fetch(base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ login: name, password }) }).then((r) => r.status);
  try {
    for (let i = 0; i < LOGIN_MAX_FAILS; i++) assert.equal(await login("wrong"), 401);
    assert.equal(await login("secret-pass-1"), 429);
    t += LOGIN_WINDOW_MS + 1;
    assert.equal(await login("secret-pass-1"), 200);
    // Удачный вход сбросил счёт: снова 4 ошибки не закрывают.
    for (let i = 0; i < LOGIN_MAX_FAILS - 1; i++) assert.equal(await login("wrong"), 401);
    assert.equal(await login("secret-pass-1"), 200);
  } finally {
    server.close();
    await store.close();
  }
});

test("подбор с разных адресов: логин закрывается после удвоенного числа неудач", () => {
  const gate = new LoginGate(() => 0);
  for (let i = 0; i < LOGIN_MAX_FAILS * 2; i++) gate.failed(`10.0.0.${i}`, "Owner");
  assert.ok(gate.wait("10.9.9.9", "owner") > 0);
  assert.equal(gate.wait("10.9.9.9", "other"), 0);
});

test("вход, которым не пользовались 90 дней, перестаёт действовать; другое устройство можно выключить", async () => {
  const store = await Store.open(":memory:");
  const u = await store.ensureUser("1", "", "Europe/Moscow");
  await store.addSession(tokenHash("phone"), u.id, "iPhone");
  await store.addSession(tokenHash("pc"), u.id, "ПК");
  const old = new Date(Date.now() - (SESSION_IDLE_DAYS + 1) * 86_400_000).toISOString();
  await (store as any).run("UPDATE sessions SET last_seen = ? WHERE token_hash = ?", old, tokenHash("phone"));
  assert.equal(await userByToken(store, "phone"), undefined);
  assert.ok(await userByToken(store, "pc"));
  assert.deepEqual((await store.sessionsOf(u.id)).map((s) => s.label), ["ПК"]);

  await store.addSession(tokenHash("laptop"), u.id, "Ноутбук");
  const llm: LlmCall = async () => "{}";
  const server = createApi({ store, pipeline: new Pipeline(store, llm) }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, token: string, body?: unknown) =>
    fetch(base + path, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined })
      .then(async (r) => ({ status: r.status, json: (await r.json()) as any }));
  try {
    const me = (await call("/api/me", "pc")).json;
    assert.deepEqual(me.sessions.map((s: any) => [s.label, s.current]).sort(), [["Ноутбук", false], ["ПК", true]]);
    const laptop = me.sessions.find((s: any) => s.label === "Ноутбук").id;
    assert.equal((await call("/api/sessions/drop", "pc", { id: laptop })).status, 200);
    assert.equal((await call("/api/me", "laptop")).status, 401);
    assert.equal((await call("/api/me", "pc")).status, 200);
    assert.equal((await call("/api/sessions/drop", "pc", { id: "0".repeat(16) })).status, 404);
  } finally {
    server.close();
    await store.close();
  }
});
