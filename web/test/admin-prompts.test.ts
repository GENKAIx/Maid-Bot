import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ADMIN_ACTIONS, ADMIN_GROUPS, ADMIN_LIVE_STAGE, ADMIN_SECTIONS, adminNavGroups, adminSection, promptError, promptIdOf, type PromptCardData, type PromptsData } from "../src/admin.ts";
import { PromptCardPage, PromptsPage } from "../src/screens/AdminPrompts.tsx";
import { checkPrompt, PROMPTS, type PromptSpec } from "../../server/src/prompts.ts";

// Промпты (27.11.2026): раздел в своей категории сразу после «ИИ», подписи журнала, ключ из адреса, проверка текста как на сервере
// и рендер списка и карточки по готовым данным (без сети).

const noop = () => {};

test("промпты: раздел в категории «Промпты» сразу после «ИИ», живой, с подписями действий журнала", () => {
  assert.equal(adminSection("prompts"), "prompts");
  const s = ADMIN_SECTIONS.find((x) => x.id === "prompts")!;
  assert.equal(s.group, "Промпты");
  assert.equal(s.icon, "adm-prompt");
  assert.ok(s.stage <= ADMIN_LIVE_STAGE);
  assert.equal(ADMIN_GROUPS.indexOf("Промпты"), ADMIN_GROUPS.indexOf("ИИ") + 1);
  assert.deepEqual(adminNavGroups().find((g) => g.group === "Промпты")!.items.map((x) => x.id), ["prompts"]);
  assert.equal(ADMIN_ACTIONS.prompt_save, "изменил промпт");
  assert.equal(ADMIN_ACTIONS.prompt_select, "выбрал версию промпта");
});

test("промпты: ключ из адреса /admin/prompts/<id> — как регулярка ручки на сервере", () => {
  assert.equal(promptIdOf("/admin/prompts/parse.rules"), "parse.rules");
  assert.equal(promptIdOf("/admin/prompts/parse.picture.one/"), "parse.picture.one");
  assert.equal(promptIdOf("/admin/prompts/common.json_retry"), "common.json_retry");
  assert.equal(promptIdOf("/admin/prompts"), null);
  assert.equal(promptIdOf("/admin/prompts/"), null);
  assert.equal(promptIdOf("/admin/prompts/Parse"), null, "с большой буквы — нет");
  assert.equal(promptIdOf("/admin/prompts/a"), null, "слишком короткий");
  assert.equal(promptIdOf("/admin/prompts/<b>"), null);
  assert.equal(promptIdOf("/admin/account/5"), null);
  for (const p of PROMPTS) assert.equal(promptIdOf(`/admin/prompts/${p.id}`), p.id, `ключ ${p.id} открывается по адресу`);
});

// Проверка на сайте — копия серверной: на каждом промпте реестра и на наборе образцов ответ тот же самый.
const asCard = (s: PromptSpec) => ({ vars: [...s.vars], required: [...s.required], max: s.max, must_contain: [...(s.mustContain ?? [])], apart: [...(s.apart ?? [])] });

