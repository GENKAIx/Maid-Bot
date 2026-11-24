// Стресс-проверки сети (main.js: api, вход): настоящий main.js на стенде (harness.cjs) против поддельного сервера, который
// ломается (fake-server.cjs). Запуск: node --test desktop/test/stress/
// Проверки с пометкой todo — найденные баги (номер — по отчёту docs/review/стресс-тест-ПК-2026-11-15.html): они описывают,
// как должно быть, и сейчас не проходят; общий итог прогона при этом зелёный. Починили — пометку todo убрать.
const test = require("node:test");
const assert = require("node:assert/strict");
const { boot, loggedIn } = require("./harness.cjs");
const fake = require("./fake-server.cjs");

const errOf = (p) => p.then(() => "", (e) => String(e.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
async function rig(t, opts = {}) {
  const srv = await fake.create().listen();
  const h = boot({ settings: loggedIn(srv.url, opts.extra), ...opts });
  await h.ready();
  t.after(async () => { h.stop(); await srv.close(); });
  return { srv, h, api: (m, p, b) => h.invoke("api", [m, p, b]) };
}

test("сервер работает: данные приходят, ключ уходит в запросе", async (t) => {
  const { srv, h, api } = await rig(t);
  const d = await api("GET", "/api/today");
  assert.equal(d.tasks.length, 4);
  assert.equal(srv.log.at(-1).auth, "Bearer good-key");
  // Кто спрашивает (статистика админки): окно виджета — widget, другое окно — desktop; версия — app.getVersion() стенда.
  assert.equal(srv.log.at(-1).client, "widget");
  assert.equal(srv.log.at(-1).version, "0.0.0-stress");
  await h.invoke("api", ["GET", "/api/today"], null);
  assert.equal(srv.log.at(-1).client, "desktop");
});

test("сервер выключен: пять попыток за ~10 с, «нет связи с сервером», запись в журнале", async (t) => {
  const { srv, h, api } = await rig(t);
  await srv.close();
  const t0 = Date.now();
  assert.equal(await errOf(api("GET", "/api/today")), "нет связи с сервером");
  assert.ok(Date.now() - t0 >= 9500, "паузы 0,7 + 1,4 + 2,8 + 5 с — переживает перезапуск сервера при выкладке");
  assert.match(h.log(), /нет связи с сервером: ECONNREFUSED/);
});

test("сервер перезапустился посреди запроса (выкладка): повтор проходит сам", async (t) => {
  const { srv, api } = await rig(t);
  srv.fault = { mode: "reset", times: 2 }; // два обрыва, третий запрос — уже новый сервер
  const d = await api("GET", "/api/today");
  assert.equal(d.tasks.length, 4);
});

test("500 с объяснением и 502 от прокси: понятная ошибка, вход не «устаревает»", async (t) => {
  const { srv, h, api } = await rig(t);
  srv.fault = { mode: "500" };
  assert.equal(await errOf(api("GET", "/api/today")), "внутренняя ошибка");
  srv.fault = { mode: "502" };
  assert.equal(await errOf(api("GET", "/api/today")), "сервер 502");
  assert.equal(h.peek("loginStale"), false);
});

test("401: «вход устарел», а когда сервер снова принял ключ — признак снят", async (t) => {
  const { srv, h, api } = await rig(t);
  srv.fault = { mode: "401" };
  assert.equal(await errOf(api("GET", "/api/today")), "вход устарел — войдите снова");
  assert.equal(h.peek("loginStale"), true);
  srv.fault = null;
  await api("GET", "/api/today");
  assert.equal(h.peek("loginStale"), false);
  assert.ok(h.disk().tokenEnc, "ключ на диске остался");
});

test("сервер молчит: запрос обрывается по сроку (90 с, на стенде в 60 раз быстрее) — «сервер не ответил»", async (t) => {
  const { srv, api } = await rig(t, { timeScale: 60 });
  srv.fault = { mode: "hang", ms: 10_000 };
  const t0 = Date.now();
  assert.equal(await errOf(api("GET", "/api/today")), "сервер не ответил");
  assert.ok(Date.now() - t0 < 3000);
});

test("Б-1: соединение оборвалось ПОСЛЕ того, как сервер выполнил POST, — запрос не должен уходить второй раз", { todo: "Б-1: main.js api() повторяет любой POST до трёх раз" }, async (t) => {
  const { srv, api } = await rig(t);
  srv.fault = { mode: "reset-after", only: /^\/api\/events$/ };
  await errOf(api("POST", "/api/events", { title: "Стоматолог", date: "2026-11-20" }));
  assert.equal(srv.posts.filter((x) => x.p === "/api/events").length, 1, "план создан на сервере столько раз");
});

test("Б-1: то же для «Отменить» и оценки дня", { todo: "Б-1" }, async (t) => {
  const { srv, api } = await rig(t);
  srv.fault = { mode: "reset-after" };
  await errOf(api("POST", "/api/undo", { messageId: 7 }));
  await errOf(api("POST", "/api/rate", { day: "2026-11-15", value: 8 }));
  assert.deepEqual([srv.undos.length, srv.rates.length], [1, 1]);
});

test("сообщение горничной при таком обрыве не двоится: у него свой id (сервер узнаёт повтор)", async (t) => {
  const { srv, api } = await rig(t);
  srv.fault = { mode: "reset-after", only: /input/ };
  await errOf(api("POST", "/api/input", { text: "купить хлеб", id: "m-1" }));
  assert.equal(srv.inputs.length, 1);
});

test("Б-2: вместо JSON пришла страница (вход в Wi-Fi, заглушка прокси) с кодом 200 — это ошибка, а не пустые данные", { todo: "Б-2: res.json().catch(() => ({})) превращает что угодно в {}" }, async (t) => {
  const { srv, api } = await rig(t);
  srv.fault = { mode: "html200" };
  await assert.rejects(api("GET", "/api/today"));
});

test("Б-2: ответ оборвался на середине — это ошибка, а не пустые данные", { todo: "Б-2" }, async (t) => {
  const { srv, api } = await rig(t);
  srv.fault = { mode: "truncate" };
  await assert.rejects(api("GET", "/api/today"));
});

test("Б-3: сервер перенаправил на ЧУЖОЙ https-адрес — адрес в настройках не меняется и ключ туда не уходит", { todo: "Б-3: movedTo() доверяет любому https-адресу" }, async (t) => {
  const { h, api } = await rig(t);
  const real = globalThis.fetch;
  const seen = [];
  t.after(() => (globalThis.fetch = real));
  const mine = h.peek("settings.server");
  // Подмена DNS или страница провайдера: запрос ушёл на «свой» адрес, ответ пришёл с другого.
  globalThis.fetch = async (url, o) => {
    seen.push(`${new URL(url).origin} ${o?.headers?.Authorization ?? ""}`);
    return { redirected: String(url).startsWith(mine), url: "https://portal.example/blocked", status: 401, ok: false, json: async () => ({}) };
  };
  await errOf(api("GET", "/api/today"));
  assert.equal(h.peek("settings.server"), mine, "адрес сервера в настройках");
  assert.ok(!seen.some((s) => s.startsWith("https://portal.example") && s.includes("good-key")), `ключ ушёл на чужой адрес: ${seen}`);
});

test("запрос не может уйти мимо /api и на чужой адрес", async (t) => {
  const { srv, api } = await rig(t);
  const n = srv.log.length;
  for (const p of ["/secret", "/api/../secret", "//evil.example/api/x", "/api/a b", "https://evil.example/api/x", 5, null])
    assert.equal(await errOf(api("GET", p)), "неверный запрос", String(p));
  assert.equal(await errOf(api("TRACE", "/api/today")), "неверный запрос");
  assert.equal(srv.log.length, n, "на сервер ничего не ушло");
});

test("С-7: «/api/%2e%2e/…» — закодированные точки тоже не должны выводить запрос из /api", { todo: "С-7: проверка пути смотрит строку, а URL раскрывает %2e%2e" }, async (t) => {
  const { srv, api } = await rig(t);
  await errOf(api("GET", "/api/%2e%2e/healthz"));
  assert.ok(srv.log.at(-1).path.startsWith("/api/"), `запрос ушёл на ${srv.log.at(-1).path}`);
});

// --- вход ---
const login = (h, form, win, url) => h.invoke("settings:login", [form], win, url);

test("вход из виджета: ключ в настройках (зашифрован), признак «устарел» снят", async (t) => {
  const { srv, h, api } = await rig(t);
  srv.token = "revoked";
  await errOf(api("GET", "/api/today"));
  assert.equal(h.peek("loginStale"), true);
  const s = await login(h, { login: "user", password: "pass" });
  assert.equal(s.loginStale, false);
  assert.equal(s.token, undefined, "ключ окну не отдаётся");
  assert.equal(h.disk().token, undefined, "открытого ключа на диске нет");
  assert.equal((await api("GET", "/api/today")).tasks.length, 4);
});

test("вход: неверный пароль, пустые поля, сервер выключен — понятные слова", async (t) => {
  const { srv, h } = await rig(t);
  assert.equal(await errOf(login(h, { login: "user", password: "нет" })), "Неверный логин или пароль.");
  assert.equal(await errOf(login(h, { login: " ", password: "x" })), "Впишите логин и пароль.");
  await srv.close();
  assert.equal(await errOf(login(h, { login: "user", password: "pass" })), "Нет связи с сервером. Проверьте адрес сервера и интернет.");
});

test("С-2: вход при разовом обрыве связи повторяется, как обычный запрос", { todo: "С-2: loginOnServer делает одну попытку, api() — три" }, async (t) => {
  const { srv, h } = await rig(t);
  srv.fault = { mode: "reset", times: 1 };
  assert.equal(await errOf(login(h, { login: "user", password: "pass" })), "");
});

test("вход принимают только окно настроек и виджет", async (t) => {
  const { h } = await rig(t);
  const site = new h.electron.BrowserWindow();
  site.loadURL("https://evil.example/");
  assert.equal(await errOf(login(h, { login: "user", password: "pass" }, site)), "неверный запрос");
});

test("Б-6: два нажатия «Войти» подряд — на сервере один вход, а не два", { todo: "Б-6: settings:login не помнит, что вход уже идёт; кнопка в настройках не гаснет" }, async (t) => {
  const { srv, h } = await rig(t);
  srv.latency = () => 150;
  await Promise.all([login(h, { login: "user", password: "pass" }), login(h, { login: "user", password: "pass" })]);
  assert.equal(srv.sessions.length, 1);
});

test("С-3: вход под другим логином — прежний вход на сервере закрывается", { todo: "С-3: старый ключ остаётся действующим на сервере (нет POST /api/logout)" }, async (t) => {
  const { srv, h } = await rig(t);
  srv.logins.second = "pass2";
  await login(h, { login: "user", password: "pass" });
  await login(h, { login: "second", password: "pass2" });
  assert.ok(srv.log.some((r) => r.path === "/api/logout"), "программа не попросила сервер закрыть старый вход");
});

test("Б-7: сайт в главном окне ушёл на чужой адрес — после входа из виджета новый ключ туда не пишется", { todo: "Б-7: executeJavaScript пишет ключ в любую страницу главного окна" }, async (t) => {
  const { h } = await rig(t);
  h.send("open-main", []);
  const win = h.mainWin();
  win.webContents.url = "https://evil.example/landing"; // переход по ссылке внутри окна (will-navigate не перехватывается)
  await login(h, { login: "user", password: "pass" });
  assert.ok(!win.js.some((c) => c.includes("maid.token")), "ключ записан в localStorage чужой страницы");
});

test("сайт вышел (или получил 401 и стёр вход) — программа тоже выходит, ключ с диска стирается", async (t) => {
  const { h } = await rig(t);
  h.send("open-main", []);
  const win = h.mainWin();
  assert.equal(h.send("site-login:get", [], win), "good-key");
  h.send("site-login:keep", [""], win);
  assert.equal(h.disk().tokenEnc, undefined);
  assert.equal(h.peek("loginStale"), true);
  // С-1 (слабое место): одного 401, который увидел сайт (например, от прокси во время выкладки), хватает, чтобы вход пропал насовсем.
});

test("ключ сайта принимается только со страницы сервера из настроек", async (t) => {
  const { h } = await rig(t);
  h.send("open-main", []);
  const win = h.mainWin();
  assert.equal(h.send("site-login:get", [], win, "https://evil.example/"), "");
  h.send("site-login:keep", ["stolen"], win, "https://evil.example/");
  assert.equal(h.peek("settings.token"), "good-key");
  h.send("site-login:keep", ["пароль-по-русски"], win);
  assert.equal(h.peek("settings.token"), "good-key", "испорченный ключ не принят");
});
