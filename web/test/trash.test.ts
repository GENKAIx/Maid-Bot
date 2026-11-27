import assert from "node:assert/strict";
import { test } from "node:test";
import { daysWord, deletedWhen, leftText, soonest, soonestText, trashLeft } from "../src/trash.ts";

// Корзина (web/src/trash.ts, screens/Trash.tsx; 27.11.2026 — дизайн v2): срок, подписи, самая срочная запись.

const NOW = new Date("2026-11-27T12:00:00").getTime();
const ago = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

test("сколько ещё лежать: дни вверх, не меньше 1, доля срока для полоски", () => {
  assert.deepEqual(trashLeft(ago(0), 14, NOW), { n: 14, part: 1 });
  assert.equal(trashLeft(ago(13.5), 14, NOW)?.n, 1);
  assert.equal(trashLeft(ago(20), 14, NOW)?.n, 1, "просроченное — всё равно 1, сервер вот-вот сотрёт");
  assert.equal(trashLeft(ago(20), 14, NOW)?.part, 0);
  assert.equal(trashLeft(ago(7), 14, NOW)?.part, 0.5);
  assert.equal(trashLeft(null, 14, NOW), null);
});

test("подписи: склонение дней, «завтра», «в течение суток»", () => {
  assert.deepEqual([1, 2, 5, 11, 21, 22, 25, 112].map(daysWord), ["день", "дня", "дней", "дней", "день", "дня", "дней", "дней"]);
  assert.equal(leftText(1), "удалится в течение суток");
  assert.equal(leftText(2), "удалится завтра");
  assert.equal(leftText(12), "удалится через 12 дней");
  assert.equal(soonestText(2), "сотрётся уже завтра");
  assert.equal(soonestText(3), "сотрётся через 3 дня");
});

test("когда удалено: сегодня со временем, вчера, дата", () => {
  const now = new Date(NOW);
  assert.match(deletedWhen(new Date(NOW - 3_600_000).toISOString(), now), /^сегодня \d\d:\d\d$/);
  assert.equal(deletedWhen(ago(1), now), "вчера");
  assert.equal(deletedWhen(null, now), "");
});

test("Рина говорит только о записи, которой осталось 3 дня или меньше, и о самой срочной", () => {
  const items = [{ title: "Йога", at: ago(2) }, { title: "Интернет", at: ago(12.5) }, { title: "Хлеб", at: ago(11.5) }, { title: "Без даты", at: null }];
  const s = soonest(items, 14, NOW);
  assert.equal(s?.title, "Интернет");
  assert.equal(s?.n, 2);
  assert.equal(soonest([{ title: "Йога", at: ago(2) }], 14, NOW), null);
});
