import { PGlite } from "@electric-sql/pglite";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApi } from "../src/api.ts";
import { authByToken, clientFromLabel, clientMeta, desktopTokenSeen, hashPassword, resetSeen, tokenHash } from "../src/auth.ts";
import { config } from "../src/config.ts";
import { Store } from "../src/db.ts";
import { PgDriver } from "../src/driver.ts";
import { callLlm, onLlmCall, type LlmCall } from "../src/llm.ts";
import { Pipeline } from "../src/pipeline.ts";
import { dayKey, timeOf, zonedToUtc } from "../src/time.ts";

// Этап 2 админки, запись на сервере (шаг 24 базы): клиент и версия входа из заголовков X-Maid-*, минуты присутствия (presence),
// журнал попыток модели (llm_calls) без текстов, счётчик вызовов модели и ветка у сообщения, чистка по сроку.

const BACKENDS: Record<string, () => Promise<Store>> = {
  sqlite: () => Store.open(":memory:"),
  postgres: async () => {
    const pg = new PGlite();
    return Store.over(new PgDriver(pg, (fn) => pg.transaction((tx) => fn(tx)), () => pg.close()));
  },
};
const TZ = "Europe/Moscow";
const q = <T>(store: Store, sql: string, ...args: unknown[]) => (store as any).all(sql, ...args) as Promise<T[]>;
const age = (store: Store, token: string, ms = 120_000) =>
  (store as any).run("UPDATE sessions SET last_seen = ? WHERE token_hash = ?", new Date(Date.now() - ms).toISOString(), tokenHash(token));
const presence = (store: Store) =>
  q<{ user_id: number; day_key: string; hour: number; client: string; minutes: number }>(store, "SELECT * FROM presence ORDER BY client")
    .then((r) => r.map((x) => ({ ...x, hour: Number(x.hour), minutes: Number(x.minutes) })));

test("заголовки X-Maid-*: только белый список и версия вида 1.2.3, иначе пусто; клиент старых входов — по метке", () => {
  assert.deepEqual(clientMeta({ "x-maid-client": "widget", "x-maid-version": "0.1.90" }), { client: "widget", version: "0.1.90" });
  assert.deepEqual(clientMeta({ "x-maid-client": " desktop ", "x-maid-version": "1.2.3; DROP TABLE" }), { client: "desktop", version: "" });
  assert.deepEqual(clientMeta({ "x-maid-client": "<script>", "x-maid-version": "1.2" }), { client: "", version: "" });
  assert.deepEqual(clientMeta({}), { client: "", version: "" });
  assert.deepEqual(clientMeta({ "x-maid-client": "telegram-widget", "x-maid-version": "1234.1.1" }), { client: "telegram-widget", version: "" });
  assert.deepEqual(["web", "iphone", "desktop", "Программа на ПК", "telegram /token", "cli"].map(clientFromLabel),
    ["web", "iphone", "desktop", "desktop", "iphone", "other"]);
  // То, что шлют клиенты (часть C): сайт — время сборки «год.день.ЧЧММ» (web/vite.config.ts), ПК — версия программы, айфон — VERSION скрипта.
  for (const [c, v] of [["web", "26.328.1530"], ["web", "26.1.5"], ["desktop", "0.1.89"], ["widget", "0.1.89"], ["quick", "0.1.89"], ["iphone", "1.0.0"]])
    assert.deepEqual(clientMeta({ "x-maid-client": c, "x-maid-version": v }), { client: c, version: v });
});

