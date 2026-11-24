// Этап 0 аналитики (24.11.2026, docs/review/аналитика-макет-2026-11-24.html, «начать записывать»): что программа на ПК шлёт
// в счётчики фич (maid.track → main.js → usage.js, пачкой). Без Electron и браузера: настоящий tour.js в песочнице и куски
// widget.js / habitparty.js — с заглушками окна.
//  • Экскурсия, начавшаяся сама при первом запуске: onboarding.tour.start, onboarding.tour.step.<id> на каждый показанный шаг,
//    в конце onboarding.tour.done (дошли до последнего шага) или onboarding.tour.skip (закрыли раньше). По просьбе из трея —
//    только widget.tour, без onboarding.*.
//  • Показанная анимация — maid.react.<имя> при смене картинки; «Ждёт» (idle) и повтор той же — не в счёт, «Стираю память» —
//    каждый показ.
//  • Праздники (hpPlay): рубеж серии — maid.party.flame, волна — maid.party.wave, салют — maid.party.salute; курс и уровень —
//    maid.party.course и maid.party.level; обида на 10-й тычок — maid.sulk.
//  • Шаги и анимации — те же, что в копии имён (src/usage.js), поэтому сервер их примет.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { WIDGET_FEATURES, TOUR_STEP_IDS, REACT_MOODS } = require("../src/usage.js");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const dir = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
const tourSrc = read("renderer/tour.js");
const widgetSrc = read("renderer/widget.js");
const partySrc = read("renderer/habitparty.js");

// --- экскурсия: настоящий tour.js ---
function tourWorld() {
  const tracks = [];
  const timers = [];
  const handlers = {};
  let last = null; // последнее облачко: { text, buttons }
  const mem = new Map();
  const el = () => ({
    classList: { add() {}, remove() {}, toggle() {}, contains: (c) => c === "hidden" },
    style: {}, innerHTML: "", value: "", placeholder: "", offsetParent: null,
    insertAdjacentHTML() {}, addEventListener() {}, contains: () => false, getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
    birthday: { value: "" }, height: { value: "" }, about: { value: "" },
  });
  const ctx = {
    console, tracks,
    touring: false, napping: false, collapsed: false, autoOpened: false, grabbed: false, data: { day: "2026-11-24" },
    chatInput: el(),
    localStorage: { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)) },
    document: { querySelectorAll: () => [], body: { appendChild: (x) => x }, createElement: () => el() },
    $: () => el(),
    esc: (s) => String(s),
    say: (text, o = {}) => { last = { text, buttons: o.buttons ?? [] }; },
    hideBubble: () => { last = null; },
    foldAnimated() {}, hideClock() {}, sendChat() {},
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    setInterval: () => 0, clearInterval() {},
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    MutationObserver: class { observe() {} },
    maid: {
      track: (name) => tracks.push(name), on: (ch, fn) => { handlers[ch] = fn; },
      openSection() {}, focusInput() {}, changed() {}, api: () => Promise.resolve({}),
    },
  };
  vm.createContext(ctx);
  vm.runInContext(`${tourSrc}\nthis.steps = TOUR_STEPS; this.endTour = endTour;`, ctx);
  return { ctx, tracks, timers, handlers, bubble: () => last };
}
const press = (w, label) => {
  const b = w.bubble()?.buttons.find((x) => x.text === label);
  check(Boolean(b), `в облачке нет кнопки «${label}»: ${JSON.stringify(w.bubble()?.buttons.map((x) => x.text))}`);
  b?.run();
};

{
  // Первый запуск: экскурсия сама (таймер ожидания), до конца по «Дальше» — все шаги и «дошли до конца».
  const w = tourWorld();
  const ids = w.ctx.steps.map((s) => s.id);
  check(JSON.stringify(ids) === JSON.stringify(TOUR_STEP_IDS), `шаги tour.js (${ids}) ≠ копии имён в usage.js (${TOUR_STEP_IDS})`);
  const wait = w.timers.find((t) => t.ms === 4000);
  check(Boolean(wait), "нет ожидания первого запуска");
  wait?.fn();
  check(w.ctx.touring === true, "экскурсия первого запуска не началась");
  check(JSON.stringify(w.tracks) === JSON.stringify(["onboarding.tour.start", "onboarding.tour.step.hello"]), `начало: ${w.tracks}`);
  press(w, "Покажи");
  for (let i = 1; i < ids.length - 1; i++) press(w, ids[i] === "profile" ? "Пропустить" : "Дальше");
  press(w, "Начать");
  check(w.ctx.touring === false, "экскурсия не кончилась");
  const want = ["onboarding.tour.start", ...ids.map((id) => `onboarding.tour.step.${id}`), "onboarding.tour.done"];
  check(JSON.stringify(w.tracks) === JSON.stringify(want), `вся экскурсия: ${w.tracks}`);
  for (const t of w.tracks) check(WIDGET_FEATURES.includes(t), `«${t}» нет в копии белого списка — сервер отбросит`);
  check(!w.tracks.includes("widget.tour"), "сама при первом запуске — не «по просьбе»");
}
{
  // Первый запуск, «Потом» на первом шаге — закрыли раньше.
  const w = tourWorld();
  w.timers.find((t) => t.ms === 4000)?.fn();
  press(w, "Потом");
  check(JSON.stringify(w.tracks) === JSON.stringify(["onboarding.tour.start", "onboarding.tour.step.hello", "onboarding.tour.skip"]), `«Потом»: ${w.tracks}`);
}
{
  // Первый запуск, «Хватит» на третьем шаге — шаги до него и «закрыли раньше»; ✕ (endTour) потом ничего не добавляет.
  const w = tourWorld();
  w.timers.find((t) => t.ms === 4000)?.fn();
  press(w, "Покажи");
  press(w, "Дальше");
  press(w, "Хватит");
  w.ctx.endTour();
  check(JSON.stringify(w.tracks) === JSON.stringify(["onboarding.tour.start", "onboarding.tour.step.hello", "onboarding.tour.step.input",
    "onboarding.tour.step.mic", "onboarding.tour.skip"]), `«Хватит»: ${w.tracks}`);
}
{
  // По просьбе из трея — только widget.tour; потом первый запуск уже не положен (отметка maid.tour).
  const w = tourWorld();
  w.handlers.tour();
  press(w, "Потом");
  check(JSON.stringify(w.tracks) === JSON.stringify(["widget.tour"]), `экскурсия из трея: ${w.tracks}`);
  w.timers.find((t) => t.ms === 4000)?.fn();
  check(w.ctx.touring === false && w.tracks.length === 1, "после экскурсии из трея первый запуск начался снова");
}

