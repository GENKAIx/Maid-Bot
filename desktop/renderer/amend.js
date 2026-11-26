// Поправка к ответу (вариант В ревью): под карточками ответа, который что-то записал, — тихая строка «поправить этот ответ…».
// Enter отправляет поправку именно этому ответу (POST /api/correct: messageId исходного сообщения, текст, свой id), сервер меняет
// только его записи и присылает все карточки ответа заново (у каждой ref — таблица и id). Облачко не пересобирается: текст
// меняется на ответ горничной, а в карточках прокручивается только то, что поменялось (как счётчик), — видно, что именно она поправила.
// Здесь же правила без DOM (выше черты «облачко»): их проверяет desktop/test/widget-amend.test.cjs.

const AMEND_MAX = 500; // длина поправки (сервер: text 1..500)
const AMEND_ROLL_MAX = 18; // середина длиннее — прокручивается вся строка, а не кусок посередине
const AMEND_ROLL_MS = 420; // одна прокрутка
const AMEND_STEP = 120; // пауза между карточками
const AMEND_HINT = "поправить этот ответ…";
const AMEND_ASK = "ответить горничной…"; // она переспросила: следующая поправка — ответ на её вопрос

/** Ключ записи за карточкой — «таблица:id», как refKey на сервере (correct.ts); у карточки без ref — пусто. */
function amendKey(ref) {
  return ref && ref.tbl && ref.id !== undefined && ref.id !== null ? `${ref.tbl}:${ref.id}` : "";
}

/** Карточки облачка после поправки. Без ref (отметки, строки правок) — как были и на своих местах; с ref — версия сервера в
 *  прежнем порядке (changed — эту запись поменяла поправка); нет в ответе сервера — записи уже нет (gone); новые с сервера —
 *  в конец (added). Ответ без списка карточек (не той формы) ничего не трогает. */
function amendMerge(oldCards, reply) {
  const old = oldCards ?? [];
  if (!Array.isArray(reply?.changes)) return old.slice();
  const copy = (c, flags) => ({ kind: c.kind, title: c.title, detail: c.detail, ref: c.ref, ...flags });
  const fresh = new Map();
  for (const c of reply.changes) {
    const k = amendKey(c?.ref);
    if (k && !fresh.has(k)) fresh.set(k, c);
  }
  const changed = new Set(reply.changed ?? []);
  const seen = new Set();
  const out = old.map((c) => {
    const k = amendKey(c.ref);
    if (!k) return c;
    seen.add(k);
    const now = fresh.get(k);
    return now ? copy(now, { changed: changed.has(k) }) : copy(c, { gone: true });
  });
  for (const [k, c] of fresh) if (!seen.has(k)) out.push(copy(c, { added: true, changed: changed.has(k) }));
  return out;
}

/** Что прокрутить в строке: общее начало и конец остаются, середина old → new. По целым знакам (эмодзи не режутся), слово не
 *  режется посередине (цифры — режутся: крутится только поменявшийся разряд, как у счётчика). Середина длинная или поменялось
 *  больше половины строки — прокручивается вся строка. Одинаковые строки — середины пустые. */
function amendRoll(oldText, newText) {
  const a = String(oldText ?? ""), b = String(newText ?? "");
  if (a === b) return { pre: a, oldMid: "", newMid: "", post: "" };
  const x = Array.from(a), y = Array.from(b);
  const n = Math.min(x.length, y.length);
  let p = 0;
  while (p < n && x[p] === y[p]) p++;
  let s = 0;
  while (s < n - p && x[x.length - 1 - s] === y[y.length - 1 - s]) s++;
  const letter = (ch) => /\p{L}/u.test(ch ?? "");
  while (p > 0 && letter(x[p - 1]) && (letter(x[p]) || letter(y[p]))) p--;
  while (s > 0 && letter(x[x.length - s]) && (letter(x[x.length - 1 - s]) || letter(y[y.length - 1 - s]))) s--;
  const oldMid = x.slice(p, x.length - s), newMid = y.slice(p, y.length - s);
  if (Math.max(oldMid.length, newMid.length) > AMEND_ROLL_MAX || (p + s) * 2 < Math.max(x.length, y.length)) {
    return { pre: "", oldMid: a, newMid: b, post: "" };
  }
  return { pre: x.slice(0, p).join(""), oldMid: oldMid.join(""), newMid: newMid.join(""), post: x.slice(x.length - s).join("") };
}

