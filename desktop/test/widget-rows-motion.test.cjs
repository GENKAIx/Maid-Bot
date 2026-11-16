// Строки, что появились или ушли на глазах (widget.js: rowChanges, snapRows, settleRows) без Electron и браузера.
// 16.11.2026: новый план в блоке ближайших планов под часами появлялся рывком, прошедший или сделанный — молча пропадал,
// привычка, отменённая в чате, исчезала, новая важная дата над планами — тоже без анимации. Теперь: новое въезжает с бликом,
// оставшееся доезжает до нового места, ушедшее гаснет на старом месте; первая отрисовка и спрятанная панель — без анимации.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const dir = path.join(__dirname, "..", "renderer");
const widget = fs.readFileSync(path.join(dir, "widget.js"), "utf8");
const css = fs.readFileSync(path.join(dir, "style.css"), "utf8");

// Что появилось, что осталось, что ушло; only — уходят только эти ключи (привычки: удалённые, а не отмеченные и спрятанные).
const src = widget.match(/\nfunction rowChanges\([^]*?\n\}\r?\n/)?.[0];
check(src, "в widget.js нет rowChanges");
try {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${src ?? ""}\nthis.f = rowChanges;`, ctx);
  const r = ctx.f(new Set(["1", "2", "3"]), new Set(["2", "3", "4"]));
  check(JSON.stringify([[...r.added], [...r.kept], [...r.gone]]) === JSON.stringify([["4"], ["2", "3"], ["1"]]), `разбор строк: ${JSON.stringify([[...r.added], [...r.kept], [...r.gone]])}`);
  const only = ctx.f(new Set(["1", "2"]), new Set(["2"]), new Set(["9"]));
  check(only.gone.size === 0, "ушла строка, которой нет в списке удалённых (отмеченная привычка спряталась — это не удаление)");
  const empty = ctx.f(new Set(), new Set(["5"]));
  check(empty.added.has("5"), "первый план в пустом блоке не считается новым");
} catch (e) {
  check(false, `rowChanges оборвался: ${e?.stack ?? e}`);
}

// Снимок пропускает первую отрисовку и спрятанную панель (null — без анимации), а не «пустой блок».
const snap = widget.match(/\nfunction snapRows\([^]*?\n\}\r?\n/)?.[0] ?? "";
check(/return null/.test(snap) && /panelShown/.test(snap), "snapRows не отличает спрятанную панель и первую отрисовку");
check(/prefers-reduced-motion/.test(widget.match(/\nfunction settleRows\([^]*?\n\}\r?\n/)?.[0] ?? ""), "settleRows не слушает «меньше движения»");

// Где включено: планы под часами, важные даты над ними, удалённые привычки.
const render = widget.match(/\nfunction render\(\) \{[^]*?\n\}\r?\n/)?.[0] ?? "";
check(/snapRows\(\$\("#next"\)/.test(render) && /settleRows\(\$\("#next"\)/.test(render), "блок планов под часами без въезда и ухода");
check(/snapRows\(\$\("#pins"\)/.test(render) && /settleRows\(\$\("#pins"\)/.test(render), "важные даты над планами без появления");
check(/settleRows\(\$\("#body"\)[^;]*gone: habitsGone/.test(render), "удалённая привычка исчезает без анимации");
check(/return gone;/.test(widget.match(/\nfunction noteHabitArrivals\([^]*?\n\}\r?\n/)?.[0] ?? ""), "noteHabitArrivals не отдаёт удалённые привычки");

// Копия ушедшей строки встаёт внутрь блока (absolute) — блоку нужно position: relative.
check(/\.w \.next,\s*\.w \.scroll\s*\{\s*position:\s*relative;?\s*\}/.test(css), "у блоков нет position: relative для копий ушедших строк");

console.log(`${n - bad}/${n}`);
process.exit(bad ? 1 : 0);
