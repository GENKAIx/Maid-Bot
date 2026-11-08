import assert from "node:assert/strict";
import { test } from "node:test";
import { recordActivity } from "../src/activity.ts";
import { Store } from "../src/db.ts";
import type { ChatMessage, LlmCall } from "../src/llm.ts";
import { normalize } from "../src/parse.ts";
import { Pipeline } from "../src/pipeline.ts";
import { upcomingDates } from "../src/report.ts";
import { Scheduler } from "../src/scheduler.ts";
import { addDays, nextYearly, zonedToUtc } from "../src/time.ts";

// Всё без сети: LLM — подставная функция, отвечающая заготовленным JSON.

const TZ = "Europe/Moscow";
const AT = zonedToUtc("2026-11-08", "14:30", TZ); // суббота, 14:30 по Москве

function setup(answers: (unknown | Error)[]) {
  const store = new Store(":memory:");
  const u = store.ensureUser("100", "Тест", TZ);
  const calls: ChatMessage[][] = [];
  const llm: LlmCall = async (messages) => {
    calls.push(messages);
    const a = answers.shift();
    if (a instanceof Error) throw a;
    return JSON.stringify(a ?? {});
  };
  return { store, u, calls, pipe: new Pipeline(store, llm) };
}
const msg = (text: string, id: string) => ({ source: "telegram", sourceId: id, text, at: AT });

test("одно сообщение — дневник и план сразу, с напоминанием за час", async () => {
  const { store, u, pipe } = setup([{
    diary: [{ section: "food", text: "овсянка с бананом" }],
    summary: "[14:30] Съел овсянку, завтра в 15 встреча с Петей",
    events: [{ title: "Встреча с Петей", date_iso: "2026-11-09", time: "15:00" }],
  }]);
  const r = await pipe.handle({ user: u, ...msg("Съел овсянку, завтра в 15 встреча с Петей", "1") });
  assert.equal(store.diaryOf(u.id, "2026-11-08").filter((d) => d.section === "food").length, 1);
  const evs = store.eventsBetween(u.id, "2026-11-09", "2026-11-09");
  assert.equal(evs.length, 1);
  assert.equal(evs[0].time, "15:00");
  const rem = store.pendingReminders("event", evs[0].id);
  assert.equal(rem.length, 1);
  assert.equal(rem[0].due_at, zonedToUtc("2026-11-09", "14:00", TZ).toISOString());
  assert.ok(r.undoable);
  assert.match(r.text, /Еда/);
  assert.match(r.text, /планов: 1/);
});

test("повторная доставка не дублирует записи и не зовёт модель", async () => {
  const { store, u, pipe, calls } = setup([{ diary: [{ section: "sport", text: "пробежка 5 км" }], summary: "x" }]);
  await pipe.handle({ user: u, ...msg("пробежал 5 км", "7") });
  const again = await pipe.handle({ user: u, ...msg("пробежал 5 км", "7") });
  assert.equal(again.duplicate, true);
  assert.equal(calls.length, 1);
  assert.equal(store.diaryOf(u.id, "2026-11-08").filter((d) => d.section === "sport").length, 1);
});

test("«вчера» — во вчерашний день, дневник из будущего отбрасывается", async () => {
  const { store, u, pipe } = setup([{
    date_iso: "2026-11-07",
    diary: [{ section: "sleep", text: "лёг в 2:00" }, { section: "mood", text: "отлично", day_iso: "2026-11-20" }],
    summary: "[14:30] вчера лёг в 2",
  }]);
  await pipe.handle({ user: u, ...msg("вчера лёг в 2", "2") });
  assert.equal(store.diaryOf(u.id, "2026-11-07").filter((d) => d.section === "sleep").length, 1);
  // Будущая дата раздела не принята — запись легла в день сообщения (2026-11-07), а не в 20-е.
  assert.equal(store.diaryOf(u.id, "2026-11-20").length, 0);
  assert.equal(store.diaryOf(u.id, "2026-11-07").filter((d) => d.section === "mood").length, 1);
});

