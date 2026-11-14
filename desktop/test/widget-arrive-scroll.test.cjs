// Въезд новой задачи (scrollToArrival из widget.js) на поддельном списке, без Electron и браузера.
// 15.11.2026: задач больше, чем помещается, — новая встаёт ниже видимой части, и въезд с бликом играл за краем: казалось,
// что анимации нет. Список должен докрутиться к новой задаче один раз, а перерисовки во время въезда не дёргают прокрутку.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const src = fs.readFileSync(path.join(__dirname, "..", "renderer", "widget.js"), "utf8");
const m = src.match(/\nfunction scrollToArrival\(\) \{[^]*?\n\}\r?\n/);
check(Boolean(m), "в widget.js нет scrollToArrival");

let rows = [];
const scrolled = [];
const row = (id) => ({ dataset: { arrive: String(id) }, scrollIntoView: (o) => scrolled.push({ id, o }) });
const body = { querySelectorAll: (s) => (s === "li.arrive" ? rows : []) };
const ctx = { $: () => body, arriveScrolled: new Set() };
vm.createContext(ctx);
try {
  vm.runInContext(m?.[0] ?? "", ctx);
  rows = [row(7)];
  ctx.scrollToArrival();
  check(scrolled.length === 1 && scrolled[0].id === 7, `к новой задаче не докрутило: ${JSON.stringify(scrolled)}`);
  check(scrolled[0]?.o?.block === "nearest", "докрутка не «nearest» — дёргает список, даже когда задача и так видна");
  ctx.scrollToArrival(); // перерисовка во время въезда
  check(scrolled.length === 1, `перерисовка снова крутит список: ${scrolled.length}`);
  rows = [row(7), row(8)];
  ctx.scrollToArrival();
  check(scrolled.length === 2 && scrolled[1].id === 8, "вторая новая задача не показана");
} catch (e) {
  check(false, `тест оборвался: ${e?.stack ?? e}`);
}
console.log(`${n - bad}/${n}`);
process.exit(bad ? 1 : 0);
