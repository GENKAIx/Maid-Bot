import { PGlite } from "@electric-sql/pglite";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApi } from "../src/api.ts";
import { hashPassword } from "../src/auth.ts";
import { Store, type HabitRow } from "../src/db.ts";
import { PgDriver } from "../src/driver.ts";
import { habitLine, habitMonth, habitStats, habitsOfDay, markTimesOf } from "../src/habits.ts";
import type { LlmCall } from "../src/llm.ts";
import { Pipeline } from "../src/pipeline.ts";
import { habitAnswered, Scheduler } from "../src/scheduler.ts";
import { addDays, dayKey, zonedToUtc } from "../src/time.ts";

// Несколько отметок в день (шаг 42, 27.11.2026): у привычки per_day («пить воду 8 раз»), у отметки дня — count и stamps (время
// каждой отметки). День сделан, когда отмечено per_day раз; меньше — status part: нигде не «сделано» (серии, проценты, напоминания,
// виджет, бот). Для per_day = 1 — всё как раньше.

const TZ = "Europe/Moscow";
const BACKENDS: Record<string, () => Promise<Store>> = {
  sqlite: () => Store.open(":memory:"),
  postgres: async () => {
    const pg = new PGlite();
    return Store.over(new PgDriver(pg, (fn) => pg.transaction((tx) => fn(tx)), () => pg.close()));
  },
};

const habitOf = (store: Store, user_id: number, title: string, per_day = 1, start_date = "2026-11-01", times: string[] = []) =>
  store.addHabit({ user_id, title, days: "1234567", times: JSON.stringify(times), start_date, end_date: null, message_id: null, per_day });

