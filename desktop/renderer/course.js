// Курсы («пить Аевит каждый день месяц») — плашка над горничной: дни срока пупырками, как у поп-ита.
// Отмеченный день — вдавленная пупырка с галочкой, прошедший без отметки — крестик (сервер решает сам), сегодня — пульсирует.
// Плашка только показывает: отмечают в списке «Задачи» (или в облачке, в Telegram). Звук и анимация — у того, что поменялось.

// --- звук поп-ита: синтез WebAudio, без файлов ---
let actx = null;
function popTone(step = 0, { vol = 0.32, soft = false } = {}) {
  if (localStorage.getItem("maid.mute")) return;
  try {
    actx ??= new AudioContext();
    const t = actx.currentTime + 0.005;
    const f = 520 * Math.pow(2, step / 12); // каждая следующая пупырка — на полтона выше
    const out = actx.createGain();
    out.connect(actx.destination);
    // Тело: короткий синус, тон падает — «чпок».
    const o = actx.createOscillator();
    const g = actx.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(f * (soft ? 1.25 : 1.9), t);
    o.frequency.exponentialRampToValueAtTime(f, t + 0.05);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (soft ? 0.09 : 0.14));
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + 0.16);
    // Щелчок силикона: 8 мс шума через полосовой фильтр.
    const n = actx.createBufferSource();
    const buf = actx.createBuffer(1, Math.round(actx.sampleRate * 0.008), actx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    n.buffer = buf;
    const bp = actx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = f * 4;
    bp.Q.value = 1.4;
    const ng = actx.createGain();
    ng.gain.value = vol * 0.55;
    n.connect(bp).connect(ng).connect(out);
    n.start(t);
  } catch {
    /* нет звука — не беда */
  }
}
// Курс пройден: короткое арпеджио вверх.
function cheer() {
  [0, 4, 7, 12, 16].forEach((s, i) => setTimeout(() => popTone(s + 3, { vol: 0.26 }), i * 85));
}

// --- данные ---
const DAY_WORD = (n) => (n % 10 === 1 && n % 100 !== 11 ? "день" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? "дня" : "дней");
let shownCourse = Number(localStorage.getItem("maid.course")) || 0;
let lastMarks = null; // id → строка состояний дней, чтобы анимировать только изменившееся
const pending = new Map(); // «id:day» → состояние, поставленное щелчком до ответа сервера

function coursesOf(d) {
  return (d?.habits ?? []).filter((h) => Array.isArray(h.course) && h.course.length);
}

function stats(h) {
  const due = h.course.filter((x) => x.s !== "rest");
  const done = due.filter((x) => x.s === "done").length;
  const idx = h.course.findIndex((x) => x.day === data.day);
  return { done, total: due.length, dayNo: idx < 0 ? null : idx + 1, len: h.course.length, finished: done === due.length && due.length > 0 };
}

const MARK = { done: "✓", miss: "✕", today: "", wait: "", rest: "" };
function dotHtml(h, x, i) {
  const s = pending.get(`${h.id}:${x.day}`) ?? x.s;
  const tip = `${humanDay(x.day).split(",")[0]}${s === "done" ? " — сделано" : s === "miss" ? " — пропущено" : s === "today" ? " — сегодня, щёлкните, чтобы отметить" : ""}`;
  return `<i class="pip ${s}" data-c="${h.id}" data-day="${x.day}" data-i="${i}" title="${esc(tip)}">${MARK[s]}</i>`;
}

