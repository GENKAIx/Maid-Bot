// Погода утром (21.11.2026): прогноз с сервера (GET /api/weather — Open-Meteo по городу из «Персонализации → О вас»,
// фраза и задетый план выбирает server/src/weather.ts). Здесь — что видно в виджете:
//   • первый ответ дня после подъёма (daySleep.wakeMin) — фраза о погоде вместо «С возвращением» (cfg.weatherMorning);
//   • плашка «☂ +3°» в шапке рядом с датой и частицы над панелью — до полудня, весь день или нет (cfg.weatherChip);
//     частиц нет при «Эффекты: тихо» и при «Уменьшить движение» в системе;
//   • значок ☂/🌨/⚠ у плана в «Ближайшем», который задевает погода;
//   • в опасную погоду (метель, гроза, гололёд, сильный ветер) — «Перенести на завтра» / «Оставить», после переноса — «↩ Отменить».
// Города нет или сеть молчит — сервер отдаёт null, и погоды в виджете просто нет.

const WX_POLL_MS = 30 * 60_000; // прогноз на сервере обновляется раз в 3 ч — опрашивать чаще незачем
const WX_SAID_KEY = "maid.wxSaid"; // день, когда утренняя фраза уже прозвучала
const WX_GREET_UNTIL = 14; // после этого часа утренняя фраза уже не к месту
const WX_DROPS = { snow: 18, rain: 26, storm: 30 };
let wxNow = null; // ответ /api/weather: { day, kind, icon, temp, text, pose, emotion, hit, plan, move, sky, … } или null
let wxAt = 0; // когда спросили
let wxSkyDrawn = ""; // какое небо сейчас нарисовано над панелью
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

// Плашка и частицы видны: погода на сегодня есть и по настройке ещё её время.
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
  const buttons = wxButtons();
  say(wxNow.text, { emotion: wxNow.emotion || "neutral", mood: MOODS.includes(wxNow.pose) ? wxNow.pose : null, ms: buttons.length ? 0 : 12000, buttons });
  return true;
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

// Шапка, значок у плана, небо над панелью — после каждой перерисовки и после ответа сервера.
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
  wxSky(on ? wxNow.sky : "");
}

// Частицы: снег (и шапка снега на панели), косой дождь, иней по краю, метель с толчком, облака, солнце.
function wxSky(sky) {
  const calm = cfg.fx === "quiet" || matchMedia("(prefers-reduced-motion: reduce)").matches;
  const want = calm ? "" : sky || "";
  if (want === wxSkyDrawn) return;
  wxSkyDrawn = want;
  const w = $("#w");
  $("#wxSky")?.remove();
  w.classList.remove("wx-frost", "wx-capped", "wx-shake");
  if (!want) return;
  const layer = document.createElement("div");
  layer.id = "wxSky";
  layer.className = `wx-sky wx-${want}`;
  layer.setAttribute("aria-hidden", "true");
  const n = WX_DROPS[want] ?? (want === "gray" ? 3 : want === "sun" ? 1 : 0);
  for (let i = 0; i < n; i++) {
    const p = document.createElement("i");
    // Своё место и темп у каждой — без Math.random, чтобы картинка не «перетасовывалась» при перерисовке.
    const k = (i * 37 + 11) % 100;
    p.style.setProperty("--x", `${k}%`);
    p.style.setProperty("--d", `${((i * 53) % 40) / 10}s`);
    p.style.setProperty("--s", `${(want === "snow" ? 5 : want === "storm" ? 1.6 : want === "gray" ? 40 : 1.1) + ((i * 29) % 10) / 10}s`);
    p.style.setProperty("--z", `${0.6 + ((i * 17) % 5) / 10}`);
    layer.append(p);
  }
  w.prepend(layer);
  if (want === "frost") w.classList.add("wx-frost");
  if (want === "snow" || want === "storm") w.classList.add("wx-capped");
  if (want === "storm") {
    w.classList.add("wx-shake");
    setTimeout(() => w.classList.remove("wx-shake"), 700);
  }
}

// Не уснула, но сегодня ещё не говорила: первое движение мыши над виджетом после подъёма — фраза о погоде.
document.addEventListener("pointermove", () => {
  if (!napping && wxGreetDue()) wxGreet();
});