for (const [kind, open] of Object.entries(BACKENDS)) {
  test(`${kind}: stepMark — по одной отметке до per_day, не больше; минус снимает последнюю; отмена возвращает как было`, async () => {
    const store = await open();
    const u = await store.ensureUser("100", "Тест", TZ);
    const h = await habitOf(store, u.id, "Вода", 3);
    assert.equal((await store.habit(h))!.per_day, 3);
    const day = "2026-11-10";
    const mark = async () => (await store.marksOf(u.id, day, day)).find((m) => m.habit_id === h);

    const a = await store.stepMark(h, day, 1, 3, null);
    assert.deepEqual([a.changed, (await mark())!.status, Number((await mark())!.count)], [true, "part", 1]);
    await store.stepMark(h, day, 1, 3, null);
    const c = await store.stepMark(h, day, 1, 3, null);
    const full = (await mark())!;
    assert.deepEqual([full.status, Number(full.count), JSON.parse(full.stamps!).length], ["done", 3, 3]);
    assert.equal(full.at, JSON.parse(full.stamps!).at(-1), "at — последняя отметка");
    assert.equal((await store.stepMark(h, day, 1, 3, null)).changed, false, "полный день не растёт");

    // Отмена последней отметки — как было до неё (part 2).
    await store.restoreMark(c.id, c.before ?? null);
    assert.deepEqual([(await mark())!.status, Number((await mark())!.count)], ["part", 2]);

    const minus = await store.stepMark(h, day, -1, 3, null);
    assert.deepEqual([minus.changed, minus.removed, Number((await mark())!.count), (await mark())!.status], [true, false, 1, "part"]);
    const last = await store.stepMark(h, day, -1, 3, null);
    assert.deepEqual([last.removed, await mark()], [true, undefined], "последняя снята — строки нет");
    await store.restoreMark(last.id, last.before ?? null);
    assert.equal(Number((await mark())!.count), 1, "отмена снятия вернула отметку");
    await store.stepMark(h, day, -1, 3, null);
    assert.equal((await store.stepMark(h, day, -1, 3, null)).changed, false, "минус с нуля — ничего");

    // Пропуск: count 0; минус снимает пропуск; плюс после пропуска — первая отметка.
    await store.markHabit(h, day, "skipped", null, undefined, 3);
    assert.deepEqual([(await mark())!.status, Number((await mark())!.count)], ["skipped", 0]);
    assert.equal((await store.stepMark(h, day, -1, 3, null)).removed, true);
    await store.markHabit(h, day, "skipped", null, undefined, 3);
    await store.stepMark(h, day, 1, 3, null);
    assert.deepEqual([(await mark())!.status, Number((await mark())!.count)], ["part", 1]);
    // «Сделано» целиком (markHabit done с need) — недостающие отметки сейчас.
    await store.markHabit(h, day, "done", null, undefined, 3);
    assert.deepEqual([(await mark())!.status, Number((await mark())!.count), JSON.parse((await mark())!.stamps!).length], ["done", 3, 3]);

    // per_day = 1 — как раньше: «сделано» одной отметкой.
    const one = await habitOf(store, u.id, "Зарядка");
    await store.markHabit(one, day, "done", null);
    const m1 = (await store.marksOf(u.id, day, day)).find((m) => m.habit_id === one)!;
    assert.deepEqual([m1.status, Number(m1.count), JSON.parse(m1.stamps!)], ["done", 1, [m1.at]]);
    await store.close();
  });

  test(`${kind}: смена per_day пересчитывает сегодня и дальше, прошлые дни — как были; миграция: старое «сделано» — одна отметка`, async () => {
    const store = await open();
    const u = await store.ensureUser("100", "Тест", TZ);
    const h = await habitOf(store, u.id, "Вода", 1);
    await store.markHabit(h, "2026-11-09", "done", null);
    await store.markHabit(h, "2026-11-10", "done", null);
    await store.updateHabit(h, { per_day: 4 }, "2026-11-10");
    const st = async (d: string) => (await store.marksOf(u.id, d, d)).find((m) => m.habit_id === h)!;
    assert.equal((await st("2026-11-09")).status, "done", "вчера сделано по прежней норме");
    assert.deepEqual([(await st("2026-11-10")).status, Number((await st("2026-11-10")).count)], ["part", 1]);
    for (let i = 0; i < 3; i++) await store.stepMark(h, "2026-11-10", 1, 4, null);
    await store.updateHabit(h, { per_day: 2 }, "2026-11-10");
    // Норма меньше — «сделано», времена отметок не обрезаются (отмена и возврат нормы их не теряют); показ — не больше нормы.
    assert.deepEqual([(await st("2026-11-10")).status, JSON.parse((await st("2026-11-10")).stamps!).length], ["done", 4]);
    const [mo] = await habitMonth(store, u, "2026-11", "2026-11-10");
    assert.deepEqual([mo.days.find((x) => x.day === "2026-11-10")!.count, mo.days.find((x) => x.day === "2026-11-10")!.need], [2, 2]);

    // Как до шага 42: столбцов нет, отметки старые — после миграции «сделано» — count 1 и время at, пропуск — 0.
    await store.markHabit(h, "2026-11-08", "skipped", null);
    await store.driver.exec("ALTER TABLE habits DROP COLUMN per_day; ALTER TABLE habit_marks DROP COLUMN count; ALTER TABLE habit_marks DROP COLUMN stamps;");
    await store.kvSet("schema_version", "41");
    const again = await Store.over(store.driver);
    assert.equal(await again.kvGet("schema_version"), "42");
    assert.equal((await again.habit(h))!.per_day, 1);
    const old = (await again.marksOf(u.id, "2026-11-08", "2026-11-10")).filter((m) => m.habit_id === h);
    assert.deepEqual(old.map((m) => [m.day_key, m.status, Number(m.count), JSON.parse(m.stamps!).length]), [
      ["2026-11-08", "skipped", 0, 0], ["2026-11-09", "done", 1, 1], ["2026-11-10", "done", 1, 1],
    ]);
    assert.equal(JSON.parse(old[1].stamps!)[0], old[1].at);
    await again.close();
  });

  test(`${kind}: норму снизили и отменили — отметки дня как были (в тот же день и назавтра); прошлые дни по старой норме`, async () => {
    const store = await open();
    const u = await store.ensureUser("100", "Тест", TZ);
    const h = await habitOf(store, u.id, "Вода", 8);
    const D = "2026-11-10";
    const st = async (d: string) => (await store.marksOf(u.id, d, d)).find((m) => m.habit_id === h);
    const view = async (d: string) => { const m = (await st(d))!; return [m.status, JSON.parse(m.stamps!).length]; };
    for (let i = 0; i < 5; i++) await store.stepMark(h, D, 1, 8, null); // сегодня 5 из 8
    for (let i = 0; i < 5; i++) await store.stepMark(h, "2026-11-09", 1, 8, null); // вчера 5 из 8 — промах
    await store.stepMark(h, "2026-11-08", 1, 8, null); // позавчера 1 из 8
    // Отмена как в pipeline.undoOne: сперва отметки из журнала (новые), потом привычка (updateHabit с прежней нормой).
    const undo = async (rows: Awaited<ReturnType<Store["updateHabit"]>>, day: string) => {
      for (const r of [...rows].reverse()) await store.restoreMark(r.id, r);
      await store.updateHabit(h, { per_day: 8 }, day);
    };

    const rows = await store.updateHabit(h, { per_day: 3 }, D);
    assert.deepEqual(await view(D), ["done", 5]);
    assert.deepEqual(await view("2026-11-09"), ["done", 5], "прошлый неполный день, где отметок не меньше новой нормы, — сделан");
    assert.deepEqual(await view("2026-11-08"), ["part", 1]);
    assert.deepEqual(rows.map((r) => r.day_key).sort(), ["2026-11-09", D]);
    await undo(rows, D);
    assert.deepEqual([await view(D), await view("2026-11-09")], [["part", 5], ["part", 5]], "отмена: 5 из 8, ничего не потеряно");

    // Отмена назавтра: строка дня правки возвращается из журнала, а не остаётся «сделано» по отменённой норме.
    const again = await store.updateHabit(h, { per_day: 3 }, D);
    await undo(again, "2026-11-11");
    assert.deepEqual([await view(D), await view("2026-11-09")], [["part", 5], ["part", 5]]);
    assert.deepEqual(await store.updateHabit(h, { per_day: 8 }, D), [], "норма та же — ничего не пересчитывается");

    // −1 при отметках сверх нормы — остаётся норма − 1 (видно сразу).
    await store.updateHabit(h, { per_day: 3 }, D);
    const minus = await store.stepMark(h, D, -1, 3, null);
    assert.deepEqual([minus.count, minus.status, await view(D)], [2, "part", ["part", 2]]);
    await store.close();
  });

  test(`${kind}: норму подняли — прошлое «сделано» не становится неполным от ещё одной отметки`, async () => {
    const store = await open();
    const u = await store.ensureUser("100", "Тест", TZ);
    const h = await habitOf(store, u.id, "Вода", 1);
    await store.markHabit(h, "2026-11-09", "done", null);
    await store.updateHabit(h, { per_day: 3 }, "2026-11-10");
    const plus = await store.stepMark(h, "2026-11-09", 1, 3, null);
    assert.deepEqual([plus.changed, plus.status], [false, "done"]);
    const m = (await store.marksOf(u.id, "2026-11-09", "2026-11-09"))[0];
    assert.deepEqual([m.status, Number(m.count)], ["done", 1]);
    const [row] = await habitMonth(store, u, "2026-11", "2026-11-10");
    assert.equal(row.days.find((x) => x.day === "2026-11-09")!.status, "done");
    // Через pipeline (кнопка, фраза «вчера») — тот же ответ, без новой записи.
    const pipeline = new Pipeline(store, async () => "{}");
    assert.match(await pipeline.markHabit(u, h, "2026-11-09", 1, "web"), /уже отмечено 3\/3/);
    assert.equal(Number((await store.marksOf(u.id, "2026-11-09", "2026-11-09"))[0].count), 1);
    await store.close();
  });

  test(`${kind}: минус в полночь — неполный вчерашний день остаётся с отметками, пустой получает минус`, async () => {
    const store = await open();
    const u = await store.ensureUser("100", "Тест", TZ);
    const a = await habitOf(store, u.id, "Вода", 3, "2026-11-01", ["09:00"]);
    const b = await habitOf(store, u.id, "Зарядка", 1, "2026-11-01", ["09:00"]);
    await store.stepMark(a, "2026-11-12", 1, 3, null);
    const sch = new Scheduler(store, null, async () => {});
    await sch.tick(new Date("2026-11-12T21:05:00Z")); // 00:05 МСК 13-го
    const marks = await store.marksOf(u.id, "2026-11-12", "2026-11-12");
    assert.deepEqual(marks.map((m) => [m.habit_id, m.status, Number(m.count)]).sort(), [[a, "part", 1], [b, "skipped", 0]]);
    const [d] = await habitsOfDay(store, u, "2026-11-13");
    assert.equal(d.yesterday, "none", "неполный вчера — можно спасти");
    await store.close();
  });
}

