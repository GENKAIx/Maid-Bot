// Горничная на ПК: фигурка в углу (дышит, моргает, думает, спит ночью), облачко с уведомлениями и ответами,
// над ней — сворачиваемая панель: часы, ближайший план, привычки, задачи, скоро. Отпущена — клики проходят сквозь окно,
// кроме самой фигурки и облачка (main.js включает мышь, пока курсор над ними).

let data = null;
let grabbed = false;
let collapsed = false;
let lastNotice = 0;
let state = "idle"; // idle | think | sleep
let bubbleTimer = 0;
// Настройки виджета (main.js → settings.widget): что показывать на панели и где стоит горничная.
// Циферблат планов (Часы 12/24) пока выключен: код в clock.js остаётся, в настройках его нет, сохранённый выбор показывается списком.
const CLOCK_DIAL = false;
const dialOff = (v) => (!CLOCK_DIAL && (v === "12" || v === "24") ? "list" : v);
const NEXT_MAX = 3; // сколько ближайших планов в строке над задачами
// Настройка «Дальние задачи» (cfg.laterTasks): «hide» — скрывать до срока (по умолчанию), «show» — все задачи в списке.
// Задача со сроком дальше TASK_WAKE дней «спит»: в списке её нет совсем, она стоит только на своём дне в панели планов.
// За TASK_WAKE дней до срока она просыпается: всплывает в списке с золотым бликом и «⏰ через 7 дней», горничная напоминает.
// Кто спал в прошлый раз — в localStorage («maid.sleeping»), так пробуждение видно и после перезапуска.
const TASK_WAKE = 7;
const WAKE_SHOW = 6000; // сколько держится анимация проснувшейся задачи
const wokeAt = new Map(); // id задачи → когда проснулась
let wakeTimer = 0;
const asleep = (t) => cfg.laterTasks === "hide" && Boolean(t.due_date) && daysFrom(data.day, t.due_date) > TASK_WAKE;
const wokeFresh = (t) => Date.now() - (wokeAt.get(t.id) ?? 0) < WAKE_SHOW;
function dueWhen(day) {
  const n = daysFrom(data.day, day);
  return n <= 0 ? "сегодня" : n === 1 ? "завтра" : `через ${n} ${plural(n, "день", "дня", "дней")}`;
}
// Срок задачи справа в строке: «вчера», «сегодня», «завтра», день недели в пределах недели, дальше — «12 нояб».
// Просроченное — красным (и такие задачи стоят в списке первыми).
const MONTH_SHORT = ["янв", "февр", "марта", "апр", "мая", "июня", "июля", "авг", "сент", "окт", "нояб", "дек"];
const overdue = (t) => Boolean(t.due_date) && daysFrom(data.day, t.due_date) < 0;
function dueTag(t) {
  if (!t.due_date) return "";
  const n = daysFrom(data.day, t.due_date);
  const [, m, d] = t.due_date.split("-").map(Number);
  const text = n === -1 ? "вчера" : n === -2 ? "позавчера" : n === 0 ? "сегодня" : n === 1 ? "завтра"
    : n > 1 && n < 7 ? WD_SHORT[wdOf(t.due_date)] : `${d} ${MONTH_SHORT[m - 1]}`;
  return `<span class="due${n < 0 ? " over" : n === 0 ? " today" : ""}" title="Срок: ${esc(humanDay(t.due_date))}">${esc(text)}</span>`;
}
function noteWakes(awake, later) {
  let was = null;
  try { was = new Set(JSON.parse(localStorage.getItem("maid.sleeping") ?? "null")); } catch {}
  localStorage.setItem("maid.sleeping", JSON.stringify(later.map((t) => t.id)));
  const woke = was ? awake.filter((t) => was.has(t.id) && !wokeAt.has(t.id)) : [];
  if (!woke.length) return;
  for (const t of woke) wokeAt.set(t.id, Date.now());
  clearTimeout(wakeTimer);
  wakeTimer = setTimeout(render, WAKE_SHOW + 50); // блик кончился — строка становится обычной
  popTone(6);
  react("surprised", 4000);
  say(woke.length > 1
    ? `Проснулись задачи: ${woke.map((t) => `«${t.title}»`).join(", ")} — срок уже близко ⏰`
    : `Вспомнила про «${woke[0].title}» — ${dueWhen(woke[0].due_date)} ⏰`, { ms: 8000 });
}
let cfg = { opacity: 0.92, side: "right", size: "m", sections: { next: true, habits: true, tasks: true, soon: true }, clock: "list", dateLead: "1", doneTasks: "keep", laterTasks: "hide", proposalWait: 12, clashWait: 10, mute: false };
const MAID_W = { s: 160, m: 196, l: 236 };


// --- звуки ---
const SOUNDS = {};
for (const n of ["pop", "ding", "send", "oops", "hey"]) {
  SOUNDS[n] = new Audio(`../assets/sounds/${n}.wav`);
  SOUNDS[n].volume = 0.45;
}
function play(name) {
  const a = SOUNDS[name];
  if (!a || cfg.mute) return;
  a.currentTime = 0;
  a.play().catch(() => {});
}

const KIND = {
  diary: ["📓", "Дневник"], event: ["📅", "План"], task: ["✅", "Задача"], date: ["🎂", "Дата"], memory: ["🧠", "Память"],
  metric: ["📊", "Показатель"], money: ["💰", "Деньги"], habit: ["🔁", "Привычка"], mark: ["✔", "Отметка"], edit: ["✎", "Правка"],
};

// Куда ведёт карточка записи из облачка: раздел приложения (веб-приложение в главном окне).
function sectionOf(c) {
  if (c.kind === "diary") return /^Здоровье/.test(c.title) ? "/health" : `/diary/${data?.day ?? ""}`.replace(/\/$/, "");
  return { event: "/plans", task: "/plans", date: "/plans", money: "/money", metric: "/health", habit: "/habits", mark: "/habits" }[c.kind] ?? "/";
}

// --- горничная: 27 анимаций (assets/maid/<имя>.webp, исходники — «А ПРИКОЛЫ/Маскот/Анимации», «…/Маскот/mascot2» и «…/Маскот/3/forget») ---
// Основа — ждёт / думает / спит / нет связи; на события она на несколько секунд реагирует (react), потом возвращается к основе.
const MOODS = ["idle", "think", "sleep", "happy", "proud", "angry", "sad", "worried", "surprised", "neutral",
  "hello", "listen", "write", "done", "remind", "clean", "tea", "streak", "offline", "bow",
  "smitten", "giggle", "refuse", "smug", "gasp", "excited", "forget"];
for (const n of MOODS) new Image().src = `../assets/maid/${n}.webp`;
// Эмоция ответа сервера → анимация.
const EMOTION_MOOD = { neutral: "neutral", happy: "happy", proud: "proud", angry: "angry", sad: "sad", worried: "worried",
  surprised: "surprised", thinking: "think", sleepy: "sleep", stern: "refuse", teasing: "smug", awkward: "forget" };
