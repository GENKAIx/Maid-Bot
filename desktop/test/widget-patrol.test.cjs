// Сторож виджета (main.js: widgetTrouble, patrolWidget; widget.js: maid.alive) без Electron.
// 17.11.2026: виджет иногда пропадал «сам», а в журнале — ничего: ни сбоя, ни сна, ни смены экрана. Теперь раз в 15 с сторож
// смотрит, что окно видно, не свёрнуто, на экране, поверх окон, а страница жива (виджет отзывается раз в 20 с) и фигурка
// нарисована. Что-то не так — запись в журнал один раз (с программой на переднем плане) и окно обратно; страница молчит
// дольше 3 минут — перезагрузка. В журнале теперь видно, отчего пропал виджет.
// 17.11.2026, второй случай: окно видно и поверх всех, а страница считала себя скрытой (document.hidden — Chromium решил, что
// прозрачное окно перекрыто) и не рисовалась. Подсчёт перекрытия выключен (CalculateNativeWinOcclusion), виджет не притормаживает
// в фоне (backgroundThrottling), а страница сообщает сторожу, что считает себя скрытой, — сразу (visibilitychange) и раз в 20 с;
// сторож показывает окно заново (так виджет и вернулся).
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const root = path.join(__dirname, "..");
const main = fs.readFileSync(path.join(root, "src", "main.js"), "utf8");
const preload = fs.readFileSync(path.join(root, "src", "preload.js"), "utf8");
const widgetJs = fs.readFileSync(path.join(root, "renderer", "widget.js"), "utf8");
const fn = (name) => main.match(new RegExp(`\\nfunction ${name}\\([^]*?\\n\\}\\r?\\n`))?.[0] ?? "";
for (const f of ["widgetTrouble", "patrolWidget"]) check(fn(f), `в main.js нет ${f}`);

