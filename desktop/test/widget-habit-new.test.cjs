// Курс в списке виджета и новая привычка (widget.js, dayItem) без Electron и браузера.
// 16.11.2026: только что заведённый курс «Пить максилак» показывал «1/10» с полоской — это был номер дня курса, а читалось как
// «сделано 1 из 10», хотя ничего не отмечено. Теперь справа — сделано из запланированного (stats из course.js), номер дня —
// в подсказке. И новая привычка въезжает в список с бликом, как новая задача (li.arrive).
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const dir = path.join(__dirname, "..", "renderer");
const widget = fs.readFileSync(path.join(dir, "widget.js"), "utf8");
const course = fs.readFileSync(path.join(dir, "course.js"), "utf8");
const css = fs.readFileSync(path.join(dir, "style.css"), "utf8");

// Счёт курса — из stats (сделано / всего по расписанию), а не номер дня.
const item = widget.match(/const dayItem = \(h\) => \{[^]*?\n  \};/)?.[0] ?? "";
check(item, "в widget.js нет dayItem");
check(!/\$\{i \+ 1\}\/\$\{h\.course\.length\}/.test(item), "у курса справа всё ещё номер дня («1/10»)");
check(/stats\(h\)/.test(item), "счёт курса не из stats (сделано из запланированного)");
check(/день \$\{/.test(item), "номер дня курса пропал и из подсказки");

const statsSrc = course.match(/\nfunction stats\(h\) \{[^]*?\n\}/)?.[0];
check(statsSrc, "в course.js нет stats");
try {
  const ctx = { data: { day: "2026-11-16" } };
  vm.createContext(ctx);
  vm.runInContext(statsSrc ?? "", ctx);
  const days = (from, marks) => Array.from({ length: 10 }, (_, k) => ({ day: `2026-11-${String(16 + k - from).padStart(2, "0")}`, s: marks[k] ?? "wait" }));
  const fresh = ctx.stats({ course: days(0, ["today"]) });
  check(fresh.done === 0 && fresh.total === 10 && fresh.dayNo === 1, `новый курс: ${JSON.stringify(fresh)}`);
  const mid = ctx.stats({ course: days(2, ["done", "miss", "today"]) });
  check(mid.done === 1 && mid.dayNo === 3, `третий день курса: ${JSON.stringify(mid)}`);
} catch (e) {
  check(false, `stats оборвался: ${e?.stack ?? e}`);
}

// Новая привычка — как новая задача: строка с классом arrive, свой учёт появившихся, первая загрузка без анимации.
check(/const habitArriveAt = new Map\(\);/.test(widget), "нет учёта новых привычек (habitArriveAt)");
check(/class="habit[^"]*\$\{[^}]*arrive/.test(item) || /arrive/.test(item), "строка новой привычки без въезда (arrive)");
check(/\.w \.list li\.arrive \.mark/.test(css), "у отметки новой привычки нет вспышки, как у галочки задачи");

console.log(`${n - bad}/${n}`);
process.exit(bad ? 1 : 0);
