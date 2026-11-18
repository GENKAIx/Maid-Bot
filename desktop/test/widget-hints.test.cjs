// Подсказки над строкой чата виджета (renderer/hints.js): какие фразы выбираются — без Electron и браузера.
// 18.11.2026: чтобы спросить «что посмотреть?», надо было знать, что так можно. Теперь щелчок в пустую строку показывает
// несколько готовых фраз: вопросы уходят сразу, заготовки встают в строку.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const dir = path.join(__dirname, "..", "renderer");
const src = fs.readFileSync(path.join(dir, "hints.js"), "utf8");
const html = fs.readFileSync(path.join(dir, "widget.html"), "utf8");
const css = fs.readFileSync(path.join(dir, "style.css"), "utf8");
const widget = fs.readFileSync(path.join(dir, "widget.js"), "utf8");

// Выбор фраз — до раздела «показ» (дальше — DOM).
const ctx = {};
vm.createContext(ctx);
try {
  vm.runInContext(src.slice(0, src.indexOf("// --- показ ---")) + "\nthis.HINTS = HINTS; this.pickHints = pickHints;", ctx);
  const { HINTS, pickHints } = ctx;
  const none = { film: 0, series: 0, game: 0, book: 0, idea: 0, other: 0 };
  const at = (hour, more = {}) => ({ hour, weekend: false, night: false, tasks: 2, notes: none, ...more });
  const ids = (c, seen = {}, k = 4) => [...pickHints(c, seen, k, () => 0.5)].map((h) => h.id);
  const fits = (c) => HINTS.filter((h) => h.fit(c) > 0).map((h) => h.id);

  check(new Set(HINTS.map((h) => h.id)).size === HINTS.length, "повтор id у подсказок");
  for (const h of HINTS) {
    check(Boolean(h.send) !== Boolean(h.fill), `${h.id}: либо вопрос (send), либо заготовка (fill)`);
    check(h.text.length <= 28, `${h.id}: фраза длиннее 28 знаков — не влезет в плашку`);
    if (h.fill) check(h.fill.endsWith(" "), `${h.id}: заготовка должна кончаться пробелом — дальше пишет человек`);
    if (h.send) check(h.text.endsWith("?"), `${h.id}: сразу отправляются только вопросы`);
  }

  // Полки пусты — «Что посмотреть?» не предлагается, вместо него заготовка «Фильм …» (самое время научить).
  const evening = at(20);
  check(!fits(evening).includes("watch") && !fits(evening).includes("play") && !fits(evening).includes("read"), "пустые полки, а вопрос про них предлагается");
  check(ids(evening).slice(0, 2).every((id) => ["film", "game", "tomorrow"].includes(id)), `вечер без заметок: первыми ${ids(evening)}`);
  // Есть фильмы и игры — вечером вопросы про них первыми.
  const stocked = at(20, { notes: { ...none, film: 3, game: 1 } });
  check(JSON.stringify(ids(stocked).slice(0, 2).sort()) === JSON.stringify(["play", "watch"]) || ids(stocked).slice(0, 2).includes("watch"), `вечер с заметками: первыми ${ids(stocked)}`);
  check(fits(stocked).includes("watch") && fits(stocked).includes("play") && !fits(stocked).includes("read"), "книг нет, а «что почитать?» есть");
  // Днём в будни «что посмотреть?» можно, но не «самое время».
  check(HINTS.find((h) => h.id === "watch").fit(at(14, { notes: { ...none, film: 1 } })) === 1, "днём в будни «что посмотреть?» не должно быть первым");
  check(HINTS.find((h) => h.id === "watch").fit(at(14, { weekend: true, notes: { ...none, series: 1 } })) === 2, "в выходной «что посмотреть?» — самое время");
  // После отбоя кино и игры не предлагаются.
  const night = at(2, { night: true, notes: { ...none, film: 3, game: 2 } });
  check(!fits(night).includes("watch") && !fits(night).includes("play"), "после отбоя предлагает кино или игры");
  // Утро: сон и «что сегодня»; вечером — нет.
  check(fits(at(9)).includes("slept") && fits(at(9)).includes("today"), "утром нет подсказок про сон и сегодня");
  check(!fits(evening).includes("slept") && !fits(evening).includes("today"), "вечером подсказки про утро");
  check(!fits(at(14, { tasks: 0 })).includes("done"), "задач нет, а «Сделал …» предлагается");

  // Не больше запрошенного и без повторов; «самое время» — не больше двух.
  const four = pickHints(stocked, {}, 4, Math.random);
  check(four.length === 4 && new Set(four.map((h) => h.id)).size === 4, "набор не из четырёх разных фраз");
  check(pickHints(at(9, { weekend: true, notes: { ...none, film: 1, game: 1, book: 1 } }), {}, 4, Math.random).filter((h, i) => i >= 2).length === 2, "после двух «самое время» должны идти обычные");
  // Показанное реже — вперёд: за несколько показов видны все подходящие фразы.
  const seen = {};
  const all = new Set();
  for (let i = 0; i < 8; i++) for (const h of pickHints(at(14), seen, 4, Math.random)) { all.add(h.id); seen[h.id] = (seen[h.id] ?? 0) + 1; }
  const want = fits(at(14));
  check(want.every((id) => all.has(id)), `за 8 показов не увидели: ${want.filter((id) => !all.has(id))}`);
} catch (e) {
  check(false, `оборвалось: ${e?.stack ?? e}`);
}

// Подключение: блок над строкой, скрипт после widget.js, показ только у пустой строки в фокусе.
check(/<div class="hints hidden" id="chatHints"/.test(html), "в widget.html нет блока подсказок");
check(html.indexOf('src="hints.js"') > html.indexOf('src="widget.js"'), "hints.js должен грузиться после widget.js");
check(/document\.activeElement === chatInput && !chatInput\.value && !pictures\.length && !Voice\.on/.test(src), "подсказки показываются не только у пустой строки в фокусе");
check(/\$\("#chatHist"\)\.classList\.contains\("hidden"\) && !collapsed/.test(src), "подсказки поверх истории или в свёрнутом виде");
check(/addEventListener\("mousedown", \(e\) => \{ if \(e\.target\.closest\("\.hint"\)\) e\.preventDefault\(\); \}\)/.test(src), "щелчок по подсказке уводит фокус из строки");
check(/if \(h\.send\) enqueue\("\/api\/input", \{ text: h\.text, id: crypto\.randomUUID\(\) \}, h\.text\);/.test(src), "вопрос не уходит той же очередью, что сообщение из строки");
check(/if \(b\.offsetTop - box\.offsetTop >= HINT_ROWS_PX\) b\.remove\(\);/.test(src) && /const HINT_ROWS_PX = 58;/.test(src), "не влезшее в два ряда считается показанным");
check(/if \(typeof syncHints === "function"\) syncHints\(\);/.test(widget), "syncSend не убирает подсказки при записи голоса и картинках");
check(/\.chat \.hints\.hidden, \.recording > \.hints \{ display: none; \}/.test(css) && /\.chat \.hints \{[^}]*max-height: 58px/.test(css), "нет стилей подсказок (скрытие, не больше двух рядов)");
console.log(bad ? `${bad} из ${n} не прошло` : `ok ${n}`);
process.exit(bad ? 1 : 0);
