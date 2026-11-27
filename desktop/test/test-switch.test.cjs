// Тестовый аккаунт в программе на ПК (main.js: settings:enter-test, settings:switch-back, testTurn, site-login:keep, меню значка) —
// настоящий main.js на стенде (stress/harness.cjs) и поддельный сервер (stress/fake-server.cjs: /api/me с is_test, /api/logout).
// Главное (просьба владельца): вернуться в свой аккаунт можно всегда — свой ключ откладывается зашифрованным на диск раньше, чем
// встаёт тестовый, переход тест → тест его не трогает, он переживает перезапуск; «вернуться» — в настройках, виджете, меню значка
// и «Выйти» на сайте; свой устарел (401) — обычная форма входа. Ключ не тестового аккаунта не принимается.
const test = require("node:test");
const assert = require("node:assert/strict");
const { boot, loggedIn } = require("./stress/harness.cjs");
const fake = require("./stress/fake-server.cjs");

const errOf = (p) => p.then(() => "", (e) => String(e.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
const dec = (b64) => Buffer.from(String(b64 ?? ""), "base64").toString("utf8"); // подменная защита Windows: «ENC:» + ключ

async function stand(t, opts = {}) {
  const srv = await fake.create().listen();
  const h = boot({ settings: loggedIn(srv.url, opts.extra), keep: true, ...opts.boot });
  await h.ready();
  // Сколько раз выброшен несданный счёт фич и падения (usage.drop, crashes.drop) — смена аккаунта должна их выбросить.
  h.peek(`globalThis.__drops = { usage: 0, crashes: 0 };
    usage.drop = ((d) => () => { globalThis.__drops.usage++; return d(); })(usage.drop);
    crashes.drop = ((d) => () => { globalThis.__drops.crashes++; return d(); })(crashes.drop);`);
  t.after(async () => { h.stop(); await srv.close(); require("node:fs").rmSync(h.app.paths.appData, { recursive: true, force: true }); });
  return { srv, h };
}
/** Сайт в главном окне программы; path — страница (по умолчанию админка «Тестовые аккаунты»). */
function site(h, srv, path = "/admin/tests") {
  h.peek("showMain()");
  const win = h.mainWin();
  return { win, url: srv.url + path };
}
const enter = (h, srv, key, path) => { const s = site(h, srv, path); return h.invoke("settings:enter-test", [key], s.win, s.url); };
const settingsWin = (h) => { h.peek("showMain(true)"); return h.mainWin(); };
const trayItem = (h) => h.menus.at(-1)?.find((x) => /вернуться в свой аккаунт/.test(x.label ?? ""));
const until = async (h, ok, ms = 3000) => { for (const end = Date.now() + ms; !ok() && Date.now() < end;) await h.wait(20); };

test("вход из админки: свой ключ — на диск зашифрованным до тестового, окна видят только номер и hasHome", async (t) => {
  const { srv, h } = await stand(t);
  const key = srv.testKey(7);
  const r = await enter(h, srv, key);
  assert.deepEqual(r, { ok: true });
  assert.equal(h.peek("settings.token"), key);
  const disk = h.disk();
  assert.equal(dec(disk.homeTokenEnc), "ENC:good-key", "свой ключ не отложен зашифрованным");
  assert.equal(disk.testId, 7);
  assert.ok(!JSON.stringify(disk).includes(key) && !JSON.stringify(disk).includes('"good-key"'), "ключ на диске открытым текстом");
  const s = await h.invoke("settings:get");
  assert.equal(s.testId, 7);
  assert.equal(s.hasHome, true);
  assert.ok(!("homeTokenEnc" in s) && !("token" in s), "окну ушёл ключ");
  assert.ok(trayItem(h)?.label.includes("Тест #7"), "в меню значка нет «Тест #7 — вернуться в свой аккаунт»");
  assert.deepEqual(h.peek("globalThis.__drops"), { usage: 1, crashes: 1 }, "счёт фич и падения своего аккаунта не выброшены");
  assert.ok(h.mainWin().js.some((c) => c.includes(JSON.stringify(key)) && c.includes('location.assign("/")')), "сайт не переключён на тестовый");
  assert.ok(h.sent.some((x) => x.channel === "changed"), "окна не узнали о смене аккаунта");
});

test("ключ не тестового аккаунта, чужое окно, не админка, другой адрес — отказ, ничего не тронуто", async (t) => {
  const { srv, h } = await stand(t);
  srv.sessions.push({ token: "plain-key" }); // обычный аккаунт (is_test 0)
  assert.match((await enter(h, srv, "plain-key")).error, /не тестовый/);
  assert.match((await enter(h, srv, "no-such-key")).error, /не принял/);
  assert.match((await enter(h, srv, "пароль")).error, /Неверный ключ/);
  const key = srv.testKey(7);
  assert.equal((await h.invoke("settings:enter-test", [key])).ok, false, "виджет вошёл в тестовый");
  assert.equal((await enter(h, srv, key, "/today")).ok, false, "сайт не со страницы админки вошёл в тестовый");
  const s = site(h, srv);
  assert.equal((await h.invoke("settings:enter-test", [key], s.win, "https://evil.example/admin")).ok, false, "чужой адрес вошёл в тестовый");
  assert.equal((await h.invoke("settings:enter-test", [key], settingsWin(h), "file:///admin")).ok, false, "окно настроек вошло в тестовый");
  assert.equal(h.peek("settings.token"), "good-key");
  assert.equal(h.disk().homeTokenEnc, undefined);
  assert.equal(trayItem(h), undefined);
});

test("возврат из настроек: тестовый ключ закрыт на сервере, свой на месте, отложенный стёрт", async (t) => {
  const { srv, h } = await stand(t);
  const key = srv.testKey(7);
  await enter(h, srv, key);
  const s = await h.invoke("settings:switch-back", [], settingsWin(h));
  assert.equal(s.testId, null);
  assert.equal(s.hasHome, false);
  assert.equal(s.loginStale, false);
  assert.equal(h.peek("settings.token"), "good-key");
  assert.deepEqual(srv.logouts, [key], "тестовый ключ не закрыт (POST /api/logout)");
  assert.equal(h.disk().homeTokenEnc, undefined);
  assert.equal(h.disk().testId, undefined);
  assert.equal(trayItem(h), undefined, "пункт возврата остался в меню");
  assert.deepEqual(h.peek("globalThis.__drops"), { usage: 2, crashes: 2 });
  // Второй щелчок «Вернуться» — ничего не ломает.
  await h.invoke("settings:switch-back", [], settingsWin(h));
  assert.equal(h.peek("settings.token"), "good-key");
  assert.deepEqual(srv.logouts, [key]);
});

test("тест → тест: свой ключ не перезаписан, прежний тестовый закрыт; переживает перезапуск; возврат из виджета", async (t) => {
  const { srv, h } = await stand(t);
  const k7 = srv.testKey(7), k8 = srv.testKey(8);
  await enter(h, srv, k7);
  // Под тестовым админка не откроется, но вход в другой тест может прийти и логином (ниже) — проверяем сам переход.
  assert.deepEqual(await enter(h, srv, k8), { ok: true });
  assert.equal(dec(h.disk().homeTokenEnc), "ENC:good-key", "свой ключ перезаписан тестовым");
  assert.equal(h.disk().testId, 8);
  assert.deepEqual(srv.logouts, [k7]);
  // Перезапуск программы (как после обновления): тест и свой ключ на месте.
  const dir = h.app.paths.appData;
  h.stop();
  const h2 = boot({ userData: dir });
  await h2.ready();
  t.after(() => h2.stop());
  assert.equal(h2.peek("settings.token"), k8);
  assert.equal((await h2.invoke("settings:get")).testId, 8);
  assert.ok(trayItem(h2)?.label.includes("Тест #8"), "после перезапуска нет пункта возврата в меню");
  const s = await h2.invoke("settings:switch-back"); // из виджета
  assert.equal(s.loginStale, false);
  assert.equal(h2.peek("settings.token"), "good-key");
  assert.deepEqual(srv.logouts, [k7, k8]);
});

test("возврат из меню значка у часов (окно сайта не нужно)", async (t) => {
  const { srv, h } = await stand(t);
  const key = srv.testKey(7);
  await enter(h, srv, key);
  h.mainWin().destroy(); // окно сайта сломано или закрыто
  trayItem(h).click();
  await until(h, () => h.peek("settings.token") === "good-key");
  assert.equal(h.peek("settings.token"), "good-key");
  assert.deepEqual(srv.logouts, [key]);
  assert.equal(trayItem(h), undefined);
});

test("свой ключ устарел (401) — возврат открывает обычную форму входа, тестовый закрыт", async (t) => {
  const { srv, h } = await stand(t);
  const key = srv.testKey(7);
  await enter(h, srv, key);
  srv.token = "revoked"; // свой вход закрыли на другом устройстве
  const s = await h.invoke("settings:switch-back", [], settingsWin(h));
  assert.equal(s.loginStale, true, "нет формы входа");
  assert.equal(s.hasToken, false);
  assert.equal(s.testId, null);
  assert.deepEqual(srv.logouts, [key]);
  assert.match(h.log(), /свой ключ устарел/);
});

test("свой ключ не расшифровался — возврата нет, но отложенный ключ и тест на месте (попробовать ещё раз)", async (t) => {
  const { srv, h } = await stand(t);
  const key = srv.testKey(7);
  await enter(h, srv, key);
  h.safe.available = false;
  assert.match(await errOf(h.invoke("settings:switch-back", [], settingsWin(h))), /не расшифровался/);
  assert.equal(h.peek("settings.token"), key);
  assert.equal(dec(h.disk().homeTokenEnc), "ENC:good-key");
  assert.deepEqual(srv.logouts, []);
  h.safe.available = true;
  await h.invoke("settings:switch-back", [], settingsWin(h));
  assert.equal(h.peek("settings.token"), "good-key");
});

test("защита Windows недоступна — в тестовый не входим (свой ключ некуда отложить)", async (t) => {
  const { srv, h } = await stand(t);
  h.safe.available = false;
  const r = await enter(h, srv, srv.testKey(7));
  assert.equal(r.ok, false);
  assert.match(r.error, /Защита Windows недоступна/);
  assert.equal(h.peek("settings.token"), "good-key");
  assert.equal(h.peek("settings.testId"), undefined);
});

test("вход логином и паролем тестового — свой ключ откладывается; вход своим логином из теста — тест закрыт", async (t) => {
  const { srv, h } = await stand(t);
  await h.invoke("settings:login", [{ server: srv.url, login: "test-ab12cd", password: "testpass" }], settingsWin(h));
  const testKey = h.peek("settings.token");
  assert.notEqual(testKey, "good-key");
  assert.equal(h.disk().testId, 7);
  assert.equal(dec(h.disk().homeTokenEnc), "ENC:good-key");
  assert.equal((await h.invoke("settings:get")).hasHome, true);
  assert.deepEqual(h.peek("globalThis.__drops"), { usage: 1, crashes: 1 });
  // Из теста — обычным логином: тест закрыт, тестовый ключ закрыт на сервере, отложенный больше не нужен.
  await h.invoke("settings:login", [{ server: srv.url, login: "user", password: "pass" }], settingsWin(h));
  assert.equal(h.disk().testId, undefined);
  assert.equal(h.disk().homeTokenEnc, undefined);
  assert.deepEqual(srv.logouts, [testKey]);
  // Обычный вход без теста — как раньше: ничего тестового, счёт фич не трогается.
  const drops = h.peek("globalThis.__drops.usage");
  await h.invoke("settings:login", [{ server: srv.url, login: "user", password: "pass" }], settingsWin(h));
  assert.equal(h.peek("globalThis.__drops.usage"), drops);
  assert.equal(h.disk().homeTokenEnc, undefined);
});

test("«Выйти» на сайте в тестовом — возврат в свой, а не выход совсем; вход на сайте другим тестовым — свой на месте", async (t) => {
  const { srv, h } = await stand(t);
  const k7 = srv.testKey(7);
  await enter(h, srv, k7);
  const s = site(h, srv, "/");
  h.send("site-login:get", [], s.win, s.url); // страница перезагрузилась с тестовым ключом (siteUse)
  // Вошли на сайте другим тестовым (логином и паролем на сайте) — тест → тест.
  const k8 = srv.testKey(8);
  h.send("site-login:keep", [k8], s.win, s.url);
  await until(h, () => h.peek("settings.token") === k8);
  assert.equal(h.disk().testId, 8);
  assert.equal(dec(h.disk().homeTokenEnc), "ENC:good-key");
  assert.deepEqual(srv.logouts, [k7]);
  // Вышли на сайте.
  h.send("site-login:keep", [""], s.win, s.url);
  await until(h, () => h.peek("settings.token") === "good-key");
  assert.equal(h.peek("settings.token"), "good-key", "выход на сайте в тестовом вышел из программы совсем");
  assert.equal(h.peek("loginStale"), false);
  assert.equal(h.disk().testId, undefined);
  assert.ok(h.mainWin().js.some((c) => c.includes('"good-key"') && c.includes("location.reload()")), "сайт не получил свой ключ обратно");
  // Без теста «Выйти» на сайте — как раньше: программа тоже вышла (новая страница уже взяла ключ программы).
  h.send("site-login:get", [], s.win, s.url);
  h.send("site-login:keep", [""], s.win, s.url);
  assert.equal(h.peek("settings.token"), "");
  assert.equal(h.peek("loginStale"), true);
});

test("окна не могут подменить отложенный ключ и номер теста через settings:set", async (t) => {
  const { srv, h } = await stand(t);
  await h.invoke("settings:set", [{ homeTokenEnc: Buffer.from("ENC:evil").toString("base64"), testId: 5 }]);
  assert.equal(h.disk().homeTokenEnc, undefined);
  assert.equal(h.disk().testId, undefined);
  assert.equal(trayItem(h), undefined);
  // Битый номер теста в файле (правили руками) — не тест.
  const dir = h.app.paths.appData;
  h.stop();
  const file = require("node:path").join(dir, "maid-desktop", "settings.json");
  const fs = require("node:fs");
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), testId: "7" }));
  const h2 = boot({ userData: dir });
  await h2.ready();
  t.after(() => h2.stop());
  assert.equal((await h2.invoke("settings:get")).testId, null);
  void srv;
});

