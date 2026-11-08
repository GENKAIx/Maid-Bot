// Горничная на ПК: фигурка в углу (дышит, моргает, думает, спит ночью), облачко с уведомлениями и ответами,
// над ней — сворачиваемая панель: часы, ближайший план, привычки, задачи, скоро. Отпущена — клики проходят сквозь окно,
// кроме самой фигурки и облачка (main.js включает мышь, пока курсор над ними).

let data = null;
let grabbed = false;
let collapsed = false;
let lastNotice = 0;
let state = "idle"; // idle | think | sleep
let bubbleTimer = 0;
// Настройки виджета (main.js → settings.widget): что показывать на панели и где стоит горничная.
let cfg = { opacity: 0.92, side: "right", size: "m", sections: { next: true, habits: true, tasks: true, soon: true } };
const MAID_W = { s: 160, m: 196, l: 236 };


// --- звуки ---
const SOUNDS = {};
for (const n of ["pop", "ding", "send", "oops", "hey"]) {
  SOUNDS[n] = new Audio(`../assets/sounds/${n}.wav`);
  SOUNDS[n].volume = 0.45;
}
function play(name) {
  const a = SOUNDS[name];
  if (!a || localStorage.getItem("maid.mute")) return;
  a.currentTime = 0;
  a.play().catch(() => {});
}

const KIND = {
  diary: ["📓", "Дневник"], event: ["📅", "План"], task: ["✅", "Задача"], date: ["🎂", "Дата"], memory: ["🧠", "Память"],
  metric: ["📊", "Показатель"], money: ["💰", "Деньги"], habit: ["🔁", "Привычка"], mark: ["✔", "Отметка"], edit: ["✎", "Правка"],
};

// --- горничная: 20 анимаций (assets/maid/<имя>.webp, исходники — «А ПРИКОЛЫ/Маскот/Анимации») ---
// Основа — ждёт / думает / спит / нет связи; на события она на несколько секунд реагирует (react), потом возвращается к основе.
const MOODS = ["idle", "think", "sleep", "happy", "proud", "angry", "sad", "worried", "surprised", "neutral",
  "hello", "listen", "write", "done", "remind", "clean", "tea", "streak", "offline", "bow"];
for (const n of MOODS) new Image().src = `../assets/maid/${n}.webp`;
// Эмоция ответа сервера → анимация.
const EMOTION_MOOD = { neutral: "neutral", happy: "happy", proud: "proud", angry: "angry", sad: "sad", worried: "worried",
  surprised: "surprised", thinking: "think", sleepy: "sleep" };
let mood = "";
let moodUntil = 0;
let moodTimer = 0;
let online = true;
function baseMood() {
  if (state === "think") return "think";
  if (!online) return "offline";
  return state === "sleep" ? "sleep" : "idle";
}
function showMood(n) {
  if (n === mood || !MOODS.includes(n)) return;
  mood = n;
  $("#face").src = `../assets/maid/${n}.webp`;
}
function react(n, ms = 6000) {
  clearTimeout(moodTimer);
  moodUntil = Date.now() + ms;
  showMood(n);
  moodTimer = setTimeout(() => { moodUntil = 0; showMood(baseMood()); }, ms);
}
function settle() {
  if (Date.now() < moodUntil) return;
  showMood(baseMood());
}

// --- состояния ---
function setState(s) {
  state = s;
  // Думает — сразу, поверх любой реакции.
  if (s === "think") { clearTimeout(moodTimer); moodUntil = 0; }
  settle();
}
function isNight() {
  const h = new Date().getHours();
  return h >= 23 || h < 7;
}
setInterval(() => {
  if (state === "think") return;
  const want = isNight() ? "sleep" : "idle";
  if (want !== state) setState(want);
  // Изредка, пока ничего не происходит, — занимается своим: чай (утром чаще), уборка, поклон.
  else if (state === "idle" && online && Date.now() > moodUntil && $("#bubble").classList.contains("hidden") && Math.random() < 0.1) {
    const h = new Date().getHours();
    const pick = h < 11 && Math.random() < 0.5 ? "tea" : ["tea", "clean", "clean", "bow"][Math.floor(Math.random() * 4)];
    react(pick, 6000);
  }
}, 30_000);

