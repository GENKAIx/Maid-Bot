import { PGlite } from "@electric-sql/pglite";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApi } from "../src/api.ts";
import { hashPassword } from "../src/auth.ts";
import { config } from "../src/config.ts";
import { Store } from "../src/db.ts";
import { callOpenRouterDraw } from "../src/draw.ts";
import { PgDriver } from "../src/driver.ts";
import type { ChatMessage, LlmCall } from "../src/llm.ts";
import { buildPrompt, promptHeader } from "../src/parse.ts";
import { Pipeline, TALK_RULES } from "../src/pipeline.ts";
import {
  checkPrompt, fill, loadPrompts, overridePrompts, prompt, PROMPT_RELOAD_MS, PROMPT_SECTIONS, promptCard, PROMPTS, promptsView, refreshPrompts,
  savePrompt, selectPrompt, type PromptSpec,
} from "../src/prompts.ts";
import { zonedToUtc } from "../src/time.ts";

// Промпты (prompts.ts, шаг 40): версии текстов для ИИ, правка и выбор версии из админки, кэш процесса раз в минуту. Postgres — PGlite.

const NOW = new Date("2026-11-27T12:00:00Z");
const sqlite = () => Store.open(":memory:");
async function postgres() {
  const pg = new PGlite();
  return Store.over(new PgDriver(pg, (fn) => pg.transaction((tx) => fn(tx)), () => pg.close()));
}
const BASES: [string, () => Promise<Store>][] = [["sqlite", sqlite], ["postgres", postgres]];

test("реестр: id разные, разделы из PROMPT_SECTIONS, каждый текст «как в коде» проходит свою проверку", () => {
  assert.equal(new Set(PROMPTS.map((s) => s.id)).size, PROMPTS.length);
  for (const s of PROMPTS) {
    assert.match(s.id, /^[a-z][a-z0-9._-]{1,60}$/, s.id);
    assert.ok((PROMPT_SECTIONS as readonly string[]).includes(s.section), s.id);
    assert.ok(s.required.every((r) => s.vars.includes(r)), `${s.id}: required — из vars`);
    assert.equal(checkPrompt(s, s.def), null, s.id);
  }
});

test("по умолчанию prompt() — ровно прежние строки кода", () => {
  overridePrompts();
  assert.equal(prompt("chat.rules"), TALK_RULES);
  assert.ok(TALK_RULES.startsWith("Это разговор: ничего не записывай") && TALK_RULES.endsWith("1–4 предложения, без списков."));
  assert.equal(prompt("draw.wrap", { prompt: "a cat" }), "Draw a single square picture: a cat");
  // Подстановка за один проход: «{{prompt}}» и «$&» в описании не раскрываются.
  assert.equal(prompt("draw.wrap", { prompt: "{{prompt}} $& $1" }), "Draw a single square picture: {{prompt}} $& $1");
  assert.equal(fill("{{a}}-{{b}}", { a: "1" }), "1-{{b}}", "незнакомое — как есть");
  assert.throws(() => prompt("nope.x"), /нет промпта/);
});

test("checkPrompt: длина, подстановки, обязательные строки, служебные знаки", () => {
  const spec: PromptSpec = { id: "t.x", section: "Разбор сообщений", title: "t", hint: "", vars: ["voice", "today"], required: ["voice"], max: 40, def: "{{voice}} JSON", mustContain: ["JSON"] };
  assert.equal(checkPrompt(spec, "{{voice}} ответь JSON"), null);
  assert.equal(checkPrompt(spec, "{{voice}}\tJSON\n{{today}}"), null, "перенос строки и табуляция можно");
  assert.match(checkPrompt(spec, "")!, /пустой/);
  assert.match(checkPrompt(spec, "   ")!, /пустой/);
  assert.match(checkPrompt(spec, 5)!, /пустой/);
  assert.match(checkPrompt(spec, "{{voice}} JSON" + "x".repeat(40))!, /длиннее 40/);
  assert.match(checkPrompt(spec, "{{voice}} {{name}} JSON")!, /незнакомая подстановка \{\{name\}\}/);
  assert.match(checkPrompt(spec, "{{ voice }} JSON")!, /незнакомая подстановка/);
  assert.match(checkPrompt(spec, "ответь JSON")!, /нужна подстановка \{\{voice\}\}/);
  assert.match(checkPrompt(spec, "{{voice}} ответь")!, /должно остаться «JSON»/);
  assert.match(checkPrompt(spec, "{{voice}} JSON\u0007")!, /служебные знаки/);
  assert.match(checkPrompt(spec, "{{voice}}\r\nJSON")!, /служебные знаки/);
});

