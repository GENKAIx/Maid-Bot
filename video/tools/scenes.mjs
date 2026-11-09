// Сценарии записи: steps — [секунда, js на странице виджета, метка для звука в ролике]. Время страницы — clock (по умолчанию 8 ноября, 18:40).
const typing = (text, from, to) => [...text].map((_, i) => [from + ((to - from) * (i + 1)) / text.length,
  `chatInput.value = ${JSON.stringify(text.slice(0, i + 1))}; fitChat()`]);
const LONG = "поспал с 2 до 9, болела голова, завтра в 15 к стоматологу";
const habitBtn = (k) => `document.querySelector('#bubbleActions button[data-i="${k}"]').click()`;
// Курс на 8 дней — сегодня последний, чтобы показать праздник.
const SHORT = `window.__marks["2026-11-03"] = "done"; { const api = maid.api; maid.api = async (...a) => { const r = await api(...a);
  if (a[1] === "/api/today") r.habits = r.habits.map((h) => h.course ? { ...h, title: "Курс витамина D", course: h.course.slice(0, 8) } : h); return r; }; } load();`;

export const SCENES = {
  test: { seconds: 2, steps: [[0.3, `react("hello", 4000)`], [1, `say("Привет, хозяин!", { ms: 0 })`]] },
  intro: { seconds: 5.5, setup: `hideBubble(); setCollapsed(true)`, steps: [
    [0.4, `say("Привет, хозяин! Я твоя горничная ✨", { ms: 0, mood: "hello" })`, "hey"],
    [2.8, `setCollapsed(false)`, "pop"],
  ] },
  chat: { seconds: 9, setup: `hideBubble()`, steps: [
    ...typing(LONG, 0.3, 3.0),
    [3.3, `sendChat()`, "send"],
  ] },
  remind: { seconds: 7, setup: `hideBubble()`, steps: [
    [0.3, `say("💊 Пора выпить Аевит, хозяин! День 8 из 30", { buttons: [{ text: "✅ Сделал", data: "habit:7:2026-11-08:done" }, { text: "➖ Пропуск", data: "habit:7:2026-11-08:skipped" }], ms: 0, sound: "hey", mood: "remind" })`, "hey"],
    [2.8, habitBtn(0), "pop"],
    [3.1, `load()`],
  ] },
  task: { seconds: 4.5, setup: `hideBubble()`, steps: [
    [0.6, `document.querySelector('#body [data-done="2"]').click()`, "pop"],
  ] },
  finish: { seconds: 7.5, setup: `hideBubble(); ${SHORT}`, steps: [
    [1.0, `document.querySelector('#body [data-habit="7"]').click()`, "pop"],
  ] },
  clock: { seconds: 6, setup: `hideBubble(); cfg.clock = "24"; showClock(data.day)`, steps: [
    [3.2, `cfg.clock = "list"; drawClock()`],
  ] },
  inbox: { seconds: 6.5, setup: `hideBubble()`, steps: [
    [0.3, `inboxAdd({ id: 101, text: "🎂 Завтра день рождения мамы! Не забудь поздравить", buttons: [] })`, "pop"],
    [0.9, `inboxAdd({ id: 102, text: "💊 Магний — выпил?", buttons: [{ text: "✅ Сделал", data: "habit:2:2026-11-08:done" }] })`, "pop"],
    [1.5, `inboxAdd({ id: 103, text: "⏰ Через 30 мин созвон с командой", buttons: [] })`, "pop"],
    [2.1, `inboxAdd({ id: 104, text: "Ты обещал записать, как спал 💌", buttons: [] })`, "pop"],
    [3.8, `openInbox(101)`, "hey"],
  ] },
  poke: { seconds: 8.5, setup: `hideBubble()`, steps: [
    ...Array.from({ length: 10 }, (_, i) => [0.4 + i * 0.6, `boop("boop"); poke()`, i === 9 ? "oops" : "pop"]),
  ] },
  night: { seconds: 4, clock: [2026, 10, 8, 1, 30, 0], setup: `hideBubble(); setCollapsed(true)`, steps: [] },
  games: { seconds: 5, setup: `hideBubble()`, steps: [
    [0.3, `say("🎮 Ты играешь уже 2 часа, хозяин. Может, перерыв? Чай уже заварила", { emotion: "worried", ms: 0, mood: "tea" })`, "hey"],
  ] },
};
