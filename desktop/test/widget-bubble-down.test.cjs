// Облачко у свёрнутой карточки в режиме «вниз» (карточка у верха экрана; widget.js placeBubble). 23.11.2026: место над
// карточкой прикидывалось с запасом (облачко не меньше 120 px + 60% роста горничной), и даже короткое «…» уезжало влево от
// карточки, хотя у головы помещалось. Теперь облачко пробно ставится у головы и меряется: целиком на экране — остаётся там.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const widget = fs.readFileSync(path.join(__dirname, "..", "renderer", "widget.js"), "utf8").replace(/\r\n/g, "\n");
const fn = (name) => widget.match(new RegExp(String.raw`\nfunction ${name}\([^]*?\n\}`))?.[0] ?? (check(false, `нет ${name}`), "");

// Сцена: облачко у головы стоит на upTop (в окне), слева от карточки — на leftTop; drop — сдвиг fitBubble.
const scene = { upTop: 31, leftTop: 139, drop: 0, down: true };
const classes = new Set(["stage", "folded"]);
const stage = { classList: {
  contains: (c) => (c === "down" ? scene.down : classes.has(c)),
  add: (c) => classes.add(c), remove: (c) => classes.delete(c),
  toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
} };
const bubble = {
  style: { getPropertyValue: () => (scene.drop ? `${scene.drop}px` : "") },
  getBoundingClientRect: () => ({ top: (classes.has("bubble-up") ? scene.upTop : scene.leftTop) + scene.drop }),
};
const ctx = { $: (q) => (q === "#stage" ? stage : q === "#bubble" ? bubble : null), screenY: 0, screen: { availTop: 0 } };
vm.createContext(ctx);
vm.runInContext(`${widget.match(/\nconst BUBBLE_UP_GAP = .*/)[0]}\n${fn("placeBubble")}\nthis.place = placeBubble;`, ctx);
const up = () => classes.has("bubble-up");

// Случай со снимка: окно у самого верха (карточка в 139 px от края), горничная видна целиком, «…» у головы на 31 px — остаётся у головы.
ctx.place();
check(up(), "короткое «…» у головы помещается — не уезжает влево");

// Высокое облачко у головы ушло бы за верх экрана — влево от карточки.
scene.upTop = -60;
ctx.place();
check(!up(), "высокое облачко за верх экрана — слева от карточки");

// Окно ниже на экране (screenY) — то же облачко у головы помещается.
ctx.screenY = 200;
ctx.place();
check(up(), "окно ниже — облачко у головы");

// Верх рабочей области не с нуля (панель задач сверху): считается от него.
ctx.screen.availTop = 180;
ctx.place();
check(!up(), "панель задач сверху: верх облачка под ней не помещается — влево");
ctx.screen.availTop = 0;

// Сдвиг fitBubble (--drop) в замер не входит: решение то же, что без него.
scene.upTop = 2; ctx.screenY = 0; scene.drop = 30;
ctx.place();
check(!up(), "опущенное fitBubble облачко меряется без сдвига");
scene.drop = 0; scene.upTop = 4;
ctx.place();
check(up(), "ровно 4 px до края — помещается");

// Не режим «вниз» — пометки нет.
scene.down = false;
ctx.place();
check(!up(), "обычный режим — без bubble-up");

check(!/Math\.max\(b\.offsetHeight, 120\)/.test(widget), "старого запаса (120 px + 60% горничной) нет");

console.log(bad ? `${bad} из ${n} не прошли` : `OK: ${n} проверок облачка в режиме «вниз»`);
process.exit(bad ? 1 : 0);
