// Мелкие живые штуки горничной: тычки по голове, настроение от того, как идёт день, «спасённый» вчерашний пропуск.
// Грузится до widget.js (тот сразу зовёт renderSoon); его react / say / data / load берёт уже при вызове.

// --- тап по голове ---
// Щелчок по верхней части фигурки — она реагирует (панель не сворачивается). Частые тычки подряд — сначала просит
// перестать, на десятом обижается на полминуты.
const POKES = [
  ["gasp", "Ой!"], ["giggle", "Хи-хи, щекотно"], ["neutral", "Чепчик съехал… поправила"], ["smitten", "Ну что вы… смущаюсь"],
  ["bow", "Я тут, хозяин"], ["listen", "М?"], ["gasp", "Ай!"], ["happy", "Чего изволите?"],
];
const POKE_ANNOYED = ["Ну хватит…", "Хозяин, ну правда…", "Ещё раз — и обижусь!"];
const POKE_SULK = 30_000;
let pokes = 0;
let lastPoke = 0;
let lastPick = -1;
let sulkUntil = 0;

function boop(kind) {
  const f = $("#face");
  f.classList.remove("boop", "huff");
  void f.offsetWidth;
  f.classList.add(kind);
}
// Короткая реплика — только если облачко свободно (напоминание с кнопками не перебиваем).
function quip(text, moodName, ms = 1900) {
  const b = $("#bubble");
  if (b.classList.contains("hidden") || b.dataset.quip) {
    say(text, { ms, mood: moodName });
    b.dataset.quip = "1";
  }
  react(moodName, ms + 300);
}
function poke() {
  const now = Date.now();
  if (now < sulkUntil) {
    boop("huff");
    quip(["Хмф.", "Не разговариваю.", "Я обиделась, между прочим."][Math.floor(Math.random() * 3)], "refuse", 1800);
    return;
  }
  pokes = now - lastPoke < 4000 ? pokes + 1 : 1;
  lastPoke = now;
  if (pokes >= 10) {
    pokes = 0;
    sulkUntil = now + POKE_SULK;
    boop("huff");
    play("oops");
    quip("Всё! Я обиделась. Не трогайте меня 😤", "angry", 4000);
    setTimeout(() => {
      if (Date.now() < sulkUntil - 50) return;
      quip("Ладно, прощаю… но больше не тыкайте 🙂", "bow", 3500);
    }, POKE_SULK);
    return;
  }
  boop("boop");
  if (pokes >= 7) {
    popTone(-4, { vol: 0.18, soft: true });
    quip(POKE_ANNOYED[pokes - 7], "worried");
    return;
  }
  let i;
  do i = Math.floor(Math.random() * POKES.length); while (i === lastPick);
  lastPick = i;
  popTone(Math.floor(Math.random() * 8), { vol: 0.2, soft: true });
  quip(POKES[i][1], POKES[i][0]);
}

// --- настроение от того, как идёт день ---
// Счёт дня −1…+1: сделанное поднимает, просроченное и неотмеченное к вечеру — опускает. Настроение идёт к нему
// медленно (несколько минут), чтобы она не металась от каждой галочки. Хорошо — чаще радуется сама по себе;
// плохо — грустно метёт веником (основа вместо «ждёт»).
const DONE_KEY = (day) => `maid.doneOn.${day}`;
let dayScore = null;
let dayMood = "ok"; // good | ok | bad

