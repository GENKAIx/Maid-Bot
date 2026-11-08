// Часы планов — круглый циферблат слева от панели: в центре горничная, вокруг — планы дня дугами от начала до конца.
// Сами не висят: выезжают, когда планы меняются (добавили, перенесли, удалили — здесь, в Telegram или с телефона)
// или когда их смотрят (щелчок по строке «ближайший план»), и прячутся через несколько секунд, если мышь не над ними.
// Вид — настройка виджета «Часы планов»: 24 часа (по умолчанию), 12 часов (текущая половина суток) или выключены.

const CLOCK_SIZE = 280;
const CX = CLOCK_SIZE / 2;
const DISC_R = 90; // циферблат
const LANES = [{ r: 106, w: 20 }, { r: 127, w: 15 }]; // дуги планов; перекрывающиеся — во второй ряд, снаружи
const CLOCK_SHOWN = 12_000;
const NO_END_MIN = 60; // план без времени конца — дуга на час
const ARC_COLORS = ["#ffd76a", "#8fe3c8", "#c9b6ff", "#ffb39a", "#9fd3ff"];

let clockDay = null; // какой день показан (YYYY-MM-DD)
let clockHalf = null; // для 12-часовых: 0 — до полудня, 1 — после
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

// Планы с временем → дуги: начало, конец, ряд (перекрывающиеся уходят во второй ряд).
function layout(list, mode, half) {
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
  const shown = mode === "12" ? timed.filter((x) => x.end > half * 720 && x.s < (half + 1) * 720) : timed;
  const laneEnd = [-1, -1];
  for (const x of shown) {
    x.lane = laneEnd[0] <= x.s ? 0 : laneEnd[1] <= x.s ? 1 : 0;
    laneEnd[x.lane] = x.end;
    if (mode === "12") {
      x.s = Math.max(x.s, half * 720);
      x.end = Math.min(x.end, (half + 1) * 720 - 1);
    }
  }
  return shown;
}

function arcSvg(x, mode, nowMin, { gone = false } = {}) {
  const lane = LANES[x.lane];
  const a0 = angleOf(x.s, mode);
  let a1 = angleOf(x.end, mode);
  if (a1 <= a0) a1 = a0 + 360 * ((x.end - x.s) / (mode === "12" ? 720 : 1440));
  // Скругления торцов добавляют по полтолщины с каждой стороны — дугу укорачиваем на них, иначе соседние слипаются.
  const cap = ((lane.w / 2) / lane.r) * (180 / Math.PI);
  const pad = Math.min(cap, (a1 - a0) / 2 - 0.5);
  const b0 = a0 + pad;
  const b1 = Math.max(b0 + 0.5, a1 - pad);
  const mid = (b0 + b1) / 2;
  const lower = mid > 90 && mid < 270; // нижняя половина: подпись по обратной дуге
  const id = `arc${x.e.id}${gone ? "g" : ""}`;
  const len = (lane.r * (b1 - b0 + 2 * cap) * Math.PI) / 180;
  const fit = Math.floor(len / (lane.w > 16 ? 6.3 : 5.4));
  // На дуге — только название, которое влезает целиком; остальные видны в списке под часами.
  const label = x.e.title.length <= fit ? x.e.title : "";
  const past = !gone && x.end <= nowMin && clockDay === data?.day;
  const now = !gone && x.s <= nowMin && nowMin < x.end && clockDay === data?.day;
  const cls = ["plan-arc", past && "past", now && "now", clockFresh.has(x.e.id) && "fresh", gone && "gone"].filter(Boolean).join(" ");
  const when = `${x.e.time}${x.e.end_time ? `–${x.e.end_time}` : ""}`;
  return `<g class="${cls}" color="${colorOf(x.e)}">
    <title>${esc(when)} · ${esc(x.e.title)}</title>
    <path class="band" d="${arcPath(lane.r, b0, b1)}" stroke-width="${lane.w}" />
    <path id="${id}" d="${arcPath(lane.r, b0 - cap, b1 + cap, lower)}" fill="none" stroke="none" />
    ${label ? `<text class="arc-label${lane.w > 16 ? "" : " small"}" dy="${lower ? 4 : 3.6}"><textPath href="#${id}" startOffset="50%" text-anchor="middle">${esc(label)}</textPath></text>` : ""}
  </g>`;
}

