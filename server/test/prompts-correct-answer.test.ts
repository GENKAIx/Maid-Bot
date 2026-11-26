import assert from "node:assert/strict";
import { test } from "node:test";
import { correctPrompt, DATE_TYPES, type Editable } from "../src/correct.ts";
import { Store } from "../src/db.ts";
import type { ChatMessage, LlmCall } from "../src/llm.ts";
import { SHELF_KEYS } from "../src/notes.ts";
import { HEALTH_TOPICS, MONEY_CATEGORIES, promptHeader, SECTIONS } from "../src/parse.ts";
import { EMOTIONS } from "../src/personas.ts";
import { Pipeline } from "../src/pipeline.ts";
import { checkPrompt, overridePrompts, prompt, promptCard, promptSpec } from "../src/prompts.ts";
import { zonedToUtc } from "../src/time.ts";

// Промпты поправки ответа, ответа на вопрос и разговора (correct.rules, answer.rules, answer.shelf_rule, chat.system), 27.11.2026:
// по умолчанию модели уходит ровно прежний текст кода; правка в админке доходит до модели; перечни из кода остаются на месте.

const TZ = "Europe/Moscow";
const AT = zonedToUtc("2026-11-08", "14:30", TZ);

/** Прежний correctPrompt (до переноса текста в prompts.ts), байт в байт. */
function oldCorrect(o: { voice: string; today: string; now: string; tz: string; original: string; list: string; asked: string }) {
  const PRIORITIES = ["high", "normal", "low"];
  return `${o.voice}
Пользователь поправляет один твой ответ — записи, которые ты сделала из его сообщения. Меняй только их: других записей здесь нет.
${promptHeader(o.today, o.now, o.tz)}

Его сообщение, из которого сделаны записи:
${o.original}

Записи этого ответа (ref — номер, дальше — вид записи и её поля сейчас):
${o.list}
${o.asked}
Какие поля можно менять:
- план: title, date_iso (ГГГГ-ММ-ДД), time (ЧЧ:ММ или null — на весь день), end_time (ЧЧ:ММ или null), details
- задача: title, due_date (ГГГГ-ММ-ДД или null — без срока), priority (${PRIORITIES.join("|")})
- деньги: kind (expense — трата, income — доход), amount (число больше 0), currency (RUB|USD|EUR…), category (${MONEY_CATEGORIES.join("|")}), note (на что / от кого), day_key (ГГГГ-ММ-ДД, не позже сегодня)
- показатель: value (число), day_key (ГГГГ-ММ-ДД, не позже сегодня), note
- дневник: section (${Object.keys(SECTIONS).join("|")}), topic (только для health: ${Object.keys(HEALTH_TOPICS).join("|")}), text, day_key (не позже сегодня)
- заметка «на потом»: shelf (${SHELF_KEYS.join("|")}), title, note
- важная дата: title, date_iso (ГГГГ-ММ-ДД), type (${DATE_TYPES.join("|")}), yearly (true|false)

Ответь ОДНИМ JSON-объектом:
{"edits": [{"ref": "r1", "set": {"time": "17:00"}}], "remove": [], "add": {}, "clarify": null, "unsupported": false, "reply": "короткая живая реплика, что поправила (1 предложение)", "emotion": "${EMOTIONS.join("|")}"}

Правила:
- В set — только поля, которые просит поменять поправка; остальное оставь как есть и не повторяй.
- Поправка про одну запись — меняй только её. Неясно, какую запись или на что поменять, — clarify: один короткий вопрос, edits пустой.
- Время «в 7» без утра/вечера, где оба варианта правдоподобны, — clarify. «В 7 вечера» — 19:00. Время — только ЧЧ:ММ.
- Сдвигаешь начало плана, а конец не назван — end_time не ставь: длительность сохранит сервер. Конец раньше начала («с 22 до 2») — до утра следующего дня, так можно.
- «Это еда, а не транспорт» — category; «сумма 540» — amount; «на завтра», «это было вчера» — date_iso, due_date или day_key.
- Трата или доход — это поле kind у денег, его менять можно.

Убрать, дописать, записать в другом виде:
- remove — номера записей, которые не надо было записывать («в задачи не надо», «это не трата», «убери встречу»). Остальные записи не трогай.
- Просят другой вид записи («это задача, а не план», «запиши в дневник, а не в траты», «это на полку фильмов») — remove прежней записи и add с новой:
  перенеси в неё название, дату, время, сумму — всё, что подходит новому виду. Вид — только из списка ниже.
- Пропущено в ответе («и ещё 300 на такси», «и задачу купить хлеб», «запиши ещё, что болела голова») — add без remove:
  только то, что прямо сказано в поправке. Уже записанное в ответе второй раз не добавляй — поправь его.
- add — новые записи, поля — как у разбора сообщения:
  "events": [{"title": "...", "date_iso": "ГГГГ-ММ-ДД", "time": "ЧЧ:ММ или null", "end_time": null, "details": ""}] — план,
  "tasks": [{"title": "...", "priority": "${PRIORITIES.join("|")}", "due_date": "ГГГГ-ММ-ДД или null"}] — задача,
  "money": [{"kind": "expense|income", "amount": 450, "currency": "RUB", "category": "${MONEY_CATEGORIES.join("|")}", "note": "на что / от кого", "day_iso": null}],
  "metrics": [{"key": "weight|pulse|… латиницей", "label": "подпись по-русски", "value": 85, "unit": "", "note": "", "day_iso": null}] — показатель,
  "diary": [{"section": "${Object.keys(SECTIONS).join("|")}", "topic": "только для health", "text": "...", "day_iso": null}] — дневник,
  "stash": [{"shelf": "${SHELF_KEYS.join("|")}", "title": "название как есть", "note": ""}] — заметка «на потом»,
  "dates": [{"title": "...", "date_iso": "ГГГГ-ММ-ДД", "type": "${DATE_TYPES.join("|")}", "person": "", "yearly": true}] — важная дата.
- Сделать из записи привычку, запомнить о пользователе, записать в профиль (аллергия, особенность) — этого поправка не умеет: unsupported: true, остальное пустое.
- Ничего не выдумывай: числа, даты и время — только названные в поправке или прямо из неё вытекающие («на час позже»).`;
}