/** Текст облачка после поправки: строки «✎ было → стало» не повторяются — это показывают сами карточки; остальное (вопрос,
 *  «⚠ …», «остального не нашла») — как есть. В переписку уходит весь текст. */
function amendText(text) {
  const [first, ...rest] = String(text ?? "").split("\n");
  // «✎ было → стало», «✕ … — убрала», «＋ новая запись» показывают карточки (прокрутка, зачёркнутая, въехавшая).
  return [first, ...rest.filter((l) => !/^[✎✕＋] /.test(l))].join("\n");
}

// --- облачко ---
// Строка поправки одна (#bubbleAmend в widget.html), к облачку её привязывает amendRun: новое облачко (say) — новый amendRun.
// Ответ сервера пишет в облачко, только если amendRun — всё ещё тот же (облачко не сменилось и не закрыто); переписка — всегда.
let amendRun = null;
let amendRolls = 0; // номер прокрутки: старая не возвращает текст поверх новой
// Поправок в пути (у сменившегося облачка своя может ещё идти). «Думает» снимает последний ответ — и только если не идёт
// сообщение чата (pumping); pump, со своей стороны, не снимает «думает», пока идёт поправка (widget.js).
let amendFlying = 0;
const amendBox = $("#bubbleAmend");
const amendInput = $("#amendInput");

function amendErr(text) {
  $("#amendErr").textContent = text;
}
function amendBusy(on) {
  amendBox.classList.toggle("busy", on);
  amendInput.readOnly = on;
}
/** Новое облачко (say): строка — только под ответом, который что-то записал (есть «Отменить» и карточка с ref), не у вопроса
 *  «добавить?» и не у «…». Недописанная поправка к прошлому облачку пропадает. */
function amendMount({ undo = null, changes = [], proposal = null, text = "" } = {}) {
  amendRun = null;
  if (amendBox.contains(document.activeElement)) amendInput.blur();
  amendBox.classList.add("hidden");
  amendBusy(false);
  amendErr("");
  amendInput.value = "";
  amendInput.placeholder = AMEND_HINT;
  if (!undo || proposal || text === "…" || !changes.some((c) => amendKey(c.ref))) return;
  // warn — строка «⚠ …» о наложении планов (с ней кнопки «Сдвинуть» / «Оставить»): поправка другой записи её не убирает.
  const last = String(text).split("\n").at(-1);
  amendRun = { messageId: undo, cards: changes.map((c) => ({ ...c })), busy: false, id: "", idText: "", warn: last.startsWith("⚠ ") ? last : "" };
  amendBox.classList.remove("hidden");
}
/** Облачко держится (время жизни стоит, «Оставить» не нажимается само, панель не сворачивается), пока в строке пишут:
 *  она в фокусе (и окно тоже), в ней текст или поправка ещё идёт. */
function amendHeld() {
  const run = amendRun;
  if (!run) return false;
  if (run.busy) return true;
  if ($("#bubble").classList.contains("hidden")) return false;
  return (document.activeElement === amendInput && document.hasFocus()) || Boolean(amendInput.value.trim());
}
/** Облачко закрыли (hideBubble): строку отпустить и черновик стереть; идущая поправка дойдёт только в переписку. */
function amendHide() {
  if (amendBox.contains(document.activeElement)) amendInput.blur();
  if (amendRun?.busy) return;
  amendInput.value = "";
  amendErr("");
}

// Окно «сквозное»: щелчок по строке — окну нужна клавиатура (как строке чата), фокус ушёл из строки — отдаёт. Щелчок мимо поля
// (значок ✎, красная строка ошибки) тоже ставит фокус в поле: иначе фокус никуда не переходит, focusout не приходит, и окно
// оставалось несквозным, пока его не отпустит что-то ещё.
amendBox.addEventListener("mousedown", (e) => {
  maid.focusInput(true);
  if (e.target === amendInput) return;
  e.preventDefault();
  amendInput.focus();
});
amendBox.addEventListener("focusout", (e) => { if (!amendBox.contains(e.relatedTarget) && !grabbed) maid.focusInput(false); });
amendBox.onsubmit = (e) => { e.preventDefault(); amendSend(); };
// Enter — отправить, Shift+Enter — ничего; Esc — стереть, в пустой строке — уйти из неё. Клавиши дальше строки не идут
// (Esc и Enter ловят и запись голоса, и другие обработчики окна).
amendInput.addEventListener("keydown", (e) => {
  e.stopPropagation();
  if (e.key === "Escape") {
    e.preventDefault();
    if (amendInput.value && !amendRun?.busy) { amendInput.value = ""; amendErr(""); } else amendInput.blur();
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (!e.shiftKey && !e.isComposing) amendSend();
  }
});
amendInput.addEventListener("input", () => amendErr(""));