// --- разбор 27.11.2026: свой ключ не теряется ни при каком сбое ---
const authOf = (srv, key) => srv.log.filter((r) => r.auth === `Bearer ${key}`);

test("вход паролем тестового, а /api/me не ответил (500, обрыв) — отказ: свой ключ на месте, новый ключ закрыт", async (t) => {
  for (const mode of ["500", "reset"]) {
    const { srv, h } = await stand(t);
    srv.fault = { mode, only: /^\/api\/me$/, times: 1 };
    const err = await errOf(h.invoke("settings:login", [{ server: srv.url, login: "test-ab12cd", password: "testpass" }], settingsWin(h)));
    assert.match(err, /Нет связи с сервером — не узнать/, mode);
    assert.equal(h.peek("settings.token"), "good-key", `${mode}: свой ключ затёрт`);
    assert.equal(dec(h.disk().tokenEnc), "ENC:good-key", `${mode}: свой ключ на диске затёрт`);
    assert.equal(h.disk().testId, undefined);
    assert.deepEqual(srv.logouts, ["key-1"], `${mode}: новый ключ не закрыт на сервере`);
    // Связь вернулась — тот же вход проходит и откладывает свой ключ.
    await h.invoke("settings:login", [{ server: srv.url, login: "test-ab12cd", password: "testpass" }], settingsWin(h));
    assert.equal(h.disk().testId, 7);
    assert.equal(dec(h.disk().homeTokenEnc), "ENC:good-key");
  }
});

