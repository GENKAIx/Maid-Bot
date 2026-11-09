import assert from "node:assert/strict";
import { test } from "node:test";
import zlib from "node:zlib";
import { Store } from "../src/db.ts";
import { Pipeline } from "../src/pipeline.ts";
import { zonedToUtc } from "../src/time.ts";
import { asksForList, fitState, WIDGET_HTML, WIDGET_STATE_MAX, widgetQuery, widgetState, type WidgetState } from "../src/widget.ts";

// Виджет Telegram «Список на сегодня»: состояние, запросы и сам HTML под лимиты Telegram.

const TZ = "Europe/Moscow";
const AT = zonedToUtc("2026-11-09", "10:00", TZ);

async function setup() {
  const store = await Store.open(":memory:");
  const u = await store.ensureUser("100", "Тест", TZ);
  const pipe = new Pipeline(store, async () => "{}");
  const t1 = await store.addTask({ user_id: u.id, title: "Купить хлеб", priority: "normal", category: "", due_date: null, notes: "", message_id: null });
  const t2 = await store.addTask({ user_id: u.id, title: "Позвонить маме", priority: "high", category: "", due_date: null, notes: "", message_id: null });
  const h = await store.addHabit({ user_id: u.id, title: "Зарядка", days: "1234567", times: "[]", start_date: "2026-11-01", end_date: null, message_id: null, created_at: "" } as never);
  return { store, u, pipe, t1, t2, h };
}
const parse = (s: string) => JSON.parse(s) as WidgetState;

test("виджет: в состоянии привычки и задачи на сегодня, важная помечена", async () => {
  const { store, u, t1, t2, h } = await setup();
  const s = parse(await widgetState(store, u, AT));
  assert.deepEqual(s.a, [[`h${h}`, "Зарядка", 0], [`t${t2}`, "Позвонить маме", 2], [`t${t1}`, "Купить хлеб", 0]]);
  assert.equal(s.r, AT.getTime());
});

test("виджет: «сделано» и «вернуть» для задачи и привычки", async () => {
  const { store, u, pipe, t1, h } = await setup();
  let s = parse(await widgetQuery(store, pipe, u, `d:t${t1}`, AT));
  assert.equal((await store.task(t1))!.status, "done");
  assert.deepEqual(s.a.at(-1), [`t${t1}`, "Купить хлеб", 1]);

  s = parse(await widgetQuery(store, pipe, u, `d:h${h}`, AT));
  assert.equal((await store.marksOf(u.id, "2026-11-09", "2026-11-09"))[0].status, "done");
  assert.ok(s.a.some((x) => x[0] === `h${h}` && x[2] === 1));

  s = parse(await widgetQuery(store, pipe, u, `u:h${h}`, AT));
  assert.equal((await store.marksOf(u.id, "2026-11-09", "2026-11-09")).length, 0);
  assert.deepEqual(s.a[0], [`h${h}`, "Зарядка", 0]);

  await widgetQuery(store, pipe, u, `u:t${t1}`, AT);
  assert.equal((await store.task(t1))!.status, "open");
});

test("виджет: чужую задачу не трогает, мусорный запрос — просто свежий список", async () => {
  const { store, u, pipe, t1 } = await setup();
  const other = await store.ensureUser("200", "Чужой", TZ);
  await widgetQuery(store, pipe, other, `d:t${t1}`, AT);
  assert.equal((await store.task(t1))!.status, "open");
  const s = parse(await widgetQuery(store, pipe, u, "что-то", AT));
  assert.equal(s.a.length, 3);
});

test("виджет: состояние всегда влезает в 1024 байта", () => {
  const long = "Очень длинное название задачи, которое никак не помещается в одну строку списка";
  for (const n of [5, 20, 60, 200]) {
    const open = Array.from({ length: n }, (_, i) => [`t${1000 + i}`, long, 0] as [string, string, number]);
    const done = Array.from({ length: n }, (_, i) => [`h${i}`, long, 1] as [string, string, number]);
    const s = fitState(open, done, Date.now());
    assert.ok(Buffer.byteLength(s) <= WIDGET_STATE_MAX, `${n}: ${Buffer.byteLength(s)}`);
    const v = parse(s);
    assert.equal(v.a.filter((x) => !(x[2] & 1)).length + (v.m ?? 0), n, "открытые не теряются молча");
  }
});

test("виджет: HTML в пределах лимитов Telegram и без запрещённого", () => {
  assert.ok(Buffer.byteLength(WIDGET_HTML) <= 32768);
  const z = zlib.deflateSync(Buffer.from(WIDGET_HTML), { level: 9 }).length;
  assert.ok(z <= 4096, `сжатый ${z} байт`);
  assert.ok(!WIDGET_HTML.includes("\0"));
  for (const bad of ["color-mix", "fetch(", "opacity", "position:sticky", "overflow:auto", "vh", "<input", "text-shadow", "@font-face", ":has(", "alert("])
    assert.ok(!WIDGET_HTML.includes(bad), bad);
});

test("виджет: какие сообщения просят список", () => {
  for (const yes of ["Что на сегодня?", "что сегодня", "Чё у меня на сегодня", "что осталось", "Что ещё осталось сделать?", "список", "мои дела", "покажи список дел", "план на сегодня"])
    assert.ok(asksForList(yes), yes);
  for (const no of ["купить хлеб", "что сегодня было на работе интересного, расскажу потом", "сделал зарядку", "список покупок: молоко", "что на завтра"])
    assert.ok(!asksForList(no), no);
});

test("виджет: отметки зовут onChange — по нему бот обновляет живой список", async () => {
  const { store, u, pipe, t1, h } = await setup();
  const seen: number[] = [];
  pipe.onChange = (x) => seen.push(x.id);
  await pipe.markHabit(u, h, "2026-11-09", "done", "test");
  await widgetQuery(store, pipe, u, `d:t${t1}`, AT);
  assert.deepEqual(seen, [u.id, u.id], "отметка привычки и задача из виджета")
});