// Отправка — своя, не через очередь чата: поправка относится к этому облачку. id один на попытку текста: повтор того же текста
// после сбоя связи — с тем же id (сервер второй раз не запишет), другой текст или следующая поправка — новый id.
async function amendSend() {
  const run = amendRun;
  const text = amendInput.value.trim().slice(0, AMEND_MAX);
  if (!run || run.busy || !text) return;
  if (run.idText !== text) {
    run.id = crypto.randomUUID();
    run.idText = text;
  }
  run.busy = true;
  amendBusy(true);
  amendErr("");
  amendFlying++;
  setState("think");
  let r = null, fail = null;
  try {
    r = await maid.api("POST", "/api/correct", { messageId: run.messageId, text, id: run.id });
  } catch (e) {
    fail = e;
  }
  run.busy = false;
  amendFlying--;
  if (!amendFlying && !pumping) setState(restState());
  const mine = amendRun === run; // облачко то же (say не сменил его)
  if (mine) amendBusy(false);
  const here = mine && !$("#bubble").classList.contains("hidden");
  if (fail || !r) {
    // Нет связи, сервер не принял: текст остаётся — Enter ещё раз; больше ничего не меняется.
    if (here) {
      amendErr(errText(fail ?? "сервер не ответил"));
      play("oops");
    }
    return;
  }
  run.idText = "";
  const merged = amendMerge(run.cards, r);
  amendRemember(run.messageId, merged, text, r);
  if (r.changed?.length) maid.changed();
  if (!here) return;
  const was = run.cards;
  run.cards = merged;
  amendShow(run, was, merged, r);
}

