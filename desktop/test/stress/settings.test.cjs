// Стресс-проверки настроек на диске (main.js: loadSettings, saveSettings, settings:set): пустой, битый, чужой и защищённый
// от записи settings.json; ключ, который не расшифровался. Настоящий main.js на стенде (harness.cjs), файлы — во временной папке.
// Пометка todo — найденный баг (номер по отчёту docs/review/стресс-тест-ПК-2026-11-15.html): сейчас не проходит, итог прогона зелёный.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { boot, loggedIn } = require("./harness.cjs");

const SERVER = "https://maid.example";
const errOf = (p) => p.then(() => "", (e) => String(e.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
async function start(t, opts) {
  const h = boot(opts);
  await h.ready();
  t.after(() => { try { fs.chmodSync(h.settingsFile, 0o666); } catch {} h.stop(); });
  return h;
}
/** Любое сохранение настроек, как после перетаскивания виджета. */
const anySave = (h) => h.invoke("settings:set", [{ widget: { opacity: 0.8 } }]);

test("файла нет (первый запуск): настройки по умолчанию, открыто окно входа, виджет на месте", async (t) => {
  const h = await start(t, {});
  assert.equal(h.peek("settings.server"), "http://localhost:3000");
  assert.ok(h.widget());
  assert.equal(h.mainWin()?.kind, "index");
});

test("неизвестные поля в файле (новее или старее версия) не теряются при сохранении", async (t) => {
  const h = await start(t, { settings: loggedIn(SERVER, { future: { a: 1 }, widget: { show: true, newThing: "x" } }) });
  await anySave(h);
  assert.deepEqual(h.disk().future, { a: 1 });
  assert.equal(h.disk().widget.newThing, "x");
});

for (const [name, text] of [["пустой (0 байт)", ""], ["оборван на середине", '{"server":"https://maid.example","tokenEnc":"RU5DOmdvb2Q'], ["null", "null"]]) {
  test(`Б-4: settings.json ${name} — прежний файл не должен молча затираться настройками по умолчанию`, { todo: "Б-4: нет запасной копии; первое же сохранение пишет поверх" }, async (t) => {
    const h = await start(t, { settings: text });
    assert.ok(h.widget(), "виджет при этом запускается");
    await anySave(h);
    const kept = fs.readdirSync(h.dir).filter((f) => /^settings\.json\.(bad|bak)/.test(f));
    assert.ok(kept.length, `копии испорченного файла нет (в папке: ${fs.readdirSync(h.dir)})`);
  });
}

test("Б-4: файл цел, но не прочитался (занят антивирусом или копированием) — вход не должен пропасть насовсем", { todo: "Б-4: ошибка чтения = «настроек нет», следующее сохранение стирает ключ и адрес сервера" }, async (t) => {
  const real = fs.readFileSync;
  fs.readFileSync = (f, ...a) => {
    if (String(f).endsWith("settings.json")) throw Object.assign(new Error("EBUSY: resource busy or locked, open settings.json"), { code: "EBUSY" });
    return real(f, ...a);
  };
  let h;
  try { h = await start(t, { settings: loggedIn(SERVER) }); } finally { fs.readFileSync = real; }
  assert.ok(h.disk().tokenEnc, "до сохранения файл цел");
  await anySave(h);
  assert.ok(h.disk().tokenEnc, "после первого же сохранения ключа в файле нет");
  assert.equal(h.disk().server, SERVER, "адрес сервера заменён на localhost");
});

test("Б-4: settings.json с меткой BOM (сохранён Блокнотом или PowerShell) читается", { todo: "Б-4: JSON.parse не понимает BOM — настройки сбрасываются" }, async (t) => {
  const h = await start(t, { settings: "﻿" + JSON.stringify(loggedIn(SERVER)) });
  assert.equal(h.peek("settings.server"), SERVER);
});

test("Б-5: значения не того типа в файле (правили руками) не роняют запуск — виджет появляется", { todo: "Б-5: keys.quick — число: refreshTray падает до создания виджета" }, async (t) => {
  const h = await start(t, { settings: loggedIn(SERVER, { keys: { quick: 5, grab: null } }) });
  assert.ok(h.widget(), `виджет не создан: ${h.bootError()?.message}`);
});

test("Б-5: место и высота виджета не числом — виджет всё равно создаётся на экране", { todo: "Б-5: x, y, extra из файла идут в размеры окна без проверки" }, async (t) => {
  const h = await start(t, { settings: loggedIn(SERVER, { widget: { show: true, x: "слева", y: {}, extra: "много" } }) });
  const b = h.widget()?.bounds;
  assert.ok(b && Object.values(b).every(Number.isFinite), `размеры окна: ${JSON.stringify(b)}`);
});

test("огромная высота панели в файле не даёт окно выше экрана", { todo: "Б-5: widget.extra из файла не ограничен высотой экрана" }, async (t) => {
  const h = await start(t, { settings: loggedIn(SERVER, { widget: { show: true, extra: 100000 } }) });
  assert.ok(h.widget().bounds.height <= 1080 + 760, `высота окна ${h.widget().bounds.height}`);
});

test("Б-8: файл только для чтения — понятная ошибка, а не «EPERM…»", { todo: "Б-8: saveSettings бросает сырую ошибку Windows во все обработчики" }, async (t) => {
  const h = await start(t, { settings: loggedIn(SERVER) });
  fs.chmodSync(h.settingsFile, 0o444);
  const e = await errOf(anySave(h));
  assert.ok(!/EPERM|EACCES|operation not permitted/.test(e), e);
});

test("Б-8: файл только для чтения — вход из виджета всё равно завершается (ключ в памяти, окна оповещены)", { todo: "Б-8: вход падает на записи: сервер вход выдал, а программа говорит «ошибка»" }, async (t) => {
  const srv = await require("./fake-server.cjs").create().listen();
  const h = await start(t, { settings: loggedIn(srv.url) });
  t.after(() => srv.close());
  fs.chmodSync(h.settingsFile, 0o444);
  const e = await errOf(h.invoke("settings:login", [{ login: "user", password: "pass" }]));
  assert.equal(e, "");
});

test("защита Windows недоступна при запуске: ключ не теряется, запросы ждут, потом идут", async (t) => {
  const srv = await require("./fake-server.cjs").create().listen();
  const h = await start(t, { settings: loggedIn(srv.url), encrypt: false });
  t.after(() => srv.close());
  assert.equal(await errOf(h.invoke("api", ["GET", "/api/today"])), "Ключ ещё не расшифровался (защита Windows) — пробую снова.");
  assert.equal((await h.invoke("settings:get")).hasToken, true);
  await anySave(h);
  assert.ok(h.disk().tokenEnc, "сохранение не стёрло нерасшифрованный ключ");
  h.safe.available = true;
  assert.equal((await h.invoke("api", ["GET", "/api/today"])).tasks.length, 4);
  assert.match(h.log(), /ключ расшифровался с повторной попытки/);
});

test("ключ не из латиницы (старые версии): вход сброшен, виджет просит войти", async (t) => {
  const h = await start(t, { settings: { server: SERVER, tokenEnc: Buffer.from("ENC:пароль").toString("base64"), tracker: { enabled: false, iconsVer: 2 } } });
  assert.equal(await errOf(h.invoke("api", ["GET", "/api/today"])), "вход устарел — войдите снова");
  assert.equal(h.peek("loginStale"), true);
});

test("С-9: испорченный ключ стирается и с диска (а не находится заново при каждом запуске)", { todo: "С-9: loadSettings убирает tokenEnc из настроек уже после того, как token() сохранил файл" }, async (t) => {
  const h = await start(t, { settings: { server: SERVER, tokenEnc: Buffer.from("ENC:пароль").toString("base64"), tracker: { enabled: false, iconsVer: 2 } } });
  assert.equal(h.disk().tokenEnc, undefined);
});

test("старый открытый ключ в файле шифруется при первом запуске", async (t) => {
  const h = await start(t, { settings: { server: SERVER, token: "good-key", tracker: { enabled: false, iconsVer: 2 } } });
  assert.equal(h.disk().token, undefined);
  assert.ok(h.disk().tokenEnc);
});

test("окно не может поменять адрес сервера и ключ через «сохранить настройки»", async (t) => {
  const h = await start(t, { settings: loggedIn(SERVER) });
  await h.invoke("settings:set", [{ server: "https://evil.example", token: "x" }]);
  assert.equal(h.peek("settings.server"), SERVER);
  assert.equal(h.peek("settings.token"), "good-key");
});

test("Б-9: горячая клавиша из окна настроек проверяется — мусор и занятое сочетание не сохраняются молча", { todo: "Б-9: settings:set пишет keys как есть; проверка есть только у сайта (app:general-set)" }, async (t) => {
  const h = await start(t, { settings: loggedIn(SERVER), takenKeys: ["Control+Shift+Escape"] });
  for (const key of ["абракадабра", "", "Control+Shift+Escape", "Alt+Shift+M" /* уже занято «взять виджет» */]) {
    const e = await errOf(h.invoke("settings:set", [{ keys: { quick: key } }], h.mainWin()));
    assert.ok(e || h.peek("settings.keys.quick") !== key, `«${key}» сохранено без ошибки`);
  }
});

test("С-6: «сохранить настройки» принимается только от своих окон", { todo: "С-6: у settings:set, api, notify, grab нет проверки отправителя — защищает только preload" }, async (t) => {
  const h = await start(t, { settings: loggedIn(SERVER) });
  const alien = new h.electron.BrowserWindow();
  alien.loadURL("https://evil.example/");
  await errOf(h.invoke("settings:set", [{ autostart: false, tracker: { enabled: false, games: ["x.exe"] } }], alien));
  assert.notDeepEqual(h.peek("settings.tracker.games"), ["x.exe"]);
});

test("вторая копия программы: закрывается, настройки не трогает, окон не создаёт", async (t) => {
  const first = await start(t, { settings: loggedIn(SERVER) });
  const before = fs.readFileSync(first.settingsFile, "utf8");
  const second = boot({ userData: first.app.paths.appData, lock: false });
  await second.ready();
  t.after(() => second.stop());
  assert.equal(second.app.quitCalled, true);
  assert.equal(second.windows.length, 0);
  assert.equal(fs.readFileSync(first.settingsFile, "utf8"), before);
  first.app.emit("second-instance", {}, ["maid.exe", "--show"]);
  assert.ok(first.mainWin(), "первая копия показывает главное окно");
});

test("запись настроек — через временный файл: оборванная запись не портит прежний", async (t) => {
  const h = await start(t, { settings: loggedIn(SERVER) });
  const real = fs.renameSync;
  fs.renameSync = () => { throw Object.assign(new Error("процесс убит"), { code: "EKILLED" }); };
  try { await errOf(anySave(h)); } finally { fs.renameSync = real; }
  assert.equal(h.disk().server, SERVER);
  assert.ok(h.disk().tokenEnc);
});
