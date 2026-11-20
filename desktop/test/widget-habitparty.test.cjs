// Праздники привычек (renderer/habitparty.js): «Огонёк взрослеет» (возраст огонька 7 / 30 / 100 и рубеж серии), «Волна по отметкам»
// (все привычки дня — повседневно) и «Салют из искр» (все привычки дня в день рубежа). Всё — по ответам /api/today, раз в день.
// Запуск: node desktop/test/widget-habitparty.test.cjs
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const root = path.join(__dirname, "..", "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const src = read("desktop/renderer/habitparty.js");
const widget = read("desktop/renderer/widget.js");
const html = read("desktop/renderer/widget.html");
const lines = read("desktop/renderer/lines.js");
const css = read("desktop/renderer/style.css");

const store = {};
const ctx = vm.createContext({
  Date, Math, Number, JSON, Map, Set,
  cfg: { mute: true, sections: { habits: true } },
  localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); } },
  matchMedia: () => ({ matches: false }), setTimeout: () => 0,
  collapsed: false, napping: false,
});
vm.runInContext(src + "\nthis.api = { hpSync, flameHtml, flameTagHtml, flameRowClass, hpAge, hpDays, get party() { return hpParty; }, clear() { hpParty = null; }, hpRoll, hpMark };", ctx);
const x = ctx.api;
const day = "2026-11-20";
const today = (habits, d = day) => ({ day: d, habits });
const H = (id, status, streak, extra = {}) => ({ id, title: `П${id}`, status, streak, ...extra });

// --- 1. Возраст огонька ---
check(x.hpAge(2) === 0 && x.hpAge(6) === 0 && x.hpAge(7) === 7 && x.hpAge(29) === 7 && x.hpAge(30) === 30 && x.hpAge(99) === 30 && x.hpAge(100) === 100 && x.hpAge(365) === 100, "возраст: 7 — светится, 30 — синий, 100 — золотой");
check(x.flameHtml(H(1, null, 1)) === "", "серия 1 — огонька нет (как раньше: с 2 дней)");
check(/class="flame a0"/.test(x.flameHtml(H(1, null, 4))) && /<b>4<\/b>/.test(x.flameHtml(H(1, null, 4))), "серия 4 — обычный огонёк с числом");
check(/class="flame a30"/.test(x.flameHtml(H(1, null, 45))), "серия 45 — синий");
check(/Серия: 22 дня подряд/.test(x.flameHtml(H(1, null, 22))) && x.hpDays(11) === "дней" && x.hpDays(21) === "день" && x.hpDays(104) === "дня", "подсказка с правильным склонением");

// --- 2. Первый ответ и новый день — без праздника ---
x.hpSync(today([H(1, "done", 7), H(2, "done", 3)]));
check(!x.party, "первый ответ после запуска (всё уже сделано) — праздника нет");
x.hpSync(today([H(1, null, 6), H(2, null, 3)], "2026-11-21"));
check(!x.party, "новый день — без праздника");

// --- 3. Повседневно: все отмечены → волна ---
const d2 = "2026-11-21";
x.hpSync(today([H(1, "done", 7), H(2, null, 3)], d2));
check(x.party?.kind === "salute" ? false : x.party?.kind === "marks", `рубеж 7 без «все сделаны» — только огонёк рубежа (${x.party?.kind})`);
check(x.hpMark.get(1)?.tier === 7 && x.hpRoll.get(1)?.from === 6, "рубеж: ярлык «неделя подряд» и перекат 6 → 7");
check(/hp-tag t7/.test(x.flameTagHtml(H(1, "done", 7))) && /неделя подряд/.test(x.flameTagHtml(H(1, "done", 7))), "ярлык в строке");
check(/hp-sweep t7/.test(x.flameRowClass(H(1, "done", 7))), "блик по строке рубежа");
check(/hp-roll/.test(x.flameHtml(H(1, "done", 7))) && /flare/.test(x.flameHtml(H(1, "done", 7))), "число перекатывается, огонёк вспыхивает");
x.clear();
x.hpSync(today([H(1, "done", 7), H(2, "done", 4)], d2));
check(x.party?.kind === "salute" && x.party.top === 7 && x.party.marks.length === 0, `рубеж был раньше за день, последняя привычка — обычная: всё равно салют, порядок галочек не важен (${x.party?.kind})`);
x.clear();
x.hpSync(today([H(1, "done", 7), H(2, null, 3)], d2));
x.hpSync(today([H(1, "done", 7), H(2, "done", 4)], d2));
check(!x.party, "сняли и снова поставили галочку — праздник второй раз за день не играет");
check(JSON.parse(store["maid.habitParty"]).marks.length === 1, "рубеж той же привычки за день второй раз не засчитывается");