for (const [name, open] of BASES) {
  test(`${name}: шаг 40 — версии промптов в базе`, async () => {
    const store = await open();
    try {
      assert.equal(await store.kvGet("schema_version"), "42");
      assert.deepEqual(await store.promptActive(), []);
      assert.equal(await store.addPromptVersion("chat.rules", "первый", NOW.toISOString(), 7, "проба"), 1);
      assert.equal(await store.addPromptVersion("chat.rules", "второй", NOW.toISOString(), 8, "x".repeat(400)), 2);
      assert.equal(await store.addPromptVersion("draw.wrap", "Draw {{prompt}}", NOW.toISOString(), 7, "проба"), 1, "номера — у каждого промпта свои");
      assert.deepEqual((await store.promptActive()).map((r) => [r.prompt_id, r.version, r.updated_by]), [["chat.rules", 2, 8], ["draw.wrap", 1, 7]]);
      assert.deepEqual((await store.promptVersions("chat.rules")).map((v) => [v.version, v.body, v.created_by, v.reason.length]), [[2, "второй", 8, 300], [1, "первый", 7, 5]]);
      assert.equal((await store.promptVersion("chat.rules", 1))!.body, "первый");
      assert.equal(await store.promptVersion("chat.rules", 3), undefined);
      await store.setPromptActive("chat.rules", 0, NOW.toISOString(), 9);
      assert.deepEqual((await store.promptActive())[0], { prompt_id: "chat.rules", version: 0, updated_at: NOW.toISOString(), updated_by: 9 });
      assert.deepEqual([...(await store.promptVersionCounts())].sort(), [["chat.rules", 2], ["draw.wrap", 1]]);
    } finally {
      await store.close();
    }
  });

  test(`${name}: сохранить — новая версия действует сразу и через минуту на другом процессе; выбор версии и «как в коде»`, async () => {
    const store = await open();
    try {
      overridePrompts();
      await loadPrompts(store, NOW.getTime());
      const v1 = "Это разговор. Отвечай коротко и по делу, 1–2 предложения.";
      await assert.rejects(savePrompt(store, 1, { id: "chat.rules", body: v1 }), /причину/);
      await assert.rejects(savePrompt(store, 1, { id: "chat.rules", body: v1, reason: "ок" }), /причину/);
      await assert.rejects(savePrompt(store, 1, { id: "nope.x", body: v1, reason: "проверка" }), (e: { status?: number }) => e.status === 404);
      await assert.rejects(savePrompt(store, 1, { id: "chat.rules", body: TALK_RULES, reason: "проверка" }), (e: { status?: number; message: string }) => e.status === 400 && /ничего не меняется/.test(e.message));
      await assert.rejects(savePrompt(store, 1, { id: "chat.rules", body: "{{voice}} поговори", reason: "проверка" }), (e: { status?: number; message: string }) => e.status === 400 && /незнакомая подстановка/.test(e.message));
      await assert.rejects(savePrompt(store, 1, { id: "draw.wrap", body: "Draw a picture", reason: "проверка" }), (e: { status?: number; message: string }) => e.status === 400 && /нужна подстановка \{\{prompt\}\}/.test(e.message));
      await assert.rejects(savePrompt(store, 1, { id: "chat.rules", body: "", reason: "проверка" }), /пустой/);

      const card = await savePrompt(store, 1, { id: "chat.rules", body: v1, reason: "короче ответы" }, NOW);
      assert.deepEqual([card.version, card.body, card.versions.map((v) => v.version)], [1, v1, [1]]);
      assert.equal(prompt("chat.rules"), v1, "сразу на этом процессе");
      await assert.rejects(savePrompt(store, 1, { id: "chat.rules", body: v1, reason: "ещё раз" }), /ничего не меняется/);
      const v2 = v1 + " Можно пошутить.";
      assert.equal((await savePrompt(store, 2, { id: "chat.rules", body: v2, reason: "пошутить" }, NOW)).version, 2);
      await savePrompt(store, 1, { id: "draw.wrap", body: "Draw one square picture, bright colors: {{prompt}}", reason: "ярче" }, NOW);
      assert.equal(prompt("draw.wrap", { prompt: "a cat" }), "Draw one square picture, bright colors: a cat");

      // Журнал: id и номера версий, причина, без текста.
      const log = await store.adminLog(10);
      assert.deepEqual(log.slice(0, 3).map((l) => [l.action, l.detail, l.reason, l.user_id]), [
        ["prompt_save", "draw.wrap v0→v1", "ярче", 1], ["prompt_save", "chat.rules v1→v2", "пошутить", 2], ["prompt_save", "chat.rules v0→v1", "короче ответы", 1],
      ]);
      assert.ok(!JSON.stringify(log).includes("Отвечай коротко") && !JSON.stringify(log).includes("bright"), "текст промпта в журнал не попадает");

      // «Другой процесс»: в памяти — как до правки; перечитывает не раньше чем через минуту.
      overridePrompts();
      assert.equal(prompt("chat.rules"), TALK_RULES);
      assert.equal(await refreshPrompts(store, NOW.getTime() + 1000), false, "минута не прошла");
      assert.equal(prompt("chat.rules"), TALK_RULES);
      assert.equal(await refreshPrompts(store, NOW.getTime() + PROMPT_RELOAD_MS), true);
      assert.equal(prompt("chat.rules"), v2, "перечитал из базы");

      // Выбор версии: старая, «как в коде», снова своя.
      await assert.rejects(selectPrompt(store, 1, { id: "chat.rules", version: 1 }), /причину/);
      await assert.rejects(selectPrompt(store, 1, { id: "chat.rules", version: 9, reason: "проверка" }), (e: { status?: number }) => e.status === 404);
      await assert.rejects(selectPrompt(store, 1, { id: "chat.rules", version: -1, reason: "проверка" }), /номер версии/);
      await assert.rejects(selectPrompt(store, 1, { id: "chat.rules", version: "1", reason: "проверка" }), /номер версии/);
      await assert.rejects(selectPrompt(store, 1, { id: "chat.rules", version: 2, reason: "проверка" }), /уже действует/);
      assert.equal((await selectPrompt(store, 1, { id: "chat.rules", version: 1, reason: "вторая хуже" }, NOW)).body, v1);
      assert.equal(prompt("chat.rules"), v1);
      const back = await selectPrompt(store, 3, { id: "chat.rules", version: 0, reason: "как было" }, NOW);
      assert.deepEqual([back.version, back.body, back.versions.length], [0, TALK_RULES, 2], "версии остаются");
      assert.equal(prompt("chat.rules"), TALK_RULES, "v0 — текст из кода");
      await assert.rejects(selectPrompt(store, 3, { id: "chat.rules", version: 0, reason: "ещё" }), /уже действует/);
      assert.deepEqual((await store.adminLog(2)).map((l) => [l.action, l.detail]), [["prompt_select", "chat.rules v1→v0"], ["prompt_select", "chat.rules v2→v1"]]);

      // Список — без текстов; карточка — тексты, версии новые сверху, предпросмотр целиком.
      const view = await promptsView(store);
      assert.equal(view.reload_ms, PROMPT_RELOAD_MS);
      // Разделы — по порядку PROMPT_SECTIONS, пустых нет (промпты подключаются по группам — список не зашит).
      const titles = view.sections.map((s) => s.title);
      assert.deepEqual(titles, PROMPT_SECTIONS.filter((t) => titles.includes(t)));
      assert.ok(titles.includes("Вопросы и разговор") && titles.includes("Картинки") && view.sections.every((s) => s.prompts.length));
      const row = (id: string) => view.sections.flatMap((s) => s.prompts).find((x) => x.id === id)!;
      const chat = row("chat.rules");
      assert.deepEqual([chat.id, chat.version, chat.versions, chat.changed_by, chat.differs_from_default, chat.length], ["chat.rules", 0, 2, "#3", false, TALK_RULES.length]);
      const draw = row("draw.wrap");
      assert.deepEqual([draw.version, draw.differs_from_default], [1, true]);
      const json = JSON.stringify(view);
      assert.ok(!json.includes(TALK_RULES) && !json.includes("bright") && !/"body"/.test(json), "в списке нет текстов");
      const dc = await promptCard(store, "draw.wrap");
      assert.equal(dc.def, "Draw a single square picture: {{prompt}}");
      assert.deepEqual([dc.vars, dc.required, Object.keys(dc.var_hints)], [["prompt"], ["prompt"], ["prompt"]]);
      assert.match(dc.preview, /^Draw one square picture, bright colors: a ginger cat/, "предпросмотр с примером подстановки");
      assert.match((await promptCard(store, "chat.rules")).preview, /^‹голос характера›\nЭто разговор: [^]*Что знаешь о собеседнике/, "и с тем, что строит код");
      await assert.rejects(promptCard(store, "nope.x"), (e: { status?: number }) => e.status === 404);
    } finally {
      overridePrompts();
      await store.close();
    }
  });
}

