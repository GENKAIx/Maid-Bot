import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPrompt } from "../src/parse.ts";
import { readFileSync } from "node:fs";
import { EYES_NAMES, HAIR_NAMES, MAID_EYES, MAID_HAIR } from "../src/look.ts";
import { HOUSE_RULES, PERSONAS, RINA, persona, rina } from "../src/personas.ts";

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

// Рина (personas.ts, RINA): горничная — персонаж со своим именем, возрастом, предысторией и внешностью, одна на все характеры.
// 17.11.2026: на «какого цвета у тебя глаза» отвечала «у меня нет глаз, я горничная из дневника».
test("карточка Рины — в голосе каждого характера, один раз", () => {
  for (const id of [...Object.keys(PERSONAS), undefined, "нет-такого"]) {
    const v = persona(id).voice;
    assert.ok(v.includes(RINA), `нет карточки Рины у ${id}`);
    assert.equal(v.split(RINA).length, 2, `карточка Рины повторяется у ${id}`);
  }
  for (const p of Object.values(PERSONAS)) assert.ok(!p.voice.includes(RINA), `карточка дописана в сам характер ${p.id} — удвоится`);
  assert.match(RINA, /Рина/);
  assert.match(RINA, /22/);
  assert.match(RINA, /фиолетов/i);
  assert.match(RINA, /красн/i);
  assert.match(RINA, /не выдумывай/i);
});

// «Перекрасить Рину» (look.ts, 20.11.2026): цвет волос и глаз из настройки хозяина — в её карточке; свои цвета — текст как был.
test("карточка Рины: выбранные волосы и глаза вместо своих, без выбора — прежний текст", () => {
  assert.ok(RINA.includes("Как ты выглядишь: тёмно-красные волосы, длинный хвост сбоку, перехваченный чёрным бантом; фиолетовые глаза; "));
  for (const id of [...Object.keys(PERSONAS), undefined]) {
    const own = persona(id).voice;
    for (const look of [{ maid_hair: "red", maid_eyes: "violet" }, {}, { maid_hair: null, maid_eyes: null }, { maid_hair: "pink", maid_eyes: "toString" }]) {
      assert.equal(persona(id, look).voice, own, `свои (или незнакомые) цвета поменяли промпт у ${id}: ${JSON.stringify(look)}`);
    }
    const v = persona(id, { maid_hair: "gold", maid_eyes: "green" }).voice;
    assert.match(v, /золотистые волосы/);
    assert.match(v, /зелёные глаза/);
    assert.doesNotMatch(v, /тёмно-красн/);
    assert.doesNotMatch(v, /фиолетовые глаза/);
    assert.ok(v.startsWith(PERSONAS[id ?? ""]?.voice ?? PERSONAS.strict.voice) && v.includes(HOUSE_RULES), `голос или правила потеряны у ${id}`);
    assert.equal(v.split("Тебя зовут Рина").length, 2, `карточка Рины повторяется у ${id}`);
  }
  for (const h of MAID_HAIR) assert.ok(rina({ maid_hair: h }).includes(`: ${HAIR_NAMES[h]} волосы, `), `волосы ${h}`);
  for (const e of MAID_EYES) assert.ok(rina({ maid_eyes: e }).includes(`; ${EYES_NAMES[e]} глаза; `), `глаза ${e}`);
});

test("промпт разбора: Рина в выбранных цветах", () => {
  const ctx = { today: "2026-11-20", now: "21:00", tz: "Europe/Moscow", events: [], tasks: [], dates: [], memory: [], habits: [], recent: [] };
  const p = buildPrompt(ctx, persona("sassy", { maid_hair: "silver", maid_eyes: "amber" }).voice);
  assert.match(p, /серебристые волосы/);
  assert.match(p, /янтарные глаза/);
  assert.doesNotMatch(p, /тёмно-красн|фиолетовые глаза/);
  assert.match(buildPrompt(ctx, persona("sassy").voice), /тёмно-красные волосы.*фиолетовые глаза/);
});

test("ответ на вопрос: о себе Рина отвечает по своей карточке, а не «нет данных»", () => {
  const src = readFileSync(new URL("../src/pipeline.ts", import.meta.url), "utf8");
  assert.match(src, /Вопросы о тебе самой — по твоей карточке/);
});
