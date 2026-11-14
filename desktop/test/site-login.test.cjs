// Один вход на программу (main.js: site-login:get / site-login:keep) — без Electron: сайт в главном окне получает ключ программы;
// вошли на сайте — это ключ программы; вышли на сайте — программа тоже выходит (виджет покажет форму); чужие окна — отказ.
const fs = require("fs");
const src = fs.readFileSync(process.argv[2] ?? require("path").join(__dirname, "../src/main.js"), "utf8");
const cut = (from, to) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));
const code = cut('ipcMain.on("site-login:get"', "const oneOf");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const handlers = {}, log = [];
const app = { id: "app" }, stranger = { id: "widget" };
const st = { saved: 0, changed: 0 };
const settings = { server: "https://maid.example", token: "tok-prog" };
const box = new Function(
  "ipcMain", "fromApp", "token", "settings", "maidLog", "saveSettings", "refreshTray", "broadcast",
  "let loginStale = false, tokenEnc = '';" + code + "; return { get stale() { return loginStale; }, setEnc(v) { tokenEnc = v; } };",
)(
  { on: (name, fn) => (handlers[name] = fn) }, (e) => e.sender === app, () => settings.token, settings,
  (...a) => log.push(a.join(" ")), () => st.saved++, () => {}, (ch) => ch === "changed" && st.changed++,
);
const get = (sender) => { const e = { sender }; handlers["site-login:get"](e); return e.returnValue; };
const keep = (sender, t) => handlers["site-login:keep"]({ sender }, t);

try {
  check(get(app) === "tok-prog", "главное окно не получило ключ программы");
  check(get(stranger) === "" && log.some((l) => l.includes("просьба не из главного окна")), "чужое окно получило ключ");
  keep(app, "tok-prog");
  check(st.saved === 0, "тот же ключ пересохранён");
  keep(app, "tok-site");
  check(settings.token === "tok-site" && st.saved === 1 && st.changed === 1, "вход на сайте не стал ключом программы");
  check(log.some((l) => l.includes("вошли на сайте")), "вход на сайте: нет записи в журнале");
  keep(stranger, "");
  check(settings.token === "tok-site", "чужое окно смогло выйти из программы");
  keep(app, "x".repeat(5000));
  check(settings.token === "tok-site", "слишком длинный ключ принят");
  keep(app, "");
  check(settings.token === "" && box.stale && st.changed === 2, "выход на сайте: программа не вышла или виджет не узнал");
  check(log.some((l) => l.includes("вышли на сайте — программа тоже вышла")), "выход: нет записи в журнале");
  keep(app, "");
  check(st.saved === 2, "повторный выход пересохранил настройки");
  keep(app, "tok-again");
  check(settings.token === "tok-again" && !box.stale, "повторный вход на сайте не вернул программу");
} catch (e) {
  check(false, `тест оборвался: ${e?.stack ?? e}`);
}
console.log(`${n - bad}/${n}`);
process.exit(bad ? 1 : 0);