let mood = "";
let moodUntil = 0;
let moodTimer = 0;
let online = true;
function baseMood() {
  if (state === "think") return "think";
  if (!online) return "offline";
  // Скоро план (≤ 10 мин) — показывает часики, даже ночью; есть просроченные задачи — недовольна, но сон важнее (fun.js, dueMood).
  const due = typeof dueMood !== "undefined" ? dueMood : "";
  if (due === "remind") return due;
  if (state === "sleep") return "sleep";
  if (due) return due;
  // День не задался (просрочено, не отмечено) — грустно метёт (fun.js, dayMood).
  return typeof dayMood !== "undefined" && dayMood === "bad" ? "clean" : "idle";
}
function showMood(n) {
  if (!MOODS.includes(n)) return;
  if (n === "forget") return forgetFlash();
  if (n === mood) return;
  mood = n;
  clearTimeout(forgetTimer);
  $("#face").src = `../assets/maid/${n}.webp`;
}
// «Стираю память» (forget): поднимает прибор, 3 с на линзе горит огонёк, на 84-м кадре (3,5 с) щелчок — в этот миг
// вспышка от его линзы, потом ещё 2 с стоит с прибором. Анимация играет один раз (5,5 с).
// Картинка каждый раз грузится заново (?метка), чтобы анимация шла с первого кадра и вспышка попала в щелчок.
const FORGET = { loop: 5500, click: 3500, x: 0.367, y: 0.584, zap: 700 }; // длина, щелчок (мс), линза в долях картинки, звук до щелчка
let forgetTimer = 0, zapTimer = 0;
function forgetFlash() {
  mood = "forget";
  clearTimeout(forgetTimer);
  clearTimeout(zapTimer);
  const face = $("#face");
  face.src = `../assets/maid/forget.webp?${Date.now()}`;
  maid.memFlashPrep?.();
  const arm = () => {
    zapTimer = setTimeout(() => { if (mood === "forget") zapTone(); }, FORGET.click - FORGET.zap);
    forgetTimer = setTimeout(() => {
      const r = face.getBoundingClientRect();
      if (mood !== "forget" || !r.width) return;
      const fx = r.left + r.width * FORGET.x, fy = r.top + r.height * FORGET.y;
      // В программе — окнами поверх экранов (свет не обрезает край виджета) и засветкой самого виджета, кроме горничной;
      // без неё (страница в браузере) — внутри.
      if (maid.memFlash) {
        maid.memFlash(window.screenX + fx, window.screenY + fy);
        veilFlash(face, fx, fy);
      } else {
        const f = $("#flash");
        f.style.setProperty("--fx", `${Math.round(fx)}px`);
        f.style.setProperty("--fy", `${Math.round(fy)}px`);
        f.classList.remove("on");
        void f.offsetWidth;
        f.classList.add("on");
      }
    }, FORGET.click);
  };
  face.decode().then(arm, arm);
}
// Засветка самого виджета: окно вспышки лежит под ним, и без неё панель и облачко остались бы чёткими.
// Холст во всё окно, белый, с дыркой по силуэту горничной (её текущий кадр) — сама она не ослеплена.
function veilFlash(face, fx, fy) {
  const v = $("#veil");
  const dpr = devicePixelRatio || 1, W = innerWidth, H = innerHeight;
  v.width = Math.round(W * dpr);
  v.height = Math.round(H * dpr);
  const g = v.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const grad = g.createRadialGradient(fx, fy, 0, fx, fy, Math.max(W, H));
  grad.addColorStop(0, "rgba(255, 255, 255, .95)");
  grad.addColorStop(0.4, "rgba(240, 246, 255, .88)");
  grad.addColorStop(1, "rgba(226, 238, 255, .8)");
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  // Видна только та часть фигурки, что над панелью: ниже её прячет панель — там дырки нет.
  const r = face.getBoundingClientRect();
  const tops = ["#w", "#mini"].map((s) => $(s)?.getBoundingClientRect()).filter((b) => b && b.height > 0).map((b) => b.top);
  const cut = tops.length ? Math.min(...tops) : H;
  g.save();
  g.beginPath();
  g.rect(0, 0, W, cut);
  g.clip();
  g.globalCompositeOperation = "destination-out";
  g.filter = "blur(1.5px)";
  g.drawImage(face, r.left, r.top, r.width, r.height);
  g.restore();
  v.classList.remove("on");
  void v.offsetWidth;
  v.classList.add("on");
}
// Звук нейралайзера: тонкий писк нарастает (FORGET.zap мс), щелчок, «пиу» вниз и глухой хлопок.
function zapTone() {
  if (cfg.mute) return;
  try {
    actx ??= new AudioContext();
    const t0 = actx.currentTime + 0.005, t = t0 + FORGET.zap / 1000;
    const out = actx.createGain();
    out.gain.value = 0.55;
    out.connect(actx.destination);
    const tone = (type, f0, f1, a, b, vol) => {
      const o = actx.createOscillator(), og = actx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(f0, a);
      o.frequency.exponentialRampToValueAtTime(f1, b);
      og.gain.setValueAtTime(0.0001, a);
      og.gain.exponentialRampToValueAtTime(vol, a + 0.01);
      og.gain.exponentialRampToValueAtTime(0.0001, b);
      o.connect(og).connect(out);
      o.start(a);
      o.stop(b + 0.02);
      return og;
    };
    // Писк зарядки: тише в начале, громче к щелчку.
    const whine = tone("sine", 1500, 3400, t0, t + 0.01, 0.006);
    whine.gain.exponentialRampToValueAtTime(0.05, t - 0.02);
    whine.gain.exponentialRampToValueAtTime(0.0001, t + 0.01);
    // Щелчок: 14 мс шума выше 2,5 кГц.
    const n = actx.createBufferSource();
    const buf = actx.createBuffer(1, Math.round(actx.sampleRate * 0.014), actx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    n.buffer = buf;
    const hp = actx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 2500;
    const ng = actx.createGain();
    ng.gain.value = 0.5;
    n.connect(hp).connect(ng).connect(out);
    n.start(t);
    // «Пиу» вниз и хлопок.
    tone("triangle", 3200, 420, t, t + 0.38, 0.13);
    tone("sine", 150, 48, t, t + 0.3, 0.32);
  } catch {}
}
function react(n, ms = 6000) {
  if (n === "forget") ms = FORGET.loop; // ровно один показ: огонёк, щелчок, 2 с с прибором
  clearTimeout(moodTimer);
  moodUntil = Date.now() + ms;
  showMood(n);
  moodTimer = setTimeout(() => { moodUntil = 0; showMood(baseMood()); }, ms);
}
function settle() {
  if (Date.now() < moodUntil) return;
  showMood(baseMood());
}

// --- состояния ---
function setState(s) {
  state = s;
  // Думает — сразу, поверх любой реакции.
  if (s === "think") { clearTimeout(moodTimer); moodUntil = 0; }
  settle();
}
// --- сон: спит, когда человека нет за ПК, а не по часам ---
// Засыпает, если ПК не трогали NAP_AFTER (или не ответили на её сообщение NAP_UNHEARD), после обычного отбоя — уже через NAP_NIGHT.
// Пока спит — молчит: уведомления только в ящик и в список «пока вас не было». Тронули ПК — просыпается, «О, вы вернулись!» и пересказ.
// Обычный отбой она узнаёт сама: когда вечером человек уходил от ПК больше чем на 1,5 ч (медиана 14 последних ночей, по умолчанию 23:00).
const NAP_AFTER = 15 * 60;
const NAP_UNHEARD = 5 * 60;
const NAP_NIGHT = 3 * 60;
const MORNING = 7 * 60;
let napping = false;
let napSince = 0; // когда человек ушёл (мс)
let missed = []; // уведомления, пришедшие во сне
let unheardAt = 0; // её сообщение, на которое ещё не отреагировали
const nightMin = (t) => { const m = t.getHours() * 60 + t.getMinutes(); return m < 12 * 60 ? m + 24 * 60 : m; }; // после полуночи — «24:30»
function bedtime() {
  let list = [];
  try { list = JSON.parse(localStorage.getItem("maid.bedtimes") ?? "[]"); } catch {}
  if (list.length < 3) return 23 * 60;
  const s = [...list].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function learnBedtime(from, to) {
  const start = new Date(from);
  const m = nightMin(start);
  // Вечер 20:00 … утро 5:00, и ушёл надолго — похоже на отбой.
  if (to - from < 90 * 60_000 || m < 20 * 60 || m > 29 * 60) return;
  let list = [];
  try { list = JSON.parse(localStorage.getItem("maid.bedtimes") ?? "[]"); } catch {}
  localStorage.setItem("maid.bedtimes", JSON.stringify([...list, m].slice(-14)));
}
function afterBedtime(t = new Date()) {
  const m = nightMin(t);
  return m >= bedtime() && m < MORNING + 24 * 60;
}
const restState = () => (napping ? "sleep" : "idle");
function fallAsleep(idleSec) {
  if (napping || state === "think") return;
  napping = true;
  napSince = Date.now() - idleSec * 1000;
  hideBubble();
  setState("sleep");
}
function wakeUp() {
  if (!napping) return;
  napping = false;
  learnBedtime(napSince, Date.now());
  const away = Date.now() - napSince;
  const news = missed;
  missed = [];
  unheardAt = 0;
  setState("idle");
  // Потягивается: удивилась — и машет.
  react("surprised", 1300);
  setTimeout(() => {
    if (napping) return;
    react("hello", 4500);
    if (away < 2 * 60_000 && !news.length) return;
    const lines = news.slice(-4).map((n) => `• ${String(n.text).split("\n")[0].replace(/<[^>]+>/g, "")}`);
    const more = news.length > 4 ? `\n…и ещё ${news.length - 4} — в ящике у головы.` : news.length ? "\nВсё это — в ящике у головы." : "";
    say(`О, вы вернулись!${news.length ? `\nПока вас не было:\n${lines.join("\n")}${more}` : ""}`, { ms: news.length ? 20000 : 4000, emotion: "happy", sound: news.length ? "ding" : null });
  }, 1300);
}
async function watchAway() {
  let idle;
  try { idle = await maid.idle(); } catch { return; }
  if (typeof idle !== "number") return;
  if (napping) return void (idle < 5 && wakeUp());
  const unheard = unheardAt && idle >= NAP_UNHEARD && idle * 1000 >= Date.now() - unheardAt; // с её сообщения ПК не трогали
  if (idle >= (afterBedtime() ? NAP_NIGHT : NAP_AFTER) || unheard) fallAsleep(idle);
  if (idle < 5) unheardAt = 0;
}
setInterval(() => watchAway(), 3_000);
// Мышь над самой горничной будит сразу, не дожидаясь опроса.
document.addEventListener("pointermove", () => napping && wakeUp());
document.addEventListener("keydown", () => napping && wakeUp());

setInterval(() => {
  if (state === "think") return;
  const want = restState();
  if (want !== state) setState(want);
  // После отбоя — не суетится: без чая, уборки и радостей.
  else if (afterBedtime()) return;
  // Изредка, пока ничего не происходит, — занимается своим: чай (утром чаще), уборка, поклон.
  else if (state === "idle" && online && Date.now() > moodUntil && $("#bubble").classList.contains("hidden") && Math.random() < 0.1) {
    const h = new Date().getHours();
    const pick = h < 11 && Math.random() < 0.5 ? "tea" : ["tea", "clean", "clean", "bow"][Math.floor(Math.random() * 4)];
    react(pick, 6000);
  }
  // День идёт хорошо — радуется чаще, сама по себе.
  else if (state === "idle" && online && dayMood === "good" && Date.now() > moodUntil && $("#bubble").classList.contains("hidden") && Math.random() < 0.25)
    react(["happy", "proud", "giggle", "bow", "excited"][Math.floor(Math.random() * 5)], 5000);
  // Не задался — изредка вздыхает.
  else if (state === "idle" && online && dayMood === "bad" && Date.now() > moodUntil && Math.random() < 0.12) react("sad", 5000);
}, 30_000);

// --- облачко ---
function say(text, { buttons = [], emotion = "neutral", ms = 14000, changes = [], undo = null, sound = null, days = [], mood: as = null, heard = "", notice = null, proposal = null, stay = false } = {}) {
  // Спит — молчит (её будит человек; ответы и уведомления сначала будят — см. wakeUp, pollNotices).
  if (napping) return;
  const b = $("#bubble");
  delete b.dataset.quip;
  stopProposal();
  if (proposal && proposal.status !== "open") proposal = null;
  // stay — ответ на строку свёрнутого виджета: облачко над головой, панель остаётся свёрнутой.
  if (text !== "…" && !stay) openForMessage();
  // Ответ на вопрос со ссылками на дни: строку «📅 …» заменяют кнопки дней.
  if (days.length) text = text.replace(/\n📅 .*$/, "");
  // Ответ без карточек — текст целиком; с карточками — только первая строка (остальное показывают карточки).
  // С вопросом «добавить?» или «Сдвинуть на …?» (план лёг на занятое время) — ещё и сам вопрос (последняя строка).
  const ask = proposal || text.split("\n").at(-1).startsWith("⚠ ");
  const plain = changes.length ? text.split("\n")[0] + (ask ? "\n" + text.split("\n").at(-1) : "") : text;
  $("#bubbleText").innerHTML = (heard ? `<div class="heard">🎙 ${esc(heard)}</div>` : "") + tgHtml(plain);
  const cards = $("#bubbleCards");
  cards.innerHTML = "";
  changes.forEach((c, i) => {
    const [icon, name] = KIND[c.kind] ?? ["•", c.kind];
    const el = document.createElement("div");
    el.className = `card k-${c.kind} go`;
    el.title = "Открыть в приложении";
    el.onclick = () => {
      hideBubble();
      maid.openSection(sectionOf(c));
    };
    el.style.animationDelay = `${160 + i * 140}ms`;
    el.innerHTML = `<span class="card-icon">${icon}</span><span class="card-body"><b>${esc(name)}</b> ${esc(c.title)}${c.detail ? `<span class="card-detail">${esc(c.detail)}</span>` : ""}</span>`;
    cards.appendChild(el);
    setTimeout(() => play("pop"), 160 + i * 140);
  });
  for (const d of days) {
    const el = document.createElement("button");
    el.className = "card day";
    el.textContent = "📅 " + humanDay(d).split(",")[0];
    el.onclick = () => maid.openDay(d);
    cards.appendChild(el);
  }
  // Вопрос «добавить?»: пункты (у нескольких — галочки, по умолчанию отмечены все).
  if (proposal) {
    const list = document.createElement("div");
    list.className = "prop-list";
    const many = proposal.items.length > 1;
    list.innerHTML = proposal.items.map((it, i) => `<label class="prop-item${many ? "" : " one"}">${many ? `<input type="checkbox" data-pi="${i}"${proposal.picked.includes(i) ? " checked" : ""}>` : ""}<span><b>${esc(it.title)}</b>${it.detail ? `<i>${esc(it.detail)}</i>` : ""}</span></label>`).join("");
    list.style.animationDelay = `${160 + changes.length * 140}ms`;
    cards.appendChild(list);
  }
  const acts = $("#bubbleActions");
  acts.innerHTML = proposal
    ? (proposal.remind ? `<button class="prop-yes" data-p="remind">✅ ${esc(proposal.remind.label)}</button>` : "")
      + `<button class="prop-yes" data-p="add">✅ ${esc(proposal.add)}</button>`
      + `<button class="prop-no" data-p="decline" title="Пока курсор на облачке — ждёт"><span class="fill"></span><span class="lbl">Не надо</span></button>`
      + (undo ? `<button data-i="undo">↩ Отменить</button>` : "")
    : buttons.map((x, i) => (x.auto ? `<button class="auto" data-i="${i}" title="Пока курсор на облачке — ждёт"><span class="fill"></span><span class="lbl">${esc(x.text)}</span></button>` : `<button data-i="${i}">${esc(x.text)}</button>`)).join("")
      + (undo ? `<button data-i="undo">↩ Отменить</button>` : "") + `<button class="ghost" data-i="close">✕</button>`;
  // Напоминание из ящика (inbox.js): любая кнопка или ✕ — прочитано; без кнопок — если курсор задержался на облачке.
  b.dataset.notice = notice ?? "";
  $("#inbox").classList.add("away"); // пока говорит — значок не мешает облачку
  b.onmouseenter = notice && !buttons.length
    ? () => setTimeout(() => { if (b.dataset.notice === String(notice) && !b.classList.contains("hidden")) inboxRead(notice); }, 1200)
    : null;
  if (proposal) startProposal(proposal);
  stopAuto();
  acts.querySelectorAll("button").forEach((btn) => {
    if (btn.dataset.p) return; // кнопки вопроса «добавить?» — startProposal
    btn.onclick = async () => {
      if (notice) inboxRead(notice);
      if (btn.dataset.i === "close") return hideBubble();
      if (btn.dataset.i === "undo") {
        try {
          const r = await maid.api("POST", "/api/undo", { messageId: undo });
          play("send");
          say(r.text, { ms: 6000, mood: "gasp" });
          maid.changed();
        } catch (e) {
          play("oops");
          say(e.message, { ms: 6000 });
        }
        return;
      }
      const x = buttons[Number(btn.dataset.i)];
      // Кнопка из самого виджета (не из уведомления сервера) — своё действие.
      if (x.run) {
        hideBubble();
        return x.run();
      }
      const m = x.data.match(/^habit:(\d+):(\d{4}-\d{2}-\d{2}):(done|skipped)$/);
      try {
        if (m) {
          if (m[3] === "done") { popTone(3); react("streak", 4000); } else { popTone(-5, { vol: 0.2, soft: true }); react("sad", 3500); }
          const r = await maid.api("POST", `/api/habits/${m[1]}/mark`, { status: m[3], day: m[2] });
          say(r.text, { ms: 5000 });
          maid.changed();
        } else hideBubble();
      } catch (e) {
        say(e.message, { ms: 6000 });
      }
    };
  });
  b.className = `bubble ${emotion}`;
  placeBubble();
  // Кнопка с самонажатием (auto: секунды) — облачко держит она, своего таймера нет.
  const autoBtn = acts.querySelector("button.auto");
  if (autoBtn) {
    startAuto(autoBtn, buttons[Number(autoBtn.dataset.i)].auto * 1000);
    ms = 0;
  }
  // Реакция горничной: записала что-то — пишет, отметила — галочка, иначе по эмоции ответа.
  if (text !== "…") {
    const marked = changes.some((c) => c.kind === "mark" || c.kind === "habit");
    const pick = as ?? (marked ? "done" : changes.length ? "write" : EMOTION_MOOD[emotion] ?? "neutral");
    react(pick, Math.max(4000, Math.min(ms || 9000, 9000)));
    // «Стираю память»: облачко с ответом — когда сойдёт засветка (щелчок + ~0,9 с), а не одновременно со вспышкой.
    if (pick === "forget") {
      b.classList.add("after-flash");
      setTimeout(() => b.classList.remove("after-flash"), FORGET.click + 900);
    }
  }
  if (sound) play(sound);
  if (changes.some((c) => c.kind === "event")) farPlanSoon(changes);
  clearTimeout(bubbleTimer);
  // Вопрос «добавить?» облачко закрывает сам (полоса на «Не надо»).
  if (proposal) ms = 0;
  // Длинный текст висит дольше (время на чтение), а под курсором не пропадает вовсе — см. hideBubbleWhenFree.
  if (ms) bubbleTimer = setTimeout(hideBubbleWhenFree, ms + changes.length * 900 + Math.min(60000, Math.max(0, plain.length - 120) * 55));
}

// --- вопрос «добавить?» (привычки из рассказа о распорядке, задачи из «надо бы…») ---
// Кнопка «Не надо» заполняется спокойной полосой (настройка «proposalWait», 12 с); пока курсор на облачке — пауза; дошла — «Не надо», облачко закрывается.
// Ответили в Telegram — облачко само закрывается (раз в 4 с спрашивает сервер).
let propRun = null;
function stopProposal() {
  if (!propRun) return;
  cancelAnimationFrame(propRun.raf);
  clearInterval(propRun.poll);
  propRun = null;
}
function startProposal(p) {
  const b = $("#bubble");
  const acts = $("#bubbleActions");
  const fill = acts.querySelector(".prop-no .fill");
  const wait = cfg.proposalWait * 1000;
  const run = (propRun = { id: p.id, left: wait, last: performance.now(), raf: 0, poll: 0, busy: false });
  const picked = () => {
    const boxes = [...$("#bubbleCards").querySelectorAll("input[data-pi]")];
    return boxes.length ? boxes.filter((x) => x.checked).map((x) => Number(x.dataset.pi)) : p.items.map((_, i) => i);
  };
  const decide = async (action, quiet = false) => {
    if (run.busy || propRun !== run) return;
    run.busy = true;
    const choice = action === "decline" ? [] : picked();
    if (action !== "decline" && !choice.length) {
      run.busy = false;
      play("oops");
      acts.classList.remove("shake");
      void acts.offsetWidth;
      return acts.classList.add("shake");
    }
    stopProposal();
    if (action === "decline") {
      popTone(-3, { vol: 0.12, soft: true });
      if (quiet) hideBubble();
    } else popTone(3);
    try {
      const r = await maid.api("POST", `/api/proposals/${p.id}`, { action, picked: action === "decline" ? undefined : choice });
      if (action === "decline" && quiet) return;
      if (r.done && action !== "decline") {
        say(r.text, { changes: r.changes ?? [], ms: 6000, sound: "ding", mood: "done" });
        maid.changed();
      } else say(r.text, { ms: 4000 });
    } catch (e) {
      if (!quiet) say(e.message, { ms: 6000, emotion: "worried" });
    }
  };
  acts.querySelectorAll("button[data-p]").forEach((btn) => (btn.onclick = () => decide(btn.dataset.p)));
  const tick = (t) => {
    if (propRun !== run) return;
    const dt = t - run.last;
    run.last = t;
    // Пауза, пока курсор на облачке (или облачко скрыто под свёрнутой панелью).
    if (!b.matches(":hover") && !b.classList.contains("hidden")) run.left -= dt;
    if (fill) fill.style.transform = `scaleX(${Math.min(1, 1 - run.left / wait)})`;
    if (run.left <= 0) return void decide("decline", true);
    run.raf = requestAnimationFrame(tick);
  };
  run.raf = requestAnimationFrame(tick);
  run.poll = setInterval(async () => {
    try {
      const now = await maid.api("GET", `/api/proposals/${p.id}`);
      if (propRun === run && now.status !== "open") {
        stopProposal();
        hideBubble();
      }
    } catch { /* нет связи — ждём */ }
  }, 4000);
}

// Кнопка, которая нажмётся сама (у наложения планов — «Оставить»): фон заполняется слева направо за wait мс,
// пока курсор на облачке — пауза; дошла — вспыхивает и нажимается (тот же onclick, что у щелчка).
let autoRun = null;
function stopAuto() {
  if (!autoRun) return;
  cancelAnimationFrame(autoRun.raf);
  clearTimeout(autoRun.press);
  autoRun = null;
}
function startAuto(btn, wait) {
  const b = $("#bubble");
  const fill = btn.querySelector(".fill");
  const run = (autoRun = { left: wait, last: performance.now(), raf: 0, press: 0 });
  const tick = (t) => {
    if (autoRun !== run) return;
    const dt = t - run.last;
    run.last = t;
    if (!b.matches(":hover") && !b.classList.contains("hidden")) run.left -= dt;
    fill.style.transform = `scaleX(${Math.min(1, 1 - run.left / wait)})`;
    if (run.left > 0) return void (run.raf = requestAnimationFrame(tick));
    btn.classList.add("pressed");
    run.press = setTimeout(() => autoRun === run && (stopAuto(), btn.click()), 380);
  };
  run.raf = requestAnimationFrame(tick);
}

// Облачко ждёт, пока курсор на нём, и ещё немного после того, как его увели.
let bubbleLeftAt = 0;
$("#bubble").addEventListener("mouseleave", () => (bubbleLeftAt = Date.now()));
function hideBubbleWhenFree() {
  if ($("#bubble").matches(":hover") || Date.now() - bubbleLeftAt < 2500) return (bubbleTimer = setTimeout(hideBubbleWhenFree, 400));
  hideBubble();
}

// --- чат с горничной ---
// Отправленное встаёт в очередь над строкой и уходит по одному: поле сразу свободно, можно писать следующее.
// Нет связи — сообщение остаётся в очереди и на этом компьютере (localStorage): «Повторить» или «Отправить, когда появится связь».
// Повтор безопасен: у сообщения свой id, сервер второй раз его не запишет.
const chatInput = $("#chatInput");
const OUTBOX_KEY = "maid.outbox";
let outbox = (() => {
  try {
    // Прервалось на отправке (закрыли виджет) — снова в очередь.
    return (JSON.parse(localStorage.getItem(OUTBOX_KEY)) ?? []).map((m) => ({ ...m, state: m.state === "sending" ? "wait" : m.state }));
  } catch { return []; }
})();
let pumping = false;
function saveOutbox() {
  // Картинки и голос могут не влезть в хранилище — тогда на диск идут только небольшие сообщения.
  const keep = outbox.filter((m) => JSON.stringify(m).length < 400_000);
  try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(keep)); } catch { try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(keep.filter((m) => !m.body.images && !m.body.audio))); } catch {} }
}
const offline = (e) => /нет связи с сервером|сервер не ответил/.test(e?.message ?? "");
const errText = (e) => String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