// --- облачко ---
function say(text, { buttons = [], emotion = "neutral", ms = 14000, changes = [], undo = null, sound = null, days = [], mood: as = null } = {}) {
  const b = $("#bubble");
  // Ответ на вопрос со ссылками на дни: строку «📅 …» заменяют кнопки дней.
  if (days.length) text = text.replace(/\n📅 .*$/, "");
  // Ответ без карточек — текст целиком; с карточками — только первая строка (остальное показывают карточки).
  const plain = changes.length ? text.split("\n")[0] : text;
  $("#bubbleText").innerHTML = tgHtml(plain);
  const cards = $("#bubbleCards");
  cards.innerHTML = "";
  changes.forEach((c, i) => {
    const [icon, name] = KIND[c.kind] ?? ["•", c.kind];
    const el = document.createElement("div");
    el.className = `card k-${c.kind}`;
    el.style.animationDelay = `${160 + i * 140}ms`;
    el.innerHTML = `<span class="card-icon">${icon}</span><span class="card-body"><b>${esc(name)}</b> ${esc(c.title)}${c.detail ? `<span class="card-detail">${esc(c.detail)}</span>` : ""}</span>`;
    cards.appendChild(el);
    setTimeout(() => play("pop"), 160 + i * 140);
  });
  for (const d of days) {
    const el = document.createElement("button");
    el.className = "card day";
    el.textContent = "📅 " + humanDay(d).split(",")[0];
    el.onclick = () => maid.openDay(d);
    cards.appendChild(el);
  }
  const acts = $("#bubbleActions");
  acts.innerHTML = buttons.map((x, i) => `<button data-i="${i}">${esc(x.text)}</button>`).join("")
    + (undo ? `<button data-i="undo">↩ Отменить</button>` : "") + `<button class="ghost" data-i="close">✕</button>`;
  acts.querySelectorAll("button").forEach((btn) => {
    btn.onclick = async () => {
      if (btn.dataset.i === "close") return hideBubble();
      if (btn.dataset.i === "undo") {
        try {
          const r = await maid.api("POST", "/api/undo", { messageId: undo });
          play("send");
          say(r.text, { ms: 6000 });
          maid.changed();
        } catch (e) {
          play("oops");
          say(e.message, { ms: 6000 });
        }
        return;
      }
      const x = buttons[Number(btn.dataset.i)];
      const m = x.data.match(/^habit:(\d+):(\d{4}-\d{2}-\d{2}):(done|skipped)$/);
      try {
        if (m) {
          if (m[3] === "done") { popTone(3); react("streak", 4000); } else { popTone(-5, { vol: 0.2, soft: true }); react("sad", 3500); }
          const r = await maid.api("POST", `/api/habits/${m[1]}/mark`, { status: m[3], day: m[2] });
          say(r.text, { ms: 5000 });
          maid.changed();
        } else hideBubble();
      } catch (e) {
        say(e.message, { ms: 6000 });
      }
    };
  });
  b.className = `bubble ${emotion}`;
  // Реакция горничной: записала что-то — пишет, отметила — галочка, иначе по эмоции ответа.
  if (text !== "…") {
    const marked = changes.some((c) => c.kind === "mark" || c.kind === "habit");
    const pick = as ?? (marked ? "done" : changes.length ? "write" : EMOTION_MOOD[emotion] ?? "neutral");
    react(pick, Math.max(4000, Math.min(ms || 9000, 9000)));
  }
  if (sound) play(sound);
  clearTimeout(bubbleTimer);
  if (ms) bubbleTimer = setTimeout(hideBubble, ms + changes.length * 900);
}

