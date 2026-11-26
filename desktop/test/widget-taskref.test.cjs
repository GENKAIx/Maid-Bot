// Плашки под ответом горничной (26.11.2026):
// 1) плашки записей в переписке не шире облачка сообщения (было: «✅ Сделать чехол для спортивной скамейки…» вылезало за правый
//    край — у .chat button стоит flex: none), длинное название — две строки и многоточие, полное — в подсказке;
// 2) ссылка на задачу, которая уже есть (taskref.js): ответ «Эта задача уже в списке, под номером #102: «…»» приходит с
//    refs: [{ tbl: "tasks", id, title }] (server/src/pipeline.ts, TaskRef). «↗ название» — щелчок разворачивает панель, закрывает
//    переписку, прокручивает к строке и подсвечивает её; задачи нет — серая «задачи уже нет», без перехода.
//    Старый виджет refs не читает (он берёт из ответа только известные поля), а changes с ними не смешаны — у него всё как раньше.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const dir = path.join(__dirname, "..", "renderer");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
const widget = read("widget.js"), css = read("style.css"), html = read("widget.html"), src = read("taskref.js");

// --- подключение: перед widget.js (widget.js зовёт taskRefsOf уже при отрисовке переписки) ---
const order = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
check(order.includes("taskref.js") && order.indexOf("taskref.js") < order.indexOf("widget.js"), "taskref.js подключён перед widget.js");

