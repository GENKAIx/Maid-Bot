// Подсказки над строкой чата: щёлкнули в пустую строку — над ней несколько готовых фраз. Заодно видно, что горничная умеет.
// Вопрос («Что посмотреть?») уходит сразу; заготовка («Фильм …») встаёт в строку — остаётся дописать.
// Набор зависит от времени (утро, вечер, выходной, после отбоя) и от полок заметок (data.notes из /api/today): «Что посмотреть?»
// — только когда на полке есть фильмы или сериалы, иначе заготовка «Фильм …». Показанное реже — вперёд, чтобы за неделю
// увидеть всё, а не одни и те же четыре фразы.

// fit(c) — насколько фраза к месту: 0 — не показывать, 1 — можно, 2 — самое время. c: { hour, weekend, night, notes, tasks }.
const HINT_COUNT = 4;
const HINT_SEEN_KEY = "maid.hints.seen";
const HINT_ROW_PX = 26; // один ряд плашек (style.css, .chat .hints max-height)
const hintEvening = (c) => c.hour >= 18 || c.weekend;
const HINTS = [
  { id: "watch", text: "Что посмотреть?", send: true, fit: (c) => (c.night || !(c.notes.film + c.notes.series) ? 0 : hintEvening(c) ? 2 : 1) },
  { id: "play", text: "Во что поиграть?", send: true, fit: (c) => (c.night || !c.notes.game ? 0 : hintEvening(c) ? 2 : 1) },
  { id: "read", text: "Что почитать?", send: true, fit: (c) => (!c.notes.book ? 0 : c.hour >= 20 ? 2 : 1) },
  { id: "film", text: "Фильм …", fill: "Фильм ", fit: (c) => (c.notes.film + c.notes.series ? 1 : 2) },
  { id: "game", text: "Поиграть в …", fill: "Поиграть в ", fit: (c) => (c.notes.game ? 1 : 2) },
  { id: "idea", text: "Идея: …", fill: "Идея: ", fit: () => 1 },
  { id: "today", text: "Что у меня сегодня?", send: true, fit: (c) => (c.hour < 12 ? 2 : c.hour < 18 ? 1 : 0) },
  { id: "tomorrow", text: "Что у меня завтра?", send: true, fit: (c) => (c.hour >= 18 ? 2 : 1) },
  { id: "plan", text: "Завтра в … …", fill: "Завтра в ", fit: () => 1 },
  { id: "remind", text: "Напомни …", fill: "Напомни ", fit: () => 1 },
  { id: "spent", text: "Потратил … на …", fill: "Потратил ", fit: () => 1 },
  { id: "week", text: "Сколько потратил за неделю?", send: true, fit: (c) => (c.weekend ? 2 : 1) },
  { id: "slept", text: "Лёг в …, встал в …", fill: "Лёг в ", fit: (c) => (c.hour >= 5 && c.hour < 13 ? 2 : 0) },
  { id: "ate", text: "Съел …", fill: "Съел ", fit: () => 1 },
  { id: "sleepq", text: "Как я спал последние 7 дней?", send: true, fit: () => 1 },
  { id: "habit", text: "Хочу каждый день …", fill: "Хочу каждый день ", fit: () => 1 },
  { id: "done", text: "Сделал …", fill: "Сделал ", fit: (c) => (c.tasks ? 1 : 0) },
];

/** Какие фразы показать: до двух «самое время» и остальные подходящие; в каждой группе сначала показанные реже
 *  (seen — сколько раз фраза уже показывалась), при равенстве — случайно. Порядок — вперемешку: «самое время», обычная,
 *  «самое время», обычная… — в один ряд влезает две-три плашки, и рядом с вопросом к месту всегда видно что-то новое. */
