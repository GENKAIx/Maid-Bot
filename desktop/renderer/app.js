// Главное окно: сегодня, планы, задачи, даты, настройки и поле ввода (как сообщение боту).

// Главное окно теперь показывает веб-приложение с сервера; эта страница открывается для настроек
// (из трея или пока нет ключа) и как запасной вид, если сервер недоступен.
let tab = new URLSearchParams(location.search).get("tab") === "settings" ? "settings" : "today";
let today = null;

const content = $("#content");

async function load() {
  try {
    today = await maid.api("GET", "/api/today");
  } catch (e) {
    today = null;
    content.innerHTML = `<h2>Нет связи</h2><p class="muted">${esc(e.message)}</p><p><button id="toSettings">Открыть настройки</button></p>`;
    $("#toSettings").onclick = () => show("settings");
    return;
  }
  render();
}

function eventItem(e, withDay) {
  const time = e.time ? `${e.time}${e.end_time ? "–" + e.end_time : ""}` : "весь день";
  return `<li><span class="time">${esc(time)}</span><span>${withDay ? `<span class="muted">${humanDay(e.date_iso)} · </span>` : ""}${esc(e.title)}</span></li>`;
}
function taskItem(t) {
  const due = t.due_date ? ` <span class="tag">до ${humanDay(t.due_date)}</span>` : "";
  return `<li><span class="check" data-done="${t.id}" title="Сделано"></span><span class="${t.priority === "high" ? "high" : ""}">${esc(t.title)}</span>${due}</li>`;
}
const list = (items, empty) => (items.length ? `<ul class="list">${items.join("")}</ul>` : `<p class="empty">${empty}</p>`);

function render() {
  if (tab === "settings") return renderSettings();
  if (!today) return load();
  const d = today;
  if (tab === "today") {
    const bySec = {};
    for (const r of d.diary) if (r.section !== "summary" && r.section !== "tags") (bySec[r.section] ??= []).push(r.text);
    const act = d.activity.flatMap((a) => [
      a.active_sec ? `<li>💻 ${dur(a.active_sec)} за ПК <span class="muted">${esc(a.apps.slice(0, 3).map((x) => x.name).join(", "))}</span></li>` : "",
      a.games.length ? `<li>🎮 ${dur(a.games.reduce((s, g) => s + g.sec, 0))} — ${esc(a.games.map((g) => g.name).join(", "))}</li>` : "",
    ]).filter(Boolean);
    content.innerHTML = `
      <h2>${humanDay(d.day)}</h2>
      <div class="cards">
        <div class="card"><h3>Планы</h3>${list(d.events.map((e) => eventItem(e)), "Планов нет")}</div>
        <div class="card"><h3>Задачи</h3>${list(d.tasks.slice(0, 8).map(taskItem), "Задач нет")}</div>
        <div class="card"><h3>Скоро</h3>${list(d.dates.filter((x) => x.inDays <= 14).map((x) => `<li><span class="time">${dateWhen(x)}</span><span>${esc(x.title)}${x.age ? ` (${x.age})` : ""}</span></li>`), "Ничего важного")}</div>
        <div class="card"><h3>Дневник</h3>${list(Object.entries(bySec).map(([s, l]) => `<li><b>${SECTION[s] ?? s}</b><span>${esc(l.join("; "))}</span></li>`), "Пока пусто — напишите, как прошёл день")}</div>
        <div class="card"><h3>Компьютер</h3>${list(act, "Нет данных трекера")}</div>
      </div>`;
  } else if (tab === "plans") {
    content.innerHTML = `<h2>Планы</h2><div class="cards"><div class="card"><h3>Сегодня</h3>${list(d.events.map((e) => eventItem(e)), "Нет")}</div>
      <div class="card"><h3>Ближайшие 2 недели</h3>${list(d.upcoming.map((e) => eventItem(e, true)), "Нет")}</div></div>`;
  } else if (tab === "tasks") {
    content.innerHTML = `<h2>Задачи</h2><div class="cards"><div class="card">${list(d.tasks.map(taskItem), "Открытых задач нет")}</div></div>`;
  } else if (tab === "dates") {
    content.innerHTML = `<h2>Важные даты</h2><p class="muted small">Ближайшие 30 дней. Все даты — команда /dates в боте.</p>
      <div class="cards"><div class="card">${list(d.dates.map((x) => `<li><span class="time">${humanDay(x.on)}</span><span>${esc(x.title)}${x.age ? ` (${x.age})` : ""} <span class="tag">${dateWhen(x)}</span></span></li>`), "Нет")}</div></div>`;
  }
}

