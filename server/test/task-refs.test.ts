import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../src/db.ts";
import type { ChatMessage, LlmCall } from "../src/llm.ts";
import { Pipeline, REFS_MAX, taskRefsIn } from "../src/pipeline.ts";
import { zonedToUtc } from "../src/time.ts";

// Ссылка на задачу, которая уже есть (26.11.2026, виджет 0.1.94): ответ «Эта задача уже в списке, под номером #102: «…».
// Второй раз записывать не стала.» — под ним плашка «↗ …», щелчок ведёт к строке задачи. Сервер шлёт refs: [{tbl, id, title}]
// отдельным полем (не в changes: для старого виджета changes — «записала»). Модель подставная, сети нет.

const TZ = "Europe/Moscow";
const AT = zonedToUtc("2026-11-26", "10:00", TZ);

async function setup(answers: unknown[]) {
  const store = await Store.open(":memory:");
  const u = await store.ensureUser("900", "Тест", TZ);
  const calls: ChatMessage[][] = [];
  const llm: LlmCall = async (messages) => {
    calls.push(messages);
    const a = answers.shift();
    return typeof a === "string" ? a : JSON.stringify(a ?? {});
  };
  return { store, u, calls, pipe: new Pipeline(store, llm) };
}
const task = (store: Store, user_id: number, title: string) =>
  store.addTask({ user_id, title, priority: "normal", category: "", due_date: null, notes: "", message_id: null });
const msg = (text: string, id: string) => ({ source: "telegram", sourceId: id, text, at: AT });

test("номер и название из списка — ссылка; чужой, выдуманный номер или номер без связи с задачей — нет", () => {
  const tasks = [{ id: 102, title: "Привозить с села 15-литровку воды" }, { id: 7, title: "Купить лампочку" }];
  assert.deepEqual(taskRefsIn("Эта задача уже в списке, под номером #102: «Привозить с села 15-литровку воды». Второй раз записывать не стала.", tasks), [102]);
  assert.deepEqual(taskRefsIn("Уже есть под номером 102 — привозить воду с села.", tasks), [102]);
  assert.deepEqual(taskRefsIn("Это уже записано: «купить  лампочку»", tasks), [7]);
  assert.deepEqual(taskRefsIn("Под номером #555 такого нет", tasks), []); // не из списка
  assert.deepEqual(taskRefsIn("План #7 на завтра перенесла", tasks), []); // номер плана, о задаче ни слова
  assert.deepEqual(taskRefsIn("Задача #7 и задача #102 уже есть, и #7 ещё раз", tasks), [7, 102]); // без повторов, по порядку
  assert.deepEqual(taskRefsIn("Это уже в списке: &laquo;нет&raquo; <b>#102</b> воду с села", tasks), [102]); // разметка не мешает
  const many = Array.from({ length: 9 }, (_, i) => ({ id: i + 1, title: `Дело ${i + 1}` }));
  assert.equal(taskRefsIn(many.map((t) => `задача #${t.id}`).join(", "), many).length, REFS_MAX);
});

test("номер плана, даты или привычки — не ссылка на задачу с тем же id: нужно «задача» перед номером или её название рядом", () => {
  const tasks = [{ id: 7, title: "Купить лампочку" }, { id: 12, title: "Оплатить интернет" }];
  // Слово «задач» где-то в ответе, а не перед номером, — не привязка.
  assert.deepEqual(taskRefsIn("Перенесла #7 «Стоматолог» на пятницу, задачу записала.", tasks, [7]), []);
  assert.deepEqual(taskRefsIn("Перенесла #7 «Стоматолог» на пятницу, задачу записала.", tasks), []);
  assert.deepEqual(taskRefsIn("Этот план уже есть, под номером #12: «Стоматолог». Новых задач не заводила.", tasks, [12]), []);
  // Перед номером «план» — не задача, даже при общем слове «купить».
  assert.deepEqual(taskRefsIn("План #7 «Купить хлеб к празднику» перенесла", tasks, [7]), []);
  assert.deepEqual(taskRefsIn("План #7 «Купить хлеб к празднику» перенесла", tasks), []);
  assert.deepEqual(taskRefsIn("Привычка под номером 12 уже есть, задача тоже.", tasks), []);
  // Номер есть у события из того же запроса: одного общего слова мало.
  assert.deepEqual(taskRefsIn("Перенесла #7 «Купить хлеб к празднику» на пятницу", tasks, [7]), []);
  // Явная привязка к задаче — ссылка, даже если тот же номер есть у плана.
  assert.deepEqual(taskRefsIn("Задача #7 уже в списке, второй раз не записывала.", tasks, [7]), [7]);
  assert.deepEqual(taskRefsIn("Уже есть под номером #7: купить лампочку.", tasks, [7]), [7]);
  assert.deepEqual(taskRefsIn("Задачу записала, а план #12 перенесла.", tasks, [12]), []); // ближе к номеру — «план»
});

