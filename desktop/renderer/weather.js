// Погода утром (21.11.2026): прогноз с сервера (GET /api/weather — Open-Meteo по городу из «Персонализации → О вас»,
// фраза и задетый план выбирает server/src/weather.ts). Здесь — что видно в виджете:
//   • первый ответ дня после подъёма (daySleep.wakeMin) — фраза о погоде вместо «С возвращением» (cfg.weatherMorning);
//   • плашка «☂ +3°» в шапке рядом с датой — до полудня, весь день или нет (cfg.weatherChip);
//   • сцена погоды (26.11.2026, по макету docs/review/погода-утром-2026-11-20.html, «Шесть утр», колонка «Новое») — только после
//     её фразы о погоде (утренней или ответа на «какая погода?»): WX_FX_MS, потом угасание WX_FX_FADE, и слоя больше нет;
//     нет при «Эффекты: тихо», «Уменьшить движение» в системе, свёрнутом виджете и во сне;
//   • значок ☂/🌨/⚠ у плана в «Ближайшем», который задевает погода;
//   • в опасную погоду (метель, гроза, гололёд, сильный ветер) — «Перенести на завтра» / «Оставить», после переноса — «↩ Отменить».
// Города нет или сеть молчит — сервер отдаёт null, и погоды в виджете просто нет.

const WX_POLL_MS = 30 * 60_000; // прогноз на сервере обновляется раз в 3 ч — опрашивать чаще незачем
const WX_SAID_KEY = "maid.wxSaid"; // день, когда утренняя фраза уже прозвучала
const WX_GREET_UNTIL = 14; // после этого часа утренняя фраза уже не к месту
const WX_FX_MS = 30_000; // столько играет сцена погоды после её фразы
const WX_FX_FADE = 2500; // плавное угасание сцены (wx-fade в style.css — столько же)
// Погода дня (kind с сервера) → одна из шести сцен макета. Жара — как ясно, туман — как пасмурно.
const WX_SCENE = { clear: "sun", heat: "sun", rain: "rain", snow: "snow", frost: "frost", storm: "storm", gray: "gray", fog: "gray" };
// Опасная погода (kind storm) — какая именно, в danger (server/src/weather.ts danger()): метель — сцена метели, гроза — дождь,
// гололёд — иней, сильный ветер — облака. Снег вбок и шапка снега — только в метель.
const WX_DANGER_SCENE = { "метель": "storm", "гроза": "rain", "гололёд": "frost", "сильный ветер": "gray" };
const WX_SCENES = ["sun", "rain", "snow", "frost", "storm", "gray"];
let wxNow = null; // ответ /api/weather: { day, kind, icon, temp, text, pose, emotion, hit, plan, move, sky, … } или null
let wxAt = 0; // когда спросили
let wxFxRun = null; // играющая сцена: { scene, layer, timers, ro }
let wxSaidDay = ""; // память о WX_SAID_KEY, чтобы не читать localStorage на каждое движение мыши

// Опрос из load(): не чаще WX_POLL_MS, или сразу, если сменился день.
async function wxLoad(force = false) {
  if (!force && Date.now() - wxAt < WX_POLL_MS && (!wxNow || wxNow.day === data?.day)) return;
  wxAt = Date.now();
  try {
    wxNow = (await maid.api("GET", "/api/weather"))?.weather ?? null;
  } catch {
    return; // старый сервер без /api/weather или нет связи — без погоды, спросим через полчаса
  }
  wxDraw();
  if (!napping) wxGreet();
}

// Плашка видна: погода на сегодня есть и по настройке ещё её время.
function wxShowing(now = new Date()) {
  if (!wxNow || !data || wxNow.day !== data.day || cfg.weatherChip === "off") return false;
  return cfg.weatherChip === "day" || now.getHours() < 12;
}

// Пора сказать утреннюю фразу: включено, сегодня ещё не говорила, подъём уже был, а полдень с запасом — ещё нет.
function wxGreetDue(now = new Date()) {
  if (!cfg.weatherMorning || !wxNow || !data || wxNow.day !== data.day) return false;
  if (!wxSaidDay) try { wxSaidDay = localStorage.getItem(WX_SAID_KEY) ?? "-"; } catch { wxSaidDay = "-"; }
  if (wxSaidDay === wxNow.day) return false;
  const m = now.getHours() * 60 + now.getMinutes();
  return m >= daySleep.wakeMin && now.getHours() < WX_GREET_UNTIL;
}

// Кнопки к фразе: в опасную погоду, если задет план, — перенести его на завтра или оставить.
function wxButtons() {
  if (!wxNow?.move || !wxNow.plan) return [];
  const plan = wxNow.plan;
  return [{ text: "Перенести на завтра", run: () => wxMove(plan) }, { text: "Оставить", run: () => react("thumbsup", 2500) }];
}

// Сказать утреннюю фразу (один раз в день). Облачко уже занято — подождём следующего случая. true — сказала.
function wxGreet(now = new Date()) {
  if (!wxGreetDue(now) || !$("#bubble").classList.contains("hidden")) return false;
  wxSaidDay = wxNow.day;
  try { localStorage.setItem(WX_SAID_KEY, wxNow.day); } catch {}
  wxSay(wxNow, wxButtons());
  return true;
}

