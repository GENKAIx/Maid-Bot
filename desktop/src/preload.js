const { contextBridge, ipcRenderer } = require("electron");

// Окнам доступно только это — ни Node, ни ключ сервера.
contextBridge.exposeInMainWorld("maid", {
  api: (method, path, body) => ipcRenderer.invoke("api", method, path, body),
  settings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (patch) => ipcRenderer.invoke("settings:set", patch),
  trackNow: () => ipcRenderer.invoke("tracker:now"),
  changed: () => ipcRenderer.send("changed"),
  openMain: () => ipcRenderer.send("open-main"),
  openQuick: () => ipcRenderer.send("quick-show"),
  hideQuick: () => ipcRenderer.send("quick-hide"),
  grab: (on) => ipcRenderer.send("grab", on),
  /** Курсор над горничной или облачком: окну нужна мышь, даже если оно «отпущено». */
  hover: (on) => ipcRenderer.send("hover", on),
  /** Горничная думает (запрос ушёл) / ответила — показать состояние и облачко. */
  thinking: (on) => ipcRenderer.send("thinking", on),
  reply: (r) => ipcRenderer.send("reply", r),
  widgetReady: () => ipcRenderer.send("widget-ready"),
  on: (channel, fn) => {
    if (["grab", "changed", "tracker", "quick-open", "thinking", "reply", "opacity"].includes(channel)) ipcRenderer.on(channel, (_e, data) => fn(data));
  },
});