test("промпты: promptError на сайте отвечает так же, как checkPrompt на сервере", () => {
  const spec: PromptSpec = { id: "x.test", section: "Картинки", title: "т", hint: "т", vars: ["name", "prompt"], required: ["prompt"], max: 40, def: "{{prompt}}", mustContain: ["JSON"] };
  const samples: [unknown, string | null][] = [
    ["JSON {{prompt}}", null],
    ["JSON {{prompt}} и {{name}}\n\tтаб", null],
    ["", "текст пустой"],
    ["   \n ", "текст пустой"],
    [42, "текст пустой"],
    [null, "текст пустой"],
    ["JSON {{prompt}}" + "я".repeat(40), "текст длиннее 40 знаков"],
    ["JSON {{prompt}}\u0007", "в тексте служебные знаки (можно только перенос строки и табуляцию)"],
    ["JSON {{prompt}}\r", "в тексте служебные знаки (можно только перенос строки и табуляцию)"],
    ["JSON {{prompt}}\u007f", "в тексте служебные знаки (можно только перенос строки и табуляцию)"],
    ["JSON {{prompt}} {{voice}}", "незнакомая подстановка {{voice}} (можно: {{name}}, {{prompt}})"],
    ["JSON {{prompt}} {{ name }}", "незнакомая подстановка {{ name }} (можно: {{name}}, {{prompt}})"],
    ["JSON {{name}}", "нужна подстановка {{prompt}}"],
    ["json {{prompt}}", "в тексте должно остаться «JSON»"],
  ];
  for (const [body, want] of samples) {
    assert.equal(checkPrompt(spec, body), want, `сервер: ${JSON.stringify(body)}`);
    assert.equal(promptError(asCard(spec), body), want, `сайт: ${JSON.stringify(body)}`);
  }
  // apart: подстановки — в разных абзацах (profile.traits).
  const sep: PromptSpec = { ...spec, apart: ["name", "prompt"] };
  for (const [body, want] of [
    ["JSON {{prompt}}\n{{name}}", "{{name}} и {{prompt}} — в разных абзацах (между ними пустая строка)"],
    ["JSON {{prompt}}\n\n{{name}}", null],
  ] as const) {
    assert.equal(checkPrompt(sep, body), want, `сервер: ${JSON.stringify(body)}`);
    assert.equal(promptError(asCard(sep), body), want, `сайт: ${JSON.stringify(body)}`);
  }
  const bare: PromptSpec = { ...spec, vars: [], required: [], mustContain: undefined };
  assert.equal(promptError(asCard(bare), "{{x}}"), checkPrompt(bare, "{{x}}"));
  assert.equal(promptError(asCard(bare), "{{x}}"), "незнакомая подстановка {{x}} (здесь подстановок нет)");
  // Реестр целиком: текст «как в коде», он же без обязательной подстановки, без mustContain и с лишней подстановкой.
  for (const p of PROMPTS) {
    const c = asCard(p);
    const variants = [p.def, p.def + " {{zzz}}", p.def.slice(0, 5), p.def.split("\n\n").join("\n"),...p.required.map((r) => p.def.split(`{{${r}}}`).join("")), ...(p.mustContain ?? []).map((t) => p.def.split(t).join(""))];
    for (const v of variants) assert.equal(promptError(c, v), checkPrompt(p, v), `${p.id}: ${v.slice(0, 40)}`);
  }
});

const LIST: PromptsData = {
  reload_ms: 60_000,
  sections: [
    { title: "Разбор сообщений", prompts: [
      { id: "parse.rules", title: "Правила разбора", hint: "что куда записывать", version: 3, stored_version: 3, broken: false, versions: 3, changed_at: "2026-11-27T10:00:00Z", changed_by: "#1", differs_from_default: true, length: 9900 },
      { id: "parse.header", title: "Заголовок с датами", hint: "сегодня и вчера", version: 0, stored_version: 0, broken: false, versions: 0, changed_at: null, changed_by: null, differs_from_default: false, length: 120 },
    ] },
    { title: "Картинки", prompts: [
      { id: "draw.wrap", title: "Запрос картинки", hint: "<script>alert(1)</script>", version: 0, stored_version: 2, broken: true, versions: 2, changed_at: "2026-11-26T09:00:00Z", changed_by: "#7", differs_from_default: false, length: 40 },
    ] },
  ],
};

const CARD: PromptCardData = {
  id: "draw.wrap", section: "Картинки", title: "Запрос картинки", hint: "оборачивает описание картинки",
  vars: ["prompt"], required: ["prompt"], var_hints: { prompt: "описание картинки от человека" }, must_contain: [], apart: [],
  readonly: "параметры модели задаёт код", max: 2000,
  def: "Draw a single square picture: {{prompt}}", version: 2, stored_version: 2, broken: false, body: "Draw one square picture: {{prompt}}",
  preview: "Draw one square picture: a ginger cat",
  versions: [
    { version: 2, body: "Draw one square picture: {{prompt}}", created_at: "2026-11-27T10:00:00Z", created_by: "#1", reason: "проще" },
    { version: 1, body: "Square picture: {{prompt}}", created_at: "2026-11-26T10:00:00Z", created_by: "#1", reason: "проба" },
  ],
  reload_ms: 60_000,
};

