const { contextBridge, ipcRenderer } = require("electron");

// Главное окно — сайт с сервера. Ему доступны только настройки виджета на этом ПК и общее — запуск с Windows, горячие клавиши (раздел «Виджет»): ни ключа, ни api, ни Node.
// main.js проверяет, что вызов пришёл из главного окна со страницы сервера из настроек.
// Один вход на программу (main.js, site-login:*): сайт (localStorage «maid.token», web/src/api.ts) и виджет — с одним ключом.
// Окно открылось — вход программы главнее: он кладётся сайту до того, как сайт его прочитает (preload выполняется раньше скриптов
// страницы). У программы входа нет, а у сайта есть — он и становится входом программы. Дальше раз в 1,5 с сверяем:
// вошли на сайте — это вход программы, вышли (кнопкой или ключ устарел — сайт стёр его) — программа тоже выходит.
try {
  const KEY = "maid.token";
  const mine = ipcRenderer.sendSync("site-login:get");
  let last = localStorage.getItem(KEY) ?? "";
  if (mine && mine !== last) { localStorage.setItem(KEY, mine); last = mine; }
  else if (!mine && last) ipcRenderer.send("site-login:keep", last);
  setInterval(() => {
    const now = localStorage.getItem(KEY) ?? "";
    if (now !== last) ipcRenderer.send("site-login:keep", (last = now));
  }, 1500);
} catch { /* хранилище недоступно — сайт попросит войти, как обычно */ }

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
