// Праздники привычек (ревью 20.11 «Опыт, праздники и живые облачка», тема «Все привычки дня отмечены»):
//  • «Огонёк взрослеет» — у огонька серии три возраста: с 7 дней светится, с 30 — синий, со 100 — золотой с искрой (видно всегда);
//    в день рубежа (серия стала 7, 30 или 100 отметкой сегодня) число перекатывается, огонёк вспыхивает, по строке бежит блик,
//    на ~3 с выезжает ярлык «неделя подряд», колокольчики (чем старше рубеж, тем длиннее перезвон), поза и облачко.
//  • «Волна по отметкам» — повседневный праздник «все привычки дня сделаны»: волна с гаммой сверху вниз, огоньки подпрыгивают,
//    потом 26 конфетти и арпеджио, как в конце курса, но над всей панелью.
//  • «Салют из искр» — тот же повод, но в особый день: брызги отметок кометами летят к Рине и рвутся тремя залпами над панелью.
//    Особый день — когда сегодня у какой-то привычки был рубеж серии 7 / 30 / 100 (в этой отметке или раньше за день).
//    Тот же салют (hpCourseSalute) — в конце курса, вместо конфетти: одинаковый на курс любой длины.
// Всё срабатывает по данным (/api/today в load → hpSync), а не по щелчку: так же и после отметки в облачке, в меню привычки,
// в режиме «улетают», в Telegram или на телефоне. Каждый праздник — раз в день (localStorage maid.habitParty), снять и снова
// поставить галочку — не повтор. Панель свёрнута или горничная спит — без праздника (день всё равно засчитан).

const HP_TIERS = { 7: "неделя подряд", 30: "месяц подряд", 100: "сто дней!" };
const HP_KEY = "maid.habitParty";
const HP_ROLL_MS = 700; // перекат числа огонька
const HP_MARK_MS = 3700; // ярлык рубежа на строке (выезд .4 с, виден ~3 с, уход .3 с)
let hpPrev = null; // { day, streak: Map id→серия, all: все ли сделаны } — прошлый ответ сервера
const hpRoll = new Map(); // id → { at, from } — у огонька перекатывается число
const hpMark = new Map(); // id → { at, tier } — рубеж серии сегодня
let hpParty = null; // { kind: "wave" | "salute", ids } — ждёт перерисовки списка, потом играет

// Возраст огонька по серии.
const hpAge = (n) => (n >= 100 ? 100 : n >= 30 ? 30 : n >= 7 ? 7 : 0);

// Огонёк серии в строке привычки (widget.js dayItem): возраст классом, перекат и вспышка — пока свежие.
function flameHtml(h) {
  if (!(h.streak >= 2)) return "";
  const age = hpAge(h.streak);
  const r = hpStamp(hpRoll.get(h.id));
  const rolling = r && Date.now() - r.at < HP_ROLL_MS && !hpStill();
  const m = hpStamp(hpMark.get(h.id));
  const flare = m && Date.now() - m.at < 900 ? ` flare" data-hp-at="${m.at}` : "";
  const num = rolling ? `<b class="hp-roll" data-hp-at="${r.at}"><i>${r.from}</i><i>${h.streak}</i></b>` : `<b>${h.streak}</b>`;
  return ` <span class="flame a${age}${flare}" title="Серия: ${h.streak} ${hpDays(h.streak)} подряд"><em>🔥</em>${num}</span>`;
}
// Ярлык рубежа справа в строке («неделя подряд»), пока свежий.
function flameTagHtml(h) {
  const m = hpStamp(hpMark.get(h.id));
  if (!m || Date.now() - m.at >= HP_MARK_MS) return "";
  return `<span class="hp-tag t${m.tier}" data-hp-at="${m.at}">${HP_TIERS[m.tier]}</span>`;
}
// Класс строки на время блика рубежа.
function flameRowClass(h) {
  const m = hpStamp(hpMark.get(h.id));
  return m && Date.now() - m.at < 1000 ? ` hp-sweep t${m.tier}` : "";
}
const hpDays = (n) => (n % 10 === 1 && n % 100 !== 11 ? "день" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? "дня" : "дней");
const hpStill = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// Что уже праздновали сегодня: { day, party, marks: [id…] }.
function hpDone(day) {
  try {
    const v = JSON.parse(localStorage.getItem(HP_KEY) ?? "null");
    return v?.day === day ? v : { day, party: false, marks: [] };
  } catch {
    return { day, party: false, marks: [] };
  }
}
function hpSave(v) {
  try { localStorage.setItem(HP_KEY, JSON.stringify(v)); } catch {}
}