// --- маленький мир для taskref.js ---
function world({ tasks = [{ id: 4, title: "Сдать отчёт" }], folded = false, hist = false, rows = [4], shown = [4] } = {}) {
  const w = { log: [], timers: [], rows: new Map(), hist, renders: 0 };
  const rowEl = (id) => {
    const cls = new Set();
    const li = { id, cls, dataset: {}, classList: { add: (c) => { cls.add(c); w.log.push(`add ${c}`); }, remove: (c) => { cls.delete(c); w.log.push(`remove ${c}`); }, contains: (c) => cls.has(c) },
      get offsetWidth() { w.log.push("reflow"); return 100; }, style: { setProperty: (k, v) => w.log.push(`css ${k}=${v}`) },
      scrollIntoView: (o) => w.log.push(`scroll ${id} ${o.block}`) };
    return { closest: () => li, li };
  };
  for (const id of rows) w.rows.set(id, rowEl(id));
  const ctx = {
    data: { tasks }, collapsed: folded, autoOpened: true, tasksMore: 0, shownTaskIds: new Set(shown), cfg: { sections: { tasks: true } },
    esc: (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"),
    $: (q) => {
      if (q === "#chatHist") return { classList: { contains: (c) => c === "hidden" && !w.hist } };
      const m = /\[data-done="(\d+)"\]/.exec(q);
      return m ? w.rows.get(Number(m[1])) ?? null : null;
    },
    foldAnimated: (on) => { w.log.push(`fold ${on}`); ctx.collapsed = on; },
    toggleHistory: (on) => { w.log.push(`history ${on}`); w.hist = on; },
    render: () => { w.renders++; if (w.onRender) w.onRender(); },
    hideBubble: () => w.log.push("hide"),
    maid: { openSection: (s) => w.log.push(`open ${s}`) },
    matchMedia: () => ({ matches: false }),
    setTimeout: (f, ms) => w.timers.push({ f, ms }),
    document: { createElement: () => {
      const cls = { v: "" };
      const el = { dataset: {}, innerHTML: "", disabled: false, title: "", type: "", get className() { return cls.v; }, set className(v) { cls.v = v; },
        querySelector: (q) => (q === ".chip-gone" && el.innerHTML.includes("chip-gone") ? {} : null), insertAdjacentHTML: (_p, h) => { el.innerHTML += h; } };
      return el;
    } },
    Date, Number, String, Array, Set, Map, Math, console,
  };
  vm.createContext(ctx);
  vm.runInContext(`${src}\nthis.api = { taskRefsOf, taskRefChipHtml, taskRefCard, goToTask, taskRefRelight, get lit() { return taskRefLit; } };`, ctx);
  w.ctx = ctx;
  w.run = () => { const t = w.timers.splice(0); t.forEach((x) => x.f()); };
  return w;
}

// Разбор refs: только задачи с числовым id, не больше 5; незнакомое — мимо (новые виды с сервера не роняют виджет).
{
  const { api } = world().ctx;
  const got = api.taskRefsOf([{ tbl: "tasks", id: 4, title: "Сдать отчёт" }, { tbl: "events", id: 5, title: "план" }, { tbl: "tasks", id: "x" }, null, { tbl: "tasks", id: -1 }]);
  check(JSON.stringify(got) === JSON.stringify([{ tbl: "tasks", id: 4, title: "Сдать отчёт" }]), `разбор refs: ${JSON.stringify(got)}`);
  check(api.taskRefsOf(undefined).length === 0 && api.taskRefsOf("мусор").length === 0, "нет refs (старый сервер) — пусто");
  check(api.taskRefsOf(Array.from({ length: 9 }, (_, i) => ({ tbl: "tasks", id: i + 1, title: "x" }))).length === 5, "не больше пяти");
  // Сохранённое в переписке (localStorage) читается тем же разбором.
  check(api.taskRefsOf(JSON.parse(JSON.stringify(got))).length === 1, "ссылка из сохранённой переписки разбирается");
}

// Плашка в переписке: живая — кнопка-ссылка; задачи нет — серая, disabled, «задачи уже нет»; название целиком — в подсказке.
{
  const { api } = world().ctx;
  const live = api.taskRefChipHtml({ id: 4, title: "Сдать отчёт" }, 3, 0);
  check(/class="h-chip ref"/.test(live) && /data-h="3" data-r="0"/.test(live) && !/disabled/.test(live) && /<span class="chip-t">Сдать отчёт<\/span>/.test(live), `живая плашка: ${live}`);
  const gone = api.taskRefChipHtml({ id: 99, title: "Привозить <воду>" }, 3, 1);
  check(/h-chip ref gone/.test(gone) && / disabled/.test(gone) && /задачи уже нет/.test(gone) && /Привозить &lt;воду>/.test(gone), `серая плашка: ${gone}`);
}

// Щелчок по живой ссылке: панель уже развёрнута, переписка открыта → переписка закрывается, строка — на виду, подсветка.
{
  const w = world({ hist: true });
  check(w.ctx.api.goToTask(4) === true, "живая задача — переход");
  check(w.log.includes("history false") && !w.log.some((l) => l.startsWith("fold")), `переписка уступает место списку: ${w.log}`);
  check(w.timers.length === 1 && w.timers[0].ms === 0, "без свёртки — сразу");
  w.run();
  const li = w.rows.get(4).li;
  check(w.log.includes("scroll 4 center") && li.classList.contains("ref-lit"), `строка прокручена и подсвечена: ${w.log}`);
  check(w.ctx.autoOpened === false, "панель остаётся развёрнутой");
}

// Свёрнутый виджет: разворачивается, строка — после того, как панель вырастет.
{
  const w = world({ folded: true });
  w.ctx.api.goToTask(4);
  check(w.log[0] === "fold false" && w.timers[0].ms === 600, `свёрнутый — разворот и ожидание: ${w.log} ${w.timers.map((t) => t.ms)}`);
  w.run();
  check(w.rows.get(4).li.classList.contains("ref-lit"), "после разворота строка подсвечена");
}

// Задачи уже нет: ничего не открывается, не прокручивается, панель не разворачивается.
{
  const w = world({ folded: true });
  check(w.ctx.api.goToTask(77) === false, "задачи нет — false");
  w.run();
  check(!w.log.length, `задачи нет — без перехода: ${w.log}`);
  // Карточка в облачке: была живой, задачу закрыли, пока висело облачко, — щелчок делает её серой.
  const el = w.ctx.api.taskRefCard({ id: 4, title: "Сдать отчёт" });
  check(/card ref go/.test(el.className) && !el.disabled, "карточка в облачке — живая");
  w.ctx.data.tasks = [];
  el.onclick();
  check(/card ref gone/.test(el.className) && el.disabled && /задачи уже нет/.test(el.innerHTML) && !w.log.includes("hide"), `закрытая задача — карточка серая, облачко на месте: ${el.className}`);
}

// Задача за кнопкой «Ещё N»: список дорисовывается; не видна вовсе (спит до срока) — раздел «Планы» в приложении.
{
  const w = world({ tasks: [{ id: 4, title: "a" }, { id: 8, title: "b" }], rows: [4], shown: [4] });
  w.onRender = () => w.rows.set(8, { closest: () => ({ dataset: {}, classList: { add() {}, remove() {}, contains: () => false }, style: { setProperty() {} }, scrollIntoView: () => w.log.push("scroll 8") }) });
  w.ctx.api.goToTask(8);
  w.run();
  check(w.renders === 1 && w.ctx.tasksMore >= 2 && w.log.includes("scroll 8"), `за «Ещё»: ${w.log}`);
  const w2 = world({ tasks: [{ id: 9, title: "спит" }], rows: [], shown: [] });
  w2.ctx.api.goToTask(9);
  w2.run();
  check(w2.log.includes("open /plans") && w2.ctx.api.lit === null, `не в списке — раздел «Планы»: ${w2.log}`);
}

// Подсветка держится ~2 с и переживает перерисовку списка.
{
  const w = world();
  w.ctx.api.goToTask(4);
  w.run();
  w.rows.set(4, (() => { const cls = new Set(); const li = { dataset: {}, classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c) }, style: { setProperty() {} } }; return { closest: () => li, cls }; })());
  w.ctx.api.taskRefRelight();
  check(w.rows.get(4).cls.has("ref-lit"), "после перерисовки строка снова подсвечена");
  check(/const TASKREF_LIT_MS = 2000;/.test(src) && /animation: refLit 2s/.test(css), "подсветка — 2 с");
  check(/scrollToArrival\(\);\r?\n  taskRefRelight\(\);/.test(widget), "render() возвращает подсветку");
}

