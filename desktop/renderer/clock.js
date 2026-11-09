// Часы планов — круглый циферблат слева от панели: планы дня цветными дугами от начала до конца, названия — в списке под часами.
// Сами не висят: выезжают, когда планы меняются (добавили, перенесли, удалили — здесь, в Telegram или с телефона)
// или когда их смотрят (щелчок по строке «ближайший план»), и прячутся через несколько секунд, если мышь не над ними.
// Вид — настройка виджета «Планы дня»: список (по умолчанию: карточки по времени, галочка — состоялся, × — убрать),
// часы на 12 (до полудня — внутреннее кольцо, после — внешнее, поверх) или 24 часа, или выключено. У каждого плана свой цвет.

const CLOCK_SIZE = 280;
const CX = CLOCK_SIZE / 2;
const DISC_R = 90; // циферблат
// Ряды дуг. 24 часа: перекрывающиеся планы уходят во второй ряд, снаружи. 12 часов: внутренний — до полудня, внешний — после.
const LANES = { "24": [{ r: 106, w: 20 }, { r: 127, w: 15 }], "12": [{ r: 106, w: 17 }, { r: 126, w: 17 }] };
const CLOCK_SHOWN = 12_000;
const NO_END_MIN = 60; // план без времени конца — дуга на час
const ARC_COLORS = ["#6fb6ff", "#ffa25c", "#7fe0b0", "#ff7fa6", "#ffd45c", "#b59bff", "#5fd6e0", "#f08a6e"];

let clockDay = null; // какой день показан (YYYY-MM-DD)
let clockHideTimer = 0;
let clockHover = false;
let clockFresh = new Set(); // id планов, которые только что добавили или поменяли, — подсвечиваются
let clockGone = []; // только что удалённые — тают на своих местах
let clockColors = new Map(); // id плана → цвет: по порядку времени, чтобы соседние планы не совпадали
let lastPlans = null; // id → JSON плана, чтобы заметить изменения

const minutesOf = (t) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(t ?? "");
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
function colorOf(e) {
  if (clockColors.has(e.id)) return clockColors.get(e.id);
  let h = 0;
  for (const ch of e.title) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return ARC_COLORS[h % ARC_COLORS.length];
}
// Минуты → угол (градусы, 0 — вверх, по часовой).
function angleOf(min, mode) {
  return mode === "12" ? ((min % 720) / 720) * 360 : (min / 1440) * 360;
}
function polar(r, deg) {
  const a = ((deg - 90) * Math.PI) / 180;
  return [CX + r * Math.cos(a), CX + r * Math.sin(a)];
}
// Дуга по часовой от a0 до a1; reverse — та же дуга в обратную сторону (чтобы подпись внизу читалась не вверх ногами).
function arcPath(r, a0, a1, reverse = false) {
  const span = a1 - a0;
  const [x0, y0] = polar(r, reverse ? a1 : a0);
  const [x1, y1] = polar(r, reverse ? a0 : a1);
  const f = (n) => n.toFixed(2);
  return `M${f(x0)} ${f(y0)} A${r} ${r} 0 ${span > 180 ? 1 : 0} ${reverse ? 0 : 1} ${f(x1)} ${f(y1)}`;
}