const OLD_ANSWER = (shelf: string, today: string) => "Отвечай на вопрос пользователя только по его записям ниже. " +
  `Нет данных — так и скажи, не выдумывай. ${shelf}Вопросы о тебе самой — по твоей карточке, не по записям. Коротко, 1–4 предложения. Сегодня ${today}. ` +
  "Дни называй датой в виде ГГГГ-ММ-ДД (их покажут ссылками), суммы и средние бери из «Итогов», сам не складывай; данные за один день — не называй это средним.";
const OLD_SHELF = "Спрашивают про заметки «на потом»: назови, что ждёт на полке (до 8 названий; если их больше — скажи, сколько всего), и предложи одно на выбор. Полка пуста — так и скажи. ";

const EVENT = { tbl: "events", row: { title: "Встреча с Петей", date_iso: "2026-11-09", time: "15:00", end_time: null, details: "" } } as unknown as Editable;
const EVENT_LINE = 'r1 план: {"title":"Встреча с Петей","date_iso":"2026-11-09","time":"15:00","end_time":null,"details":""}';

test("по умолчанию — ровно прежние тексты поправки, ответа на вопрос и разговора", () => {
  overridePrompts();
  const base = { voice: "ГОЛОС", today: "2026-11-08", now: "14:30", tz: TZ, original: "завтра в 15 встреча {{now}} $&" };
  assert.equal(correctPrompt({ ...base, rows: [EVENT] }), oldCorrect({ ...base, list: EVENT_LINE, asked: "" }));
  const asked = "\nНа прошлую поправку ты переспросила: «В 7 утра или вечера?». Ниже в сообщении — та поправка и ответ на вопрос («(уточнение: …)»): исполни поправку с ним.\n";
  assert.equal(correctPrompt({ ...base, rows: [EVENT], question: "В 7 утра или вечера?" }), oldCorrect({ ...base, list: EVENT_LINE, asked }));
  assert.equal(prompt("answer.rules", { shelf_rule: "", today: "2026-11-08" }), OLD_ANSWER("", "2026-11-08"));
  assert.equal(`${prompt("answer.shelf_rule")} `, OLD_SHELF);
  assert.equal(prompt("chat.system", { today: "2026-11-08", memory: "почти ничего" }), "Сегодня 2026-11-08.\nЧто знаешь о собеседнике:\nпочти ничего");
  for (const id of ["correct.rules", "answer.rules", "answer.shelf_rule", "chat.system"]) {
    const spec = promptSpec(id)!;
    assert.equal(checkPrompt(spec, spec.def), null, id);
  }
});

