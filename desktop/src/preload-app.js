const { contextBridge, ipcRenderer } = require("electron");

// Главное окно — сайт с сервера. Ему доступны только настройки виджета на этом ПК (раздел «Виджет»): ни ключа, ни api, ни Node.
// main.js проверяет, что вызов пришёл из главного окна со страницы сервера из настроек.
contextBridge.exposeInMainWorld("maidDesktop", {
  widget: () => ipcRenderer.invoke("app:widget-get"),
  saveWidget: (patch) => ipcRenderer.invoke("app:widget-set", patch),
  resetWidget: () => ipcRenderer.invoke("app:widget-reset"),
});
