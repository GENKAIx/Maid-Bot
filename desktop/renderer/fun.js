// Мелкие живые штуки горничной: тычки по голове, настроение от того, как идёт день, «спасённый» вчерашний пропуск.
// Грузится до widget.js (тот сразу зовёт renderSoon); его react / say / data / load берёт уже при вызове.

// --- тап по голове ---
// Щелчок по верхней части фигурки — она реагирует (панель не сворачивается). Частые тычки подряд — сначала просит
// перестать, на десятом обижается: дуется (основа позы — «дуется», widget.js baseMood), пока не пройдёт полминуты
// с последнего тычка — каждый тычок во время обиды отодвигает прощение (sulkFor), но не дальше двух минут с её начала.
// Реакция зависит от того, чем она занята (pokeBusy: только что разбудили, думает, пьёт чай, убирается, ночь после отбоя —
// на первый тычок серии) и куда попали (pokeZone: чепчик, бант, щёки, грудь — три раза из четырёх, иначе обычная реплика).
// Фразы — в lines.js (line / lineItem): много вариантов, без повторов.
const POKE_HOLD = 8000; // поза после тычка держится дольше облачка
const POKE_SULK = 30_000;
const POKE_SULK_MAX = 120_000;
let pokes = 0;
let lastPoke = 0;
let sulkUntil = 0;
let sulkFrom = 0;
let sulkTimer = 0;