// --- реакции: showMood из widget.js ---
const moodsSrc = widgetSrc.match(/\nconst MOODS = \[[^]*?\];/)?.[0] ?? "";
const showSrc = widgetSrc.match(/\nfunction showMood\(n\) \{[^]*?\n\}/)?.[0] ?? "";
check(moodsSrc && showSrc, "в widget.js нет MOODS или showMood");
{
  const tracks = [];
  const ctx = {
    tracks, mood: "", forgetTimer: 0, faces: [],
    albumSee() {}, forgetFlash() { ctx.mood = "forget"; }, maidSrc: (x) => x, clearTimeout() {},
    $: () => ({ set src(v) { ctx.faces.push(v); } }),
    maid: { track: (x) => tracks.push(x) },
  };
  vm.createContext(ctx);
  // mood в widget.js — let верхнего уровня; здесь — свойство песочницы, чтобы видеть его снаружи.
  vm.runInContext(`${moodsSrc.replace("const MOODS", "var MOODS")}\n${showSrc}\nthis.MOODS = MOODS; this.showMood = showMood;`, ctx);
  const moods = ctx.MOODS.filter((m) => m !== "idle");
  check(JSON.stringify([...moods].sort()) === JSON.stringify([...REACT_MOODS].sort()), `анимации widget.js без idle ≠ копии имён в usage.js`);
  ctx.showMood("happy");
  ctx.showMood("happy");
  ctx.showMood("idle");
  ctx.showMood("think");
  ctx.showMood("forget");
  ctx.showMood("forget");
  ctx.showMood("нет такой");
  check(JSON.stringify(tracks) === JSON.stringify(["maid.react.happy", "maid.react.think", "maid.react.forget", "maid.react.forget"]),
    `реакции: ${tracks}`);
  for (const t of tracks) check(WIDGET_FEATURES.includes(t), `«${t}» нет в копии белого списка`);
}

// --- праздники: hpPlay из habitparty.js; курс, уровень и обида — вызов в нужной функции ---
const hpSrc = partySrc.match(/\nfunction hpPlay\(p\) \{[^]*?\n\}/)?.[0] ?? "";
check(hpSrc, "в habitparty.js нет hpPlay");
{
  const tracks = [];
  const played = [];
  const ctx = {
    maid: { track: (x) => tracks.push(x) },
    hpMarkFx: () => played.push("marks"), hpWave: () => played.push("wave"), hpSalute: () => played.push("salute"),
  };
  vm.createContext(ctx);
  vm.runInContext(`${hpSrc}\nthis.hpPlay = hpPlay;`, ctx);
  ctx.hpPlay({ kind: "wave", marks: [], n: 3 });
  ctx.hpPlay({ kind: "salute", marks: [{ id: 1, streak: 7 }], top: 7 });
  ctx.hpPlay({ kind: "marks", marks: [{ id: 2, streak: 30 }] });
  check(JSON.stringify(tracks) === JSON.stringify(["maid.party.wave", "maid.party.flame", "maid.party.salute", "maid.party.flame"]), `праздники: ${tracks}`);
  check(JSON.stringify(played) === JSON.stringify(["wave", "marks", "salute", "marks"]), `праздники играют как раньше: ${played}`);
}
const fnBody = (src, name) => src.match(new RegExp(`\\nfunction ${name}\\([^)]*\\) \\{[^]*?\\n\\}`))?.[0] ?? "";
check(/maid\.track\?\.\("maid\.party\.course"\)/.test(fnBody(read("renderer/course.js"), "celebrate")), "курс пройден (celebrate) не считается");
check(/maid\.track\?\.\("maid\.party\.level"\)/.test(fnBody(read("renderer/xp.js"), "xpLevelUp")), "новый уровень (xpLevelUp) не считается");
const sulk = fnBody(read("renderer/fun.js"), "poke").match(/if \(pokes >= 10\) \{[^]*?return;/)?.[0] ?? "";
check(/track\?\.\("maid\.sulk"\)/.test(sulk), "обида на 10-й тычок не считается");

console.log(`${n - bad}/${n}`);
process.exit(bad ? 1 : 0);
