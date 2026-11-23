// Погода утром в виджете (21.11.2026; desktop/renderer/weather.js): первая фраза дня после подъёма — одна в день, плашка в шапке
// до полудня (или весь день, или нет), кнопки «Перенести на завтра» / «Оставить» только в опасную погоду, перенос и «↩ Отменить»
// идут в /api/weather/move; хуки в widget.js (подъём, опрос, перерисовка), настройки в main.js и на сайте.
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
let bubbleHidden = true;
const ctx = {
  localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } },
  document: { addEventListener: () => {}, querySelectorAll: () => [] },
  $: (q) => (q === "#bubble" ? { classList: { contains: () => bubbleHidden } } : null),
  say: (text, o = {}) => said.push({ text, ...o }), react: (m) => reacted.push(m), play: () => {}, errText: (e) => String(e.message),
  load: () => {}, maid: { api: async (m, p, b) => { posted.push([m, p, b]); return {}; }, changed: () => {} },
  MOODS: ["happy", "worried", "remind", "tea", "excited", "thumbsup", "done"],
  daySleep: { wakeMin: 7 * 60 }, cfg: { weatherMorning: true, weatherChip: "noon", fx: "normal" }, data: { day: "2026-11-21" }, napping: false,
};
vm.createContext(ctx);
vm.runInContext(`${src}\nthis.set = (w) => { wxNow = w; wxSaidDay = ""; }; this.fns = { wxGreetDue, wxGreet, wxShowing, wxButtons };`, ctx);
const { wxGreetDue, wxGreet, wxShowing, wxButtons } = ctx.fns;

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

  // Хуки и настройки.
  check(/if \(!news\.length && wxGreet\(\)\) return;/.test(widget), "подъём: погода вместо «С возвращением»");
  check(/daySleepSync\(data\);[^\n]*\n\s*wxLoad\(\);/.test(widget), "опрос погоды из load()");
  check(/\n  wxDraw\(\);[^\n]*\n\}/.test(widget), "wxDraw в конце render()");
  check(/weatherMorning: w\.weatherMorning !== false, weatherChip: \["day", "off"\]\.includes\(w\.weatherChip\) \? w\.weatherChip : "noon"/.test(widget), "loadCfg");
  check(/weatherMorning: \(v\) => typeof v === "boolean",\n  weatherChip: oneOf\("noon", "day", "off"\),/.test(main), "WIDGET_PREFS");
  check(html.indexOf('src="weather.js"') > 0 && html.indexOf('src="weather.js"') < html.indexOf('src="widget.js"'), "weather.js до widget.js");
  check(/weatherMorning/.test(site) && /weatherChip/.test(site) && /weather_rain/.test(site), "настройки на сайте");
  check(/cfg\.fx === "quiet" \|\| matchMedia\("\(prefers-reduced-motion: reduce\)"\)\.matches/.test(src), "частицы молчат при «тихо» и уменьшенном движении");

  console.log(bad ? `${bad} из ${n} не прошли` : `OK: ${n} проверок погоды в виджете`);
  process.exit(bad ? 1 : 0);
})();
