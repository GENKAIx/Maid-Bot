// Проверка возврата виджета (main.js: reviveWidget, watchWidget) подменными событиями — без Electron:
// сбой видеочасти, сон и пробуждение ПК, смена экранов. Всё записано в журнал, окно — на экране и наверху.
const fs = require("fs");
const { EventEmitter } = require("events");
const src = fs.readFileSync(process.argv[2] ?? require("path").join(__dirname, "../src/main.js"), "utf8");
const cut = (from, to) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));
const code = [cut("/** Окно есть, но не видно", "function toggleWidget")].join("\n");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };

const app = new EventEmitter(), powerMonitor = new EventEmitter(), screen = new EventEmitter();
const area = { x: 0, y: 0, width: 1920, height: 1040 };
screen.getAllDisplays = () => [{ workArea: area }];
const log = [], calls = [];
let bounds = { x: 1500, y: 300, width: 420, height: 760 };
const widget = {
  isDestroyed: () => false, isMinimized: () => false, restore: () => calls.push("restore"),
  getBounds: () => bounds, setBounds: (b) => { bounds = b; calls.push("setBounds"); },
  showInactive: () => calls.push("show"), setAlwaysOnTop: (on, lvl) => calls.push(`top:${on}:${lvl}`),
  moveTop: () => calls.push("moveTop"), reload: () => calls.push("reload"),
};
const timers = [];
const api = new Function("app", "powerMonitor", "screen", "widget", "maidLog", "widgetBounds", "setTimeout",
  code + "; return { reviveWidget, watchWidget };");
const A = api(app, powerMonitor, screen, widget, (...a) => log.push(a.join(" ")), () => ({ x: 1490, y: 280, width: 420, height: 760 }), (f) => timers.push(f));
A.watchWidget();
const reset = () => { log.length = 0; calls.length = 0; };

// Видеочасть упала — страница виджета загружается заново; упал другой процесс — только запись.
reset();
app.emit("child-process-gone", {}, { type: "GPU", reason: "crashed", exitCode: -1 });
check(calls.includes("reload"), "сбой видеочасти: страница не перезагружена");
check(log.some((l) => l.includes("GPU crashed")), "сбой видеочасти: нет записи в журнале");
reset();
app.emit("child-process-gone", {}, { type: "Utility", reason: "crashed", exitCode: 1 });
check(!calls.includes("reload") && log.length === 1, "сбой другого процесса: лишняя перезагрузка или нет записи");
reset();
app.emit("child-process-gone", {}, { type: "GPU", reason: "clean-exit", exitCode: 0 });
check(!calls.includes("reload"), "видеочасть закрылась штатно — перезагружать не надо");

// Сон и пробуждение: записи; окно возвращается чуть погодя (после подключения экранов), наверх.
reset();
powerMonitor.emit("suspend");
powerMonitor.emit("resume");
check(log.includes("сон ПК") && log.includes("пробуждение ПК"), "сон/пробуждение: нет записей");
check(!calls.includes("show") && timers.length === 1, "пробуждение: окно надо вернуть отложенно");
timers.shift()();
check(calls.includes("show") && calls.includes("top:true:screen-saver") && calls.includes("moveTop"), "пробуждение: окно не поднято наверх");
check(!calls.includes("setBounds"), "пробуждение: окно на экране — двигать не надо");

// Экран изменился, а окно оказалось за краем — вернуть на место и записать.
reset();
bounds = { x: 4000, y: 300, width: 420, height: 760 };
screen.emit("display-metrics-changed", {}, {}, ["bounds", "workArea"]);
check(log.some((l) => l.includes("экран изменился: bounds,workArea")), "смена экрана: нет записи");
check(calls.includes("setBounds") && bounds.x === 1490, "смена экрана: окно за краем не вернулось");
check(log.some((l) => l.includes("виджет за экраном")), "смена экрана: нет записи о возврате");

// Экран подключён и отключён — записи, окно на месте.
reset();
screen.emit("display-added");
screen.emit("display-removed");
check(log.includes("экран подключён") && log.includes("экран отключён"), "подключение/отключение экрана: нет записей");
check(calls.includes("moveTop") && calls.includes("setBounds"), "подключение/отключение экрана: окно не поправлено");

console.log(`${n - bad}/${n}`);
process.exit(bad ? 1 : 0);