test("отмена убирает всё, что сделало сообщение, и снимает напоминания", async () => {
  const { store, u, pipe } = setup([{
    diary: [{ section: "notes", text: "купил лампочку" }],
    summary: "[14:30] купил лампочку",
    events: [{ title: "Стоматолог", date_iso: "2026-11-10", time: "10:00" }],
    tasks: [{ title: "Вкрутить лампочку" }],
  }]);
  const r = await pipe.handle({ user: u, ...msg("купил лампочку, во вторник в 10 стоматолог, вкрутить", "3") });
  const ev = store.eventsBetween(u.id, "2026-11-10", "2026-11-10")[0];
  pipe.undo(u, r.messageId);
  assert.equal(store.diaryOf(u.id, "2026-11-08").length, 0);
  assert.equal(store.eventsBetween(u.id, "2026-11-10", "2026-11-10").length, 0);
  assert.equal(store.openTasks(u.id).length, 0);
  assert.equal(store.pendingReminders("event", ev.id).length, 0);
  assert.equal(pipe.undo(u, r.messageId), "Нечего отменять.");
});

test("неясное время — один вопрос, ответ дописывает исходное сообщение", async () => {
  const { store, u, pipe, calls } = setup([
    { clarify: "В 7 утра или вечера?" },
    { events: [{ title: "Тренировка", date_iso: "2026-11-09", time: "19:00" }], summary: "[14:30] завтра в 7 тренировка" },
  ]);
  const q = await pipe.handle({ user: u, ...msg("завтра в 7 тренировка", "4") });
  assert.match(q.text, /утра или вечера/);
  assert.equal(store.eventsBetween(u.id, "2026-11-09", "2026-11-09").length, 0);
  await pipe.handle({ user: u, ...msg("вечера", "5") });
  const evs = store.eventsBetween(u.id, "2026-11-09", "2026-11-09");
  assert.equal(evs.length, 1);
  assert.equal(evs[0].time, "19:00");
  assert.equal(evs[0].message_id, store.message(evs[0].message_id!)?.id);
  assert.match(calls[1].at(-1)!.content, /завтра в 7 тренировка[\s\S]*уточнение: вечера/);
  assert.equal(store.pendingClarify(u.id), undefined);
});

test("правка по номеру: перенос плана переставляет напоминание", async () => {
  const { store, u, pipe } = setup([
    { events: [{ title: "Созвон", date_iso: "2026-11-09", time: "12:00" }], summary: "s" },
    { edits: [{ action: "move", kind: "event", id: 1, new_date: "2026-11-11", new_time: "16:00" }], summary: "s" },
  ]);
  await pipe.handle({ user: u, ...msg("завтра в 12 созвон", "10") });
  await pipe.handle({ user: u, ...msg("созвон перенесли на среду 16:00", "11") });
  const ev = store.event(1)!;
  assert.equal(ev.date_iso, "2026-11-11");
  assert.equal(ev.time, "16:00");
  const rem = store.pendingReminders("event", 1);
  assert.equal(rem.length, 1);
  assert.equal(rem[0].due_at, zonedToUtc("2026-11-11", "15:00", TZ).toISOString());
});

test("ошибка модели — сообщение сохраняется, повтор доставки дообрабатывает", async () => {
  const { store, u, pipe } = setup([new Error("сеть"), { diary: [{ section: "health", text: "болит голова" }], summary: "s" }]);
  const r1 = await pipe.handle({ user: u, ...msg("болит голова", "20") });
  assert.equal(store.message(r1.messageId)?.state, "failed");
  await pipe.handle({ user: u, ...msg("болит голова", "20") });
  assert.equal(store.message(r1.messageId)?.state, "done");
  assert.equal(store.diaryOf(u.id, "2026-11-08").filter((d) => d.section === "health").length, 1);
});

