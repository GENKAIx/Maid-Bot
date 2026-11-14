// Проверка «вход устарел» (main.js: api) на маленьком http-сервере — без Electron: сервер не принял ключ (401) —
// ошибка «вход устарел — войдите снова» (а не «нет связи»), признак loginStale и одна запись в журнале; ключ снова принят — признак снят;
// сервер перенаправил на https-адрес — адрес в настройках меняется и запрос повторяется с ключом (один раз), на http — нет.
const fs = require("fs");
const http = require("http");
const src = fs.readFileSync(process.argv[2] ?? require("path").join(__dirname, "../src/main.js"), "utf8");
const cut = (from, to) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)) + to.length);
const code = cut("/** Сервер перенаправил запрос на другой адрес https", 'const LOGIN_STALE = "вход устарел — войдите снова";');

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
  let saved = 0;
  const A = new Function("settings", "token", "tokenEnc", "serverBase", "maidLog", "saveSettings",
    code + "; return { api, stale: () => loginStale };")(settings, () => settings.token, "", () => new URL(settings.server).origin, (...a) => log.push(a.join(" ")), () => saved++);
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

    // Переадресация на https (http://IP → https://домен): fetch подменён — ответ «перенаправлен, 401 без ключа», потом 200 с ключом.
    const realFetch = globalThis.fetch;
    const seen = [];
    try {
      settings.server = "http://10.0.0.1";
      globalThis.fetch = async (url, o) => {
        seen.push(`${url} ${o.headers.Authorization}`);
        if (String(url).startsWith("http://10.0.0.1")) return { redirected: true, url: "https://maid.example/api/today", status: 401, ok: false, json: async () => ({}) };
        return { redirected: false, url: String(url), status: 200, ok: true, json: async () => ({ day: "moved" }) };
      };
      const m = await A.api("GET", "/api/today");
      check(m.day === "moved", "https-переадресация: запрос не повторён");
      check(settings.server === "https://maid.example" && saved === 1, `https-переадресация: адрес ${settings.server}, сохранений ${saved}`);
      check(seen[1] === "https://maid.example/api/today Bearer good", `https-переадресация: повтор без ключа (${seen})`);
      check(log.some((l) => l.includes("сервер переехал: http://10.0.0.1 → https://maid.example")), "https-переадресация: нет записи в журнале");
      // На http ключ не переносится: адрес прежний, 401 — «вход устарел».
      settings.server = "http://10.0.0.1";
      seen.length = 0;
      globalThis.fetch = async (url) => { seen.push(String(url)); return { redirected: true, url: "http://other.example/api/today", status: 401, ok: false, json: async () => ({}) }; };
      const e2 = await errOf(A.api("GET", "/api/today"));
      check(e2 === "вход устарел — войдите снова" && settings.server === "http://10.0.0.1" && seen.length === 1, `переадресация на http: ${e2}, ${settings.server}, запросов ${seen.length}`);
      // Переадресация по кругу — повтор только один.
      seen.length = 0;
      globalThis.fetch = async (url) => { seen.push(String(url)); return { redirected: true, url: `https://hop${seen.length}.example/api/today`, status: 401, ok: false, json: async () => ({}) }; };
      await errOf(A.api("GET", "/api/today"));
      check(seen.length === 2, `переадресация по кругу: запросов ${seen.length}`);
    } finally { globalThis.fetch = realFetch; }
  } finally {
    server.close();
    console.log(`${n - bad}/${n}`);
    process.exit(bad ? 1 : 0);
  }
});