function sendChat() {
  const text = chatInput.value.trim();
  if (!text && !pictures.length) return;
  const images = pictures.length ? pictures.map((p) => ({ data: p.data, mime: p.mime })) : undefined;
  chatInput.value = "";
  fitChat();
  setPictures([]);
  syncSend();
  const label = images ? `${images.length > 1 ? `📷×${images.length}` : "📷"} ${text}`.trim() : text;
  enqueue("/api/input", { text, images, id: crypto.randomUUID() }, label);
  chatInput.focus();
}
function enqueue(path, body, label, mini = false) {
  outbox.push({ id: body.id, path, body, label, state: "wait", at: Date.now(), mini });
  saveOutbox();
  play("send");
  drawOutbox();
  pump();
}
// Отправляет первое ждущее сообщение; дошло — следующее.
async function pump() {
  if (pumping) return;
  const m = outbox.find((x) => x.state === "wait");
  if (!m) return;
  pumping = true;
  m.state = "sending";
  drawOutbox();
  setState("think");
  say("…", { ms: 0 });
  let next = true;
  try {
    const r = await maid.api("POST", m.path, m.body);
    outbox = outbox.filter((x) => x !== m);
    remember(m.body.text || r.heard || m.label, r);
    say(r.text, { emotion: r.emotion, changes: r.changes ?? [], days: r.days ?? [], undo: r.undoable ? r.messageId : null, ms: 16000, sound: r.changes?.length ? "ding" : null, heard: r.heard, mood: heardMood(m.body?.text ?? r.heard, r), proposal: r.proposal, buttons: [...failedButtons(r), ...clashButtons(r)], stay: m.mini && collapsed });
    maid.changed();
  } catch (e) {
    if (offline(e)) {
      // Связи нет — дальше по очереди тоже не пройдёт: все ждущие остаются на этом компьютере.
      for (const x of outbox) if (x === m || x.state === "wait") x.state = x.auto ? "later" : "failed";
      hideBubble();
      play("oops");
      react("sad", 3500);
      next = false;
    } else {
      outbox = outbox.filter((x) => x !== m);
      say(errText(e), { emotion: "worried", ms: 8000, sound: "oops" });
    }
  } finally {
    pumping = false;
    saveOutbox();
    drawOutbox();
    setState(restState());
    if (next) pump();
  }
}
function retryOutbox(auto) {
  for (const x of outbox) if (x.state === "failed" || (auto === null && x.state === "later")) { x.state = "wait"; if (auto) x.auto = true; }
  saveOutbox();
  drawOutbox();
  pump();
}
// «Отправить, когда появится связь»: раз в 20 секунд и при появлении сети пробуем снова.
setInterval(() => { if (outbox.some((x) => x.state === "later")) retryOutbox(null); }, 20_000);
window.addEventListener("online", () => { if (outbox.some((x) => x.state === "later")) retryOutbox(null); });

function drawOutbox() {
  const box = $("#chatQueue");
  const fails = outbox.filter((m) => m.state === "failed");
  const rows = outbox.filter((m) => m.state !== "failed");
  box.classList.toggle("hidden", !outbox.length);
  const row = (m, i) => {
    const icon = m.state === "sending" ? `<span class="ob-spin"></span>` : m.state === "later" ? `<span class="ob-wait" title="Ждёт связи">⏳</span>` : `<span class="ob-dot"></span>`;
    const note = m.state === "later" ? `<span class="ob-note">ждёт связи</span>` : "";
    const drop = m.state === "sending" ? "" : `<button type="button" class="ob-drop" data-ob-drop="${esc(m.id)}" title="Убрать из очереди" aria-label="Убрать из очереди">✕</button>`;
    return `<div class="ob-row ${m.state}"><span class="ob-text" title="${esc(m.label)}">${icon}${esc(m.label)}</span>${note}${rows.length > 1 ? `<span class="ob-n">${i + 1}</span>` : ""}${drop}</div>`;
  };
  const fail = fails.length
    ? `<div class="ob-fail" role="alert"><div class="ob-msg">Не отправилось: нет связи с сервером. ${fails.length > 1 ? `Сообщения (${fails.length}) сохранены` : "Сообщение сохранено"} на этом компьютере.</div>`
      + fails.map((m) => `<div class="ob-row failed"><span class="ob-text" title="${esc(m.label)}">${esc(m.label)}</span><button type="button" class="ob-drop" data-ob-drop="${esc(m.id)}" title="Удалить сообщение" aria-label="Удалить сообщение">✕</button></div>`).join("")
      + `<div class="ob-acts"><button type="button" class="ob-retry" data-ob="retry">Повторить</button><button type="button" class="ob-later" data-ob="later">Отправить, когда появится связь</button></div></div>`
    : "";
  box.innerHTML = fail + rows.map(row).join("");
}
$("#chatQueue").addEventListener("click", (e) => {
  const drop = e.target.closest("[data-ob-drop]");
  if (drop) {
    outbox = outbox.filter((m) => m.id !== drop.dataset.obDrop || m.state === "sending");
    saveOutbox();
    return drawOutbox();
  }
  const b = e.target.closest("[data-ob]");
  if (b) retryOutbox(b.dataset.ob === "later");
});
drawOutbox();
setTimeout(pump, 1500); // что не ушло в прошлый раз — отправляется само

// Последние ответы горничной (на этом компьютере): облачко исчезает, а ответ и «Отменить» остаются под рукой.
const HIST_KEY = "maid.history";
const HIST_MAX = 40;
let chatLog = (() => { try { return JSON.parse(localStorage.getItem(HIST_KEY)) ?? []; } catch { return []; } })();
function remember(me, r) {
  if (!r?.text) return;
  chatLog = [...chatLog, { at: Date.now(), me: String(me ?? "").slice(0, 400), reply: String(r.text).slice(0, 2000), undo: r.undoable ? r.messageId : null }].slice(-HIST_MAX);
  try { localStorage.setItem(HIST_KEY, JSON.stringify(chatLog)); } catch {}
  if (!$("#chatHist").classList.contains("hidden")) drawHistory();
}
const clockOf = (t) => new Date(t).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
function drawHistory() {
  const box = $("#chatHist");
  box.innerHTML = chatLog.length
    ? chatLog.map((h, i) => (h.me ? `<div class="hm me">${esc(h.me)}<i>${clockOf(h.at)}</i></div>` : "")
      + `<div class="hm her">${tgHtml(h.reply)}${h.undo ? (h.undone ? ` <span class="h-undone">отменено</span>` : ` <button type="button" class="h-undo" data-h="${i}">Отменить</button>`) : ""}<i>${clockOf(h.at)}</i></div>`).join("")
    : `<div class="h-empty">Здесь будут последние ответы горничной.</div>`;
  box.scrollTop = box.scrollHeight;
}
// История встаёт на место списка задач (панель вытягивается, как с настройками) и занимает ровно свободное место:
// раньше она росла до 260 px поверх всего и выталкивала строку ввода за низ панели.
function toggleHistory(on = $("#chatHist").classList.contains("hidden")) {
  $("#chatHist").classList.toggle("hidden", !on);
  $("#chatHistBtn").classList.toggle("on", on);
  $("#w").classList.toggle("hist-open", on);
  if (on) drawHistory();
  fitHistory();
}
function fitHistory() {
  const box = $("#chatHist");
  const w = $("#w");
  if (box.classList.contains("hidden")) return void box.style.removeProperty("max-height");
  box.style.maxHeight = "60px";
  // Низ строки ввода при истории в 60 px — сколько до низа панели осталось, отдать истории.
  const chat = $("#chat");
  const free = w.clientHeight - parseFloat(getComputedStyle(w).paddingBottom) - (chat.offsetTop + chat.offsetHeight);
  box.style.maxHeight = `${Math.max(60, 60 + free)}px`;
  w.scrollTop = 0;
  box.scrollTop = box.scrollHeight;
}
addEventListener("resize", fitHistory);
$("#chatHistBtn").addEventListener("click", (e) => { e.preventDefault(); toggleHistory(); chatInput.focus(); });
chatInput.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#chatHist").classList.contains("hidden")) { e.preventDefault(); toggleHistory(false); } });
// Копировать из истории: выделенное (Ctrl+C или ПКМ) или всё сообщение (ПКМ без выделения) — без строки времени.
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); } catch { document.execCommand("copy"); }
  play("send");
}
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.code === "KeyC" && document.activeElement !== chatInput && histPicked()) { e.preventDefault(); copyText(histPicked()); }
});
$("#chatHist").addEventListener("contextmenu", (e) => {
  const msg = e.target.closest(".hm");
  const picked = histPicked();
  if (!msg && !picked) return;
  e.preventDefault();
  closePlanMenu();
  const whole = () => { const c = msg.cloneNode(true); c.querySelectorAll("i, button, .h-undone").forEach((x) => x.remove()); return c.textContent.trim(); };
  const menu = document.createElement("div");
  menu.className = "pl-menu";
  menu.innerHTML = (picked ? `<button type="button" data-act="sel">⧉ Копировать выделенное</button>` : "")
    + (msg ? `<button type="button" data-act="msg">⧉ Копировать сообщение</button>` : "");
  showPlanMenu(menu, e.clientX, e.clientY);
  menu.addEventListener("click", (ev) => {
    const act = ev.target.closest("[data-act]")?.dataset.act;
    if (!act) return;
    closePlanMenu();
    copyText(act === "sel" ? picked : whole());
  });
});
$("#chatHist").addEventListener("click", async (e) => {
  const b = e.target.closest(".h-undo");
  if (!b) return;
  const h = chatLog[Number(b.dataset.h)];
  b.disabled = true;
  try {
    const r = await maid.api("POST", "/api/undo", { messageId: h.undo });
    h.undone = true;
    try { localStorage.setItem(HIST_KEY, JSON.stringify(chatLog)); } catch {}
    drawHistory();
    play("send");
    say(r.text, { ms: 6000, mood: "gasp" });
    maid.changed();
  } catch (err) {
    b.disabled = false;
    play("oops");
    say(errText(err), { ms: 6000 });
  }
});