// --- чат с горничной ---
const chatInput = $("#chatInput");
let sending = false;
async function sendChat() {
  const text = chatInput.value.trim();
  if (!text || sending) return;
  sending = true;
  chatInput.value = "";
  chatInput.placeholder = text.length > 40 ? text.slice(0, 40) + "…" : text;
  play("send");
  setState("think");
  say("…", { ms: 0 });
  try {
    const r = await maid.api("POST", "/api/input", { text, id: crypto.randomUUID() });
    say(r.text, { emotion: r.emotion, changes: r.changes ?? [], days: r.days ?? [], undo: r.undoable ? r.messageId : null, ms: 16000, sound: r.changes?.length ? "ding" : null });
    maid.changed();
  } catch (e) {
    say(e.message, { emotion: "worried", ms: 8000, sound: "oops" });
  } finally {
    sending = false;
    chatInput.placeholder = "Скажи горничной…";
    setState(isNight() ? "sleep" : "idle");
    chatInput.focus();
  }
}
$("#chat").onsubmit = (e) => { e.preventDefault(); sendChat(); };
// Окно «сквозное» и без фокуса: навёл на строку чата — окно принимает мышь и клавиатуру, ушёл и не печатаешь — отдаёт.
const chatBox = $("#chat");
// Наведение только готовит окно (main.js делает его фокусируемым), фокус забирается щелчком — не крадём его у игры от одного наведения.
chatBox.addEventListener("mousedown", () => { maid.focusInput(true); chatInput.focus(); setTimeout(() => chatInput.focus(), 30); });
chatBox.addEventListener("mouseleave", () => { if (document.activeElement !== chatInput && !grabbed) maid.focusInput(false); });
chatInput.addEventListener("blur", () => { if (!grabbed) maid.focusInput(false); });
chatInput.addEventListener("keydown", (e) => { if (e.key === "Escape") chatInput.blur(); });
function hideBubble() {
  $("#bubble").classList.add("hidden");
  maid.hover(false);
}

// --- панель ---
function minutesUntil(e) {
  if (!e.time) return null;
  const [h, m] = e.time.split(":").map(Number);
  const now = new Date();
  return h * 60 + m - (now.getHours() * 60 + now.getMinutes());
}

function render() {
  const now = new Date();
  const sec = cfg.sections;
  $("#clock").textContent = now.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  if (!data) {
    $("#next").innerHTML = `<span class="muted">Нет связи с сервером</span>`;
    $("#body").innerHTML = "";
    renderCourses();
    return;
  }
  $("#day").textContent = humanDay(data.day);
  const next = data.events.find((e) => (minutesUntil(e) ?? 1) > -30) ?? data.upcoming[0];
  if (next) {
    const m = next.date_iso === data.day ? minutesUntil(next) : null;
    const when = m === null ? (next.date_iso === data.day ? "сегодня" : humanDay(next.date_iso)) : m <= 0 ? "сейчас" : m < 60 ? `через ${m} мин` : `в ${next.time}`;
    $("#next").innerHTML = `<b>${esc(when)}</b> · ${esc(next.title)}`;
  } else $("#next").innerHTML = `<span class="muted">Планов нет</span>`;
  // Один список «Задачи» вместо отдельных разделов. Порядок:
  //   1) ежедневное на сегодня, ещё не отмеченное (привычки и курсы — «Пить Аевит · день 9 из 30»);
  //   2) задачи: сначала важные, потом обычные, потом «когда-нибудь»;
  //   3) ежедневное, уже отмеченное сегодня, — внизу бледным (щелчок — передумать).
  const daily = (sec.habits ? data.habits ?? [] : []).filter((h) => h.course?.find((x) => x.day === data.day)?.s !== "rest");
  const dayItem = (h) => {
    const i = h.course?.length ? h.course.findIndex((x) => x.day === data.day) : -1;
    const sub = i >= 0 ? ` <span class="muted">· день ${i + 1} из ${h.course.length}</span>` : h.streak >= 2 ? ` <span class="muted">🔥${h.streak}</span>` : "";
    return `<li class="${h.status ? "did" : ""}"><span class="mark ${h.status ?? ""}" data-habit="${h.id}">${h.status === "done" ? "✓" : h.status === "skipped" ? "–" : ""}</span><span>${esc(h.title)}${sub}</span></li>`;
  };
  const RANK = { high: 0, normal: 1, low: 2 };
  const tasks = [...data.tasks].sort((a, b) => (RANK[a.priority] ?? 1) - (RANK[b.priority] ?? 1));
  const shownTasks = tasks.slice(0, 6);
  const todo = daily.filter((h) => !h.status);
  const items = [
    ...todo.map(dayItem),
    ...(sec.tasks ? shownTasks : []).map((t) => `<li><span class="check" data-done="${t.id}"></span><span class="${t.priority === "high" ? "high" : ""}">${esc(t.title)}</span></li>`),
    ...daily.filter((h) => h.status).map(dayItem),
  ];
  const left = todo.length + (sec.tasks ? data.tasks.length : 0);
  const soon = (sec.soon ? data.dates : []).filter((d) => d.inDays <= 7).map((d) => `<li><span class="time">${dateWhen(d)}</span><span>${esc(d.title)}</span></li>`);
  $("#body").innerHTML =
    (sec.tasks || daily.length ? `<h4>Задачи${left > 3 ? ` · ${left}` : ""}</h4>${items.length ? `<ul class="list">${items.join("")}</ul>` : `<p class="empty small">Нет</p>`}` : "") +
    (soon.length ? `<h4>Скоро</h4><ul class="list">${soon.join("")}</ul>` : "");
  renderCourses();
}