test("версия, которую не пропускает нынешняя проверка, — текст из кода и выбрать её нельзя", async () => {
  const store = await sqlite();
  try {
    await store.addPromptVersion("draw.wrap", "без подстановки", NOW.toISOString(), 1, "в обход проверки");
    await loadPrompts(store, NOW.getTime());
    assert.equal(prompt("draw.wrap", { prompt: "a cat" }), "Draw a single square picture: a cat");
    await store.setPromptActive("draw.wrap", 0, NOW.toISOString(), 1);
    await assert.rejects(selectPrompt(store, 1, { id: "draw.wrap", version: 1, reason: "проверка" }), /не подходит к нынешнему коду/);
  } finally {
    overridePrompts();
    await store.close();
  }
});

test("записанная действующая версия не подходит к коду: админка видит это, «как в коде» выбирается, журнал — с записанным номером", async () => {
  const store = await sqlite();
  try {
    await store.addPromptVersion("draw.wrap", "без подстановки", NOW.toISOString(), 1, "в обход проверки");
    await loadPrompts(store, NOW.getTime());
    const row = (await promptsView(store)).sections.flatMap((x) => x.prompts).find((p) => p.id === "draw.wrap")!;
    assert.deepEqual([row.version, row.stored_version, row.broken, row.differs_from_default], [0, 1, true, false]);
    const card = await promptCard(store, "draw.wrap");
    assert.deepEqual([card.version, card.stored_version, card.broken], [0, 1, true]);
    const back = await selectPrompt(store, 2, { id: "draw.wrap", version: 0, reason: "закрепить код" }, NOW);
    assert.deepEqual([back.version, back.stored_version, back.broken], [0, 0, false]);
    assert.deepEqual((await store.promptActive()).map((r) => [r.prompt_id, r.version]), [["draw.wrap", 0]]);
    await assert.rejects(selectPrompt(store, 2, { id: "draw.wrap", version: 0, reason: "ещё" }), /уже действует/);
    // Снова записанная негодная v1 — сохранение того же текста, что «как в коде», не «ничего не меняется»: оно закрепляет код новой версией.
    await store.setPromptActive("draw.wrap", 1, NOW.toISOString(), 1);
    const saved = await savePrompt(store, 2, { id: "draw.wrap", body: "Draw a single square picture: {{prompt}}", reason: "как в коде" }, NOW);
    assert.deepEqual([saved.version, saved.broken], [2, false]);
    const log = await store.adminLog(10);
    assert.deepEqual(log.slice(0, 2).map((l) => [l.action, l.detail]), [["prompt_save", "draw.wrap v1→v2"], ["prompt_select", "draw.wrap v1→v0"]]);
  } finally {
    overridePrompts();
    await store.close();
  }
});

