import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApi } from "../src/api.ts";
import { hashPassword } from "../src/auth.ts";
import { Store } from "../src/db.ts";
import { habitFinished, habitsOfDay, markTime } from "../src/habits.ts";
import type { ChatMessage, LlmCall } from "../src/llm.ts";
import { Pipeline } from "../src/pipeline.ts";
import { habitAnswered } from "../src/scheduler.ts";
import { addDays, dayKey, zonedToUtc } from "../src/time.ts";

// Время отметки и «Завершённые» привычки (26.11.2026). Время отметки — в поясе человека, считает сервер: «21:14»; задним
// числом — ещё и день отметки; минус в полночь — без времени. Завершённая — идёт и закончена вручную (finished_at) или срок
// прошёл; её нет в сетке месяца, она в finished[] с итогом; повторное «Завершить» срок не продлевает; «↺ Вернуть» и «Отменить»
// возвращают всё; отметить её (и удалённую) нельзя.

const TZ = "Asia/Yekaterinburg"; // UTC+5: день по поясу и по UTC расходятся вечером по UTC

interface Cell { day: string; status: string | null; at_time: string | null; at_day: string | null }
interface MonthRow { id: number; days: Cell[] }
interface Finished { id: number; title: string; start_date: string; end_date: string; finished_at: string | null; done: number; planned: number; best: number }
interface HabitsJson { today: { habit: { id: number }; at_time: string | null; at_day: string | null }[]; habits: MonthRow[]; finished: Finished[] }

test("время отметки: в поясе человека, задним числом — с днём, минус в полночь — без времени", () => {
  const at = (day: string, time: string) => zonedToUtc(day, time, TZ).toISOString();
  assert.deepEqual(markTime({ status: "done", message_id: 5, day_key: "2026-11-26", at: at("2026-11-26", "21:14") }, TZ), { at_time: "21:14", at_day: null });
  assert.deepEqual(markTime({ status: "skipped", message_id: 5, day_key: "2026-11-25", at: at("2026-11-26", "10:02") }, TZ), { at_time: "10:02", at_day: "2026-11-26" });
  assert.deepEqual(markTime({ status: "skipped", message_id: null, day_key: "2026-11-25", at: at("2026-11-26", "00:01") }, TZ), { at_time: null, at_day: null });
  assert.deepEqual(markTime(undefined, TZ), { at_time: null, at_day: null });
});

test("завершена: срок прошёл по поясу человека (со следующего дня) или закончили вручную; удалённая — нет", () => {
  const h = { status: "active", end_date: "2026-11-25", finished_at: null };
  // 20:30 UTC 25 ноября — в Екатеринбурге уже 01:30 26-го: срок прошёл; по UTC ещё нет.
  const at = new Date("2026-11-25T20:30:00Z");
  assert.equal(habitFinished(h, dayKey(at, TZ)), true);
  assert.equal(habitFinished(h, dayKey(at, "UTC")), false, "в последний день срока ещё идёт");
  assert.equal(habitFinished({ ...h, end_date: null }, "2026-11-26"), false);
  assert.equal(habitFinished({ ...h, end_date: "2026-11-26", finished_at: "2026-11-26T10:00:00Z" }, "2026-11-26"), true, "вручную — сразу");
  assert.equal(habitFinished({ ...h, status: "stopped" }, "2026-11-26"), false, "удалённая — не в «Завершённых»");
});