let lastJson = "";
async function load() {
  try {
    const fresh = await maid.api("GET", "/api/today");
    const json = JSON.stringify(fresh);
    data = fresh;
    if (!online) { online = true; settle(); }
    // Опрос каждые 5 с: перерисовывать только когда что-то изменилось, иначе сбивается прокрутка списка.
    if (json === lastJson) return;
    lastJson = json;
  } catch {
    // Нет связи — старые данные пока оставить, следующий опрос через 5 с.
    if (online) { online = false; settle(); }
    if (data) return;
  }
  render();
}

// Лента уведомлений: что ушло в Telegram — показать и здесь, с кнопками.
async function pollNotices() {
  try {
    const rows = await maid.api("GET", `/api/notices?after=${lastNotice}`);
    if (!lastNotice) {
      // Первый запрос — только запомнить, где мы; старое не показываем.
      lastNotice = rows[0]?.id ?? 0;
      return;
    }
    for (const n of rows.reverse()) {
      lastNotice = Math.max(lastNotice, n.id);
      const emotion = /🎮/.test(n.text) ? "angry" : n.emotion;
      // Напоминание с кнопками — звонит в колокольчик.
      say(n.text, { buttons: n.buttons, emotion, ms: n.buttons.length ? 0 : 20000, sound: "hey", mood: n.buttons.length ? "remind" : null });
    }
  } catch {
    /* нет связи — молчим */
  }
}

function setCollapsed(on) {
  collapsed = on;
  $("#w").classList.toggle("hidden", on);
  $("#stage").classList.toggle("folded", on);
  localStorage.setItem("maid.collapsed", on ? "1" : "");
}

// --- настройки виджета ---
function applyCfg() {
  const st = $("#stage");
  st.classList.remove("side-left", "side-right");
  st.classList.add(`side-${cfg.side}`);
  st.classList.toggle("no-maid", cfg.side === "none");
  const w = MAID_W[cfg.size] ?? MAID_W.m;
  st.style.setProperty("--maid-w", `${w}px`);
  // За панелью прячется только низ корсета — фигурка почти целиком над краем.
  st.style.setProperty("--peek", `${Math.round(w * 0.13)}px`);
  $("#w").style.opacity = String(cfg.opacity);
  $("#next").classList.toggle("hidden", !cfg.sections.next || prefsOpen);
}
async function loadCfg() {
  const s = await maid.settings();
  const w = s.widget ?? {};
  cfg = { opacity: w.opacity ?? 0.92, side: w.side === "center" ? "right" : w.side ?? "right", size: w.size ?? "m", sections: { ...cfg.sections, ...w.sections } };
  applyCfg();
  if (prefsOpen) drawPrefs();
}
function saveCfg(patch) {
  Object.assign(cfg, patch);
  applyCfg();
  render();
  drawPrefs();
  maid.saveSettings({ widget: patch });
}

