import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApi } from "../src/api.ts";
import { hashPassword } from "../src/auth.ts";
import { Store } from "../src/db.ts";
import type { ChatMessage, LlmCall, UsageKind } from "../src/llm.ts";
import { persona } from "../src/personas.ts";
import { Pipeline, type CorrectReply } from "../src/pipeline.ts";
import { zonedToUtc } from "../src/time.ts";

// Поправка к ответу (correct.ts, Pipeline.correct, POST /api/correct): «не в 15, а в 17», «это еда, а не транспорт» меняют
// только записи этого ответа; модель видит только их; неверное значение — вопрос без записи; вид записи не меняется;
// журнал — под исходным сообщением, одна «Отменить» убирает ответ вместе с поправками. Всё без сети: LLM — заготовки.

const TZ = "Europe/Moscow";
const AT = zonedToUtc("2026-11-08", "14:30", TZ); // воскресенье, 14:30 по Москве

async function setup(answers: unknown[]) {
  const store = await Store.open(":memory:");
  const u = await store.ensureUser("100", "Тест", TZ);
  const calls: ChatMessage[][] = [];
  const kinds: (UsageKind | undefined)[] = [];
  const llm: LlmCall = async (messages, opts) => {
    calls.push(messages);
    kinds.push(opts?.kind);
    const a = answers.shift();
    if (a instanceof Error) throw a;
    return typeof a === "string" ? a : JSON.stringify(a ?? {});
  };
  const pipe = new Pipeline(store, llm);
  const say = (text: string, id: string) => pipe.handle({ user: u, source: "telegram", sourceId: id, text, at: AT });
  const fix = async (messageId: number, text: string, id: string) => (await pipe.correct(u, messageId, text, { sourceId: id, at: AT }))!;
  return { store, u, calls, kinds, pipe, say, fix };
}
const meeting = (time = "15:00", end: string | null = null) =>
  ({ summary: "[14:30] встреча", events: [{ title: "Встреча с Петей", date_iso: "2026-11-09", time, end_time: end }] });

test("«не в 15, а в 17»: план переезжает с той же длительностью, напоминания заново, карточки ответа с ref", async () => {
  const { store, u, calls, kinds, say, fix } = await setup([
    { diary: [{ section: "food", text: "овсянка с бананом" }], ...meeting("15:00", "16:00") },
    { edits: [{ ref: "r2", set: { time: "17:00" } }], reply: "Перенесла на 17:00.", emotion: "proud" },
  ]);
  const r = await say("Съел овсянку, завтра с 15 до 16 встреча с Петей", "1");
  const [ev] = await store.eventsBetween(u.id, "2026-11-09", "2026-11-09");
  const food = (await store.diaryOf(u.id, "2026-11-08")).find((d) => d.section === "food")!;
  // Ответ разбора (и /api/input): у карточек — ссылка на запись.
  assert.deepEqual(r.changes?.map((c) => c.ref), [{ tbl: "diary", id: food.id }, { tbl: "events", id: ev.id }]);

  const c = await fix(r.messageId, "не в 15, а в 17", "c1");
  const now = (await store.event(ev.id))!;
  assert.equal(now.time, "17:00");
  assert.equal(now.end_time, "18:00", "конец не назван — длительность та же");
  assert.deepEqual((await store.pendingReminders("event", ev.id)).map((x) => x.due_at).sort(), [
    zonedToUtc("2026-11-09", "16:00", TZ).toISOString(), zonedToUtc("2026-11-09", "17:00", TZ).toISOString(),
  ], "старые напоминания сняты, новые — за час и в момент начала");
  assert.equal(c.messageId, r.messageId, "отмена — у исходного ответа");
  assert.equal(c.undoable, true);
  assert.deepEqual(c.changed, [`events:${ev.id}`]);
  assert.equal(c.emotion, "proud");
  // Все карточки ответа из базы, тем же построителем: неизменённая — та же, у плана — новое время.
  assert.deepEqual(c.changes.map((x) => x.ref), r.changes!.map((x) => x.ref));
  assert.deepEqual(c.changes[0], r.changes![0]);
  assert.equal(c.changes[1].detail, r.changes![1].detail!.replace("15:00", "17:00"));
  assert.match(c.text, /Перенесла на 17:00\./);
  assert.match(c.text, /✎ Встреча с Петей: 9 ноября, Пн 15:00 → 9 ноября, Пн 17:00/);

  // Запрос к модели: голос характера, «сегодня» как у разбора, исходное сообщение, записи r1..rn — и больше ничего.
  assert.equal(kinds[1], "correct");
  assert.equal(calls[1].length, 2, "без истории разговора");
  const sys = calls[1][0].content;
  assert.ok(sys.startsWith(persona(u.persona).voice));
  assert.match(sys, /Сегодня 2026-11-08 \(воскресенье\), сейчас 14:30, часовой пояс Europe\/Moscow\./);
  assert.match(sys, /Вчера = 2026-11-07, завтра = 2026-11-09, послезавтра = 2026-11-10\./);
  assert.match(sys, /Съел овсянку, завтра с 15 до 16 встреча с Петей/);
  assert.match(sys, /r1 дневник: \{"section":"food","text":"овсянка с бананом","day_key":"2026-11-08"\}/);
  assert.match(sys, /r2 план: \{"title":"Встреча с Петей","date_iso":"2026-11-09","time":"15:00","end_time":"16:00","details":""\}/);
  assert.doesNotMatch(sys, /\[14:30\] встреча/, "хроника дня — не запись для поправки");
  assert.equal(calls[1][1].content, "не в 15, а в 17");
});

test("деньги: «это еда, а не транспорт» и «сумма 540»; одна «Отменить» убирает трату вместе с поправками", async () => {
  const { store, u, pipe, say, fix } = await setup([
    { money: [{ kind: "expense", amount: 450, currency: "RUB", category: "транспорт", note: "шаурма" }], summary: "s" },
    { edits: [{ ref: "r1", set: { category: "Еда" } }], reply: "Поправила категорию." },
    { edits: [{ ref: "r1", set: { amount: "540" } }] },
  ]);
  const r = await say("потратил 450 на шаурму", "1");
  const id = r.changes![0].ref!.id;
  assert.equal(r.changes![0].detail, "−450 RUB — транспорт, шаурма");

  const c1 = await fix(r.messageId, "это еда, а не транспорт", "c1");
  assert.equal((await store.money(id))!.category, "еда");
  assert.equal(c1.changes[0].detail, "−450 RUB — еда, шаурма");
  assert.deepEqual(c1.changed, [`money:${id}`]);

  const c2 = await fix(r.messageId, "сумма 540", "c2");
  assert.equal((await store.money(id))!.amount, 540);
  assert.match(c2.text, /^Поправила\.\n✎ шаурма: −450 RUB — еда, шаурма → −540 RUB — еда, шаурма$/);

  // Журнал — под исходным сообщением: две поправки, трата и хроника дня.
  assert.deepEqual((await store.actionsOf(r.messageId)).map((a) => a.kind), ["edit", "edit", "add", "add"]);
  // «/undo» без номера берёт исходный ответ: у служебного сообщения поправки своих действий нет.
  assert.equal((await store.lastDoneMessage(u.id))!.id, r.messageId);
  await pipe.undo(u);
  const row = (await store.money(id))!;
  assert.equal(row.deleted, 1, "трата убрана");
  assert.deepEqual([row.amount, row.category], [450, "транспорт"], "поправки откатились по порядку, от новой к старой");
  assert.deepEqual(await store.moneyRange(u.id, "2026-11-01", "2026-11-30"), []);
  assert.equal(await pipe.undo(u), "Нечего отменять.", "ничего не воскресло и не осталось");
});

test("план: две поправки и отмена ответа — плана нет, напоминаний нет", async () => {
  const { store, u, pipe, say, fix } = await setup([
    meeting(),
    { edits: [{ ref: "r1", set: { time: "17:00" } }] },
    { edits: [{ ref: "r1", set: { date_iso: "2026-11-10" } }] },
  ]);
  const r = await say("завтра в 15 встреча с Петей", "1");
  const id = r.changes![0].ref!.id;
  await fix(r.messageId, "не в 15, а в 17", "c1");
  await fix(r.messageId, "на послезавтра", "c2");
  assert.deepEqual([(await store.event(id))!.date_iso, (await store.event(id))!.time], ["2026-11-10", "17:00"]);
  await pipe.undo(u, r.messageId);
  const ev = (await store.event(id))!;
  assert.equal(ev.status, "deleted");
  assert.deepEqual([ev.date_iso, ev.time], ["2026-11-09", "15:00"], "поправки откатились до записи");
  assert.deepEqual(await store.pendingReminders("event", id), []);
});

