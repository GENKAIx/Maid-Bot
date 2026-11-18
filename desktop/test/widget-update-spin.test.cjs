// Шестерёнка обновления в ряду оповещений (inbox.js: updateBadge, drawInbox) без Electron и браузера.
// 18.11.2026: пока программа качает новую версию, шестерёнка крутится и справа от неё — сколько скачалось («59 %»);
// раньше значок стоял неподвижно, а процент был виден только в «Настройках» и в облачке по щелчку.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const dir = path.join(__dirname, "..", "renderer");
const inbox = fs.readFileSync(path.join(dir, "inbox.js"), "utf8");
const css = fs.readFileSync(path.join(dir, "style.css"), "utf8");
const fn = (name) => inbox.match(new RegExp(`\\nfunction ${name}\\([^]*?\\n\\}\\r?\\n`))?.[0] ?? "";
check(fn("updateBadge"), "в inbox.js нет updateBadge");
check(/updateBadge\(/.test(fn("drawInbox")), "drawInbox не зовёт updateBadge");
check(/\.ib\.busy img \{[^}]*animation: ibSpin/.test(css) && /@keyframes ibSpin/.test(css), "в style.css нет вращения шестерёнки (.ib.busy img, ibSpin)");
check(/prefers-reduced-motion[^]*\.ib\.busy img \{ animation: none/.test(css), "«меньше движения» — шестерёнка не крутится");

const ctx = {};
vm.createContext(ctx);
try {
  vm.runInContext(`${fn("updateBadge")}\nthis.updateBadge = updateBadge;`, ctx);
  const b = (s) => JSON.stringify(ctx.updateBadge(s));
  check(b({ status: "available", next: "0.1.70" }) === JSON.stringify({ busy: false, pct: "" }), `есть новая, не качается — стоит: ${b({ status: "available" })}`);
  check(b({ status: "downloading", percent: 0 }) === JSON.stringify({ busy: true, pct: "0 %" }), `качается с нуля: ${b({ status: "downloading", percent: 0 })}`);
  check(b({ status: "downloading", percent: 59 }) === JSON.stringify({ busy: true, pct: "59 %" }), `качается: ${b({ status: "downloading", percent: 59 })}`);
  check(b({ status: "downloading" }) === JSON.stringify({ busy: true, pct: "" }), `процент ещё не пришёл — крутится без числа: ${b({ status: "downloading" })}`);
  check(b({ status: "ready", percent: 100 }) === JSON.stringify({ busy: true, pct: "100 %" }), `скачано, ставится: ${b({ status: "ready", percent: 100 })}`);
  check(b(null) === JSON.stringify({ busy: false, pct: "" }), "обновления нет");
} catch (e) {
  n++; bad++;
  console.log("FAIL", e.message);
}
console.log(`${n - bad}/${n} проверок`);
if (bad) process.exit(1);