let prefsOpen = false;
function togglePrefs(on = !prefsOpen) {
  prefsOpen = on;
  $("#gear").classList.toggle("on", on);
  $("#prefs").classList.toggle("hidden", !on);
  $("#body").classList.toggle("hidden", on);
  $("#w").classList.toggle("prefs-open", on);
  applyCfg();
  if (on) drawPrefs();
  renderCourses();
}
const SECTIONS = [["next", "Ближайший план"], ["habits", "Привычки"], ["tasks", "Задачи"], ["soon", "Скоро"]];
function seg(name, value, opts) {
  return `<div class="seg" data-seg="${name}">${opts.map(([v, t]) => `<button type="button" data-v="${v}" class="${String(value) === v ? "on" : ""}">${t}</button>`).join("")}</div>`;
}
function drawPrefs() {
  if (!prefsOpen) return;
  const muted = Boolean(localStorage.getItem("maid.mute"));
  $("#prefs").innerHTML = `
    <div class="pref"><span>Показывать на панели</span><div class="checks">${SECTIONS.map(([k, t]) =>
      `<label class="tick"><input type="checkbox" data-sec="${k}" ${cfg.sections[k] ? "checked" : ""}/>${t}</label>`).join("")}</div></div>
    <div class="pref"><span>Горничная</span>${seg("side", cfg.side, [["left", "Слева"], ["right", "Справа"], ["none", "Скрыть"]])}</div>
    <div class="pref"><span>Размер горничной</span>${seg("size", cfg.size, [["s", "Меньше"], ["m", "Обычная"], ["l", "Больше"]])}</div>
    <div class="pref"><span>Непрозрачность панели · ${Math.round(cfg.opacity * 100)}%</span><input type="range" id="prefOpacity" min="0.4" max="1" step="0.02" value="${cfg.opacity}" /></div>
    <div class="pref"><span>Звуки</span>${seg("sound", muted ? "off" : "on", [["on", "Включены"], ["off", "Выключены"]])}</div>
    <div class="row2"><button type="button" id="prefReset">Вернуть в угол</button><button type="button" id="prefDone" class="primary">Готово</button></div>`;
}
$("#prefs").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.id === "prefDone") return togglePrefs(false);
  if (b.id === "prefReset") return maid.resetWidget();
  const kind = b.parentElement?.dataset.seg;
  if (kind === "sound") {
    localStorage.setItem("maid.mute", b.dataset.v === "off" ? "1" : "");
    drawPrefs();
    if (b.dataset.v === "on") play("pop");
  } else if (kind) saveCfg({ [kind]: b.dataset.v });
});
$("#prefs").addEventListener("change", (e) => {
  const k = e.target.dataset?.sec;
  if (k) saveCfg({ sections: { ...cfg.sections, [k]: e.target.checked } });
  else if (e.target.id === "prefOpacity") saveCfg({ opacity: Number(e.target.value) });
});
$("#prefs").addEventListener("input", (e) => {
  if (e.target.id !== "prefOpacity") return;
  cfg.opacity = Number(e.target.value);
  $("#w").style.opacity = String(cfg.opacity);
  e.target.previousElementSibling.textContent = `Непрозрачность панели · ${Math.round(cfg.opacity * 100)}%`;
});
// Кнопка в шапке — полная версия приложения; настройки виджета — правым щелчком по ней (или если они уже открыты — закрыть).
$("#gear").addEventListener("click", (e) => {
  e.stopPropagation();
  if (prefsOpen) return togglePrefs(false);
  maid.openMain();
});
$("#gear").addEventListener("contextmenu", (e) => {
  e.preventDefault();
  e.stopPropagation();
  togglePrefs();
});

// --- перетаскивание за шапку: окно двигает main.js по курсору (так верно и на экранах с разным масштабом) ---
const head = $("#head");
head.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || grabbed || e.target.closest("button")) return;
  head.setPointerCapture(e.pointerId);
  head.classList.add("dragging");
  maid.dragWidget("start");
});
head.addEventListener("pointermove", (e) => {
  if (head.hasPointerCapture(e.pointerId)) maid.dragWidget("move");
});
const endDrag = (e) => {
  if (!head.hasPointerCapture(e.pointerId)) return;
  head.releasePointerCapture(e.pointerId);
  head.classList.remove("dragging");
  maid.dragWidget("end");
};
head.addEventListener("pointerup", endDrag);
head.addEventListener("pointercancel", endDrag);
// Захват потерян или кнопку отпустили где-то ещё — окно не должно остаться приклеенным к курсору.
const dropDrag = () => {
  if (!head.classList.contains("dragging")) return;
  head.classList.remove("dragging");
  maid.dragWidget("end");
};
head.addEventListener("lostpointercapture", dropDrag);
document.addEventListener("pointerup", dropDrag);
window.addEventListener("blur", dropDrag);

