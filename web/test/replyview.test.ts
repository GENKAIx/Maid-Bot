import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../src/api.ts";
import { canNote, draftFor, draftKey, holdsPlace, keepDraft, keepQuestion, openProposal, replyState, retryable, retryWay, stateLabel, stateLook, stillAsked, togglePick, type Shown } from "../src/replyview.ts";
import type { Reply } from "../src/types.ts";

// Строка ввода сайта (28.11.2026, docs/ДИЗАЙН.md 5.7–5.8): id черновика и состояние ответа.

const reply = (more: Partial<Reply> = {}): Reply => ({ text: "x", emotion: "neutral", messageId: 7, undoable: false, ...more });

test("id черновика: тот же текст после сбоя — прежний id; правка или успех — новый", () => {
  let n = 0;
  const id = () => `id${++n}`;
  const first = draftFor(null, draftKey("купить хлеб"), id);
  assert.equal(first.id, "id1");
  // Сбой: черновик остался, человек жмёт Enter ещё раз.
  assert.equal(draftFor(first, draftKey("купить хлеб"), id).id, "id1");
  assert.equal(draftFor(first, draftKey("  купить хлеб  "), id).id, "id1", "пробелы по краям сервер срезает — это та же фраза");
  // Текст изменён — новая фраза.
  assert.equal(draftFor(first, draftKey("купить хлеб и молоко"), id).id, "id2");
  // Успех: черновик сброшен (null) — та же фраза снова уже новая запись.
  assert.equal(draftFor(null, draftKey("купить хлеб"), id).id, "id3");
  // Картинки — часть содержимого.
  const pic = { data: "a".repeat(100) };
  assert.notEqual(draftKey("чек", [pic]), draftKey("чек"));
  assert.notEqual(draftKey("чек", [pic]), draftKey("чек", [{ data: "b".repeat(100) }]));
  assert.equal(draftKey("чек", [pic]), draftKey("чек", [{ data: "a".repeat(100) }]));
});

test("состояние ответа: сохранено, не сохранено, нужно уточнение", () => {
  const saved: Shown = { text: "Записала", reply: reply({ undoable: true }) };
  const failed: Shown = { text: "Не получилось", reply: reply({ failed: true }) };
  const ask: Shown = { text: "Утра или вечера?", reply: reply({ clarify: true }) };
  const offline: Shown = { text: "Failed to fetch", error: true, again: "draft" };
  const pay: Shown = { text: "Проба кончилась", pay: "https://t.me/$x", again: "voice" };
  assert.deepEqual([saved, failed, ask, offline, pay].map(replyState), ["saved", "unsaved", "clarify", "unsaved", "unsaved"]);
  assert.equal(replyState({ text: "Распознаю…", wait: true }), "wait");
  assert.equal(replyState({ text: "Нет доступа к микрофону", error: true }), "error");
  assert.deepEqual(["saved", "unsaved", "clarify", "wait", "error"].map((s) => stateLabel(s as never)), ["", "Не сохранено", "Нужно уточнение", "", ""]);

  assert.deepEqual(stateLook(saved), { bad: false, role: "status" });
  assert.deepEqual(stateLook(ask), { bad: false, role: "status" });
  assert.deepEqual(stateLook(failed), { bad: true, role: "alert" }, "сбой разбора не выглядит как успех");
  assert.deepEqual(stateLook(offline), { bad: true, role: "alert" });
  assert.deepEqual(stateLook(pay), { bad: false, role: "alert" }, "отказ с кнопкой оплаты не красный");
  // Вопрос остаётся вопросом, даже если ответ на него не дошёл (again) — крестик должен снять ожидание на сервере.
  assert.equal(replyState({ ...ask, again: "draft", problem: "нет связи" }), "clarify");
});

