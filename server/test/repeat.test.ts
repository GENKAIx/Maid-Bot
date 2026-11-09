import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../src/db.ts";
import { escapeKind, escapesText } from "../src/escapes.ts";
import { extendSeries, HORIZON, seriesDates, setRepeat, specOf } from "../src/repeat.ts";
import { addDays } from "../src/time.ts";

// Повтор плана (ПКМ в виджете) и недельная сводка «сбежали от задач».

test("даты повтора: дни, дни недели через неделю, месяц, конец по числу и по дате", () => {
  const last = "2026-12-31";
  assert.deepEqual(seriesDates("2026-11-09", { kind: "day", every: 1, count: 4 }, last), ["2026-11-10", "2026-11-11", "2026-11-12"]);
  assert.deepEqual(seriesDates("2026-11-09", { kind: "day", every: 3, until: "2026-11-20" }, last), ["2026-11-12", "2026-11-15", "2026-11-18"]);
  // 2026-11-09 — понедельник: пн, ср, пт, 5 раз всего.
  assert.deepEqual(seriesDates("2026-11-09", { kind: "week", every: 1, days: [1, 3, 5], count: 5 }, last), ["2026-11-11", "2026-11-13", "2026-11-16", "2026-11-18"]);
  // Через неделю: вторник и четверг первой, третьей недели…
  assert.deepEqual(seriesDates("2026-11-09", { kind: "week", every: 2, days: [2, 4] }, "2026-11-30"), ["2026-11-10", "2026-11-12", "2026-11-24", "2026-11-26"]);
  assert.deepEqual(seriesDates("2026-01-31", { kind: "month", every: 1, count: 4 }, last), ["2026-02-28", "2026-03-31", "2026-04-30"]);
  // Старые значения repeat читаются как настройка.
  assert.deepEqual(specOf("weekdays", "2026-11-09"), { kind: "week", every: 1, days: [1, 2, 3, 4, 5] });
  assert.deepEqual(specOf("biweekly", "2026-11-09"), { kind: "week", every: 2, days: [1] });
  assert.equal(specOf("", "2026-11-09"), null);
});

test("серия: без конца — на HORIZON дней с досозданием, с концом — сразу вся; перестать повторять убирает будущие", async () => {
  const store = await Store.open(":memory:");
  const u = await store.ensureUser("100", "Тест", "Europe/Moscow");
  const today = "2026-11-09";
  const id = await store.addEvent({ user_id: u.id, title: "Спортзал", date_iso: today, time: "19:00", end_time: "20:30", details: "", domain: "", message_id: null });
  const now = new Date("2026-11-09T08:00:00Z");

  const r = await setRepeat(store, u, (await store.event(id))!, { kind: "week", every: 1, days: [1] }, today, now);
  assert.ok(r.endless);
  assert.equal(r.made, HORIZON / 7);
  assert.equal(r.dates[0], "2026-11-16");
  const copies = (await store.allEvents(u.id)).filter((e) => e.series === id);
  assert.equal(copies.length, 8);
  assert.equal(copies[0].time, "19:00");
  assert.equal(copies[0].end_time, "20:30");

  // Через неделю досоздаётся одна новая, старые не дублируются; перенесённая копия не возвращается на старое место.
  await store.updateEvent(copies[1].id, { date_iso: "2026-11-24" });
  assert.equal((await extendSeries(store, u, (await store.event(id))!, today, now)).length, 0);
  assert.equal((await extendSeries(store, u, (await store.event(id))!, addDays(today, 7), now)).length, 1);
  const all = (await store.allEvents(u.id)).filter((e) => e.series === id && e.status === "active");
  assert.equal(all.length, 9);
  assert.ok(!all.some((e) => e.date_iso === "2026-11-23"), "перенесённая копия не создана заново");

  // Отменённое занятие остаётся отменённым; перестать повторять с третьего — после него будущие активные уходят.
  await store.updateEvent(copies[0].id, { status: "cancelled" });
  const stop = await setRepeat(store, u, (await store.event(copies[2].id))!, null, today, now);
  assert.equal(stop.event.repeat, "");
  assert.equal((await store.event(id))!.repeat, "", "старое начало серии больше не продолжает её");
  const left = (await store.allEvents(u.id)).filter((e) => e.status === "active" && e.title === "Спортзал").map((e) => e.date_iso);
  assert.deepEqual(left, ["2026-11-09", "2026-11-24", "2026-11-30"]);
  assert.equal((await store.event(copies[0].id))!.status, "cancelled");

  // С концом: 12 раз по будням — 11 копий сразу, дальше не досоздаётся.
  const gym = await store.addEvent({ user_id: u.id, title: "Курс", date_iso: today, time: "08:00", end_time: null, details: "", domain: "", message_id: null });
  const c = await setRepeat(store, u, (await store.event(gym))!, { kind: "week", every: 1, days: [1, 2, 3, 4, 5], count: 12 }, today, now);
  assert.equal(c.made, 11);
  assert.equal(c.endless, false);
  assert.equal(c.dates.at(-1), "2026-11-24");
  assert.equal((await extendSeries(store, u, (await store.event(gym))!, addDays(today, 60), now)).length, 0);
});

test("сводка «сбежали»: за 7 дней, чаще всего — по словам названия", async () => {
  const store = await Store.open(":memory:");
  const u = await store.ensureUser("100", "Тест", "Europe/Moscow");
  const add = (title: string, category = "") =>
    store.addTask({ user_id: u.id, title, priority: "normal", category, due_date: "2026-11-05", notes: "", message_id: null });
  const ids = [await add("Позвонить маме"), await add("Созвон с банком"), await add("Купить корм"), await add("Перезвонить врачу")];
  for (const id of ids) await store.updateTask(id, { status: "dodged" });
  const done = await add("Позвонить бабушке");
  await store.updateTask(done, { status: "done" });
  const today = new Date().toISOString().slice(0, 10);

  const tasks = await store.allTasks(u.id);
  assert.ok(tasks.every((t) => t.closed_at), "закрытым ставится дата закрытия");
  const text = escapesText(tasks, today, "UTC")!;
  assert.match(text, /убежали от 4 задач — чаще всего от звонков/);
  assert.match(text, /«Перезвонить врачу»/);
  assert.equal(escapesText(tasks, addDays(today, 8), "UTC"), null, "старше недели — не считается");

  await store.updateTask(ids[0], { status: "open" });
  assert.equal((await store.task(ids[0]))!.closed_at, null, "снова открытая — без даты закрытия");
  assert.equal(escapeKind({ title: "Что-то", category: "Работа" }), "работа");
  assert.equal(escapeKind({ title: "Что-то", category: "" }), null);
  assert.match(escapesText([{ ...tasks[1], title: "Одна" } as never], today, "UTC")!, /от 1 задачи\./);
});
