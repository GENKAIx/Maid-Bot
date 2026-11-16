// Важная дата в полосе дней (clock.js, dayStrip → .day-chip.has-date) без Electron и браузера.
// 16.11.2026: день с важной датой помечался жёлтой точкой в углу чипа — непонятно, что она значит. Теперь — золотая рамка
// вокруг всего дня; выбранный день с датой — та же рамка и сиреневое кольцо снаружи, видно оба признака.
const fs = require("fs");
const path = require("path");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const dir = path.join(__dirname, "..", "renderer");
const clock = fs.readFileSync(path.join(dir, "clock.js"), "utf8");
const css = fs.readFileSync(path.join(dir, "style.css"), "utf8");

check(/big\.length \? " has-date" : ""/.test(clock), "чип дня с важной датой без класса has-date");
check(!/\.day-chip\.has-date::after/.test(css), "у дня с важной датой всё ещё точка (::after)");
const rule = css.match(/\.day-chip\.has-date\s*\{([^}]*)\}/)?.[1] ?? "";
check(/border-color:\s*#ffc45c/.test(rule), "у дня с важной датой нет золотой рамки");
const on = css.match(/\.day-chip\.has-date\.on\s*\{([^}]*)\}/)?.[1] ?? "";
check(/border-color:\s*#ffc45c/.test(on) && /box-shadow:[^;]*var\(--accent/.test(on), "выбранный день с датой теряет рамку или не видно, что он выбран");

console.log(`${n - bad}/${n}`);
process.exit(bad ? 1 : 0);
