import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { demoLength, FEATURES, frameAt } from "../src/features.ts";

// Раздел «Возможности» (web/src/features.ts, screens/Features.tsx): фичи по порядку, у каждой — название, зачем она и живой
// пример; кадр примера собирается по шагам сценария.

test("возможности: первые фичи по порядку, у каждой название, описание и пример", () => {
  assert.deepEqual(FEATURES.slice(0, 3).map((f) => f.id), ["words", "voice", "days"]);
  assert.equal(new Set(FEATURES.map((f) => f.id)).size, FEATURES.length);
  for (const f of FEATURES) {
    assert.ok(f.title && f.text.length > 40, `${f.id}: нет названия или описания`);
    assert.ok(f.ai.steps.length > 0, `${f.id}: пустой пример`);
    if (f.manual) assert.ok(f.manualText, `${f.id}: у ручного пути нет подписи`);
    for (const d of [f.ai, f.manual].filter(Boolean)) {
      const ats = d!.steps.map((s) => s.at);
      assert.deepEqual(ats, [...ats].sort((a, b) => a - b), `${f.id}: шаги не по времени`);
    }
  }
});

test("кадр примера: до первого шага — начало, в конце — итог; возраст поля — сколько мс с его смены", () => {
  const words = FEATURES[0].ai;
  assert.deepEqual(frameAt(words, 0).frame.rows?.map((r) => r.title), ["Созвон"]);
  assert.equal(frameAt(words, 0).frame.bubble, undefined);
  const end = frameAt(words, demoLength(words)).frame;
  assert.deepEqual(end.rows?.map((r) => r.title), ["Созвон", "Врач", "Купить хлеб"]);
  assert.equal(end.maid, "happy");
  assert.equal(frameAt(words, 900).frame.input, "завтра в 15 врач");
  assert.equal(frameAt(words, 900).age.input, 500);
  // Сброс поля шагом (undefined) — поле пропадает.
  const days = FEATURES.find((f) => f.id === "days")!.ai;
  assert.deepEqual(frameAt(days, 7000).frame.buttons, ["➜ Сдвинуть на 16:00", "Оставить"]);
  assert.equal(frameAt(days, demoLength(days)).frame.buttons, undefined);
});

test("эмоции примеров — из тех, что есть у горничной", () => {
  for (const f of FEATURES) for (const d of [f.ai, f.manual].filter(Boolean)) for (const m of [d!.start.maid, ...d!.steps.map((s) => s.set.maid)].filter(Boolean))
    assert.ok(existsSync(new URL(`../public/maid/${m}.webp`, import.meta.url)), `${f.id}: нет картинки горничной ${m}`);
});

test("раздел в меню и на своём адресе", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /\{ id: "features", path: "\/features", title: "Возможности"/);
  assert.match(app, /tab === "features" \? <Features/);
});
