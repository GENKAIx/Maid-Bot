import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DRAG_PX, LONG_PRESS_MS, pressOutcome, rowAt, sleepDraft, sleepMoveText, TOUCH_SLOP_PX } from "../src/sleep.tsx";

// Правка сна на шкале (web/src/sleep.tsx: SleepEditor, sleepDraft): форма открывается со временем, которое уже видно на полосе;
// у пустого дня — 23:00 и 7:00. 18.11.2026.

test("форма сна: время с полосы, у пустого дня — 23:00–07:00", () => {
  assert.deepEqual(sleepDraft({ day: "2026-11-15", bed: 1.5, wake: 10, hours: 8.5 }), { bed: "01:30", wake: "10:00" });
  assert.deepEqual(sleepDraft({ day: "2026-11-15", bed: 23.25, wake: 7, hours: 7.75 }), { bed: "23:15", wake: "07:00" });
  // Известны только часы и подъём — отбой считается назад.
  assert.deepEqual(sleepDraft({ day: "2026-11-15", wake: 9, hours: 8 }), { bed: "01:00", wake: "09:00" });
  assert.deepEqual(sleepDraft({ day: "2026-11-15" }), { bed: "23:00", wake: "07:00" });
  // Только часы, без времени — тоже по умолчанию.
  assert.deepEqual(sleepDraft({ day: "2026-11-15", hours: 6 }), { bed: "23:00", wake: "07:00" });
});

// Перетаскивание сна на другой день (SleepTimeline, POST /api/sleep/swap), 27.11.2026.

test("перетаскивание сна: щелчок или перетаскивание, мышью и пальцем", () => {
  // Мышь: дрожание руки — ещё щелчок, сдвиг на DRAG_PX — перетаскивание.
  assert.equal(pressOutcome({ dx: 2, dy: 3, ms: 50, touch: false }), "wait");
  assert.equal(pressOutcome({ dx: 0, dy: DRAG_PX, ms: 50, touch: false }), "drag");
  assert.equal(pressOutcome({ dx: 0, dy: 1, ms: 5000, touch: false }), "wait", "мышь не ждёт долгого нажатия");
  // Палец: повёл сразу — это прокрутка; подержал LONG_PRESS_MS — перетаскивание.
  assert.equal(pressOutcome({ dx: 0, dy: TOUCH_SLOP_PX, ms: 100, touch: true }), "cancel");
  assert.equal(pressOutcome({ dx: 0, dy: 3, ms: 100, touch: true }), "wait");
  assert.equal(pressOutcome({ dx: 0, dy: 3, ms: LONG_PRESS_MS, touch: true }), "drag");
  assert.equal(pressOutcome({ dx: 0, dy: 40, ms: LONG_PRESS_MS + 50, touch: true }), "drag");
});

test("перетаскивание сна: строка под указателем, подпись итога", () => {
  const rows = [{ day: "2026-11-08", top: 100, bottom: 122, left: 240, right: 900 }, { day: "2026-11-09", top: 125, bottom: 147, left: 240, right: 900 }];
  assert.equal(rowAt(500, 100, rows), "2026-11-08");
  assert.equal(rowAt(500, 121.9, rows), "2026-11-08");
  assert.equal(rowAt(500, 130, rows), "2026-11-09");
  assert.equal(rowAt(500, 123, rows), null, "в щели между строками — мимо");
  assert.equal(rowAt(500, 90, rows), null);
  assert.equal(rowAt(500, 200, rows), null);
  assert.equal(rowAt(60, 130, rows), null, "сбоку над меню на высоте строки — мимо, сон не переносится");
  assert.equal(rowAt(905, 130, rows), null, "справа за шкалой — мимо");
  assert.equal(sleepMoveText("2026-11-08", "2026-11-12", true), "Сон 8 ноя ⇄ 12 ноя");
  assert.equal(sleepMoveText("2026-11-08", "2026-11-12", false), "Сон перенесён на 12 ноя");
});

test("перетаскивание сна: шкала зовёт /api/sleep/swap, отмена — /api/undo, Esc отменяет", () => {
  const src = readFileSync(new URL("../src/sleep.tsx", import.meta.url), "utf8");
  assert.match(src, /post<[^>]*>\("\/api\/sleep\/swap", \{ from: d\.from, to: d\.over \}\)/);
  assert.match(src, /post\("\/api\/undo", \{ messageId: id \}\)/);
  assert.match(src, /↩ Отменить/);
  assert.match(src, /e\.key === "Escape" && dragRef\.current/);
  assert.match(src, /if \(!dragged\.current\) toggle\(\)/, "после перетаскивания щелчок не открывает правку");
  // Пальцем щелчок после короткого удержания приходит после pointerup отдельной задачей — сброс по таймеру его пропускал.
  assert.doesNotMatch(src, /setTimeout\(\(\) => \{ dragged\.current = false/, "флажок не сбрасывается таймером");
  assert.match(src, /onPointerDownCapture=\{\(\) => \{ dragged\.current = false; \}\}/, "флажок сбрасывает следующее нажатие");
  // Плашка «↩ Отменить» — под строками и прилипает к низу экрана.
  assert.ok(src.indexOf("sleep-note") > src.indexOf("days.map("), "плашка ниже строк");
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.sleep-note \{ position: sticky; bottom: 8px;/);
  assert.match(src, /"touchmove", touch, \{ passive: false \}/, "пока тащим пальцем, страница не прокручивается");
  // У карточки .reveal остаётся transform: fixed внутри неё считается от карточки, призрак уезжал от указателя.
  assert.match(src, /createPortal\(\s*<div className="sleep-ghost"[\s\S]*?document\.body/, "призрак выводится в body");
  assert.match(src, /rowAt\(e\.clientX, e\.clientY,/, "строка под указателем — и по ширине");
});
