// «⏰ Позже» у вопроса о привычке в облачке виджета (widget.js: habitSnoozeStep и его помощники) без Electron и браузера.
// 27.11.2026: вместо «⏳ Ещё нет» — «⏰ Позже»; она меняет кнопки облачка на «15 мин · 30 мин · 1 ч · 2 ч · Выбрать · ←»
// (только то, что успевает до 00:00), «Выбрать» — поле времени с «Ок» и «←». Выбрали — POST /api/habits/:id/snooze
// {day, in} или {day, at}, короткий ответ сервера. Старый сервер без /snooze — прежний ответ «спрошу ещё раз» (…/mark later).
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const widget = fs.readFileSync(path.join(__dirname, "..", "renderer", "widget.js"), "utf8").replace(/\r\n/g, "\n");
const fn = (name) => widget.match(new RegExp(`\\n(?:async )?function ${name}\\([^]*?\\n\\}\\n`))?.[0] ?? (check(false, `в widget.js нет ${name}`), "");
const label = widget.match(/\nconst HABIT_SNOOZE_LABEL = [^\n]*\n/)?.[0] ?? (check(false, "нет HABIT_SNOOZE_LABEL"), "");
const NAMES = ["habitSnoozeNow", "habitSnoozeSteps", "habitSnoozeHtml", "habitSnoozePickHtml", "habitSnoozeCheck", "habitSnoozeBody", "habitSnoozeStep"];
const src = label + NAMES.map(fn).join("\n") + `\nthis.f = { ${NAMES.join(", ")} };`;
const T = (h, m) => h * 60 + m;

// --- поддельный ряд кнопок облачка: разбирает ровно ту разметку, что пишет виджет ---
const cls = (s = "") => { const set = new Set(s.split(/\s+/).filter(Boolean)); return { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c), toggle: (c, on) => (on ?? !set.has(c)) ? set.add(c) : set.delete(c) }; };
const attr = (a, k) => a.match(new RegExp(`${k}="([^"]*)"`))?.[1];
function parse(html) {
  const out = [];
  for (const m of html.matchAll(/<(button|span)([^>]*)>([^]*?)<\/\1>|<input([^>]*)>/g)) {
    const a = m[2] ?? m[4];
    const el = { tag: m[1] ?? "input", className: attr(a, "class") ?? "", dataset: {}, textContent: m[3] ?? "", value: attr(a, "value") ?? "", min: attr(a, "min"), max: attr(a, "max"), type: attr(a, "type"), parentNode: null, onclick: null, focus() { el.focused = true; } };
    for (const [, k, v] of a.matchAll(/data-(\w+)="([^"]*)"/g)) el.dataset[k] = v;
    el.classList = cls(el.className);
    out.push(el);
  }
  return out;
}
const matches = (el, sel) => sel.startsWith(".") ? el.classList.contains(sel.slice(1))
  : sel === "button[data-s]" ? el.tag === "button" && el.dataset.s !== undefined
  : sel === '[data-i="close"]' ? el.dataset.i === "close" : false;
function makeActs(html) {
  const acts = { kids: [], classList: cls() };
  const own = (k) => { for (const x of acts.kids) if (!k.includes(x)) x.parentNode = null; acts.kids = k; for (const x of k) x.parentNode = acts; };
  Object.defineProperty(acts, "childNodes", { get: () => acts.kids });
  Object.defineProperty(acts, "innerHTML", { set: (h) => own(parse(h)) });
  acts.querySelector = (s) => acts.kids.find((x) => matches(x, s)) ?? null;
  acts.querySelectorAll = (s) => acts.kids.filter((x) => matches(x, s));
  acts.insertBefore = (node, ref) => { const k = acts.kids.filter((x) => x !== node); const i = ref ? k.indexOf(ref) : -1; k.splice(i < 0 ? k.length : i, 0, node); own(k); };
  acts.appendChild = (node) => acts.insertBefore(node, null);
  acts.replaceChildren = (...k) => own(k);
  acts.contains = (x) => acts.kids.includes(x);
  acts.innerHTML = html;
  return acts;
}
const FIRST = `<button data-i="0">✅ Да</button><button data-i="1">⏰ Позже</button><button data-i="2">✖ Нет</button><button class="ghost life" data-i="close">✕</button>`;
const texts = (acts) => acts.kids.filter((x) => !x.classList.contains("snooze-err")).map((x) => x.tag === "input" ? "[время]" : x.dataset.i === "close" ? "✕" : x.textContent).filter((t) => t !== "");
const errOf = (acts) => acts.querySelector(".snooze-err")?.textContent ?? "";
const btn = (acts, t) => acts.kids.find((x) => x.tag === "button" && x.textContent === t);
const tick = () => new Promise((r) => setImmediate(r));