test("correct.rules: перечни из кода — обязательные подстановки; без JSON или без {{schema}} не сохранить", () => {
  const spec = promptSpec("correct.rules")!;
  assert.match(checkPrompt(spec, spec.def.replace("{{schema}}", "")) ?? "", /\{\{schema\}\}/);
  assert.match(checkPrompt(spec, spec.def.replace("{{add_schema}}", "")) ?? "", /\{\{add_schema\}\}/);
  assert.match(checkPrompt(spec, spec.def.replaceAll("JSON", "джейсон")) ?? "", /JSON/);
  assert.equal(checkPrompt(spec, `Коротко. {{header}} {{original}} {{rows}} {{asked}} {{fields}} {{schema}} {{add_schema}} JSON`), null);
  assert.match(checkPrompt(promptSpec("answer.rules")!, "Отвечай по записям. Сегодня {{today}}.") ?? "", /\{\{shelf_rule\}\}/);
  assert.match(checkPrompt(promptSpec("chat.system")!, "Сегодня {{today}}.") ?? "", /\{\{memory\}\}/);
});

test("предпросмотр: поправка — со схемой и перечнями из кода, ответ про полки — с правилом полок внутри", async () => {
  overridePrompts();
  const store = await Store.open(":memory:");
  try {
    const c = await promptCard(store, "correct.rules");
    assert.ok(c.preview.startsWith("‹голос характера›\nПользователь поправляет"));
    assert.ok(c.preview.includes(`"emotion": "${EMOTIONS.join("|")}"`), "в предпросмотре нет образца JSON");
    assert.ok(c.preview.includes(`category (${MONEY_CATEGORIES.join("|")})`), "в предпросмотре нет перечня категорий");
    assert.ok(!/\{\{[a-z_]+\}\}/.test(c.preview), "в предпросмотре остались подстановки");
    const s = await promptCard(store, "answer.shelf_rule");
    assert.ok(s.preview.includes(OLD_ANSWER(OLD_SHELF, "2026-11-27")), "правило полок — не на своём месте в ответе");
    const t = await promptCard(store, "chat.system");
    assert.ok(t.preview.includes(prompt("chat.rules")) && t.preview.includes("Что знаешь о собеседнике:\nПетя: друг детства"));
  } finally {
    await store.close();
  }
});

async function setup(answers: unknown[]) {
  const store = await Store.open(":memory:");
  const u = await store.ensureUser("100", "Тест", TZ);
  const calls: { kind?: string; messages: ChatMessage[] }[] = [];
  const llm: LlmCall = async (messages, opts) => {
    calls.push({ kind: opts?.kind, messages });
    const a = answers.shift();
    return typeof a === "string" ? a : JSON.stringify(a ?? {});
  };
  const pipe = new Pipeline(store, llm);
  const say = (text: string, id: string) => pipe.handle({ user: u, source: "telegram", sourceId: id, text, at: AT });
  return { store, u, calls, pipe, say };
}
const sysOf = (c: { messages: ChatMessage[] }) => String(c.messages[0].content);

