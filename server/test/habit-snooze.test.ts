import { PGlite } from "@electric-sql/pglite";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApi } from "../src/api.ts";
import { hashPassword } from "../src/auth.ts";
import { createBot } from "../src/bot.ts";
import { config } from "../src/config.ts";
import { Store } from "../src/db.ts";
import { PgDriver } from "../src/driver.ts";
import { Pipeline } from "../src/pipeline.ts";
import {
  HABIT_DATA, SNOOZE_STEPS, Scheduler, habitButtons, habitLaterRows, habitPickRows, snoozeOptions, type Button,
} from "../src/scheduler.ts";
import { flushFeatures, resetFeatureEvents } from "../src/feature-events.ts";
import { addDays, dayKey, zonedToUtc } from "../src/time.ts";

// «⏰ Позже» у вопроса про привычку (27.11.2026): второй шаг «15 мин | 30 мин | 1 ч | 2 ч | Выбрать | ←», отложенный вопрос —
// напоминание ref_kind "habit" в базе; в своё время приходит тот же вопрос с теми же кнопками, ровно один раз; последнее «Позже»
// выигрывает; отметка снимает отложенное; вопрос в habit_last (23:00) не приходит, только если отложили на 23:00 или позже.

const TZ = "Europe/Moscow";
const DAY = "2026-11-12";
const at = (time: string, day = DAY) => zonedToUtc(day, time, TZ);

const BACKENDS: Record<string, () => Promise<Store>> = {
  sqlite: () => Store.open(":memory:"),
  postgres: async () => {
    const pg = new PGlite();
    return Store.over(new PgDriver(pg, (fn) => pg.transaction((tx) => fn(tx)), () => pg.close()));
  },
};

async function setup(open: () => Promise<Store>) {
  const store = await open();
  const u = await store.ensureUser("100", "Тест", TZ);
  const hid = await store.addHabit({ user_id: u.id, title: "Зарядка", days: "1234567", times: '["09:00"]', start_date: "2026-11-01", end_date: null, message_id: null });
  const sent: { text: string; buttons?: Button[]; kind?: string }[] = [];
  const scheduler = () => new Scheduler(store, null, async (_u, text, _e, buttons, kind) => void (buttons?.some((b) => b.data.startsWith("habit:")) && sent.push({ text, buttons, kind })));
  return { store, u, hid, sent, sch: scheduler(), scheduler, pipe: new Pipeline(store, async () => "{}") };
}

test("варианты «Позже»: что не успевает до 00:00 — скрыто; кнопки и колбэки", () => {
  const u = { tz: TZ };
  assert.deepEqual(snoozeOptions(u, DAY, at("15:10")), {
    steps: [15, 30, 60, 120], hours: ["16:00", "17:00", "18:00", "19:00", "20:00", "21:00", "22:00", "23:00"], now: "15:10",
  });
  assert.deepEqual(snoozeOptions(u, DAY, at("22:30")), { steps: [15, 30, 60], hours: ["23:00"], now: "22:30" });
  assert.deepEqual(snoozeOptions(u, DAY, at("23:00")), { steps: [15, 30], hours: [], now: "23:00" });
  assert.deepEqual(snoozeOptions(u, DAY, at("23:44")).steps, [15]);
  assert.deepEqual(snoozeOptions(u, DAY, at("23:45")).steps, [], "даже 15 минут уже за полночь");
  assert.deepEqual(snoozeOptions(u, "2026-11-11", at("10:00")).steps, [], "вчерашний день — ничего");

  // Первый ряд: без «Позже», когда не успеть.
  assert.deepEqual(habitButtons(7, DAY).map((b) => b.text), ["✅ Да", "⏰ Позже", "✖ Нет"]);
  assert.deepEqual(habitButtons(7, DAY, false).map((b) => b.data), [`habit:7:${DAY}:done`, `habit:7:${DAY}:skipped`]);

  // Второй шаг и сетка часов.
  const opt = snoozeOptions(u, DAY, at("15:10"));
  const later = habitLaterRows(7, DAY, opt);
  assert.deepEqual(later.map((r) => r.map((b) => b.text)), [["15 мин", "30 мин", "1 ч", "2 ч"], ["Выбрать", "←"]]);
  assert.deepEqual(later.flat().map((b) => b.data.split(":")[3]), ["s15", "s30", "s60", "s120", "pick", "back"]);
  assert.deepEqual(habitLaterRows(7, DAY, snoozeOptions(u, DAY, at("23:20"))).map((r) => r.map((b) => b.text)), [["15 мин", "30 мин"], ["←"]], "часов не осталось — без «Выбрать»");
  const pick = habitPickRows(7, DAY, opt.hours);
  assert.deepEqual(pick.map((r) => r.map((b) => b.text)), [["16:00", "17:00", "18:00", "19:00"], ["20:00", "21:00", "22:00", "23:00"], ["←"]]);
  assert.equal(pick[0][0].data, `habit:7:${DAY}:t1600`);
  assert.equal(pick.at(-1)![0].data, `habit:7:${DAY}:step`, "← из часов — ко второму шагу (не later: не новое нажатие «Позже»)");

  // Telegram: callback_data не длиннее 64 байт и при огромном номере привычки; все виды проходят разбор бота.
  const big = 2 ** 31 - 1;
  const all = [...habitButtons(big, DAY), ...habitLaterRows(big, DAY, opt).flat(), ...habitPickRows(big, DAY, opt.hours).flat()];
  for (const b of all) {
    assert.ok(Buffer.byteLength(b.data) <= 64, b.data);
    assert.match(b.data, HABIT_DATA);
  }
  assert.deepEqual(SNOOZE_STEPS, [15, 30, 60, 120]);
});

