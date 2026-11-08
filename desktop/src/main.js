// Горничная на ПК: главное окно, виджет поверх всех окон, быстрый ввод, трей, трекер ПК.
// Ключ и адрес сервера хранятся в userData/settings.json; запросы к серверу идут только отсюда.

const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, screen, nativeImage, Notification } = require("electron");
const { collectDay, localDay } = require("./activity.js");

const DEFAULTS = {
  server: "http://localhost:3000",
  token: "",
  widget: { show: true, x: null, y: null, display: null, opacity: 0.92 },
  tracker: { enabled: true, games: ["dota2.exe", "cs2.exe", "VALORANT-Win64-Shipping.exe", "League of Legends.exe", "GenshinImpact.exe", "Minecraft.Windows.exe"] },
  keys: { quick: "Alt+Shift+Space", grab: "Alt+Shift+M" },
};

const settingsFile = () => path.join(app.getPath("userData"), "settings.json");
let settings = structuredClone(DEFAULTS);
function loadSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    settings = { ...DEFAULTS, ...s, widget: { ...DEFAULTS.widget, ...s.widget }, tracker: { ...DEFAULTS.tracker, ...s.tracker }, keys: { ...DEFAULTS.keys, ...s.keys } };
  } catch {
    settings = structuredClone(DEFAULTS);
  }
}
function saveSettings() {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
}