for (const [kind, open] of Object.entries(BACKENDS)) {
  test(`${kind}: миграция с шага 23 — старые сессии и сообщения читаются, новые столбцы пустые`, async () => {
    const store = await open();
    const u = await store.ensureUser("1", "Тест", TZ);
    await store.addSession(tokenHash("old"), u.id, "web");
    const { message } = await store.saveMessage({ userId: u.id, source: "web", sourceId: "m1", text: "привет", dayKey: "2026-11-24" });
    await store.driver.exec("ALTER TABLE sessions DROP COLUMN client; ALTER TABLE sessions DROP COLUMN version;" +
      " ALTER TABLE messages DROP COLUMN llm_calls; ALTER TABLE messages DROP COLUMN route; DROP TABLE presence; DROP TABLE llm_calls;" +
      " ALTER TABLE users DROP COLUMN plan; ALTER TABLE users DROP COLUMN access_until; ALTER TABLE users DROP COLUMN tg_user_id; ALTER TABLE users DROP COLUMN sub_charge_id; ALTER TABLE users DROP COLUMN sub_canceled; ALTER TABLE users DROP COLUMN trial_len_days; ALTER TABLE users DROP COLUMN frozen_at; ALTER TABLE admin_log DROP COLUMN reason;");
    await store.kvSet("schema_version", "23");
    const again = await Store.over(store.driver);
    assert.equal(await again.kvGet("schema_version"), "33");
    const [s] = await q<{ client: string; version: string; label: string }>(again, "SELECT client, version, label FROM sessions");
    assert.deepEqual([s.client, s.version, s.label], ["", "", "web"]);
    const m = (await again.message(message.id))!;
    assert.deepEqual([Number(m.llm_calls), m.route, m.text], [0, "", "привет"]);
    await again.bumpPresence(u.id, "2026-11-24", 9, "web");
    await again.addLlmCall(new Date(), { kind: "parse", model: "m", ms: 12, cost: 0.001, userId: u.id });
    assert.equal((await presence(again))[0].minutes, 1);
    assert.equal((await q(again, "SELECT * FROM llm_calls")).length, 1);
    await again.close();
  });

  test(`${kind}: вход — клиент и версия в сессии; минута присутствия не чаще раза в минуту, пустой заголовок не затирает`, async () => {
    resetSeen();
    const store = await open();
    const u = await store.ensureUser("1", "Тест", TZ);
    await store.addSession(tokenHash("k"), u.id, "Программа на ПК");
    const meta = { client: "widget", version: "0.1.90" };
    // Только что вошёл — last_seen свежий: ни записи, ни минуты.
    assert.ok(await authByToken(store, "k", meta));
    assert.deepEqual(await presence(store), []);
    await age(store, "k");
    const now = new Date();
    assert.ok(await authByToken(store, "k", meta));
    assert.ok(await authByToken(store, "k", meta)); // сразу ещё раз — минута та же
    const p = await presence(store);
    assert.equal(p.length, 1);
    // Виджет — окно программы на ПК: и вход, и минута — «desktop».
    assert.deepEqual([p[0].user_id, p[0].day_key, p[0].hour, p[0].client, p[0].minutes], [u.id, dayKey(now, TZ), Number(timeOf(now, TZ).slice(0, 2)), "desktop", 1]);
    const sess = () => q<{ client: string; version: string }>(store, "SELECT client, version FROM sessions ORDER BY label");
    assert.deepEqual((await sess()).map((s) => [s.client, s.version]), [["desktop", "0.1.90"]]);
    // Через минуту без заголовков (старый клиент): клиент и версия в сессии остаются.
    resetSeen();
    await age(store, "k");
    assert.ok(await authByToken(store, "k"));
    assert.deepEqual((await sess()).map((s) => [s.client, s.version]), [["desktop", "0.1.90"]]);
    assert.deepEqual((await presence(store)).map((x) => [x.client, x.minutes]), [["desktop", 2]]);
    // Сайт в главном окне программы — тот же ключ: клиент и версия программы не меняются, минута — программы.
    resetSeen();
    await age(store, "k");
    await authByToken(store, "k", { client: "web", version: "26.328.1530" });
    assert.deepEqual((await sess()).map((s) => [s.client, s.version]), [["desktop", "0.1.90"]]);
    assert.deepEqual((await presence(store)).map((x) => [x.client, x.minutes]), [["desktop", 3]]);
    // Старая программа без заголовков (клиента в сессии нет, метка «Программа на ПК») и новый сайт в её окне — вход не становится «web».
    await store.addSession(tokenHash("old"), u.id, "Программа на ПК");
    await age(store, "old");
    await authByToken(store, "old", { client: "web", version: "26.328.1530" });
    const [old] = await q<{ client: string; version: string }>(store, "SELECT client, version FROM sessions WHERE token_hash = ?", tokenHash("old"));
    assert.deepEqual([old.client, old.version], ["", ""]);
    await store.close();
  });

  test(`${kind}: два входа одного человека с одного клиента в одну минуту — одна минута присутствия`, async () => {
    resetSeen();
    const store = await open();
    const u = await store.ensureUser("1", "Тест", TZ);
    await store.addSession(tokenHash("phone"), u.id, "web");
    await store.addSession(tokenHash("pc"), u.id, "web");
    await age(store, "phone");
    await age(store, "pc");
    await Promise.all([authByToken(store, "phone", { client: "web", version: "" }), authByToken(store, "pc", { client: "web", version: "" })]);
    assert.deepEqual((await presence(store)).map((x) => [x.client, x.minutes]), [["web", 1]]);
    await store.close();
  });

  test(`${kind}: llm_calls и сообщения — запись, счёт вызовов с прибавлением, чистка по сроку`, async () => {
    const store = await open();
    const u = await store.ensureUser("1", "Тест", TZ);
    const NOW = new Date("2026-11-24T12:00:00Z");
    const { message } = await store.saveMessage({ userId: u.id, source: "web", sourceId: "m1", text: "x", dayKey: "2026-11-24" });
    await store.addMessageCalls(message.id, 2, "clarify");
    await store.addMessageCalls(message.id, 1, "");
    const m = (await store.message(message.id))!;
    assert.deepEqual([Number(m.llm_calls), m.route], [3, "clarify"]);
    await store.addLlmCall(new Date(NOW.getTime() - 31 * 86_400_000), { kind: "parse", model: "m", ms: 5, cost: null, error: "timeout" });
    await store.addLlmCall(new Date(NOW.getTime() - 29 * 86_400_000), { kind: "parse", model: "m", ms: 5, cost: 0.002 });
    // Присутствие с 24.11.2026 хранится 400 дней (было 90): годовые когорты удержания.
    await store.bumpPresence(u.id, "2025-10-19", 10, "web"); // 401 день
    await store.bumpPresence(u.id, "2025-10-21", 10, "web"); // 399 дней
    await store.bumpPresence(u.id, "2026-08-25", 10, "web"); // 91 день — раньше удалялся
    await store.pruneStats(NOW);
    const calls = await q<{ micro_usd: number; error_code: string }>(store, "SELECT micro_usd, error_code FROM llm_calls");
    assert.deepEqual(calls.map((c) => [Number(c.micro_usd), c.error_code]), [[2000, ""]]);
    assert.deepEqual((await presence(store)).map((x) => x.day_key).sort(), ["2025-10-21", "2026-08-25"]);
    await store.close();
  });

  test(`${kind}: счётчик вызовов модели у сообщения — переспрос уточнения, погода без модели, повтор прибавляет`, async () => {
    const store = await open();
    const u = await store.ensureUser("1", "Тест", TZ);
    const answers: unknown[] = [{ reply: "Записала.", diary: [{ section: "notes", text: "Молоко" }] }, { edits: [] }, "не JSON", { clarify: "В 7 утра или вечера?" }];
    const llm: LlmCall = async () => {
      const a = answers.shift();
      if (a instanceof Error) throw a;
      return typeof a === "string" ? a : JSON.stringify(a ?? {});
    };
    const pipe = new Pipeline(store, llm);
    const at = zonedToUtc("2026-11-08", "14:30", TZ);
    const say = (text: string, id: string) => pipe.handle({ user: u, source: "telegram", sourceId: id, text, at });
    const r2 = await say("купила молоко", "2");
    let m = (await store.message(r2.messageId))!;
    assert.deepEqual([Number(m.llm_calls), m.route], [1, "apply"]);
    // Повтор доставки того же сообщения не зовёт модель и счёт не меняет.
    await say("купила молоко", "2");
    assert.equal(Number((await store.message(r2.messageId))!.llm_calls), 1);
    // Поправка — на своё служебное сообщение, ветка «correct»; исходное сообщение счёт не меняет.
    await pipe.correct(u, r2.messageId, "не молоко, а кефир", { sourceId: "c1", at });
    const fixes = await q<{ id: number; llm_calls: number }>(store, "SELECT id, llm_calls FROM messages WHERE route = 'correct'");
    assert.deepEqual(fixes.map((x) => Number(x.llm_calls)), [1]);
    assert.notEqual(Number(fixes[0].id), r2.messageId);
    assert.equal(Number((await store.message(r2.messageId))!.llm_calls), 1);
    // Ответ словами вместо JSON — переспрос: два вызова на одно сообщение, ветка «уточнение».
    const r1 = await say("завтра в 7 тренировка", "1");
    m = (await store.message(r1.messageId))!;
    assert.deepEqual([Number(m.llm_calls), m.route, m.state], [2, "clarify", "clarify"]);
    // Погода — без модели (города нет — ответ без сети).
    const w = await say("какая погода?", "w");
    m = (await store.message(w.messageId))!;
    assert.deepEqual([Number(m.llm_calls), m.route], [0, "weather"]);
    await store.setMessage(r1.messageId, { state: "done" }); // уточнение закрыто — следующее сообщение новое
    // Сбой разбора, потом фоновый повтор того же сообщения — вызовы прибавляются.
    answers.push(new Error("упала"), { reply: "Записала.", diary: [{ section: "notes", text: "Хлеб" }] });
    const r3 = await say("купила хлеб", "3");
    assert.equal(r3.failed, true);
    m = (await store.message(r3.messageId))!;
    assert.deepEqual([Number(m.llm_calls), m.route], [1, "parse"]);
    await pipe.retryFailed(async () => {}, new Date(at.getTime() + 3 * 60_000));
    m = (await store.message(r3.messageId))!;
    assert.deepEqual([Number(m.llm_calls), m.route, m.state], [2, "apply", "done"]);
    // «Нарисуй»: разбор и сам рисунок — два вызова, ветка «draw».
    answers.push({ draw: { prompt: "a cat", title: "Кот" } });
    pipe.draw = async () => ({ mime: "image/png", data: Buffer.from("x").toString("base64") });
    const d = await say("нарисуй кота", "d");
    m = (await store.message(d.messageId))!;
    assert.deepEqual([Number(m.llm_calls), m.route], [2, "draw"]);
    await store.close();
  });
}

