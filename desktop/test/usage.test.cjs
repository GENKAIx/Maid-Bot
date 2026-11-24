// Счётчики фич программы на ПК (src/usage.js, админка «Использование функций»): копия имён совпадает с группой «Виджет»
// белого списка сервера (server/src/feature-list.ts); каждое имя в вызовах maid.track и countUse — из списка;
// пачка уходит одна за раз; 429 и нет связи — счёт остаётся, 404 (старый сервер), 400 и 401 — выбрасывается;
// счёт не больше 500 на имя; остаток при выходе — в файл и со следующим запуском обратно (файл удаляется).
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createUsage, WIDGET_FEATURES, USAGE_CAP } = require("../src/usage.js");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const root = path.join(__dirname, "..", "..");

// 1. Копия списка = имена, которые сервер принимает от программы: группа «Виджет» в том же порядке, и с 24.11.2026 (этап 0
// аналитики) клиентские имена «Первого запуска» (экскурсия) и «Рины» — набором: шаги — TOUR_STEP_NAMES, реакции — ALBUM
// сервера без idle (server/src/feature-list.ts собирает их так же).
const list = fs.readFileSync(path.join(root, "server", "src", "feature-list.ts"), "utf8");
const server = [...list.matchAll(/^\s*widget\("([^"]+)"/gm)].map((m) => m[1]);
check(server.length > 0, "в списке сервера нашлись имена виджета");
check(JSON.stringify(server) === JSON.stringify(WIDGET_FEATURES.filter((x) => x.startsWith("widget."))), `список виджета расходится с сервером: ${server.join(",")} ≠ ${WIDGET_FEATURES.join(",")}`);
const album = fs.readFileSync(path.join(root, "server", "src", "album.ts"), "utf8").match(/export const ALBUM = \[([^\]]+)\]/)?.[1] ?? "";
const serverMoods = [...album.matchAll(/"([^"]+)"/g)].map((m) => m[1]).filter((x) => x !== "idle");
const serverSteps = [...(list.match(/TOUR_STEP_NAMES: \[string, string\]\[\] = \[([^]*?)\n\];/)?.[1] ?? "").matchAll(/\["([^"]+)", "/g)].map((m) => m[1]);
check(serverMoods.length === 40 && serverSteps.length >= 10, `сервер: реакций ${serverMoods.length}, шагов ${serverSteps.length}`);
check(list.includes("...TOUR_STEP_NAMES.map(([id, t]) => onboarding(`onboarding.tour.step.${id}`") && list.includes("...REACT_MOODS.map((m) => rina(`maid.react.${m}`"),
  "сервер собирает имена шагов и реакций не так, как программа");