test("годовая дата повторяется и напоминает за 7 дней один раз", async () => {
  const { store, u, pipe } = setup([{ dates: [{ title: "ДР мамы", date_iso: "1965-11-15", type: "birthday" }], summary: "s" }]);
  await pipe.handle({ user: u, ...msg("у мамы день рождения 15 ноября 1965", "30") });
  const up = upcomingDates(store.activeDates(u.id), "2026-11-08");
  assert.equal(up[0].on, "2026-11-15");
  assert.equal(up[0].inDays, 7);
  assert.equal(up[0].age, 61);
  assert.equal(nextYearly("2024-02-29", "2027-01-01"), "2027-02-28");

  const sent: string[] = [];
  const sch = new Scheduler(store, null, async (_u, text) => void sent.push(text));
  const morning = zonedToUtc("2026-11-08", "09:05", TZ);
  await sch.tick(morning);
  await sch.tick(morning);
  assert.equal(sent.filter((t) => t.startsWith("🎂") && t.includes("ДР мамы")).length, 1);
  assert.equal(sent.filter((t) => t.includes("Доброе утро")).length, 1);
});

test("напоминание за час приходит один раз; устаревшее после простоя — нет", async () => {
  const { store, u, pipe } = setup([
    { events: [{ title: "Врач", date_iso: "2026-11-08", time: "16:00" }], summary: "s" },
    { events: [{ title: "Кино", date_iso: "2026-11-08", time: "18:00" }], summary: "s" },
  ]);
  await pipe.handle({ user: u, ...msg("в 16 врач", "40") });
  await pipe.handle({ user: u, ...msg("в 18 кино", "41") });
  const sent: string[] = [];
  const sch = new Scheduler(store, null, async (_u, text) => void sent.push(text));
  await sch.tick(zonedToUtc("2026-11-08", "15:01", TZ));
  await sch.tick(zonedToUtc("2026-11-08", "15:02", TZ));
  assert.equal(sent.filter((t) => t.includes("Врач")).length, 1);
  await sch.tick(zonedToUtc("2026-11-08", "18:30", TZ)); // сервер спал с 15:02 до 18:30
  assert.equal(sent.filter((t) => t.includes("Кино")).length, 0);
});

test("игры: уведомление один раз на каждый новый полный час", async () => {
  const { store, u } = setup([]);
  const sent: string[] = [];
  const send = async (_u: unknown, text: string) => void sent.push(text);
  const day = (sec: number) => ({ day: "2026-11-08", source: "pc", active_sec: sec, afk_sec: 0, apps: [], games: [{ name: "dota2", sec }] });
  await recordActivity(store, u, day(1800), send);
  await recordActivity(store, u, day(3700), send);
  await recordActivity(store, u, day(3900), send);
  await recordActivity(store, u, day(9000), send);
  assert.deepEqual(sent.map((t) => t.match(/(\d+) ч/)?.[1]), ["1", "2"]);
});

test("код не верит модели: неверная дата плана — вопрос, «7» — не время, игры не в дневник", () => {
  const p = normalize(
    {
      diary: [{ section: "games", text: "3 часа доты" }, { section: "food", text: "суп" }],
      events: [{ title: "Встреча", date_iso: "2026-13-40", time: "15:00" }, { title: "Звонок", date_iso: "2026-11-09", time: "7" }],
    },
    { today: "2026-11-08", now: "14:30", text: "..." },
  );
  assert.deepEqual(p.diary.map((d) => d.section), ["food"]);
  assert.equal(p.events.length, 1);
  assert.equal(p.events[0].time, null);
  assert.match(p.clarify ?? "", /Встреча/);
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
});

test("«Это просто заметка» заменяет разбор записью целиком", async () => {
  const { store, u, pipe } = setup([{ tasks: [{ title: "Позвонить" }], summary: "s" }]);
  const r = await pipe.handle({ user: u, ...msg("надо бы позвонить, но это просто мысль", "50") });
  pipe.asNote(u, r.messageId, AT);
  assert.equal(store.openTasks(u.id).length, 0);
  const notes = store.diaryOf(u.id, "2026-11-08").filter((d) => d.section === "notes");
  assert.equal(notes[0]?.text, "надо бы позвонить, но это просто мысль");
});
