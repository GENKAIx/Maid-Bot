const { contextBridge, ipcRenderer } = require("electron");

// Окнам доступно только это — ни Node, ни ключ сервера.
contextBridge.exposeInMainWorld("maid", {
  api: (method, path, body) => ipcRenderer.invoke("api", method, path, body),
  settings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (patch) => ipcRenderer.invoke("settings:set", patch),
  /** Вход логином и паролем (только окно настроек): { server, login, password }. */
  login: (form) => ipcRenderer.invoke("settings:login", form),
  trackNow: () => ipcRenderer.invoke("tracker:now"),
  idle: () => ipcRenderer.invoke("idle"),
  changed: () => ipcRenderer.send("changed"),
  openMain: () => ipcRenderer.send("open-main"),
  /** Открыть день дневника в веб-приложении (браузер). */
  openDay: (day) => ipcRenderer.send("open-day", day),
  /** Открыть раздел приложения в главном окне: "/money", "/diary/2026-11-09"… */
  openSection: (path) => ipcRenderer.send("open-section", path),
  openQuick: () => ipcRenderer.send("quick-show"),
  hideQuick: () => ipcRenderer.send("quick-hide"),
  grab: (on) => ipcRenderer.send("grab", on),
  /** Курсор над горничной или облачком: окну нужна мышь, даже если оно «отпущено». */
  hover: (on) => ipcRenderer.send("hover", on),
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
  on: (channel, fn) => {
    if (["grab", "changed", "tracker", "quick-open", "thinking", "reply", "opacity", "down", "down-shown", "prefs"].includes(channel)) ipcRenderer.on(channel, (_e, data) => fn(data));
  },
});