function renderCourses() {
  const box = $("#courses");
  if (!box) return;
  const list = data && !prefsOpen ? coursesOf(data) : [];
  if (!list.length) {
    box.innerHTML = "";
    box.classList.add("hidden");
    lastMarks = data ? new Map() : null;
    return;
  }
  if (!list.some((h) => h.id === shownCourse)) {
    // По умолчанию — тот, что ещё ждёт отметки сегодня.
    shownCourse = (list.find((h) => h.course.some((x) => x.day === data.day && x.s === "today")) ?? list[0]).id;
  }
  const prev = lastMarks;
  const now = new Map(list.map((h) => [h.id, h.course.map((x) => x.s).join(",")]));
  const fresh = !box.childElementCount || prev === null;

  const main = list.find((h) => h.id === shownCourse);
  const st = stats(main);
  const others = list.filter((h) => h !== main).map((h) => {
    const o = stats(h);
    return `<button class="chip" data-show="${h.id}" title="${esc(h.title)}"><span>${esc(h.title)}</span><b>${o.done}/${o.total}</b><s style="--p:${o.total ? o.done / o.total : 0}"></s></button>`;
  });
  const big = main.course.length > 45;
  box.classList.remove("hidden");
  box.innerHTML = `
    <div class="course${st.finished ? " finished" : ""}${big ? " dense" : ""}" data-id="${main.id}">
      <div class="c-head">
        <svg class="c-ico" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>
        <span class="c-title">${esc(main.title)}</span>
        <span class="c-len">${st.len} ${DAY_WORD(st.len)}</span>
        <span class="c-score"><b>${st.done}</b> / ${st.total}</span>
      </div>
      <div class="pips">${main.course.map((x, i) => dotHtml(main, x, i)).join("")}</div>
      ${others.length ? `<div class="chips">${others.join("")}</div>` : ""}
    </div>`;
  // Анимация: при первом показе — волна появления, потом — только поменявшиеся пупырки.
  const pips = [...box.querySelectorAll(".pip")];
  if (fresh || !prev?.has(main.id)) {
    pips.forEach((p, i) => { p.style.animationDelay = `${i * 18}ms`; p.classList.add("rise"); });
    box.querySelector(".course").classList.add("enter");
  } else {
    const was = prev.get(main.id).split(",");
    let n = 0;
    main.course.forEach((x, i) => {
      if (was[i] === x.s) return;
      const p = pips[i];
      if (x.s === "done") {
        if (!pendingPopped.has(`${main.id}:${x.day}`)) {
          setTimeout(() => popTone(n * 2), n * 110);
          burst(p, n * 110);
        }
        p.classList.add("pressed");
        p.style.animationDelay = `${n * 110}ms`;
        n++;
      } else if (x.s === "miss") {
        p.classList.add("crossed");
        p.style.animationDelay = `${n * 110}ms`;
        n++;
      }
    });
    if (st.finished && was.filter((s) => s !== "rest" && s !== "done").length) setTimeout(() => celebrate(box.querySelector(".course")), 380);
  }
  pendingPopped.clear();
  lastMarks = now;
  settleCourses(prev && [...now].some(([id, m]) => prev.has(id) && prev.get(id) !== m));
}

// Плашка сама не висит: появляется, когда отметили день (видно, как вдавилась пупырка), и прячется через несколько секунд;
// навести на горничную — снова видна, пока курсор на ней.
const TUCK_AFTER_MARK = 4000;
const TUCK_AFTER_PEEK = 2500;
let tuckTimer = 0;
let peeking = false;
function tuck(on, ms = 0) {
  clearTimeout(tuckTimer);
  const box = $("#courses");
  if (!on) return box.classList.remove("tucked");
  if (ms) tuckTimer = setTimeout(() => { if (!peeking) box.classList.add("tucked"); }, ms);
  else box.classList.add("tucked");
}
function settleCourses(marked) {
  if (marked) {
    tuck(false);
    tuck(true, TUCK_AFTER_MARK);
  } else if (!peeking && !tuckTimer) tuck(true);
}
$("#maid").addEventListener("mouseenter", () => {
  peeking = true;
  tuck(false);
});
$("#maid").addEventListener("mouseleave", () => {
  peeking = false;
  tuck(true, TUCK_AFTER_PEEK);
});

// Брызги вокруг пупырки: кольцо и несколько точек.
function burst(pip, delay = 0) {
  setTimeout(() => {
    if (!pip.isConnected) return;
    const ring = document.createElement("b");
    ring.className = "ring";
    pip.appendChild(ring);
    for (let k = 0; k < 7; k++) {
      const s = document.createElement("b");
      s.className = "spark";
      const a = (k / 7) * Math.PI * 2 + Math.random() * 0.5;
      const r = 15 + Math.random() * 9;
      s.style.setProperty("--dx", `${Math.cos(a) * r}px`);
      s.style.setProperty("--dy", `${Math.sin(a) * r}px`);
      pip.appendChild(s);
    }
    setTimeout(() => pip.querySelectorAll(".ring, .spark").forEach((e) => e.remove()), 700);
  }, delay);
}

function celebrate(el) {
  if (!el) return;
  cheer();
  el.classList.add("party");
  const colors = ["#b79cff", "#4fd09a", "#ffb36b", "#ff8a9a", "#7cc4ff", "#ffe27a"];
  for (let k = 0; k < 26; k++) {
    const c = document.createElement("b");
    c.className = "confetti";
    c.style.background = colors[k % colors.length];
    c.style.left = `${8 + Math.random() * 84}%`;
    c.style.setProperty("--dx", `${(Math.random() - 0.5) * 120}px`);
    c.style.setProperty("--dy", `${-40 - Math.random() * 70}px`);
    c.style.setProperty("--rot", `${(Math.random() - 0.5) * 720}deg`);
    c.style.animationDelay = `${Math.random() * 120}ms`;
    el.appendChild(c);
  }
  setTimeout(() => { el.querySelectorAll(".confetti").forEach((e) => e.remove()); el.classList.remove("party"); }, 1600);
  say("Курс пройден до конца! Горжусь тобой, хозяин ✨", { emotion: "proud", ms: 7000 });
}

const pendingPopped = new Set();
