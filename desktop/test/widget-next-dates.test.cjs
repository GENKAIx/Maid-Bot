// Важные даты в ленте «Дальше» (widget.js, feedDates и render) без Electron и браузера.
// 16.11.2026: даты на неделю вперёд стояли отдельным разделом «Скоро» внизу списка, под задачами, — их не видно рядом с планами.
// Теперь они — строками ленты «Дальше» (золотая точка, «ср 18», значок и название), сверх «Сколько планов», не больше двух;
// в свой срок (cfg.dateLead) дата, как и раньше, — плашкой над планами. Раздел «Скоро» и его выключатель удалены.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const root = path.join(__dirname, "..");
const widget = fs.readFileSync(path.join(root, "renderer", "widget.js"), "utf8");
const clock = fs.readFileSync(path.join(root, "renderer", "clock.js"), "utf8");
const main = fs.readFileSync(path.join(root, "src", "main.js"), "utf8");
const site = fs.readFileSync(path.join(root, "..", "web", "src", "screens", "Widget.tsx"), "utf8");

// Какие даты идут в ленту: впереди до 7 дней, позже срока плашки, не убранные, ближайшие первыми, не больше NEXT_DATES.
const src = widget.match(/\nfunction feedDates\([^]*?\n\}\r?\n/)?.[0];
check(src, "в widget.js нет feedDates");
try {
  const ctx = {};
  vm.createContext(ctx);
  const helpers = `${clock.match(/\nfunction daysFrom\([^]*?\n\}/)?.[0] ?? ""}\n${clock.match(/\nconst dateKey = .*/)?.[0] ?? ""}`;
  vm.runInContext(`${widget.match(/\nconst NEXT_DATES = .*/)?.[0] ?? ""}\n${helpers}\n${src ?? ""}\nthis.f = feedDates;`, ctx);
  const d = (id, on) => ({ id, on, title: `д${id}` });
  const all = [d(1, "2026-11-16"), d(2, "2026-11-17"), d(3, "2026-11-20"), d(4, "2026-11-18"), d(5, "2026-11-23"), d(6, "2026-11-24"), d(7, "2026-11-19")];
  const ids = (xs) => xs.map((x) => x.id).join(",");
  check(ids(ctx.f(all, "2026-11-16", 1, new Set())) === "4,7", `срок плашки 1 день: ${ids(ctx.f(all, "2026-11-16", 1, new Set()))}`);
  check(ids(ctx.f(all, "2026-11-16", 0, new Set())) === "2,4", `в тот день: ${ids(ctx.f(all, "2026-11-16", 0, new Set()))}`);
  check(ids(ctx.f(all, "2026-11-16", 1, new Set(["4:2026-11-18"]))) === "7,3", "убранная дата всё ещё в ленте");
  check(ids(ctx.f(all, "2026-11-16", 7, new Set())) === "", "дата и плашкой, и строкой ленты");
} catch (e) {
  check(false, `feedDates оборвался: ${e?.stack ?? e}`);
}

const render = widget.match(/\nfunction render\(\) \{[^]*?\n\}\r?\n/)?.[0] ?? "";
check(/feedDates\(/.test(render) && /nx-date/.test(render), "даты не попадают в ленту «Дальше»");
check(!/Скоро/.test(render) && !/sec\.soon/.test(render), "раздел «Скоро» всё ещё рисуется");
check(!/["']?soon["']?: true/.test(widget.match(/\nlet cfg = .*/)?.[0] ?? ""), "выключатель «Скоро» в настройках виджета");
check(!/"soon"/.test(main.match(/sections: \(v\) =>.*/)?.[0] ?? "") && !/soon: true/.test(main), "main.js всё ещё знает раздел «Скоро»");
check(!/soon/.test(site), "на сайте остался выключатель «Скоро»");
// Без справа «через N дн.» (просьба пользователя): у строки даты нет nx-in.
check(!/nx-date[^`]*nx-in/.test(render), "у строки даты справа «через N дн.»");
// Щелчок по строке даты — панель её дня и вспышка её карточки (data-date), а не поиск плана с таким id.
check(/dataset\.date/.test(clock.match(/\$\("#next"\)\.addEventListener\("click"[^]*?\n\}\);/)?.[0] ?? ""), "щелчок по дате в ленте не находит её карточку");

console.log(`${n - bad}/${n}`);
process.exit(bad ? 1 : 0);