test("неполный день — не сделан: серия, проценты, вчера «none», напоминания и строка бота; месяц — count и need", async () => {
  const store = await Store.open(":memory:");
  const u = await store.ensureUser("100", "Тест", TZ);
  const h = await habitOf(store, u.id, "Вода", 3, "2026-11-01");
  for (const d of ["2026-11-07", "2026-11-08"]) await store.markHabit(h, d, "done", null, undefined, 3);
  await store.stepMark(h, "2026-11-09", 1, 3, null); // вчера — 1 из 3
  await store.stepMark(h, "2026-11-10", 1, 3, null);
  await store.stepMark(h, "2026-11-10", 1, 3, null); // сегодня — 2 из 3

  const [d] = await habitsOfDay(store, u, "2026-11-10", "2026-11-10");
  assert.deepEqual([d.status, d.count, d.need, d.streak, d.yesterday], [null, 2, 3, 0, "none"], "вчера отмечено не всё — серия порвана, вчера можно спасти");
  assert.equal(d.doneDays, 2);
  assert.match(habitLine(d), /◐ Вода 2\/3/);
  assert.ok(d.at_time, "время последней отметки");

  // Вопрос про привычку не закрыт: отмечено не всё.
  const q = [{ text: "✅ Да", data: `habit:${h}:2026-11-10:done` }];
  assert.equal(await habitAnswered(store, q), false);
  await store.stepMark(h, "2026-11-10", 1, 3, null);
  assert.equal(await habitAnswered(store, q), true, "отмечено всё — вопрос не нужен");

  const [row] = await habitMonth(store, u, "2026-11", "2026-11-10");
  assert.equal(row.per_day, 3);
  const day = (k: string) => row.days.find((x) => x.day === k)!;
  assert.deepEqual([day("2026-11-09").status, day("2026-11-09").count, day("2026-11-09").need], [null, 1, 3]);
  assert.deepEqual([day("2026-11-10").status, day("2026-11-10").count], ["done", 3]);
  assert.deepEqual([day("2026-11-11").status, day("2026-11-11").count], [null, 0]);

  const st = await habitStats(store, u, (await store.habit(h))!, "2026-11-10");
  // 1–6 ноября не отмечены, 7 и 8 сделаны, 9 — неполный (промах), 10 — сделан.
  assert.deepEqual([st.total.done, st.total.planned, st.streak, st.best], [3, 10, 1, 2]);
  assert.deepEqual(st.year.find((c) => c.day === "2026-11-09"), { day: "2026-11-09", s: "miss", k: "part", p: 0.33 }, "неполный — доля для заливки");
  await store.markHabit(h, "2026-11-06", "skipped", null);
  const st2 = await habitStats(store, u, (await store.habit(h))!, "2026-11-10");
  assert.deepEqual([st2.year.find((c) => c.day === "2026-11-06")!.k, st2.year.find((c) => c.day === "2026-11-05")!.k], ["skip", undefined]);
  store.close();
});