// Фраза о погоде и сразу её сцена — тот же путь у утренней фразы и у показа погоды в «Витрине» админки (server/preview/control.js).
function wxSay(w, buttons = []) {
  say(w.text, { emotion: w.emotion || "neutral", mood: MOODS.includes(w.pose) ? w.pose : null, ms: buttons.length ? 0 : 12000, buttons });
  wxFx(w);
}

async function wxMove(plan) {
  try {
    await maid.api("POST", "/api/weather/move", { eventId: plan.id });
    react("done", 2500);
    say(`«${plan.title}» — на завтра${plan.time ? `, в ${plan.time}` : ""}.`, { ms: 10000, buttons: [{ text: "↩ Отменить", run: () => wxBack(plan) }] });
  } catch (e) {
    play("oops");
    say(errText(e), { ms: 6000 });
  }
  maid.changed();
  load();
}
async function wxBack(plan) {
  try {
    await maid.api("POST", "/api/weather/move", { eventId: plan.id, back: true });
    say(`Вернула «${plan.title}» на сегодня.`, { ms: 5000 });
  } catch (e) {
    play("oops");
    say(errText(e), { ms: 6000 });
  }
  maid.changed();
  load();
}

// Шапка и значок у плана — после каждой перерисовки и после ответа сервера (сцена погоды — только после фразы, wxFx).
let wxCountedDay = "";
function wxDraw(now = new Date()) {
  const on = wxShowing(now);
  let chip = $("#wxChip");
  if (!chip) {
    chip = document.createElement("span");
    chip.id = "wxChip";
    chip.className = "wx-chip";
    $("#day")?.after(chip);
  }
  chip.classList.toggle("hidden", !on);
  // Плашку видно — раз в день в счётчик фич (у неё нет щелчка: счёт — «показалась»).
  if (on && wxCountedDay !== wxNow.day) {
    wxCountedDay = wxNow.day;
    maid.track?.("widget.weather");
  }
  if (on) {
    chip.textContent = `${wxNow.icon} ${wxNow.temp}`;
    chip.title = `${wxNow.city ?? ""}: ${wxNow.text}`.replace(/^: /, "");
  }
  for (const el of document.querySelectorAll("#next .nx-wx")) el.remove();
  const row = wxNow?.hit && wxNow.plan && wxNow.day === data?.day ? $(`#next .nx[data-id="${wxNow.plan.id}"]`) : null;
  if (row) {
    const s = document.createElement("span");
    s.className = "nx-wx";
    s.textContent = wxNow.hit;
    s.title = wxNow.text;
    row.querySelector(".hero-txt, .nx-title")?.after(s);
  }
  if (wxFxRun && wxFxCalm()) wxFxStop(); // «Эффекты: тихо» включили посреди сцены
}

