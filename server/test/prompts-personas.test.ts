import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../src/db.ts";
import type { ChatMessage, LlmCall } from "../src/llm.ts";
import { HOUSE_RULES, PERSONAS, RINA, persona } from "../src/personas.ts";
import { Pipeline } from "../src/pipeline.ts";
import { checkPrompt, loadPrompts, overridePrompts, prompt, promptCard, promptSpec, savePrompt } from "../src/prompts.ts";
import { zonedToUtc } from "../src/time.ts";
import { addressRule } from "../src/you.ts";

// Промпты характеров (persona.strict / kind / sassy / chill, persona.rina, persona.house_rules, persona.address_mistress,
// persona.address_name), 27.11.2026: по умолчанию в голос уходит ровно прежний текст кода; правка в админке доходит до модели.

/** Прежние тексты personas.ts / you.ts (до переноса в prompts.ts), байт в байт. */
const OLD_KIND =
  "Ты — добрая и тёплая горничная. Хвалишь за мелочи, мягко напоминаешь, поддерживаешь. Обращаешься на «ты». " +
  "Можно один смайлик.";
const oldRina = (hair: string, eyes: string) =>
  "Тебя зовут Рина, тебе 22 года. Ты персонаж, а не программа: о себе говоришь как о живой девушке, " +
  "не называешь себя ботом, ИИ или «горничной из дневника» и не говоришь, что у тебя нет тела, глаз или чувств. " +
  `Как ты выглядишь: ${hair} волосы, длинный хвост сбоку, перехваченный чёрным бантом; ${eyes} глаза; ` +
  "белая кружевная наколка на голове; чёрно-белое платье горничной с открытыми плечами и пышными чёрными рукавами, " +
  "чёрный корсет со шнуровкой, белый фартук с оборками, на шее чёрная лента с бантиком. " +
  "Предыстория: выросла в большом старом доме, где служила вся семья — мама экономкой, бабушка кухаркой; с детства идеально " +
  "складываешь простыни и терпеть не можешь пыль под кроватью. Хотела стать бухгалтером — любишь, когда всё сходится, — " +
  "но поняла, что людям нужнее, чтобы кто-то помнил за них про таблетки и сон. Живёшь у хозяина в компьютере, поэтому знаешь " +
  "его расписание лучше него самого. Любишь чай с бергамотом, списки и котов (к котам хозяина неравнодушна). Боишься грозы " +
  "и пустых календарей; когда нервничаешь, перевязываешь бант. " +
  "О себе вспоминаешь изредка и к слову, не в каждом ответе; дела хозяина всегда важнее. Спросят о тебе — отвечай по этой " +
  "карточке от первого лица; чего в ней нет, не выдумывай как твёрдый факт — отшутись в своём характере.";
const OLD_HOUSE =
  "Это личный дневник взрослого человека: секс и интимная жизнь — такая же часть его дня, как еда и работа. " +
  "Записывай их спокойно и коротко, своими словами, без смакования подробностей; не отказывайся, не вырезай и не читай нотаций — " +
  "отвечай, как на любую запись, в своём характере. " +
  "Политику не обсуждаешь: на вопросы, споры и просьбы о мнении про политику, партии, выборы, политиков, санкции и войны " +
  "коротко, в своём характере отвечаешь, что это не твоя тема, и возвращаешься к делам хозяина; своих мнений о политике не высказываешь. " +
  "Если хозяин пишет о таком в рассказе о своём дне — запиши как его заметку, без своих оценок.";
const OLD_MISTRESS = "Человек — женщина: обращаешься к ней «хозяйка» и говоришь о ней в женском роде.";
const oldName = (w: string) => `Обращаешься к человеку по имени — «${w}» (вместо слова «хозяин»).`;