test("«Во сколько отмечали» — весь срок, каждая отметка точкой (n — номер в дне), per_day и remind", () => {
  const h = { id: 1, user_id: 1, title: "Таблетки", days: "1234567", times: '["20:00","08:00"]', start_date: "2026-10-01", end_date: null, status: "active", message_id: null, per_day: 2 } as HabitRow;
  const at = (d: string, t: string) => zonedToUtc(d, t, TZ).toISOString();
  const marks = [
    { id: 1, habit_id: 1, day_key: "2026-10-01", status: "done" as const, at: at("2026-10-01", "21:05"), message_id: 1, amount: null, unit: "", count: 2, stamps: JSON.stringify([at("2026-10-01", "08:10"), at("2026-10-01", "21:05")]) },
    { id: 2, habit_id: 1, day_key: "2026-10-03", status: "part" as const, at: at("2026-10-03", "09:00"), message_id: 2, amount: null, unit: "", count: 1, stamps: JSON.stringify([at("2026-10-03", "09:00")]) },
  ];
  const t = markTimesOf(h, marks, "2026-11-27", TZ, "12:00");
  assert.deepEqual([t.from, t.to, t.per_day, t.remind], ["2026-10-01", "2026-11-27", 2, ["08:00", "20:00"]]);
  assert.deepEqual(t.points, [
    { day: "2026-10-01", time: "08:10", min: 490, gap: false, n: 1 },
    { day: "2026-10-01", time: "21:05", min: 1265, gap: false, n: 2 },
    { day: "2026-10-03", time: "09:00", min: 540, gap: true, n: 1 },
  ]);
});

