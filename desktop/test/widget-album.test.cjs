// Альбом реакций, слова-пасхалки и «погладить» (album.js, widget.js) без Electron и браузера.
// 16.11.2026: 27 анимаций включались по событиям, но узнать о редких («стирает память», «смущённо рада») можно было
// только случайно. Теперь впервые показанная анимация уходит на сервер (/api/album), сайт рисует альбом.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const dir = path.join(__dirname, "..", "renderer");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
const widget = read("widget.js"), album = read("album.js"), html = read("widget.html"), lines = read("lines.js");

// Скрипт подключён до widget.js: showMood зовёт albumSee при первой же анимации.
check(html.indexOf('src="album.js"') > 0 && html.indexOf('src="album.js"') < html.indexOf('src="widget.js"'), "album.js не подключён до widget.js");
check(/function showMood\(n\) \{\s*if \(!MOODS\.includes\(n\)\) return;\s*albumSee\(n\);/.test(widget), "showMood не отмечает анимацию в альбоме (или отмечает после выхода для forget)");

// Список анимаций виджета совпадает с альбомом сервера.
const moods = eval(widget.match(/const MOODS = (\[[^\]]+\])/)[1]);
const server = fs.readFileSync(path.join(__dirname, "..", "..", "server", "src", "album.ts"), "utf8");
const serverMoods = eval(server.match(/export const ALBUM = (\[[^\]]+\])/)[1]);
check(moods.length === 27 && [...moods].sort().join() === [...serverMoods].sort().join(), "MOODS виджета и ALBUM сервера разошлись");

// albumSee / albumFlush: одно имя — один раз, несколько подряд — одним запросом, сбой — повтор, после успеха не шлёт снова.
const calls = [];
let fail = true;
const timers = [];
const store = {};
const ctx = vm.createContext({
  localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } },
  maid: { api: async (m, p, b) => { calls.push([m, p, b]); if (fail) throw new Error("нет связи"); return {}; } },
  setTimeout: (f, ms) => { timers.push([f, ms]); return timers.length; }, clearTimeout: () => {},
  Date, JSON, Set, Error,
});
vm.runInContext(album + "\n;globalThis.t = { albumSee, albumFlush };", ctx);
(async () => {
  ctx.t.albumSee("tea"); ctx.t.albumSee("tea"); ctx.t.albumSee("happy");
  check(calls.length === 0 && timers.at(-1)[1] === 3000, "альбом шлёт запрос сразу, а не пачкой через 3 с");
  await ctx.t.albumFlush();
  check(calls.length === 1 && calls[0][1] === "/api/album" && calls[0][2].moods.join() === "tea,happy", "первый запрос не «tea, happy» одним вызовом");
  check(timers.at(-1)[1] === 60_000, "после сбоя нет повтора через минуту");
  fail = false;
  await ctx.t.albumFlush();
  check(calls.length === 2 && JSON.parse(store["maid.album"]).tea === 1, "после успеха отправленное не запомнено");
  ctx.t.albumSee("tea"); await ctx.t.albumFlush();
  check(calls.length === 2, "уже открытая анимация отправляется повторно");

  // Слова-пасхалки: своя анимация, но не поверх записи; старые правила сильнее.
  const src = widget.match(/const LEWD = [^\n]+/)[0] + "\n" + widget.match(/const UNSAY = [^\n]+/)[0] + "\n" + widget.match(/const EGG_PRAISE[\s\S]*?\nfunction heardMood[\s\S]*?\n\}/)[0];
  const heard = vm.runInNewContext(src + "\n;heardMood");
  const none = { changes: [] };
  for (const [text, want] of [["чай?", "tea"], ["Может, чаю?", "tea"], ["попьём чаю", "tea"], ["спокойной ночи", "sleep"], ["Доброй ночи!", "sleep"],
    ["ты молодец", "smitten"], ["Вы умница", "smitten"], ["спасибо", "smitten"], ["купить чай", null], ["случай?", null], ["забудь", "forget"]]) {
    check(heard(text, none) === want, `«${text}» → ${heard(text, none)}, ждали ${want}`);
  }
  check(heard("чай?", { changes: [{ kind: "task" }] }) === null, "пасхалка перебивает реакцию на запись");

  // Погладить: зажатие на горничной, перетаскивание и щелчок после него — не считаются.
  check(/petTimer = setTimeout\(\(\) => \{ if \(!dragMoved\) pet\(\); \}, PET_HOLD\)/.test(widget), "зажатие на горничной не гладит (или гладит при перетаскивании)");
  check(/if \(Date\.now\(\) - pettedAt < 400\) return;/.test(widget), "щелчок после «погладить» считается тычком");
  check(/sulkUntil = 0;\s*quip\(line\("forgive"\)/.test(album), "погладить обиженную — не прощает");
  check(/\n  pet: \[/.test(lines) && (lines.match(/\n  pet: \[([\s\S]*?)\],\n/)[1].match(/\{ t:/g) ?? []).length >= 6, "мало реплик на «погладить»");

  console.log(`${n - bad}/${n}`);
  process.exit(bad ? 1 : 0);
})();
