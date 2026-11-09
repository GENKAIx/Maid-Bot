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
// Циферблат планов (Часы 12/24) пока выключен: код в clock.js остаётся, в настройках его нет, сохранённый выбор показывается списком.
const CLOCK_DIAL = false;
const dialOff = (v) => (!CLOCK_DIAL && (v === "12" || v === "24") ? "list" : v);
let cfg = { opacity: 0.92, side: "right", size: "m", sections: { next: true, habits: true, tasks: true, soon: true }, clock: "list", dateLead: "1", doneTasks: "keep" };
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

// Куда ведёт карточка записи из облачка: раздел приложения (веб-приложение в главном окне).
function sectionOf(c) {
  if (c.kind === "diary") return /^Здоровье/.test(c.title) ? "/health" : `/diary/${data?.day ?? ""}`.replace(/\/$/, "");
  return { event: "/plans", task: "/plans", date: "/plans", money: "/money", metric: "/health", habit: "/habits", mark: "/habits" }[c.kind] ?? "/";
}

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
  if (state === "sleep") return "sleep";
  // День не задался (просрочено, не отмечено) — грустно метёт (fun.js, dayMood).
  return typeof dayMood !== "undefined" && dayMood === "bad" ? "clean" : "idle";
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
  // День идёт хорошо — радуется чаще, сама по себе.
  else if (state === "idle" && online && dayMood === "good" && Date.now() > moodUntil && $("#bubble").classList.contains("hidden") && Math.random() < 0.25)
    react(["happy", "proud", "happy", "bow"][Math.floor(Math.random() * 4)], 5000);
  // Не задался — изредка вздыхает.
  else if (state === "idle" && online && dayMood === "bad" && Date.now() > moodUntil && Math.random() < 0.12) react("sad", 5000);
}, 30_000);

