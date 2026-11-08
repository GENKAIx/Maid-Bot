// Горничная на ПК: главное окно, виджет поверх всех окон, быстрый ввод, трей, трекер ПК.
// Ключ и адрес сервера хранятся в userData/settings.json; запросы к серверу идут только отсюда.

const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, screen, nativeImage, Notification, shell } = require("electron");
const { collectDay, localDay } = require("./activity.js");

const DEFAULTS = {
  server: "http://localhost:3000",
  token: "",
  widget: { show: true, x: null, y: null, display: null, opacity: 0.92, side: "right", size: "m", sections: { next: true, habits: true, tasks: true, soon: true } },
  tracker: { enabled: true, games: ["dota2.exe", "cs2.exe", "VALORANT-Win64-Shipping.exe", "League of Legends.exe", "GenshinImpact.exe", "Minecraft.Windows.exe"] },
  keys: { quick: "Alt+Shift+Space", grab: "Alt+Shift+M" },
  autostart: true,
};

// Настройки лежат в одной папке и в разработке, и в установленной программе (иначе после установки пропал бы ключ).
app.setPath("userData", path.join(app.getPath("appData"), "maid-desktop"));

// Запуск вместе с Windows — только у установленной программы (в разработке это был бы electron.exe).
function applyAutostart() {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: Boolean(settings.autostart), path: process.execPath, args: ["--hidden"] });
}

const WIDGET_W = 620;
const settingsFile = () => path.join(app.getPath("userData"), "settings.json");
let settings = structuredClone(DEFAULTS);
function loadSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    settings = { ...DEFAULTS, ...s, widget: { ...DEFAULTS.widget, ...s.widget }, tracker: { ...DEFAULTS.tracker, ...s.tracker }, keys: { ...DEFAULTS.keys, ...s.keys } };
    // Окно виджета стало шире слева (там облачко): панель остаётся там, где её поставили.
    if (settings.widget.x != null && settings.widget.width !== WIDGET_W) settings.widget.x -= WIDGET_W - (settings.widget.width ?? 340);
    settings.widget.width = WIDGET_W;
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

