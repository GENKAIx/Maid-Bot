import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../src/db.ts";
import type { ChatMessage, LlmCall } from "../src/llm.ts";
import { Pipeline } from "../src/pipeline.ts";
import { zonedToUtc } from "../src/time.ts";

// Правка привычки словами (17.11.2026): «у привычек Таблетка Чумбы сделай напоминание по времени, как в их названиях» —
// горничная переспрашивала про чужое время: она не видела, во сколько напоминания сейчас, и не умела их менять (в чате
// у привычки были только «остановить» и «вернуть»). Теперь время напоминаний — в её списке привычек, правка remind ставит
// новое время (пусто — без напоминаний), rename переименовывает; «Отменить» возвращает как было.

const TZ = "Europe/Moscow";
const AT = zonedToUtc("2026-11-17", "12:01", TZ);

test("время напоминаний привычки — в подсказке; remind и rename словами; отмена возвращает", async () => {
  const store = await Store.open(":memory:");
  const u = await store.ensureUser("100", "Тест", TZ);
  const add = (title: string, times: string[], quiet = 0) =>
    store.addHabit({ user_id: u.id, title, days: "1234567", times: JSON.stringify(times), start_date: "2026-11-01", end_date: null, message_id: null, quiet });
  const night = await add("Таблетка Чумбы 00:30", ["02:00"]);
  const day = await add("Таблетка Чумбы 12:30", ["14:00"]);
  const walk = await add("Гулять", []);
  const tea = await add("Чай", [], 1);

  const prompts: string[] = [];
  const answers: unknown[] = [
    { edits: [
      { action: "remind", kind: "habit", id: night, new_times: ["00:30"] },
      { action: "remind", kind: "habit", id: day, new_times: ["12.30"] },
    ], summary: "s" },
    { edits: [{ action: "rename", kind: "habit", id: walk, new_title: "Прогулка" }], summary: "s" },
    { edits: [{ action: "remind", kind: "habit", id: walk, new_times: [] }], summary: "s" },
  ];
  const llm: LlmCall = async (messages: ChatMessage[]) => {
    prompts.push(messages.map((m) => m.content).join("\n"));
    return JSON.stringify(answers.shift() ?? {});
  };
  const pipe = new Pipeline(store, llm);
  const send = (text: string, id: string) => pipe.handle({ user: u, source: "telegram", sourceId: id, text, at: AT });
  const times = async (id: number) => JSON.parse((await store.habit(id))!.times) as string[];

  const r = await send("у привычек Таблетка Чумбы сделай напоминание по времени так же как указано в их названиях", "1");
  assert.match(prompts[0], /Таблетка Чумбы 00:30[^\n]*напоминания 02:00/, "горничная видит, во сколько напоминания сейчас");
  assert.match(prompts[0], /Гулять[^\n]*напоминания — общее время/);
  assert.match(prompts[0], /Чай[^\n]*без напоминаний/);
  assert.deepEqual(await times(night), ["00:30"]);
  assert.deepEqual(await times(day), ["12:30"], "12.30 приводится к 12:30");
  assert.ok(r.changes?.some((c) => c.kind === "edit" && /Таблетка Чумбы 00:30.*00:30/.test(c.title)), "в ответе — карточка с новым временем");
  assert.equal(r.undoable, true);

  await pipe.undo(u);
  assert.deepEqual([await times(night), await times(day)], [["02:00"], ["14:00"]], "отмена вернула прежнее время");

  await send("переименуй гулять в прогулка", "2");
  assert.equal((await store.habit(walk))!.title, "Прогулка");

  await send("про прогулку не напоминай", "3");
  assert.equal((await store.habit(walk))!.quiet, 1, "пустое время — без напоминаний");
  await pipe.undo(u);
  assert.equal((await store.habit(walk))!.quiet, 0);
  await pipe.undo(u);
  assert.equal((await store.habit(walk))!.title, "Гулять");
  store.close();
});