// --- облачко ---
function say(text, { buttons = [], emotion = "neutral", ms = 14000, changes = [], undo = null, sound = null, days = [], mood: as = null, heard = "", notice = null } = {}) {
  const b = $("#bubble");
  delete b.dataset.quip;
  // Ответ на вопрос со ссылками на дни: строку «📅 …» заменяют кнопки дней.
  if (days.length) text = text.replace(/\n📅 .*$/, "");
  // Ответ без карточек — текст целиком; с карточками — только первая строка (остальное показывают карточки).
  const plain = changes.length ? text.split("\n")[0] : text;
  $("#bubbleText").innerHTML = (heard ? `<div class="heard">🎙 ${esc(heard)}</div>` : "") + tgHtml(plain);
  const cards = $("#bubbleCards");
  cards.innerHTML = "";
  changes.forEach((c, i) => {
    const [icon, name] = KIND[c.kind] ?? ["•", c.kind];
    const el = document.createElement("div");
    el.className = `card k-${c.kind} go`;
    el.title = "Открыть в приложении";
    el.onclick = () => {
      hideBubble();
      maid.openSection(sectionOf(c));
    };
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
  // Напоминание из ящика (inbox.js): любая кнопка или ✕ — прочитано; без кнопок — если курсор задержался на облачке.
  b.dataset.notice = notice ?? "";
  $("#inbox").classList.add("away"); // пока говорит — значок не мешает облачку
  b.onmouseenter = notice && !buttons.length
    ? () => setTimeout(() => { if (b.dataset.notice === String(notice) && !b.classList.contains("hidden")) inboxRead(notice); }, 1200)
    : null;
  acts.querySelectorAll("button").forEach((btn) => {
    btn.onclick = async () => {
      if (notice) inboxRead(notice);
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
      // Кнопка из самого виджета (не из уведомления сервера) — своё действие.
      if (x.run) {
        hideBubble();
        return x.run();
      }
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
  // Длинный текст висит дольше (время на чтение), а под курсором не пропадает вовсе — см. hideBubbleWhenFree.
  if (ms) bubbleTimer = setTimeout(hideBubbleWhenFree, ms + changes.length * 900 + Math.min(60000, Math.max(0, plain.length - 120) * 55));
}

// Облачко ждёт, пока курсор на нём, и ещё немного после того, как его увели.
let bubbleLeftAt = 0;
$("#bubble").addEventListener("mouseleave", () => (bubbleLeftAt = Date.now()));
function hideBubbleWhenFree() {
  if ($("#bubble").matches(":hover") || Date.now() - bubbleLeftAt < 2500) return (bubbleTimer = setTimeout(hideBubbleWhenFree, 400));
  hideBubble();
}

// --- чат с горничной ---
const chatInput = $("#chatInput");
let sending = false;
async function sendChat() {
  const text = chatInput.value.trim();
  if (!text || sending) return;
  chatInput.value = "";
  fitChat();
  await ask("/api/input", { text, id: crypto.randomUUID() }, text.length > 40 ? text.slice(0, 40) + "…" : text);
}
async function ask(path, body, waiting) {
  sending = true;
  chatInput.placeholder = waiting;
  play("send");
  setState("think");
  say("…", { ms: 0 });
  try {
    const r = await maid.api("POST", path, body);
    say(r.text, { emotion: r.emotion, changes: r.changes ?? [], days: r.days ?? [], undo: r.undoable ? r.messageId : null, ms: 16000, sound: r.changes?.length ? "ding" : null, heard: r.heard });
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

// --- голосом: щелчок по микрофону — запись, ещё щелчок (или Enter) — отправить, Esc — отменить ---
const mic = $("#chatMic");
let micTick = 0;
function micUi(on) {
  mic.classList.toggle("rec", on);
  mic.title = on ? "Отправить запись (Enter)" : "Сказать голосом";
  chatBox.classList.toggle("recording", on);
  clearInterval(micTick);
  if (!on) return;
  const time = chatBox.querySelector(".rec-time");
  const show = () => (time.textContent = Voice.clock());
  show();
  micTick = setInterval(show, 250);
  Voice.wave(chatBox.querySelector(".rec-wave"), "#cdbcff");
}
async function toggleMic() {
  if (sending) return;
  if (!Voice.on) {
    try {
      await Voice.start(toggleMic);
    } catch (e) {
      return say(`Нет доступа к микрофону: ${e.message}`, { emotion: "worried", ms: 8000, sound: "oops" });
    }
    micUi(true);
    chatInput.focus();
    return;
  }
  micUi(false);
  const v = await Voice.stop();
  if (v) await ask("/api/voice", { ...v, id: crypto.randomUUID() }, "🎙 Распознаю…");
}
mic.addEventListener("click", (e) => { e.preventDefault(); toggleMic(); });
const dropRecording = () => Voice.cancel().then(() => { micUi(false); play("oops"); });
// Пока идёт запись, строки ввода нет: Enter — отправить, Esc — удалить ловятся на всём окне.
document.addEventListener("keydown", (e) => {
  if (!Voice.on) return;
  if (e.key === "Escape") { e.preventDefault(); dropRecording(); }
  else if (e.key === "Enter") { e.preventDefault(); toggleMic(); }
});
document.querySelector("#chat .rec-trash").addEventListener("click", (e) => { e.preventDefault(); dropRecording(); });
$("#chat").onsubmit = (e) => { e.preventDefault(); if (Voice.on) toggleMic(); else sendChat(); };
// Окно «сквозное» и без фокуса: навёл на строку чата — окно принимает мышь и клавиатуру, ушёл и не печатаешь — отдаёт.
const chatBox = $("#chat");
// Наведение только готовит окно (main.js делает его фокусируемым), фокус забирается щелчком — не крадём его у игры от одного наведения.
chatBox.addEventListener("mousedown", () => { maid.focusInput(true); chatInput.focus(); setTimeout(() => chatInput.focus(), 30); });
chatBox.addEventListener("mouseleave", () => { if (document.activeElement !== chatInput && !grabbed) maid.focusInput(false); });
chatInput.addEventListener("blur", () => { if (!grabbed) maid.focusInput(false); });
// Enter — отправить, Shift+Enter — новая строка; поле растёт по тексту (до пяти строк, дальше прокрутка).
function fitChat() {
  chatInput.style.height = "auto";
  chatInput.style.height = `${chatInput.scrollHeight + 2}px`;
}
chatInput.addEventListener("input", fitChat);
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") return chatInput.blur();
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("#chat").requestSubmit();
  }
});
function hideBubble() {
  $("#bubble").classList.add("hidden");
  maid.hover(false);
  $("#inbox").classList.remove("away");
}

// --- панель ---
function minutesUntil(e) {
  if (!e.time) return null;
  const [h, m] = e.time.split(":").map(Number);
  const now = new Date();
  return h * 60 + m - (now.getHours() * 60 + now.getMinutes());
}

function render() {
  // Строка улетает или список смыкается — не пересобирать его посреди анимации (иначе строка прыгает назад), дорисовать после.
  if (Date.now() < animUntil) {
    clearTimeout(animWait);
    animWait = setTimeout(render, animUntil - Date.now() + 5);
    return;
  }
  const now = new Date();
  const sec = cfg.sections;
  $("#clock").textContent = $("#miniClock").textContent = now.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  if (!data) {
    $("#next").innerHTML = `<span class="muted">Нет связи с сервером</span>`;
    $("#body").innerHTML = "";
    renderCourses();
    return;
  }
  $("#day").textContent = humanDay(data.day);
  $("#miniDay").textContent = miniDay(data.day);
  const next = data.events.find((e) => (minutesUntil(e) ?? 1) > -30) ?? data.upcoming[0];
  $("#next").dataset.day = next?.date_iso ?? "";
  if (next) {
    const m = next.date_iso === data.day ? minutesUntil(next) : null;
    const when = m === null ? (next.date_iso === data.day ? "сегодня" : humanDay(next.date_iso)) : m <= 0 ? "сейчас" : m < 60 ? `через ${m} мин` : `в ${next.time}`;
    $("#next").innerHTML = `<b>${esc(when)}</b> · ${esc(next.title)}`;
  } else $("#next").innerHTML = `<span class="muted">Планов нет</span>`;
  // Важные даты — над ближайшим планом (за cfg.dateLead дней; убрать — в списке планов).
  const pins = datesOf(data.day);
  $("#pins").innerHTML = pins.map((d) => `<div class="pin" data-day="${d.on}">${dateText(d, data.day)}</div>`).join("");
  // Один список «Задачи» вместо отдельных разделов. Порядок:
  //   1) ежедневное на сегодня, ещё не отмеченное (привычки и курсы — «Пить Аевит · день 9 из 30»);
  //   2) задачи: сначала важные, потом обычные, потом «когда-нибудь»;
  //   3) ежедневное, уже отмеченное сегодня, — внизу бледным (щелчок — передумать).
  const daily = (sec.habits ? data.habits ?? [] : []).filter((h) => h.course?.find((x) => x.day === data.day)?.s !== "rest");
  const dayItem = (h) => {
    const i = h.course?.length ? h.course.findIndex((x) => x.day === data.day) : -1;
    const sub = i >= 0 ? ` <span class="muted">· день ${i + 1} из ${h.course.length}</span>` : h.streak >= 2 ? ` <span class="muted">🔥${h.streak}</span>` : "";
    const go = leavingRows.get(`h${h.id}`);
    if (go?.gone) return `<li class="undo-row${undoFresh(go)}" data-key="h${h.id}"><button type="button" class="undo-back" data-undo="h${h.id}">↶ Вернуть</button></li>`;
    if (go) return `<li class="${rowLeaving(go)}" data-key="h${h.id}"><span class="mark done" data-habit="${h.id}" title="Отменить">${UNDO_MARK}</span><span>${esc(h.title)}${sub}</span></li>`;
    return `<li class="${h.status ? "did" : ""}"><span class="mark ${h.status ?? ""}" data-habit="${h.id}">${h.status === "done" ? "✓" : h.status === "skipped" ? "–" : ""}</span><span>${esc(h.title)}${sub}</span></li>`;
  };
  const RANK = { high: 0, normal: 1, low: 2 };
  const tasks = [...data.tasks].sort((a, b) => (RANK[a.priority] ?? 1) - (RANK[b.priority] ?? 1));
  const shownTasks = tasks.filter((t) => !doneNow.has(t.id)).slice(0, 6);
  const todo = daily.filter((h) => !h.status);
  const hiding = cfg.doneTasks === "hide";
  // Вчерашний пропуск, который ещё можно спасти задним числом (fun.js).
  const rescueItem = (h) => `<li class="rescue"><span class="mark" data-rescue="${h.id}" title="Отметить вчерашний день"></span><span>${esc(h.title)} <span class="muted">· вчера — спасти серию</span></span></li>`;
  const items = [
    ...todo.map(dayItem),
    ...daily.filter(missedYesterday).map(rescueItem),
    ...(sec.tasks ? shownTasks : []).map((t) => {
      const go = leavingRows.get(`t${t.id}`);
      if (go?.gone) return `<li class="undo-row${undoFresh(go)}" data-key="t${t.id}"><button type="button" class="undo-back" data-undo="t${t.id}">↶ Вернуть</button></li>`;
      return go
        ? `<li class="${rowLeaving(go)}" data-key="t${t.id}"><span class="check done" data-done="${t.id}" title="Отменить">${UNDO_MARK}</span><span class="${t.priority === "high" ? "high" : ""}">${esc(t.title)}</span></li>`
        : `<li><span class="check" data-done="${t.id}"></span><span class="${t.priority === "high" ? "high" : ""}">${esc(t.title)}</span></li>`;
    }),
    // Сделанное: в режиме «прятать» — только пока открыт счётчик.
    ...(hiding && !showingDone() ? [] : [
      ...daily.filter((h) => h.status).map(dayItem),
      ...(sec.tasks ? recentDone() : []).map((t) => `<li class="did"><span class="check done">✓</span><span>${esc(t.title)}</span></li>`),
    ]),
  ];
  // Улетевшие, но ещё не отправленные (идёт «Вернуть») уже считаются сделанными.
  const gone = [...leavingRows.values()].filter((x) => x.gone).length;
  const left = todo.length + (sec.tasks ? data.tasks.filter((t) => !doneNow.has(t.id)).length : 0) - gone;
  const doneCount = daily.filter((h) => h.status).length + (sec.tasks ? recentDone().length : 0) + gone;
  const allDone = hiding && !left && doneCount > 0;
  if (allDone && lastLeft > 0) { react("proud", 5000); allDoneAt = Date.now(); }
  lastLeft = left;
  renderMini(tasks.filter((t) => !doneNow.has(t.id)), todo, left);
  const bump = Date.now() - bumpAt < 600 ? " bump" : "";
  const counter = hiding && doneCount
    ? ` <button type="button" class="done-count${showingDone() ? " on" : ""}${allDone ? " all" : ""}${bump}" id="doneCount" title="${showingDone() ? "Спрятать сделанное" : "Показать сделанное"}">${doneCount}/${doneCount + left}</button>`
    : left > 3 ? ` · ${left}` : "";
  const pinned = new Set(datesOf(data.day, true).map(dateKey));
  const soon = (sec.soon ? data.dates : []).filter((d) => d.inDays <= 7 && !pinned.has(dateKey(d))).map((d) => `<li><span class="time">${dateWhen(d)}</span><span>${esc(d.title)}</span></li>`);
  $("#body").innerHTML =
    (sec.tasks || daily.length ? `<h4>Задачи${counter}</h4>${items.length ? `<ul class="list">${items.join("")}</ul>` : ""}${allDone && !showingDone() ? `<p class="all-done${Date.now() - allDoneAt < 400 ? " fresh" : ""}">Всё на сегодня ✨</p>` : items.length ? "" : `<p class="empty small">Нет</p>`}` : "") +
    (soon.length ? `<h4>Скоро</h4><ul class="list">${soon.join("")}</ul>` : "");
  if (hiding && Date.now() - peekAt < 300) for (const li of $("#body").querySelectorAll("li.did")) li.classList.add("shown-done");
  for (const li of $("#body").querySelectorAll("li.leaving")) {
    const x = leavingRows.get(li.dataset.key);
    if (x) li.style.setProperty("--fill-delay", `-${Math.min((x.pausedAt || Date.now()) - x.at, ROW_FADE)}ms`);
  }
  renderCourses();
  inboxTidy();
}

// --- Сделанные задачи в режиме «прятать» (cfg.doneTasks === "hide") ---
// Отметил — строка ROW_FADE мс заливается цветом слева направо, улетает вправо, и список смыкается; только тогда отметка уходит
// на сервер. До этого галочка при наведении — ×: отменить. Мышь вернулась на строку после щелчка — заливка стоит.
// Счётчик «сделано/всего» у заголовка — щелчок показывает сделанное зачёркнутым, пока мышь не уйдёт со списка.
const ROW_FADE = 3000;
const ROW_FLY = 380;
const ROW_SHUT = 220;
const DONE_PEEK = 30000; // запасной срок: обычно сделанное прячется, когда мышь уходит со списка
const UNDO_MARK = "<i>✓</i><b>×</b>";
const UNDO_WINDOW = 3000; // сколько после улёта висит «↶ Вернуть»; отметка уходит на сервер только после него
let bumpAt = 0; // когда счётчик последний раз получил «+1»
let lastLeft = -1;
let allDoneAt = 0;
let peekAt = 0; // когда открыли сделанное — появление проигрывается только тогда, не при каждой перерисовке
let animUntil = 0; // до этого времени список не перерисовывать (render)
let animWait = 0;
const undoFresh = (x) => (Date.now() - x.goneAt < 250 ? " fresh" : "");
const leavingRows = new Map(); // "t12" / "h3" → { at, pausedAt, armed, fly, title, timer }
let showDoneUntil = 0;
let showDoneTimer = 0;
const showingDone = () => Date.now() < showDoneUntil;
const rowLeaving = (x) => `leaving${x.fly ? " fly" : ""}${x.pausedAt ? " hold" : ""}`;
const rowEl = (key) => $("#body").querySelector(`li[data-key="${key}"]`);
$("#body").addEventListener("mouseleave", () => {
  if (!showingDone()) return;
  clearTimeout(showDoneTimer);
  showDoneUntil = 0;
  render();
});
function toggleShowDone() {
  clearTimeout(showDoneTimer);
  showDoneUntil = showingDone() ? 0 : Date.now() + DONE_PEEK;
  peekAt = showDoneUntil ? Date.now() : 0;
  if (showDoneUntil) showDoneTimer = setTimeout(render, DONE_PEEK + 30);
  render();
}
function startLeave(key, mark) {
  popTone(4);
  burst(mark);
  react("done", 4000);
  leavingRows.set(key, { at: Date.now(), pausedAt: 0, armed: false, fly: false, title: mark.nextElementSibling?.textContent ?? "" });
  render();
  rowCountdown(key);
}
function cancelLeave(key) {
  const x = leavingRows.get(key);
  if (!x || x.fly) return;
  clearTimeout(x.timer);
  leavingRows.delete(key);
  popTone(-5, { vol: 0.2, soft: true });
  render();
}
function rowCountdown(key) {
  const x = leavingRows.get(key);
  if (!x || x.pausedAt || x.fly) return;
  clearTimeout(x.timer);
  x.timer = setTimeout(() => rowFly(key), Math.max(0, ROW_FADE - (Date.now() - x.at)));
}
function rowHold(key, on) {
  const x = leavingRows.get(key);
  if (!x || x.fly) return;
  if (on && !x.pausedAt) {
    x.pausedAt = Date.now();
    clearTimeout(x.timer);
    rowEl(key)?.classList.add("hold");
  } else if (!on && x.pausedAt) {
    x.at += Date.now() - x.pausedAt;
    x.pausedAt = 0;
    rowEl(key)?.classList.remove("hold");
    rowCountdown(key);
  }
}
// Строка улетела — на её месте «↶ Вернуть» на UNDO_WINDOW мс (мышь на ней — ждёт), потом список смыкается и отметка уходит на сервер.
function rowFly(key) {
  const x = leavingRows.get(key);
  if (!x) return;
  x.fly = true;
  rowEl(key)?.classList.add("fly");
  animUntil = Date.now() + ROW_FLY;
  setTimeout(() => {
    if (leavingRows.get(key) !== x) return;
    x.gone = true;
    x.goneAt = bumpAt = Date.now();
    render();
    x.timer = setTimeout(() => rowCommit(key), UNDO_WINDOW);
  }, ROW_FLY);
}
function undoGone(key) {
  const x = leavingRows.get(key);
  if (!x || x.sent) return;
  clearTimeout(x.timer);
  leavingRows.delete(key);
  popTone(-5, { vol: 0.2, soft: true });
  render();
}
async function rowCommit(key) {
  const x = leavingRows.get(key);
  if (!x || x.sent) return;
  x.sent = true;
  const el = rowEl(key);
  if (el) {
    el.style.setProperty("height", `${el.offsetHeight}px`);
    void el.offsetHeight;
    el.classList.add("shut");
    animUntil = Date.now() + ROW_SHUT + 40;
    await new Promise((r) => setTimeout(r, ROW_SHUT + 40));
    animUntil = 0;
  }
  const id = Number(key.slice(1));
  const task = key[0] === "t";
  if (task) { keepDone(id, x.title); countDone(data.day); }
  else { const h = data?.habits?.find((v) => v.id === id); if (h) h.status = "done"; }
  leavingRows.delete(key);
  render();
  try {
    await maid.api("POST", task ? `/api/tasks/${id}` : `/api/habits/${id}/mark`, { status: "done" });
    maid.changed();
    if (!task) load();
  } catch (err) {
    play("oops");
    say(err.message, { ms: 6000 });
    load();
  }
}
// Виджет закрывают, пока висит «Вернуть», — отметить сразу, чтобы не потерять.
window.addEventListener("beforeunload", () => {
  for (const [key, x] of leavingRows) if (x.gone && !x.sent) maid.api("POST", key[0] === "t" ? `/api/tasks/${key.slice(1)}` : `/api/habits/${key.slice(1)}/mark`, { status: "done" });
});
// «Вернуть» под мышью не исчезает; ушла — ещё 1,2 с.
$("#body").addEventListener("mouseover", (e) => {
  const li = e.target.closest("li.undo-row");
  const x = li && leavingRows.get(li.dataset.key);
  if (x && !x.sent && !li.contains(e.relatedTarget)) clearTimeout(x.timer);
});
$("#body").addEventListener("mouseout", (e) => {
  const li = e.target.closest("li.undo-row");
  const x = li && leavingRows.get(li.dataset.key);
  if (!x || x.sent || li.contains(e.relatedTarget)) return;
  clearTimeout(x.timer);
  x.timer = setTimeout(() => rowCommit(li.dataset.key), 1200);
});
// Пауза заливки: мышь ушла со строки — «взвести», вернулась — стоп, ушла — дальше (наведение сразу после щелчка не в счёт).
$("#body").addEventListener("mouseover", (e) => {
  const li = e.target.closest("li.leaving");
  if (li && !li.contains(e.relatedTarget) && leavingRows.get(li.dataset.key)?.armed) rowHold(li.dataset.key, true);
});
$("#body").addEventListener("mouseout", (e) => {
  const li = e.target.closest("li.leaving");
  if (!li || li.contains(e.relatedTarget)) return;
  const x = leavingRows.get(li.dataset.key);
  if (x) x.armed = true;
  rowHold(li.dataset.key, false);
});

let lastJson = "";
async function load() {
  try {
    const fresh = await maid.api("GET", "/api/today");
    const json = JSON.stringify(fresh);
    data = fresh;
    forgetReopened(data.tasks);
    if (!online) { online = true; settle(); }
    // Опрос каждые 5 с: перерисовывать только когда что-то изменилось, иначе сбивается прокрутка списка.
    if (json === lastJson) return;
    lastJson = json;
  } catch {
    // Нет связи — старые данные пока оставить, следующий опрос через 5 с.
    if (online) { online = false; settle(); }
    if (data) return;
  }
  renderSoon();
  watchPlans();
  if (dayScore === null) tickDayMood();
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
      // В ящик непрочитанного (значок у головы) и сразу сказать; напоминание с кнопками — звонит в колокольчик.
      inboxAdd({ ...n, emotion });
      say(n.text, { buttons: n.buttons, emotion, ms: n.buttons.length ? 0 : 20000, sound: "hey", mood: n.buttons.length ? "remind" : null, notice: n.id });
    }
  } catch {
    /* нет связи — молчим */
  }
}

// Свёрнутая панель: точка на каждое несделанное (важные — оранжевые, обычные — сиреневые, «когда-нибудь» и привычки — серые).
function miniDay(day) {
  const [, m, d] = day.split("-").map(Number);
  return `${d} ${MONTHS[m - 1].slice(0, 3)}, ${humanDay(day).split(", ")[1]}`;
}
// Справа от точек — ближайший план сегодня («в 19:00 · Спортзал», «через 25 мин · …», «идёт · …»); планов больше нет — счёт задач.
function miniPlan() {
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  for (const e of data.events ?? []) {
    if (!e.time || (e.status && e.status !== "active")) continue;
    const [h, m] = e.time.split(":").map(Number);
    const start = h * 60 + m;
    const [eh, em] = (e.end_time ?? "").split(":").map(Number);
    const end = e.end_time ? eh * 60 + em : start + 30;
    if (end <= cur) continue;
    const when = start <= cur ? "идёт" : start - cur <= 60 ? `через ${start - cur} мин` : `в ${e.time}`;
    return { when, title: e.title, soon: start - cur <= 15 };
  }
  return null;
}
function renderMini(open, todo, left) {
  const dots = [...open.map((t) => t.priority === "high" ? "hi" : t.priority === "low" ? "lo" : "mid"), ...todo.map(() => "lo")];
  const more = dots.length > 6 ? `<i class="more">+${dots.length - 6}</i>` : "";
  const plan = miniPlan();
  const tasks = left > 0 ? `<span class="dots" title="Задачи: ${left}">${dots.slice(0, 6).map((k) => `<i class="${k}"></i>`).join("")}${more}</span>` : "";
  $("#miniTasks").innerHTML = plan
    ? `${tasks}<span class="mini-plan${plan.soon ? " soon" : ""}"><b>${esc(plan.when)}</b> · ${esc(plan.title)}</span>`
    : left > 0
      ? `${tasks}Задачи · ${left}`
      : `<span class="dots"><i class="ok"></i></span>Всё на сегодня ✨`;
}

function setCollapsed(on) {
  collapsed = on;
  if (on) hideClock();
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
  $("#w").style.opacity = $("#mini").style.opacity = String(cfg.opacity);
  $("#next").classList.toggle("hidden", !cfg.sections.next || prefsOpen);
  $("#pins").classList.toggle("hidden", prefsOpen);
}
async function loadCfg() {
  const s = await maid.settings();
  const w = s.widget ?? {};
  cfg = { opacity: w.opacity ?? 0.92, side: w.side === "center" ? "right" : w.side ?? "right", size: w.size ?? "m", sections: { ...cfg.sections, ...w.sections }, clock: dialOff(w.plans ?? "list"), dateLead: w.dateLead ?? "1", doneTasks: w.doneTasks === "hide" ? "hide" : "keep" }; // «plans» — с тех пор, как появился список (старое «clock» не переносим: по умолчанию теперь список)
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
  if (on) hideClock();
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
    <div class="pref"><span>Планы дня</span>${seg("clock", cfg.clock, [["list", "Список"], ...(CLOCK_DIAL ? [["12", "Часы 12"], ["24", "Часы 24"]] : []), ["off", "Нет"]])}</div>
    <div class="pref"><span>Важные даты</span>${seg("dateLead", String(cfg.dateLead), [["0", "В день"], ["1", "За день"], ["3", "За 3 дня"], ["7", "За неделю"]])}</div>
    <div class="pref"><span>Сделанные задачи</span><div class="done-modes">
      <button type="button" data-dmode="keep" class="dm${cfg.doneTasks === "keep" ? " on" : ""}">
        <div class="dm-mini"><b>Задачи</b><p><i></i>Купить хлеб</p><p class="did"><i>✓</i><s>Пить Аевит</s></p></div>
        <span>Остаются зачёркнутыми</span></button>
      <button type="button" data-dmode="hide" class="dm${cfg.doneTasks === "hide" ? " on" : ""}">
        <div class="dm-mini"><b>Задачи <em>1/2</em></b><p><i></i>Купить хлеб</p><p class="go"><i>✓</i><span>Пить Аевит</span></p></div>
        <span>Улетают, счётчик сделанного</span></button>
    </div></div>
    <div class="pref"><span>Звуки</span>${seg("sound", muted ? "off" : "on", [["on", "Включены"], ["off", "Выключены"]])}</div>
    <div class="row2"><button type="button" id="prefReset">Вернуть в угол</button><button type="button" id="prefDone" class="primary">Готово</button></div>`;
}
$("#prefs").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.id === "prefDone") return togglePrefs(false);
  if (b.id === "prefReset") return maid.resetWidget();
  if (b.dataset.dmode) return saveCfg({ doneTasks: b.dataset.dmode });
  const kind = b.parentElement?.dataset.seg;
  if (kind === "sound") {
    localStorage.setItem("maid.mute", b.dataset.v === "off" ? "1" : "");
    drawPrefs();
    if (b.dataset.v === "on") play("pop");
  } else if (kind === "clock") {
    saveCfg({ clock: b.dataset.v, plans: b.dataset.v });
    hideClock();
  } else if (kind === "dateLead") {
    saveCfg({ dateLead: b.dataset.v });
    drawClock();
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
  $("#w").style.opacity = $("#mini").style.opacity = String(cfg.opacity);
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

// --- перетаскивание за шапку и за горничную: окно двигает main.js по курсору (так верно и на экранах с разным масштабом) ---
// У горничной щелчок — тычок: сдвинул мышь дальше DRAG_SLOP — это перетаскивание, щелчок после него не считается.
const DRAG_SLOP = 4;
let dragEl = null;
let dragFrom = null;
let dragMoved = false;
function draggable(el, skip) {
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || grabbed || skip(e)) return;
    el.setPointerCapture(e.pointerId);
    dragEl = el;
    dragFrom = { x: e.screenX, y: e.screenY };
    dragMoved = false;
    el.classList.add("dragging");
    maid.dragWidget("start");
  });
  el.addEventListener("pointermove", (e) => {
    if (dragEl !== el) return;
    if (!dragMoved && Math.hypot(e.screenX - dragFrom.x, e.screenY - dragFrom.y) > DRAG_SLOP) dragMoved = true;
    maid.dragWidget("move");
  });
  const end = (e) => {
    if (dragEl !== el) return;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    dropDrag();
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
  el.addEventListener("lostpointercapture", () => dragEl === el && dropDrag());
  // Протащили — щелчок, который браузер пришлёт следом, не считается тычком.
  el.addEventListener("click", (e) => {
    if (!dragMoved) return;
    dragMoved = false;
    e.stopImmediatePropagation();
    e.preventDefault();
  }, true);
}
// Захват потерян или кнопку отпустили где-то ещё — окно не должно остаться приклеенным к курсору.
function dropDrag() {
  if (!dragEl) return;
  dragEl.classList.remove("dragging");
  dragEl = null;
  maid.dragWidget("end");
}
const head = $("#head");
draggable(head, (e) => e.target.closest("button"));
draggable($("#maid"), () => false);
draggable($("#mini"), (e) => e.target.closest("button"));
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
  for (const el of [$("#w"), $("#mini"), $("#bubble"), $("#maid"), $("#planClock"), ...document.querySelectorAll(".pl-menu"), ...$("#inbox").children]) {
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
// Значки непрочитанного (inbox.js) — щелчок по значку открывает его напоминание.
$("#inbox").addEventListener("click", (e) => {
  const ib = e.target.closest(".ib");
  if (ib) openInbox(ib.dataset.id);
});
drawInbox();
// Щелчок по горничной — тычок (fun.js), двойной — свернуть/развернуть панель. Тычок ждёт, не будет ли второго щелчка.
$("#maid").addEventListener("click", () => {
  clearTimeout(clickTimer);
  clickTimer = setTimeout(poke, 230);
});
$("#maid").addEventListener("dblclick", () => {
  clearTimeout(clickTimer);
  setCollapsed(!collapsed);
});
$("#miniOpen").onclick = () => setCollapsed(false);
$("#maid").addEventListener("contextmenu", (e) => {
  e.preventDefault();
  maid.grab(!grabbed);
});

$("#open").onclick = () => maid.openMain();
$("#release").onclick = () => maid.grab(false);
$("#body").addEventListener("click", async (e) => {
  if (e.target.closest("#doneCount")) return toggleShowDone();
  const back = e.target.closest("[data-undo]");
  if (back) return undoGone(back.dataset.undo);
  const tick = e.target.closest("[data-done], [data-habit]");
  if (tick) {
    const key = tick.dataset.done ? `t${tick.dataset.done}` : `h${tick.dataset.habit}`;
    if (leavingRows.has(key)) return cancelLeave(key);
    if (cfg.doneTasks === "hide" && !tick.closest("li.did")) return startLeave(key, tick);
  }
  const id = e.target.dataset?.done;
  const habit = e.target.dataset?.habit;
  const save = e.target.dataset?.rescue;
  try {
    if (save) await rescue(e.target, save);
    else if (id) {
      // Галочка задачи: пупырка вдавливается с брызгами, строка съезжает вниз к сделанному, потом сервер.
      e.target.classList.add("done", "pressed");
      e.target.textContent = "✓";
      popTone(4);
      burst(e.target);
      react("done", 4000);
      const li = e.target.closest("li");
      keepDone(Number(id), li.lastElementChild.textContent);
      countDone(data.day);
      holdRender = Date.now() + 1100; // список не перерисовывать, пока строка едет вниз
      setTimeout(() => slideDown(li), 420);
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
