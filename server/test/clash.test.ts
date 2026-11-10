import assert from "node:assert/strict";
import { test } from "node:test";
import { overlaps, shiftTime } from "../src/clash.ts";
import { Store } from "../src/db.ts";
import type { LlmCall } from "../src/llm.ts";
import { Pipeline } from "../src/pipeline.ts";
import { zonedToUtc } from "../src/time.ts";

// План лёг на занятое время: горничная спрашивает «Сдвинуть на …?» кнопками «Сдвинуть» / «Оставить» (clash.ts).

const TZ = "Europe/Moscow";
const AT = zonedToUtc("2026-11-08", "10:00", TZ);
const DAY = "2026-11-09";

async function setup(answers: unknown[]) {
  const store = await Store.open(":memory:");
  const u = await store.ensureUser("100", "Тест", TZ);
  const llm: LlmCall = async () => JSON.stringify(answers.shift() ?? {});
  return { store, u, pipe: new Pipeline(store, llm) };
}
const busy = (store: Store, userId: number, title: string, time: string, end: string | null = null) =>
  store.addEvent({ user_id: userId, title, date_iso: DAY, time, end_time: end, details: "", domain: "life", message_id: null });
const say = (title: string, time: string | null, end: string | null = null) =>
  ({ events: [{ title, date_iso: DAY, time, end_time: end }], summary: "s" });
const msg = (id: string) => ({ source: "telegram", sourceId: id, text: "план", at: AT });

test("наложение: перекрытие, точка внутри, одно время — да; встык и без времени — нет", () => {
  const ev = (time: string | null, end_time: string | null = null) => ({ time, end_time });
  assert.ok(overlaps(ev("14:00", "15:00"), ev("14:30")));
  assert.ok(overlaps(ev("14:00", "15:00"), ev("14:30", "16:00")));
  assert.ok(overlaps(ev("14:00"), ev("14:00")));
  assert.ok(!overlaps(ev("14:00", "15:00"), ev("15:00")));
  assert.ok(!overlaps(ev("14:00", "15:00"), ev("15:00", "16:00")));
  assert.ok(!overlaps(ev("14:00", "15:00"), ev(null)));
  assert.ok(!overlaps(ev("14:00"), ev("15:00")));
});

test("сдвиг: после конца занятого, дальше по цепочке, длина сохраняется; за полночь — некуда", () => {
  const day = [{ id: 1, time: "14:00", end_time: "15:00" }, { id: 2, time: "15:00", end_time: "15:30" }];
  assert.deepEqual(shiftTime({ id: 9, time: "14:30", end_time: null }, day), { time: "15:30", end: null });
  assert.deepEqual(shiftTime({ id: 9, time: "14:15", end_time: "14:45" }, day), { time: "15:30", end: "16:00" });
  // План без конца считается часовым.
  assert.deepEqual(shiftTime({ id: 9, time: "20:00", end_time: null }, [{ id: 1, time: "20:00", end_time: null }]), { time: "21:00", end: null });
  assert.equal(shiftTime({ id: 9, time: "23:00", end_time: null }, [{ id: 1, time: "23:00", end_time: null }]), null);
  assert.equal(shiftTime({ id: 9, time: "16:00", end_time: null }, day), null); // ни на что не ложится
});

test("записали на занятое время — ответ спрашивает «Сдвинуть на 15:00?», оба плана записаны", async () => {
  const { store, u, pipe } = await setup([say("Новый созвон", "14:30")]);
  const old = await busy(store, u.id, "Встреча", "14:00", "15:00");
  const r = await pipe.handle({ user: u, ...msg("1") });
  assert.ok(r.clash, "есть вопрос о наложении");
  assert.equal(r.clash.withId, old);
  assert.equal(r.clash.shiftTo, "15:00");
  assert.match(r.text, /⚠ В 14:00–15:00 у тебя уже «Встреча»\. Сдвинуть «Новый созвон» на 15:00\?/);
  assert.equal((await store.eventsBetween(u.id, DAY, DAY)).length, 2);
});

