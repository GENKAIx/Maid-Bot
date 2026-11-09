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
function dayStrip() {
  return Array.from({ length: DAYS_AHEAD + 1 }, (_, i) => {
    const day = dayAfter(data.day, stripFrom + i);
    const d = new Date(`${day}T12:00:00Z`);
    const wd = d.toLocaleDateString("ru-RU", { weekday: "short", timeZone: "UTC" });
    const n = plansOf(day).length;
    // Точка — в этот день важная дата (сама дата, не напоминание о ней заранее).
    const big = (data.dates ?? []).filter((x) => x.on === day);
    return `<button type="button" class="day-chip${day === clockDay ? " on" : ""}${n ? "" : " empty"}${big.length ? " has-date" : ""}" data-day="${day}" title="${esc(humanDay(day))}${n ? ` · ${n} ${planWord(n)}` : " · планов нет"}${big.map((x) => ` · ${esc(x.title)}`).join("")}">
      <b>${d.getUTCDate()}</b> ${esc(wd)}<span class="cnt">${n ? `(${n})` : "–"}</span></button>`;
  }).join("");
}

function plansOf(day) {
  if (!data) return [];
  if (farPlans.has(day)) return farPlans.get(day);
  return [...(data.events ?? []), ...(data.upcoming ?? [])].filter((e) => e.date_iso === day);
}
// Дальние дни полосы — отдельным запросом, один раз на неделю полосы.
async function loadFar() {
  const last = stripFrom + DAYS_AHEAD;
  const to = dayAfter(data.day, last);
  if (last <= NEAR_DAYS || farPlans.has(to)) return;
  const from = dayAfter(data.day, Math.max(stripFrom, NEAR_DAYS + 1));
  try {
    const rows = await maid.api("GET", `/api/events?from=${from}&to=${to}`);
    for (let d = from; d <= to; d = dayAfter(d, 1)) farPlans.set(d, rows.filter((e) => e.date_iso === d));
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
    <div class="pc-head"><b>${esc(dayName)}</b><span>${list.length ? `${list.length} ${planWord(list.length)}` : "планов нет"}</span></div>
    <div class="pc-days">${dayStrip()}</div>
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
  const dayName = today ? "Сегодня" : humanDay(clockDay);
  const card = (e) => {
    const st = e._st ?? "";
    const start = minutesOf(e.time);
    let end = minutesOf(e.end_time);
    if (start !== null && (end === null || end <= start)) end = start + NO_END_MIN;
    const past = today && !st && end !== null && end <= nowMin;
    const now = today && !st && start !== null && start <= nowMin && nowMin < end;
    const when = e.time ? `в ${esc(e.time)}${e.end_time ? `–${esc(e.end_time)}` : ""}` : "без времени";
    const tools = st === "gone" ? "" : `${st ? "" : `<button type="button" class="pl-x" data-act="cancelled" title="Убрать из планов">×</button>`}
      <button type="button" class="pl-check${st === "done" ? " on" : st === "cancelled" ? " on off" : ""}" data-act="${st ? "active" : "done"}" title="${st ? "Отменить — вернуть в планы" : "Состоялось"}">${st === "done" ? "<i>✓</i><b>×</b>" : st === "cancelled" ? "<i>×</i><b>↺</b>" : ""}</button>`;
    return `<li class="pl-card${st ? ` ${st}` : ""}${past ? " past" : ""}${now ? " now" : ""}${clockFresh.has(e.id) ? " fresh" : ""}${leaving(e.id)}" data-id="${e.id}" data-c="${colorOf(e)}">
      <span class="pl-text"><b class="pl-when">${when}</b> · ${esc(e.title)}</span>${tools}</li>`;
  };
  box.innerHTML = `
    <div class="pc-head"><b>${esc(dayName)}</b><span>${open ? `${open} ${planWord(open)}` : "планов нет"}</span></div>
    <div class="pc-strip">
      <button type="button" class="pc-arrow" data-shift="-1" title="Неделя назад"${stripFrom <= 0 ? " disabled" : ""}>‹</button>
      <div class="pc-days">${dayStrip()}</div>
      <button type="button" class="pc-arrow" data-shift="1" title="Неделя вперёд">›</button>
    </div>
    <div class="pl-top"><span>Планы на день</span></div>
    ${list.length || pins.length ? `<ul class="pl-list">${pins.map(pinCard).join("")}${list.map(card).join("")}</ul>` : `<p class="pl-empty">Свободный день.</p>`}`;
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
}
function hideClockLater() {
  clearTimeout(clockHideTimer);
  clockHideTimer = setTimeout(() => (clockHover ? hideClockLater() : hideClock()), CLOCK_SHOWN);
}

// После каждой загрузки данных: что из планов появилось, поменялось или пропало (неважно, где — здесь, в Telegram, с телефона).
const quietPlans = new Set(); // id планов, которые появились от своего действия здесь (копия перетаскиванием) — не переключать на их день
function watchPlans() {
  if (!data) return;
  const all = [...(data.events ?? []), ...(data.upcoming ?? [])];
  const now = new Map(all.map((e) => [e.id, JSON.stringify(e)]));
  const prev = lastPlans;
  lastPlans = now;
  if (!prev) return;
  const fresh = all.filter((e) => prev.get(e.id) !== now.get(e.id) && !quietPlans.delete(e.id));
  const gone = [...prev].filter(([id]) => !now.has(id)).map(([, j]) => JSON.parse(j)).filter((e) => e.date_iso >= data.day);
  if (!fresh.length && !gone.length) {
    if (!$("#planClock").classList.contains("hidden")) drawClock(); // стрелка и прошедшие планы
    return;
  }
  const day = (fresh[0] ?? gone[0]).date_iso;
  showClock(day, { fresh: fresh.map((e) => e.id), gone: gone.filter((e) => e.date_iso === day) });
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
    stripFrom = Math.max(0, stripFrom + Number(arrow.dataset.shift) * (DAYS_AHEAD + 1));
    clockDay = dayAfter(data.day, stripFrom);
    clockFresh = new Set();
    clockGone = [];
    drawClock();
    loadFar();
    return hideClockLater();
  }
  const chip = e.target.closest(".day-chip");
  if (chip) {
    clockDay = chip.dataset.day;
    clockFresh = new Set();
    clockGone = [];
    drawClock();
    return hideClockLater();
  }
  if (!e.target.closest(".plan-arc, .pl-list, .pl-top, .pl-empty, .pc-strip")) hideClock();
});
// Посмотреть планы — щелчок по строке «ближайший план»: ещё раз — спрятать.
// Щелчок по ближайшему плану или важной дате — панель планов на их день (ещё раз на тот же день — спрятать).
function togglePlansOn(day) {
  if (!$("#planClock").classList.contains("hidden") && clockDay === day) return hideClock();
  // Полоса дней — та неделя, где этот день.
  const n = data ? daysFrom(data.day, day) : 0;
  if (n < stripFrom || n > stripFrom + DAYS_AHEAD) stripFrom = Math.max(0, Math.floor(n / (DAYS_AHEAD + 1)) * (DAYS_AHEAD + 1));
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
    say(`Скопировала «${e.title}» на ${where} ✓`, { ms: 5000, mood: "write", emotion: "happy" });
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
    say(`Перенесла «${e.title}» на ${humanDay(day)} ✓`, { ms: 5000, mood: "write", emotion: "happy" });
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
    say(`Сдвинула «${e.title}» на ${body.time}${body.end_time ? `–${body.end_time}` : ""} ✓`, { ms: 4000, mood: "write", emotion: "happy" });
    farPlans.clear();
    maid.changed();
  } catch (err) {
    r.when.textContent = r.label;
    const msg = String(err?.message ?? err);
    say(/нет такого адреса|404|нужно status/.test(msg) ? "Сервер ещё не умеет сдвигать планы по времени — его нужно обновить." : `Не вышло: ${msg}`, { emotion: "worried", ms: 6000 });
  }
}
