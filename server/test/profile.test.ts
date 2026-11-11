import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../src/db.ts";
import type { ChatMessage, LlmCall } from "../src/llm.ts";
import { normalize } from "../src/parse.ts";
import { Pipeline } from "../src/pipeline.ts";
import { decideTrait, findPatterns, levelOf, profileView, saveProfile, traitPrompt } from "../src/profile.ts";
import { addDays, zonedToUtc } from "../src/time.ts";

// Профиль как в RPG: уровень за дела, дебафы из чата и найденные закономерности, которые горничная учитывает в ответах.

const TZ = "Europe/Moscow";
const AT = zonedToUtc("2026-11-08", "14:30", TZ);

async function setup(answers: unknown[]) {
  const store = await Store.open(":memory:");
  const u = await store.ensureUser("300", "Тест", TZ);
  const calls: ChatMessage[][] = [];
  const llm: LlmCall = async (messages) => {
    calls.push(messages);
    return JSON.stringify(answers.shift() ?? {});
  };
  return { store, u, calls, llm, pipe: new Pipeline(store, llm) };
}

test("уровень: 100 опыта на второй, дальше на 25 больше", () => {
  assert.deepEqual(levelOf(0), { level: 1, into: 0, need: 100 });
  assert.deepEqual(levelOf(99), { level: 1, into: 99, need: 100 });
  assert.deepEqual(levelOf(100), { level: 2, into: 0, need: 125 });
  assert.deepEqual(levelOf(230), { level: 3, into: 5, need: 150 });
});

test("профиль: рост и аватар проверяются, опыт идёт от сделанных задач", async () => {
  const { store, u } = await setup([]);
  await assert.rejects(saveProfile(store, u.id, { height: 400 }), /рост/);
  await assert.rejects(saveProfile(store, u.id, { avatar: "http://x/y.png" }), /аватар/);
  await saveProfile(store, u.id, { height: 181, title: "Паладин порядка", avatar: "data:image/png;base64,AAAA" });
  const t = await store.addTask({ user_id: u.id, title: "Дело", priority: "normal", category: "", due_date: null, notes: "", message_id: null });
  await store.updateTask(t, { status: "done" });
  const v = await profileView(store, u, "2026-11-08");
  assert.equal(v.title, "Паладин порядка");
  assert.equal(v.height, 181);
  assert.equal(v.xp, 10);
  assert.equal(v.level, 1);
  assert.ok(v.stats.some((s) => s.key === "height" && s.value.includes("181")));
});

test("дебаф из чата: записан, виден в промпте ответа, отменяется", async () => {
  const { store, u, pipe, calls } = await setup([
    { traits: [{ kind: "debuff", category: "allergy", title: "Аллергия на креветки", note: "сыпь" }], summary: "x" },
    { intent: "question", search: "" },
    "Лучше без креветок",
  ]);
  const r = await pipe.handle({ user: u, source: "telegram", sourceId: "1", text: "у меня аллергия на креветки", at: AT });
  const traits = await store.traitsOf(u.id);
  assert.equal(traits.length, 1);
  assert.equal(traits[0].status, "active");
  assert.equal(traits[0].source, "chat");
  assert.ok(r.changes?.some((c) => c.kind === "trait"));
  assert.match(traitPrompt(traits), /креветки/);
  await pipe.undo(u, r.messageId);
  assert.equal((await store.trait(traits[0].id))?.status, "removed");
  assert.equal(traitPrompt(await store.traitsOf(u.id)), "");
  assert.ok(calls.length >= 1);
});

test("разбор: traits обрезаются и считаются содержимым", () => {
  const p = normalize({ traits: [{ kind: "что-то", title: "  Непереносимость лактозы  ", note: "" }] }, { today: "2026-11-08", now: "14:30", text: "x" });
  assert.equal(p.traits.length, 1);
  assert.equal(p.traits[0].kind, "debuff");
  assert.equal(p.traits[0].title, "Непереносимость лактозы");
});

test("закономерность: только по дням из дневника, минимум три, предлагается и ждёт ответа", async () => {
  const days = ["2026-11-01", "2026-11-03", "2026-11-05", "2026-11-07"];
  const { store, u, llm } = await setup([{ patterns: [
    { title: "Плохо после молока", category: "food", note: "живот после молочного", days: [...days.slice(0, 3), "2026-10-01"] },
    { title: "Выдумка", category: "food", note: "", days: ["2026-11-02", "2026-11-04", "2026-11-06"] },
  ] }]);
  for (const d of days) {
    await store.addDiary(u.id, d, "food", "латте", null);
    await store.addDiary(u.id, d, "health", "болел живот", null);
  }
  const found = await findPatterns(store, llm, u, "2026-11-08");
  assert.deepEqual(found.map((t) => t.title), ["Плохо после молока"]);
  assert.equal(found[0].status, "suggested");
  assert.deepEqual(JSON.parse(found[0].evidence), days.slice(0, 3));
  assert.equal(traitPrompt(await store.traitsOf(u.id)), "", "предложение ещё не учитывается в ответах");
  assert.match(await decideTrait(store, u, found[0].id, true), /Добавила/);
  assert.match(traitPrompt(await store.traitsOf(u.id)), /молока/);
  assert.match(await decideTrait(store, u, found[0].id, false), /Уже/);
});

test("закономерность: мало дней со здоровьем — модель не зовётся", async () => {
  const { store, u, llm, calls } = await setup([]);
  for (let i = 0; i < 2; i++) await store.addDiary(u.id, addDays("2026-11-08", -i), "health", "болит голова", null);
  assert.deepEqual(await findPatterns(store, llm, u, "2026-11-08"), []);
  assert.equal(calls.length, 0);
});
