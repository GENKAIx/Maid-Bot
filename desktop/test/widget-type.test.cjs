// Печать в облачке (runType / stopType из widget.js) на поддельном облачке, без Electron и браузера.
// 14.11.2026, две ошибки: (1) два вопроса подряд — перехватчик щелчков первой печати оставался на облачке и
// съедал нажатия на кнопки второго вопроса; (2) длинный текст печатался под нижним краем облачка, а прокрутки за ним
// не было — казалось, что печать встала.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const src = fs.readFileSync(path.join(__dirname, "..", "renderer", "widget.js"), "utf8");
const from = src.indexOf("function runType(");
const to = src.indexOf("function typeBlip(");
check(from > 0 && to > from, "в widget.js нет runType / typeBlip");

// Облачко: окно текста высотой 100 px, строка 20 px, по 10 букв в строке; scrollTop ограничен как у браузера.
function makeBubble() {
  const listeners = new Set();
  const classes = new Set();
  const box = {
    clientHeight: 100, scrollHeight: 0, _top: 0,
    get scrollTop() { return this._top; },
    set scrollTop(v) { this._top = Math.max(0, Math.min(v, this.scrollHeight - this.clientHeight)); },
    getBoundingClientRect() { return { top: 0, bottom: 100 }; },
  };
  const bubble = {
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
    addEventListener: (t, f) => listeners.add(f),
    removeEventListener: (t, f) => listeners.delete(f),
    querySelector: (s) => (s === ".bubble-text" ? box : null),
    querySelectorAll: () => [],
    listeners, classes, box,
  };
  return bubble;
}
function makeText(box, len) {
  const chars = [], at = [];
  for (let i = 0; i < len; i++) {
    const row = Math.floor(i / 10);
    const on = new Set();
    chars.push({ textContent: "а", classList: { add: (c) => on.add(c) }, on,
      getBoundingClientRect: () => ({ top: row * 20 - box.scrollTop, bottom: row * 20 + 20 - box.scrollTop }) });
    at.push(i * 10);
  }
  box.scrollHeight = Math.ceil(len / 10) * 20;
  return { chars, at, total: len * 10 };
}

let clock = 0;
const timers = new Map();
let nextId = 1;
const ctx = {
  TYPE_PITCH: {}, typeTimers: [], typing: null, cfg: { mute: true },
  performance: { now: () => clock },
  setInterval: (f) => { const id = nextId++; timers.set(id, f); return id; },
  clearInterval: (id) => timers.delete(id),
  clearTimeout: () => {},
  typeBlip: () => {},
};
const advance = (ms) => { for (let t = 0; t < ms; t += 16) { clock += 16; for (const f of [...timers.values()]) f(); } };
vm.createContext(ctx);
try {
  vm.runInContext(src.slice(from, to), ctx);

  // (1) Вторая печать прервала первую (say → stopType → runType), затем дописалась: на облачке не остаётся перехватчиков.
  let b = makeBubble();
  ctx.$ = () => b;
  ctx.runType(makeText(b.box, 30), "calm");
  advance(50);
  ctx.stopType();
  check(b.listeners.size === 0, `после прерванной печати осталось перехватчиков щелчков: ${b.listeners.size}`);
  ctx.runType(makeText(b.box, 5), "calm");
  advance(200);
  check(ctx.typing === null && !b.classes.has("typing"), "вторая печать не закончилась");
  check(b.listeners.size === 0, `после второй печати осталось перехватчиков: ${b.listeners.size}`);
  check(timers.size === 0, "таймер печати не остановлен");

  // Щелчок во время печати дописывает всё и снимает перехватчик.
  ctx.runType(makeText(b.box, 30), "calm");
  advance(30);
  const tw1 = [...b.listeners][0];
  tw1?.({ stopPropagation() {} });
  check(ctx.typing === null && b.listeners.size === 0, "щелчок не дописал печать или не снял перехватчик");

  // (2) Длинный текст: последняя напечатанная буква остаётся в окне облачка.
  b = makeBubble();
  ctx.$ = () => b;
  let tw = makeText(b.box, 200); // 20 строк = 400 px при окне 100 px
  const visible = () => {
    const i = tw.chars.findLastIndex((c) => c.on.has("on"));
    const r = tw.chars[i].getBoundingClientRect();
    return r.bottom <= 100 && r.top >= 0;
  };
  ctx.runType(tw, "calm");
  advance(1000); // ~100 букв = 10 строк
  check(b.box.scrollTop > 0 && visible(), `печать ушла под край: scrollTop ${b.box.scrollTop}`);
  b.box.scrollTop = 0; // листнули вверх рукой — не тянет обратно
  advance(300);
  check(b.box.scrollTop === 0, `облачко утянуло вниз, хотя его листнули вверх: ${b.box.scrollTop}`);
  b.box.scrollTop = 1e9; // листнули до самого низа (там ещё не напечатанное) — снова держит последнюю букву
  advance(100);
  check(visible(), "после листания вниз печать не видна");
  advance(2000);
  check(ctx.typing === null, "длинная печать не закончилась");
} catch (e) {
  check(false, `тест оборвался: ${e?.stack ?? e}`);
}
console.log(`${n - bad}/${n}`);
process.exit(bad ? 1 : 0);
