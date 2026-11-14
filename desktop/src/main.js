// Горничная на ПК: главное окно, виджет поверх всех окон, быстрый ввод, трей, трекер ПК.
// Ключ и адрес сервера хранятся в userData/settings.json (ключ — зашифрован защитой Windows, safeStorage); запросы к серверу идут только отсюда.
// Окна ключа не видят: им отдаётся только признак hasToken; адрес и ключ меняет только окно настроек программы.

const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, screen, nativeImage, Notification, shell, safeStorage, powerMonitor, nativeTheme, session } = require("electron");
const { collectDay, localDay } = require("./activity.js");
const { iconKey, newIcons } = require("./icons.js");
const { createUpdates } = require("./updates.js");

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
// Панель виджета внутри окна: у нижнего края, справа (горничная слева — слева). С запасом на тень.
const PANEL_W = 340;
const PANEL_H = 400;
// Панель можно вытянуть вниз за правый нижний угол (widget-resize): окно выше на столько же, сколько панель (CSS: высота панели — 100vh − 380).
// Прибавка к высоте запоминается в settings.widget.extra; 0 — исходный размер.
const WIDGET_H = 760;
const CLOCK_LEFT = 8; // левый край развёрнутых «Планов на день» в окне (CSS .plan-clock: right 342 + ширина 270)
const extraH = () => Math.max(0, Math.round(settings.widget.extra ?? 0));
const settingsFile = () => path.join(app.getPath("userData"), "settings.json");
let settings = structuredClone(DEFAULTS);
// Зашифрованный ключ из файла, пока он не расшифровался (защита Windows бывает недоступна в первые секунды после
// установки или входа): token() пробует ещё раз при каждом запросе, а saveSettings его не теряет.
let tokenEnc = "";
let tokenFailed = false; // уже не расшифровывался — удачу стоит записать в журнал
function token() {
  if (!settings.token && tokenEnc) {
    try {
      settings.token = safeStorage.decryptString(Buffer.from(tokenEnc, "base64"));
      tokenEnc = "";
      if (tokenFailed) maidLog("ключ расшифровался с повторной попытки");
    } catch (e) {
      tokenFailed = true;
      maidLog("ключ не расшифровался:", e?.message ?? e);
    }
  }
  return settings.token;
}
// Журнал программы для разбора сбоев: userData/maid.log, без ключа и содержимого; больше 200 КБ — начинается заново.
const logFile = () => path.join(app.getPath("userData"), "maid.log");
const logged = new Map(); // одна и та же строка — не чаще раза в минуту
function maidLog(...a) {
  const line = a.join(" ");
  if (Date.now() - (logged.get(line) ?? 0) < 60_000) return;
  logged.set(line, Date.now());
  try {
    if ((fs.statSync(logFile(), { throwIfNoEntry: false })?.size ?? 0) > 200_000) fs.rmSync(logFile());
    fs.appendFileSync(logFile(), `${new Date().toISOString()} ${line}
`);
  } catch (e) {
    // Основной журнал не пишется — запасной рядом, со своим номером процесса, и почему.
    try { fs.appendFileSync(logFile().replace(/\.log$/, `-${process.pid}.log`), `${new Date().toISOString()} [${e?.code ?? e}] ${line}
`); } catch { /* журнал не обязателен */ }
  }
}
function loadSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    settings = { ...DEFAULTS, ...s, widget: { ...DEFAULTS.widget, ...s.widget }, tracker: { ...DEFAULTS.tracker, ...s.tracker }, keys: { ...DEFAULTS.keys, ...s.keys } };
    // Окно виджета стало шире слева (там облачко): панель остаётся там, где её поставили.
    if (settings.widget.x != null && settings.widget.width !== WIDGET_W) settings.widget.x -= WIDGET_W - (settings.widget.width ?? 340);
    settings.widget.width = WIDGET_W;
    // Ключ в файле — зашифрованный (tokenEnc); старый открытый перешифруется при первом сохранении.
    if (s.tokenEnc) {
      settings.token = "";
      tokenEnc = s.tokenEnc;
      token();
    }
    delete settings.tokenEnc;
    if (s.token && canEncrypt()) saveSettings();
  } catch (e) {
    if (fs.existsSync(settingsFile())) maidLog("настройки не прочитались:", e?.message ?? e);
    settings = structuredClone(DEFAULTS);
  }
}
const canEncrypt = () => { try { return safeStorage.isEncryptionAvailable(); } catch { return false; } };
function saveSettings() {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  // Без защиты Windows (редко: другой пользователь, сломанный профиль) ключ остаётся как был — иначе пропал бы вход.
  const out = { ...settings };
  if (out.token && canEncrypt()) {
    out.tokenEnc = safeStorage.encryptString(out.token).toString("base64");
    delete out.token;
  } else if (!out.token && tokenEnc) {
    out.tokenEnc = tokenEnc; // ещё не расшифрован — оставить как был, иначе вход пропадёт
    delete out.token;
  }
  // Через временный файл: если установщик обновления оборвёт программу на записи, старый файл останется целым.
  const tmp = settingsFile() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
  fs.renameSync(tmp, settingsFile());
}
// Адрес сервера: только http(s), без пути — иначе null.
function serverBase(s = settings.server) {
  try {
    const u = new URL(String(s));
    return /^https?:$/.test(u.protocol) ? u.origin : null;
  } catch { return null; }
}
// Окно настроек программы — своя страница из папки renderer, а не сайт и не виджет.
const isSettingsPage = (wc) => {
  try { return wc === mainWin?.webContents && new URL(wc.getURL()).protocol === "file:"; } catch { return false; }
};