// Картинки к сообщению (до PICS_MAX): скрепка, Ctrl+V в строке или перетащить на виджет.
// Ряд миниатюр над строкой ввода; уходят с ближайшим Enter, подпись — по желанию.
const PICS_MAX = 6;
let pictures = [];
function setPictures(list) {
  pictures = list;
  const box = $("#chatPics");
  box.classList.toggle("hidden", !list.length);
  box.replaceChildren(...list.map((p, i) => {
    const el = document.createElement("div");
    el.className = "pic";
    el.innerHTML = `<img alt="" /><button type="button" title="Убрать картинку" aria-label="Убрать картинку">✕</button>`;
    el.querySelector("img").src = p.url;
    el.querySelector("button").addEventListener("click", (e) => { e.preventDefault(); setPictures(pictures.filter((_, j) => j !== i)); chatInput.focus(); });
    return el;
  }));
  chatInput.placeholder = list.length ? "Подпись к картинкам (можно пусто) — Enter" : "Скажи горничной…";
  syncSend();
  if (list.length) chatInput.focus();
}
async function attachFiles(files) {
  files = [...files];
  if (!files.length) return;
  const room = PICS_MAX - pictures.length;
  if (room <= 0) return say(`Больше ${PICS_MAX} картинок за раз не возьму.`, { emotion: "worried", ms: 4000 });
  try {
    const shrunk = await Promise.all(files.slice(0, room).map((f) => shrinkImage(f)));
    setPictures([...pictures, ...shrunk]);
    react("surprised", 2500);
    if (files.length > room) say(`Взяла ${room}, больше ${PICS_MAX} за раз нельзя.`, { emotion: "worried", ms: 4000 });
  } catch { say("Не получилось открыть картинку.", { emotion: "worried", ms: 5000, sound: "oops" }); }
}
$("#chatClip").addEventListener("click", () => { maid.focusInput(true); $("#chatFile").click(); });
$("#chatFile").addEventListener("change", (e) => { attachFiles(e.target.files); e.target.value = ""; });
chatInput.addEventListener("paste", (e) => {
  const f = imagesFrom(e.clipboardData);
  if (f.length) { e.preventDefault(); attachFiles(f); }
});
document.addEventListener("drop", (e) => attachFiles(imagesFrom(e.dataTransfer)));
// Реакция на сказанное, что бы ни ответил сервер: пошлое (запись про секс и т. п.) — довольная ухмылка,
// даже если записалось; благодарность без записи — смущённо рада.
const LEWD = /(?<![а-яё])(секс|интим|пошл|переспа|трах|минет|кунилин|оральн|голая|голый|голышом|раздел[аи]сь|эрот|порн|оргазм|возбужд|похот|дроч|мастурб|сиськ|задниц|презерватив|в постел[иь] с)/i;
// Разбор не удался (модель не ответила): «Повторить» сейчас или «Оставить заметкой». Сервер и сам повторит через 2, 10 и 30 мин.
// План лёг на занятое время: «Сдвинуть на 15:00» (если есть куда) и «Оставить» — как кнопки в Telegram (/api/clash).
function clashButtons(r) {
  const c = r.clash;
  if (!c) return [];
  const act = async (action) => {
    try {
      const x = await maid.api("POST", "/api/clash", { messageId: r.messageId, eventId: c.eventId, withId: c.withId, action });
      say(x.text, { ms: 5000, sound: action === "shift" ? "ding" : null });
      maid.changed();
    } catch (e) {
      say(e.message, { ms: 6000, emotion: "worried" });
    }
  };
  // «Оставить» заполняется и нажимается сама через cfg.clashWait секунд — молчание и есть «оставить».
  return [...(c.shiftTo ? [{ text: `➜ Сдвинуть на ${c.shiftTo}`, run: () => act("shift") }] : []), { text: "Оставить", run: () => act("keep"), auto: cfg.clashWait }];
}
function failedButtons(r) {
  if (!r.failed) return [];
  const act = async (what) => {
    try {
      const x = await maid.api("POST", `/api/messages/${r.messageId}/${what}`);
      if (what === "note") say(x.text, { ms: 5000, sound: "ding" });
      else say(x.text, { emotion: x.emotion, changes: x.changes ?? [], days: x.days ?? [], undo: x.undoable ? x.messageId : null, ms: 16000, sound: x.changes?.length ? "ding" : null, proposal: x.proposal, buttons: [...failedButtons(x), ...clashButtons(x)] });
      maid.changed();
    } catch (e) {
      say(e.message, { ms: 6000, emotion: "worried" });
    }
  };
  return [{ text: "🔁 Повторить", run: () => act("retry") }, { text: "📝 Оставить заметкой", run: () => act("note") }];
}
// Сказал то, чего лучше было не говорить (сервер пометил ответ эмоцией awkward), или сам просит забыть — «стирает память».
const UNSAY = /(?<![а-яё])((?<!не )забудь|я этого не говорил|я ничего не говорил|(ты|вы) (этого|ничего) не слышал|сделай(те)? вид,? что|этого разговора не было|проехали|зря (я )?(это )?(сказал|написал|ляпнул)|ляпнул[аи]? лишн|сболтнул|не стоило (мне )?(это(го)? )?говорить|никому не (говори|рассказывай))/i;
function heardMood(text, r) {
  if (r?.emotion === "awkward") return "forget";
  if (!text) return null;
  if (UNSAY.test(text)) return "forget";
  if (LEWD.test(text)) return "smug";
  if (/спасиб|благодар/i.test(text) && !r.changes?.length) return "smitten";
  return null;
}

// --- голосом: щелчок по микрофону — запись, ещё щелчок (или Enter) — отправить, Esc — отменить ---
const mic = $("#chatMic");
let micTick = 0;
// Кнопка справа: пусто — микрофон; есть текст или картинки, или идёт запись — превращается в «отправить».
function syncSend() {
  const ready = Voice.on || Boolean(chatInput.value.trim()) || pictures.length > 0;
  $("#chat").classList.toggle("ready", ready);
  $("#chatSend").title = Voice.on ? "Отправить запись (Enter)" : "Отправить (Enter)";
}
function micUi(on) {
  chatBox.classList.toggle("recording", on);
  syncSend();
  clearInterval(micTick);
  if (!on) return;
  const time = chatBox.querySelector(".rec-time");
  const show = () => (time.textContent = Voice.clock());
  show();
  micTick = setInterval(show, 250);
  Voice.wave(chatBox.querySelector(".rec-wave"), "#cdbcff");
}
async function toggleMic() {
  if (!Voice.on) {
    try {
      await Voice.start(toggleMic);
    } catch (e) {
      return say(`Нет доступа к микрофону: ${e.message}`, { emotion: "worried", ms: 8000, sound: "oops" });
    }
    micUi(true);
    chatInput.focus();
    return;
  }
  micUi(false);
  const v = await Voice.stop();
  if (v) enqueue("/api/voice", { ...v, id: crypto.randomUUID() }, "🎙 Голосовое сообщение");
}
mic.addEventListener("click", (e) => { e.preventDefault(); toggleMic(); });
const dropRecording = () => Voice.cancel().then(() => { micUi(false); play("oops"); });
// Пока идёт запись, строки ввода нет: Enter — отправить, Esc — удалить ловятся на всём окне.
document.addEventListener("keydown", (e) => {
  if (!Voice.on) return;
  if (e.key === "Escape") { e.preventDefault(); dropRecording(); }
  else if (e.key === "Enter") { e.preventDefault(); toggleMic(); }
});
document.querySelector("#chat .rec-trash").addEventListener("click", (e) => { e.preventDefault(); dropRecording(); });
$("#chat").onsubmit = (e) => { e.preventDefault(); if (Voice.on) toggleMic(); else sendChat(); };
// Окно «сквозное» и без фокуса: навёл на строку чата — окно принимает мышь и клавиатуру, ушёл и не печатаешь — отдаёт.
const chatBox = $("#chat");
// Наведение только готовит окно (main.js делает его фокусируемым), фокус забирается щелчком — не крадём его у игры от одного наведения.
// В истории щелчок не уводит в строку ввода — там выделяют текст; окну нужна только клавиатура (Ctrl+C).
const inHist = (el) => el?.closest?.("#chatHist") && !el.closest("button");
chatBox.addEventListener("mousedown", (e) => {
  maid.focusInput(true);
  if (e.button !== 0 || inHist(e.target)) return;
  chatInput.focus();
  setTimeout(() => chatInput.focus(), 30);
});
const histPicked = () => { const sel = getSelection(); return !sel.isCollapsed && $("#chatHist").contains(sel.anchorNode) ? sel.toString() : ""; };
chatBox.addEventListener("mouseleave", () => { if (document.activeElement !== chatInput && !grabbed && !histPicked()) maid.focusInput(false); });
chatInput.addEventListener("blur", () => { if (!grabbed) maid.focusInput(false); });
// Enter — отправить, Shift+Enter — новая строка; поле растёт по тексту (до пяти строк, дальше прокрутка).
function fitChat() {
  chatInput.style.height = "auto";
  chatInput.style.height = `${chatInput.scrollHeight + 2}px`;
}
chatInput.addEventListener("input", () => { fitChat(); syncSend(); });
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") return pictures.length ? setPictures(pictures.slice(0, -1)) : chatInput.blur();
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("#chat").requestSubmit();
  }
});
function hideBubble() {
  stopProposal();
  stopAuto();
  $("#bubble").classList.add("hidden");
  maid.hover(false);
  $("#inbox").classList.remove("away");
  refoldLater();
}

// Свёрнутый виджет и сообщение горничной: разворачивается, показывает его и, когда облачко ушло, сворачивается обратно.
// Если вы за это время сами взялись за панель (щелчок, чат, курсор на ней) — остаётся развёрнутым.
let autoOpened = false;
let refoldTimer = 0;
function openForMessage() {
  clearTimeout(refoldTimer);
  if (!collapsed) return;
  autoOpened = true;
  foldAnimated(false);
}
function refoldLater() {
  if (!autoOpened) return;
  clearTimeout(refoldTimer);
  refoldTimer = setTimeout(function again() {
    if (!autoOpened || collapsed) return (autoOpened = false);
    if (!$("#bubble").classList.contains("hidden")) return; // новое сообщение — ждём, когда уйдёт и оно
    // Курсор на панели или в чате что-то пишут — не трогаем, пока не отпустят.
    if ($("#w").matches(":hover") || document.activeElement === chatInput || chatInput.value.trim()) return (refoldTimer = setTimeout(again, 1500));
    autoOpened = false;
    foldAnimated(true);
  }, 900);
}
$("#w").addEventListener("pointerdown", () => { autoOpened = false; }); // взялись за панель — она ваша

// --- панель ---
function minutesUntil(e) {
  if (!e.time) return null;
  const [h, m] = e.time.split(":").map(Number);
  const now = new Date();
  return h * 60 + m - (now.getHours() * 60 + now.getMinutes());
}

