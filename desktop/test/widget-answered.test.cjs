// Ответил не в облачке, а в списке (widget.js: bubbleAsk, answeredInList, askSettled) без Electron и браузера.
// 17.11.2026: горничная спросила «Таблетка Чумбы 12:30 — сегодня сделали?», а галочку поставили в списке привычек —
// облачко с вопросом так и висело. Теперь облачко помнит, о чём спрашивает (привычка за день или задача с прошедшим сроком);
// ответили в списке (или в Telegram, на сайте — увидит при обновлении данных) — облачко закрывается, оповещение прочитано,
// и она коротко реагирует («Поняла, вижу-вижу ✓» — несколько вариантов, без повторов подряд: lines.js, answeredInList).
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const dir = path.join(__dirname, "..", "renderer");
const widget = fs.readFileSync(path.join(dir, "widget.js"), "utf8");
const lines = fs.readFileSync(path.join(dir, "lines.js"), "utf8");
const tails = fs.readFileSync(path.join(dir, "tails.js"), "utf8");
const fn = (name) => widget.match(new RegExp(`\\nfunction ${name}\\([^]*?\\n\\}\\r?\\n`))?.[0] ?? "";

for (const f of ["bubbleAsk", "answeredInList", "askSettled"]) check(fn(f), `в widget.js нет ${f}`);

// Варианты реплики: не меньше шести.
const ctxL = { localStorage: { getItem: () => null, setItem() {} }, Math, Date, JSON };
vm.createContext(ctxL);
vm.runInContext(`${lines}\nthis.L = LINES;`, ctxL);
check((ctxL.L.answered ?? []).length >= 6, `вариантов реплики «ответили в списке» мало: ${(ctxL.L.answered ?? []).length}`);

// Поддельное облачко и данные дня.
const said = [];
const read = [];
const bubble = { dataset: {}, classList: { contains: (c) => c === "hidden" && bubble.hidden } };
const ctx = {
  $: (s) => (s === "#bubble" ? bubble : null),
  data: { day: "2026-11-17", habits: [{ id: 5, status: null }, { id: 6, status: null }], tasks: [{ id: 9 }] },
  say: (t, o) => said.push({ t, o }),
  inboxRead: (id) => read.push(id),
  lineItem: () => ({ t: "Поняла, вижу-вижу ✓", m: "happy" }),
};
vm.createContext(ctx);
try {
  vm.runInContext(`${fn("bubbleAsk")}\n${fn("answeredInList")}\n${fn("askSettled")}\nthis.ask = bubbleAsk; this.ans = answeredInList; this.settled = askSettled;`, ctx);
  check(ctx.ask([{ text: "✅ Да", data: "habit:5:2026-11-17:done" }, { text: "Нет", data: "habit:5:2026-11-17:skipped" }]) === "h:5:2026-11-17", "вопрос о привычке не распознан");
  check(ctx.ask([{ text: "ok", data: "rate:2026-11-17:5" }]) === "", "оценка дня — не вопрос о привычке");

  const show = (ask, notice = "41") => { bubble.hidden = false; bubble.dataset = { ask, notice }; said.length = 0; read.length = 0; };
  show("h:5:2026-11-17");
  ctx.ans("h:6");
  check(!said.length, "отметили другую привычку — облачко закрылось");
  ctx.ans("h:5");
  check(said.length === 1 && /вижу/.test(said[0].t), `ответили в списке — нет реакции: ${JSON.stringify(said)}`);
  check(read[0] === 41, "оповещение не прочитано");
  check(bubble.dataset.ask === "", "облачко всё ещё ждёт ответа");

  show("h:5:2026-11-16");
  ctx.ans("h:5");
  check(!said.length, "вопрос про вчерашний день закрылся сегодняшней галочкой");

  show("t:9", "");
  ctx.ans("t:9");
  check(said.length === 1 && read.length === 0, "задача с прошедшим сроком: нет реакции или прочитано лишнее");

  show("h:5:2026-11-17");
  bubble.hidden = true;
  ctx.ans("h:5");
  check(!said.length, "спрятанное облачко отвечает");

  // Отметили в другом месте (Telegram, сайт): данные дня обновились — облачко тоже закрывается.
  show("h:6:2026-11-17");
  ctx.settled();
  check(!said.length, "привычка не отмечена, а облачко закрылось");
  ctx.data.habits[1].status = "done";
  ctx.settled();
  check(said.length === 1, "отметили в другом месте — облачко висит");
  show("t:9", "");
  ctx.data.tasks = [];
  ctx.settled();
  check(said.length === 1, "задачу закрыли в другом месте — облачко висит");
} catch (e) {
  check(false, `тест оборвался: ${e?.stack ?? e}`);
}

// Где включено: облачко помнит вопрос (say), кнопки облачка его снимают, галочки списка и обновление данных — спрашивают.
const sayFn = widget.match(/\nfunction say\([^]*?\n\}\r?\n/)?.[0] ?? "";
check(/b\.dataset\.ask = bubbleAsk\(/.test(sayFn), "say не запоминает, о чём вопрос");
check(/btn\.onclick = async \(\) => \{\s*b\.dataset\.ask = "";/.test(sayFn), "ответ кнопкой облачка — ещё и «вижу-вижу»");
check(/answeredInList\(`t:\$\{id\}`\)/.test(widget) && /answeredInList\(`h:\$\{habit\}`\)/.test(widget), "галочки списка не закрывают вопрос");
check(/askSettled\(\)/.test(fn("render")), "обновление данных не закрывает вопрос");
check(/dataset\.ask = `t:\$\{t\.id\}`/.test(tails), "вопрос о задаче с прошедшим сроком не помечен");

console.log(`${n - bad}/${n}`);
process.exit(bad ? 1 : 0);
