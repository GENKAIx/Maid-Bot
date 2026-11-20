// Свёрнутая карточка по времени суток (widget.js: miniPeriod, miniView, miniTomorrow, dayRating) без Electron и браузера.
// 19.11.2026, вариант Б полного ревью (выбран пользователем): утром — «Доброе утро ☀» и три ближайших плана плашками,
// днём — ближайший план с отсчётом (как было), вечером — «Сделано 6 из 8», «завтра 10:00 · Созвон» и десять звёзд оценки дня
// (не дожидаясь вечернего итога), ночью — «Спокойной ночи», первый план завтра, луна вместо кольца, карточка тускнеет.
// Границы (решение пользователя): ночь — как сон горничной (от «Отбоя» до «Утра») и всё после полуночи до «Утра»;
// утро — от «Утра» до 11:00; вечер — с 18:00. План идёт или начнётся в течение часа — в любое время дневной вид.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, "renderer", f), "utf8");
const widget = read("widget.js"), clock = read("clock.js"), common = read("common.js"), rate = read("rate.js"), css = read("style.css"), html = read("widget.html");

const pick = (src, re, what) => { const s = src.match(re)?.[0]; check(s, `нет ${what}`); return s ?? ""; };
const fn = (src, name, file) => pick(src, new RegExp(`\\nfunction ${name}\\([^]*?\\n\\}`), `${name} в ${file}`);
const line = (src, re, what) => pick(src, re, what);
const code = [
  line(common, /\nconst esc = .*/, "esc в common.js"),
  line(clock, /\nconst plural = .*/, "plural в clock.js"),
  fn(clock, "dayAfter", "clock.js"),
  line(widget, /\nconst nightMin = .*/, "nightMin в widget.js"),
  fn(widget, "bedtime", "widget.js"),
  fn(widget, "afterBedtime", "widget.js"),
  line(widget, /\nconst MINI_MORNING_END = .*/, "MINI_MORNING_END в widget.js"),
  line(widget, /\nconst MINI_EVENING = .*/, "MINI_EVENING в widget.js"),
  line(widget, /\nconst MINI_NEAR = .*/, "MINI_NEAR в widget.js"),
  fn(widget, "miniPeriod", "widget.js"),
  fn(widget, "miniSubLines", "widget.js"),
  fn(widget, "miniTomorrow", "widget.js"),
  line(widget, /\nlet miniRated = .*/, "miniRated в widget.js"),
  fn(widget, "dayRating", "widget.js"),
  fn(widget, "miniView", "widget.js"),
].join("\n");

// Планы: _in — через сколько минут начало (подмена minutesUntil: тест не зависит от того, когда его запустили).
const ctx = {
  daySleep: { wakeMin: 7 * 60, bed: "23:00" },
  localStorage: { getItem: () => null },
  data: null,
  minutesUntil: (e) => (e.time ? e._in : null),
  colorOf: (e) => e._c ?? "#b59bff",
};
vm.createContext(ctx);
try {
  vm.runInContext(`${code}\nthis.period = miniPeriod; this.view = miniView; this.tomorrow = miniTomorrow; this.rating = dayRating; this.setRated = (x) => { miniRated = x; };`, ctx);
} catch (e) {
  check(false, `код не разобрался: ${e?.message ?? e}`);
}
const at = (h, m = 0) => new Date(2026, 10, 19, h, m);

if (ctx.period) {
  const P = (h, m, near = false) => ctx.period(at(h, m), near);
  const table = [[6, 59, "night"], [7, 0, "morning"], [10, 59, "morning"], [11, 0, "day"], [17, 59, "day"], [18, 0, "evening"], [22, 59, "evening"], [23, 0, "night"], [0, 30, "night"], [3, 0, "night"]];
  for (const [h, m, want] of table) check(P(h, m) === want, `${h}:${String(m).padStart(2, "0")} — «${P(h, m)}», а надо «${want}» (утро 7, отбой 23:00)`);
  check(P(8, 0, true) === "day" && P(19, 0, true) === "day" && P(23, 30, true) === "day", "план рядом (идёт или через час) — не дневной вид");
  ctx.daySleep.bed = "00:30";
  check(P(23, 59) === "evening", "отбой 00:30: в 23:59 ещё вечер");
  check(P(0, 10) === "night", "после полуночи до «Утра» — ночь, даже до отбоя (вечер вчерашнего дня не оценивается)");
  ctx.daySleep.wakeMin = 9 * 60; ctx.daySleep.bed = "23:00";
  check(P(8, 0) === "night" && P(9, 0) === "morning", "подъём в 9: в 8:00 ещё ночь, в 9:00 — утро");
  ctx.daySleep.wakeMin = 7 * 60;
}

