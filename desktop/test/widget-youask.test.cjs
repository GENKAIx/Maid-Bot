// Рина спрашивает о вас в облачке (widget.js: youAskTick; ответ — ветка «you:» в кнопках облачка), 20.11.2026.
// Сервер решает, что и когда спросить (/api/today.ask: город → подъём → обращение, раз в 3 дня), виджет — в какую минуту:
// не спит, не ночь, облачко пустое, ничего не происходит, с запуска 2 минуты; один раз за запуск, показ отмечается на сервере.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const widget = fs.readFileSync(path.join(__dirname, "..", "renderer", "widget.js"), "utf8");
const pick = (re, what) => { const s = widget.match(re)?.[0]; check(s, `нет ${what} в widget.js`); return s ?? ""; };

const said = [], posted = [];
const bubble = { hidden: true, classList: { contains: (c) => c === "hidden" && bubble.hidden } };
const ctx = {
  data: null, napping: false, touring: false, state: "idle", online: true, moodUntil: 0, night: false,
  $: () => bubble,
  say: (t, o) => said.push({ t, o }),
  maid: { api: (m, p, b) => { posted.push([m, p, b]); return Promise.resolve({}); } },
  Date: { now: () => 1_000_000 },
};
vm.createContext(ctx);
vm.runInContext([
  "function afterBedtime() { return night; }",
  pick(/\nconst YOU_ASK_AFTER = .*/, "YOU_ASK_AFTER"),
  pick(/\nconst youAskBoot = .*/, "youAskBoot"),
  pick(/\nlet youAsked = .*/, "youAsked"),
  pick(/\nfunction youAskTick\([^]*?\n\}/, "youAskTick"),
  "this.tick = youAskTick; this.reset = () => { youAsked = ''; };",
].join("\n"), ctx);

const ASK = { field: "city", text: "Кстати, из какого вы города?", buttons: [{ text: "Потом", data: "you:city:later" }, { text: "Не скажу", data: "you:city:never" }] };
const boot = 1_000_000, later = boot + 121_000;
check(ctx.tick(later) === false && !said.length, "без вопроса от сервера — молчит");
ctx.data = { ask: ASK };
check(ctx.tick(boot + 60_000) === false, "первые 2 минуты после запуска — не спрашивает");
ctx.night = true;
check(ctx.tick(later) === false, "ночью — не спрашивает");
ctx.night = false;
bubble.hidden = false;
check(ctx.tick(later) === false, "облачко занято — не спрашивает");
bubble.hidden = true;
ctx.napping = true;
check(ctx.tick(later) === false, "спит — не спрашивает");
ctx.napping = false;
check(ctx.tick(later) === true, "спокойная минута — спрашивает");
check(said[0]?.t === ASK.text && said[0].o.buttons === ASK.buttons, "вопрос и кнопки — с сервера");
check(JSON.stringify(posted[0]) === JSON.stringify(["POST", "/api/you/ask", { field: "city" }]), "показ отмечен на сервере");
check(ctx.tick(later + 60_000) === false && said.length === 1, "второй раз за запуск — нет");

// Кнопки «you:…» в облачке уходят на сервер (/api/you/button), ответ — её словами.
check(/\/\^you:\\w\+:\\w\+\$\/\.test\(x\.data\)/.test(widget) && /"\/api\/you\/button", \{ data: x\.data \}/.test(widget), "ветка кнопок «you:» в облачке");
// Тикер покоя зовёт вопрос.
check(/else if \(youAskTick\(\)\) return;/.test(widget), "тикер покоя не зовёт youAskTick");

console.log(bad ? `${bad} из ${n} проверок не прошли` : `OK: ${n} проверок вопросов Рины`);
process.exit(bad ? 1 : 0);
