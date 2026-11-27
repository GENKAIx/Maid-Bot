import { PGlite } from "@electric-sql/pglite";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { AiGate } from "../src/access.ts";
import { cachedAnalytics, parseAnalyticsQuery, resetAnalyticsCache } from "../src/admin-analytics.ts";
import { adminAudience, adminOverview, adminSpend, adminUsers } from "../src/admin-stats.ts";
import { TEST_ACCOUNTS_MAX, TEST_TOKEN_LABEL, testAccountAction } from "../src/admin-tests.ts";
import { createApi } from "../src/api.ts";
import { hashPassword, isAdmin, tokenHash } from "../src/auth.ts";
import { config } from "../src/config.ts";
import { Store } from "../src/db.ts";
import { PgDriver } from "../src/driver.ts";
import type { LlmCall } from "../src/llm.ts";
import { Pipeline } from "../src/pipeline.ts";
import { releaseCrashes, type Release } from "../src/releases.ts";
import { Scheduler } from "../src/scheduler.ts";
import { dayKey, zonedToUtc } from "../src/time.ts";

// Тестовые аккаунты (admin-tests.ts, шаг 41 users.is_test): создать из админки, ключ для программы на ПК, сбросить к чистому —
// тем же путём, что кнопки админки (вход → код из «Telegram» → /api/admin/tests…). Тестовый — не админ и не в счёте людей,
// регистраций, планов, аналитики и падений выпуска; расход ИИ — отдельной строкой «тесты»; утро с моделью — только при входе за сутки.

const OWNER = "1001";
const TZ = "Europe/Moscow";
const DAY = 86_400_000;

const BACKENDS: Record<string, () => Promise<Store>> = {
  sqlite: () => Store.open(":memory:"),
  postgres: async () => {
    const pg = new PGlite();
    return Store.over(new PgDriver(pg, (fn) => pg.transaction((tx) => fn(tx)), () => pg.close()));
  },
};

async function stand(open: () => Promise<Store> = BACKENDS.sqlite) {
  config.allowedChatIds.splice(0, Infinity, OWNER);
  config.adminChatIds.splice(0, Infinity);
  const store = await open();
  const owner = await store.createUser({ login: "owner", passwordHash: await hashPassword("owner-pass-1"), tz: TZ, chatId: OWNER, name: "Хозяин" });
  const anya = await store.createUser({ login: "anya", passwordHash: await hashPassword("anya-pass-1"), tz: TZ, chatId: "11", name: "Аня", plan: "trial", accessUntil: new Date(Date.now() + 2 * DAY).toISOString(), trialLenDays: 7 });
  const codes: string[] = [];
  const pipeline = new Pipeline(store, async () => "{}");
  pipeline.gate = new AiGate(store, { owners: () => [OWNER] });
  const server = createApi({ store, pipeline, adminCode: async (_u, text) => void codes.push(text.match(/\d{6}/)![0]) }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = async (l: string, pw: string) => {
    const r = await fetch(base + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: l, password: pw }) });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const callAs = async (token: string, p: string, body?: unknown) => {
    const r = await fetch(base + p, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> };
  };
  const token = String((await login("owner", "owner-pass-1")).body.token);
  await callAs(token, "/api/admin/code", {});
  assert.equal((await callAs(token, "/api/admin/confirm", { code: codes[0] })).status, 200);
  const call = (p: string, body?: unknown) => callAs(token, p, body);
  return { store, owner, anya, token, call, callAs, login, close: async () => { server.close(); await store.close(); } };
}

/** В списке и журнале — только номера и числа: ни логина, ни имени, ни chat id, ни пароля с ключом. */
const noPrivate = (body: unknown, secrets: string[] = []) => {
  const json = JSON.stringify(body);
  for (const bad of ["Аня", "Хозяин", '"anya"', '"owner"', OWNER, "chat_id", "login", "password", "password_hash", "name", ...secrets]) {
    assert.ok(!json.includes(bad), `в ответе админки: ${bad}`);
  }
};

