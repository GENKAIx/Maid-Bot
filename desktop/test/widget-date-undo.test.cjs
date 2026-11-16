// Убранная важная дата в панели дня (clock.js: toggleDate, pinCard) без Electron и браузера.
// 16.11.2026: × у даты оставлял её зачёркнутой с ↺ до закрытия панели — зачёркнутый «ДР мамы» читался как «день рождения
// отменили». Теперь карточка улетает, на её месте DATE_UNDO мс строка «Убрала · ДР мамы» с кнопкой «Вернуть», потом строка
// смыкается. Зачёркивания и ↺ у дат больше нет.
const fs = require("fs");
const path = require("path");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const dir = path.join(__dirname, "..", "renderer");
const clock = fs.readFileSync(path.join(dir, "clock.js"), "utf8");
const css = fs.readFileSync(path.join(dir, "style.css"), "utf8");

const pin = clock.match(/const pinCard = \(d\) => \{[^]*?\n  \};/)?.[0] ?? "";
check(pin, "в clock.js нет pinCard");
check(!/cancelled/.test(pin) && !/↺/.test(pin), "убранная дата всё ещё зачёркнута с ↺");
check(/Вернуть<\/button>/.test(pin) && /Убрала/.test(pin), "на месте убранной даты нет «Убрала · … Вернуть»");
check(/const DATE_UNDO = 5000;/.test(clock), "«Вернуть» держится не 5 с (DATE_UNDO)");
const toggle = clock.match(/\nfunction toggleDate\([^]*?\n\}\r?\n/)?.[0] ?? "";
check(/setTimeout\([^]*DATE_UNDO/.test(toggle), "строка «Вернуть» не уходит сама");
check(/animate\(/.test(toggle) && /prefers-reduced-motion/.test(toggle), "карточка не улетает (или улетает и при «уменьшить движение»)");
// Панель закрыли — таймеры строк «Вернуть» сняты, дата остаётся убранной.
const hide = clock.match(/\nfunction hideClock\([^]*?\n\}\r?\n/)?.[0] ?? "";
check(/dateUndo/.test(hide), "закрытие панели не снимает таймеры «Вернуть»");
check(!/\.pl-x\.back/.test(css) && !/\.pl-date\.cancelled/.test(css), "остались стили ↺ и зачёркнутой даты");

console.log(`${n - bad}/${n}`);
process.exit(bad ? 1 : 0);