test("чем повторить и когда есть «Оставить заметкой»", () => {
  assert.equal(retryWay({ text: "x", reply: reply({ failed: true }) }), "message");
  assert.equal(retryWay({ text: "x", reply: reply({ failed: true }), again: "draft" }), "draft", "картинки сервер не хранит — шлём строку заново");
  assert.deepEqual([keepDraft({ failed: true }, true), keepDraft({ failed: true }, false), keepDraft({}, true)], [true, false, false]);
  assert.equal(retryWay({ text: "x", error: true, again: "voice" }), "voice");
  assert.equal(retryWay({ text: "x", error: true, again: "draft" }), "draft");
  assert.equal(retryWay({ text: "x", reply: reply({ undoable: true }) }), null);
  assert.equal(retryWay({ text: "x", reply: reply({ clarify: true }) }), null);

  assert.equal(canNote({ text: "x", reply: reply({ failed: true }) }), true);
  assert.equal(canNote({ text: "x", reply: reply({ clarify: true }) }), true);
  assert.equal(canNote({ text: "x", reply: reply({ undoable: true }) }), false);
  assert.equal(canNote({ text: "x", error: true, again: "draft" }), false, "сервер фразу не получил — заметкой оставить нечего");

  assert.equal(retryable(new TypeError("Failed to fetch")), true);
  assert.deepEqual([500, 502, 429, 402, 408].map((s) => retryable(new ApiError(s, "x"))), [true, true, true, true, true]);
  assert.deepEqual([400, 413, 422].map((s) => retryable(new ApiError(s, "x"))), [false, false, false]);
});

test("вопрос «добавить?»: показывается, пока открыт; галочки", () => {
  const p = { id: 3, items: [{ kind: "habit" as const, title: "Зарядка", detail: "каждый день" }], picked: [0], remind: null, status: "open", add: "Добавить в привычки" };
  assert.equal(openProposal({ text: "x", reply: reply({ proposal: p }) })?.id, 3);
  assert.equal(openProposal({ text: "x", reply: reply({ proposal: { ...p, status: "accepted" } }) }), null);
  assert.equal(openProposal({ text: "x", reply: reply() }), null);
  assert.equal(openProposal(null), null);
  assert.deepEqual(togglePick([0, 2], 1), [0, 1, 2]);
  assert.deepEqual(togglePick([0, 1, 2], 1), [0, 2]);
});

test("вопрос остаётся на экране, пока сервер его ждёт (waiting)", () => {
  const ask: Shown = { text: "Утра или вечера?", reply: reply({ clarify: true, messageId: 7 }), sent: "завтра в 7 тренировка" };
  assert.equal(stillAsked(ask, { waiting: 7 }), true);
  assert.equal(stillAsked(ask, {}), false, "сервер вопрос закрыл — плашку сменяет новый ответ");
  assert.equal(stillAsked(ask, { waiting: 9 }), false, "ждёт другой вопрос");
  assert.equal(stillAsked({ text: "Записала", reply: reply({ undoable: true }) }, { waiting: 7 }), false);
  assert.equal(stillAsked(null, { waiting: 7 }), false);

  // Ответ на вопрос не разобрался: вопрос тот же, причина строкой, «Повторить» шлёт строку с прежним id; крестик и
  // «Оставить заметкой» по-прежнему про вопрос.
  const failed = keepQuestion(ask, { failed: true }, "Не получилось разобрать", "draft");
  assert.deepEqual([replyState(failed), retryWay(failed), canNote(failed), failed.reply?.messageId], ["clarify", "draft", true, 7]);
  assert.equal(failed.problem, "Не получилось разобрать");
  assert.equal(failed.sent, "завтра в 7 тренировка");
  // Пришёл ответ на другую фразу (погода, картинка): он строкой под вопросом, повторять нечего.
  const other = keepQuestion(failed, {}, "Сегодня ясно", undefined);
  assert.deepEqual([replyState(other), retryWay(other), other.aside, other.problem, other.text], ["clarify", null, "Сегодня ясно", undefined, "Утра или вечера?"]);
});

test("сбой без записи (микрофон, картинка) не заменяет висящий ответ", () => {
  assert.equal(holdsPlace({ text: "Записала", reply: reply({ undoable: true }) }), true, "«Отменить» не пропадает");
  assert.equal(holdsPlace({ text: "Утра или вечера?", reply: reply({ clarify: true }) }), true);
  assert.equal(holdsPlace({ text: "Не получилось", reply: reply({ failed: true }) }), true);
  assert.equal(holdsPlace({ text: "Failed to fetch", error: true, again: "draft" }), true);
  assert.equal(holdsPlace({ text: "Проба кончилась", pay: "https://t.me/$x" }), true);
  assert.equal(holdsPlace({ text: "Смотрю…", wait: true }), false);
  assert.equal(holdsPlace({ text: "Отменила." }), false, "короткий итог кнопки");
  assert.equal(holdsPlace({ text: "Нет доступа к микрофону", error: true }), false);
  assert.equal(holdsPlace(null), false);
});
