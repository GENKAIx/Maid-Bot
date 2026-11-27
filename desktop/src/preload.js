const { contextBridge, ipcRenderer } = require("electron");

// Окнам доступно только это — ни Node, ни ключ сервера.
contextBridge.exposeInMainWorld("maid", {
  api: (method, path, body) => ipcRenderer.invoke("api", method, path, body),
  /** Нужна подписка (сервер ответил 402): открыть счёт Telegram в браузере системы (main.js pay-open) → "" или текст ошибки. */
  openPay: () => ipcRenderer.invoke("pay-open"),
  settings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (patch) => ipcRenderer.invoke("settings:set", patch),
  /** Вход логином и паролем: окно настроек — { server, login, password }, виджет — { server, login, password } (пустой адрес — из настроек). */
  login: (form) => ipcRenderer.invoke("settings:login", form),
  /** Тестовый аккаунт (settings.testId): вернуться в свой — тестовый ключ закрывается, свой отложенный встаёт на место (main.js). */
  switchBack: () => ipcRenderer.invoke("settings:switch-back"),
  trackNow: () => ipcRenderer.invoke("tracker:now"),
  idle: () => ipcRenderer.invoke("idle"),
  changed: () => ipcRenderer.send("changed"),
  openMain: () => ipcRenderer.send("open-main"),
  /** Открыть раздел приложения в главном окне: "/money", "/diary/2026-11-09"… */
  openSection: (path) => ipcRenderer.send("open-section", path),
  openQuick: () => ipcRenderer.send("quick-show"),
  hideQuick: () => ipcRenderer.send("quick-hide"),
  grab: (on) => ipcRenderer.send("grab", on),
  /** Курсор над горничной или облачком: окну нужна мышь, даже если оно «отпущено». */
  hover: (on) => ipcRenderer.send("hover", on),
  alive: (drawn, hidden) => ipcRenderer.send("alive", drawn, hidden), // сторож виджета (main.js, patrolWidget)
  /** Горничная думает (запрос ушёл) / ответила — показать состояние и облачко. */
  thinking: (on) => ipcRenderer.send("thinking", on),
  reply: (r) => ipcRenderer.send("reply", r),
  widgetReady: () => ipcRenderer.send("widget-ready"),
  /** Строка чата получила/потеряла фокус: окну нужна клавиатура. */
  focusInput: (on) => ipcRenderer.send("focus-input", on),
  /** Где на окне что-то есть (панель, облачко, фигурка) — там окно принимает мышь, остальное сквозное. */
  regions: (list) => ipcRenderer.send("regions", list),
  /** Перетаскивание виджета за шапку: start / move / end — окно идёт за курсором. */
  dragWidget: (phase) => ipcRenderer.send("widget-drag", phase),
  /** Вернуть виджет в правый нижний угол основного экрана. */
  resetWidget: () => ipcRenderer.send("widget-reset"),
  /** Вытянуть панель за правый нижний угол: start / move / end, reset — исходная высота. */
  resizeWidget: (phase) => ipcRenderer.send("widget-resize", phase),
  /** Свёрнут ли виджет и высота свёрнутой карточки — main решает, раскрываться ли панели вниз (у верха экрана). */
  foldState: (folded, miniH, head) => ipcRenderer.send("widget-fold", folded, miniH, head),
  /** Вспышка «стираю память» из точки экрана (x, y) — окнами поверх всех мониторов, чтобы свет не обрезал край виджета. */
  memFlash: (x, y) => ipcRenderer.send("mem-flash", x, y),
  /** Горничная подняла прибор — загрузить окна вспышки заранее. */
  memFlashPrep: () => ipcRenderer.send("mem-flash-prep"),
  /** Окно применило режим «вниз» (и спрятано) — main может сдвинуть его. */
  downReady: () => ipcRenderer.send("down-ready"),
  /** Скачать и поставить новую версию программы (значок-шестерёнка в виджете); состояние приходит событием "update". */
  installUpdate: () => ipcRenderer.send("update-install"),
  /** Счётчик фичи для админки (main.js → usage.js): только имя из белого списка, без данных. */
  track: (name) => ipcRenderer.send("usage", name),
  /** Ошибка окна для админки «Падения» (renderer/common.js → main.js → crashes.js): main оставит только тип, место и отпечаток. */
  crash: (e) => ipcRenderer.send("crash", { name: String(e?.name ?? "").slice(0, 60), message: String(e?.message ?? "").slice(0, 500), stack: String(e?.stack ?? "").slice(0, 4000) }),
  /** «Перекрасить Рину» (maidlook.js): исходники из assets и кэш перекрашенных анимаций в userData/maid-look (только виджет). */
  look: {
    asset: (name, keep) => ipcRenderer.invoke("look:asset", name, keep),
    get: (set, name) => ipcRenderer.invoke("look:get", set, name),
    put: (set, name, bytes) => ipcRenderer.invoke("look:put", set, name, bytes),
    keep: (set) => ipcRenderer.invoke("look:keep", set),
  },
  on: (channel, fn) => {
    if (["grab", "changed", "tracker", "quick-open", "thinking", "reply", "opacity", "down", "down-shown", "prefs", "tour", "update", "updated"].includes(channel)) ipcRenderer.on(channel, (_e, data) => fn(data));
  },
});
