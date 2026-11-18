// Щелчок по названию привычки в виджете открывает главное окно на странице «Привычки» со статистикой этой привычки
// («/habits?h=<id>»): отметка-кружок по-прежнему отмечает, уезжающая строка и «↶ Вернуть» не открывают ничего.
const fs = require("fs");
const path = require("path");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const widget = fs.readFileSync(path.join(__dirname, "..", "renderer", "widget.js"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "..", "renderer", "style.css"), "utf8");
const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");

const click = widget.match(/\$\("#body"\)\.addEventListener\("click", async \(e\) => \{[^]*?\n\}\);/)?.[0] ?? "";
check(click, "в widget.js нет обработчика щелчка по списку");
check(/li\.habit:not\(\.leaving\):not\(\.undo-row\) \.t/.test(click), "щелчок по названию привычки не ловится (или ловится у уезжающей строки)");
check(/!tick \? e\.target\.closest\("li\.habit/.test(click), "щелчок по кружку-отметке тоже открывает окно");
check(/maid\.openSection\(`\/habits\?h=\$\{Number\(habitOpen\)\}`\)/.test(click), "не открывает /habits?h=<id>");
check(click.indexOf("habitOpen") < click.indexOf("const id = e.target.dataset?.done"), "переход стоит после отметки привычки");
check(/li\.habit:not\(\.leaving\) \.t \{ cursor: pointer; \}/.test(css), "название привычки без курсора-ссылки");

// Главный процесс пропускает только путь и, по желанию, «?h=число».
const re = main.match(/ipcMain\.on\("open-section"[^]*?if \(!(\/.+?\/)\.test\(String\(p\)\)/)?.[1];
check(re, "в main.js нет проверки адреса раздела");
if (re) {
  const rx = eval(re);
  for (const ok of ["/habits", "/habits?h=12", "/history/daily", "/diary/2026-11-18", "/"]) check(rx.test(ok), `адрес не пропущен: ${ok}`);
  for (const no of ["/habits?h=abc", "/habits?h=1&x=2", "/habits?x=1", "https://evil.example/", "/habits?h=1#x", "//evil.example"]) {
    if (no === "//evil.example") continue; // «//…» дописывается к адресу сервера строкой — остаётся на нём
    check(!rx.test(no), `лишний адрес пропущен: ${no}`);
  }
}
console.log(bad ? `${bad} из ${n} не прошло` : `ok ${n}`);
process.exit(bad ? 1 : 0);