test("DESKTOP_TOKEN: минута присутствия «desktop» раз в минуту, версия — в памяти для админки", async () => {
  resetSeen();
  config.allowedChatIds.splice(0, Infinity, "1001");
  config.desktopToken = "desk-test-key";
  const store = await Store.open(":memory:");
  try {
    const a = await authByToken(store, "desk-test-key", { client: "", version: "0.1.89" });
    assert.equal(a?.via, "desktop");
    await authByToken(store, "desk-test-key", { client: "", version: "0.1.90" }); // в ту же минуту — не считается
    assert.deepEqual((await presence(store)).map((x) => [x.user_id, x.client, x.minutes]), [[a!.user.id, "desktop", 1]]);
    const seen = desktopTokenSeen();
    assert.deepEqual(seen.map((s) => [s.userId, s.version]), [[a!.user.id, "0.1.89"]]);
    // Сайт в главном окне программы с этим ключом: версия сайта как версия программы не пишется, минута — программы.
    resetSeen();
    await authByToken(store, "desk-test-key", { client: "web", version: "26.328.1530" });
    assert.deepEqual(desktopTokenSeen().map((s) => s.version), [""]);
    assert.deepEqual((await presence(store)).map((x) => [x.client, x.minutes]), [["desktop", 2]]);
  } finally {
    config.desktopToken = "";
    await store.close();
  }
});

