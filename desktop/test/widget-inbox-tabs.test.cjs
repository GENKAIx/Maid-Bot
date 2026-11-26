// Список напоминаний (24.11.2026; desktop/renderer/inbox.js): начался новый день — вчерашние смешивались с сегодняшними, а
// закрыть их можно было только по одному, открыв каждое. Теперь: вкладки [Вчера N] [Сегодня N] (если есть оба дня), старше
// вчерашнего гаснет само, «Прочитать все» гасит открытую вкладку (5 с можно «↩ Вернуть»), ✕ на строке — прочитано без ответа,
// напоминания об одном плане склеиваются, закрытый хвост не возвращается до смены срока.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const root = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(root, "renderer", "inbox.js"), "utf8");
const css = fs.readFileSync(path.join(root, "renderer", "style.css"), "utf8");

// Маленький DOM: кнопки в #bubbleCards разбираются из innerHTML, щелчок — onclick с target.
const parse = (html) => [...html.matchAll(/<button type="button"([^>]*)>([^]*?)<\/button>/g)].map((m) => {
  const attr = (a) => new RegExp(`${a}="([^"]*)"`).exec(m[1])?.[1];
  const cls = new Set((attr("class") ?? "").split(" ").filter(Boolean));
  return { html: m[2], dataset: { tab: attr("data-tab"), key: attr("data-key") }, classList: { add: (c) => cls.add(c), contains: (c) => cls.has(c) }, cls, onclick: null };
});
const cards = { _h: "", rows: [], tabs: [],
  set innerHTML(v) { this._h = v; const all = parse(v); this.tabs = all.filter((b) => b.dataset.tab); this.rows = all.filter((b) => b.dataset.key); },
  get innerHTML() { return this._h; },
  querySelectorAll(q) { return q === "[data-tab]" ? this.tabs : q === ".ib-list [data-key]" ? this.rows : []; } };
const text = { textContent: "" };
let bubbleHidden = false;
const actions = { removed: [], querySelector: (q) => ({ classList: { add: () => {} }, remove: () => actions.removed.push(q) }) };
const store = {}, said = [], opened = [], timers = [];
// Облачко и маленькое облачко «Прочитано · ↩ Вернуть» над ним (ibToast): top — где облачко в окне.
let toast = null, bubbleTop = 200;
const toastEl = () => {
  const cls = new Set();
  const el = { innerHTML: "", offsetHeight: 28, classList: { add: (c) => cls.add(c) }, cls, attrs: {}, setAttribute(k, v) { el.attrs[k] = v; },
    btn: { onclick: null }, querySelector: () => el.btn, remove: () => { if (toast === el) toast = null; } };
  return el;
};
const bubbleEl = { classList: { contains: () => bubbleHidden }, append: (el) => { toast = el; }, prepend: (el) => { toast = el; el.first = true; }, querySelector: (q) => (q === ".ib-toast" ? toast : null),
  getBoundingClientRect: () => ({ top: bubbleTop }) };
const ctx = vm.createContext({
  localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } },
  $: (q) => ({ "#bubbleCards": cards, "#bubbleText": text, "#bubbleActions": actions, "#bubble": bubbleEl })[q] ?? null,
  document: { createElement: () => toastEl() },
  clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].dead = true; },
  data: { day: "2026-11-24", habits: [], tasks: [{ id: 7, title: "Сдать отчёт", due_date: "2026-11-20" }] },
  say: (t, o) => { said.push({ t, o }); bubbleHidden = false; },
  hideBubble: () => { bubbleHidden = true; },
  startButtons: (x) => x.buttons ?? [], askTail: (t) => opened.push(`tail:${t.id}`),
  maid: { openSection() {} }, esc: (s) => String(s), humanDay: (d) => d, placeBubble() {}, fitBubble() {},
  matchMedia: () => ({ matches: false }), setTimeout: (f, ms) => timers.push({ f, ms }),
  Date, JSON, Math, Set, Map, Number, String, console,
});
vm.runInContext(src + "\n;globalThis.t = { inboxAdd, inboxTidy, groupItems, openGroup, tailsOf, ibDay, ibPlanKey, get inbox() { return inbox; } };", ctx);
const t = ctx.t;
const at = (d, h) => new Date(`${d}T${String(h).padStart(2, "0")}:00:00`).getTime();
const add = (id, text, when, extra = {}) => { t.inboxAdd({ id, text, emotion: "neutral", buttons: [], kind: "plan", ...extra }); t.inbox.at(-1).at = when; };
const flush = () => { for (const x of timers.splice(0)) if (!x.dead) x.f(); };
const clickRow = (i, x = false) => cards.rows[i].onclick({ target: { closest: (q) => (q === "[data-x]" && x ? {} : null) } });
const readAll = () => said.at(-1).o.buttons[0].run();