if (ctx.view) {
  const ev = (id, time, title, inMin, extra = {}) => ({ id, time, title, date_iso: "2026-11-19", _in: inMin, ...extra });
  const base = () => ({
    day: "2026-11-19",
    events: [ev(1, "10:00", "Созвон", 120, { _c: "#111111" }), ev(2, "15:00", "Врач", 420, { _c: "#222222" }), ev(3, "19:00", "Кино", 660), ev(4, "21:00", "Душ", 780), { id: 5, time: null, title: "Купить хлеб", date_iso: "2026-11-19" }],
    upcoming: [{ id: 9, time: null, title: "Без часа", date_iso: "2026-11-20" }, { id: 7, time: "10:00", title: "Созвон", date_iso: "2026-11-20" }, { id: 8, time: "08:00", title: "Пробежка", date_iso: "2026-11-21" }],
    metrics: [],
  });
  const V = (part, o) => ctx.view(part, { plan: null, late: 0, left: 5, done: 3, now: at(part === "night" ? 23 : part === "evening" ? 21 : part === "morning" ? 8 : 14), ...o });

  // Утро.
  ctx.data = base();
  let v = V("morning", {});
  check(v.line1 === "Доброе утро ☀", `утро, первая строка: ${v.line1}`);
  check(v.lines[0] === "5 планов · 5 дел", `утро, вторая строка: ${v.lines[0]}`);
  const chips = [...v.extra.matchAll(/<span data-c="([^"]+)"[^>]*><b>([^<]+)<\/b>([^<]+)<\/span>/g)].map((m) => `${m[1]} ${m[2]} ${m[3]}`);
  // Политика страницы (widget.html: style-src 'self') молча выбрасывает style="…" из разметки — цвет плашек пропадал (стенд, 19.11.2026).
  check(!/style="/.test(v.extra), "в разметке ряда карточки style=\"…\" — политика страницы его выбросит");
  check(JSON.stringify(chips) === JSON.stringify(["#111111 10:00 Созвон", "#222222 15:00 Врач", "#b59bff 19:00 Кино"]), `утро, плашки — три ближайших со временем, цвет плана: ${chips.join(" | ")}`);
  check(/class="mini-plans"/.test(v.extra), "утро: нет ряда .mini-plans");
  v = V("morning", { late: 2 });
  check(v.lines.every((s) => s.includes("2 просрочены")), `утро с просрочкой — просрочка пропала: ${v.lines.join(" | ")}`);
  ctx.data.events = ctx.data.events.map((e) => ({ ...e, _in: e.time ? -200 : e._in })); // все планы со временем уже прошли
  v = V("morning", {});
  check(v.extra === "", "утро без будущих планов со временем — ряда плашек нет");
  ctx.data.events = [];
  v = V("morning", { left: 4 });
  check(JSON.stringify(v.lines) === JSON.stringify(["4 дела"]), `утро без планов: ${v.lines.join(" | ")}`);
  ctx.data.events = [ev(1, "10:00", 'Тег <b>"x"</b>', 60)];
  check(!/<b>"x"/.test(V("morning", {}).extra), "название плана в плашке не экранировано");

  // День — как было.
  ctx.data = base();
  v = V("day", { plan: { time: "15:00", title: "Врач", rel: "через 40 мин", soon: false }, late: 2, left: 5 });
  check(/<b>15:00<\/b> Врач/.test(v.line1) && v.lines[0] === "через 40 мин · 2 просрочены · 3 дела" && v.extra === "", `день: ${v.line1} / ${v.lines[0]} / ${v.extra}`);
  v = V("day", { left: 7 });
  check(v.line1 === "Задачи · 7" && v.lines.length === 0, `день без планов: ${v.line1} / ${v.lines.join(" | ")}`);

  // Вечер.
  ctx.data = base();
  v = V("evening", { done: 6, left: 2 });
  check(v.line1 === "Сделано 6 из 8", `вечер: ${v.line1}`);
  check(V("evening", { done: 8, left: 0 }).line1 === "Всё сделано ✨", "вечер: всё сделано");
  check(V("evening", { done: 0, left: 0 }).line1 === "Добрый вечер", "вечер: дел не было");
  check(v.lines[0] === "завтра 10:00 · Созвон", `вечер, вторая строка — первый план завтра со временем: ${v.lines[0]}`);
  v = V("evening", { done: 6, left: 2, late: 2 });
  check(v.lines.every((s) => s.includes("2 просрочены")), `вечер с просрочкой: ${v.lines.join(" | ")}`);
  const stars = [...V("evening", {}).extra.matchAll(/<button type="button" class="rate-star( on)?" data-v="(\d+)"/g)];
  check(stars.length === 10 && stars.every((m, i) => Number(m[2]) === i + 1 && !m[1]), `вечер: десять пустых звёзд 1…10 (${stars.length})`);
  check(/id="miniStars"/.test(V("evening", {}).extra) && !/rated/.test(V("evening", {}).extra), "вечер: ряд звёзд не оценён");
  ctx.data.metrics = [{ key: "rating_day", value: 7, source: "evening" }];
  v = V("evening", {});
  check(v.extra === "", `день уже оценён — ряда звёзд в свёрнутой карточке нет (остался: ${v.extra.slice(0, 60)})`);
  check(ctx.rating() === 7, "dayRating не читает rating_day из data.metrics");
  ctx.data.metrics = [];
  ctx.setRated({ day: "2026-11-19", v: 4 });
  check(ctx.rating() === 4, "оценка, поставленная с карточки, не видна, пока данные не обновились");
  check(V("evening", {}).extra === "", "оценили с карточки — ряд уходит сразу, не дожидаясь новых данных");
  ctx.setRated({ day: "2026-11-18", v: 4 });
  check(ctx.rating() === null, "вчерашняя оценка с карточки считается сегодняшней");
  ctx.setRated(null);
  ctx.data.upcoming = [];
  check(V("evening", {}).lines.length === 0, "вечер, завтра пусто — второй строки нет");

  // Ночь.
  ctx.data = base();
  v = V("night", { late: 3 });
  check(v.line1 === "Спокойной ночи" && v.extra === "", `ночь: ${v.line1} / ${v.extra}`);
  check(JSON.stringify(v.lines) === JSON.stringify(["завтра 10:00 · Созвон"]), `ночь: без просрочки, только завтра — ${v.lines.join(" | ")}`);
  // После полуночи data.day уже новый: «завтра» — ближайший план сегодняшнего дня из data.events.
  v = ctx.view("night", { plan: null, late: 0, left: 5, done: 3, now: at(1, 15) });
  check(v.lines[0] === "завтра 10:00 · Созвон", `ночь после полуночи: ${v.lines[0]}`);
  check(ctx.tomorrow(at(23, 0)) === "завтра 10:00 · Созвон", "miniTomorrow до полуночи — из upcoming на следующий день");
}

