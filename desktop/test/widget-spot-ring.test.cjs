// Вспышка карточки в панели планов (style.css: .pl-card.spot, plSpot) — без браузера, по CSS.
// 18.11.2026: у верхней карточки не было верхней обводки — список .pl-list прокручивается (overflow) и срезает тень,
// выходящую за карточку. Обводка вспышки — внутренняя (inset): её не срезает ни край списка, ни прокрутка.
const fs = require("fs");
const path = require("path");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const css = fs.readFileSync(path.join(__dirname, "..", "renderer", "style.css"), "utf8");
const spot = css.match(/@keyframes plSpot \{[^]*?\n\}/)?.[0] ?? "";
check(spot, "в style.css нет @keyframes plSpot");
check(/overflow-y: auto/.test(css.match(/\n\.pl-list \{[^}]*\}/)?.[0] ?? ""), "список планов больше не прокручивается — проверку пересмотреть");
const ring = spot.match(/25% \{ box-shadow: ([^;]+);/)?.[1] ?? "";
check(/^inset 0 0 0 2px/.test(ring), `обводка вспышки — внутренняя (inset): ${ring}`);
for (const k of ["0%", "100%"]) {
  const s = spot.match(new RegExp(`${k} \\{ box-shadow: ([^;]+);`))?.[1] ?? "";
  const count = (x) => (x.match(/\binset\b/g) ?? []).length;
  check(count(s) === count(ring) && count(s) > 0, `${k}: столько же теней и тоже inset, иначе анимация прыгает: ${s}`);
}
const still = css.match(/#planClock \.pl-card\.spot \{ animation: none;[^}]*\}/)?.[0] ?? "";
check(/box-shadow: inset 0 0 0 2px/.test(still), `«меньше движения»: обводка тоже внутренняя: ${still}`);
console.log(`${n - bad}/${n} проверок`);
if (bad) process.exit(1);
