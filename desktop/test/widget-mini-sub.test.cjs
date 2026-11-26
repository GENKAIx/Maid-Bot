// Вторая строка свёрнутой карточки (widget.js, miniSubLines и fitMiniSub) без Electron и браузера.
// 19.11.2026: строка «через 40 мин · 2 просрочены · 3 дела» шириной 215 px не влезала в свои 136 px и обрывалась
// «через 40 мин · 2 п…» — число просроченного пропадало. Теперь у строки несколько вариантов, от полного к короткому,
// и ставится первый, что влезает целиком. Просрочка не пропадает никогда. С 26.11.2026 вместо «3 дела» — «осталось 3 из 9»,
// а первым уходит отсчёт «через 40 мин» (время плана видно строкой выше): в кольце цифр больше нет.
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
  // 26.11.2026: вместо «N дел» — «осталось N из M» (N — все несделанные, вместе с просроченными), всё сделано — «всё сделано»;
  // отсчёт уходит последним (решение владельца 26.11.2026): сперва счёт сокращается до «5 из 9», потом пропадает.
  const L = (...a) => ctx.lines(...a);
  const full = L("через 40 мин", 2, 5, 9);
  check(full[0] === "через 40 мин · 2 просрочены · осталось 5 из 9", `полная строка: ${full[0]}`);
  check(full.every((s) => s.includes("2 просрочены")), `просрочка пропала в одном из вариантов: ${full.join(" | ")}`);
  check(full.at(-1) === "2 просрочены", `самый короткий вариант при просрочке — только она: ${full.at(-1)}`);
  check(full.every((s, i) => i === 0 || s.length < full[i - 1].length), `варианты не укорачиваются по порядку: ${full.join(" | ")}`);
  check(JSON.stringify(L("через 40 мин", 0, 5, 9)) === JSON.stringify(["через 40 мин · осталось 5 из 9", "через 40 мин · 5 из 9", "через 40 мин"]), `без просрочки: ${L("через 40 мин", 0, 5, 9).join(" | ")}`);
  check(L("через 1 ч", 0, 23, 24)[0] === "через 1 ч · осталось 23 из 24", `пример владельца: ${L("через 1 ч", 0, 23, 24)[0]}`);
  check(!L("через 1 ч", 0, 23, 24).some((s) => /\d дел/.test(s)), "осталось старое «N дел»");
  check(JSON.stringify(L("через 1 ч", 0, 0, 24)) === JSON.stringify(["через 1 ч · всё сделано", "через 1 ч"]), `всё сделано: ${L("через 1 ч", 0, 0, 24).join(" | ")}`);
  check(JSON.stringify(L("через 1 ч", 0, 0, 0)) === JSON.stringify(["через 1 ч"]), `дел на сегодня нет — без счёта: ${L("через 1 ч", 0, 0, 0).join(" | ")}`);
  check(JSON.stringify(L(undefined, 2, 3, 5)) === JSON.stringify(["2 просрочены"]), `без плана счёт не пишется (как раньше): ${L(undefined, 2, 3, 5).join(" | ")}`);
  check(L(undefined, 0, 4, 6).length === 0, "без плана и просрочки строки нет");
  check(L("идёт", 1, 1, 4)[0] === "идёт · 1 просрочено · осталось 1 из 4", `падеж: ${L("идёт", 1, 1, 4)[0]}`);
  check(L("через 2 ч", 12, 14, 20)[0] === "через 2 ч · 12 просрочено · осталось 14 из 20", `падеж: ${L("через 2 ч", 12, 14, 20)[0]}`);
}

if (ctx.fit) {
  const fitted = (lines) => { ctx.set(lines); ctx.fit(); return el.textContent; };
  const cases = [
    ["через 40 мин", 2, 5, 9], ["через 59 мин", 12, 14, 27], ["идёт", 1, 3, 4], ["через 2 ч", 12, 14, 30], ["через 12 ч", 2, 2, 2], ["через 40 мин", 0, 14, 27],
    ["через 1 ч", 0, 23, 24], ["через 1 ч", 0, 0, 24], [undefined, 3, 2, 5],
  ];
  for (const [rel, late, left, total] of cases) {
    const t = fitted(ctx.lines(rel, late, left, total));
    check(t.length * 6.6 <= 136, `«${t}» не влезает в карточку (${rel}, просрочено ${late}, осталось ${left} из ${total})`);
    if (late) check(t.includes(`${late} просроч`), `в карточке «${t}» нет просрочки`);
  }
  check(fitted(ctx.lines("через 1 ч", 0, 23, 24)) === "через 1 ч · 23 из 24", `пример владельца в карточке: ${el.textContent}`);
  check(["идёт", "через 5 мин", "через 40 мин"].every((r) => fitted(ctx.lines(r, 0, 23, 24)).startsWith(r)), `отсчёт пропал из карточки без просрочки: ${el.textContent}`);
  check(fitted(ctx.lines("идёт", 0, 0, 5)) === "идёт · всё сделано", "влезающая строка укоротилась зря");
  check(fitted(ctx.lines("через 40 мин", 2, 5, 9)) === "2 просрочены", `при просрочке: ${el.textContent}`);
  check(fitted([]) === "", "пустая строка не очистилась — в карточке осталась прежняя");
  // Свёрнутой карточки не видно (развёрнута панель): мерить нечем — полная строка, подгонка при сворачивании.
  el.clientWidth = 0;
  check(fitted(ctx.lines("через 40 мин", 2, 5, 9)) === "через 40 мин · 2 просрочены · осталось 5 из 9", "в скрытой карточке строка укоротилась вслепую");
  el.clientWidth = 136;
}

// Подгонка ещё раз — когда карточку показали (свернули панель) и когда догрузился шрифт.
const fold = widget.match(/\nfunction setCollapsed\([^]*?\n\}/)?.[0] ?? "";
check(/fitMiniSub\(\)/.test(fold), "setCollapsed не подгоняет строку карточки при сворачивании");
check(/fonts\??\.ready[^\n]*fitMiniSub/.test(widget), "после загрузки шрифта строка карточки не подгоняется");
const mini = widget.match(/\nfunction renderMini\([^]*?\n\}/)?.[0] ?? "";
// С 19.11.2026 строки по времени суток собирает miniView (widget-mini-day.test.cjs); днём — по-прежнему miniSubLines.
const view = widget.match(/\nfunction miniView\([^]*?\n\}/)?.[0] ?? "";
check(/miniView\(/.test(mini) && /fitMiniSub\(\)/.test(mini) && /miniSubLines\(plan\?\.rel, late, left, done \+ left\)/.test(view), "renderMini не берёт строку из miniSubLines/fitMiniSub");

console.log(`${n - bad}/${n}`);
process.exit(bad ? 1 : 0);
