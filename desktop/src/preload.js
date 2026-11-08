const { contextBridge, ipcRenderer } = require("electron");

// Окнам доступно только это — ни Node, ни ключ сервера.
contextBridge.exposeInMainWorld("maid", {
  api: (method, path, body) => ipcRenderer.invoke("api", method, path, body),
  settings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (patch) => ipcRenderer.invoke("settings:set", patch),
  trackNow: () => ipcRenderer.invoke("tracker:now"),
  changed: () => ipcRenderer.send("changed"),
  openMain: () => ipcRenderer.send("open-main"),
  hideQuick: () => ipcRenderer.send("quick-hide"),
  grab: (on) => ipcRenderer.send("grab", on),
  on: (channel, fn) => {
    if (["grab", "changed", "tracker", "quick-open"].includes(channel)) ipcRenderer.on(channel, (_e, data) => fn(data));
  },
});