function render() {
  // Строка улетает или список смыкается — не пересобирать его посреди анимации (иначе строка прыгает назад), дорисовать после.
  if (Date.now() < animUntil) {
    clearTimeout(animWait);
    animWait = setTimeout(render, animUntil - Date.now() + 5);
    return;
  }
  const now = new Date();
  const sec = cfg.sections;
  $("#clock").textContent = $("#miniClock").textContent = now.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  if (!data) {
    $("#next").innerHTML = `<span class="muted">Нет связи с сервером</span>`;
    $("#body").innerHTML = "";
    renderCourses();
    return;
  }
  $("#day").textContent = humanDay(data.day);
  $("#miniClock").title = miniDay(data.day);
  // Ближайшие планы, до NEXT_MAX строк: сначала сегодняшние (не начавшиеся больше 30 мин назад), не хватает — из следующих дней,
  // не дальше недели вперёд (поэтому дня недели хватает: «Завтра», «Послезавтра», «Сб»).
  const today = data.events.filter((e) => (minutesUntil(e) ?? 1) > -30);
  const week = data.upcoming.filter((e) => daysFrom(data.day, e.date_iso) <= 6);
  const nexts = [...today, ...week].slice(0, NEXT_MAX);
  $("#next").dataset.day = nexts[0]?.date_iso ?? "";
  $("#next").innerHTML = nexts.length
    ? nexts.map((e) => {
      const m = e.date_iso === data.day ? minutesUntil(e) : null;
      const n = daysFrom(data.day, e.date_iso);
      const wd = WD_SHORT[wdOf(e.date_iso)];
      const when = e.date_iso !== data.day ? `${n === 1 ? "Завтра" : n === 2 ? "Послезавтра" : wd[0].toUpperCase() + wd.slice(1)}${e.time ? `, ${e.time}` : ""}`
        : m === null ? "Сегодня" : m <= 0 ? "сейчас" : m < 60 ? `через ${m} мин` : e.time;
      // Сегодняшние — яркие, планы на другие дни — приглушены (день серым, текст бледнее), чтобы сразу видеть, что сегодня.
      return `<div class="nx${e.date_iso === data.day ? "" : " ahead"}" data-day="${esc(e.date_iso)}"><b>${esc(when)}</b> · ${esc(e.title)}</div>`;
    }).join("")
    : `<span class="muted">Планов нет</span>`;
  // Важные даты — над ближайшим планом (за cfg.dateLead дней; убрать — в списке планов).
  const pins = datesOf(data.day);
  $("#pins").innerHTML = pins.map((d) => `<div class="pin" data-day="${d.on}">${dateText(d, data.day)}</div>`).join("");
  // Один список «Задачи» вместо отдельных разделов. Порядок:
  //   1) ежедневное на сегодня, ещё не отмеченное (привычки и курсы — «Пить Аевит · день 9 из 30»);
  //   2) задачи: сначала важные, потом обычные, потом «когда-нибудь»;
  //   3) ежедневное, уже отмеченное сегодня, — внизу бледным (щелчок — передумать).
  const daily = (sec.habits ? data.habits ?? [] : []).filter((h) => h.course?.find((x) => x.day === data.day)?.s !== "rest");
  const dayItem = (h) => {
    const i = h.course?.length ? h.course.findIndex((x) => x.day === data.day) : -1;
    // Курс — полоска и «9/30» справа; у обычной привычки — серия 🔥 после названия.
    const sub = i >= 0
      ? `<span class="course-meter" title="День ${i + 1} из ${h.course.length}"><span class="cm-bar"><i data-w="${Math.round(((i + 1) / h.course.length) * 100)}"></i></span>${i + 1}/${h.course.length}</span>`
      : h.streak >= 2 ? ` <span class="muted">🔥${h.streak}</span>` : "";
    const go = leavingRows.get(`h${h.id}`);
    if (go?.gone) return `<li class="undo-row${undoFresh(go)}" data-key="h${h.id}"><button type="button" class="undo-back" data-undo="h${h.id}">↶ Вернуть</button></li>`;
    const name = i >= 0 ? `<span class="t">${esc(h.title)}</span>${sub}` : `<span class="t">${esc(h.title)}${sub}</span>`;
    if (go) return `<li class="habit ${rowLeaving(go)}" data-key="h${h.id}"><span class="mark done" data-habit="${h.id}" title="Отменить">${UNDO_MARK}</span>${name}</li>`;
    return `<li class="habit${h.status ? " did" : ""}"><span class="mark ${h.status ?? ""}" data-habit="${h.id}">${h.status === "done" ? "✓" : h.status === "skipped" ? "–" : ""}</span>${name}</li>`;
  };
  const RANK = { high: 0, normal: 1, low: 2 };
  const allTasks = taskRows();
  const later = allTasks.filter(asleep).sort((a, b) => a.due_date.localeCompare(b.due_date));
  const awake = allTasks.filter((t) => !asleep(t));
  noteWakes(awake, later);
  // Просроченные — первыми (самые старые сверху), потом только что проснувшиеся, чтобы их было видно, потом со сроком (ближний
  // выше), потом без срока; внутри — по важности.
  const tasks = [...awake].sort((a, b) => overdue(b) - overdue(a) || (overdue(a) ? a.due_date.localeCompare(b.due_date) : 0)
    || wokeFresh(b) - wokeFresh(a) || Boolean(b.due_date) - Boolean(a.due_date)
    || (a.due_date && b.due_date ? a.due_date.localeCompare(b.due_date) : 0) || (RANK[a.priority] ?? 1) - (RANK[b.priority] ?? 1));
  // Вытянутая панель (уголок справа внизу) показывает больше задач: +1 на каждые 26 px прибавки к высоте.
  const shownTasks = tasks.filter((t) => !doneNow.has(t.id)).slice(0, 6 + Math.floor(Math.max(0, innerHeight - 760) / 26));
  shownTaskIds = new Set(sec.tasks ? shownTasks.map((t) => t.id) : []);
  const todo = daily.filter((h) => !h.status);
  const hiding = cfg.doneTasks === "hide";
  // Вчерашний пропуск, который ещё можно спасти задним числом (fun.js).
  const rescueItem = (h) => `<li class="rescue"><span class="mark" data-rescue="${h.id}" title="Отметить вчерашний день"></span><span>${esc(h.title)} <span class="muted">· вчера — спасти серию</span></span></li>`;
  const items = [
    ...todo.map(dayItem),
    ...daily.filter(missedYesterday).map(rescueItem),
    ...(sec.tasks ? shownTasks : []).map((t) => {
      if (binTasks.has(t.id)) return `<li class="bin-out" data-bin="${t.id}"><span class="check"></span><span class="t${t.priority === "high" ? " high" : ""}">${esc(t.title)}</span></li>`;
      const go = leavingRows.get(`t${t.id}`);
      if (go?.gone) return `<li class="undo-row${undoFresh(go)}" data-key="t${t.id}"><button type="button" class="undo-back" data-undo="t${t.id}">↶ Вернуть</button></li>`;
      return go
        ? `<li class="${rowLeaving(go)}" data-key="t${t.id}"><span class="check done" data-done="${t.id}" title="Отменить">${UNDO_MARK}</span><span class="${t.priority === "high" ? "high" : ""}">${esc(t.title)}</span></li>`
        : wokeFresh(t)
          ? `<li class="woke" data-woke="${t.id}"><span class="check" data-done="${t.id}"></span><span class="${t.priority === "high" ? "high" : ""}">${esc(t.title)}</span><span class="wake-tag">⏰ ${esc(dueWhen(t.due_date))}</span></li>`
          : `<li><span class="check" data-done="${t.id}"></span><span class="t${t.priority === "high" ? " high" : ""}">${esc(t.title)}</span>${dueTag(t)}</li>`;
    }),
    // Сделанное: в режиме «прятать» — только пока открыт счётчик.
    ...(hiding && !showingDone() ? [] : [
      ...daily.filter((h) => h.status).map(dayItem),
      ...(sec.tasks ? recentDone() : []).map((t) => `<li class="did"><span class="check done" data-reopen="${t.id}" title="Снять галочку"><i>✓</i><b>↶</b></span><span>${esc(t.title)}</span></li>`),
    ]),
  ];
  // Улетевшие, но ещё не отправленные (идёт «Вернуть») уже считаются сделанными.
  const gone = [...leavingRows.values()].filter((x) => x.gone).length;
  const left = todo.length + (sec.tasks ? awake.filter((t) => !doneNow.has(t.id)).length : 0) - gone;
  const doneCount = daily.filter((h) => h.status).length + (sec.tasks ? recentDone().length : 0) + gone;
  const allDone = hiding && !left && doneCount > 0;
  if (allDone && lastLeft > 0) { react("excited", 5000); allDoneAt = Date.now(); }
  lastLeft = left;
  renderMini(tasks.filter((t) => !doneNow.has(t.id)), todo, left, doneCount, daily.filter((h) => !h.status && !leavingRows.has(`h${h.id}`)));
  const bump = Date.now() - bumpAt < 600 ? " bump" : "";
  const counter = hiding && doneCount
    ? ` <button type="button" class="done-count${showingDone() ? " on" : ""}${allDone ? " all" : ""}${bump}" id="doneCount" title="${showingDone() ? "Спрятать сделанное" : "Показать сделанное"}">${doneCount}/${doneCount + left}</button>`
    : left > 3 ? ` · ${left}` : "";
  const pinned = new Set(datesOf(data.day, true).map(dateKey));
  const soon = (sec.soon ? data.dates : []).filter((d) => d.inDays <= 7 && !pinned.has(dateKey(d))).map((d) => `<li><span class="time">${dateWhen(d)}</span><span>${esc(d.title)}</span></li>`);
  $("#body").innerHTML =
    (sec.tasks || daily.length ? `<h4>Задачи${counter}</h4>${items.length ? `<ul class="list">${items.join("")}</ul>` : ""}${allDone && !showingDone() ? `<p class="all-done${Date.now() - allDoneAt < 400 ? " fresh" : ""}">Всё на сегодня ✨</p>` : items.length ? "" : `<p class="empty small">Нет</p>`}` : "") +
    (soon.length ? `<h4>Скоро</h4><ul class="list">${soon.join("")}</ul>` : "");
  if (hiding && Date.now() - peekAt < 300) for (const li of $("#body").querySelectorAll("li.did")) li.classList.add("shown-done");
  for (const x of $("#body").querySelectorAll(".cm-bar i")) x.style.width = `${x.dataset.w}%`; // style="" в разметке запрещает CSP
  fitHistory(); // планы сверху могли стать выше или ниже
  for (const li of $("#body").querySelectorAll("li.woke")) li.style.setProperty("--wake-delay", `-${Date.now() - wokeAt.get(Number(li.dataset.woke))}ms`);
  for (const li of $("#body").querySelectorAll("li.leaving")) {
    const x = leavingRows.get(li.dataset.key);
    if (x) li.style.setProperty("--fill-delay", `-${Math.min((x.pausedAt || Date.now()) - x.at, ROW_FADE)}ms`);
  }
  renderCourses();
  inboxTidy();
  if (binTasks.size) flyTasksToBin();
}

