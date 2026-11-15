// Порядок и число задач в списке виджета (taskOrder, TASKS_STEP из widget.js) без Electron и браузера.
// 15.11.2026: новые задачи без срока вставали в конец и уходили под обрезку «Сколько задач» (4/6/10 строк) — казалось, что
// задачи из Telegram не приходят, а счёт «Задачи · 15» не сходился со списком. Теперь: просроченные и на сегодня сверху,
// дальше новые сверху; по умолчанию до 100 строк, кнопка «Ещё» — следующие 100.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const src = fs.readFileSync(path.join(__dirname, "..", "renderer", "widget.js"), "utf8");
const order = src.match(/\nfunction taskOrder\(a, b\) \{[^]*?\n\}\r?\n/);
const step = src.match(/\nconst TASKS_STEP = (\d+);/);
check(Boolean(order), "в widget.js нет taskOrder");
check(step && Number(step[1]) === 100, "в widget.js нет TASKS_STEP = 100");
check(/taskCount: 100\b/.test(src), "по умолчанию не 100 задач");
check(!/innerHeight - 760/.test(src), "осталась прежняя прибавка строк от высоты панели");

const ctx = {
  data: { day: "2026-11-15" },
  overdue: (t) => Boolean(t.due_date) && t.due_date < "2026-11-15",
  wokeFresh: (t) => t.woke === true,
};
vm.createContext(ctx);
try {
  vm.runInContext(order?.[0] ?? "", ctx);
  const t = (id, due_date = null, extra = {}) => ({ id, title: `t${id}`, due_date, priority: "normal", ...extra });
  const list = [t(1), t(2, "2026-11-20"), t(3, "2026-11-10"), t(4, "2026-11-15"), t(5), t(6, null, { priority: "high" }), t(7, "2026-11-12"), t(8, "2026-11-22", { woke: true })];
  const ids = [...list].sort(ctx.taskOrder).map((x) => x.id);
  check(JSON.stringify(ids) === JSON.stringify([3, 7, 8, 4, 6, 5, 2, 1]), `порядок задач: ${ids}`);
} catch (e) {
  check(false, `тест оборвался: ${e?.stack ?? e}`);
}
console.log(`${n - bad}/${n}`);
process.exit(bad ? 1 : 0);
