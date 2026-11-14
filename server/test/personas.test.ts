import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPrompt } from "../src/parse.ts";
import { HOUSE_RULES, PERSONAS, persona } from "../src/personas.ts";

// Общие правила горничной (personas.ts, HOUSE_RULES): интимное записывать спокойно, без отказов и нотаций; политику не обсуждать.

test("правила — в голосе каждого характера и у неизвестного характера", () => {
  for (const id of [...Object.keys(PERSONAS), undefined, "нет-такого"]) {
    const v = persona(id).voice;
    assert.ok(v.includes(HOUSE_RULES), `нет правил у ${id}`);
    assert.ok(v.startsWith(PERSONAS[id ?? ""]?.voice ?? PERSONAS.strict.voice), `голос характера потерян у ${id}`);
  }
  assert.ok(!PERSONAS.strict.voice.includes(HOUSE_RULES), "правила дописаны в сам список характеров — удвоятся");
  assert.match(HOUSE_RULES, /секс/i);
  assert.match(HOUSE_RULES, /не отказывайся, не вырезай и не читай нотаций/);
  assert.match(HOUSE_RULES, /Политику не обсуждаешь/);
});

test("промпт разбора: интимное записывать, политику не обсуждать", () => {
  const p = buildPrompt({ today: "2026-11-14", now: "21:00", tz: "Europe/Moscow", events: [], tasks: [], dates: [], memory: [], habits: [], recent: [] }, persona("kind").voice);
  assert.match(p, /Секс и интимное — обычный дневник/);
  assert.match(p, /Не пропускай и не вырезай/);
  assert.match(p, /Политика в рассказе о дне — заметка пользователя без твоих оценок/);
  assert.ok(p.includes(HOUSE_RULES), "в голосе для reply нет общих правил");
});