// Опрос (widget.js load, до сравнения JSON): сравнить с прошлым ответом — перекаты, рубежи, «все сделаны».
function hpSync(d) {
  const day = d?.day;
  const list = (d?.habits ?? []).filter((h) => h.course?.find((x) => x.day === day)?.s !== "rest");
  const streak = new Map(list.map((h) => [h.id, h.streak ?? 0]));
  const status = new Map(list.map((h) => [h.id, h.status ?? null]));
  const all = list.length > 0 && list.every((h) => h.status === "done");
  const prev = hpPrev;
  hpPrev = { day, streak, status, all };
  if (!prev || prev.day !== day) return; // первый ответ после запуска или новый день — без праздника
  const now = Date.now();
  const seen = hpDone(day);
  const fresh = [];
  const shown = cfg.sections?.habits !== false; // раздел «Привычки» спрятан — ни рубежей, ни праздника (и день их не тратит)
  for (const h of list) {
    const was = prev.streak.get(h.id);
    // Серия упала (сняли отметку) — рубеж и перекат этой строки больше не показывать.
    if (hpMark.get(h.id) && hpMark.get(h.id).tier !== h.streak) hpMark.delete(h.id);
    if (was !== undefined && h.streak < was) hpRoll.delete(h.id);
    if (was === undefined || !(h.streak > was)) continue;
    hpRoll.set(h.id, { made: now, at: 0, from: was });
    // Рубеж — серия стала 7, 30 или 100 сегодняшней отметкой (а не задним числом: тогда сегодня не «сделано»). Только у строки
    // с огоньком: у курса в день курса вместо огонька полоска.
    const courseDay = h.course?.some((x) => x.day === day);
    if (shown && HP_TIERS[h.streak] && h.status === "done" && !courseDay && !seen.marks.includes(h.id)) {
      hpMark.set(h.id, { made: now, at: 0, tier: h.streak });
      seen.marks.push(h.id);
      fresh.push(h);
    }
  }
  // «Все сделаны» — только когда в этом ответе какая-то привычка сама стала сделанной (а не исчезла из списка: удалили, остановили,
  // день отдыха) и раздел «Привычки» виден.
  const justDone = list.some((h) => prev.status.has(h.id) && prev.status.get(h.id) !== "done" && h.status === "done");
  const party = shown && all && !prev.all && justDone && !seen.party;
  // Праздник ждёт перерисовки, а галочку уже сняли — убрать из него снятые рубежи; «все сделаны» больше не так — без волны и салюта.
  if (hpParty) {
    hpParty.marks = hpParty.marks.filter((m) => hpMark.has(m.id));
    if (!all) hpParty.kind = "marks";
    if (hpParty.kind === "marks" && !hpParty.marks.length) hpParty = null;
  }
  if (party) seen.party = true;
  // Этой же отметкой закончился курс — его салют играет course.js (hpCourseSalute); волну или второй салют поверх не запускать.
  const courseEnd = list.some((h) => prev.status.get(h.id) !== "done" && h.status === "done" && h.course?.length
    && h.course.every((x) => x.s === "done" || x.s === "rest"));
  if (!fresh.length && !party) return;
  hpSave(seen);
  // Особый день — рубеж серии был сегодня (в этой отметке или раньше): тогда вместо волны салют.
  const tops = list.filter((h) => seen.marks.includes(h.id) && HP_TIERS[h.streak] && h.status === "done").map((h) => h.streak);
  // Праздник — после ближайшей перерисовки (hpAfterRender). Если та ещё не прошла (список держат), не затирать прошлое событие, а сложить.
  const q = hpParty;
  const marks = [...(q?.marks ?? []).filter((m) => !fresh.some((f) => f.id === m.id)), ...fresh];
  const big = (party && !courseEnd) || q?.kind === "wave" || q?.kind === "salute";
  hpParty = { kind: big ? (tops.length ? "salute" : "wave") : "marks", n: list.length, marks, top: Math.max(0, ...tops, q?.top ?? 0) };
  if (hpParty.kind === "marks" && !marks.length) hpParty = null;
}

// Время эффекта строки считается с первой перерисовки, которая его показала (список могли придержать); устарело — не показывать.
function hpStamp(x) {
  if (!x) return null;
  if (!x.at) {
    if (Date.now() - x.made > 15000) return null;
    x.at = Date.now();
  }
  return x;
}

