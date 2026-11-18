// Волна записи голоса (voice.js: waveBars) без браузера.
// 19.11.2026: волна «глитчила» — сдвиг шёл по часам, а новый столбик добавляет таймер замеров, который опаздывает на
// миллисекунды: в эти кадры вся волна прыгала на шаг вправо и обратно. Теперь место столбика — по его времени
// (k-й столбик — момент (k+1)·STEP), и каждый столбик едет только влево, плавно, когда бы ни пришёл следующий.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const src = fs.readFileSync(path.join(__dirname, "..", "renderer", "voice.js"), "utf8");
const ctx = { window: {}, navigator: {}, setTimeout, clearTimeout, setInterval, clearInterval };
vm.createContext(ctx);
try {
  vm.runInContext(`${src}\nthis.Voice = Voice;`, ctx);
  const { waveBars, STEP } = ctx.Voice;
  check(typeof waveBars === "function" && STEP > 0, "в Voice нет waveBars или STEP");
  const W = 300, PITCH = 8, GAP = 4;
  // Замеры приходят с опозданием 25 мс: столбик k появляется в (k+1)·STEP + 25.
  const LATE = 25;
  const levelsAt = (t) => Array.from({ length: Math.max(0, Math.floor((t - LATE) / STEP)) }, (_, k) => k / 100);
  const xOf = (t, k) => waveBars(levelsAt(t), 0, t, W, PITCH, GAP).find((b) => b.lv === k / 100)?.x;
  let jumps = 0, worst = 0;
  for (let t = 10 * STEP; t < 30 * STEP; t += 3) {
    for (let k = 0; k < 9; k++) {
      const a = xOf(t, k), b = xOf(t + 3, k);
      if (a === undefined || b === undefined) continue;
      if (b > a + 1e-9) { jumps++; worst = Math.max(worst, b - a); }
    }
  }
  check(jumps === 0, `столбики не прыгают вправо, когда замер опоздал: ${jumps} скачков, до ${worst.toFixed(1)} px`);
  // За 3 мс столбик сдвигается на долю шага, а не на целый шаг.
  const a = xOf(20 * STEP + 40, 5), b = xOf(20 * STEP + 43, 5);
  check(a - b > 0 && a - b < PITCH / 4, `плавный сдвиг за 3 мс: ${(a - b).toFixed(2)} px`);
  // Новый столбик въезжает справа из-за края (как раньше), старые уходят влево.
  const bars = waveBars(levelsAt(20 * STEP + LATE), 0, 20 * STEP + LATE, W, PITCH, GAP);
  check(bars.length && bars[0].x <= W + GAP && bars[0].x > W - PITCH, `новый столбик — у правого края: ${bars[0]?.x}`);
  // Сдвиг начала (старые замеры выброшены) не двигает оставшиеся.
  const lv = levelsAt(20 * STEP + LATE);
  const whole = waveBars(lv, 0, 20 * STEP + LATE, W, PITCH, GAP);
  const cut = waveBars(lv.slice(5), 5, 20 * STEP + LATE, W, PITCH, GAP);
  check(cut[0].x === whole[0].x, "выброшенные старые замеры не сдвигают волну");
} catch (e) {
  n++; bad++;
  console.log("FAIL", e.message);
}
console.log(`${n - bad}/${n} проверок`);
if (bad) process.exit(1);
