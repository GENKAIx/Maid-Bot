import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { hashPassword } from "../src/auth.ts";
import { Store, type TraitRow } from "../src/db.ts";
import type { ChatMessage, LlmCall } from "../src/llm.ts";
import { morningText } from "../src/morning.ts";
import { PATTERN_MIN, findPatterns, traitPrompt } from "../src/profile.ts";
import { checkPrompt, loadPrompts, overridePrompts, prompt, promptCard, promptSpec } from "../src/prompts.ts";
import { EVENING_MAX, Scheduler } from "../src/scheduler.ts";

// Промпты утра, вечера и профиля (morning.fact / wish / weather, evening.summary, profile.patterns, profile.traits), 27.11.2026:
// по умолчанию модели уходит ровно прежний текст кода; правка в админке доходит до модели; схемы и строки черт строит код.

afterEach(() => overridePrompts());

const TZ = "Europe/Moscow";
const IDS = ["morning.fact", "morning.wish", "morning.weather", "evening.summary", "profile.patterns", "profile.traits"];

async function owner() {
  const store = await Store.open(":memory:");
  const u = await store.createUser({ login: "owner", passwordHash: await hashPassword("secret-pass-1"), tz: TZ });
  return { store, u };
}
const trait = (kind: string, title: string, note = "", category = "allergy") =>
  ({ id: 1, user_id: 1, kind, category, title, note, source: "chat", status: "active", evidence: "", created_at: "", message_id: null }) as unknown as TraitRow;

/** Прежний traitPrompt (до переноса текста в prompts.ts), байт в байт. */
function oldTraits(de: string[], bu: string[]) {
  return [
    de.length ? `Дебафы пользователя (аллергии, непереносимость, противопоказания):\n${de.join("\n")}` : "",
    bu.length ? `Бафы пользователя (что ему помогает):\n${bu.join("\n")}` : "",
    "Если сообщение или вопрос касается еды, напитков, лекарств, нагрузок или мест, которые задевают дебаф, — коротко и прямо " +
      "предупреди об этом в ответе (например: «Лучше без креветок — у вас на них аллергия»). Не к месту дебафы не упоминай.",
  ].filter(Boolean).join("\n");
}

test("утро, вечер, профиль: все шесть промптов в реестре, def проходит проверку, разделы верные", () => {
  for (const id of IDS) {
    const spec = promptSpec(id);
    assert.ok(spec, id);
    assert.equal(checkPrompt(spec, spec.def), null, id);
    assert.equal(spec.section, id.startsWith("profile.") ? "Профиль" : "Утро и вечер", id);
  }
});

test("по умолчанию — прежний текст: вечер, закономерности, черты", () => {
  assert.equal(prompt("evening.summary", { max: String(EVENING_MAX) }),
    "Вечерний итог дня для хозяина — 2–3 коротких предложения, не длиннее 300 знаков, " +
    "без заголовков, списков и эмодзи в начале строк. НЕ пересказывай, что было за день: цифры он уже видит. " +
    "Найди одну неочевидную связь по записям за неделю (что повторяется, что идёт после чего: еда и самочувствие, игры и сон, " +
    "дела и настроение) и дай один конкретный маленький совет на завтра с учётом завтрашних планов. Только по фактам ниже, " +
    "без выдумок; связи нет — один точный совет. О здоровье — без диагнозов: «заметь и проверь», при повторах несколько дней — к врачу.");
  assert.equal(prompt("profile.patterns", { min: String(PATTERN_MIN) }),
    "Ты смотришь дневник пользователя и ищешь повторяющиеся связи «после X ему плохо» (еда, напитки, лекарства, " +
    "недосып, нагрузка → боль, тошнота, сыпь, слабость и т. п.). Связь засчитывается, только если в дневнике она видна " +
    "минимум в 3 разных днях: в один день — и X, и плохое самочувствие после него. Не выдумывай, не ставь " +
    "диагнозов, случайные совпадения не бери. Уже известное ниже не повторяй.");
  const shrimp = trait("debuff", "Креветки", "сыпь"), milk = trait("debuff", "Молоко", "", "food"), sleep = trait("buff", "Сон", "", "weird");
  assert.equal(traitPrompt([]), "");
  assert.equal(traitPrompt([shrimp]), oldTraits(["- [Аллергия] Креветки — сыпь"], []));
  assert.equal(traitPrompt([sleep]), oldTraits([], ["- [weird] Сон"]));
  assert.equal(traitPrompt([shrimp, sleep, milk]), oldTraits(["- [Аллергия] Креветки — сыпь", "- [Еда] Молоко"], ["- [weird] Сон"]));
});