// После перерисовки списка (widget.js render): дотянуть свежие анимации (style="" в разметке запрещает CSP) и начать праздник.
function hpAfterRender() {
  for (const el of $("#body").querySelectorAll("[data-hp-at]")) el.style.setProperty("--hp-delay", `-${Date.now() - Number(el.dataset.hpAt)}ms`);
  for (const li of $("#body").querySelectorAll("li.hp-sweep")) {
    const m = hpMark.get(Number(li.querySelector("[data-habit]")?.dataset.habit));
    if (m) li.style.setProperty("--hp-delay", `-${Date.now() - m.at}ms`);
  }
  // Ярлык рубежа гаснет сам (анимация), а потом уходит из строки, чтобы не держать место до следующей перерисовки.
  for (const t of $("#body").querySelectorAll(".hp-tag")) setTimeout(() => t.remove(), Math.max(0, HP_MARK_MS - (Date.now() - Number(t.dataset.hpAt))));
  if (!hpParty) return;
  const p = hpParty;
  hpParty = null;
  if (collapsed || napping) return;
  setTimeout(() => hpPlay(p), 30);
}

function hpPlay(p) {
  // Праздники — в счётчик «Рины» (usage.js): рубеж серии, волна, салют (салют без фигурки играет волной — в счёт салютом).
  if (p.marks.length) maid.track?.("maid.party.flame");
  if (p.kind === "wave") maid.track?.("maid.party.wave");
  else if (p.kind === "salute") maid.track?.("maid.party.salute");
  if (p.marks.length) hpMarkFx(p.marks, p.kind === "marks");
  if (p.kind === "wave") hpWave(p.n);
  else if (p.kind === "salute") hpSalute(p.top);
}

// --- рубеж серии: искры у огонька, колокольчики, поза и облачко (если это не часть большого праздника) ---
const HP_BELLS = { 7: [1175, 1760], 30: [1175, 1480, 1760], 100: [1175, 1480, 1760, 2349] };
const HP_MARK_POSE = { 7: "streak", 30: "proud", 100: "bow" };
function hpMarkFx(marks, alone) {
  const top = Math.max(...marks.map((h) => h.streak));
  hpSound((s) => {
    s.voice(0, 300, 900, 0.2, 0.05);
    HP_BELLS[top].forEach((f, i) => s.bell(0.09 * i, f, 0.04, 0.7));
  });
  const cols = { 7: ["#ffb36b", "#ff8a5c", "#ffe27a"], 30: ["#8fc2ff", "#b79cff", "#fff"], 100: ["#f2c661", "#ffe9a8", "#fff", "#ffb36b"] };
  for (const h of marks) {
    const em = $(`#body [data-habit="${h.id}"]`)?.closest("li")?.querySelector(".flame em");
    if (em) hpDots(em, { n: { 7: 8, 30: 14, 100: 24 }[h.streak], cols: cols[h.streak], spread: 26 + { 7: 8, 30: 14, 100: 24 }[h.streak], rise: true });
    if (h.streak === 100 && em) {
      hpAgain($("#w"), "hp-goldw");
      setTimeout(() => cheer(), 450);
      hpDots(em, { n: 20, cols: ["#f2c661", "#fff3c4", "#fff"], spread: 92, star: true, life: 1300 });
    }
  }
  if (!alone) return;
  react(HP_MARK_POSE[top], 4500);
  if ($("#bubble").classList.contains("hidden")) say(line(`flame${top}`), { ms: 6000, mood: HP_MARK_POSE[top] });
}

// --- «Волна по отметкам» ---
function hpWave(n) {
  const rows = [...$("#body").querySelectorAll(".habit-list li.habit")]; // отмеченные спрятаны (cfg.doneHabits) — сразу финал
  const still = hpStill();
  animUntil = Math.max(animUntil, Date.now() + rows.length * 125 + 1100); // список не перерисовывать, пока идёт волна
  rows.forEach((li, i) => setTimeout(() => {
    if (!li.isConnected) return;
    hpAgain(li.querySelector(".mark"), "hp-wave");
    popTone([0, 2, 4, 7, 9, 12, 14][i] ?? (i * 2) % 16, { vol: 0.16 });
    const em = li.querySelector(".flame em");
    if (em) { hpAgain(em, "hp-jump"); if (!still) hpDots(em, { n: 5, cols: ["#ffb36b", "#ff8a5c", "#ffe27a"], spread: 20, rise: true, life: 650 }); }
    else hpAgain(li.querySelector(".cm-bar"), "hp-shine");
  }, i * 125));
  setTimeout(() => {
    const ul = $("#body .habit-list") ?? $("#body");
    hpAgain(ul, "hp-party");
    cheer();
    if (!still) hpConfetti(ul, 26);
    react("happy", 5000);
    if ($("#bubble").classList.contains("hidden")) say(line("habitsAll", { n }), { ms: 6000, mood: "happy" });
  }, rows.length * 125 + 380);
}