// День напоминания: привычка — из кнопки, остальное — когда пришло.
check(t.ibDay({ at: at("2026-11-24", 1), buttons: [{ data: "habit:3:2026-11-23:yes" }] }) === "2026-11-23", "день привычки — из кнопки");
check(t.ibDay({ at: at("2026-11-24", 9) }) === "2026-11-24", "день — когда пришло");
check(t.ibPlanKey({ text: "⏰ Через 1 ч: 18:00 — Врач" }) === "18:00 — Врач" && t.ibPlanKey({ text: "⏰ Пора: 18:00 — Врач" }) === "18:00 — Врач"
  && t.ibPlanKey({ text: "📅 Сегодня: 18:00 — Врач\nещё строка" }) === "18:00 — Врач", "ключ плана");
check(t.ibPlanKey({ text: "⏰ Пора: 18:00 — Врач", buttons: [{ data: "x" }] }) === "", "с кнопками — не план");

// Ящик: позавчера, два вчера, два сегодня; плюс хвост (сегодня).
add(1, "⏰ Пора: 09:00 — Давнее", at("2026-11-22", 9));
add(2, "⏰ Пора: 10:00 — Вчерашнее", at("2026-11-23", 10));
add(3, "Зарядка — сегодня сделали?", at("2026-11-24", 0), { kind: "habit", buttons: [{ text: "Да", data: "habit:3:2026-11-23:yes" }] });
add(4, "⏰ Пора: 12:00 — Обед", at("2026-11-24", 12));
add(5, "📅 Сегодня: 18:00 — Врач", at("2026-11-24", 8));
t.inboxTidy();
check(!t.inbox.some((x) => x.id === 1), "позавчерашнее погасло само");
check(t.inbox.some((x) => x.id === 2), "вчерашнее осталось");

// Повтор о том же плане — склеивается, остаётся последний.
add(6, "⏰ Через 1 ч: 18:00 — Врач", at("2026-11-24", 17));
check(!t.inbox.some((x) => x.id === 5) && t.inbox.some((x) => x.id === 6), "«Через 1 ч» заменило «Сегодня» о том же плане");
// Старые повторы (накопились до 0.1.87) склеивает inboxTidy.
t.inbox.push({ id: 60, text: "⏰ Пора: 18:00 — Врач", emotion: "neutral", buttons: [], kind: "plan", at: at("2026-11-24", 18) });
t.inbox.push({ id: 61, text: "⏰ Через 1 ч: 18:00 — Врач", emotion: "neutral", buttons: [], kind: "plan", at: at("2026-11-24", 17) });
t.inboxTidy();
check(t.inbox.filter((x) => t.ibPlanKey(x) === "18:00 — Врач").map((x) => x.id).join() === "61", "старые повторы склеены, остался последний");

// Вопрос о привычке за вчера уходит из ящика, когда вчерашний день отметили где угодно (24.11.2026).
add(80, "Читать — сегодня сделали?", at("2026-11-23", 23), { kind: "habit", buttons: [{ text: "Да", data: "habit:8:2026-11-23:done" }] });
ctx.data.habits = [{ id: 8, status: null, yesterday: "none" }];
t.inboxTidy();
check(t.inbox.some((x) => x.id === 80), "вчера не отмечено — вопрос остаётся");
ctx.data.habits[0].yesterday = "skipped";
t.inboxTidy();
check(!t.inbox.some((x) => x.id === 80), "вчерашний день отметили — вопрос ушёл");
ctx.data.habits = [];

// Вкладки: по умолчанию «Сегодня»; во «Вчера» — вчерашнее и привычка за вчера.
t.openGroup("alarm");
check(cards.tabs.map((b) => b.html.replace(/<[^>]+>/g, "")).join("|") === "Вчера 2|Сегодня 3", `вкладки: ${cards.tabs.map((b) => b.html)}`);
check(cards.tabs[1].cls.has("on") && text.textContent === "", "по умолчанию «Сегодня»; заголовка нет — вместо него вкладки");
check(said.at(-1).o.buttons[0].text === "Прочитать все", "внизу «Прочитать все»");
check(cards.rows.length === 3 && /Сдать отчёт/.test(cards.innerHTML), "сегодня: два письма и хвост");
cards.tabs[0].onclick();
check(cards.rows.length === 2 && /Вчерашнее/.test(cards.innerHTML) && /Зарядка/.test(cards.innerHTML) && cards.tabs[0].cls.has("on"), "вкладка «Вчера»");

// Щелчок по строке открывает, ✕ — гасит без ответа.
const rowOf = (re) => cards.rows.findIndex((b) => re.test(b.html));
clickRow(rowOf(/Вчерашнее/));
check(said.at(-1).o.notice === 2, "строка открывает напоминание");
t.openGroup("alarm");
cards.tabs[0].onclick();
const row = cards.rows[rowOf(/Вчерашнее/)];
clickRow(rowOf(/Вчерашнее/), true);
check(row.cls.has("gone") && !t.inbox.some((x) => x.id === 2), "✕ — строка гаснет и уходит из ящика");
flush();
check(cards.rows.length === 1 && cards.tabs.length === 2, "во «Вчера» осталась одна строка");
clickRow(0, true);
flush();
check(cards.rows.length === 3 && cards.tabs.length === 1 && /Сегодня <span>3/.test(cards.tabs[0].html) && cards.tabs[0].cls.has("on"), "остался один день — одна вкладка с числом");
check(text.textContent === "", `заголовка нет: ${text.textContent}`);