async function renderSettings() {
  const s = await maid.settings();
  const st = s.tracker.state ?? {};
  content.innerHTML = `
    <h2>Настройки</h2>
    <div class="form">
      <label>Адрес сервера<input id="server" value="${esc(s.server)}" /></label>
      <label>Ключ (команда /token в боте)<input id="token" type="password" value="${esc(s.token)}" /></label>
      <label class="row"><input type="checkbox" id="wshow" style="width:auto" ${s.widget.show ? "checked" : ""}/> Виджет поверх всех окон</label>
      <label>Прозрачность виджета <input id="wop" type="range" min="0.4" max="1" step="0.02" value="${s.widget.opacity}" /></label>
      <label class="row"><input type="checkbox" id="auto" style="width:auto" ${s.autostart ? "checked" : ""}/> Запускать вместе с Windows</label>
      <label class="row"><input type="checkbox" id="track" style="width:auto" ${s.tracker.enabled ? "checked" : ""}/> Отправлять время за ПК (нужен ActivityWatch)</label>
      <label>Игры — имена программ, по одной в строке<textarea id="games" rows="5">${esc(s.tracker.games.join("\n"))}</textarea></label>
      <label>Быстрая запись<input id="kq" value="${esc(s.keys.quick)}" /></label>
      <label>Взять/отпустить виджет<input id="kg" value="${esc(s.keys.grab)}" /></label>
      <p class="small muted">Трекер: ${st.error ? `<span class="high">${esc(st.error)}</span>` : st.last ? `отправлено ${new Date(st.last).toLocaleTimeString("ru-RU")}` : "ещё не отправлял"}</p>
      <div class="row"><button class="primary" id="save">Сохранить</button><button id="tnow">Отправить ПК сейчас</button></div>
    </div>`;
  $("#save").onclick = async () => {
    await maid.saveSettings({
      server: $("#server").value.trim(),
      token: $("#token").value.trim(),
      widget: { show: $("#wshow").checked, opacity: Number($("#wop").value) },
      tracker: { enabled: $("#track").checked, games: $("#games").value.split("\n").map((x) => x.trim()).filter(Boolean) },
      keys: { quick: $("#kq").value.trim(), grab: $("#kg").value.trim() },
      autostart: $("#auto").checked,
    });
    toast("Сохранено.");
    today = null;
  };
  $("#tnow").onclick = async () => {
    await maid.trackNow();
    renderSettings();
  };
}

function show(t) {
  tab = t;
  document.querySelectorAll("nav a").forEach((a) => a.classList.toggle("on", a.dataset.tab === t));
  render();
}
document.querySelectorAll("nav a").forEach((a) => (a.onclick = () => show(a.dataset.tab)));
document.querySelectorAll("nav a").forEach((a) => a.classList.toggle("on", a.dataset.tab === tab));

content.addEventListener("click", async (e) => {
  const id = e.target.dataset?.done;
  if (!id) return;
  await maid.api("POST", `/api/tasks/${id}`, { status: "done" });
  maid.changed();
});

function toast(html, reply) {
  const box = $("#toast");
  box.innerHTML = `<div class="toast">${html}${reply?.undoable ? `<div class="actions"><button id="undo">↩ Отменить</button></div>` : ""}</div>`;
  if (reply?.undoable) {
    $("#undo").onclick = async () => {
      const r = await maid.api("POST", "/api/undo", { messageId: reply.messageId });
      toast(esc(r.text));
      maid.changed();
    };
  }
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (box.innerHTML = ""), 15000);
}

$("#composer").onsubmit = async (e) => {
  e.preventDefault();
  const input = $("#input");
  const text = input.value.trim();
  if (!text) return;
  input.disabled = true;
  try {
    const r = await maid.api("POST", "/api/input", { text, id: crypto.randomUUID() });
    toast(tgHtml(r.text), r);
    input.value = "";
    maid.changed();
  } catch (err) {
    toast(`<span class="high">${esc(err.message)}</span>`);
  } finally {
    input.disabled = false;
    input.focus();
  }
};
// Голосом: щелчок — запись, ещё щелчок — распознать и записать, Esc — отменить.
let micTick = 0;
function micUi(on) {
  const mic = $("#mic");
  const input = $("#input");
  mic.classList.toggle("rec", on);
  mic.title = on ? "Отправить запись · Esc — отменить" : "Сказать голосом";
  clearInterval(micTick);
  input.readOnly = on;
  if (!on) return void (input.placeholder = input.dataset.ph ?? input.placeholder);
  input.dataset.ph ??= input.placeholder;
  const show = () => (input.placeholder = `🔴 Слушаю… ${Voice.seconds} с · щелчок по микрофону — отправить, Esc — отмена`);
  show();
  micTick = setInterval(show, 500);
}
async function toggleMic() {
  const mic = $("#mic");
  if (mic.disabled) return;
  if (!Voice.on) {
    try {
      await Voice.start(toggleMic);
    } catch (err) {
      return toast(`<span class="high">Нет доступа к микрофону: ${esc(err.message)}</span>`);
    }
    return micUi(true);
  }
  micUi(false);
  const v = await Voice.stop();
  if (!v) return;
  mic.disabled = true;
  toast("🎙 Распознаю…");
  try {
    const r = await maid.api("POST", "/api/voice", { ...v, id: crypto.randomUUID() });
    toast(`<div class="heard">🎙 ${esc(r.heard)}</div>${tgHtml(r.text)}`, r);
    maid.changed();
  } catch (err) {
    toast(`<span class="high">${esc(err.message)}</span>`);
  } finally {
    mic.disabled = false;
  }
}
$("#mic").onclick = toggleMic;
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && Voice.on) Voice.cancel().then(() => micUi(false));
});
$("#input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("#composer").requestSubmit();
  }
});

maid.on("changed", () => {
  today = null;
  if (tab !== "settings") load();
});
setInterval(() => tab !== "settings" && load(), 60_000);
load();
