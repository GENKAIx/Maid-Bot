import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { AiGate, DRAWS_CAP_TEXT, quotaDay, VOICE_CAP_TEXT } from "../src/access.ts";
import { createApi } from "../src/api.ts";
import { hashPassword } from "../src/auth.ts";
import { config } from "../src/config.ts";
import { Store, type User } from "../src/db.ts";
import type { LlmCall } from "../src/llm.ts";
import { Pipeline } from "../src/pipeline.ts";
import { loadTariffs, overrideTariffs, type TariffValues } from "../src/tariffs.ts";
import { voiceSeconds } from "../src/voice.ts";
import { saveYou } from "../src/you.ts";

// Лимиты в штуках (access.ts) без дыр и без лишних списаний (ревью 24.11.2026): отказ по частоте не даёт бесплатного фонового
// разбора; человек, который ничего не получил (модель, художник не ответили; поправке модель не нужна), запроса не теряет;
// повтор доставки не списывает дважды; sec: 0 не занижает голос; смена пояса не открывает новый день; при упоре в картинки и
// голос — своя честная фраза.

const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString();

async function fresh(p: Partial<TariffValues> = {}) {
  const store = await Store.open(":memory:");
  await loadTariffs(store);
  overrideTariffs({ aiBurst: 1000, ...p });
  return store;
}
const trial = (store: Store, login: string, tz = "Europe/Moscow") =>
  store.createUser({ login, passwordHash: "x", tz, plan: "trial", accessUntil: iso(Date.now() + 5 * DAY), trialLenDays: 7 });

/** Конвейер с заготовками: answers по очереди (Error — модель упала), пустая очередь — одна запись в заметки. */
function pipeOf(store: Store, answers: unknown[] = [], gate: AiGate = new AiGate(store, { owners: () => [] })) {
  let asked = 0;
  const llm: LlmCall = async () => {
    asked++;
    const a = answers.shift();
    if (a instanceof Error) throw a;
    return JSON.stringify(a ?? { reply: "Записала.", diary: [{ section: "notes", text: "x" }] });
  };
  const pipe = new Pipeline(store, llm);
  pipe.gate = gate;
  return { pipe, asked: () => asked };
}
const used = (store: Store, u: User) => store.quotaOf(u.id, quotaDay(u, new Date()));

test("отказ по частоте при кончившемся лимите: фоновый повтор модель не зовёт — сообщение заметкой, запросов не больше лимита", async () => {
  const store = await fresh({ trialCalls: 2 });
  const gate = new AiGate(store, { owners: () => [], burst: 3, windowMs: 3_600_000 });
  const { pipe, asked } = pipeOf(store, [], gate);
  const u = await trial(store, "rate");
  const at = new Date();
  const say = (id: string, text: string) => pipe.handle({ user: u, source: "telegram", sourceId: id, text, at, client: "telegram" });
  await say("1", "купить молоко");
  await say("2", "купить хлеб");
  assert.equal((await say("3", "позвонить маме")).blocked, "money", "третье прошло частоту и упёрлось в лимит");
  const fast = await say("4", "полить цветы");
  assert.equal(fast.failed, true, "четвёртое — отказ по частоте");
  assert.equal((await store.message(fast.messageId))!.reply, "rate");
  const before = asked();
  const sent: string[] = [];
  await pipe.retryFailed(async (_u, text) => void sent.push(text), new Date(Date.now() + 3 * 60_000));
  assert.equal(asked(), before, "модель не звали");
  assert.deepEqual(sent, [], "«Разобрала …» не пришло");
  const m = (await store.message(fast.messageId))!;
  assert.equal(m.state, "done");
  assert.match(m.reply ?? "", /записала заметкой/);
  assert.equal((await store.diaryOf(u.id, quotaDay(u, at))).some((d) => d.text === "полить цветы"), true, "текст — в заметках");
  assert.deepEqual(await used(store, u), { calls: 2, draws: 0, voice_sec: 0 });
  await store.close();
});

test("отказ по частоте при свободном лимите: фоновый повтор разбирает и берёт свой запрос", async () => {
  const store = await fresh({ trialCalls: 10 });
  const gate = new AiGate(store, { owners: () => [], burst: 1, windowMs: 3_600_000 });
  const { pipe } = pipeOf(store, [], gate);
  const u = await trial(store, "rate2");
  const at = new Date();
  await pipe.handle({ user: u, source: "telegram", sourceId: "1", text: "купить молоко", at, client: "telegram" });
  const fast = await pipe.handle({ user: u, source: "telegram", sourceId: "2", text: "купить хлеб", at, client: "telegram" });
  assert.equal(fast.failed, true);
  assert.equal((await used(store, u)).calls, 1);
  const sent: string[] = [];
  await pipe.retryFailed(async (_u, text) => void sent.push(text), new Date(Date.now() + 3 * 60_000));
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^Разобрала/);
  assert.equal((await used(store, u)).calls, 2, "фон взял запрос, который отказ по частоте не брал");
  await store.close();
});

