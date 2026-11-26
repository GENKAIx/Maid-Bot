// Заглушка preload.js для живого показа виджета в «Витрине» админки (server/src/preview.ts вставляет её первым скриптом
// в настоящий desktop/renderer/widget.html). В отличие от стенда desktop/test/stress/stub.js — без стенда и без сети:
// window.maid отвечает из памяти тестовыми данными (не данные человека), записи никуда не уходят, к серверу запросов нет.
// Ещё здесь: адреса картинок и звуков с меткой версии и без предзагрузки всех анимаций (ниже), localStorage в памяти (виджет
// на одном адресе с сайтом и иначе писал бы в его хранилище; экскурсия первого запуска уже «пройдена»), замедление
// показа (window.__preview.speed: таймеры, performance.now, Date.now, кадры rAF и CSS-анимации) и window.__preview — общий объект с control.js (данные дня, погода, вызовы).
// Методы window.maid — те же, что у desktop/src/preload.js; что их не меньше и что виджет при загрузке не зовёт ничего
// другого, проверяет server/test/preview.test.ts.
(() => {
  const P = (window.__preview = { k: 1, calls: [], errors: [], subs: {}, weather: null, data: null, settings: null });
  addEventListener("error", (e) => P.errors.push(`${e.message} @ ${String(e.filename).split("/").pop()}:${e.lineno}`));
  addEventListener("unhandledrejection", (e) => P.errors.push("обещание: " + String(e.reason?.message ?? e.reason)));

  // --- файлы с меткой версии и только своя анимация (26.11.2026, server/src/preview.ts PreviewFiles) ---
  // Сервер кладёт в страницу список «путь → метка» (<script type="application/json" id="preview-files">). Адреса картинок и
  // звуков, которые виджет собирает сам (`../assets/maid/${n}.webp`, new Audio(…)), получают ?v=<метка> — такой адрес браузер
  // берёт из своего кэша без запроса (immutable). Предзагрузку всех 41 анимации (widget.js: new Image().src = … для каждой)
  // показ пропускает: картинке, которой нет на странице, адрес анимации не ставится (P.lazy — что пропущено) — карточка тянет
  // только то, что показывает горничная (idle из разметки и свою анимацию).
  let files = {};
  try { files = JSON.parse(document.getElementById?.("preview-files")?.textContent || "{}") || {}; } catch {}
  P.files = files;
  P.lazy = [];
  const ROOT = "/admin-preview/";
  P.url = (u) => {
    try {
      const x = new URL(String(u), location.href);
      const v = x.origin === location.origin && x.pathname.startsWith(ROOT) && !x.searchParams.has("v") ? files[x.pathname.slice(ROOT.length)] : undefined;
      if (!v) return String(u);
      x.searchParams.set("v", v);
      return x.href;
    } catch { return String(u); }
  };
  const isMaid = (u) => /\/assets\/maid\/[a-z0-9-]+\.webp(\?|$)/.test(u);
  const imgSrc = typeof HTMLImageElement !== "undefined" ? Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src") : null;
  if (imgSrc?.set) {
    Object.defineProperty(HTMLImageElement.prototype, "src", {
      configurable: true, enumerable: imgSrc.enumerable, get: imgSrc.get,
      set(v) {
        const u = P.url(v);
        if (!this.isConnected && isMaid(u)) return void P.lazy.push(u);
        imgSrc.set.call(this, u);
      },
    });
  }
  const RealAudio = window.Audio;
  if (typeof RealAudio === "function") {
    const Audio = function Audio(src) { return src === undefined ? new RealAudio() : new RealAudio(P.url(src)); };
    Audio.prototype = RealAudio.prototype;
    window.Audio = Audio;
  }

  // --- localStorage в памяти: экскурсия и подсказки уже видены, остальное — пусто ---
  const mem = new Map([["maid.tour", "1"], ["maid.miniSeen", String(Date.now())]]);
  const store = {
    getItem: (k) => (mem.has(String(k)) ? mem.get(String(k)) : null),
    setItem: (k, v) => void mem.set(String(k), String(v)),
    removeItem: (k) => void mem.delete(String(k)),
    clear: () => mem.clear(),
    key: (i) => [...mem.keys()][i] ?? null,
    get length() { return mem.size; },
  };
  try { Object.defineProperty(window, "localStorage", { value: store, configurable: true }); } catch {}
  try { Object.defineProperty(window, "sessionStorage", { value: store, configurable: true }); } catch {}

  // --- замедление: k — во сколько раз быстрее обычного (0.25 — вчетверо медленнее) ---
  const realTimeout = window.setTimeout.bind(window), realInterval = window.setInterval.bind(window);
  const realRaf = window.requestAnimationFrame.bind(window), realNow = performance.now.bind(performance);
  let base = realNow(), vbase = base;
  const vnow = () => vbase + (realNow() - base) * P.k;
  // Date.now — тоже медленно: праздники привычек (habitparty.js) считают по нему задержки CSS-анимаций и сколько держать ярлык.
  const realDate = Date.now.bind(Date);
  let dbase = realDate(), dvbase = dbase;
  const vdate = () => Math.round(dvbase + (realDate() - dbase) * P.k);
  try { Date.now = vdate; } catch {}
  const scaled = (ms) => Math.max(0, Number(ms) || 0) / P.k;
  window.setTimeout = (f, ms, ...a) => realTimeout(f, scaled(ms), ...a);
  window.setInterval = (f, ms, ...a) => realInterval(f, scaled(ms), ...a);
  window.requestAnimationFrame = (f) => realRaf(() => f(vnow()));
  try { performance.now = vnow; } catch {}
  let rateSet = 1;
  const syncAnims = () => {
    if (P.k === 1 && rateSet === 1) return;
    for (const a of document.getAnimations?.() ?? []) if (a.playbackRate !== P.k) a.playbackRate = P.k;
    rateSet = P.k;
  };
  realInterval(syncAnims, 50);
  P.speed = (k) => {
    k = Number(k) > 0 ? Math.min(4, Number(k)) : 1;
    vbase = vnow();
    base = realNow();
    dvbase = vdate();
    dbase = realDate();
    P.k = k;
    syncAnims();
  };
  P.realTimeout = realTimeout;

  // --- тестовые данные дня (той же формы, что GET /api/today; имена и дела выдуманы) ---
  const pad = (n) => String(n).padStart(2, "0");
  const dayKey = (t = new Date()) => `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
  const dayPlus = (n) => { const t = new Date(); t.setDate(t.getDate() + n); return dayKey(t); };
  const hm = (t) => `${pad(t.getHours())}:${pad(t.getMinutes())}`;
  const soon = (min) => hm(new Date(Date.now() + min * 60_000));
  P.dayKey = dayKey;
  P.dayPlus = dayPlus;
  P.soon = soon;
  P.sample = () => ({
    tasks: [
      { id: 1, title: "Оплатить интернет", priority: "high", due_date: dayKey() },
      { id: 2, title: "Позвонить маме", priority: "normal", due_date: null },
      { id: 3, title: "Разобрать почту", priority: "low", due_date: dayPlus(2) },
    ],
    habits: [
      { id: 1, title: "Зарядка", status: null, streak: 4 },
      { id: 2, title: "Пить воду", status: "done", streak: 12 },
    ],
    events: [
      { id: 11, title: "Спортзал", date_iso: dayKey(), time: soon(50), end_time: null, status: "active" },
      { id: 12, title: "Созвон с командой", date_iso: dayKey(), time: soon(190), end_time: null, status: "active" },
    ],
    upcoming: [{ id: 13, title: "Стоматолог", date_iso: dayPlus(1), time: "10:30", end_time: null, status: "active" }],
  });
  P.data = P.sample();
  const xpOf = (xp) => {
    let level = 1, left = xp;
    while (left >= 100 + 25 * (level - 1)) { left -= 100 + 25 * (level - 1); level++; }
    return { xp, level, into: left, need: 100 + 25 * (level - 1) };
  };
  P.today = () => ({
    day: dayKey(), dates: [], done_today: [], diary: [], activity: [], far_fresh: [], gone_fresh: [], done_fresh: [],
    bed: "auto", wake: 7, wake_at: "07:00", xp: xpOf(740), ...P.data,
  });
  // Настройки виджета для показа: без звука (включается кнопкой), не засыпает, эффекты «празднично» (каждая реплика может
  // быть с эффектом — правило «не чаще одной из трёх» показу мешало бы), погода видна весь день.
  P.settings = { server: "", widget: { mute: true, napAfter: 0, napFold: false, fx: "festive", weatherChip: "day", weatherMorning: false, typing: "sound" } };

  const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
  const api = async (method, path, body) => {
    P.calls.push(`${method} ${String(path).split("?")[0]}`);
    const p = String(path).split("?")[0];
    if (method === "GET") {
      if (p === "/api/today") return clone(P.today());
      if (p === "/api/notices" || p === "/api/events") return [];
      if (p === "/api/weather") return { weather: clone(P.weather) };
      return {};
    }
    void body;
    if (p === "/api/input" || p === "/api/voice") return { text: "Это витрина: здесь ничего не записывается 🙂", emotion: "teasing", changes: [], messageId: Date.now() };
    return { ok: true, text: "Готово" };
  };
  const quiet = (name) => (...a) => { P.calls.push(name); void a; };
  const subs = P.subs;
  P.emit = (channel, data) => { for (const fn of subs[channel] ?? []) fn(data); };
  window.maid = {
    api,
    openPay: async () => "",
    settings: async () => clone(P.settings),
    saveSettings: async (patch) => {
      P.settings = { ...P.settings, ...patch, widget: { ...P.settings.widget, ...(patch?.widget ?? {}) } };
      return clone(P.settings);
    },
    login: async () => { throw new Error("в витрине вход не нужен"); },
    trackNow: async () => ({}),
    idle: async () => 0,
    changed: quiet("changed"),
    openMain: quiet("openMain"),
    openSection: quiet("openSection"),
    openQuick: quiet("openQuick"),
    hideQuick: quiet("hideQuick"),
    grab: quiet("grab"),
    hover: () => {},
    alive: () => {},
    thinking: quiet("thinking"),
    reply: quiet("reply"),
    widgetReady: quiet("widgetReady"),
    focusInput: () => {},
    regions: () => {},
    dragWidget: () => {},
    resetWidget: quiet("resetWidget"),
    resizeWidget: () => {},
    foldState: () => {},
    memFlash: undefined, // без программы вспышка «стираю память» рисуется внутри страницы (widget.js forgetFlash)
    memFlashPrep: () => {},
    downReady: () => {},
    installUpdate: quiet("installUpdate"),
    track: () => {},
    crash: (e) => P.errors.push(String(e?.message ?? e)),
    look: {
      asset: async (name, keep) => (keep ? null : `../assets/maid/${name}.webp`),
      get: async () => null,
      put: async () => false,
      keep: async () => true,
    },
    on: (channel, fn) => void (subs[channel] ??= []).push(fn),
  };
})();
