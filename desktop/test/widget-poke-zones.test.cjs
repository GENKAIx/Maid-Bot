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
const timers = [];
let rnd = 0;
const ctx = {
  $: () => ({ classList: { contains: () => true, remove() {}, add() {} }, dataset: {}, offsetWidth: 0, getBoundingClientRect: () => ({ left: 100, top: 50, width: 200, height: 213.5 }) }),
  say: () => {}, react: () => {}, play: () => {}, popTone: () => {},
  line: (k) => k, lineItem: (k) => ({ t: k, m: "neutral" }),
  quipLog: said,
  state: "idle", mood: "", moodUntil: 0, napWokeAt: 0, pokedAwake: false, thinkPick: "think2", night: false,
  afterBedtime: () => ctx.night,
  setTimeout: (f, ms) => { timers.push([f, ms]); return timers.length; },
  clearTimeout: (id) => { if (id) timers[id - 1] = null; },
  Math: { random: () => rnd, floor: Math.floor, min: Math.min, max: Math.max },
  Date: { now: () => ctx.clock },
  clock: 1_000_000,
};
vm.createContext(ctx);
try {
  vm.runInContext(section, ctx);
  // quip подменяем: что сказала и с какой позой.
  vm.runInContext("quip = (text, moodName, ms, hold) => quipLog.push([text, moodName, ms, hold]);", ctx);
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
  const began = ctx.clock;
  const until = () => vm.runInContext("sulkUntil", ctx);
  check(until() === began + 30_000, "обида — на 30 с");
  // 18.11.2026: прощала через 30 с после десятого тычка, сколько бы ни тыкали дальше. Теперь каждый тычок, пока дуется,
  // отодвигает прощение на 30 с от него (но не дальше 2 минут с начала обиды), прежний таймер снят.
  const sulk = poke("cheek", 20_000);
  check(sulk[0] === "sulk" && sulk[1] === "pout", `тычок, пока дуется: ${sulk}`);
  check(until() === ctx.clock + 30_000, `тычок во время обиды не продлил её: осталось ${until() - ctx.clock} мс`);
  check(timers.filter(Boolean).length === 1, `таймеров прощения ${timers.filter(Boolean).length}, должен быть один`);
  for (let i = 0; i < 8; i++) poke("cap", 20_000);
  check(until() === began + 120_000, `обида длиннее двух минут: ${until() - began} мс`);
  // Время вышло — прощает сама, следующий тычок уже обычный.
  const [forgive] = timers.filter(Boolean).at(-1);
  said.length = 0; ctx.clock = began + 120_000; forgive();
  check(said[0]?.[0] === "forgive" && until() === 0, `по таймеру не простила: ${said}`);
  rnd = 0;
  check(poke("cap", fresh)[0] === "pokeCap", `после прощения тычок снова обычный: ${said}`);
} catch (e) {
  check(false, `оборвалось: ${e?.stack ?? e}`);
}

// Пока дуется, основа позы — «дуется», а не обычная стойка; «погладить» снимает и таймер прощения.
check(/Date\.now\(\) < sulkUntil\) return "pout";/.test(widget.match(/function baseMood\(\) \{[^]*?\n\}/)?.[0] ?? ""), "пока дуется, возвращается в обычную позу");
check(/clearTimeout\(sulkTimer\);\s*sulkUntil = 0;/.test(fs.readFileSync(path.join(dir, "album.js"), "utf8")), "«погладить» не снимает таймер прощения");
// Поза после тычка держится не меньше 3 с.
// 18.11.2026: поза после тычка — 8 с (POKE_HOLD), облачко — как было (3,2–3,8 с).
check(/function quip\(text, moodName, ms = 3200, hold = ms \+ 300\)/.test(fun) && /react\(moodName, hold\);/.test(fun), "у quip нет отдельного времени позы");
check(/const POKE_HOLD = 8000;/.test(fun), "поза тычка не 8 с");
check((fun.match(/, POKE_HOLD\);/g) ?? []).length === 3, "8 с — не у всех тычков (обычный, «вы закончили?», «хватит»)");
check(/how \? 3800 : 3200, POKE_HOLD\)/.test(fun), "облачко тычка изменилось");
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