test("API: вход и запросы с X-Maid-* — сессия знает клиента и версию, мусорная версия — пусто", async () => {
  resetSeen();
  const store = await Store.open(":memory:");
  await store.createUser({ login: "owner", passwordHash: await hashPassword("owner-pass-1"), tz: TZ });
  const server = createApi({ store, pipeline: new Pipeline(store, async () => "{}") }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const r = await fetch(base + "/api/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-maid-client": "desktop", "x-maid-version": "1.2.3'; DROP TABLE users;--" },
      body: JSON.stringify({ login: "owner", password: "owner-pass-1", label: "Программа на ПК" }),
    });
    const { token } = (await r.json()) as { token: string };
    let [s] = await q<{ client: string; version: string }>(store, "SELECT client, version FROM sessions");
    assert.deepEqual([s.client, s.version], ["desktop", ""]);
    await age(store, token);
    const me = await fetch(base + "/api/me", { headers: { authorization: `Bearer ${token}`, "x-maid-client": "quick", "x-maid-version": "0.1.90" } });
    assert.equal(me.status, 200);
    [s] = await q<{ client: string; version: string }>(store, "SELECT client, version FROM sessions");
    assert.deepEqual([s.client, s.version], ["desktop", "0.1.90"], "быстрая запись — окно программы на ПК");
    assert.deepEqual((await presence(store)).map((x) => [x.client, x.minutes]), [["desktop", 1]]);
  } finally {
    server.close();
    await store.close();
  }
});