// Второй переход к той же строке (список не перерисовался): класс снимается, перерасчёт, класс снова — строка мигает заново.
// Через TASKREF_LIT_MS класс снимает таймер (и при «уменьшить движение», где фон задан без анимации).
{
  const w = world();
  const li = w.rows.get(4).li;
  w.ctx.api.goToTask(4);
  w.run(); // показ строки; таймер снятия подсветки ждёт
  check(li.classList.contains("ref-lit") && w.timers.length === 1 && w.timers[0].ms > 1900 && w.timers[0].ms <= 2000, `таймер снятия подсветки: ${w.timers.map((t) => t.ms)}`);
  const unlight1 = w.timers.splice(0)[0];
  w.ctx.api.taskRefRelight(); // перерисовка в ту же строку — не перезапускать посреди мигания
  check(!w.log.includes("remove ref-lit") && w.timers.length === 0, `тот же переход — без перезапуска: ${w.log}`);
  w.log.length = 0;
  w.ctx.api.goToTask(4); // второй щелчок по той же задаче
  w.run();
  const i = w.log.indexOf("remove ref-lit"), j = w.log.indexOf("reflow"), k = w.log.lastIndexOf("add ref-lit");
  check(i >= 0 && i < j && j < k, `второй переход — анимация заново: ${w.log}`);
  unlight1.f(); // таймер первого перехода не гасит подсветку второго
  check(li.classList.contains("ref-lit"), "старый таймер не снимает новую подсветку");
  w.run();
  check(!li.classList.contains("ref-lit") && w.ctx.api.lit === null, "через 2 с класс снят таймером");
  const css2 = css.match(/@media \(prefers-reduced-motion: reduce\) \{ \.w \.list li\.ref-lit \{[^}]*\}/)?.[0] ?? "";
  check(/animation: none/.test(css2), `при «уменьшить движение» — без анимации, снимает таймер: ${css2}`);
}

