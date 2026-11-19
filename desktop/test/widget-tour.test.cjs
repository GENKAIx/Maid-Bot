// Экскурсия при первом запуске (tour.js) и пустой виджет (widget.js) без Electron и браузера.
// 15.11.2026: новичок видел пустую коробку «Планов нет / Задачи / Нет» и не понимал, что делать. Теперь: один раз на компьютере
// горничная проводит экскурсию — подсвечивает кнопки по очереди, просит рассказать о себе (профиль), в конце — «Что я умею»;
// повторить — пункт «Экскурсия» в трее. Пустой блок «Дальше» — с кнопкой «+ План», пустая панель — низкая (.w.bare).
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const dir = path.join(__dirname, "..");
const read = (f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), "utf8") : "");
const html = read("renderer/widget.html");
const tour = read("renderer/tour.js");
const widget = read("renderer/widget.js");
const tails = read("renderer/tails.js");
const css = read("renderer/style.css");
const main = read("src/main.js");
const preload = read("src/preload.js");

check(tour, "нет renderer/tour.js");
const scripts = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
check(scripts.includes("tour.js") && scripts.indexOf("tour.js") > scripts.indexOf("widget.js") && scripts.indexOf("tour.js") < scripts.indexOf("tails.js"),
  `tour.js не подключён между widget.js и tails.js: ${scripts.join(", ")}`);

// Шаги: у каждого — текст и эмоция; подсвечиваемая кнопка есть в widget.html; главное — строка, голос, картинка, история, планы,
// список, шапка, горничная, знакомство (профиль) и финал со ссылкой на «Возможности».
const block = tour.match(/\nconst TOUR_STEPS = \[[^]*?\n\];/);
check(Boolean(block), "в tour.js нет TOUR_STEPS");
const ctx = {};
vm.createContext(ctx);
try {
  vm.runInContext(`${block?.[0] ?? "const TOUR_STEPS = [];"}\nthis.steps = TOUR_STEPS;`, ctx);
} catch (e) {
  check(false, `TOUR_STEPS не разбирается: ${e.message}`);
}
const steps = ctx.steps ?? [];
check(steps.length >= 10, `шагов мало: ${steps.length}`);
for (const s of steps) {
  check(s.id && s.text && s.mood, `шаг без id, текста или эмоции: ${JSON.stringify(s)}`);
  if (s.mood) check(fs.existsSync(path.join(dir, "assets", "maid", `${s.mood}.webp`)), `${s.id}: нет анимации ${s.mood}`);
  for (const t of [s.target ?? []].flat()) check(new RegExp(`id="${t.replace(/^#/, "")}"`).test(html), `${s.id}: в widget.html нет ${t}`);
}
const targets = new Set(steps.flatMap((s) => [s.target ?? []].flat()));
for (const t of ["#chatInput", "#chatMic", "#chatClip", "#chatHistBtn", "#next", "#body", "#head", "#maid"]) check(targets.has(t), `экскурсия не показывает ${t}`);
check(steps.some((s) => s.id === "profile"), "нет шага знакомства (профиль)");
check(steps.at(-1)?.id === "end", "последний шаг — не финал");
// С 0.1.53 горничная о хвостах сама не спрашивает — они лежат под будильником ⏰ (inbox.js). Экскурсия обещала обратное (до 19.11.2026).
const listStep = steps.find((s) => s.id === "list")?.text ?? "";
check(!/спрошу сама|по одному/.test(listStep) && /⏰/.test(listStep), `шаг «list» неверно говорит про просроченное: ${listStep}`);
check(/\/api\/profile/.test(tour), "знакомство не сохраняет профиль");
check(/openSection\("\/features"\)/.test(tour), "в финале нет ссылки на «Возможности»");

// Один раз на компьютере: после показа — отметка; без localStorage (ошибка доступа) — не показывать.
const due = tour.match(/\nconst TOUR_KEY = [^]*?\nfunction tourSeen\([^]*?\n\}\r?\n/);
check(Boolean(due), "в tour.js нет TOUR_KEY / tourDue / tourSeen");
try {
  const c = {};
  vm.createContext(c);
  vm.runInContext(due?.[0] ?? "", c);
  const mem = new Map();
  const ls = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)) };
  check(c.tourDue(ls) === true, "новый компьютер — экскурсия не положена");
  c.tourSeen(ls);
  check(c.tourDue(ls) === false, "после показа экскурсия положена снова");
  check(c.tourDue({ getItem: () => { throw new Error("нет доступа"); } }) === false, "без localStorage экскурсия лезет каждый запуск");
} catch (e) {
  check(false, `tourDue оборвался: ${e?.stack ?? e}`);
}

// Пока идёт экскурсия, облачко — её: прочие реплики и вопросы-хвосты молчат (уведомления копятся в ящике).
check(/^let touring = false;/m.test(widget), "в widget.js нет touring");
check(/if \(napping \|\| \(touring && !tour\)\) return;/.test(widget), "say() не молчит во время экскурсии");
// С 0.1.53 хвосты сами не спрашивают вовсе (лежат под будильником, inbox.js) — значит, и экскурсию не перебьют.
check(!/setInterval|setTimeout/.test(tails), "хвосты снова всплывают сами (таймер в tails.js) — перебьют экскурсию");

// Пустой виджет: «+ План» в «Дальше» (форма нового плана на сегодня), низкая панель.
check(/data-addplan/.test(widget) && /\+ План/.test(widget), "в пустом «Дальше» нет кнопки «+ План»");
check(/classList\.toggle\("bare"/.test(widget), "панель не знает, что она пустая (.bare)");
check(/\.w\.bare\s*\{[^}]*flex-basis:\s*auto/.test(css), "пустая панель не низкая (.w.bare)");

// Повторить экскурсию — из трея.
check(/label: "Экскурсия"/.test(main) && /send\("tour"\)/.test(main), "в трее нет пункта «Экскурсия»");
check(/"tour"/.test(preload.match(/on: \(channel, fn\)[^]*?\}/)?.[0] ?? ""), "preload не пропускает канал tour");

console.log(`${n - bad}/${n}`);
process.exit(bad ? 1 : 0);
