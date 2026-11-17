import { PGlite } from "@electric-sql/pglite";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Store, type HabitRow } from "../src/db.ts";
import { PgDriver } from "../src/driver.ts";
import { habitMonth, habitStatsOf } from "../src/habits.ts";
import type { LlmCall } from "../src/llm.ts";
import { Pipeline } from "../src/pipeline.ts";
import { zonedToUtc } from "../src/time.ts";

// Сколько сделано по привычке (17.11.2026): привычка обычная, с галочкой; число — только если человек сам написал горничной
// («прочитал 35 страниц»). Оно лежит в дневной отметке (amount, unit), за день складывается, отменяется вместе с сообщением;
// кнопка «Да» его не стирает. Сайт показывает число в клетке месяца и суммы в статистике.

const TZ = "Europe/Moscow";
const AT = zonedToUtc("2026-11-17", "21:00", TZ);
const BACKENDS: Record<string, () => Promise<Store>> = {
  sqlite: () => Store.open(":memory:"),
  postgres: async () => {
    const pg = new PGlite();
    return Store.over(new PgDriver(pg, (fn) => pg.transaction((tx) => fn(tx)), () => pg.close()));
  },
};
const mark = (amount: number | null, unit = "стр.", day_iso: string | null = null) =>
  ({ habit_marks: [{ habit_id: 1, status: "done", day_iso, amount, unit }], summary: "s" });

for (const [kind, open] of Object.entries(BACKENDS)) {
  test(`${kind}: «прочитал 35 страниц» — галочка и число, за день складывается, отмена и кнопка`, async () => {
    const store = await open();
    const u = await store.ensureUser("100", "Тест", TZ);
    const answers: unknown[] = [mark(35), mark(20), mark(null, "", "2026-11-16"), mark(12, "стр.", "2026-11-16")];
    const llm: LlmCall = async () => JSON.stringify(answers.shift() ?? {});
    const pipe = new Pipeline(store, llm);
    await store.addHabit({ user_id: u.id, title: "Читать", days: "1234567", times: "[]", start_date: "2026-11-01", end_date: null, message_id: null });
    const send = (text: string, id: string) => pipe.handle({ user: u, source: "telegram", sourceId: id, text, at: AT });
    const day = async (d: string) => (await store.marksOf(u.id, d, d))[0];

    const r1 = await send("прочитал 35 страниц", "1");
    assert.equal((await day("2026-11-17")).status, "done");
    assert.equal((await day("2026-11-17")).amount, 35);
    assert.equal((await day("2026-11-17")).unit, "стр.");
    assert.match(r1.changes?.find((c) => c.kind === "mark")?.detail ?? "", /35 стр\./, "в карточке ответа — сколько");

    await send("ещё 20 страниц", "2");
    assert.equal((await day("2026-11-17")).amount, 55, "за день числа складываются");
    await pipe.undo(u);
    assert.equal((await day("2026-11-17")).amount, 35, "отмена возвращает прежнее число");

    await pipe.markHabit(u, 1, "2026-11-17", "done", "telegram");
    assert.equal((await day("2026-11-17")).amount, 35, "кнопка «Да» число не стирает");

    await send("вчера почитал", "3");
    assert.equal((await day("2026-11-16")).status, "done");
    assert.equal((await day("2026-11-16")).amount, null, "без числа — просто галочка");
    await send("вчера было 12 страниц", "4");
    assert.equal((await day("2026-11-16")).amount, 12, "число дописали потом");

    const [row] = await habitMonth(store, u, "2026-11");
    const cell = row.days.find((d) => d.day === "2026-11-17")!;
    assert.deepEqual([cell.status, cell.amount, cell.unit], ["done", 35, "стр."]);
    assert.equal(row.days.find((d) => d.day === "2026-11-15")!.amount, null);
    store.close();
  });
}

test("статистика: суммы за неделю, месяц и всё время, лучший день, столбики за 30 дней; без чисел — нет", () => {
  const h = { id: 1, user_id: 1, title: "Читать", days: "1234567", times: "[]", start_date: "2026-10-01", end_date: null, status: "active", message_id: null } as HabitRow;
  const marks = new Map([["2026-10-20", "done"], ["2026-11-10", "done"], ["2026-11-16", "done"], ["2026-11-17", "done"]] as const);
  const amounts = new Map([["2026-10-20", { amount: 100, unit: "стр." }], ["2026-11-10", { amount: 40, unit: "стр." }], ["2026-11-16", { amount: 12, unit: "стр." }], ["2026-11-17", { amount: 35, unit: "стр." }]]);
  const s = habitStatsOf(h, marks, "2026-11-17", amounts);
  // 17.11.2026 — вторник: неделя с 16-го.
  assert.deepEqual({ ...s.amount!, days: undefined }, { unit: "стр.", week: 47, month: 87, total: 187, best: { day: "2026-10-20", value: 100 }, days: undefined });
  assert.equal(s.amount!.days.length, 30);
  assert.deepEqual(s.amount!.days.at(-1), { day: "2026-11-17", value: 35 });
  assert.equal(s.amount!.days.find((d) => d.day === "2026-11-11")!.value, null);
  assert.equal(habitStatsOf(h, marks, "2026-11-17").amount, null);
});
