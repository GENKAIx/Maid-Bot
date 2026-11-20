// Поправка к ответу в облачке (desktop/renderer/amend.js) без Electron и браузера: правила (amendMerge, amendRoll, amendText —
// выше черты «облачко»), строка на поддельной странице (когда появляется, что держит облачко, id попыток, ответ в сменившееся
// облачко) и подключение в widget.js / widget.html / style.css.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const eq = (a, b, m) => check(JSON.stringify(a) === JSON.stringify(b), `${m}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
const dir = path.join(__dirname, "..", "renderer");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
const amend = read("amend.js"), widget = read("widget.js"), html = read("widget.html"), css = read("style.css");
const MARK = "// --- облачко ---";
check(amend.includes(MARK), "в amend.js нет черты «// --- облачко ---»");
const pure = amend.slice(0, amend.indexOf(MARK));

// --- правила ---
const ctx = {};
vm.createContext(ctx);
try {
  vm.runInContext(`${pure}\nthis.amendKey = amendKey; this.amendMerge = amendMerge; this.amendRoll = amendRoll; this.amendText = amendText;`, ctx);
} catch (e) {
  check(false, `правила amend.js не разобрались: ${e?.message ?? e}`);
}
const { amendKey, amendMerge, amendRoll, amendText } = ctx;

eq(amendKey({ tbl: "events", id: 12 }), "events:12", "ключ карточки");
eq(amendKey(undefined), "", "карточка без ref — без ключа");
eq(amendKey({ tbl: "money", id: 0 }), "money:0", "id 0 — тоже запись");

// amendMerge: без ref — как были и на своих местах; с ref — версия сервера в прежнем порядке; пропала — gone; новая — в конец.
{
  const mark = { kind: "mark", title: "Зарядка ✓" };
  const ev = { kind: "event", title: "Стоматолог", detail: "21 ноября, Сб 15:00", ref: { tbl: "events", id: 1 } };
  const mo = { kind: "money", title: "такси", detail: "−450 RUB — транспорт, такси", ref: { tbl: "money", id: 2 } };
  const edit = { kind: "edit", title: "✎ Созвон → 12:00" };
  const old = [mark, ev, mo, edit];
  const out = amendMerge(old, {
    changes: [
      { kind: "money", title: "такси", detail: "−540 RUB — транспорт, такси", ref: { tbl: "money", id: 2 } },
      { kind: "task", title: "Купить подарок", ref: { tbl: "tasks", id: 7 } },
    ],
    changed: ["money:2"],
  });
  check(out.length === 5, `карточек после поправки: ${out.length}`);
  check(out[0] === mark && out[3] === edit, "карточки без ref не остались как были на своих местах");
  check(out[1].gone === true && out[1].title === "Стоматолог" && out[1].detail === ev.detail, "запись, которой нет в ответе, не помечена ушедшей (или потеряла текст)");
  check(out[2].detail === "−540 RUB — транспорт, такси" && out[2].changed === true && !out[2].gone, "карточка не заменена версией сервера");
  check(out[4].added === true && out[4].title === "Купить подарок" && amendKey(out[4].ref) === "tasks:7", "новая карточка с сервера не встала в конец");
  check(!out[4].changed, "новая карточка помечена изменённой, хотя её нет в changed");
  check(old[2].detail === "−450 RUB — транспорт, такси", "amendMerge испортил старые карточки");

  // Порядок — прежний, даже если сервер прислал по-другому; changed — только у названных.
  const a = { kind: "event", title: "A", ref: { tbl: "events", id: 1 } }, b = { kind: "event", title: "B", ref: { tbl: "events", id: 2 } };
  const ord = amendMerge([a, b], { changes: [{ ...b, title: "B2" }, { ...a, title: "A2" }], changed: ["events:2"] });
  eq(ord.map((c) => c.title), ["A2", "B2"], "порядок карточек");
  eq(ord.map((c) => Boolean(c.changed)), [false, true], "изменённые — только из changed");
  // Ответ не той формы (нет списка карточек) — ничего не трогает.
  const keep = amendMerge([a, b], { text: "?" });
  check(keep.length === 2 && keep[0] === a && keep[1] === b && !keep.some((c) => c.gone), "ответ без changes что-то поменял");
  // Вторая поправка: ушедшая остаётся ушедшей, добавленная в прошлый раз — обычная.
  const twice = amendMerge(out, { changes: [{ kind: "money", title: "такси", detail: "x", ref: { tbl: "money", id: 2 } }, { kind: "task", title: "Купить подарок", ref: { tbl: "tasks", id: 7 } }], changed: [] });
  check(twice[1].gone && !twice[4].added && !twice[4].gone, "вторая поправка перепутала ушедшие и новые");
}