// Полоса дней под заголовком: сегодня и ещё DAYS_AHEAD вперёд, у каждого — сколько планов; щелчок — показать этот день.
const DAYS_AHEAD = 6;
function dayAfter(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
let stripFrom = 0; // с какого дня от сегодня начинается полоса (стрелки листают по неделе)
const farPlans = new Map(); // день → планы дней дальше, чем приходят в /api/today (там — сегодня и 14 дней вперёд)
const NEAR_DAYS = 14;
function dayStrip(from = stripFrom, count = DAYS_AHEAD + 1) {
  return Array.from({ length: count }, (_, i) => {
    const day = dayAfter(data.day, from + i);
    const d = new Date(`${day}T12:00:00Z`);
    const wd = d.toLocaleDateString("ru-RU", { weekday: "short", timeZone: "UTC" });
    const n = plansOf(day).length + tasksOn(day).length;
    // Точка — в этот день важная дата (сама дата, не напоминание о ней заранее).
    const big = (data.dates ?? []).filter((x) => x.on === day);
    return `<button type="button" class="day-chip${day === clockDay ? " on" : ""}${day < data.day ? " past" : ""}${day === data.day ? " today" : ""}${n ? "" : " empty"}${big.length ? " has-date" : ""}" data-day="${day}" title="${esc(humanDay(day))}${n ? ` · ${n} ${planWord(n)} и задач` : " · планов нет"}${big.map((x) => ` · ${esc(x.title)}`).join("")}">
      <b>${d.getUTCDate()}</b> ${esc(wd)}<span class="cnt">${n ? `(${n})` : "–"}</span></button>`;
  }).join("");
}

function plansOf(day) {
  if (!data) return [];
  if (farPlans.has(day)) return farPlans.get(day);
  return [...(data.events ?? []), ...(data.upcoming ?? [])].filter((e) => e.date_iso === day);
}
// Задачи со сроком — в панели на день срока (открытые задачи приходят все, на любую дату).
const tasksOn = (day) => (data?.tasks ?? []).filter((t) => t.due_date === day);
const taskWord = (n) => (n % 10 === 1 && n % 100 !== 11 ? "задача" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? "задачи" : "задач");
// Дни полосы, которых нет в /api/today (прошлые и дальше 14 дней), — отдельным запросом, один раз.
const nearDay = (day) => { const n = daysFrom(data.day, day); return n >= 0 && n <= NEAR_DAYS; };
async function loadRange(from, to) {
  const rows = await maid.api("GET", `/api/events?from=${from}&to=${to}`);
  for (let d = from; d <= to; d = dayAfter(d, 1)) if (!nearDay(d)) farPlans.set(d, rows.filter((e) => e.date_iso === d && e.status !== "deleted"));
  return rows;
}
async function loadFar() {
  const need = Array.from({ length: DAYS_AHEAD + 1 }, (_, i) => dayAfter(data.day, stripFrom + i)).filter((d) => !nearDay(d) && !farPlans.has(d));
  if (!need.length) return;
  try {
    await loadRange(need[0], need.at(-1));
  } catch {
    return;
  }
  drawClock();
}

// Планы с временем → дуги: начало, конец, ряд. У 12 часов план через полдень делится на два куска — по кольцу на половину.
function layout(list, mode) {
  const timed = list
    .map((e) => {
      const s = minutesOf(e.time);
      if (s === null) return null;
      let end = minutesOf(e.end_time);
      if (end === null || end <= s) end = s + NO_END_MIN;
      return { e, s, end: Math.min(end, 1440) };
    })
    .filter(Boolean)
    .sort((a, b) => a.s - b.s);
  if (mode === "12") {
    return timed.flatMap((x) => [0, 1]
      .filter((h) => x.end > h * 720 && x.s < (h + 1) * 720)
      .map((h) => ({ ...x, lane: h, s: Math.max(x.s, h * 720), end: Math.min(x.end, (h + 1) * 720 - 1), from: x.s, to: x.end })));
  }
  const laneEnd = [-1, -1];
  for (const x of timed) {
    x.lane = laneEnd[0] <= x.s ? 0 : laneEnd[1] <= x.s ? 1 : 0;
    laneEnd[x.lane] = x.end;
    x.from = x.s;
    x.to = x.end;
  }
  return timed;
}

function arcSvg(x, mode, nowMin, { gone = false } = {}) {
  const lane = LANES[mode][x.lane];
  const a0 = angleOf(x.s, mode);
  let a1 = angleOf(x.end, mode);
  if (a1 <= a0) a1 = a0 + 360 * ((x.end - x.s) / (mode === "12" ? 720 : 1440));
  // Тёмная кромка под дугой отделяет её от соседней, на которую она легла. Скругления торцов добавляют по полтолщины с каждой стороны — дугу укорачиваем на них, иначе соседние слипаются.
  const cap = ((lane.w / 2) / lane.r) * (180 / Math.PI);
  const pad = Math.min(cap, (a1 - a0) / 2 - 0.5);
  const b0 = a0 + pad;
  const b1 = Math.max(b0 + 0.5, a1 - pad);
  const past = !gone && x.to <= nowMin && clockDay === data?.day;
  const now = !gone && x.from <= nowMin && nowMin < x.to && clockDay === data?.day;
  const cls = ["plan-arc", past && "past", now && "now", clockFresh.has(x.e.id) && "fresh", gone && "gone"].filter(Boolean).join(" ");
  const when = `${x.e.time}${x.e.end_time ? `–${x.e.end_time}` : ""}`;
  return `<g class="${cls}" color="${colorOf(x.e)}">
    <title>${esc(when)} · ${esc(x.e.title)}</title>
    <path class="edge" d="${arcPath(lane.r, b0, b1)}" stroke-width="${lane.w + 3}" />
    <path class="band" d="${arcPath(lane.r, b0, b1)}" stroke-width="${lane.w}" />
  </g>`;
}

function drawClock() {
  const box = $("#planClock");
  if (!box || !data || !clockDay) return;
  box.classList.toggle("as-list", cfg.clock === "list");
  if (cfg.clock === "list") return drawPlanList(box);
  const mode = cfg.clock === "12" ? "12" : "24";
  const d = new Date();
  const nowMin = d.getHours() * 60 + d.getMinutes();
  const list = plansOf(clockDay);
  clockColors = new Map(layout(list, "24").map((x, i) => [x.e.id, ARC_COLORS[i % ARC_COLORS.length]]));
  // Внешнее кольцо (после полудня) рисуется позже — лежит поверх внутреннего.
  const arcs = layout(list, mode).sort((p, q) => p.lane - q.lane);
  const gone = layout(clockGone, mode);
  const untimed = list.filter((e) => minutesOf(e.time) === null);

  // Деления: каждый час (у 24 часов каждый третий — длинный, с цифрой), у 12 — все цифры.
  const marks = [];
  const n = mode === "12" ? 12 : 24;
  for (let i = 0; i < n * 4; i++) {
    const a = (i / (n * 4)) * 360;
    const hour = i % 4 === 0;
    const big = hour && (mode === "12" || (i / 4) % 3 === 0);
    const [x0, y0] = polar(DISC_R - (big ? 9 : hour ? 6 : 3), a);
    const [x1, y1] = polar(DISC_R - 2, a);
    marks.push(`<line class="tick${big ? " big" : hour ? " hour" : ""}" x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}" />`);
    if (big) {
      const h = i / 4;
      const [tx, ty] = polar(DISC_R - 19, a);
      marks.push(`<text class="num" x="${tx.toFixed(1)}" y="${(ty + 4).toFixed(1)}">${mode === "12" ? h || 12 : h}</text>`);
    }
  }
  // Ночь у 24-часовых — тёмный сектор 23:00–07:00 по краю циферблата.
  const night = mode === "24" ? `<path class="night" d="${arcPath(DISC_R - 4, angleOf(23 * 60, "24"), angleOf(31 * 60, "24"))}" stroke-width="6" />` : "";
  const handA = angleOf(nowMin, mode);
  const showHand = clockDay === data.day;
  // Стрелка — тонкая игла до делений, не до цифр, с коротким хвостом за центром.
  const HAND_R = DISC_R - 30;
  const [hx, hy] = polar(HAND_R, handA);
  const [tx0, ty0] = polar(12, handA + 180);
  const [lx, ly] = polar(3.2, handA - 90);
  const [rx, ry] = polar(3.2, handA + 90);
  const f = (v) => v.toFixed(1);
  const hand = `<path class="hand" d="M${f(tx0)} ${f(ty0)} L${f(lx)} ${f(ly)} L${f(hx)} ${f(hy)} L${f(rx)} ${f(ry)} Z" />`;

  const dayName = clockDay === data.day ? "Сегодня" : humanDay(clockDay);
  // Список под часами: время и название, цвет — как у дуги; прошедшие бледнее, идущий сейчас — ярче.
  const today = clockDay === data.day;
  const item = (e, cls) => ({ at: minutesOf(e.time) ?? 1441, keep: cls.includes("fresh") || cls.includes("gone"),
    html: `<li class="${cls}"><i class="dot${minutesOf(e.time) === null ? " none" : ""}" data-c="${colorOf(e)}"></i><span class="t">${esc(e.time ?? "—")}</span>${esc(e.title)}</li>` });
  const rows = [
    ...layout(list, "24").map((x) => item(x.e, [
      today && x.end <= nowMin ? "past" : today && x.s <= nowMin && nowMin < x.end ? "now" : "",
      clockFresh.has(x.e.id) ? "fresh" : "",
    ].join(" ").trim())),
    ...untimed.map((e) => item(e, clockFresh.has(e.id) ? "fresh" : "")),
    ...clockGone.map((e) => item(e, "gone")),
  ].sort((p, q) => p.at - q.at);
  // Не влезает — сначала то, что только что поменялось, остальное по времени.
  const MAX_ROWS = 5;
  let shownRows = rows;
  if (rows.length > MAX_ROWS) {
    const keep = new Set(rows.filter((r) => r.keep).slice(0, MAX_ROWS - 1));
    for (const r of rows) if (keep.size < MAX_ROWS - 1) keep.add(r);
    shownRows = rows.filter((r) => keep.has(r));
  }
  const more = rows.length - shownRows.length;
  const legend = rows.length ? `<ul class="pc-list">${shownRows.map((r) => r.html).join("")}${more ? `<li class="more">и ещё ${more}</li>` : ""}</ul>` : "";

  // У 12 часов кольца — две половины дня: внутри светлое тёплое «до полудня» с мягким свечением, снаружи тёмное вечернее.
  const halves = () => LANES["12"].map((l, k) => {
    return `<circle class="orbit ${k ? "pm" : "am"}" cx="${CX}" cy="${CX}" r="${l.r}" stroke-width="${l.w}"><title>${k ? "После полудня" : "До полудня"}</title></circle>`;
  }).join("") + `<circle class="orbit seam" cx="${CX}" cy="${CX}" r="${(LANES["12"][0].r + LANES["12"][1].r) / 2}" />`;
  box.innerHTML = `
    ${headHtml(dayName, list.length ? `${list.length} ${planWord(list.length)}` : "планов нет")}
    <div class="pc-strip"><div class="pc-days">${dayStrip()}</div></div>
    <svg viewBox="0 0 ${CLOCK_SIZE} ${CLOCK_SIZE}" width="${CLOCK_SIZE}" height="${CLOCK_SIZE}" aria-label="Планы на ${esc(dayName)}">
      ${mode === "12" ? halves() : `<circle class="orbit" cx="${CX}" cy="${CX}" r="${LANES[mode][0].r}" />`}
      <circle class="orbit dots" cx="${CX}" cy="${CX}" r="${LANES[mode][1].r + 10}" />
      <circle class="disc" cx="${CX}" cy="${CX}" r="${DISC_R}" />
      ${night}
      ${marks.join("")}
      ${gone.map((x) => arcSvg(x, mode, nowMin, { gone: true })).join("")}
      ${arcs.map((x) => arcSvg(x, mode, nowMin)).join("")}
      ${showHand ? `${hand}<circle class="hub-ring" cx="${CX}" cy="${CX}" r="5.5" />` : ""}
      <circle class="hub" cx="${CX}" cy="${CX}" r="${showHand ? 2.4 : 4}" />
    </svg>
    ${legend}`;
  // Цвет меток — через CSSOM: строгая политика окна не пускает атрибуты style в разметке.
  for (const d of box.querySelectorAll(".dot[data-c]:not(.none)")) d.style.background = d.dataset.c;
  fitClockHeight(box);
}
// Высота постоянная, какой бы день ни выбрали: не ниже панели (верх вровень с ней) и с местом под самый длинный список.
// Не влезает — список прокручивается внутри.
const CLOCK_LIST_ROWS = 6;
function fitClockHeight(box) {
  const w = $("#w");
  const svg = box.querySelector("svg");
  const pad = parseFloat(getComputedStyle(box).paddingBottom) || 0;
  const fixed = svg.getBoundingClientRect().bottom - box.getBoundingClientRect().top + pad + 6;
  const want = Math.max(w?.offsetHeight ?? 0, fixed + CLOCK_LIST_ROWS * 19 + 4);
  box.style.height = `${Math.min(want, box.parentElement.clientHeight - 16)}px`;
}
const planWord = (n) => (n % 10 === 1 && n % 100 !== 11 ? "план" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? "плана" : "планов");

// --- важные даты (дни рождения, годовщины…) наверху планов ---
// Дата висит в планах своего дня и cfg.dateLead дней до него. × убирает её до следующего раза (в этом году — только этот),
// убранное хранится здесь, на компьютере: на сервере дата остаётся (она каждый год).
const DATE_ICON = { birthday: "🎂", anniversary: "💍", holiday: "🎉", deadline: "⏳", other: "📌" };
const hiddenDates = new Set(JSON.parse(localStorage.getItem("maid.datesHidden") || "[]"));
const datesHiddenNow = new Set(); // убранные, пока панель открыта: остаются зачёркнутыми, щелчок — вернуть
const dateKey = (d) => `${d.id}:${d.on}`;
function daysFrom(a, b) {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 864e5);
}
function datesOf(day, withHidden = false) {
  const lead = Number(cfg.dateLead ?? 1);
  return (data?.dates ?? []).filter((d) => {
    const n = daysFrom(day, d.on);
    return n >= 0 && n <= lead && (withHidden || !hiddenDates.has(dateKey(d)));
  });
}
function yearsWord(n) {
  const a = n % 100, b = n % 10;
  return a > 10 && a < 20 ? "лет" : b === 1 ? "год" : b > 1 && b < 5 ? "года" : "лет";
}
function dateText(d, day) {
  const n = daysFrom(day, d.on);
  const today = day === data.day;
  const when = n === 0 ? (today ? "сегодня" : "в этот день") : n === 1 ? (today ? "завтра" : "на следующий день") : `через ${n} дн.`;
  return `<b class="pl-when">${DATE_ICON[d.type] ?? DATE_ICON.other} ${when}</b> · ${esc(d.title)}${d.age ? ` · ${d.age} ${yearsWord(d.age)}` : ""}`;
}
function toggleDate(key) {
  if (hiddenDates.has(key)) { hiddenDates.delete(key); datesHiddenNow.delete(key); }
  else { hiddenDates.add(key); datesHiddenNow.add(key); }
  // Старые годы не копить: оставить только даты, которые ещё впереди.
  const keep = [...hiddenDates].filter((k) => k.split(":")[1] >= data.day);
  localStorage.setItem("maid.datesHidden", JSON.stringify(keep));
  drawClock();
  render();
}

