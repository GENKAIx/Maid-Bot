// Экскурсия при первом запуске: горничная по очереди подсвечивает кнопки виджета (кольцо вокруг, остальное панели притушено)
// и объясняет облачком, в конце знакомится — дата рождения и рост в профиль, «о себе» уходит ей обычным сообщением — и даёт
// ссылку на «Возможности». Один раз на компьютере (localStorage maid.tour), повторить — пункт «Экскурсия» в трее.
// Пока идёт — облачко её: прочие реплики молчат (say, touring), хвосты не спрашивают (tails.js), уведомления копятся в ящике.

const TOUR_KEY = "maid.tour";
/** Положена ли экскурсия: на этом компьютере не было — да; localStorage недоступен — нет (иначе лезла бы на каждом запуске). */
function tourDue(ls = localStorage) {
  try { return ls.getItem(TOUR_KEY) !== "1"; } catch { return false; }
}
function tourSeen(ls = localStorage) {
  try { ls.setItem(TOUR_KEY, "1"); } catch {}
}

// target — что подсветить (селектор или несколько), mood — анимация горничной, example — печатается подсказкой в строке ввода.
const TOUR_STEPS = [
  { id: "hello", mood: "hello", text: "Привет! Я горничная — буду вести твои планы, задачи и привычки. Покажу, что тут где, — это минута." },
  { id: "input", target: "#chatInput", mood: "write", example: "завтра в 15 врач",
    text: "Сюда пиши как другу: «завтра в 15 врач», «купить хлеб», «спал 6 часов». Сама пойму, план это, задача или дневник, — и разложу." },
  { id: "mic", target: "#chatMic", mood: "listen", text: "Руки заняты — нажми микрофон и скажи. Расшифрую и запишу так же, как текст." },
  { id: "clip", target: "#chatClip", mood: "think", text: "Плюсик — приложить картинку: чек станет тратой, билет — планом, список — задачами. Можно и Ctrl+V." },
  { id: "history", target: "#chatHistBtn", mood: "present", text: "Часики — мои последние ответы. Записала не то — там же «Отменить»." },
  { id: "next", target: "#next", mood: "remind",
    text: "Здесь ближайшие планы. Щелчок по плану — панель дня и неделя; «+ План» — добавить самому, без чата. Перед планом напомню." },
  { id: "list", target: "#body", mood: "list", text: "Ниже — привычки и задачи на сегодня. Галочка — сделано. Про просроченное спрошу сама, по одному." },
  { id: "head", target: ["#head", "#grip"], mood: "bow",
    text: "За шапку виджет можно перетащить, кнопкой в ней — свернуть, а кнопка справа открывает полную версию (правый щелчок — настройки виджета). За уголок внизу панель тянется длиннее." },
  { id: "maid", target: "#maid", mood: "giggle", text: "А это я. Ткни — отвечу. Когда тебя нет за компьютером, сплю, а вернёшься — расскажу, что пришло." },
  { id: "profile", mood: "smitten", text: "Давай познакомимся! Заполни, что хочешь, — любое поле можно пропустить." },
  { id: "end", mood: "excited", text: "Готово! Я есть и в Telegram — там всё то же самое. Начни с первого дела: напиши, что у тебя сегодня." },
];

let tourAbout = "";
let tourSaveError = "";

function startTour() {
  if (touring || napping) return;
  touring = true;
  tourAbout = tourSaveError = "";
  tourSeen();
  if (collapsed) { autoOpened = false; foldAnimated(false); }
  hideClock();
  tourStep(0);
}

function tourStep(i) {
  const s = TOUR_STEPS[i];
  if (!s) return endTour();
  const last = i === TOUR_STEPS.length - 1;
  lightUp(s.target);
  showExample(s.example);
  const buttons = s.id === "profile"
    ? [{ text: "Сохранить", run: () => { saveAbout(); tourStep(i + 1); } }, { text: "Пропустить", run: () => tourStep(i + 1) }]
    : last
      ? [{ text: "Что я умею", run: () => { maid.openSection("/features"); endTour(); } }, { text: "Начать", run: endTour }]
      : [{ text: i ? "Дальше" : "Покажи", run: () => tourStep(i + 1) }, { text: i ? "Хватит" : "Потом", run: endTour }];
  say(s.text, { buttons, ms: 0, mood: s.mood, tour: true });
  const cards = $("#bubbleCards");
  if (s.id === "profile") cards.innerHTML = aboutForm();
  cards.insertAdjacentHTML("beforeend", `<div class="tour-dots" aria-label="Шаг ${i + 1} из ${TOUR_STEPS.length}">${TOUR_STEPS.map((_, k) => `<i${k === i ? ' class="on"' : ""}></i>`).join("")}</div>`);
  if (s.id === "profile") bindAbout();
}