for (const [kind, open] of Object.entries(BACKENDS)) {
  test(`${kind}: отложить — в срок тот же вопрос с теми же кнопками ровно один раз; последнее «Позже» выигрывает; перезапуск не мешает`, async () => {
    const { store, u, hid, sent, sch, scheduler, pipe } = await setup(open);
    try {
      await sch.tick(at("09:05"));
      assert.equal(sent.length, 1);
      const ask = sent[0];
      const r1 = await pipe.habitSnooze(u, hid, DAY, { in: 30 }, new Date(at("09:06").getTime() + 40_000));
      assert.deepEqual([r1.ok, r1.at, r1.text], [true, "09:36", "⏰ Зарядка — напомню в 09:36. Не отметите до 00:00 — поставлю минус."]);
      // Передумали: к 10:00 — прежнее снято, ждёт одно.
      const r2 = await pipe.habitSnooze(u, hid, DAY, { at: "10:00" }, at("09:07"));
      assert.equal(r2.at, "10:00");
      const pending = await store.pendingReminders("habit", hid);
      assert.deepEqual(pending.map((r) => new Date(r.due_at).toISOString()), [at("10:00").toISOString()]);
      await sch.tick(at("09:36"));
      assert.equal(sent.length, 1, "снятое не приходит");
      // Перезапуск сервера: новый планировщик на той же базе.
      const sch2 = scheduler();
      await sch2.tick(at("09:59"));
      assert.equal(sent.length, 1);
      await sch2.tick(at("10:00"));
      await sch2.tick(new Date(at("10:00").getTime() + 30_000));
      await scheduler().tick(at("10:01"));
      assert.equal(sent.length, 2, "ровно один раз");
      assert.deepEqual([sent[1].text, sent[1].buttons, sent[1].kind], [ask.text, ask.buttons, "habit"]);
      // Ещё раз «Позже» — можно сколько угодно.
      assert.equal((await pipe.habitSnooze(u, hid, DAY, { in: 120 }, at("10:02"))).at, "12:02");
      await sch2.tick(at("12:02"));
      assert.equal(sent.length, 3);
    } finally {
      await store.close();
    }
  });

  test(`${kind}: отметка снимает отложенное; вопрос в 23:00 — если отложили раньше, и нет — если на 23:00 и позже`, async () => {
    const { store, u, hid, sent, sch, pipe } = await setup(open);
    try {
      // Отметка снимает: отложенного нет, в срок ничего.
      await pipe.habitSnooze(u, hid, DAY, { at: "15:00" }, at("09:10"));
      await pipe.markHabit(u, hid, DAY, "done", "web");
      assert.equal((await store.pendingReminders("habit", hid)).length, 0);
      await sch.tick(at("15:00"));
      assert.equal(sent.length, 0);

      // Отложили на 22:00 (раньше 23:00): приходят оба — в 22:00 и в 23:00.
      const d2 = "2026-11-13";
      await pipe.habitSnooze(u, hid, d2, { at: "22:00" }, at("09:10", d2));
      await sch.tick(at("22:00", d2));
      await sch.tick(at("23:00", d2));
      await sch.tick(at("23:30", d2));
      assert.equal(sent.length, 2);
      assert.deepEqual(sent.map((x) => x.buttons?.map((b) => b.text)), [["✅ Да", "⏰ Позже", "✖ Нет"], ["✅ Да", "⏰ Позже", "✖ Нет"]]);

      // Отложили на 23:30: в 23:00 вопроса нет, в 23:30 — отложенный, и больше ничего (окно 23:00 ещё открыто).
      sent.length = 0;
      const d3 = "2026-11-14";
      await pipe.habitSnooze(u, hid, d3, { at: "23:30" }, at("09:10", d3));
      await sch.tick(at("23:00", d3));
      assert.equal(sent.length, 0);
      await sch.tick(at("23:30", d3));
      await sch.tick(at("23:31", d3));
      await sch.tick(at("23:59", d3));
      assert.equal(sent.length, 1);
      assert.deepEqual(sent[0].buttons?.map((b) => b.text), ["✅ Да", "⏰ Позже", "✖ Нет"], "в 23:30 ещё успеть 15 минут");

      // Ровно на 23:00 — один вопрос, не два.
      sent.length = 0;
      const d4 = "2026-11-15";
      await pipe.habitSnooze(u, hid, d4, { at: "23:00" }, at("09:10", d4));
      await sch.tick(at("23:00", d4));
      await sch.tick(at("23:20", d4));
      assert.equal(sent.length, 1);

      // Отложенный на 23:50 — без «Позже» (15 минут уже за полночь).
      sent.length = 0;
      const d5 = "2026-11-16";
      await pipe.habitSnooze(u, hid, d5, { at: "23:50" }, at("23:10", d5));
      await sch.tick(at("23:50", d5));
      assert.deepEqual(sent.map((x) => x.buttons?.map((b) => b.text)), [["✅ Да", "✖ Нет"]]);
    } finally {
      await store.close();
    }
  });

  test(`${kind}: день кончился — отложенный не приходит; отказы: прошлое время, за полночь, чужая, завершённая, отмеченная`, async () => {
    const { store, u, hid, sent, sch, pipe } = await setup(open);
    try {
      // Отложили на 23:55, а сервер проспал до 00:10: день уже другой — не шлём, минус как всегда.
      await pipe.habitSnooze(u, hid, DAY, { at: "23:55" }, at("23:40"));
      await sch.tick(at("00:10", "2026-11-13"));
      assert.equal(sent.length, 0);
      assert.equal((await store.pendingReminders("habit", hid)).length, 0);
      assert.deepEqual((await store.marksOf(u.id, DAY, DAY)).map((m) => m.status), ["skipped"]);

      const day = "2026-11-13";
      const no = async (when: { in: number } | { at: string }, now: Date, d = day, id = hid) => {
        const r = await pipe.habitSnooze(u, id, d, when, now);
        assert.equal(r.ok, false, JSON.stringify(when));
        return r.text;
      };
      assert.match(await no({ at: "10:00" }, at("10:00", day)), /уже прошло/);
      assert.match(await no({ at: "09:00" }, at("10:00", day)), /уже прошло/);
      assert.match(await no({ in: 120 }, at("23:00", day)), /До 00:00 уже не успеть/);
      assert.match(await no({ in: 30 }, at("10:00", day), DAY), /день уже закончился/);
      assert.match(await no({ in: 30 }, at("10:00", day), "2026-11-14"), /только на сегодня/);
      const other = await store.ensureUser("200", "Другой", TZ);
      const theirs = await store.addHabit({ user_id: other.id, title: "Чужая", days: "1234567", times: "[]", start_date: "2026-11-01", end_date: null, message_id: null });
      assert.equal(await no({ in: 30 }, at("10:00", day), day, theirs), "Нет такой привычки.");
      const ended = await store.addHabit({ user_id: u.id, title: "Курс", days: "1234567", times: "[]", start_date: "2026-11-01", end_date: "2026-11-12", message_id: null });
      assert.equal(await no({ in: 30 }, at("10:00", day), day, ended), "Эта привычка уже завершена.");
      const gone = await store.addHabit({ user_id: u.id, title: "Удалённая", days: "1234567", times: "[]", start_date: "2026-11-01", end_date: null, message_id: null });
      await store.updateHabit(gone, { status: "stopped" });
      assert.equal(await no({ in: 30 }, at("10:00", day), day, gone), "Этой привычки больше нет.");
      await pipe.markHabit(u, hid, day, "skipped", "web");
      assert.equal(await no({ in: 30 }, at("10:00", day)), "Зарядка — уже отмечено.");
      assert.equal((await store.pendingReminders("habit", hid)).length, 0, "ни один отказ ничего не поставил");
      // Прежнее «Ещё нет» (виджеты 0.1.96/97, push) отвечает, как раньше.
      assert.match(await pipe.habitLater(u, hid, "2026-11-14", at("10:00", "2026-11-14")), /спрошу ещё раз в 23:00/);
    } finally {
      await store.close();
    }
  });
  test(`${kind}: своё время привычки не пропадает — «Позже» заменяет только вопрос в habit_last (и ровно ту же минуту)`, async () => {
    const { store, u, hid, sent, sch, pipe } = await setup(open);
    try {
      await store.updateHabit(hid, { times: '["09:00","20:00"]' });
      const asks = async (day: string, times: string[]) => {
        const got: string[] = [];
        for (const t of times) {
          const n = sent.length;
          await sch.tick(at(t, day));
          if (sent.length > n) got.push(`${t}×${sent.length - n}`);
        }
        return got;
      };
      // 09:00 и 20:00, в 09:06 отложили на 21:00: в 20:00 вопрос свой, в 21:00 отложенный, в 23:00 — второй (21:00 раньше 23:00).
      await sch.tick(at("09:05"));
      await pipe.habitSnooze(u, hid, DAY, { at: "21:00" }, at("09:06"));
      assert.deepEqual(await asks(DAY, ["20:00", "20:30", "21:00", "21:30", "23:00", "23:30"]), ["20:00×1", "21:00×1", "23:00×1"]);

      // Передумали на 19:30: приходят 19:30, 20:00 и 23:00, а в 21:00 — ничего.
      const d2 = "2026-11-13";
      sent.length = 0;
      await sch.tick(at("09:05", d2));
      await pipe.habitSnooze(u, hid, d2, { at: "21:00" }, at("09:06", d2));
      await pipe.habitSnooze(u, hid, d2, { at: "19:30" }, at("09:07", d2));
      assert.deepEqual(await asks(d2, ["19:30", "20:00", "21:00", "23:00"]), ["19:30×1", "20:00×1", "23:00×1"]);

      // Отложили ровно на 20:00 — один вопрос, не два; на 23:30 — вопроса в 23:00 нет.
      const d3 = "2026-11-14";
      await sch.tick(at("09:05", d3));
      await pipe.habitSnooze(u, hid, d3, { at: "20:00" }, at("09:06", d3));
      assert.deepEqual(await asks(d3, ["20:00", "20:30"]), ["20:00×1"]);
      await pipe.habitSnooze(u, hid, d3, { at: "23:30" }, at("20:31", d3));
      assert.deepEqual(await asks(d3, ["23:00", "23:30", "23:45"]), ["23:30×1"]);
    } finally {
      await store.close();
    }
  });

  test(`${kind}: не по расписанию и тихая — не откладывается и не приходит; кнопки — по часам отправки; два «Позже» разом — один вопрос`, async () => {
    const { store, u, hid, sent, sch, pipe } = await setup(open);
    try {
      // Только по понедельникам, а DAY — четверг: отказ, ничего не стоит.
      const monday = await store.addHabit({ user_id: u.id, title: "Бассейн", days: "1", times: "[]", start_date: "2026-11-01", end_date: null, message_id: null });
      const r = await pipe.habitSnooze(u, monday, DAY, { in: 30 }, at("10:00"));
      assert.deepEqual([r.ok, r.text], [false, "Бассейн — сегодня не спрашиваю."]);
      assert.equal((await store.pendingReminders("habit", monday)).length, 0);
      // Отложили, а потом сделали тихой — в срок не приходит, напоминание снято.
      await pipe.habitSnooze(u, hid, DAY, { at: "15:00" }, at("10:00"));
      await store.updateHabit(hid, { quiet: 1 });
      await sch.tick(at("15:00"));
      assert.equal(sent.length, 0);
      assert.equal((await store.pendingReminders("habit", hid)).length, 0);
      assert.equal((await pipe.habitSnooze(u, hid, DAY, { in: 30 }, at("15:01"))).text, "Зарядка — сегодня не спрашиваю.");
      await store.updateHabit(hid, { quiet: 0 });
      // Убрали сегодняшний день недели из расписания — тоже не приходит.
      await pipe.habitSnooze(u, hid, DAY, { at: "16:00" }, at("15:02"));
      await store.updateHabit(hid, { days: "1" });
      await sch.tick(at("16:00"));
      assert.equal(sent.length, 0);
      await store.updateHabit(hid, { days: "1234567" });

      // Отложили на 23:30, а сервер опоздал до 23:50: «⏰ Позже» уже не успеть — кнопок без него.
      const d2 = "2026-11-13";
      await pipe.habitSnooze(u, hid, d2, { at: "23:30" }, at("23:10", d2));
      await sch.tick(at("23:50", d2));
      assert.deepEqual(sent.map((x) => x.buttons?.map((b) => b.text)), [["✅ Да", "✖ Нет"]]);

      // Обычный вопрос в habit_last 23:50 — тоже без «Позже».
      sent.length = 0;
      const d3 = "2026-11-14";
      await store.updateUser(u.id, { habit_last: "23:50" });
      const u2 = (await store.user(u.id))!;
      await sch.tick(at("23:50", d3));
      assert.deepEqual(sent.map((x) => x.buttons?.map((b) => b.text)), [["✅ Да", "✖ Нет"]]);
      await store.updateUser(u.id, { habit_last: "23:00" });

      // Два «Позже» разом (виджет и Telegram): приходит один вопрос.
      sent.length = 0;
      const d4 = "2026-11-15";
      await Promise.all([pipe.habitSnooze(u2, hid, d4, { in: 15 }, at("10:00", d4)), pipe.habitSnooze(u2, hid, d4, { in: 30 }, at("10:00", d4))]);
      await sch.tick(at("10:15", d4));
      await sch.tick(at("10:30", d4));
      await sch.tick(at("10:45", d4));
      assert.equal(sent.length, 1);
      assert.equal((await store.pendingReminders("habit", hid)).length, 0);
    } finally {
      await store.close();
    }
  });
}

