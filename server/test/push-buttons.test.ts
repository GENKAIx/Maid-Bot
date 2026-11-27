import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import * as webpush from "web-push";
import { createApi } from "../src/api.ts";
import { Store } from "../src/db.ts";
import type { NoticeKind } from "../src/notices.ts";
import { Pipeline } from "../src/pipeline.ts";
import { traitButtons } from "../src/profile.ts";
import { Push } from "../src/push.ts";
import { Scheduler, habitButtons, snoozeOptions, type Button } from "../src/scheduler.ts";
import { makeSend } from "../src/send.ts";
import { dayKey, zonedToUtc } from "../src/time.ts";

// Кнопки push (28.11.2026): у вопроса про привычку отложить — одна кнопка, и она на деле откладывает (шаг s30, habitSnooze);
// отложенное письмо с другими кнопками (закономерность — trait:…) приходит с исходным текстом и исходными подписями кнопок.

const keys = { ...webpush.generateVAPIDKeys(), subject: "mailto:test@example.com" };
const TZ = "Europe/Moscow";
const DAY = "2026-11-28";
const at = (t: string) => zonedToUtc(DAY, t, TZ);

async function setup() {
  const store = await Store.open(":memory:");
  const u = await store.createUser({ login: "owner", passwordHash: "x", tz: TZ });
  const pipe = new Pipeline(store, async () => "{}");
  const push = new Push(store, keys);
  const hid = await store.addHabit({ user_id: u.id, title: "Витамины", days: "1234567", times: '["09:00"]', start_date: "2026-01-01", end_date: null, message_id: null });
  const server = createApi({ store, pipeline: pipe, push }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const act = async (token: string, action: number) => {
    const r = await fetch(`${base}/api/push/act`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ act: token, action }) });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as { text?: string; error?: string } };
  };
  return { store, u, push, hid, act, close: async () => { server.close(); await store.close(); } };
}

test("push: у вопроса про привычку одна кнопка отложить — «Через 30 мин» (s30) на месте «Позже», общей snooze нет", async () => {
  const s = await setup();
  try {
    const p = s.push.payload(s.u, "Витамины — сегодня сделали?", habitButtons(7, DAY), at("12:00"));
    assert.deepEqual(p.actions.map((a) => a.title), ["✅ Да", "⏰ Через 30 мин", "✖ Нет"]);
    assert.deepEqual(s.push.verify(p.act)?.buttons, [`habit:7:${DAY}:done`, `habit:7:${DAY}:s30`, `habit:7:${DAY}:skipped`], "ни later, ни snooze");
    // Под полночь полчаса не помещаются — 15 минут; не помещаются и они — кнопки отложить нет.
    assert.deepEqual(s.push.payload(s.u, "?", habitButtons(7, DAY), at("23:40")).actions.map((a) => a.title), ["✅ Да", "⏰ Через 15 мин", "✖ Нет"]);
    assert.deepEqual(s.push.payload(s.u, "?", habitButtons(7, DAY), at("23:50")).actions.map((a) => a.title), ["✅ Да", "✖ Нет"]);
    // Вопрос без «Позже» (до 00:00 не успеть) и вопрос не за сегодня — тоже без неё и без общей snooze.
    assert.deepEqual(s.push.buttons(s.u, habitButtons(7, DAY, false), at("12:00")).map((b) => b.data), [`habit:7:${DAY}:done`, `habit:7:${DAY}:skipped`]);
    assert.deepEqual(s.push.buttons(s.u, habitButtons(7, "2026-11-27"), at("12:00")).map((b) => b.text), ["✅ Да", "✖ Нет"]);
    // Остальные письма с кнопками — общая «Через 30 мин» последней; кнопка-ссылка (оплата) в push не идёт.
    assert.deepEqual(s.push.buttons(s.u, traitButtons(12), at("12:00")).map((b) => b.text), ["✅ Добавить", "✖ Не надо", "⏰ Через 30 мин"]);
    assert.deepEqual(s.push.buttons(s.u, [{ text: "Оформить", data: "", url: "https://t.me/$x" }], at("12:00")), []);
  } finally {
    await s.close();
  }
});