test("вход без своего ключа (новая установка), а /api/me не ответил — обычный вход, как раньше", async (t) => {
  const srv = await fake.create().listen();
  const h = boot({ settings: { server: srv.url, tracker: { enabled: false, iconsVer: 2 } } });
  await h.ready();
  t.after(async () => { h.stop(); await srv.close(); });
  srv.fault = { mode: "500", only: /^\/api\/me$/, times: 1 };
  await h.invoke("settings:login", [{ server: srv.url, login: "user", password: "pass" }], settingsWin(h));
  assert.equal(h.peek("settings.token"), "key-1");
});

test("свой ключ ещё не расшифровался — вход в тестовый (паролем и из админки) отменён, зашифрованный свой ключ не стёрт", async (t) => {
  const { srv, h } = await stand(t, { boot: { encrypt: false } });
  assert.equal(h.peek("settings.token"), "");
  const err = await errOf(h.invoke("settings:login", [{ server: srv.url, login: "test-ab12cd", password: "testpass" }], settingsWin(h)));
  assert.match(err, /Свой ключ ещё не расшифровался/);
  assert.equal(h.peek("tokenEnc"), Buffer.from("ENC:good-key").toString("base64"), "свой зашифрованный ключ стёрт");
  assert.equal(h.disk().token, undefined, "тестовый ключ на диске открытым текстом");
  assert.equal(h.disk().testId, undefined);
  assert.deepEqual(srv.logouts, ["key-1"], "новый ключ не закрыт");
  const r = await enter(h, srv, srv.testKey(7));
  assert.equal(r.ok, false);
  assert.match(r.error, /не расшифровался/);
  // Защита вернулась — свой ключ на месте, вход в тестовый и возврат работают.
  h.safe.available = true;
  assert.equal(h.peek("token()"), "good-key");
  await enter(h, srv, srv.testKey(8));
  await h.invoke("settings:switch-back", [], settingsWin(h));
  assert.equal(h.peek("settings.token"), "good-key");
});