test("только записи этого ответа: модель не видит других, чужой номер — ничего не меняется", async () => {
  const { store, u, calls, say, fix } = await setup([
    { events: [{ title: "Стоматолог", date_iso: "2026-11-10", time: "10:00" }], summary: "s" },
    { tasks: [{ title: "Купить лампочку" }], summary: "s" },
    { edits: [{ ref: "r7", set: { time: "17:00" } }, { ref: "Стоматолог", set: { time: "17:00" } }], reply: "Перенесла!" },
  ]);
  await store.addMemory(u.id, "person", "Кот", "Кота зовут Барсик", null);
  await say("во вторник в 10 стоматолог", "1");
  const b = await say("надо купить лампочку", "2");
  const c = await fix(b.messageId, "не в 10, а в 17", "c1");
  const sys = calls[2][0].content;
  assert.match(sys, /r1 задача: \{"title":"Купить лампочку"/);
  assert.doesNotMatch(sys, /Стоматолог|Барсик/, "других записей и памяти в запросе нет");
  assert.doesNotMatch(sys, /r2/);
  assert.equal(calls[2].length, 2, "истории разговора нет — в ней чужие записи");
  const [ev] = await store.eventsBetween(u.id, "2026-11-10", "2026-11-10");
  assert.equal(ev.time, "10:00");
  assert.deepEqual(c.changed, []);
  assert.doesNotMatch(c.text, /Перенесла/, "ничего не поменялось — не говорит, что поменяла");
  assert.match(c.text, /Не поняла, что поправить/);
  assert.equal(c.clarify, true);
});

test("неверное значение — вопрос и никакой записи, даже если другое поле верное", async () => {
  const { store, say, fix } = await setup([
    { ...meeting(), money: [{ kind: "expense", amount: 300, category: "кафе", note: "кофе" }] },
    { edits: [{ ref: "r1", set: { time: "51:00" } }], reply: "Готово!" },
    { edits: [{ ref: "r1", set: { time: "17:00" } }, { ref: "r2", set: { category: "космос" } }] },
  ]);
  const r = await say("завтра в 15 встреча с Петей, кофе 300", "1");
  const [evRef, moneyRef] = r.changes!.map((x) => x.ref!);
  const c = await fix(r.messageId, "не в 15, а в 51", "c1");
  assert.match(c.text, /^51 — такого часа нет\. Во сколько поставить\?$/);
  assert.equal(c.clarify, true);
  assert.deepEqual(c.changed, []);
  assert.equal((await store.event(evRef.id))!.time, "15:00");

  const c2 = await fix(r.messageId, "в 17, и это не кафе, а космос", "c2");
  assert.match(c2.text, /Категории «космос» у меня нет/);
  assert.equal((await store.event(evRef.id))!.time, "15:00", "верная часть тоже не записана");
  assert.equal((await store.money(moneyRef.id))!.category, "кафе");
  assert.ok((await store.actionsOf(r.messageId)).every((a) => a.kind === "add"), "в журнале — только записи ответа");
});

test("чего поправка не умеет (привычка, память) — честный ответ и «Отменить», ничего не записано", async () => {
  const { store, u, say, fix } = await setup([
    meeting(),
    { unsupported: true, reply: "Сделала привычкой!", edits: [{ ref: "r1", set: { time: "17:00" } }], remove: ["r1"] },
  ]);
  const r = await say("завтра в 15 встреча с Петей", "1");
  const c = await fix(r.messageId, "сделай это привычкой", "c1");
  assert.match(c.text, /не умею/);
  assert.match(c.text, /«↩ Отменить»/);
  assert.doesNotMatch(c.text, /Сделала/);
  assert.deepEqual(c.changed, []);
  const ev = (await store.event(r.changes![0].ref!.id))!;
  assert.deepEqual([ev.time, ev.status], ["15:00", "active"]);
  assert.equal((await store.openTasks(u.id)).length, 0);
});

test("«в задачи не надо»: задача убрана, трата осталась; карточки — без задачи; «Отменить» убирает и трату", async () => {
  const { store, u, calls, pipe, say, fix } = await setup([
    {
      summary: "s",
      tasks: [{ title: "Забрать гель из пункта Ozon" }],
      money: [{ kind: "expense", amount: 1097, currency: "RUB", category: "дом", note: "Ozon, гель для стирки" }],
    },
    { remove: ["r1"], reply: "Убрала из задач, трату оставила.", emotion: "neutral" },
  ]);
  const r = await say("заказал гель для стирки на озоне 1097, надо забрать", "1");
  const [task, money] = r.changes!.map((x) => x.ref!);
  assert.deepEqual([task.tbl, money.tbl], ["tasks", "money"]);

  const c = await fix(r.messageId, "в задачи добавлять не надо", "c1");
  assert.equal((await store.task(task.id))!.status, "deleted");
  assert.equal((await store.money(money.id))!.deleted, 0);
  assert.deepEqual(c.changes.map((x) => x.ref), [money], "карточка задачи ушла, трата — на месте");
  assert.deepEqual(c.changed, []);
  assert.match(c.text, /^Убрала из задач, трату оставила\.\n✕ Забрать гель из пункта Ozon — убрала$/);
  assert.equal((await store.openTasks(u.id)).length, 0);
  assert.match(calls[1][0].content, /"remove"/, "модели объяснено, как убрать запись");

  await pipe.undo(u);
  assert.equal((await store.task(task.id))!.status, "deleted", "отмена ответа убирает задачу и после возврата из поправки");
  assert.equal((await store.money(money.id))!.deleted, 1);
  assert.equal(await pipe.undo(u), "Нечего отменять.");
});

test("убрать: каждое — по-своему (план без напоминаний, дневник, деньги, заметка, дата); все убраны — поправлять нечего", async () => {
  const { store, say, fix } = await setup([
    {
      ...meeting(), diary: [{ section: "food", text: "овсянка" }],
      money: [{ kind: "expense", amount: 300, category: "еда", note: "кофе" }],
      stash: [{ shelf: "movies", title: "Дюна" }], dates: [{ title: "ДР мамы", date_iso: "2026-12-01", type: "birthday" }],
    },
    { remove: ["r1", "r2", "r3", "r4", "r5"] },
  ]);
  const r = await say("всё сразу", "1");
  const refs = r.changes!.map((x) => x.ref!);
  assert.deepEqual(refs.map((x) => x.tbl), ["diary", "events", "notes", "dates", "money"]);
  const ev = refs[1].id;
  assert.ok((await store.pendingReminders("event", ev)).length > 0);
  const c = await fix(r.messageId, "ничего этого не записывай", "c1");
  assert.equal(c.text.split("\n").filter((l) => l.startsWith("✕")).length, 5);
  assert.match(c.text, /^Убрала\.\n/, "своей реплики нет — нейтральная");
  assert.deepEqual(c.changes, []);
  assert.equal((await store.diaryRow(refs[0].id))!.deleted, 1);
  assert.equal((await store.event(ev))!.status, "deleted");
  assert.deepEqual(await store.pendingReminders("event", ev), [], "напоминания сняты");
  assert.equal((await store.note(refs[2].id))!.status, "deleted");
  assert.equal((await store.date(refs[3].id))!.status, "deleted");
  assert.equal((await store.money(refs[4].id))!.deleted, 1);
  const again = await fix(r.messageId, "не в 15, а в 17", "c2");
  assert.match(again.text, /Записей этого ответа уже нет/);
});

test("«это задача, а не план»: план убран (без напоминаний), задача записана под тем же ответом; «Отменить» убирает её", async () => {
  const { store, u, pipe, say, fix } = await setup([
    meeting(),
    { remove: ["r1"], add: { tasks: [{ title: "Встреча с Петей", due_date: "2026-11-09", priority: "normal" }] }, reply: "Сделала задачей." },
  ]);
  const r = await say("завтра в 15 встреча с Петей", "1");
  const ev = r.changes![0].ref!.id;
  const c = await fix(r.messageId, "это задача, а не план", "c1");
  assert.equal((await store.event(ev))!.status, "deleted");
  assert.deepEqual(await store.pendingReminders("event", ev), []);
  const [t] = await store.openTasks(u.id);
  assert.deepEqual([t.title, t.due_date, t.message_id], ["Встреча с Петей", "2026-11-09", r.messageId]);
  assert.deepEqual(c.changes.map((x) => x.ref), [{ tbl: "tasks", id: t.id }]);
  assert.deepEqual(c.changed, [`tasks:${t.id}`]);
  assert.match(c.text, /^Сделала задачей\.\n✕ Встреча с Петей — убрала\n＋ Встреча с Петей/);

  await pipe.undo(u);
  assert.equal((await store.task(t.id))!.status, "deleted");
  assert.equal((await store.event(ev))!.status, "deleted");
  assert.equal(await pipe.undo(u), "Нечего отменять.");
});

test("сменить вид: трата → дневник, задача → заметка на полку; новую запись следующая поправка видит и правит", async () => {
  const { store, u, calls, say, fix } = await setup([
    { summary: "s", tasks: [{ title: "Посмотреть Дюну" }], money: [{ kind: "expense", amount: 500, category: "еда", note: "ужин" }] },
    { remove: ["r2"], add: { diary: [{ section: "food", text: "ужин в кафе" }] } },
    { remove: ["r1"], add: { stash: [{ shelf: "movies", title: "Дюна" }] } },
    { edits: [{ ref: "r2", set: { title: "Дюна 2" } }] },
  ]);
  const r = await say("надо посмотреть дюну, ужин 500", "1");
  const [task, money] = r.changes!.map((x) => x.ref!);
  await fix(r.messageId, "ужин — это в дневник, а не трата", "c1");
  assert.equal((await store.money(money.id))!.deleted, 1);
  const food = (await store.diaryOf(u.id, "2026-11-08")).find((d) => d.section === "food")!;
  assert.equal(food.text, "ужин в кафе");
  const c2 = await fix(r.messageId, "дюну — на полку фильмов, не в задачи", "c2");
  assert.equal((await store.task(task.id))!.status, "deleted");
  const note = (await store.notesOf(u.id)).find((n) => n.title === "Дюна")!;
  assert.deepEqual(c2.changes.map((x) => x.ref), [{ tbl: "diary", id: food.id }, { tbl: "notes", id: note.id }]);
  await fix(r.messageId, "назови Дюна 2", "c3");
  const sys = calls[3][0].content;
  assert.match(sys, /r1 дневник: \{"section":"food","text":"ужин в кафе"/);
  assert.match(sys, /r2 заметка «на потом»: \{"shelf":"film","title":"Дюна"/);
  assert.doesNotMatch(sys, /^r\d+ (задача|деньги):/m, "убранных записей модель не видит");
  assert.equal((await store.note(note.id))!.title, "Дюна 2");
});

test("новая запись без нужного (план без дня) — вопрос, и ничего не убрано; номер мимо в remove — не поняла", async () => {
  const { store, u, say, fix } = await setup([
    { summary: "s", tasks: [{ title: "Позвонить маме" }] },
    { remove: ["r1"], add: { events: [{ title: "Позвонить маме", time: "18:00" }] } },
    { remove: ["r7"] },
  ]);
  const r = await say("надо позвонить маме", "1");
  const t = r.changes![0].ref!.id;
  const c = await fix(r.messageId, "это план на 18", "c1");
  assert.equal(c.clarify, true);
  assert.match(c.text, /На какой день «Позвонить маме»\?/);
  assert.equal((await store.task(t))!.status, "open");
  assert.deepEqual(await store.eventsBetween(u.id, "2026-11-01", "2026-12-31"), []);
  const c2 = await fix(r.messageId, "убери вторую", "c2");
  assert.equal(c2.text, "Не поняла, что поправить в этом ответе. Скажите иначе — например, «не в 15, а в 17».");
  assert.equal((await store.task(t))!.status, "open");
  assert.ok((await store.actionsOf(r.messageId)).every((a) => a.kind === "add"), "ни одной поправки в журнале");
});

test("в ответе нечего поправить — честно и без запроса к модели", async () => {
  const { calls, say, fix } = await setup([
    { summary: "[14:30] привет", reply: "Привет!" },
    { habits: [{ title: "Зарядка", days: "1234567", times: ["08:00"] }], summary: "s" },
  ]);
  const chat = await say("привет", "1");
  const c = await fix(chat.messageId, "не в 15, а в 17", "c1");
  assert.match(c.text, /нет записей — поправлять нечего/);
  assert.deepEqual([c.changes, c.changed], [[], []]);
  const habit = await say("хочу каждый день зарядку в 8", "2");
  const c2 = await fix(habit.messageId, "не в 8, а в 9", "c2");
  assert.match(c2.text, /поправкой не поменять/);
  assert.deepEqual(c2.changes.map((x) => x.kind), ["habit"], "карточка привычки — та же, с ref");
  assert.deepEqual(c2.changes[0], habit.changes![0]);
  assert.equal(calls.length, 2, "модель не спрашивали");
});

test("«в 7» — горничная переспрашивает; уточнение разбора при этом не ждёт", async () => {
  const { store, u, calls, say, fix } = await setup([
    meeting(),
    { clarify: "В 7 утра или вечера?", edits: [{ ref: "r1", set: { time: "07:00" } }] },
    { summary: "s", diary: [{ section: "notes", text: "купил хлеб" }] },
  ]);
  const r = await say("завтра в 15 встреча с Петей", "1");
  const c = await fix(r.messageId, "не в 15, а в 7", "c1");
  assert.equal(c.text, `${persona(u.persona).clarify} В 7 утра или вечера?`);
  assert.equal(c.clarify, true);
  assert.equal((await store.event(r.changes![0].ref!.id))!.time, "15:00");
  assert.equal(await store.pendingClarify(u.id), undefined, "служебное сообщение поправки не ждёт ответа разбора");
  await say("купил хлеб", "2");
  assert.equal(calls[2].at(-1)!.content, "купил хлеб", "следующее сообщение — обычное, не ответ на уточнение");
});

test("повтор поправки с тем же id — тот же итог, без второй записи и запроса", async () => {
  const { store, calls, say, fix } = await setup([meeting(), { edits: [{ ref: "r1", set: { time: "17:00" } }], reply: "Перенесла." }]);
  const r = await say("завтра в 15 встреча с Петей", "1");
  const a = await fix(r.messageId, "не в 15, а в 17", "same");
  const b = await fix(r.messageId, "не в 15, а в 17", "same");
  assert.equal(b.duplicate, true);
  assert.equal(b.text, a.text);
  assert.deepEqual(b.changed, a.changed);
  assert.deepEqual(b.changes, a.changes);
  assert.equal(calls.length, 2);
  assert.deepEqual((await store.actionsOf(r.messageId)).map((a) => a.kind), ["edit", "add", "add"], "одна поправка, план и хроника дня");
});

test("поправка — в истории разговора; поправка через id ответа на уточнение и через саму поправку — к тому же ответу", async () => {
  const { store, u, calls, say, fix } = await setup([
    { clarify: "В 7 утра или вечера?", events: [{ title: "Пробежка", date_iso: "2026-11-09", time: "07:00" }] },
    { events: [{ title: "Пробежка", date_iso: "2026-11-09", time: "19:00" }], summary: "s" },
    { edits: [{ ref: "r1", set: { time: "20:00" } }], reply: "Сдвинула." },
    { edits: [{ ref: "r1", set: { time: "20:30" } }] },
    { summary: "s" },
  ]);
  const q = await say("завтра в 7 пробежка", "1");
  const r = await say("вечера", "2");
  assert.equal(r.messageId, q.messageId, "ответ — у исходного сообщения");
  const clarifyMsg = (await store.recentMessages(u.id, 5)).find((m) => m.reply === "(уточнение)")!;
  const c = await fix(clarifyMsg.id, "не в 19, а в 20", "c1");
  assert.equal(c.messageId, q.messageId);
  const id = c.changes[0].ref!.id;
  assert.equal((await store.event(id))!.time, "20:00");
  const service = (await store.recentMessages(u.id, 5)).find((m) => m.text.startsWith("✎ Поправка"))!;
  const c2 = await fix(service.id, "в 20:30", "c2");
  assert.equal(c2.messageId, q.messageId);
  assert.equal((await store.event(id))!.time, "20:30");
  await say("ок", "3");
  const history = calls[4].map((m) => m.content).join("\n");
  assert.match(history, /✎ Поправка: не в 19, а в 20/);
  assert.match(history, /Сдвинула\./);
});

test("поправленный план лёг на занятое время — вопрос «Сдвинуть?», а занятый план модель не видела", async () => {
  const { store, u, calls, say, fix } = await setup([meeting(), { edits: [{ ref: "r1", set: { time: "17:00" } }] }]);
  await store.addEvent({ user_id: u.id, title: "Йога", date_iso: "2026-11-09", time: "17:00", end_time: "18:00", details: "", domain: "life", message_id: null });
  const r = await say("завтра в 15 встреча с Петей", "1");
  const c = await fix(r.messageId, "не в 15, а в 17", "c1");
  assert.equal(c.clash?.withTitle, "Йога");
  assert.equal(c.clash?.shiftTo, "18:00");
  assert.match(c.text, /⚠ В 17:00–18:00 у тебя уже «Йога»/);
  assert.doesNotMatch(calls[1][0].content, /Йога/);
});

test("дневник, задача, заметка, дата и показатель — каждое своими проверками; отмена откатывает и убирает всё", async () => {
  const { store, u, pipe, say, fix } = await setup([
    {
      diary: [{ section: "food", text: "овсянка" }], tasks: [{ title: "Купить лампочку" }], stash: [{ shelf: "film", title: "Разделение" }],
      dates: [{ title: "ДР Маши", date_iso: "2026-12-01", type: "birthday" }], metrics: [{ key: "weight", value: 85 }], summary: "s",
    },
    { edits: [
      { ref: "r1", set: { section: "Заметки", day_key: "2026-11-07" } }, { ref: "r2", set: { due_date: "2026-11-09" } },
      { ref: "r3", set: { shelf: "сериал" } }, { ref: "r4", set: { yearly: false } }, { ref: "r5", set: { value: "84,5" } },
    ] },
  ]);
  const r = await say("ел овсянку, купить лампочку, посмотреть Разделение, ДР Маши 1 декабря, вес 85", "1");
  const [diary, task, note, date, metric] = r.changes!.map((x) => x.ref!);
  assert.deepEqual([diary.tbl, task.tbl, note.tbl, date.tbl, metric.tbl], ["diary", "tasks", "notes", "dates", "metrics"]);
  const c = await fix(r.messageId, "это было вчера и не еда; лампочку — к завтра; Разделение — сериал; ДР не каждый год; вес 84,5", "c1");
  assert.equal(c.changed.length, 5);
  const d = (await store.diaryRow(diary.id))!;
  assert.deepEqual([d.section, d.day_key], ["notes", "2026-11-07"]);
  assert.equal((await store.task(task.id))!.due_date, "2026-11-09");
  assert.equal((await store.note(note.id))!.shelf, "series");
  assert.equal((await store.date(date.id))!.yearly, 0);
  assert.equal((await store.metric(metric.id))!.value, 84.5);
  assert.deepEqual(c.changes.map((x) => x.detail), [
    "овсянка", "до 9 ноября, Пн", "Заметки · Сериалы", "1 декабря 2026, Вт", "Вес 84,5 кг",
  ]);
  assert.equal(c.changes[0].title, "Заметки");

  await pipe.undo(u, r.messageId);
  const d2 = (await store.diaryRow(diary.id))!;
  assert.deepEqual([d2.deleted, d2.section, d2.day_key], [1, "food", "2026-11-08"]);
  assert.equal((await store.task(task.id))!.status, "deleted");
  assert.equal((await store.note(note.id))!.status, "deleted");
  assert.equal((await store.date(date.id))!.status, "deleted");
  const m = (await store.metric(metric.id))!;
  assert.deepEqual([m.deleted, m.value], [1, 85]);
});

test("план до утра («с 22 до 2») и конец после «перенеси»: день, название и начало правятся — конец не мешает", async () => {
  const answers: unknown[] = [
    { events: [{ title: "Вечеринка", date_iso: "2026-11-14", time: "22:00", end_time: "02:00" }], summary: "s" },
    { edits: [{ ref: "r1", set: { date_iso: "2026-11-15" } }] },
    { edits: [{ ref: "r1", set: { time: "23:00" } }] },
    { events: [{ title: "Встреча", date_iso: "2026-11-09", time: "15:00", end_time: "16:00" }], summary: "s" },
  ];
  const { store, say, fix } = await setup(answers);
  const party = await say("в субботу вечеринка с 22 до 2", "1");
  const id = party.changes![0].ref!.id;
  assert.equal((await store.event(id))!.end_time, "02:00", "разбор пишет конец раньше начала — до утра");
  const c1 = await fix(party.messageId, "не в субботу, а в воскресенье", "c1");
  assert.equal(c1.clarify, undefined, c1.text);
  assert.deepEqual(c1.changed, [`events:${id}`]);
  const c2 = await fix(party.messageId, "на час позже", "c2");
  assert.deepEqual(c2.changed, [`events:${id}`], c2.text);
  const ev = (await store.event(id))!;
  assert.deepEqual([ev.date_iso, ev.time, ev.end_time], ["2026-11-15", "23:00", "03:00"], "те же четыре часа, по кругу суток");

  const meet = await say("завтра с 15 до 16 встреча", "2");
  const mid = meet.changes![0].ref!.id;
  answers.push(
    { edits: [{ action: "move", kind: "event", id: mid, new_time: "18:00" }], summary: "s" },
    { edits: [{ ref: "r1", set: { title: "Встреча с Машей" } }] },
  );
  const moved = await say("перенеси встречу на 18", "3");
  const was = (await store.event(mid))!;
  assert.deepEqual([was.time, was.end_time], ["18:00", "16:00"], "«перенеси» в разборе оставляет прежний конец");
  const c3 = await fix(moved.messageId, "назови её «Встреча с Машей»", "c3");
  assert.equal(c3.clarify, undefined, c3.text);
  assert.doesNotMatch(c3.text, /Конец/);
  assert.equal((await store.event(mid))!.title, "Встреча с Машей");
});

test("ответ на вопрос поправки («вечера») — модель видит ту поправку и свой вопрос; после записи — новая поправка сама по себе", async () => {
  const { store, u, calls, say, fix } = await setup([
    meeting(),
    { clarify: "В 7 утра или вечера?" },
    { clarify: "Так утра или вечера?" },
    { edits: [{ ref: "r1", set: { time: "19:00" } }], reply: "Поставила на 19:00." },
    { edits: [{ ref: "r1", set: { title: "Встреча с Петром" } }] },
  ]);
  const r = await say("завтра в 15 встреча с Петей", "1");
  const q = await fix(r.messageId, "не в 15, а в 7", "c1");
  assert.equal(q.clarify, true);
  await fix(r.messageId, "ну", "c2");
  assert.equal(calls[2][1].content, "не в 15, а в 7\n(уточнение: ну)");
  assert.match(calls[2][0].content, /ты переспросила: «[^»\n]*В 7 утра или вечера\?»/);
  const c = await fix(r.messageId, "вечера", "c3");
  assert.equal(calls[3][1].content, "не в 15, а в 7\n(уточнение: ну)\n(уточнение: вечера)", "цепочка вопросов — вся");
  assert.match(calls[3][0].content, /ты переспросила: «[^»\n]*Так утра или вечера\?»/);
  assert.equal(calls[3].length, 2, "только запрос и поправка — без истории разговора");
  assert.equal((await store.event(r.changes![0].ref!.id))!.time, "19:00");
  assert.match(c.text, /^Поставила на 19:00\./);
  assert.equal(await store.pendingClarify(u.id), undefined);

  await fix(r.messageId, "назови Встреча с Петром", "c4");
  assert.equal(calls[4][1].content, "назови Встреча с Петром", "вопроса больше нет — поправка как есть");
  assert.doesNotMatch(calls[4][0].content, /переспросила/);
});

test("реплика модели — только если сделано всё названное: номер мимо и поле без перемен — «Поправила.» и правда", async () => {
  const { store, say, fix } = await setup([
    { ...meeting(), money: [{ kind: "expense", amount: 300, category: "кафе", note: "кофе" }] },
    {
      edits: [{ ref: "r1", set: { time: "17:00" } }, { ref: "r2", set: { category: "кафе" } }, { ref: "r5", set: { amount: 500 } }],
      reply: "Перенесла встречу на 17, кофе теперь в еде и сумма 500.",
    },
  ]);
  const r = await say("завтра в 15 встреча с Петей, кофе 300", "1");
  const [ev, money] = r.changes!.map((x) => x.ref!);
  const c = await fix(r.messageId, "в 17, кофе — это еда, сумма 500", "c1");
  assert.doesNotMatch(c.text, /кофе теперь|сумма 500/);
  assert.equal(c.text, "Поправила.\n✎ Встреча с Петей: 9 ноября, Пн 15:00 → 9 ноября, Пн 17:00\nОстального в этом ответе не нашла — не меняла.");
  assert.deepEqual(c.changed, [`events:${ev.id}`]);
  const m = (await store.money(money.id))!;
  assert.deepEqual([m.amount, m.category], [300, "кафе"]);
});

test("поле, которого у записи нет, — вопрос, а не «так и записано»; «kind» у плана и подпись показателя — честный отказ", async () => {
  const { store, say, fix } = await setup([
    { ...meeting(), metrics: [{ key: "weight", value: 85 }] },
    { edits: [{ ref: "r1", set: { start_time: "17:00" } }], reply: "Перенесла!" },
    { edits: [{ ref: "r1", set: { kind: "task" } }], reply: "Сделала задачей!" },
    { edits: [{ ref: "r2", set: { label: "Пульс" } }] },
    { edits: [{ ref: "r1", set: { time: "15:00" } }], reply: "Перенесла!" },
  ]);
  const r = await say("завтра в 15 встреча с Петей, вес 85", "1");
  const [ev, metric] = r.changes!.map((x) => x.ref!);
  assert.deepEqual([ev.tbl, metric.tbl], ["events", "metrics"]);

  const c1 = await fix(r.messageId, "не в 15, а в 17", "c1");
  assert.equal(c1.text, "Не поняла, что поправить в этом ответе. Скажите иначе — например, «не в 15, а в 17».");
  assert.equal(c1.clarify, true);
  const c2 = await fix(r.messageId, "это задача, а не план", "c2");
  assert.match(c2.text, /не умею/);
  assert.doesNotMatch(c2.text, /Так и записано|Сделала/);
  const c3 = await fix(r.messageId, "это пульс, а не вес", "c3");
  assert.match(c3.text, /не умею/);
  assert.equal((await store.metric(metric.id))!.label, "Вес");
  // Настоящее «то же значение»: время и так 15:00.
  const c4 = await fix(r.messageId, "в 15, как и было", "c4");
  assert.equal(c4.text, "Так и записано — ничего не меняла.");
  assert.equal(c4.clarify, undefined);
  assert.equal((await store.event(ev.id))!.time, "15:00");
  assert.ok((await store.actionsOf(r.messageId)).every((a) => a.kind === "add"), "ни одной поправки в журнале");
});

test("два одновременных запроса с одним id — модель спросили оба, а записала поправку одна", async () => {
  const store = await Store.open(":memory:");
  const u = await store.ensureUser("100", "Тест", TZ);
  let release!: () => void;
  const gate = new Promise<void>((done) => (release = done));
  setTimeout(() => release(), 2000).unref();
  let asked = 0;
  const llm: LlmCall = async (messages) => {
    if (!messages[0].content.includes("поправляет один твой ответ")) return JSON.stringify(meeting());
    if (++asked === 2) release();
    await gate;
    return JSON.stringify({ edits: [{ ref: "r1", set: { time: "17:00" } }], reply: "Перенесла." });
  };
  const pipe = new Pipeline(store, llm);
  const r = await pipe.handle({ user: u, source: "telegram", sourceId: "1", text: "завтра в 15 встреча с Петей", at: AT });
  const [a, b] = await Promise.all([
    pipe.correct(u, r.messageId, "не в 15, а в 17", { sourceId: "same", at: AT }),
    pipe.correct(u, r.messageId, "не в 15, а в 17", { sourceId: "same", at: AT }),
  ]);
  assert.equal(asked, 2, "оба дошли до модели");
  assert.equal((await store.actionsOf(r.messageId)).filter((x) => x.kind === "edit").length, 1, "одна запись в журнале");
  assert.deepEqual([a!.duplicate, b!.duplicate].filter(Boolean), [true], "второй получил итог первого");
  assert.equal(a!.text, b!.text);
  assert.deepEqual(a!.changed, b!.changed);
  assert.equal((await store.event(r.changes![0].ref!.id))!.time, "17:00");
});

test("поправка после «↩ Отменить» — ответ уже отменён, модель не спрашивают", async () => {
  const { calls, pipe, u, say, fix } = await setup([meeting()]);
  const r = await say("завтра в 15 встреча с Петей", "1");
  await pipe.undo(u, r.messageId);
  const c = await fix(r.messageId, "не в 15, а в 17", "c1");
  assert.equal(c.text, "Этот ответ уже отменён — поправлять нечего.");
  assert.equal(c.undoable, false);
  assert.deepEqual([c.changes, c.changed], [[], []]);
  assert.equal(calls.length, 1);
});

test("сбой модели — ничего не поменяла, сообщение не failed, повтор с тем же id спрашивает снова; ответ без JSON — переспрос", async () => {
  const { store, u, calls, say, fix } = await setup([
    meeting(),
    new Error("сеть"),
    "Конечно, перенесу на 17!",
    { edits: [{ ref: "r1", set: { time: "17:00" } }] },
  ]);
  const r = await say("завтра в 15 встреча с Петей", "1");
  const id = r.changes![0].ref!.id;
  const c1 = await fix(r.messageId, "не в 15, а в 17", "same");
  assert.equal(c1.text, "Не получилось разобрать поправку — ничего не поменяла. Попробуйте ещё раз.");
  assert.equal(c1.emotion, "worried");
  assert.deepEqual(c1.changed, []);
  assert.equal((await store.event(id))!.time, "15:00");
  assert.ok((await store.actionsOf(r.messageId)).every((a) => a.kind === "add"));
  const service = (await store.repliesTo(u.id, r.messageId)).at(-1)!;
  assert.equal(service.state, "received", "не done — повтор спросит модель; не failed — фоновый повтор разбора не тронет");
  assert.deepEqual(await store.failedMessages(new Date(0)), []);

  const c2 = await fix(r.messageId, "не в 15, а в 17", "same");
  assert.equal(c2.duplicate, undefined);
  assert.equal(calls.length, 4, "повтор спросил модель снова, ответ без JSON — переспросил");
  assert.equal(calls[3].at(-2)!.content, "Конечно, перенесу на 17!");
  assert.match(calls[3].at(-1)!.content, /Ответь одним JSON-объектом/);
  assert.equal((await store.event(id))!.time, "17:00");
  assert.match(c2.text, /^Поправила\.\n✎ Встреча с Петей/);
  assert.equal((await store.message(service.id))!.state, "done");
});

test("карточки памяти и профиля — с ref и из базы, как в ответе; модель их не правит и не видит", async () => {
  const { calls, say, fix } = await setup([
    {
      ...meeting(), memory: [{ kind: "person", subject: "Кот", text: "Кота зовут Барсик" }],
      traits: [{ kind: "debuff", category: "allergy", title: "Аллергия на арахис", note: "" }],
    },
    { edits: [{ ref: "r1", set: { time: "17:00" } }] },
  ]);
  const r = await say("Кота зовут Барсик, у меня аллергия на арахис, завтра в 15 встреча с Петей", "1");
  assert.deepEqual(r.changes!.map((x) => x.ref?.tbl), ["events", "memory", "traits"]);
  const c = await fix(r.messageId, "не в 15, а в 17", "c1");
  assert.deepEqual(c.changes.map((x) => x.ref?.tbl), ["events", "memory", "traits"]);
  assert.deepEqual(c.changes.slice(1), r.changes!.slice(1), "карточки «Запомнила» и баф/дебаф — те же до символа");
  assert.doesNotMatch(calls[1][0].content, /^r2 /m, "записи для поправки — только план");
});

test("POST /api/correct: вход, проверка тела, чужой и неизвестный ответ — 404, итог с карточками", async () => {
  const answers: unknown[] = [meeting(), { edits: [{ ref: "r1", set: { time: "17:00" } }], reply: "Перенесла." }];
  const llm: LlmCall = async () => JSON.stringify(answers.shift() ?? {});
  const store = await Store.open(":memory:");
  const u = await store.ensureUser("100", "Тест", TZ);
  await store.updateUser(u.id, { login: "owner", password_hash: await hashPassword("secret-pass-1") });
  const other = await store.ensureUser("200", "Другой", TZ);
  const foreign = (await store.saveMessage({ userId: other.id, source: "telegram", sourceId: "x", text: "чужое", dayKey: "2026-11-08" })).message;
  const server = createApi({ store, pipeline: new Pipeline(store, llm) }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (path: string, body: unknown, token?: string) => {
    const res = await fetch(base + path, {
      method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as any };
  };
  try {
    const { token } = (await post("/api/login", { login: "owner", password: "secret-pass-1" })).json;
    const r = await post("/api/input", { text: "завтра в 15 встреча с Петей", id: "in1" }, token);
    assert.equal(r.status, 200);
    const evRef = r.json.changes[0].ref;
    assert.equal(evRef.tbl, "events", "у карточек /api/input — ref");

    assert.equal((await post("/api/correct", { messageId: r.json.messageId, text: "в 17" })).status, 401);
    for (const bad of [{ messageId: "1", text: "в 17" }, { messageId: r.json.messageId }, { messageId: r.json.messageId, text: "   " },
      { messageId: r.json.messageId, text: "а".repeat(501) }, { messageId: r.json.messageId, text: "в 17", id: "x".repeat(81) }]) {
      assert.equal((await post("/api/correct", bad, token)).status, 400, JSON.stringify(bad).slice(0, 60));
    }
    assert.equal((await post("/api/correct", { messageId: 99999, text: "в 17" }, token)).status, 404);
    assert.equal((await post("/api/correct", { messageId: foreign.id, text: "в 17" }, token)).status, 404, "чужой ответ не виден");

    const c = await post("/api/correct", { messageId: r.json.messageId, text: "не в 15, а в 17", id: "fix1" }, token);
    assert.equal(c.status, 200, JSON.stringify(c.json));
    assert.equal(c.json.messageId, r.json.messageId);
    assert.equal(c.json.undoable, true);
    assert.deepEqual(c.json.changed, [`events:${evRef.id}`]);
    assert.deepEqual(c.json.changes[0].ref, evRef);
    assert.match(c.json.changes[0].detail, /17:00/);
    assert.equal((await store.event(evRef.id))!.time, "17:00");
    const again = await post("/api/correct", { messageId: r.json.messageId, text: "не в 15, а в 17", id: "fix1" }, token);
    assert.equal(again.json.duplicate, true);
    assert.equal((await store.actionsOf(r.json.messageId)).filter((a) => a.kind === "edit").length, 1);
  } finally {
    server.close();
  }
});

/** Модель поправки ждёт, пока тест не отпустит: за это время ответ отменяют, а план двигают мышью. */
function gated(answer: unknown) {
  let release!: () => void;
  const gate = new Promise<void>((done) => (release = done));
  let reached!: () => void;
  const waiting = new Promise<void>((done) => (reached = done));
  const llm: LlmCall = async (messages) => {
    if (!messages[0].content.includes("поправляет один твой ответ")) return JSON.stringify(meeting("15:00", "16:00"));
    reached();
    await gate;
    return JSON.stringify(answer);
  };
  return { llm, release, waiting };
}

test("«↩ Отменить», пока поправка ждёт модель, — поправка ничего не пишет и честно говорит, что ответ отменён", async () => {
  const store = await Store.open(":memory:");
  const u = await store.ensureUser("100", "Тест", TZ);
  const { llm, release, waiting } = gated({ edits: [{ ref: "r1", set: { time: "17:00" } }], reply: "Перенесла на 17." });
  const pipe = new Pipeline(store, llm);
  const r = await pipe.handle({ user: u, source: "telegram", sourceId: "1", text: "завтра с 15 до 16 встреча с Петей", at: AT });
  const id = r.changes![0].ref!.id;
  const pending = pipe.correct(u, r.messageId, "не в 15, а в 17", { sourceId: "c1", at: AT });
  await waiting;
  await pipe.undo(u, r.messageId);
  release();
  const c = (await pending)!;
  assert.equal(c.text, "Этот ответ уже отменён — поправлять нечего.");
  assert.equal(c.undoable, false);
  assert.deepEqual([c.changes, c.changed], [[], []]);
  const ev = (await store.event(id))!;
  assert.deepEqual([ev.status, ev.time], ["deleted", "15:00"], "удалённый план не правится");
  assert.deepEqual(await store.actionsOf(r.messageId), [], "у отменённого ответа нет живой поправки в журнале");
  assert.equal(await store.lastDoneMessage(u.id), undefined);
  assert.equal(await pipe.undo(u), "Нечего отменять.", "второй /undo не тратится на невидимую правку");
  const again = (await pipe.correct(u, r.messageId, "не в 15, а в 17", { sourceId: "c1", at: AT }))!;
  assert.equal(again.duplicate, true);
  assert.equal(again.text, c.text);
});

test("план подвинули мышью, пока поправка ждёт модель, — поправка от нового времени, «как было» в журнале — тоже новое", async () => {
  const store = await Store.open(":memory:");
  const u = await store.ensureUser("100", "Тест", TZ);
  const { llm, release, waiting } = gated({ edits: [{ ref: "r1", set: { time: "17:00" } }] });
  const pipe = new Pipeline(store, llm);
  const r = await pipe.handle({ user: u, source: "telegram", sourceId: "1", text: "завтра с 15 до 16 встреча с Петей", at: AT });
  const id = r.changes![0].ref!.id;
  const pending = pipe.correct(u, r.messageId, "не в 15, а в 17", { sourceId: "c1", at: AT });
  await waiting;
  // То же, что перетаскивание в виджете (POST /api/events/:id): своё служебное сообщение и «как было».
  await pipe.manual(u, "✎ Встреча с Петей", async (log) => {
    await log("events", id, { time: "15:00", end_time: "16:00" });
    await store.updateEvent(id, { time: "15:30", end_time: "17:00" });
  });
  release();
  const c = (await pending)!;
  const ev = (await store.event(id))!;
  assert.deepEqual([ev.time, ev.end_time], ["17:00", "18:30"], "длительность — от плана после перетаскивания");
  assert.match(c.text, /✎ Встреча с Петей: 9 ноября, Пн 15:30 → 9 ноября, Пн 17:00/);
  const [edit] = await store.actionsOf(r.messageId);
  assert.equal(edit.kind, "edit");
  assert.deepEqual(JSON.parse(edit.before_json!), { time: "15:30", end_time: "17:00" });
  await pipe.undo(u, r.messageId);
  const back = (await store.event(id))!;
  assert.deepEqual([back.status, back.time, back.end_time], ["deleted", "15:30", "17:00"]);
});

test("план стал задачей, задача — планом (виджет): закрытая запись не правится, её карточки нет, ответ честный", async () => {
  const { store, u, pipe, calls, say, fix } = await setup([
    meeting(),
    { tasks: [{ title: "Купить лампочку", due_date: "2026-11-09" }], summary: "s" },
    { events: [{ title: "Стрижка", date_iso: "2026-11-10", time: "12:00" }], money: [{ kind: "expense", amount: 300, category: "кафе", note: "кофе" }], summary: "s" },
    { edits: [{ ref: "r1", set: { amount: 540 } }] },
  ]);
  await store.updateUser(u.id, { login: "owner", password_hash: await hashPassword("secret-pass-1") });
  const server = createApi({ store, pipeline: pipe }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (path: string, body: unknown, token?: string) => {
    const res = await fetch(base + path, {
      method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as any };
  };
  try {
    const { token } = (await post("/api/login", { login: "owner", password: "secret-pass-1" })).json;
    const plan = await say("завтра в 15 встреча с Петей", "1");
    const task = await say("завтра купить лампочку", "2");
    const both = await say("послезавтра в 12 стрижка, кофе 300", "3");
    const planId = plan.changes![0].ref!.id;
    const taskId = task.changes![0].ref!.id;
    const [cut, coffee] = both.changes!.map((x) => x.ref!);
    assert.equal((await post(`/api/events/${planId}/task`, {}, token)).status, 200, "план → задача");
    assert.equal((await post(`/api/tasks/${taskId}/plan`, { time: "18:00" }, token)).status, 200, "задача → план");
    assert.equal((await post(`/api/events/${cut.id}/task`, {}, token)).status, 200);

    const c1 = await fix(plan.messageId, "не в 15, а в 17", "c1");
    assert.equal(c1.text, "«Встреча с Петей» уже не план, а задача — поправьте её в задачах.");
    assert.deepEqual([c1.changes, c1.changed], [[], []], "карточки скрытого плана нет");
    const ev = (await store.event(planId))!;
    assert.deepEqual([ev.status, ev.time], ["tasked", "15:00"]);

    const c2 = await fix(task.messageId, "на послезавтра", "c2");
    assert.equal(c2.text, "«Купить лампочку» уже не задача, а план — поправьте его в планах.");
    assert.deepEqual(c2.changes, []);
    assert.equal((await store.task(taskId))!.due_date, "2026-11-09");
    assert.equal(calls.length, 3, "модель не спрашивали");

    // Рядом с тратой: план стал задачей — модель видит только трату, карточка — только у неё.
    const c3 = await fix(both.messageId, "сумма 540", "c3");
    assert.equal(calls.length, 4);
    assert.doesNotMatch(calls[3][0].content, /Стрижка/);
    assert.deepEqual(c3.changes.map((x) => x.ref), [coffee]);
    assert.deepEqual(c3.changed, [`money:${coffee.id}`]);
    assert.equal(Number((await store.money(coffee.id))!.amount), 540);
  } finally {
    server.close();
  }
});

test("сбой модели у одного из двух запросов с тем же id не перезаписывает итог другого", async () => {
  const store = await Store.open(":memory:");
  const u = await store.ensureUser("100", "Тест", TZ);
  let n = 0;
  const llm: LlmCall = async (messages) => {
    if (!messages[0].content.includes("поправляет один твой ответ")) return JSON.stringify(meeting());
    if (++n === 1) throw new Error("сеть");
    return JSON.stringify({ edits: [{ ref: "r1", set: { time: "17:00" } }], reply: "Перенесла." });
  };
  const pipe = new Pipeline(store, llm);
  const r = await pipe.handle({ user: u, source: "telegram", sourceId: "1", text: "завтра в 15 встреча с Петей", at: AT });
  const id = r.changes![0].ref!.id;
  // Второй запрос с тем же id записывает поправку между сбоем первого и записью его ответа (в Postgres — отдельные
  // запросы): перед записью «не получилось» — каким бы методом хранилища она ни шла — второй доходит до конца.
  const race: { other?: Promise<CorrectReply | null> } = {};
  const st = store as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  for (const name of ["setMessage", "replyUnlessDone"]) {
    const was = st[name]?.bind(store);
    if (!was) continue;
    st[name] = async (msgId, patch) => {
      const reply = typeof patch === "string" ? patch : (patch as { reply?: string } | undefined)?.reply;
      if (!race.other && /Не получилось разобрать поправку/.test(reply ?? "")) {
        race.other = pipe.correct(u, r.messageId, "не в 15, а в 17", { sourceId: "same", at: AT });
        await race.other;
      }
      return was(msgId, patch);
    };
  }
  const a = (await pipe.correct(u, r.messageId, "не в 15, а в 17", { sourceId: "same", at: AT }))!;
  assert.ok(race.other, "второй запрос прошёл между сбоем и записью");
  const b = (await race.other)!;
  assert.equal((await store.event(id))!.time, "17:00");
  const service = (await store.repliesTo(u.id, r.messageId)).at(-1)!;
  assert.equal(service.state, "done");
  assert.doesNotMatch(service.reply ?? "", /ничего не поменяла/, "итог поправки не перезаписан ответом о сбое");
  assert.equal(service.reply, b.text);
  assert.equal(a.text, b.text, "сбойный запрос отдаёт записанный итог");
  assert.equal(a.duplicate, true);
  assert.deepEqual(a.changed, [`events:${id}`]);
  const again = (await pipe.correct(u, r.messageId, "не в 15, а в 17", { sourceId: "same", at: AT }))!;
  assert.deepEqual([again.duplicate, again.text, again.changed], [true, b.text, [`events:${id}`]]);
});

test("«Сдвинуть?» поправки решается у поправки: строка ⚠ ответа про другой план остаётся; свой вопрос ответа — как прежде", async () => {
  const { store, u, pipe, say, fix } = await setup([meeting("15:00", "16:00"), { edits: [{ ref: "r1", set: { time: "17:00" } }] }]);
  const yoga = await store.addEvent({ user_id: u.id, title: "Йога", date_iso: "2026-11-09", time: "15:00", end_time: "16:00", details: "", domain: "life", message_id: null });
  const pool = await store.addEvent({ user_id: u.id, title: "Бассейн", date_iso: "2026-11-09", time: "17:00", end_time: "18:00", details: "", domain: "life", message_id: null });
  const r = await say("завтра с 15 до 16 встреча с Петей", "1");
  assert.equal(r.clash?.withId, yoga);
  const c = await fix(r.messageId, "не в 15, а в 17", "c1");
  assert.equal(c.clash?.withId, pool);
  assert.equal(c.messageId, r.messageId);

  const d = await pipe.decideClash(u, r.messageId, c.clash!.eventId, c.clash!.withId, "shift");
  assert.equal(d.text, "Сдвинула «Встреча с Петей» на 18:00–19:00.");
  assert.equal(d.reply, null, "строка вопроса ответа (Telegram) — про другой план, её не трогаем");
  assert.match((await store.message(r.messageId))!.reply!, /⚠ В 15:00–16:00 у тебя уже «Йога»/);
  const service = (await store.repliesTo(u.id, r.messageId)).at(-1)!;
  assert.doesNotMatch(service.reply!, /⚠/);
  assert.match(service.reply!, /\nСдвинула «Встреча с Петей» на 18:00–19:00\.$/);
  assert.equal(JSON.parse(service.parse_json!).clash, undefined);
  const again = await fix(r.messageId, "не в 15, а в 17", "c1");
  assert.equal(again.duplicate, true);
  assert.equal(again.clash, undefined, "повтор не возвращает кнопки решённого вопроса");
  assert.equal(again.text, service.reply);
  // Тот же вопрос второй раз (кнопка, «Оставить» через 10 с) строку ответа про йогу не трогает.
  await pipe.decideClash(u, r.messageId, c.clash!.eventId, c.clash!.withId, "keep");
  assert.match((await store.message(r.messageId))!.reply!, /«Йога»/);
  // Занятый план тем временем переименовали в виджете (POST /api/events/:id {title}) — вопрос ответа узнаётся по паре планов.
  await pipe.manual(u, "✎ Пилатес", async (log) => {
    await log("events", yoga, { title: "Йога" });
    await store.updateEvent(yoga, { title: "Пилатес" });
  });

  // Свой вопрос ответа — как прежде: строка ⚠ — итогом.
  const own = await pipe.decideClash(u, r.messageId, r.clash!.eventId, r.clash!.withId, "keep");
  assert.equal(own.text, "Хорошо, оставила оба.");
  assert.ok(own.reply && !own.reply.includes("⚠") && own.reply.includes("Хорошо, оставила оба."));
  assert.equal((await store.message(r.messageId))!.reply, own.reply);
  // Сдвиг — в журнале ответа: одна «Отменить» откатывает сдвиг, поправку и сам план.
  assert.deepEqual((await store.actionsOf(r.messageId)).map((a) => a.kind), ["update", "edit", "add", "add"]);
  await pipe.undo(u, r.messageId);
  const ev = (await store.event(r.clash!.eventId))!;
  assert.deepEqual([ev.status, ev.time, ev.end_time], ["deleted", "15:00", "16:00"]);
});

test("запись удалили, пока поправка ждёт модель, — не пишется ничего, и про другие записи ответа тоже", async () => {
  const store = await Store.open(":memory:");
  const u = await store.ensureUser("100", "Тест", TZ);
  let release!: () => void;
  const gate = new Promise<void>((done) => (release = done));
  let reached!: () => void;
  const waiting = new Promise<void>((done) => (reached = done));
  const llm: LlmCall = async (messages) => {
    if (!messages[0].content.includes("поправляет один твой ответ")) {
      return JSON.stringify({ ...meeting(), money: [{ kind: "expense", amount: 300, category: "кафе", note: "кофе" }] });
    }
    reached();
    await gate;
    return JSON.stringify({ edits: [{ ref: "r1", set: { time: "17:00" } }, { ref: "r2", set: { amount: 540 } }], reply: "Готово." });
  };
  const pipe = new Pipeline(store, llm);
  const r = await pipe.handle({ user: u, source: "telegram", sourceId: "1", text: "завтра в 15 встреча с Петей, кофе 300", at: AT });
  const [ev, coffee] = r.changes!.map((x) => x.ref!);
  const pending = pipe.correct(u, r.messageId, "в 17, и кофе 540", { sourceId: "c1", at: AT });
  await waiting;
  // То же, что удаление в виджете: своё служебное сообщение и «как было».
  await pipe.manual(u, "🗑 Встреча с Петей", async (log) => {
    await log("events", ev.id, { status: "active" });
    await store.updateEvent(ev.id, { status: "deleted" });
  });
  release();
  const c = (await pending)!;
  assert.equal(c.text, "Записи «Встреча с Петей» уже нет — ничего не поменяла.");
  assert.deepEqual(c.changed, []);
  assert.equal(c.undoable, true, "ответ не отменён — «Отменить» у него остаётся");
  assert.deepEqual(c.changes.map((x) => x.ref), [coffee], "карточка удалённого плана ушла");
  assert.equal(Number((await store.money(coffee.id))!.amount), 300, "трата тоже не тронута");
  assert.equal((await store.event(ev.id))!.time, "15:00");
  assert.ok((await store.actionsOf(r.messageId)).every((a) => a.kind === "add"), "в журнале ответа — ни одной поправки");
});

test("вопрос «Сдвинуть?» ответа узнаётся по паре планов, а не по названию: занятый план переименовали поправкой — строка ⚠ всё равно меняется на итог", async () => {
  const { store, u, pipe, say, fix } = await setup([
    { summary: "s", events: [{ title: "Йога", date_iso: "2026-11-09", time: "15:00", end_time: "16:00" }] },
    meeting("15:00", "16:00"),
    { edits: [{ ref: "r1", set: { title: "Пилатес" } }] },
  ]);
  const yoga = await say("завтра с 15 до 16 йога", "1");
  const r = await say("завтра с 15 до 16 встреча с Петей", "2");
  assert.equal(r.clash?.withId, yoga.changes![0].ref!.id);
  // До кнопки занятый план переименовали — поправкой его собственного ответа.
  const c = await fix(yoga.messageId, "это пилатес", "c1");
  assert.equal((await store.event(r.clash!.withId))!.title, "Пилатес");
  assert.equal(c.clash, undefined, "название время не двигает — нового вопроса нет");

  const d = await pipe.decideClash(u, r.messageId, r.clash!.eventId, r.clash!.withId, "keep");
  assert.equal(d.text, "Хорошо, оставила оба.");
  assert.ok(d.reply && !d.reply.includes("⚠") && d.reply.endsWith("\nХорошо, оставила оба."), "облачко Telegram переписывается итогом");
  assert.equal((await store.message(r.messageId))!.reply, d.reply, "в истории разговора — итог, а не вопрос без кнопок");
});

test("ответ и поправка спросили про одну пару — кнопка у облачка ответа заменяет итогом обе строки ⚠", async () => {
  const { store, u, pipe, say, fix } = await setup([meeting("15:00", "16:00"), { edits: [{ ref: "r1", set: { time: "15:30" } }] }]);
  const yoga = await store.addEvent({ user_id: u.id, title: "Йога", date_iso: "2026-11-09", time: "15:00", end_time: "16:00", details: "", domain: "life", message_id: null });
  const r = await say("завтра с 15 до 16 встреча с Петей", "1");
  assert.equal(r.clash?.withId, yoga);
  // Вопрос ответа ещё открыт, а поправка «не в 15, а в 15:30» снова кладёт встречу на йогу — та же пара.
  const c = await fix(r.messageId, "не в 15, а в 15:30", "c1");
  assert.deepEqual([c.clash?.eventId, c.clash?.withId], [r.clash!.eventId, yoga]);

  // Кнопка — у исходного облачка (Telegram: messageId ответа).
  const d = await pipe.decideClash(u, r.messageId, r.clash!.eventId, r.clash!.withId, "keep");
  assert.equal(d.text, "Хорошо, оставила оба.");
  assert.ok(d.reply && !d.reply.includes("⚠") && d.reply.endsWith("\nХорошо, оставила оба."), "ответ — переписанный текст облачка");
  assert.equal((await store.message(r.messageId))!.reply, d.reply);
  const service = (await store.repliesTo(u.id, r.messageId)).at(-1)!;
  assert.doesNotMatch(service.reply!, /⚠/);
  assert.match(service.reply!, /\nХорошо, оставила оба\.$/);
  assert.equal(JSON.parse(service.parse_json!).clash, undefined);
  assert.equal((await fix(r.messageId, "не в 15, а в 15:30", "c1")).clash, undefined, "повтор поправки кнопок не вернёт");

  // Та же кнопка ещё раз (другое окно, «Оставить» через 10 с) ничего уже не переписывает.
  const again = await pipe.decideClash(u, r.messageId, r.clash!.eventId, r.clash!.withId, "keep");
  assert.equal(again.reply, null);
  assert.equal((await store.message(r.messageId))!.reply, d.reply);
  assert.equal((await store.repliesTo(u.id, r.messageId)).at(-1)!.reply, service.reply);
});

test("ответ без пары вопроса в parse_json (записан до поправок) — первая строка ⚠, если эту пару не спрашивала поправка", async () => {
  const { store, u, pipe, say, fix } = await setup([meeting("15:00", "16:00"), { edits: [{ ref: "r1", set: { time: "17:00" } }] }]);
  const yoga = await store.addEvent({ user_id: u.id, title: "Йога", date_iso: "2026-11-09", time: "15:00", end_time: "16:00", details: "", domain: "life", message_id: null });
  const pool = await store.addEvent({ user_id: u.id, title: "Бассейн", date_iso: "2026-11-09", time: "17:00", end_time: "18:00", details: "", domain: "life", message_id: null });
  const r = await say("завтра с 15 до 16 встреча с Петей", "1");
  const c = await fix(r.messageId, "не в 15, а в 17", "c1");
  assert.equal(c.clash?.withId, pool);
  const { clash, ...old } = JSON.parse((await store.message(r.messageId))!.parse_json!);
  assert.deepEqual(clash, { eventId: r.clash!.eventId, withId: yoga }, "пара вопроса ответа — в его parse_json");
  await store.setMessage(r.messageId, { parse_json: JSON.stringify(old) });

  const d = await pipe.decideClash(u, r.messageId, c.clash!.eventId, pool, "keep");
  assert.equal(d.reply, null, "пару спрашивала поправка — строку ответа не трогаем");
  assert.match((await store.message(r.messageId))!.reply!, /⚠ В 15:00–16:00 у тебя уже «Йога»/);
  assert.equal((await pipe.decideClash(u, r.messageId, c.clash!.eventId, pool, "keep")).reply, null, "и после решения — тоже");
  const own = await pipe.decideClash(u, r.messageId, r.clash!.eventId, yoga, "keep");
  assert.ok(own.reply && !own.reply.includes("⚠") && own.reply.endsWith("\nХорошо, оставила оба."));
});

test("план стал задачей, пока поправка ждёт модель, — «уже не план, а задача», не пишется ничего", async () => {
  const store = await Store.open(":memory:");
  const u = await store.ensureUser("100", "Тест", TZ);
  const { llm, release, waiting } = gated({ edits: [{ ref: "r1", set: { time: "17:00" } }], reply: "Перенесла на 17." });
  const pipe = new Pipeline(store, llm);
  const r = await pipe.handle({ user: u, source: "telegram", sourceId: "1", text: "завтра с 15 до 16 встреча с Петей", at: AT });
  const id = r.changes![0].ref!.id;
  const pending = pipe.correct(u, r.messageId, "не в 15, а в 17", { sourceId: "c1", at: AT });
  await waiting;
  // То же, что «сделать задачей» в виджете (POST /api/events/:id/task): у плана — tasked.
  await pipe.manual(u, "✎ Встреча с Петей → задача", async (log) => {
    await log("events", id, { status: "active" });
    await store.updateEvent(id, { status: "tasked" });
  });
  release();
  const c = (await pending)!;
  assert.equal(c.text, "«Встреча с Петей» уже не план, а задача — поправьте её в задачах.");
  assert.deepEqual([c.changes, c.changed], [[], []]);
  const ev = (await store.event(id))!;
  assert.deepEqual([ev.status, ev.time], ["tasked", "15:00"]);
  assert.ok((await store.actionsOf(r.messageId)).every((a) => a.kind === "add"), "в журнале ответа — ни одной поправки");
});

test("смена вида: привычка — «не умею», неизвестный вид — вопрос, и ничего не убрано; одна запись объектом — тоже запись", async () => {
  const { store, u, say, fix } = await setup([
    meeting(),
    { remove: ["r1"], add: { habits: [{ title: "Встреча", days: "1234567" }] }, reply: "Сделала привычкой!" },
    { remove: ["r1"], add: { task: [{ title: "Встреча с Петей" }] }, reply: "Сделала задачей." },
    { remove: ["r1"], add: { tasks: { title: "Встреча с Петей" } }, reply: "Сделала задачей." },
  ]);
  const r = await say("завтра в 15 встреча с Петей", "1");
  const ev = r.changes![0].ref!.id;
  const c1 = await fix(r.messageId, "сделай привычкой", "c1");
  assert.match(c1.text, /не умею/);
  const c2 = await fix(r.messageId, "это задача", "c2");
  assert.doesNotMatch(c2.text, /Сделала/);
  assert.equal(c2.clarify, true);
  assert.equal((await store.event(ev))!.status, "active", "план на месте");
  assert.ok((await store.actionsOf(r.messageId)).every((a) => a.kind === "add"), "ни одной поправки в журнале");
  const c3 = await fix(r.messageId, "это задача", "c3");
  assert.match(c3.text, /^Сделала задачей\./);
  assert.equal((await store.event(ev))!.status, "deleted");
  assert.deepEqual((await store.openTasks(u.id)).map((t) => t.title), ["Встреча с Петей"]);
});

test("поправка, которая только убрала, — тоже «данные поменялись» (список в Telegram обновится)", async () => {
  const { store, u, say, fix, pipe } = await setup([meeting(), { remove: ["r1"] }]);
  let calls = 0;
  pipe.onChange = () => void calls++;
  const r = await say("завтра в 15 встреча с Петей", "1");
  calls = 0;
  await fix(r.messageId, "не надо", "c1");
  assert.equal(calls, 1);
  void store; void u;
});

test("смена вида вчерашней записи: новая — в тот же день, что ответ, а не в день поправки", async () => {
  const { store, u, pipe, fix } = await setup([
    { summary: "s", money: [{ kind: "expense", amount: 500, category: "еда", note: "ужин" }] },
    { remove: ["r1"], add: { diary: [{ section: "food", text: "ужин в кафе", day_iso: null }] } },
  ]);
  const r = await pipe.handle({ user: u, source: "telegram", sourceId: "1", text: "ужин 500", at: new Date(AT.getTime() - 24 * 3600e3) });
  assert.equal((await store.money(r.changes![0].ref!.id))!.day_key, "2026-11-07");
  await fix(r.messageId, "это в дневник", "c1");
  assert.ok((await store.diaryOf(u.id, "2026-11-07")).some((d) => d.text === "ужин в кафе"), "вчерашний день");
  assert.ok(!(await store.diaryOf(u.id, "2026-11-08")).some((d) => d.text === "ужин в кафе"));
});

test("«это задача, а не план»: время в названии задачи — всё равно задача, как просили", async () => {
  const { store, u, say, fix } = await setup([
    meeting(),
    { remove: ["r1"], add: { tasks: [{ title: "Встреча с Петей в 15:00", due_date: "2026-11-09" }] }, reply: "Сделала задачей." },
  ]);
  const r = await say("завтра в 15 встреча с Петей", "1");
  const c = await fix(r.messageId, "это задача, а не план", "c1");
  const [t] = await store.openTasks(u.id);
  assert.equal(t?.title, "Встреча с Петей в 15:00");
  assert.deepEqual(await store.eventsBetween(u.id, "2026-11-01", "2026-12-31"), [], "нового плана нет");
  assert.deepEqual(c.changes.map((x) => x.kind), ["task"]);
});

test("дописать пропущенное: «и ещё 300 на такси» — новая трата под тем же ответом; «Отменить» убирает обе", async () => {
  const { store, u, calls, pipe, say, fix } = await setup([
    { summary: "s", money: [{ kind: "expense", amount: 450, category: "еда", note: "шаурма" }] },
    { add: { money: [{ kind: "expense", amount: 300, category: "транспорт", note: "такси" }] } },
    { add: { tasks: [{ title: "Купить хлеб" }] }, edits: [{ ref: "r1", set: { amount: 500 } }], reply: "Записала хлеб и поправила сумму." },
  ]);
  const r = await say("потратил 450 на шаурму", "1");
  const first = r.changes![0].ref!;
  const c = await fix(r.messageId, "и ещё 300 на такси", "c1");
  const taxi = (await store.moneyRange(u.id, "2026-11-01", "2026-11-30")).find((m) => m.note === "такси")!;
  assert.equal(taxi.message_id, r.messageId);
  assert.deepEqual(c.changes.map((x) => x.ref), [first, { tbl: "money", id: taxi.id }]);
  assert.deepEqual(c.changed, [`money:${taxi.id}`]);
  assert.match(c.text, /^Записала\.\n＋ такси: −300 RUB — транспорт, такси$/);
  assert.match(calls[1][0].content, /Пропущено в ответе/);

  const c2 = await fix(r.messageId, "и купить хлеб, а шаурма 500", "c2");
  assert.match(c2.text, /^Записала хлеб и поправила сумму\.\n✎ шаурма: .+\n＋ Купить хлеб/);
  assert.equal((await store.money(first.id))!.amount, 500);

  await pipe.undo(u);
  assert.deepEqual(await store.moneyRange(u.id, "2026-11-01", "2026-11-30"), []);
  assert.equal((await store.openTasks(u.id)).length, 0);
  assert.equal(await pipe.undo(u), "Нечего отменять.");
});
