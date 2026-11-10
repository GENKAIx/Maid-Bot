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

async function setup(answers: (unknown | Error)[]) {
  const store = await Store.open(":memory:");
  const u = (await store.ensureUser("100", "Тест", TZ));
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
  const { store, u, pipe } = await setup([{
    diary: [{ section: "food", text: "овсянка с бананом" }],
    summary: "[14:30] Съел овсянку, завтра в 15 встреча с Петей",
    events: [{ title: "Встреча с Петей", date_iso: "2026-11-09", time: "15:00" }],
  }]);
  const r = await pipe.handle({ user: u, ...msg("Съел овсянку, завтра в 15 встреча с Петей", "1") });
  assert.equal((await store.diaryOf(u.id, "2026-11-08")).filter((d) => d.section === "food").length, 1);
  const evs = (await store.eventsBetween(u.id, "2026-11-09", "2026-11-09"));
  assert.equal(evs.length, 1);
  assert.equal(evs[0].time, "15:00");
  const rem = (await store.pendingReminders("event", evs[0].id));
  assert.equal(rem.length, 1);
  assert.equal(rem[0].due_at, zonedToUtc("2026-11-09", "14:00", TZ).toISOString());
  assert.ok(r.undoable);
  assert.match(r.text, /Еда/);
  assert.match(r.text, /планов: 1/);
  // Карточки «что куда записалось» для приложения.
  assert.deepEqual(r.changes?.map((c) => [c.kind, c.title]), [["diary", "Еда"], ["event", "Встреча с Петей"]]);
  assert.match(r.changes![1].detail ?? "", /9 ноября.*15:00/);
});

test("повторная доставка не дублирует записи и не зовёт модель", async () => {
  const { store, u, pipe, calls } = await setup([{ diary: [{ section: "sport", text: "пробежка 5 км" }], summary: "x" }]);
  await pipe.handle({ user: u, ...msg("пробежал 5 км", "7") });
  const again = await pipe.handle({ user: u, ...msg("пробежал 5 км", "7") });
  assert.equal(again.duplicate, true);
  assert.equal(calls.length, 1);
  assert.equal((await store.diaryOf(u.id, "2026-11-08")).filter((d) => d.section === "sport").length, 1);
});

test("«вчера» — во вчерашний день, дневник из будущего отбрасывается", async () => {
  const { store, u, pipe } = await setup([{
    date_iso: "2026-11-07",
    diary: [{ section: "sleep", text: "лёг в 2:00" }, { section: "mood", text: "отлично", day_iso: "2026-11-20" }],
    summary: "[14:30] вчера лёг в 2",
  }]);
  await pipe.handle({ user: u, ...msg("вчера лёг в 2", "2") });
  assert.equal((await store.diaryOf(u.id, "2026-11-07")).filter((d) => d.section === "sleep").length, 1);
  // Будущая дата раздела не принята — запись легла в день сообщения (2026-11-07), а не в 20-е.
  assert.equal((await store.diaryOf(u.id, "2026-11-20")).length, 0);
  assert.equal((await store.diaryOf(u.id, "2026-11-07")).filter((d) => d.section === "mood").length, 1);
});

test("отмена убирает всё, что сделало сообщение, и снимает напоминания", async () => {
  const { store, u, pipe } = await setup([{
    diary: [{ section: "notes", text: "купил лампочку" }],
    summary: "[14:30] купил лампочку",
    events: [{ title: "Стоматолог", date_iso: "2026-11-10", time: "10:00" }],
    tasks: [{ title: "Вкрутить лампочку" }],
  }]);
  const r = await pipe.handle({ user: u, ...msg("купил лампочку, во вторник в 10 стоматолог, вкрутить", "3") });
  const ev = (await store.eventsBetween(u.id, "2026-11-10", "2026-11-10"))[0];
  (await pipe.undo(u, r.messageId));
  assert.equal((await store.diaryOf(u.id, "2026-11-08")).length, 0);
  assert.equal((await store.eventsBetween(u.id, "2026-11-10", "2026-11-10")).length, 0);
  assert.equal((await store.openTasks(u.id)).length, 0);
  assert.equal((await store.pendingReminders("event", ev.id)).length, 0);
  assert.equal((await pipe.undo(u, r.messageId)), "Нечего отменять.");
});