test("причина со служебными знаками и знаками смены направления — 400", async () => {
  const store = await sqlite();
  try {
    for (const reason of ["a\u0000bc", "abc\u202e", "ab\nc", "abc\u2066"]) {
      await assert.rejects(savePrompt(store, 1, { id: "draw.wrap", body: "Draw: {{prompt}}", reason }), (e: { status?: number; message: string }) => e.status === 400 && /служебные знаки/.test(e.message), JSON.stringify(reason));
      await assert.rejects(selectPrompt(store, 1, { id: "draw.wrap", version: 0, reason }), /служебные знаки/);
    }
    assert.equal((await store.promptVersions("draw.wrap")).length, 0);
  } finally {
    overridePrompts();
    await store.close();
  }
});

test("сохранение столкнулось с версией другой копии сервера (UNIQUE) — 409 с понятной причиной, а не 500", async () => {
  const store = await sqlite();
  const orig = store.addPromptVersion.bind(store);
  try {
    store.addPromptVersion = async () => { throw new Error("UNIQUE constraint failed: prompt_versions.prompt_id, prompt_versions.version"); };
    await assert.rejects(savePrompt(store, 1, { id: "draw.wrap", body: "Draw: {{prompt}}", reason: "проверка" }), (e: { status?: number; message: string }) => e.status === 409 && /только что изменили/.test(e.message));
    store.addPromptVersion = async () => { throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" }); };
    await assert.rejects(savePrompt(store, 1, { id: "draw.wrap", body: "Draw: {{prompt}}", reason: "проверка" }), (e: { status?: number }) => e.status === 409);
    store.addPromptVersion = async () => { throw new Error("disk full"); };
    await assert.rejects(savePrompt(store, 1, { id: "draw.wrap", body: "Draw: {{prompt}}", reason: "проверка" }), (e: { status?: number; message: string }) => e.status === undefined && e.message === "disk full");
  } finally {
    store.addPromptVersion = orig;
    overridePrompts();
    await store.close();
  }
});

test("карточка промпта открывается прямой ссылкой: /admin/prompts/<ключ с точкой> — index.html, файл с точкой вне админки — 404", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maid-prompts-"));
  const html = "<!doctype html><title>maid</title>";
  fs.writeFileSync(path.join(dir, "index.html"), html);
  const store = await Store.open(":memory:");
  const server = createApi({ store, pipeline: new Pipeline(store, async () => "{}"), webDir: dir }).listen(0);
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const p of ["/admin/prompts/parse.rules", "/admin/prompts/persona.address_name", "/admin/prompts"]) {
      const r = await fetch(base + p);
      assert.equal(r.status, 200, p);
      assert.match(String(r.headers.get("content-type")), /text\/html/, p);
      assert.equal(await r.text(), html, p);
    }
    assert.equal((await fetch(base + "/missing.js")).status, 404, "нет файла с расширением — не страница");
  } finally {
    server.close();
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("правка доходит до модели: разговор и картинка OpenRouter", async () => {
  const store = await sqlite();
  const savedD = { ...config.drawing };
  const realFetch = globalThis.fetch;
  try {
    overridePrompts();
    await loadPrompts(store);
    await savePrompt(store, 1, { id: "chat.rules", body: "Это разговор. Говори как пират.", reason: "проба" });
    await savePrompt(store, 1, { id: "draw.wrap", body: "Pixel art: {{prompt}}", reason: "проба" });
    const TZ = "Europe/Moscow";
    const u = await store.ensureUser("100", "Тест", TZ);
    const calls: ChatMessage[][] = [];
    const llm: LlmCall = async (messages, opts) => {
      calls.push(messages);
      return opts?.kind === "parse" ? JSON.stringify({ summary: "", talk: true, reply: "Привет!" }) : "Йо-хо-хо!";
    };
    await new Pipeline(store, llm).handle({ user: u, source: "telegram", sourceId: "1", text: "как дела?", at: zonedToUtc("2026-11-27", "14:30", TZ) });
    const sys = String(calls[1][0].content);
    assert.ok(sys.includes("\nЭто разговор. Говори как пират.\nСегодня 2026-11-27."), sys.slice(0, 400));
    assert.ok(!sys.includes(TALK_RULES));

    Object.assign(config.drawing, { openrouterKey: "k", openrouterModel: "google/img" });
    const sent: unknown[] = [];
    globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ choices: [{ message: { images: [{ image_url: { url: `data:image/png;base64,${Buffer.from("p").toString("base64")}` } }] } }] }), { status: 200 });
    }) as typeof fetch;
    await callOpenRouterDraw("a cat");
    assert.equal((sent[0] as { messages: { content: string }[] }).messages[0].content, "Pixel art: a cat");
  } finally {
    globalThis.fetch = realFetch;
    Object.assign(config.drawing, savedD);
    overridePrompts();
    await store.close();
  }
});