// --- список планов дня ---
const planDone = new Map(); // id → { e, status, at } — отмеченные здесь: остаются в списке зачёркнутыми, пока панель открыта
// Выполненный план виден ещё DONE_FADE мс: карточка заливается цветом слева направо, галочка при наведении — × «отменить»;
// залилась — улетает вправо (DONE_FLY мс) и пропадает.
const DONE_FADE = 3000;
const DONE_FLY = 380;
const DONE_SHUT = 220;
const doneTimers = new Map(); // id → таймер ухода
function drawPlanList(box) {
  const today = clockDay === data.day;
  const d = new Date();
  const nowMin = d.getHours() * 60 + d.getMinutes();
  const ids = new Set();
  const list = [
    ...[...planDone.values()].filter((x) => x.e.date_iso === clockDay).map((x) => ({ ...x.e, _st: x.status })),
    ...plansOf(clockDay),
    ...clockGone.map((e) => ({ ...e, _st: "gone" })),
  ].filter((e) => !ids.has(e.id) && ids.add(e.id))
    .sort((a, b) => (minutesOf(a.time) ?? 1441) - (minutesOf(b.time) ?? 1441));
  clockColors = new Map(layout(list, "24").map((x, i) => [x.e.id, ARC_COLORS[i % ARC_COLORS.length]]));
  const pins = datesOf(clockDay, true).filter((d) => !hiddenDates.has(dateKey(d)) || datesHiddenNow.has(dateKey(d)));
  const pinCard = (d) => {
    const off = hiddenDates.has(dateKey(d));
    return `<li class="pl-card pl-date${off ? " cancelled" : ""}" data-date="${esc(dateKey(d))}">
      <span class="pl-text">${dateText(d, clockDay)}</span>
      <button type="button" class="pl-x${off ? " back" : ""}" data-dact="1" title="${off ? "Вернуть" : "Убрать — больше не показывать до этой даты"}">${off ? "↺" : "×"}</button></li>`;
  };
  const open = list.filter((e) => !e._st).length;
  const tasks = tasksOn(clockDay);
  const dayName = today ? "Сегодня" : humanDay(clockDay);
  const count = [open && `${open} ${planWord(open)}`, tasks.length && `${tasks.length} ${taskWord(tasks.length)}`].filter(Boolean).join(" · ") || "планов нет";
  const taskCard = (t) => `<li class="pl-card pl-task${clockFresh.has(`t${t.id}`) ? " fresh" : ""}${clockDay < data.day ? " late" : ""}" data-task="${t.id}">
      <span class="pl-text"><b class="pl-when">${clockDay < data.day ? "срок прошёл" : "срок"}</b> · ${esc(t.title)}</span>
      <button type="button" class="pl-check" data-tdone="1" title="Сделано"></button></li>`;
  const card = (e) => {
    const st = e._st ?? "";
    const start = minutesOf(e.time);
    let end = minutesOf(e.end_time);
    if (start !== null && (end === null || end <= start)) end = start + NO_END_MIN;
    const past = today && !st && end !== null && end <= nowMin;
    const now = today && !st && start !== null && start <= nowMin && nowMin < end;
    const when = e.time ? `<b class="pl-when">в ${esc(e.time)}${e.end_time ? `–${esc(e.end_time)}` : ""}</b> · ` : ""; // без времени — только название
    const tools = st === "gone" ? "" : `${st ? "" : `<button type="button" class="pl-x" data-act="cancelled" title="Убрать из планов">×</button>`}
      <button type="button" class="pl-check${st === "done" ? " on" : st === "cancelled" ? " on off" : ""}" data-act="${st ? "active" : "done"}" title="${st ? "Отменить — вернуть в планы" : "Состоялось"}">${st === "done" ? "<i>✓</i><b>×</b>" : st === "cancelled" ? "<i>×</i><b>↺</b>" : ""}</button>`;
    return `<li class="pl-card${st ? ` ${st}` : ""}${past ? " past" : ""}${now ? " now" : ""}${clockFresh.has(e.id) ? " fresh" : ""}${leaving(e.id)}" data-id="${e.id}" data-c="${colorOf(e)}">
      <span class="pl-text">${when}${esc(e.title)}${e.repeat || e.series ? ` <i class="pl-rep" title="Повторяется">🔁</i>` : ""}</span>${tools}</li>`;
  };
  box.innerHTML = `
    ${headHtml(dayName, count)}
    <div class="pc-strip">
      <button type="button" class="pc-arrow" data-shift="-1" title="Неделя назад">‹</button>
      <div class="pc-days">${dayStrip()}</div>
      <button type="button" class="pc-arrow" data-shift="1" title="Неделя вперёд">›</button>
    </div>
    <div class="pl-top"><span>Планы на день</span></div>
    ${list.length || pins.length || tasks.length ? `<ul class="pl-list">${pins.map(pinCard).join("")}${tasks.map(taskCard).join("")}${list.map(card).join("")}</ul>` : `<p class="pl-empty">Свободный день.</p>`}`;
  // Цвет полоски карточки — через CSSOM: строгая политика окна не пускает атрибуты style в разметке.
  for (const li of box.querySelectorAll(".pl-card[data-c]")) li.style.setProperty("--c", li.dataset.c);
  // Заливка продолжает идти с того же места, хотя список перерисован.
  for (const li of box.querySelectorAll(".pl-card.leaving")) {
    const at = planDone.get(Number(li.dataset.id))?.at ?? Date.now();
    const x = planDone.get(Number(li.dataset.id));
    li.style.setProperty("--fill-delay", `-${Math.min((x?.pausedAt ?? Date.now()) - at, DONE_FADE)}ms`);
    if (x?.pausedAt) li.classList.add("hold");
  }
  box.style.height = `${Math.min(Math.max($("#w")?.offsetHeight ?? 0, 320), box.parentElement.clientHeight - 16)}px`;
}
// Отсчёт до улёта. Пока мышь на карточке, он стоит (и заливка тоже) — чтобы карточка не улетела из-под курсора.
// Наведение, оставшееся от самого щелчка по галочке, не в счёт: пауза — только когда мышь ушла с карточки и вернулась.
// Отмеченный (галочка) и убранный (×) уходят одинаково: заливка, потом улёт; пока идёт заливка — можно вернуть.
const going = (x) => x?.status === "done" || x?.status === "cancelled";
function planCountdown(id) {
  const x = planDone.get(id);
  if (!going(x) || x.pausedAt) return;
  clearTimeout(doneTimers.get(id));
  doneTimers.set(id, setTimeout(() => planFly(id), Math.max(0, DONE_FADE - (Date.now() - x.at))));
}
function planHold(id, on) {
  const x = planDone.get(id);
  if (!going(x) || !x.at || x.fly) return;
  const li = document.querySelector(`#planClock .pl-card[data-id="${id}"]`);
  if (on && !x.pausedAt) {
    x.pausedAt = Date.now();
    clearTimeout(doneTimers.get(id));
    li?.classList.add("hold");
  } else if (!on && x.pausedAt) {
    x.at += Date.now() - x.pausedAt;
    x.pausedAt = 0;
    li?.classList.remove("hold");
    planCountdown(id);
  }
}
// Улёт вправо, потом место карточки плавно сжимается, и список подтягивается.
function planFly(id) {
  const x = planDone.get(id);
  if (!going(x)) return doneTimers.delete(id);
  x.fly = true;
  const li = document.querySelector(`#planClock .pl-card[data-id="${id}"]`);
  li?.classList.add("fly");
  doneTimers.set(id, setTimeout(() => {
    const done = () => { doneTimers.delete(id); if (planDone.get(id)?.fly) { planDone.delete(id); drawClock(); } };
    const el = document.querySelector(`#planClock .pl-card[data-id="${id}"]`);
    if (!el) return done();
    el.style.height = `${el.offsetHeight}px`;
    void el.offsetHeight;
    el.classList.add("shut");
    el.nextElementSibling?.classList.add("pull"); // промежуток сетки под карточкой тоже уходит (отрицательный отступ у пустой строки сетка не берёт)
    doneTimers.set(id, setTimeout(done, DONE_SHUT));
  }, DONE_FLY));
}
function leaving(id) {
  const x = planDone.get(id);
  return going(x) && x.at ? ` leaving${x.fly ? " fly" : ""}` : "";
}
// Галочка — состоялся, × — убрать (отменён); оба заливаются и улетают, щелчок по отметке до улёта — вернуть в планы.
async function setPlanStatus(id, status) {
  const e = plansOf(clockDay).find((x) => x.id === id) ?? planDone.get(id)?.e;
  if (!e) return;
  clearTimeout(doneTimers.get(id));
  doneTimers.delete(id);
  if (status === "active") planDone.delete(id);
  else planDone.set(id, { e, status, at: Date.now() });
  planCountdown(id);
  lastPlans?.delete(id); // своё действие — не показывать его как «удалено где-то ещё»
  drawClock();
  try {
    await maid.api("POST", `/api/events/${id}`, { status });
  } catch (err) {
    planDone.delete(id);
    drawClock();
    const msg = String(err?.message ?? err);
    say(/нет такого адреса|404/.test(msg) ? "Сервер ещё не умеет отмечать планы — его нужно обновить." : `Не вышло: ${msg}`, { emotion: "worried", ms: 6000 });
    return;
  }
  if (status === "done") react?.("happy", 1800);
  farPlans.clear();
  await load();
  lastPlans?.delete(id);
}

async function doneTaskHere(id, btn) {
  const li = btn.closest(".pl-card");
  btn.classList.add("on");
  btn.innerHTML = "<i>✓</i>";
  li.classList.add("done");
  popTone(4);
  react?.("done", 4000);
  try {
    await maid.api("POST", `/api/tasks/${id}`, { status: "done" });
    maid.changed();
  } catch (err) {
    say(err.message, { ms: 6000 });
  }
  setTimeout(() => load(), 900);
}

function showClock(day, { fresh = [], gone = [] } = {}) {
  if (cfg.clock === "off" || collapsed || prefsOpen || !data) return;
  const box = $("#planClock");
  clockDay = day;
  clockFresh = new Set(fresh);
  clockGone = gone;
  drawClock();
  box.classList.remove("hidden");
  hideClockLater();
}
function hideClock() {
  clearTimeout(clockHideTimer);
  $("#planClock").classList.add("hidden");
  planDone.clear();
  for (const t of doneTimers.values()) clearTimeout(t);
  doneTimers.clear();
  datesHiddenNow.clear();
  stripFrom = 0;
  clockFresh = new Set();
  clockGone = [];
  stopFly();
}
function hideClockLater(ms = CLOCK_SHOWN) {
  clearTimeout(clockHideTimer);
  clockHideTimer = setTimeout(() => (clockHover ? hideClockLater() : hideClock()), ms);
}

// После каждой загрузки данных: что из планов появилось, поменялось или пропало (неважно, где — здесь, в Telegram, с телефона).
const quietPlans = new Set(); // id планов, которые появились от своего действия здесь (копия перетаскиванием) — не переключать на их день
function watchPlans() {
  if (!data) return;
  const all = [...(data.events ?? []), ...(data.upcoming ?? [])];
  const due = (data.tasks ?? []).filter((t) => t.due_date);
  const now = new Map([...all.map((e) => [e.id, JSON.stringify(e)]), ...due.map((t) => [`t${t.id}`, JSON.stringify(t)])]);
  const prev = lastPlans;
  lastPlans = now;
  if (!prev) return;
  const fresh = all.filter((e) => prev.get(e.id) !== now.get(e.id) && !quietPlans.delete(e.id));
  // Задача — новая или поменялся срок (изменение названия не в счёт).
  const freshTasks = due.filter((t) => { const was = prev.get(`t${t.id}`); return !was || JSON.parse(was).due_date !== t.due_date; });
  const gone = [...prev].filter(([id]) => !now.has(id)).map(([, j]) => JSON.parse(j)).filter((e) => e.date_iso >= data.day);
  if (!fresh.length && !freshTasks.length && !gone.length) {
    if (!$("#planClock").classList.contains("hidden")) drawClock(); // стрелка и прошедшие планы
    return;
  }
  const day = fresh[0]?.date_iso ?? freshTasks[0]?.due_date ?? gone[0].date_iso;
  const freshKeys = [...fresh.map((e) => e.id), ...freshTasks.map((t) => `t${t.id}`)];
  // Панель была спрятана, а план — на другой день: едем к нему по полосе (свои действия в открытой панели — без этого).
  if (freshKeys.length && day > data.day && $("#planClock").classList.contains("hidden")) {
    const days = new Set([...fresh.map((e) => e.date_iso), ...freshTasks.map((t) => t.due_date)]);
    return flyToDay(day, { fresh: freshKeys, gone: gone.filter((e) => e.date_iso === day), more: days.size - 1 });
  }
  showClock(day, { fresh: freshKeys, gone: gone.filter((e) => e.date_iso === day) });
}