// --- переписка (widget.js, herHtml): плашки записей и ссылки ---
const pick = (re) => widget.match(re)?.[0] ?? "";
const hctx = { esc: world().ctx.esc, tgHtml: (t) => t, clockOf: () => "12:00", data: { tasks: [{ id: 4, title: "Сдать отчёт" }] } };
vm.createContext(hctx);
vm.runInContext(`${src}\n${pick(/\nconst KIND = \{[^]*?\n\};/)}\n${pick(/\nfunction herHtml\([^]*?\n\}/)}\nthis.herHtml = herHtml;`, hctx);
{
  const long = "Сделать чехол для спортивной скамейки из старого брезента и поролона";
  const out = hctx.herHtml({ at: 0, reply: "Записала ✨\n✅ В задачах: …", changes: [{ kind: "task", title: long }], undo: 5 }, 0);
  check(new RegExp(`<button type="button" class="h-chip" data-h="0" data-c="0" title="Задача: ${long} — открыть в приложении">✅ <span class="chip-t">${long}</span></button>`).test(out), `плашка записи: ${out}`);
  check(/h-undo/.test(out), "«Отменить» на месте");
  const ref = hctx.herHtml({ at: 0, reply: "Эта задача уже в списке, под номером #4: «Сдать отчёт».\nВторой раз записывать не стала.", changes: [], refs: [{ tbl: "tasks", id: 4, title: "Сдать отчёт" }] }, 2);
  check(/Второй раз записывать не стала/.test(ref), "ответ со ссылкой — текст целиком (ссылка — не «записала»)");
  check(/class="h-chip ref" data-h="2" data-r="0"/.test(ref), `ссылка в переписке: ${ref}`);
  const old = hctx.herHtml({ at: 0, reply: "Старый ответ\n📓 строка" }, 1);
  check(old === `<div class="hm her">Старый ответ\n📓 строка<i>12:00</i></div>`, `старая запись переписки (без changes и refs) — как была: ${old}`);
}
check(/const ref = e\.target\.closest\("\.h-chip\.ref"\);[^]*?goToTask\(r\.id\)[^]*?drawHistory\(\)/.test(widget), "щелчок по ссылке в переписке ведёт к задаче, задачи нет — перерисовка (серая)");
check((widget.match(/refs: (r|x)\.refs \?\? \[\]/g) ?? []).length >= 3, "ответы сервера (строка, Enter, повтор) передают refs в облачко");
check(/const refs = taskRefsOf\(r\.refs\);/.test(widget), "переписка запоминает refs");

// --- CSS: плашка не шире облачка ---
const rule = (sel) => css.match(new RegExp(`(^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`))?.[2] ?? "";
const chip = rule(".chat button.h-chip");
check(/flex: 0 1 auto/.test(chip) && /min-width: 0/.test(chip) && /max-width: 100%/.test(chip), `плашка сжимается по облачку: ${chip}`);
const t = rule(".chat .h-chip .chip-t");
check(/-webkit-line-clamp: 2/.test(t) && /overflow: hidden/.test(t) && /min-width: 0/.test(t) && /overflow-wrap: anywhere/.test(t), `название — две строки и многоточие: ${t}`);
check(/min-width: 0/.test(rule(".chat .h-chips")), "ряд плашек сжимается");
const card = rule(".card.ref .card-body");
check(/-webkit-line-clamp: 2/.test(card) && /min-width: 0/.test(card), "ссылка в облачке — две строки");

console.log(bad ? `${bad} из ${n} не прошли` : `OK: ${n} проверок плашек и ссылок на задачи`);
process.exit(bad ? 1 : 0);
