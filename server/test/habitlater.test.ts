import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../src/db.ts";
import { habitLaterTime, habitsOfDay } from "../src/habits.ts";
import { Pipeline } from "../src/pipeline.ts";
import { habitButtons, Scheduler, type Button } from "../src/scheduler.ts";

// «Да / Ещё нет / Нет» у вопроса про привычку и минус за день без ответа.

async function setup() {
  const store = await Store.open(":memory:");
  const u = await store.ensureUser("100", "Тест", "Europe/Moscow");
  const hid = await store.addHabit({ user_id: u.id, title: "Зарядка", days: "1234567", times: '["09:00"]', start_date: "2026-11-01", end_date: null, message_id: null });
  const sent: { text: string; buttons?: Button[] }[] = [];
  const sch = new Scheduler(store, null, async (_u, text, _e, buttons) => void (buttons?.some((b) => b.data.startsWith("habit:")) && sent.push({ text, buttons })));
  return { store, u, hid, sent, sch, pipe: new Pipeline(store, async () => "{}") };
}

test("вопрос про привычку — три кнопки: Да, Ещё нет, Нет", () => {
  assert.deepEqual(habitButtons(7, "2026-11-12").map((b) => [b.text, b.data]), [
    ["✅ Да", "habit:7:2026-11-12:done"],
    ["⏳ Ещё нет", "habit:7:2026-11-12:later"],
    ["✖ Нет", "habit:7:2026-11-12:skipped"],
  ]);
  assert.equal(habitLaterTime("09:05"), "11:05");
  assert.equal(habitLaterTime("22:10"), "23:30");
  assert.equal(habitLaterTime("23:00"), null);
});

test("«Ещё нет»: отметки нет, спрашивает ещё раз через 2 часа — один раз", async () => {
  const { store, u, hid, sent, sch, pipe } = await setup();
  await sch.tick(new Date("2026-11-12T06:05:00Z")); // 09:05 МСК
  assert.equal(sent.length, 1);
  const text = await pipe.habitLater(u, hid, "2026-11-12", new Date("2026-11-12T06:06:00Z"));
  assert.match(text, /спрошу ещё раз в 11:06/);
  assert.match(text, /минус/);
  assert.equal((await store.marksOf(u.id, "2026-11-12", "2026-11-12")).length, 0);
  await sch.tick(new Date("2026-11-12T07:00:00Z"));
  assert.equal(sent.length, 1);
  await sch.tick(new Date("2026-11-12T08:10:00Z")); // 11:10
  await sch.tick(new Date("2026-11-12T08:20:00Z"));
  assert.equal(sent.length, 2);
  await store.close();
});

test("не ответил до конца дня — минус; вчера всё ещё можно спасти", async () => {
  const { store, u, hid, sch, pipe } = await setup();
  await sch.tick(new Date("2026-11-12T21:05:00Z")); // 00:05 МСК 13-го
  const marks = await store.marksOf(u.id, "2026-11-12", "2026-11-12");
  assert.deepEqual(marks.map((m) => [m.habit_id, m.status]), [[hid, "skipped"]]);
  const [d] = await habitsOfDay(store, u, "2026-11-13");
  assert.equal(d.yesterday, "none"); // минус сам — «вчера — спасти серию» остаётся
  // Отвеченное «Да» минусом не перезаписывается.
  await pipe.markHabit(u, hid, "2026-11-13", "done", "web");
  await sch.tick(new Date("2026-11-13T21:05:00Z"));
  assert.equal((await store.marksOf(u.id, "2026-11-13", "2026-11-13"))[0].status, "done");
  // Своё «Нет» — уже не «спасти».
  await pipe.markHabit(u, hid, "2026-11-14", "skipped", "web");
  assert.equal((await habitsOfDay(store, u, "2026-11-15"))[0].yesterday, "skipped");
  await store.close();
});