// --- 4. Особый день: рубеж и «все сделаны» одной отметкой → салют ---
const d3 = "2026-11-22";
x.hpSync(today([H(1, "done", 8), H(5, null, 29)], d3));
x.clear();
x.hpSync(today([H(1, "done", 8), H(5, "done", 30)], d3));
check(x.party?.kind === "salute" && x.party.marks[0]?.id === 5, `последняя отметка дня — и тут же серия 30: салют (${x.party?.kind})`);
check(/месяц подряд/.test(x.flameTagHtml(H(5, "done", 30))), "ярлык «месяц подряд»");

// --- 5. Что не считается ---
const d4 = "2026-11-23";
x.clear();
x.hpSync(today([H(1, null, 2), H(2, null, 0)], d4));
x.hpSync(today([H(1, "done", 3), H(2, "skipped", 0)], d4));
check(!x.party, "пропущенная («–») — не «все сделаны», праздника нет");
const d5 = "2026-11-24";
x.hpSync(today([H(1, null, 2), H(9, null, 0, { course: [{ day: d5, s: "rest" }] })], d5));
x.hpSync(today([H(1, "done", 3), H(9, null, 0, { course: [{ day: d5, s: "rest" }] })], d5));
check(x.party?.kind === "wave", "день отдыха курса не мешает «все сделаны»");
x.clear();
const d6 = "2026-11-25";
const markWas = x.hpMark.get(1);
x.hpSync(today([H(1, null, 6)], d6));
x.hpSync(today([H(1, null, 7)], d6));
check(x.hpMark.get(1) === markWas && !x.party, "серия выросла без сегодняшней отметки (отметили вчера задним числом) — не рубеж");
x.clear();
ctx.cfg.sections.habits = false;
const d7 = "2026-11-26";
x.hpSync(today([H(1, null, 2)], d7));
x.hpSync(today([H(1, "done", 3)], d7));
check(!x.party, "раздел «Привычки» выключен — праздника нет");
ctx.cfg.sections.habits = true;
x.hpSync(today([], "2026-11-27"));
x.hpSync(today([], "2026-11-27"));
check(!x.party, "привычек нет — праздника нет");

// --- 5б. Находки ревью ---
// Привычку удалили или остановили — «все сделаны» без отметки: не праздник, и праздник дня не сгорает.
const d8 = "2026-11-28";
x.clear();
x.hpSync(today([H(1, "done", 3), H(2, null, 0)], d8));
x.hpSync(today([H(1, "done", 3)], d8));
const savedD8 = JSON.parse(store["maid.habitParty"] ?? "{}");
check(!x.party && !(savedD8.day === d8 && savedD8.party),"удалили единственную неотмеченную — волны нет, праздник дня не потрачен");
x.hpSync(today([H(1, "done", 3), H(3, null, 0)], d8));
x.hpSync(today([H(1, "done", 3), H(3, "done", 1)], d8));
check(x.party?.kind === "wave", "потом отметили новую — волна играет");
// Раздел «Привычки» включили, когда всё уже сделано, — не праздник.
x.clear();
const d9 = "2026-11-29";
ctx.cfg.sections.habits = false;
x.hpSync(today([H(1, null, 2)], d9));
x.hpSync(today([H(1, "done", 3)], d9));
ctx.cfg.sections.habits = true;
x.hpSync(today([H(1, "done", 3)], d9));
check(!x.party, "включили раздел, когда всё уже отмечено, — волны нет");
// Два события до перерисовки — не затирают друг друга.
x.clear();
const d10 = "2026-11-30";
x.hpSync(today([H(1, null, 29), H(2, null, 5)], d10));
x.hpSync(today([H(1, "done", 30), H(2, null, 5)], d10));
x.hpSync(today([H(1, "done", 30), H(2, "done", 6)], d10));
check(x.party?.kind === "salute" && x.party.marks.some((m) => m.id === 1) && x.party.top === 30, `рубеж 30 и следом «все сделаны» до перерисовки — салют, и колокольчики рубежа не потерялись (${JSON.stringify(x.party)})`);
// Сняли отметку — ярлык и блик рубежа уходят.
x.clear();
x.hpSync(today([H(1, null, 29), H(2, "done", 5)], d10));
check(!x.hpMark.has(1) && x.flameTagHtml(H(1, null, 29)) === "", "сняли отметку после рубежа — ярлыка «месяц подряд» больше нет");
// Курс в день курса: вместо огонька полоска — рубежа нет.
x.clear();
const d11 = "2026-12-01";
const C = { course: [{ day: d11, s: "plan" }] };
x.hpSync(today([H(7, null, 6, C), H(8, null, 1)], d11));
x.hpSync(today([H(7, "done", 7, C), H(8, null, 1)], d11));
check(!x.hpMark.has(7) && !x.party, "курс дошёл до 7 в день курса — без рубежа огонька (огонька там нет)");
// Время эффекта — с первой перерисовки: список придержали на 2 с — ярлык всё равно свежий.
x.clear();
const d12 = "2026-12-02";
x.hpSync(today([H(9, null, 6), H(10, null, 1)], d12));
x.hpSync(today([H(9, "done", 7), H(10, null, 1)], d12));
x.hpMark.get(9).made -= 2000;
check(/hp-tag/.test(x.flameTagHtml(H(9, "done", 7))) && /hp-roll/.test(x.flameHtml(H(9, "done", 7))), "перерисовку придержали — перекат и ярлык показываются с её начала");
x.hpMark.set(11, { made: Date.now() - 20000, at: 0, tier: 7 });
check(x.flameTagHtml(H(11, "done", 7)) === "", "рубеж, который так и не показали за 15 с, — уже не показывать");

