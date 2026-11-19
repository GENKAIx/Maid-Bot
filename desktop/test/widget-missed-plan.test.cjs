// Прошедший неотмеченный план в ленте «Дальше» (widget.js, missedPlan и render) без Electron и браузера.
// 19.11.2026: план «19:00 Продать акции» через 30 мин после начала пропадал из ленты, хотя галочку не поставили, —
// в ленте оставалось одно «Дальше: пт 20 …», будто планов не было. Теперь самый поздний такой план остаётся первой
// бледной строкой «19:00 · Название · прошёл» с ✓ «Сделано» (кнопки «Не было» нет — так решил пользователь), до отметки
// или конца дня. Отмеченный (сделан, ✓ или «Окей») уходит, как раньше.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const root = path.join(__dirname, "..");
const widget = fs.readFileSync(path.join(root, "renderer", "widget.js"), "utf8");
const css = fs.readFileSync(path.join(root, "renderer", "style.css"), "utf8");

const pick = (re, what) => { const s = widget.match(re)?.[0]; check(s, `в widget.js нет ${what}`); return s ?? ""; };
const src = [
  pick(/\nfunction planStart\([^]*?\n\}/, "planStart"),
  pick(/\nfunction minutesUntil\([^]*?\n\}/, "minutesUntil"),
  pick(/\nconst ackKey = .*/, "ackKey"),
  pick(/\nfunction missedPlan\([^]*?\n\}/, "missedPlan"),
].join("\n");
try {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${src}\nthis.f = missedPlan;`, ctx);
  // План, начавшийся ago минут назад, — сегодня (тест в первые минуты суток не гоняют: время сдвинулось бы на вчера).
  const at = (id, ago, extra = {}) => {
    const t = new Date(Date.now() - ago * 60000);
    const p = (x) => String(x).padStart(2, "0");
    return { id, title: `п${id}`, date_iso: `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`, time: `${p(t.getHours())}:${p(t.getMinutes())}`, status: "active", ...extra };
  };
  const late = new Date().getHours() * 60 + new Date().getMinutes() > 130;
  if (late) {
    const id = (e) => e?.id ?? null;
    check(id(ctx.f([at(1, 90)], {})) === 1, "прошедший неотмеченный план пропал");
    check(id(ctx.f([at(1, 10)], {})) === null, "план, начавшийся 10 мин назад, — не «прошёл» (он ещё в ленте)");
    check(id(ctx.f([at(1, 120), at(2, 60)], {})) === 2, "из двух прошедших — не самый поздний");
    check(id(ctx.f([at(2, 60), at(1, 120)], {})) === 2, "самый поздний зависит от порядка");
    check(id(ctx.f([at(1, 90, { status: "done" })], {})) === null, "сделанный план всё ещё «прошёл»");
    const e = at(1, 90);
    check(id(ctx.f([e], { [`${e.date_iso}:1`]: "ok" })) === null, "план с ответом (✓ или «Окей») всё ещё «прошёл»");
    check(id(ctx.f([e], { [`${e.date_iso}:1`]: Date.now() - 5000 })) === 1, "отложенный «⏰» и забытый план пропал");
    check(id(ctx.f([at(1, 90, { time: null })], {})) === null, "план без времени — «прошёл»");
  } else console.log("первые 2 ч суток — проверки по времени пропущены");
} catch (e) {
  check(false, `missedPlan оборвался: ${e?.stack ?? e}`);
}

const render = widget.match(/\nfunction render\(\) \{[^]*?\n\}\r?\n/)?.[0] ?? "";
check(/missedPlan\(data\.events, planAcks\)/.test(render), "render не берёт прошедший план");
check(/nx-missed/.test(render) && /прошёл/.test(render), "в ленте нет строки «прошёл»");
check(!/data-act="skip"|Не было/.test(render), "кнопка «Не было» (пользователь её не хотел)");
// ✓ на строке «прошёл» — тот же обработчик, что у горящей плашки: отметка «сделано» на сервере.
const click = widget.match(/\$\("#next"\)\.addEventListener\("click"[^]*?\n\}\);/)?.[0] ?? "";
check(/closest\("\.nx\[data-id\]"\)/.test(click), "✓ строки «прошёл» не находит свой план");
check(/\.nx-missed\b/.test(css), "нет стиля строки «прошёл»");

console.log(`${n - bad}/${n}`);
process.exit(bad ? 1 : 0);