const serverAll = [
  ...server,
  ...[...list.matchAll(/^\s*onboarding\("([^"]+)",[^\n]*"client"\)/gm)].map((m) => m[1]),
  ...serverSteps.map((id) => `onboarding.tour.step.${id}`),
  ...serverMoods.map((m) => `maid.react.${m}`),
  ...[...list.matchAll(/^\s*rina\("([^"]+)"/gm)].map((m) => m[1]),
].sort();
check(JSON.stringify(serverAll) === JSON.stringify([...WIDGET_FEATURES].sort()),
  `имена программы расходятся с сервером: лишние ${WIDGET_FEATURES.filter((x) => !serverAll.includes(x))}, нет ${serverAll.filter((x) => !WIDGET_FEATURES.includes(x))}`);
check(new Set(WIDGET_FEATURES).size === WIDGET_FEATURES.length, "в списке программы повторы");
// Сервер не берёт пачку больше USAGE_MAX_KEYS имён (400 — и вся пачка выброшена): все имена программы влезают в одну.
const maxKeys = Number(fs.readFileSync(path.join(root, "server", "src", "feature-events.ts"), "utf8").match(/USAGE_MAX_KEYS = (\d+)/)?.[1]);
check(WIDGET_FEATURES.length <= maxKeys, `имён программы ${WIDGET_FEATURES.length} — больше, чем сервер берёт в пачке (${maxKeys})`);

// 2. Каждое имя в коде программы — из списка; каждое имя списка где-то считается.
const files = [path.join(root, "desktop", "src", "main.js"), ...fs.readdirSync(path.join(root, "desktop", "renderer")).filter((f) => f.endsWith(".js")).map((f) => path.join(root, "desktop", "renderer", f))];
const used = new Set();
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  for (const m of src.matchAll(/(?:maid\??\.track\?\.|countUse)\(\s*"([^"]+)"/g)) {
    used.add(m[1]);
    check(WIDGET_FEATURES.includes(m[1]), `${path.basename(f)}: имя «${m[1]}» не в белом списке`);
  }
  // Разветвление в open-section: оба имени строками внутри countUse(… ? "…" : "…").
  for (const m of src.matchAll(/countUse\([^)]*\?\s*"([^"]+)"\s*:\s*"([^"]+)"\)/g)) for (const x of [m[1], m[2]]) used.add(x);
  for (const m of src.matchAll(/track\?\.\(\s*[^"`)]*\?\s*"([^"]+)"\s*:\s*"([^"]+)"\)/g)) for (const x of [m[1], m[2]]) used.add(x);
  // Имя по шаблону (`maid.react.${n}`, `onboarding.tour.step.${s.id}`): в счёт — все имена списка с этим началом.
  for (const m of src.matchAll(/track\?\.\(`([a-z.]+)\$\{/g)) for (const x of WIDGET_FEATURES) if (x.startsWith(m[1])) used.add(x);
}
for (const id of WIDGET_FEATURES) check(used.has(id), `имя «${id}» нигде не считается`);

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maid-usage-"));
  const file = path.join(dir, "usage.json");
  const sent = [];
  let answer = null; // null — 200; число — ошибка с этим статусом; "off" — нет связи
  let hold = null; // обещание, которое держит ответ (вторая пачка, пока первая в пути)
  const send = async (body) => {
    sent.push(JSON.parse(JSON.stringify(body)));
    if (hold) await hold;
    if (answer === "off") throw new Error("нет связи с сервером");
    if (typeof answer === "number") throw Object.assign(new Error(`сервер ${answer}`), { status: answer });
    return { ok: true };
  };
  const logs = [];
  const u = createUsage({ send, file, log: (...a) => logs.push(a.join(" ")) });

  // Незнакомое имя и имена, которые сервер считает сам, — не берутся.
  check(u.count("widget.fold") === true, "знакомое имя берётся");
  check(u.count("voice") === false && u.count("screen.today") === false && u.count("<script>") === false, "чужие имена не берутся");
  for (let i = 0; i < 700; i++) u.count("widget.poke");
  check(u.peek()["widget.poke"] === USAGE_CAP, "не больше 500 на имя");

  await u.flush();
  check(sent.length === 1 && sent[0].counts["widget.fold"] === 1 && sent[0].counts["widget.poke"] === USAGE_CAP, "пачка ушла");
  check(!u.pending(), "после удачной пачки память пуста");
  await u.flush();
  check(sent.length === 1, "пустая пачка не уходит");

  // 429 и нет связи — счёт остаётся и складывается с новым.
  for (const a of [429, "off", 502]) {
    answer = a;
    u.count("widget.tour");
    await u.flush();
    check(u.pending(), `${a}: счёт остался`);
  }
  check(u.peek()["widget.tour"] === 3, "три неудачных пачки — счёт 3");
  // 404 (старый сервер), 400, 401 — выбросить, молча (строка в журнал программы).
  for (const a of [404, 400, 401]) {
    answer = a;
    u.count("widget.drag");
    await u.flush();
    check(!u.pending(), `${a}: пачка выброшена`);
  }
  check(logs.length === 3 && logs.every((l) => !/widget\./.test(l)), "в журнале — только статус, без имён");

  // Одна пачка за раз: вторая, пока первая в пути, не уходит.
  answer = null;
  let release;
  hold = new Promise((r) => (release = r));
  u.count("widget.main");
  const a = u.flush();
  u.count("widget.section");
  const b = u.flush();
  check(sent.length === 8 && a === b, "вторая пачка ждёт первую");
  release();
  hold = null;
  await a;
  check(u.peek()["widget.section"] === 1, "новый счёт — до следующей пачки");

  // Выход без связи: остаток — в файл, новая копия берёт его и удаляет файл.
  answer = "off";
  await u.atQuit();
  check(!u.pending() && fs.existsSync(file), "не ушло при выходе — в файле");
  check(JSON.parse(fs.readFileSync(file, "utf8")).counts["widget.section"] === 1, "в файле — счёт");
  const u2 = createUsage({ send, file });
  check(u2.peek()["widget.section"] === 1 && !fs.existsSync(file), "следующий запуск взял остаток и удалил файл");
  // Испорченный файл и чужие имена в нём — без ошибки, чужое не берётся.
  fs.writeFileSync(file, JSON.stringify({ counts: { "widget.fold": 9999, "voice": 3, "widget.x": 1 } }));
  const u3 = createUsage({ send, file });
  check(JSON.stringify(u3.peek()) === JSON.stringify({ "widget.fold": USAGE_CAP }), "из файла — только знакомые, со срезом");
  fs.writeFileSync(file, "{не json");
  const u4 = createUsage({ send, file });
  check(!u4.pending() && !fs.existsSync(file), "испорченный файл — пусто, файл удалён");

  // Выход, когда сервер молчит: ждём не дольше USAGE_QUIT_MS (здесь — висящая пачка), остаток — в файл.
  answer = null;
  hold = new Promise(() => {});
  const u5 = createUsage({ send, file });
  u5.count("widget.quick");
  const t0 = Date.now();
  await u5.atQuit();
  check(Date.now() - t0 < 6000, "выход не ждёт висящий сервер дольше нескольких секунд");
  check(JSON.parse(fs.readFileSync(file, "utf8")).counts["widget.quick"] === 1, "пачка без ответа — в файле, не потеряна");

  // Вышли или вошли другим ключом: счёт, файл и пачка в пути — выброшены (неудача той пачки счёт не вернёт).
  answer = 429;
  let free;
  hold = new Promise((r) => (free = r));
  const u6 = createUsage({ send, file });
  u6.count("widget.inbox");
  const inAir = u6.flush();
  u6.count("widget.hints");
  fs.writeFileSync(file, JSON.stringify({ counts: { "widget.fold": 2 } }));
  u6.drop();
  free();
  hold = null;
  await inAir;
  check(!u6.pending() && !fs.existsSync(file), "после смены входа — ни счёта, ни файла");

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(bad ? `${bad} из ${n} проверок упали` : `OK: ${n} проверок счётчиков фич`);
  process.exit(bad ? 1 : 0);
})();