function pickHints(c, seen = {}, n = HINT_COUNT, rnd = Math.random) {
  const rated = HINTS.map((h) => ({ h, fit: h.fit(c), seen: seen[h.id] ?? 0, r: rnd() })).filter((x) => x.fit > 0);
  const rare = (a, b) => a.seen - b.seen || a.r - b.r;
  const hot = rated.filter((x) => x.fit === 2).sort(rare).slice(0, 2);
  const rest = rated.filter((x) => x.fit === 1).sort(rare);
  const out = [];
  for (let i = 0; i < n && out.length < n; i++) {
    if (hot[i]) out.push(hot[i].h);
    if (rest[i] && out.length < n) out.push(rest[i].h);
  }
  return out;
}

// --- показ ---
let hintsShown = [];
let hintsOff = false; // после щелчка по подсказке — до следующего входа в строку
function hintContext(now = new Date()) {
  const notes = { film: 0, series: 0, game: 0, book: 0, idea: 0, other: 0, ...(data?.notes ?? {}) };
  return { hour: now.getHours(), weekend: now.getDay() === 0 || now.getDay() === 6, night: afterBedtime(now), notes, tasks: data?.tasks?.length ?? 0 };
}
function hintSeen() {
  try { return JSON.parse(localStorage.getItem(HINT_SEEN_KEY)) ?? {}; } catch { return {}; }
}
/** Показать подсказки, если строка пуста и в фокусе и над ней ничего другого (история, запись голоса, картинки); иначе убрать. */
function syncHints() {
  const box = $("#chatHints");
  const want = !hintsOff && document.activeElement === chatInput && !chatInput.value && !pictures.length && !Voice.on
    && $("#chatHist").classList.contains("hidden") && !collapsed;
  if (!want) {
    hintsShown = [];
    return void box.classList.add("hidden");
  }
  if (hintsShown.length) return;
  const seen = hintSeen();
  hintsShown = pickHints(hintContext(), seen);
  box.replaceChildren(...hintsShown.map((h) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `hint ${h.send ? "ask" : ""}`;
    b.dataset.hint = h.id;
    b.textContent = h.text;
    b.title = h.send ? "Спросить горничную" : "Вставить в строку — останется дописать";
    return b;
  }));
  box.classList.toggle("hidden", !hintsShown.length);
  // Ряд один: что в него не влезло (перенеслось ниже), убирается и показанным не считается — придёт в другой раз.
  const top = box.getBoundingClientRect().top;
  for (const b of [...box.children]) if (b.getBoundingClientRect().top - top >= HINT_ROW_PX) b.remove();
  hintsShown = hintsShown.filter((h) => box.querySelector(`[data-hint="${h.id}"]`));
  for (const h of hintsShown) seen[h.id] = (seen[h.id] ?? 0) + 1;
  try { localStorage.setItem(HINT_SEEN_KEY, JSON.stringify(seen)); } catch {}
}
function useHint(id) {
  const h = HINTS.find((x) => x.id === id);
  if (!h) return;
  maid.track?.("widget.hints");
  hintsOff = true;
  if (h.send) enqueue("/api/input", { text: h.text, id: crypto.randomUUID() }, h.text);
  else {
    chatInput.value = h.fill;
    fitChat();
    syncSend();
    chatInput.setSelectionRange(h.fill.length, h.fill.length);
  }
  chatInput.focus();
  syncHints();
}
// mousedown не должен увести фокус из строки: иначе blur уберёт подсказки раньше щелчка.
$("#chatHints").addEventListener("mousedown", (e) => { if (e.target.closest(".hint")) e.preventDefault(); });
$("#chatHints").addEventListener("click", (e) => {
  const b = e.target.closest(".hint");
  if (!b) return;
  e.preventDefault();
  e.stopPropagation();
  useHint(b.dataset.hint);
});
chatInput.addEventListener("focus", () => {
  hintsOff = false;
  // Пустая строка — высотой в одну строку: оставшаяся от прежнего текста высота сбрасывается, иначе поле вместе с подсказками съедает список.
  if (!chatInput.value && chatInput.style.height) chatInput.style.removeProperty("height");
  syncHints();
});
chatInput.addEventListener("blur", () => setTimeout(syncHints, 120));
chatInput.addEventListener("input", syncHints);
$("#chatHistBtn").addEventListener("click", () => setTimeout(syncHints, 0));
