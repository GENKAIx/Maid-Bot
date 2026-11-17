// Проверка обновления после сбоя (updates.js) на поддельном electron-updater и поддельных таймерах, без Electron.
// 17.11.2026: проверка совпала с пробуждением ПК (net::ERR_NETWORK_IO_SUSPENDED) и упала — следующая была только через 6 часов,
// значок «вышла новая версия» не появлялся. Теперь после ошибки проверка повторяется через 15 минут, а после пробуждения
// ПК (main.js, powerMonitor resume) — через минуту.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const dir = path.join(__dirname, "..", "src");

// Поддельный electron-updater: checkForUpdates падает, пока fail = true, иначе находит 0.1.56.
let fail = true, calls = 0;
const handlers = {};
const autoUpdater = {
  on: (ev, fn) => { handlers[ev] = fn; },
  setFeedURL() {},
  async checkForUpdates() {
    calls++;
    if (fail) throw new Error("net::ERR_NETWORK_IO_SUSPENDED");
    handlers["update-available"]?.({ version: "0.1.56" });
  },
};
const timers = [];
const ctx = {
  module: { exports: {} },
  require: (m) => (m === "electron" ? { app: { getVersion: () => "0.1.55", isPackaged: true } } : m === "electron-updater" ? { autoUpdater } : require(m)),
  setTimeout: (fn, ms) => { const t = { fn, ms, on: true }; timers.push(t); return t; },
  clearTimeout: (t) => { if (t) t.on = false; },
  console,
};
ctx.exports = ctx.module.exports;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(dir, "updates.js"), "utf8"), ctx);
const states = [];
const u = ctx.module.exports.createUpdates({ feed: () => "http://x/desktop/", onState: (s) => states.push(s.status), beforeInstall() {}, log() {} });
const live = () => timers.filter((t) => t.on);

(async () => {
  try {
    await u.check();
    check(u.state().status === "error", `сбой проверки — не ошибка: ${u.state().status}`);
    check(live().length === 1 && live()[0].ms === 15 * 60_000, `после сбоя нет повтора через 15 минут: ${JSON.stringify(live().map((t) => t.ms))}`);
    await u.check(); // снова сбой — повтор один, не копится
    check(live().length === 1, `повторы копятся: ${live().length}`);
    fail = false;
    const t = live()[0];
    t.on = false;
    await t.fn();
    check(u.state().status === "available" && u.state().next === "0.1.56", `повтор не нашёл новую версию: ${u.state().status}`);
    check(live().length === 0, "после удачной проверки остался повтор");
  } catch (e) {
    check(false, `тест оборвался: ${e?.stack ?? e}`);
  }
  // Пробуждение ПК: проверить снова через минуту (сеть успевает подняться).
  const main = fs.readFileSync(path.join(dir, "main.js"), "utf8");
  const resume = main.match(/powerMonitor\.on\("resume",[^\n]*/)?.[0] ?? "";
  check(/updates\.check\(\)/.test(resume) && /60_000/.test(resume), "после пробуждения ПК обновление не проверяется");
  console.log(`${n - bad}/${n}`);
  process.exit(bad ? 1 : 0);
})();