test("callLlm: каждая попытка — строка llm_calls с временем и кодом ошибки, без тела ответа провайдера", async () => {
  const store = await Store.open(":memory:");
  const saved = { ...config.llm };
  const real = globalThis.fetch;
  Object.assign(config.llm, { baseUrl: "https://openrouter.ai/api/v1", apiKey: "k", model: "test/model" });
  onLlmCall((x) => void store.addLlmCall(new Date(), x).catch(() => {}));
  const replies: (() => Response)[] = [
    () => new Response("SECRET-BODY перегружено", { status: 503 }),
    () => Response.json({ choices: [{ message: { content: "ответ" } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.0025 } }),
    () => new Response("SECRET-BODY плохой запрос", { status: 400 }),
    () => Response.json({ choices: [{ message: { content: "" } }] }),
    () => Response.json({ choices: [{ message: { content: "" } }] }),
    () => Response.json({ choices: [{ message: { content: "" } }] }),
  ];
  globalThis.fetch = (async () => replies.shift()!()) as typeof fetch;
  try {
    assert.equal(await callLlm([{ role: "user", content: "SECRET-PROMPT" }], { kind: "chat" }), "ответ");
    await assert.rejects(callLlm([{ role: "user", content: "SECRET-PROMPT" }], { kind: "parse" }), /LLM 400/);
    await assert.rejects(callLlm([{ role: "user", content: "x" }]), /пустой/);
    config.llm.apiKey = "";
    await assert.rejects(callLlm([{ role: "user", content: "x" }]), /LLM_API_KEY/);
    await new Promise((r) => setTimeout(r, 20));
    const rows = await q<Record<string, unknown>>(store, "SELECT * FROM llm_calls ORDER BY id");
    assert.deepEqual(rows.map((r) => [r.kind, r.model, r.error_code, Number(r.micro_usd)]), [
      ["chat", "test/model", "http_5xx", 0],
      ["chat", "test/model", "", 2500],
      ["parse", "test/model", "http_4xx", 0],
      ["other", "test/model", "empty", 0],
      ["other", "test/model", "empty", 0],
      ["other", "test/model", "empty", 0],
      ["other", "test/model", "no_key", 0],
    ]);
    assert.ok(rows.every((r) => Number(r.ms) >= 0));
    assert.ok(!JSON.stringify(rows).includes("SECRET"), "в журнале текст ответа или запроса");
  } finally {
    globalThis.fetch = real;
    Object.assign(config.llm, saved);
    onLlmCall(null);
    await store.close();
  }
});
