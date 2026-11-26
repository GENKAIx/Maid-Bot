// Погода утром в виджете (21.11.2026; desktop/renderer/weather.js): первая фраза дня после подъёма — одна в день, плашка в шапке
// до полудня (или весь день, или нет), кнопки «Перенести на завтра» / «Оставить» только в опасную погоду, перенос и «↩ Отменить»
// идут в /api/weather/move; хуки в widget.js (подъём, опрос, перерисовка), настройки в main.js и на сайте.
// Сцена погоды (26.11.2026, по макету docs/review/погода-утром-2026-11-20.html): сцена по kind/sky, только после фразы о погоде,
// через WX_FX_MS угасает и снимается (часы поддельные), повтор — с начала, «тихо» / меньше движения / свёрнут / спит — нет.
// Этап 15 (26.11.2026): опасная погода — сцена по danger (снег вбок только в метель), слой и над облачком, края над прозрачным
// окном гаснут маской, путь частиц — до низа слоя (--fh), место — заново после раскрытия виджета, признак погоды из быстрой записи.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const root = path.join(__dirname, "..", "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const src = read("desktop/renderer/weather.js"), widget = read("desktop/renderer/widget.js"), main = read("desktop/src/main.js");
const html = read("desktop/renderer/widget.html"), site = read("web/src/screens/Widget.tsx");

const store = {};
const said = [], posted = [], reacted = [];
let bubbleHidden = true, bubbleRect = null;
// Маленький DOM: узлы с классами и детьми, место на экране — у #stage, #w и #maid.
function node(tag) {
  const cls = new Set();
  const e = {
    tag, id: "", children: [], parent: null, style: { cssText: "" }, attrs: {}, textContent: "", offsetWidth: 0,
    get className() { return [...cls].join(" "); }, set className(v) { cls.clear(); for (const c of String(v).split(/\s+/)) if (c) cls.add(c); },
    classList: { add: (...c) => c.forEach((x) => cls.add(x)), remove: (...c) => c.forEach((x) => cls.delete(x)), contains: (c) => cls.has(c),
      replace: (a, b) => { if (cls.delete(a)) cls.add(b); }, toggle: (c, on) => ((on ?? !cls.has(c)) ? cls.add(c) : cls.delete(c)) },
    append(c) { c.parent = e; e.children.push(c); }, prepend(c) { c.parent = e; e.children.unshift(c); },
    remove() { if (e.parent) e.parent.children = e.parent.children.filter((x) => x !== e); e.parent = null; },
    setAttribute(k, v) { e.attrs[k] = v; }, rect: null, getBoundingClientRect: () => e.rect, anims: [], getAnimations: () => e.anims,
  };
  return e;
}
const box = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
const stage = node("div"), panel = node("div"), maidEl = node("div");
stage.rect = box(0, 0, 620, 760); panel.rect = box(288, 300, 324, 452); maidEl.rect = box(400, 90, 196, 210);
// Поддельные часы: setTimeout/clearTimeout идут по clock, advance(ms) прогоняет срок.
let clock = 0, timers = [], tid = 0;
const fakeSet = (f, ms = 0) => { const t = { f, at: clock + ms, id: ++tid }; timers.push(t); return t.id; };
const fakeClear = (id) => { timers = timers.filter((t) => t.id !== id); };
function advance(ms) {
  const end = clock + ms;
  for (;;) {
    const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
    if (!due) break;
    timers = timers.filter((t) => t !== due);
    clock = due.at;
    due.f();
  }
  clock = end;
}
let reduced = false;
const ctx = {
  localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } },
  document: { addEventListener: () => {}, querySelectorAll: () => [], createElement: node },
  $: (q) => (q === "#bubble" ? { classList: { contains: () => bubbleHidden }, getBoundingClientRect: () => bubbleRect ?? box(0, 0, 0, 0) } : q === "#stage" ? stage : q === "#w" ? panel : q === "#maid" ? maidEl : null),
  setTimeout: fakeSet, clearTimeout: fakeClear, matchMedia: () => ({ matches: reduced }),
  touring: false, collapsed: false,
  say: (text, o = {}) => said.push({ text, ...o }), react: (m) => reacted.push(m), play: () => {}, errText: (e) => String(e.message),
  load: () => {}, maid: { api: async (m, p, b) => { posted.push([m, p, b]); return {}; }, changed: () => {} },
  MOODS: ["happy", "worried", "remind", "tea", "excited", "thumbsup", "done"],
  daySleep: { wakeMin: 7 * 60 }, cfg: { weatherMorning: true, weatherChip: "noon", fx: "normal" }, data: { day: "2026-11-21" }, napping: false,
};
vm.createContext(ctx);
vm.runInContext(`${src}\nthis.set = (w) => { wxNow = w; wxSaidDay = ""; }; this.fns = { wxGreetDue, wxGreet, wxShowing, wxButtons, wxScene, wxFx, wxFxStop, wxSay };
  this.consts = { WX_FX_MS, WX_FX_FADE };`, ctx);
