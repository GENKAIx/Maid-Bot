// Падения программы (src/crashes.js, админка «Падения»): место — путь внутри программы без диска и папки пользователя; сообщение
// не уходит (только отпечаток, одинаковый для одинаковых ошибок с разными числами и строками); одинаковые склеиваются; пачка — не
// больше CRASH_BATCH записей и не чаще CRASH_EVERY_MS; нет связи — повтор, но не больше CRASH_TRIES раз; 400/401/404 — выброшено;
// остаток при выходе — в файл и обратно со следующим запуском; поля пачки — ровно белый список сервера (server/src/crashes.ts).
// Плюс electron-updater: stagingPercentage из latest.yml — как его читает AppUpdater (нет поля — все, 0 — никто, 100 — все).
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createCrashes, placeOf, fingerprint, kindOf, appRelative, CRASH_EVERY_MS, CRASH_BATCH, CRASH_KEYS, CRASH_TRIES } = require("../src/crashes.js");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const root = path.join(__dirname, "..", "..");

// 1. Место: путь от папки программы, без C:\Users\<имя>; чужие кадры (Node, Electron, node_modules) пропускаются.
const APP = "C:\\Users\\Аня Петрова\\AppData\\Local\\Programs\\Горничная\\resources\\app.asar";
const mainStack = [
  "TypeError: Cannot read properties of undefined (reading 'Аня')",
  "    at node:internal/process/task_queues:95:5",
  `    at Object.<anonymous> (${APP}\\node_modules\\electron-updater\\out\\AppUpdater.js:10:2)`,
  `    at saveSettings (${APP}\\src\\main.js:1190:17)`,
  `    at ${APP}\\src\\updates.js:5:1`,
].join("\n");
check(placeOf(mainStack, APP) === "src/main.js:1190:17", `место main: ${placeOf(mainStack, APP)}`);
const enc = "file:///C:/Users/%D0%90%D0%BD%D1%8F/AppData/Local/Programs/%D0%93%D0%BE%D1%80%D0%BD%D0%B8%D1%87%D0%BD%D0%B0%D1%8F/resources/app.asar/renderer/habitparty.js";
const rStack = `TypeError: x is not a function\n    at party (${enc}:212:7)\n    at HTMLButtonElement.<anonymous> (${enc}:10:1)`;
check(placeOf(rStack, APP) === "renderer/habitparty.js:212:7", `место окна (file://, %-кодировка): ${placeOf(rStack, APP)}`);
const dev = "E:\\Users\\Аня\\Desktop\\Горничная бот\\desktop";
check(placeOf(`Error: x\n    at f (${dev}\\src\\usage.js:3:4)`, dev) === "src/usage.js:3:4", "из исходников — от папки desktop");
check(placeOf("Error: x\n    at f (C:\\Users\\Аня\\other\\src\\main.js:1:1)", APP) === "-", "файл вне программы — не место");
check(placeOf(`Error\n    at f (${APP}\\src\\..\\..\\secret.js:1:1)`, APP) === "-", "выход из папки — не место");
check(placeOf("", APP) === "-" && placeOf(undefined, APP) === "-", "нет стека — «-»");
check(appRelative(`${APP}/renderer/widget.js`, "") === "renderer/widget.js", "без папки — по app.asar/");
for (const s of [mainStack, rStack]) {
  const p = placeOf(s, APP);
  check(!/Users|Аня|[A-Z]:|%|\\/.test(p), `в месте нет пути ПК: ${p}`);
}

// 2. Отпечаток: одинаковый у одинаковых ошибок с разными числами, строками, путями; разный у разных; само сообщение не угадывается.
const f1 = fingerprint("Cannot read properties of undefined (reading 'Аня')");
check(/^[0-9a-f]{12}$/.test(f1), "отпечаток — 12 знаков");
check(f1 === fingerprint("Cannot read properties of undefined (reading 'Петя')"), "строки в кавычках не меняют отпечаток");
check(fingerprint("timeout after 1200 ms at C:\\Users\\Аня\\x.txt") === fingerprint("timeout after 90 ms at C:\\Users\\Петя\\y.txt"), "числа и пути не меняют отпечаток");
check(f1 !== fingerprint("x is not a function"), "разные ошибки — разные отпечатки");
check(fingerprint("") === "", "пусто — пусто");
check(kindOf(new TypeError("x")) === "TypeError" && kindOf(new RangeError("x")) === "RangeError", "тип — имя класса");
check(kindOf("строка") === "NonError" && kindOf({ name: "Bad Name: Аня" }) === "NonError", "не ошибка и странное имя");