test("push: «Через 30 мин» у привычки на деле откладывает вопрос; «Позже» из старого уведомления — тоже на 30 минут", async () => {
  const s = await setup();
  try {
    const now = new Date();
    const today = dayKey(now, s.u.tz);
    const fits = snoozeOptions(s.u, today, now).steps.includes(30);
    for (const buttons of [s.push.buttons(s.u, habitButtons(s.hid, today), now), habitButtons(s.hid, today)]) {
      const i = buttons.findIndex((b) => /:(s\d+|later)$/.test(b.data));
      if (i < 0) continue; // под самую полночь кнопки отложить нет
      const r = await s.act(s.push.sign(s.u.id, buttons), i);
      assert.equal(r.status, 200);
      if (fits) {
        assert.match(r.json.text ?? "", /^⏰ Витамины — напомню в \d\d:\d\d\. Не отметите до 00:00 — поставлю минус\.$/);
        const pending = await s.store.pendingReminders("habit", s.hid);
        assert.equal(pending.length, 1, "вопрос отложен, прежнее «отложить» заменено");
        const min = Math.round((new Date(pending[0].due_at).getTime() - now.getTime()) / 60_000);
        assert.ok(min >= 28 && min <= 31, `через 30 минут, а не ${min}`);
      } else assert.doesNotMatch(r.json.text ?? "", /спрошу ещё раз/, "прежнего пустого обещания нет");
    }
  } finally {
    await s.close();
  }
});

test("push: отложенное письмо о закономерности приходит с исходным текстом и подписями кнопок, вид — заметка", async () => {
  const s = await setup();
  try {
    const text = "🔍 Заметила закономерность: <b>Поздний отбой</b>\n3 раза: пн, ср, пт.\nДобавить в дебафы профиля?";
    const { send } = makeSend({ store: s.store, push: { send: async () => 0 } });
    await send(s.u, text, "surprised", traitButtons(12), "note");
    await send(s.u, "☀️ Доброе утро", "happy", undefined, "morning");
    const shown = s.push.buttons(s.u, traitButtons(12));
    const before = Date.now();
    const r = await s.act(s.push.sign(s.u.id, shown), shown.findIndex((b) => b.data === "snooze"));
    assert.equal(r.json.text, "Напомню через 30 мин.");

    const sent: { text: string; buttons?: Button[]; kind?: NoticeKind }[] = [];
    const sch = new Scheduler(s.store, null, async (_u, t, _e, buttons, kind) => void sent.push({ text: t, buttons, kind }));
    await sch.tick(new Date(before + 5 * 60_000));
    assert.equal(sent.filter((x) => x.buttons?.some((b) => b.data.startsWith("trait:"))).length, 0, "раньше срока не приходит");
    await sch.tick(new Date(before + 31 * 60_000));
    const again = sent.filter((x) => x.buttons?.some((b) => b.data.startsWith("trait:")));
    assert.equal(again.length, 1);
    assert.equal(again[0].text, text, "текст письма — исходный, а не «Напоминаю»");
    assert.deepEqual(again[0].buttons, traitButtons(12), "подписи — «✅ Добавить» и «✖ Не надо», а не trait:12:yes");
    assert.equal(again[0].kind, "note");

    // Письма с такими кнопками в ленте нет — честный отказ, пустое «Напоминаю» не ставится.
    const lost = await s.act(s.push.sign(s.u.id, [...traitButtons(99), { text: "⏰", data: "snooze" }]), 2);
    assert.equal(lost.status, 404);
    assert.match(lost.json.error ?? "", /отложить не получилось/);
    const left = await (s.store as any).all("SELECT text FROM reminders WHERE ref_kind = 'snooze' AND status = 'pending'");
    assert.deepEqual(left, []);
  } finally {
    await s.close();
  }
});