// --- Задачи, отменённые или удалённые не здесь (в чате, в Telegram, с телефона) ---
// Как у планов (clock.js, ejectGone): строку перечёркивает красная черта, копия улетает в корзину, что выезжает под списком задач;
// место строк держится, пока последняя не долетит, потом все смыкаются разом и корзина уезжает. Свёрнутая панель — без полёта.
const binTasks = new Map(); // id → задача, которой уже нет в data.tasks, но её строка ещё улетает
let shownTaskIds = new Set(); // задачи, что были в списке при прошлой перерисовке
let lastTaskRows = null;
let taskBinBusy = false;
const taskRows = () => (binTasks.size ? [...data.tasks, ...[...binTasks.values()].filter((t) => !data.tasks.some((x) => x.id === t.id))] : data.tasks);
function noteGoneTasks() {
  const prev = lastTaskRows;
  lastTaskRows = new Map((data?.tasks ?? []).map((t) => [t.id, t]));
  if (!prev || collapsed || $("#w").classList.contains("hidden") || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const done = new Set((data.done_today ?? []).map((t) => t.id));
  for (const [id, t] of prev) {
    if (!lastTaskRows.has(id) && shownTaskIds.has(id) && !done.has(id) && !doneNow.has(id) && !leavingRows.has(`t${id}`)) binTasks.set(id, t);
  }
}
function flyTasksToBin() {
  if (taskBinBusy) return;
  const rows = [...$("#body").querySelectorAll("li.bin-out")];
  if (!rows.length) return binTasks.clear();
  taskBinBusy = true;
  const ids = rows.map((li) => Number(li.dataset.bin));
  const ghosts = []; // копии в полёте: если окно было скрыто и анимация не доиграла, убрать их в конце
  const can = document.createElement("div");
  can.className = "pl-bin task-bin in";
  can.innerHTML = BIN_SVG;
  rows[0].closest("ul").after(can);
  can.scrollIntoView({ block: "nearest" });
  const start = 300;
  const landed = start + (rows.length - 1) * 180 + 420 + 640;
  const shut = landed + 120;
  animUntil = Date.now() + shut + 340 + 320 + 40;
  rows.forEach((li, i) => setTimeout(() => {
    if (!li.isConnected) return;
    li.classList.add("striking");
    popTone(2, { vol: 0.05, soft: true });
    setTimeout(() => {
      if (!li.isConnected) return;
      const at = li.getBoundingClientRect();
      const to = can.isConnected ? can.querySelector("svg").getBoundingClientRect() : { left: at.left, top: at.top - 60, width: 30, height: 30 };
      const ghost = li.cloneNode(true);
      ghost.classList.add("task-ghost");
      Object.assign(ghost.style, { left: `${at.left}px`, top: `${at.top}px`, width: `${at.width}px`, height: `${at.height}px` });
      document.body.append(ghost);
      ghosts.push(ghost);
      li.style.visibility = "hidden";
      const dx = to.left + to.width / 2 - (at.left + at.width / 2);
      const dy = to.top + to.height / 2 - (at.top + at.height / 2);
      const fly = ghost.animate([
        { transform: "none", opacity: 1, offset: 0 },
        { transform: "translate(-4px, -7px) scale(1.04) rotate(-2deg)", opacity: 1, offset: 0.2 },
        { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - 30}px) scale(.55) rotate(6deg)`, opacity: 1, offset: 0.62 },
        { transform: `translate(${dx}px, ${dy}px) scale(.12) rotate(12deg)`, opacity: 0, offset: 1 },
      ], { duration: 640, easing: "cubic-bezier(.45, 0, .7, .5)" });
      setTimeout(() => can.classList.add("open"), 330);
      fly.onfinish = () => {
        ghost.remove();
        popTone(-4, { vol: 0.07 });
        can.classList.remove("open", "gulp"); void can.offsetWidth; can.classList.add("gulp");
        popTone(-6, { vol: 0.05, soft: true });
      };
    }, 420);
  }, start + i * 180));
  setTimeout(() => rows.forEach((li) => {
    if (!li.isConnected) return;
    const h = li.getBoundingClientRect().height;
    li.animate([{ height: `${h}px` }, { height: "0px", minHeight: "0px", paddingTop: "0px", paddingBottom: "0px", marginTop: "0px", marginBottom: "0px" }],
      { duration: 320, easing: "cubic-bezier(.4, 0, .2, 1)", fill: "forwards" });
  }), shut);
  setTimeout(() => can.classList.replace("in", "out") || can.classList.add("out"), shut + 340);
  setTimeout(() => {
    can.remove();
    for (const g of ghosts) g.remove();
    for (const id of ids) binTasks.delete(id);
    taskBinBusy = false;
    animUntil = 0;
    render();
  }, shut + 340 + 320);
}

// --- Сделанные задачи в режиме «прятать» (cfg.doneTasks === "hide") ---
// Отметил — строка ROW_FADE мс заливается цветом слева направо, улетает вправо, и список смыкается; только тогда отметка уходит
// на сервер. До этого галочка при наведении — ×: отменить. Мышь вернулась на строку после щелчка — заливка стоит.
// Счётчик «сделано/всего» у заголовка — щелчок показывает сделанное зачёркнутым, пока мышь не уйдёт со списка.
const ROW_FADE = 3000;
const ROW_FLY = 380;
const ROW_SHUT = 220;
const DONE_PEEK = 30000; // запасной срок: обычно сделанное прячется, когда мышь уходит со списка
const UNDO_MARK = "<i>✓</i><b>×</b>";
const UNDO_WINDOW = 3000; // сколько после улёта висит «↶ Вернуть»; отметка уходит на сервер только после него
let bumpAt = 0; // когда счётчик последний раз получил «+1»
let lastLeft = -1;
let allDoneAt = 0;
let peekAt = 0; // когда открыли сделанное — появление проигрывается только тогда, не при каждой перерисовке
let animUntil = 0; // до этого времени список не перерисовывать (render)
let animWait = 0;
const undoFresh = (x) => (Date.now() - x.goneAt < 250 ? " fresh" : "");
const leavingRows = new Map(); // "t12" / "h3" → { at, pausedAt, armed, fly, title, timer }
let showDoneUntil = 0;
let showDoneTimer = 0;
const showingDone = () => Date.now() < showDoneUntil;
const rowLeaving = (x) => `leaving${x.fly ? " fly" : ""}${x.pausedAt ? " hold" : ""}`;
const rowEl = (key) => $("#body").querySelector(`li[data-key="${key}"]`);
// Растворение у края списка: есть что листать выше или ниже — край тает (style.css, .more-above / .more-below).
function scrollEdges() {
  const b = $("#body");
  b.classList.toggle("more-above", b.scrollTop > 2);
  b.classList.toggle("more-below", b.scrollTop + b.clientHeight < b.scrollHeight - 2);
}
$("#body").addEventListener("scroll", scrollEdges, { passive: true });
new ResizeObserver(scrollEdges).observe($("#body"));
new MutationObserver(() => requestAnimationFrame(scrollEdges)).observe($("#body"), { childList: true, subtree: true });
$("#body").addEventListener("mouseleave", () => {
  if (!showingDone()) return;
  clearTimeout(showDoneTimer);
  showDoneUntil = 0;
  render();
});
function toggleShowDone() {
  clearTimeout(showDoneTimer);
  showDoneUntil = showingDone() ? 0 : Date.now() + DONE_PEEK;
  peekAt = showDoneUntil ? Date.now() : 0;
  if (showDoneUntil) showDoneTimer = setTimeout(render, DONE_PEEK + 30);
  render();
}
function startLeave(key, mark) {
  popTone(4);
  burst(mark);
  react("done", 4000);
  leavingRows.set(key, { at: Date.now(), pausedAt: 0, armed: false, fly: false, title: mark.nextElementSibling?.textContent ?? "" });
  render();
  rowCountdown(key);
}
function cancelLeave(key) {
  const x = leavingRows.get(key);
  if (!x || x.fly) return;
  clearTimeout(x.timer);
  leavingRows.delete(key);
  popTone(-5, { vol: 0.2, soft: true });
  render();
}
function rowCountdown(key) {
  const x = leavingRows.get(key);
  if (!x || x.pausedAt || x.fly) return;
  clearTimeout(x.timer);
  x.timer = setTimeout(() => rowFly(key), Math.max(0, ROW_FADE - (Date.now() - x.at)));
}
function rowHold(key, on) {
  const x = leavingRows.get(key);
  if (!x || x.fly) return;
  if (on && !x.pausedAt) {
    x.pausedAt = Date.now();
    clearTimeout(x.timer);
    rowEl(key)?.classList.add("hold");
  } else if (!on && x.pausedAt) {
    x.at += Date.now() - x.pausedAt;
    x.pausedAt = 0;
    rowEl(key)?.classList.remove("hold");
    rowCountdown(key);
  }
}
// Строка улетела — на её месте «↶ Вернуть» на UNDO_WINDOW мс (мышь на ней — ждёт), потом список смыкается и отметка уходит на сервер.
function rowFly(key) {
  const x = leavingRows.get(key);
  if (!x) return;
  x.fly = true;
  rowEl(key)?.classList.add("fly");
  animUntil = Date.now() + ROW_FLY;
  setTimeout(() => {
    if (leavingRows.get(key) !== x) return;
    x.gone = true;
    x.goneAt = bumpAt = Date.now();
    render();
    x.timer = setTimeout(() => rowCommit(key), UNDO_WINDOW);
  }, ROW_FLY);
}
function undoGone(key) {
  const x = leavingRows.get(key);
  if (!x || x.sent) return;
  clearTimeout(x.timer);
  leavingRows.delete(key);
  popTone(-5, { vol: 0.2, soft: true });
  render();
}
async function rowCommit(key) {
  const x = leavingRows.get(key);
  if (!x || x.sent) return;
  x.sent = true;
  const el = rowEl(key);
  if (el) {
    el.style.setProperty("height", `${el.offsetHeight}px`);
    void el.offsetHeight;
    el.classList.add("shut");
    animUntil = Date.now() + ROW_SHUT + 40;
    await new Promise((r) => setTimeout(r, ROW_SHUT + 40));
    animUntil = 0;
  }
  const id = Number(key.slice(1));
  const task = key[0] === "t";
  if (task) { keepDone(id, x.title); countDone(data.day); }
  else { const h = data?.habits?.find((v) => v.id === id); if (h) h.status = "done"; }
  leavingRows.delete(key);
  render();
  try {
    await maid.api("POST", task ? `/api/tasks/${id}` : `/api/habits/${id}/mark`, { status: "done" });
    maid.changed();
    if (!task) load();
  } catch (err) {
    play("oops");
    say(err.message, { ms: 6000 });
    load();
  }
}
// Виджет закрывают, пока висит «Вернуть», — отметить сразу, чтобы не потерять.
window.addEventListener("beforeunload", () => {
  for (const [key, x] of leavingRows) if (x.gone && !x.sent) maid.api("POST", key[0] === "t" ? `/api/tasks/${key.slice(1)}` : `/api/habits/${key.slice(1)}/mark`, { status: "done" });
});
// «Вернуть» под мышью не исчезает; ушла — ещё 1,2 с.
$("#body").addEventListener("mouseover", (e) => {
  const li = e.target.closest("li.undo-row");
  const x = li && leavingRows.get(li.dataset.key);
  if (x && !x.sent && !li.contains(e.relatedTarget)) clearTimeout(x.timer);
});
$("#body").addEventListener("mouseout", (e) => {
  const li = e.target.closest("li.undo-row");
  const x = li && leavingRows.get(li.dataset.key);
  if (!x || x.sent || li.contains(e.relatedTarget)) return;
  clearTimeout(x.timer);
  x.timer = setTimeout(() => rowCommit(li.dataset.key), 1200);
});
// Пауза заливки: мышь ушла со строки — «взвести», вернулась — стоп, ушла — дальше (наведение сразу после щелчка не в счёт).
$("#body").addEventListener("mouseover", (e) => {
  const li = e.target.closest("li.leaving");
  if (li && !li.contains(e.relatedTarget) && leavingRows.get(li.dataset.key)?.armed) rowHold(li.dataset.key, true);
});
$("#body").addEventListener("mouseout", (e) => {
  const li = e.target.closest("li.leaving");
  if (!li || li.contains(e.relatedTarget)) return;
  const x = leavingRows.get(li.dataset.key);
  if (x) x.armed = true;
  rowHold(li.dataset.key, false);
});

let lastJson = "";
async function load() {
  try {
    const fresh = await maid.api("GET", "/api/today");
    const json = JSON.stringify(fresh);
    data = fresh;
    forgetReopened(data.tasks);
    takeServerDone(data.done_today);
    if (!online) { online = true; settle(); }
    // Опрос каждые 5 с: перерисовывать только когда что-то изменилось, иначе сбивается прокрутка списка.
    if (json === lastJson) return;
    lastJson = json;
  } catch {
    // Нет связи — старые данные пока оставить, следующий опрос через 5 с.
    if (online) { online = false; settle(); }
    if (data) return;
  }
  noteGoneTasks();
  renderSoon();
  watchPlans();
  if (dayScore === null) tickDayMood();
  tickDue(); // часики перед планом и недовольство просрочкой — сразу по свежим данным
}

// Лента уведомлений: что ушло в Telegram — показать и здесь, с кнопками.
async function pollNotices() {
  try {
    const rows = await maid.api("GET", `/api/notices?after=${lastNotice}`);
    if (!lastNotice) {
      // Первый запрос — только запомнить, где мы; старое не показываем.
      lastNotice = rows[0]?.id ?? 0;
      return;
    }
    for (const n of rows.reverse()) {
      lastNotice = Math.max(lastNotice, n.id);
      const emotion = /🎮/.test(n.text) ? "angry" : n.emotion;
      // В ящик непрочитанного (значок у головы) и сразу сказать; напоминание с кнопками — звонит в колокольчик.
      inboxAdd({ ...n, emotion });
      // Спит (человека нет) — не будит и не звенит: перескажет, когда он вернётся.
      if (napping) { missed.push(n); continue; }
      unheardAt = Date.now();
      say(n.text, { buttons: n.buttons, emotion, ms: n.buttons.length ? 0 : 20000, sound: "hey", mood: n.buttons.length ? "remind" : /🎮/.test(n.text) ? "refuse" : null, notice: n.id });
    }
  } catch {
    /* нет связи — молчим */
  }
}

// Свёрнутая панель: часы, ближайший план и сводка словами, справа кольцо «сделано из всего» (щелчок — развернуть).
function miniDay(day) {
  const [, m, d] = day.split("-").map(Number);
  return `${d} ${MONTHS[m - 1].slice(0, 3)}, ${humanDay(day).split(", ")[1]}`;
}
// Справа от точек — ближайший план сегодня («в 19:00 · Спортзал», «через 25 мин · …», «идёт · …»); планов больше нет — счёт задач.
function miniPlan() {
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  for (const e of data.events ?? []) {
    if (!e.time || (e.status && e.status !== "active")) continue;
    const [h, m] = e.time.split(":").map(Number);
    const start = h * 60 + m;
    const [eh, em] = (e.end_time ?? "").split(":").map(Number);
    const end = e.end_time ? eh * 60 + em : start + 30;
    if (end <= cur) continue;
    const d = start - cur;
    const rel = d <= 0 ? "идёт" : d < 60 ? `через ${d} мин` : `через ${Math.round(d / 60)} ч`;
    return { time: e.time, rel, title: e.title, soon: d <= 15 };
  }
  return null;
}
const RING = 2 * Math.PI * 16.5;
let miniHabits = [];
function renderMini(open, todo, left, done, habits = []) {
  // Неотмеченные сегодня привычки — точка с числом на кольце; щелчок — отметить.
  miniHabits = habits;
  const hb = $("#miniHabit");
  hb.classList.toggle("hidden", !habits.length);
  hb.textContent = habits.length > 1 ? String(habits.length) : "";
  hb.title = habits.length === 1 ? `«${habits[0].title}» — отметить сделанным` : `Привычки на сегодня: ${habits.map((h) => h.title).join(", ")}`;
  const plan = miniPlan();
  const late = open.filter(overdue).length;
  $("#miniTasks").innerHTML = plan
    ? `<span class="mini-plan${plan.soon ? " soon" : ""}"><b>${esc(plan.time)}</b> ${esc(plan.title)}</span>`
    : left > 0 ? `Задачи · ${left}` : "Всё на сегодня ✨";
  // Вторая строка — главное словами: когда план, что просрочено, сколько осталось.
  const sub = [
    plan?.rel,
    late ? `${late} ${plural(late, "просрочено", "просрочены", "просрочено")}` : "",
    left - late > 0 && plan ? `${left - late} ${plural(left - late, "дело", "дела", "дел")}` : "",
  ].filter(Boolean);
  $("#miniSub").textContent = sub.join(" · ");
  $("#miniSub").classList.toggle("late", late > 0);
  const total = done + left;
  $("#miniArc").style.strokeDasharray = `${total ? (done / total) * RING : 0} ${RING}`;
  $("#miniCount").textContent = total ? `${done}/${total}` : "✓";
  $("#miniOpen").title = total ? `Сделано ${done} из ${total} · развернуть панель` : "Развернуть панель";
}

function setCollapsed(on) {
  collapsed = on;
  hideClock(); // свёрнутый вид — без панели планов; разворот — выдвижная панель уходит, а не превращается в обычную
  $("#w").classList.toggle("hidden", on);
  $("#stage").classList.toggle("folded", on);
  syncLift();
  sendFold();
  // В свёрнутом виде над карточкой видна голова горничной: по ней видно настроение и «думаю».
  localStorage.setItem("maid.collapsed", on ? "1" : "");
}

// Режим «вниз» (решает main, когда свёрнутую карточку отпустили у верха экрана): карточка стоит на месте верха панели (--lift над низом
// окна), панель и выдвижные «Планы на день» раскрываются вниз, облачко — слева от карточки. Пока карточка переставляется внутри окна,
// а main сдвигает окно, виджет на кадр спрятан — на экране карточка не прыгает.
function syncLift() {
  const st = $("#stage");
  const h = $("#mini").offsetHeight || 68;
  st.style.setProperty("--lift", `${Math.max(0, Math.max(380, innerHeight - 380) - h)}px`);
  if (collapsed) sendFold();
  syncDrawer();
}
// Режим «вниз»: облачко — над головой, как обычно, если над карточкой на экране хватает места под горничную и облачко;
// у самого верха экрана — слева от карточки (CSS .stage.folded.down:not(.bubble-up)).
function placeBubble() {
  const st = $("#stage");
  const b = $("#bubble");
  if (!st.classList.contains("down")) return st.classList.remove("bubble-up");
  const top = screenY + $("#mini").getBoundingClientRect().top - (screen.availTop ?? 0);
  const need = Math.max(b.offsetHeight, 120) + ($("#maid").offsetHeight || 0) * 0.6 + 20;
  st.classList.toggle("bubble-up", top >= need);
}
// Сколько горничная выглядывает над карточкой (или над панелью): main не пускает её голову за верх экрана.
function sendFold() {
  const m = $("#maid");
  const head = m.offsetHeight ? Math.max(0, Math.round(m.offsetHeight + parseFloat(getComputedStyle($("#perch")).marginBottom))) : 0;
  // Высота карточки — без строки вопроса, плюс место под неё и под тень снизу (76 px): при наведении это число не меняется.
  const ask = $("#mini .mini-ask");
  const h = ($("#mini").offsetHeight || 68) - (ask?.offsetHeight ? ask.offsetHeight + 10 : 0) + 76;
  maid.foldState(collapsed, h, head);
}
new ResizeObserver(() => syncLift()).observe($("#mini"));
new ResizeObserver(() => sendFold()).observe($("#maid"));
addEventListener("resize", syncLift);
maid.on("down", (on) => {
  const st = $("#stage");
  st.style.opacity = "0";
  $("#mini").style.transition = "none"; // карточка встаёт на новое место сразу, без съезда по margin-bottom
  st.classList.toggle("down", Boolean(on));
  syncLift();
  requestAnimationFrame(() => requestAnimationFrame(() => maid.downReady()));
});
maid.on("down-shown", () => requestAnimationFrame(() => {
  placeBubble();
  $("#stage").style.opacity = "";
  $("#mini").style.transition = "";
}));

// Свернуть/развернуть с анимацией. Свернуть: содержимое панели ссыпается вниз, панель сжимается в карточку с пружинкой,
// горничная едет вниз на её верхнем краю и выглядывает из-за карточки головой, из-за края — облачко пыли.
// Развернуть: панель вырастает из карточки с перелётом, горничная подскакивает с карточки и садится на край, строки въезжают по очереди.
let folding = null;
function foldAnimated(on) {
  if (on === collapsed) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return setCollapsed(on);
  folding?.();
  const from = on ? $("#w") : $("#mini");
  const r0 = from.getBoundingClientRect();
  const m0 = $("#maid").getBoundingClientRect();
  // Уходящая панель остаётся копией на своём месте, пока её не сменит новая.
  const stage = $("#stage");
  stage.classList.add("fold-anim"); // на время анимации: без CSS-переходов панелей и с обычной линией обрезки горничной
  const ghost = from.cloneNode(true);
  ghost.removeAttribute("id");
  ghost.querySelectorAll("[id]").forEach((el) => el.removeAttribute("id"));
  ghost.classList.remove("hidden");
  ghost.classList.add("fold-ghost");
  Object.assign(ghost.style, { left: `${r0.left}px`, top: `${r0.top}px`, width: `${r0.width}px`, height: `${r0.height}px`, margin: "0" });
  document.body.append(ghost);
  setCollapsed(on);
  const to = on ? $("#mini") : $("#w");
  const r1 = to.getBoundingClientRect();
  const m1 = $("#maid").getBoundingClientRect();
  const dy = m0.top - m1.top; // где горничная была относительно нового места
  const maidEl = $("#maid");
  const alpha = String(cfg.opacity); // панели прозрачны по настройке — анимация кончается на ней, а не на 1
  const anims = [];
  const run = (el, kf, opt) => {
    const a = el.animate(kf, opt);
    anims.push(a);
    return a;
  };
  maidEl.style.transformOrigin = "50% 100%";
  const down = stage.classList.contains("down"); // у верха экрана: верх панели на месте, она сжимается и растёт снизу
  if (on) {
    // Содержимое ссыпается вниз, сверху вниз по очереди (в режиме «вниз» — уходит вверх, к карточке).
    [...ghost.children].forEach((c, i) => run(c, [{ transform: "none", opacity: 1 }, { transform: `translateY(${down ? -18 : 26}px) scale(.96)`, opacity: 0 }],
      { duration: 220, delay: i * 28, easing: "cubic-bezier(.5, 0, .9, .4)", fill: "forwards" }));
    // Панель сжимается вниз в карточку: низ на месте, верх опускается с пружинкой.
    // Низ едет от низа панели к низу карточки (под ней место под строку вопроса).
    const h0 = r0.height, h1 = r1.height;
    const top = (hk) => `${down ? r0.top : r0.bottom + (r1.bottom - r0.bottom) * Math.min(1, (h0 - hk) / Math.max(1, h0 - h1)) - hk}px`;
    run(ghost, [
      { height: `${h0}px`, top: top(h0), borderRadius: "16px", offset: 0 },
      { height: `${h1 * 0.82}px`, top: top(h1 * 0.82), borderRadius: "22px", offset: 0.62 },
      { height: `${h1 * 1.07}px`, top: top(h1 * 1.07), offset: 0.8 },
      { height: `${h1}px`, top: top(h1), borderRadius: "22px", offset: 1 },
    ], { duration: 560, delay: 90, easing: "cubic-bezier(.45, 0, .2, 1)", fill: "forwards" });
    run(ghost, [{ opacity: 1 }, { opacity: 0 }], { duration: 160, delay: 560, fill: "forwards" });
    run(to, [{ opacity: 0, transform: "scale(.97)" }, { opacity: alpha, transform: "scale(1.02)", offset: 0.6 }, { opacity: alpha, transform: "none" }],
      { duration: 280, delay: 520, easing: "ease-out", fill: "backwards" });
    // Горничная едет вниз на верхнем краю сжимающейся панели и остаётся над карточкой. Низ картинки срезается по краю панели:
    // сколько спрятано, плавно меняется от прежнего (у большой панели) до конечного (у карточки) — в конце срез совпадает
    // с обрезкой свёрнутого вида, и ничего не прыгает.
    const t = (hk) => (h0 - hk) / Math.max(1, h0 - h1);
    const hid0 = m0.bottom - r0.top, hid1 = m1.bottom - r1.top;
    const at = (hk) => ({ transform: `translateY(${dy * (1 - t(hk))}px)`, clipPath: `inset(-400px -400px ${hid0 + (hid1 - hid0) * t(hk)}px -400px)` });
    run(maidEl, [
      { ...at(h0), offset: 0 },
      { ...at(h1 * 0.82), offset: 0.62 },
      { ...at(h1 * 1.07), offset: 0.8 },
      { ...at(h1), offset: 1 },
    ], { duration: 560, delay: 90, easing: "cubic-bezier(.45, 0, .2, 1)", fill: "backwards" }).onfinish = () => {
      if (folding === stop) stage.classList.remove("fold-anim");
    };
    setTimeout(() => {
      if (folding !== stop) return;
      popTone(1, { vol: 0.07, soft: true });
      dust(m1.left + m1.width / 2, r1.top);
      const squash = [{ transform: "none" }, { transform: "translateY(3px) scale(1.01, .98)" }, { transform: "none" }];
      run(to, squash, { duration: 260, easing: "ease-out", composite: "add" });
      run(maidEl, [{ transform: "none" }, { transform: "translateY(3px)" }, { transform: "none" }], { duration: 260, easing: "ease-out" }); // горничная оседает вместе с карточкой
    }, 700);
    popTone(5, { vol: 0.05, soft: true });
  } else {
    // Карточка исчезает, панель вырастает из неё вверх с перелётом.
    run(ghost, [{ opacity: 1 }, { opacity: 0 }], { duration: 140, fill: "forwards" });
    // Панель вырастает из карточки: только transform и прозрачность (дёшево, без перерисовки размытого фона), один мягкий перелёт.
    const k = Math.min(1, r0.height / r1.height);
    to.style.transformOrigin = down ? "50% 0" : "50% 100%";
    run(to, [
      { transform: `translateY(${down ? 0 : r0.bottom - r1.bottom}px) scaleY(${k}) scaleX(.96)`, opacity: 0, offset: 0, easing: "cubic-bezier(.25, .8, .35, 1)" },
      { transform: "scaleY(1.015)", opacity: alpha, offset: 0.7, easing: "cubic-bezier(.4, 0, .4, 1)" },
      { transform: "none", opacity: alpha, offset: 1 },
    ], { duration: 520, delay: 60, fill: "backwards" });
    [...to.children].filter((c) => c.offsetParent).forEach((c, i) => run(c, [{ transform: "translateY(14px)", opacity: 0 }, { transform: "none", opacity: 1 }],
      { duration: 340, delay: 220 + i * 40, easing: "cubic-bezier(.2, .8, .3, 1)", fill: "backwards" }));
    // Горничная подскакивает с карточки вместе с растущей панелью, чуть взлетает и плавно садится на край — без пружинок в конце.
    run(maidEl, [
      { transform: `translateY(${dy}px)`, offset: 0 },
      { transform: `translateY(${dy}px)`, offset: 0.18, easing: "cubic-bezier(.2, .75, .35, 1)" },
      { transform: "translateY(-14px) scale(.98, 1.03)", offset: 0.62, easing: "cubic-bezier(.45, 0, .35, 1)" },
      { transform: "none", offset: 1 },
    ], { duration: 820, fill: "backwards" });
    setTimeout(() => {
      if (folding !== stop) return;
      popTone(6, { vol: 0.07, soft: true });
      dust(m1.left + m1.width / 2, r1.top);
    }, 820 * 0.3);
    setTimeout(() => folding === stop && popTone(9, { vol: 0.06, soft: true }), 820);
  }
  const stop = () => {
    anims.forEach((a) => a.cancel());
    maidEl.style.visibility = "";
    stage.classList.remove("fold-anim");
    to.style.transformOrigin = "";
    ghost.remove();
    if (folding === stop) folding = null;
  };
  folding = stop;
  setTimeout(() => folding === stop && stop(), 1100);
}
// Облачко пыли там, где горничная приземлилась.
function dust(x, y) {
  for (let i = 0; i < 9; i++) {
    const p = document.createElement("i");
    p.className = "fold-dust";
    Object.assign(p.style, { left: `${x}px`, top: `${y}px` });
    document.body.append(p);
    const side = i % 2 ? 1 : -1;
    const dx = side * (24 + Math.random() * 70);
    const s = 0.6 + Math.random() * 0.9;
    p.animate([
      { transform: `translate(-50%, -50%) scale(${s * 0.4})`, opacity: 0.85 },
      { transform: `translate(calc(-50% + ${dx}px), calc(-50% - ${8 + Math.random() * 18}px)) scale(${s})`, opacity: 0 },
    ], { duration: 520 + Math.random() * 260, easing: "cubic-bezier(.2, .8, .4, 1)" }).onfinish = () => p.remove();
  }
}

// --- настройки виджета ---
function applyCfg() {
  const st = $("#stage");
  st.classList.remove("side-left", "side-right");
  st.classList.add(`side-${cfg.side}`);
  st.classList.toggle("no-maid", cfg.side === "none");
  const w = MAID_W[cfg.size] ?? MAID_W.m;
  st.style.setProperty("--maid-w", `${w}px`);
  // За панелью прячется только низ корсета — фигурка почти целиком над краем.
  st.style.setProperty("--peek", `${Math.round(w * 0.13)}px`);
  $("#w").style.opacity = $("#mini").style.opacity = String(cfg.opacity);
  $("#next").classList.toggle("hidden", !cfg.sections.next);
}
async function loadCfg() {
  const s = await maid.settings();
  const w = s.widget ?? {};
  cfg = { opacity: w.opacity ?? 0.92, side: w.side === "center" ? "right" : w.side ?? "right", size: w.size ?? "m", sections: { ...cfg.sections, ...w.sections }, clock: dialOff(w.plans ?? "list"), dateLead: w.dateLead ?? "1", doneTasks: w.doneTasks === "hide" ? "hide" : "keep", laterTasks: w.laterTasks === "show" ? "show" : "hide", proposalWait: secs(w.proposalWait, 12), clashWait: secs(w.clashWait, 10), mute: Boolean(w.mute) }; // «plans» — с тех пор, как появился список (старое «clock» не переносим: по умолчанию теперь список)
  // «Звуки выключены» раньше жили в localStorage виджета — переносим в настройки один раз.
  if (w.mute === undefined && localStorage.getItem("maid.mute")) {
    cfg.mute = true;
    maid.saveSettings({ widget: { mute: true } });
  }
  localStorage.removeItem("maid.mute");
  applyCfg();
}
// Секунды до самонажатия кнопки (настройки виджета): число 3…60, иначе — по умолчанию.
function secs(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 3 && n <= 60 ? n : d;
}
// Настройки поменяли в разделе «Виджет» полной версии — перечитать и перерисовать.
maid.on("prefs", async () => {
  const was = { clock: cfg.clock, dateLead: cfg.dateLead };
  await loadCfg();
  render();
  if (cfg.clock !== was.clock) hideClock();
  else if (cfg.dateLead !== was.dateLead) drawClock();
});

// Кнопка в шапке — полная версия приложения; правым щелчком — сразу её раздел «Виджет» (настройки виджета).
$("#gear").addEventListener("click", (e) => {
  e.stopPropagation();
  maid.openMain();
});
$("#gear").addEventListener("contextmenu", (e) => {
  e.preventDefault();
  e.stopPropagation();
  maid.openSection("/widget");
});

// --- перетаскивание за шапку и за горничную: окно двигает main.js по курсору (так верно и на экранах с разным масштабом) ---
// У горничной щелчок — тычок: сдвинул мышь дальше DRAG_SLOP — это перетаскивание, щелчок после него не считается.
const DRAG_SLOP = 4;
let dragEl = null;
let dragFrom = null;
let dragMoved = false;
function draggable(el, skip) {
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || grabbed || skip(e)) return;
    el.setPointerCapture(e.pointerId);
    dragEl = el;
    dragFrom = { x: e.screenX, y: e.screenY };
    dragMoved = false;
    el.classList.add("dragging");
    maid.dragWidget("start");
  });
  el.addEventListener("pointermove", (e) => {
    if (dragEl !== el) return;
    if (!dragMoved && Math.hypot(e.screenX - dragFrom.x, e.screenY - dragFrom.y) > DRAG_SLOP) dragMoved = true;
    maid.dragWidget("move");
  });
  const end = (e) => {
    if (dragEl !== el) return;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    dropDrag();
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
  el.addEventListener("lostpointercapture", () => dragEl === el && dropDrag());
  // Протащили — щелчок, который браузер пришлёт следом, не считается тычком.
  el.addEventListener("click", (e) => {
    if (!dragMoved) return;
    dragMoved = false;
    e.stopImmediatePropagation();
    e.preventDefault();
  }, true);
}
// Захват потерян или кнопку отпустили где-то ещё — окно не должно остаться приклеенным к курсору.
function dropDrag() {
  if (!dragEl) return;
  dragEl.classList.remove("dragging");
  dragEl = null;
  maid.dragWidget("end");
}
const head = $("#head");
draggable(head, (e) => e.target.closest("button"));
draggable($("#maid"), () => false);
draggable($("#mini"), (e) => e.target.closest("button, input"));
document.addEventListener("pointerup", dropDrag);
window.addEventListener("blur", dropDrag);

// --- связь с main и мышь ---
maid.on("grab", (on) => {
  grabbed = on;
  $("#stage").classList.toggle("grab", on);
});
maid.on("changed", () => { loadCfg(); load(); });
maid.on("thinking", (on) => { wakeUp(); setState(on ? "think" : restState()); });
maid.on("reply", (r) => wakeUp() || remember(r.heard ?? "", r) || say(r.text, { emotion: r.emotion, ms: 12000, changes: r.changes ?? [], days: r.days ?? [], undo: r.undoable ? r.messageId : null, sound: r.changes?.length ? "ding" : null, mood: heardMood(r.heard, r), proposal: r.proposal, buttons: [...failedButtons(r), ...clashButtons(r)] }));
maid.on("opacity", (o) => { cfg.opacity = o; applyCfg(); });

// Окно сквозное везде, кроме панели, облачка и фигурки: main.js следит за курсором по этим прямоугольникам
// (forward-события мыши у «сквозного» окна на Windows ненадёжны, поэтому опрос курсора).
function reportRegions() {
  const rects = [];
  for (const el of [$("#w"), $("#mini"), $("#bubble"), $("#maid"), $("#planClock"), ...document.querySelectorAll(".pl-menu"), ...$("#inbox").children]) {
    if (el.offsetParent === null) continue;
    if (el.classList.contains("hidden")) continue;
    const r = el.getBoundingClientRect();
    if (r.width && r.height) rects.push({ x: r.left, y: r.top, w: r.width, h: r.height });
  }
  const c = $("#chat").getBoundingClientRect();
  if (c.width && $("#w").offsetParent !== null && !$("#w").classList.contains("hidden")) rects.push({ x: c.left, y: c.top, w: c.width, h: c.height, chat: true });
  maid.regions(rects);
}
setInterval(reportRegions, 300);
let clickTimer = 0;
// Значки непрочитанного (inbox.js) — щелчок по значку открывает его напоминание.
$("#inbox").addEventListener("click", (e) => {
  const ib = e.target.closest(".ib");
  if (ib) openInbox(ib.dataset.id);
});
drawInbox();
// Щелчок по горничной — тычок (fun.js), двойной — свернуть/развернуть панель. Тычок ждёт, не будет ли второго щелчка.
$("#maid").addEventListener("click", () => {
  clearTimeout(clickTimer);
  clickTimer = setTimeout(poke, 230);
});
$("#maid").addEventListener("dblclick", () => {
  clearTimeout(clickTimer);
  autoOpened = false;
  foldAnimated(!collapsed);
});
$("#miniOpen").onclick = () => { autoOpened = false; foldAnimated(false); };
// Выдвижная панель планов под свёрнутой карточкой: щелчок (по дню, по плану) разворачивает всю панель; перетаскивать здесь нельзя.
$("#planClock").addEventListener("pointerdown", (e) => { if (collapsed) e.stopImmediatePropagation(); }, true);
$("#planClock").addEventListener("click", (e) => {
  if (!collapsed) return;
  e.stopImmediatePropagation();
  autoOpened = false;
  hideClock();
  foldAnimated(false);
}, true);
// Точка привычек на кольце: одна — сразу отмечается, несколько — меню со списком и «Все сразу».
$("#miniHabit").onclick = (e) => {
  e.stopPropagation();
  if (miniHabits.length === 1) return markHabitDay(miniHabits[0], "done");
  closePlanMenu();
  const menu = document.createElement("div");
  menu.className = "pl-menu";
  menu.innerHTML = miniHabits.map((h, i) => `<button type="button" data-i="${i}">✓ ${esc(h.title)}</button>`).join("")
    + `<hr><button type="button" data-all>✓ Все сразу</button>`;
  const r = e.currentTarget.getBoundingClientRect();
  showPlanMenu(menu, r.right - 200, r.top - 8 - (miniHabits.length + 1) * 30);
  const list = miniHabits;
  menu.addEventListener("click", async (ev) => {
    const b = ev.target.closest("button");
    if (!b) return;
    closePlanMenu();
    if (b.dataset.all === undefined) return markHabitDay(list[Number(b.dataset.i)], "done");
    for (const h of list) await maid.api("POST", `/api/habits/${h.id}/mark`, { status: "done" }).catch(() => {});
    popTone(3);
    react("streak", 4000);
    maid.changed();
    load();
  });
};
$("#mini").addEventListener("dblclick", (e) => { if (e.target.closest("button, form")) return; autoOpened = false; foldAnimated(false); });
// Строка ввода свёрнутой панели: Enter — в ту же очередь, что чат панели; ответ — облачком над головой, панель остаётся свёрнутой.
$("#miniAsk").onsubmit = (e) => {
  e.preventDefault();
  const text = $("#miniInput").value.trim();
  if (!text) return;
  $("#miniInput").value = "";
  enqueue("/api/input", { text, id: crypto.randomUUID() }, text, true);
};
$("#miniInput").addEventListener("keydown", (e) => {
  e.stopPropagation();
  if (e.key === "Escape") { $("#miniInput").value = ""; $("#miniInput").blur(); }
});
// Голос — запись видна только в панели: разворачиваем её (она ваша, сама не свернётся) и начинаем.
$("#miniMic").onclick = () => {
  autoOpened = false;
  foldAnimated(false);
  setTimeout(() => { if (!Voice.on) toggleMic(); }, 380);
};
$("#maid").addEventListener("contextmenu", (e) => {
  e.preventDefault();
  maid.grab(!grabbed);
});

$("#open").onclick = () => maid.openMain();
$("#release").onclick = () => maid.grab(false);
// Двойной щелчок по названию открытой задачи — переименовать (то же окошко, что в панели планов, clock.js openRename).
$("#body").addEventListener("dblclick", (e) => {
  const li = e.target.closest("ul.list li");
  const tick = li?.querySelector(".check[data-done]:not(.done)");
  if (!tick || e.target === tick || li.matches(".leaving, .undo-row")) return;
  const t = (data?.tasks ?? []).find((x) => x.id === Number(tick.dataset.done));
  if (t) openRename({ task: true, id: t.id, title: t.title, date_iso: t.due_date }, li);
});
// ПКМ по открытой задаче — то же меню, что в панели планов (clock.js openTaskMenu): переименовать, перенести, удалить с «↩ Вернуть»…
// У задачи без срока дни меню (завтра, время, повтор) считаются от сегодня.
$("#body").addEventListener("contextmenu", (e) => {
  const li = e.target.closest("ul.list li");
  const tick = li?.querySelector(".check[data-done]:not(.done)");
  if (!tick || li.matches(".leaving, .undo-row, .fly")) return;
  const t = (data?.tasks ?? []).find((x) => x.id === Number(tick.dataset.done));
  if (!t) return;
  e.preventDefault();
  openTaskMenu({ task: true, id: t.id, title: t.title, date_iso: t.due_date ?? data.day }, li, e.clientX, e.clientY, () => tick.click());
});
// ПКМ по привычке: отметить или пропустить сегодня, переименовать, напоминания, закончить, удалить.
// «Закончить» — больше не появляется в новых днях, в истории остаётся со всеми отметками; «Удалить» — пропадает отовсюду,
// отметки в базе остаются. Всё через журнал отмены (POST /api/habits/:id): «↩ Вернуть» / «Отменить».
$("#body").addEventListener("contextmenu", (e) => {
  const li = e.target.closest("ul.list li.habit");
  const mark = li?.querySelector(".mark[data-habit]");
  if (!mark || li.matches(".leaving, .undo-row")) return;
  const h = (data?.habits ?? []).find((x) => x.id === Number(mark.dataset.habit));
  if (!h) return;
  e.preventDefault();
  openHabitMenu(h, li, e.clientX, e.clientY);
});
function openHabitMenu(h, li, x, y) {
  closePlanMenu();
  const item = (act, text) => `<button type="button" data-act="${act}">${text}</button>`;
  const menu = document.createElement("div");
  menu.className = "pl-menu";
  // Снять отметку — как повторный щелчок по галочке: день становится пропущенным (удалять отметки сервер не умеет).
  menu.innerHTML = (h.status === "done" ? item("skip", "↶ Снять отметку") : item("done", "✓ Сделано сегодня"))
    + (h.status ? "" : item("skip", "– Пропустить сегодня"))
    + `<hr>`
    + item("rename", "✎ Переименовать")
    + (h.quiet ? item("loud", "🔔 С напоминаниями") : item("quiet", "🔕 Без напоминаний"))
    + `<hr>`
    + item("finish", "⏸ Закончить привычку")
    + item("delete", "× Удалить привычку");
  showPlanMenu(menu, x, y);
  menu.addEventListener("click", (ev) => {
    const act = ev.target.closest("[data-act]")?.dataset.act;
    if (!act) return;
    closePlanMenu();
    if (act === "rename") return openRename({ habit: true, id: h.id, title: h.title }, li);
    if (act === "done" || act === "skip") return markHabitDay(h, act === "done" ? "done" : "skipped");
    editHabit(h, act, li);
  });
}
async function markHabitDay(h, status) {
  try {
    await maid.api("POST", `/api/habits/${h.id}/mark`, { status });
    if (status === "done") { popTone(2); react("streak", 4000); } else popTone(-3, { vol: 0.15, soft: true });
    maid.changed();
  } catch (err) {
    play("oops");
    say(err.message, { ms: 6000 });
  }
  load();
}
async function editHabit(h, act, li) {
  const body = act === "quiet" ? { quiet: true } : act === "loud" ? { quiet: false } : act === "finish" ? { finish: true } : { status: "stopped" };
  if (act === "finish" || act === "delete") { li.style.height = `${li.offsetHeight}px`; li.classList.add("fly"); }
  try {
    const r = await maid.api("POST", `/api/habits/${h.id}`, body);
    const text = act === "quiet" ? `«${h.title}» — без напоминаний ✓`
      : act === "loud" ? `«${h.title}» — снова с напоминаниями ✓`
        : act === "finish" ? `Закончила привычку «${h.title}». В истории она осталась со всеми отметками.`
          : `Удалила привычку «${h.title}».`;
    popTone(act === "delete" ? -1 : 2, { soft: act === "delete" });
    say(text, { ms: 5000, buttons: r.undo ? [{ text: "↩ Вернуть", run: () => undoHabit(h, r.undo) }] : [] });
    maid.changed();
  } catch (err) {
    li.classList.remove("fly");
    const msg = String(err?.message ?? err);
    say(/нет такого адреса|404/.test(msg) ? "Сервер ещё не умеет менять привычки — его нужно обновить." : `Не вышло: ${msg}`, { emotion: "worried", ms: 6000 });
  }
  setTimeout(() => load(), 400);
}
async function undoHabit(h, undo) {
  try {
    await maid.api("POST", "/api/undo", { messageId: undo });
    popTone(3);
    say(`Вернула «${h.title}» ✓`, { ms: 3000 });
    maid.changed();
  } catch (err) {
    say(`Не вышло: ${String(err?.message ?? err)}`, { emotion: "worried", ms: 6000 });
  }
  setTimeout(() => load(), 300);
}
$("#body").addEventListener("click", async (e) => {
  if (e.target.closest("#doneCount")) return toggleShowDone();
  const back = e.target.closest("[data-undo]");
  if (back) return undoGone(back.dataset.undo);
  const reopen = e.target.closest("[data-reopen]");
  if (reopen) return reopenTask(Number(reopen.dataset.reopen));
  const tick = e.target.closest("[data-done], [data-habit]");
  if (tick) {
    const key = tick.dataset.done ? `t${tick.dataset.done}` : `h${tick.dataset.habit}`;
    if (leavingRows.has(key)) return cancelLeave(key);
    if (cfg.doneTasks === "hide" && !tick.closest("li.did")) return startLeave(key, tick);
  }
  const id = e.target.dataset?.done;
  const habit = e.target.dataset?.habit;
  const save = e.target.dataset?.rescue;
  try {
    if (save) await rescue(e.target, save);
    else if (id) {
      // Галочка задачи: пупырка вдавливается с брызгами, строка съезжает вниз к сделанному, потом сервер.
      e.target.classList.add("done", "pressed");
      e.target.textContent = "✓";
      popTone(4);
      burst(e.target);
      react("done", 4000);
      const li = e.target.closest("li");
      // Название — из данных, не из строки: последним в строке бывает метка срока («сегодня», «завтра»).
      keepDone(Number(id), data.tasks.find((t) => t.id === Number(id))?.title ?? li.querySelector(".check + span").textContent);
      countDone(data.day);
      holdRender = Date.now() + 1100; // список не перерисовывать, пока строка едет вниз
      setTimeout(() => slideDown(li), 420);
      await maid.api("POST", `/api/tasks/${id}`, { status: "done" });
      maid.changed();
    } else if (habit) {
      const was = e.target.classList.contains("done");
      e.target.classList.toggle("done", !was);
      e.target.classList.add("pressed");
      if (was) { popTone(-5, { vol: 0.2, soft: true }); react("sad", 3500); }
      else { popTone(2); burst(e.target); react("streak", 4000); }
      await maid.api("POST", `/api/habits/${habit}/mark`, { status: was ? "skipped" : "done" });
      maid.changed();
    }
  } catch (err) {
    play("oops");
    say(err.message, { ms: 6000 });
    load();
  }
});

// Галочку у сделанной задачи можно снять: задача снова открыта (сервер помнит её срок и всё остальное).
async function reopenTask(id) {
  forgetDone(id);
  popTone(-5, { vol: 0.2, soft: true });
  render();
  try {
    await maid.api("POST", `/api/tasks/${id}`, { status: "open" });
    maid.changed();
    load();
  } catch (err) {
    play("oops");
    say(err.message, { ms: 6000 });
    load();
  }
}

setCollapsed(Boolean(localStorage.getItem("maid.collapsed")));
setState("idle");
if (!afterBedtime()) react("hello", 4500);
setInterval(render, 15_000);
// Что записано из Telegram или с телефона — появляется здесь через несколько секунд.
setInterval(load, 5_000);
setInterval(pollNotices, 5_000);
loadCfg().then(load);
pollNotices();
maid.widgetReady();

// --- уголок: вытянуть панель вниз (окно растит main.js, панель — 100vh − 380 px), высота запоминается ---
{
  const grip = $("#grip");
  let raf = 0;
  const step = () => { raf = 0; maid.resizeWidget("move"); };
  grip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    grip.setPointerCapture(e.pointerId);
    grip.classList.add("on");
    maid.resizeWidget("start");
  });
  grip.addEventListener("pointermove", () => { if (grip.classList.contains("on") && !raf) raf = requestAnimationFrame(step); });
  const end = () => {
    if (!grip.classList.contains("on")) return;
    grip.classList.remove("on");
    maid.resizeWidget("end");
    setTimeout(render, 60); // больше места — больше задач
  };
  grip.addEventListener("pointerup", end);
  grip.addEventListener("lostpointercapture", end);
  grip.addEventListener("dblclick", (e) => { e.stopPropagation(); maid.resizeWidget("reset"); setTimeout(render, 60); });
  addEventListener("resize", () => { if (!grip.classList.contains("on")) render(); });
}