const { wxGreetDue, wxGreet, wxShowing, wxButtons, wxScene, wxFx, wxFxStop, wxSay } = ctx.fns;

const at = (h, m = 0) => new Date(2026, 10, 21, h, m);
const STORM = { day: "2026-11-21", kind: "storm", icon: "🌬", temp: "−4°", text: "С обеда метель. А у вас шиномонтаж в 18:00 — может, перенесём?", pose: "worried", emotion: "worried",
  hit: "⚠", plan: { id: 7, title: "Шиномонтаж", time: "18:00" }, move: true, sky: "storm" };

(async () => {
  ctx.set(STORM);
  check(!wxGreetDue(at(6, 59)), "до подъёма — молчит");
  check(wxGreetDue(at(7, 0)) && wxGreetDue(at(13, 59)) && !wxGreetDue(at(14, 0)), "с подъёма до 14:00");
  bubbleHidden = false;
  check(!wxGreet(at(8)) && !said.length, "облачко занято — ждём");
  bubbleHidden = true;
  check(wxGreet(at(8)), "сказала");
  check(said[0].text === STORM.text && said[0].mood === "worried" && said[0].ms === 0, `фраза, поза и без самозакрытия: ${JSON.stringify(said[0])}`);
  check(said[0].buttons.map((b) => b.text).join("|") === "Перенести на завтра|Оставить", "кнопки в метель");
  check(!wxGreet(at(9)) && said.length === 1 && store["maid.wxSaid"] === "2026-11-21", "второй раз за день — нет");
  ctx.set(STORM);
  check(!wxGreetDue(at(9)), "и после перезапуска виджета — нет (день в localStorage)");

  // Перенос и «↩ Отменить».
  await said[0].buttons[0].run();
  check(JSON.stringify(posted[0]) === JSON.stringify(["POST", "/api/weather/move", { eventId: 7 }]), `перенос: ${JSON.stringify(posted[0])}`);
  const moved = said.at(-1);
  check(/«Шиномонтаж» — на завтра, в 18:00\./.test(moved.text) && moved.buttons[0].text === "↩ Отменить", "сказала, куда перенесла, и можно отменить");
  await moved.buttons[0].run();
  check(JSON.stringify(posted[1]) === JSON.stringify(["POST", "/api/weather/move", { eventId: 7, back: true }]), "отмена — back: true");

  // Без опасности — без кнопок; выключено — без фразы; другой день — без погоды.
  ctx.set({ ...STORM, kind: "rain", move: false, pose: "remind", emotion: "sad" });
  check(!wxButtons().length, "дождь — без кнопок");
  delete store["maid.wxSaid"];
  ctx.set({ ...STORM, move: false });
  ctx.cfg.weatherMorning = false;
  check(!wxGreetDue(at(8)), "«Говорить о погоде утром» выключено");
  ctx.cfg.weatherMorning = true;
  ctx.set({ ...STORM, day: "2026-11-20" });
  check(!wxGreetDue(at(8)) && !wxShowing(at(8)), "вчерашняя погода — молчим");

  // Плашка: до полудня / весь день / нет.
  ctx.set(STORM);
  check(wxShowing(at(11, 59)) && !wxShowing(at(12)), "до полудня");
  ctx.cfg.weatherChip = "day";
  check(wxShowing(at(18)), "весь день");
  ctx.cfg.weatherChip = "off";
  check(!wxShowing(at(8)), "нет");
  ctx.set(null);
  check(!wxShowing(at(8)) && !wxGreetDue(at(8)), "нет города — нет погоды");

  // Сцена погоды: какая — по погоде дня (kind), у старых ответов и в витрине — по небу (sky).
  const sceneOf = { clear: "sun", heat: "sun", rain: "rain", snow: "snow", frost: "frost", gray: "gray", fog: "gray" };
  for (const [kind, scene] of Object.entries(sceneOf)) check(wxScene({ kind, sky: "" }) === scene, `kind ${kind} → ${scene}`);
  // Опасная погода (kind storm) — по danger: метель — метель, гроза — дождь, гололёд — иней, ветер — облака (снега летом нет).
  const byDanger = { "метель": "storm", "гроза": "rain", "гололёд": "frost", "сильный ветер": "gray" };
  for (const [danger, scene] of Object.entries(byDanger)) check(wxScene({ kind: "storm", sky: "sun", danger }) === scene, `storm/${danger} → ${scene}`);
  check(wxScene({ kind: "storm", sky: "rain" }) === "rain" && wxScene({ kind: "storm", sky: "storm" }) === "storm" && wxScene({ kind: "storm", sky: "" }) === "gray",
    "storm без danger — по небу, без неба — облака");
  check(wxScene({ kind: "rain", sky: "sun" }) === "rain", "погода дня важнее неба сейчас");
  check(wxScene({ sky: "snow" }) === "snow" && wxScene({ kind: "sun", sky: "sun" }) === "sun", "без kind — по небу (витрина: kind = id сцены)");
  check(wxScene(null) === "" && wxScene({ kind: "??", sky: "" }) === "", "непонятная погода — без сцены");
  const layer = () => stage.children.find((c) => c.id === "wxSky");
  const kids = (cls) => layer().children.filter((c) => c.className === cls).length;
  // Только после фразы: облачко закрыто (фразу не показали) — сцены нет.
  ctx.set(null);
  bubbleHidden = true;
  check(!wxFx({ kind: "snow" }) && !layer(), "фразы не видно — сцены нет");
  bubbleHidden = false;
  // Формы и количество — как в макете.
  const COUNTS = { snow: { fl: 34, cap: 1 }, storm: { dim: 1, st: 70, cap: 1 }, rain: { dr: 46 }, sun: { sun: 1, ray: 4, mote: 8 }, gray: { cl: 3 }, frost: { ice: 9 } };
  for (const [scene, want] of Object.entries(COUNTS)) {
    check(wxFx({ kind: scene === "sun" ? "clear" : scene, sky: scene }), `${scene}: играет`);
    const l = layer();
    check(l && l.className === `wx-sky wx-${scene}` && l.attrs["aria-hidden"] === "true", `${scene}: слой ${l?.className}`);
    const got = Object.fromEntries(Object.keys(want).map((k) => [k, kids(k)]));
    check(JSON.stringify(got) === JSON.stringify(want) && l.children.length === Object.values(want).reduce((a, b) => a + b, 0), `${scene}: ${JSON.stringify(got)} из ${l.children.length}`);
    check(stage.children.filter((c) => c.id === "wxSky").length === 1 && timers.length === 1, `${scene}: один слой и один таймер`);
    check(panel.classList.contains("wx-frost") === (scene === "frost") && panel.classList.contains("wx-shake") === (scene === "storm"), `${scene}: иней/толчок у панели`);
  }
  // Место: над горничной (на 10 px выше макушки), облачком (левее панели) и панелью; панель в слое — --pl/--pt/--pw;
  // путь частиц — высота слоя + 30 px.
  check(layer().style.cssText === "left:288px;top:80px;width:324px;height:672px;--pl:0px;--pt:220px;--pw:324px;--ph:452px;--fh:702px;--fhn:702",
    `место слоя без облачка: ${layer().style.cssText}`);
  bubbleRect = box(148, 110, 270, 120);
  wxFx({ kind: "rain" });
  check(layer().style.cssText === "left:148px;top:80px;width:464px;height:672px;--pl:140px;--pt:220px;--pw:324px;--ph:452px;--fh:702px;--fhn:702",
    `слой и над облачком: ${layer().style.cssText}`);
  // Высокое окно — путь частиц длиннее (дождь и снег не обрываются выше низа панели).
  panel.rect = box(288, 300, 324, 800);
  wxFx({ kind: "snow" });
  check(/;height:1020px;.*--fh:1050px;--fhn:1050$/.test(layer().style.cssText), `высокое окно: ${layer().style.cssText}`);
  panel.rect = box(288, 300, 324, 452);
  // Фраза раскрыла свёрнутый виджет: панель и горничная ещё в анимации (рамки по мини-карточке) — после неё место заново.
  let done;
  panel.anims = [{ finished: new Promise((ok) => { done = ok; }) }];
  panel.rect = box(288, 640, 324, 112);
  maidEl.rect = box(400, 470, 196, 170);
  wxFx({ kind: "snow" });
  check(/--pt:540px;--pw:324px;--ph:112px/.test(layer().style.cssText), `в начале раскрытия — по мини-карточке: ${layer().style.cssText}`);
  panel.rect = box(288, 300, 324, 452);
  maidEl.rect = box(400, 90, 196, 210);
  done();
  await new Promise((ok) => setImmediate(ok));
  check(/^left:148px;top:80px;.*--pt:220px;--pw:324px;--ph:452px/.test(layer().style.cssText), `после раскрытия — по панели: ${layer().style.cssText}`);
  panel.anims = [];
  bubbleRect = null;
  // 30 с — и угасание, потом слоя нет, и ни одного таймера.
  wxFxStop();
  check(!layer() && timers.length === 0 && !panel.classList.contains("wx-frost"), "стоп: слоя и таймеров нет");
  check(ctx.consts.WX_FX_MS === 30000 && ctx.consts.WX_FX_FADE >= 2000 && ctx.consts.WX_FX_FADE <= 3000, "30 с и угасание 2–3 с");
  wxFx({ kind: "frost" });
  advance(29_999);
  check(layer() && !layer().classList.contains("out"), "до 30 с играет");
  advance(1);
  check(layer()?.classList.contains("out") && panel.classList.contains("wx-thaw") && !panel.classList.contains("wx-frost"), "в 30 с — угасает, иней сходит");
  advance(ctx.consts.WX_FX_FADE);
  check(!layer() && timers.length === 0 && !panel.classList.contains("wx-thaw"), "после угасания слоя нет, таймеров нет");
  // Повтор фразы — сцена с начала.
  wxFx({ kind: "rain" });
  advance(20_000);
  wxFx({ kind: "rain" });
  advance(15_000);
  check(layer() && !layer().classList.contains("out") && stage.children.length === 1, "повтор через 20 с — ещё играет через 35 с от первой");
  advance(15_000 + ctx.consts.WX_FX_FADE);
  check(!layer() && timers.length === 0, "и снимается через 30 с от повтора");
  // Тихо, меньше движения, свёрнут, спит, экскурсия — сцены нет.
  ctx.cfg.fx = "quiet";
  check(!wxFx({ kind: "snow" }) && !layer(), "«Эффекты: тихо» — нет");
  ctx.cfg.fx = "normal";
  reduced = true;
  check(!wxFx({ kind: "snow" }) && !layer(), "«Уменьшить движение» — нет");
  reduced = false;
  for (const f of ["collapsed", "napping", "touring"]) {
    ctx[f] = true;
    check(!wxFx({ kind: "snow" }) && !layer(), `${f} — нет`);
    ctx[f] = false;
  }
  check(wxFx({ kind: "snow" }) && layer(), "всё снято — снова играет");
  wxFxStop();
  // Утренняя фраза — со сценой; «Витрина» идёт тем же wxSay.
  delete store["maid.wxSaid"];
  ctx.set({ ...STORM, move: false });
  said.length = 0;
  bubbleHidden = true; // облачко свободно — фраза ляжет в него
  ctx.say = (text, o = {}) => { said.push({ text, ...o }); bubbleHidden = false; };
  check(wxGreet(at(8)) && said.length === 1 && layer()?.className === "wx-sky wx-storm", "утренняя фраза — и сцена метели");
  wxFxStop();
  wxSay({ kind: "sun", sky: "sun", text: "Ясно", pose: "happy", emotion: "happy" });
  check(said.at(-1).mood === "happy" && layer()?.className === "wx-sky wx-sun", "wxSay: фраза и сцена");
  wxFxStop();
  ctx.say = (text, o = {}) => said.push({ text, ...o });
  bubbleHidden = true;
  // Небо больше не висит до полудня: перерисовка панели сцену не запускает.
  check(!/wxSky\(|WX_DROPS/.test(src) && !/wxFx\(/.test(src.slice(src.indexOf("function wxDraw"), src.indexOf("// --- сцена погоды"))), "wxDraw сцену не рисует");
  check((widget.match(/if \(r\.weather\) wxFx\(r\.weather\);/g) ?? []).length === 2, "ответ чата и быстрой записи с признаком погоды — сцена");
  check(/function setCollapsed\(on\) \{\n  collapsed = on;\n  if \(on\) wxFxStop\(\);/.test(widget) && /hideBubble\(\);\n  wxFxStop\(\);/.test(widget), "свернули или уснула — сцена уходит");
  const css = read("desktop/renderer/style.css");
  check(/\.wx-sky \{[^}]*pointer-events: none;/.test(css), "слой не ловит мышь");
  // Над прозрачным окном края слоя гаснут маской (солнце, дождь и снег не режутся прямой линией), по панели — целиком.
  const sky = css.match(/\.wx-sky \{[^}]*\}/)?.[0] ?? "";
  check(/mask-image: linear-gradient\(#000, #000\), linear-gradient\(transparent, #000 40px\), linear-gradient\(90deg, transparent, #000 40px, #000 calc\(100% - 40px\), transparent\)/.test(sky)
    && /mask-position: var\(--pl, 0px\) calc\(var\(--pt, 0px\) - 8px\)/.test(sky) && /mask-composite: add, intersect, subtract, add;/.test(sky) && /mask-repeat: no-repeat;/.test(sky),
    "маска: панель целиком, выше — мягкий верх и бока");
  // Путь частиц — до низа слоя, темп как в макете.
  check(/@keyframes wx-fall \{[^\n]*translate\(var\(--dx, 20px\), var\(--fh, 640px\)\)/.test(css) && /wx-fall calc\(var\(--d, 6s\) \* var\(--fhn, 640\) \/ 640\)/.test(css), "снег — до низа слоя");
  check(/@keyframes wx-blow \{[^\n]*translate\(calc\(var\(--fh, 520px\) \* -\.5\), var\(--fh, 520px\)\)/.test(css) && /wx-blow calc\(var\(--d, 1\.4s\) \* var\(--fhn, 520\) \/ 520\)/.test(css), "метель — до низа слоя");
  check(/@keyframes wx-rain \{[^\n]*var\(--fh, 660px\)\) rotate/.test(css) && /wx-rain calc\(var\(--d, \.8s\) \* var\(--fhn, 660\) \/ 660\)/.test(css), "дождь — до низа слоя");
  check(!/translate\(-260px, 520px\)|translate\(-90px, 660px\)|, 640px\); \} \}/.test(css), "чисел пути из макета больше нет");
  check(/\.wx-sky \.dim \{ left: var\(--pl, 0px\); width: var\(--pw, 100%\);/.test(css) && /\.wx-sky \.cap \{ left: calc\(var\(--pl, 0px\) \+ 6px\); width: calc\(var\(--pw, 100%\) - 12px\);/.test(css),
    "сумрак и шапка снега — по панели, а не по всему слою");
  for (const k of ["wx-fall", "wx-blow", "wx-rain", "wx-glow", "wx-ray", "wx-mote", "wx-cloud", "wx-twinkle", "wx-fade", "wx-shake"]) check(css.includes(`@keyframes ${k} {`), `ключевые кадры ${k}`);
  check(/\.wx-sky\.out \{ animation: wx-fade 2\.5s/.test(css) && ctx.consts.WX_FX_FADE === 2500, "угасание в CSS = WX_FX_FADE");

  // Хуки и настройки.
  check(/if \(!news\.length && wxGreet\(\)\) return;/.test(widget), "подъём: погода вместо «С возвращением»");
  check(/daySleepSync\(data\);[^\n]*\n\s*wxLoad\(\);/.test(widget), "опрос погоды из load()");
  check(/\n  wxDraw\(\);[^\n]*\n\}/.test(widget), "wxDraw в конце render()");
  check(/weatherMorning: w\.weatherMorning !== false, weatherChip: \["day", "off"\]\.includes\(w\.weatherChip\) \? w\.weatherChip : "noon"/.test(widget), "loadCfg");
  check(/weatherMorning: \(v\) => typeof v === "boolean",\n  weatherChip: oneOf\("noon", "day", "off"\),/.test(main), "WIDGET_PREFS");
  check(html.indexOf('src="weather.js"') > 0 && html.indexOf('src="weather.js"') < html.indexOf('src="widget.js"'), "weather.js до widget.js");
  check(/weatherMorning/.test(site) && /weatherChip/.test(site) && /weather_rain/.test(site), "настройки на сайте");
  check(/cfg\.fx === "quiet" \|\| matchMedia\("\(prefers-reduced-motion: reduce\)"\)\.matches/.test(src), "частицы молчат при «тихо» и уменьшенном движении");

  // Быстрая запись: признак погоды из ответа сервера доходит до виджета (maid.reply → widget.js if (r.weather) wxFx).
  {
    const replies = [];
    const el = () => ({ value: "", textContent: "", innerHTML: "", disabled: false, src: "", classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, focus() {}, appendChild() {} });
    const els = {};
    const q = { $: (k) => (els[k] ??= el()), document: { addEventListener() {} }, setTimeout: () => 0, crypto: { randomUUID: () => "u1" },
      tgHtml: (x) => x, draftMarksShow: () => true, draftNow: () => new Date(), shrinkImage: async () => null, imageFrom: () => null,
      maid: { on() {}, api: async () => ({ text: "🌧 Дождь с обеда", emotion: "sad", messageId: 5, undoable: false, weather: { kind: "storm", sky: "rain", danger: "гроза" } }),
        reply: (r) => replies.push(r), thinking() {}, changed() {}, hideQuick() {} } };
    vm.createContext(q);
    vm.runInContext(read("desktop/renderer/quick.js"), q);
    q.$("#t").value = "какая погода?";
    await q.$("#f").onsubmit({ preventDefault() {} });
    check(JSON.stringify(replies[0]?.weather) === JSON.stringify({ kind: "storm", sky: "rain", danger: "гроза" }) && replies[0].heard === "какая погода?",
      `быстрая запись: признак погоды в reply: ${JSON.stringify(replies[0])}`);
  }

  console.log(bad ? `${bad} из ${n} не прошли` : `OK: ${n} проверок погоды в виджете`);
  process.exit(bad ? 1 : 0);
})();
