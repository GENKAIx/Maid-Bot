// Сценки трейлера «Твоя горничная»: steps — [секунда, js на странице, метка звука]. mode: open — развёрнутый виджет, fold — свёрнутый.
const type = (el, text, from, to) => [...text].map((_, i) => [from + ((to - from) * (i + 1)) / text.length,
  el === "chat" ? `chatInput.value = ${JSON.stringify(text.slice(0, i + 1))}; fitChat(); syncSend()` : `document.querySelector("#miniInput").value = ${JSON.stringify(text.slice(0, i + 1))}`]);
const sendChat = `sendChat()`, sendMini = `document.querySelector("#miniAsk").requestSubmit()`;
const LONG = "завтра в 15 встреча с Петей, купить лампочку, у мамы день рождения 5 марта";
const hello = [[0.3, `say("Привет! Я твоя горничная ✨", { ms: 0, mood: "hello", stay: true })`, "hey"]];
const remind = [[0.3, `say("⏰ Через 10 минут — созвон с командой", { ms: 0, mood: "remind", stay: true })`, "hey"]];
const tick = `document.querySelector('#body .check[data-done]:not(.done)')?.click()`;

export const SCENES = {
  hello_open: { mode: "open", seconds: 4.5, steps: hello },
  hello_fold: { mode: "fold", seconds: 4.5, steps: hello },
  poke: { mode: "open", seconds: 7.6, steps: Array.from({ length: 10 }, (_, i) => [0.4 + i * 0.62, `boop("boop"); poke()`, i === 9 ? "oops" : "pop"]) },
  write_open: { mode: "open", seconds: 10, steps: [...type("chat", LONG, 0.3, 3.3), [3.6, sendChat, "send"], [5.3, `load()`, "ding"]] },
  write_fold: { mode: "fold", seconds: 8, steps: [...type("mini", "в субботу в 12 стрижка", 0.3, 1.7), [2.0, sendMini, "send"], [3.6, `load()`, "ding"]] },
  cancel: { mode: "open", seconds: 10.5, setup: `__demo.seedPetya(); load()`, steps: [...type("chat", "отмени встречу с Петей", 0.9, 2.1), [2.4, sendChat, "send"], [4.0, `load()`, "pop"],
    ...type("chat", "верни из корзины", 6.0, 6.9), [7.2, sendChat, "send"], [8.8, `load()`, "ding"]] },
  clash: { mode: "fold", seconds: 8, setup: `__demo.seedPetya(); load()`, steps: [...type("mini", "завтра в 15 репетиция", 0.3, 1.6), [1.9, sendMini, "send"],
    [5.4, `document.querySelector("#bubbleActions button").click()`, "pop"]] },
  remind_open: { mode: "open", seconds: 4.5, steps: remind },
  remind_fold: { mode: "fold", seconds: 4.5, steps: remind },
  angry: { mode: "open", seconds: 4.5, steps: [[0.3, `say("Корм коту сам себя не купит.", { ms: 0, mood: "angry" })`, "oops"]] },
  clean: { mode: "fold", seconds: 4.5, steps: [[0.2, `react("clean", 9000)`]] },
  done: { mode: "open", seconds: 9, steps: [[0.6, `document.querySelector('#body [data-habit="1"]').click()`, "pop"], [2.2, tick, "pop"], [3.3, tick, "pop"], [4.4, tick, "pop"],
    [5.2, `document.querySelector('#body [data-habit="3"]')?.click()`, "pop"]] },
  sleep: { mode: "fold", seconds: 8, steps: [[0.3, `fallAsleep(900)`], [3.6, `wakeUp()`, "hey"]] },
  thanks: { mode: "open", seconds: 6.5, steps: [...type("chat", "спасибо, ты лучшая!", 0.3, 1.3), [1.6, sendChat, "send"]] },
  games: { mode: "fold", seconds: 4.5, steps: [[0.3, `say("🎮 Уже 2 часа в играх. Мир снаружи ещё существует.", { ms: 0, mood: "refuse", stay: true })`, "hey"]] },
  girl: { mode: "open", seconds: 15.5, steps: [...type("chat", "познакомился сегодня с девочкой", 0.3, 2.0), [2.3, sendChat, "send"],
    ...type("chat", "…забудь", 6.4, 7.0), [7.3, sendChat, "send"]] },
  forget_fold: { mode: "fold", seconds: 7, steps: [[0.2, `say("Я ничего не слышала.", { ms: 0, mood: "forget", stay: true })`]] },
};

// Полная версия (демо-сервер tools/demo-server.mts на 3399): url, шаги — js на странице сайта.
const prev = `[...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "‹").click()`;
const dayCell = (n) => `[...document.querySelectorAll("button, div")].filter((x) => x.children.length < 6 && /^${n}(\\D|$)/.test(x.textContent.trim()) && x.getBoundingClientRect().width > 60 && x.getBoundingClientRect().width < 120)[0]?.click()`;
const toSleep = `(() => { const h = [...document.querySelectorAll("*")].find((x) => x.children.length === 0 && x.textContent.trim() === "Сон");
  let sc = h.parentElement; while (sc && !(sc.scrollHeight > sc.clientHeight + 40 && /auto|scroll/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement; sc ??= document.scrollingElement;
  const from = sc.scrollTop, to = from + h.getBoundingClientRect().top - 24, t0 = performance.now();
  (function go(now) { const k = Math.min(1, (now - t0) / 1500), e = k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; sc.scrollTop = from + (to - from) * e; if (k < 1) requestAnimationFrame(go); })(t0); })()`;
// В ролике приложение называется «Твоя горничная» — подпись в боковом меню меняется только на съёмке.
const brand = `[...document.querySelectorAll("*")].filter((x) => x.children.length === 0 && x.textContent.trim() === "Горничная").forEach((x) => (x.textContent = "Твоя горничная"))`;
export const FULL = {
  diary: { url: "/diary", seconds: 7.5, setup: prev + "; " + brand, steps: [[0.2, dayCell(24)], [2.4, dayCell(9), "pop"], [4.2, dayCell(17), "pop"], [5.9, dayCell(30), "pop"]] },
  stats: { url: "/stats", seconds: 8, setup: brand, steps: [[2.6, toSleep]] },
};
