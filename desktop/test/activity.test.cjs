// Свой трекер ПК (activity.js: createTracker, foreground) — без Electron, с подменой времени, простоя и окна:
// время программ — пока человек за ПК; простой до 3 мин — программе, дольше и замок экрана — «отошёл»; сон ПК не считается;
// полночь — новый день, старый записан; перезапуск продолжает день из файла; игры по списку; файлы старше 7 дней удаляются.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createTracker, foreground, localDay } = require("../src/activity.js");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maid-act-"));
const st = { t: new Date(2026, 10, 14, 10, 0, 0).getTime(), idle: 0, locked: false, app: { name: "chrome", path: "C:\chrome.exe" } };
const make = () => createTracker({ dir, now: () => st.t, idle: () => ({ sec: st.idle, locked: st.locked }), fg: () => st.app });
// n замеров по 5 с; idleGrows — простой растёт вместе со временем
const run = (tr, steps, { idleGrows = false } = {}) => { for (let i = 0; i < steps; i++) { st.t += 5000; if (idleGrows) st.idle += 5; tr.tick(); } };
const sec = (sum, name) => [...sum.apps, ...sum.games].find((x) => x.name === name)?.sec ?? 0;
const day = () => localDay(new Date(st.t));

try {
  const old = path.join(dir, "2026-11-01.json");
  fs.writeFileSync(old, "{}");
  let tr = make();
  tr.tick(); // первый замер — точка отсчёта
  check(!fs.existsSync(old), "день старше 7 дней не удалён");
  run(tr, 24); // 2 мин в chrome
  check(sec(tr.summary(day()), "chrome") === 120, `chrome: ${sec(tr.summary(day()), "chrome")} вместо 120`);

  // Читает 2 минуты, не трогая мышь (простой < 3 мин), потом шевельнул — время chrome.
  st.idle = 0;
  run(tr, 24, { idleGrows: true });
  st.idle = 0;
  run(tr, 1);
  check(sec(tr.summary(day()), "chrome") === 245, `читал 2 мин: chrome ${sec(tr.summary(day()), "chrome")} вместо 245`);

  // Ушёл на 10 минут: с 10-й секунды простоя всё — «отошёл» (первые 5 с — ещё chrome), вернулся — снова chrome.
  st.idle = 0;
  run(tr, 120, { idleGrows: true });
  st.idle = 0;
  run(tr, 1);
  let s = tr.summary(day());
  check(sec(s, "chrome") === 255, `ушёл: chrome ${sec(s, "chrome")} вместо 255`);
  check(s.afk_sec === 595, `ушёл: afk ${s.afk_sec} вместо 595`);

  // Замок экрана — «отошёл», даже если мышь только что трогали.
  st.locked = true;
  run(tr, 12);
  st.locked = false;
  check(tr.summary(day()).afk_sec === 655, "замок экрана не стал «отошёл»");

  // Сон ПК: следующий замер через 2 часа — промежуток не считается.
  st.t += 2 * 3600_000;
  tr.tick();
  s = tr.summary(day());
  check(sec(s, "chrome") === 255 && s.afk_sec === 655, "сон ПК посчитан");

  // Игра по списку, значок — путь к exe.
  st.app = { name: "dota2", path: "D:\dota2.exe" };
  run(tr, 24);
  s = tr.summary(day(), ["dota2.exe"]);
  check(s.games.length === 1 && s.games[0].name === "dota2" && s.games[0].sec === 120 && !s.apps.some((x) => x.name === "dota2"), "игра не в играх");
  check(tr.paths(day()).get("dota2") === "D:\dota2.exe", "путь к exe игры не запомнен");
  check(s.active_sec === 375, `active_sec ${s.active_sec} вместо 375`);

  // Меньше минуты — не идёт; окна нет — «?».
  st.app = { name: "notepad", path: "" };
  run(tr, 6);
  check(sec(tr.summary(day()), "notepad") === 0, "программа меньше минуты попала в итог");

  // Перезапуск программы: день продолжается из файла.
  tr.save();
  const before = tr.summary(day(), ["dota2.exe"]);
  tr = make();
  tr.tick();
  run(tr, 12);
  check(sec(tr.summary(day()), "notepad") === 90 && sec(tr.summary(day()), "chrome") === 255, "после перезапуска день не продолжился из файла");
  check(JSON.stringify(before.games) === JSON.stringify(tr.summary(day(), ["dota2.exe"]).games), "после перезапуска игры потерялись");

  // Полночь: старый день записан и читается, новый — с нуля.
  const yesterday = day();
  st.t = new Date(2026, 10, 15, 0, 0, 2).getTime() - 5000;
  tr.tick();
  st.app = { name: "chrome", path: "C:\chrome.exe" };
  run(tr, 15);
  check(sec(tr.summary(day()), "chrome") === 75, `новый день: chrome ${sec(tr.summary(day()), "chrome")} вместо 75`);
  check(sec(tr.summary(yesterday), "chrome") === 255, "вчерашний день после полуночи не читается");

  // Окно не узнать (ошибка) — время идёт в «?», трекер не падает.
  const tr2 = createTracker({ dir, now: () => st.t, idle: () => ({ sec: 0, locked: false }), fg: () => { throw new Error("нет"); } });
  tr2.tick();
  st.t += 5000 * 13;
  tr2.tick();
  check(true, "ошибка окна уронила трекер");

  // Настоящий Windows: программа на переднем плане читается без исключения.
  if (process.platform === "win32") {
    const f = foreground();
    check(f === null || (typeof f.name === "string" && f.name.length > 0), `foreground: ${JSON.stringify(f)}`);
  }
} catch (e) {
  check(false, `тест оборвался: ${e?.stack ?? e}`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`${n - bad}/${n}`);
process.exit(bad ? 1 : 0);