test("разбор: по умолчанию прежние строки; правка правил, «сегодня», пометки картинки и переспроса JSON доходит до модели", async () => {
  overridePrompts();
  // Прежние строки кода (до выноса в prompts.ts), байт в байт.
  assert.equal(promptHeader("2026-11-27", "14:30", "Europe/Moscow"),
    "Сегодня 2026-11-27 (пятница), сейчас 14:30, часовой пояс Europe/Moscow.\nВчера = 2026-11-26, завтра = 2026-11-28, послезавтра = 2026-11-29.");
  assert.equal(prompt("parse.picture.one"), "(К сообщению приложено изображение — разбери его по правилам для изображений. Подпись выше, если есть, важнее картинки.)");
  assert.equal(prompt("parse.picture.many", { n: "3" }),
    "(К сообщению приложено изображений: 3 — разбери каждое по правилам для изображений, одно и то же не записывай дважды. Подпись выше, если есть, важнее картинок.)");
  assert.equal(prompt("common.json_retry"), "Ответь одним JSON-объектом по схеме из инструкции, без текста вокруг.");
  const ctx = { today: "2026-11-27", now: "14:30", tz: "Europe/Moscow", events: [], tasks: [], dates: [], memory: [], habits: [], recent: [] };
  const def = buildPrompt(ctx, "голос");
  assert.ok(def.includes("\n\nПравила:\n- Одно сообщение может содержать много всего сразу"));
  assert.ok(def.includes("- summary: начинается с [14:30], близко к словам пользователя"));
  assert.ok(def.includes("лучше reply «не разобрала сумму».\n\nГолос для reply: голос\n"));
  assert.match(def, /Ответь ОДНИМ JSON-объектом:\n\{\n "date_iso"[\s\S]*"emotion": "[a-z|]+",[\s\S]*\n\}\n\nПравила:/, "схема — из кода");
  // Предпросмотр parse.rules в карточке — системное сообщение целиком, со схемой из кода.
  const s0 = await sqlite();
  try {
    await loadPrompts(s0);
    const card = await promptCard(s0, "parse.rules");
    assert.ok(card.preview.startsWith("Ты разбираешь сообщения пользователя") && card.preview.includes('"emotion": "') && card.preview.includes("[14:30]"), card.preview.slice(0, 200));
  } finally { await s0.close(); }

  const store = await sqlite();
  try {
    await loadPrompts(store);
    await savePrompt(store, 1, { id: "parse.rules", body: "Правила:\n- Пиши всё в дневник. Время — {{now}}.", reason: "проба" });
    await savePrompt(store, 1, { id: "parse.header", body: "Дата {{today}}, время {{now}}, пояс {{tz}}.", reason: "проба" });
    await savePrompt(store, 1, { id: "parse.picture.one", body: "(Тут картинка.)", reason: "проба" });
    await savePrompt(store, 1, { id: "common.json_retry", body: "Только JSON, пожалуйста.", reason: "проба" });
    await assert.rejects(savePrompt(store, 1, { id: "common.json_retry", body: "Только объект.", reason: "проба" }), /должно остаться «JSON»/);
    await assert.rejects(savePrompt(store, 1, { id: "parse.header", body: "Дата {{today}}, время {{now}}.", reason: "проба" }), /нужна подстановка \{\{tz\}\}/);
    const TZ = "Europe/Moscow";
    const u = await store.ensureUser("100", "Тест", TZ);
    const calls: ChatMessage[][] = [];
    let n = 0;
    const llm: LlmCall = async (messages) => {
      calls.push(messages);
      return n++ === 0 ? "Сейчас подумаю…" : JSON.stringify({ summary: "[14:30] фото", reply: "Вижу." });
    };
    const png = { mime: "image/png", data: Buffer.from("p").toString("base64") };
    await new Pipeline(store, llm).handle({ user: u, source: "telegram", sourceId: "1", text: "чек", images: [png], at: zonedToUtc("2026-11-27", "14:30", TZ) });
    const sys = String(calls[0][0].content);
    assert.ok(sys.includes("\nДата 2026-11-27, время 14:30, пояс Europe/Moscow.\n\nОтветь ОДНИМ JSON-объектом:\n{"), sys.slice(0, 300));
    assert.ok(sys.includes("\n}\n\nПравила:\n- Пиши всё в дневник. Время — 14:30.\n\nГолос для reply:"));
    assert.ok(!sys.includes("Одно сообщение может содержать много всего сразу"));
    assert.equal(calls[0].at(-1)!.content, "чек\n(Тут картинка.)");
    // Модель ответила словами — переспрос новым текстом.
    assert.equal(calls[1].at(-1)!.content, "Только JSON, пожалуйста.");
  } finally {
    overridePrompts();
    await store.close();
  }
});