// amendRoll: общее начало и конец, середина — что прокрутить; по целым знакам, слово целиком, цифры — по разрядам.
const roll = (a, b, want, m) => {
  const r = amendRoll(a, b);
  eq(r, want, m);
  check(r.pre + r.oldMid + r.post === a && r.pre + r.newMid + r.post === b, `${m}: куски не складываются обратно в строки`);
};
roll("пт, 20 ноября, 15:00", "пт, 20 ноября, 17:00", { pre: "пт, 20 ноября, 1", oldMid: "5", newMid: "7", post: ":00" }, "время плана");
roll("21 ноября, Сб 15:00", "21 ноября, Сб 17:00", { pre: "21 ноября, Сб 1", oldMid: "5", newMid: "7", post: ":00" }, "время плана как у сервера");
roll("450 ₽", "540 ₽", { pre: "", oldMid: "45", newMid: "54", post: "0 ₽" }, "сумма");
roll("−450 RUB — транспорт, такси", "−450 RUB — еда, такси", { pre: "−450 RUB — ", oldMid: "транспорт", newMid: "еда", post: ", такси" }, "смена категории");
roll("−450 RUB — кафе", "−450 RUB — кофе", { pre: "−450 RUB — ", oldMid: "кафе", newMid: "кофе", post: "" }, "слово не режется посередине");
roll("Стоматолог", "Стоматолог", { pre: "Стоматолог", oldMid: "", newMid: "", post: "" }, "одинаковые строки");
roll("Такси", "Кофе", { pre: "", oldMid: "Такси", newMid: "Кофе", post: "" }, "совсем другая строка — целиком");
roll("Созвон с командой в офисе", "Созвон с бухгалтерией по отчёту за квартал", { pre: "", oldMid: "Созвон с командой в офисе", newMid: "Созвон с бухгалтерией по отчёту за квартал", post: "" }, "длинная середина — целиком");
roll("🍕 450", "🍕 540", { pre: "🍕 ", oldMid: "45", newMid: "54", post: "0" }, "эмодзи не режется");
roll("", "21 ноября, Сб", { pre: "", oldMid: "", newMid: "21 ноября, Сб", post: "" }, "подробность появилась");

// amendText: строки «✎ было → стало» показывают карточки, остальное — как есть.
eq(amendText("Перенесла на 17:00.\n✎ Стоматолог: 15:00 → 17:00\n⚠ В 17:00 у тебя уже «Йога». Сдвинуть?"), "Перенесла на 17:00.\n⚠ В 17:00 у тебя уже «Йога». Сдвинуть?", "текст облачка после поправки");
eq(amendText("Уточните, пожалуйста: в 7 утра или вечера?"), "Уточните, пожалуйста: в 7 утра или вечера?", "вопрос — целиком");
eq(amendText("Поправила.\n✎ такси — поправила\nОстального в этом ответе не нашла — не меняла."), "Поправила.\nОстального в этом ответе не нашла — не меняла.", "честная строка остаётся");

