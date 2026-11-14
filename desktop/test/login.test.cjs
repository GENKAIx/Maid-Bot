// Проверка входа программы логином и паролем (main.js: loginOnServer) на настоящем маленьком http-сервере — без Electron:
// верный пароль — ключ; неверный — «Неверный логин или пароль»; нет сервера — «Нет связи с сервером» и код в журнале;
// settings:login — из окна настроек и из виджета (адрес — из настроек), из других окон — нет;
// сервер перенаправил на https-адрес (http://IP → https://домен) — сохраняется он, на http — нет.
const fs = require("fs");
const http = require("http");
const src = fs.readFileSync(process.argv[2] ?? require("path").join(__dirname, "../src/main.js"), "utf8");
const cut = (from, to) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));
const code = cut("/** Сервер перенаправил запрос на другой адрес https", "async function api(") +
  cut("/** Вход логином и паролем на сервере", 'ipcMain.handle("settings:set"');

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const log = [];
// Вход из окна (settings:login): окно настроек и виджет — можно, другие окна — нет; виджету адрес — из настроек.
const handlers = {};
const settingsPage = { id: "settings" }, widgetWc = { id: "widget" }, stranger = { id: "site" };
const st = { settings: { server: "", token: "" }, saved: 0 };
const { loginOnServer } = new Function(
  "maidLog", "ipcMain", "isSettingsPage", "widget", "settings", "serverBase", "canEncrypt", "safeStorage", "saveSettings", "refreshTray", "broadcast", "shown",
  code + "; return { loginOnServer };",
)(
  (...a) => log.push(a.join(" ")), { handle: (name, fn) => (handlers[name] = fn) }, (wc) => wc === settingsPage, { webContents: widgetWc }, st.settings,
  (s) => { try { const u = new URL(String(s)); return /^https?:$/.test(u.protocol) ? u.origin : null; } catch { return null; } },
  () => false, null, () => st.saved++, () => {}, () => {}, () => ({ ok: true }),
);

const bodies = [];
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const b = JSON.parse(raw || "{}");
    bodies.push({ path: req.url, ...b });
    res.setHeader("Content-Type", "application/json");
    if (b.login === "boom") return res.writeHead(500).end(JSON.stringify({ error: "ошибка сервера" }));
    if (b.login === "many") return res.writeHead(429).end(JSON.stringify({ error: "слишком много неудачных попыток, попробуйте через 5 мин" }));
    if (b.login === "vasya" && b.password === "secret") return res.end(JSON.stringify({ token: "tok-" + b.label }));
    res.writeHead(401).end(JSON.stringify({ error: "неверный логин или пароль" }));
  });
});

const errOf = (p) => p.then(() => "", (e) => e.message);

server.listen(0, "127.0.0.1", async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const t = await loginOnServer(base, "vasya", "secret", "Программа на ПК");
    check(t.token === "tok-Программа на ПК" && t.origin === base, `верный пароль: ключ ${JSON.stringify(t)}`);
    check(bodies[0].path === "/api/login" && bodies[0].label === "Программа на ПК", "запрос не на /api/login или без подписи");
    check(/Неверный логин или пароль/.test(await errOf(loginOnServer(base, "vasya", "wrong", "x"))), "неверный пароль: не та ошибка");
    check(/Сервер: слишком много/.test(await errOf(loginOnServer(base, "many", "x", "x"))), "429: нет текста сервера");
    check(/Сервер: ошибка сервера/.test(await errOf(loginOnServer(base, "boom", "x", "x"))), "500: нет текста сервера");
    check(log.some((l) => l.includes("вход: сервер ответил 500")), "500: нет записи в журнале");
    // Нет сервера по адресу — «Нет связи», в журнал — код (ECONNREFUSED); пароля в журнале нет.
    log.length = 0;
    const free = http.createServer();
    await new Promise((r) => free.listen(0, "127.0.0.1", r));
    const closed = `http://127.0.0.1:${free.address().port}`;
    await new Promise((r) => free.close(r));
    const e = await errOf(loginOnServer(closed, "vasya", "secret", "x"));
    check(/Нет связи с сервером. Проверьте адрес сервера и интернет/.test(e), `нет сервера: ${e}`);
    check(log.some((l) => l.includes("ECONNREFUSED")), `нет сервера: в журнале нет кода (${log})`);
    check(!log.some((l) => l.includes("secret")), "пароль попал в журнал");

    // settings:login: из чужого окна — отказ; из окна настроек — адрес из формы; из виджета — адрес из настроек, а не из формы.
    const login = handlers["settings:login"];
    check(/неверный запрос/.test(await errOf(login({ sender: stranger }, { server: base, login: "vasya", password: "secret" }))), "чужое окно: вход не запрещён");
    check(st.settings.token === "", "чужое окно: ключ записан");
    await login({ sender: settingsPage }, { server: base, login: "vasya", password: "secret" });
    check(st.settings.server === base && st.settings.token === "tok-Программа на ПК", "окно настроек: ключ или адрес не записаны");
    st.settings.token = "";
    bodies.length = 0;
    await login({ sender: widgetWc }, { server: closed, login: "vasya", password: "secret" });
    check(st.settings.token === "tok-Программа на ПК" && st.settings.server === base, "виджет: вход не прошёл или адрес взят из формы");
    check(bodies.length === 2, `виджет: запросов на сервер ${bodies.length}, нужно 2 (программа и сайт)`);
    check(/Неверный логин или пароль/.test(await errOf(login({ sender: widgetWc }, { login: "vasya", password: "nope" }))), "виджет: неверный пароль — не та ошибка");

    // Переадресация (как Caddy: http://IP → 308 → https://домен). fetch подменён: настоящий https в тесте не поднять.
    const realFetch = globalThis.fetch;
    const answer = (url) => ({ redirected: true, url, status: 200, ok: true, json: async () => ({ token: "tok-moved" }) });
    try {
      globalThis.fetch = async () => answer("https://maid.example/api/login");
      bodies.length = 0;
      await login({ sender: settingsPage }, { server: "http://10.0.0.1", login: "vasya", password: "secret" });
      check(st.settings.server === "https://maid.example" && st.settings.token === "tok-moved", `https-переадресация: сохранён ${st.settings.server}`);
      check(log.some((l) => l.includes("сервер на другом адресе: http://10.0.0.1 → https://maid.example")), "https-переадресация: нет записи в журнале");
      globalThis.fetch = async () => answer("http://other.example/api/login");
      await login({ sender: settingsPage }, { server: "http://10.0.0.1", login: "vasya", password: "secret" });
      check(st.settings.server === "http://10.0.0.1", `переадресация на http: адрес сменился на ${st.settings.server}`);
    } finally { globalThis.fetch = realFetch; }
  } finally {
    server.close();
    console.log(`${n - bad}/${n}`);
    process.exit(bad ? 1 : 0);
  }
});
