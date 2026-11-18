// Из виджета — только в полную версию на ПК, не в браузер (widget.js, preload.js, main.js) — по тексту, без Electron.
// 18.11.2026: кнопки дней под ответом («📅 17 ноября») звали open-day — main.js открывал сайт в браузере Windows.
// Теперь день открывается в главном окне (openSection("/diary/<день>")), а open-day удалён целиком.
const fs = require("fs");
const path = require("path");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const read = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");
const widget = read("renderer", "widget.js");
const preload = read("src", "preload.js");
const main = read("src", "main.js");

check(/el\.onclick = \(\) => maid\.openSection\(`\/diary\/\$\{d\}`\)/.test(widget), "кнопка дня под ответом не открывает день в полной версии (openSection)");
check(!/openDay/.test(widget) && !/openDay/.test(preload), "в виджете или preload остался openDay");
check(!/"open-day"/.test(main), "в main.js остался обработчик open-day (браузер)");
// openExternal — только для ссылок «в новом окне» из главного окна (setWindowOpenHandler), не для виджета.
const ext = main.match(/openExternal/g) ?? [];
check(ext.length === 1 && /setWindowOpenHandler\(\(\{ url \}\) => \{\s*if \(\/\^https\?:\\\/\\\/\/\.test\(url\)\) void shell\.openExternal\(url\)/.test(main),
  `openExternal в main.js — только у главного окна: ${ext.length}`);
console.log(`${n - bad}/${n} проверок`);
if (bad) process.exit(1);