test("утро: по умолчанию модели — прежний текст; правка абзаца доходит до модели, ключи JSON и последняя строка — из кода", async () => {
  const { store, u } = await owner();
  let asked: ChatMessage[] = [];
  const llm: LlmCall = async (m) => ((asked = m), JSON.stringify({ fact: "x", wish: "y" }));
  await morningText(store, llm, u, "2026-11-15");
  const sys = String(asked[0].content);
  assert.ok(sys.endsWith(
    " (2026-11-15). Ответь JSON {\"fact\": \"...\", \"wish\": \"...\"}.\n" +
    "fact — одно короткое забавное предложение про этот день, не длиннее 240 знаков: праздник этого дня (можно неофициальный и " +
    "смешной), событие, случившееся в этот день в истории, или интересный факт. Пиши только то, в чём уверена. Не уверена — скажи " +
    "что-нибудь про время года или день недели.\n" +
    "wish — напутствие на день от тебя хозяину, 1–2 предложения, не длиннее 240 знаков, твоими словами и твоим голосом. Основа — " +
    "мысль ниже (идея стоиков): перескажи её по-своему, как совет на сегодня, можно с привязкой к его планам. Не цитируй, не называй " +
    "философов и стоицизм.\n" +
    "Без приветствия, без кавычек вокруг текста, без эмодзи в начале."), sys);
  assert.match(sys, /\nУтреннее сообщение хозяину на .*15 ноября/);
  assert.doesNotMatch(sys, /weather/, "без прогноза — без абзаца погоды");
  overridePrompts({ "morning.wish": "wish — пожелай хозяину удачи на сегодня, до {{max}} знаков." });
  await morningText(store, llm, u, "2026-11-15");
  const edited = String(asked[0].content);
  assert.match(edited, /\nwish — пожелай хозяину удачи на сегодня, до 240 знаков\.\nБез приветствия/);
  assert.doesNotMatch(edited, /идея стоиков/);
  assert.match(edited, /Ответь JSON \{"fact": "\.\.\.", "wish": "\.\.\."\}/);
  assert.match(edited, /\nfact — одно короткое/);
});

test("вечер: правка итога дня доходит до модели, голос характера остаётся перед ним", async () => {
  const { store, u } = await owner();
  await store.addDiary(u.id, "2026-11-13", "food", "Пельмени.", null);
  let seen: ChatMessage[] = [];
  const llm: LlmCall = async (m) => ((seen = m), "Завтра без пельменей.");
  overridePrompts({ "evening.summary": "Итог дня одним предложением, до {{max}} знаков." });
  await new Scheduler(store, llm, async () => {}).eveningText(u, "2026-11-13");
  const sys = String(seen[0].content);
  assert.ok(sys.endsWith("\nИтог дня одним предложением, до 300 знаков."), sys);
  assert.doesNotMatch(sys, /НЕ пересказывай/);
  assert.match(String(seen[1].content), /Пельмени/);
});

test("закономерности: правка правил доходит до модели, образец JSON и «Уже известно» — из кода", async () => {
  const { store, u } = await owner();
  for (const d of ["2026-11-01", "2026-11-03", "2026-11-05"]) {
    await store.addDiary(u.id, d, "food", "латте", null);
    await store.addDiary(u.id, d, "health", "болел живот", null);
  }
  let seen: ChatMessage[] = [];
  const llm: LlmCall = async (m) => ((seen = m), JSON.stringify({ patterns: [] }));
  overridePrompts({ "profile.patterns": "Ищи только связи с едой, минимум {{min}} дня." });
  await findPatterns(store, llm, u, "2026-11-08");
  const sys = String(seen[0].content);
  assert.ok(sys.startsWith("Ищи только связи с едой, минимум 3 дня.\nОтветь JSON: {\"patterns\": ["), sys);
  assert.match(sys, /food\|allergy\|med\|condition\|body\|other/);
  assert.ok(sys.endsWith("\n\nУже известно:\nнет"), sys);
});

