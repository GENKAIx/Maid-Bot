import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import * as webpush from "web-push";
import { createApi } from "../src/api.ts";
import { hashPassword } from "../src/auth.ts";
import { exportJson } from "../src/backup.ts";
import { Store } from "../src/db.ts";
import { Pipeline } from "../src/pipeline.ts";
import { Push } from "../src/push.ts";
import { habitButtons, Scheduler, type Button } from "../src/scheduler.ts";

// Этап 3: push-уведомления (подпись кнопок, подписка, действие без входа, «отложить»), настройки, резервная копия.

const keys = { ...webpush.generateVAPIDKeys(), subject: "mailto:test@example.com" };

async function setup() {
  const store = await Store.open(":memory:");
  const u = await store.createUser({ login: "owner", passwordHash: await hashPassword("secret-pass-1"), tz: "Europe/Moscow" });
  const pipe = new Pipeline(store, async () => "{}");
  const push = new Push(store, keys);
  const hid = await store.addHabit({ user_id: u.id, title: "Витамины", days: "1234567", times: '["09:00"]', start_date: "2026-01-01", end_date: null, message_id: null });
  return { store, u, pipe, push, hid };
}

test("push: подпись кнопок — верная проходит, чужая и просроченная нет", async () => {
  const { store, push, u } = await setup();
  const buttons = habitButtons(5, "2026-11-08");
  const token = push.sign(u.id, buttons);
  assert.deepEqual(push.verify(token), { userId: u.id, buttons: buttons.map((b) => b.data) });
  assert.equal(push.verify(token.slice(0, -2) + "zz"), null);
  assert.equal(push.verify(token, Date.now() + 48 * 3600_000), null); // через двое суток — устарело
  const other = new Push(store, { ...keys, privateKey: webpush.generateVAPIDKeys().privateKey });
  assert.equal(other.verify(token), null);
  assert.equal(push.action(token, 1)?.data, "habit:5:2026-11-08:skipped");
  assert.equal(push.action(token, 7), null);
  const p = push.payload(u, "<b>Заголовок</b>\nтело &lt;x&gt;", buttons);
  assert.equal(p.title, "Заголовок");
  assert.equal(p.body, "тело <x>");
  assert.deepEqual(p.actions.map((a) => a.title), ["✅ Сделал", "➖ Пропуск", "⏰ Через 30 мин"]);
  await store.close();
});

test("push: подписка, кнопка без входа отмечает привычку, «отложить» ставит напоминание с кнопками, настройки и копия", async () => {
  const { store, u, pipe, push, hid } = await setup();
  const server = createApi({ store, pipeline: pipe, push }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, body?: unknown, token?: string) => {
    const r = await fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any, headers: r.headers };
  };
  try {
    const { json: { token } } = await call("/api/login", { login: "owner", password: "secret-pass-1" });
    assert.equal((await call("/api/push/key", undefined, token)).json.key, keys.publicKey);
    const sub = { endpoint: "https://push.example/abc", keys: { p256dh: "p", auth: "a" }, label: "iphone" };
    assert.equal((await call("/api/push/subscribe", sub, token)).status, 200);
    assert.equal((await call("/api/push/subscribe", { endpoint: "not-a-url", keys: sub.keys }, token)).status, 400);
    assert.deepEqual((await call("/api/push/key", undefined, token)).json.subs.map((s: any) => [s.endpoint, s.label]), [[sub.endpoint, "iphone"]]);

    // Кнопка из уведомления: подписанный список, номер кнопки; входа нет.
    const day = "2026-11-08";
    const act = push.sign(u.id, [...habitButtons(hid, day), { text: "⏰", data: "snooze" }]);
    assert.equal((await call("/api/push/act", { act, action: 0 })).status, 200);
    assert.equal((await store.marksOf(u.id, day, day))[0]?.status, "done");
    assert.equal((await call("/api/push/act", { act: act + "x", action: 0 })).status, 403);
    assert.equal((await call("/api/push/act", { act, action: 5 })).status, 403);

    const before = Date.now();
    assert.match((await call("/api/push/act", { act, action: 2 })).json.text, /Напомню/);
    const later = new Date(before + 31 * 60_000);
    const sent: { text: string; buttons?: Button[] }[] = [];
    const sch = new Scheduler(store, null, async (_u, text, _e, buttons) => void sent.push({ text, buttons }));
    await sch.tick(new Date(before + 5 * 60_000));
    assert.equal(sent.length, 0);
    await sch.tick(later);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /Витамины/);
    assert.deepEqual(sent[0].buttons?.map((b) => b.data), habitButtons(hid, day).map((b) => b.data));

    assert.equal((await call("/api/push/unsubscribe", { endpoint: sub.endpoint }, token)).json.ok, true);
    assert.equal((await call("/api/push/key", undefined, token)).json.subs.length, 0);

    // Настройки времени и предупреждений.
    const me = (await call("/api/settings", { morning_time: "08:30", game_first_min: 90, game_alerts: 0 }, token)).json;
    assert.equal(me.morning_time, "08:30");
    assert.equal(me.game_first_min, 90);
    assert.equal(me.game_alerts, 0);
    assert.equal(me.password_hash, undefined);
    assert.equal((await call("/api/settings", { morning_time: "25:00" }, token)).status, 400);

    // Резервная копия: файл со всем, без хеша пароля.
    const r = await fetch(`${base}/api/backup`, { headers: { Authorization: `Bearer ${token}` } });
    assert.match(r.headers.get("content-disposition") ?? "", /maid-owner-\d{4}-\d{2}-\d{2}\.json/);
    const b = (await r.json()) as any;
    assert.equal(b.format, "maid-backup-1");
    assert.equal(b.habits.length, 1);
    assert.equal(b.habit_marks.length, 1);
    assert.equal(b.user.password_hash, undefined);
    assert.deepEqual(Object.keys(await exportJson(store, u.id)).sort(), Object.keys(b).sort());
  } finally {
    server.close();
    await store.close();
  }
});
