// Разбор хвостов: задача со сроком в прошлом осталась открытой — горничная спрашивает в облачке, по одной:
// «✓ Сделано», «✕ Не сделано» (задача закрывается невыполненной) или день недели снизу — перенести туда.
// «Потом» — больше не спрашивать об этой задаче сегодня. Данные — data из widget.js, полоса дней — как в планах (clock.js).

const TAIL_LATER = (day) => `maid.tailLater.${day}`;
let tailShown = null; // id задачи, о которой сейчас спрашивает

function tailsLater() {
  try {
    return new Set(JSON.parse(localStorage.getItem(TAIL_LATER(data.day)) || "[]"));
  } catch {
    return new Set();
  }
}
function tailsOf() {
  if (!data) return [];
  const later = tailsLater();
  return (data.tasks ?? [])
    .filter((t) => t.due_date && t.due_date < data.day && !later.has(t.id))
    .sort((a, b) => a.due_date.localeCompare(b.due_date) || a.id - b.id);
}
function tailWhen(due) {
  const n = Math.round((Date.parse(data.day) - Date.parse(due)) / 864e5);
  return n === 1 ? "вчера" : n === 2 ? "позавчера" : humanDay(due).split(",")[0];
}

function askTail() {
  const b = $("#bubble");
  // Облачко с вопросом закрыли или сменили другим сообщением — спросить снова, когда оно освободится.
  if (tailShown && !$("#bubbleActions [data-tail]")) tailShown = null;
  if (tailShown || !online || !data || !b.classList.contains("hidden") || document.activeElement === $("#chatInput")) return;
  const list = tailsOf();
  const t = list[0];
  if (!t) return;
  tailShown = t.id;
  const more = list.length > 1 ? `\n(ещё ${list.length - 1} ${list.length - 1 === 1 ? "задача" : "задачи"} после этой)` : "";
  say(`Вы не отметили ${tailWhen(t.due_date)} задачу «${t.title}». Вы её сделали? Или перенести?${more}`, { ms: 0, mood: "remind", sound: "hey" });

  const days = Array.from({ length: DAYS_AHEAD + 1 }, (_, i) => dayAfter(data.day, i));
  $("#bubbleCards").innerHTML = `<div class="tail-days">${days.map((day, i) => {
    const d = new Date(`${day}T12:00:00Z`);
    const wd = d.toLocaleDateString("ru-RU", { weekday: "short", timeZone: "UTC" });
    const n = plansOf(day).length;
    return `<button type="button" class="tail-day${i ? "" : " today"}" data-day="${day}" title="Перенести на ${esc(humanDay(day))}${n ? ` · планов: ${n}` : ""}">`
      + `<b>${d.getUTCDate()}</b>${esc(wd)}<span>${n ? `(${n})` : "–"}</span></button>`;
  }).join("")}</div>`;
  $("#bubbleActions").innerHTML = `<button class="tail-yes" data-tail="done">✓ Сделано</button><button class="tail-no" data-tail="failed">✕ Не сделано</button>`
    + `<button class="ghost" data-tail="later" title="Не спрашивать об этой задаче сегодня">Потом</button>`;

  const settleTail = async (body, reply, mood) => {
    try {
      await maid.api("POST", `/api/tasks/${t.id}`, body);
      // Ответ показать до обновления данных, иначе следующий хвост перебьёт его.
      data.tasks = (data.tasks ?? []).filter((x) => x.id !== t.id);
      tailShown = null;
      say(reply, { ms: 3500, mood, emotion: mood === "sad" ? "neutral" : "happy" });
      maid.changed();
    } catch (e) {
      play("oops");
      tailShown = null;
      say(e.message, { ms: 6000, emotion: "worried" });
    }
  };
  $("#bubbleActions").querySelectorAll("[data-tail]").forEach((btn) => {
    btn.onclick = () => {
      const a = btn.dataset.tail;
      if (a === "later") {
        const later = tailsLater();
        later.add(t.id);
        localStorage.setItem(TAIL_LATER(data.day), JSON.stringify([...later]));
        tailShown = null;
        return hideBubble();
      }
      if (a === "done") popTone(3);
      else popTone(-5, { vol: 0.2, soft: true });
      settleTail({ status: a }, a === "done" ? `Отлично, отметила «${t.title}» ✓` : `Закрыла «${t.title}» как невыполненную.`, a === "done" ? "done" : "sad");
    };
  });
  $("#bubbleCards").querySelectorAll("[data-day]").forEach((btn) => {
    btn.onclick = () => {
      const day = btn.dataset.day;
      popTone(1);
      settleTail({ due_date: day }, `Перенесла «${t.title}» на ${day === data.day ? "сегодня" : humanDay(day)}.`, "write");
    };
  });
}

// Спросить чуть позже запуска (пока всё загрузится), дальше — проверять каждые 4 с: освободилось ли облачко, не появились ли хвосты.
setTimeout(() => {
  askTail();
  setInterval(askTail, 4000);
}, 6000);