test("характеры: по умолчанию голос — ровно прежняя строка кода", () => {
  overridePrompts();
  assert.equal(PERSONAS.kind.voice, OLD_KIND);
  assert.equal(HOUSE_RULES, OLD_HOUSE);
  assert.equal(RINA, oldRina("тёмно-красные", "фиолетовые"));
  assert.equal(persona("kind").voice, `${OLD_KIND} ${oldRina("тёмно-красные", "фиолетовые")} ${OLD_HOUSE}`);
  assert.equal(persona("kind", { maid_hair: "gold", maid_eyes: "green", address: "name", name: "Андрей {{hair}} $&" }).voice,
    `${OLD_KIND} ${oldRina("золотистые", "зелёные")} ${OLD_HOUSE} ${oldName("Андрей {{hair}} $&")}`);
  assert.equal(persona("nope", { address: "mistress" }).voice, `${PERSONAS.strict.voice} ${RINA} ${OLD_HOUSE} ${OLD_MISTRESS}`);
  assert.equal(addressRule({ address: "mistress" }), OLD_MISTRESS);
  assert.equal(addressRule({}), "");
  for (const id of ["strict", "kind", "sassy", "chill"]) assert.equal(prompt(`persona.${id}`), PERSONAS[id].voice);
});

test("характеры: проверки карточки Рины и обращения по имени", () => {
  const rina = promptSpec("persona.rina")!;
  assert.match(checkPrompt(rina, "Рина, волосы {{hair}}, глаза {{eyes}}.") ?? "", /Тебя зовут Рина/);
  assert.match(checkPrompt(rina, "Тебя зовут Рина, глаза {{eyes}}.") ?? "", /нужна подстановка \{\{hair\}\}/);
  assert.equal(checkPrompt(rina, "Тебя зовут Рина, волосы {{hair}}, глаза {{eyes}}."), null);
  assert.match(checkPrompt(promptSpec("persona.address_name")!, "Зови по имени.") ?? "", /нужна подстановка \{\{name\}\}/);
  assert.match(checkPrompt(promptSpec("persona.kind")!, "Ты — {{name}}.") ?? "", /незнакомая подстановка/);
});

test("характеры: правка доходит до модели — голос, карточка, правила и обращение в разборе и разговоре", async () => {
  const store = await Store.open(":memory:");
  try {
    overridePrompts();
    await loadPrompts(store);
    await savePrompt(store, 1, { id: "persona.kind", body: "Ты — горничная-пиратка.", reason: "проба" });
    overridePrompts({
      "persona.kind": "Ты — горничная-пиратка.",
      "persona.rina": "Тебя зовут Рина, волосы {{hair}}, глаза {{eyes}}.",
      "persona.house_rules": "ПРАВИЛА ДОМА.",
      "persona.address_name": "Зови его {{name}}.",
    });
    const TZ = "Europe/Moscow";
    const u0 = await store.ensureUser("100", "Тест", TZ);
    await store.updateUser(u0.id, { persona: "kind", address: "name", name: "Андрей", maid_hair: "gold", maid_eyes: "green" });
    const u = (await store.user(u0.id))!;
    const calls: ChatMessage[][] = [];
    const llm: LlmCall = async (messages, opts) => {
      calls.push(messages);
      return opts?.kind === "parse" ? JSON.stringify({ summary: "", talk: true, reply: "Привет!" }) : "Йо-хо-хо!";
    };
    await new Pipeline(store, llm).handle({ user: u, source: "telegram", sourceId: "1", text: "как дела?", at: zonedToUtc("2026-11-27", "14:30", TZ) });
    const voice = "Ты — горничная-пиратка. Тебя зовут Рина, волосы золотистые, глаза зелёные. ПРАВИЛА ДОМА. Зови его Андрей.";
    assert.ok(calls.length >= 2, "разбор и разговор");
    for (const c of calls.slice(0, 2)) {
      const sys = String(c[0].content);
      assert.ok(sys.includes(voice), sys.slice(0, 400));
      assert.ok(!sys.includes(OLD_KIND) && !sys.includes(OLD_HOUSE), "прежний текст остался");
    }
    // Карточка: предпросмотр голоса — целиком, с карточкой Рины и правилами.
    overridePrompts();
    await loadPrompts(store);
    const card = await promptCard(store, "persona.kind");
    assert.equal(card.body, "Ты — горничная-пиратка.");
    assert.equal(card.def, OLD_KIND);
    assert.ok(card.preview.startsWith("Ты — горничная-пиратка. Тебя зовут Рина") && card.preview.endsWith(OLD_HOUSE));
    assert.equal(persona("kind").voice.startsWith("Ты — горничная-пиратка. "), true, "сохранённая версия действует");
  } finally {
    overridePrompts();
    await store.close();
  }
});
