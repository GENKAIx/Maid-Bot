import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import vm from "node:vm";
import { createApi } from "../src/api.ts";
import { hashPassword } from "../src/auth.ts";
import { Store } from "../src/db.ts";
import type { ChatMessage, LlmCall } from "../src/llm.ts";
import { EYES_NAMES, HAIR_NAMES, MAID_EYES, MAID_HAIR } from "../src/look.ts";
import { morningText } from "../src/morning.ts";
import { Pipeline } from "../src/pipeline.ts";
import { Scheduler } from "../src/scheduler.ts";
import { zonedToUtc } from "../src/time.ts";

// «Перекрасить Рину» (look.ts, 20.11.2026): цвет волос и глаз горничной выбирают на сайте (POST /api/settings), виджет ПК
// получает его с каждым опросом (GET /api/today) и перекрашивает анимации, а Рина знает свой цвет — он в её карточке
// во всех промптах. Без сети: LLM подставная.

const TZ = "Europe/Moscow";
const AT = zonedToUtc("2026-11-08", "14:30", TZ);
const RINA_MARK = "Тебя зовут Рина";

test("цвета сервера — те же id, порядок и названия, что LOOK_HAIR / LOOK_EYES виджета (desktop/renderer/look.js)", () => {
  const src = readFileSync(new URL("../../desktop/renderer/look.js", import.meta.url), "utf8");
  const MARK = "// --- браузер ---";
  assert.ok(src.includes(MARK), "в look.js нет метки «// --- браузер ---» — таблицы не достать");
  const ctx = vm.createContext({});
  vm.runInContext(`${src.slice(0, src.indexOf(MARK))}\nthis.LOOK_HAIR = LOOK_HAIR; this.LOOK_EYES = LOOK_EYES;`, ctx);
  const desk = (t: { id: string; name: string }[]) => Array.from(t, (o) => [o.id, o.name]);
  assert.deepEqual(MAID_HAIR.map((id) => [id, HAIR_NAMES[id]]), desk(ctx.LOOK_HAIR));
  assert.deepEqual(MAID_EYES.map((id) => [id, EYES_NAMES[id]]), desk(ctx.LOOK_EYES));
  assert.deepEqual([MAID_HAIR[0], MAID_EYES[0]], ["red", "violet"], "свои цвета — первыми (DEFAULT столбцов в db.ts)");
});

test("настройки: цвет волос и глаз сохраняется, /api/me и /api/today его отдают, чужой цвет — 400; Рина знает новый цвет", async () => {
  const store = await Store.open(":memory:");
  await store.createUser({ login: "owner", passwordHash: await hashPassword("secret-pass-1"), tz: TZ });
  const systems: string[] = [];
  const llm: LlmCall = async (messages) => {
    systems.push(messages.filter((m) => m.role === "system").map((m) => m.content).join("\n"));
    return JSON.stringify({ question: "какого цвета у тебя волосы?", lookup: null });
  };
  const server = createApi({ store, pipeline: new Pipeline(store, llm) }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, body?: unknown, token?: string) => {
    const r = await fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };
  const look = (j: any) => [j.maid_hair, j.maid_eyes];
  try {
    const { json: { token } } = await call("/api/login", { login: "owner", password: "secret-pass-1" });
    assert.deepEqual(look((await call("/api/me", undefined, token)).json), ["red", "violet"]);
    assert.deepEqual(look((await call("/api/today", undefined, token)).json), ["red", "violet"]);

    let me = (await call("/api/settings", { maid_hair: "gold" }, token)).json;
    assert.deepEqual(look(me), ["gold", "violet"], "глаза поменялись без спроса");
    me = (await call("/api/settings", { maid_eyes: "green" }, token)).json;
    assert.deepEqual(look(me), ["gold", "green"]);
    assert.equal(me.password_hash, undefined);
    assert.deepEqual(look((await call("/api/me", undefined, token)).json), ["gold", "green"]);
    const today = (await call("/api/today", undefined, token)).json;
    assert.deepEqual(look(today), ["gold", "green"]);
    assert.equal(today.persona, "strict");

    for (const bad of [{ maid_hair: "pink" }, { maid_eyes: "red" }, { maid_hair: "" }, { maid_eyes: 1 }, { maid_hair: "Gold" }]) {
      const r = await call("/api/settings", bad, token);
      assert.equal(r.status, 400, `принят ${JSON.stringify(bad)}`);
      assert.match(r.json.error, /нет такого цвета/);
    }
    assert.deepEqual(look((await call("/api/me", undefined, token)).json), ["gold", "green"], "чужой цвет всё же записался");

    // Спросили, какого она цвета, — в промпте уже выбранный.
    assert.equal((await call("/api/input", { text: "какого цвета у тебя волосы?", id: "q1" }, token)).status, 200);
    const rina = systems.filter((s) => s.includes(RINA_MARK));
    assert.ok(rina.length >= 2, "нет промптов с карточкой Рины (разбор и ответ)");
    for (const s of rina) {
      assert.ok(s.includes("золотистые волосы") && s.includes("зелёные глаза"), "в промпте не выбранный цвет");
      assert.doesNotMatch(s, /тёмно-красн|фиолетовые глаза/);
    }

    for (const h of MAID_HAIR) assert.equal((await call("/api/settings", { maid_hair: h }, token)).json.maid_hair, h);
    for (const e of MAID_EYES) assert.equal((await call("/api/settings", { maid_eyes: e }, token)).json.maid_eyes, e);
  } finally {
    server.close();
    await store.close();
  }
});