function boop(kind) {
  const f = $("#face");
  f.classList.remove("boop", "huff");
  void f.offsetWidth;
  f.classList.add(kind);
}
// Короткая реплика — только если облачко свободно (напоминание с кнопками не перебиваем). ms — сколько висит облачко, hold — поза.
function quip(text, moodName, ms = 3200, hold = ms + 300) {
  const b = $("#bubble");
  if (b.classList.contains("hidden") || b.dataset.quip) {
    say(text, { ms, mood: moodName });
    b.dataset.quip = "1";
  }
  react(moodName, hold);
}
// Зоны по кадру фигурки 400×427, в долях ширины и высоты: [зона, x0, y0, x1, y1]. Позы немного разные — зоны с запасом;
// бант — и на шее, и в волосах справа. Мимо зон (волосы, глаза, руки) — обычный тычок.
const POKE_ZONES = [
  ["bow", 0.46, 0.62, 0.68, 0.74], ["bow", 0.75, 0.25, 0.93, 0.41],
  ["cap", 0.28, 0, 0.86, 0.21],
  ["cheek", 0.33, 0.47, 0.47, 0.62], ["cheek", 0.6, 0.47, 0.74, 0.62],
  ["chest", 0.36, 0.74, 0.73, 0.92],
];
const POKE_ZONE_CHANCE = 0.75;
function pokeZone(x, y) {
  return POKE_ZONES.find(([, x0, y0, x1, y1]) => x >= x0 && x < x1 && y >= y0 && y < y1)?.[0] ?? "";
}
function pokeZoneAt(e) {
  const r = $("#face").getBoundingClientRect();
  return r.width && r.height ? pokeZone((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height) : "";
}
// Чем она занята в момент тычка: woke — разбудили меньше 5 с назад, think — ждёт ответа сервера, tea / clean — занята своим,
// night — после отбоя. Пусто — свободна.
function pokeBusy(now = Date.now()) {
  if (now - napWokeAt < 5000) return "woke";
  if (state === "think") return "think";
  if (now < moodUntil && (mood === "tea" || mood === "clean")) return mood;
  return afterBedtime() ? "night" : "";
}
const POKE_KEY = { woke: "pokeWoke", think: "pokeThink", tea: "pokeTea", clean: "pokeClean", night: "pokeNight", cap: "pokeCap", bow: "pokeBow", cheek: "pokeCheek", chest: "pokeChest" };
// Обида или её продление: простит через POKE_SULK после этого тычка, но не позже POKE_SULK_MAX с начала обиды.
function sulkFor(now) {
  sulkUntil = Math.min(now + POKE_SULK, sulkFrom + POKE_SULK_MAX);
  clearTimeout(sulkTimer);
  sulkTimer = setTimeout(() => {
    sulkUntil = 0;
    quip(line("forgive"), "bow", 3500);
  }, Math.max(0, sulkUntil - now));
}
function poke(zone = "") {
  globalThis.maid?.track?.("widget.poke"); // счётчик фич (main.js, usage.js)
  const now = Date.now();
  if (now < sulkUntil) {
    sulkFor(now);
    boop("huff");
    quip(line("sulk"), "pout", 2600);
    return;
  }
  pokes = now - lastPoke < 4000 ? pokes + 1 : 1;
  lastPoke = now;
  if (pokes >= 10) {
    pokes = 0;
    sulkFrom = now;
    sulkFor(now);
    boop("huff");
    play("oops");
    quip(line("sulkStart"), "angry", 4000);
    return;
  }
  boop("boop");
  if (pokes >= 7) {
    popTone(-4, { vol: 0.18, soft: true });
    quip(line(`annoyed${pokes}`), "worried", 3200, POKE_HOLD);
    return;
  }
  // 4–6-й тычок подряд — через раз смотрит пустым взглядом: «вы закончили?».
  if (pokes >= 4 && Math.random() < 0.5) {
    popTone(-2, { vol: 0.18, soft: true });
    quip(line("pokeMore"), "deadpan", 3400, POKE_HOLD);
    return;
  }
  // Первый тычок серии — по тому, чем занята (ночью — через раз, чтобы не одно и то же); иначе — по месту, куда попали.
  const busy = pokes === 1 ? pokeBusy(now) : "";
  const how = busy && (busy !== "night" || Math.random() < 0.6) ? busy : zone && Math.random() < POKE_ZONE_CHANCE ? zone : "";
  if (how === "woke") pokedAwake = true; // «О, вы вернулись!» после такого не нужно (wakeUp)
  const p = lineItem(POKE_KEY[how] ?? "poke");
  popTone(Math.floor(Math.random() * 8), { vol: 0.2, soft: true });
  quip(p.t, how === "think" ? thinkPick : p.m, how ? 3800 : 3200, POKE_HOLD);
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

// --- реплики на события дня ---
// Раз за день на каждое: первая сделанная задача, всё на сегодня сделано, днём давно ни одной галочки, вечером остались дела.
// Только когда облачко свободно и она не спит и не дуется; свёрнутая панель не разворачивается — облачко над головой (stay).
const SAID_KEY = "maid.dayEvents";
const STALE_MS = 3 * 3600_000;
const tasksCount = (n) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? "задача" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? "задачи" : "задач"}`;
let widgetSince = Date.now(); // «давно» не раньше, чем через 3 ч после запуска виджета
function saidToday(day) {
  try {
    const v = JSON.parse(localStorage.getItem(SAID_KEY) ?? "null");
    return v?.day === day ? v.said : [];
  } catch { return []; }
}
function sayOnce(day, key, vars) {
  const said = saidToday(day);
  if (said.includes(key)) return false;
  // «Всё сделано» заодно закрывает «первую»: одна задача на день — одна реплика, а не две подряд.
  const now = key === "allDone" ? [key, "firstDone"] : [key];
  try { localStorage.setItem(SAID_KEY, JSON.stringify({ day, said: [...said, ...now] })); } catch {}
  const p = lineItem(key, vars);
  say(p.t, { ms: 7000, mood: p.m, stay: collapsed });
  return true;
}
function dayEvent(now = new Date()) {
  const day = data.day;
  const h = now.getHours();
  const done = (data.done_today ?? []).map((t) => new Date(t.done_at).getTime()).filter(Number.isFinite);
  const habits = (data.habits ?? []).filter((x) => x.course?.find((c) => c.day === day)?.s !== "rest");
  const habitsLeft = habits.filter((x) => !x.status).length;
  const dueLeft = (data.tasks ?? []).filter((t) => t.due_date && t.due_date <= day).length;
  const said = saidToday(day);
  if (done.length + habits.filter((x) => x.status === "done").length > 0 && !dueLeft && !habitsLeft && !said.includes("allDone")) return ["allDone"];
  // «Первая» — только если она сделана только что (перезапуск вечером не скажет «первая!»).
  if (done.length && now - Math.min(...done) < 10 * 60_000 && !said.includes("firstDone")) return ["firstDone"];
  const last = Math.max(widgetSince, ...done);
  if (h >= 12 && h < 20 && (data.tasks ?? []).length && now - last > STALE_MS && !said.includes("stale")) return ["stale"];
  if (h >= 21 && dueLeft && !said.includes("eveningLeft")) return ["eveningLeft", { n: tasksCount(dueLeft) }];
  return null;
}
function tickDayEvents() {
  if (!data || !online || napping || Date.now() < sulkUntil || !$("#bubble").classList.contains("hidden")) return;
  const ev = dayEvent();
  if (ev) sayOnce(data.day, ...ev);
}
setInterval(tickDayEvents, 30_000);

// --- реакция на дела ---
// Есть просроченные задачи — недовольная мордочка вместо обычной (основа, см. baseMood). В колокольчик звонит только
// в момент начала плана, пока висит облачко «⏰ Пора» (widget.js, startButtons).
let dueMood = "";
function tickDue() {
  if (!data) return;
  const overdue = (data.tasks ?? []).some((t) => t.due_date && t.due_date < data.day);
  const next = overdue ? "angry" : "";
  if (next !== dueMood) {
    dueMood = next;
    settle();
  }
}
setInterval(tickDue, 15_000);

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
// Сняли галочку в самом виджете — забыть сразу (и минус один к счёту дня).
function forgetDone(id) {
  doneNow.delete(id);
  localStorage.setItem(DONE_KEY_NOW, JSON.stringify([...doneNow]));
  const day = data?.day;
  const n = Number(localStorage.getItem(DONE_KEY(day))) || 0;
  if (day && n > 0) localStorage.setItem(DONE_KEY(day), String(n - 1));
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
  for (const t of list) {
    const d = doneNow.get(t.id);
    if (!d) { doneNow.set(t.id, { title: t.title, until: endOfDay(), at: 0 }); added = true; }
    else if (t.title && d.title !== t.title) { d.title = t.title; added = true; } // сервер знает точное название (и чинит записанное с ошибкой)
  }
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
