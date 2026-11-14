// Трекер ПК — свой, без сторонних программ: раз в 5 с смотрит, какая программа на переднем плане (функции Windows через koffi)
// и трогали ли мышь и клавиатуру (powerMonitor, передаёт main.js). Время в программах — только пока человек за компьютером:
// простой дольше AFK_SEC или заблокированный экран — «отошёл» (afk). День копится в файле <dir>/ГГГГ-ММ-ДД.json (сон ПК,
// перезапуск программы его не стирают), хранятся последние KEEP_DAYS дней. Игры — по списку имён программ из настроек.
// До 0.1.37 время читалось из ActivityWatch (localhost:5600) — его нужно было ставить отдельно.

const fs = require("node:fs");
const path = require("node:path");

const STEP_MS = 5000;
const AFK_SEC = 180; // как у ActivityWatch: 3 минуты без мыши и клавиатуры — отошёл
const GAP_MS = 15_000; // между замерами дольше — сон ПК или зависание: этот промежуток не считается
const HOLD_SEC = 10; // простой с этой секунды копится отдельно: вернулся до AFK_SEC — это время программы, нет — afk
const KEEP_DAYS = 7;

function localDay(t = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
}

function isGame(app, games) {
  const a = app.toLowerCase();
  return games.some((g) => g && a === g.toLowerCase().trim());
}

// --- программа на переднем плане (Windows) ---
let win32 = null; // функции Windows, загружаются при первом замере
function loadWin32() {
  const koffi = require("koffi");
  const user32 = koffi.load("user32.dll");
  const kernel32 = koffi.load("kernel32.dll");
  return {
    foreground: user32.func("void* __stdcall GetForegroundWindow()"),
    threadPid: user32.func("uint32 __stdcall GetWindowThreadProcessId(void* hWnd, _Out_ uint32* pid)"),
    open: kernel32.func("void* __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)"),
    imageName: kernel32.func("bool __stdcall QueryFullProcessImageNameW(void* h, uint32 flags, _Out_ uint16* buf, _Inout_ uint32* size)"),
    close: kernel32.func("bool __stdcall CloseHandle(void* h)"),
  };
}

/** Программа на переднем плане: { name: "chrome", path: "C:\…\chrome.exe" }; окна нет — null; путь не отдали (защищённый процесс) — name "?". */
function foreground() {
  if (process.platform !== "win32") return null;
  win32 ??= loadWin32();
  const hwnd = win32.foreground();
  if (!hwnd) return null;
  const pid = [0];
  win32.threadPid(hwnd, pid);
  if (!pid[0]) return null;
  const h = win32.open(0x1000, false, pid[0]); // PROCESS_QUERY_LIMITED_INFORMATION
  if (!h) return { name: "?", path: "" };
  try {
    const buf = Buffer.alloc(2 * 1024);
    const size = [1024];
    if (!win32.imageName(h, 0, buf, size)) return { name: "?", path: "" };
    const full = buf.toString("utf16le", 0, size[0] * 2);
    return { name: path.basename(full).replace(/\.exe$/i, "") || "?", path: full };
  } finally {
    win32.close(h);
  }
}

// --- учёт ---
/**
 * Учёт дня. idle() → { sec, locked } (powerMonitor), fg() → программа на переднем плане (foreground), now() → мс.
 * tick() — замер (раз в STEP_MS), save() — записать день в файл, summary(day, games) — день для POST /api/activity,
 * paths(day) — пути к exe программ дня (для значков).
 */
function createTracker({ dir, idle, fg = foreground, now = Date.now, log = () => {} }) {
  let cur = null; // { day, apps: { имя: сек }, afk: сек, paths: { имя: путь } }
  let last = 0; // время прошлого замера
  let held = null; // простой, ещё не решено чей: { app, sec }
  let dirty = false;
  let fgFailed = false;

  const file = (day) => path.join(dir, `${day}.json`);
  const read = (day) => {
    try {
      const d = JSON.parse(fs.readFileSync(file(day), "utf8"));
      return { day, apps: d.apps ?? {}, afk: d.afk ?? 0, paths: d.paths ?? {} };
    } catch {
      return { day, apps: {}, afk: 0, paths: {} };
    }
  };
  const add = (app, sec) => (cur.apps[app] = (cur.apps[app] ?? 0) + sec);
  // Простой закончился (back — вернулся до AFK_SEC) или стал «отошёл»: решить, куда его время.
  const settle = (back) => {
    if (!held) return;
    if (back) add(held.app, held.sec);
    else cur.afk += held.sec;
    held = null;
  };

  function save() {
    if (!cur || !dirty) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = file(cur.day) + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ apps: cur.apps, afk: cur.afk, paths: cur.paths }));
      fs.renameSync(tmp, file(cur.day));
      dirty = false;
    } catch (e) {
      log("трекер: день не записался:", e?.message ?? e);
    }
  }

  function prune() {
    try {
      const keep = new Set();
      for (let i = 0; i < KEEP_DAYS; i++) keep.add(localDay(new Date(now() - i * 86_400_000)));
      for (const f of fs.readdirSync(dir)) {
        const m = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(f);
        if (m && !keep.has(m[1])) fs.rmSync(path.join(dir, f), { force: true });
      }
    } catch {
      // папки ещё нет
    }
  }

  function tick() {
    const t = now();
    const day = localDay(new Date(t));
    if (cur?.day !== day) {
      if (cur) {
        settle(false);
        dirty = true;
        save();
      }
      cur = read(day);
      prune();
    }
    const dt = last && t - last <= GAP_MS ? (t - last) / 1000 : 0;
    last = t;
    const { sec: idleSec, locked } = idle();
    if (locked || idleSec >= AFK_SEC) {
      settle(false); // что копилось в простое — тоже afk
      cur.afk += dt;
      dirty ||= dt > 0;
      return;
    }
    let app;
    try {
      app = fg();
      fgFailed = false;
    } catch (e) {
      if (!fgFailed) log("трекер: не узнать программу на переднем плане:", e?.message ?? e);
      fgFailed = true;
      app = null;
    }
    const name = app?.name ?? "?";
    if (app?.path && !cur.paths[name]) cur.paths[name] = app.path;
    if (idleSec >= HOLD_SEC) {
      // не трогают — пока непонятно, читает человек или ушёл
      if (held && held.app !== name) settle(true);
      held ??= { app: name, sec: 0 };
      held.sec += dt;
    } else {
      settle(true);
      add(name, dt);
    }
    dirty ||= dt > 0;
  }

  /** День в виде для сервера (как раньше из ActivityWatch); простой без решения в итог пока не идёт. */
  function summary(day, games = []) {
    const d = cur?.day === day ? cur : read(day);
    const list = Object.entries(d.apps)
      .map(([name, sec]) => ({ name, sec: Math.round(sec) }))
      .filter((x) => x.sec >= 60)
      .sort((a, b) => b.sec - a.sec);
    const gameNames = games.map((g) => g.replace(/\.exe$/i, ""));
    return {
      day,
      source: "pc",
      active_sec: Math.min(86400, list.reduce((s, x) => s + x.sec, 0)),
      afk_sec: Math.min(86400, Math.round(d.afk)),
      apps: list.filter((x) => !isGame(x.name, gameNames)).slice(0, 30),
      games: list.filter((x) => isGame(x.name, gameNames)),
    };
  }

  const paths = (day) => new Map(Object.entries((cur?.day === day ? cur : read(day)).paths));

  return { tick, save, summary, paths };
}

module.exports = { createTracker, foreground, localDay, STEP_MS };
