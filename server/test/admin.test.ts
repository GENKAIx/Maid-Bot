import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import crypto from "node:crypto";
import { ADMIN_CODE_TRIES, ADMIN_PASS_MS } from "../src/admin.ts";
import { createApi, pageCsp } from "../src/api.ts";
import { hashPassword } from "../src/auth.ts";
import { config } from "../src/config.ts";
import { Store } from "../src/db.ts";
import { Pipeline } from "../src/pipeline.ts";

// Админка: каркас и доступ (24.11.2026, docs/review/админка-2026-11-24.html). Тем же путём, что сайт: /api/login → ключ →
// /api/me (admin) → /api/admin/state → /api/admin/code (код уходит в «Telegram» — здесь в массив) → /api/admin/confirm → данные.

const OWNER = "1001", FRIEND = "2002";

async function stand(opts: { admins?: string[]; telegram?: boolean } = {}) {
  config.allowedChatIds.splice(0, Infinity, OWNER, FRIEND);
  config.adminChatIds.splice(0, Infinity, ...(opts.admins ?? []));
  config.desktopToken = "desk-test-key";
  const store = await Store.open(":memory:");
  await store.createUser({ login: "owner", passwordHash: await hashPassword("owner-pass-1"), tz: "Europe/Moscow", chatId: OWNER, name: "Хозяин" });
  await store.createUser({ login: "friend", passwordHash: await hashPassword("friend-pass-1"), tz: "Europe/Moscow", chatId: FRIEND });
  const codes: string[] = [];
  const adminCode = opts.telegram === false ? undefined : async (_u: unknown, text: string) => void codes.push(text.match(/\d{6}/)![0]);
  const server = createApi({ store, pipeline: new Pipeline(store, async () => "{}"), adminCode }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (p: string, token: string, body?: unknown) => {
    const r = await fetch(base + p, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  };
  const login = async (l: string, pw: string) => (await (await fetch(base + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: l, password: pw }) })).json()).token as string;
  return { store, codes, call, login, close: async () => { server.close(); await store.close(); } };
}

test("админка: не админ, ключ ПК — 404 и admin=false; админ — признан, но без кода данных нет", async () => {
  const s = await stand();
  try {
    const owner = await s.login("owner", "owner-pass-1");
    const friend = await s.login("friend", "friend-pass-1");
    // Пусто ADMIN_CHAT_IDS — админ только первый из ALLOWED_CHAT_IDS, а не все.
    assert.equal((await s.call("/api/me", owner)).body.admin, true);
    assert.equal((await s.call("/api/me", friend)).body.admin, false);
    assert.equal((await s.call("/api/me", "desk-test-key")).body.admin, false, "DESKTOP_TOKEN — тот же владелец, но не админ");
    for (const p of ["/api/admin/state", "/api/admin/overview", "/api/admin/log", "/api/admin/whatever"]) {
      assert.equal((await s.call(p, friend)).status, 404, `друг: ${p}`);
      assert.equal((await s.call(p, "desk-test-key")).status, 404, `ключ ПК: ${p}`);
    }
    assert.equal((await s.call("/api/admin/code", friend, {})).status, 404);
    assert.equal((await s.call("/api/admin/state", owner)).body.until, null);
    assert.equal((await s.call("/api/admin/overview", owner)).status, 403, "без кода — нет данных");
    assert.equal((await s.call("/api/admin/log", owner)).status, 403);
  } finally {
    await s.close();
  }
});

test("админка: ADMIN_CHAT_IDS решает, кто админ", async () => {
  const s = await stand({ admins: [FRIEND] });
  try {
    assert.equal((await s.call("/api/me", await s.login("owner", "owner-pass-1"))).body.admin, false);
    assert.equal((await s.call("/api/me", await s.login("friend", "friend-pass-1"))).body.admin, true);
  } finally {
    await s.close();
  }
});

