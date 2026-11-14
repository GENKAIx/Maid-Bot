// Проверка «вход устарел» (main.js: api) на маленьком http-сервере — без Electron: сервер не принял ключ (401) —
// ошибка «вход устарел — войдите снова» (а не «нет связи»), признак loginStale и одна запись в журнале; ключ снова принят — признак снят.
const fs = require("fs");
const http = require("http");
const src = fs.readFileSync(process.argv[2] ?? require("path").join(__dirname, "../src/main.js"), "utf8");
const cut = (from, to) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)) + to.length);
const code = cut("async function api(method, p, body) {", 'const LOGIN_STALE = "вход устарел — войдите снова";');

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const log = [];
let accept = false;
const server = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (accept && req.headers.authorization === "Bearer good") return res.end(JSON.stringify({ day: "2026-11-14" }));
  res.writeHead(401).end(JSON.stringify({ error: "нужен вход (логин и пароль) или ключ" }));
});

server.listen(0, "127.0.0.1", async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const settings = { token: "good", server: base };
  const A = new Function("settings", "token", "tokenEnc", "serverBase", "maidLog",
    code + "; return { api, stale: () => loginStale };")(settings, () => settings.token, "", () => base, (...a) => log.push(a.join(" ")));
  const errOf = (p) => p.then(() => "", (e) => e.message);
  try {
    check(!A.stale(), "сначала признака нет");
    const e1 = await errOf(A.api("GET", "/api/today"));
    check(e1 === "вход устарел — войдите снова", `401: ошибка «${e1}»`);
    check(A.stale(), "401: признак loginStale не поставлен");
    await errOf(A.api("GET", "/api/today"));
    check(log.filter((l) => l.includes("сервер не принял ключ (401)")).length === 1, `401: в журнале не одна запись (${log})`);
    accept = true;
    const d = await A.api("GET", "/api/today");
    check(d.day === "2026-11-14", "ключ принят: нет данных");
    check(!A.stale(), "ключ принят: признак не снят");
  } finally {
    server.close();
    console.log(`${n - bad}/${n}`);
    process.exit(bad ? 1 : 0);
  }
});
