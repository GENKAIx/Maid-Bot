// Кнопка микрофона после голосового (widget.js: toggleMic, syncSend) без Electron и браузера.
// 18.11.2026: после отправки записи справа оставалась «отправить», а микрофон пропадал до первой набранной буквы:
// micUi(false) звал syncSend, пока запись ещё шла (Voice.on), — «ready» оставался. Теперь после Voice.stop кнопка
// пересчитывается ещё раз.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const widget = fs.readFileSync(path.join(__dirname, "..", "renderer", "widget.js"), "utf8");
const fn = (name) => widget.match(new RegExp(`\\n(async )?function ${name}\\([^]*?\\n\\}\\r?\\n`))?.[0] ?? "";
for (const f of ["toggleMic", "syncSend", "micUi"]) check(fn(f), `в widget.js нет ${f}`);

const cls = new Set();
const chat = { classList: { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)) }, querySelector: () => ({}) };
let rec = false;
const ctx = {
  $: (s) => (s === "#chat" ? chat : { title: "" }),
  chatBox: chat,
  chatInput: { value: "", focus() {} },
  pictures: [],
  micTick: 0,
  clearInterval() {}, setInterval() { return 0; },
  Voice: {
    get on() { return rec; },
    start: async () => { rec = true; },
    stop: async () => { rec = false; return { audio: "AAAA", mime: "audio/webm" }; },
    clock: () => "0:01", wave() {}, seconds: 0, hushed: false,
  },
  enqueue: () => {},
  say: () => {},
  crypto: { randomUUID: () => "id" },
};
vm.createContext(ctx);
(async () => {
  try {
    vm.runInContext(`let micWarned = false;\n${fn("micCheck")}\n${fn("syncSend")}\n${fn("micUi")}\n${fn("toggleMic")}\nthis.toggleMic = toggleMic;`, ctx);
    await ctx.toggleMic();
    check(cls.has("recording") && cls.has("ready"), `идёт запись — справа «отправить»: ${[...cls]}`);
    await ctx.toggleMic();
    check(!cls.has("recording"), "запись остановлена");
    check(!cls.has("ready"), `строка пустая — справа снова микрофон: ${[...cls]}`);
  } catch (e) {
    n++; bad++;
    console.log("FAIL", e.message);
  }
  console.log(`${n - bad}/${n} проверок`);
  if (bad) process.exit(1);
})();
