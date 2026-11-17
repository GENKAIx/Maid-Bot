// Разбор хвоста: задача со сроком в прошлом осталась открытой. Сама горничная о ней не спрашивает — хвосты лежат под
// будильником (inbox.js); щелчок по строке списка открывает вопрос об этой задаче.
// Шаг 1 — «Вы её сделали?»: столбиком «✓ Сделано», «📅 Перенести», «✕ Не буду делать» (failed); ✕ внизу — просто закрыть,
// задача остаётся хвостом.
// Шаг 2 («Перенести») — «Давай выберем дату»: сегодня и 6 дней вперёд, как полоса в планах (clock.js); «← Назад» — к шагу 1.

function askTail(t) {
  const settle = async (body, reply, mood, emotion = "neutral") => {
    $("#bubble").dataset.ask = ""; // ответили в облачке — «вижу-вижу» не нужно
    try {
      await maid.api("POST", `/api/tasks/${t.id}`, body);
      // Ответ показать до обновления данных, иначе следующий хвост перебьёт его.
      data.tasks = (data.tasks ?? []).filter((x) => x.id !== t.id);
      drawInbox();
      say(reply, { ms: 5000, mood, emotion });
      maid.changed();
    } catch (e) {
      play("oops");
      say(e.message, { ms: 6000, emotion: "worried" });
    }
  };
  // Крестик внизу на обоих шагах: закрыть облачко, задача остаётся под будильником.
  const close = `<button class="ghost tail-x" data-tail="close" title="Закрыть, задача останется в списке">✕</button>`;

  const ask = () => {
    say(`Вы не отметили ${tailWhen(t.due_date)} задачу «${t.title}». Вы её сделали?`, { ms: 0 });
    $("#bubble").dataset.ask = `t:${t.id}`; // закрыли задачу в списке — облачко закроется (widget.js, answeredInList)
    $("#bubbleCards").innerHTML = `<div class="tail-choices">`
      + `<button type="button" class="tail-yes" data-choice="done">✓ Сделано</button>`
      + `<button type="button" class="tail-move" data-choice="move">📅 Перенести</button>`
      + `<button type="button" class="tail-no" data-choice="failed">✕ Не буду делать</button></div>`;
    $("#bubbleActions").innerHTML = close;
    $("#bubbleActions [data-tail=close]").onclick = hideBubble;
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
    $("#bubble").dataset.ask = `t:${t.id}`;
    const days = Array.from({ length: DAYS_AHEAD + 1 }, (_, i) => dayAfter(data.day, i));
    $("#bubbleCards").innerHTML = `<div class="tail-days">${days.map((day, i) => {
      const d = new Date(`${day}T12:00:00Z`);
      const wd = d.toLocaleDateString("ru-RU", { weekday: "short", timeZone: "UTC" });
      const n = plansOf(day).length;
      const off = d.getUTCDay() === 0 || d.getUTCDay() === 6;
      return `<button type="button" class="tail-day${i ? "" : " today"}${off ? " off" : ""}" data-day="${day}" title="Перенести на ${esc(humanDay(day))}${n ? ` · планов: ${n}` : ""}">`
        + `<b>${d.getUTCDate()}</b>${esc(wd)}<span>${n ? `(${n})` : ""}</span></button>`;
    }).join("")}</div>`;
    $("#bubbleActions").innerHTML = `<button data-tail="back">← Назад</button>` + close;
    $("#bubbleActions [data-tail=back]").onclick = ask;
    $("#bubbleActions [data-tail=close]").onclick = hideBubble;
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