test("неясное время — один вопрос, ответ дописывает исходное сообщение", async () => {
  const { store, u, pipe, calls } = await setup([
    { clarify: "В 7 утра или вечера?" },
    { events: [{ title: "Тренировка", date_iso: "2026-11-09", time: "19:00" }], summary: "[14:30] завтра в 7 тренировка" },
  ]);
  const q = await pipe.handle({ user: u, ...msg("завтра в 7 тренировка", "4") });
  assert.match(q.text, /утра или вечера/);
  assert.equal((await store.eventsBetween(u.id, "2026-11-09", "2026-11-09")).length, 0);
  await pipe.handle({ user: u, ...msg("вечера", "5") });
  const evs = (await store.eventsBetween(u.id, "2026-11-09", "2026-11-09"));
  assert.equal(evs.length, 1);
  assert.equal(evs[0].time, "19:00");
  assert.equal(evs[0].message_id, (await store.message(evs[0].message_id!))?.id);
  assert.match(calls[1].at(-1)!.content, /завтра в 7 тренировка[\s\S]*уточнение: вечера/);
  assert.equal((await store.pendingClarify(u.id)), undefined);
});

test("правка по номеру: перенос плана переставляет напоминание", async () => {
  const { store, u, pipe } = await setup([
    { events: [{ title: "Созвон", date_iso: "2026-11-09", time: "12:00" }], summary: "s" },
    { edits: [{ action: "move", kind: "event", id: 1, new_date: "2026-11-11", new_time: "16:00" }], summary: "s" },
  ]);
  await pipe.handle({ user: u, ...msg("завтра в 12 созвон", "10") });
  await pipe.handle({ user: u, ...msg("созвон перенесли на среду 16:00", "11") });
  const ev = (await store.event(1))!;
  assert.equal(ev.date_iso, "2026-11-11");
  assert.equal(ev.time, "16:00");
  const rem = (await store.pendingReminders("event", 1));
  assert.equal(rem.length, 1);
  assert.equal(rem[0].due_at, zonedToUtc("2026-11-11", "15:00", TZ).toISOString());
});

test("ошибка модели — сообщение сохраняется, повтор доставки дообрабатывает", async () => {
  const { store, u, pipe } = await setup([new Error("сеть"), { diary: [{ section: "health", text: "болит голова" }], summary: "s" }]);
  const r1 = await pipe.handle({ user: u, ...msg("болит голова", "20") });
  assert.equal((await store.message(r1.messageId))?.state, "failed");
  await pipe.handle({ user: u, ...msg("болит голова", "20") });
  assert.equal((await store.message(r1.messageId))?.state, "done");
  assert.equal((await store.diaryOf(u.id, "2026-11-08")).filter((d) => d.section === "health").length, 1);
});

