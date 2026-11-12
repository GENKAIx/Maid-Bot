// Обновление программы по кнопке (сайт → «Виджет» → «Программа», и пункт в меню значка у часов).
// electron-updater берёт latest.yml и установщик с сервера горничной (/desktop/, их выкладывает tools/release-desktop.py)
// и ставит новую версию тихо (/S): программа закрывается, ставится и запускается снова; ключ и настройки остаются.
const { app } = require("electron");

// Состояние для страницы: status — idle | checking | latest | available | downloading | ready | error | dev.
function createUpdates({ feed, onState, beforeInstall, log }) {
  let state = { version: app.getVersion(), status: app.isPackaged ? "idle" : "dev" };
  let updater = null;
  let installAfter = false; // нажали «Обновить», пока шла проверка, — сразу качать

  const set = (patch) => {
    state = { ...state, ...patch };
    onState(state);
  };
  const reason = (e) => {
    const m = String(e?.message ?? e);
    if (/404|Cannot find latest\.yml|ENOENT/i.test(m)) return "На сервере пока нет версий программы.";
    if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::|getaddrinfo/i.test(m)) return "Сервер не отвечает — проверьте интернет.";
    return "Не получилось: " + m.split("\n")[0].slice(0, 160);
  };

  function load() {
    if (updater) return updater;
    ({ autoUpdater: updater } = require("electron-updater"));
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.disableDifferentialDownload = true; // сервер отдаёт файл целиком, без частей (Range)
    updater.logger = { info() {}, warn: (m) => log("обновление:", m), error: (m) => log("обновление:", m), debug() {} };
    updater.on("update-available", (info) => {
      set({ status: "available", next: info.version, error: "" });
      if (installAfter) void download();
    });
    updater.on("update-not-available", () => set({ status: "latest", next: "", error: "" }));
    updater.on("download-progress", (p) => set({ status: "downloading", percent: Math.round(p.percent) }));
    updater.on("update-downloaded", () => {
      set({ status: "ready", percent: 100 });
      log("обновление: ставлю", state.next);
      beforeInstall();
      setTimeout(() => updater.quitAndInstall(true, true), 400);
    });
    updater.on("error", (e) => {
      installAfter = false;
      set({ status: "error", error: reason(e) });
    });
    return updater;
  }

  async function check() {
    if (state.status === "dev" || ["checking", "downloading", "ready"].includes(state.status)) return state;
    set({ status: "checking", error: "" });
    try {
      const u = load();
      u.setFeedURL({ provider: "generic", url: feed() });
      await u.checkForUpdates();
    } catch (e) {
      installAfter = false;
      set({ status: "error", error: reason(e) });
    }
    return state;
  }

  async function download() {
    installAfter = false;
    set({ status: "downloading", percent: 0 });
    try {
      await load().downloadUpdate();
    } catch (e) {
      set({ status: "error", error: reason(e) });
    }
  }

  // «Обновить»: есть новая — качать и ставить; ещё не проверяли — проверить и, если есть, сразу ставить.
  async function install() {
    if (state.status === "available") void download();
    else if (state.status === "checking") installAfter = true;
    else if (!["checking", "downloading", "ready", "dev"].includes(state.status)) {
      installAfter = true;
      await check();
    }
    return state;
  }

  return { state: () => state, check, install };
}

module.exports = { createUpdates };
