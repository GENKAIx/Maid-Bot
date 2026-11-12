import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApi } from "../src/api.ts";
import { hashPassword } from "../src/auth.ts";
import { Store, type HabitRow, type MarkRow } from "../src/db.ts";
import { habitStatsOf } from "../src/habits.ts";
import { Pipeline } from "../src/pipeline.ts";
import { addDays } from "../src/time.ts";

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
    assert.equal((await get(other)).status, 404);
  } finally {
    server.close();
  }
});