// Праздник ждал перерисовки, а галочку сняли — он отменяется.
x.clear();
const d13 = "2026-12-03";
x.hpSync(today([H(12, null, 6)], d13));
x.hpSync(today([H(12, "done", 7)], d13));
check(x.party?.kind === "salute", "рубеж 7 и все сделаны — салют в очереди");
x.hpSync(today([H(12, null, 6)], d13));
check(!x.party, "сняли галочку до перерисовки — ни салюта, ни колокольчиков рубежа");
// Раздел «Привычки» спрятан — рубеж не празднуется и не тратится.
x.clear();
const d14 = "2026-12-04";
ctx.cfg.sections.habits = false;
x.hpSync(today([H(13, null, 29), H(14, null, 1)], d14));
x.hpSync(today([H(13, "done", 30), H(14, null, 1)], d14));
check(!x.party && !x.hpMark.has(13), "раздел спрятан — рубеж 30 без колокольчиков и облачка");
ctx.cfg.sections.habits = true;
check(/transition: box-shadow \.3s, filter \.3s; \}/.test(css.match(/\.w \.list \.course-meter \.cm-bar \{[^}]*\}/)?.[0] ?? ""), "свечение полоски курса гаснет плавно (переход на самой полоске)");

// --- 6. Места вызова, реплики, звук, движение ---
check(/hpSync\(data\)/.test(widget.match(/async function load\(\)[^]*?\n\}/)?.[0] ?? ""), "load() отдаёт /api/today в hpSync до сравнения JSON");
check(/hpAfterRender\(\)/.test(widget) && /: flameHtml\(h\)/.test(widget) && /flameTagHtml\(h\)/.test(widget) && /flameRowClass\(h\)/.test(widget), "render: огонёк, ярлык, блик и праздник после перерисовки");
check(!/class="muted">🔥/.test(widget), "старого серого «🔥N» больше нет — одна версия огонька");
check(html.indexOf('src="habitparty.js"') > html.indexOf('src="course.js"') && html.indexOf('src="habitparty.js"') < html.indexOf('src="widget.js"'), "habitparty.js подключён после course.js и до widget.js");
for (const k of ["habitsAll", "habitsSalute", "flame7", "flame30", "flame100"]) check(lines.includes(`  ${k}: [`), `реплики ${k} в lines.js`);
check(/function hpSound[^]*?if \(cfg\.mute\) return/.test(src), "звуки праздника молчат при «Звуки выключены»");
check(/if \(collapsed \|\| napping\) return/.test(src), "свёрнута или спит — без праздника");
check(/prefers-reduced-motion: reduce[^}]*\.w \.flame\.flare em/.test(css) && /function hpDots[^]*?if \(hpStill\(\)\) return/.test(src), "«уменьшить движение»: без вспышек и частиц");
check(/animUntil = Math\.max\(animUntil/.test(src), "пока идёт волна или салют, список не перерисовывается");

console.log(`${n - bad}/${n}`);
process.exit(bad ? 1 : 0);
