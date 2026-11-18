// Тычки по горничной зависят от места и от того, чем она занята (fun.js: pokeZone, pokeBusy, poke) — без Electron и браузера.
// 18.11.2026: тычок всегда шёл по одной лесенке (реплика → «вы закончили?» → обида). Теперь первый тычок серии отвечает
// на её занятие (чай, уборка, думает, только что разбудили, ночь после отбоя), остальные — на место: чепчик, бант, щёки, грудь.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const dir = path.join(__dirname, "..", "renderer");
const fun = fs.readFileSync(path.join(dir, "fun.js"), "utf8");
const widget = fs.readFileSync(path.join(dir, "widget.js"), "utf8");
const lines = fs.readFileSync(path.join(dir, "lines.js"), "utf8");

// Весь раздел «тап по голове» — до следующего раздела fun.js.
const section = fun.slice(0, fun.indexOf("// --- настроение от того, как идёт день ---"));
check(/function pokeZone\(/.test(section) && /function pokeBusy\(/.test(section), "в fun.js нет pokeZone / pokeBusy");

const said = [];
let rnd = 0;
const ctx = {
  $: () => ({ classList: { contains: () => true, remove() {}, add() {} }, dataset: {}, offsetWidth: 0, getBoundingClientRect: () => ({ left: 100, top: 50, width: 200, height: 213.5 }) }),
  say: () => {}, react: () => {}, play: () => {}, popTone: () => {},
  line: (k) => k, lineItem: (k) => ({ t: k, m: "neutral" }),
  quipLog: said,
  state: "idle", mood: "", moodUntil: 0, napWokeAt: 0, pokedAwake: false, thinkPick: "think2", night: false,
  afterBedtime: () => ctx.night,
  setTimeout: () => 1,
  Math: { random: () => rnd, floor: Math.floor },
  Date: { now: () => ctx.clock },
  clock: 1_000_000,
};
vm.createContext(ctx);
try {
  vm.runInContext(section, ctx);
  // quip подменяем: что сказала и с какой позой.
  vm.runInContext("quip = (text, moodName) => quipLog.push([text, moodName]);", ctx);
  const zone = (x, y) => vm.runInContext(`pokeZone(${x}, ${y})`, ctx);
  for (const [x, y, want] of [[0.55, 0.1, "cap"], [0.4, 0.56, "cheek"], [0.67, 0.56, "cheek"], [0.57, 0.68, "bow"], [0.84, 0.33, "bow"],
    [0.55, 0.82, "chest"], [0.55, 0.4, ""], [0.05, 0.9, ""], [0.95, 0.05, ""]]) {
    check(zone(x, y) === want, `точка ${x}, ${y}: ждали «${want}», вышло «${zone(x, y)}»`);
  }
  // Точка щелчка переводится в доли кадра фигурки: (100 + 110, 50 + 21) при кадре 200×213,5 → чепчик.
  check(vm.runInContext("pokeZoneAt({ clientX: 210, clientY: 71 })", ctx) === "cap", "pokeZoneAt не переводит точку щелчка в доли кадра");

  const busy = () => vm.runInContext("pokeBusy()", ctx);
  check(busy() === "", "свободна — занятие должно быть пустым");
  ctx.night = true; check(busy() === "night", "после отбоя — night");
  ctx.mood = "tea"; ctx.moodUntil = ctx.clock + 3000; check(busy() === "tea", "пьёт чай — tea (сильнее ночи)");
  ctx.mood = "clean"; check(busy() === "clean", "убирается — clean");
  ctx.moodUntil = ctx.clock - 1; check(busy() === "night", "чай кончился — снова night");
  ctx.night = false;
  ctx.mood = "happy"; ctx.moodUntil = ctx.clock + 3000; check(busy() === "", "обычная реакция — не занятие");
  ctx.state = "think"; check(busy() === "think", "ждёт ответа — think");
  ctx.napWokeAt = ctx.clock - 2000; check(busy() === "woke", "разбудили 2 с назад — woke (сильнее всего)");
  ctx.napWokeAt = ctx.clock - 6000; check(busy() === "think", "разбудили 6 с назад — уже не woke");
  ctx.state = "idle"; ctx.moodUntil = 0;

  const poke = (z, dt = 1000) => { said.length = 0; ctx.clock += dt; vm.runInContext(`poke(${JSON.stringify(z)})`, ctx); return said[0] ?? []; };
  const fresh = 10_000; // пауза между сериями тычков
  rnd = 0;
  check(poke("cap", fresh)[0] === "pokeCap", `тычок в чепчик: ${said}`);
  check(poke("chest", fresh)[0] === "pokeChest", `тычок в грудь: ${said}`);
  check(poke("", fresh)[0] === "poke", `мимо зон — обычная реплика: ${said}`);
  rnd = 0.9;
  check(poke("cheek", fresh)[0] === "poke", `каждый четвёртый тычок в зону — обычная реплика: ${said}`);
  // Занятие — только на первый тычок серии, второй — уже по месту.
  rnd = 0;
  ctx.mood = "tea"; ctx.moodUntil = ctx.clock + 60_000;
  check(poke("cap", fresh)[0] === "pokeTea", `первый тычок, пока пьёт чай: ${said}`);
  check(poke("cap")[0] === "pokeCap", `второй тычок подряд — уже по месту: ${said}`);
  ctx.moodUntil = 0;
  // Думает — поза остаётся «думает».
  ctx.state = "think";
  const th = poke("", fresh);
  check(th[0] === "pokeThink" && th[1] === "think2", `тычок, пока думает: ${th}`);
  ctx.state = "idle";
  // Только что разбудили — помечает, что приветствие не нужно.
  ctx.napWokeAt = ctx.clock + fresh - 500;
  check(poke("cheek", fresh)[0] === "pokeWoke" && vm.runInContext("pokedAwake", ctx) === true, `тычок сразу после сна: ${said}`);
  ctx.napWokeAt = 0;
  // Ночь — через раз.
  ctx.night = true;
  rnd = 0.5; check(poke("", fresh)[0] === "pokeNight", `ночной тычок: ${said}`);
  rnd = 0.7; check(poke("", fresh)[0] === "poke", `ночной тычок через раз — обычный: ${said}`);
  ctx.night = false;
  // Лесенка осталась: 7-й подряд — «хватит», 10-й — обида, дальше дуется, куда бы ни тыкали.
  rnd = 0.99;
  poke("cap", fresh);
  for (let i = 2; i <= 6; i++) poke("cap");
  check(poke("cap")[0] === "annoyed7", `седьмой тычок подряд: ${said}`);
  poke("cap"); poke("cap");
  check(poke("chest")[0] === "sulkStart", `десятый тычок — обида: ${said}`);
  const sulk = poke("cheek");
  check(sulk[0] === "sulk" && sulk[1] === "pout", `тычок, пока дуется: ${sulk}`);
} catch (e) {
  check(false, `оборвалось: ${e?.stack ?? e}`);
}

// Щелчок передаёт место в poke; разбуженная тычком не здоровается, если новостей нет.
check(/const zone = e \? pokeZoneAt\(e\) : "";/.test(widget) && /setTimeout\(\(\) => poke\(zone\), 230\)/.test(widget), "maidClick не передаёт место тычка");
check(/napWokeAt = Date\.now\(\);\s*pokedAwake = false;/.test(widget), "wakeUp не запоминает время пробуждения");
check(/if \(napping \|\| \(pokedAwake && !news\.length\)\) return;/.test(widget), "разбуженная тычком всё равно здоровается");

// У каждого случая — хотя бы пять реплик, позы — из списка анимаций.
const moods = new Set([...widget.match(/const MOODS = \[([^\]]+)\]/)[1].matchAll(/"(\w+)"/g)].map((m) => m[1]));
for (const key of ["pokeCap", "pokeBow", "pokeCheek", "pokeChest", "pokeTea", "pokeClean", "pokeThink", "pokeWoke", "pokeNight"]) {
  const body = lines.match(new RegExp(`\\n  ${key}: \\[([^]*?)\\n  (?:\\]|//|\\w+:)`))?.[1] ?? "";
  const count = (body.match(/\bt: "/g) ?? []).length;
  check(count >= 5, `${key}: реплик ${count}, нужно хотя бы 5`);
  for (const m of body.matchAll(/m: "(\w+)"/g)) check(moods.has(m[1]), `${key}: нет анимации «${m[1]}»`);
  if (key !== "pokeThink") check((body.match(/m: "/g) ?? []).length === count, `${key}: не у каждой реплики своя поза`);
}
console.log(bad ? `${bad} из ${n} не прошло` : `ok ${n}`);
process.exit(bad ? 1 : 0);