// --- «Салют из искр» ---
// Все привычки дня в день рубежа серии: брызги от каждой отметки.
function hpSalute(top) {
  const marks = [...$("#body").querySelectorAll(".habit-list li.habit .mark")];
  if (!$("#face")) return hpWave(marks.length);
  hpSaluteFrom(marks, () => {
    if ($("#bubble").classList.contains("hidden")) say(line(top ? "habitsSalute" : "habitsAll", { n: top, what: HP_TIERS[top] ?? "" }), { ms: 7000, mood: "excited" });
  });
}
// Курс пройден (course.js celebrate, после волны по дням): салют от дней курса — один и тот же на курс любой длины.
function hpCourseSalute(el) {
  const pips = [...el.querySelectorAll(".pip:not(.rest)")];
  const pick = pips.length <= 8 ? pips : Array.from({ length: 8 }, (_, i) => pips[Math.round((i * (pips.length - 1)) / 7)]);
  el.classList.add("party");
  setTimeout(() => el.classList.remove("party"), 700);
  hpSaluteFrom(pick, () => say(line("courseDone"), { emotion: "proud", ms: 7000, mood: "bow" }));
}
// Кометы от источников (отметки, дни курса) летят к Рине, потом подсветка панели и три залпа над ней; done — облачко после залпов.
function hpSaluteFrom(from, done) {
  const face = $("#face");
  const still = hpStill();
  animUntil = Math.max(animUntil, Date.now() + from.length * 80 + 900); // список не перерисовывать, пока летят кометы
  const f = face?.getBoundingClientRect();
  const to = f?.width ? { x: f.left + f.width * 0.5, y: f.top + f.height * 0.32 } : null;
  const cols = ["#4fd09a", "#b79cff", "#ffb36b"];
  from.forEach((m, i) => {
    setTimeout(() => {
      if (!m.isConnected) return;
      burst(m);
      hpSound((s) => s.voice(0, 520 + i * 90, 1300 + i * 120, 0.16, 0.03));
    }, i * 80);
    if (!still && to && m.offsetParent) for (let k = 0; k < 3; k++) hpComet(m, to, cols[(i + k) % 3], i * 80 + k * 50, 560 + Math.random() * 140);
  });
  setTimeout(() => {
    react("excited", 6000);
    hpAgain($("#w"), "hp-lit");
    if (to) {
      const shots = [[0, 0, 0], [300, 46, -14], [580, -34, 18]];
      shots.forEach(([at, dx, dy], k) => setTimeout(() => hpSalvo(to.x + dx, to.y + dy, k, still), at));
    }
    setTimeout(done, 1300);
  }, from.length * 80 + 800);
}
function hpSalvo(x, y, k, still) {
  hpSound((s) => { s.voice(0, 190, 60, 0.22, 0.1); s.noise(0, 0.28, 0.05, { kind: "highpass", f0: 2200 }); });
  if (still) return;
  hpFx("hp-orb", x, y, 600);
  hpBloom(x, y, { n: 22, r: 82, size: 5.5, life: 1250, cols: [["#4fd09a", "#b8ffe0", "#fff"], ["#b79cff", "#e2d6ff", "#fff"], ["#ffb36b", "#ffe27a", "#fff"]][k % 3] });
  hpBloom(x, y, { n: 10, r: 46, size: 5, life: 800, drop: 8, streak: true, cols: ["#ffe27a", "#fff"] });
}