// Связка с карточкой: renderMini берёт часть суток и вид, класс части на #mini, ряд под верхом карточки, луна в кнопке «развернуть».
const mini = widget.match(/\nfunction renderMini\([^]*?\n\}/)?.[0] ?? "";
check(/miniPeriod\(/.test(mini) && /miniView\(/.test(mini), "renderMini не берёт часть суток (miniPeriod) и вид (miniView)");
check(/plan\.d <= MINI_NEAR|MINI_NEAR/.test(mini), "renderMini не отдаёт дневному виду план, до которого меньше часа");
check(/querySelectorAll\("\[data-c\]"\)\) s\.style\.setProperty\("--c", s\.dataset\.c\)/.test(mini), "renderMini не ставит цвет плашек из data-c");
check(/miniPlan\(\)[^]*?/.test(widget) && /return \{ e, time: e\.time, rel, title: e\.title, soon: [^}]*, d \}/.test(widget), "miniPlan не отдаёт, через сколько минут план (d)");
check(/class="mini-extra" id="miniExtra"/.test(html) && html.indexOf('id="miniExtra"') < html.indexOf('id="miniAsk"'), "ряд #miniExtra не стоит между верхом карточки и строкой ввода");
check(/class="mini-moon"/.test(html.match(/<button[^>]*id="miniOpen"[^]*?<\/button>/)?.[0] ?? ""), "луна не внутри кнопки «развернуть» (#miniOpen)");
check(/\.mini\.night \.mini-top \{[^}]*opacity/.test(css) && !/\.mini\.night \{[^}]*opacity/.test(css), "ночью тускнеет не верх карточки (opacity самой .mini занята настройкой «Прозрачность»)");
check(/\.mini\.night \.mini-moon \{ display: block; \}/.test(css), "ночью нет луны");
// Звёзды карточки: тот же rateShow, что у облачка, только на её ряду; оценка — тот же POST /api/rate за день с сервера.
check(/async function rateShow\(v, row = \$\("#bubbleActions"\)\)/.test(rate), "rateShow не умеет показывать оценку на другом ряду");
const click = widget.match(/\$\("#miniExtra"\)\.addEventListener\("click"[^]*?\n\}\);/)?.[0] ?? "";
check(/rateShow\(v, row\)/.test(click) && /maid\.api\("POST", "\/api\/rate", \{ day, value: v \}\)/.test(click) && /day = data\.day/.test(click), "звезда на карточке не идёт тем же путём (rateShow на ряду, POST /api/rate за data.day)");
check(/stay: true/.test(click), "ответ на оценку с карточки разворачивает панель (нет stay: true)");
check(/@media \(prefers-reduced-motion: reduce\)[^\n]*\.mini-(text|extra)\.swap/.test(css), "въезд строк при смене части суток не гасится при «уменьшить движение»");

