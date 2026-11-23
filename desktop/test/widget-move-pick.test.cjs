// «↪ Перенести…» в меню плана и задачи (23.11.2026; desktop/renderer/clock.js: openMovePick, openMoveDate). Раньше пункт сразу
// переносил на завтра; теперь открывает второе меню: «На завтра», «Через неделю» (от дня записи, дата справа) и «📅 Выбрать дату…» —
// окошко с датой: не раньше сегодня и не тот же день. Сам перенос — прежний (movePlan / moveTask).
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const clock = fs.readFileSync(path.join(__dirname, "..", "renderer", "clock.js"), "utf8");
const fn = (name) => { const s = clock.match(new RegExp(String.raw`\nfunction ${name}\([^]*?\r?\n\}`))?.[0]; check(s, `нет ${name} в clock.js`); return s ?? ""; };

// Маленький DOM: меню — строка innerHTML и обработчики; «щелчок» — по data-act / data-save / data-x.
const shown = [];
const fakeEl = () => {
  const el = { className: "", innerHTML: "", on: {}, fields: {} };
  el.addEventListener = (k, h) => { el.on[k] = h; };
  el.querySelector = (q) => (el.fields[q] ??= { value: (el.innerHTML.match(/data-in="day"[^>]*value="([^"]*)"/) ?? [])[1] ?? "", textContent: "", focus() {} });
  return el;
};
const ctx = {
  document: { createElement: fakeEl },
  data: { day: "2026-11-23" },
  MONTHS: ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"],
  closed: 0,
  esc: (s) => String(s),
  setTimeout: (f) => f(),
};
ctx.showPlanMenu = (m) => shown.push(m);
ctx.closePlanMenu = () => { ctx.closed++; };
ctx.keepIn = () => {};
vm.createContext(ctx);
vm.runInContext([
  clock.match(/\nfunction dayAfter\([^]*?\r?\n\}/)[0], clock.match(/\nconst shortDay = [^]*?\r?\n\};/)?.[0] ?? "const shortDay = (d) => d;",
  fn("openMovePick"), fn("openMoveDate"), "this.pick = openMovePick;",
].join("\n"), ctx);

const tap = (m, attr, value) => m.on.click({ target: { closest: (q) => (q === `[${attr}]` || (attr === "data-act" && q === "[data-act]") ? { dataset: { act: value } } : null) } });

// Второе меню: три пункта, даты — от дня записи.
let moved = [];
ctx.pick("Купить воды", "2026-11-23", 10, 10, (d) => moved.push(d));
const menu = shown.at(-1);
const labels = [...menu.innerHTML.matchAll(/data-act="(\w+)">([^<]+)/g)].map((m) => `${m[1]}:${m[2].trim()}`);
check(JSON.stringify(labels) === JSON.stringify(["tomorrow:На завтра", "week:Через неделю", "pick:📅 Выбрать дату…"]), `пункты: ${JSON.stringify(labels)}`);
tap(menu, "data-act", "tomorrow");
tap(menu, "data-act", "week");
check(JSON.stringify(moved) === JSON.stringify(["2026-11-24", "2026-11-30"]), `завтра и через неделю: ${JSON.stringify(moved)}`);

// План на пятницу — «через неделю» от пятницы, а не от сегодня.
moved = [];
ctx.pick("Врач", "2026-11-27", 10, 10, (d) => moved.push(d));
tap(shown.at(-1), "data-act", "week");
check(moved[0] === "2026-12-04", `от дня плана: ${moved[0]}`);

// «Выбрать дату…»: окошко с датой, по умолчанию — завтра от дня записи; прошлое и тот же день не принимаются.
moved = [];
ctx.pick("Купить воды", "2026-11-23", 10, 10, (d) => moved.push(d));
tap(shown.at(-1), "data-act", "pick");
const box = shown.at(-1);
check(/type="date"/.test(box.innerHTML) && /min="2026-11-23"/.test(box.innerHTML), "поле даты, не раньше сегодня");
const input = box.querySelector('[data-in="day"]');
const err = box.querySelector(".tm-err");
check(input.value === "2026-11-24", `по умолчанию завтра: ${input.value}`);
const save = () => box.on.click({ target: { closest: (q) => (q === "[data-save]" ? {} : null) } });
input.value = "2026-11-20"; save();
check(!moved.length && /прошла/.test(err.textContent), "прошлое — нельзя");
input.value = "2026-11-23"; save();
check(!moved.length && /тот же день/.test(err.textContent), "тот же день — нельзя");
input.value = ""; save();
check(!moved.length && /Выберите дату/.test(err.textContent), "пусто — нельзя");
input.value = "2026-12-31"; box.on.keydown({ key: "Enter" });
check(moved[0] === "2026-12-31", `своя дата по Enter: ${moved[0]}`);

// Оба меню ведут в выбор, а не сразу на завтра.
check((clock.match(/item\("move", "↪ Перенести…"\)/g) ?? []).length === 2, "пункт «↪ Перенести…» у плана и у задачи");
check(/act === "move"\) return openMovePick\(e\.title, e\.date_iso, x, y, \(day\) => movePlan\(e, day, li\)\)/.test(clock), "план → выбор дня");
check(/act === "move"\) return openMovePick\(t\.title, dayAfter\(next, -1\), x, y, \(day\) => moveTask\(t, day, li\)\)/.test(clock), "задача → выбор дня (просроченная — от сегодня)");
check(!/Перенести на завтра/.test(clock), "старого «Перенести на завтра» в меню нет");

console.log(bad ? `${bad} из ${n} не прошли` : `OK: ${n} проверок переноса`);
process.exit(bad ? 1 : 0);
