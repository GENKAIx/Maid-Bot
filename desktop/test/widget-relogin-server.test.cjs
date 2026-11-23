// Вход из виджета на новой установке (23.11.2026). Было: у новой установки адрес сервера localhost:3000, а форма входа виджета
// адреса не спрашивала — «Нет связи с сервером», войти получалось только через полную версию; «Вхожу…» мелькало красным.
// Стало: установленная программа по умолчанию смотрит на настоящий сервер (и старый адрес для разработки заменяется при запуске),
// в форме виджета есть поле адреса (localhost не подставляется), на кнопке крутилка, «Вхожу…» — не красным и не короче 600 мс.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8").replace(/\r\n/g, "\n");
const main = read("src/main.js"), widget = read("renderer/widget.js"), css = read("renderer/style.css");

// Адрес по умолчанию: установленная — настоящий сервер, разработка — localhost.
const dev = new RegExp(main.match(/const DEV_SERVER = \/(.+)\/i;/)[1], "i");
check(main.includes('const SERVER_DEFAULT = "https://187-126-11-122.sslip.io";'), "адрес по умолчанию");
check(/server: app\.isPackaged \? SERVER_DEFAULT : "http:\/\/localhost:3000",/.test(main), "по умолчанию: установленная — сервер, разработка — localhost");
for (const s of ["http://localhost:3000", "http://localhost:3000/", "http://127.0.0.1:3000", "https://LOCALHOST"]) check(dev.test(s), `адрес для разработки: ${s}`);
for (const s of ["https://187-126-11-122.sslip.io", "http://192.168.1.5:3000", "https://localhost.example.com", "http://localhost:3000/api"]) check(!dev.test(s), `не для разработки: ${s}`);
check(/if \(app\.isPackaged && DEV_SERVER\.test\(String\(settings\.server \?\? ""\)\)\) \{\n\s+maidLog\([^\n]+\n\s+settings\.server = SERVER_DEFAULT;\n\s+saveSettings\(\);/.test(main),
  "старая установка с localhost — на настоящий сервер при запуске");
check(/const typed = String\(form\?\.server \?\? ""\)\.trim\(\);\n\s+const base = serverBase\(fromWidget && !typed \? settings\.server : typed\);/.test(main), "вход: виджет присылает адрес, пустой — из настроек");

// Форма виджета: поле адреса и вход с крутилкой.
const html = widget.match(/const reloginHtml = `([^`]+)`/)[1];
check(/id="rlServer"/.test(html) && html.indexOf('id="rlServer"') < html.indexOf('id="rlLogin"'), "поле адреса над логином");
check(/class="relogin-spin"/.test(html), "крутилка на кнопке");
check(/\.relogin\.busy \.relogin-spin \{ display: inline-block; \}/.test(css) && /\.relogin \.relogin-err\.ok \{ color: var\(--muted\); \}/.test(css), "стили: крутилка и «Вхожу…» не красным");

// Поведение формы — в маленьком DOM.
const els = {};
const el = (id) => (els[id] ??= { id, value: "", textContent: "", disabled: false, classes: new Set(), classList: { toggle(c, on) { on ? els[id].classes.add(c) : els[id].classes.delete(c); } }, addEventListener() {} });
const sent = [];
let answer = async () => {};
const ctx = {
  $: (q) => el(q.slice(1)), grabbed: false, loadFail: "x", setTimeout, Date,
  maid: { settings: async () => ({ server: ctx.server }), login: async (f) => { sent.push(f); return answer(f); }, focusInput() {} },
  load: async () => { ctx.loaded = true; },
};
vm.createContext(ctx);
vm.runInContext(`${widget.match(/\nconst RELOGIN_MIN_MS = .*/)[0]}\n${widget.match(/\nconst RELOGIN_DEV = .*/)[0]}\n${widget.match(/\nfunction bindRelogin\(\) \{[^]*?\n\}/)[0]}\nthis.bind = bindRelogin;`, ctx);
const tick = () => new Promise((r) => setTimeout(r, 0));
const submit = () => els.reloginForm.onsubmit({ preventDefault() {} });

(async () => {
  // Адрес для разработки не подставляется, настоящий — подставляется.
  ctx.server = "http://localhost:3000";
  ctx.bind(); await tick();
  check(els.rlServer.value === "", `localhost не подставлен: «${els.rlServer.value}»`);
  els.rlServer.value = "";
  ctx.server = "https://187-126-11-122.sslip.io";
  ctx.bind(); await tick();
  check(els.rlServer.value === "https://187-126-11-122.sslip.io", "свой адрес подставлен");

  // Пустой адрес — просьба вписать, без запроса.
  els.rlServer.value = "";
  el("rlLogin").value = "volkir58"; el("rlPass").value = "pass";
  await submit();
  check(!sent.length && els.rlErr.textContent === "Впишите адрес сервера" && !els.rlErr.classes.has("ok"), "пустой адрес — красная подсказка");

  // Вход идёт: крутилка, «Вхожу…» не красным, кнопка недоступна; мгновенный отказ держится не меньше 600 мс.
  els.rlServer.value = " https://187-126-11-122.sslip.io ";
  let release;
  answer = () => new Promise((_, no) => { release = () => no(new Error("Error invoking remote method 'settings:login': Error: Нет связи с сервером. Проверьте адрес сервера и интернет.")); });
  const t0 = Date.now();
  const p = submit();
  await tick();
  check(els.reloginForm.classes.has("busy") && els.rlGo.disabled && els.rlErr.textContent === "Вхожу…" && els.rlErr.classes.has("ok"), "во время входа: крутилка и «Вхожу…»");
  check(JSON.stringify(sent[0]) === JSON.stringify({ server: "https://187-126-11-122.sslip.io", login: "volkir58", password: "pass" }), `в main ушёл адрес: ${JSON.stringify(sent[0])}`);
  release();
  await p;
  check(Date.now() - t0 >= 590, `отказ показан не раньше 600 мс: ${Date.now() - t0}`);
  check(!els.reloginForm.classes.has("busy") && !els.rlGo.disabled && /^Нет связи с сервером/.test(els.rlErr.textContent) && !els.rlErr.classes.has("ok"), "отказ — красным, без «Error invoking…», кнопка снова доступна");

  // Удачный вход — данные грузятся заново.
  answer = async () => ({ ok: true });
  await submit();
  check(ctx.loaded && ctx.loadFail === "", "после входа — загрузка");

  console.log(bad ? `${bad} из ${n} не прошли` : `OK: ${n} проверок входа из виджета`);
  process.exit(bad ? 1 : 0);
})();
