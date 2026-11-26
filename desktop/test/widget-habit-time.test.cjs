// Время отметки у привычки в списке «Сегодня» виджета и текст «Закончить привычку» (26.11.2026) без Electron и браузера.
// Сервер отдаёт в /api/today у привычки at_time — «ЧЧ:ММ» в поясе человека (habits.ts markTime): у сделанной строка
// «✓ 21:14 Зарядка». У пропуска и полуночного минуса времени нет; строка без at_time (старый сервер) — как раньше.
// Размер строки при наведении не меняется (правил наведения у времени нет). ПКМ «⏸ Закончить привычку» говорит, что привычка
// теперь на сайте в «Завершённых».
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const root = path.join(__dirname, "..");
const widget = fs.readFileSync(path.join(root, "renderer", "widget.js"), "utf8");
const css = fs.readFileSync(path.join(root, "renderer", "style.css"), "utf8").replace(/\/\*[^]*?\*\//g, "");

// Чистая функция: что стоит у галочки.
const src = widget.match(/\nfunction markAtHtml\(h\) \{[^]*?\n\}/)?.[0];
check(src, "в widget.js нет markAtHtml");
const ctx = {};
vm.createContext(ctx);
try { vm.runInContext(`${src ?? ""}\nthis.at = markAtHtml;`, ctx); } catch (e) { check(false, `markAtHtml не разобралась: ${e?.message ?? e}`); }
const at = (h) => (ctx.at ? ctx.at(h) : "");
const done = at({ id: 1, status: "done", at_time: "21:14", at_day: null });
check(/class="mark-at"/.test(done) && />21:14</.test(done), `у сделанной нет «21:14»: ${done}`);
check(/title="Сделано в 21:14"/.test(done), "нет подсказки «Сделано в 21:14»");
check(at({ status: "skipped", at_time: "21:14" }) === "", "у пропуска показано время");
check(at({ status: null, at_time: null }) === "", "у неотмеченной показано время");
check(at({ status: "done", at_time: null }) === "", "полуночный минус / старый сервер — время показано");
check(at({ status: "done" }) === "", "без поля at_time — что-то показано");
check(at({ status: "done", at_time: `<img src=x onerror="x()">` }) === "", "в время попала разметка");

// В строке время стоит сразу за галочкой, перед названием: «✓ 21:14 Зарядка».
const item = widget.match(/const dayItem = \(h\) => \{[^]*?\n  \};/)?.[0] ?? "";
check(item, "в widget.js нет dayItem");
check(/<\/span>\$\{markAtHtml\(h\)\}\$\{name\}/.test(item), "время не сразу за галочкой перед названием");
// Склеим строку, как dayItem: галочка ✓, время, название.
const row = `<span class="mark done">✓</span>${done}<span class="t">Зарядка</span>`.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
check(row === "✓ 21:14 Зарядка", `строка читается не «✓ 21:14 Зарядка»: «${row}»`);

// Вид: мелко, постоянной ширины; при наведении ничего не меняется.
const rule = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));
const base = rule.find((r) => r.sel === ".w .list li.habit .mark-at");
check(base && /flex: none/.test(base.body) && /tabular-nums/.test(base.body) && /white-space: nowrap/.test(base.body), "время не постоянной ширины");
check(!rule.some((r) => /mark-at/.test(r.sel) && /:hover|:focus/.test(r.sel)), "у времени есть правило наведения");

// ПКМ «Закончить»: тот же запрос, новый текст.
const edit = widget.match(/async function editHabit\(h, act, li\) \{[^]*?\n\}/)?.[0] ?? "";
check(/act === "finish" \? \{ finish: true \}/.test(edit), "«Закончить» шлёт не {finish:true}");
check(/«Завершённых»/.test(edit), "текст «Закончить» не говорит про «Завершённые» на сайте");
check(!/В истории она осталась/.test(edit), "остался старый текст «В истории она осталась»");
check(/⏸ Закончить привычку/.test(widget), "пропал пункт «⏸ Закончить привычку»");

// Стенды показывают время у сделанной привычки.
const fake = fs.readFileSync(path.join(root, "test", "stress", "fake-server.cjs"), "utf8");
check(/"Пить воду", status: "done", streak: 12, at_time: "\d\d:\d\d"/.test(fake), "у стенда desktop/test/stress нет at_time");
check(/hb\.at_time = hb\.status \? hm\(srv\.now\(\)\) : null/.test(fake), "стенд не ставит at_time при отметке");
const stub = fs.readFileSync(path.join(root, "..", "server", "preview", "stub.js"), "utf8");
check(/"Пить воду", status: "done", streak: 12, at_time: "\d\d:\d\d"/.test(stub), "у витрины server/preview нет at_time");

console.log(bad ? `${bad} из ${n} не прошли` : `OK: ${n} проверок: «✓ 21:14» у сделанной привычки, «Закончить» → «Завершённые»`);
process.exit(bad ? 1 : 0);
