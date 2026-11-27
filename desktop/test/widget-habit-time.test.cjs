// Время отметки у привычки и текст «Закончить привычку» без Electron и браузера. С 26.11.2026 виджет показывал «✓ 21:14 Зарядка»;
// 27.11.2026 пользователь решил: в виджете времени нет, оно только в полной версии (сайт, «Сегодня»). Сервер по-прежнему отдаёт
// at_time в /api/today (стенды тоже), виджет его не читает. ПКМ «⏸ Закончить привычку» говорит, что привычка теперь на сайте
// в «Завершённых».
const fs = require("fs");
const path = require("path");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const root = path.join(__dirname, "..");
const widget = fs.readFileSync(path.join(root, "renderer", "widget.js"), "utf8");
const css = fs.readFileSync(path.join(root, "renderer", "style.css"), "utf8").replace(/\/\*[^]*?\*\//g, "");

// 27.11.2026 (решение пользователя): в виджете времени отметки нет — оно только в полной версии (сайт, «Сегодня», Today.tsx).
// Строка привычки в виджете: галочка, сразу за ней название — «✓ Зарядка».
const item = widget.match(/const dayItem = \(h\) => \{[^]*?\n  \};/)?.[0] ?? "";
check(item, "в widget.js нет dayItem");
check(/<\/span>\$\{name\}/.test(item), "за галочкой не сразу название");
check(!/at_time/.test(widget), "виджет читает at_time — время отметки снова показывается");
check(!/markAtHtml|mark-at/.test(widget), "в widget.js осталось время отметки (markAtHtml / mark-at)");
check(!/mark-at/.test(css), "в style.css остался стиль времени отметки .mark-at");
const site = fs.readFileSync(path.join(root, "..", "web", "src", "screens", "Today.tsx"), "utf8");
check(/habit-at/.test(site) && /h\.at_time/.test(site), "на сайте («Сегодня») пропало время отметки");

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

console.log(bad ? `${bad} из ${n} не прошли` : `OK: ${n} проверок: в виджете у привычки нет времени отметки (оно на сайте), «Закончить» → «Завершённые»`);
process.exit(bad ? 1 : 0);