test("годовая дата повторяется и напоминает за 7 дней один раз", async () => {
  const { store, u, pipe } = await setup([{ dates: [{ title: "ДР мамы", date_iso: "1965-11-15", type: "birthday" }], summary: "s" }]);
  await pipe.handle({ user: u, ...msg("у мамы день рождения 15 ноября 1965", "30") });
  const up = upcomingDates((await store.activeDates(u.id)), "2026-11-08");
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
  const { store, u, pipe } = await setup([
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

test("игры: первое уведомление на 2 ч, дальше каждые 2 ч, каждое один раз", async () => {
  const { store, u } = await setup([]);
  const sent: string[] = [];
  const send = async (_u: unknown, text: string) => void sent.push(text);
  const day = (sec: number) => ({ day: "2026-11-08", source: "pc", active_sec: sec, afk_sec: 0, apps: [], games: [{ name: "dota2", sec }] });
  await recordActivity(store, u, day(1800), send);
  await recordActivity(store, u, day(3700), send);
  await recordActivity(store, u, day(3900), send);
  await recordActivity(store, u, day(7300), send);
  await recordActivity(store, u, day(9000), send);
  await recordActivity(store, u, day(14500), send);
  await recordActivity(store, u, day(14600), send);
  assert.deepEqual(sent.map((t) => t.match(/(\d+) ч/)?.[1]), ["2", "4"]);
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

test("дело со временем в названии — план с напоминанием, а не задача", () => {
  const p = normalize(
    {
      tasks: [
        { title: "Озон в 20:00" },
        { title: "Забрать посылку 9.30" },
        { title: "Сдать отчёт к 18:00", due_date: "2026-11-10" },
        { title: "Купить лампочку" },
        { title: "Позвонить в 7" },
      ],
    },
    { today: "2026-11-08", now: "14:30", text: "..." },
  );
  assert.deepEqual(p.events.map((e) => [e.title, e.date, e.time]), [
    ["Озон", "2026-11-08", "20:00"],
    ["Забрать посылку", "2026-11-09", "09:30"],
    ["Сдать отчёт", "2026-11-10", "18:00"],
  ]);
  assert.deepEqual(p.tasks.map((t) => t.title), ["Купить лампочку", "Позвонить в 7"]);
});

test("вопрос по записям: поиск за всё время, точные суммы денег, ссылки на дни", async () => {
  const { store, u, calls } = await setup([]);
  await store.addDiary(u.id, "2026-03-14", "health", "кололо сердце после бега", null, "heart");
  await store.addDiary(u.id, "2026-10-02", "health", "Сердце снова шалило вечером", null, "heart");
  await store.addDiary(u.id, "2026-10-05", "health", "болела голова", null, "head");
  for (const [d, a, c] of [["2026-10-03", 500, "еда"], ["2026-10-20", 1250.5, "еда"], ["2026-10-21", 3000, "такси"], ["2026-11-01", 999, "еда"]] as const) {
    await store.addMoney({ user_id: u.id, day_key: d, kind: "expense", amount: a, currency: "RUB", category: c, note: "", message_id: null });
  }
  const answers: unknown[] = [
    { question: "когда болело сердце?", search: ["сердц"], lookup: null },
    "Сердце болело 2026-03-14 и 2026-10-02.",
    { question: "сколько потратил на еду в октябре?", lookup: { from: "2026-10-01", to: "2026-10-31" } },
    "На еду в октябре ушло 1 750,5 RUB.",
  ];
  const llm: LlmCall = async (m) => { calls.push(m); const a = answers.shift(); return typeof a === "string" ? a : JSON.stringify(a); };
  const pipe = new Pipeline(store, llm, "http://maid.test");

  const r = await pipe.handle({ user: u, ...msg("когда болело сердце?", "q1") });
  const data = calls[1][0].content;
  assert.match(data, /2026-03-14 .*кололо сердце/);
  assert.match(data, /2026-10-02 .*Сердце снова/);
  assert.doesNotMatch(data, /болела голова/);
  assert.deepEqual(r.days, ["2026-03-14", "2026-10-02"]);
  assert.match(r.text, /Сердце болело 14 марта и 2 октября\./);
  assert.match(r.text, /<a href="http:\/\/maid\.test\/diary\/2026-10-02">2 октября<\/a>/);

  await pipe.handle({ user: u, ...msg("сколько потратил на еду в октябре?", "q2") });
  const totals = calls[3][0].content;
  assert.match(totals, /Расход всего 4[\s ]750,5 RUB; по категориям: такси 3[\s ]000, еда 1[\s ]750,5/);
});

test("«Это просто заметка» заменяет разбор записью целиком", async () => {
  const { store, u, pipe } = await setup([{ tasks: [{ title: "Позвонить" }], summary: "s" }]);
  const r = await pipe.handle({ user: u, ...msg("надо бы позвонить, но это просто мысль", "50") });
  (await pipe.asNote(u, r.messageId, AT));
  assert.equal((await store.openTasks(u.id)).length, 0);
  const notes = (await store.diaryOf(u.id, "2026-11-08")).filter((d) => d.section === "notes");
  assert.equal(notes[0]?.text, "надо бы позвонить, но это просто мысль");
});

test("рассказ о распорядке — дневник сразу, привычки только по кнопке", async () => {
  const { store, u, pipe } = await setup([
    {
      diary: [{ section: "notes", text: "перед сном читаю и чищу зубы" }],
      summary: "[14:30] Перед сном читаю и чищу зубы",
      suggest_habits: [{ title: "Читать перед сном", days: "1234567", times: [] }, { title: "Чистить зубы", days: "1234567", times: [] }],
      suggest_remind: { label: "Напоминать перед сном", time: "22:30" },
    },
    {
      diary: [{ section: "notes", text: "по утрам кофе" }],
      summary: "[14:31] По утрам пью кофе",
      suggest_habits: [{ title: "Кофе утром", days: "1234567", times: [] }],
    },
    { summary: "[14:32] просто так" },
  ]);
  const closed: string[] = [];
  pipe.onProposal = async (_u, _p, _text, outcome) => void closed.push(outcome);
  const r = await pipe.handle({ user: u, ...msg("Перед сном я читаю и чищу зубы", "p1") });
  assert.equal((await store.activeHabits(u.id)).length, 0);
  assert.match(r.text, /Хочешь отслеживать как привычки\?/);
  assert.deepEqual(r.proposal?.items.map((i) => i.title), ["Читать перед сном", "Чистить зубы"]);
  assert.equal(r.proposal?.remind?.time, "22:30");
  // Снять галочку со второго — добавится только первый, с напоминанием.
  await pipe.toggleProposal(u, r.proposal!.id, 1);
  const ok = await pipe.decideProposal(u, r.proposal!.id, "remind");
  assert.ok(ok.done);
  const hs = await store.activeHabits(u.id);
  assert.deepEqual(hs.map((h) => [h.title, h.times, h.quiet]), [["Читать перед сном", '["22:30"]', 0]]);
  assert.match(closed[0], /напомню в 22:30/);
  // Повторный ответ ничего не создаёт.
  assert.equal((await pipe.decideProposal(u, r.proposal!.id, "add")).done, false);
  // «Отменить» сообщения убирает и добавленную по кнопке привычку.
  await pipe.undo(u, r.messageId);
  assert.equal((await store.activeHabits(u.id)).length, 0);

  // Не ответил, а написал дальше — вопрос закрывается и ничего не создаёт.
  const r2 = await pipe.handle({ user: u, ...msg("По утрам пью кофе", "p2") });
  assert.match(r2.text, /как привычку\?/);
  await pipe.handle({ user: u, ...msg("просто так", "p3") });
  assert.equal((await store.proposal(r2.proposal!.id))?.status, "expired");
  assert.equal(closed.at(-1), "Не стала добавлять в привычки.");
  assert.match((await store.message(r2.messageId))?.reply ?? "", /Не стала добавлять в привычки\.$/);
  assert.equal((await store.activeHabits(u.id)).length, 0);
});

test("«Добавить в привычки» — в список без напоминаний; вопрос истекает через сутки", async () => {
  const { store, u, pipe } = await setup([
    { summary: "[14:30] вечером гуляю", suggest_habits: [{ title: "Прогулка", days: "1234567", times: ["20:00"] }] },
    { summary: "[14:31] надо бы как-нибудь", suggest_tasks: [{ title: "Разобрать балкон" }] },
  ]);
  const r = await pipe.handle({ user: u, ...msg("Вечером я гуляю", "q1") });
  await pipe.decideProposal(u, r.proposal!.id, "add");
  const [h] = await store.activeHabits(u.id);
  assert.deepEqual([h.title, h.times, h.quiet], ["Прогулка", "[]", 1]);
  const r2 = await pipe.handle({ user: u, ...msg("Надо бы как-нибудь разобрать балкон", "q2") });
  assert.equal(r2.proposal?.add, "Добавить в задачи");
  await pipe.sweepProposals(new Date(Date.now() + 25 * 60 * 60_000));
  assert.equal((await store.proposal(r2.proposal!.id))?.status, "expired");
  assert.equal((await store.openTasks(u.id)).length, 0);
});
