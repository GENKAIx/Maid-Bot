// Кольцо свёрнутой карточки (widget.js: miniRing и renderMini) без Electron и браузера.
// 26.11.2026, одобрено владельцем: дробь «11/27» в кольце не влезала и повторяла строку слева — цифр в кольце больше нет,
// только дуга сделанного; всё сделано — полное кольцо и ✓ внутри; дел нет — пустое бледное кольцо без знака (кнопка того же
// размера, ширина не прыгает). Числа остаются в подсказке и aria-label кнопки: «Сделано 11 из 27 · развернуть панель».
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, "renderer", f), "utf8");
const widget = read("widget.js"), css = read("style.css"), html = read("widget.html");

const ring = widget.match(/\nfunction miniRing\([^]*?\n\}/)?.[0];
check(ring, "нет miniRing в widget.js");
const ctx = {};
vm.createContext(ctx);
try { vm.runInContext(`${ring ?? ""}\nthis.ring = miniRing;`, ctx); } catch (e) { check(false, `код не разобрался: ${e?.message ?? e}`); }

if (ctx.ring) {
  const R = (d, t) => ctx.ring(d, t);
  let r = R(11, 27);
  check(r.mark === "" && !r.full && !r.empty, `11 из 27 — в кольце знак или не тот вид: ${JSON.stringify(r)}`);
  check(Math.abs(r.part - 11 / 27) < 1e-9, `доля дуги: ${r.part}`);
  check(r.label === "Сделано 11 из 27", `подсказка: ${r.label}`);
  r = R(1, 24);
  check(r.mark === "" && r.label === "Сделано 1 из 24", `1 из 24: ${JSON.stringify(r)}`);
  check(!/\d/.test(R(11, 27).mark + R(1, 24).mark + R(0, 5).mark + R(24, 24).mark), "в кольце снова цифры");
  r = R(24, 24);
  check(r.full && r.mark === "✓" && r.part === 1 && !r.empty, `всё сделано — полное кольцо с ✓: ${JSON.stringify(r)}`);
  check(r.label === "Сделано 24 из 24", `всё сделано, подсказка: ${r.label}`);
  r = R(0, 0);
  check(r.empty && r.mark === "" && r.part === 0 && !r.full && r.label === "", `дел нет — пустое кольцо без знака: ${JSON.stringify(r)}`);
  r = R(0, 5);
  check(!r.empty && !r.full && r.part === 0 && r.mark === "", `ничего не сделано: ${JSON.stringify(r)}`);
  r = R(7, 5); // гонка перерисовки: сделано больше, чем всего, — не больше полного
  check(r.part === 1 && r.full, `сделано больше всего: ${JSON.stringify(r)}`);
}

// renderMini ставит кольцо из miniRing, без дроби; подсказка и aria-label — с числами.
const mini = widget.match(/\nfunction renderMini\([^]*?\n\}/)?.[0] ?? "";
check(/miniRing\(done, done \+ left\)/.test(mini), "renderMini не берёт кольцо из miniRing");
check(!/\$\{done\}\/\$\{total\}/.test(mini), "renderMini снова пишет дробь в кольцо");
check(/#miniCount"\)\.textContent = ring\.mark/.test(mini), "в кольцо пишется не ring.mark");
check(/setAttribute\("aria-label"/.test(mini) && /ring\.label/.test(mini), "у кнопки кольца нет aria-label с числами");
check(/classList\.toggle\("full", ring\.full\)/.test(mini) && /classList\.toggle\("empty", ring\.empty\)/.test(mini), "кнопка кольца не знает «всё сделано» / «дел нет»");

// Размер кнопки задан жёстко (ширина карточки не прыгает), пустой знак не занимает места, «дел нет» — бледное кольцо.
check(/\.mini \.mini-open \{[^}]*width: 42px; height: 42px;[^}]*flex: none/.test(css), "кнопка кольца не фиксированного размера");
check(/\.mini-count:empty \{ display: none; \}/.test(css), "пустой знак в кольце не спрятан");
check(/\.mini-open\.empty \.mini-ring \{ opacity:/.test(css), "дел нет — кольцо не бледнеет");
check(/\.mini-open\.empty \.mini-ring \.arc \{ stroke-linecap: butt; \}/.test(css), "нет дел — у пустой дуги нет круглой точки сверху");
check(/id="miniOpen"[^>]*aria-label=/.test(html), "у кнопки кольца в разметке нет aria-label");

console.log(`${n - bad}/${n}`);
process.exit(bad ? 1 : 0);