// ——— Ручки админки: тем же путём, что сайт (вход → код из «Telegram» → /api/admin/prompts…).

const OWNER = "1001", FRIEND = "2002";

async function stand() {
  config.allowedChatIds.splice(0, Infinity, OWNER, FRIEND);
  config.adminChatIds.splice(0, Infinity);
  const store = await Store.open(":memory:");
  await store.createUser({ login: "owner", passwordHash: await hashPassword("owner-pass-1"), tz: "Europe/Moscow", chatId: OWNER, name: "Хозяин" });
  await store.createUser({ login: "friend", passwordHash: await hashPassword("friend-pass-1"), tz: "Europe/Moscow", chatId: FRIEND });
  const codes: string[] = [];
  const server = createApi({ store, pipeline: new Pipeline(store, async () => "{}"), adminCode: async (_u: unknown, text: string) => void codes.push(text.match(/\d{6}/)![0]) }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (p: string, token: string, body?: unknown) => {
    const r = await fetch(base + p, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  };
  const login = async (l: string, pw: string) => (await (await fetch(base + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: l, password: pw }) })).json()).token as string;
  return { store, codes, call, login, close: async () => { server.close(); await store.close(); } };
}

test("ручки «Промпты»: не админу 404, без кода 403; список, карточка, сохранить, выбрать; незнакомый id — 404", async () => {
  const s = await stand();
  try {
    overridePrompts();
    await loadPrompts(s.store);
    const owner = await s.login("owner", "owner-pass-1");
    const friend = await s.login("friend", "friend-pass-1");
    for (const p of ["/api/admin/prompts", "/api/admin/prompts/chat.rules"]) {
      assert.equal((await s.call(p, friend)).status, 404, `друг: ${p}`);
      assert.equal((await s.call(p, owner)).status, 403, `без кода: ${p}`);
    }
    assert.equal((await s.call("/api/admin/prompts/chat.rules/save", friend, { body: "x", reason: "проверка" })).status, 404);
    assert.equal((await s.call("/api/admin/prompts/chat.rules/save", owner, { body: "x", reason: "проверка" })).status, 403);
    assert.equal((await s.call("/api/admin/code", owner, {})).status, 200);
    assert.equal((await s.call("/api/admin/confirm", owner, { code: s.codes[0] })).status, 200);

    const list = await s.call("/api/admin/prompts", owner);
    assert.equal(list.status, 200);
    assert.ok(!JSON.stringify(list.body).includes(TALK_RULES), "в списке нет текстов");
    const card = await s.call("/api/admin/prompts/chat.rules", owner);
    assert.deepEqual([card.status, card.body.body, card.body.def, card.body.version], [200, TALK_RULES, TALK_RULES, 0]);
    assert.ok(!("text" in card.body) && !("prompt" in card.body) && !("reply" in card.body), "текст — в поле body");
    for (const p of ["/api/admin/prompts/nope.x", "/api/admin/prompts/Chat.rules", "/api/admin/prompts/chat.rules/undo"]) {
      assert.equal((await s.call(p, owner)).status, 404, p);
    }
    assert.equal((await s.call("/api/admin/prompts/nope.x/save", owner, { body: "x", reason: "проверка" })).status, 404);

    const bad = await s.call("/api/admin/prompts/draw.wrap/save", owner, { body: "Draw {{name}}", reason: "проверка" });
    assert.equal(bad.status, 400);
    assert.match(String(bad.body.error), /незнакомая подстановка/);
    assert.equal((await s.call("/api/admin/prompts/draw.wrap/save", owner, { body: "Draw {{prompt}}" })).status, 400, "без причины");
    const saved = await s.call("/api/admin/prompts/draw.wrap/save", owner, { body: "Draw, please: {{prompt}}", reason: "вежливее", id: "chat.rules" });
    assert.deepEqual([saved.status, saved.body.id, saved.body.version, saved.body.body], [200, "draw.wrap", 1, "Draw, please: {{prompt}}"], "id — из адреса");
    assert.equal(prompt("draw.wrap", { prompt: "a cat" }), "Draw, please: a cat");
    const sel = await s.call("/api/admin/prompts/draw.wrap/select", owner, { version: 0, reason: "как было" });
    assert.deepEqual([sel.status, sel.body.version], [200, 0]);
    assert.equal(prompt("draw.wrap", { prompt: "a cat" }), "Draw a single square picture: a cat");

    const log = (await s.call("/api/admin/log", owner)).body as unknown as { action: string; detail: string }[];
    assert.deepEqual(log.slice(0, 2).map((l) => [l.action, l.detail]), [["prompt_select", "draw.wrap v1→v0"], ["prompt_save", "draw.wrap v0→v1"]]);
    assert.ok(!JSON.stringify(log).includes("please"), "в журнале нет текста");
  } finally {
    overridePrompts();
    await s.close();
  }
});