// Ответ на поправку — в то же облачко: текст, цвет по эмоции, карточки на месте, кнопки наложения планов.
function amendShow(run, was, merged, r) {
  const b = $("#bubble");
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  stopType();
  const box = $("#bubbleText");
  const heard = box.querySelector(".heard");
  // Вопрос о наложении планов решается заново, только если пришло новое наложение или поправка тронула план. Поправка другой
  // записи (сумма, категория) или переспрос прежний вопрос — строку ⚠ и кнопки «Сдвинуть» / «Оставить» — оставляет: план всё так
  // же на занятом времени (сервер шлёт clash только по планам, у которых поменялись дата или время).
  const plans = Boolean(r.clash) || (r.changed ?? []).some((k) => String(k).startsWith("events:"));
  let shown = amendText(r.text);
  if (plans) run.warn = r.clash ? shown.split("\n").find((l) => l.startsWith("⚠ ")) ?? "" : "";
  else if (run.warn && !shown.split("\n").includes(run.warn)) shown += `\n${run.warn}`;
  box.innerHTML = planRows(tgHtml(shown));
  box.dataset.fx = ""; // текст поправки — без слов с характером и без печати: обрезка и прокрутка как у обычного текста (fitBubble)
  box.dataset.fits = "";
  box.classList.remove("fxb");
  if (heard) box.prepend(heard);
  box.classList.remove("amend-fade");
  void box.offsetWidth;
  box.classList.add("amend-fade");
  for (const c of [...b.classList]) if (c in EMOTION_MOOD) b.classList.remove(c);
  b.classList.add(r.emotion || "neutral");

  // Карточки: изменившиеся — прокрутка с паузой между карточками, ушедшие — зачёркнуты, новые — въезжают в конец.
  const cards = $("#bubbleCards");
  const prev = new Map(was.map((c) => [amendKey(c.ref), c]));
  const find = (k) => [...cards.querySelectorAll(".card[data-ref]")].find((x) => x.dataset.ref === k);
  let step = 0;
  for (const c of merged) {
    const k = amendKey(c.ref);
    if (!k) continue;
    const el = find(k);
    const at = step * AMEND_STEP;
    if (c.gone) {
      if (!el || el.classList.contains("amend-gone")) continue;
      el.classList.add("amend-gone");
      el.title = "Этой записи уже нет";
      typeTimers.push(setTimeout(() => popTone(-4, { vol: 0.12, soft: true }), at));
      step++;
      continue;
    }
    if (!el) {
      const add = bubbleCard(c);
      add.classList.add("amend-new");
      add.style.animationDelay = `${at}ms`;
      const last = [...cards.querySelectorAll(".card:not(.day)")].at(-1);
      if (last) last.after(add);
      else cards.prepend(add);
      typeTimers.push(setTimeout(() => play("pop"), at));
      step++;
      continue;
    }
    el.className = el.className.replace(/\bk-\S+/, `k-${c.kind}`);
    // Щелчок — раздел по новой версии записи, как в bubbleCard: у дневника раздел зависит от названия («Здоровье · …» — /health).
    el.onclick = () => {
      hideBubble();
      maid.openSection(sectionOf(c));
    };
    const old = prev.get(k) ?? c;
    const title = el.querySelector(".card-title");
    let detail = el.querySelector(".card-detail");
    if (!detail && c.detail) {
      detail = document.createElement("span");
      detail.className = "card-detail";
      el.querySelector(".card-body")?.append(detail);
    }
    // Запись поменялась не этой поправкой (например, где-то ещё) — просто новый текст, без прокрутки.
    const quiet = !c.changed || still;
    if (title) amendRollTo(title, old.title ?? "", c.title ?? "", at, quiet);
    if (detail) amendRollTo(detail, old.detail ?? "", c.detail ?? "", at, quiet);
    if (!c.changed) continue;
    el.classList.remove("amend-lit");
    void el.offsetWidth;
    el.style.animationDelay = `${at}ms`;
    el.classList.add("amend-lit");
    const pitch = 3 + step * 2;
    typeTimers.push(setTimeout(() => popTone(pitch, { vol: 0.14, soft: true }), at));
    step++;
  }
  if (!step) bubbleSound();

  // Кнопки наложения планов: поправка сдвинула план на занятое время — новые «Сдвинуть» / «Оставить» (POST /api/clash с
  // messageId исходного ответа); тронула план, а наложения нет — прежние кнопки ушли. Поправка другой записи их не трогает
  // (и «Оставить» дальше заполняется само). «Отменить» и ✕ — на месте.
  const acts = $("#bubbleActions");
  let autoBtn = null;
  if (plans) {
    stopAuto();
    acts.querySelectorAll("button").forEach((x) => { if (/^\d+$/.test(x.dataset.i ?? "") || x.dataset.amend) x.remove(); });
    const list = r.clash ? clashButtons({ clash: r.clash, messageId: r.messageId }) : [];
    acts.prepend(...list.map((x) => {
      const btn = document.createElement("button");
      btn.dataset.amend = "clash";
      if (x.auto) {
        btn.className = "auto";
        btn.title = "Пока курсор на облачке — ждёт";
        btn.innerHTML = `<span class="fill"></span><span class="lbl">${esc(x.text)}</span>`;
        autoBtn = btn;
        btn.dataset.wait = String(x.auto * 1000);
      } else btn.textContent = x.text;
      btn.onclick = () => {
        b.dataset.ask = "";
        hideBubble();
        x.run();
      };
      return btn;
    }));
  }

  // Строка: переспросила — открыта, ответ на вопрос; поправила — пустая, фокус отпущен; записей не осталось — уходит.
  const live = r.undoable !== false && merged.some((c) => amendKey(c.ref) && !c.gone);
  amendBusy(false);
  amendInput.value = "";
  if (!live) {
    amendRun = null;
    if (amendBox.contains(document.activeElement)) amendInput.blur();
    amendBox.classList.add("hidden");
  } else if (r.clarify) {
    // Фокус не забирается: остаётся в строке, только если человек из неё не уходил (и окно в фокусе). Ответ приходит без его
    // жеста — maid.focusInput(true) отсюда увёл бы клавиатуру у игры и сделал бы всё окно несквозным; ушёл — щёлкнет сам.
    amendInput.placeholder = AMEND_ASK;
  } else {
    amendInput.placeholder = AMEND_HINT;
    if (document.activeElement === amendInput) amendInput.blur();
  }

  // Горничная: поправила — пишет (только планы — «Есть!»), иначе по эмоции ответа; держится, пока висит облачко.
  const moved = merged.filter((c) => c.changed);
  react(moved.length ? (moved.every((c) => c.kind === "event") ? "salute" : "write") : EMOTION_MOOD[r.emotion] ?? "neutral", 30 * 60_000, true);
  moodOfBubble = true;

  // Время жизни — заново: не меньше 12 с, плюс время на чтение; у «Оставить» облачко держит она.
  if (autoBtn) {
    stopLife();
    startAuto(autoBtn, Number(autoBtn.dataset.wait));
  } else if (!acts.querySelector("button.auto")) {
    stopLife();
    startLife(12000 + moved.length * 900 + Math.min(60000, Math.max(0, shown.length - 120) * 55), true);
  }
}