// Главное окно — веб-приложение с сервера (то же, что на телефоне). Страница с сервера — без preload:
// ключ десктопа ей не нужен, вход там свой (логин и пароль). Сервер не отвечает — локальная страница настроек.
function showMain(settingsOnly = false) {
  const local = settingsOnly || !settings.server;
  if (mainWin && mainWin.isLocal !== local) {
    mainWin.destroy();
    mainWin = null;
  }
  if (!mainWin) {
    mainWin = new BrowserWindow({
      width: 1060, height: 760, minWidth: 640, minHeight: 480, title: "Горничная", icon: icon(), backgroundColor: local ? "#1d1830" : "#f4f3f8",
      webPreferences: local ? prefs : { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    mainWin.isLocal = local;
    mainWin.removeMenu();
    if (local) mainWin.loadFile(page("index.html"), { query: { tab: "settings" } });
    else {
      mainWin.loadURL(settings.server.replace(/\/$/, "") + "/");
      mainWin.webContents.on("did-fail-load", (_e, code, desc, url) => {
        if (code === -3 || !url.startsWith(settings.server.replace(/\/$/, ""))) return; // -3: отменено (переход внутри)
        console.warn("главное окно:", code, desc);
        showMain(true);
      });
    }
    mainWin.on("close", (e) => {
      if (!quitting) {
        e.preventDefault();
        mainWin.hide();
      }
    });
    mainWin.on("closed", () => (mainWin = null));
  }
  mainWin.show();
  mainWin.focus();
}

// --- виджет ---
// Окно горничной: горничная выглядывает из-за верхнего края панели. cur — куда окно уже передвинули (иначе — сохранённое место).
function widgetBounds(cur) {
  const w = WIDGET_W;
  const h = 760;
  const displays = screen.getAllDisplays();
  const d = displays.find((x) => x.id === settings.widget.display) ?? screen.getPrimaryDisplay();
  const a = d.workArea;
  let x = cur?.x ?? settings.widget.x ?? a.x + a.width - w - 12;
  let y = cur?.y ?? settings.widget.y ?? a.y + a.height - h;
  // Сохранённое место вне всех экранов (монитор отключили) — вернуть на основной.
  const visible = displays.some((s) => x >= s.bounds.x - w / 2 && x < s.bounds.x + s.bounds.width - w / 2 && y >= s.bounds.y && y < s.bounds.y + s.bounds.height - 40);
  if (!visible) {
    const p = screen.getPrimaryDisplay().workArea;
    x = p.x + p.width - w - 12;
    y = p.y + p.height - h;
  }
  // Не вылезать за рабочую область (под панель задач): окно стало выше прежнего виджета.
  const area = screen.getDisplayMatching({ x, y, width: w, height: h }).workArea;
  x = Math.min(Math.max(x, area.x), area.x + area.width - w);
  y = Math.min(Math.max(y, area.y), area.y + area.height - h);
  return { x, y, width: w, height: h };
}

function rememberWidget() {
  if (!widget || widget.isDestroyed()) return;
  const b = widget.getBounds();
  const d = screen.getDisplayMatching(b);
  settings.widget = { ...settings.widget, x: b.x, y: b.y, display: d.id };
  saveSettings();
}

// Перетаскивание за шапку: окно идёт за курсором от точки, где его взяли.
let drag = null;
ipcMain.on("widget-drag", (_e, phase) => {
  if (!widget || widget.isDestroyed()) return;
  const c = screen.getCursorScreenPoint();
  if (phase === "start") {
    drag = { cx: c.x, cy: c.y, b: widget.getBounds() };
  } else if (phase === "move" && drag) {
    // setBounds с прежним размером: на экранах с разным масштабом setPosition у Windows меняет размер окна.
    widget.setBounds({ x: drag.b.x + c.x - drag.cx, y: drag.b.y + c.y - drag.cy, width: drag.b.width, height: drag.b.height });
  } else if (phase === "end" && drag) {
    drag = null;
    widget.setBounds(widgetBounds(widget.getBounds()));
    rememberWidget();
  }
});
ipcMain.on("widget-reset", () => {
  settings.widget = { ...settings.widget, x: null, y: null, display: null };
  saveSettings();
  widget?.setBounds(widgetBounds());
});

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
  // Прозрачность — только у панели (в renderer); сама фигурка всегда непрозрачная.
  widget.loadFile(page("widget.html"));
  setGrab(false);
  widget.once("ready-to-show", () => widget.showInactive());
  widget.on("moved", rememberWidget);
  widget.on("closed", () => (widget = null));
}

/** Взять виджет: можно таскать и кликать. Отпустить: клики идут сквозь него в окна под ним,
 * кроме фигурки и облачка — пока курсор над ними, мышь включается (hover). */
let hovering = false;
let mouseOn = null;
function applyMouse() {
  if (!widget) return;
  const on = Boolean(grabbed || hovering || typing);
  if (on === mouseOn) return;
  mouseOn = on;
  widget.setIgnoreMouseEvents(!on, { forward: true });
}
// Опрос курсора: над панелью/облачком/фигуркой — окно принимает мышь, иначе клики идут сквозь.
let regions = [];
setInterval(() => {
  if (!widget || widget.isDestroyed() || grabbed || typing || drag) return;
  const b = widget.getBounds();
  const c = screen.getCursorScreenPoint();
  const x = c.x - b.x;
  const y = c.y - b.y;
  const inside = x >= 0 && y >= 0 && x < b.width && y < b.height && regions.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
  if (inside !== hovering) {
    hovering = inside;
    applyMouse();
  }
}, 60);
function setGrab(on) {
  grabbed = on;
  if (!widget) return;
  mouseOn = null;
  applyMouse();
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
    { label: "Открыть", click: () => showMain() },
    { label: "Настройки", click: () => showMain(true) },
    { label: `Быстрая запись (${settings.keys.quick.replace("Control", "Ctrl")})`, click: showQuick },
    { label: widget ? "Скрыть виджет" : "Показать виджет", click: () => toggleWidget() },
    { label: `Взять/отпустить виджет (${settings.keys.grab.replace("Control", "Ctrl")})`, enabled: Boolean(widget), click: () => setGrab(!grabbed) },
    { type: "separator" },
    { label: "Запускать с Windows", type: "checkbox", checked: Boolean(settings.autostart), enabled: app.isPackaged,
      click: (it) => { settings.autostart = it.checked; saveSettings(); applyAutostart(); } },
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
ipcMain.on("open-day", (_e, day) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day)) || !/^https?:\/\//.test(settings.server)) return;
  shell.openExternal(`${settings.server.replace(/\/$/, "")}/diary/${day}`);
});
ipcMain.handle("settings:get", () => ({ ...settings, tracker: { ...settings.tracker, state: trackerState } }));
ipcMain.on("widget-ready", (e) => e.sender.send("opacity", settings.widget.opacity));
ipcMain.handle("settings:set", (_e, patch) => {
  settings = { ...settings, ...patch, widget: { ...settings.widget, ...patch.widget }, tracker: { ...settings.tracker, ...patch.tracker }, keys: { ...settings.keys, ...patch.keys } };
  saveSettings();
  registerKeys();
  applyAutostart();
  refreshTray();
  widget?.webContents.send("opacity", settings.widget.opacity);
  if (patch.widget && "show" in patch.widget) toggleWidget(patch.widget.show);
  if (patch.tracker) startTracker();
  broadcast("changed", null);
  return settings;
});
ipcMain.handle("tracker:now", trackOnce);
// Отладка: electron . --inspect → в инспекторе main maidDebug()
global.maidDebug = () => ({
  grabbed, hovering, typing, regions, mouseOn, focused: widget?.isFocused(), focusable: widget?.isFocusable?.(),
  bounds: widget?.getBounds(), cursor: screen.getCursorScreenPoint(),
});
ipcMain.on("changed", () => broadcast("changed", null));
ipcMain.on("open-main", () => showMain());
ipcMain.on("quick-hide", () => quick?.hide());
ipcMain.on("grab", (_e, on) => setGrab(on));
ipcMain.on("hover", () => {});
ipcMain.on("regions", (_e, list) => { regions = Array.isArray(list) ? list : []; });
// Печатать в строке чата можно, только если окно принимает фокус; после — снова «сквозное».
let typing = false;
ipcMain.on("focus-input", (_e, on) => {
  if (!widget) return;
  typing = Boolean(on);
  applyMouse();
  if (on) {
    widget.setFocusable(true);
    widget.focus();
  } else if (!grabbed) {
    widget.setFocusable(false);
    hovering = false;
    applyMouse();
  }
});
ipcMain.on("quick-show", showQuick);
ipcMain.on("thinking", (_e, on) => widget?.webContents.send("thinking", on));
ipcMain.on("reply", (_e, r) => widget?.webContents.send("reply", r));
ipcMain.on("notify", (_e, title, body) => new Notification({ title, body }).show());

if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => showMain());
app.whenReady().then(() => {
  app.setAppUserModelId("Горничная");
  loadSettings();
  tray = new Tray(icon().isEmpty() ? nativeImage.createEmpty() : icon().resize({ width: 16, height: 16 }));
  tray.setToolTip("Горничная");
  tray.on("click", () => showMain());
  refreshTray();
  registerKeys();
  applyAutostart();
  if (settings.widget.show) createWidget();
  if (!settings.token) showMain(true);
  else if (process.argv.includes("--show")) showMain();
  startTracker();
  screen.on("display-removed", () => widget?.setBounds(widgetBounds()));
});
app.on("window-all-closed", (e) => e.preventDefault?.());
app.on("will-quit", () => globalShortcut.unregisterAll());