test("промпты: список по разделам — название, версия или «как в коде», число версий, дата и #id, «Открыть»; текстов нет", () => {
  const html = renderToStaticMarkup(createElement(PromptsPage, { data: LIST, onOpen: noop }));
  for (const s of ["Разбор сообщений", "Картинки", "Правила разбора", "v3", "как в коде", "#1", "#7", "27.11.2026", "Открыть", 'href="/admin/prompts/parse.rules"', "течение"]) {
    assert.ok(html.includes(s), `в списке нет «${s}»`);
  }
  assert.equal(html.split('class="adm-h2"').length - 1, 2, "заголовок у каждого раздела");
  assert.ok(html.indexOf("Разбор сообщений") < html.indexOf("Картинки"), "разделы по порядку");
  assert.equal(html.split("Открыть").length - 1, 3);
  assert.ok(!html.includes("<script>") && html.includes("&lt;script&gt;"), "подсказка экранируется");
});

test("промпты: карточка — текст сейчас, подстановки, предпросмотр, версии новые сверху и «как в коде (v0)» с кнопкой выбора", () => {
  const html = renderToStaticMarkup(createElement(PromptCardPage, { card: CARD, onBack: noop, onChanged: noop, note: null, setNote: noop }));
  for (const s of ["← Все промпты", "Запрос картинки", "draw.wrap", "оборачивает описание картинки", "{{prompt}}", "описание картинки от человека", "обязательна",
    "параметры модели задаёт код", "Текст сейчас", "<pre class=\"adm-pr-text\">Draw one square picture: {{prompt}}</pre>", "Изменить", "Предпросмотр целиком",
    "Draw one square picture: a ginger cat", "Версии", "проще", "проба", "как в коде (v0)", "Draw a single square picture: {{prompt}}", "действует", "Причина"]) {
    assert.ok(html.includes(s), `в карточке нет «${s}»`);
  }
  assert.ok(html.indexOf(">v2<") < html.indexOf(">v1<") && html.indexOf(">v1<") < html.indexOf("как в коде (v0)</td>"), "новые сверху, v0 — последней строкой");
  assert.equal(html.split("Выбрать эту версию").length - 1, 3, "кнопка у каждой версии и у v0");
  assert.equal(html.split("disabled=\"\"").length - 1, 1, "выключена только у действующей");
  assert.ok(html.indexOf("Предпросмотр целиком") > html.indexOf("<details"), "предпросмотр свёрнут");
  assert.ok(!html.includes("<textarea"), "до «Изменить» поля правки нет");
  // Без своей версии действует v0: выключена её кнопка.
  const v0 = renderToStaticMarkup(createElement(PromptCardPage, { card: { ...CARD, version: 0, stored_version: 0, body: CARD.def, versions: [] }, onBack: noop, onChanged: noop, note: null, setNote: noop }));
  assert.ok(v0.includes("Действует: <span class=\"adm-al-st \">как в коде (v0)</span>"));
  assert.equal(v0.split("Выбрать эту версию").length - 1, 1);
  assert.equal(v0.split("disabled=\"\"").length - 1, 1);
  // Итог действия виден в карточке.
  const done = renderToStaticMarkup(createElement(PromptCardPage, { card: CARD, onBack: noop, onChanged: noop, note: { ok: true, text: "Сохранено. Записано в журнал админа." }, setNote: noop }));
  assert.ok(done.includes("Записано в журнал админа."));
  // Ошибка выбора видна и у таблицы версий (кнопки ниже итога в «Текст сейчас»).
  const fail = renderToStaticMarkup(createElement(PromptCardPage, { card: CARD, onBack: noop, onChanged: noop, note: { ok: false, text: "Напишите причину — хотя бы 3 знака." }, setNote: noop }));
  assert.equal(fail.split("Напишите причину — хотя бы 3 знака.").length - 1, 2, "и наверху, и у версий");
  assert.ok(fail.lastIndexOf("Напишите причину") > fail.indexOf(">Версии<"));
  assert.equal(done.split("Записано в журнал админа.").length - 1, 1, "удачный итог — один раз");
});