$("#planClock").addEventListener("mouseenter", () => { clockHover = true; });
$("#planClock").addEventListener("mouseleave", () => { clockHover = false; hideClockLater(); });
// Пауза отсчёта у выполненного плана: мышь ушла с карточки — «взвести», вернулась — стоп, ушла снова — дальше.
$("#planClock").addEventListener("mouseover", (e) => {
  const li = e.target.closest(".pl-card.leaving");
  if (li && !li.contains(e.relatedTarget) && planDone.get(Number(li.dataset.id))?.armed) planHold(Number(li.dataset.id), true);
});
$("#planClock").addEventListener("mouseout", (e) => {
  const li = e.target.closest(".pl-card.leaving");
  if (!li || li.contains(e.relatedTarget)) return;
  const x = planDone.get(Number(li.dataset.id));
  if (x) x.armed = true;
  planHold(Number(li.dataset.id), false);
});
$("#planClock").addEventListener("click", (e) => {
  const tdone = e.target.closest("[data-tdone]");
  if (tdone) {
    doneTaskHere(Number(tdone.closest(".pl-card").dataset.task), tdone);
    return hideClockLater();
  }
  const dact = e.target.closest("[data-dact]");
  if (dact) {
    toggleDate(dact.closest(".pl-card").dataset.date);
    return hideClockLater();
  }
  const act = e.target.closest("[data-act]");
  if (act) {
    setPlanStatus(Number(act.closest(".pl-card").dataset.id), act.dataset.act);
    return hideClockLater();
  }
  const arrow = e.target.closest(".pc-arrow");
  if (arrow) {
    goDay(dayAfter(clockDay, Number(arrow.dataset.shift) * (DAYS_AHEAD + 1)), { week: true });
    return hideClockLater();
  }
  if (e.target.closest("[data-today]")) {
    goDay(data.day, { center: true });
    return hideClockLater();
  }
  if (e.target.closest("[data-cal]")) return calShut ? (calShut = false) : openCalendar(clockDay);
  const chip = e.target.closest(".day-chip");
  if (chip && swipedAt > Date.now() - 250) return;
  if (chip) {
    flyNote = null;
    clockDay = chip.dataset.day;
    clockFresh = new Set();
    clockGone = [];
    drawClock();
    return hideClockLater();
  }
  if (!e.target.closest(".plan-arc, .pl-list, .pl-top, .pl-empty, .pc-strip, .pc-head")) hideClock();
});
// Листание дат: колесо над полосой — день вперёд/назад (Shift — неделя), полосу можно тянуть мышью, стрелки — неделя,
// «Сегодня» — назад к сегодня, щелчок по дате в заголовке — календарь месяца. Можно и в прошлое: посмотреть, что было.
const CAL_ICO = `<svg class="pc-cal-ico" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="2" y="3" width="12" height="11" rx="2.2"/><path d="M2 6.5h12M5.5 1.6v3M10.5 1.6v3"/><circle cx="5.4" cy="9.4" r=".9"/><circle cx="8" cy="9.4" r=".9"/><circle cx="10.6" cy="9.4" r=".9"/></svg>`;
function headHtml(dayName, count) {
  if (flyNote) return `<div class="pc-head"><button type="button" class="pc-title" data-cal title="Календарь месяца"><b>${esc(dayName)}</b>${CAL_ICO}</button><span class="pc-far">${esc(flyNote)}</span></div>`;
  const back = clockDay !== data.day ? `<button type="button" class="pc-today" data-today title="Вернуться к сегодня">${clockDay < data.day ? "Сегодня →" : "← Сегодня"}</button>` : "";
  return `<div class="pc-head"><button type="button" class="pc-title" data-cal title="Календарь месяца"><b>${esc(dayName)}</b>${CAL_ICO}</button>${back || `<span>${count}</span>`}</div>`;
}
/** Показать день: полоса сдвигается ровно настолько, чтобы он был виден (center — по середине, week — вместе с ним на неделю). */
function goDay(day, { center = false, week = false } = {}) {
  const n = daysFrom(data.day, day);
  const was = stripFrom;
  if (day === data.day && center) stripFrom = 0;
  else if (week) stripFrom += n - daysFrom(data.day, clockDay);
  else if (center || n < stripFrom - 7 || n > stripFrom + DAYS_AHEAD + 7) stripFrom = n - Math.floor(DAYS_AHEAD / 2);
  else if (n < stripFrom) stripFrom = n;
  else if (n > stripFrom + DAYS_AHEAD) stripFrom = n - DAYS_AHEAD;
  const moved = day !== clockDay;
  flyNote = null;
  clockDay = day;
  clockFresh = new Set();
  clockGone = [];
  drawClock();
  if (stripFrom !== was) slideStrip(Math.sign(stripFrom - was));
  if (moved) popTone(0, { vol: 0.05, soft: true });
  loadFar();
}
function slideStrip(dir) {
  const el = $("#planClock .pc-days");
  if (!el || !dir) return;
  el.classList.add(dir > 0 ? "slide-l" : "slide-r");
}
// Колесо: тачпад шлёт много мелких шагов — копим до 60.
let wheelAcc = 0;
$("#planClock").addEventListener("wheel", (ev) => {
  if (!ev.target.closest(".pc-strip, .pc-head")) return;
  ev.preventDefault();
  wheelAcc += Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.deltaY;
  if (Math.abs(wheelAcc) < 60) return;
  const step = Math.sign(wheelAcc) * (ev.shiftKey ? DAYS_AHEAD + 1 : 1);
  wheelAcc = 0;
  goDay(dayAfter(clockDay, step), { week: ev.shiftKey });
  hideClockLater();
}, { passive: false });
// Тянуть полосу: на ширину дня — полоса сдвигается на день, отпустил — встаёт на место.
let stripSwipe = null;
let swipedAt = 0;
$("#planClock").addEventListener("pointerdown", (ev) => {
  const days = ev.target.closest(".pc-days");
  if (ev.button !== 0 || !days || planDrag) return;
  stripSwipe = { x: ev.clientX, from: stripFrom, w: (days.firstElementChild?.offsetWidth ?? 40) + 3, moved: false, id: ev.pointerId, steps: 0 };
});
$("#planClock").addEventListener("pointermove", (ev) => {
  const sw = stripSwipe;
  if (!sw || ev.pointerId !== sw.id) return;
  const dx = ev.clientX - sw.x;
  if (!sw.moved && Math.abs(dx) < 6) return;
  if (!sw.moved) {
    sw.moved = true;
    $("#planClock").setPointerCapture(ev.pointerId);
    $("#planClock").classList.add("swiping");
  }
  const steps = Math.round(-dx / sw.w);
  if (steps !== sw.steps) {
    sw.steps = steps;
    stripFrom = sw.from + steps;
    drawClock();
    popTone(0, { vol: 0.04, soft: true });
  }
  const el = $("#planClock .pc-days");
  if (el) el.style.transform = `translateX(${dx + steps * sw.w}px)`;
});
function endSwipe(ev) {
  const sw = stripSwipe;
  if (!sw || ev.pointerId !== sw.id) return;
  stripSwipe = null;
  if (!sw.moved) return;
  swipedAt = Date.now();
  $("#planClock").classList.remove("swiping");
  // Выбранный день ушёл за край — выбираем ближний видимый.
  const n = daysFrom(data.day, clockDay);
  if (n < stripFrom || n > stripFrom + DAYS_AHEAD) {
    clockDay = dayAfter(data.day, n < stripFrom ? stripFrom : stripFrom + DAYS_AHEAD);
    drawClock();
  }
  const el = $("#planClock .pc-days");
  if (el) {
    el.classList.add("settle");
    requestAnimationFrame(() => { el.style.transform = ""; });
  }
  loadFar();
  hideClockLater();
}
$("#planClock").addEventListener("pointerup", endSwipe);
$("#planClock").addEventListener("pointercancel", endSwipe);

// Календарь месяца: точки — сколько планов в день, золотая — важная дата; ‹ › и колесо — месяц; щелчок по дню — показать его.
const MONTH_NAMES = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
function openCalendar(day) {
  closePlanMenu();
  const box = document.createElement("div");
  box.className = "pl-menu pc-cal";
  let month = day.slice(0, 7);
  const rows = new Map();
  const lastOf = (mon) => { const [y, m] = mon.split("-").map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
  const draw = () => {
    const [y, m] = month.split("-").map(Number);
    const lead = (wdOf(`${month}-01`) + 6) % 7;
    const cells = Array.from({ length: lead }, () => `<i></i>`);
    for (let d = 1; d <= lastOf(month); d++) {
      const iso = `${month}-${String(d).padStart(2, "0")}`;
      const n = (nearDay(iso) || farPlans.has(iso) ? plansOf(iso).length : 0) + tasksOn(iso).length;
      const big = (data.dates ?? []).some((x) => x.on === iso);
      const dots = n ? `<span class="cal-dots">${"<em></em>".repeat(Math.min(n, 3))}</span>` : "";
      const cls = [iso === clockDay && "on", iso === data.day && "today", iso < data.day && "past", big && "big"].filter(Boolean).join(" ");
      cells.push(`<button type="button" data-go="${iso}" class="${cls}" title="${esc(humanDay(iso))}${n ? ` · ${n} ${planWord(n)}` : ""}">${d}${dots}</button>`);
    }
    box.innerHTML = `<div class="cal-top"><button type="button" data-m="-1" title="Месяц назад">‹</button>
      <b>${MONTH_NAMES[m - 1]} ${y}</b><button type="button" data-m="1" title="Месяц вперёд">›</button></div>
      <div class="cal-wd">${WD_ORDER.map((d) => `<span>${WD_SHORT[d]}</span>`).join("")}</div>
      <div class="cal-grid">${cells.join("")}</div>
      ${month !== data.day.slice(0, 7) ? `<button type="button" class="cal-today" data-go="${data.day}">К сегодня</button>` : ""}`;
  };
  const fetchMonth = async () => {
    if (rows.has(month)) return;
    const mon = month;
    rows.set(mon, true);
    try {
      await loadRange(`${mon}-01`, `${mon}-${String(lastOf(mon)).padStart(2, "0")}`);
    } catch {
      return;
    }
    if (planMenu === box && month === mon) draw();
  };
  const shiftMonth = (k) => {
    const [y, m] = month.split("-").map(Number);
    month = new Date(Date.UTC(y, m - 1 + k, 1)).toISOString().slice(0, 7);
    popTone(k > 0 ? 1 : -1, { vol: 0.05, soft: true });
    draw();
    keepIn(box);
    fetchMonth();
  };
  draw();
  const r = $("#planClock .pc-title").getBoundingClientRect();
  showPlanMenu(box, r.left, r.bottom + 4);
  fetchMonth();
  let acc = 0;
  box.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    acc += ev.deltaY;
    if (Math.abs(acc) < 60) return;
    shiftMonth(Math.sign(acc));
    acc = 0;
  }, { passive: false });
  box.addEventListener("click", (ev) => {
    const b = ev.target.closest("button");
    if (!b) return;
    if (b.dataset.m) return shiftMonth(Number(b.dataset.m));
    if (b.dataset.go) {
      closePlanMenu();
      clockHover = $("#planClock").matches(":hover");
      goDay(b.dataset.go, { center: true });
    }
  });
}

