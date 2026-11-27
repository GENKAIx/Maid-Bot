// Привычки «несколько раз в день» (×N) и новые отметки в виджете без Electron и браузера (28.11.2026).
// Сервер (шаг 42) отдаёт в /api/today у привычки count и need; виджет вместо кружка рисует кольцо из need долей, справа от названия
// «3/5»; щелчок — POST …/mark {day, step: 1}, правый щелчок по кольцу — {step: -1}, по строке — меню. Сделано, опыт и салют —
// только при count >= need. Сделано у всех привычек — залитый круг с жирной тёмной галочкой, пропуск — залитый серый с тёмным минусом.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const root = path.join(__dirname, "..");
const widget = fs.readFileSync(path.join(root, "renderer", "widget.js"), "utf8");
const css = fs.readFileSync(path.join(root, "renderer", "style.css"), "utf8").replace(/\/\*[^]*?\*\//g, "");

// --- помощники отметки: кусок widget.js от HABIT_TICK до UNDO_WINDOW исполняется как есть ---
const helpers = widget.match(/\nconst HABIT_TICK = [^]*?\n(?=const UNDO_WINDOW)/)?.[0] ?? "";
check(helpers, "в widget.js нет помощников отметки (HABIT_TICK … habitDoneBody)");
const ctx = { data: { day: "2026-11-28", habits: [] }, Math, Number, Infinity };
vm.createContext(ctx);
try { vm.runInContext(`${helpers}\nthis.api = { HABIT_TICK, HABIT_SKIP, habitNeed, habitCount, habitRing, habitMarkClass, habitMarkHtml, habitNHtml, habitDoneBody, habitPending, habitHold };`, ctx); } catch (e) { check(false, `помощники не исполнились: ${e.message}`); }
const A = ctx.api ?? {};

// Новая галочка и минус — точная форма из примера дизайна.
check(/<circle class="mk-bg" cx="9" cy="9" r="8"\/>/.test(A.HABIT_TICK ?? "") && /d="M5\.5 9\.2l2\.3 2\.3 4\.6-4\.8"/.test(A.HABIT_TICK ?? ""), "галочка не круг r 8 с путём M5.5 9.2l2.3 2.3 4.6-4.8");
check(/viewBox="0 0 18 18"/.test(A.HABIT_TICK ?? ""), "галочка не в поле 18×18");
check(/<circle class="mk-bg" cx="9" cy="9" r="8"\/>/.test(A.HABIT_SKIP ?? "") && /d="M5\.5 9h7"/.test(A.HABIT_SKIP ?? ""), "минус не круг r 8 с путём M5.5 9h7");

// need и count: старый сервер (нет need) — обычная привычка; count не больше need; пропуск — 0; сделано — need.
check(A.habitNeed?.({}) === 1 && A.habitNeed?.({ need: 1 }) === 1 && A.habitNeed?.({ need: 5 }) === 5 && A.habitNeed?.({ need: "5" }) === 1, "habitNeed: старый сервер или need 1 — не обычная привычка");
check(A.habitCount?.({ need: 5, count: 3 }) === 3 && A.habitCount?.({ need: 5, count: 9 }) === 5 && A.habitCount?.({ need: 5, count: -2 }) === 0, "habitCount не держится в 0…need");
check(A.habitCount?.({ need: 5, count: 2, status: "skipped" }) === 0 && A.habitCount?.({ need: 5, count: 4, status: "done" }) === 5, "habitCount: пропуск не 0 или сделанное не need");

// Кольцо: need долей, отмеченные — mk-on; r 7 вокруг (9, 9); зазоры есть; больше 10 — сектор, без долей.
const segs = (svg, cls) => (svg.match(new RegExp(`class="${cls}"`, "g")) ?? []).length;
const r35 = A.habitRing?.(3, 5) ?? "";
check(segs(r35, "mk-on") === 3 && segs(r35, "mk-off") === 2, `3 из 5: долей не 3 + 2 (${r35})`);
check(segs(A.habitRing?.(0, 5) ?? "", "mk-on") === 0 && segs(A.habitRing?.(0, 5) ?? "", "mk-off") === 5, "0 из 5: не пять пустых долей");
check(segs(A.habitRing?.(2, 2) ?? "", "mk-on") === 2, "2 из 2: не две полные доли");
check(segs(A.habitRing?.(10, 10) ?? "", "mk-on") === 10 && !/mk-pie/.test(A.habitRing?.(4, 10) ?? ""), "10 в день — ещё доли, не сектор");
{
  // Каждая доля — дуга r 7: концы на окружности радиуса 7 вокруг (9, 9). Зазор — видимый, с учётом круглых концов (полтолщины:
  // 1,3 у отмеченной, 0,65 у пустой): между соседними долями ~0,35 рад, и отмеченные не сливаются в сплошную дугу.
  const ang = (x, y) => Math.atan2(y - 9, x - 9);
  const arcsOf = (svg) => [...svg.matchAll(/class="(mk-on|mk-off)" d="M([\d.-]+) ([\d.-]+)A7 7 0 0 1 ([\d.-]+) ([\d.-]+)"/g)]
    .map((m) => ({ cap: (m[1] === "mk-on" ? 1.3 : 0.65) / 7, a0: ang(+m[2], +m[3]), a1: ang(+m[4], +m[5]), pts: m.slice(2).map(Number) }));
  const gaps = (arcs) => arcs.map((a, k) => { const b = arcs[(k + 1) % arcs.length]; return (((b.a0 - a.a1) + 4 * Math.PI) % (2 * Math.PI)) - a.cap - b.cap; });
  const arcs = arcsOf(r35);
  const onCircle = arcs.every(({ pts: [x0, y0, x1, y1] }) => Math.abs(Math.hypot(x0 - 9, y0 - 9) - 7) < 0.02 && Math.abs(Math.hypot(x1 - 9, y1 - 9) - 7) < 0.02);
  check(arcs.length === 5 && onCircle, `доли не дугами r 7 (${arcs.length})`);
  const g35 = gaps(arcs);
  check(g35.length === 5 && g35.every((g) => Math.abs(g - 0.35) < 0.01), `видимый зазор 3/5 не ~0,35 рад (${g35.map((g) => g.toFixed(3))})`);
  check(arcs.length && Math.abs(arcs[0].a0 - arcs[0].cap - (-Math.PI / 2 + 0.175)) < 0.01, "первая доля (с концом) начинается не от верха");
  // Отмеченные подряд (4/5, 5/6, 7/8, 9/10) — между ними видимый зазор, в пикселях не меньше 1,2 px (r 7).
  for (const [c, nd] of [[4, 5], [5, 6], [7, 8], [9, 10], [10, 10]]) {
    const a = arcsOf(A.habitRing?.(c, nd) ?? "");
    const g = gaps(a);
    check(a.length === nd && Math.min(...g) * 7 > 1.2, `${c}/${nd}: отмеченные доли слиплись (видимый зазор ${(Math.min(...g) * 7).toFixed(2)} px)`);
  }
}
const pie = A.habitRing?.(7, 12) ?? "";
check(/class="mk-pie"/.test(pie) && !/mk-on/.test(pie), `12 в день — не сектор (${pie})`);
check(/A7 7 0 1 1 /.test(pie), "7 из 12 — больше половины, а сектор с малой дугой");
check(!/mk-pie/.test(A.habitRing?.(0, 12) ?? "") && /<circle class="mk-pie"/.test(A.habitRing?.(12, 12) ?? ""), "сектор: 0 — не пустой или 12 из 12 — не полный круг");

// Что в строке: сделано (и ×N с набранной нормой) — галочка; пропуск — минус; ×N — кольцо; обычная — пусто.
check(A.habitMarkHtml?.({ status: "done" }) === A.HABIT_TICK && A.habitMarkHtml?.({ status: "done", need: 5, count: 5 }) === A.HABIT_TICK, "у сделанной не новая галочка");
check(A.habitMarkHtml?.({ status: "skipped" }) === A.HABIT_SKIP && A.habitMarkHtml?.({ status: "skipped", need: 5 }) === A.HABIT_SKIP, "у пропуска не новый минус");
check(A.habitMarkHtml?.({ status: null }) === "" && A.habitMarkClass?.({ status: null }) === "", "обычная неотмеченная — не пустой кружок");
check(/mk-on/.test(A.habitMarkHtml?.({ status: null, need: 5, count: 3 }) ?? "") && A.habitMarkClass?.({ status: null, need: 5, count: 3 }) === "multi", "×N 3/5 — не кольцо с классом multi");
check(A.habitNHtml?.({ need: 5, count: 3 }) === `<span class="habit-n">3/5</span>` && A.habitNHtml?.({ need: 5, status: "done" }) === `<span class="habit-n">5/5</span>`, "у ×N нет «3/5» / «5/5»");
check(A.habitNHtml?.({}) === "" && A.habitNHtml?.({ need: 5, status: "skipped" }) === "", "«N/M» у обычной или у пропуска");
ctx.data.habits = [{ id: 1, need: 5, count: 4 }, { id: 2 }];
check(JSON.stringify(A.habitDoneBody?.(1)) === JSON.stringify({ day: "2026-11-28", step: 1 }) && JSON.stringify(A.habitDoneBody?.(2)) === JSON.stringify({ status: "done" }), "закрытие дня: у ×N не {day, step:1} или у обычной не {status:done}");

// Строка списка берёт отметку из помощников; старых «✓» и «–» в разметке строки нет.
const item = widget.match(/const dayItem = \(h\) => \{[^]*?\n  \};/)?.[0] ?? "";
check(/class="mark \$\{habitMarkClass\(h\)\}"/.test(item) && /\$\{habitMarkHtml\(h\)\}/.test(item), "dayItem рисует отметку не через habitMarkClass/habitMarkHtml");
check(!/"✓" : h\.status === "skipped" \? "–"/.test(item), "в dayItem остались тонкие ✓ и –");
check(/habitNHtml\(/.test(item), "в dayItem нет «3/5» (habitNHtml)");
check(/<i>\$\{HABIT_TICK\}<\/i><b>×<\/b>/.test(item), "улетающая привычка — со старой тонкой галочкой");

// load(): шаги ×N в пути накладываются на каждый снимок /api/today — до hpSync (серии и «все привычки дня») и до перерисовки.
check(/data = fresh;[^]*?habitHold\(data, seq\);[^\n]*\n\s*hpSync\(data\)/.test(widget.match(/async function load\(\) \{[^]*?\n\}/)?.[0] ?? ""), "load не накладывает шаги в пути (habitHold) перед hpSync");
// Щелчок: ×N — stepHabit (+1, у набранной нормы −1); в «улетают» последняя отметка — startLeave, тогда шлёт rowCommit.
const click = widget.match(/\$\("#body"\)\.addEventListener\("click", async \(e\) => \{[^]*?\n\}\);/)?.[0] ?? "";
check(/habitNeed\(hx\) > 1/.test(click) && /return stepHabit\(hx, hx\.status === "done" \? -1 : 1, tick\)/.test(click), "щелчок по ×N не идёт в stepHabit(±1)");
check(/cfg\.doneTasks === "hide" && last/.test(click), "в «улетают» последняя отметка ×N не улетает строкой");
check(/e\.target\.innerHTML = was \? "" : HABIT_TICK/.test(click), "щелчок по обычной привычке ставит не новую галочку");
const commit = widget.match(/async function rowCommit\(key\) \{[^]*?\n\}/)?.[0] ?? "";
check(/habitDoneBody\(id\)/.test(commit), "rowCommit у ×N шлёт не step 1");
check(/habitDoneBody\(Number\(key\.slice\(1\)\)\)/.test(widget), "при закрытии окна ×N уходит не step 1");

// Правый щелчок: по кольцу ×N с отметками — снять одну; иначе меню; в меню ×N — ±1 и «Снять все».
const ctxm = widget.match(/\$\("#body"\)\.addEventListener\("contextmenu", \(e\) => \{\n  const li = e\.target\.closest\("ul\.list li\.habit"\);[^]*?\n\}\);/)?.[0] ?? "";
check(/e\.target\.closest\("\.mark\[data-habit\]"\) && habitNeed\(h\) > 1 && habitCount\(h\) > 0\) return stepHabit\(h, -1, mark\)/.test(ctxm), "правый щелчок по кольцу не снимает одну отметку");
check(/openHabitMenu\(h, li, e\.clientX, e\.clientY\)/.test(ctxm), "правый щелчок по строке больше не открывает меню");
const menu = widget.match(/function openHabitMenu\(h, li, x, y\) \{[^]*?\n\}/)?.[0] ?? "";
check(/item\("step\+"/.test(menu) && /item\("step-"/.test(menu) && /Снять все отметки/.test(menu), "в меню ×N нет «+1», «−1» и «Снять все отметки»");
check(/act === "step\+" \? 1 : -1/.test(menu), "пункты ±1 меню не зовут stepHabit");

// stepHabit по-настоящему: вид, запрос, опыт один раз при наборе нормы, откат при ошибке.
const stepSrc = widget.match(/\nasync function stepHabit\(h, step, mark\) \{[^]*?\n\}/)?.[0] ?? "";
check(stepSrc, "в widget.js нет stepHabit");
const cls = () => { const s = new Set(); return { add: (...a) => a.forEach((x) => s.add(x)), remove: (x) => s.delete(x), toggle: (x, on) => (on ? s.add(x) : s.delete(x)), contains: (x) => s.has(x), s }; };
function stand(fail = false) {
  const log = { posts: [], xp: [], tones: [], bursts: 0, reacts: [], loads: 0, renders: 0, says: [] };
  const nTag = { textContent: "" };
  const li = { classList: cls(), querySelector: (q) => (q === ".habit-n" ? nTag : null) };
  const mark = { className: "", classList: cls(), innerHTML: "", isConnected: true, offsetWidth: 16, closest: () => li };
  Object.defineProperty(mark, "className", { get() { return this._c; }, set(v) { this._c = v; this.classList = cls(); for (const c of v.split(/\s+/).filter(Boolean)) this.classList.add(c); } });
  const sx = { data: { day: "2026-11-28" }, Math, Number, Boolean, Date, Infinity, habitDoneAt: new Map(), animUntil: 0, loadSeq: 0, log, nTag, li, mark,
    maid: { api: async (m, p, b) => { log.posts.push({ m, p, b }); if (fail) throw new Error("нет связи"); const need = b.step ? 5 : 1; return { text: "ok", count: log.nextCount, need, status: log.nextStatus ?? null }; }, changed: () => {} },
    popTone: (x) => log.tones.push(x), burst: () => log.bursts++, xpGain: (_, k) => log.xp.push(`+${k}`), xpTake: (k) => log.xp.push(`-${k}`),
    xpUndo: (k, s = -1) => log.xp.push(`undo${s}${k}`), xpSent: () => {}, react: (x) => log.reacts.push(x), answeredInList: () => {},
    play: () => {}, say: (t) => log.says.push(t), errText: (e) => e.message, load: () => log.loads++, render: () => log.renders++ };
  vm.createContext(sx);
  vm.runInContext(`${helpers}\n${stepSrc}\nthis.stepHabit = stepHabit; this.HABIT_TICK = HABIT_TICK; this.habitHold = habitHold; this.habitPending = habitPending;`, sx);
  return sx;
}
(async () => {
  try {
    // 3/5 → 4/5: кольцо, «4/5», {day, step:1}, без опыта и брызг.
    let s = stand(); let h = { id: 7, need: 5, count: 3, status: null };
    s.log.nextCount = 4;
    await s.stepHabit(h, 1, s.mark);
    check(JSON.stringify(s.log.posts[0]) === JSON.stringify({ m: "POST", p: "/api/habits/7/mark", b: { day: "2026-11-28", step: 1 } }), `+1 шлёт не {day, step:1}: ${JSON.stringify(s.log.posts[0])}`);
    check(h.count === 4 && h.status === null && s.mark.classList.contains("multi") && s.mark.classList.contains("pressed"), `4/5: не кольцо или нет «чпока» (${s.mark.className})`);
    check(s.nTag.textContent === "4/5" && !s.li.classList.contains("did"), "4/5: метка не «4/5» или строка уже «сделано»");
    check(!s.log.xp.length && !s.log.bursts && !s.log.reacts.length, `неполная норма дала опыт/брызги/радость: ${JSON.stringify(s.log)}`);
    check(s.animUntil > Date.now() + 300, "во время «чпока» список перерисовывается (animUntil не отложен)");
    check(!s.log.loads, "после удачной отметки лишний load (перезагрузку зовёт maid.changed)");
    // 4/5 → 5/5: галочка, сделано, опыт +5 один раз, брызги, «серия».
    s.log.nextCount = 5; s.log.nextStatus = "done";
    await s.stepHabit(h, 1, s.mark);
    check(h.status === "done" && s.mark.innerHTML === s.HABIT_TICK && s.mark.classList.contains("done") && s.li.classList.contains("did"), "5/5: не новая галочка или не «сделано»");
    check(JSON.stringify(s.log.xp) === JSON.stringify(["+habit"]) && s.log.bursts === 1 && s.log.reacts.includes("streak"), `5/5: опыт или брызги не один раз (${JSON.stringify(s.log.xp)})`);
    check(s.habitDoneAt.has(7), "5/5: строка не встаёт первой среди сделанных (habitDoneAt)");
    // Ещё щелчок по набранной норме +1 — ничего не шлёт и опыт не даёт.
    const posts = s.log.posts.length;
    await s.stepHabit(h, 1, s.mark);
    check(s.log.posts.length === posts && s.log.xp.length === 1, "+1 по сделанному дню ушёл на сервер или дал опыт ещё раз");
    // 5/5 → 4/5 (правый щелчок): {step:-1}, опыт назад, снова кольцо.
    s.log.nextCount = 4; s.log.nextStatus = null;
    await s.stepHabit(h, -1, s.mark);
    check(s.log.posts.at(-1).b.step === -1 && h.count === 4 && h.status === null && s.mark.classList.contains("multi"), "−1 с набранной нормы: не {step:-1} или не кольцо 4/5");
    check(s.log.xp.at(-1) === "-habit", "−1 с набранной нормы не забрал опыт");
    // −1 при 0 отметок — ничего.
    s = stand(); h = { id: 8, need: 5, count: 0, status: null };
    await s.stepHabit(h, -1, s.mark);
    check(!s.log.posts.length, "−1 при нуле отметок ушёл на сервер");
    // Ошибка: всё назад, опыт назад, её слова, перерисовка.
    s = stand(true); h = { id: 9, need: 2, count: 1, status: null };
    await s.stepHabit(h, 1, s.mark);
    check(h.count === 1 && h.status === null, `ошибка: count/status не вернулись (${JSON.stringify(h)})`);
    check(JSON.stringify(s.log.xp) === JSON.stringify(["+habit", "undo-1habit"]) && s.log.says[0] === "нет связи" && s.log.renders === 1, `ошибка: опыт не вернулся или нет слов (${JSON.stringify(s.log)})`);

    // Шаги в пути и опрос (находка ревью): ×5 на 2/5, три быстрых щелчка; ответы приходят по одному, а между ними load()
    // приносит снимок, где ещё нет поздних шагов. Итог — 5/5, ровно одна прибавка опыта, кольцо не мигает назад.
    s = stand();
    const waits = [];
    s.maid.api = (m, p, b) => { s.log.posts.push({ m, p, b }); return new Promise((ok) => waits.push(ok)); };
    s.data = { day: "2026-11-28", habits: [{ id: 11, need: 5, count: 2, status: null }] };
    const snap = (count, status = null) => { s.loadSeq++; s.data = { day: "2026-11-28", habits: [{ id: 11, need: 5, count, status }] }; s.habitHold(s.data, s.loadSeq); return s.data.habits[0]; };
    const p1 = s.stepHabit(s.data.habits[0], 1, s.mark); // 3
    const p2 = s.stepHabit(s.data.habits[0], 1, s.mark); // 4
    waits[0]({ text: "ok", count: 3, need: 5, status: null }); await p1;
    let shown = snap(3); // GET успел раньше, чем сервер применил второй шаг
    check(shown.count === 4 && shown.status === null, `снимок без шага в пути сбил кольцо: ${JSON.stringify(shown)}`);
    const p3 = s.stepHabit(shown, 1, s.mark); // 5 — от показанного 4, а не от снимка 3
    check(s.data.habits[0].count === 5 && s.data.habits[0].status === "done", `третий щелчок посчитал не от показанного: ${JSON.stringify(s.data.habits[0])}`);
    shown = snap(4); // ещё один старый снимок, пока шаги идут
    check(shown.count === 5 && shown.status === "done", `пока шаги в пути, «сделано» мигнуло назад: ${JSON.stringify(shown)}`);
    const before = s.log.posts.length;
    await s.stepHabit(shown, 1, s.mark);
    check(s.log.posts.length === before, "+1 по набранной норме (пока шаги в пути) ушёл на сервер");
    waits[1]({ text: "ok", count: 4, need: 5, status: null }); await p2; // ответ раннего шага старее показанного
    check(s.data.habits[0].count === 5 && s.data.habits[0].status === "done", `ответ раннего шага затёр показанное: ${JSON.stringify(s.data.habits[0])}`);
    waits[2]({ text: "ok", count: 5, need: 5, status: "done" }); await p3;
    check(s.data.habits[0].count === 5 && s.data.habits[0].status === "done", "после всех ответов не 5/5");
    check(JSON.stringify(s.log.xp) === JSON.stringify(["+habit"]) && s.log.bursts === 1, `опыт или брызги не ровно один раз: ${JSON.stringify(s.log.xp)}`);
    check(s.log.posts.filter((x) => x.p === "/api/habits/11/mark").length === 3, `ушло не три шага: ${s.log.posts.length}`);
    // Снимок, запрошенный после последнего ответа, — уже правда сервера: запись шагов в пути снята.
    shown = snap(5, "done");
    check(!s.habitPending.has(11) && shown.count === 5, "после свежего снимка шаги в пути не сняты");
    // Ошибка одного из двух шагов рядом откатывает только его.
    s = stand();
    const w2 = [];
    s.maid.api = () => new Promise((ok, no) => w2.push([ok, no]));
    s.data = { day: "2026-11-28", habits: [{ id: 12, need: 5, count: 1, status: null }] };
    const q1 = s.stepHabit(s.data.habits[0], 1, s.mark); // 2
    const q2 = s.stepHabit(s.data.habits[0], 1, s.mark); // 3
    w2[0][1](new Error("нет связи")); await q1;
    check(s.data.habits[0].count === 2, `ошибка первого шага затёрла второй: ${JSON.stringify(s.data.habits[0])}`);
    w2[1][0]({ text: "ok", count: 2, need: 5, status: null }); await q2;
    check(s.data.habits[0].count === 2 && s.data.habits[0].status === null, `после ошибки одного шага не 2/5: ${JSON.stringify(s.data.habits[0])}`);
  } catch (e) {
    check(false, `stepHabit оборвался: ${e?.stack ?? e}`);
  }

  // Ответ «Сделал» в облачке (habit:ID:день:done): у ×N сервер ставит одну отметку — праздник только при набранной норме.
  {
    const bub = widget.match(/\n          \/\/ ×N \(«Пить воду» ×5\)[^]*?say\(r\.text, \{ ms: 5000 \}\);/)?.[0] ?? "";
    check(bub, "в ответе облачка нет ветки для ×N");
    const run = async (habits, reply, kind = "done") => {
      const log = { tones: [], reacts: [] };
      const bx = { data: { habits }, m: [null, "5", "2026-11-28", kind], Number, Math, Infinity, log,
        popTone: (x) => log.tones.push(x), react: (x) => log.reacts.push(x), say: () => {},
        maid: { api: async () => reply, changed: () => {} } };
      vm.createContext(bx);
      await vm.runInContext(`${helpers}\n(async () => { ${bub} })()`, bx);
      return log;
    };
    try {
      let L = await run([{ id: 5, need: 5, count: 0 }], { text: "◐ Пить воду: 1/5", count: 1, need: 5, status: null });
      check(!L.reacts.length && !L.tones.includes(3), `облачко: 1/5 сыграло праздник (${JSON.stringify(L)})`);
      L = await run([{ id: 5, need: 5, count: 4 }], { text: "ok", count: 5, need: 5, status: "done" });
      check(L.reacts.includes("streak") && L.tones.includes(3), `облачко: 5/5 без праздника (${JSON.stringify(L)})`);
      L = await run([{ id: 5 }], { text: "ok" });
      check(L.reacts.includes("streak") && L.tones[0] === 3, `облачко: обычная привычка (старый сервер) — не как раньше (${JSON.stringify(L)})`);
      L = await run([{ id: 5, need: 5, count: 2 }], { text: "ok" }, "skipped");
      check(L.reacts.includes("sad") && !L.reacts.includes("streak"), `облачко: пропуск ×N не как раньше (${JSON.stringify(L)})`);
    } catch (e) {
      check(false, `облачко оборвалось: ${e?.stack ?? e}`);
    }
  }

  // Стиль: svg на месте кружка (поле на 1 px шире с каждой стороны), галочка и минус жирные тёмные, пропуск серый, доли 2,6 / 1,3.
  check(/\.w \.mark svg\.mk \{[^}]*inset: -1px[^}]*pointer-events: none/.test(css), "svg отметки не вровень с кружком или ловит щелчки (e.target)");
  check(/\.w \.mark \.mk-fg \{[^}]*stroke: var\(--ink\); stroke-width: 1\.8; stroke-linecap: round; stroke-linejoin: round/.test(css), "галочка/минус не тёмные (--ink) 1,8 с круглыми концами");
  // 28.11.2026 пользователь: «я не просил менять серый фон на красный» — круг пропуска серый (--muted), как был до новой отметки.
  check(/\.w \.mark\.skipped \.mk-bg \{ fill: var\(--muted\); \}/.test(css), "круг пропуска не серый (--muted)");
  check(!/#e0566a|--mark-skip|9a6a74/.test(widget) && !/\.mark[^{]*\{[^}]*(#e0566a|--mark-skip)/.test(css), "пропуск снова красный или подкрашивается под цвет панели");
  // Серый пропуск и «сделано» заметно разного цвета при любом цвете панели.
  {
    const accents = vm.runInNewContext(`(${widget.match(/\nconst ACCENTS = (\{[^\n]*\});/)?.[1] ?? "{}"})`);
    const rgb = (hex) => hex.match(/\w\w/g).map((x) => parseInt(x, 16));
    const far = (a, b) => { const [x, y] = [rgb(a), rgb(b)]; return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]); };
    for (const [k, [, done]] of Object.entries(accents)) {
      const skip = css.match(/--muted: (#\w{6})/)?.[1] ?? "";
      check(far(skip, done) > 90, `${k}: пропуск ${skip} почти того же цвета, что «сделано» ${done} (${far(skip, done).toFixed(0)})`);
    }
  }
  // 28.11.2026 пользователь: галочка и минус «темными как было раньше а не белыми» — один тёмный цвет при любом цвете панели.
  check(!/MARK_LOOK|--mark-ink/.test(widget) && !/--mark-ink|\.mk-fg \{ stroke: #fff/.test(css), "галочка или минус снова белые / подкрашиваются под цвет панели");
  check(/\.w \.mark \.mk-bg \{ fill: var\(--accent-2\); \}/.test(css), "сделано не цветом галочек --accent-2");
  check(/\.mk-on \{ stroke: var\(--accent-2\); stroke-width: 2\.6; \}/.test(css) && /\.mk-off \{ stroke: var\(--muted\); stroke-width: 1\.3;/.test(css), "доли кольца не 2,6 зелёные / 1,3 цвета пустого кружка");
  check(/\.w \.list \.habit-n \{[^}]*color: var\(--muted\)/.test(css), "«3/5» не приглушённое");
  check(!/\.w \.mark\.skipped \{ background: var\(--muted\)/.test(css), "остался серый пропуск");

  // Стенд (desktop/test/stress/fake-server.cjs): набор multi и шаги ±1, как на сервере.
  const fake = require("./stress/fake-server.cjs");
  const srv = await fake.create().listen(0);
  try {
    srv.reset("multi");
    const H = { Authorization: `Bearer ${srv.token}`, "Content-Type": "application/json" };
    const post = async (id, body) => (await fetch(`${srv.url}/api/habits/${id}/mark`, { method: "POST", headers: H, body: JSON.stringify(body) })).json();
    const today = await (await fetch(`${srv.url}/api/today`, { headers: H })).json();
    const hs = Object.fromEntries((today.habits ?? []).map((h) => [h.id, h]));
    check(hs[51]?.need === 5 && hs[51]?.count === 0 && hs[52]?.count === 3 && hs[54]?.need === 12 && hs[53]?.status === "done" && hs[56]?.status === "skipped" && hs[57]?.need === undefined, "в наборе multi не те привычки");
    const xp0 = srv.xp;
    let r = await post(52, { day: today.day, step: 1 });
    check(r.count === 4 && r.need === 5 && r.status === null, `стенд 3/5 +1: ${JSON.stringify(r)}`);
    r = await post(52, { day: today.day, step: 1 });
    check(r.count === 5 && r.status === "done" && srv.xp === xp0 + 5, `стенд 4/5 +1 — не «сделано» или опыт не +5: ${JSON.stringify(r)}`);
    r = await post(52, { day: today.day, step: 1 });
    check(r.count === 5 && r.status === "done" && srv.xp === xp0 + 5 && /уже отмечено/.test(r.text), `стенд: +1 по сделанному дню что-то поменял: ${JSON.stringify(r)}`);
    r = await post(52, { day: today.day, step: -1 });
    check(r.count === 4 && r.status === null && srv.xp === xp0, `стенд −1 с 5/5: ${JSON.stringify(r)}`);
    r = await post(51, { day: today.day, step: -1 });
    check(r.count === 0 && /отметок нет/.test(r.text), `стенд −1 при нуле: ${JSON.stringify(r)}`);
    r = await post(57, { status: "done" });
    check(r.status === "done" && r.need === 1, `стенд: обычная привычка отмечается не как раньше: ${JSON.stringify(r)}`);
  } catch (e) {
    check(false, `стенд оборвался: ${e?.stack ?? e}`);
  } finally {
    await srv.close();
  }

  console.log(bad ? `${bad} из ${n} не прошли` : `OK: ${n} проверок: ×N — кольцо долей, «3/5», шаги ±1, сделано и опыт только при полной норме; новая галочка и минус`);
  process.exit(bad ? 1 : 0);
})();
