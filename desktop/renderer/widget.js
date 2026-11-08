// Виджет поверх всех окон: часы, ближайший план, задачи, скоро. Отпущен — клики проходят сквозь него.

let data = null;
let grabbed = false;

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
  const tasks = data.tasks.slice(0, 6).map((t) => `<li><span class="check" data-done="${t.id}"></span><span class="${t.priority === "high" ? "high" : ""}">${esc(t.title)}</span></li>`);
  const soon = data.dates.filter((d) => d.inDays <= 7).map((d) => `<li><span class="time">${dateWhen(d)}</span><span>${esc(d.title)}</span></li>`);
  $("#body").innerHTML =
    `<h4>Задачи${data.tasks.length > 6 ? ` · ${data.tasks.length}` : ""}</h4>${tasks.length ? `<ul class="list">${tasks.join("")}</ul>` : `<p class="empty small">Нет</p>`}` +
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

async function hint() {
  const s = await maid.settings();
  const k = (x) => x.replace("Control", "Ctrl");
  $("#hint").textContent = grabbed ? "Тащите за любое место" : `${k(s.keys.grab)} — взять · ${k(s.keys.quick)} — записать`;
}

maid.on("grab", (on) => {
  grabbed = on;
  $("#w").classList.toggle("grab", on);
  hint();
});
maid.on("changed", load);
$("#open").onclick = () => maid.openMain();
$("#release").onclick = () => maid.grab(false);
$("#body").addEventListener("click", async (e) => {
  const id = e.target.dataset?.done;
  if (!id || !grabbed) return;
  await maid.api("POST", `/api/tasks/${id}`, { status: "done" });
  maid.changed();
});

setInterval(render, 15_000);
setInterval(load, 60_000);
hint();
load();