test("черты: правка текста доходит до запроса; абзац без черт пропадает, строки черт строит код", () => {
  overridePrompts({ "profile.traits": "Нельзя:\n{{debuffs}}\n\nПомогает:\n{{buffs}}\n\nПредупреждай коротко." });
  const shrimp = trait("debuff", "Креветки", "сыпь"), sleep = trait("buff", "Сон", "", "body");
  assert.equal(traitPrompt([shrimp, sleep]), "Нельзя:\n- [Аллергия] Креветки — сыпь\nПомогает:\n- [Тело] Сон\nПредупреждай коротко.");
  assert.equal(traitPrompt([shrimp]), "Нельзя:\n- [Аллергия] Креветки — сыпь\nПредупреждай коротко.");
  assert.equal(traitPrompt([sleep]), "Помогает:\n- [Тело] Сон\nПредупреждай коротко.");
  assert.equal(traitPrompt([{ ...shrimp, title: "{{buffs}} x" }]), "Нельзя:\n- [Аллергия] {{buffs}} x — сыпь\nПредупреждай коротко.", "подстановка в названии черты не раскрывается");
  assert.equal(traitPrompt([]), "");
  assert.match(String(checkPrompt(promptSpec("profile.traits")!, "Только {{debuffs}}")), /\{\{buffs\}\}/, "обе подстановки обязательны");
});

test("предпросмотр в админке: утро и закономерности — целиком, со схемой из кода", async () => {
  const { store } = await owner();
  const fact = await promptCard(store, "morning.fact");
  assert.match(fact.preview, /^‹голос характера›\nУтреннее сообщение хозяину на .+Ответь JSON \{"fact": "\.\.\.", "wish": "\.\.\.", "weather": "\.\.\."\}\.\nfact — .+240 знаков/s);
  assert.match(fact.preview, /\nweather — погода на сегодня.+\nБез приветствия/s);
  assert.match(fact.preview, /\[сообщение пользователя\]\nМысль дня: /);
  const pat = await promptCard(store, "profile.patterns");
  assert.match(pat.preview, /минимум в 3 разных днях.+\nОтветь JSON: \{"patterns".+\n\nУже известно:\n- Плохо после молока/s);
  const tr = await promptCard(store, "profile.traits");
  assert.ok(tr.preview.includes("сыпь\nБафы пользователя"), tr.preview);
  const ev = await promptCard(store, "evening.summary");
  assert.match(ev.preview, /не длиннее 300 знаков/);
});

test("profile.traits: обе подстановки в одном абзаце — не сохранить; такой текст из базы заменяется текстом из кода", async () => {
  const spec = promptSpec("profile.traits")!;
  const one = "Дебафы:\n{{debuffs}}\nБафы:\n{{buffs}}\nПредупреждай о дебафах.";
  assert.equal(checkPrompt(spec, one), "{{debuffs}} и {{buffs}} — в разных абзацах (между ними пустая строка)");
  assert.equal(checkPrompt(spec, "Дебафы:\n{{debuffs}}\n\nБафы:\n{{buffs}}"), null);
  const { store } = await owner();
  try {
    const shrimp = [trait("debuff", "Креветки")];
    const want = traitPrompt(shrimp);
    assert.ok(want.includes("Креветки") && want.includes("предупреди"), want);
    await store.addPromptVersion("profile.traits", one, "2026-11-27T12:00:00Z", 1, "в обход проверки");
    await loadPrompts(store);
    assert.equal(traitPrompt(shrimp), want, "негодный текст из базы не действует");
  } finally {
    overridePrompts();
    await store.close();
  }
});