test("промпты: записанная версия не подходит к коду — предупреждение, кнопка «как в коде (v0)» включена, у записанной — выключена", () => {
  const card: PromptCardData = { ...CARD, version: 0, stored_version: 2, broken: true, body: CARD.def };
  const html = renderToStaticMarkup(createElement(PromptCardPage, { card, onBack: noop, onChanged: noop, note: null, setNote: noop }));
  assert.ok(html.includes("Записана версия v2, но она не подходит к нынешнему коду"), "предупреждение");
  assert.ok(html.includes("Действует: <span class=\"adm-al-st \">как в коде (v0)</span>"));
  const rows = html.split("<tr>").slice(2);
  assert.equal(rows.length, 3);
  assert.ok(rows[0].includes(">v2<") && rows[0].includes('disabled=""'), "записанная v2 — выключена");
  assert.ok(!rows[1].includes('disabled=""') && !rows[2].includes('disabled=""'), "v1 и v0 — можно выбрать");
  const list = renderToStaticMarkup(createElement(PromptsPage, { data: LIST, onOpen: noop }));
  assert.ok(list.includes("записана v2, не подходит к коду"), "и в списке");
});

test("промпты: пока открыта правка, версии не выбрать — черновик не пропадёт", () => {
  const html = renderToStaticMarkup(createElement(PromptCardPage, { card: CARD, onBack: noop, onChanged: noop, note: null, setNote: noop, editing: true }));
  const table = html.slice(html.indexOf(">Версии<"));
  assert.equal(table.split("Выбрать эту версию").length - 1, 3);
  assert.equal(table.split('disabled=""').length - 1, 3, "все кнопки выбора выключены");
  assert.ok(table.includes("сначала сохраните или отмените правку"));
});

test("промпты: правка — поле с действующим текстом, проверка сразу, причина и «Сохранить как новую версию»", () => {
  const html = renderToStaticMarkup(createElement(PromptCardPage, { card: CARD, onBack: noop, onChanged: noop, note: null, setNote: noop, editing: true }));
  assert.ok(html.includes("<textarea") && html.includes("adm-tf-txt") && html.includes(">Draw one square picture: {{prompt}}</textarea>"));
  for (const s of ["Сохранить как новую версию", "Текст тот же, что действует.", "Причина", "Отмена"]) assert.ok(html.includes(s), `нет «${s}»`);
  assert.equal(promptError(CARD, "Draw: {{voice}}"), "незнакомая подстановка {{voice}} (можно: {{prompt}})");
  assert.equal(promptError(CARD, "Draw a picture"), "нужна подстановка {{prompt}}");
});

test("промпты: текст и причина экранируются — HTML из промпта не становится разметкой", () => {
  const evil = "<img src=x onerror=alert(1)> {{prompt}}";
  const card: PromptCardData = {
    ...CARD, body: evil, preview: evil, def: "<b>def</b> {{prompt}}",
    versions: [{ version: 2, body: evil, created_at: "2026-11-27T10:00:00Z", created_by: "#1", reason: "<script>alert(2)</script>" }],
  };
  for (const editing of [false, true]) {
    const html = renderToStaticMarkup(createElement(PromptCardPage, { card, onBack: noop, onChanged: noop, note: null, setNote: noop, editing }));
    assert.ok(!html.includes("<img") && html.includes("&lt;img src=x onerror=alert(1)&gt;"), "текст экранирован");
    assert.ok(!html.includes("<script>") && html.includes("&lt;script&gt;alert(2)&lt;/script&gt;"), "причина экранирована");
    assert.ok(!html.includes("<b>def</b>") && html.includes("&lt;b&gt;def&lt;/b&gt;"), "текст «как в коде» экранирован");
  }
});

test("промпты: высота поля правки по тексту", async () => {
  const { editRows } = await import("../src/screens/AdminPrompts.tsx");
  assert.equal(editRows("Сегодня {{today}}\nВчера {{yesterday}}"), 4, "короткий — 4 строки");
  assert.equal(editRows("x".repeat(20000)), 18, "длинный — не больше 18");
});
