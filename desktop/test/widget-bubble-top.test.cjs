// Облачко у верха экрана (fitBubble из widget.js) на поддельном окне, без Electron и браузера.
// 15.11.2026: виджет подвинули к верху экрана — прозрачный верх окна разрешено уводить за край (main.js, widgetBounds),
// а с ним уходил и верх высокого облачка: текст обрезался. Облачко должно опускаться ровно на ушедшее и возвращаться,
// когда окно снова ниже.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const src = fs.readFileSync(path.join(__dirname, "..", "renderer", "widget.js"), "utf8");
const m = src.match(/\nfunction fitBubble\(\) \{[^]*?\n\}\r?\n/);
check(Boolean(m), "в widget.js нет fitBubble");

// Облачко: низ закреплён (в окне на 340 px), высота 300; сдвиг --drop опускает его (как CSS translate),
// --room — потолок высоты (max-height): облачко укорачивается сверху.
const props = new Map();
const classes = new Set();
let base = 340, tall = 300;
const bubble = {
  classList: { contains: (c) => classes.has(c) },
  style: { getPropertyValue: (k) => props.get(k) ?? "", setProperty: (k, v) => props.set(k, v) },
  getBoundingClientRect: () => {
    const bottom = base + (parseFloat(props.get("--drop")) || 0);
    const room = parseFloat(props.get("--room"));
    return { bottom, top: bottom - Math.min(tall, Number.isFinite(room) ? room : Infinity) };
  },
};
const ctx = { $: () => bubble, screenY: 500, screen: { availTop: 0 }, Math, parseFloat };
vm.createContext(ctx);
const drop = () => parseFloat(props.get("--drop")) || 0;
const onScreenTop = () => ctx.screenY + bubble.getBoundingClientRect().top - ctx.screen.availTop;
try {
  vm.runInContext(m?.[0] ?? "", ctx);
  ctx.fitBubble();
  check(drop() === 0, `окно посреди экрана — облачко сдвинуто: ${drop()}`);

  ctx.screenY = -120; // верх окна за краем экрана: верх облачка на −80
  ctx.fitBubble();
  check(onScreenTop() >= 0 && onScreenTop() <= 8, `облачко за верхом экрана: верх на ${onScreenTop()}`);
  ctx.fitBubble(); // повторная проверка не копит сдвиг
  check(onScreenTop() >= 0 && onScreenTop() <= 8, `сдвиг накопился: верх на ${onScreenTop()}`);

  ctx.screen.availTop = 40; // панель задач сверху
  ctx.fitBubble();
  check(onScreenTop() >= 0 && onScreenTop() <= 8, `облачко под верхней панелью задач: ${onScreenTop()}`);

  ctx.screen.availTop = 0;
  ctx.screenY = 500; // окно отпустили ниже — облачко на своём месте
  ctx.fitBubble();
  check(drop() === 0, `облачко не вернулось: ${drop()}`);

  // 16.11.2026: свёрнутый виджет внизу экрана, под карточкой выдвинуты «Планы на день» — облачко поднялось выше верха окна
  // (верх в окне на −120) и срезалось. Окно на экране целиком: облачко укорачивается (текст листается), верх — в окне.
  ctx.screenY = 300;
  base = 180; // низ облачка в окне: высота 300 — верх на −120
  ctx.fitBubble();
  const r = bubble.getBoundingClientRect();
  check(r.top >= 0 && r.top <= 8, `облачко за верхом окна: верх в окне на ${r.top}`);
  check(drop() === 0, `облачко сдвинулось вниз, а не укоротилось: ${drop()}`);
  base = 340; // планы спрятали — облачко снова во весь рост
  ctx.fitBubble();
  check(bubble.getBoundingClientRect().top === 40, `облачко не выросло обратно: верх на ${bubble.getBoundingClientRect().top}`);

  classes.add("hidden");
  ctx.screenY = -300;
  ctx.fitBubble();
  check(drop() === 0, "спрятанное облачко двигается");
} catch (e) {
  check(false, `тест оборвался: ${e?.stack ?? e}`);
}
console.log(`${n - bad}/${n}`);
process.exit(bad ? 1 : 0);
