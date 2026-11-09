import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../src/db.ts";
import { escapeKind, escapesText } from "../src/escapes.ts";
import { extendSeries, HORIZON, repeatDates, setRepeat } from "../src/repeat.ts";
import { addDays } from "../src/time.ts";

// Повтор плана (ПКМ в виджете) и недельная сводка «сбежали от задач».

test("даты повтора: каждый день, будни, неделя, две недели, месяц (31-е в коротком — последнее)", () => {
  assert.deepEqual(repeatDates("2026-11-09", "daily", "2026-11-09", "2026-11-12"), ["2026-11-10", "2026-11-11", "2026-11-12"]);
  // 2026-11-13 — пятница: дальше понедельник.
  assert.deepEqual(repeatDates("2026-11-12", "weekdays", "2026-11-12", "2026-11-17"), ["2026-11-13", "2026-11-16", "2026-11-17"]);
  assert.deepEqual(repeatDates("2026-11-09", "weekly", "2026-11-09", "2026-11-30"), ["2026-11-16", "2026-11-23", "2026-11-30"]);
  assert.deepEqual(repeatDates("2026-11-09", "biweekly", "2026-11-16", "2026-12-31"), ["2026-11-23", "2026-12-07", "2026-12-21"]);
  assert.deepEqual(repeatDates("2026-01-31", "monthly", "2026-01-31", "2026-04-30"), ["2026-02-28", "2026-03-31", "2026-04-30"]);
});

test("серия: копии на HORIZON дней, досоздание без дублей, перестать повторять убирает будущие", async () => {
  const store = await Store.open(":memory:");
  const u = await store.ensureUser("100", "Тест", "Europe/Moscow");
  const today = "2026-11-09";
  const id = await store.addEvent({ user_id: u.id, title: "Спортзал", date_iso: today, time: "19:00", end_time: "20:30", details: "", domain: "", message_id: null });
  const now = new Date("2026-11-09T08:00:00Z");

  const r = await setRepeat(store, u, (await store.event(id))!, "weekly", today, now);
  assert.equal(r.event.repeat, "weekly");
  assert.equal(r.made, HORIZON / 7);
  const copies = (await store.allEvents(u.id)).filter((e) => e.series === id);
  assert.equal(copies.length, 8);
  assert.equal(copies[0].date_iso, "2026-11-16");
  assert.equal(copies[0].time, "19:00");
  assert.equal(copies[0].end_time, "20:30");

  // Через неделю досоздаётся одна новая, старые не дублируются; перенесённая копия не возвращается на старое место.
  await store.updateEvent(copies[1].id, { date_iso: "2026-11-24" });
  assert.equal(await extendSeries(store, u, (await store.event(id))!, today, now), 0);
  assert.equal(await extendSeries(store, u, (await store.event(id))!, addDays(today, 7), now), 1);
  const all = (await store.allEvents(u.id)).filter((e) => e.series === id && e.status === "active");
  assert.equal(all.length, 9);
  assert.ok(!all.some((e) => e.date_iso === "2026-11-23"), "перенесённая копия не создана заново");

  // Отменённое занятие остаётся отменённым; перестать повторять с третьего — после него будущие активные уходят.
  await store.updateEvent(copies[0].id, { status: "cancelled" });
  const third = (await store.event(copies[2].id))!;
  const stop = await setRepeat(store, u, third, "", today, now);
  assert.equal(stop.event.repeat, "");
  assert.equal((await store.event(id))!.repeat, "", "старое начало серии больше не продолжает её");
  const left = (await store.allEvents(u.id)).filter((e) => e.status === "active" && e.title === "Спортзал").map((e) => e.date_iso);
  assert.deepEqual(left, ["2026-11-09", "2026-11-24", "2026-11-30"]);
  assert.equal((await store.event(copies[0].id))!.status, "cancelled");
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
