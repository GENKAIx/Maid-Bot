// Сообщение «обновилась» после установки новой версии (main.js: updatedFrom; widget.js: maid.on("updated")) без Electron.
// 17.11.2026: после обновления программа запускалась молча — непонятно, поставилось ли. Теперь main помнит версию прошлого
// запуска (settings.lastVersion): запустилась версия новее — один раз шлёт виджету «updated», и горничная говорит
// «Я обновилась до 0.1.58 ✨» (несколько вариантов, lines.js). Первая установка — молча; старые установки без lastVersion
// узнают обновление по флагу --updated, который ставит установщик.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const root = path.join(__dirname, "..");
const main = fs.readFileSync(path.join(root, "src", "main.js"), "utf8");
const preload = fs.readFileSync(path.join(root, "src", "preload.js"), "utf8");
const widget = fs.readFileSync(path.join(root, "renderer", "widget.js"), "utf8");
const lines = fs.readFileSync(path.join(root, "renderer", "lines.js"), "utf8");

const src = main.match(/\nfunction updatedFrom\([^]*?\n\}\r?\n/)?.[0];
check(src, "в main.js нет updatedFrom");
try {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${src ?? ""}\nthis.f = updatedFrom;`, ctx);
  check(ctx.f("0.1.57", "0.1.58", false) === "0.1.57", "обновление 0.1.57 → 0.1.58 не замечено");
  check(ctx.f("0.1.9", "0.1.10", false) === "0.1.9", "0.1.9 → 0.1.10 сравнено как строки");
  check(ctx.f("0.1.58", "0.1.58", false) === null, "тот же запуск — «обновилась»");
  check(ctx.f("0.1.58", "0.1.57", false) === null, "откат на старую — «обновилась»");
  check(ctx.f("", "0.1.58", false) === null, "первая установка — «обновилась»");
  check(ctx.f("", "0.1.58", true) === "", "старая установка без lastVersion: обновление по флагу --updated не замечено");
} catch (e) {
  check(false, `updatedFrom оборвался: ${e?.stack ?? e}`);
}
check(/lastVersion/.test(main) && /send\("updated"/.test(main), "main не помнит версию или не сообщает виджету");
check(/"updated"/.test(preload.match(/on: \(channel, fn\)[^]*?\]/)?.[0] ?? ""), "виджет не может слушать «updated» (preload)");
check(/maid\.on\("updated"/.test(widget) && /line\("updated"/.test(widget), "виджет не говорит про обновление");
const ctxL = { localStorage: { getItem: () => null, setItem() {} }, Math, Date, JSON };
vm.createContext(ctxL);
vm.runInContext(`${lines}\nthis.L = LINES;`, ctxL);
const v = ctxL.L.updated ?? [];
check(v.length >= 3 && v.every((x) => x.t.includes("{v}")), `вариантов «обновилась» мало или без номера версии: ${v.length}`);
console.log(`${n - bad}/${n}`);
process.exit(bad ? 1 : 0);
