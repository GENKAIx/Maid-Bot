// Недописанный текст переходит между строкой свёрнутой карточки (#miniInput) и чатом панели (#chatInput).
// 19.11.2026: начал печатать в свёрнутом виде, развернул — текст пропал: у карточки и панели были две отдельные строки.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const src = fs.readFileSync(path.join(__dirname, "..", "renderer", "widget.js"), "utf8");
const fn = (name) => src.match(new RegExp(`\\nfunction ${name}\\([^]*?\\n\\}\\r?\\n`))?.[0] ?? "";
try {
  const code = fn("moveDraft");
  check(code, "в widget.js нет moveDraft");
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${code}\nthis.moveDraft = moveDraft;`, ctx);
  const { moveDraft } = ctx;

  // Печатал в карточке, развернул — текст в чате панели, строка карточки пустая.
  let d = moveDraft(false, "", "купить молоко");
  check(d.chat === "купить молоко" && d.mini === "", `развернул: ${JSON.stringify(d)}`);
  // Печатал в панели, свернул — текст в строке карточки.
  d = moveDraft(true, "позвонить маме", "");
  check(d.mini === "позвонить маме", `свернул: ${JSON.stringify(d)}`);
  // Несколько строк: в карточке одной строкой, а развернул не трогая — переносы на месте.
  d = moveDraft(true, "раз\nдва", "");
  check(d.mini === "раз два", `в карточке одной строкой: ${JSON.stringify(d)}`);
  d = moveDraft(false, "раз\nдва", d.mini);
  check(d.chat === "раз\nдва" && d.mini === "", `переносы сохранились: ${JSON.stringify(d)}`);
  // В карточке дописал — в панели уже новый текст.
  d = moveDraft(false, "раз\nдва", "раз два три");
  check(d.chat === "раз два три", `дописанное в карточке: ${JSON.stringify(d)}`);
  // Отправил из карточки (строка пустая) — в панели не остаётся старого черновика.
  d = moveDraft(false, "старое", "");
  check(d.chat === "", `после отправки из карточки: ${JSON.stringify(d)}`);

  // Перенос делает setCollapsed — ею сворачивают и разворачивают все кнопки и двойной щелчок.
  check(/moveDraft\(/.test(fn("setCollapsed")), "setCollapsed не переносит черновик");
} catch (e) {
  n++; bad++;
  console.log("FAIL", e.message);
}
console.log(`${n - bad}/${n} проверок`);
if (bad) process.exit(1);