test("админка: код из Telegram → вход на час, только на этом устройстве; журнал; выход", async () => {
  const s = await stand();
  try {
    const owner = await s.login("owner", "owner-pass-1");
    const other = await s.login("owner", "owner-pass-1"); // второе устройство владельца
    assert.equal((await s.call("/api/admin/confirm", owner, { code: "123456" })).status, 400, "без запроса кода");
    assert.equal((await s.call("/api/admin/code", owner, {})).status, 200);
    assert.equal(s.codes.length, 1);
    assert.equal((await s.call("/api/admin/code", owner, {})).status, 429, "второй код сразу — нельзя");
    const wrong = s.codes[0] === "000000" ? "000001" : "000000";
    const bad = await s.call("/api/admin/confirm", owner, { code: wrong });
    assert.equal(bad.status, 400);
    assert.match(String(bad.body.error), /осталось попыток: 4/);
    const ok = await s.call("/api/admin/confirm", owner, { code: s.codes[0] });
    assert.equal(ok.status, 200);
    const until = Date.parse(String(ok.body.until)) - Date.now();
    assert.ok(until > ADMIN_PASS_MS - 60_000 && until <= ADMIN_PASS_MS, "вход на час");
    assert.equal((await s.call("/api/admin/confirm", owner, { code: s.codes[0] })).status, 400, "код одноразовый");
    const ov = await s.call("/api/admin/overview", owner);
    assert.equal(ov.status, 200);
    assert.equal(ov.body.users, 2);
    assert.equal(ov.body.new_week, 2);
    assert.equal((ov.body.online as { total: number }).total, 1, "этап 2: онлайн — владелец (два его входа — один человек)");
    for (const p of ["/api/admin/users", "/api/admin/spend?days=7", "/api/admin/audience", "/api/admin/quality?days=7", "/api/admin/health"]) {
      const r = await s.call(p, owner);
      assert.equal(r.status, 200, p);
      assert.equal((await s.call(p, other)).status, 403, `${p}: другое устройство без кода`);
      const json = JSON.stringify(r.body);
      for (const f of ["text", "reply", "prompt", "chat_id", "password_hash"]) assert.ok(!json.includes(`"${f}"`), `поле ${f} в ${p}`);
    }
    // Форма ответов этапа 2 — те поля, которые читает сайт (web/src/screens/AdminSections.tsx: Health, Audience, SpendReport, Overview).
    const keys = async (p: string, want: string[]) => {
      const body = (await s.call(p, owner)).body;
      for (const k of want) assert.ok(k in body, `${p}: нет поля ${k}`);
      return body;
    };
    const h = await keys("/api/admin/health", ["kinds", "errors", "models", "messages", "reminders", "uptime_sec", "version", "built_at"]);
    for (const k of ["kinds", "errors", "models"]) assert.ok(Array.isArray(h[k]), `health.${k} — список`);
    assert.deepEqual(Object.keys(h.messages as object).sort(), ["clarify", "failed", "failed24"]);
    assert.deepEqual(Object.keys(h.reminders as object).sort(), ["n", "oldest"]);
    const aud = await keys("/api/admin/audience", ["heat", "versions", "clients"]);
    assert.equal((aud.heat as unknown[]).length, 7);
    for (const k of ["versions", "clients"]) assert.ok(Array.isArray(aud[k]), `audience.${k} — список`);
    const sp = await keys("/api/admin/spend?days=7", ["heavy", "routes"]);
    for (const k of ["heavy", "routes"]) assert.ok(Array.isArray(sp[k]), `spend.${k} — список`);
    assert.ok(Array.isArray((ov.body.online as { clients: unknown }).clients), "overview.online.clients — список");
    assert.equal((await s.call("/api/admin/overview", other)).status, 403, "другое устройство — свой код");
    const log = await s.call("/api/admin/log", owner);
    assert.deepEqual((log.body as unknown as { action: string; who: string }[]).map((r) => `${r.who}:${r.action}`), ["Хозяин:enter", "Хозяин:wrong", "Хозяин:code"]);
    // В ответах админки нет текстов пользователей и chat id.
    for (const body of [ov.body, log.body, (await s.call("/api/admin/state", owner)).body]) {
      const json = JSON.stringify(body);
      for (const f of ["text", "reply", "prompt", "apps_json", "games_json", "note", "chat_id", "password_hash"]) assert.ok(!json.includes(`"${f}"`), `поле ${f} в ответе админки`);
      assert.ok(!json.includes(OWNER), "chat id в ответе админки");
    }
    assert.equal((await s.call("/api/admin/leave", owner, {})).status, 200);
    assert.equal((await s.call("/api/admin/overview", owner)).status, 403, "вышли из админки");
  } finally {
    await s.close();
  }
});

test("админка: код сгорает после неверных попыток и по сроку; без бота — 503", async () => {
  const s = await stand();
  try {
    const owner = await s.login("owner", "owner-pass-1");
    await s.call("/api/admin/code", owner, {});
    const wrong = s.codes[0] === "000000" ? "000001" : "000000";
    for (let i = 1; i < ADMIN_CODE_TRIES; i++) assert.equal((await s.call("/api/admin/confirm", owner, { code: wrong })).status, 400);
    assert.match(String((await s.call("/api/admin/confirm", owner, { code: wrong })).body.error), /слишком много попыток/);
    assert.equal((await s.call("/api/admin/confirm", owner, { code: s.codes[0] })).status, 400, "после блокировки верный код уже не действует");
    // Срок: подвинуть время кода в прошлое.
    const sid = crypto.createHash("sha256").update(owner).digest("hex").slice(0, 16);
    await s.store.kvSet(`admin:code:${sid}`, JSON.stringify({ hash: "00", exp: Date.now() - 1, sent: 0, tries: 0 }));
    assert.match(String((await s.call("/api/admin/confirm", owner, { code: "123456" })).body.error), /устарел/);
    // Вход в админку истёк — снова 403.
    await s.store.kvSet(`admin:pass:${sid}`, new Date(Date.now() - 1000).toISOString());
    assert.equal((await s.call("/api/admin/overview", owner)).status, 403);
  } finally {
    await s.close();
  }
  const t = await stand({ telegram: false });
  try {
    assert.equal((await t.call("/api/admin/code", await t.login("owner", "owner-pass-1"), {})).status, 503);
  } finally {
    await t.close();
  }
});

test("страница сайта: Content-Security-Policy со своим встроенным скриптом по хешу, без чужих адресов", async () => {
  const html = `<!doctype html><script>var a=1;</script><script type="module" src="/assets/x.js"></script>`;
  const csp = pageCsp(html);
  const hash = crypto.createHash("sha256").update("var a=1;").digest("base64");
  assert.ok(csp.includes(`script-src 'self' 'sha256-${hash}'`), csp);
  assert.ok(csp.includes("connect-src 'self'") && csp.includes("object-src 'none'"));
  assert.ok(!/https?:/.test(csp), "чужие адреса в политике");
  // Сервер отдаёт её с index.html (и на адресах экранов, например /admin).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maid-csp-"));
  fs.writeFileSync(path.join(dir, "index.html"), html);
  const store = await Store.open(":memory:");
  const server = createApi({ store, pipeline: new Pipeline(store, async () => "{}"), webDir: dir }).listen(0);
  try {
    const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/admin`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-security-policy"), csp);
    assert.equal(await r.text(), html);
  } finally {
    server.close();
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
