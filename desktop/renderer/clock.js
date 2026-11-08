// Часы планов — круглый циферблат слева от панели: планы дня цветными дугами от начала до конца, названия — в списке под часами.
// Сами не висят: выезжают, когда планы меняются (добавили, перенесли, удалили — здесь, в Telegram или с телефона)
// или когда их смотрят (щелчок по строке «ближайший план»), и прячутся через несколько секунд, если мышь не над ними.
// Вид — настройка виджета «Часы планов»: 12 часов (по умолчанию: до полудня — синее внутреннее кольцо, после — оранжевое
// внешнее, поверх), 24 часа или выключены.

const CLOCK_SIZE = 280;
const CX = CLOCK_SIZE / 2;
const DISC_R = 90; // циферблат
// Ряды дуг. 24 часа: перекрывающиеся планы уходят во второй ряд, снаружи. 12 часов: внутренний — до полудня, внешний — после.
const LANES = { "24": [{ r: 106, w: 20 }, { r: 127, w: 15 }], "12": [{ r: 106, w: 17 }, { r: 126, w: 17 }] };
const HALF_COLORS = ["#6fb6ff", "#ffa25c"]; // до полудня, после
const CLOCK_SHOWN = 12_000;
const NO_END_MIN = 60; // план без времени конца — дуга на час
const ARC_COLORS = ["#ffd76a", "#8fe3c8", "#c9b6ff", "#ffb39a", "#9fd3ff"];

let clockDay = null; // какой день показан (YYYY-MM-DD)
let clockHideTimer = 0;
let clockHover = false;
let clockFresh = new Set(); // id планов, которые только что добавили или поменяли, — подсвечиваются
let clockGone = []; // только что удалённые — тают на своих местах
let lastPlans = null; // id → JSON плана, чтобы заметить изменения

const minutesOf = (t) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(t ?? "");
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
function colorOf(e) {
  if (cfg.clock !== "24") return HALF_COLORS[(minutesOf(e.time) ?? 0) >= 720 ? 1 : 0];
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

function plansOf(day) {
  if (!data) return [];
  return [...(data.events ?? []), ...(data.upcoming ?? [])].filter((e) => e.date_iso === day);
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
  const color = mode === "12" ? HALF_COLORS[x.lane] : colorOf(x.e);
  return `<g class="${cls}" color="${color}">
    <title>${esc(when)} · ${esc(x.e.title)}</title>
    <path class="edge" d="${arcPath(lane.r, b0, b1)}" stroke-width="${lane.w + 3}" />
    <path class="band" d="${arcPath(lane.r, b0, b1)}" stroke-width="${lane.w}" />
  </g>`;
}

function drawClock() {
  const box = $("#planClock");
  if (!box || !data || !clockDay) return;
  const mode = cfg.clock === "12" ? "12" : "24";
  const d = new Date();
  const nowMin = d.getHours() * 60 + d.getMinutes();
  const list = plansOf(clockDay);
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
  const [hx, hy] = polar(DISC_R - 4, handA);
  const [hx0, hy0] = polar(7, handA);

  const dayName = clockDay === data.day ? "Сегодня" : humanDay(clockDay);
  const key = mode === "12" ? `<span class="pc-key"><i data-c="${HALF_COLORS[0]}"></i>до 12<i data-c="${HALF_COLORS[1]}"></i>после</span>` : "";
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

  box.innerHTML = `
    <div class="pc-head"><b>${esc(dayName)}</b><span>${list.length ? `${list.length} ${planWord(list.length)}` : "планов нет"}</span>${key}</div>
    <svg viewBox="0 0 ${CLOCK_SIZE} ${CLOCK_SIZE}" width="${CLOCK_SIZE}" height="${CLOCK_SIZE}" aria-label="Планы на ${esc(dayName)}">
      <circle class="orbit" cx="${CX}" cy="${CX}" r="${LANES[mode][0].r}" />
      ${mode === "12" ? `<circle class="orbit" cx="${CX}" cy="${CX}" r="${LANES[mode][1].r}" />` : ""}
      <circle class="orbit dots" cx="${CX}" cy="${CX}" r="${LANES[mode][1].r + 10}" />
      <circle class="disc" cx="${CX}" cy="${CX}" r="${DISC_R}" />
      ${night}
      ${marks.join("")}
      ${gone.map((x) => arcSvg(x, mode, nowMin, { gone: true })).join("")}
      ${arcs.map((x) => arcSvg(x, mode, nowMin)).join("")}
      ${showHand ? `<line class="hand" x1="${hx0.toFixed(1)}" y1="${hy0.toFixed(1)}" x2="${hx.toFixed(1)}" y2="${hy.toFixed(1)}" /><circle class="hand-dot" cx="${hx.toFixed(1)}" cy="${hy.toFixed(1)}" r="3.4" />` : ""}
      <circle class="hub" cx="${CX}" cy="${CX}" r="4" />
    </svg>
    ${legend}`;
  // Цвет меток — через CSSOM: строгая политика окна не пускает атрибуты style в разметке.
  for (const d of box.querySelectorAll(".dot[data-c]:not(.none), .pc-key i")) d.style.background = d.dataset.c;
}
const planWord = (n) => (n % 10 === 1 && n % 100 !== 11 ? "план" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? "плана" : "планов");

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
  clockFresh = new Set();
  clockGone = [];
}
function hideClockLater() {
  clearTimeout(clockHideTimer);
  clockHideTimer = setTimeout(() => (clockHover ? hideClockLater() : hideClock()), CLOCK_SHOWN);
}

// После каждой загрузки данных: что из планов появилось, поменялось или пропало (неважно, где — здесь, в Telegram, с телефона).
function watchPlans() {
  if (!data) return;
  const all = [...(data.events ?? []), ...(data.upcoming ?? [])];
  const now = new Map(all.map((e) => [e.id, JSON.stringify(e)]));
  const prev = lastPlans;
  lastPlans = now;
  if (!prev) return;
  const fresh = all.filter((e) => prev.get(e.id) !== now.get(e.id));
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
$("#planClock").addEventListener("click", (e) => {
  if (!e.target.closest(".plan-arc")) hideClock();
});
// Посмотреть планы — щелчок по строке «ближайший план»: ещё раз — спрятать.
$("#next").addEventListener("click", () => {
  if (!$("#planClock").classList.contains("hidden")) return hideClock();
  showClock(data?.day);
});
setInterval(() => { if (!$("#planClock").classList.contains("hidden")) drawClock(); }, 30_000);