// Новый план на другой день (из чата, Telegram, с телефона): панель открывается на сегодня, полоса едет день за днём к его дню —
// видно, через сколько дней, — там план появляется, и через несколько секунд панель уходит сама (если мышь не над ней).
const FLY_SHOWN = 5_000;
let flyNote = null; // «через 5 дней» — в заголовке вместо числа планов, пока не начали листать сами
let flyRun = 0;
const dayWord = (n) => {
  const a = n % 10, b = n % 100;
  return a === 1 && b !== 11 ? "день" : a >= 2 && a <= 4 && (b < 12 || b > 14) ? "дня" : "дней";
};
const inDays = (n) => (n === 1 ? "завтра" : `через ${n} ${dayWord(n)}`);
function stopFly() {
  const was = $("#planClock").classList.contains("flying");
  flyRun++;
  flyNote = null;
  $("#planClock").classList.remove("flying");
  if (was && !$("#planClock").classList.contains("hidden")) drawClock();
}
function flyToDay(day, { fresh = [], gone = [], more = 0 } = {}) {
  const n = daysFrom(data.day, day);
  if (n <= 0) return showClock(day, { fresh, gone });
  const run = ++flyRun;
  stripFrom = 0;
  showClock(data.day);
  const box = $("#planClock");
  if (box.classList.contains("hidden")) return; // панель выключена или свёрнута
  clearTimeout(clockHideTimer);
  box.classList.add("flying");
  // Полоса едет одним движением: на время полёта в ней лента из всех дней до нужного (очень далёкие — последние 120),
  // лента сдвигается непрерывно, выделение идёт по дням. Медленный старт, разгон, плавная остановка — одна кривая.
  const from = Math.max(0, n - 120);
  const last = Math.max(0, n - DAYS_AHEAD); // с какого дня полоса начнётся в конце
  const dur = Math.min(2200, Math.max(800, 650 + n * 45));
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
  let lastK = -1;
  let tickAt = 0;
  let rail = null;
  let step = 0;
  const mount = () => {
    const days = $("#planClock .pc-days");
    if (!days || !days.getBoundingClientRect().width) return null;
    // Ширина дня — как в обычной полосе: 7 равных колонок с зазором 3 px.
    const w = (days.getBoundingClientRect().width - 3 * DAYS_AHEAD) / (DAYS_AHEAD + 1);
    step = w + 3;
    days.classList.add("rail-box");
    days.innerHTML = `<div class="fly-rail">${dayStrip(from, n - from + 1)}</div>`;
    const r = days.firstElementChild;
    r.style.gridTemplateColumns = `repeat(${n - from + 1}, ${w}px)`;
    return r;
  };
  const frame = (at, t0) => {
    if (run !== flyRun) return;
    if (!rail?.isConnected) rail = mount();
    const t = Math.min(1, (at - t0) / dur);
    const e = ease(t);
    const k = from + (n - from) * e; // выбранный день
    const shift = (Math.max(from, last) - from) * e; // лента едет по той же кривой с первого кадра
    if (rail) rail.style.transform = `translateX(${(-shift * step).toFixed(1)}px)`;
    const kd = Math.round(k);
    if (kd !== lastK && t < 1) {
      lastK = kd;
      const d = dayAfter(data.day, kd);
      rail?.querySelector(".day-chip.on")?.classList.remove("on");
      rail?.querySelector(`.day-chip[data-day="${d}"]`)?.classList.add("on");
      const b = $("#planClock .pc-title b");
      if (b) b.textContent = kd === 0 ? "Сегодня" : humanDay(d);
      const far = $("#planClock .pc-far");
      if (far) far.textContent = kd ? inDays(kd) : "";
      if (at - tickAt > 45) {
        tickAt = at;
        popTone(Math.round(((kd - from) / Math.max(1, n - from)) * 7), { vol: 0.03, soft: true });
      }
    }
    if (t < 1) return requestAnimationFrame((a) => frame(a, t0));
    // Приехали: обычная полоса на том же месте, план появляется, чип подпрыгивает.
    stripFrom = last;
    clockDay = day;
    clockFresh = new Set(fresh);
    clockGone = gone;
    flyNote = inDays(n) + (more ? ` · ещё ${more}` : "");
    box.classList.remove("flying");
    drawClock();
    const chip = $(`#planClock .day-chip[data-day="${day}"]`);
    chip?.classList.add("landed");
    popTone(7, { vol: 0.09 });
    // Новые карточки не «уже были»: выпадают из чипа дня в список.
    [...box.querySelectorAll(".pl-card.fresh")].forEach((card, i) => dropIn(card, chip, 160 + i * 140));
    loadFar();
    hideClockLater(FLY_SHOWN);
  };
  flyNote = " "; // заголовок с местом под «через N дней»
  drawClock();
  setTimeout(() => {
    if (run !== flyRun) return;
    rail = mount();
    requestAnimationFrame((a) => frame(a, a));
  }, 420);
}
// Карточка вылетает из чипа дня: место в списке раскрывается, копия карточки летит по дуге из чипа, растёт с перелётом и встаёт
// на место, затем блик по карточке и искры у галочки.
function dropIn(card, chip, delay) {
  if (!card || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const h = card.offsetHeight;
  card.classList.add("arriving");
  card.animate([{ height: "0px", minHeight: "0px", paddingTop: "0px", paddingBottom: "0px", marginTop: "-3px" }, { height: `${h}px` }],
    { duration: 320, delay, easing: "cubic-bezier(.3, .8, .4, 1)", fill: "backwards" });
  setTimeout(() => {
    if (!card.isConnected) return;
    const to = card.getBoundingClientRect();
    const from = chip?.isConnected ? chip.getBoundingClientRect() : { left: to.left, top: to.top - 60, width: 30, height: 30 };
    const ghost = card.cloneNode(true);
    ghost.classList.remove("arriving", "fresh");
    ghost.classList.add("pl-ghost");
    ghost.style.setProperty("--c", getComputedStyle(card).getPropertyValue("--c"));
    Object.assign(ghost.style, { left: `${to.left}px`, top: `${to.top}px`, width: `${to.width}px`, height: `${to.height}px` });
    document.body.append(ghost);
    const dx = from.left + from.width / 2 - (to.left + to.width / 2);
    const dy = from.top + from.height / 2 - (to.top + to.height / 2);
    popTone(3, { vol: 0.05, soft: true });
    const fly = ghost.animate([
      { transform: `translate(${dx}px, ${dy}px) scale(.18) rotate(-8deg)`, opacity: 0, offset: 0 },
      { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - 26}px) scale(.62) rotate(-4deg)`, opacity: 1, offset: 0.4 },
      { transform: "translate(0, 3px) scale(1.05) rotate(1deg)", offset: 0.78 },
      { transform: "none", opacity: 1, offset: 1 },
    ], { duration: 620, easing: "cubic-bezier(.25, .7, .35, 1)" });
    fly.onfinish = () => {
      ghost.remove();
      if (!card.isConnected) return;
      card.classList.remove("arriving");
      card.classList.add("shine");
      popTone(9, { vol: 0.08 });
      const pip = card.querySelector(".pl-check");
      if (pip) burst(pip);
    };
  }, delay + 120);
}
$("#planClock").addEventListener("pointerdown", () => { if ($("#planClock").classList.contains("flying")) stopFly(); }, true);
$("#planClock").addEventListener("wheel", () => { if ($("#planClock").classList.contains("flying")) stopFly(); }, { capture: true, passive: true });

// Посмотреть планы — щелчок по строке «ближайший план»: ещё раз — спрятать.
// Щелчок по ближайшему плану или важной дате — панель планов на их день (ещё раз на тот же день — спрятать).
function togglePlansOn(day) {
  if (!$("#planClock").classList.contains("hidden") && clockDay === day) return hideClock();
  // Полоса дней — та неделя, где этот день.
  const n = data ? daysFrom(data.day, day) : 0;
  if (n < stripFrom || n > stripFrom + DAYS_AHEAD) stripFrom = Math.floor(n / (DAYS_AHEAD + 1)) * (DAYS_AHEAD + 1);
  showClock(day);
  loadFar();
}
$("#next").addEventListener("click", () => togglePlansOn($("#next").dataset.day || data?.day));
$("#pins").addEventListener("click", (ev) => {
  const pin = ev.target.closest(".pin");
  if (pin) togglePlansOn(pin.dataset.day || data?.day);
});
setInterval(() => { if (!$("#planClock").classList.contains("hidden")) drawClock(); }, 30_000);

// Перетащить карточку плана на день в полосе — перенести его туда (POST /api/events/:id {date}) или скопировать (…/copy, исходный остаётся).
// Нажал и сдвинул мышь дальше PLAN_DRAG_SLOP — карточка едет у курсора (правее и ниже, чтобы не закрывать полосу). Над днём под ним
// раскрывается плашка из двух половин: сверху «Перенести», снизу «Копия». Отпустил над самим днём — перенос; с зажатым Ctrl — копия.
const PLAN_DRAG_SLOP = 6;
let planDrag = null;
$("#planClock").addEventListener("pointerdown", (ev) => {
  const li = ev.target.closest(".pl-card[data-id]");
  if (ev.button !== 0 || !li || ev.target.closest("button") || li.matches(".gone, .cancelled, .leaving")) return;
  const e = [...plansOf(clockDay)].find((x) => x.id === Number(li.dataset.id));
  if (!e) return;
  planDrag = { e, li, x: ev.clientX, y: ev.clientY, ghost: null, pick: null, pickDay: null, day: null, mode: null };
  li.setPointerCapture(ev.pointerId); // мышь ушла за край карточки — события всё равно приходят сюда
});

// Плашка выбора под днём: две половины, ширина — по тексту, не выходит за края панели.
function dropPick(d, chip) {
  d.pick?.remove();
  const pick = document.createElement("div");
  pick.className = "drop-pick";
  pick.innerHTML = `<div data-mode="move">↪ Перенести</div><div data-mode="copy">⧉ Копия</div>`;
  document.body.appendChild(pick);
  const r = chip.getBoundingClientRect();
  const box = $("#planClock").getBoundingClientRect();
  const w = pick.offsetWidth;
  pick.style.left = `${Math.min(Math.max(r.left + r.width / 2 - w / 2, box.left + 6), box.right - w - 6)}px`;
  pick.style.top = `${r.bottom + 4}px`;
  d.pick = pick;
  d.pickDay = chip.dataset.day;
}
function planDragAt(d, x, y, ctrl) {
  const el = document.elementFromPoint(x, y);
  const chip = el?.closest("#planClock .day-chip");
  let day = null;
  let mode = null;
  if (chip && chip.dataset.day !== d.e.date_iso) {
    if (d.pickDay !== chip.dataset.day) dropPick(d, chip);
    day = chip.dataset.day;
    mode = "move";
  } else if (d.pick) {
    const half = el?.closest(".drop-pick [data-mode]");
    const r = d.pick.getBoundingClientRect();
    const c = document.querySelector(`#planClock .day-chip[data-day="${d.pickDay}"]`)?.getBoundingClientRect();
    // Промежуток между днём и плашкой — ещё над ней, иначе по пути вниз плашка бы закрывалась.
    const between = c && x >= Math.min(r.left, c.left) && x <= Math.max(r.right, c.right) && y >= c.bottom - 1 && y <= r.top + 1;
    if (half) {
      day = d.pickDay;
      mode = half.dataset.mode;
    } else if (between) {
      day = d.pickDay;
      mode = "move";
    }
  }
  if (!day && d.pick) {
    d.pick.remove();
    d.pick = null;
    d.pickDay = null;
  }
  if (day && ctrl) mode = "copy";
  d.day = day;
  d.mode = mode;
  for (const c of document.querySelectorAll("#planClock .day-chip")) c.classList.toggle("drop", c.dataset.day === day);
  for (const h of d.pick?.querySelectorAll("[data-mode]") ?? []) h.classList.toggle("on", h.dataset.mode === mode);
  d.ghost.classList.toggle("copy", mode === "copy");
  d.ghost.classList.toggle("move", mode === "move");
}
document.addEventListener("pointermove", (ev) => {
  if (!planDrag) return;
  const d = planDrag;
  if (!d.ghost) {
    if (Math.hypot(ev.clientX - d.x, ev.clientY - d.y) < PLAN_DRAG_SLOP) return;
    d.ghost = d.li.cloneNode(true);
    d.ghost.classList.add("pl-ghost");
    d.ghost.style.width = `${Math.min(d.li.offsetWidth, 200)}px`;
    d.ghost.style.setProperty("--c", d.li.dataset.c);
    document.body.appendChild(d.ghost);
    d.li.classList.add("pl-dragging");
    $("#planClock").classList.add("dragging-plan");
  }
  d.ghost.style.left = `${ev.clientX + 16}px`;
  d.ghost.style.top = `${ev.clientY + 18}px`;
  d.px = ev.clientX;
  d.py = ev.clientY;
  planDragAt(d, ev.clientX, ev.clientY, ev.ctrlKey);
});
// Ctrl нажали или отпустили, не двигая мышь, — режим меняется сразу.
for (const type of ["keydown", "keyup"]) {
  document.addEventListener(type, (e) => {
    if (planDrag?.ghost && e.key === "Control") planDragAt(planDrag, planDrag.px, planDrag.py, type === "keydown");
  });
}
function endPlanDrag(drop) {
  const d = planDrag;
  planDrag = null;
  if (!d?.ghost) return;
  d.ghost.remove();
  d.pick?.remove();
  d.li.classList.remove("pl-dragging");
  $("#planClock").classList.remove("dragging-plan");
  for (const c of document.querySelectorAll("#planClock .day-chip.drop")) c.classList.remove("drop");
  // Щелчок, который браузер пришлёт после отпускания, не должен открыть день или отметить план.
  const eat = (e) => {
    e.stopPropagation();
    e.preventDefault();
  };
  window.addEventListener("click", eat, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", eat, { capture: true }), 0);
  if (!drop || !d.day) return;
  if (d.mode === "copy") copyPlan(d.e, d.day);
  else movePlan(d.e, d.day, d.li);
}
document.addEventListener("pointerup", () => endPlanDrag(true));
document.addEventListener("pointercancel", () => endPlanDrag(false));
document.addEventListener("keydown", (e) => { if (e.key === "Escape") endPlanDrag(false); });

function planDragFailed(err, what) {
  const msg = String(err?.message ?? err);
  say(/нет такого адреса|404|нужно status/.test(msg) ? `Сервер ещё не умеет ${what} планы — его нужно обновить.` : `Не вышло: ${msg}`, { emotion: "worried", ms: 6000 });
}
async function copyPlan(e, day) {
  const where = humanDay(day);
  try {
    const r = await maid.api("POST", `/api/events/${e.id}/copy`, { date: day });
    if (r.duplicate) return say(`На ${where} «${e.title}» уже есть.`, { ms: 4000, mood: "think" });
    quietPlans.add(r.id); // остаёмся на дне, откуда тянули
    popTone(2);
    sayUnlessClash({ ...e, id: r.id }, day, `Скопировала «${e.title}» на ${where} ✓`);
    farPlans.clear();
    maid.changed();
  } catch (err) {
    planDragFailed(err, "копировать");
  }
}
// Перенос: карточка сразу улетает из этого дня, панель остаётся на нём.
async function movePlan(e, day, li) {
  li.style.height = `${li.offsetHeight}px`;
  li.classList.add("fly");
  try {
    await maid.api("POST", `/api/events/${e.id}`, { date: day });
    quietPlans.add(e.id);
    popTone(2);
    sayUnlessClash(e, day, `Перенесла «${e.title}» на ${humanDay(day)} ✓`);
    farPlans.clear();
    maid.changed();
  } catch (err) {
    li.classList.remove("fly");
    planDragFailed(err, "переносить");
  }
}

// Сдвиг плана по времени: потянуть время на карточке («в 19:00–20:30») вверх — раньше, вниз — позже, шагом RETIME_STEP минут
// на каждые RETIME_PX пикселей; длительность сохраняется, за полночь не уходит. Пока тянешь — новое время на карточке и «+15 мин» рядом;
// отпустил — сохраняется (POST /api/events/:id {time, end_time}), Esc — отмена. Карточка за пределы времени не тянется — за день тянут её саму.
const RETIME_STEP = 15;
const RETIME_PX = 9;
let retime = null;
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
function retimeShift(r, dy) {
  const steps = Math.round(dy / RETIME_PX);
  if (!steps) return r.start;
  // По сетке 15 минут: первый шаг — до ближайшей черты (19:10 → 19:15 или 19:00), дальше по 15.
  const off = r.start % RETIME_STEP;
  const first = steps > 0 ? r.start + (off ? RETIME_STEP - off : RETIME_STEP) : r.start - (off || RETIME_STEP);
  const start = first + (steps - Math.sign(steps)) * RETIME_STEP;
  const latest = Math.floor((1439 - r.len) / RETIME_STEP) * RETIME_STEP; // конец не позже 23:59
  return Math.max(0, Math.min(start, latest));
}
function retimeLabel(r, start) {
  const end = r.len ? start + r.len : null;
  return `в ${hhmm(start)}${end !== null ? `–${hhmm(Math.min(end, 1439))}` : ""}`;
}
$("#planClock").addEventListener("pointerdown", (ev) => {
  const when = ev.target.closest(".pl-when");
  const li = when?.closest(".pl-card[data-id]");
  if (ev.button !== 0 || !li || li.matches(".gone, .cancelled, .leaving, .done")) return;
  const e = plansOf(clockDay).find((x) => x.id === Number(li.dataset.id));
  const start = minutesOf(e?.time);
  if (start === null || start === undefined) return;
  const end = minutesOf(e.end_time);
  ev.stopImmediatePropagation(); // перенос на день (карточка целиком) не начинается
  ev.preventDefault();
  retime = { e, li, when, y: ev.clientY, start, len: end !== null && end > start ? end - start : 0, now: start, label: when.textContent };
  when.setPointerCapture(ev.pointerId);
}, { capture: true });
document.addEventListener("pointermove", (ev) => {
  if (!retime) return;
  const r = retime;
  const start = retimeShift(r, ev.clientY - r.y);
  if (!r.moved && Math.abs(ev.clientY - r.y) < 3) return;
  if (!r.moved) {
    r.moved = true;
    r.li.classList.add("retime");
    $("#planClock").classList.add("retiming");
    r.badge = document.createElement("span");
    r.badge.className = "pl-shift";
    r.li.appendChild(r.badge);
  }
  if (start === r.now) return;
  r.now = start;
  r.when.textContent = retimeLabel(r, start);
  const d = start - r.start;
  const abs = Math.abs(d);
  r.badge.textContent = d ? `${d > 0 ? "+" : "−"}${abs >= 60 ? `${Math.floor(abs / 60)} ч${abs % 60 ? ` ${abs % 60} мин` : ""}` : `${abs} мин`}` : "";
  r.badge.classList.toggle("later", d > 0);
  popTone(d > 0 ? 1 : -1, { vol: 0.08, soft: true });
});
function endRetime(save) {
  const r = retime;
  retime = null;
  if (!r) return;
  r.li.classList.remove("retime");
  $("#planClock").classList.remove("retiming");
  r.badge?.remove();
  if (r.moved) {
    // Щелчок после отпускания не должен отметить план.
    const eat = (e) => {
      e.stopPropagation();
      e.preventDefault();
    };
    window.addEventListener("click", eat, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", eat, { capture: true }), 0);
  }
  if (!save || r.now === r.start) {
    r.when.textContent = r.label;
    return;
  }
  retimePlan(r.e, r.now, r.len ? r.now + r.len : null, r);
}
document.addEventListener("pointerup", () => endRetime(true));
document.addEventListener("pointercancel", () => endRetime(false));
document.addEventListener("keydown", (e) => { if (e.key === "Escape") endRetime(false); });

async function retimePlan(e, start, end, r) {
  const body = { time: hhmm(start), end_time: end !== null ? hhmm(Math.min(end, 1439)) : null };
  try {
    await maid.api("POST", `/api/events/${e.id}`, body);
    popTone(2);
    sayUnlessClash({ ...e, ...body }, e.date_iso, `${e.time ? "Сдвинула" : "Поставила"} «${e.title}» на ${body.time}${body.end_time ? `–${body.end_time}` : ""} ✓`);
    farPlans.clear();
    maid.changed();
  } catch (err) {
    if (r) r.when.textContent = r.label;
    const msg = String(err?.message ?? err);
    say(/нет такого адреса|404|нужно status/.test(msg) ? "Сервер ещё не умеет сдвигать планы по времени — его нужно обновить." : `Не вышло: ${msg}`, { emotion: "worried", ms: 6000 });
  }
}

// Конфликты: план перенесли, скопировали или сдвинули на время, которое уже занято другим планом того дня, — горничная говорит,
// с чем пересекается, и предлагает ближайшее свободное окно той же длины (шаг 15 минут) одной кнопкой. План без конца занимает 30 минут.
const CLASH_DEFAULT = 30;
function spanOf(x) {
  const start = minutesOf(x.time);
  if (start === null || start === undefined) return null;
  const end = minutesOf(x.end_time);
  return { start, end: end !== null && end > start ? end : start + CLASH_DEFAULT };
}
function freeSlot(busy, start, len) {
  const span = len || CLASH_DEFAULT;
  const latest = Math.floor((1439 - span) / RETIME_STEP) * RETIME_STEP;
  const free = (s) => busy.every((b) => s + span <= b.start || b.end <= s);
  for (let d = RETIME_STEP; d <= 24 * 60; d += RETIME_STEP) {
    for (const s of [start + d, start - d]) {
      const at = Math.round(s / RETIME_STEP) * RETIME_STEP;
      if (at >= 0 && at <= latest && free(at)) return at;
    }
  }
  return null;
}
/** Сохранили план e (id, время) на день day: пересёкся — сказать и предложить окно; нет — сказать ok. */
async function sayUnlessClash(e, day, ok) {
  const me = spanOf(e);
  let others = [];
  if (me) {
    try {
      others = (await maid.api("GET", `/api/events?from=${day}&to=${day}`)).filter((x) => x.id !== e.id && x.status === "active" && spanOf(x));
    } catch {
      others = [];
    }
  }
  const hit = me && others.filter((x) => { const s = spanOf(x); return s.start < me.end && me.start < s.end; });
  if (!hit?.length) return say(ok, { ms: 5000, mood: "write", emotion: "happy" });
  const len = minutesOf(e.end_time) > me.start ? minutesOf(e.end_time) - me.start : 0;
  const slot = freeSlot(others.map(spanOf), me.start, len);
  const with_ = hit.map((x) => `«${x.title}» ${x.end_time ? `${x.time}–${x.end_time}` : `в ${x.time}`}`).join(" и ");
  const where = slot === null ? "" : `\nСвободно ${len ? `в ${hhmm(slot)}–${hhmm(slot + len)}` : `в ${hhmm(slot)}`} — сдвинуть туда?`;
  popTone(-2, { vol: 0.15, soft: true });
  say(`${ok.replace(/ ✓$/, "")}, но это время занято: ${with_}.${where}`, {
    ms: 0,
    emotion: "worried",
    mood: "think",
    buttons: slot === null ? [] : [
      { text: `⏩ На ${hhmm(slot)}`, run: () => retimePlan({ ...e, date_iso: day }, slot, len ? slot + len : null, null) },
      { text: "Оставить так", run: () => {} },
    ],
  });
}

// ПКМ по плану — меню: «🔁 Повторять…» (окно настройки) и быстрые действия (на завтра — перенести или копия, состоялось, убрать).
// Окно повтора: время, как часто (дни, дни недели, месяц), каждые N, дни недели, сколько раз (без конца, N раз, до даты),
// внизу — ближайшие даты. Сохранить — POST /api/events/:id/repeat: копии раскладывает сервер (без конца — на 8 недель вперёд
// и дальше сам). После — горничная показывает, на сколько и по каким дням создала, пупырками, как у курса.
let planMenu = null;
function closePlanMenu() {
  if (!planMenu) return;
  planMenu.remove();
  planMenu = null;
  clockHover = false;
  hideClockLater();
}
const WD_ORDER = [1, 2, 3, 4, 5, 6, 0];
const WD_SHORT = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const plural = (n, one, few, many) => (n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many);
const wdOf = (day) => new Date(`${day}T12:00:00Z`).getUTCDay();
const shortDay = (day) => {
  const [, m, d] = day.split("-").map(Number);
  return `${d} ${MONTHS[m - 1].slice(0, 3)}`;
};

// Настройка повтора — как на сервере (repeat.ts): старые строки и JSON.
function specOf(e) {
  const r = e?.repeat;
  if (!r) return null;
  const dow = wdOf(e.date_iso);
  const old = { daily: { kind: "day", every: 1 }, weekdays: { kind: "week", every: 1, days: [1, 2, 3, 4, 5] }, weekly: { kind: "week", every: 1, days: [dow] },
    biweekly: { kind: "week", every: 2, days: [dow] }, monthly: { kind: "month", every: 1 } };
  if (old[r]) return old[r];
  try {
    return JSON.parse(r);
  } catch {
    return null;
  }
}
function headOf(e) {
  if (e.repeat || !e.series) return e;
  return [...(data?.events ?? []), ...(data?.upcoming ?? []), ...[...farPlans.values()].flat()].find((x) => x.id === e.series) ?? null;
}
/** Даты после start по настройке, не дальше last (как seriesDates на сервере). */
function seriesDates(start, spec, last) {
  const out = [];
  const end = spec.until && spec.until < last ? spec.until : last;
  const room = spec.count ? spec.count - 1 : Infinity;
  if (spec.kind === "month") {
    const [y0, m0, d0] = start.split("-").map(Number);
    for (let i = spec.every; out.length < room; i += spec.every) {
      const y = y0 + Math.floor((m0 - 1 + i) / 12);
      const m = ((m0 - 1 + i) % 12) + 1;
      const dd = Math.min(d0, new Date(Date.UTC(y, m, 0)).getUTCDate());
      const day = `${y}-${String(m).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
      if (day > end) break;
      out.push(day);
    }
    return out;
  }
  if (spec.kind === "day") {
    for (let day = dayAfter(start, spec.every); day <= end && out.length < room; day = dayAfter(day, spec.every)) out.push(day);
    return out;
  }
  const days = new Set(spec.days?.length ? spec.days : [wdOf(start)]);
  const monday = dayAfter(start, -((wdOf(start) + 6) % 7));
  for (let day = dayAfter(start, 1); day <= end && out.length < room; day = dayAfter(day, 1)) {
    const week = Math.floor((Date.parse(day) - Date.parse(monday)) / (7 * 864e5));
    if (week % spec.every === 0 && days.has(wdOf(day))) out.push(day);
  }
  return out;
}
/** «по пн, ср, пт», «каждый день», «раз в 2 недели по вт» … */
function howOften(spec, day) {
  if (spec.kind === "day") return spec.every === 1 ? "каждый день" : `каждые ${spec.every} ${plural(spec.every, "день", "дня", "дней")}`;
  if (spec.kind === "month") return `${spec.every === 1 ? "каждый месяц" : `раз в ${spec.every} ${plural(spec.every, "месяц", "месяца", "месяцев")}`}, ${Number(day.slice(8))}-го`;
  const d = [...new Set(spec.days?.length ? spec.days : [wdOf(day)])];
  const set = d.sort((a, b) => WD_ORDER.indexOf(a) - WD_ORDER.indexOf(b)).join();
  const which = set === "1,2,3,4,5" ? "по будням" : set === "6,0" ? "по выходным" : d.length === 7 ? "каждый день" : `по ${d.map((x) => WD_SHORT[x]).join(", ")}`;
  return spec.every === 1 ? which : `${which}, раз в ${spec.every} ${plural(spec.every, "неделю", "недели", "недель")}`;
}
function howLong(spec) {
  return spec.count ? `${spec.count} ${plural(spec.count, "раз", "раза", "раз")}` : spec.until ? `до ${shortDay(spec.until)}` : "без конца";
}

function openPlanMenu(e, li, x, y) {
  closePlanMenu();
  const head = headOf(e);
  const spec = head && specOf(head);
  const item = (act, text) => `<button type="button" data-act="${act}">${text}</button>`;
  const menu = document.createElement("div");
  menu.className = "pl-menu";
  menu.innerHTML = item("repeat", spec ? `🔁 Повтор <span>${esc(howOften(spec, head.date_iso))}</span>` : "🔁 Повторять…")
    + `<hr>`
    + (e.status === "active" || !e.status ? item("time", e.time ? "🕒 Изменить время" : "🕒 Задать время") : "")
    + item("move", "↪ Перенести на завтра")
    + item("copy", "⧉ Копия на завтра")
    + (e.status === "active" || !e.status ? item("done", "✓ Состоялось") + item("cancelled", "× Убрать из планов") : "");
  showPlanMenu(menu, x, y);
  menu.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-act]");
    if (!b) return;
    const act = b.dataset.act;
    closePlanMenu();
    if (act === "repeat") return openRepeat(e);
    if (act === "time") return openTime(e, x, y);
    if (act === "move") return movePlan(e, dayAfter(e.date_iso, 1), li);
    if (act === "copy") return copyPlan(e, dayAfter(e.date_iso, 1));
    setPlanStatus(e.id, act);
  });
}
function showPlanMenu(menu, x, y) {
  document.body.appendChild(menu);
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  menu.style.left = `${Math.max(4, Math.min(x, innerWidth - w - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, innerHeight - h - 4))}px`;
  planMenu = menu;
  keepIn(menu);
  // Пока меню или окно открыто — панель планов не прячется.
  clockHover = true;
  menu.addEventListener("mouseenter", () => { clockHover = true; });
}

// --- окно времени плана (ПКМ → «Задать время») ---
function openTime(e, x, y) {
  const box = document.createElement("div");
  box.className = "pl-menu rp-box tm-box";
  box.innerHTML = `<div class="rp-top"><b>${e.time ? "Время плана" : "Задать время"}</b><span class="rp-name">${esc(e.title)}</span><button type="button" class="rp-x" data-x title="Закрыть">✕</button></div>
    <label class="rp-row"><span>Начало</span><input type="time" data-in="time" value="${esc(e.time ?? "")}"></label>
    <label class="rp-row tm-end"><span>Конец</span><span class="tm-endin"><input type="time" data-in="end" value="${esc(e.end_time ?? "")}"><button type="button" class="rp-x" data-noend title="Без конца">✕</button></span></label>
    <div class="tm-err"></div>
    <div class="tm-act"><button type="button" class="tm-more" data-addend>+ Время конца</button><button type="button" class="tm-save" data-save>Сохранить</button></div>`;
  showPlanMenu(box, x, y);
  const start = box.querySelector('[data-in="time"]');
  const end = box.querySelector('[data-in="end"]');
  const err = box.querySelector(".tm-err");
  // Конец — по желанию: строка появляется по «+ Время конца», ✕ убирает её снова.
  const endShown = (on) => {
    box.classList.toggle("has-end", on);
    if (!on) end.value = "";
    keepIn(box);
  };
  endShown(Boolean(e.end_time));
  setTimeout(() => start.focus(), 0);
  const fail = (text) => {
    err.textContent = text;
    keepIn(box);
  };
  const save = () => {
    if (!start.value) return fail("Укажите время начала");
    if (end.value && end.value <= start.value) return fail("Конец должен быть позже начала");
    closePlanMenu();
    const [h, m] = start.value.split(":").map(Number);
    const [eh, em] = end.value ? end.value.split(":").map(Number) : [];
    retimePlan(e, h * 60 + m, end.value ? eh * 60 + em : null, null);
  };
  box.addEventListener("click", (ev) => {
    if (ev.target.closest("[data-x]")) return closePlanMenu();
    if (ev.target.closest("[data-addend]")) {
      endShown(true);
      return end.focus();
    }
    if (ev.target.closest("[data-noend]")) return endShown(false);
    if (ev.target.closest("[data-save]")) save();
  });
  box.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") save();
    if (ev.key === "Escape") closePlanMenu();
  });
  box.addEventListener("input", () => (err.textContent = ""));
}

/** Окно выросло (новые строки) — не уходить за низ экрана. */
function keepIn(menu) {
  const r = menu.getBoundingClientRect();
  if (r.bottom > innerHeight - 4) menu.style.top = `${Math.max(4, innerHeight - r.height - 4)}px`;
}

// --- окно повтора ---
function openRepeat(e) {
  const head = headOf(e) ?? e;
  const was = specOf(head);
  const dow = wdOf(e.date_iso);
  const st = {
    kind: was?.kind ?? "week",
    every: was?.every ?? 1,
    days: new Set(was?.days?.length ? was.days : [dow]),
    end: was?.count ? "count" : was?.until ? "until" : "never",
    count: was?.count ?? 10,
    until: was?.until ?? dayAfter(e.date_iso, 30),
    time: e.time ?? "",
    endTime: e.end_time ?? "",
  };
  const box = document.createElement("div");
  box.className = "pl-menu rp-box";
  const spec = () => ({
    kind: st.kind,
    every: st.every,
    ...(st.kind === "week" ? { days: [...st.days] } : {}),
    count: st.end === "count" ? st.count : null,
    until: st.end === "until" ? st.until : null,
  });
  const seg = (name, val, text) => `<button type="button" data-${name}="${val}"${st[name] === val ? ` class="on"` : ""}>${text}</button>`;
  const unit = () => st.kind === "day" ? plural(st.every, "день", "дня", "дней") : st.kind === "week" ? plural(st.every, "неделю", "недели", "недель") : plural(st.every, "месяц", "месяца", "месяцев");
  const draw = () => {
    const sp = spec();
    const next = seriesDates(e.date_iso, sp, dayAfter(e.date_iso, 400));
    const shown = next.slice(0, 6).map((d) => `${WD_SHORT[wdOf(d)]} ${shortDay(d)}`).join(" · ");
    const total = sp.count || sp.until ? next.length + 1 : null;
    box.innerHTML = `
      <div class="rp-top"><b>🔁 Повтор</b><span class="rp-name">«${esc(e.title)}»</span><button type="button" class="rp-x" data-close title="Закрыть">✕</button></div>
      <label class="rp-row"><span>Время</span><span class="rp-time"><input type="time" data-in="time" value="${esc(st.time)}"> – <input type="time" data-in="endTime" value="${esc(st.endTime)}"></span></label>
      <div class="rp-row"><span>Как часто</span><span class="rp-seg">${seg("kind", "day", "Дни")}${seg("kind", "week", "Неделя")}${seg("kind", "month", "Месяц")}</span></div>
      <div class="rp-row"><span>Каждые</span><span class="rp-step"><button type="button" data-every="-1">−</button><b>${st.every}</b><button type="button" data-every="1">+</button> ${unit()}</span></div>
      ${st.kind === "week" ? `<div class="rp-row"><span>Дни</span><span class="rp-days">${WD_ORDER.map((d) => `<button type="button" data-day="${d}"${st.days.has(d) ? ` class="on"` : ""}>${WD_SHORT[d]}</button>`).join("")}</span></div>
        <div class="rp-row rp-quick"><span></span><span><button type="button" data-preset="work">будни</button><button type="button" data-preset="weekend">выходные</button><button type="button" data-preset="all">все</button></span></div>` : ""}
      <div class="rp-row"><span>Сколько</span><span class="rp-seg">${seg("end", "never", "Без конца")}${seg("end", "count", "Раз")}${seg("end", "until", "До даты")}</span></div>
      ${st.end === "count" ? `<div class="rp-row"><span></span><span class="rp-step"><button type="button" data-count="-1">−</button><b>${st.count}</b><button type="button" data-count="1">+</button> ${plural(st.count, "раз", "раза", "раз")} вместе с этим</span></div>` : ""}
      ${st.end === "until" ? `<div class="rp-row"><span></span><span><input type="date" data-in="until" min="${dayAfter(e.date_iso, 1)}" value="${esc(st.until)}"></span></div>` : ""}
      <div class="rp-sum"><b>${esc(howOften(sp, e.date_iso))}${st.time ? ` в ${esc(st.time)}` : ""}</b> · ${esc(total ? `${total} ${plural(total, "раз", "раза", "раз")}` : "без конца")}
        <div>${next.length ? `Дальше: ${esc(shown)}${next.length > 6 ? " …" : ""}` : "Повторов не будет — поменяйте дни или срок."}</div></div>
      <div class="rp-btns">${was ? `<button type="button" class="ghost" data-stop>Не повторять</button>` : ""}<span></span>
        <button type="button" class="ghost" data-close>Отмена</button><button type="button" class="rp-ok" data-save${next.length ? "" : " disabled"}>Повторять</button></div>`;
  };
  draw();
  const r = $("#planClock").getBoundingClientRect();
  showPlanMenu(box, r.left + Math.max(0, (r.width - 300) / 2), r.top + 40);
  box.addEventListener("input", (ev) => {
    const k = ev.target.dataset.in;
    if (!k) return;
    st[k] = ev.target.value;
    if (k === "until" && st.until) draw();
  });
  box.addEventListener("change", (ev) => { if (ev.target.dataset.in) { draw(); keepIn(box); } });
  box.addEventListener("click", async (ev) => {
    const b = ev.target.closest("button");
    if (!b) return;
    const d = b.dataset;
    if ("close" in d) return closePlanMenu();
    if (d.kind) st.kind = d.kind;
    if (d.end) st.end = d.end;
    if (d.every) st.every = Math.max(1, Math.min(12, st.every + Number(d.every)));
    if (d.count) st.count = Math.max(2, Math.min(100, st.count + Number(d.count)));
    if (d.day) {
      const n = Number(d.day);
      if (st.days.has(n) && st.days.size > 1) st.days.delete(n);
      else st.days.add(n);
    }
    if (d.preset) st.days = new Set(d.preset === "work" ? [1, 2, 3, 4, 5] : d.preset === "weekend" ? [6, 0] : WD_ORDER);
    if ("stop" in d) {
      closePlanMenu();
      return repeatPlan(e, null);
    }
    if ("save" in d) {
      if (st.time && st.endTime && st.endTime <= st.time) return say("Конец раньше начала — поправьте время.", { ms: 4000, emotion: "worried" });
      closePlanMenu();
      return repeatPlan(e, spec(), st.time && st.time !== e.time || (st.time && (st.endTime || null) !== (e.end_time || null)) ? st : null);
    }
    popTone(1, { vol: 0.06, soft: true });
    draw();
    keepIn(box);
  });
}
async function repeatPlan(e, sp, time) {
  try {
    if (time) await maid.api("POST", `/api/events/${e.id}`, { time: time.time, end_time: time.endTime || null });
    const at = time?.time ?? e.time;
    const r = await maid.api("POST", `/api/events/${e.id}/repeat`, { repeat: sp });
    farPlans.clear();
    maid.changed();
    if (!sp) {
      popTone(-1, { soft: true });
      return say(`«${e.title}» больше не повторяется${r.removed ? ` — убрала ${r.removed} ${plural(r.removed, "будущий", "будущих", "будущих")}` : ""}.`, { ms: 5000, mood: "write" });
    }
    showSeriesMade(e, sp, at, r);
  } catch (err) {
    const msg = String(err?.message ?? err);
    say(/нет такого адреса|404|repeat/.test(msg) ? "Сервер ещё не умеет так повторять планы — его нужно обновить." : `Не вышло: ${msg}`, { emotion: "worried", ms: 6000 });
  }
}
// Плашка «на сколько и по каким дням»: пупырка на каждое занятие (первое — этот план), по одной с «чпоком».
function showSeriesMade(e, sp, at, r) {
  const all = [e.date_iso, ...r.dates];
  const total = all.length;
  const limit = 24;
  const tail = r.endless ? "дальше — сама, без конца" : `${shortDay(all[0])} — ${shortDay(all.at(-1))}`;
  say(`Готово! «${e.title}» — ${howOften(sp, e.date_iso)}${at ? ` в ${at}` : ""} 🔁`, { ms: 10000, mood: "write", emotion: "happy" });
  $("#bubbleCards").innerHTML = `<div class="course rp-made${total > 14 ? " dense" : ""}">
    <div class="c-head"><span class="c-ico">📅</span><span class="c-title">${r.endless ? `${total} ${plural(total, "занятие", "занятия", "занятий")} на 8 недель` : `${total} ${plural(total, "раз", "раза", "раз")}`}</span>
      <span class="c-score">${r.endless ? "∞" : `<b>0</b> / ${total}`}</span></div>
    <div class="pips">${all.slice(0, limit).map((d, i) => `<i class="pip ${i ? "wait" : "today"} rise" title="${esc(`${WD_SHORT[wdOf(d)]}, ${shortDay(d)}`)}"></i>`).join("")}${total > limit ? `<i class="rp-more">+${total - limit}</i>` : ""}</div>
    <div class="rp-span">${esc(tail)}</div></div>`;
  $("#bubbleCards").querySelectorAll(".pip").forEach((p, i) => {
    p.style.animationDelay = `${120 + i * 55}ms`;
    if (i < 14) setTimeout(() => popTone(i, { vol: 0.14, soft: true }), 120 + i * 55);
  });
}

$("#planClock").addEventListener("contextmenu", (ev) => {
  const li = ev.target.closest(".pl-card[data-id]");
  if (!li || li.matches(".gone, .leaving")) return;
  const e = plansOf(clockDay).find((x) => x.id === Number(li.dataset.id));
  if (!e) return;
  ev.preventDefault();
  openPlanMenu(e, li, ev.clientX, ev.clientY);
});
// Нажали на кнопку календаря, пока он открыт, — он закрывается здесь, а щелчок следом не должен открыть его снова.
let calShut = false;
document.addEventListener("pointerdown", (ev) => {
  calShut = !!planMenu?.classList.contains("pc-cal") && !!ev.target.closest("[data-cal]");
  if (!planMenu || ev.target.closest(".pl-menu")) return;
  closePlanMenu();
}, true);
document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") closePlanMenu(); });