// --- сцена погоды (по макету: частицы, лучи, иней, ветер, облака; капли с облачка в дождь — bubblefx.js, «тает» при sad) ---
function wxScene(w) {
  // storm без danger (старый сервер, «Витрина») — по небу; неба нет — облака, а не метель.
  if (w?.kind === "storm") return WX_DANGER_SCENE[w.danger] ?? (WX_SCENES.includes(w.sky) ? w.sky : "gray");
  return WX_SCENE[w?.kind] ?? (WX_SCENES.includes(w?.sky) ? w.sky : "");
}
function wxFxCalm() {
  return cfg.fx === "quiet" || matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Сцена погоды после её фразы: w — ответ /api/weather или признак weather из ответа чата ({ kind, sky }). Играет WX_FX_MS,
 *  потом угасает и уходит из DOM. Фразы не видно (облачко закрыто, спит, экскурсия), виджет свёрнут, «тихо» — сцены нет.
 *  Повторная фраза — сцена с начала. true — играет. */
function wxFx(w) {
  const scene = wxScene(w);
  if (!scene || wxFxCalm() || napping || touring || collapsed || $("#bubble").classList.contains("hidden")) return false;
  wxFxStop();
  const stage = $("#stage"), panel = $("#w");
  const layer = document.createElement("div");
  layer.id = "wxSky";
  layer.className = `wx-sky wx-${scene}`;
  layer.setAttribute("aria-hidden", "true");
  const run = (wxFxRun = { scene, layer, timers: [], ro: null });
  const rnd = (a, b) => a + Math.random() * (b - a);
  const add = (cls, css, txt) => {
    const i = document.createElement("i");
    i.className = cls;
    if (css) i.style.cssText = css; // через CSSOM: CSP запрещает только атрибут style в разметке
    if (txt) i.textContent = txt;
    layer.append(i);
  };
  // Количество, места и темп — как в макете.
  if (scene === "snow") for (let i = 0; i < 34; i++) add("fl", `left:${rnd(0, 100)}%;--s:${rnd(3, 7).toFixed(1)}px;--d:${rnd(5, 10).toFixed(1)}s;--dl:-${rnd(0, 10).toFixed(1)}s;--dx:${rnd(-30, 30).toFixed(0)}px`);
  if (scene === "storm") {
    add("dim", "");
    for (let i = 0; i < 70; i++) add("st", `left:${rnd(10, 140)}%;--d:${rnd(0.9, 1.7).toFixed(2)}s;--dl:-${rnd(0, 2).toFixed(2)}s`);
  }
  if (scene === "rain") for (let i = 0; i < 46; i++) add("dr", `left:${rnd(0, 120)}%;--d:${rnd(0.6, 1).toFixed(2)}s;--dl:-${rnd(0, 1).toFixed(2)}s`);
  if (scene === "sun") {
    add("sun", "");
    [-150, -135, -118, -100].forEach((a) => add("ray", `--a:${a}deg`));
    for (let i = 0; i < 8; i++) add("mote", `left:${rnd(10, 90)}%;top:${rnd(10, 70)}%;--dl:-${rnd(0, 5).toFixed(1)}s`);
  }
  if (scene === "gray") [[8, 26, 0], [42, 34, -12], [20, 40, -22]].forEach(([y, d, dl]) => add("cl", `--y:${y}px;--d:${d}s;--dl:${dl}s`));
  if (scene === "frost") for (let i = 0; i < 9; i++) add("ice", `left:${rnd(4, 94)}%;top:${rnd(52, 96)}%;--dl:-${rnd(0, 2.4).toFixed(1)}s`, "✦");
  if (scene === "snow" || scene === "storm") add("cap", ""); // панель заметает: шапка снега растёт по верху за 5 с
  stage.append(layer);
  wxFxPlace();
  if (typeof ResizeObserver === "function") (run.ro = new ResizeObserver(() => wxFxPlace())).observe(stage);
  // Фраза раскрыла свёрнутый виджет (foldAnimated): панель и горничная ещё в анимации (рамки по мини-карточке, а окно и #stage
  // не меняются) — место ставим заново, когда анимация кончится.
  for (const el of [panel, $("#maid")]) for (const a of el?.getAnimations?.() ?? []) {
    const again = () => wxFxRun === run && wxFxPlace();
    a.finished?.then(again, again);
  }
  if (scene === "frost") panel.classList.add("wx-frost");
  if (scene === "storm") {
    panel.classList.remove("wx-shake");
    void panel.offsetWidth; // толчок с начала и у повторной фразы
    panel.classList.add("wx-shake");
  }
  run.timers.push(setTimeout(() => {
    layer.classList.add("out");
    if (panel.classList.contains("wx-frost")) panel.classList.replace("wx-frost", "wx-thaw"); // иней сходит за то же время
    run.timers.push(setTimeout(wxFxStop, WX_FX_FADE));
  }, WX_FX_MS));
  return true;
}

// Слой — над панелью, горничной и облачком с фразой, как небо над виджетом в макете (от макушки на 10 px выше до низа панели).
// Над панелью окно прозрачное: там края слоя гаснут маской (.wx-sky в style.css), а не режутся. В слое: --pl/--pt/--pw/--ph —
// где панель (шапка снега, сумрак метели, маска), --fh/--fhn — путь частиц до низа слоя (темп как в макете).
function wxFxPlace() {
  const r = wxFxRun;
  if (!r) return;
  const s = $("#stage").getBoundingClientRect(), p = $("#w").getBoundingClientRect();
  const boxes = [$("#maid")?.getBoundingClientRect(), $("#bubble")?.classList.contains("hidden") ? null : $("#bubble")?.getBoundingClientRect?.()]
    .filter((b) => b && b.width && b.height);
  const top = Math.max(0, Math.min(p.top, ...boxes.map((b) => b.top)) - 10 - s.top);
  const bottom = Math.max(p.bottom, ...boxes.map((b) => b.bottom)) - s.top;
  const left = Math.max(0, Math.min(p.left, ...boxes.map((b) => b.left)) - s.left);
  const right = Math.min(s.width, Math.max(p.right, ...boxes.map((b) => b.right)) - s.left);
  const h = Math.max(0, bottom - top), fh = Math.round(h + 30);
  r.layer.style.cssText = `left:${left}px;top:${top}px;width:${Math.max(0, right - left)}px;height:${h}px;--pl:${p.left - s.left - left}px;--pt:${p.top - s.top - top}px;--pw:${p.width}px;--ph:${p.height}px;--fh:${fh}px;--fhn:${fh}`;
}

function wxFxStop() {
  const r = wxFxRun;
  if (!r) return;
  wxFxRun = null;
  for (const t of r.timers) clearTimeout(t);
  r.ro?.disconnect();
  r.layer.remove();
  $("#w")?.classList.remove("wx-frost", "wx-thaw", "wx-shake");
}

// Не уснула, но сегодня ещё не говорила: первое движение мыши над виджетом после подъёма — фраза о погоде.
document.addEventListener("pointermove", () => {
  if (!napping && wxGreetDue()) wxGreet();
});