// ✕ у хвоста: скрыт, пока не сменится срок.
t.openGroup("alarm");
const tailRow = cards.rows.findIndex((b) => /Сдать отчёт/.test(b.html));
clickRow(tailRow, true);
flush();
check(!t.tailsOf().length, "хвост скрыт");
t.inboxTidy();
check(!t.tailsOf().length, "и после обновления данных — скрыт");
ctx.data.tasks[0].due_date = "2026-11-21";
t.inboxTidy();
check(t.tailsOf().length === 1, "срок сменился — хвост вернулся");
ctx.data.tasks[0].due_date = "2026-11-20";
check(t.tailsOf().length === 1 && !JSON.parse(store["maid.tailsHidden"]).length, "прежняя пометка забыта");

// «Прочитать все» — только открытая вкладка, и «↩ Вернуть».
add(7, "⏰ Пора: 11:00 — Ещё вчерашнее", at("2026-11-23", 11));
t.openGroup("alarm");
check(cards.tabs.length === 2 && cards.tabs[1].cls.has("on"), "снова два дня");
readAll();
check(t.groupItems("alarm").length === 1 && cards.rows.length === 1 && /Ещё вчерашнее/.test(cards.innerHTML) && cards.tabs.length === 1, "погашена только вкладка «Сегодня»");
check(said.at(-1).o.buttons.length === 1, "внизу только «Прочитать все» — «Вернуть» не там");
check(toast && /Прочитано: 3/.test(toast.innerHTML) && /↩ Вернуть/.test(toast.innerHTML) && toast.attrs.role === "status" && !toast.cls.has("inline"),
  `маленькое облачко над списком: ${toast?.innerHTML}`);
check(timers.at(-1)?.ms === 5000, "маленькое облачко уходит через 5 с");
toast.btn.onclick({ stopPropagation() {} });
check(!toast, "после «Вернуть» маленькое облачко убрано");
check(t.groupItems("alarm").length === 4, `вернула: ${t.groupItems("alarm").length}`);
// У верха экрана над облачком места нет — маленькое облачко под ним; через 5 с уходит само.
t.openGroup("alarm");
bubbleTop = 10;
readAll();
check(toast?.cls.has("inline") && toast.first, "у верха окна — строкой в верху облачка (под ним закрыла бы панель)");
const back = toast?.btn;
flush();
check(!toast, "через 5 с ушло");
back?.onclick({ stopPropagation() {} }); // вернуть, чтобы дальше было что гасить
bubbleTop = 200;
// Всё погашено — короткое облачко «Прочитано» с «Вернуть».
timers.length = 0;
t.openGroup("alarm");
readAll();
readAll();
check(/^Прочитано: 1\.$/.test(said.at(-1).t) && said.at(-1).o.ms === 5000 && said.at(-1).o.buttons[0].text === "↩ Вернуть", `всё прочитано: ${said.at(-1).t}`);
check(!t.groupItems("alarm").length, "раздел пуст");

// Стили: ✕ при наведении проявляется на своём, всегда занятом месте рядом со сроком (26.11.2026: раньше вставал вместо срока —
// строка и облачко меняли размер; подробно — widget-hover-steady.test.cjs), «Прочитать все» слева.
check(/\.ib-list \.ib-x \{ display: inline-block; visibility: hidden;/.test(css) && /\.ib-list button:hover \.ib-x[^{]*\{ visibility: visible; opacity: 1; \}/.test(css)
  && !/\.ib-time[^{]*\{[^}]*display: none/.test(css), "✕ проявляется при наведении, срок остаётся");
check(/#bubbleActions \.ib-readall \{ margin-right: auto; \}/.test(css), "«Прочитать все» слева");

const widget = fs.readFileSync(path.join(root, "renderer", "widget.js"), "utf8");
check(/function say\([^]*?if \(napping \|\| \(touring && !tour\)\) return;\r?\n  ibToastOff\(\);/.test(widget), "новая реплика убирает «Прочитано · ↩ Вернуть» чужого списка");
check(/\.ib-tabs button\.on \{ background: #4b3f72;/.test(css) && /\.ib-toast \{ position: absolute;[^}]*bottom: calc\(100% \+ 6px\)/.test(css), "стили: тёмная вкладка, облачко над списком");

console.log(bad ? `${bad} из ${n} не прошли` : `OK: ${n} проверок списка напоминаний`);
process.exit(bad ? 1 : 0);