const displays = [{ workArea: { x: 0, y: 0, width: 2560, height: 1400 } }];
const ok = { visible: true, minimized: false, top: true, bounds: { x: 1600, y: 200, width: 620, height: 1080 }, silent: 20_000, drawn: true };
const log = [], calls = [];
let state = { ...ok };
const ctx = {
  settings: { widget: { show: true } },
  widget: {
    isDestroyed: () => false, isVisible: () => state.visible, isMinimized: () => state.minimized, isAlwaysOnTop: () => state.top,
    getBounds: () => state.bounds, reload: () => calls.push("reload"),
  },
  screen: { getAllDisplays: () => displays },
  maidLog: (...a) => log.push(a.filter(Boolean).join(" ")),
  reviveWidget: (why) => calls.push(`revive:${why}`),
  foreground: () => ({ name: "FortniteClient-Win64-Shipping" }),
  Date: { now: () => 1_000_000 },
  widgetAlive: 1_000_000 - 20_000,
  widgetDrawn: true,
  widgetHidden: false,
  widgetIssue: "",
};
vm.createContext(ctx);
try {
  vm.runInContext(`${fn("widgetTrouble")}\n${fn("patrolWidget")}\nthis.trouble = widgetTrouble; this.patrol = patrolWidget;`, ctx);
  check(ctx.trouble(ok, displays).length === 0, "всё хорошо, а сторож видит беду");
  check(ctx.trouble({ ...ok, visible: false }, displays).includes("окно спрятано"), "спрятанное окно не замечено");
  check(ctx.trouble({ ...ok, minimized: true }, displays).includes("окно свёрнуто"), "свёрнутое окно не замечено");
  check(ctx.trouble({ ...ok, bounds: { x: 6000, y: 0, width: 620, height: 1080 } }, displays).includes("окно за экраном"), "окно за экраном не замечено");
  check(ctx.trouble({ ...ok, top: false }, displays).includes("не поверх окон"), "окно не поверх — не замечено");
  check(ctx.trouble({ ...ok, silent: 200_000 }, displays).includes("страница молчит"), "молчащая страница не замечена");
  check(ctx.trouble({ ...ok, silent: 120_000 }, displays).length === 0, "окно под игрой (таймеры реже) — уже «молчит»");
  check(ctx.trouble({ ...ok, drawn: false }, displays).includes("фигурка не нарисована"), "пустое окно без фигурки не замечено");
  check(ctx.trouble({ ...ok, pageHidden: true }, displays).includes("страница считает себя скрытой"), "окно видно, а страница скрыта — не замечено");
  check(!ctx.trouble({ ...ok, visible: false, pageHidden: true }, displays).includes("страница считает себя скрытой"), "окно спрятано — скрытая страница не отдельная беда");

  const reset = () => { log.length = 0; calls.length = 0; };
  // Всё хорошо — тишина.
  ctx.patrol();
  check(!log.length && !calls.length, "всё хорошо — а запись или возврат");
  // Окно спряталось — запись с программой впереди, окно обратно; повтор той же беды — без новой записи.
  state = { ...ok, visible: false };
  ctx.patrol();
  check(log.length === 1 && /окно спрятано/.test(log[0]) && /Fortnite/.test(log[0]), `нет записи о пропаже: ${log}`);
  check(calls.includes("revive:сторож"), "спрятанное окно не возвращено");
  reset();
  ctx.patrol();
  check(!log.length && calls.includes("revive:сторож"), "та же беда — запись повторилась или окно не возвращается");
  // Вернулось — запись, что снова видно.
  reset();
  state = { ...ok };
  ctx.patrol();
  check(log.length === 1 && /снова/.test(log[0]), `нет записи, что виджет вернулся: ${log}`);
  // Страница молчит — перезагрузка.
  reset();
  ctx.widgetAlive = 1_000_000 - 200_000;
  ctx.patrol();
  check(calls.includes("reload") && /страница молчит/.test(log[0] ?? ""), "молчащая страница не перезагружена");
  check(ctx.widgetAlive === 1_000_000, "после перезагрузки сторож ждёт отклика заново");
  // Фигурка не нарисована — только запись (окно на месте — двигать нечего).
  reset();
  ctx.widgetIssue = "";
  ctx.widgetDrawn = false;
  ctx.patrol();
  check(/фигурка не нарисована/.test(log[0] ?? "") && !calls.length, "фигурка не нарисована: нет записи или лишнее действие");
  // Страница считает себя скрытой при видимом окне — запись и окно показывается заново.
  reset();
  ctx.widgetIssue = "";
  ctx.widgetDrawn = true;
  ctx.widgetHidden = true;
  ctx.patrol();
  check(/страница считает себя скрытой/.test(log[0] ?? "") && calls.includes("revive:сторож"), `скрытая страница: нет записи или окно не показано: ${log} ${calls}`);
  ctx.widgetHidden = false;
  // Виджет выключен в меню — сторож молчит.
  reset();
  ctx.widgetIssue = "";
  ctx.settings.widget.show = false;
  state = { ...ok, visible: false };
  ctx.patrol();
  check(!log.length && !calls.length, "виджет выключен — а сторож его возвращает");
} catch (e) {
  check(false, `тест оборвался: ${e?.stack ?? e}`);
}
check(/setInterval\(patrolWidget, 15_000\)/.test(main), "сторож не запускается");
check(/ipcMain\.on\("alive"/.test(main), "main не слушает отклик виджета");
check(/alive: \(drawn, hidden\) => ipcRenderer\.send\("alive", drawn, hidden\)/.test(preload), "виджет не может отозваться (preload)");
check(/maid\.alive\(/.test(widgetJs) && /document\.hidden/.test(widgetJs), "виджет не отзывается или не говорит, что скрыт");
check(/addEventListener\("visibilitychange"/.test(widgetJs), "виджет не сообщает сразу, что его скрыли");
check(/appendSwitch\("disable-features", "CalculateNativeWinOcclusion"\)/.test(main), "подсчёт перекрытия окон не выключен");
check(/backgroundThrottling: false/.test(main.match(/widget = new BrowserWindow\(\{[^]*?\}\);/)?.[0] ?? ""), "виджет притормаживает в фоне");
console.log(`${n - bad}/${n}`);
process.exit(bad ? 1 : 0);