test("летнее время в полночь (America/Havana, 08.03.2026): «Позже» на 23:30 заменяет вопрос в 23:00", async () => {
  const tz = "America/Havana", day = "2026-03-07";
  const store = await Store.open(":memory:");
  try {
    const u = await store.ensureUser("300", "Гавана", tz);
    await store.updateUser(u.id, { tz });
    const me = (await store.user(u.id))!;
    const hid = await store.addHabit({ user_id: u.id, title: "Зарядка", days: "1234567", times: '["09:00"]', start_date: "2026-03-01", end_date: null, message_id: null });
    const sent: string[] = [];
    const sch = new Scheduler(store, null, async (_u, text, _e, buttons) => void (buttons?.some((b) => b.data.startsWith("habit:")) && sent.push(text)));
    const t = (x: string) => zonedToUtc(day, x, tz);
    await sch.tick(t("09:05"));
    assert.equal((await new Pipeline(store, async () => "{}").habitSnooze(me, hid, day, { at: "23:30" }, t("10:00"))).ok, true);
    await sch.tick(t("23:00"));
    await sch.tick(t("23:30"));
    assert.equal(sent.length, 2, "09:00 и отложенный 23:30, без 23:00");
  } finally {
    await store.close();
  }
});

/** Пояс, в котором сейчас около полудня: у бота и API часы настоящие, а вариантам «Позже» нужен запас до полуночи. */
function noonZone(): string {
  const off = 12 - new Date().getUTCHours();
  return off === 0 ? "Etc/GMT" : off > 0 ? `Etc/GMT-${off}` : `Etc/GMT+${-off}`;
}