test("модель не ответила: запрос возвращается; «Повторить» при новом сбое — тоже; фоновый повтор потом берёт один", async () => {
  const store = await fresh({ trialCalls: 5 });
  const { pipe } = pipeOf(store, [new Error("провайдер 503"), new Error("провайдер 503")]);
  const u = await trial(store, "fail");
  const r = await pipe.handle({ user: u, source: "telegram", sourceId: "1", text: "купить молоко", at: new Date(), client: "telegram" });
  assert.equal(r.failed, true);
  assert.equal((await used(store, u)).calls, 0, "человек ничего не получил — запрос вернулся");
  const again = await pipe.retry(u, r.messageId, new Date(), "telegram");
  assert.equal(again.failed, true);
  assert.equal((await used(store, u)).calls, 0, "«Повторить» упал — и этот вернулся");
  const sent: string[] = [];
  await pipe.retryFailed(async (_u, text) => void sent.push(text), new Date(Date.now() + 3 * 60_000));
  assert.match(sent[0] ?? "", /^Разобрала/);
  assert.equal((await used(store, u)).calls, 1, "разобрал фон — запрос один, взят им");
  await store.close();
});

test("разговор (/ask) упал — запрос возвращается", async () => {
  const store = await fresh({ trialCalls: 5 });
  const { pipe } = pipeOf(store, [new Error("провайдер 503")]);
  const u = await trial(store, "chat");
  await pipe.handle({ user: u, source: "desktop", sourceId: "1", text: "как дела?", chatOnly: true, at: new Date(), client: "web" });
  assert.equal((await used(store, u)).calls, 0);
  await store.close();
});

test("художник не ответил: картинка возвращается (запрос разбора — нет: модель ответила)", async () => {
  const store = await fresh({ trialDraws: 3 });
  const { pipe } = pipeOf(store, [{ draw: { prompt: "a cat", title: "Кот" }, reply: "Рисую!" }]);
  pipe.draw = async () => { throw new Error("RunPod 500"); };
  const u = await trial(store, "draw");
  const r = await pipe.handle({ user: u, source: "telegram", sourceId: "1", text: "нарисуй кота", at: new Date(), client: "telegram" });
  assert.match(r.text, /Не вышло нарисовать/);
  assert.deepEqual(await used(store, u), { calls: 1, draws: 0, voice_sec: 0 });
  await store.close();
});

test("упор в картинки: своя фраза («картинки кончились»), не «силы кончились — продолжу»; в голосе — своя", async () => {
  const store = await fresh({ trialDraws: 1, trialVoiceMin: 1 });
  const answer = { draw: { prompt: "a cat", title: "Кот" }, reply: "Рисую!" };
  const { pipe } = pipeOf(store, [answer, answer]);
  pipe.draw = async () => ({ mime: "image/png", data: "eA==" });
  const u = await trial(store, "cap");
  assert.ok((await pipe.handle({ user: u, source: "telegram", sourceId: "1", text: "нарисуй кота", at: new Date(), client: "telegram" })).drawing);
  const r = await pipe.handle({ user: u, source: "telegram", sourceId: "2", text: "нарисуй ещё", at: new Date(), client: "telegram" });
  assert.equal(r.text, DRAWS_CAP_TEXT);
  assert.doesNotMatch(r.text, /продолжу/);
  const gate = new AiGate(store, { owners: () => [] });
  const v = await gate.check(u, { take: { calls: 1, voiceSec: 61 } });
  assert.deepEqual(v.ok ? null : [v.reason, v.text], ["voice_cap", VOICE_CAP_TEXT]);
  await store.close();
});

test("поправка, которой модель не нужна («поправлять нечего», «уже отменено»), запроса не берёт", async () => {
  const store = await fresh({ trialCalls: 5 });
  const { pipe, asked } = pipeOf(store, [{ reply: "Понятно." }]);
  const u = await trial(store, "fix");
  const r = await pipe.handle({ user: u, source: "desktop", sourceId: "1", text: "просто так", at: new Date(), client: "web" });
  assert.equal((await used(store, u)).calls, 1);
  const n = asked();
  const c = await pipe.correct(u, r.messageId, "не так", { sourceId: "c1", client: "web" });
  assert.match(c!.text, /поправлять нечего/);
  assert.equal(asked(), n, "модель не звали");
  assert.equal((await used(store, u)).calls, 1, "запрос не взят");
  await store.close();
});