test("API: время отметки в /api/habits и /api/today; завершить, повтор, вернуть, отмена; finished[]; отметки после конца — 409", async () => {
  const store = await Store.open(":memory:");
  const u = await store.ensureUser("100", "Тест", TZ);
  await store.updateUser(u.id, { login: "owner", password_hash: await hashPassword("secret-pass-1") });
  const today = dayKey(new Date(), TZ);
  const d = (n: number) => addDays(today, n);
  const add = (title: string, start: string, end: string | null = null) =>
    store.addHabit({ user_id: u.id, title, days: "1234567", times: "[]", start_date: start, end_date: end, message_id: null });
  // Отметка с нужным временем: markHabit пишет «сейчас», restoreMark ставит заданное.
  const markAt = async (habit: number, day: string, status: "done" | "skipped", at: string, messageId: number | null = 1) => {
    const { id } = await store.markHabit(habit, day, status, messageId);
    await store.restoreMark(id, { id, habit_id: habit, day_key: day, status, at, message_id: messageId, amount: null, unit: "" });
  };

  const walk = await add("Гулять", d(-10));
  await markAt(walk, today, "done", zonedToUtc(today, "21:14", TZ).toISOString());
  await markAt(walk, d(-2), "done", zonedToUtc(d(-1), "10:02", TZ).toISOString());
  await markAt(walk, d(-3), "skipped", zonedToUtc(d(-2), "00:01", TZ).toISOString(), null);

  const pills = await add("Аевит", d(-5)); // закончим вручную: сегодня не отмечена — конец вчера
  for (const n of [-5, -4, -3]) await markAt(pills, d(n), "done", zonedToUtc(d(n), "09:00", TZ).toISOString());
  await markAt(pills, d(-2), "skipped", zonedToUtc(d(-2), "23:00", TZ).toISOString());
  const course = await add("Курс", d(-20), d(-3)); // кончилась по сроку сама
  const fresh = await add("Новая", today); // заведена сегодня и не отмечена: конец — не раньше начала
  const doneToday = await add("Зарядка", d(-3)); // отмечена сегодня: конец — сегодня, из списка дня уходит
  await markAt(doneToday, today, "done", new Date().toISOString());
  const gone = await add("Удалённая", d(-10));
  await store.updateHabit(gone, { status: "stopped" });

  const pipeline = new Pipeline(store, async () => "{}");
  const server = createApi({ store, pipeline }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let token = "";
  const call = async <T = Record<string, unknown>>(method: "GET" | "POST", path: string, body?: unknown) => {
    const r = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json()) as T };
  };
  const habits = async (month = today.slice(0, 7)) => (await call<HabitsJson>("GET", `/api/habits?month=${month}`)).json;
  const cell = async (habit: number, day: string) => (await habits(day.slice(0, 7))).habits.find((h) => h.id === habit)!.days.find((x) => x.day === day)!;
  const row = async (id: number) => (await store.habit(id))!;
  try {
    token = (await call<{ token: string }>("POST", "/api/login", { login: "owner", password: "secret-pass-1", label: "test" })).json.token;

    // Время отметки.
    assert.deepEqual([(await cell(walk, today)).at_time, (await cell(walk, today)).at_day], ["21:14", null]);
    assert.deepEqual([(await cell(walk, d(-2))).at_time, (await cell(walk, d(-2))).at_day], ["10:02", d(-1)], "задним числом — день и время отметки");
    assert.deepEqual([(await cell(walk, d(-3))).status, (await cell(walk, d(-3))).at_time], ["skipped", null], "минус в полночь — без времени");
    assert.equal((await cell(walk, d(-4))).at_time, null, "нет отметки — нет времени");
    assert.equal((await habits()).today.find((x) => x.habit.id === walk)!.at_time, "21:14");
    const day = (await call<{ habits: { id: number; at_time: string | null; at_day: string | null }[] }>("GET", "/api/today")).json;
    assert.deepEqual(day.habits.filter((x) => x.id === walk).map((x) => [x.at_time, x.at_day]), [["21:14", null]]);

    // Кончившаяся по сроку — сама в «Завершённых» (со следующего дня после конца), в сетке её нет; удалённой нет нигде.
    let all = await habits();
    assert.ok(!all.habits.some((h) => h.id === course) && all.finished.some((f) => f.id === course));
    assert.ok(!all.habits.some((h) => h.id === gone) && !all.finished.some((f) => f.id === gone));

    // Завершить вручную: сегодня не отмечена — конец вчера.
    const fin = await call<{ end_date: string; finished_at: string | null; undo: number | null }>("POST", `/api/habits/${pills}`, { finish: true });
    assert.equal(fin.status, 200);
    assert.equal(fin.json.end_date, d(-1));
    assert.ok(fin.json.finished_at && fin.json.undo);
    all = await habits();
    assert.ok(!all.habits.some((h) => h.id === pills), "из сетки ушла");
    const card = all.finished.find((f) => f.id === pills)!;
    assert.deepEqual([card.title, card.start_date, card.end_date, card.done, card.planned, card.best], ["Аевит", d(-5), d(-1), 3, 5, 3]);
    assert.ok(card.finished_at);
    const ends = all.finished.map((f) => f.end_date);
    assert.deepEqual(ends, [...ends].sort().reverse(), "свежие сверху");

    // Повтор не продлевает: ни у закончившей вручную, ни у кончившейся по сроку.
    const again = await call<{ end_date: string; undo: number | null }>("POST", `/api/habits/${pills}`, { finish: true });
    assert.deepEqual([again.status, again.json.end_date, again.json.undo], [200, d(-1), null]);
    const old = await call<{ end_date: string; undo: number | null }>("POST", `/api/habits/${course}`, { finish: true });
    assert.deepEqual([old.json.end_date, old.json.undo], [d(-3), null]);
    assert.equal((await row(course)).finished_at ?? null, null);

    // Заведена сегодня, не отмечена — конец сегодня (не раньше начала); отмечена сегодня — конец сегодня, из списка дня уходит.
    await call("POST", `/api/habits/${fresh}`, { finish: true });
    assert.equal((await row(fresh)).end_date, today);
    await call("POST", `/api/habits/${doneToday}`, { finish: true });
    assert.equal((await row(doneToday)).end_date, today);
    assert.ok(!(await call<{ habits: { id: number }[] }>("GET", "/api/today")).json.habits.some((x) => x.id === doneToday), "в списке дня её больше нет");
    assert.ok((await habits()).finished.some((f) => f.id === doneToday));

    // Отметить завершённую или удалённую нельзя: сайт — 409 с текстом, кнопка в Telegram — короткий ответ.
    const late = await call<{ error: string }>("POST", `/api/habits/${pills}/mark`, { status: "done" });
    assert.deepEqual([late.status, late.json.error], [409, "Эта привычка уже завершена."]);
    assert.equal((await call("POST", `/api/habits/${pills}/mark`, { status: "done", day: d(-6) })).status, 409, "до начала — тоже");
    assert.equal((await call("POST", `/api/habits/${pills}/mark`, { status: "done", day: d(-1) })).status, 200, "в свой срок — можно");
    assert.equal((await call("POST", `/api/habits/${gone}/mark`, { status: "done" })).status, 409);
    assert.equal(await pipeline.markHabit(u, pills, today, "done", "telegram"), "Эта привычка уже завершена.");
    assert.ok(!(await store.marksOf(u.id, today, today)).some((m) => m.habit_id === pills), "отметки нет");
    assert.equal(await habitAnswered(store, [{ text: "✅", data: `habit:${pills}:${today}:done` }]), true, "старый вопрос гаснет");
    // «Ещё нет» у завершённой и удалённой: сайт — 409, кнопка — тот же короткий ответ, без обещания минуса.
    assert.deepEqual([(await call<{ error: string }>("POST", `/api/habits/${pills}/mark`, { status: "later" })).json.error], ["Эта привычка уже завершена."]);
    assert.equal((await call("POST", `/api/habits/${gone}/mark`, { status: "later" })).status, 409);
    assert.equal(await pipeline.habitLater(u, pills, today), "Эта привычка уже завершена.");
    assert.equal(await pipeline.habitLater(u, gone, today), "Этой привычки больше нет.");
    // История дня: закончили сегодня, уже отметив, — завтра этот день по-прежнему показывает её с отметкой.
    assert.equal((await habitsOfDay(store, u, today, addDays(today, 1))).find((x) => x.habit.id === doneToday)?.status, "done", "прошлый день — с ней");
    assert.ok(!(await habitsOfDay(store, u, today)).some((x) => x.habit.id === doneToday), "сегодня — без неё");
    // Старая запись с концом раньше начала (виджет до 26.11.2026) — в «Завершённых» конец не раньше начала.
    const odd = await add("Старая", d(-1), d(-2));
    assert.deepEqual((await habits()).finished.filter((f) => f.id === odd).map((f) => [f.start_date, f.end_date]), [[d(-1), d(-1)]]);

    // Статистика завершённой — до конца срока.
    const st = (await call<{ end_date: string; total: { done: number; planned: number } }>("GET", `/api/habits/${pills}/stats`)).json;
    assert.deepEqual([st.end_date, st.total], [d(-1), { done: 4, planned: 5 }]);

    // «Отменить» завершение — всё как было.
    await call("POST", "/api/undo", { messageId: fin.json.undo });
    assert.deepEqual([(await row(pills)).end_date, (await row(pills)).finished_at], [null, null]);
    assert.ok((await habits()).habits.some((h) => h.id === pills), "снова в сетке");

    // «↺ Вернуть» и его отмена.
    await call("POST", `/api/habits/${pills}`, { finish: true });
    const finishedAt = (await row(pills)).finished_at;
    const back = await call<{ end_date: string | null; finished_at: string | null; status: string; undo: number }>("POST", `/api/habits/${pills}`, { reopen: true });
    assert.deepEqual([back.json.status, back.json.end_date, back.json.finished_at], ["active", null, null]);
    assert.ok((await habits()).habits.some((h) => h.id === pills));
    await call("POST", "/api/undo", { messageId: back.json.undo });
    assert.deepEqual([(await row(pills)).end_date, (await row(pills)).finished_at], [d(-1), finishedAt], "отмена «Вернуть» — снова завершена");
    const course2 = await call<{ end_date: string | null }>("POST", `/api/habits/${course}`, { reopen: true });
    assert.equal(course2.json.end_date, null, "кончившаяся по сроку возвращается без срока");
  } finally {
    server.close();
    store.close();
  }
});

