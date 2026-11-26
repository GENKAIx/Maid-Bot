import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApi } from "../src/api.ts";
import { hashPassword } from "../src/auth.ts";
import { Store, type HabitRow, type MarkRow } from "../src/db.ts";
import { habitStatsOf, markTimesOf } from "../src/habits.ts";
import { Pipeline } from "../src/pipeline.ts";
import { addDays, zonedToUtc } from "../src/time.ts";

// Статистика привычки (страница «Привычки», щелчок по названию): год клетками, серии, проценты, дни недели, месяцы.

const habit = (over: Partial<HabitRow> = {}): HabitRow => ({
  id: 1, user_id: 1, title: "Аевит", days: "1234567", times: "[]", start_date: "2026-11-01", end_date: null,
  status: "active", message_id: null, ...over,
} as HabitRow);

test("статистика: проценты не считают сегодняшнее неотмеченное, серии, дни недели, год с понедельника", () => {
  // 1–12 ноября 2026 (12-е — четверг, сегодня): сделано всё, кроме 10-го (пропуск) и 11-го (не отмечено); сегодня не отмечено.
  const marks = new Map<string, MarkRow["status"]>();
  for (let d = "2026-11-01"; d <= "2026-11-09"; d = addDays(d, 1)) marks.set(d, "done");
  marks.set("2026-11-10", "skipped");
  const s = habitStatsOf(habit(), marks, "2026-11-12");
  assert.deepEqual(s.total, { done: 9, planned: 11 });
  assert.deepEqual(s.rate30, { done: 9, planned: 11 });
  assert.equal(s.best, 9);
  assert.equal(s.streak, 0, "вчера не сделано — серия прервана");
  assert.equal(s.year.length, 53 * 7);
  assert.equal(s.year[0].day, "2025-11-10", "понедельник 52 недели назад");
  assert.equal(s.year.at(-1)!.day, "2026-11-15", "воскресенье этой недели");
  const at = (d: string) => s.year.find((x) => x.day === d)!.s;
  assert.deepEqual(["2026-10-31", "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"].map(at), ["off", "done", "miss", "miss", "today", "wait"]);
  // 10.11 — вторник, 11.11 — среда: по одному промаху; понедельник — два раза сделан.
  assert.deepEqual(s.weekdays.map((w) => `${w.done}/${w.planned}`), ["2/2", "1/2", "1/2", "1/1", "1/1", "1/1", "2/2"]);
  assert.equal(s.months.length, 12);
  assert.deepEqual(s.months.at(-1), { month: "2026-11", done: 9, planned: 11 });
  assert.equal(s.months[0].month, "2025-12");
});

test("статистика: дни не по расписанию — отдых, сделанное сегодня считается, законченная привычка — до конца срока", () => {
  const marks = new Map<string, MarkRow["status"]>([["2026-11-02", "done"], ["2026-11-04", "done"], ["2026-11-06", "done"]]);
  // Пн, ср, пт; курс до 6.11, сегодня 12.11.
  const s = habitStatsOf(habit({ days: "135", end_date: "2026-11-06", status: "stopped" }), marks, "2026-11-12");
  assert.deepEqual(s.total, { done: 3, planned: 3 });
  assert.equal(s.best, 3);
  assert.equal(s.year.find((x) => x.day === "2026-11-03")!.s, "rest");
  assert.equal(s.year.find((x) => x.day === "2026-11-09")!.s, "off", "после конца срока");
  const today = habitStatsOf(habit(), new Map([["2026-11-12", "done"]]), "2026-11-12");
  assert.deepEqual(today.rate30, { done: 1, planned: 12 });
  assert.equal(today.streak, 1);
});

test("/api/habits/:id/stats: своя привычка — статистика, чужая — 404", async () => {
  const store = await Store.open(":memory:");
  const u = await store.ensureUser("100", "Тест", "Europe/Moscow");
  await store.updateUser(u.id, { login: "owner", password_hash: await hashPassword("secret-pass-1") });
  const h = await store.addHabit({ user_id: u.id, title: "Аевит", days: "1234567", times: "[]", start_date: "2026-01-01", end_date: null, message_id: null });
  const other = await store.addHabit({ user_id: (await store.ensureUser("200", "Чужой", "Europe/Moscow")).id, title: "Чужая", days: "1234567", times: "[]", start_date: "2026-01-01", end_date: null, message_id: null });
  await store.markHabit(h, "2026-01-02", "done", null);
  const server = createApi({ store, pipeline: new Pipeline(store, async () => "{}") }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const login = await fetch(base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ login: "owner", password: "secret-pass-1" }) });
    const { token } = (await login.json()) as { token: string };
    const get = (id: number) => fetch(`${base}/api/habits/${id}/stats`, { headers: { Authorization: `Bearer ${token}` } });
    const r = await get(h);
    assert.equal(r.status, 200);
    const s = (await r.json()) as { title: string; total: { done: number }; year: unknown[] };
    assert.equal(s.title, "Аевит");
    assert.equal(s.total.done, 1);
    assert.equal(s.year.length, 371);
    const mt = (s as unknown as { mark_times: { remind: string[]; points: unknown[] } }).mark_times;
    assert.deepEqual(mt.remind, ["12:00"], "время из настроек, как у 🔔");
    assert.ok(Array.isArray(mt.points));
    assert.equal((await get(other)).status, 404);
  } finally {
    server.close();
  }
});

