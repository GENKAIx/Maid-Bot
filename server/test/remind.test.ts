import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import * as webpush from "web-push";
import { createApi } from "../src/api.ts";
import { hashPassword } from "../src/auth.ts";
import { Store } from "../src/db.ts";
import { Pipeline } from "../src/pipeline.ts";
import { Push } from "../src/push.ts";
import { leadText, planEventReminders, remindPlan, remindText } from "../src/scheduler.ts";
import { addDays, dayKey } from "../src/time.ts";

// «Когда напоминать о событиях»: несколько напоминаний о плане — в начале дня, за N минут, в момент начала.

async function setup() {
  const store = await Store.open(":memory:");
  const u = await store.createUser({ login: "owner", passwordHash: await hashPassword("secret-pass-1"), tz: "UTC" });
  return { store, u };
}
const pending = async (store: Store, id: number) =>
  (await store.pendingReminders("event", id)).map((r) => [r.due_at.slice(11, 16), r.text]).sort();

test("remind: разбор и запись настройки", () => {
  assert.deepEqual(remindPlan({ event_reminders: "", event_lead_min: 30 }), [30, 0]); // старые пользователи — как было + в момент
  assert.deepEqual(remindPlan({ event_reminders: "day,60,5,0", event_lead_min: 60 }), ["day", 60, 5, 0]);
  assert.deepEqual(remindPlan({ event_reminders: "off", event_lead_min: 60 }), []);
  assert.equal(remindText("0,5,day,5,60,99999,x"), "day,60,5,0");
  assert.equal(remindText("off"), "off");
  assert.equal(leadText(5), "5 мин");
  assert.equal(leadText(60), "1 ч");
  assert.equal(leadText(150), "2 ч 30 мин");
  assert.equal(leadText(2880), "2 дн.");
});

test("remind: в начале дня, за час, за 5 минут и в момент события; прошедшие пропускаются", async () => {
  const { store, u } = await setup();
  const day = "2030-05-10";
  const me = { ...(await store.user(u.id))!, event_reminders: "day,60,5,0", morning_time: "07:00" };
  const id = await store.addEvent({ user_id: u.id, title: "Позвонить", date_iso: day, time: "12:00", end_time: null, details: "", domain: "", message_id: null });
  await planEventReminders(store, me, (await store.event(id))!, new Date(`${day}T11:30:00Z`));
  assert.deepEqual(await pending(store, id), [["11:55", "⏰ Через 5 мин: 12:00 — Позвонить"], ["12:00", "⏰ Пора: 12:00 — Позвонить"]]);
  const id2 = await store.addEvent({ user_id: u.id, title: "Обед", date_iso: day, time: "13:00", end_time: null, details: "", domain: "", message_id: null });
  await planEventReminders(store, me, (await store.event(id2))!, new Date(`${day}T00:00:00Z`));
  assert.deepEqual((await pending(store, id2)).map((x) => x[0]), ["07:00", "12:00", "12:55", "13:00"]);
  assert.match((await pending(store, id2))[0][1], /^📅 Сегодня: 13:00 — Обед/);
  // План раньше начала дня — «в начале дня» не ставится.
  const id3 = await store.addEvent({ user_id: u.id, title: "Рано", date_iso: day, time: "06:00", end_time: null, details: "", domain: "", message_id: null });
  await planEventReminders(store, me, (await store.event(id3))!, new Date(`${day}T00:00:00Z`));
  assert.deepEqual((await pending(store, id3)).map((x) => x[0]), ["05:00", "05:55", "06:00"]);
});

test("remind: смена настройки перекладывает напоминания будущих планов (и туда-обратно)", async () => {
  const { store, u } = await setup();
  const keys = { ...webpush.generateVAPIDKeys(), subject: "mailto:test@example.com" };
  const server = createApi({ store, pipeline: new Pipeline(store, async () => "{}"), push: new Push(store, keys) }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, body: unknown, token?: string) => {
    const r = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };
  try {
    const { json: { token } } = await call("/api/login", { login: "owner", password: "secret-pass-1" });
    const day = addDays(dayKey(new Date(), "UTC"), 3);
    const id = await store.addEvent({ user_id: u.id, title: "Врач", date_iso: day, time: "15:00", end_time: null, details: "", domain: "", message_id: null });
    await planEventReminders(store, (await store.user(u.id))!, (await store.event(id))!, new Date());
    assert.deepEqual((await pending(store, id)).map((x) => x[0]), ["14:00", "15:00"]); // по умолчанию: за час и в момент

    const me = (await call("/api/settings", { event_reminders: "5,day" }, token)).json;
    assert.equal(me.event_reminders, "day,5");
    assert.deepEqual((await pending(store, id)).map((x) => x[0]), [me.morning_time, "14:55"]);

    await call("/api/settings", { event_reminders: "off" }, token);
    assert.deepEqual(await pending(store, id), []);
    await call("/api/settings", { event_reminders: "60,0" }, token); // отменённые на те же моменты оживают
    assert.deepEqual((await pending(store, id)).map((x) => x[0]), ["14:00", "15:00"]);

    assert.equal((await call("/api/settings", { event_reminders: "завтра" }, token)).status, 400);
  } finally {
    server.close();
  }
});