// --- Ревью 19.11.2026 (шесть ошибок карточки по времени суток) ---
// 1. Строки карточки ставит fitMiniSub через textContent — это текст, не разметка: «завтра …» с «&» и кавычками показывался «&amp;», «&quot;».
if (ctx.view) {
  ctx.data = { day: "2026-11-19", events: [], upcoming: [{ id: 1, time: "10:00", title: 'Кафе "Пушкин" & чай', date_iso: "2026-11-20" }], metrics: [] };
  const want = 'завтра 10:00 · Кафе "Пушкин" & чай';
  const ve = ctx.view("evening", { plan: null, late: 0, left: 0, done: 0, now: at(21) });
  const vn = ctx.view("night", { plan: null, late: 0, left: 0, done: 0, now: at(23, 30) });
  check(ve.lines[0] === want, `вечер: строка — текст, а экранирована как разметка: ${ve.lines[0]}`);
  check(vn.lines[0] === want, `ночь: строка — текст, а экранирована как разметка: ${vn.lines[0]}`);
}
// 2. Звёзды карточки меньше, чем в облачке: правило размера карточки должно перебивать общее :is(.bubble-actions, .mini-stars) —
// у :is() вес самого сильного довода (.mini-stars), и общее правило ниже по файлу брало верх (звёзды были 21×22, как в облачке).
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const starWins = (part) => {
  const shared = css.match(new RegExp("\n" + reEsc(`:is(.bubble-actions, .mini-stars) button.rate-star${part} {`) + "[^}]*width"))?.[0];
  const card = css.match(new RegExp("\n([^\n{]*" + reEsc(`.mini-stars button.rate-star${part}`) + ") \\{[^}]*width"));
  if (!shared || !card) return false;
  return card[1].match(/\./g).length > 2 || css.indexOf(card[0]) > css.indexOf(shared);
};
check(starWins(""), "размер звезды карточки (кнопка) перебит общим правилом звёзд");
check(starWins(" img"), "размер звезды карточки (картинка) перебит общим правилом звёзд");
// 3. Двойной щелчок по звезде: первый ставит оценку, ряд становится .rated (у звёзд pointer-events: none), второй попадает в сам ряд
// span.mini-stars — панель разворачивалась посреди оценки, а нажатие начинало перетаскивание карточки.
check(/\$\("#mini"\)\.addEventListener\("dblclick", \(e\) => \{ if \(e\.target\.closest\("[^"]*\.mini-stars/.test(widget), "двойной щелчок по ряду звёзд разворачивает панель");
check(/draggable\(\$\("#mini"\), \(e\) => e\.target\.closest\("[^"]*\.mini-stars/.test(widget), "нажатие на ряд звёзд начинает перетаскивание карточки");
// 4. Режим «вниз»: выдвижная панель под высокой карточкой (утро, вечер, строка ввода) уходила за низ окна на 33–49 px.
// syncDrawer ограничивает её высоту местом до низа окна (отступ 8 px), список внутри прокручивается.
{
  const sd = fn(clock, "syncDrawer", "clock.js");
  const props = {};
  let natural = 270;
  const box = { classList: { contains: () => false }, style: {}, get offsetHeight() { const mh = parseFloat(this.style.maxHeight); return Number.isNaN(mh) ? natural : Math.min(natural, mh); } };
  const st = { classList: { contains: (c) => c === "down" }, style: { setProperty: (k, v) => { props[k] = v; }, getPropertyValue: (k) => props[k] ?? "" } };
  const c2 = { $: (sel) => (sel === "#planClock" ? box : st), collapsed: true, innerHeight: 760 };
  vm.createContext(c2);
  try { vm.runInContext(`${sd}\nthis.sync = syncDrawer;`, c2); } catch (e) { check(false, `syncDrawer не разобрался: ${e?.message ?? e}`); }
  if (c2.sync) {
    for (const h of [68, 116, 146, 162]) {
      props["--lift"] = `${380 - h}px`;
      natural = 270; box.style = {}; c2.sync();
      const bottom = parseFloat(box.style.bottom);
      check(bottom >= 8, `вниз, карточка ${h} px: панель вылезла за низ окна на ${8 - bottom} px`);
      natural = 120; box.style = {}; c2.sync();
      check(parseFloat(box.style.bottom) === 8 + (380 - h) - 6 - 120, `вниз, карточка ${h} px: короткая панель встала не под карточку (${box.style.bottom})`);
    }
    st.classList.contains = () => false; box.style = { maxHeight: "200px" }; c2.sync();
    check(!box.style.maxHeight, "без режима «вниз» у выдвижной панели осталось ограничение высоты");
  }
}
// 5. Въезд при смене части суток: класс swap снимается, когда доигран, — иначе копия карточки при развороте (foldAnimated, cloneNode)
// проигрывала его заново и весь разворот стояла пустой. И въезжает только видимая (свёрнутая) карточка.
check(/addEventListener\("animationend", \(e\) => \{ if \(e\.animationName === "miniSwap"\) el\.classList\.remove\("swap"\)/.test(widget), "класс swap остаётся на карточке после въезда");
check(/if \(miniPart && miniPart !== part && collapsed\)/.test(mini), "въезд строк запускается и у скрытой карточки (панель развёрнута)");
// 6. Оценка с карточки закончилась, а часть суток уже другая (ряда нет): ряд всё равно пересобирается — «уже показанное» сбрасывается
// на значение, которого у вида не бывает (null), а не на "" (иначе на всю ночь оставались мёртвые серые звёзды).
check(/finally \{[^}]*miniExtraHtml = null/.test(click), "после оценки ряд не пересобирается, если в новом виде ряда нет");

console.log(`${n - bad}/${n}`);
process.exit(bad ? 1 : 0);