test("встык, без времени, два плана одним сообщением — не спрашивает", async () => {
  const { store, u, pipe } = await setup([
    say("Встык", "15:00"),
    say("Без времени", null),
    { events: [{ title: "А", date_iso: DAY, time: "18:00" }, { title: "Б", date_iso: DAY, time: "18:00" }], summary: "s" },
  ]);
  await busy(store, u.id, "Встреча", "14:00", "15:00");
  assert.equal((await pipe.handle({ user: u, ...msg("1") })).clash, undefined);
  assert.equal((await pipe.handle({ user: u, ...msg("2") })).clash, undefined);
  assert.equal((await pipe.handle({ user: u, ...msg("3") })).clash, undefined);
});

test("«Сдвинуть» переносит новый план после занятого, строка вопроса заменяется итогом, отмена возвращает", async () => {
  const { store, u, pipe } = await setup([say("Новый созвон", "14:30")]);
  await busy(store, u.id, "Встреча", "14:00", "15:00");
  const r = await pipe.handle({ user: u, ...msg("1") });
  const d = await pipe.decideClash(u, r.messageId, r.clash!.eventId, r.clash!.withId, "shift");
  assert.match(d.text, /Сдвинула «Новый созвон» на 15:00/);
  assert.equal((await store.event(r.clash!.eventId))!.time, "15:00");
  assert.ok(d.reply && !d.reply.includes("⚠") && d.reply.includes("Сдвинула"));
  assert.equal((await store.message(r.messageId))!.reply, d.reply);
  // Повторное «Сдвинуть» ничего не двигает.
  assert.match((await pipe.decideClash(u, r.messageId, r.clash!.eventId, r.clash!.withId, "shift")).text, /ни на что не ложится/);
  // «Отменить» сообщение убирает новый план целиком.
  await pipe.undo(u, r.messageId);
  assert.equal((await store.event(r.clash!.eventId))!.status, "deleted");
});

test("«Оставить» — оба на месте, и про эту пару больше не спрашивает (а про другую — спрашивает)", async () => {
  const { store, u, pipe } = await setup([
    say("Новый созвон", "14:30"),
    { edits: [{ action: "move", kind: "event", id: 0, new_date: DAY, new_time: "14:40" }], summary: "s" },
  ]);
  await busy(store, u.id, "Встреча", "14:00", "15:00");
  const r = await pipe.handle({ user: u, ...msg("1") });
  const d = await pipe.decideClash(u, r.messageId, r.clash!.eventId, r.clash!.withId, "keep");
  assert.equal(d.text, "Хорошо, оставила оба.");
  assert.equal((await store.event(r.clash!.eventId))!.time, "14:30");
  assert.ok(await store.clashKept(u.id, Math.min(r.clash!.eventId, r.clash!.withId), Math.max(r.clash!.eventId, r.clash!.withId)));
  // Перенос того же плана внутрь той же встречи — уже не спрашивает.
  const p2 = new Pipeline(store, async () => JSON.stringify({ edits: [{ action: "move", kind: "event", id: r.clash!.eventId, new_date: DAY, new_time: "14:40" }], summary: "s" }));
  assert.equal((await p2.handle({ user: u, ...msg("2") })).clash, undefined);
  // Новая встреча на это время — другая пара, спрашивает.
  const other = await busy(store, u.id, "Обед", "16:00", "17:00");
  const p3 = new Pipeline(store, async () => JSON.stringify({ edits: [{ action: "move", kind: "event", id: r.clash!.eventId, new_date: DAY, new_time: "16:30" }], summary: "s" }));
  const r3 = await p3.handle({ user: u, ...msg("3") });
  assert.equal(r3.clash?.withId, other);
  assert.equal(r3.clash?.shiftTo, "17:00");
});

test("до конца дня занято — вопрос без «Сдвинуть», только предупреждение", async () => {
  const { store, u, pipe } = await setup([say("Поздно", "23:10", "23:40")]);
  await busy(store, u.id, "Ночная смена", "23:00", "23:59");
  const r = await pipe.handle({ user: u, ...msg("1") });
  assert.equal(r.clash?.shiftTo, null);
  assert.match(r.text, /⚠ В 23:00–23:59 у тебя уже «Ночная смена»\.$/);
});