// «Во сколько отмечали» (26.11.2026): время «сделал» в поясе человека за последние 30 дней срока, линия рвётся на днях без такой отметки.
const TZ = "Asia/Yekaterinburg"; // UTC+5
const mk = (day: string, status: MarkRow["status"], atDay: string, time: string, message_id: number | null = 7): MarkRow =>
  ({ id: 0, habit_id: 1, day_key: day, status, at: zonedToUtc(atDay, time, TZ).toISOString(), message_id, amount: null, unit: "" });

test("во сколько отмечали: только «сделал» в тот же день, в поясе человека; пропуск, минус в полночь и задним числом — нет", () => {
  const marks = [
    mk("2026-11-20", "done", "2026-11-20", "12:04"),
    mk("2026-11-21", "done", "2026-11-21", "23:50"), // по UTC это 18:50 — считаем по поясу
    mk("2026-11-22", "skipped", "2026-11-22", "21:00"),
    mk("2026-11-23", "skipped", "2026-11-24", "00:01", null), // минус в полночь
    mk("2026-11-24", "done", "2026-11-25", "10:02"), // задним числом
    mk("2026-11-25", "done", "2026-11-25", "08:30"),
    { ...mk("2026-11-25", "done", "2026-11-25", "09:00"), habit_id: 2 }, // чужая привычка
  ];
  const t = markTimesOf(habit({ start_date: "2026-11-20" }), marks, "2026-11-26", TZ, "12:00");
  assert.equal(t.from, "2026-11-20", "не раньше начала");
  assert.equal(t.to, "2026-11-26");
  assert.deepEqual(t.points, [
    { day: "2026-11-20", time: "12:04", min: 724, gap: false },
    { day: "2026-11-21", time: "23:50", min: 1430, gap: false },
    { day: "2026-11-25", time: "08:30", min: 510, gap: true },
  ]);
  assert.deepEqual(t.remind, ["12:00"], "своего времени нет — общее из настроек, как у 🔔");
});

test("во сколько отмечали: окно 30 дней, у законченной — до конца срока; свои напоминания и «без напоминаний»", () => {
  const marks: MarkRow[] = [];
  for (let d = "2026-09-01"; d <= "2026-10-31"; d = addDays(d, 1)) marks.push(mk(d, "done", d, "07:15"));
  const run = markTimesOf(habit({ start_date: "2026-09-01", times: '["21:00","09:00"]' }), marks, "2026-10-31", TZ, "12:00");
  assert.equal(run.from, "2026-10-02");
  assert.equal(run.points.length, 30);
  assert.ok(run.points.every((p) => !p.gap));
  assert.deepEqual(run.remind, ["09:00", "21:00"]);
  const fin = markTimesOf(habit({ start_date: "2026-09-01", end_date: "2026-09-20", finished_at: "2026-09-20T10:00:00Z", quiet: 1 } as Partial<HabitRow>), marks, "2026-11-26", TZ, "12:00");
  assert.deepEqual([fin.from, fin.to, fin.points.length, fin.points.at(-1)!.day], ["2026-09-01", "2026-09-20", 20, "2026-09-20"]);
  assert.deepEqual(fin.remind, [], "без напоминаний — линии нет");
  // Пн, ср, пт: дни не по расписанию линию не рвут, сегодняшнее неотмеченное — тоже.
  const mwf = markTimesOf(habit({ start_date: "2026-10-26", days: "135" }), [mk("2026-10-26", "done", "2026-10-26", "10:00"), mk("2026-10-28", "done", "2026-10-28", "11:00")], "2026-10-30", TZ, "12:00");
  assert.deepEqual(mwf.points.map((p) => p.gap), [false, false]);
});