function drawClock() {
  const box = $("#planClock");
  if (!box || !data || !clockDay) return;
  const mode = cfg.clock === "12" ? "12" : "24";
  const d = new Date();
  const nowMin = d.getHours() * 60 + d.getMinutes();
  if (clockHalf === null) clockHalf = nowMin >= 720 ? 1 : 0;
  const list = plansOf(clockDay);
  const arcs = layout(list, mode, clockHalf);
  const gone = layout(clockGone, mode, clockHalf);
  const untimed = list.filter((e) => minutesOf(e.time) === null);
  const hidden = mode === "12" ? layout(list, "24", 0).length - arcs.length : 0;

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
  const showHand = clockDay === data.day && (mode === "24" || Math.floor(nowMin / 720) === clockHalf);
  const [hx, hy] = polar(DISC_R - 4, handA);
  const [hx0, hy0] = polar(60, handA);

  const dayName = clockDay === data.day ? "Сегодня" : humanDay(clockDay);
  const half = mode === "12" ? `<button type="button" class="half" title="Показать другую половину суток">${clockHalf ? "после полудня" : "до полудня"} ⇄</button>` : "";
  // Список под часами: время и название, цвет — как у дуги; прошедшие бледнее, идущий сейчас — ярче.
  const today = clockDay === data.day;
  const item = (e, cls) => ({ at: minutesOf(e.time) ?? 1441, keep: cls.includes("fresh") || cls.includes("gone"),
    html: `<li class="${cls}"><i class="dot${minutesOf(e.time) === null ? " none" : ""}" data-c="${colorOf(e)}"></i><span class="t">${esc(e.time ?? "—")}</span>${esc(e.title)}</li>` });
  const rows = [
    ...layout(list, "24", 0).map((x) => item(x.e, [
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
  const extra = hidden > 0 ? [`${hidden} — в другой половине суток`] : [];

  box.innerHTML = `
    <div class="pc-head"><b>${esc(dayName)}</b><span>${list.length ? `${list.length} ${planWord(list.length)}` : "планов нет"}</span>${half}</div>
    <svg viewBox="0 0 ${CLOCK_SIZE} ${CLOCK_SIZE}" width="${CLOCK_SIZE}" height="${CLOCK_SIZE}" aria-label="Планы на ${esc(dayName)}">
      <circle class="orbit" cx="${CX}" cy="${CX}" r="${LANES[0].r}" />
      <circle class="orbit dots" cx="${CX}" cy="${CX}" r="${LANES[1].r + 9}" />
      <circle class="disc" cx="${CX}" cy="${CX}" r="${DISC_R}" />
      ${night}
      ${marks.join("")}
      ${gone.map((x) => arcSvg(x, mode, nowMin, { gone: true })).join("")}
      ${arcs.map((x) => arcSvg(x, mode, nowMin)).join("")}
      <clipPath id="pcFace"><circle cx="${CX}" cy="${CX}" r="56" /></clipPath>
      <circle class="face-bg" cx="${CX}" cy="${CX}" r="57" />
      <image class="pc-maid" href="${$("#face").getAttribute("src")}" x="${CX - 66}" y="${CX - 52}" width="132" height="141" clip-path="url(#pcFace)" />
      ${showHand ? `<line class="hand" x1="${hx0.toFixed(1)}" y1="${hy0.toFixed(1)}" x2="${hx.toFixed(1)}" y2="${hy.toFixed(1)}" /><circle class="hand-dot" cx="${hx.toFixed(1)}" cy="${hy.toFixed(1)}" r="3.4" />` : ""}
    </svg>
    ${extra.length ? `<div class="pc-foot">${extra.join(" · ")}</div>` : ""}
    ${legend}`;
  // Цвет меток — через CSSOM: строгая политика окна не пускает атрибуты style в разметке.
  for (const d of box.querySelectorAll(".dot[data-c]:not(.none)")) d.style.background = d.dataset.c;
}
const planWord = (n) => (n % 10 === 1 && n % 100 !== 11 ? "план" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? "плана" : "планов");

function showClock(day, { fresh = [], gone = [], half = null } = {}) {
  if (cfg.clock === "off" || collapsed || prefsOpen || !data) return;
  const box = $("#planClock");
  clockDay = day;
  clockFresh = new Set(fresh);
  clockGone = gone;
  clockHalf = half;
  // 12 часов: показать ту половину, где поменялся план.
  if (cfg.clock === "12" && half === null) {
    const changed = [...plansOf(day), ...gone].find((e) => clockFresh.has(e.id) || gone.includes(e));
    const m = minutesOf(changed?.time);
    if (m !== null) clockHalf = m >= 720 ? 1 : 0;
  }
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
  if (e.target.closest(".half")) {
    clockHalf = clockHalf ? 0 : 1;
    clockFresh = new Set();
    drawClock();
    return;
  }
  if (!e.target.closest(".plan-arc")) hideClock();
});
// Посмотреть планы — щелчок по строке «ближайший план»: ещё раз — спрятать.
$("#next").addEventListener("click", () => {
  if (!$("#planClock").classList.contains("hidden")) return hideClock();
  showClock(data?.day);
});
setInterval(() => { if (!$("#planClock").classList.contains("hidden")) drawClock(); }, 30_000);