test("тестовый на другом сервере — отказ; свой ключ на чужой сервер не уходит", async (t) => {
  const { srv, h } = await stand(t);
  const b = await fake.create().listen();
  t.after(() => b.close());
  b.token = "other-server-key";
  const err = await errOf(h.invoke("settings:login", [{ server: b.url, login: "test-ab12cd", password: "testpass" }], settingsWin(h)));
  assert.match(err, /только на том же сервере/);
  assert.equal(h.peek("settings.server"), srv.url);
  assert.equal(h.peek("settings.token"), "good-key");
  assert.deepEqual(b.logouts, ["key-1"], "ключ тестового на чужом сервере не закрыт");
  assert.deepEqual(authOf(b, "good-key"), [], "свой ключ ушёл на чужой сервер");
});

test("свой отложенный ключ проверяется и встаёт только на своём сервере (homeServer), даже если адрес сменился", async (t) => {
  const { srv, h } = await stand(t);
  const b = await fake.create().listen();
  t.after(() => b.close());
  const key = srv.testKey(7);
  await enter(h, srv, key);
  assert.equal(h.disk().homeServer, srv.url, "сервер своего ключа не отложен");
  assert.ok(!("homeServer" in (await h.invoke("settings:get"))), "окну ушёл отложенный сервер");
  h.peek(`settings.server = ${JSON.stringify(b.url)}`); // адрес сменился (старый файл, правка руками)
  const s = await h.invoke("settings:switch-back", [], settingsWin(h));
  assert.equal(s.loginStale, false);
  assert.equal(h.peek("settings.token"), "good-key");
  assert.equal(h.peek("settings.server"), srv.url, "адрес своего сервера не вернулся");
  assert.deepEqual(authOf(b, "good-key"), [], "свой ключ ушёл на чужой сервер");
  assert.ok(authOf(srv, "good-key").some((r) => r.path === "/api/me"), "свой ключ не проверен на своём сервере");
});