test("тестовые аккаунты: только админу с кодом (иначе 404 / 403); создать — без Telegram, friend, is_test; причина и журнал; потолок", async () => {
  const s = await stand();
  try {
    // Не админ — адреса нет; админ на другом устройстве без кода — 403.
    const anyaToken = String((await s.login("anya", "anya-pass-1")).body.token);
    assert.equal((await s.callAs(anyaToken, "/api/admin/tests")).status, 404);
    assert.equal((await s.callAs(anyaToken, "/api/admin/tests", { reason: "сам себе" })).status, 404);
    const other = String((await s.login("owner", "owner-pass-1")).body.token);
    assert.equal((await s.callAs(other, "/api/admin/tests")).status, 403);
    assert.equal((await s.callAs(other, "/api/admin/tests", { reason: "без кода" })).status, 403);

    const empty = await s.call("/api/admin/tests");
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body, { max: TEST_ACCOUNTS_MAX, items: [] });
    for (const bad of [{}, { reason: "ой" }, { reason: "   " }, { reason: "проверка", tz: "Нет/Такого" }, { reason: "проверка", tz: 5 }]) {
      assert.equal((await s.call("/api/admin/tests", bad)).status, 400, JSON.stringify(bad));
    }
    const r = await s.call("/api/admin/tests", { reason: "проверить виджет на ПК", tz: "Asia/Yekaterinburg" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const { id, login, password } = r.body as { id: number; login: string; password: string };
    assert.match(login, /^test-[0-9a-f]{6}$/);
    assert.match(password, /^[\w-]{10}$/);
    assert.match(r.body.text, new RegExp(`^Тестовый аккаунт #${id} создан`));
    assert.equal(r.body.items.length, 1);
    const u = (await s.store.user(id))!;
    assert.deepEqual([u.chat_id, u.plan, Number(u.is_test), u.tz, u.access_until, u.name], [null, "friend", 1, "Asia/Yekaterinburg", null, ""]);
    assert.notEqual(u.password_hash, password, "в базе — только хеш");
    // Пароль — для ручного входа: обычный /api/login пускает, /api/me — is_test 1, доступ — бесплатный друг; в админку — нет.
    const t = await s.login(login, password);
    assert.equal(t.status, 200);
    const me = await s.callAs(String(t.body.token), "/api/me");
    assert.deepEqual([me.body.is_test, me.body.admin, me.body.access.plan, me.body.access.until, me.body.chat_id], [1, false, "friend", null, null]);
    assert.equal((await s.callAs(String(t.body.token), "/api/admin/state")).status, 404, "тестовый — не админ");
    assert.equal((await s.callAs(anyaToken, "/api/me")).body.is_test, 0, "у обычного — is_test 0");
    // Без поля пояса — пояс админа.
    const r2 = await s.call("/api/admin/tests", { reason: "второй" });
    assert.equal((await s.store.user(r2.body.id))!.tz, TZ);
    assert.notEqual(r2.body.login, login);

    // Список и журнал — без логина, пароля и имён.
    const list = await s.call("/api/admin/tests");
    noPrivate(list.body, [login, password]);
    assert.deepEqual(list.body.items.map((x: { id: number }) => x.id), [id, r2.body.id]);
    assert.deepEqual(Object.keys(list.body.items[0]).sort(), ["client", "created_at", "frozen_at", "id", "last_seen", "plan", "sessions", "version"]);
    assert.equal(list.body.items[0].sessions, 1, "вход по паролю — в счёте входов");
    const log = (await s.call("/api/admin/log")).body as unknown as { who: string; action: string; detail: string; reason: string }[];
    const created = log.filter((x) => x.action === "test_create");
    assert.deepEqual(created.map((x) => [x.who, x.detail, x.reason]), [[`#${s.owner.id}`, `#${r2.body.id}`, "второй"], [`#${s.owner.id}`, `#${id}`, "проверить виджет на ПК"]]);
    noPrivate(log, [login, password]);
    // Карточка аккаунта: метка тестового и строка журнала.
    const card = (await s.call(`/api/admin/account/${id}`)).body;
    assert.equal(card.is_test, 1);
    assert.equal((await s.call(`/api/admin/account/${s.anya.id}`)).body.is_test, 0);
    assert.deepEqual(card.log.map((x: { action: string }) => x.action), ["test_create"]);

    // Потолок: не больше TEST_ACCOUNTS_MAX сразу — дальше 409; удалили один — снова можно.
    for (let i = 2; i < TEST_ACCOUNTS_MAX; i++) assert.equal((await s.call("/api/admin/tests", { reason: `ещё ${i}` })).status, 200);
    const over = await s.call("/api/admin/tests", { reason: "лишний" });
    assert.equal(over.status, 409);
    assert.equal((await s.store.testAccounts()).length, TEST_ACCOUNTS_MAX);
    assert.equal((await s.call(`/api/admin/account/${r2.body.id}/delete`, { reason: "лишний тест", confirm: String(r2.body.id) })).status, 200, "удаление — обычное «Удалить»");
    assert.equal((await s.call("/api/admin/tests", { reason: "на место удалённого" })).status, 200);
  } finally {
    await s.close();
  }
});

test("ключ для программы на ПК: только тестовому (обычному — 403); ключ входит, is_test 1, админка под ним — 404; журнал без ключа", async () => {
  const s = await stand();
  try {
    const { id } = (await s.call("/api/admin/tests", { reason: "ключ для ПК" })).body as { id: number };
    const p = `/api/admin/tests/${id}/token`;
    assert.equal((await s.call(p, {})).status, 400, "без причины — 400");
    assert.equal((await s.call(p, { reason: "ключ", label: 5 })).status, 400);
    assert.equal((await s.call(`/api/admin/tests/${s.anya.id}/token`, { reason: "подмена входа" })).status, 403, "обычному человеку — нельзя");
    assert.equal((await s.call(`/api/admin/tests/${s.owner.id}/token`, { reason: "подмена входа" })).status, 403);
    assert.equal(await s.store.accountSessions(s.anya.id).then((x) => x.length), 0, "Ане ключ не выдан");
    assert.equal((await s.call("/api/admin/tests/99999/token", { reason: "нет такого" })).status, 404);
    assert.equal((await s.call("/api/admin/tests/99999999999/token", { reason: "больше int4" })).status, 404);
    assert.equal((await s.call(`/api/admin/tests/${id}/nope`, { reason: "нет действия" })).status, 404);
    assert.equal((await s.call(`/api/admin/tests/${id}/token`)).status, 404, "GET — адреса нет");

    const r = await s.call(p, { reason: "вход в программе на ПК" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const token = String(r.body.token);
    assert.match(token, /^[\w-]{43}$/);
    assert.equal(r.body.id, id);
    const me = await s.callAs(token, "/api/me");
    assert.deepEqual([me.status, me.body.id, me.body.is_test, me.body.admin], [200, id, 1, false]);
    assert.equal(me.body.sessions.find((x: { current: boolean }) => x.current).label, TEST_TOKEN_LABEL);
    assert.equal((await s.callAs(token, "/api/admin/tests")).status, 404, "под тестовым ключом админки нет");
    assert.equal((await s.callAs(token, "/api/admin/state")).status, 404);
    // Метка — своя; ключ — каждый раз новый.
    const r2 = await s.call(p, { reason: "второй ПК", label: "Тест: ноутбук" });
    assert.notEqual(r2.body.token, token);
    assert.ok((await s.callAs(String(r2.body.token), "/api/me")).body.sessions.some((x: { label: string; current: boolean }) => x.current && x.label === "Тест: ноутбук"));
    // Журнал: test_token с номером и причиной, ключа нет ни там, ни в списке.
    const log = (await s.call("/api/admin/log")).body as unknown as { action: string; detail: string; reason: string }[];
    assert.deepEqual(log.filter((x) => x.action === "test_token").map((x) => [x.detail, x.reason]), [[`#${id}`, "второй ПК"], [`#${id}`, "вход в программе на ПК"]]);
    noPrivate(log, [token, String(r2.body.token)]);
    noPrivate((await s.call("/api/admin/tests")).body, [token]);
    // Выход в программе (возврат в свой аккаунт) — обычный /api/logout: ключ больше не входит.
    assert.equal((await s.callAs(token, "/api/logout", {})).status, 200);
    assert.equal((await s.callAs(token, "/api/me")).status, 401);
    // Замороженному ключ не выдаётся.
    await s.store.updateUser(id, { frozen_at: new Date().toISOString() });
    assert.equal((await s.call(p, { reason: "заморожен" })).status, 409);
  } finally {
    await s.close();
  }
});

test("сбросить к чистому: данные удалены, запись, номер, логин и пароль остались, входы закрыты; номер набрать вручную; только тестовому", async () => {
  const s = await stand();
  try {
    const c = (await s.call("/api/admin/tests", { reason: "сброс" })).body as { id: number; login: string; password: string };
    const token = String((await s.call(`/api/admin/tests/${c.id}/token`, { reason: "ключ" })).body.token);
    // Данные: сообщение, задача, привычка, настройки, ключ kv.
    const today = dayKey(new Date(), TZ);
    await s.store.saveMessage({ userId: c.id, source: "desktop", sourceId: "x1", text: "купить хлеб", dayKey: today });
    await s.store.updateUser(c.id, { name: "Тестер", persona: "kind", maid_hair: "black", morning_time: "07:30", city: "{}" });
    await s.store.kvSet(`album:${c.id}`, "1");
    await s.store.kvSet(`morning:${c.id}:${today}`, "1");
    const anyaMsg = await s.store.saveMessage({ userId: s.anya.id, source: "web", sourceId: "a1", text: "моё", dayKey: today });

    const p = `/api/admin/tests/${c.id}/reset`;
    assert.equal((await s.call(p, { confirm: String(c.id) })).status, 400, "без причины — 400");
    assert.equal((await s.call(p, { reason: "сброс" })).status, 400, "без номера — 400");
    assert.equal((await s.call(p, { reason: "сброс", confirm: String(c.id + 1) })).status, 400, "не тот номер — 400");
    assert.equal((await s.call(`/api/admin/tests/${s.anya.id}/reset`, { reason: "сброс", confirm: String(s.anya.id) })).status, 403, "обычного — нельзя");
    assert.ok((await s.store.message(anyaMsg.message.id)), "у Ани всё на месте");

    const r = await s.call(p, { reason: "к чистому", confirm: `#${c.id}` });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.deleted >= 3, `удалено строк: ${r.body.deleted}`);
    assert.match(r.body.text, new RegExp(`^Тестовый аккаунт #${c.id} сброшен`));
    const u = (await s.store.user(c.id))!;
    assert.deepEqual(
      [u.id, u.login, u.plan, Number(u.is_test), u.chat_id, u.name, u.persona, u.maid_hair, u.morning_time, u.city],
      [c.id, c.login, "friend", 1, null, "", "strict", "red", "09:00", ""],
    );
    const n = async (sql: string, ...a: unknown[]) => Number((await s.store.driver.all<{ n: number }>(sql, a))[0].n);
    assert.equal(await n("SELECT COUNT(*) AS n FROM messages WHERE user_id = ?", c.id), 0);
    assert.equal(await n("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?", c.id), 0, "входы закрыты");
    assert.equal(await s.store.kvGet(`album:${c.id}`), undefined);
    assert.equal(await s.store.kvGet(`morning:${c.id}:${today}`), undefined);
    assert.equal((await s.callAs(token, "/api/me")).status, 401, "прежний ключ не входит");
    assert.ok(await s.store.message(anyaMsg.message.id), "у Ани всё на месте и после сброса");
    // Логин и пароль — прежние; номер в списке тот же.
    assert.equal((await s.login(c.login, c.password)).status, 200);
    assert.deepEqual((await s.call("/api/admin/tests")).body.items.map((x: { id: number }) => x.id), [c.id]);
    const log = (await s.call("/api/admin/log")).body as unknown as { action: string; detail: string; reason: string }[];
    const row = log.find((x) => x.action === "test_reset")!;
    assert.match(row.detail, new RegExp(`^#${c.id} сброшен к чистому, строк удалено: \\d+, отвязано \\(деньги\\): \\d+$`));
    assert.equal(row.reason, "к чистому");
    assert.deepEqual((await s.call(`/api/admin/account/${c.id}`)).body.log.map((x: { action: string }) => x.action), ["test_reset", "test_token", "test_create"]);
  } finally {
    await s.close();
  }
});

test("isAdmin: тестовый аккаунт — никогда не админ, даже с chat id из ADMIN_CHAT_IDS", async () => {
  config.allowedChatIds.splice(0, Infinity, OWNER);
  config.adminChatIds.splice(0, Infinity, OWNER);
  const store = await Store.open(":memory:");
  try {
    const u = await store.createUser({ login: "t", passwordHash: "x", tz: TZ, chatId: OWNER, isTest: true });
    assert.equal(Number(u.is_test), 1);
    assert.equal(isAdmin(u, "session"), false);
    assert.equal(isAdmin({ ...u, is_test: 0 }, "session"), true, "тот же без признака — админ");
  } finally {
    config.adminChatIds.splice(0, Infinity);
    await store.close();
  }
});

for (const [name, open] of Object.entries(BACKENDS)) {
  test(`тестовые не в счёте (${name}): люди, новички, активные, планы, регистрации, аналитика, падения выпуска; расход — строкой «тесты»`, async () => {
    config.allowedChatIds.splice(0, Infinity, OWNER);
    config.adminChatIds.splice(0, Infinity);
    resetAnalyticsCache();
    const store = await open();
    try {
      const now = new Date();
      const real = await store.createUser({ login: "real", passwordHash: "x", tz: TZ, chatId: "21", plan: "friend" });
      const t1 = await store.createUser({ login: "test-aaaaaa", passwordHash: "x", tz: TZ, chatId: null, plan: "friend", isTest: true });
      const t2 = await store.createUser({ login: "test-bbbbbb", passwordHash: "x", tz: TZ, chatId: null, plan: "friend", isTest: true });
      const hourAgo = new Date(now.getTime() - 3600_000).toISOString();
      assert.equal(await store.countUsersSince(hourAgo), 1, "потолок регистраций — без тестовых");
      assert.deepEqual((await store.usersCreatedSince(hourAgo)).map((x) => x.id), [real.id], "сводка новичков — без тестовых");
      assert.equal((await store.planCounts(now.toISOString())).friend, 1);
      assert.deepEqual([...(await store.testUserIds())].length, 2);
      assert.deepEqual((await store.analyticsUsers([OWNER])).map((x) => [x.id, x.test]), [[real.id, false], [t1.id, true], [t2.id, true]]);
      // Активность и расход: оба пишут сегодня, у обоих расход.
      const today = dayKey(now, config.defaultTimezone);
      for (const [u, k] of [[real.id, "r"], [t1.id, "t"]] as const) {
        await store.saveMessage({ userId: u, source: "telegram", sourceId: `m${k}`, text: "x", dayKey: today, at: now });
        await store.addUsage(now, { kind: "parse", model: "m", input: 1, output: 1, cost: u === t1.id ? 0.25 : 0.5, userId: u });
      }
      const o = await adminOverview(store, now);
      assert.deepEqual([o.users, o.new_week, o.active_day, o.billing.friends], [1, 1, 1, 1], "в «Обзоре» — только настоящий человек");
      assert.ok(Math.abs(o.spend_month - 0.75) < 1e-9, "общий расход — весь, с тестами");
      assert.equal(o.spend_tests_month.accounts, 2);
      assert.ok(Math.abs(o.spend_tests_month.cost - 0.25) < 1e-9, "строка «тесты»");
      const sp = await adminSpend(store, 30, now);
      assert.ok(Math.abs(sp.tests.cost - 0.25) < 1e-9);
      assert.deepEqual(sp.byUser.filter((x) => x.test).map((x) => x.user_id), [t1.id]);
      const users = (await adminUsers(store, now)).map((x) => [x.id, x.test]).sort((a, b) => Number(a[0]) - Number(b[0]));
      assert.deepEqual(users, [[real.id, false], [t1.id, true], [t2.id, true]], "«Пользователи» — с меткой test");
      const aud = await adminAudience(store, now);
      assert.equal(aud.series.at(-1)!.dau, 1, "в «Аудитории» — без тестовых");
      const act = await cachedAnalytics(store, parseAnalyticsQuery("/api/admin/analytics?report=act&days=7&step=d"), now);
      assert.ok(!JSON.stringify(act).includes(`"user_id":${t1.id}`));
      // Падения: у тестового ПК — падения новой версии, у настоящего — нет: выпуск их не видит.
      await store.markDesktopDay(real.id, today, "2.0.0", 0);
      await store.markDesktopDay(t1.id, today, "2.0.0", 5);
      const cr = await releaseCrashes(store, { version: "2.0.0", prev: "" } as Release, now);
      assert.deepEqual([cr.cur.active, cr.cur.crashed, cr.cur.crashes], [1, 0, 0], "падения тестового ПК не ставят выпуск на паузу");
    } finally {
      await store.close();
    }
  });
}

for (const [name, open] of Object.entries(BACKENDS)) {
  test(`расход тестового (${name}): после «Сбросить к чистому» и после удаления — в строке «тесты»; в аналитике — в итоге ИИ и марже`, async () => {
    config.allowedChatIds.splice(0, Infinity, OWNER);
    config.adminChatIds.splice(0, Infinity);
    resetAnalyticsCache();
    const store = await open();
    try {
      const now = new Date();
      const real = await store.createUser({ login: "real", passwordHash: "x", tz: TZ, chatId: "21", plan: "friend" });
      const t = await store.createUser({ login: "test-spend1", passwordHash: "x", tz: TZ, chatId: null, plan: "friend", isTest: true });
      await store.addUsage(now, { kind: "parse", model: "m", input: 1, output: 1, cost: 1, userId: real.id });
      await store.addUsage(now, { kind: "parse", model: "m", input: 1, output: 1, cost: 2, userId: t.id });
      const tests = async () => (await adminOverview(store, now)).spend_tests_month;
      assert.equal((await tests()).cost, 2);
      const money = async () => {
        resetAnalyticsCache();
        return (await cachedAnalytics(store, parseAnalyticsQuery("/api/admin/analytics?report=money&days=7&step=d"), now)).data as { kpi: { ai_micro: { cur: number }; ai_per_active_micro: { cur: number | null } } };
      };
      const ai = async () => {
        resetAnalyticsCache();
        return (await cachedAnalytics(store, parseAnalyticsQuery("/api/admin/analytics?report=ai&days=7&step=d"), now)).data as { kpi: { total_micro: { cur: number }; tests_micro: { cur: number }; top_user: { user_id: number } | null } };
      };
      assert.equal((await money()).kpi.ai_micro.cur, 3_000_000, "аналитика: расход ИИ — весь, с тестовым (деньги настоящие)");
      const a1 = await ai();
      assert.deepEqual([a1.kpi.total_micro.cur, a1.kpi.tests_micro.cur, a1.kpi.top_user?.user_id], [3_000_000, 2_000_000, real.id], "из итога — тесты; самый дорогой — человек");
      // Сброс: деньги остаются на номере тестового.
      await store.wipeAccountData(t.id);
      assert.equal((await tests()).cost, 2, "сброс не должен уносить расход из строки «тесты»");
      assert.equal((await adminOverview(store, now)).spend_month, 3);
      // Удаление тестового: расход — на −id, в строке «тесты» остаётся, «без человека» его нет.
      await store.deleteAccount(t.id);
      assert.equal((await tests()).cost, 2, "удаление тестового не должно уносить расход из строки «тесты»");
      const sp = await adminSpend(store, 30, now);
      assert.equal(sp.tests.cost, 2);
      assert.ok(!sp.byUser.some((x) => x.user_id === 0), "расход удалённого тестового попал в «без человека»");
      assert.deepEqual(sp.byUser.filter((x) => x.test).map((x) => [x.user_id, x.name]), [[-t.id, `тест #${t.id} (удалён)`]]);
      assert.equal((await money()).kpi.ai_micro.cur, 3_000_000);
      assert.equal((await ai()).kpi.tests_micro.cur, 2_000_000);
    } finally {
      await store.close();
    }
  });
}

test("сброс тестового: хвосты, дописанные начатыми до сброса делами, убираются вторым проходом; вошли после сброса — не трогаем", async () => {
  const store = await Store.open(":memory:");
  try {
    const by = await store.createUser({ login: "adm", passwordHash: "x", tz: TZ, chatId: OWNER });
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const tasks = async (id: number) => (await store.driver.all<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE user_id = ?", [id]))[0].n;
    const task = (id: number) => store.addTask({ user_id: id, title: "хвост", priority: "", category: "", due_date: null, notes: "", message_id: null });
    for (const loggedIn of [false, true]) {
      const t = await store.createUser({ login: `test-tail${Number(loggedIn)}`, passwordHash: "x", tz: TZ, chatId: null, plan: "friend", isTest: true });
      await testAccountAction({ store, sweepAfterMs: 30 }, by, t.id, "reset", { reason: "сброс", confirm: String(t.id) });
      await task(t.id); // ответ модели пришёл уже после сброса
      if (loggedIn) await store.addSession(tokenHash(`k${t.id}`), t.id, TEST_TOKEN_LABEL);
      await wait(120);
      assert.equal(Number(await tasks(t.id)), loggedIn ? 1 : 0, loggedIn ? "вошли после сброса — строки свои, не трогать" : "хвост после сброса остался");
    }
  } finally {
    await store.close();
  }
});

test("планировщик: утро с моделью у тестового — только если входом пользовались за сутки; иначе утро без модели", async () => {
  config.allowedChatIds.splice(0, Infinity, OWNER);
  const store = await Store.open(":memory:");
  try {
    const idle = await store.createUser({ login: "test-idle01", passwordHash: "x", tz: TZ, chatId: null, plan: "friend", isTest: true });
    const fresh = await store.createUser({ login: "test-fresh1", passwordHash: "x", tz: TZ, chatId: null, plan: "friend", isTest: true });
    await store.addSession(tokenHash("fresh-key"), fresh.id, TEST_TOKEN_LABEL);
    const asked = new Set<number>();
    let who = 0;
    const llm: LlmCall = async () => (asked.add(who), JSON.stringify({ fact: "Факт дня.", wish: "Хорошего дня." }));
    const sent: { id: number; text: string }[] = [];
    const sch = new Scheduler(store, llm, async (u, text) => void sent.push({ id: u.id, text }));
    const day = dayKey(new Date(), TZ);
    // Два такта: сначала утро только у idle (у fresh утро позже), потом — у fresh; who — чьё утро сейчас просит модель.
    who = idle.id;
    await store.updateUser(fresh.id, { morning_time: "23:59" });
    await sch.tick(zonedToUtc(day, "09:05", TZ));
    assert.ok(sent.some((x) => x.id === idle.id && x.text.includes("Доброе утро")), "утро тестовому без входа — пришло");
    assert.ok(!asked.has(idle.id), "но без модели");
    who = fresh.id;
    await store.updateUser(fresh.id, { morning_time: "09:00" });
    await sch.tick(zonedToUtc(day, "09:06", TZ));
    assert.ok(sent.some((x) => x.id === fresh.id && x.text.includes("Доброе утро")), "утро тестовому со входом — пришло");
    assert.ok(asked.has(fresh.id), "и с моделью");
  } finally {
    await store.close();
  }
});