test("повтор доставки, пока первый ждёт модель: модель — один раз, запрос — один", async () => {
  const store = await fresh({ trialCalls: 5 });
  let release!: () => void;
  const wait = new Promise<void>((r) => (release = r));
  let asked = 0;
  const pipe = new Pipeline(store, async () => (asked++, await wait, JSON.stringify({ reply: "Записала.", diary: [{ section: "notes", text: "x" }] })));
  pipe.gate = new AiGate(store, { owners: () => [] });
  const u = await trial(store, "dup");
  const inc = { user: u, source: "desktop", sourceId: "same", text: "купить молоко", at: new Date(), client: "web" };
  const a = pipe.handle(inc);
  const b = pipe.handle(inc);
  await new Promise((r) => setTimeout(r, 20));
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(asked, 1);
  assert.equal(rb.duplicate, true);
  assert.equal(ra.messageId, rb.messageId);
  assert.equal((await used(store, u)).calls, 1);
  await store.close();
});

test("API: два /api/voice с одним id (ответ потерялся) — один запрос, одни секунды, одно распознавание", async () => {
  let heardCalls = 0;
  const stt = http.createServer(async (req, res) => {
    for await (const _ of req) { /* тело не нужно */ }
    heardCalls++;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ text: "купить хлеб" }));
  }).listen(0);
  const saved = { ...config.stt };
  Object.assign(config.stt, { baseUrl: `http://127.0.0.1:${(stt.address() as AddressInfo).port}/v1`, apiKey: "test-stt", model: "whisper-1" });
  const keep = { allowed: [...config.allowedChatIds], admin: [...config.adminChatIds] };
  config.allowedChatIds.splice(0, Infinity);
  config.adminChatIds.splice(0, Infinity);
  const store = await fresh({ trialCalls: 10, trialVoiceMin: 10 });
  const { pipe } = pipeOf(store);
  const u = await store.createUser({ login: "vox", passwordHash: await hashPassword("vox-pass-1"), tz: "Europe/Moscow", plan: "trial", accessUntil: iso(Date.now() + 5 * DAY), trialLenDays: 7 });
  const server = createApi({ store, pipeline: pipe }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const token = (await (await fetch(base + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: "vox", password: "vox-pass-1" }) })).json()).token as string;
    const voice = async (body: unknown) => {
      const r = await fetch(base + "/api/voice", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    const audio = Buffer.alloc(40_000, 7).toString("base64"); // 10 с при 32 кбит/с
    const one = await voice({ audio, mime: "audio/webm;codecs=opus", id: "X", sec: 10 });
    assert.equal(one.status, 200, JSON.stringify(one.body));
    const two = await voice({ audio, mime: "audio/webm;codecs=opus", id: "X", sec: 10 });
    assert.equal(two.status, 200);
    assert.equal(two.body.duplicate, true);
    assert.equal(two.body.heard, "купить хлеб");
    assert.equal(heardCalls, 1, "распознавали один раз");
    assert.deepEqual(await used(store, u), { calls: 1, draws: 0, voice_sec: 10 });
    // Одновременно два с новым id — тоже одно списание.
    const [a, b] = await Promise.all([voice({ audio, mime: "audio/webm", id: "Y", sec: 10 }), voice({ audio, mime: "audio/webm", id: "Y", sec: 10 })]);
    assert.deepEqual([a.status, b.status], [200, 200]);
    assert.equal(heardCalls, 2);
    assert.deepEqual(await used(store, u), { calls: 2, draws: 0, voice_sec: 20 });
  } finally {
    server.close();
    stt.close();
    await store.close();
    Object.assign(config.stt, saved);
    config.allowedChatIds.splice(0, Infinity, ...keep.allowed);
    config.adminChatIds.splice(0, Infinity, ...keep.admin);
  }
});

test("секунды голоса наших клиентов (Opus 32 кбит/с): sec 0 не занижает — 240 КБ не меньше 60 с; mp3 — по 128 кбит/с", () => {
  assert.equal(voiceSeconds(240_000, 0, true), 60);
  assert.equal(voiceSeconds(240_000, 0), 15, "без пометки Opus (Telegram, mp3) — прежняя граница");
  assert.equal(voiceSeconds(240_000, 75, true), 75, "названная длиннее — она");
});

test("смена пояса не открывает новый день счётчиков: остаток тот же, назад — тоже", async () => {
  const store = await fresh({ trialCalls: 3 });
  const u = await trial(store, "tz");
  const gate = new AiGate(store, { owners: () => [] });
  for (let i = 0; i < 3; i++) assert.equal((await gate.check(u, { take: { calls: 1 } })).ok, true);
  assert.equal((await gate.check(u, { take: { calls: 1 } })).ok, false);
  // Пояса по обе стороны линии смены дат: хотя бы в одном из них сейчас другая дата, чем в Москве.
  for (const tz of ["Pacific/Kiritimati", "Pacific/Pago_Pago", "Europe/Moscow"]) {
    const cur = (await store.user(u.id))!;
    await saveYou(store, cur, { tz });
    const moved = (await store.user(u.id))!;
    assert.equal(moved.tz, tz);
    assert.equal((await gate.check(moved, { take: { calls: 1 } })).ok, false, `в ${tz} — остаток тот же, 0`);
    assert.equal((await used(store, moved)).calls, 3);
  }
  await store.close();
});