test("чат: «заверши привычку» — в «Завершённые», «верни» — снова идёт, «бросаю» — удалена; отмена возвращает", async () => {
  const store = await Store.open(":memory:");
  const u = await store.ensureUser("100", "Тест", TZ);
  const AT = zonedToUtc("2026-11-26", "12:00", TZ);
  const add = (title: string) => store.addHabit({ user_id: u.id, title, days: "1234567", times: "[]", start_date: "2026-11-01", end_date: null, message_id: null });
  const pills = await add("Аевит");
  const tea = await add("Чай");
  const prompts: string[] = [];
  const answers: unknown[] = [
    { edits: [{ action: "done", kind: "habit", id: pills }], summary: "s" },
    { edits: [{ action: "done", kind: "habit", id: pills }], summary: "s" },
    { edits: [{ action: "reopen", kind: "habit", id: pills }], summary: "s" },
    { edits: [{ action: "cancel", kind: "habit", id: tea }], summary: "s" },
    { habit_marks: [{ habit_id: pills, status: "done", day_iso: "2026-11-26" }], summary: "s" },
  ];
  const llm: LlmCall = async (messages: ChatMessage[]) => {
    prompts.push(messages.map((m) => m.content).join("\n"));
    return JSON.stringify(answers.shift() ?? {});
  };
  const pipe = new Pipeline(store, llm);
  const send = (text: string, id: string) => pipe.handle({ user: u, source: "telegram", sourceId: id, text, at: AT });
  const row = async (id: number) => (await store.habit(id))!;

  const r = await send("заверши привычку аевит", "1");
  assert.match(prompts[0], /Заверши\/закончи привычку X[^\n]*action=done/, "подсказка модели: заверши — done");
  assert.match(r.text, /🏁 привычка завершена: Аевит/);
  assert.deepEqual([(await row(pills)).end_date, Boolean((await row(pills)).finished_at)], ["2026-11-25", true], "не отмечена сегодня — конец вчера");

  const again = await send("заверши аевит", "2");
  assert.match(prompts[1], /#\d+ Аевит \(завершена; /, "модель видит, что она завершена");
  assert.match(again.text, /уже завершена: Аевит/);
  assert.equal((await row(pills)).end_date, "2026-11-25", "повтор не продлевает");

  const back = await send("верни привычку аевит", "3");
  assert.match(back.text, /↺ привычка снова идёт: Аевит/);
  assert.deepEqual([(await row(pills)).end_date, (await row(pills)).finished_at ?? null], [null, null]);
  await pipe.undo(u);
  assert.equal((await row(pills)).end_date, "2026-11-25", "отмена «верни» — снова завершена");
  assert.ok((await row(pills)).finished_at);

  await send("бросаю чай", "4");
  assert.equal((await row(tea)).status, "stopped", "бросаю — удалить, не в «Завершённые»");

  const mark = await send("выпил аевит", "5");
  assert.match(mark.text, /Аевит: эта привычка уже завершена/);
  assert.equal((await store.marksOf(u.id, "2026-11-26", "2026-11-26")).length, 0);

  // Отмена «заверши» — всё как было.
  await store.updateHabit(pills, { end_date: null, finished_at: null });
  answers.push({ edits: [{ action: "done", kind: "habit", id: pills }], summary: "s" });
  await send("закончи аевит", "6");
  assert.ok((await row(pills)).finished_at);
  await pipe.undo(u);
  assert.deepEqual([(await row(pills)).end_date, (await row(pills)).finished_at], [null, null]);
  store.close();
});
