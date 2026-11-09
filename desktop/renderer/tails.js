// Разбор хвостов: задача со сроком в прошлом осталась открытой — горничная спрашивает в облачке, по одной.
// Шаг 1 — «Вы её сделали?»: столбиком «✓ Сделано», «📅 Перенести», «✕ Не буду делать» (failed); крестик внизу — закрыть, не ответив:
// задача тоже закрывается, но отдельно отмечается как брошенная (dodged — «сбежал от задачи»).
// Шаг 2 («Перенести») — «Давай выберем дату»: сегодня и 6 дней вперёд, как полоса в планах (clock.js); «← Назад» — к шагу 1.

let tailShown = null; // id задачи, о которой сейчас спрашивает

function tailsOf() {
  if (!data) return [];
  return (data.tasks ?? [])
    .filter((t) => t.due_date && t.due_date < data.day)
    .sort((a, b) => a.due_date.localeCompare(b.due_date) || a.id - b.id);
}
function tailWhen(due) {
  const n = Math.round((Date.parse(data.day) - Date.parse(due)) / 864e5);
  return n === 1 ? "вчера" : n === 2 ? "позавчера" : humanDay(due).split(",")[0];
}

function askTail() {
  // Облачко с вопросом закрыли или сменили другим сообщением — спросить снова, когда оно освободится.
  if (tailShown && !$("#bubbleActions [data-tail]")) tailShown = null;
  if (tailShown || !online || !data || !$("#bubble").classList.contains("hidden") || document.activeElement === $("#chatInput")) return;
  const list = tailsOf();
  const t = list[0];
  if (!t) return;
  tailShown = t.id;
  const more = list.length > 1 ? `<span class="tail-count">${list.length - 1} ещё</span>` : "";

  const settle = async (body, reply, mood, emotion = "neutral") => {
    try {
      await maid.api("POST", `/api/tasks/${t.id}`, body);
      // Ответ показать до обновления данных, иначе следующий хвост перебьёт его.
      data.tasks = (data.tasks ?? []).filter((x) => x.id !== t.id);
      tailShown = null;
      say(reply, { ms: 5000, mood, emotion });
      maid.changed();
    } catch (e) {
      play("oops");
      tailShown = null;
      say(e.message, { ms: 6000, emotion: "worried" });
    }
  };
  // Крестик внизу на обоих шагах: убежать от задачи, не ответив.
  const dodge = `<button class="ghost tail-x" data-tail="dodged" title="Закрыть, не отвечая: задача закроется как брошенная">✕</button>`;
  const onDodge = () => {
    popTone(-7, { vol: 0.2, soft: true });
    settle({ status: "dodged" }, `Сбежали от «${t.title}»?.. Ладно, закрыла. Но я запомнила 👀`, "surprised", "worried");
  };

  const ask = () => {
    say(`Вы не отметили ${tailWhen(t.due_date)} задачу «${t.title}». Вы её сделали?`, { ms: 0, mood: "remind", sound: "hey" });
    $("#bubbleText").insertAdjacentHTML("afterbegin", more);
    $("#bubbleCards").innerHTML = `<div class="tail-choices">`
      + `<button type="button" class="tail-yes" data-choice="done">✓ Сделано</button>`
      + `<button type="button" class="tail-move" data-choice="move">📅 Перенести</button>`
      + `<button type="button" class="tail-no" data-choice="failed">✕ Не буду делать</button></div>`;
    $("#bubbleActions").innerHTML = dodge;
    $("#bubbleActions [data-tail]").onclick = onDodge;
    $("#bubbleCards").querySelectorAll("[data-choice]").forEach((btn) => {
      btn.onclick = () => {
        const c = btn.dataset.choice;
        if (c === "move") return pick();
        if (c === "done") {
          popTone(3);
          settle({ status: "done" }, `Отлично, отметила «${t.title}» ✓`, "done", "happy");
        } else {
          popTone(-5, { vol: 0.2, soft: true });
          settle({ status: "failed" }, `Хорошо, не будем. Закрыла «${t.title}».`, "neutral");
        }
      };
    });
  };

  const pick = () => {
    popTone(1);
    say(`Давай выберем дату для «${t.title}» 📅`, { ms: 0, mood: "think" });
    const days = Array.from({ length: DAYS_AHEAD + 1 }, (_, i) => dayAfter(data.day, i));
    $("#bubbleCards").innerHTML = `<div class="tail-days">${days.map((day, i) => {
      const d = new Date(`${day}T12:00:00Z`);
      const wd = d.toLocaleDateString("ru-RU", { weekday: "short", timeZone: "UTC" });
      const n = plansOf(day).length;
      const off = d.getUTCDay() === 0 || d.getUTCDay() === 6;
      return `<button type="button" class="tail-day${i ? "" : " today"}${off ? " off" : ""}" data-day="${day}" title="Перенести на ${esc(humanDay(day))}${n ? ` · планов: ${n}` : ""}">`
        + `<b>${d.getUTCDate()}</b>${esc(wd)}<span>${n ? `(${n})` : ""}</span></button>`;
    }).join("")}</div>`;
    $("#bubbleActions").innerHTML = `<button data-tail="back">← Назад</button>` + dodge;
    $("#bubbleActions [data-tail=back]").onclick = ask;
    $("#bubbleActions [data-tail=dodged]").onclick = onDodge;
    $("#bubbleCards").querySelectorAll("[data-day]").forEach((btn) => {
      btn.onclick = () => {
        const day = btn.dataset.day;
        popTone(2);
        settle({ due_date: day }, `Перенесла «${t.title}» на ${day === data.day ? "сегодня" : humanDay(day)}.`, "write", "happy");
      };
    });
  };

  ask();
}

// Спросить чуть позже запуска (пока всё загрузится), дальше — проверять каждые 4 с: освободилось ли облачко, не появились ли хвосты.
setTimeout(() => {
  askTail();
  setInterval(askTail, 4000);
}, 6000);