test("все промпты с карточкой Рины — в выбранных цветах: разбор, ответ на вопрос, разговор, /ask, поправка, утро, вечер", async () => {
  const store = await Store.open(":memory:");
  const u0 = await store.ensureUser("100", "Тест", TZ);
  await store.updateUser(u0.id, { maid_hair: "gold", maid_eyes: "green" });
  const u = (await store.user(u0.id))!;
  const parses: unknown[] = [
    { summary: "[14:30] встреча", events: [{ title: "Встреча с Петей", date_iso: "2026-11-09", time: "15:00", end_time: null }] },
    { question: "какого цвета у тебя глаза?", lookup: null },
    { diary: [{ section: "notes", text: "повысили до тимлида" }], summary: "[14:30] Повысили", talk: true, emotion: "happy", reply: "Ого." },
  ];
  const calls: { kind?: string; system: string }[] = [];
  const llm: LlmCall = async (messages: ChatMessage[], opts) => {
    calls.push({ kind: opts?.kind, system: messages.filter((m) => m.role === "system").map((m) => m.content).join("\n") });
    if (opts?.kind === "parse") return JSON.stringify(parses.shift() ?? {});
    if (opts?.kind === "correct") return JSON.stringify({ edits: [], clarify: "На сколько перенести?", reply: "", emotion: "neutral" });
    if (opts?.kind === "summary") return JSON.stringify({ fact: "Сегодня день чая.", wish: "Береги себя." });
    return "Золотистые, хозяин.";
  };
  const pipe = new Pipeline(store, llm);
  const say = (text: string, id: string, chatOnly?: boolean) => pipe.handle({ user: u, source: "telegram", sourceId: id, text, at: AT, chatOnly });

  const meet = await say("завтра в 15 встреча с Петей", "1");
  await say("какого цвета у тебя глаза?", "2");
  await say("Представляешь, меня повысили до тимлида!", "3");
  await say("расскажи о себе", "4", true);
  await pipe.correct(u, meet.messageId, "не в 15, а в 17", { sourceId: "c1", at: AT });
  await morningText(store, llm, u, "2026-11-08");
  await new Scheduler(store, llm, async () => {}).eveningText(u, "2026-11-08");

  const kinds = calls.filter((c) => c.system.includes(RINA_MARK)).map((c) => c.kind);
  for (const k of ["parse", "answer", "chat", "correct", "summary"]) assert.ok(kinds.includes(k), `нет промпта ${k} с карточкой Рины`);
  assert.equal(kinds.filter((k) => k === "chat").length, 2, "разговор и /ask");
  assert.equal(kinds.filter((k) => k === "summary").length, 2, "утро и вечер");
  for (const c of calls.filter((x) => x.system.includes(RINA_MARK))) {
    assert.ok(c.system.includes("золотистые волосы,"), `${c.kind}: нет выбранных волос`);
    assert.ok(c.system.includes("; зелёные глаза;"), `${c.kind}: нет выбранных глаз`);
    assert.doesNotMatch(c.system, /тёмно-красн|фиолетовые глаза/, `${c.kind}: остались свои цвета`);
  }

  // Вернули свои цвета — со следующего сообщения в промпте снова они.
  await store.updateUser(u.id, { maid_hair: "red", maid_eyes: "violet" });
  calls.length = 0;
  await pipe.handle({ user: (await store.user(u.id))!, source: "telegram", sourceId: "5", text: "привет", at: AT });
  assert.ok(calls[0].system.includes("тёмно-красные волосы, длинный хвост сбоку, перехваченный чёрным бантом; фиолетовые глаза; "));
  await store.close();
});
