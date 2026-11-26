// Облачко со списком напоминаний «Сегодня N» (inbox.js, openList) не меняет размеров при наведении (26.11.2026).
// Было: на строке подпись «срок был вчера» пряталась (display: none), на её месте вставал ✕ (display: inline-block) — строка
// становилась уже и на полпикселя выше, облачко (ширина по содержимому) сжималось и дёргалось, кнопки внизу ехали вместе с ним.
// Стало: место под ✕ есть всегда, ✕ только проявляется (visibility/opacity), срок виден. Замер на стенде (desktop/test/stress,
// getBoundingClientRect облачка, строк и кнопок до и при наведении) совпадал во всех трёх положениях виджета; здесь — правило
// CSS: hover/focus-правила этого облачка не трогают свойства, от которых меняется размер.
const fs = require("fs");
const path = require("path");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const css = fs.readFileSync(path.join(__dirname, "..", "renderer", "style.css"), "utf8").replace(/\/\*[^]*?\*\//g, "");

// Все правила: селектор → объявления (без @media: внутри них — свои правила, их разбираем так же, по внутренним скобкам).
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));
// Облачко списка: строки и вкладки (.ib-*), кнопки под ним (.bubble-actions / #bubbleActions — «Прочитать все», ✕ закрыть).
// Звёзды оценки дня — другое облачко (их увеличение при наведении задумано), его не трогаем.
const inBubble = (sel) => /\.ib-(list|tabs|x|time|toast|readall)|\.bubble-actions|#bubbleActions|\.life/.test(sel) && !/rate-star/.test(sel);
const hover = rules.filter((r) => /:hover|:focus-visible|:focus-within/.test(r.sel) && inBubble(r.sel));
check(hover.length >= 5, `нашлось мало hover-правил облачка (${hover.length}) — разбор CSS сломался?`);
const SIZE = /(^|;)\s*(display|padding[\w-]*|margin[\w-]*|border(-(top|right|bottom|left))?(-width)?|font-weight|font-size|font|width|height|min-width|max-width|line-height|letter-spacing|gap|transform|scale|translate|zoom)\s*:/;
for (const r of hover) check(!SIZE.test(r.body), `«${r.sel}» при наведении меняет размер: ${r.body.trim()}`);
// border при наведении — только цвет (ширина та же, что без наведения).
for (const r of hover) check(!/border\s*:/.test(r.body), `«${r.sel}»: border целиком — только border-color`);

// ✕ на строке: место есть всегда, проявляется только видимость; срок не прячется.
const x = rules.find((r) => r.sel === ".ib-list .ib-x");
check(x && /display: inline-block/.test(x.body) && /visibility: hidden/.test(x.body) && /width: 20px/.test(x.body) && /height: 18px/.test(x.body), "✕ занимает место и без наведения");
check(!rules.some((r) => /\.ib-time/.test(r.sel) && /display:\s*none|visibility:\s*hidden/.test(r.body)), "подпись срока не прячется");
// ✕ — не выше строки: строка без наведения уже той же высоты (отрицательные поля по вертикали съедают разницу 18 px и строки 11 px).
check(x && /margin: -1px/.test(x.body), "✕ не раздвигает строку по высоте");

console.log(bad ? `${bad} из ${n} не прошли` : `OK: ${n} проверок: облачко напоминаний не меняет размеров при наведении`);
process.exit(bad ? 1 : 0);
