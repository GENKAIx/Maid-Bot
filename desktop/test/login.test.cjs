// Проверка входа программы логином и паролем (main.js: loginOnServer) на настоящем маленьком http-сервере — без Electron:
// верный пароль — ключ; неверный — «Неверный логин или пароль»; нет сервера — «Нет связи с сервером» и код в журнале.
const fs = require("fs");
const http = require("http");
const src = fs.readFileSync(process.argv[2] ?? require("path").join(__dirname, "../src/main.js"), "utf8");
const cut = (from, to) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));
const code = cut("/** Вход логином и паролем на сервере", "// Вход в программу — только из окна настроек");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const log = [];
const loginOnServer = new Function("maidLog", code + "; return loginOnServer;")((...a) => log.push(a.join(" ")));

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
    check(t === "tok-Программа на ПК", `верный пароль: ключ ${t}`);
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
  } finally {
    server.close();
    console.log(`${n - bad}/${n}`);
    process.exit(bad ? 1 : 0);
  }
});
