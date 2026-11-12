const { contextBridge, ipcRenderer } = require("electron");

// Главное окно — сайт с сервера. Ему доступны только настройки виджета на этом ПК и общее — запуск с Windows, горячие клавиши (раздел «Виджет»): ни ключа, ни api, ни Node.
// main.js проверяет, что вызов пришёл из главного окна со страницы сервера из настроек.
contextBridge.exposeInMainWorld("maidDesktop", {
  widget: () => ipcRenderer.invoke("app:widget-get"),
  saveWidget: (patch) => ipcRenderer.invoke("app:widget-set", patch),
  resetWidget: () => ipcRenderer.invoke("app:widget-reset"),
  general: () => ipcRenderer.invoke("app:general-get"),
  saveGeneral: (patch) => ipcRenderer.invoke("app:general-set", patch),
  // Обновление программы с сервера (updates.js): состояние, проверить, обновить; onUpdate — подписка, возвращает отписку.
  update: () => ipcRenderer.invoke("app:update-get"),
  checkUpdate: () => ipcRenderer.invoke("app:update-check"),
  installUpdate: () => ipcRenderer.invoke("app:update-install"),
  onUpdate: (cb) => {
    const fn = (_e, s) => cb(s);
    ipcRenderer.on("app:update", fn);
    return () => ipcRenderer.removeListener("app:update", fn);
  },
});