// 3. Белый список полей — тот же, что берёт сервер (crashItem): version, process, kind, place, fp, count — и процессы те же.
const server = fs.readFileSync(path.join(root, "server", "src", "crashes.ts"), "utf8");
const sProcs = (server.match(/CRASH_PROCESSES = \[([^\]]+)\]/)?.[1] ?? "").match(/"[^"]+"/g)?.map((x) => x.slice(1, -1)) ?? [];
const mine = fs.readFileSync(path.join(root, "desktop", "src", "crashes.js"), "utf8");
const cProcs = (mine.match(/PROCESSES = \[([^\]]+)\]/)?.[1] ?? "").match(/"[^"]+"/g)?.map((x) => x.slice(1, -1)) ?? [];
check(sProcs.length > 0 && JSON.stringify(sProcs) === JSON.stringify(cProcs), `процессы расходятся с сервером: ${sProcs} ≠ ${cProcs}`);
const sMax = Number(server.match(/CRASH_MAX_ITEMS = (\d+)/)?.[1]);
check(CRASH_BATCH <= sMax, `пачка ${CRASH_BATCH} больше, чем берёт сервер (${sMax})`);
// Окна и main ловят ошибки: common.js первым в окнах, preload отдаёт maid.crash, main — uncaughtException и падения процессов.
const common = fs.readFileSync(path.join(root, "desktop", "renderer", "common.js"), "utf8");
check(/addEventListener\("error"/.test(common) && /addEventListener\("unhandledrejection"/.test(common) && common.includes("maid?.crash?.("), "common.js ловит ошибки окна");
for (const page of ["widget.html", "quick.html", "index.html"]) {
  const html = fs.readFileSync(path.join(root, "desktop", "renderer", page), "utf8");
  check([...html.matchAll(/<script\s+src="([^"]+)"/g)][0]?.[1] === "common.js", `${page}: common.js — первым скриптом`);
}
check(fs.readFileSync(path.join(root, "desktop", "src", "preload.js"), "utf8").includes('crash: (e) => ipcRenderer.send("crash"'), "preload: maid.crash");
const main = fs.readFileSync(path.join(root, "desktop", "src", "main.js"), "utf8");
for (const s of ['crashes?.error(e, "main")', 'app.on("render-process-gone"', "crashes?.gone(", '"/api/events/crash"', "crashes?.drop()", "crashes?.atQuit()", "crashes?.save()"]) check(main.includes(s), `main.js: ${s}`);

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maid-crash-"));
  const file = path.join(dir, "crashes.json");
  let t = 1_000_000;
  const sent = [];
  let answer = null; // null — 200; число — ошибка со статусом; "off" — нет связи
  const send = async (body) => {
    sent.push(JSON.parse(JSON.stringify(body)));
    if (answer === "off") throw new Error("нет связи с сервером");
    if (typeof answer === "number") throw Object.assign(new Error(`сервер ${answer}`), { status: answer });
    return { ok: true };
  };
  const mk = () => createCrashes({ send, file, appDir: APP, version: "0.1.93", now: () => t });
  const c = mk();

  // Склейка: одна ошибка 5 раз — одна запись со счётом 5; падение окна — тип из причины, «clean-exit» — не падение.
  for (let i = 0; i < 5; i++) c.error(Object.assign(new TypeError(`Cannot read 'п${i}'`), { stack: mainStack }), "main");
  c.error(Object.assign(new TypeError("x"), { stack: rStack }), "widget");
  c.gone("widget", "crashed");
  c.gone("gpu", "clean-exit");
  check(c.peek().length === 3, `записей ${c.peek().length}, ждали 3`);
  check(c.peek()[0].count === 5, "одинаковые склеены");
  check(c.gone("browser", "crashed") === false, "незнакомый процесс не берётся");

  await c.flush();
  check(sent.length === 1 && sent[0].items.length === 3, "пачка ушла");
  const keys = [...new Set(sent[0].items.flatMap((x) => Object.keys(x)))].sort().join(",");
  check(keys === "count,fp,kind,place,process,version", `поля пачки — только белый список: ${keys}`);
  const txt = JSON.stringify(sent[0]);
  check(!/Аня|Петя|Users|Cannot|AppData|п\d/.test(txt), `в пачке нет текста и путей: ${txt}`);
  check(sent[0].items.find((x) => x.process === "widget" && x.kind === "crashed").place === "-", "падение окна — без места");

  // Не чаще CRASH_EVERY_MS: новая ошибка сразу — ждёт.
  c.error(new Error("y"), "main");
  await c.flush();
  check(sent.length === 1, "вторая пачка раньше срока не уходит");
  t += CRASH_EVERY_MS;
  await c.flush();
  check(sent.length === 2, "через 10 минут — уходит");

  // Пачка — не больше CRASH_BATCH записей; остальное — со следующей.
  for (let i = 0; i < CRASH_BATCH + 5; i++) c.error({ name: `E${i}`, message: "m", stack: "" }, "main");
  t += CRASH_EVERY_MS;
  await c.flush();
  check(sent.at(-1).items.length === CRASH_BATCH && c.peek().length === 5, `пачка ${sent.at(-1).items.length}, осталось ${c.peek().length}`);
  t += CRASH_EVERY_MS;
  await c.flush();
  check(!c.pending(), "остаток ушёл следующей пачкой");
  // В памяти — не больше CRASH_KEYS записей.
  for (let i = 0; i < CRASH_KEYS + 30; i++) c.error({ name: `K${i}`, message: "", stack: "" }, "main");
  check(c.peek().length === CRASH_KEYS, `в памяти ${c.peek().length}`);
  t += CRASH_EVERY_MS;
  answer = 400;
  while (c.pending()) { t += CRASH_EVERY_MS; await c.flush(); }
  check(true, "400 — выброшено");

  // Нет связи — запись остаётся, но не больше CRASH_TRIES попыток.
  answer = "off";
  c.error(new Error("z"), "main");
  const before = sent.length;
  for (let i = 0; i < CRASH_TRIES + 3; i++) { t += CRASH_EVERY_MS; await c.flush(); }
  check(sent.length - before === CRASH_TRIES && !c.pending(), `попыток ${sent.length - before}, ждали ${CRASH_TRIES}`);
  answer = 429;
  c.error(new Error("w"), "main");
  t += CRASH_EVERY_MS;
  await c.flush();
  check(c.pending() && c.peek()[0].tries === 1, "429 — оставить, попытка посчитана");
  answer = 404;
  t += CRASH_EVERY_MS;
  await c.flush();
  check(!c.pending(), "404 (старый сервер) — выброшено");

  // Выход: не ушло — в файл с версией той сборки; новый запуск (уже другая версия) берёт его и шлёт как было, файл удалён.
  answer = "off";
  c.error(Object.assign(new TypeError("q"), { stack: rStack }), "quick");
  await c.atQuit();
  check(fs.existsSync(file) && !c.pending(), "остаток — в файле");
  check(!fs.readFileSync(file, "utf8").includes("Аня"), "в файле нет имени из пути");
  answer = null;
  const c2 = createCrashes({ send, file, appDir: APP, version: "0.1.94", now: () => t });
  check(!fs.existsSync(file), "файл удалён после чтения");
  check(c2.peek().length === 1 && c2.peek()[0].version === "0.1.93" && c2.peek()[0].process === "quick", "со следующим запуском — та же запись, версия падения");
  await c2.flush(true);
  check(!c2.pending(), "ушла");
  // Выход: atQuit записал файл, до will-quit случилась ещё ошибка — второй save() дописывает, а не затирает записанное.
  answer = "off";
  const at = (line) => Object.assign(new Error("e"), { stack: `Error: e\n    at f (${APP}\\src\\main.js:${line}:1)` });
  const c3 = createCrashes({ send, file, appDir: APP, version: "0.1.94", now: () => t });
  for (const line of [11, 12, 13]) c3.error(at(line), "main");
  await c3.atQuit();
  const first = JSON.parse(fs.readFileSync(file, "utf8")).items.length;
  c3.error(at(14), "main"); // unhandledRejection между before-quit и will-quit
  c3.save();
  const both = JSON.parse(fs.readFileSync(file, "utf8")).items;
  check(first === 3 && both.length === 4, `второй save() сливает с файлом: было ${first}, стало ${both.length}`);
  c3.error(at(11), "main"); // та же ошибка, что уже в файле, — счёт складывается, строка не дублируется
  c3.save();
  const again = JSON.parse(fs.readFileSync(file, "utf8")).items;
  check(again.length === 4 && again.find((x) => x.place === "src/main.js:11:1")?.count === 2, "повтор — та же строка, счёт 2");
  answer = null;
  const c4 = createCrashes({ send, file, appDir: APP, version: "0.1.94", now: () => t });
  check(c4.peek().length === 4, "следующий запуск видит все записи");
  await c4.flush(true);
  check(!c4.pending() && !fs.existsSync(file), "ушли, файла нет");
  c2.error(new Error("a"));
  c2.drop();
  check(!c2.pending(), "выход из аккаунта — выброшено");
  fs.writeFileSync(file, "не json");
  check(!createCrashes({ send, file, appDir: APP, version: "0.1.94" }).pending() && !fs.existsSync(file), "испорченный файл — без падений");

  // electron-updater: stagingPercentage — как его читает AppUpdater (тот же код, что в программе).
  const { AppUpdater } = require("electron-updater/out/AppUpdater.js");
  const yaml = require("js-yaml");
  const silent = { info() {}, warn() {}, error() {}, debug() {} };
  const fake = (id, current = "0.1.92") => {
    const u = Object.create(AppUpdater.prototype);
    u._logger = silent;
    u.stagingUserIdPromise = { value: Promise.resolve(id) };
    u._isUserWithinRollout = (info) => u.isStagingMatch(info);
    u._isUpdateSupported = () => true;
    u.currentVersion = current; // строкой: semver внутри electron-updater свой
    u.allowDowngrade = false;
    return u;
  };
  const LOW = "00000000-0000-4000-8000-000000000001"; // доля ≈ 0
  const HIGH = "00000000-0000-4000-8000-0000ffffff00"; // доля ≈ 1
  const MID = "00000000-0000-4000-8000-00004ccccccc"; // доля 0,3
  const yml = (p) => yaml.load(`version: 0.1.93\npath: Gornichnaya-Setup-0.1.93.exe\n${p == null ? "" : `stagingPercentage: ${p}\n`}`);
  const can = (id, p, cur) => fake(id, cur).isUpdateAvailable(yml(p));
  check(await can(HIGH, null) === true && await can(LOW, null) === true, "нет stagingPercentage — обновление видят все");
  check(await can(LOW, 0) === false && await can(HIGH, 0) === false, "0 — никто (пауза)");
  check(await can(LOW, 20) === true && await can(MID, 20) === false && await can(MID, 50) === true && await can(HIGH, 99) === false, "20/50/99% — по stagingUserId");
  check(await can(HIGH, 100) === true, "100 — все");
  check(await can(LOW, 100, "0.1.93") === false, "уже на этой версии — не ставит снова");
  check(await can(LOW, 100, "0.1.94") === false, "новее, чем в latest.yml, — не откатывает");
  check(yml(20).stagingPercentage === 20, "js-yaml отдаёт число");

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(bad ? `${bad} из ${n} проверок не прошли` : `OK: ${n} проверок падений и поэтапного выпуска`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.log("FAIL", e); process.exit(1); });