test("в ответе номер события совпал с номером задачи — ссылки на задачу нет", async () => {
  const { store, u } = await setup([]);
  const tid = await task(store, u.id, "Купить лампочку");
  const eid = await store.addEvent({ user_id: u.id, title: "Стоматолог", date_iso: "2026-11-27", time: "10:00", end_time: null, details: "", domain: "life", message_id: null });
  assert.equal(eid, tid); // свои счётчики у таблиц: номера совпали
  const p = new Pipeline(store, async () => JSON.stringify({ reply: `Перенесла #${eid} «Стоматолог» на пятницу, задачу записала.` }));
  const r = await p.handle({ user: u, ...msg("стоматолог на пятницу", "9") });
  assert.equal(r.refs, undefined);
});

test("«уже в списке» — refs с id задачи; changes пустые, «Отменить» нет; модель видела этот номер", async () => {
  const { store, u, calls } = await setup([]);
  const id = await task(store, u.id, "Привозить с села 15-литровку воды");
  const p = new Pipeline(store, async (m) => {
    calls.push(m);
    return JSON.stringify({ reply: `Эта задача уже в списке, под номером #${id}: «Привозить с села 15-литровку воды». Второй раз записывать не стала.` });
  });
  const r = await p.handle({ user: u, ...msg("надо привозить с села 15-литровку воды", "1") });
  assert.match(String(calls[0][0].content), new RegExp(`#${id} Привозить с села`));
  assert.deepEqual(r.refs, [{ tbl: "tasks", id, title: "Привозить с села 15-литровку воды" }]);
  assert.deepEqual(r.changes ?? [], []);
  assert.equal(r.undoable, false);
  assert.match(r.text, /уже в списке/);
});

test("задачи уже нет (выполнена) или чужая — ссылки нет; новая задача этого ответа — карточкой, не ссылкой", async () => {
  const { store, u } = await setup([]);
  const other = await store.ensureUser("901", "Другой", TZ);
  const done = await task(store, u.id, "Сдать отчёт");
  await store.updateTask(done, { status: "done" });
  const theirs = await task(store, other.id, "Чужое дело");
  const replies = [
    { reply: `Задача #${done} «Сдать отчёт» уже была, и задача #${theirs} тоже.` },
    { tasks: [{ title: "Позвонить маме" }], reply: "Записала «Позвонить маме»." },
  ];
  const p = new Pipeline(store, async () => JSON.stringify(replies.shift() ?? {}));
  const r = await p.handle({ user: u, ...msg("сдать отчёт", "2") });
  assert.equal(r.refs, undefined);
  const r2 = await p.handle({ user: u, ...msg("позвонить маме", "3") });
  assert.equal(r2.refs, undefined);
  assert.deepEqual(r2.changes?.map((c) => [c.kind, c.title]), [["task", "Позвонить маме"]]);
});

test("правка задачи словами: переименована или новый срок — ссылка на неё; сделана или убрана — нет", async () => {
  const { store, u } = await setup([]);
  const a = await task(store, u.id, "Купить лампочку");
  const b = await task(store, u.id, "Вынести мусор");
  const replies = [
    { edits: [{ action: "rename", kind: "task", id: a, new_title: "Купить две лампочки" }, { action: "done", kind: "task", id: b }] },
  ];
  const p = new Pipeline(store, async () => JSON.stringify(replies.shift() ?? {}));
  const r = await p.handle({ user: u, ...msg("лампочки нужно две, мусор вынес", "4") });
  assert.deepEqual(r.refs, [{ tbl: "tasks", id: a, title: "Купить две лампочки" }]);
  assert.ok(r.changes?.some((c) => c.kind === "edit"));
});