test("кнопка «сделал» и фраза у ×N — одна отметка; веб: step ±1, per_day, месяц и статистика; отмена", async () => {
  const store = await Store.open(":memory:");
  const u = await store.ensureUser("100", "Тест", TZ);
  await store.updateUser(u.id, { login: "owner", password_hash: await hashPassword("secret-pass-1") });
  const today = dayKey(new Date(), TZ);
  const h = await habitOf(store, u.id, "Вода", 3, addDays(today, -3));
  const answers: unknown[] = [
    { habit_marks: [{ habit_id: h, status: "done" }], summary: "s" },
    { habits: [{ title: "Пить воду", days: "1234567", times: [], per_day: 8 }, { title: "Таблетки", times: ["09:00", "21:00"], per_day: 2 }], summary: "s" },
    { edits: [{ action: "per_day", kind: "habit", id: h, new_per_day: 6 }], summary: "s" },
  ];
  const llm: LlmCall = async () => JSON.stringify(answers.shift() ?? {});
  const pipeline = new Pipeline(store, llm);
  const mark = async () => (await store.marksOf(u.id, today, today)).find((m) => m.habit_id === h);

  // Кнопка напоминания (runButton, бот, виджет — pipeline.markHabit «done»): у ×N — одна отметка.
  assert.match(await pipeline.markHabit(u, h, today, "done", "push"), /Вода: 1\/3/);
  assert.deepEqual([(await mark())!.status, Number((await mark())!.count)], ["part", 1]);
  // Фраза «выпил стакан воды» — habit_marks done — ещё одна.
  const r = await pipeline.handle({ user: u, source: "telegram", sourceId: "1", text: "выпил стакан воды", at: new Date() });
  assert.ok(r.changes?.some((c) => c.kind === "mark" && /2\/3/.test(c.detail ?? "")));
  assert.equal(Number((await mark())!.count), 2);
  await pipeline.undo(u);
  assert.equal(Number((await mark())!.count), 1, "отмена фразы — минус одна");

  // Новые привычки с per_day из разбора.
  await pipeline.handle({ user: u, source: "telegram", sourceId: "2", text: "пить 8 стаканов воды в день и таблетки утром и вечером", at: new Date() });
  const made = (await store.activeHabits(u.id)).filter((x) => x.id !== h);
  assert.deepEqual(made.map((x) => [x.title, x.per_day, x.times]), [["Пить воду", 8, "[]"], ["Таблетки", 2, '["09:00","21:00"]']]);

  const server = createApi({ store, pipeline }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, token?: string) => {
    const res = await fetch(base + path, {
      method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };
  try {
    const token = (await call("POST", "/api/login", { login: "owner", password: "secret-pass-1", label: "test" })).json.token as string;
    const up = await call("POST", `/api/habits/${h}/mark`, { step: 1 }, token);
    assert.deepEqual([up.status, up.json.count, up.json.need, up.json.status], [200, 2, 3, null]);
    const full = await call("POST", `/api/habits/${h}/mark`, { step: 1 }, token);
    assert.deepEqual([full.json.count, full.json.status], [3, "done"]);
    assert.match((await call("POST", `/api/habits/${h}/mark`, { step: 1 }, token)).json.text, /уже отмечено 3\/3/);
    const down = await call("POST", `/api/habits/${h}/mark`, { step: -1 }, token);
    assert.deepEqual([down.json.count, down.json.status], [2, null]);
    await call("POST", "/api/undo", {}, token);
    assert.deepEqual([(await mark())!.status, Number((await mark())!.count)], ["done", 3], "отмена минуса");
    assert.equal((await call("POST", `/api/habits/${h}/mark`, { step: 2 }, token)).status, 400);
    // −1 у пропуска — пропуск снят; −1 с нуля — «отметок нет», count 0.
    const y = addDays(today, -1);
    await call("POST", `/api/habits/${h}/mark`, { status: "skipped", day: y }, token);
    const unskip = await call("POST", `/api/habits/${h}/mark`, { step: -1, day: y }, token);
    assert.deepEqual([unskip.status, unskip.json.count, unskip.json.status], [200, 0, null]);
    assert.match(unskip.json.text, /Пропуск снят/);
    const zero = await call("POST", `/api/habits/${h}/mark`, { step: -1, day: y }, token);
    assert.deepEqual([zero.json.count, zero.json.status], [0, null]);
    assert.match(zero.json.text, /отметок нет/);

    // Сегодня и месяц: count, need; статистика — точки на каждую отметку.
    const month = await call("GET", `/api/habits?month=${today.slice(0, 7)}`, undefined, token);
    const row = month.json.habits.find((x: { id: number }) => x.id === h);
    assert.equal(row.per_day, 3);
    assert.deepEqual([row.days.find((x: { day: string }) => x.day === today).count, row.days.find((x: { day: string }) => x.day === today).need], [3, 3]);
    const td = month.json.today.find((x: { habit: { id: number } }) => x.habit.id === h);
    assert.deepEqual([td.status, td.count, td.need], ["done", 3, 3]);
    const stats = await call("GET", `/api/habits/${h}/stats`, undefined, token);
    assert.deepEqual([stats.json.mark_times.from, stats.json.mark_times.per_day], [addDays(today, -3), 3]);
    assert.deepEqual(stats.json.mark_times.points.filter((p: { day: string }) => p.day === today).map((p: { n: number }) => p.n), [1, 2, 3]);

    // per_day правкой мышью: сегодня пересчитано, отмена возвращает.
    const ed = await call("POST", `/api/habits/${h}`, { per_day: 5 }, token);
    assert.equal(ed.json.per_day, 5);
    assert.deepEqual([(await mark())!.status, Number((await mark())!.count)], ["part", 3]);
    await call("POST", "/api/undo", { messageId: ed.json.undo }, token);
    assert.equal((await store.habit(h))!.per_day, 3);
    assert.equal((await mark())!.status, "done", "отмена вернула норму и «сделано»");
    assert.equal((await call("POST", `/api/habits/${h}`, { per_day: 13 }, token)).status, 400);
  } finally {
    server.close();
  }

  // Фраза «пить воду 6 раз в день» — правка per_day; отмена.
  await pipeline.handle({ user: u, source: "telegram", sourceId: "3", text: "пить воду 6 раз в день", at: new Date() });
  assert.equal((await store.habit(h))!.per_day, 6);
  assert.equal((await mark())!.status, "part");
  await pipeline.undo(u);
  assert.equal((await store.habit(h))!.per_day, 3);
  store.close();
});