async function api(method, p, body) {
  if (!settings.token) throw new Error("Нет ключа: напишите боту /token и вставьте его в настройках.");
  const res = await fetch(settings.server.replace(/\/$/, "") + p, {
    method,
    headers: { Authorization: `Bearer ${settings.token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(90_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `сервер ${res.status}`);
  return data;
}

let mainWin = null;
let widget = null;
let quick = null;
let tray = null;
let grabbed = false;
let quitting = false;

const icon = () => nativeImage.createFromPath(path.join(__dirname, "..", "assets", "icon.png"));
const page = (name) => path.join(__dirname, "..", "renderer", name);
const prefs = { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true };

function showMain() {
  if (!mainWin) {
    mainWin = new BrowserWindow({ width: 980, height: 720, minWidth: 640, minHeight: 480, title: "Горничная", icon: icon(), backgroundColor: "#1d1b22", webPreferences: prefs });
    mainWin.removeMenu();
    mainWin.loadFile(page("index.html"));
    mainWin.on("close", (e) => {
      if (!quitting) {
        e.preventDefault();
        mainWin.hide();
      }
    });
  }
  mainWin.show();
  mainWin.focus();
}

// --- виджет ---
function widgetBounds() {
  const w = 300;
  const h = 360;
  const displays = screen.getAllDisplays();
  const d = displays.find((x) => x.id === settings.widget.display) ?? screen.getPrimaryDisplay();
  const a = d.workArea;
  let x = settings.widget.x ?? a.x + a.width - w - 24;
  let y = settings.widget.y ?? a.y + 24;
  // Сохранённое место вне всех экранов (монитор отключили) — вернуть на основной.
  const visible = displays.some((s) => x >= s.bounds.x - w / 2 && x < s.bounds.x + s.bounds.width - w / 2 && y >= s.bounds.y && y < s.bounds.y + s.bounds.height - 40);
  if (!visible) {
    const p = screen.getPrimaryDisplay().workArea;
    x = p.x + p.width - w - 24;
    y = p.y + 24;
  }
  return { x, y, width: w, height: h };
}

function createWidget() {
  if (widget) return;
  widget = new BrowserWindow({
    ...widgetBounds(),
    frame: false, transparent: true, resizable: false, skipTaskbar: true, focusable: false,
    alwaysOnTop: true, hasShadow: false, show: false, webPreferences: prefs,
  });
  // Выше полноэкранных окон и игр в оконном режиме.
  widget.setAlwaysOnTop(true, "screen-saver");
  widget.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  widget.setOpacity(settings.widget.opacity);
  widget.loadFile(page("widget.html"));
  setGrab(false);
  widget.once("ready-to-show", () => widget.showInactive());
  widget.on("moved", () => {
    const b = widget.getBounds();
    const d = screen.getDisplayMatching(b);
    settings.widget = { ...settings.widget, x: b.x, y: b.y, display: d.id };
    saveSettings();
  });
  widget.on("closed", () => (widget = null));
}

/** Взять виджет: можно таскать и кликать. Отпустить: клики идут сквозь него в окна под ним. */
function setGrab(on) {
  grabbed = on;
  if (!widget) return;
  widget.setIgnoreMouseEvents(!on, { forward: true });
  widget.setFocusable(on);
  if (on) widget.focus();
  widget.webContents.send("grab", on);
}

function toggleWidget(show = !widget) {
  settings.widget.show = show;
  saveSettings();
  if (show) createWidget();
  else widget?.close();
  refreshTray();
}

// --- быстрый ввод ---
function showQuick() {
  if (!quick) {
    const a = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    quick = new BrowserWindow({
      width: 560, height: 132, x: Math.round(a.x + (a.width - 560) / 2), y: Math.round(a.y + a.height * 0.28),
      frame: false, transparent: true, resizable: false, skipTaskbar: true, alwaysOnTop: true, show: false, webPreferences: prefs,
    });
    quick.setAlwaysOnTop(true, "screen-saver");
    quick.loadFile(page("quick.html"));
    quick.on("blur", () => quick?.hide());
    quick.on("closed", () => (quick = null));
    quick.once("ready-to-show", () => quick.show());
  } else {
    quick.show();
  }
  quick.focus();
  quick.webContents.send("quick-open");
}

function refreshTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Открыть", click: showMain },
    { label: `Быстрая запись (${settings.keys.quick.replace("Control", "Ctrl")})`, click: showQuick },
    { label: widget ? "Скрыть виджет" : "Показать виджет", click: () => toggleWidget() },
    { label: `Взять/отпустить виджет (${settings.keys.grab.replace("Control", "Ctrl")})`, enabled: Boolean(widget), click: () => setGrab(!grabbed) },
    { type: "separator" },
    { label: "Выход", click: () => { quitting = true; app.quit(); } },
  ]));
}

function registerKeys() {
  globalShortcut.unregisterAll();
  const bind = (key, fn) => {
    try {
      if (!globalShortcut.register(key, fn)) console.warn("клавиша занята:", key);
    } catch (e) {
      console.warn("клавиша не подходит:", key, e.message);
    }
  };
  bind(settings.keys.quick, showQuick);
  bind(settings.keys.grab, () => { if (widget) setGrab(!grabbed); });
}

// --- трекер ---
let trackerTimer = null;
let trackerState = { last: null, error: null };
async function trackOnce() {
  if (!settings.tracker.enabled || !settings.token) return;
  const days = [localDay()];
  // Сразу после полуночи досчитать вчерашний день.
  const now = new Date();
  if (now.getHours() === 0 && now.getMinutes() < 30) days.unshift(localDay(new Date(now.getTime() - 3600_000)));
  try {
    for (const d of days) await api("POST", "/api/activity", await collectDay(d, settings.tracker.games));
    trackerState = { last: new Date().toISOString(), error: null };
  } catch (e) {
    trackerState = { last: trackerState.last, error: e.message };
  }
  broadcast("tracker", trackerState);
}
function startTracker() {
  clearInterval(trackerTimer);
  trackerTimer = setInterval(trackOnce, 10 * 60_000);
  setTimeout(trackOnce, 15_000);
}

function broadcast(channel, data) {
  for (const w of [mainWin, widget, quick]) if (w && !w.isDestroyed()) w.webContents.send(channel, data);
}

// --- связь с окнами ---
ipcMain.handle("api", (_e, method, p, body) => api(method, p, body));
ipcMain.handle("settings:get", () => ({ ...settings, tracker: { ...settings.tracker, state: trackerState } }));
ipcMain.handle("settings:set", (_e, patch) => {
  settings = { ...settings, ...patch, widget: { ...settings.widget, ...patch.widget }, tracker: { ...settings.tracker, ...patch.tracker }, keys: { ...settings.keys, ...patch.keys } };
  saveSettings();
  registerKeys();
  if (widget) widget.setOpacity(settings.widget.opacity);
  if (patch.widget && "show" in patch.widget) toggleWidget(patch.widget.show);
  if (patch.tracker) startTracker();
  broadcast("changed", null);
  return settings;
});
ipcMain.handle("tracker:now", trackOnce);
ipcMain.on("changed", () => broadcast("changed", null));
ipcMain.on("open-main", showMain);
ipcMain.on("quick-hide", () => quick?.hide());
ipcMain.on("grab", (_e, on) => setGrab(on));
ipcMain.on("notify", (_e, title, body) => new Notification({ title, body }).show());

if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", showMain);
app.whenReady().then(() => {
  app.setAppUserModelId("Горничная");
  loadSettings();
  tray = new Tray(icon().isEmpty() ? nativeImage.createEmpty() : icon().resize({ width: 16, height: 16 }));
  tray.setToolTip("Горничная");
  tray.on("click", showMain);
  refreshTray();
  registerKeys();
  if (settings.widget.show) createWidget();
  if (!settings.token || process.argv.includes("--show")) showMain();
  startTracker();
  screen.on("display-removed", () => widget?.setBounds(widgetBounds()));
});
app.on("window-all-closed", (e) => e.preventDefault?.());
app.on("will-quit", () => globalShortcut.unregisterAll());