test("на диске не бывает тестового ключа без своего: одна запись; «сирота» homeTokenEnc без теста убирается и не подменяет свой ключ", async (t) => {
  const { srv, h } = await stand(t, { extra: { homeTokenEnc: Buffer.from("ENC:old-key").toString("base64") } });
  srv.sessions.push({ token: "old-key" });
  assert.equal((await h.invoke("settings:get")).hasHome, false, "сирота виден как отложенный ключ");
  const snaps = [];
  h.peek(`saveSettings = ((s) => () => { s(); globalThis.__snap(JSON.parse(require("node:fs").readFileSync(settingsFile(), "utf8"))); })(saveSettings)`);
  globalThis.__snap = (d) => snaps.push(d);
  t.after(() => { delete globalThis.__snap; });
  const key = srv.testKey(7);
  await enter(h, srv, key);
  await h.invoke("settings:login", [{ server: srv.url, login: "test-ab12cd", password: "testpass" }], settingsWin(h)); // тест → тест
  await h.invoke("settings:switch-back", [], settingsWin(h));
  assert.equal(h.peek("settings.token"), "good-key", "возврат положил старый ключ-сироту вместо своего");
  for (const d of snaps) {
    assert.ok(!d.testId || dec(d.homeTokenEnc) === "ENC:good-key", `на диске тест без своего ключа: ${JSON.stringify(d)}`);
    assert.ok(d.testId || !d.homeTokenEnc, `на диске отложенный ключ без теста: ${JSON.stringify(d)}`);
  }
});