test("Telegram: «Позже» → второй шаг → «Выбрать» → «←»; 30 мин и 16:00 ставят вопрос; старое later, вчерашний день, счёт нажатий", async () => {
  config.telegramToken = "123456:test-token";
  config.allowedChatIds.splice(0, Infinity, "77");
  const store = await Store.open(":memory:");
  const tz = noonZone();
  const u = await store.ensureUser("77", "А", tz);
  await store.updateUser(u.id, { tz });
  const today = dayKey(new Date(), tz);
  const hid = await store.addHabit({ user_id: u.id, title: "Зарядка", days: "1234567", times: "[]", start_date: "2026-11-01", end_date: null, message_id: null });
  const pipe = new Pipeline(store, async () => "{}");
  const { bot } = createBot(store, pipe, () => null);
  pipe.onChange = null; // список-виджет Telegram обновляется в фоне через секунду — к тому времени база уже закрыта
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    const result: unknown = method === "getMe" ? { id: 1, is_bot: true, first_name: "Maid", username: "maid_test_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false } : true;
    return { ok: true, result } as never;
  });
  await bot.init();
  let n = 0;
  const press = async (data: string) => {
    calls.length = 0;
    await bot.handleUpdate({
      update_id: ++n,
      callback_query: {
        id: String(n), chat_instance: "c", data, from: { id: 77, is_bot: false, first_name: "А" },
        message: { message_id: 5, date: Math.floor(Date.now() / 1000), chat: { id: 77, type: "private", first_name: "А" }, caption: "🔁 Зарядка — сегодня сделали?" },
      },
    } as never);
    const answer = calls.find((c) => c.method === "answerCallbackQuery")?.payload;
    const edit = calls.find((c) => c.method === "editMessageReplyMarkup")?.payload;
    const kb = (edit?.reply_markup as { inline_keyboard?: { text: string; callback_data: string }[][] } | undefined)?.inline_keyboard;
    return { popup: answer?.text as string | undefined, edited: Boolean(edit), rows: kb?.map((r) => r.map((b) => b.text)), data: kb?.flat().map((b) => b.callback_data) };
  };
  const key = (x: string) => `habit:${hid}:${today}:${x}`;
  try {
    const later = await press(key("later"));
    assert.equal(later.popup, undefined, "шаг — без всплывашки");
    assert.deepEqual(later.rows, [["15 мин", "30 мин", "1 ч", "2 ч"], ["Выбрать", "←"]]);
    const pick = await press(key("pick"));
    assert.deepEqual(pick.rows?.flat().slice(0, 4), ["13:00", "14:00", "15:00", "16:00"]);
    assert.deepEqual(pick.rows?.at(-1), ["←"]);
    assert.ok(pick.rows!.slice(0, -1).every((r) => r.length <= 4));
    assert.ok(pick.data!.every((d) => Buffer.byteLength(d) <= 64));
    assert.deepEqual((await press(key("back"))).rows, [["✅ Да", "⏰ Позже", "✖ Нет"]]);

    const s30 = await press(key("s30"));
    assert.match(s30.popup!, /^⏰ Зарядка — напомню в \d\d:\d\d\. Не отметите до 00:00 — поставлю минус\.$/);
    assert.deepEqual([s30.edited, s30.rows], [true, undefined], "клавиатура снята");
    assert.equal((await store.pendingReminders("habit", hid)).length, 1);
    const t16 = await press(key("t1600"));
    assert.match(t16.popup!, /напомню в 16:00/);
    const pending = await store.pendingReminders("habit", hid);
    assert.deepEqual(pending.map((r) => new Date(r.due_at).toISOString()), [zonedToUtc(today, "16:00", tz).toISOString()], "последнее выигрывает");
    assert.deepEqual(JSON.parse(pending[0].buttons).map((b: Button) => b.data), habitButtons(hid, today).map((b) => b.data));

    // Время, что уже прошло, — отказ и снова второй шаг.
    const past = await press(key("t0500"));
    assert.match(past.popup!, /уже прошло/);
    assert.deepEqual(past.rows?.[0], ["15 мин", "30 мин", "1 ч", "2 ч"]);

    // Отмечено — «Позже» отвечает коротко и снимает клавиатуру; отложенное снято.
    assert.match((await press(key("done"))).popup!, /Отмечено/);
    assert.equal((await store.pendingReminders("habit", hid)).length, 0);
    const marked = await press(key("later"));
    assert.deepEqual([marked.popup, marked.rows], ["Зарядка — уже отмечено.", undefined]);

    // Старое сообщение за вчера с «⏳ Ещё нет» (later): до полуночи не успеть — прежний ответ, клавиатура снята.
    const old = await press(`habit:${hid}:2026-11-20:later`);
    assert.match(old.popup!, /хорошо, подожду/);
    assert.deepEqual([old.edited, old.rows], [true, undefined]);
    // А шаги второго ряда на вчерашнем сообщении (нажали после полуночи) — честный отказ, не «подожду».
    for (const x of ["s15", "t2300", "pick", "step", "back"]) {
      const gone = await press(`habit:${hid}:2026-11-20:${x}`);
      assert.equal(gone.popup, "Этот день уже закончился — отложить нельзя.", x);
      assert.deepEqual([gone.edited, gone.rows], [true, undefined], x);
    }

    // «←» из сетки часов (step) — обратно ко второму шагу; неверное время t2400 — тоже второй шаг.
    const tea = await store.addHabit({ user_id: u.id, title: "Чай & прогулка", days: "1234567", times: "[]", start_date: "2026-11-01", end_date: null, message_id: null });
    const tk = (x: string) => `habit:${tea}:${today}:${x}`;
    resetFeatureEvents();
    assert.deepEqual((await press(tk("later"))).rows?.at(-1), ["Выбрать", "←"]);
    await press(tk("pick"));
    assert.deepEqual((await press(tk("step"))).rows?.[0], ["15 мин", "30 мин", "1 ч", "2 ч"]);
    assert.deepEqual((await press(tk("t2400"))).rows?.[0], ["15 мин", "30 мин", "1 ч", "2 ч"]);
    // Всплывашка — обычный текст: «&», а не «&amp;».
    assert.match((await press(tk("s30"))).popup!, /^⏰ Чай & прогулка — напомню в /);
    // В счёт — одно нажатие «Позже», шаги (pick, step, t…, s…) — нет.
    await flushFeatures(store, Date.now(), true);
    const counted = await (store as any).all("SELECT count FROM feature_events WHERE feature = 'habit.mark' AND client = 'telegram'");
    assert.deepEqual(counted.map((r: { count: number }) => Number(r.count)), [1]);
  } finally {
    resetFeatureEvents();
    await store.close();
  }
});

