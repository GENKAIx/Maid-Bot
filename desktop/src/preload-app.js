const { contextBridge, ipcRenderer } = require("electron");

// Главное окно — сайт с сервера. Ему доступны только настройки виджета на этом ПК и общее — запуск с Windows, горячие клавиши (раздел «Виджет»): ни ключа, ни api, ни Node.
// main.js проверяет, что вызов пришёл из главного окна со страницы сервера из настроек.
// Вход сайта (localStorage «maid.token», web/src/api.ts) держим и в настройках программы: после обновления хранилище окна
// бывает пустым — тогда вход возвращается до того, как сайт его прочитает (preload выполняется раньше скриптов страницы).
// Дальше раз в 1,5 с сверяем: вошли — копия обновится, вышли или ключ устарел (сайт стёр его) — копия сотрётся.
try {
  const KEY = "maid.token";
  let last = localStorage.getItem(KEY) ?? "";
  if (!last) {
    const saved = ipcRenderer.sendSync("site-login:get");
    if (saved) { localStorage.setItem(KEY, saved); last = saved; }
  }
  if (last) ipcRenderer.send("site-login:keep", last); // пусто — копию не трогаем: защита Windows могла ещё не ответить
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