test("правка доходит до модели: поправка ответа, ответ на вопрос, полки и разговор", async () => {
  try {
    // Поправка ответа.
    overridePrompts({
      "correct.rules": "ПРАВИЛА-ПОПРАВКИ {{header}}\nСообщение: {{original}}\nЗаписи:\n{{rows}}{{asked}}\nПоля:\n{{fields}}\nJSON:\n{{schema}}\nНовые:\n{{add_schema}}",
    });
    {
      const { store, u, calls, pipe, say } = await setup([
        { summary: "[14:30] встреча", events: [{ title: "Встреча с Петей", date_iso: "2026-11-09", time: "15:00", end_time: null }] },
        { edits: [{ ref: "r1", set: { time: "17:00" } }], reply: "Перенесла.", emotion: "proud" },
      ]);
      const r = await say("завтра в 15 встреча с Петей", "1");
      await pipe.correct(u, r.messageId, "не в 15, а в 17", { sourceId: "c1", at: AT });
      const c = calls.find((x) => x.kind === "correct")!;
      const sys = sysOf(c);
      assert.ok(sys.includes("\nПРАВИЛА-ПОПРАВКИ Сегодня 2026-11-08"), "правка correct.rules не дошла до модели");
      assert.ok(!sys.includes("Пользователь поправляет один твой ответ"), "старый текст остался");
      assert.ok(sys.includes("Сообщение: завтра в 15 встреча с Петей"));
      assert.ok(sys.includes(`"emotion": "${EMOTIONS.join("|")}"`) && sys.includes(`shelf (${SHELF_KEYS.join("|")})`), "перечни из кода пропали");
      assert.equal((await store.eventsBetween(u.id, "2026-11-09", "2026-11-09"))[0].time, "17:00");
      await store.close();
    }

    // Ответ на вопрос и правило полок.
    overridePrompts({ "answer.rules": "ОТВЕЧАЙ-ПО-ЗАПИСЯМ {{shelf_rule}}на {{today}}", "answer.shelf_rule": "ПРО-ПОЛКИ." });
    {
      const { store, calls, say } = await setup([{ question: "что посмотреть?", shelves: ["film"] }, "Пусто."]);
      await say("Что посмотреть?", "2");
      const sys = sysOf(calls.find((x) => x.kind === "answer")!);
      assert.ok(sys.includes("\nОТВЕЧАЙ-ПО-ЗАПИСЯМ ПРО-ПОЛКИ. на 2026-11-08\n\nЗаметки «на потом»:"), sys.slice(-200));
      await store.close();
    }
    {
      const { store, calls, say } = await setup([{ question: "как я спал?", lookup: { from: "2026-11-05", to: "2026-11-08" } }, "Не знаю."]);
      await say("Как я спал?", "3");
      const sys = sysOf(calls.find((x) => x.kind === "answer")!);
      assert.ok(sys.includes("\nОТВЕЧАЙ-ПО-ЗАПИСЯМ на 2026-11-08\n\n") && !sys.includes("ПРО-ПОЛКИ"), "правило полок — без вопроса про полки");
      await store.close();
    }

    // Разговор: подписи даты и памяти.
    overridePrompts({ "chat.system": "ДАТА {{today}}; ПАМЯТЬ:\n{{memory}}" });
    {
      const { store, calls, say } = await setup([{ summary: "", talk: true, reply: "Привет!" }, "Привет!"]);
      await say("как дела?", "4");
      const sys = sysOf(calls.find((x) => x.kind === "chat")!);
      assert.ok(sys.endsWith(`${prompt("chat.rules")}\nДАТА 2026-11-08; ПАМЯТЬ:\nпочти ничего`), sys.slice(-200));
      await store.close();
    }
  } finally {
    overridePrompts();
  }
});
