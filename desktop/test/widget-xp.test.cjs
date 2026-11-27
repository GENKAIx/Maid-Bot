// Опыт в шапке виджета (renderer/xp.js): уровень считается как на сервере, опрос не дёргает полосу, пока отметка едет,
// ошибка или отмена возвращают свой опыт, настройка «Опыт и уровень в шапке» (xpBar: always | event) доходит от сайта до виджета.
// Запуск: node desktop/test/widget-xp.test.cjs
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const root = path.join(__dirname, "..", "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const xpSrc = read("desktop/renderer/xp.js");
const widget = read("desktop/renderer/widget.js");
const clock = read("desktop/renderer/clock.js");
const html = read("desktop/renderer/widget.html");
const main = read("desktop/src/main.js");
const site = read("web/src/screens/Widget.tsx");
const server = read("server/src/profile.ts");

// --- 1. xpLevel — та же формула, что levelOf на сервере ---
const els = {};
const el = (id) => (els[id] ??= { id, textContent: "", title: "", style: {}, offsetWidth: 1, isConnected: true,
  classList: { s: new Set(), add(...c) { c.forEach((x) => this.s.add(x)); }, remove(...c) { c.forEach((x) => this.s.delete(x)); },
    toggle(c, on) { if (on ?? !this.s.has(c)) this.s.add(c); else this.s.delete(c); }, contains(c) { return this.s.has(c); } } });
const ctx = vm.createContext({ $: (sel) => el(sel.replace("#", "")), cfg: { mute: true, xpBar: "always" }, Date, Math, Number, leavingRows: new Map(),
  setTimeout: () => 0, clearTimeout: () => {}, matchMedia: () => ({ matches: true }), document: { createElement: () => el("tmp"), body: { append() {} } } });
vm.runInContext(xpSrc + "\nthis.api = { xpLevel, xpSync, xpGain, xpTake, xpUndo, xpSent, xpHold, xpApplyCfg, get shown() { return xpShown; },"
  + " setHold(v) { xpHoldUntil = v; }, setAir(v) { xpAirSum = v; }, get void() { return xpVoid; }, get plus() { return xpPlusSum; } };", ctx);
const x = ctx.api;
const levelOf = (xp) => { let level = 1, left = xp; while (left >= 100 + 25 * (level - 1)) { left -= 100 + 25 * (level - 1); level++; } return { level, into: left, need: 100 + 25 * (level - 1) }; };
check(/100 \+ 25 \* \(level - 1\)/.test(server), "формула уровня на сервере изменилась — поправить xpLevel в xp.js и этот тест");
for (const v of [0, 99, 100, 230, 549, 550, 740, 750, 1224, 1225, 6175]) {
  const a = x.xpLevel(v), b = levelOf(v);
  check(a.level === b.level && a.into === b.into && a.need === b.need && a.xp === v, `xpLevel(${v}) = ${JSON.stringify(a)}, сервер ${JSON.stringify(b)}`);
}
check(/XP = \{ task: 10, habit: 5/.test(server) && /XP_GAIN = \{ task: 10, habit: 5 \}/.test(xpSrc), "искра берёт те же числа, что сервер (задача 10, привычка 5)");

// --- 2. Опрос, галочки, отмены, ошибки ---
x.xpSync({ xp: 740, level: 5, into: 190, need: 200 });
check(x.shown.xp === 740 && els.xpLvl.textContent === "ур. 5" && els.xpFill.style.width === "95%", `первый опрос рисует без анимации: ${els.xpLvl.textContent} ${els.xpFill.style.width}`);
check(els.head.classList.contains("has-xp"), "у шапки появился класс has-xp — полоса видна");
x.xpGain(null, "task");
check(x.shown.xp === 750 && x.shown.level === 6, `галочка задачи: сразу +10 и новый уровень (${JSON.stringify(x.shown)})`);
check(els.xpFill.style.width === "100%", `новый уровень: полоса сначала дозаполняется до конца, а не отъезжает назад (${els.xpFill.style.width})`);
check(x.plus === 10 && els.xpLvl.textContent === "+10 ✦", `метка уровня на время серии — «+10 ✦» (${els.xpLvl.textContent})`);
x.xpSync({ xp: 740 });
check(x.shown.xp === 750, "старый ответ опроса, пока галочка едет на сервер, полосу не откатывает");
x.xpTake("task");
check(x.shown.xp === 740 && x.shown.level === 5, "отмена галочки убирает прибавку");
check(x.plus === 0, "отменили после того, как искра села, — «+10 ✦» в метке тоже уходит");
x.xpGain(null, "habit");
check(x.shown.xp === 745, "привычка — +5");
x.xpUndo("habit");
check(x.shown.xp === 740, "отметка не прошла — своя прибавка уходит назад");
x.xpUndo("habit", 1);
check(x.shown.xp === 745, "не прошло снятие отметки — опыт возвращается");
x.xpUndo("habit");
ctx.leavingRows.set("t9", { sent: false });
x.setHold(0);
x.xpSync({ xp: 700 });
check(x.shown.xp === 740, "режим «улетают»: пока строка ждёт отправки (курсор держит её сколько угодно), опрос полосу не трогает");
ctx.leavingRows.clear();
x.setAir(5);
x.xpTake("habit");
check(x.void === 5, "галочку сняли, пока искра летит, — искра сядет молча (без «+5 ✦» и звона)");
x.setAir(0);
x.setHold(0);
x.xpSync({ xp: 900 });
check(x.shown.xp === 900 && els.w.classList.contains("xp-show"), "прибавка не из виджета (телефон, Telegram, облачко) — полоса показывается сама");
x.xpSync({ bad: 1 });
check(x.shown.xp === 900, "ответ без опыта (старый сервер) ничего не ломает");

// --- 3. Места вызова ---
const gains = (widget.match(/xpGain\(/g) ?? []).length + (clock.match(/xpGain\(/g) ?? []).length;
// 28.11.2026: пятое место — ×N набрал норму (stepHabit, щелчок по кольцу); неполная отметка опыта не даёт.
check(gains === 5, `искра — у галочки задачи и привычки в списке, «улетают», панели планов и ×N с набранной нормой (облачко и меню привычки — через опрос): ${gains}`);
check(/const again = e\.target\.classList\.contains\("done"\)[^]*?if \(!again\) \{ xpGain/.test(widget), "второй щелчок по уже отмеченной задаче опыт не даёт");
check(!/xpForget/.test(widget + clock + xpSrc), "общего сброса удержания нет — ошибка одной отметки не трогает другие");
check((widget.match(/xpUndo\(/g) ?? []).length >= 4 && (clock.match(/xpUndo\(/g) ?? []).length === 2, "ошибка отметки или снятия возвращает свой опыт (xpUndo)");
check(/xpHold\(\);\s*try \{\s*await maid\.api\("POST", task \?/.test(widget), "rowCommit держит полосу, пока отметка из «улетают» едет на сервер");
check(/!bar\.offsetParent\) return false/.test(xpSrc), "свёрнутая панель — искра не летит в угол окна");

// --- 4. Настройка «Всегда / По событию» по всей цепочке ---
ctx.cfg.xpBar = "event"; x.xpApplyCfg();
check(els.w.classList.contains("xp-event"), "xpBar: event → класс xp-event у панели");
ctx.cfg.xpBar = "always"; x.xpApplyCfg();
check(!els.w.classList.contains("xp-event"), "xpBar: always → класса нет");
check(/xpBar: oneOf\("always", "event"\)/.test(main), "main.js WIDGET_PREFS пропускает xpBar (иначе сайт не сохранит)");
check(/xpBar: w\.xpBar === "event" \? "event" : "always"/.test(widget), "widget.js loadCfg читает xpBar, по умолчанию «always»");
check(/xpApplyCfg\(\)/.test(widget.match(/function applyCfg\(\)[^]*?\n\}/)?.[0] ?? ""), "applyCfg зовёт xpApplyCfg");
check(/xpBar\?: "always" \| "event"/.test(site) && /xpBar: "always"/.test(site) && /\["always", "Всегда"\], \["event", "По событию"\]/.test(site), "сайт: тип, значение по умолчанию и выбор «Всегда / По событию»");
check(/xpSync\(data\.xp\)/.test(widget.match(/async function load\(\)[^]*?\n\}/)?.[0] ?? ""), "load() отдаёт опыт из /api/today в xpSync");
check(html.indexOf('src="xp.js"') > 0 && html.indexOf('src="xp.js"') < html.indexOf('src="widget.js"'), "xp.js подключён в widget.html до widget.js");
for (const id of ["xpLvl", "xpBar", "xpFill"]) check(html.includes(`id="${id}"`), `в шапке есть #${id}`);

console.log(`${n - bad}/${n}`);
process.exit(bad ? 1 : 0);
