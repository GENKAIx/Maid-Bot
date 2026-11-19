// Анимация оценки дня (rate.js) без Electron и браузера.
// 17.11.2026: щелчок по звезде сразу сменял облачко ответом сервера. Теперь звёзды зажигаются по одной, а дальше — по
// ступени оценки: 1–3 осыпаются, 4–6 подпрыгивают, 7–9 летят к горничной, 10 — ещё и звездопад.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const dir = path.join(__dirname, "..", "renderer");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
const rate = read("rate.js"), widget = read("widget.js"), html = read("widget.html"), css = read("style.css");

check(html.indexOf('src="rate.js"') > 0 && html.indexOf('src="rate.js"') < html.indexOf('src="widget.js"'), "rate.js не подключён до widget.js");
// Ответ сервера показывается после анимации, а не поверх неё.
check(/const shown = rateShow\(Number\(m\[2\]\)\);[^]*?await shown;\s*say\(r\.text/.test(widget), "ответ сервера не ждёт конца анимации оценки");
// С 19.11.2026 правила звёзд общие для облачка и вечерней свёрнутой карточки: :is(.bubble-actions, .mini-stars).
check(/(\.bubble-actions|:is\(\.bubble-actions, \.mini-stars\))\.rated \.rate-star \{ pointer-events: none; \}/.test(css), "после оценки по звёздам можно щёлкнуть ещё раз");
check(/\.rate-fly \{[^}]*position: fixed;[^}]*pointer-events: none;/.test(css), "летящие звёзды перехватывают клики или не поверх окна");
check(/prefers-reduced-motion: reduce/.test(rate), "анимация оценки не учитывает «меньше движения»");

// Настроение горничной по ступеням.
const mood = vm.runInNewContext(rate.match(/const rateMood = [^\n]+/)[0] + "\n;rateMood");
const want = { 1: "sad", 3: "sad", 4: "bow", 6: "bow", 7: "happy", 8: "happy", 9: "proud", 10: "excited" };
for (const [v, m] of Object.entries(want)) check(mood(Number(v)) === m, `оценка ${v}: настроение ${mood(Number(v))}, ждали ${m}`);
const moods = eval(widget.match(/const MOODS = (\[[^\]]+\])/)[1]);
check(Object.values(want).every((m) => moods.includes(m)), "у оценки настроение, которого нет среди анимаций горничной");

// rateShow в песочнице: зажигает ровно v звёзд, блокирует ряд, по ступени запускает своё.
async function run(v) {
  const flown = [];
  const star = () => {
    const cls = new Set();
    const img = { getBoundingClientRect: () => ({ left: 10, top: 10, width: 20, height: 20 }), animate: () => ({ finished: Promise.resolve() }) };
    return { cls, classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c) }, querySelector: () => img };
  };
  const stars = Array.from({ length: 10 }, star);
  const acts = { cls: new Set(), classList: { add(c) { acts.cls.add(c); } }, querySelectorAll: () => stars };
  const reacted = [];
  const ctx = vm.createContext({
    $: (s) => (s === "#bubbleActions" ? acts : { getBoundingClientRect: () => ({ left: 300, top: 0, width: 100, height: 100 }) }),
    react: (m) => reacted.push(m), popTone() {},
    matchMedia: () => ({ matches: false }),
    setTimeout: (f) => { f(); return 0; },
    document: {
      createElement: () => ({ style: {}, remove() {}, animate: (frames) => { flown.push(frames); return { finished: Promise.resolve() }; } }),
      body: { appendChild() {} },
    },
    innerWidth: 400, innerHeight: 500, Math, Promise,
  });
  await vm.runInContext(rate + `\n;rateShow(${v})`, ctx);
  return { lit: stars.filter((s) => s.cls.has("on")).length, rated: acts.cls.has("rated"), flown: flown.length, reacted };
}
(async () => {
  const low = await run(2), mid = await run(5), high = await run(8), top = await run(10);
  check(low.rated && mid.rated && high.rated && top.rated, "ряд звёзд не блокируется после оценки");
  check(low.flown === 2 && low.lit === 0, `оценка 2: осыпаться должны две звезды и погаснуть (летит ${low.flown}, горит ${low.lit})`);
  check(mid.flown === 0 && mid.lit === 5, `оценка 5: звёзды остаются на месте зажжёнными (летит ${mid.flown}, горит ${mid.lit})`);
  check(high.flown === 8 && high.lit === 0, `оценка 8: к горничной должны лететь восемь звёзд (летит ${high.flown})`);
  check(top.flown === 10 + 26, `оценка 10: десять звёзд и звездопад (летит ${top.flown})`);
  check(low.reacted[0] === "sad" && top.reacted[0] === "excited", "горничная реагирует не по ступени оценки");
  console.log(`${n - bad}/${n}`);
  process.exit(bad ? 1 : 0);
})();