/** Сервер перенаправил запрос на другой адрес https (http://IP → https://домен): новый адрес — иначе null.
 * При переходе на другой адрес fetch выбрасывает ключ из запроса, и сервер отвечал 401 — вход «устаревал» сразу после входа.
 * На http ключ не переносим: там он идёт открытым текстом. */
function movedTo(base, res) {
  if (!res.redirected || !res.url) return null;
  try {
    const u = new URL(res.url);
    return u.protocol === "https:" && u.origin !== base ? u.origin : null;
  } catch { return null; }
}

async function api(method, p, body, moved = false) {
  if (!token()) throw new Error(tokenEnc ? "Ключ ещё не расшифровался (защита Windows) — пробую снова." : "Вход не выполнен: откройте настройки программы и войдите логином и паролем.");
  // Только пути /api/… и только на сервер из настроек: окно не может увести ключ на чужой адрес.
  const base = serverBase();
  if (!base) throw new Error("Неверный адрес сервера в настройках.");
  if (typeof p !== "string" || !/^\/api\/[^\s]*$/.test(p) || p.includes("..") || p.includes("//")) throw new Error("неверный запрос");
  const url = new URL(p, base);
  if (url.origin !== base) throw new Error("неверный запрос");
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new Error("неверный запрос");
  const opts = {
    method,
    headers: { Authorization: `Bearer ${settings.token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  };
  // Соединение иногда рвётся (VPN, сон компьютера) — «fetch failed» без ответа сервера. Повторить ещё дважды;
  // POST тоже: сервер его не получил, раз ответа нет вовсе.
  let res;
  for (let i = 0; ; i++) {
    try {
      res = await fetch(url, { ...opts, signal: AbortSignal.timeout(90_000) });
      break;
    } catch (e) {
      // Понятные слова вместо «fetch failed»: по ним виджет понимает, что сообщение можно повторить позже.
      if (e?.name === "TimeoutError") throw new Error("сервер не ответил");
      if (i >= 2) {
        maidLog("нет связи с сервером:", e?.cause?.code ?? e?.message ?? e);
        throw new Error("нет связи с сервером");
      }
      await new Promise((r) => setTimeout(r, 700 * (i + 1)));
    }
  }
  // Сервер переехал на https-адрес: запомнить его и повторить запрос уже с ключом (один раз).
  const to = movedTo(base, res);
  if (to && !moved) {
    maidLog("сервер переехал:", base, "→", to);
    settings.server = to;
    saveSettings();
    return api(method, p, body, true);
  }
  const data = await res.json().catch(() => ({}));
  // Сервер не принял ключ (вышли на сайте, устройство удалено, аккаунта нет): это не обрыв связи — нужен вход заново.
  // Раньше виджет писал «Нет связи с сервером», хотя связь была.
  if (res.status === 401) {
    if (!loginStale) maidLog("сервер не принял ключ (401) — нужен вход заново");
    loginStale = true;
    throw new Error(LOGIN_STALE);
  }
  loginStale = false;
  if (!res.ok) throw new Error(data.error ?? `сервер ${res.status}`);
  return data;
}
/** Сервер ответил 401 на ключ программы: виджет просит войти, настройки открывают форму входа. */
let loginStale = false;
const LOGIN_STALE = "вход устарел — войдите снова";

let mainWin = null;
let widget = null;
let quick = null;
let tray = null;
let grabbed = false;
let quitting = false;

const icon = () => nativeImage.createFromPath(path.join(__dirname, "..", "assets", "icon.png"));
const page = (name) => path.join(__dirname, "..", "renderer", name);
const prefs = { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true };

// Главное окно — веб-приложение с сервера (то же, что на телефоне). Страница с сервера — со своим маленьким preload
// (preload-app.js: только настройки виджета, раздел «Виджет»): ключ десктопа ей не нужен, вход там свой (логин и пароль).
// Сервер не отвечает — локальная страница настроек.
function showMain(settingsOnly = false) {
  const local = settingsOnly || !settings.server;
  if (mainWin && mainWin.isLocal !== local) {
    mainWin.destroy();
    mainWin = null;
  }
  if (!mainWin) {
    mainWin = new BrowserWindow({
      width: 1060, height: 760, minWidth: 640, minHeight: 480, title: "Горничная", icon: icon(), backgroundColor: local ? "#1d1830" : nativeTheme.shouldUseDarkColors ? "#15121f" : "#f4f3f8",
      webPreferences: local ? prefs : { preload: path.join(__dirname, "preload-app.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    mainWin.isLocal = local;
    mainWin.removeMenu();
    // Ссылки «в новом окне» (бот в Telegram и т. п.) — в браузере системы, а не новым окном программы.
    mainWin.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
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
  } else if (!local) refreshIfStale(mainWin);
  mainWin.show();
  mainWin.focus();
}

// Скрытое главное окно живёт, пока работает программа, и держит старую версию сайта. При показе сверяем сборку
// (/assets/index-*.js в index.html сервера) с той, что загружена, и перезагружаем окно, если на сервере новая.
async function refreshIfStale(win) {
  try {
    const base = settings.server.replace(/\/$/, "");
    const html = await (await fetch(base + "/", { cache: "no-store" })).text();
    const fresh = html.match(/\/assets\/index-[\w-]+\.js/)?.[0];
    if (!fresh || win.isDestroyed()) return;
    const loaded = await win.webContents.executeJavaScript(
      `[...document.scripts].map((s) => s.src).find((x) => x.includes("/assets/index-")) ?? ""`, true);
    if (loaded && !loaded.endsWith(fresh)) win.webContents.reloadIgnoringCache();
  } catch (e) {
    console.warn("проверка версии сайта:", e.message);
  }
}

// --- виджет ---
// Окно горничной: горничная выглядывает из-за верхнего края панели. cur — куда окно уже передвинули (иначе — сохранённое место).
function widgetBounds(cur) {
  const w = WIDGET_W;
  const ph = PANEL_H + extraH();
  const h = WIDGET_H + extraH();
  const displays = screen.getAllDisplays();
  const d = displays.find((x) => x.id === settings.widget.display) ?? screen.getPrimaryDisplay();
  const a = d.workArea;
  let x = cur?.x ?? settings.widget.x ?? a.x + a.width - w - 12;
  let y = cur?.y ?? settings.widget.y ?? a.y + a.height - h;
  // Окно высокое (760) и почти всё прозрачное: на экране должна остаться панель, а не всё окно. Иначе панель у верха экрана
  // или у края второго монитора считалась «за экраном», и виджет прыгал обратно в угол основного.
  // Панель всегда у правого края окна (CSS .w); «горничная слева» двигает только фигурку.
  const panel = (px, py) => ({ x: px + w - PANEL_W, y: py + h - ph, width: PANEL_W, height: ph });
  const p0 = panel(x, y);
  const cx = p0.x + p0.width / 2;
  const cy = p0.y + p0.height / 2;
  const home = displays.find((s) => cx >= s.bounds.x && cx < s.bounds.x + s.bounds.width && cy >= s.bounds.y && cy < s.bounds.y + s.bounds.height);
  if (!home) {
    const p = screen.getPrimaryDisplay().workArea;
    x = p.x + p.width - w - 12;
    y = p.y + p.height - h;
  }
  // Не вылезать за рабочую область (под панель задач) — панелью; прозрачный верх окна может уйти за край экрана.
  const area = (home ?? screen.getPrimaryDisplay()).workArea;
  const p1 = panel(x, y);
  // Развёрнутый: «Планы на день» выезжают слева от панели (CSS .plan-clock, левый край — 8 px от края окна) — у левого края экрана
  // окно сдвигается, чтобы они не ушли за экран.
  const leftMost = fold.folded ? area.x : Math.min(area.x + w - PANEL_W - CLOCK_LEFT, area.x + area.width - PANEL_W);
  x += Math.min(Math.max(p1.x, leftMost), area.x + area.width - PANEL_W) - p1.x;
  // Горничная выглядывает над верхом панели (у свёрнутой у верха экрана — над карточкой на том же месте): её голова тоже на экране.
  const head = !fold.folded || settings.widget.down ? fold.head : 0;
  y += Math.min(Math.max(p1.y, area.y + head), area.y + area.height - ph) - p1.y;
  return { x, y, width: w, height: h };
}

function rememberWidget() {
  if (!widget || widget.isDestroyed()) return;
  const b = widget.getBounds();
  const c = screen.getCursorScreenPoint();
  const d = screen.getDisplayNearestPoint(drag ? c : { x: b.x + b.width / 2, y: b.y + b.height - (PANEL_H + extraH()) / 2 });
  settings.widget = { ...settings.widget, x: b.x, y: b.y, display: d.id };
  saveSettings();
}

// Перетаскивание за шапку: окно идёт за курсором от точки, где его взяли.
let drag = null;
ipcMain.on("widget-drag", (_e, phase) => {
  if (!widget || widget.isDestroyed()) return;
  const c = screen.getCursorScreenPoint();
  if (phase === "start") {
    clearInterval(drag?.timer);
    drag = { cx: c.x, cy: c.y, b: widget.getBounds() };
    // Окно ведёт таймер, а не события мыши: окно без фокуса получает их неровно, и оно отставало от курсора.
    drag.timer = setInterval(followCursor, 16);
  } else if (phase === "move" && drag) {
    followCursor();
  } else if (phase === "end" && drag) {
    clearInterval(drag.timer);
    drag = null;
    settleWidget();
  }
});

// Свёрнутый виджет у верха экрана: развернуться вверх некуда — тогда карточка стоит там, где верх панели, и панель (и выдвижные
// «Планы на день») раскрывается вниз (settings.widget.down). Режим решается, когда свёрнутую карточку отпустили; карточка при этом
// остаётся на месте: окно сдвигается на разницу, а окно (спрятанное на кадр) переставляет карточку внутри себя.
let fold = { folded: false, miniH: 68, head: 0 };
let pendingDown = null;
let foldSettled = false;
ipcMain.on("widget-fold", (_e, folded, miniH, head) => {
  const was = fold;
  fold = { folded: Boolean(folded), miniH: Number(miniH) || fold.miniH, head: Number(head) || 0 };
  // Первый отчёт после запуска: решить «вверх или вниз» по месту, где стоит карточка (раньше — только после перетаскивания).
  if (fold.folded && !foldSettled && widget && !widget.isDestroyed() && !drag) {
    foldSettled = true;
    setTimeout(() => !drag && !pendingDown && settleWidget(), 300);
  }
  // Горничная выросла или виджет развернули у верха — сдвинуть, чтобы голова не ушла за экран.
  if ((was.head !== fold.head || was.folded !== fold.folded) && widget && !widget.isDestroyed() && !drag && !sizing && !pendingDown) {
    const b = widget.getBounds();
    const nb = widgetBounds(b);
    if (nb.y !== b.y || nb.x !== b.x) {
      widget.setBounds(nb);
      rememberWidget();
    }
  }
});
const panelInWindow = (h) => Math.max(380, h - 380); // CSS: высота панели — max(380px, 100vh − 380px), отступ снизу 8
// Вниз — если снизу хватает места на всю панель (виджет не у низа экрана) или сверху его нет: карточка поднимается на высоту панели,
// и над ней ещё голова горничной (fold.head) — на маленьком экране (1280×720 при 150 %) она ушла бы за верх.
function wantDown(cardBottom, panel, area) {
  const roomBelow = cardBottom - fold.miniH + panel <= area.y + area.height;
  return roomBelow || cardBottom - panel - fold.head < area.y;
}
function settleWidget() {
  if (!widget || widget.isDestroyed()) return;
  const b = widget.getBounds();
  const wasDown = Boolean(settings.widget.down);
  const lift = panelInWindow(b.height) - fold.miniH;
  let down = wasDown;
  if (fold.folded) {
    const cardBottom = b.y + b.height - 8 - (wasDown ? lift : 0);
    const area = screen.getDisplayNearestPoint({ x: b.x + b.width - PANEL_W / 2, y: cardBottom - fold.miniH / 2 }).workArea;
    down = wantDown(cardBottom, panelInWindow(b.height), area);
  }
  if (down === wasDown) {
    widget.setBounds(widgetBounds(b));
    rememberWidget();
    return;
  }
  settings.widget.down = down;
  pendingDown = widgetBounds({ ...b, y: b.y + (down ? lift : -lift) });
  widget.webContents.send("down", down);
  setTimeout(() => pendingDown && placeDown(), 400); // окно не ответило — всё равно поставить
}
function placeDown() {
  if (!widget || widget.isDestroyed()) return;
  if (pendingDown) widget.setBounds(pendingDown);
  pendingDown = null;
  rememberWidget();
  widget.webContents.send("down-shown");
}
ipcMain.on("down-ready", placeDown);
function followCursor() {
  if (!drag || !widget || widget.isDestroyed()) return;
  const c = screen.getCursorScreenPoint();
  const x = drag.b.x + c.x - drag.cx;
  const y = drag.b.y + c.y - drag.cy;
  const now = widget.getBounds();
  if (now.x === x && now.y === y) return;
  // setBounds с прежним размером: на экранах с разным масштабом setPosition у Windows меняет размер окна.
  widget.setBounds({ x, y, width: drag.b.width, height: drag.b.height });
}
// Вытянуть панель за правый нижний угол: тянешь вниз — длиннее, вверх — короче (не меньше исходной).
// Верх панели стоит на месте, растёт низ; у нижнего края экрана расти некуда — тогда панель растёт вверх.
// «reset» (двойной щелчок по уголку) — исходная высота.
let sizing = null;
ipcMain.on("widget-resize", (_e, phase) => {
  if (!widget || widget.isDestroyed()) return;
  const c = screen.getCursorScreenPoint();
  if (phase === "start") {
    clearInterval(sizing?.timer);
    const b = widget.getBounds();
    sizing = { cy: c.y, extra: extraH(), b, area: screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height - 40 }).workArea };
    hovering = true;
    applyMouse();
    sizing.timer = setInterval(followResize, 16);
  } else if (phase === "move" && sizing) {
    followResize();
  } else if (phase === "end" && sizing) {
    followResize();
    clearInterval(sizing.timer);
    sizing = null;
    rememberWidget();
  } else if (phase === "reset") {
    const b = widget.getBounds();
    const bottom = b.y + b.height - extraH(); // верх панели на месте
    settings.widget.extra = 0;
    widget.setBounds({ x: b.x, y: bottom - WIDGET_H, width: b.width, height: WIDGET_H });
    rememberWidget();
  }
});
function followResize() {
  if (!sizing || !widget || widget.isDestroyed()) return;
  const { b, area } = sizing;
  // Не выше рабочей области минус место для головы горничной над панелью.
  const most = Math.max(0, area.height - PANEL_H - 150);
  const extra = Math.min(most, Math.max(0, sizing.extra + screen.getCursorScreenPoint().y - sizing.cy));
  const h = WIDGET_H + extra;
  const bottom = Math.min(b.y + b.height + extra - sizing.extra, area.y + area.height);
  if (extra === extraH() && widget.getBounds().height === h) return;
  settings.widget.extra = extra;
  widget.setBounds({ x: b.x, y: bottom - h, width: b.width, height: h });
}
ipcMain.on("widget-reset", resetWidgetPlace);

// Вспышка «стираю память» (forget), как у нейралайзера в «Людях в чёрном»: на каждом мониторе своё прозрачное окно во весь экран,
// поверх всего, щелчки идут сквозь (flash.html). Линза — на мониторе горничной, на остальных засветка и полоса на той же высоте.
const FLASH_MS = 2700;
const flashWins = new Map(); // id монитора -> { win, ready }
let flashHide = 0;
function flashWinFor(d) {
  let f = flashWins.get(d.id);
  if (f && !f.win.isDestroyed()) return f;
  const win = new BrowserWindow({
    ...d.bounds,
    frame: false, transparent: true, resizable: false, skipTaskbar: true, focusable: false,
    alwaysOnTop: true, hasShadow: false, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setIgnoreMouseEvents(true);
  win.on("closed", () => flashWins.delete(d.id));
  f = { win, ready: new Promise((ok) => win.webContents.once("did-finish-load", ok)) };
  win.loadFile(page("flash.html"));
  flashWins.set(d.id, f);
  return f;
}
function memFlash(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const pt = { x: Math.round(x), y: Math.round(y) };
  const shown = [];
  for (const d of screen.getAllDisplays()) {
    const { win, ready } = flashWinFor(d);
    const b = d.bounds;
    win.setBounds(b);
    shown.push(win);
    ready.then(() => {
      if (win.isDestroyed()) return;
      win.showInactive();
      win.moveTop();
      win.webContents.executeJavaScript(`go(${pt.x - b.x}, ${pt.y - b.y})`).catch(() => {});
    });
  }
  // Окна мониторов, которых больше нет, — закрыть.
  for (const [id, f] of flashWins) if (!shown.includes(f.win)) { flashWins.delete(id); if (!f.win.isDestroyed()) f.win.destroy(); }
  clearTimeout(flashHide);
  flashHide = setTimeout(() => { for (const w of shown) if (!w.isDestroyed()) w.hide(); }, FLASH_MS);
}
ipcMain.on("mem-flash", (_e, x, y) => memFlash(Number(x), Number(y)));
// Горничная подняла прибор — окна вспышки загружаются заранее, чтобы к щелчку уже были готовы.
ipcMain.on("mem-flash-prep", () => { for (const d of screen.getAllDisplays()) flashWinFor(d); });
function resetWidgetPlace() {
  settings.widget = { ...settings.widget, x: null, y: null, display: null, down: false };
  saveSettings();
  widget?.setBounds(widgetBounds());
  widget?.webContents.send("down", false);
  widget?.webContents.send("down-shown");
}

function createWidget() {
  if (widget) return;
  widget = new BrowserWindow({
    ...widgetBounds(),
    frame: false, transparent: true, resizable: false, skipTaskbar: true,
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
  widget.on("focus", () => flog("win-focus"));
  widget.on("blur", () => flog("win-blur"));
  widget.on("closed", () => (widget = null));
  // Страница виджета упала или зависла — окно оставалось пустым и прозрачным, будто виджет пропал. Загружаем заново.
  widget.webContents.on("render-process-gone", (_e, d) => {
    maidLog("страница виджета упала:", d.reason, d.exitCode);
    if (d.reason !== "clean-exit" && widget && !widget.isDestroyed()) widget.reload();
  });
  widget.on("unresponsive", () => {
    maidLog("страница виджета зависла");
    if (widget && !widget.isDestroyed()) widget.webContents.forcefullyCrashRenderer();
  });
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
// Окно всегда «фокусируемое»: щелчок по нему Windows активирует сама, и чат принимает ввод с первого раза.
// Раньше окно было нефокусируемым и переключалось на лету (setFocusable) — фокус не доходил, а окно мигало при каждом щелчке.
let overChat = false;
const flog = (...a) => { if (process.env.MAID_FOCUS_LOG) fs.appendFileSync(process.env.MAID_FOCUS_LOG, `${Date.now() % 100000} ${a.join(" ")} focused=${widget?.isFocused()} focusable=${widget?.isFocusable?.()}
`); };
// Курсор над фигуркой, облачком или панелью (regions от виджета, в координатах окна).
function cursorOver() {
  const b = widget.getBounds();
  const c = screen.getCursorScreenPoint();
  const x = c.x - b.x;
  const y = c.y - b.y;
  return x >= 0 && y >= 0 && x < b.width && y < b.height && regions.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
}
setInterval(() => {
  if (!widget || widget.isDestroyed() || grabbed || typing || drag || sizing) return;
  const b = widget.getBounds();
  const c = screen.getCursorScreenPoint();
  const x = c.x - b.x;
  const y = c.y - b.y;
  const inside = cursorOver();
  if (inside !== hovering) {
    hovering = inside;
    applyMouse();
  }
  const chat = inside && regions.some((r) => r.chat && x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
  if (chat !== overChat) {
    overChat = chat;
    flog("overChat", chat);
  }
}, 30);
function setGrab(on) {
  grabbed = on;
  flog("grab", on);
  if (!widget) return;
  mouseOn = null;
  applyMouse();
  if (on) widget.focus();
  widget.webContents.send("grab", on);
}

/** Окно есть, но не видно (свернулось, спряталось, ушло за край, оказалось под другими окнами) — вернуть на экран и наверх. */
function reviveWidget(why) {
  if (!widget || widget.isDestroyed()) return;
  if (widget.isMinimized()) widget.restore();
  const b = widget.getBounds();
  if (!screen.getAllDisplays().some((d) => { const a = d.workArea; return b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y; })) {
    maidLog("виджет за экраном — возвращаю:", why);
    widget.setBounds(widgetBounds());
  }
  widget.showInactive();
  widget.setAlwaysOnTop(true, "screen-saver");
  widget.moveTop();
}

// Виджет пропадал целиком, пока программа работала: после сна ПК, смены экранов или сбоя видеочасти окно оставалось пустым
// и прозрачным, уходило за край или под другие окна. Что случилось — в журнал; окно — обратно.
function watchWidget() {
  app.on("child-process-gone", (_e, d) => {
    maidLog("сбой процесса:", d.type, d.reason, d.exitCode);
    // Видеочасть упала — прозрачное окно больше не рисуется; страница виджета загружается заново.
    if (d.type === "GPU" && d.reason !== "clean-exit" && widget && !widget.isDestroyed()) widget.reload();
  });
  powerMonitor.on("suspend", () => maidLog("сон ПК"));
  // После пробуждения экраны подключаются не сразу — вернуть окно чуть погодя.
  powerMonitor.on("resume", () => { maidLog("пробуждение ПК"); setTimeout(() => reviveWidget("пробуждение ПК"), 3000); });
  screen.on("display-added", () => { maidLog("экран подключён"); reviveWidget("экран подключён"); });
  screen.on("display-removed", () => { maidLog("экран отключён"); widget?.setBounds(widgetBounds()); });
  screen.on("display-metrics-changed", (_e, _d, changed) => { maidLog("экран изменился:", changed.join(",")); reviveWidget("экран изменился"); });
}

function toggleWidget(show = !widget) {
  settings.widget.show = show;
  saveSettings();
  if (show && widget && !widget.isDestroyed()) reviveWidget("из меню");
  else if (show) createWidget();
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
    ...(updates.state().status === "available" ? [{ label: `Обновить до ${updates.state().next}`, click: () => void updates.install() }] : []),
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
  if (!settings.tracker.enabled || !token()) return;
  const days = [localDay()];
  // Сразу после полуночи досчитать вчерашний день.
  const now = new Date();
  if (now.getHours() === 0 && now.getMinutes() < 30) days.unshift(localDay(new Date(now.getTime() - 3600_000)));
  try {
    const names = [];
    for (const d of days) {
      const day = await collectDay(d, settings.tracker.games);
      await api("POST", "/api/activity", day);
      for (const x of [...day.apps, ...day.games]) names.push(x.name);
    }
    trackerState = { last: new Date().toISOString(), error: null };
    sendIcons(names).catch((e) => console.warn("[icons]", e.message));
  } catch (e) {
    trackerState = { last: trackerState.last, error: e.message };
  }
  broadcast("tracker", trackerState);
}
// Значки программ из статистики — один раз на программу (settings.tracker.iconsSent).
async function sendIcons(names) {
  const sent = new Set(settings.tracker.iconsSent ?? []);
  const icons = await newIcons(names, sent);
  if (!icons.length) return;
  await api("POST", "/api/icons", { icons });
  for (const i of icons) sent.add(iconKey(i.name));
  settings.tracker.iconsSent = [...sent];
  saveSettings();
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
// Раздел приложения (щелчок по карточке в облачке горничной): главное окно открывается сразу на нём.
ipcMain.on("open-section", (_e, p) => {
  if (!/^\/[\w\/-]*$/.test(String(p)) || !/^https?:\/\//.test(settings.server)) return showMain();
  showMain();
  mainWin?.loadURL(settings.server.replace(/\/$/, "") + p);
});
// Окнам — настройки без ключа.
const shown = () => { const { token: _t, siteTokenEnc: _s, ...rest } = settings; return { ...rest, hasToken: Boolean(token() || tokenEnc), loginStale, insecure: insecure(settings.server), tracker: { ...settings.tracker, state: trackerState } }; };
// http:// не на этом компьютере — ключ и дневник идут открытым текстом.
function insecure(s) {
  try { const u = new URL(String(s)); return u.protocol === "http:" && !/^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(u.hostname); } catch { return false; }
}
ipcMain.handle("settings:get", shown);
ipcMain.on("widget-ready", (e) => {
  e.sender.send("opacity", settings.widget.opacity);
  e.sender.send("down", Boolean(settings.widget.down));
  e.sender.send("down-shown");
});
/** Вход логином и паролем на сервере: ключ для программы (POST /api/login, как вход сайта). Ошибки — понятными словами. */
async function loginOnServer(base, login, password, label) {
  let res;
  try {
    res = await fetch(new URL("/api/login", base), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login, password, label }), signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    maidLog("вход: нет связи с сервером:", e?.cause?.code ?? e?.cause?.message ?? e?.name ?? e?.message ?? e);
    throw new Error(e?.name === "TimeoutError" ? "Сервер не ответил. Проверьте адрес сервера и интернет." : "Нет связи с сервером. Проверьте адрес сервера и интернет.");
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error("Неверный логин или пароль.");
  if (!res.ok || typeof data.token !== "string") {
    maidLog("вход: сервер ответил", res.status);
    throw new Error(data.error ? `Сервер: ${data.error}` : `Сервер ответил ошибкой ${res.status}. Проверьте адрес сервера.`);
  }
  // Адрес, на котором сервер в итоге ответил (вписали http://IP — сохраняется https-адрес, куда он перенаправил).
  return { token: data.token, origin: movedTo(base, res) ?? base };
}
// Вход в программу — из окна настроек (адрес, логин и пароль) или из виджета, когда вход устарел (логин и пароль; адрес — из настроек).
// Ключ — программе, второй — входу сайта в главном окне (копия входа, как site-login:keep), чтобы сайт не спрашивал пароль ещё раз.
// Пароль не хранится.
ipcMain.handle("settings:login", async (e, form) => {
  const fromWidget = Boolean(widget && e.sender === widget.webContents);
  if (!isSettingsPage(e.sender) && !fromWidget) throw new Error("неверный запрос");
  const base = serverBase(String((fromWidget ? settings.server : form?.server) ?? "").trim());
  if (!base) throw new Error("Адрес сервера: нужен вида https://example.com");
  const login = String(form?.login ?? "").trim();
  const password = String(form?.password ?? "");
  if (!login || !password) throw new Error("Впишите логин и пароль.");
  const { token: key, origin } = await loginOnServer(base, login, password, "Программа на ПК");
  if (origin !== base) maidLog("вход: сервер на другом адресе:", base, "→", origin);
  const site = (await loginOnServer(origin, login, password, "Программа на ПК: сайт").catch(() => null))?.token ?? "";
  settings.server = origin;
  settings.token = key;
  tokenEnc = "";
  loginStale = false;
  if (site && canEncrypt()) {
    settings.siteTokenEnc = safeStorage.encryptString(site).toString("base64");
    siteSeen = null;
  }
  saveSettings();
  refreshTray();
  maidLog("вход в программу выполнен");
  broadcast("changed", null);
  return shown();
});
ipcMain.handle("settings:set", (e, patch) => {
  patch = { ...patch };
  // Адрес сервера и ключ меняет только вход (settings:login).
  delete patch.server;
  delete patch.token;
  delete patch.siteTokenEnc;
  settings ={ ...settings, ...patch, widget: { ...settings.widget, ...patch.widget }, tracker: { ...settings.tracker, ...patch.tracker }, keys: { ...settings.keys, ...patch.keys } };
  saveSettings();
  registerKeys();
  applyAutostart();
  refreshTray();
  widget?.webContents.send("opacity", settings.widget.opacity);
  if (patch.widget && "show" in patch.widget) toggleWidget(patch.widget.show);
  if (patch.tracker) startTracker();
  broadcast("changed", null);
  return shown();
});
// --- раздел «Виджет» полной версии (сайт в главном окне, preload-app.js) ---
// Только из главного окна и только со страницы сервера из настроек; только эти поля и только допустимые значения.
const fromApp = (e) => {
  try {
    return e.sender === mainWin?.webContents && !mainWin.isLocal && new URL(e.senderFrame.url).origin === new URL(settings.server).origin;
  } catch { return false; }
};
// Вход сайта в главном окне (localStorage «maid.token») — копия в settings.json, зашифрованная, как ключ виджета.
// Хранилище окон Chromium после обновления программы иногда открывается пустым — тогда preload-app.js возвращает вход отсюда.
// Сайт вышел (кнопкой или ключ устарел — 401) — копия стирается.
ipcMain.on("site-login:get", (e) => {
  e.returnValue = "";
  if (!fromApp(e)) return maidLog("вход сайта: просьба вернуть не из главного окна");
  if (!settings.siteTokenEnc) return maidLog("вход сайта: в окне пусто, копии нет — сайт попросит войти");
  try {
    e.returnValue = siteSeen = safeStorage.decryptString(Buffer.from(settings.siteTokenEnc, "base64"));
    maidLog("вход сайта возвращён из настроек");
  } catch (err) {
    maidLog("вход сайта не расшифровался:", err?.message ?? err);
  }
});
let siteSeen = null; // последний вход, пришедший из окна, — тот же не перешифровываем
ipcMain.on("site-login:keep", (e, t) => {
  if (!fromApp(e)) return maidLog("вход сайта: копия пришла не из главного окна");
  if (typeof t !== "string" || t.length > 4000 || t === siteSeen) return;
  siteSeen = t;
  let enc = "";
  if (t) {
    if (!canEncrypt()) return; // без защиты Windows открытым текстом не храним — копия остаётся прежней
    enc = safeStorage.encryptString(t).toString("base64");
  }
  if (!enc && !settings.siteTokenEnc) return;
  // Сайт стирает вход, когда вышли кнопкой или сервер ответил «нужен вход» (401) — в журнал, чтобы выход было видно.
  maidLog(enc ? "вход сайта сохранён" : "сайт вышел — копия входа стёрта");
  settings.siteTokenEnc = enc;
  saveSettings();
});
const oneOf = (...vs) => (v) => vs.includes(v);
const secsOk = (v) => Number.isInteger(v) && v >= 3 && v <= 60;
const WIDGET_PREFS = {
  show: (v) => typeof v === "boolean",
  opacity: (v) => typeof v === "number" && v >= 0.4 && v <= 1,
  side: oneOf("left", "right", "none"),
  size: oneOf("s", "m", "l"),
  plans: oneOf("list", "off"),
  dateLead: oneOf("0", "1", "3", "7"),
  doneTasks: oneOf("keep", "hide"),
  laterTasks: oneOf("hide", "show"),
  proposalWait: secsOk,
  clashWait: secsOk,
  mute: (v) => typeof v === "boolean",
  typing: oneOf("sound", "quiet", "off"),
  typeSpeed: oneOf("slow", "normal", "fast"),
  accent: oneOf("violet", "blue", "green", "pink", "amber"),
  textSize: oneOf("s", "m", "l"),
  taskCount: oneOf(4, 6, 10),
  nextCount: oneOf(1, 3, 5),
  doneHabits: oneOf("dim", "hide"),
  napAfter: oneOf(0, 5, 15, 30, 60),
  napNight: (v) => typeof v === "boolean",
  bedtime: oneOf("auto", "22:00", "23:00", "00:00", "01:00"),
  morning: oneOf(6, 7, 8, 9),
  napRecap: (v) => typeof v === "boolean",
  napFold: (v) => typeof v === "boolean",
  popSound: oneOf("bubble", "chime", "off"),
  sections: (v) => v && typeof v === "object" && Object.entries(v).every(([k, x]) => ["next", "habits", "tasks", "soon"].includes(k) && typeof x === "boolean"),
};
const widgetPrefs = () => Object.fromEntries(Object.keys(WIDGET_PREFS).filter((k) => k in settings.widget).map((k) => [k, settings.widget[k]]));
ipcMain.handle("app:widget-get", (e) => (fromApp(e) ? widgetPrefs() : null));
ipcMain.handle("app:widget-set", (e, patch) => {
  if (!fromApp(e) || !patch || typeof patch !== "object") return null;
  const clean = {};
  for (const [k, v] of Object.entries(patch)) if (WIDGET_PREFS[k]?.(v)) clean[k] = k === "sections" ? { ...settings.widget.sections, ...v } : v;
  settings.widget = { ...settings.widget, ...clean };
  saveSettings();
  widget?.webContents.send("opacity", settings.widget.opacity);
  widget?.webContents.send("prefs");
  if ("show" in clean) toggleWidget(clean.show);
  return widgetPrefs();
});
ipcMain.handle("app:widget-reset", (e) => {
  if (fromApp(e)) resetWidgetPlace();
});
// Общее (раньше — только в меню значка у часов): запуск с Windows и горячие клавиши.
// Клавиша — строка Electron (Ctrl/Alt/Shift/Win + клавиша); занятая другой программой не сохраняется — возвращается ошибка.
const KEY_OK = /^((Control|Alt|Shift|Super)\+){1,3}([A-Z0-9]|F([1-9]|1[0-9]|2[0-4])|Space|Up|Down|Left|Right|Home|End|PageUp|PageDown|Insert|Delete|Backspace|Tab|Enter)$|^F([1-9]|1[0-9]|2[0-4])$/;
const general = () => ({ autostart: Boolean(settings.autostart), canAutostart: app.isPackaged, keys: { ...settings.keys } });
ipcMain.handle("app:general-get", (e) => (fromApp(e) ? general() : null));
ipcMain.handle("app:general-set", (e, patch) => {
  if (!fromApp(e) || !patch || typeof patch !== "object") return null;
  if (typeof patch.autostart === "boolean") {
    settings.autostart = patch.autostart;
    applyAutostart();
  }
  for (const k of ["quick", "grab"]) {
    const key = patch.keys?.[k];
    if (typeof key !== "string" || key === settings.keys[k]) continue;
    const other = k === "quick" ? settings.keys.grab : settings.keys.quick;
    if (!KEY_OK.test(key) || !/(Control|Alt|Super)\+|^(Shift\+)?F\d+$/.test(key)) return { ...general(), error: "Такое сочетание не подходит: нужна клавиша с Ctrl, Alt или Win (или F1–F24)." };
    if (key === other) return { ...general(), error: "Это сочетание уже занято другим действием горничной." };
    const was = settings.keys[k];
    settings.keys = { ...settings.keys, [k]: key };
    registerKeys();
    if (!globalShortcut.isRegistered(key)) {
      settings.keys = { ...settings.keys, [k]: was };
      registerKeys();
      return { ...general(), error: "Это сочетание уже занято другой программой — выберите другое." };
    }
  }
  saveSettings();
  refreshTray();
  return general();
});
// Обновление программы: состояние — в главное окно (раздел «Виджет» → «Программа») и в меню значка.
const updates = createUpdates({
  feed: () => settings.server.replace(/\/$/, "") + "/desktop/",
  onState: (s) => {
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send("app:update", s);
    refreshTray();
  },
  // Установщик закрывает программу жёстко: вход сайта (localStorage главного окна) и куки сначала пишутся на диск, иначе после обновления — экран входа.
  // Окна закрываем сами: при закрытии окно дописывает своё хранилище, а у установщика — убить процесс.
  beforeInstall: async () => {
    quitting = true;
    session.defaultSession.flushStorageData();
    await session.defaultSession.cookies.flushStore();
    for (const w of BrowserWindow.getAllWindows()) w.close();
    await new Promise((r) => setTimeout(r, 1200));
    session.defaultSession.flushStorageData();
    maidLog("обновление: окна закрыты, данные записаны");
  },
  log: maidLog,
});
ipcMain.handle("app:update-get", (e) => (fromApp(e) ? updates.state() : null));
ipcMain.handle("app:update-check", (e) => (fromApp(e) ? updates.check() : null));
ipcMain.handle("app:update-install", (e) => (fromApp(e) ? updates.install() : null));
ipcMain.handle("tracker:now", trackOnce);
// Сколько секунд человек не трогал мышь и клавиатуру (горничная засыпает, когда его нет; заблокированный экран — тоже нет).
ipcMain.handle("idle", () => (powerMonitor.getSystemIdleState(1) === "locked" ? 86_400 : powerMonitor.getSystemIdleTime()));
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
// Строка чата в фокусе — окно не становится «сквозным», даже если курсор ушёл.
let typing = false;
ipcMain.on("focus-input", (_e, on) => {
  if (!widget) return;
  typing = Boolean(on);
  flog("focus-input", on, "grabbed", grabbed);
  applyMouse();
  if (on) {
    widget.focus();
    widget.webContents.focus();
  } else if (!grabbed) {
    overChat = false;
    // Фокус ушёл из строки чата щелчком по облачку или панели — курсор ещё над ними, мышь не отключать посреди щелчка.
    hovering = cursorOver();
    applyMouse();
  }
});
ipcMain.on("quick-show", showQuick);
ipcMain.on("thinking", (_e, on) => widget?.webContents.send("thinking", on));
ipcMain.on("reply", (_e, r) => widget?.webContents.send("reply", r));
ipcMain.on("notify", (_e, title, body) => new Notification({ title, body }).show());

// Ошибки главного процесса — в журнал: без этого сбой запуска (виджет не появился) не оставлял следа.
process.on("uncaughtException", (e) => maidLog("ошибка:", e?.stack ?? e));
process.on("unhandledRejection", (e) => maidLog("ошибка (обещание):", e?.stack ?? e));
const afterUpdate = process.argv.includes("--updated");
maidLog("старт процесса", app.getVersion(), afterUpdate ? "после обновления" : "");
let haveLock = app.requestSingleInstanceLock();
// После обновления установщик запускает новую копию, пока старая может ещё закрываться: подождать её до 15 с, а не закрыться самой.
for (const until = Date.now() + 15_000; !haveLock && afterUpdate && Date.now() < until;) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
  haveLock = app.requestSingleInstanceLock();
}
if (!haveLock) { maidLog("уже запущена — эта копия закрывается"); app.quit(); }
app.on("second-instance", (_e, argv) => { maidLog("второй запуск:", argv.slice(1).filter((a) => a.startsWith("--")).join(" ")); showMain(); });
app.whenReady().then(() => {
  if (!haveLock) return;
  app.setAppUserModelId("Горничная");
  loadSettings();
  tray = new Tray(icon().isEmpty() ? nativeImage.createEmpty() : icon().resize({ width: 16, height: 16 }));
  tray.setToolTip("Горничная");
  tray.on("click", () => showMain());
  refreshTray();
  registerKeys();
  applyAutostart();
  if (settings.widget.show) createWidget();
  maidLog("запуск", app.getVersion(), token() ? "ключ есть" : tokenEnc ? "ключ не расшифровался" : "ключа нет");
  if (!token() && !tokenEnc) showMain(true);
  else if (process.argv.includes("--show")) showMain();
  startTracker();
  // Тихая проверка обновления через минуту после запуска и раз в 6 часов: нашлось — пункт «Обновить до …» в меню значка.
  if (app.isPackaged) {
    setTimeout(() => void updates.check(), 60_000);
    setInterval(() => void updates.check(), 6 * 3600_000);
  }
  watchWidget();
});
app.on("window-all-closed", (e) => e.preventDefault?.());
app.on("will-quit", () => globalShortcut.unregisterAll());
