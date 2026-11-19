// Вторая строка свёрнутой карточки (widget.js, miniSubLines и fitMiniSub) без Electron и браузера.
// 19.11.2026: строка «через 40 мин · 2 просрочены · 3 дела» шириной 215 px не влезала в свои 136 px и обрывалась
// «через 40 мин · 2 п…» — число просроченного пропадало. Теперь у строки несколько вариантов, от полного к короткому,
// и ставится первый, что влезает целиком: сначала уходит «3 дела» (их видно в кольце), потом «через 40 мин» (время плана
// видно строкой выше). Просрочка не пропадает никогда.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const root = path.join(__dirname, "..");
const widget = fs.readFileSync(path.join(root, "renderer", "widget.js"), "utf8");
const clock = fs.readFileSync(path.join(root, "renderer", "clock.js"), "utf8");

const pick = (src, re, what) => { const s = src.match(re)?.[0]; check(s, `нет ${what}`); return s ?? ""; };
const code = [
  pick(clock, /\nconst plural = .*/, "plural в clock.js"),
  pick(widget, /\nfunction miniSubLines\([^]*?\n\}/, "miniSubLines в widget.js"),
  pick(widget, /\nlet miniLines = .*/, "miniLines в widget.js"),
  pick(widget, /\nfunction fitMiniSub\([^]*?\n\}/, "fitMiniSub в widget.js"),
].join("\n");

// Строка карточки: ширина текста — 6,6 px на знак (Onest 12 px, как на стенде: «через 40 мин · 5 дел» ≈ 132 px), места 136 px.
const el = { textContent: "", clientWidth: 136, get scrollWidth() { return Math.max(this.clientWidth, Math.round(this.textContent.length * 6.6)); } };
const ctx = { $: () => el };
vm.createContext(ctx);
try {
  vm.runInContext(`${code}\nthis.lines = miniSubLines; this.fit = fitMiniSub; this.set = (l) => { miniLines = l; };`, ctx);
} catch (e) {
  check(false, `код не разобрался: ${e?.message ?? e}`);
}

if (ctx.lines) {
  const L = (...a) => ctx.lines(...a);
  const full = L("через 40 мин", 2, 3);
  check(full[0] === "через 40 мин · 2 просрочены · 3 дела", `полная строка: ${full[0]}`);
  check(full.every((s) => s.includes("2 просрочены")), `просрочка пропала в одном из вариантов: ${full.join(" | ")}`);
  check(full.at(-1) === "2 просрочены", `самый короткий вариант при просрочке — только она: ${full.at(-1)}`);
  check(full.every((s, i) => i === 0 || s.length < full[i - 1].length), `варианты не укорачиваются по порядку: ${full.join(" | ")}`);
  check(JSON.stringify(L("через 40 мин", 0, 5)) === JSON.stringify(["через 40 мин · 5 дел", "через 40 мин"]), `без просрочки: ${L("через 40 мин", 0, 5).join(" | ")}`);
  check(JSON.stringify(L(undefined, 2, 3)) === JSON.stringify(["2 просрочены"]), `без плана «N дел» не пишется (как раньше): ${L(undefined, 2, 3).join(" | ")}`);
  check(L(undefined, 0, 4).length === 0, "без плана и просрочки строки нет");
  check(L("идёт", 1, 0)[0] === "идёт · 1 просрочено", `падеж: ${L("идёт", 1, 0)[0]}`);
  check(L("через 2 ч", 12, 14)[0] === "через 2 ч · 12 просрочено · 14 дел", `падеж: ${L("через 2 ч", 12, 14)[0]}`);
}

if (ctx.fit) {
  const fitted = (lines) => { ctx.set(lines); ctx.fit(); return el.textContent; };
  const cases = [
    ["через 40 мин", 2, 3], ["через 59 мин", 12, 14], ["идёт", 1, 3], ["через 2 ч", 12, 14], ["через 12 ч", 2, 0], ["через 40 мин", 0, 14], [undefined, 3, 2],
  ];
  for (const [rel, late, rest] of cases) {
    const t = fitted(ctx.lines(rel, late, rest));
    check(t.length * 6.6 <= 136, `«${t}» не влезает в карточку (${rel}, просрочено ${late}, дел ${rest})`);
    if (late) check(t.includes(`${late} просроч`), `в карточке «${t}» нет просрочки`);
  }
  check(fitted(ctx.lines("через 40 мин", 0, 5)) === "через 40 мин · 5 дел", "влезающая строка укоротилась зря");
  check(fitted(ctx.lines("через 40 мин", 2, 3)) === "2 просрочены", `при просрочке: ${el.textContent}`);
  check(fitted([]) === "", "пустая строка не очистилась — в карточке осталась прежняя");
  // Свёрнутой карточки не видно (развёрнута панель): мерить нечем — полная строка, подгонка при сворачивании.
  el.clientWidth = 0;
  check(fitted(ctx.lines("через 40 мин", 2, 3)) === "через 40 мин · 2 просрочены · 3 дела", "в скрытой карточке строка укоротилась вслепую");
  el.clientWidth = 136;
}

// Подгонка ещё раз — когда карточку показали (свернули панель) и когда догрузился шрифт.
const fold = widget.match(/\nfunction setCollapsed\([^]*?\n\}/)?.[0] ?? "";
check(/fitMiniSub\(\)/.test(fold), "setCollapsed не подгоняет строку карточки при сворачивании");
check(/fonts\??\.ready[^\n]*fitMiniSub/.test(widget), "после загрузки шрифта строка карточки не подгоняется");
const mini = widget.match(/\nfunction renderMini\([^]*?\n\}/)?.[0] ?? "";
// С 19.11.2026 строки по времени суток собирает miniView (widget-mini-day.test.cjs); днём — по-прежнему miniSubLines.
const view = widget.match(/\nfunction miniView\([^]*?\n\}/)?.[0] ?? "";
check(/miniView\(/.test(mini) && /fitMiniSub\(\)/.test(mini) && /miniSubLines\(plan\?\.rel, late, left - late\)/.test(view), "renderMini не берёт строку из miniSubLines/fitMiniSub");

console.log(`${n - bad}/${n}`);
process.exit(bad ? 1 : 0);