test("сирота homeTokenEnc в файле без testId — убран при запуске", async (t) => {
  const { h } = await stand(t, { extra: { homeTokenEnc: Buffer.from("ENC:old-key").toString("base64"), homeServer: "https://old.example" } });
  assert.equal(h.peek("settings.homeTokenEnc"), undefined);
  assert.equal(h.peek("settings.homeServer"), undefined);
});

test("возврат: сайт получает свой ключ раньше, чем тестовый закрыт; «вышли» старой страницы до перезагрузки — не выход", async (t) => {
  const { srv, h } = await stand(t);
  const key = srv.testKey(7);
  await enter(h, srv, key);
  const s = site(h, srv, "/");
  h.send("site-login:get", [], s.win, s.url);
  let jsAtLogout = -1;
  const push = srv.logouts.push.bind(srv.logouts);
  srv.logouts.push = (k) => { jsAtLogout = h.mainWin().js.filter((c) => c.includes('"good-key"')).length; return push(k); };
  await h.invoke("settings:switch-back"); // из виджета: окно сайта остаётся сайтом
  assert.ok(jsAtLogout > 0, "тестовый ключ закрыт раньше, чем сайт получил свой");
  // Старая страница поймала 401 на тестовом ключе и стёрла вход — до перезагрузки: программа не выходит.
  h.send("site-login:keep", [""], s.win, s.url);
  await h.wait(50);
  assert.equal(h.peek("settings.token"), "good-key", "выход старой страницы выкинул из своего аккаунта");
  assert.equal(h.peek("loginStale"), false);
  // Новая страница взяла ключ программы — дальше «Выйти» снова выход.
  assert.equal(h.send("site-login:get", [], s.win, s.url), "good-key");
  h.send("site-login:keep", [""], s.win, s.url);
  assert.equal(h.peek("settings.token"), "");
});

test("меню значка: свой ключ не отложен — «выйти из тестового», а не «вернуться в свой аккаунт»", async (t) => {
  const srv = await fake.create().listen();
  const h = boot({ settings: { server: srv.url, tracker: { enabled: false, iconsVer: 2 } } });
  await h.ready();
  t.after(async () => { h.stop(); await srv.close(); });
  await h.invoke("settings:login", [{ server: srv.url, login: "test-ab12cd", password: "testpass" }], settingsWin(h));
  assert.equal(h.peek("settings.testId"), 7);
  const item = h.menus.at(-1)?.find((x) => /^Тест #7/.test(x.label ?? ""));
  assert.equal(item?.label, "Тест #7 — выйти из тестового");
});
