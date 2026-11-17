// Щелчок по горничной (widget.js: maidClick) без Electron и браузера.
// 17.11.2026: облачко с ответом закрывалось только крестиком; щелчок по горничной вместо этого тыкал её. Теперь щелчок,
// пока висит облачко с ответом или сообщением, закрывает его; облачко тычка (dataset.quip) и пустое место — тычок, как было.
// Оповещение без кнопок при этом прочитано (как ✕), а вопрос с кнопками (dataset.choices) остаётся в ящике — ответить позже.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const widget = fs.readFileSync(path.join(__dirname, "..", "renderer", "widget.js"), "utf8");
const fn = (name) => widget.match(new RegExp(`\\nfunction ${name}\\([^]*?\\n\\}\\r?\\n`))?.[0] ?? "";
check(fn("maidClick"), "в widget.js нет maidClick");

const calls = [];
const read = [];
const bubble = { hidden: true, dataset: {}, classList: { contains: (c) => c === "hidden" && bubble.hidden } };
const ctx = {
  $: (s) => (s === "#bubble" ? bubble : null),
  hideBubble: () => calls.push("hide"),
  inboxRead: (id) => read.push(id),
  poke: () => calls.push("poke"),
  setTimeout: (f) => { f(); return 1; },
  clearTimeout: () => {},
  Date: { now: () => 10_000 },
  pettedAt: 0,
  clickTimer: 0,
};
vm.createContext(ctx);
try {
  vm.runInContext(`${fn("maidClick")}\nthis.click = maidClick;`, ctx);
  ctx.click();
  check(calls.join() === "poke", `облачка нет — щелчок должен тыкать: ${calls}`);
  calls.length = 0;
  bubble.hidden = false;
  ctx.click();
  check(calls.join() === "hide", `висит ответ — щелчок должен закрыть облачко: ${calls}`);
  calls.length = 0;
  bubble.dataset.quip = "1";
  ctx.click();
  check(calls.join() === "poke", `облачко тычка — щелчок тыкает дальше: ${calls}`);
  calls.length = 0;
  delete bubble.dataset.quip;
  // Оповещение без кнопок — закрыто и прочитано; вопрос с кнопками — закрыт, но остаётся в ящике.
  calls.length = 0;
  bubble.dataset.notice = "42";
  bubble.dataset.choices = "";
  ctx.click();
  check(calls.join() === "hide" && read.join() === "42", `оповещение без кнопок: закрыть и прочитать: ${calls} / ${read}`);
  calls.length = 0;
  read.length = 0;
  bubble.dataset.choices = "1";
  ctx.click();
  check(calls.join() === "hide" && !read.length, `вопрос с кнопками: закрыть, но не читать: ${calls} / ${read}`);
  calls.length = 0;
  bubble.dataset.notice = "";
  bubble.dataset.choices = "";
  ctx.click();
  check(calls.join() === "hide" && !read.length, `обычный ответ — нечего читать: ${calls} / ${read}`);
  calls.length = 0;
  ctx.pettedAt = 9_800;
  ctx.click();
  check(!calls.length, `отпустили после «погладить» — ни тычка, ни закрытия: ${calls}`);
} catch (e) {
  check(false, `тест оборвался: ${e?.stack ?? e}`);
}
check(/\$\("#maid"\)\.addEventListener\("click", maidClick\)/.test(widget), "щелчок по горничной не идёт в maidClick");
check(/b\.dataset\.choices = buttons\.length \? "1" : ""/.test(widget), "облачко не помнит, есть ли у него кнопки (say)");
console.log(`${n - bad}/${n}`);
process.exit(bad ? 1 : 0);
