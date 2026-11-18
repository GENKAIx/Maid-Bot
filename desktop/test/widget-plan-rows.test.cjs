// Строки плана в облачке (widget.js: planRows) без Electron и браузера.
// 18.11.2026: облачко «Завтра» было сплошным текстом «• 19:00 — Продать…». Теперь подряд идущие строки «• время — название»
// и «• весь день — название» — одна сетка: время колонкой слева, название справа; остальной текст — как был.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const widget = fs.readFileSync(path.join(__dirname, "..", "renderer", "widget.js"), "utf8");
const fn = (name) => widget.match(new RegExp(`\\nfunction ${name}\\([^]*?\\n\\}\\r?\\n`))?.[0] ?? "";
check(fn("planRows"), "в widget.js нет planRows");
check(/tgHtml\(plain\)\)/.test(widget) && /planRows\(tgHtml\(plain\)\)/.test(widget), "say: текст облачка не проходит через planRows");

const ctx = {};
vm.createContext(ctx);
try {
  vm.runInContext(`${fn("planRows")}\nthis.planRows = planRows;`, ctx);
  const html = ctx.planRows("🌙 Хозяин, вот ваши планы на завтра.\nЧетверг, 19 ноября\n• весь день — Листинг акций\n• 13:00–14:00 — Обед\n• 19:00 — Продать &lt;акции&gt;");
  check(html.startsWith("🌙 Хозяин, вот ваши планы на завтра.\nЧетверг, 19 ноября"), `шапка — как была: ${html}`);
  check((html.match(/class="plan-list"/g) ?? []).length === 1, `строки плана — одна сетка: ${html}`);
  check(/<b class="plan-t allday">весь день<\/b><span class="plan-x">Листинг акций<\/span>/.test(html), `весь день: ${html}`);
  check(/<b class="plan-t">13:00–14:00<\/b><span class="plan-x">Обед<\/span>/.test(html), `промежуток времени: ${html}`);
  check(/Продать &lt;акции&gt;/.test(html), "экранированное остаётся экранированным");
  check(!/Чт|• /.test(html), `точки списка убраны: ${html}`);
  // Сетка — блок: перевод строки перед ней и между строками убран, иначе в pre-wrap — пустые строки.
  check(/19 ноября<span class="plan-list">/.test(html) && !/plan-list">[^]*\n/.test(html), `лишних переводов строки вокруг сетки нет: ${html}`);
  // После сетки — обычный текст снова с новой строки, без пустой строки.
  const after = ctx.planRows("• 10:00 — А\nИ ещё текст");
  check(/<\/span>И ещё текст$/.test(after), `текст после сетки: ${after}`);
  // Обычный текст и строки с точкой без времени не трогаются.
  const plain = "Записала.\n• купить хлеб\n• 10 яиц — не забудь";
  check(ctx.planRows(plain) === plain, `обычный список не трогается: ${ctx.planRows(plain)}`);
} catch (e) {
  n++; bad++;
  console.log("FAIL", e.message);
}
console.log(`${n - bad}/${n} проверок`);
if (bad) process.exit(1);