test("API: GET /snooze — варианты в поясе человека, POST /snooze — in или at; 409 у отмеченной и завершённой; старое later в /mark", async () => {
  const store = await Store.open(":memory:");
  const tz = noonZone();
  const u = await store.ensureUser("100", "Тест", tz);
  await store.updateUser(u.id, { login: "owner", password_hash: await hashPassword("secret-pass-1") });
  const today = dayKey(new Date(), tz);
  const add = (title: string, end: string | null = null) =>
    store.addHabit({ user_id: u.id, title, days: "1234567", times: "[]", start_date: "2026-11-01", end_date: end, message_id: null });
  const hid = await add("Зарядка");
  const ended = await add("Курс", "2026-11-02");
  const pipeline = new Pipeline(store, async () => "{}");
  const server = createApi({ store, pipeline }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let token = "";
  const call = async <T = Record<string, unknown>>(method: "GET" | "POST", path: string, body?: unknown) => {
    const r = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json()) as T };
  };
  try {
    token = (await call<{ token: string }>("POST", "/api/login", { login: "owner", password: "secret-pass-1", label: "test" })).json.token;
    const opt = await call<{ steps: number[]; hours: string[]; now: string }>("GET", `/api/habits/${hid}/snooze?day=${today}`);
    assert.equal(opt.status, 200);
    assert.deepEqual(opt.json.steps, [15, 30, 60, 120]);
    assert.equal(opt.json.hours[0], "13:00");
    assert.match(opt.json.now, /^12:\d\d$/);
    assert.deepEqual((await call<{ steps: number[] }>("GET", `/api/habits/${hid}/snooze`)).json.steps, [15, 30, 60, 120], "day по умолчанию — сегодня");

    const rel = await call<{ text: string; at: string }>("POST", `/api/habits/${hid}/snooze`, { day: today, in: 60 });
    assert.equal(rel.status, 200);
    assert.match(rel.json.at, /^13:\d\d$/);
    assert.equal(rel.json.text, `⏰ Зарядка — напомню в ${rel.json.at}. Не отметите до 00:00 — поставлю минус.`);
    const abs = await call<{ text: string; at: string }>("POST", `/api/habits/${hid}/snooze`, { at: "21:30" });
    assert.deepEqual([abs.status, abs.json.at], [200, "21:30"]);
    assert.equal((await store.pendingReminders("habit", hid)).length, 1);

    assert.equal((await call("POST", `/api/habits/${hid}/snooze`, { in: 30, at: "21:30" })).status, 400, "ровно одно из двух");
    assert.equal((await call("POST", `/api/habits/${hid}/snooze`, {})).status, 400);
    assert.equal((await call("POST", `/api/habits/${hid}/snooze`, { at: "25:00" })).status, 400);
    const past = await call<{ error: string }>("POST", `/api/habits/${hid}/snooze`, { at: "05:00" });
    assert.deepEqual([past.status, past.json.error], [409, "Это время уже прошло — выберите позже."]);
    const late = await call<{ error: string }>("POST", `/api/habits/${hid}/snooze`, { in: 1440 });
    assert.deepEqual([late.status, late.json.error], [409, "До 00:00 уже не успеть — выберите время раньше."]);
    const done = await call<{ error: string }>("POST", `/api/habits/${ended}/snooze`, { in: 30 });
    assert.deepEqual([done.status, done.json.error], [409, "Эта привычка уже завершена."]);
    assert.equal((await call("GET", `/api/habits/${ended}/snooze`)).status, 409);
    // GET за вчера и за завтра — 409 с тем же текстом, что у POST (виджет скажет его, а не уйдёт в /mark later).
    const yest = await call<{ error: string }>("GET", `/api/habits/${hid}/snooze?day=${addDays(today, -1)}`);
    assert.deepEqual([yest.status, yest.json.error], [409, "Этот день уже закончился — отложить нельзя."]);
    const tomorrow = await call<{ error: string }>("GET", `/api/habits/${hid}/snooze?day=${addDays(today, 1)}`);
    assert.deepEqual([tomorrow.status, tomorrow.json.error], [409, "Отложить можно только на сегодня."]);
    assert.equal((await call("GET", `/api/habits/${hid}/snooze?day=вчера`)).status, 400);
    assert.equal((await call("POST", `/api/habits/${hid}/snooze`, { in: 0 })).status, 400);
    const other = await store.ensureUser("200", "Другой", tz);
    const theirs = await store.addHabit({ user_id: other.id, title: "Чужая", days: "1234567", times: "[]", start_date: "2026-11-01", end_date: null, message_id: null });
    for (const m of ["GET", "POST"] as const) {
      const r = await call<{ error: string }>(m, `/api/habits/${theirs}/snooze`, m === "POST" ? { in: 30 } : undefined);
      assert.deepEqual([r.status, r.json.error], [409, "Нет такой привычки."], m);
    }

    // Старый виджет: «Ещё нет» → /mark later — прежний ответ.
    const old = await call<{ text: string }>("POST", `/api/habits/${hid}/mark`, { status: "later" });
    assert.match(old.json.text, /спрошу ещё раз в 23:00/);

    await call("POST", `/api/habits/${hid}/mark`, { status: "done" });
    assert.equal((await store.pendingReminders("habit", hid)).length, 0, "отметка сняла отложенное");
    const marked = await call<{ error: string }>("GET", `/api/habits/${hid}/snooze`);
    assert.deepEqual([marked.status, marked.json.error], [409, "Зарядка — уже отмечено."]);
  } finally {
    server.close();
    await store.close();
  }
});