function endTour() {
  if (!touring) return;
  touring = false;
  lightUp(null);
  showExample(null);
  hideBubble();
  if (tourSaveError) say(`Профиль не сохранился: ${tourSaveError}`, { emotion: "worried", ms: 6000 });
  // «О себе» — обычным сообщением: разбор запомнит, что это о человеке (память, бафы и дебафы).
  if (tourAbout) {
    chatInput.value = tourAbout;
    tourAbout = "";
    sendChat();
  }
}

// --- Знакомство: дата рождения и рост — в профиль (/api/profile), «о себе» — сообщением после экскурсии ---
function aboutForm() {
  return `<form class="tour-form" autocomplete="off">
    <label>День рождения<input type="date" name="birthday" max="${esc(data?.day ?? "")}"></label>
    <label>Рост, см<input type="number" name="height" min="80" max="250" inputmode="numeric"></label>
    <label class="wide">О себе<textarea name="about" rows="3" maxlength="1000" placeholder="Как тебя зовут, чем занимаешься, что любишь, есть ли аллергии…"></textarea></label>
  </form>`;
}
function bindAbout() {
  const form = $(".tour-form");
  // Окно «сквозное»: щелчок по форме — окну нужна клавиатура (как строке чата), ушли из формы — отдаёт.
  form.addEventListener("mousedown", () => maid.focusInput(true));
  form.addEventListener("focusout", (e) => { if (!form.contains(e.relatedTarget) && !grabbed) maid.focusInput(false); });
  form.onsubmit = (e) => e.preventDefault();
  // Уже заполненное в профиле — подставить.
  maid.api("GET", "/api/profile").then((p) => {
    if (p?.birthday && !form.birthday.value) form.birthday.value = p.birthday;
    if (p?.height && !form.height.value) form.height.value = String(p.height);
  }, () => {});
}
function saveAbout() {
  const form = $(".tour-form");
  if (!form) return;
  const patch = {};
  if (/^\d{4}-\d{2}-\d{2}$/.test(form.birthday.value)) patch.birthday = form.birthday.value;
  const h = Number(form.height.value);
  if (h >= 80 && h <= 250) patch.height = Math.round(h);
  tourAbout = form.about.value.trim();
  maid.focusInput(false);
  if (Object.keys(patch).length) maid.api("POST", "/api/profile", patch).then(() => maid.changed(), (e) => { tourSaveError = e.message; });
}

// --- Подсветка: кольцо вокруг цели (идёт за ней, если панель двигается), остальное в панели притушено (.stage.tour-dim) ---
let ringRaf = 0;
function lightUp(target) {
  for (const el of document.querySelectorAll(".tour-on, .tour-path")) el.classList.remove("tour-on", "tour-path");
  for (const el of document.querySelectorAll(".tour-ring")) el.remove();
  cancelAnimationFrame(ringRaf);
  const els = [target ?? []].flat().map((t) => $(t)).filter((el) => el && el.offsetParent !== null);
  $("#stage").classList.toggle("tour-dim", els.length > 0);
  if (!els.length) return;
  for (const el of els) {
    el.classList.add("tour-on");
    for (let x = el.parentElement; x && x !== document.body; x = x.parentElement) x.classList.add("tour-path");
  }
  const rings = els.map(() => document.body.appendChild(Object.assign(document.createElement("div"), { className: "tour-ring" })));
  (function follow() {
    els.forEach((el, k) => {
      const r = el.getBoundingClientRect();
      Object.assign(rings[k].style, { left: `${r.left - 5}px`, top: `${r.top - 5}px`, width: `${r.width + 10}px`, height: `${r.height + 10}px` });
    });
    ringRaf = requestAnimationFrame(follow);
  })();
}

// Пример в строке ввода — подсказкой (placeholder), по букве; ничего не отправляется.
let exampleTimer = 0;
let examplePlaceholder = null;
function showExample(text) {
  clearInterval(exampleTimer);
  if (examplePlaceholder !== null) chatInput.placeholder = examplePlaceholder;
  examplePlaceholder = null;
  if (!text) return;
  examplePlaceholder = chatInput.placeholder;
  let k = 0;
  exampleTimer = setInterval(() => {
    chatInput.placeholder = text.slice(0, ++k);
    if (k >= text.length) clearInterval(exampleTimer);
  }, 70);
}

// Облачко экскурсии закрыли (✕) — экскурсия кончилась. Между шагами облачко прячется на миг — это не считается.
new MutationObserver(() => {
  if (touring && $("#bubble").classList.contains("hidden")) setTimeout(() => { if (touring && $("#bubble").classList.contains("hidden")) endTour(); }, 60);
}).observe($("#bubble"), { attributes: true, attributeFilter: ["class"] });

maid.on("tour", () => { if (touring) endTour(); startTour(); });

// Первый запуск: когда данные пришли, горничная не спит и облачко свободно (раньше хвостов — tails.js ждёт 6 с).
setTimeout(function waitTour() {
  if (!tourDue()) return;
  if (!data || napping || !$("#bubble").classList.contains("hidden")) return setTimeout(waitTour, 3000);
  startTour();
}, 4000);