function countDone(day) {
  localStorage.setItem(DONE_KEY(day), String((Number(localStorage.getItem(DONE_KEY(day))) || 0) + 1));
}
function dayTarget() {
  if (!data) return 0;
  const day = data.day;
  const habits = (data.habits ?? []).filter((h) => h.course?.find((x) => x.day === day)?.s !== "rest");
  const done = habits.filter((h) => h.status === "done").length;
  const left = habits.filter((h) => !h.status).length;
  const overdue = data.tasks.filter((t) => t.due_date && t.due_date < day).length;
  const dueToday = data.tasks.filter((t) => t.due_date === day).length;
  const missed = habits.filter((h) => h.yesterday === "none").length;
  // Сделанные сегодня — с сервера (и с телефона, и из Telegram); старый сервер без поля — свой счёт виджета.
  const tasksDone = Math.max(data.done_today?.length ?? 0, Number(localStorage.getItem(DONE_KEY(day))) || 0);
  const h = new Date().getHours();
  const late = h >= 18 ? 1 : h >= 14 ? 0.5 : 0.15;
  let s = 0.3 * Math.min(done, 4) + 0.25 * Math.min(tasksDone, 4) - 0.35 * Math.min(overdue, 4)
    - late * 0.25 * Math.min(left + dueToday, 4) - 0.1 * missed;
  if (habits.length && !left) s += 0.4;
  return Math.max(-1, Math.min(1, s));
}
function tickDayMood() {
  if (!data) return;
  const t = dayTarget();
  dayScore = dayScore === null ? t : dayScore + Math.max(-0.06, Math.min(0.06, t - dayScore));
  // С запасом в обе стороны, чтобы на границе не моргало.
  const next = dayMood === "good" ? (dayScore < 0.3 ? "ok" : "good")
    : dayMood === "bad" ? (dayScore > -0.25 ? "ok" : "bad")
    : dayScore > 0.4 ? "good" : dayScore < -0.35 ? "bad" : "ok";
  if (next !== dayMood) {
    dayMood = next;
    settle();
  }
  $("#maid").dataset.day = dayMood;
}
setInterval(tickDayMood, 20_000);

// --- реакция на дела ---
// За 10 минут до плана со временем — машет и потом держит часики, пока план не начнётся; есть просроченные задачи —
// недовольная мордочка вместо обычной (основа, см. baseMood). Сервер свои напоминания и так присылает — тут без слов.
let dueMood = "";
let soonWaved = "";
function soonPlan() {
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  for (const e of data?.events ?? []) {
    if (!e.time || (e.status && e.status !== "active")) continue;
    const [h, m] = e.time.split(":").map(Number);
    const left = h * 60 + m - cur;
    if (left > 0 && left <= 10) return e;
  }
  return null;
}
function tickDue() {
  if (!data) return;
  const soon = soonPlan();
  const overdue = (data.tasks ?? []).some((t) => t.due_date && t.due_date < data.day);
  const next = soon ? "remind" : overdue ? "angry" : "";
  const key = soon ? `${data.day}|${soon.id ?? soon.title}|${soon.time}` : "";
  if (soon && key !== soonWaved) {
    // Только что стало «через 10 минут» — помахать и тихонько звякнуть, потом часики.
    soonWaved = key;
    dueMood = next;
    popTone(5, { vol: 0.08, soft: true });
    return react("hello", 3500);
  }
  if (next !== dueMood) {
    dueMood = next;
    settle();
  }
}
setInterval(tickDue, 15_000);

// --- спасённый пропуск ---
// Вчерашний день по расписанию без отметки — в списке строкой «вчера — спасти серию». Отметка задним числом:
// пупырка «склеивается» с трещинкой, серия не рвётся.
const rescued = new Set(); // «id:день» — чтобы плашка курса склеила пупырку, а не просто вдавила
function dayBefore(day) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
function missedYesterday(h) {
  if (h.yesterday !== undefined) return h.yesterday === "none";
  // Сервер ещё без поля «yesterday» — по дням курса.
  const y = dayBefore(data.day);
  return h.course?.find((x) => x.day === y)?.s === "miss";
}
function crack(el) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "crack");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.innerHTML = `<polyline points="3,1.5 7,6 5,8.5 10,11.5 13.5,15" />`;
  el.appendChild(svg);
  setTimeout(() => svg.remove(), 1500);
}
function glue(el) {
  el.classList.remove("pressed", "glued");
  void el.offsetWidth;
  el.classList.add("glued");
  crack(el);
  popTone(-7, { vol: 0.2, soft: true });
  setTimeout(() => popTone(5, { vol: 0.24 }), 380);
  setTimeout(() => popTone(9, { vol: 0.24 }), 470);
  setTimeout(() => burst(el), 420);
}
async function rescue(el, id) {
  const h = data.habits.find((x) => x.id === Number(id));
  if (!h) return;
  const day = dayBefore(data.day);
  rescued.add(`${h.id}:${day}`);
  el.classList.add("done");
  el.textContent = "✓";
  glue(el);
  react("proud", 4500);
  holdRender = Date.now() + 950; // строка доиграет склейку, потом список и плашка обновятся
  await maid.api("POST", `/api/habits/${h.id}/mark`, { status: "done", day });
  await load();
  const now = data?.habits?.find((x) => x.id === h.id);
  setTimeout(() => {
    say(`Пропуск спасён — «${h.title}» вчера отмечено${now?.streak >= 2 ? `, серия цела 🔥${now.streak}` : ""}`, { ms: 5000, mood: "proud" });
  }, 700);
  maid.changed();
}