// Прокрутка изменившейся части строки: старое уходит вверх и гаснет, новое приходит снизу. Цифры — каждая своим колёсиком
// (младшая трогается первой), ширина куска плавно переходит от старой к новой. «Меньше движения» — сразу новый текст.
function amendRollTo(span, from, to, delay, still) {
  const r = amendRoll(from, to);
  const mark = ++amendRolls;
  span.dataset.roll = String(mark); // прокрутка прошлой поправки, если ещё идёт, текст уже не вернёт
  if (still || (!r.oldMid && !r.newMid)) return void (span.textContent = to);
  span.textContent = "";
  span.append(r.pre);
  const odo = /^\d+$/.test(r.oldMid) && /^\d+$/.test(r.newMid) && r.oldMid.length === r.newMid.length;
  const parts = odo ? [...r.oldMid].map((d, i) => [d, r.newMid[i]]) : [[r.oldMid, r.newMid]];
  const rolls = [];
  parts.forEach(([a, z], i) => {
    if (a === z) return void span.append(a);
    const roll = document.createElement("span");
    roll.className = `amend-roll${Math.max(Array.from(a).length, Array.from(z).length) <= AMEND_ROLL_MAX ? " short" : ""}`;
    const out = document.createElement("span");
    out.className = "amend-was";
    out.textContent = a;
    const come = document.createElement("span");
    come.className = "amend-now";
    come.textContent = z;
    const at = `${delay + (parts.length - 1 - i) * 45}ms`;
    out.style.animationDelay = come.style.animationDelay = roll.style.transitionDelay = at;
    roll.append(out, come);
    span.append(roll);
    rolls.push({ roll, out, come });
  });
  span.append(r.post);
  // Ширина и высота куска — от старого текста к новому, плавно: строка вокруг не прыгает.
  for (const x of rolls) {
    const a = x.out.getBoundingClientRect(), z = x.come.getBoundingClientRect();
    x.roll.style.width = `${a.width}px`;
    x.roll.style.height = `${a.height || z.height}px`;
    x.to = [z.width, z.height || a.height];
  }
  void span.offsetWidth;
  for (const x of rolls) {
    x.roll.style.width = `${x.to[0]}px`;
    x.roll.style.height = `${x.to[1]}px`;
  }
  // Прокрутилось — снова простой текст (следующая поправка начнёт с него).
  setTimeout(() => {
    if (span.dataset.roll !== String(mark)) return;
    span.textContent = to;
    delete span.dataset.roll;
  }, delay + (parts.length - 1) * 45 + AMEND_ROLL_MS + 80);
}

// Переписка (widget.js, chatLog): у исходного ответа — карточки после поправки, сама поправка — отдельной парой
// «✎ текст» → ответ горничной, без своего «Отменить» (поправка отменяется вместе с ответом).
function amendRemember(messageId, merged, text, r) {
  const h = chatLog.findLast((x) => x.undo === messageId);
  if (h) h.changes = merged.filter((c) => !c.gone).slice(0, 12).map((c) => ({ kind: c.kind, title: String(c.title ?? "").slice(0, 200) }));
  if (r?.text) {
    chatLog = [...chatLog, { at: Date.now(), me: `✎ ${text}`.slice(0, 400), reply: String(r.text).slice(0, 2000), undo: null, pic: null, changes: [], day: data?.day ?? "" }].slice(-HIST_MAX);
  }
  try { localStorage.setItem(HIST_KEY, JSON.stringify(chatLog)); } catch {}
  if (!$("#chatHist").classList.contains("hidden")) drawHistory();
}