// --- частицы: всё — fixed поверх окна, вне #body, чтобы перерисовка списка их не стёрла ---
function hpFx(cls, x, y, life) {
  const e = document.createElement("i");
  e.className = `hp-fx ${cls}`;
  Object.assign(e.style, { left: `${x}px`, top: `${y}px` });
  document.body.append(e);
  setTimeout(() => e.remove(), life);
  return e;
}
function hpCenter(el) {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}
// Точки или звёздочки от элемента (огонёк): разлетаются и взлетают.
function hpDots(el, { n = 8, cols = ["#ffb36b"], spread = 24, rise = false, star = false, life = 900 } = {}) {
  if (hpStill()) return;
  const c = hpCenter(el);
  for (let i = 0; i < n; i++) {
    const p = hpFx(star ? "hp-star" : "hp-dot", c.x, c.y, life * 1.3);
    const col = cols[i % cols.length];
    if (star) { p.textContent = "✦"; p.style.color = col; } else p.style.background = col;
    const a = Math.random() * Math.PI * 2, r = spread * (0.45 + Math.random() * 0.55);
    const dx = Math.cos(a) * r, dy = Math.sin(a) * r - spread * 0.25 + (rise ? -spread * 0.4 : 0);
    p.animate([
      { transform: "translate(-50%, -50%) scale(.4)", opacity: 1 },
      { transform: `translate(calc(-50% + ${dx * 0.8}px), calc(-50% + ${dy * 0.8}px)) scale(1)`, opacity: 1, offset: 0.45 },
      { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy + (rise ? -22 : 30)}px)) scale(.7)`, opacity: 0 },
    ], { duration: life * (0.75 + Math.random() * 0.5), easing: "cubic-bezier(.15, .7, .3, 1)", fill: "forwards" });
  }
}
// 26 конфетти над списком привычек — как party() курса (course.js), только над всей панелью.
function hpConfetti(over, n) {
  const r = over.getBoundingClientRect();
  const colors = ["#b79cff", "#4fd09a", "#ffb36b", "#ff8a9a", "#7cc4ff", "#ffe27a"];
  for (let k = 0; k < n; k++) {
    const c = hpFx("hp-conf", r.left + r.width * (0.08 + Math.random() * 0.84), r.top + r.height * 0.4, 1600);
    c.style.background = colors[k % colors.length];
    c.style.setProperty("--dx", `${(Math.random() - 0.5) * 120}px`);
    c.style.setProperty("--dy", `${-40 - Math.random() * 70}px`);
    c.style.setProperty("--rot", `${(Math.random() - 0.5) * 720}deg`);
    c.style.animationDelay = `${Math.random() * 120}ms`;
  }
}
// Комета от отметки к Рине.
function hpComet(from, to, color, delay, dur) {
  const a = hpCenter(from);
  const e = hpFx("hp-comet", a.x, a.y, delay + dur + 80);
  e.style.background = color;
  e.style.boxShadow = `0 0 9px 2px ${color}`;
  const dx = to.x - a.x, dy = to.y - a.y, k = (Math.random() - 0.5) * 110;
  e.animate([
    { transform: "translate(-50%, -50%) scale(.4)", opacity: 0 },
    { transform: `translate(calc(-50% + ${dx * 0.2 + k}px), calc(-50% + ${dy * 0.45}px)) scale(1.2)`, opacity: 1, offset: 0.35 },
    { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(.6)`, opacity: 1 },
  ], { duration: dur, delay, easing: "cubic-bezier(.5, 0, .6, 1)", fill: "both" });
}
// «Цветок» залпа: точки ровным кругом наружу, потом провисают и гаснут.
function hpBloom(x, y, { n = 20, r = 70, cols = ["#fff"], size = 5, life = 1000, drop = 26, streak = false } = {}) {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 6.283 + Math.random() * 0.3, d = r * (0.7 + Math.random() * 0.4), c = cols[i % cols.length], s = size * (0.7 + Math.random() * 0.6);
    const e = hpFx("hp-spark", x, y, life * 1.25);
    Object.assign(e.style, { width: `${streak ? s * 0.45 : s}px`, height: `${streak ? s * 2.6 : s}px`, borderRadius: `${s}px`, background: c, boxShadow: `0 0 ${s * 1.6}px ${s * 0.3}px ${c}` });
    const rot = streak ? ` rotate(${(a + 1.571).toFixed(2)}rad)` : "", ex = Math.cos(a) * d, ey = Math.sin(a) * d;
    e.animate([
      { transform: `translate(-50%, -50%)${rot} scale(.3)`, opacity: 1, easing: "cubic-bezier(.1, .8, .3, 1)" },
      { transform: `translate(calc(-50% + ${ex * 0.92}px), calc(-50% + ${ey * 0.92}px))${rot} scale(1)`, opacity: 1, offset: 0.45, easing: "ease-in" },
      { transform: `translate(calc(-50% + ${ex}px), calc(-50% + ${ey + drop}px))${rot} scale(.2)`, opacity: 0 },
    ], { duration: life * (0.8 + Math.random() * 0.4), fill: "forwards" });
  }
}
function hpAgain(el, cls) {
  if (!el) return;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), 2000);
}
// Звук на кирпичиках «голосов» Рины (moodsound.js MoodSynth); молчит при «Звуки выключены».
function hpSound(make) {
  if (cfg.mute) return;
  try {
    actx ??= new AudioContext();
    const out = actx.createGain();
    out.gain.value = 1.1;
    out.connect(actx.destination);
    make(new MoodSynth(actx, out, actx.currentTime + 0.01));
  } catch {}
}
