// Скрипты окна (widget.html, index.html…) делят одну глобальную область: одинаковое имя const/let/class в двух файлах —
// SyntaxError, второй файл не выполняется целиком, и виджет падает при загрузке (11.11.2026: taskWord в clock.js и fun.js —
// пустая панель и «--:--»). Здесь скрипты каждой страницы склеиваются по порядку и компилируются одним куском —
// такой повтор даёт ту же ошибку разбора.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const dir = path.join(__dirname, "..", "renderer");
let bad = 0, n = 0;
for (const page of fs.readdirSync(dir).filter((f) => f.endsWith(".html"))) {
  const html = fs.readFileSync(path.join(dir, page), "utf8");
  const files = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]).filter((f) => !/^https?:/.test(f));
  if (files.length < 2) continue;
  n++;
  const code = files.map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n;\n");
  try {
    new vm.Script(code, { filename: page });
  } catch (e) {
    bad++;
    console.log(`FAIL ${page} (${files.join(", ")}): ${e.message}`);
  }
}
console.log(bad ? `${bad} из ${n} страниц с повтором имён` : `OK: ${n} страниц без повторов глобальных имён`);
process.exit(bad ? 1 : 0);
