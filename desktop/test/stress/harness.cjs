// Стенд для стресс-проверок программы на ПК: настоящий src/main.js запускается без Electron — модуль «electron» подменён
// (окна, экраны, значок у часов, защита Windows), настройки лежат во временной папке, сеть — настоящая (fetch Node).
// Так проверяется логика главного процесса: запросы к серверу, вход, настройки на диске, место виджета на экранах.
// Чего стенд не видит: настоящие окна, масштаб Windows, прозрачность, фокус и мышь — это только на живой программе.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const SRC = path.join(__dirname, "..", "..", "src");

/** Запустить main.js. opts: settings (объект или строка — содержимое settings.json; undefined — файла нет), displays, cursor,
 * argv, encrypt (false — защита Windows недоступна), lock (false — уже запущена другая копия), userData (готовая папка). */
function boot(opts = {}) {
  const userData = opts.userData ?? fs.mkdtempSync(path.join(os.tmpdir(), "maid-stress-"));
  const dir = path.join(userData, "maid-desktop");
  fs.mkdirSync(dir, { recursive: true });
  const settingsFile = path.join(dir, "settings.json");
  if (opts.settings !== undefined) fs.writeFileSync(settingsFile, typeof opts.settings === "string" ? opts.settings : JSON.stringify(opts.settings));

  boot.lastError = null;
  const timers = new Set();
  const T = {
    setTimeout: (f, ms, ...a) => { const t = setTimeout((...x) => { timers.delete(t); f(...x); }, ms, ...a); timers.add(t); return t; },
    setInterval: (f, ms, ...a) => { const t = setInterval(f, ms, ...a); timers.add(t); return t; },
    clearTimeout: (t) => { timers.delete(t); clearTimeout(t); },
    clearInterval: (t) => { timers.delete(t); clearInterval(t); },
  };

  // --- экраны ---
  const screen = new EventEmitter();
  screen.displays = opts.displays ?? [display(1, 0, 0, 1920, 1080)];
  screen.cursor = opts.cursor ?? { x: 100, y: 100 };
  screen.getAllDisplays = () => screen.displays;
  screen.getPrimaryDisplay = () => screen.displays[0];
  screen.getCursorScreenPoint = () => ({ ...screen.cursor });
  screen.getDisplayNearestPoint = (p) => {
    const dist = (d) => {
      const b = d.bounds;
      const dx = Math.max(b.x - p.x, 0, p.x - (b.x + b.width));
      const dy = Math.max(b.y - p.y, 0, p.y - (b.y + b.height));
      return dx * dx + dy * dy;
    };
    return [...screen.displays].sort((a, b) => dist(a) - dist(b))[0];
  };

  // --- окна ---
  const windows = [];
  const sent = []; // всё, что main отправил окнам: { win, channel, args }
  const bus = new EventEmitter(); // «send» — для моста в браузер
  class WebContents extends EventEmitter {
    constructor(win) { super(); this.win = win; this.url = ""; }
    send(channel, ...args) { sent.push({ win: this.win.kind, channel, args }); bus.emit("send", this.win, channel, args); }
    getURL() { return this.url; }
    setWindowOpenHandler() {}
    executeJavaScript(code) { this.win.js.push(code); return Promise.resolve(""); }
    reloadIgnoringCache() { this.win.calls.push("reload"); }
    forcefullyCrashRenderer() { this.win.calls.push("crash"); }
    focus() {}
  }
  class BrowserWindow extends EventEmitter {
    constructor(o = {}) {
      super();
      this.opts = o;
      this.bounds = { x: o.x ?? 0, y: o.y ?? 0, width: o.width ?? 800, height: o.height ?? 600 };
      this.calls = [];
      this.js = [];
      this.destroyed = false;
      this.visible = false;
      this.ignoreMouse = null;
      this.kind = "?";
      this.webContents = new WebContents(this);
      windows.push(this);
    }
    static getAllWindows() { return windows.filter((w) => !w.destroyed); }
    loadFile(f, o) { this.kind = path.basename(f, ".html"); this.webContents.url = "file:///" + f.replace(/\\/g, "/") + (o?.query ? "?" + new URLSearchParams(o.query) : ""); this.calls.push("loadFile:" + path.basename(f)); return Promise.resolve(); }
    loadURL(u) { this.kind = "site"; this.webContents.url = u; this.calls.push("loadURL:" + u); return Promise.resolve(); }
    getBounds() { return { ...this.bounds }; }
    setBounds(b) {
      for (const k of ["x", "y", "width", "height"]) if (b[k] !== undefined && !Number.isFinite(b[k])) throw new TypeError(`setBounds: ${k} = ${b[k]}`);
      this.bounds = { ...this.bounds, ...b };
      this.calls.push("setBounds");
    }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    isFocused() { return false; }
    isFocusable() { return true; }
    restore() {}
    show() { this.visible = true; this.calls.push("show"); }
    showInactive() { this.visible = true; this.calls.push("showInactive"); }
    hide() { this.visible = false; this.calls.push("hide"); }
    focus() { this.calls.push("focus"); }
    moveTop() { this.calls.push("moveTop"); }
    reload() { this.calls.push("reload"); }
    removeMenu() {}
    setAlwaysOnTop(on, lvl) { this.calls.push(`top:${on}:${lvl ?? ""}`); }
    setVisibleOnAllWorkspaces() {}
    setIgnoreMouseEvents(on) { this.ignoreMouse = on; this.calls.push(`ignoreMouse:${on}`); }
    close() {
      const e = { prevented: false, preventDefault() { this.prevented = true; } };
      this.emit("close", e);
      if (e.prevented) return;
      this.destroy();
    }
    destroy() { if (this.destroyed) return; this.destroyed = true; this.emit("closed"); }
  }

  // --- остальной Electron ---
  const ipcMain = new EventEmitter();
  ipcMain.handlers = new Map();
  ipcMain.handle = (ch, fn) => ipcMain.handlers.set(ch, fn);
  const app = new EventEmitter();
  Object.assign(app, {
    isPackaged: Boolean(opts.packaged),
    paths: { appData: userData, userData: dir },
    setPath: (k, v) => { app.paths[k] = v; },
    getPath: (k) => app.paths[k],
    getVersion: () => "0.0.0-stress",
    requestSingleInstanceLock: () => opts.lock !== false,
    // Ошибка запуска (в программе она ушла бы в журнал через unhandledRejection) — в h.bootError, чтобы проверка могла её увидеть.
    whenReady: () => ({ then: (fn) => { ready = ready.then(fn).catch((e) => { boot.lastError = e; proc.emit("unhandledRejection", e); }); return ready; } }),
    quit: () => { app.quitCalled = true; },
    setAppUserModelId() {},
    setLoginItemSettings: (o) => { app.loginItem = o; },
  });
  let ready = Promise.resolve();
  const safe = {
    available: opts.encrypt !== false,
    isEncryptionAvailable: () => safe.available,
    encryptString: (s) => { if (!safe.available) throw new Error("защита Windows недоступна"); return Buffer.from("ENC:" + s, "utf8"); },
    decryptString: (b) => {
      const s = b.toString("utf8");
      if (!safe.available || !s.startsWith("ENC:")) throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString.");
      return s.slice(4);
    },
  };
  const shortcuts = new Map();
  const globalShortcut = {
    taken: new Set(opts.takenKeys ?? []),
    register: (k, fn) => { if (globalShortcut.taken.has(k)) return false; shortcuts.set(k, fn); return true; },
    isRegistered: (k) => shortcuts.has(k),
    unregisterAll: () => shortcuts.clear(),
  };
  const powerMonitor = new EventEmitter();
  powerMonitor.getSystemIdleTime = () => opts.idle ?? 0;
  powerMonitor.getSystemIdleState = () => "active";
  const menus = [];
  const opened = [];
  const electron = {
    app, BrowserWindow, ipcMain, screen, safeStorage: safe, globalShortcut, powerMonitor,
    Tray: class { setToolTip() {} on() {} setContextMenu(m) { menus.push(m); } },
    Menu: { buildFromTemplate: (t) => t },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true, resize() { return this; } }), createEmpty: () => ({}) },
    Notification: class { show() {} },
    shell: { openExternal: (u) => { opened.push(u); return Promise.resolve(); } },
    nativeTheme: { shouldUseDarkColors: true },
    session: { defaultSession: { flushStorageData() {}, cookies: { flushStore: async () => {} } } },
  };

  const proc = new EventEmitter();
  Object.assign(proc, { argv: ["electron", ".", ...(opts.argv ?? [])], env: {}, pid: process.pid, execPath: "maid.exe" });
  const fakeGlobal = {};
  const req = (name) => {
    if (name === "electron") return electron;
    if (name === "electron-updater") return { autoUpdater: Object.assign(new EventEmitter(), { setFeedURL() {}, checkForUpdates: async () => null, downloadUpdate: async () => null, quitAndInstall() {} }) };
    if (name.startsWith("./")) {
      const file = path.join(SRC, name);
      const code = fs.readFileSync(file, "utf8");
      const m = { exports: {} };
      new Function("require", "module", "exports", "__dirname", "process", "setTimeout", "setInterval", "clearTimeout", "clearInterval", code)(
        req, m, m.exports, SRC, proc, T.setTimeout, T.setInterval, T.clearTimeout, T.clearInterval);
      return m.exports;
    }
    return require(name);
  };
  const code = fs.readFileSync(path.join(SRC, "main.js"), "utf8") + "\n;return (__code) => eval(__code);";
  // timeScale: во сколько раз короче ждать ответа сервера (90 с и 30 с в main.js) — чтобы проверка «сервер молчит» шла секунды.
  const scale = opts.timeScale ?? 1;
  const Abort = { timeout: (ms) => AbortSignal.timeout(Math.max(1, Math.round(ms / scale))) };
  const peek = new Function("require", "__dirname", "process", "global", "setTimeout", "setInterval", "clearTimeout", "clearInterval", "AbortSignal", code)(
    req, SRC, proc, fakeGlobal, T.setTimeout, T.setInterval, T.clearTimeout, T.clearInterval, Abort);

  const widget = () => windows.find((w) => w.kind === "widget" && !w.destroyed);
  const mainWin = () => peek("mainWin");
  const eventFrom = (win, url) => ({ sender: win?.webContents ?? {}, senderFrame: { url: url ?? win?.webContents.url ?? "" }, returnValue: undefined });
  const h = {
    dir, settingsFile, electron, screen, windows, sent, bus, menus, opened, app, proc, safe, peek, widget, mainWin,
    /** Что лежит в settings.json сейчас (null — нет файла или не JSON). */
    disk: () => { try { return JSON.parse(fs.readFileSync(settingsFile, "utf8")); } catch { return null; } },
    log: () => { try { return fs.readFileSync(path.join(dir, "maid.log"), "utf8"); } catch { return ""; } },
    /** ipcRenderer.invoke из окна win (по умолчанию — виджет). Ошибка — как в Electron: «Error invoking remote method…». */
    invoke: async (channel, args = [], win = widget(), url) => {
      const fn = ipcMain.handlers.get(channel);
      if (!fn) throw new Error(`нет обработчика ${channel}`);
      try { return await fn(eventFrom(win, url), ...args); } catch (e) { throw new Error(`Error invoking remote method '${channel}': ${e}`); }
    },
    /** ipcRenderer.send / sendSync из окна win; возвращает returnValue. */
    send: (channel, args = [], win = widget(), url) => { const e = eventFrom(win, url); ipcMain.emit(channel, e, ...args); return e.returnValue; },
    /** Дать поработать будильникам и обещаниям. */
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    /** Остановить всё, что main завёл (будильники), и стереть временную папку. */
    stop: () => {
      for (const t of timers) { clearTimeout(t); clearInterval(t); }
      timers.clear();
      if (!opts.userData && !opts.keep) fs.rmSync(userData, { recursive: true, force: true });
    },
    timers,
    bootError: () => boot.lastError,
    ready: () => ready.then(() => new Promise((r) => setImmediate(r))),
  };
  return h;
}

/** Монитор: bounds и рабочая область (без панели задач 40 px снизу). */
function display(id, x, y, width, height, taskbar = 40) {
  return { id, bounds: { x, y, width, height }, workArea: { x, y, width, height: height - taskbar }, scaleFactor: 1 };
}

/** Настройки, с которыми программа «уже вошла»: ключ зашифрован подменной защитой, трекер выключен (иначе он смотрит настоящие окна). */
function loggedIn(server, extra = {}) {
  return { server, tokenEnc: Buffer.from("ENC:good-key").toString("base64"), tracker: { enabled: false, iconsVer: 2 }, ...extra, widget: { show: true, ...extra.widget } };
}

module.exports = { boot, display, loggedIn };