// --- выполненная задача съезжает вниз ---
// Сделанные сегодня задачи (сервер их уже не отдаёт): id → { title, until } — внизу списка зачёркнутыми / под счётчиком.
// Живут до конца дня и переживают перезапуск виджета (localStorage).
const DONE_KEY_NOW = "maid.doneNow";
const doneNow = new Map(loadDoneNow());
function loadDoneNow() {
  try { return JSON.parse(localStorage.getItem(DONE_KEY_NOW)) ?? []; } catch { return []; }
}
function endOfDay() {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}
function keepDone(id, title) {
  doneNow.set(id, { title, until: endOfDay(), at: Date.now() });
  localStorage.setItem(DONE_KEY_NOW, JSON.stringify([...doneNow]));
}
// Задачу вернули в работу (в приложении, в Telegram) — сервер снова отдаёт её открытой: забыть отметку.
// Первые 15 с не считаются: отметка ещё могла не дойти до сервера.
function forgetReopened(tasks) {
  let dropped = false;
  for (const t of tasks ?? []) {
    const d = doneNow.get(t.id);
    if (d && Date.now() - (d.at ?? 0) > 15_000) { doneNow.delete(t.id); dropped = true; }
  }
  if (dropped) localStorage.setItem(DONE_KEY_NOW, JSON.stringify([...doneNow]));
}
// Сделанные сегодня в другом месте (телефон, Telegram) — тоже внизу списка зачёркнутыми. at 0 — сервер уже знает.
function takeServerDone(list) {
  if (!Array.isArray(list)) return;
  let added = false;
  for (const t of list) if (!doneNow.has(t.id)) { doneNow.set(t.id, { title: t.title, until: endOfDay(), at: 0 }); added = true; }
  if (added) localStorage.setItem(DONE_KEY_NOW, JSON.stringify([...doneNow]));
}
function recentDone() {
  const now = Date.now();
  let dropped = false;
  for (const [id, t] of doneNow) if (t.until < now) { doneNow.delete(id); dropped = true; }
  if (dropped) localStorage.setItem(DONE_KEY_NOW, JSON.stringify([...doneNow]));
  return [...doneNow].map(([id, t]) => ({ id, ...t }));
}
// Пока строка едет, свежие данные не перерисовывают список — иначе анимация обрывается.
let holdRender = 0;
let holdTimer = 0;
function renderSoon() {
  const wait = holdRender - Date.now();
  clearTimeout(holdTimer);
  if (wait > 0) holdTimer = setTimeout(render, wait);
  else render();
}
// FLIP: строка переезжает в конец списка, остальные поднимаются на её место — всё плавно.
function slideDown(li) {
  const ul = li?.parentElement;
  if (!ul) return;
  const rows = [...ul.children];
  const before = new Map(rows.map((r) => [r, r.getBoundingClientRect().top]));
  ul.appendChild(li);
  li.classList.add("did");
  for (const r of rows) {
    const dy = before.get(r) - r.getBoundingClientRect().top;
    if (!dy) continue;
    r.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }],
      { duration: r === li ? 520 : 380, easing: "cubic-bezier(.3, 1.15, .4, 1)" });
  }
}
