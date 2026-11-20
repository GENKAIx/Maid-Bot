import { PGlite } from "@electric-sql/pglite";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../src/db.ts";
import { PgDriver } from "../src/driver.ts";
import type { LlmCall } from "../src/llm.ts";
import { persona } from "../src/personas.ts";
import { Pipeline } from "../src/pipeline.ts";
import { zonedToUtc } from "../src/time.ts";

// Поправка к ответу на SQLite и на Postgres (PGlite): новые методы хранилища (money, updateMoney, updateMetric, updateDiary,
// memoryRow, repliesTo, claimMessage, wasUndone, replyUnlessDone, lockRow) и откат поправок «Отменить» — прежние поля возвращаются
// (kind edit), а записанное ответом убирается; ответ отменили, пока поправка ждала модель, — ничего не пишется.

const TZ = "Europe/Moscow";
const AT = zonedToUtc("2026-11-08", "14:30", TZ);

const BACKENDS: Record<string, () => Promise<Store>> = {
  sqlite: () => Store.open(":memory:"),
  postgres: async () => {
    const pg = new PGlite();
    return Store.over(new PgDriver(pg, (fn) => pg.transaction((tx) => fn(tx)), () => pg.close()));
  },
};

for (const [kind, open] of Object.entries(BACKENDS)) {
  test(`${kind}: деньги, показатель и дневник правятся по полям; чужое поле — ошибка`, async () => {
    const store = await open();
    const u = await store.ensureUser("100", "Тест", TZ);
    const m = await store.addMoney({ user_id: u.id, day_key: "2026-11-08", kind: "expense", amount: 450, currency: "RUB", category: "транспорт", note: "такси", message_id: null });
    await store.updateMoney(m, { amount: 540.5, category: "еда", note: "шаурма", currency: "USD", kind: "income", day_key: "2026-11-07" });
    const row = (await store.money(m))!;
    assert.deepEqual(
      [Number(row.amount), row.category, row.note, row.currency, row.kind, row.day_key, Number(row.deleted)],
      [540.5, "еда", "шаурма", "USD", "income", "2026-11-07", 0],
    );
    assert.equal(await store.money(999), undefined);
    await assert.rejects(store.updateMoney(m, { user_id: 7 } as never), /bad field user_id/);

    const x = await store.addMetric({ user_id: u.id, day_key: "2026-11-08", key: "weight", label: "Вес", value: 85, unit: "кг", note: "", source: "text", message_id: null });
    await store.updateMetric(x, { value: 84.5, day_key: "2026-11-07", note: "утром" });
    const mt = (await store.metric(x))!;
    assert.deepEqual([Number(mt.value), mt.day_key, mt.note, Number(mt.deleted)], [84.5, "2026-11-07", "утром", 0]);
    await assert.rejects(store.updateMetric(x, { key: "pulse" } as never), /bad field key/);

    const d = await store.addDiary(u.id, "2026-11-08", "health", "болит голова", null, "head");
    await store.updateDiary(d, { section: "notes", topic: "", text: "болела голова", day_key: "2026-11-07" });
    const dr = (await store.diaryRow(d))!;
    assert.deepEqual([dr.section, dr.topic, dr.text, dr.day_key], ["notes", "", "болела голова", "2026-11-07"]);
    await assert.rejects(store.updateDiary(d, { deleted: 1 } as never), /bad field deleted/);
    await store.close();
  });

  test(`${kind}: память по id, ответы на сообщение, «забрать» сообщение один раз, отменённый ответ`, async () => {
    const store = await open();
    const u = await store.ensureUser("100", "Тест", TZ);
    const mem = await store.addMemory(u.id, "person", "Кот", "Кота зовут Барсик", null);
    await store.setMemoryStatus(mem, "superseded");
    const row = (await store.memoryRow(mem))!;
    assert.deepEqual([Number(row.user_id), row.subject, row.text, row.status], [u.id, "Кот", "Кота зовут Барсик", "superseded"]);
    assert.equal(await store.memoryRow(999), undefined);

    const day = "2026-11-08";
    const first = (await store.saveMessage({ userId: u.id, source: "telegram", sourceId: "1", text: "привет", dayKey: day })).message;
    const a = (await store.saveMessage({ userId: u.id, source: "desktop", sourceId: "correct:a", text: "a", dayKey: day, replyTo: first.id })).message;
    await store.saveMessage({ userId: u.id, source: "telegram", sourceId: "2", text: "другое", dayKey: day });
    const b = (await store.saveMessage({ userId: u.id, source: "desktop", sourceId: "correct:b", text: "b", dayKey: day, replyTo: first.id })).message;
    assert.deepEqual((await store.repliesTo(u.id, first.id)).map((m) => m.id), [a.id, b.id], "от старых к новым, только ответы");
    assert.deepEqual(await store.repliesTo(u.id + 1, first.id), []);

    assert.equal(await store.claimMessage(a.id), true);
    assert.equal((await store.message(a.id))!.state, "done");
    assert.equal(await store.claimMessage(a.id), false, "второй раз — уже забрано");
    assert.equal(await store.transaction(() => store.claimMessage(a.id)), false);
    assert.equal(await store.transaction(() => store.claimMessage(b.id)), true);

    await store.logAction(u.id, first.id, "add", "memory", mem);
    assert.equal(await store.wasUndone(first.id), false);
    await store.markUndone((await store.actionsOf(first.id))[0].id);
    assert.equal(await store.wasUndone(first.id), true);
    assert.equal(await store.wasUndone(b.id), false);
    await store.close();
  });

  test(`${kind}: поправки ответа и «Отменить» — прежние поля по порядку, запись убрана`, async () => {
    const store = await open();
    const u = await store.ensureUser("100", "Тест", TZ);
    const answers: unknown[] = [
      {
        diary: [{ section: "food", text: "шаурма" }], summary: "s",
        events: [{ title: "Встреча", date_iso: "2026-11-09", time: "15:00" }],
        money: [{ kind: "expense", amount: 450, category: "транспорт", note: "шаурма" }],
      },
      { edits: [{ ref: "r2", set: { time: "17:00" } }, { ref: "r3", set: { category: "еда" } }, { ref: "r1", set: { section: "notes" } }] },
      { edits: [{ ref: "r3", set: { amount: 540 } }] },
    ];
    const llm: LlmCall = async () => JSON.stringify(answers.shift() ?? {});
    const pipe = new Pipeline(store, llm);
    const r = await pipe.handle({ user: u, source: "telegram", sourceId: "1", text: "съел шаурму за 450, завтра в 15 встреча", at: AT });
    const [diary, ev, money] = r.changes!.map((c) => c.ref!.id);
    const c1 = (await pipe.correct(u, r.messageId, "в 17, это еда, и это не еда в дневнике", { sourceId: "a", at: AT }))!;
    assert.equal(c1.changed.length, 3);
    await pipe.correct(u, r.messageId, "сумма 540", { sourceId: "b", at: AT });
    assert.equal((await store.event(ev))!.time, "17:00");
    assert.deepEqual([Number((await store.money(money))!.amount), (await store.money(money))!.category], [540, "еда"]);
    assert.equal((await store.diaryRow(diary))!.section, "notes");
    assert.equal((await store.pendingReminders("event", ev)).length, 2);

    await pipe.undo(u, r.messageId);
    const mr = (await store.money(money))!;
    assert.deepEqual([Number(mr.deleted), Number(mr.amount), mr.category], [1, 450, "транспорт"]);
    const dr = (await store.diaryRow(diary))!;
    assert.deepEqual([Number(dr.deleted), dr.section], [1, "food"]);
    const er = (await store.event(ev))!;
    assert.deepEqual([er.status, er.time], ["deleted", "15:00"]);
    assert.deepEqual(await store.pendingReminders("event", ev), []);
    await store.close();
  });

  test(`${kind}: правка денег, показателя и дневника в журнале (kind edit) откатывается без удаления`, async () => {
    const store = await open();
    const u = await store.ensureUser("100", "Тест", TZ);
    const pipe = new Pipeline(store, async () => "{}");
    const m = await store.addMoney({ user_id: u.id, day_key: "2026-11-08", kind: "expense", amount: 450, currency: "RUB", category: "транспорт", note: "такси", message_id: null });
    const x = await store.addMetric({ user_id: u.id, day_key: "2026-11-08", key: "weight", label: "Вес", value: 85, unit: "кг", note: "", source: "text", message_id: null });
    const d = await store.addDiary(u.id, "2026-11-08", "food", "каша", null);
    const first = await pipe.manual(u, "✎ 1", async (log) => {
      await log("money", m, { category: "транспорт" });
      await store.updateMoney(m, { category: "еда" });
      await log("metrics", x, { value: 85 });
      await store.updateMetric(x, { value: 84 });
    });
    await pipe.manual(u, "✎ 2", async (log) => {
      await log("money", m, { amount: 450, category: "еда" });
      await store.updateMoney(m, { amount: 600, category: "кафе" });
      await log("diary", d, { text: "каша" });
      await store.updateDiary(d, { text: "овсянка" });
    });
    await pipe.undo(u); // последняя правка
    const m1 = (await store.money(m))!;
    assert.deepEqual([Number(m1.amount), m1.category, Number(m1.deleted)], [450, "еда", 0]);
    assert.deepEqual([(await store.diaryRow(d))!.text, Number((await store.diaryRow(d))!.deleted)], ["каша", 0]);
    await pipe.undo(u, first);
    const m2 = (await store.money(m))!;
    assert.deepEqual([Number(m2.amount), m2.category, Number(m2.deleted)], [450, "транспорт", 0]);
    const mt = (await store.metric(x))!;
    assert.deepEqual([Number(mt.value), Number(mt.deleted)], [85, 0]);
    await store.close();
  });

  test(`${kind}: ответ о сбое — одним условным запросом: пока сообщение не done, done не трогается`, async () => {
    const store = await open();
    const u = await store.ensureUser("100", "Тест", TZ);
    const m = (await store.saveMessage({ userId: u.id, source: "desktop", sourceId: "correct:1:a", text: "✎ Поправка: в 17", dayKey: "2026-11-08" })).message;
    assert.equal(await store.replyUnlessDone(m.id, "Не получилось"), true);
    const row = (await store.message(m.id))!;
    assert.deepEqual([row.state, row.reply], ["received", "Не получилось"], "состояние то же — повтор спросит модель снова");
    assert.equal(await store.claimMessage(m.id), true);
    await store.setMessage(m.id, { reply: "Поправила." });
    assert.equal(await store.replyUnlessDone(m.id, "Не получилось"), false, "итог другого запроса уже записан");
    assert.equal((await store.message(m.id))!.reply, "Поправила.");
    assert.equal(await store.replyUnlessDone(999, "Не получилось"), false);
    await store.close();
  });

  test(`${kind}: ответ отменили, пока поправка ждала модель, — ничего не записано, ответ честный`, async () => {
    const store = await open();
    const u = await store.ensureUser("100", "Тест", TZ);
    let release!: () => void;
    const gate = new Promise<void>((done) => (release = done));
    let reached!: () => void;
    const waiting = new Promise<void>((done) => (reached = done));
    const llm: LlmCall = async (messages) => {
      if (!messages[0].content.includes("поправляет один твой ответ")) {
        return JSON.stringify({ summary: "s", events: [{ title: "Встреча", date_iso: "2026-11-09", time: "15:00" }] });
      }
      reached();
      await gate;
      return JSON.stringify({ edits: [{ ref: "r1", set: { time: "17:00" } }], reply: "Перенесла." });
    };
    const pipe = new Pipeline(store, llm);
    const r = await pipe.handle({ user: u, source: "telegram", sourceId: "1", text: "завтра в 15 встреча", at: AT });
    const id = r.changes![0].ref!.id;
    const pending = pipe.correct(u, r.messageId, "в 17", { sourceId: "a", at: AT });
    await waiting;
    await pipe.undo(u, r.messageId);
    release();
    const c = (await pending)!;
    assert.equal(c.text, "Этот ответ уже отменён — поправлять нечего.");
    assert.deepEqual([c.undoable, c.changed], [false, []]);
    const ev = (await store.event(id))!;
    assert.deepEqual([ev.status, ev.time], ["deleted", "15:00"]);
    assert.deepEqual(await store.actionsOf(r.messageId), []);
    assert.deepEqual(await store.pendingReminders("event", id), []);
    await store.close();
  });

  test(`${kind}: lockRow держит строку до конца транзакции и ничего в ней не меняет; таблица не из списка — ошибка`, async () => {
    const store = await open();
    const u = await store.ensureUser("100", "Тест", TZ);
    const m = (await store.saveMessage({ userId: u.id, source: "telegram", sourceId: "1", text: "завтра в 15 встреча", dayKey: "2026-11-08" })).message;
    await store.setMessage(m.id, { state: "done", reply: "Внесла.", parse_json: "{}" });
    const ev = await store.addEvent({ user_id: u.id, title: "Встреча", date_iso: "2026-11-09", time: "15:00", end_time: null, details: "", domain: "life", message_id: m.id });
    const before = [await store.message(m.id), await store.event(ev)];
    assert.equal(await store.transaction(async () => (await store.lockRow("messages", m.id)) && (await store.lockRow("events", ev))), true);
    assert.deepEqual([await store.message(m.id), await store.event(ev)], before, "ни поля, ни updated_at");
    assert.equal(await store.lockRow("events", 999), false, "нет строки — false");
    await assert.rejects(store.lockRow("habit_marks" as never, 1), /bad table habit_marks/);
    await store.close();
  });

  test(`${kind}: поправка записалась между началом «↩ Отменить» и его транзакцией — отмена откатывает и её`, async () => {
    const store = await open();
    const u = await store.ensureUser("100", "Тест", TZ);
    let release!: () => void;
    const gate = new Promise<void>((done) => (release = done));
    let reached!: () => void;
    const waiting = new Promise<void>((done) => (reached = done));
    const llm: LlmCall = async (messages) => {
      if (!messages[0].content.includes("поправляет один твой ответ")) {
        return JSON.stringify({ summary: "s", events: [{ title: "Встреча", date_iso: "2026-11-09", time: "15:00" }] });
      }
      reached();
      await gate;
      return JSON.stringify({ edits: [{ ref: "r1", set: { time: "17:00" } }], reply: "Перенесла на 17." });
    };
    const pipe = new Pipeline(store, llm);
    const r = await pipe.handle({ user: u, source: "telegram", sourceId: "1", text: "завтра в 15 встреча", at: AT });
    const id = r.changes![0].ref!.id;
    const pending = pipe.correct(u, r.messageId, "в 17", { sourceId: "a", at: AT });
    await waiting;
    // Отмена уже началась, а поправка дописала своё раньше её транзакции (в Postgres — отдельные запросы на разных соединениях).
    const tx = store.transaction.bind(store);
    let armed = true;
    store.transaction = (async (fn: () => Promise<unknown>) => {
      if (armed) {
        armed = false;
        release();
        await pending;
      }
      return tx(fn);
    }) as typeof store.transaction;
    assert.equal(await pipe.undo(u, r.messageId), persona(u.persona).undone);
    store.transaction = tx;
    assert.match((await pending)!.text, /Перенесла на 17\./, "поправка успела записаться");
    const ev = (await store.event(id))!;
    assert.deepEqual([ev.status, ev.time], ["deleted", "15:00"], "план убран, поправка откатилась");
    assert.deepEqual(await store.actionsOf(r.messageId), [], "под отменённым ответом нет живой поправки");
    assert.equal(await store.lastDoneMessage(u.id), undefined);
    assert.equal(await pipe.undo(u), "Нечего отменять.");
    await store.close();
  });

  test(`${kind}: поправка и «↩ Отменить» начинают запись с блокировки строки ответа, поправка — ещё и правимой записи`, async () => {
    const store = await open();
    const u = await store.ensureUser("100", "Тест", TZ);
    const answers: unknown[] = [
      { summary: "s", events: [{ title: "Встреча", date_iso: "2026-11-09", time: "15:00" }] },
      { edits: [{ ref: "r1", set: { time: "17:00" } }] },
    ];
    const pipe = new Pipeline(store, async () => JSON.stringify(answers.shift() ?? {}));
    const r = await pipe.handle({ user: u, source: "telegram", sourceId: "1", text: "завтра в 15 встреча", at: AT });
    const id = r.changes![0].ref!.id;
    // В Postgres (READ COMMITTED, пул соединений) одновременные транзакции видят только уже закоммиченное: порядок держит
    // блокировка строки ответа — первая инструкция и поправки, и отмены; журнал отмена читает уже после неё.
    const calls: string[] = [];
    const st = store as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    const tx = store.transaction.bind(store);
    store.transaction = ((fn: () => Promise<unknown>) => tx(async () => {
      calls.push("{");
      try {
        return await fn();
      } finally {
        calls.push("}");
      }
    })) as typeof store.transaction;
    for (const name of ["lockRow", "claimMessage", "actionsOf", "event"]) {
      const was = st[name].bind(store);
      st[name] = async (...a) => {
        calls.push(`${name}:${a.join(":")}`);
        return was(...a);
      };
    }
    await pipe.correct(u, r.messageId, "в 17", { sourceId: "a", at: AT });
    assert.equal((await store.event(id))!.time, "17:00");
    const i = calls.indexOf(`lockRow:messages:${r.messageId}`);
    assert.ok(i > 0, "поправка блокирует строку ответа");
    assert.equal(calls[i - 1], "{", "первой инструкцией транзакции");
    assert.match(calls[i + 1], /^claimMessage:/);
    const j = calls.indexOf(`lockRow:events:${id}`, i);
    assert.ok(j > i, "и правимую запись — до того, как перечитать её");
    assert.equal(calls[j + 1], `event:${id}`);

    calls.length = 0;
    await pipe.undo(u, r.messageId);
    assert.deepEqual(calls.slice(0, 3), ["{", `lockRow:messages:${r.messageId}`, `actionsOf:${r.messageId}`], "журнал — в транзакции, после блокировки");
    assert.deepEqual([(await store.event(id))!.status, (await store.event(id))!.time], ["deleted", "15:00"]);
    await store.close();
  });
}
