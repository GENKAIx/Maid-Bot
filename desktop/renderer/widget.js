// Горничная на ПК: фигурка в углу (дышит, моргает, думает, спит ночью), облачко с уведомлениями и ответами,
// над ней — сворачиваемая панель: часы, ближайший план, привычки, задачи, скоро. Отпущена — клики проходят сквозь окно,
// кроме самой фигурки и облачка (main.js включает мышь, пока курсор над ними).

let data = null;
let grabbed = false;
let collapsed = false;
let lastNotice = 0;
let state = "idle"; // idle | think | sleep
let bubbleTimer = 0;

const face = $("#face");
const think = $("#think");

// --- состояния ---
function setState(s) {
  state = s;
  const m = $("#maid");
  m.classList.toggle("thinking", s === "think");
  m.classList.toggle("sleeping", s === "sleep");
  if (s === "think") think.play().catch(() => {});
  else think.pause();
  if (s === "sleep") face.src = "../assets/maid/blink.png";
  else if (s === "idle") face.src = "../assets/maid/idle.png";
}
function isNight() {
  const h = new Date().getHours();
  return h >= 23 || h < 7;
}
// Моргание: раз в 3–7 с на 130 мс.
function blink() {
  if (state === "idle") {
    face.src = "../assets/maid/blink.png";
    setTimeout(() => state === "idle" && (face.src = "../assets/maid/idle.png"), 130);
  }
  setTimeout(blink, 3000 + Math.random() * 4000);
}
setTimeout(blink, 2500);
setInterval(() => {
  if (state === "think") return;
  const want = isNight() ? "sleep" : "idle";
  if (want !== state) setState(want);
}, 30_000);

// --- облачко ---
function say(text, { buttons = [], emotion = "neutral", ms = 14000 } = {}) {
  const b = $("#bubble");
  $("#bubbleText").innerHTML = tgHtml(text);
  const acts = $("#bubbleActions");
  acts.innerHTML = buttons.map((x, i) => `<button data-i="${i}">${esc(x.text)}</button>`).join("") + `<button class="ghost" data-i="close">✕</button>`;
  acts.querySelectorAll("button").forEach((btn) => {
    btn.onclick = async () => {
      if (btn.dataset.i === "close") return hideBubble();
      const x = buttons[Number(btn.dataset.i)];
      const m = x.data.match(/^habit:(\d+):(\d{4}-\d{2}-\d{2}):(done|skipped)$/);
      try {
        if (m) {
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
  $("#maid").classList.toggle("grumpy", emotion === "angry" || emotion === "sad");
  clearTimeout(bubbleTimer);
  if (ms) bubbleTimer = setTimeout(hideBubble, ms);
}
function hideBubble() {
  $("#bubble").classList.add("hidden");
  $("#maid").classList.remove("grumpy");
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
  $("#clock").textContent = now.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  if (!data) {
    $("#next").innerHTML = `<span class="muted">Нет связи с сервером</span>`;
    $("#body").innerHTML = "";
    return;
  }
  $("#day").textContent = humanDay(data.day);
  const next = data.events.find((e) => (minutesUntil(e) ?? 1) > -30) ?? data.upcoming[0];
  if (next) {
    const m = next.date_iso === data.day ? minutesUntil(next) : null;
    const when = m === null ? (next.date_iso === data.day ? "сегодня" : humanDay(next.date_iso)) : m <= 0 ? "сейчас" : m < 60 ? `через ${m} мин` : `в ${next.time}`;
    $("#next").innerHTML = `<b>${esc(when)}</b> · ${esc(next.title)}`;
  } else $("#next").innerHTML = `<span class="muted">Планов нет</span>`;
  const habits = (data.habits ?? []).map((h) => `<li><span class="mark ${h.status ?? ""}" data-habit="${h.id}">${h.status === "done" ? "✓" : h.status === "skipped" ? "–" : ""}</span><span>${esc(h.title)}${h.streak >= 2 ? ` <span class="muted">🔥${h.streak}</span>` : ""}</span></li>`);
  const tasks = data.tasks.slice(0, 5).map((t) => `<li><span class="check" data-done="${t.id}"></span><span class="${t.priority === "high" ? "high" : ""}">${esc(t.title)}</span></li>`);
  const soon = data.dates.filter((d) => d.inDays <= 7).map((d) => `<li><span class="time">${dateWhen(d)}</span><span>${esc(d.title)}</span></li>`);
  $("#body").innerHTML =
    (habits.length ? `<h4>Привычки</h4><ul class="list">${habits.join("")}</ul>` : "") +
    `<h4>Задачи${data.tasks.length > 5 ? ` · ${data.tasks.length}` : ""}</h4>${tasks.length ? `<ul class="list">${tasks.join("")}</ul>` : `<p class="empty small">Нет</p>`}` +
    (soon.length ? `<h4>Скоро</h4><ul class="list">${soon.join("")}</ul>` : "");
}

async function load() {
  try {
    data = await maid.api("GET", "/api/today");
  } catch {
    data = null;
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
      say(n.text, { buttons: n.buttons, emotion, ms: n.buttons.length ? 0 : 20000 });
    }
  } catch {
    /* нет связи — молчим */
  }
}

async function hint() {
  const s = await maid.settings();
  const k = (x) => x.replace("Control", "Ctrl");
  $("#hint").textContent = grabbed ? "Тащите за любое место · ПКМ по горничной — отпустить" : `${k(s.keys.grab)} — взять · ${k(s.keys.quick)} — записать`;
}

function setCollapsed(on) {
  collapsed = on;
  $("#w").classList.toggle("hidden", on);
  localStorage.setItem("maid.collapsed", on ? "1" : "");
}

// --- связь с main и мышь ---
maid.on("grab", (on) => {
  grabbed = on;
  $("#stage").classList.toggle("grab", on);
  hint();
});
maid.on("changed", load);
maid.on("thinking", (on) => setState(on ? "think" : isNight() ? "sleep" : "idle"));
maid.on("reply", (r) => say(r.text, { emotion: r.emotion, ms: 9000 }));

// Пока курсор над фигуркой или облачком, окно принимает мышь (иначе клики идут сквозь него).
for (const el of [$("#maid"), $("#bubble")]) {
  el.addEventListener("mouseenter", () => !grabbed && maid.hover(true));
  el.addEventListener("mouseleave", () => !grabbed && maid.hover(false));
}
let clickTimer = 0;
$("#maid").addEventListener("click", () => {
  clearTimeout(clickTimer);
  clickTimer = setTimeout(() => setCollapsed(!collapsed), 220);
});
$("#maid").addEventListener("dblclick", () => {
  clearTimeout(clickTimer);
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
  if (!grabbed) return;
  if (id) {
    await maid.api("POST", `/api/tasks/${id}`, { status: "done" });
    maid.changed();
  } else if (habit) {
    const was = e.target.classList.contains("done");
    await maid.api("POST", `/api/habits/${habit}/mark`, { status: was ? "skipped" : "done" });
    maid.changed();
  }
});

setCollapsed(Boolean(localStorage.getItem("maid.collapsed")));
setState(isNight() ? "sleep" : "idle");
setInterval(render, 15_000);
setInterval(load, 60_000);
setInterval(pollNotices, 20_000);
hint();
load();
pollNotices();