// --- связь с main и мышь ---
maid.on("grab", (on) => {
  grabbed = on;
  $("#stage").classList.toggle("grab", on);
});
maid.on("changed", () => { loadCfg(); load(); });
maid.on("thinking", (on) => setState(on ? "think" : isNight() ? "sleep" : "idle"));
maid.on("reply", (r) => say(r.text, { emotion: r.emotion, ms: 12000, changes: r.changes ?? [], days: r.days ?? [], undo: r.undoable ? r.messageId : null, sound: r.changes?.length ? "ding" : null }));
maid.on("opacity", (o) => { cfg.opacity = o; applyCfg(); });

// Окно сквозное везде, кроме панели, облачка и фигурки: main.js следит за курсором по этим прямоугольникам
// (forward-события мыши у «сквозного» окна на Windows ненадёжны, поэтому опрос курсора).
function reportRegions() {
  const rects = [];
  for (const el of [$("#w"), $("#bubble"), $("#maid")]) {
    if (el.offsetParent === null) continue;
    if (el.classList.contains("hidden")) continue;
    const r = el.getBoundingClientRect();
    if (r.width && r.height) rects.push({ x: r.left, y: r.top, w: r.width, h: r.height });
  }
  const c = $("#chat").getBoundingClientRect();
  if (c.width && $("#w").offsetParent !== null && !$("#w").classList.contains("hidden")) rects.push({ x: c.left, y: c.top, w: c.width, h: c.height, chat: true });
  maid.regions(rects);
}
setInterval(reportRegions, 300);
let clickTimer = 0;
$("#maid").addEventListener("click", () => {
  clearTimeout(clickTimer);
  clickTimer = setTimeout(() => setCollapsed(!collapsed), 220);
});
$("#maid").addEventListener("dblclick", () => {
  clearTimeout(clickTimer);
  react("listen", 5000);
  maid.openQuick();
});
$("#maid").addEventListener("contextmenu", (e) => {
  e.preventDefault();
  maid.grab(!grabbed);
});

$("#open").onclick = () => maid.openMain();
$("#release").onclick = () => maid.grab(false);
$("#body").addEventListener("click", async (e) => {
  const id = e.target.dataset?.done;
  const habit = e.target.dataset?.habit;
  try {
    if (id) {
      // Галочка задачи: чпок и брызги сразу, потом сервер.
      e.target.classList.add("done", "pressed");
      popTone(4);
      burst(e.target);
      react("done", 4000);
      await maid.api("POST", `/api/tasks/${id}`, { status: "done" });
      maid.changed();
    } else if (habit) {
      const was = e.target.classList.contains("done");
      e.target.classList.toggle("done", !was);
      e.target.classList.add("pressed");
      if (was) { popTone(-5, { vol: 0.2, soft: true }); react("sad", 3500); }
      else { popTone(2); burst(e.target); react("streak", 4000); }
      await maid.api("POST", `/api/habits/${habit}/mark`, { status: was ? "skipped" : "done" });
      maid.changed();
    }
  } catch (err) {
    play("oops");
    say(err.message, { ms: 6000 });
    load();
  }
});

setCollapsed(Boolean(localStorage.getItem("maid.collapsed")));
setState(isNight() ? "sleep" : "idle");
if (!isNight()) react("hello", 4500);
setInterval(render, 15_000);
// Что записано из Telegram или с телефона — появляется здесь через несколько секунд.
setInterval(load, 5_000);
setInterval(pollNotices, 5_000);
loadCfg().then(load);
pollNotices();
maid.widgetReady();
