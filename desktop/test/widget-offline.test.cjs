// Связь с сервером в виджете (widget.js: errText, backOnline) без Electron и браузера.
// 18.11.2026: отметка привычки без связи показывала сырое «Error invoking remote method 'api': Error: нет связи с сервером»;
// теперь все облачка с ошибкой — через errText, а «нет связи» — понятной фразой. Связь вернулась после долгого перерыва
// (дольше OFFLINE_SAY_MS) — она говорит об этом вслух; короткий обрыв — только «починила» (гаечный ключ), как было.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const widget = fs.readFileSync(path.join(__dirname, "..", "renderer", "widget.js"), "utf8");
const fn = (name) => widget.match(new RegExp(`\\nfunction ${name}\\([^]*?\\n\\}\\r?\\n`))?.[0] ?? "";
const line = (start) => widget.match(new RegExp(`\\n(${start}[^\\n]*)`))?.[1] ?? "";

// 1. Текст ошибки.
check(line("const errText"), "в widget.js нет errText");
check(fn("backOnline"), "в widget.js нет backOnline");
check(!/say\((e|err)\.message/.test(widget), "облачко с сырым e.message: все ошибки — через errText");
check(/online = false; offlineSince = Date\.now\(\)/.test(widget), "load: при потере связи не запоминается offlineSince");
check(/if \(!online\) backOnline\(\)/.test(widget), "load: связь вернулась — не зовётся backOnline");

const said = [], reacted = [], retried = [];
const bubble = { hidden: true, classList: { contains: (c) => c === "hidden" && bubble.hidden } };
const ctx = {
  $: (s) => (s === "#bubble" ? bubble : null),
  say: (t, o) => said.push([t, o?.mood]),
  react: (m) => reacted.push(m),
  settle: () => {},
  retryOutbox: (a) => retried.push(a),
  Math, now: 100_000, online: false, napping: false, offlineSince: 0, outbox: [],
};
ctx.Date = { now: () => ctx.now };
vm.createContext(ctx);
try {
  vm.runInContext(`${line("const OFFLINE_SAY_MS")}\n${line("const BACK_LINES")}\n${line("const errText")}\n${fn("backOnline")}
    this.errText = errText; this.backOnline = backOnline; this.OFFLINE_SAY_MS = OFFLINE_SAY_MS;
    Object.defineProperty(this, "st", { get: () => ({ online, napping, offlineSince, outbox }), set: (v) => ({ online, napping, offlineSince, outbox } = { online, napping, offlineSince, outbox, ...v }) });`, ctx);
  const raw = (m) => ({ message: `Error invoking remote method 'api': Error: ${m}` });
  const off = ctx.errText(raw("нет связи с сервером"));
  check(!/Error invoking/.test(off) && /Нет связи с сервером/.test(off) && /ещё раз/.test(off), `нет связи — понятная фраза: ${off}`);
  check(/Сервер не ответил/.test(ctx.errText(raw("сервер не ответил"))), "сервер не ответил — понятная фраза");
  check(ctx.errText(raw("нет такой привычки")) === "нет такой привычки", "ошибка сервера — как есть, без приставки");

  // 2. Связь вернулась.
  const back = (gone, st = {}) => {
    said.length = reacted.length = retried.length = 0;
    ctx.st = { online: false, napping: false, offlineSince: ctx.now - gone, outbox: [], ...st };
    ctx.backOnline();
    check(ctx.st.online === true, "backOnline: online снова true");
  };
  back(5_000);
  check(!said.length && reacted.join() === "wrench", `короткий обрыв — только ключ: ${JSON.stringify(said)} / ${reacted}`);
  back(ctx.OFFLINE_SAY_MS + 1000);
  check(said.length === 1 && said[0][1] === "wrench" && /[Сс]вяз/.test(said[0][0]), `долго не было — сказать: ${JSON.stringify(said)}`);
  bubble.hidden = false;
  back(60_000);
  check(!said.length && reacted.join() === "wrench", `висит облачко — не перебивать: ${JSON.stringify(said)}`);
  bubble.hidden = true;
  back(60_000, { outbox: [{ state: "later" }] });
  check(retried.length === 1 && retried[0] === null, `ждали сообщения — отправить сразу: ${retried}`);
  check(said.length === 1 && /отправля/i.test(said[0][0]), `ждали сообщения — сказать «отправляю»: ${JSON.stringify(said)}`);
  back(5_000, { outbox: [{ state: "later" }] });
  check(retried.length === 1, "короткий обрыв — ждущие тоже отправить сразу");
  back(60_000, { napping: true });
  check(!said.length && !reacted.length, `спит — молчит: ${JSON.stringify(said)} / ${reacted}`);
} catch (e) {
  bad++;
  console.log("FAIL", e.message);
}
console.log(`${n - bad}/${n} проверок`);
if (bad) process.exit(1);