// --- окружение облачка ---
let clock = Date.parse("2026-11-27T12:00:00Z");
const bubble = { dataset: { ask: "h:5:2026-11-27" }, classList: cls() };
const calls = [], said = [], read = [];
let reply = {}; // путь → ответ или Error
const ctx = {
  Math, Number, String, JSON, Error, setTimeout, setInterval: () => 1, clearInterval: () => {}, grabbed: false,
  Date: class extends Date { static now() { return clock; } },
  $: (s) => (s === "#bubble" ? bubble : null),
  maid: {
    api: async (method, p, body) => {
      calls.push({ method, p, body });
      const r = reply[`${method} ${p.replace(/\?.*$/, "")}`];
      if (r instanceof Error) throw r;
      return typeof r === "function" ? r(body) : r ?? { text: "Готово" };
    },
    changed: () => calls.push({ changed: true }),
    focusInput: (on) => calls.push({ focus: on }),
  },
  say: (t, o) => said.push({ t, o }),
  inboxRead: (id) => read.push(id),
  errText: (e) => String(e?.message ?? e),
  placeBubble() {}, fitBubble() {},
  play: (s) => calls.push({ play: s }),
};
vm.createContext(ctx);

(async () => {
  try {
    vm.runInContext(src, ctx);
    const f = ctx.f;

    // Минуты «сейчас»: время сервера плюс прошедшие целые минуты.
    check(f.habitSnoozeNow({ now: "15:10" }, 0) === T(15, 10), "сейчас 15:10");
    check(f.habitSnoozeNow({ now: "15:10" }, 125_000) === T(15, 12), "прошло 2 мин 5 с — 15:12");
    check(f.habitSnoozeNow({ now: "мусор" }, 0) === null && f.habitSnoozeNow(null, 0) === null, "неверное время сервера");

    // Что успевает до 00:00 (сервер прислал раньше — облачко могло провисеть).
    const ALL = { steps: [15, 30, 60, 120] };
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    check(same(f.habitSnoozeSteps(ALL, T(15, 10)), [15, 30, 60, 120]), "15:10 — все четыре");
    check(same(f.habitSnoozeSteps(ALL, T(22, 0)), [15, 30, 60]), "22:00 — без «2 ч»");
    check(same(f.habitSnoozeSteps(ALL, T(23, 0)), [15, 30]), "23:00 — 15 и 30 мин");
    check(same(f.habitSnoozeSteps(ALL, T(23, 44)), [15]), "23:44 — только 15 мин");
    check(same(f.habitSnoozeSteps(ALL, T(23, 45)), []), "23:45 — ничего (00:00 — уже завтра)");
    check(same(f.habitSnoozeSteps(ALL, null), []) && same(f.habitSnoozeSteps({ steps: [15, "x", -5] }, T(12, 0)), [15]), "мусор в шагах");

    // Кнопки второго шага.
    const row = f.habitSnoozeHtml([15, 30, 60, 120]);
    check(same(parse(row).map((x) => x.textContent), ["15 мин", "30 мин", "1 ч", "2 ч", "Выбрать", "←"]), `подписи второго шага: ${row}`);
    check(same(parse(row).map((x) => x.dataset.s), ["15", "30", "60", "120", "pick", "back"]), "данные второго шага");
    check(!/2 ч/.test(f.habitSnoozeHtml([15, 30])), "лишняя «2 ч»");

    // Поле времени.
    const pick = parse(f.habitSnoozePickHtml(T(23, 10)));
    check(pick[0].type === "time" && pick[0].min === "23:11" && pick[0].max === "23:59" && pick[0].value === "23:45", `поле времени: ${JSON.stringify(pick[0])}`);
    check(same(pick.map((x) => x.textContent), ["", "Ок", "←", ""]) && pick[3].classList.contains("snooze-err"), "Ок, ← и строка ошибки");
    check(parse(f.habitSnoozePickHtml(T(23, 50)))[0].value === "23:59", "поздно — предложено 23:59, а не завтра");
    check(parse(f.habitSnoozePickHtml(T(9, 0)))[0].value === "09:30", "утром — через полчаса");
    check(/Выберите/.test(f.habitSnoozeCheck("", T(12, 0))), "пустое время");
    check(/прошло/.test(f.habitSnoozeCheck("11:59", T(12, 0))) && /прошло/.test(f.habitSnoozeCheck("12:00", T(12, 0))), "прошедшее время");
    check(/00:00/.test(f.habitSnoozeCheck("00:30", T(23, 0))), "после полуночи — про 00:00");
    check(f.habitSnoozeCheck("23:30", T(23, 0)) === "", "23:30 в 23:00 — можно");
    check(same(f.habitSnoozeBody("2026-11-27", 30), { day: "2026-11-27", in: 30 }) && same(f.habitSnoozeBody("2026-11-27", "21:30"), { day: "2026-11-27", at: "21:30" }), "тела запроса");

    const DAY = "2026-11-27";
    const start = async (opt, html = FIRST) => {
      const acts = makeActs(html);
      calls.length = said.length = read.length = 0;
      bubble.dataset.ask = `h:5:${DAY}`;
      reply = { "GET /api/habits/5/snooze": opt, "POST /api/habits/5/snooze": (b) => ({ text: `⏰ Зарядка — напомню в ${b.at ?? "+" + b.in}.` }), "POST /api/habits/5/mark": { text: "⏳ Зарядка — хорошо, спрошу ещё раз в 23:00." } };
      const first = [...acts.kids];
      await f.habitSnoozeStep(acts, { id: 5, day: DAY, notice: 41 });
      return { acts, first };
    };
    const posts = () => calls.filter((c) => c.method === "POST");

    // «Позже» в 22:50: сервер прислал все четыре, «2 ч» уже не успевает — виджет её прячет. ✕ остаётся справа.
    let { acts, first } = await start({ steps: [15, 30, 60, 120], hours: ["23:00"], now: "22:50" });
    check(calls[0]?.method === "GET" && calls[0].p === `/api/habits/5/snooze?day=${DAY}`, `спросила варианты: ${JSON.stringify(calls[0])}`);
    check(same(texts(acts), ["15 мин", "30 мин", "1 ч", "Выбрать", "←", "✕"]), `второй шаг: ${texts(acts)}`);
    check(!said.length && !read.length && bubble.dataset.ask === `h:5:${DAY}`, "«Позже» — ещё не ответ: облачко ждёт, оповещение не прочитано");
    check(!acts.classList.contains("busy"), "ряд остался бледным");
    // ← — первый ряд, те же кнопки (с теми же обработчиками).
    btn(acts, "←").onclick();
    check(acts.kids.length === first.length && acts.kids.every((x, i) => x === first[i]), "← не вернул первый ряд");

    // 30 мин → {day, in: 30}; ответ сервера, оповещение прочитано, вопрос снят.
    ({ acts } = await start({ steps: [15, 30, 60, 120], hours: [], now: "15:10" }));
    btn(acts, "30 мин").onclick();
    await tick();
    check(same(posts().map((c) => [c.p, c.body]), [["/api/habits/5/snooze", { day: DAY, in: 30 }]]), `отложить на 30 мин: ${JSON.stringify(posts())}`);
    check(said.length === 1 && /напомню/.test(said[0].t) && said[0].o.mood === "bow" && said[0].o.ms === 5000, `ответ: ${JSON.stringify(said)}`);
    check(read[0] === 41 && bubble.dataset.ask === "" && calls.some((c) => c.changed), "после ответа: прочитано, вопрос снят, данные обновлены");
    // Пока облачко висело, прошло 20 минут: в 23:30 «30 мин» уже за полночь — POST не уходит, ряд пересобран.
    ({ acts } = await start({ steps: [15, 30, 60, 120], hours: [], now: "23:10" }));
    const thirty = btn(acts, "30 мин");
    clock += 20 * 60_000;
    thirty.onclick();
    await tick();
    check(!posts().length && same(texts(acts), ["15 мин", "Выбрать", "←", "✕"]), `шаг за полночь ушёл на сервер или ряд не пересобран: ${texts(acts)}`);
    check(/не успеть/.test(errOf(acts)), "шаг за полночь — не сказано почему");
    clock -= 20 * 60_000;
    // В 23:40 открыли «Выбрать», в 23:45 нажали «←» (или Esc): шагов не осталось — ничего не отправлено, ряд «Выбрать · ←» и почему.
    for (const how of ["←", "Esc"]) {
      ({ acts } = await start({ steps: [15], hours: [], now: "23:40" }));
      btn(acts, "Выбрать").onclick();
      clock += 5 * 60_000;
      if (how === "←") btn(acts, "←").onclick();
      else acts.querySelector(".snooze-time").onkeydown({ key: "Escape", stopPropagation() {} });
      await tick();
      check(!posts().length && !said.length, `${how} в 23:45 отправил ответ: ${JSON.stringify(posts())}`);
      check(same(texts(acts), ["Выбрать", "←", "✕"]) && /не успеть/.test(errOf(acts)), `${how} в 23:45: ${texts(acts)} / ${errOf(acts)}`);
      // «←» ещё раз — первый ряд, тоже без запроса.
      btn(acts, "←").onclick();
      check(!posts().length && same(texts(acts), ["✅ Да", "⏰ Позже", "✖ Нет", "✕"]), `второе ← в 23:45: ${texts(acts)}`);
      clock -= 5 * 60_000;
    }
    // «15 мин» в 23:45 (облачко висело с 23:40): POST не уходит, ряд без шагов и почему.
    ({ acts } = await start({ steps: [15], hours: [], now: "23:40" }));
    const fifteen = btn(acts, "15 мин");
    clock += 5 * 60_000;
    fifteen.onclick();
    await tick();
    check(!posts().length && !said.length && same(texts(acts), ["Выбрать", "←", "✕"]) && /не успеть/.test(errOf(acts)), `15 мин в 23:45: ${texts(acts)}`);
    clock -= 5 * 60_000;
    // Esc на кнопке второго шага (не в поле) — назад, к первому ряду.
    ({ acts, first } = await start({ steps: [15, 30], hours: [], now: "12:00" }));
    btn(acts, "30 мин").onkeydown({ key: "Escape", stopPropagation() {} });
    check(acts.kids.every((x, i) => x === first[i]), "Esc на кнопке шага не вернул первый ряд");

    // Выбрать → поле времени, ← — обратно ко второму шагу; прошедшее время — ошибка в облачке, без запроса; 23:30 — {day, at}.
    ({ acts } = await start({ steps: [15, 30, 60, 120], hours: ["23:00"], now: "22:50" }));
    btn(acts, "Выбрать").onclick();
    let inp = acts.querySelector(".snooze-time");
    check(inp && inp.focused && same(texts(acts), ["[время]", "Ок", "←", "✕"]), `шаг «Выбрать»: ${texts(acts)}`);
    const focus = () => calls.filter((c) => "focus" in c).map((c) => c.focus);
    check(same(focus(), [true]), `поле не взяло клавиатуру окна: ${focus()}`);
    inp.onblur({ relatedTarget: btn(acts, "Ок") });
    check(same(focus(), [true]), "фокус перешёл на «Ок» — клавиатуру отпускать рано");
    inp.onblur({ relatedTarget: null });
    check(same(focus(), [true, false]), `фокус ушёл из облачка — клавиатура не отпущена: ${focus()}`);
    inp.onmousedown();
    check(same(focus(), [true, false, true]), "щелчок по полю не вернул клавиатуру");
    btn(acts, "←").onclick();
    check(same(focus(), [true, false, true]), "клавиатура отпущена дважды");
    check(same(texts(acts), ["15 мин", "30 мин", "1 ч", "Выбрать", "←", "✕"]), "← из поля времени — не ко второму шагу");
    btn(acts, "Выбрать").onclick();
    inp = acts.querySelector(".snooze-time");
    inp.value = "22:00";
    btn(acts, "Ок").onclick();
    await tick();
    check(!posts().length && /прошло/.test(acts.querySelector(".snooze-err").textContent), "прошедшее время ушло на сервер или нет ошибки");
    check(acts.kids.at(-1).classList.contains("snooze-err") && acts.kids.at(-2).dataset.i === "close", "строка ошибки — под рядом, ✕ — в ряду");
    inp.oninput();
    check(acts.querySelector(".snooze-err").textContent === "", "ошибка не стёрлась при правке времени");
    inp.value = "23:30";
    inp.onkeydown({ key: "Enter" });
    await tick();
    check(same(posts().map((c) => c.body), [{ day: DAY, at: "23:30" }]), `Enter в поле → {day, at}: ${JSON.stringify(posts())}`);
    check(said.length === 1 && /23:30/.test(said[0].t), "ответ на «Выбрать»");

    // Сервер не принял время (часы разошлись) — остаться в поле и сказать почему.
    ({ acts } = await start({ steps: [15, 30, 60, 120], hours: ["23:00"], now: "22:50" }));
    reply["POST /api/habits/5/snooze"] = new Error("Это время уже прошло — выберите позже.");
    btn(acts, "Выбрать").onclick();
    acts.querySelector(".snooze-time").value = "22:55";
    btn(acts, "Ок").onclick();
    await tick();
    check(!said.length && /прошло/.test(acts.querySelector(".snooze-err").textContent), "отказ сервера по времени — не в облачке");
    // Иной отказ (отметили в другом месте) — ответом.
    reply["POST /api/habits/5/snooze"] = new Error("Зарядка — уже отмечено.");
    acts.querySelector(".snooze-time").value = "23:20";
    btn(acts, "Ок").onclick();
    await tick();
    check(said.length === 1 && /отмечено/.test(said[0].t), "отказ «уже отмечено» не сказан");

    // Старый сервер (нет /snooze) — прежний ответ «спрошу ещё раз».
    await start(new Error("нет такого адреса"));
    check(same(posts().map((c) => [c.p, c.body]), [["/api/habits/5/mark", { status: "later", day: DAY }]]) && /спрошу/.test(said[0]?.t), `старый сервер: ${JSON.stringify(calls)}`);
    check(read[0] === 41 && bubble.dataset.ask === "", "старый ответ — оповещение прочитано, вопрос снят");
    // До полуночи не успеть даже 15 минут — тоже прежний ответ.
    await start({ steps: [], hours: [], now: "23:50" });
    check(posts().length === 1 && posts()[0].p === "/api/habits/5/mark", "в 23:50 — не прежний ответ");
    // Отмечено / завершена / вчерашний день / нет связи — сказать как есть, без «спрошу ещё раз».
    for (const why of ["Зарядка — уже отмечено.", "Эта привычка уже завершена.", "Этот день уже закончился — отложить нельзя.", "Нет связи с сервером"]) {
      await start(new Error(why));
      check(!posts().length && said.length === 1 && said[0].t === why, `${why} — ушло на /mark later или не сказано: ${JSON.stringify(said)}`);
    }
    // Ответ POST пришёл, когда облачко уже другое (новое уведомление), — не затирать его.
    {
      ({ acts } = await start({ steps: [15, 30], hours: [], now: "12:00" }));
      let open;
      reply["POST /api/habits/5/snooze"] = () => new Promise((r) => (open = r));
      btn(acts, "30 мин").onclick();
      acts.innerHTML = `<button data-i="0">Новое</button>`;
      open({ text: "⏰ Зарядка — напомню в 12:30." });
      await tick();
      await tick();
      check(!said.length && read[0] === 41 && calls.some((c) => c.changed), `ответ затёр новое облачко: ${JSON.stringify(said)}`);
    }
    // Облачко сменилось, пока сервер думал, — второй шаг не рисуется поверх нового.
    {
      const a = makeActs(FIRST);
      calls.length = said.length = 0;
      let open;
      reply["GET /api/habits/5/snooze"] = () => new Promise((r) => (open = r));
      const run = f.habitSnoozeStep(a, { id: 5, day: DAY, notice: 41 });
      check(a.classList.contains("busy"), "пока ждёт сервер — ряд не бледный");
      a.innerHTML = `<button data-i="0">Другое</button>`;
      await tick();
      open({ steps: [15], hours: [], now: "12:00" });
      await run;
      check(same(texts(a), ["Другое"]) && !said.length, "второй шаг поверх другого облачка");
    }
  } catch (e) {
    check(false, `тест оборвался: ${e?.stack ?? e}`);
  }

  // В облачке: «Позже» ведёт во второй шаг (а не сразу на сервер), остальные ответы о привычке — как раньше.
  const sayFn = widget.match(/\nfunction say\([^]*?\n\}\n/)?.[0] ?? "";
  check(/:later\$\/\.exec\(buttons\[Number\(btn\.dataset\.i\)\]/.test(sayFn) && /if \(lm\) return habitSnoozeStep\(acts,/.test(sayFn), "«Позже» в облачке не ведёт во второй шаг");
  check(/\(done\|skipped\)\$\/\)/.test(sayFn) && !/\(done\|skipped\|later\)/.test(sayFn), "later всё ещё уходит сразу на /mark");
  const css = fs.readFileSync(path.join(__dirname, "..", "renderer", "style.css"), "utf8");
  check(/\.bubble-actions input\.snooze-time \{[^}]*width: auto/.test(css), "поле времени во всю ширину облачка");
  check(/\.bubble-actions \.snooze-err \{[^}]*flex-basis: 100%/.test(css) && /\.bubble-actions\.busy > :not\(\[data-i="close"\]\) \{[^}]*pointer-events: none/.test(css), "нет стилей ошибки или ожидания (✕ должен оставаться живым)");

  console.log(`${n - bad}/${n}`);
  process.exit(bad ? 1 : 0);
})();