// --- строка на поддельной странице ---
// Маленькое дерево узлов: классы, dataset, текст, append/prepend/after/remove, querySelector по простым селекторам — сколько
// нужно amend.js, чтобы ответ на поправку прошёл в облачко целиком (amendShow), а не только до отправки.
class FakeNode {
  constructor(tag = "div", id = "") {
    Object.assign(this, { tagName: tag.toUpperCase(), id, kids: [], parent: null, classes: new Set(), dataset: {}, style: {}, listeners: {} });
    Object.assign(this, { value: "", placeholder: "", readOnly: false, title: "", onclick: null });
    const self = this;
    this.classList = {
      add: (...c) => c.forEach((x) => self.classes.add(x)), remove: (...c) => c.forEach((x) => self.classes.delete(x)),
      contains: (c) => self.classes.has(c), toggle: (c, on = !self.classes.has(c)) => (on ? self.classes.add(c) : self.classes.delete(c), on),
      [Symbol.iterator]: () => self.classes[Symbol.iterator](),
    };
  }
  get className() { return [...this.classes].join(" "); }
  set className(v) { this.classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get textContent() { return this.kids.map((k) => (typeof k === "string" ? k : k.textContent)).join(""); }
  set textContent(v) { this.kids.forEach((k) => typeof k !== "string" && (k.parent = null)); this.kids = String(v) ? [String(v)] : []; }
  set innerHTML(v) { this.textContent = String(v).replace(/<[^>]*>/g, ""); }
  get children() { return this.kids.filter((k) => typeof k !== "string"); }
  adopt(x) { if (typeof x !== "string") { x.remove(); x.parent = this; } return x; }
  append(...xs) { for (const x of xs) this.kids.push(this.adopt(x)); }
  appendChild(x) { this.append(x); return x; }
  prepend(...xs) { this.kids.unshift(...xs.map((x) => this.adopt(x))); }
  after(x) { const p = this.parent; p.adopt(x); p.kids.splice(p.kids.indexOf(this) + 1, 0, x); }
  remove() { if (this.parent) this.parent.kids = this.parent.kids.filter((k) => k !== this); this.parent = null; }
  contains(x) { for (let k = x; k; k = k.parent) if (k === this) return true; return false; }
  matches(sel) {
    const m = sel.match(/^([a-z]*)((?:\.[\w-]+)*)(?:\[data-([\w-]+)\])?(?::not\(\.([\w-]+)\))?$/);
    if (!m) throw new Error(`поддельная страница не знает селектор «${sel}»`);
    const [, tag, cls, data, not] = m;
    return (!tag || this.tagName === tag.toUpperCase()) && (!cls || cls.slice(1).split(".").every((c) => this.classes.has(c)))
      && (!data || data in this.dataset) && (!not || !this.classes.has(not));
  }
  querySelectorAll(sel) { const all = (x) => x.children.flatMap((k) => [k, ...all(k)]); return all(this).filter((x) => x.matches(sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
  getBoundingClientRect() { return { width: this.textContent.length * 7, height: 16 }; }
  get offsetWidth() { return 100; }
  addEventListener(t, f) { (this.listeners[t] ??= []).push(f); }
  focus() { doc.activeElement = this; }
  blur() {
    if (doc.activeElement !== this) return;
    doc.activeElement = doc.body;
    for (let k = this; k; k = k.parent) fire(k, "focusout", { relatedTarget: null, target: this });
  }
}
const fire = (el, t, e = {}) => (el.listeners[t] ?? []).forEach((f) => f(e));
const node = (tag, id, cls = "", parent = null) => { const x = new FakeNode(tag, id); x.className = cls; parent?.append(x); return x; };
const doc = { body: new FakeNode("body"), activeElement: null, focused: true, hasFocus: () => doc.focused, createElement: (t) => new FakeNode(t) };
doc.activeElement = doc.body;
// Облачко, как в widget.html: текст, карточки, строка поправки (поле в label, красная строка), кнопки.
const els = {};
els["#bubble"] = node("div", "bubble", "bubble neutral");
els["#bubbleText"] = node("div", "bubbleText", "bubble-text", els["#bubble"]);
els["#bubbleCards"] = node("div", "bubbleCards", "bubble-cards", els["#bubble"]);
els["#bubbleAmend"] = node("form", "bubbleAmend", "amend hidden", els["#bubble"]);
const amendLabel = node("label", "", "amend-line", els["#bubbleAmend"]);
els["#amendInput"] = node("input", "amendInput", "", amendLabel);
els["#amendErr"] = node("div", "amendErr", "amend-err", els["#bubbleAmend"]);
els["#bubbleActions"] = node("div", "bubbleActions", "bubble-actions", els["#bubble"]);
els["#chatHist"] = node("div", "chatHist", "hidden");
const calls = [];
let pending = [];
let uuid = 0;
let timers = [];
const runTimers = () => { const t = timers; timers = []; t.sort((a, b) => a.ms - b.ms).forEach((x) => x.f()); };
const page = {
  $: (s) => els[s], document: doc, grabbed: false, data: { day: "2026-11-20" }, pumping: false, still: false,
  maid: {
    api: (method, p, body) => { calls.push({ method, p, body }); return new Promise((ok, no) => pending.push({ ok, no })); },
    focusInput: (on) => calls.push({ focus: on }), changed: () => calls.push({ changed: true }), openSection: (p) => calls.push({ open: p }),
  },
  setState: (s) => calls.push({ state: s }), restState: () => "idle", errText: (e) => String(e?.message ?? e), play: () => {},
  crypto: { randomUUID: () => `id-${++uuid}` }, chatLog: [], HIST_KEY: "maid.history", HIST_MAX: 40, localStorage: { setItem() {} },
  drawHistory: () => calls.push({ drawn: true }),
  // То, что amendShow берёт из widget.js: текст облачка, звуки, таймеры, кнопки, время жизни.
  setTimeout: (f, ms = 0) => timers.push({ f, ms }), clearTimeout: () => {}, typeTimers: [],
  matchMedia: () => ({ matches: page.still }), stopType: () => {}, planRows: (x) => x, tgHtml: (x) => x, esc: (x) => String(x),
  EMOTION_MOOD: { neutral: "neutral", happy: "happy", angry: "angry", thinking: "think" }, cfg: { clashWait: 10 },
  popTone: () => calls.push({ tone: true }), bubbleSound: () => calls.push({ tone: true }), react: (m) => calls.push({ react: m }),
  hideBubble: () => calls.push({ hide: true }), say: (t) => calls.push({ said: t }),
  stopAuto: () => calls.push({ stopAuto: true }), startAuto: (btn, wait) => calls.push({ startAuto: btn, wait }),
  stopLife: () => calls.push({ stopLife: true }), startLife: (ms, shown) => calls.push({ life: ms, shown }),
  // Карточка — как bubbleCard в widget.js (data-ref, .card-body, .card-title, .card-detail; щелчок — раздел по sectionOf).
  bubbleCard: (c) => {
    const el = node("div", "", `card k-${c.kind} go`);
    const ref = page.amendKey(c.ref);
    if (ref) el.dataset.ref = ref;
    el.onclick = () => { page.hideBubble(); page.maid.openSection(page.sectionOf(c)); };
    const body = node("span", "", "card-body", el);
    node("span", "", "card-title", body).textContent = c.title;
    if (c.detail) node("span", "", "card-detail", body).textContent = c.detail;
    return el;
  },
};
vm.createContext(page);
// Настоящие sectionOf и clashButtons из widget.js: щелчок по карточке после поправки и кнопки наложения — те же, что в окне.
const fromWidget = (name) => widget.match(new RegExp(`\\nfunction ${name}\\([^]*?\\n\\}`))?.[0] ?? "";
try {
  vm.runInContext(`${fromWidget("sectionOf")}\n${fromWidget("clashButtons")}`, page);
} catch (e) {
  check(false, `sectionOf или clashButtons из widget.js не разобрались: ${e?.message ?? e}`);
}
const flush = () => new Promise((r) => setImmediate(r));
(async () => {
  try {
    vm.runInContext(`${amend}\nthis.__run = () => amendRun;`, page);
    const box = els["#bubbleAmend"], input = els["#amendInput"], err = els["#amendErr"], bubble = els["#bubble"];
    const ev = { kind: "event", title: "Стоматолог", detail: "21 ноября, Сб 15:00", ref: { tbl: "events", id: 501 } };

    // Когда строка есть: «Отменить» и карточка с ref; нет — у вопроса «добавить?», у «…», без «Отменить», без ref.
    for (const [opts, m] of [
      [{ undo: null, changes: [ev], text: "Записала" }, "без «Отменить»"],
      [{ undo: 7, changes: [ev], proposal: { id: 1 }, text: "Добавить?" }, "у вопроса «добавить?»"],
      [{ undo: 7, changes: [ev], text: "…" }, "у «…»"],
      [{ undo: 7, changes: [{ kind: "mark", title: "Зарядка" }], text: "Отметила" }, "без карточки с ref"],
    ]) {
      page.amendMount(opts);
      check(box.classes.has("hidden") && !page.__run(), `строка поправки видна ${m}`);
    }
    page.amendMount({ undo: 7, changes: [ev], text: "Записала" });
    check(!box.classes.has("hidden") && page.__run()?.messageId === 7, "строки нет под записанным ответом");
    check(input.placeholder === "поправить этот ответ…", `подсказка строки: ${input.placeholder}`);

    // Что держит облачко: пусто и без фокуса — нет; фокус, текст, поправка в пути — да; закрытое облачко — только поправка в пути.
    check(!page.amendHeld(), "пустая строка без фокуса держит облачко");
    input.focus();
    check(page.amendHeld(), "строка в фокусе не держит облачко");
    input.blur();
    check(calls.some((c) => c.focus === false), "ушли из строки — окно не отпустило клавиатуру");
    fire(box, "mousedown", { target: input, button: 0, preventDefault() {} });
    check(calls.at(-1)?.focus === true, "щелчок по строке не забрал клавиатуру окну");
    // Щелчок мимо поля (красная строка ошибки, значок ✎): фокус всё равно в поле — иначе focusout не придёт, focusInput(false)
    // не уйдёт, и окно так и останется несквозным.
    input.blur();
    const errAt = calls.length;
    fire(box, "mousedown", { target: err, button: 0, preventDefault() {} });
    check(calls.slice(errAt).some((c) => c.focus === true) && doc.activeElement === input, "щелчок по красной строке взял клавиатуру, а фокус в поле не поставил");
    input.blur();
    check(calls.at(-1)?.focus === false, "ушли из строки после щелчка по красной строке — окно не отпустило клавиатуру");
    input.value = "не в 15, а в 17";
    check(page.amendHeld(), "строка с текстом не держит облачко");
    bubble.classes.add("hidden");
    check(!page.amendHeld(), "закрытое облачко держится черновиком");
    bubble.classes.delete("hidden");

    // Esc: текст — стереть, пустая — уйти из строки; клавиши дальше строки не идут.
    let stopped = 0;
    const key = (k, extra = {}) => fire(input, "keydown", { key: k, preventDefault() {}, stopPropagation() { stopped++; }, ...extra });
    input.focus();
    key("Escape");
    check(input.value === "" && doc.activeElement === input, "Esc не стёр текст (или увёл фокус сразу)");
    key("Escape");
    check(doc.activeElement !== input, "Esc в пустой строке не увёл фокус");
    check(stopped === 2, "Esc ушёл дальше строки");

    // Отправка: своя ручка /api/correct, id один на текст; в пути — только чтение, крутилка, «думает».
    input.focus();
    input.value = "не в 15, а в 17";
    key("Enter", { shiftKey: true });
    check(!calls.some((c) => c.p), "Shift+Enter отправил поправку");
    key("Enter");
    const first = calls.find((c) => c.p);
    check(first?.method === "POST" && first?.p === "/api/correct", `поправка ушла не в /api/correct: ${first?.p}`);
    eq(first?.body, { messageId: 7, text: "не в 15, а в 17", id: "id-1" }, "тело поправки");
    check(input.readOnly && box.classes.has("busy") && calls.some((c) => c.state === "think"), "в пути: строка не только для чтения / нет крутилки / не думает");
    check(page.amendHeld(), "поправка в пути не держит облачко");
    key("Enter");
    check(calls.filter((c) => c.p).length === 1, "второй Enter в пути отправил ещё раз");
    pending.shift().no(new Error("нет связи с сервером"));
    await flush();
    check(err.textContent === "нет связи с сервером" && input.value === "не в 15, а в 17" && !input.readOnly && !box.classes.has("busy"), "сбой: нет красной строки, пропал текст или строка не ожила");
    check(calls.at(-1)?.state === "idle" || calls.some((c) => c.state === "idle"), "после сбоя горничная осталась «думает»");
    key("Enter");
    check(calls.filter((c) => c.p).at(-1).body.id === "id-1", "повтор того же текста — с другим id");
    pending.shift().no(new Error("сервер не ответил"));
    await flush();
    input.value = "не в 15, а в 18";
    key("Enter");
    check(calls.filter((c) => c.p).at(-1).body.id === "id-2", "другой текст — с прежним id");

    // Пока поправка в пути, пришло новое облачко (say): ответ пишет только в переписку, строку нового облачка не трогает.
    page.chatLog = [{ at: 1, me: "завтра в 15 стоматолог", reply: "Записала", undo: 7, changes: [{ kind: "event", title: "Стоматолог" }] }];
    page.amendMount({ undo: 9, changes: [{ ...ev, ref: { tbl: "events", id: 900 } }], text: "Другое" });
    input.value = "черновик нового";
    const newRun = page.__run();
    pending.shift().ok({ text: "Перенесла на 18:00.\n✎ Стоматолог: 21 ноября, Сб 15:00 → 21 ноября, Сб 18:00", emotion: "happy", messageId: 7, undoable: true,
      changes: [{ ...ev, detail: "21 ноября, Сб 18:00" }], changed: ["events:501"] });
    await flush();
    check(page.__run() === newRun && input.value === "черновик нового" && !input.readOnly, "ответ старой поправки попал в новое облачко");
    eq(page.chatLog.map((h) => h.me), ["завтра в 15 стоматолог", "✎ не в 15, а в 18"], "поправка не записана в переписку отдельной парой");
    check(page.chatLog[1].undo === null && page.chatLog[1].reply.startsWith("Перенесла на 18:00."), "у пары поправки своё «Отменить» или не тот ответ");
    check(calls.some((c) => c.changed), "после поправки панель не обновилась (maid.changed)");

    // Успех без облачка (оно закрыто): следующая поправка тем же текстом — уже с новым id.
    bubble.classes.add("hidden");
    input.value = "в 17";
    page.__run().busy = false;
    bubble.classes.delete("hidden");
    key("Enter");
    const idA = calls.filter((c) => c.p).at(-1).body.id;
    bubble.classes.add("hidden");
    pending.shift().ok({ text: "Перенесла на 17:00.", emotion: "happy", messageId: 9, undoable: true, changes: [{ ...ev, ref: { tbl: "events", id: 900 } }], changed: ["events:900"] });
    await flush();
    bubble.classes.delete("hidden");
    input.value = "в 17";
    key("Enter");
    check(calls.filter((c) => c.p).at(-1).body.id !== idA, "после принятой поправки тот же текст ушёл с прежним id");
    pending.shift().no(new Error("x"));
    await flush();

    // Облачко закрыли (hideBubble → amendHide): фокус отпущен, черновик стёрт.
    input.focus();
    input.value = "черновик";
    page.amendHide();
    check(doc.activeElement !== input && input.value === "", "закрытое облачко оставило фокус или черновик в строке");

    // --- ответ на поправку в то же облачко (amendShow) ---
    const cards = els["#bubbleCards"], acts = els["#bubbleActions"], text = els["#bubbleText"];
    // Как say: текст, карточки через bubbleCard, кнопки ответа (data-i — номер) и «Отменить», строка поправки.
    const showBubble = ({ shown, buttons = [], ...opts }) => {
      bubble.className = "bubble neutral";
      text.textContent = shown;
      cards.textContent = "";
      for (const c of opts.changes) cards.append(page.bubbleCard(c));
      acts.textContent = "";
      buttons.forEach((x, i) => { const btn = node("button", "", x.auto ? "auto" : "", acts); btn.dataset.i = String(i); btn.textContent = x.text; });
      node("button", "", "", acts).dataset.i = "undo";
      page.amendMount(opts);
    };
    const answer = async (reply) => { pending.shift().ok(reply); await flush(); };
    const send = (t) => { input.focus(); input.value = t; key("Enter"); };
    const cardOf = (k) => cards.children.find((x) => x.dataset.ref === k);

    // Поправка принята: текст и цвет облачка — по ответу; изменённое крутится, ушедшее зачёркнуто, новое въехало в конец,
    // карточка без ref на месте; щелчок — раздел новой версии записи; облачко живёт заново (≥ 12 с); переписка — после поправки.
    const mk = { kind: "mark", title: "Зарядка ✓" };
    const evA = { kind: "event", title: "Стоматолог", detail: "21 ноября, Сб 15:00", ref: { tbl: "events", id: 501 } };
    const moA = { kind: "money", title: "такси", detail: "−450 RUB — транспорт, такси", ref: { tbl: "money", id: 2 } };
    const diA = { kind: "diary", title: "Заметки", detail: "плохо спал", ref: { tbl: "diary", id: 3 } };
    const task = { kind: "task", title: "Купить подарок", ref: { tbl: "tasks", id: 8 } };
    page.chatLog = [{ at: 2, me: "завтра в 15 стоматолог, такси 450, плохо спал", reply: "Записала.", undo: 11, changes: [] }];
    showBubble({ shown: "Записала.", undo: 11, changes: [mk, evA, moA, diA], text: "Записала.\n📅 Стоматолог\n💰 такси" });
    const markEl = cards.children[0];
    send("не в 15, а в 17, и это про здоровье");
    const fixAt = calls.length;
    const fixed = [{ ...evA, detail: "21 ноября, Сб 17:00" }, { ...diA, title: "Здоровье · Сон" }, task];
    await answer({ text: "Поправила.\n✎ Стоматолог: 21 ноября, Сб 15:00 → 21 ноября, Сб 17:00", emotion: "happy", messageId: 11, undoable: true,
      changes: fixed, changed: ["events:501", "diary:3"] });
    check(text.textContent === "Поправила.", `текст облачка после поправки: ${text.textContent}`);
    check(bubble.classes.has("happy") && !bubble.classes.has("neutral"), "цвет облачка не сменился по эмоции ответа");
    const evEl = cardOf("events:501");
    const was = evEl?.querySelector(".amend-was")?.textContent, now = evEl?.querySelector(".amend-now")?.textContent;
    check(was === "5" && now === "7" && evEl.classes.has("amend-lit"), `в карточке плана не крутится «5» → «7»: ${was} → ${now}`);
    check(cardOf("money:2")?.classes.has("amend-gone"), "ушедшая запись не зачёркнута (или пропала из облачка)");
    check(cards.children[0] === markEl && markEl.textContent === "Зарядка ✓", "карточка без ref сдвинулась или поменялась");
    const added = cards.children.at(-1);
    check(added?.dataset.ref === "tasks:8" && added.classes.has("amend-new") && added.querySelector(".card-title")?.textContent === "Купить подарок", "новая запись ответа не въехала в конец");
    runTimers();
    check(evEl.querySelector(".card-detail")?.textContent === "21 ноября, Сб 17:00" && !evEl.querySelector(".amend-roll"), `после прокрутки подробность плана: ${evEl.querySelector(".card-detail")?.textContent}`);
    check(cardOf("diary:3")?.querySelector(".card-title")?.textContent === "Здоровье · Сон", "название записи дневника не стало новым");
    cardOf("diary:3").onclick();
    check(calls.at(-1)?.open === "/health", `щелчок по карточке после поправки открыл раздел старой версии: ${calls.at(-1)?.open}`);
    const lifeCall = calls.slice(fixAt).filter((c) => "life" in c).at(-1);
    check(lifeCall?.life >= 12000 && lifeCall.shown === true, `после ответа облачко живёт не заново или меньше 12 с: ${lifeCall?.life}`);
    check(!box.classes.has("hidden") && input.placeholder === "поправить этот ответ…" && input.value === "" && doc.activeElement !== input, "после принятой поправки строка не пустая, не на месте или держит фокус");
    check(calls.slice(fixAt).some((c) => c.state === "idle"), "после ответа горничная осталась «думает»");
    eq(page.chatLog[0].changes.map((c) => c.title), ["Зарядка ✓", "Стоматолог", "Здоровье · Сон", "Купить подарок"], "переписка: карточки исходного ответа после поправки");

    // Переспрос, а окно без фокуса (ушли в игру, пока она думала): строка открыта с подсказкой «ответить горничной…», но
    // клавиатуру и мышь окно не забирает. Тем временем ушло сообщение чата — «думает» снимет оно, не ответ поправки.
    const ask = { text: "Уточните: в 7 утра или вечера?", emotion: "thinking", clarify: true, messageId: 11, undoable: true, changes: fixed, changed: [] };
    send("в 7");
    doc.focused = false;
    page.pumping = true;
    const askAt = calls.length;
    await answer(ask);
    check(!calls.slice(askAt).some((c) => c.focus === true), "переспрос без фокуса окна забрал клавиатуру (focusInput(true))");
    check(input.placeholder === "ответить горничной…" && !box.classes.has("hidden"), "на переспрос строка не открыта с подсказкой «ответить горничной…»");
    check(text.textContent === "Уточните: в 7 утра или вечера?", "вопрос горничной не стал текстом облачка");
    check(!calls.slice(askAt).some((c) => c.state === "idle"), "ответ поправки снял «думает», пока идёт сообщение чата");
    page.pumping = false;
    doc.focused = true;
    // В пути ушли из строки (Esc) — переспрос фокус не возвращает.
    send("в 7");
    key("Escape");
    const escAt = calls.length;
    await answer(ask);
    check(!calls.slice(escAt).some((c) => c.focus === true) && doc.activeElement !== input, "после Esc в пути переспрос вернул фокус в строку");
    // Так и сидят в строке (окно в фокусе) — строка остаётся в фокусе: следующая поправка — ответ на вопрос.
    send("в 7");
    await answer(ask);
    check(doc.activeElement === input && input.placeholder === "ответить горничной…", "на переспрос строка потеряла фокус");
    input.blur();

    // Наложение на месте: поправка другой записи (сумма) не убирает «Сдвинуть на …» / «Оставить» и строку ⚠ — план всё так же
    // лежит на занятом времени (сервер шлёт clash только по планам, у которых поменялись дата или время).
    const warn = "⚠ В 19:00 у тебя уже «Ужин с друзьями». Сдвинуть на 20:30?";
    const evB = { ...evA, detail: "21 ноября, Сб 19:00" };
    const moB = { ...moA, detail: "−540 RUB — транспорт, такси" };
    showBubble({ shown: `Записала.\n${warn}`, undo: 12, changes: [evB, moA], text: `Записала.\n📅 Стоматолог\n${warn}`, buttons: [{ text: "➜ Сдвинуть на 20:30" }, { text: "Оставить", auto: 10 }] });
    send("сумма 540");
    const sumAt = calls.length;
    await answer({ text: "Поправила сумму.\n✎ такси: −450 RUB → −540 RUB", emotion: "neutral", messageId: 12, undoable: true, changes: [evB, moB], changed: ["money:2"] });
    eq(acts.children.map((x) => x.dataset.i), ["0", "1", "undo"], "поправка суммы убрала кнопки наложения плана");
    check(!calls.slice(sumAt).some((c) => c.stopAuto), "поправка суммы остановила самонажатие «Оставить»");
    check(text.textContent === `Поправила сумму.\n${warn}`, `строка ⚠ пропала из облачка: ${text.textContent}`);

    // Поправка сдвинула план на занятое время: прежние кнопки уходят, новые — clashButtons с messageId исходного ответа.
    send("в 18");
    await answer({ text: "Перенесла на 18:00.\n✎ Стоматолог: 21 ноября, Сб 19:00 → 21 ноября, Сб 18:00\n⚠ В 18:00 у тебя уже «Йога». Сдвинуть на 19:30?",
      emotion: "worried", messageId: 12, undoable: true, changes: [{ ...evB, detail: "21 ноября, Сб 18:00" }, moB], changed: ["events:501"],
      clash: { eventId: 501, withId: 77, shiftTo: "19:30" } });
    const labels = acts.children.map((x) => x.textContent);
    check(!acts.children.some((x) => /^\d+$/.test(x.dataset.i ?? "")) && labels[0] === "➜ Сдвинуть на 19:30" && labels[1] === "Оставить", `кнопки наложения после поправки: ${labels.join(" | ")}`);
    check(text.textContent === "Перенесла на 18:00.\n⚠ В 18:00 у тебя уже «Йога». Сдвинуть на 19:30?", `текст облачка с новым наложением: ${text.textContent}`);
    const autoCall = calls.filter((c) => c.startAuto).at(-1);
    check(autoCall?.startAuto === acts.children[1] && autoCall.wait === 10000, "у нового «Оставить» не запущено самонажатие");
    acts.children[0].onclick();
    eq(calls.filter((c) => c.p === "/api/clash").at(-1)?.body, { messageId: 12, eventId: 501, withId: 77, action: "shift" }, "«Сдвинуть» после поправки — не по исходному ответу");
    pending.shift().no(new Error("x"));
    await flush();

    // При «меньше движения» — сразу новый текст, без прокрутки, с короткой подсветкой.
    page.still = true;
    showBubble({ shown: "Записала.", undo: 13, changes: [moA], text: "Записала." });
    send("сумма 540");
    await answer({ text: "Поправила сумму.", emotion: "neutral", messageId: 13, undoable: true, changes: [moB], changed: ["money:2"] });
    const moEl = cardOf("money:2");
    check(moEl.querySelector(".card-detail")?.textContent === "−540 RUB — транспорт, такси" && !moEl.querySelector(".amend-roll") && moEl.classes.has("amend-lit"), "«меньше движения»: не сразу новый текст или без подсветки");
    page.still = false;
  } catch (e) {
    check(false, `строка на поддельной странице: ${e?.stack ?? e}`);
  }

  // --- подключение ---
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  check(scripts.includes("amend.js") && scripts.indexOf("amend.js") < scripts.indexOf("widget.js"), `amend.js не подключён до widget.js: ${scripts.join(", ")}`);
  const order = ["bubbleCards", "bubbleAmend", "bubbleActions"].map((id) => html.indexOf(`id="${id}"`));
  check(order.every((x, i) => x > 0 && (!i || x > order[i - 1])), "строка поправки не между карточками и кнопками облачка");
  check(/id="amendInput"[^>]*maxlength="500"/.test(html) && /placeholder="поправить этот ответ…"/.test(html), "у строки поправки нет maxlength 500 или подсказки");

  const fn = (name) => widget.match(new RegExp(`\\n(async )?function ${name}\\([^]*?\\n\\}\\r?\\n`))?.[0] ?? "";
  const card = fn("bubbleCard"), say = fn("say");
  check(/el\.dataset\.ref = ref/.test(card) && /amendKey\(c\.ref\)/.test(card), "у карточки облачка нет data-ref");
  check(/class="card-title"/.test(card) && /class="card-detail"/.test(card), "название и подробность карточки — не отдельные span");
  check(/bubbleCard\(c\)/.test(say), "say не строит карточки через bubbleCard");
  check(/amendMount\(\{ undo, changes, proposal, text \}\)/.test(say), "say не подключает строку поправки");
  check(/const held = b\.matches\(":hover"\) \|\| amendHeld\(\);/.test(fn("startLife")), "время жизни облачка не стоит, пока пишут поправку");
  check(/!amendHeld\(\)\) run\.left -= dt/.test(fn("startAuto")), "«Оставить» нажимается само посреди поправки");
  check(/chatInput\.value\.trim\(\) \|\| amendHeld\(\)\)/.test(fn("refoldLater")), "панель сворачивается, пока пишут поправку");
  check(/amendHide\(\)/.test(fn("hideBubble")), "закрытое облачко не отпускает строку поправки");
  check(/if \(!amendFlying\) setState\(restState\(\)\);/.test(fn("pump")), "сообщение чата снимает «думает», пока идёт поправка");

  const browser = amend.slice(amend.indexOf(MARK));
  check(/maid\.api\("POST", "\/api\/correct", \{ messageId: run\.messageId, text, id: run\.id \}\)/.test(browser), "поправка уходит не в /api/correct");
  check(!/enqueue\(|outbox|pump\(/.test(browser), "поправка идёт через очередь чата");
  check(/clashButtons\(\{ clash: r\.clash, messageId: r\.messageId \}\)/.test(browser), "кнопки наложения после поправки — не с messageId исходного ответа");
  check(/prefers-reduced-motion: reduce/.test(browser), "прокрутка не смотрит на «меньше движения»");
  check(/AMEND_ASK/.test(browser) && /r\.clarify/.test(browser), "на вопрос горничной строка не переходит в «ответить горничной…»");
  check(/startLife\(12000 \+/.test(browser), "после ответа облачко живёт меньше 12 с");
  // Все имена верхнего уровня — с приставкой amend/AMEND_ (скрипты окна делят одну область имён).
  const tops = [...amend.matchAll(/^(?:async )?(?:function|const|let|var|class) +([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
  const stray = tops.filter((x) => !/^(amend|AMEND_)/.test(x));
  check(tops.length > 10 && !stray.length, `имена amend.js без приставки: ${stray.join(", ")}`);

  const rm = css.match(/@media \(prefers-reduced-motion: reduce\) \{\n  \.amend-was[^}]*\}[^}]*\}[^}]*\}/)?.[0] ?? "";
  check(/animation: none/.test(rm) && /\.amend-roll \{ transition: none; \}/.test(rm), "при «меньше движения» прокрутка карточек не выключена");
  check(/\.amend-roll \{[^}]*overflow: hidden/.test(css) && /\.amend-roll \{[^}]*inline-grid/.test(css), "кусок прокрутки не inline-grid с overflow: hidden");
  check(/\.bubble\.typing \.amend \{[^}]*opacity: 0/.test(css), "строка поправки видна, пока печатается текст");

  console.log(`${n - bad}/${n}`);
  process.exit(bad ? 1 : 0);
})();
