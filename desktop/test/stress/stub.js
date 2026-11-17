// Заглушка preload.js для виджета в браузере (serve.cjs): window.maid пересылает вызовы настоящему main.js на стенде.
// Ещё здесь: сдвиг часов страницы (?shift=мс или localStorage «__shift» — для полуночи и смены пояса), счётчики будильников
// и список ошибок страницы — window.__stress.
(() => {
  const shift = Number(new URLSearchParams(location.search).get("shift") ?? localStorage.getItem("__shift")) || 0;
  const stress = (window.__stress = { errors: [], shift, timers: { timeouts: 0, intervals: 0, live: new Set(), fired: 0, raf: 0 }, calls: [] });
  addEventListener("error", (e) => stress.errors.push(String(e.message)));
  addEventListener("unhandledrejection", (e) => stress.errors.push("обещание: " + String(e.reason?.message ?? e.reason)));
  const Real = Date;
  class Shifted extends Real {
    constructor(...a) { if (a.length) super(...a); else super(Real.now() + stress.shift); }
    static now() { return Real.now() + stress.shift; }
  }
  window.Date = Shifted;
  // Сколько будильников завела страница, сколько из них живы (утечки) и сколько срабатываний (нагрузка).
  const T = stress.timers;
  const si = window.setInterval, ci = window.clearInterval, sto = window.setTimeout, raf = window.requestAnimationFrame;
  window.setInterval = (f, ms, ...a) => { T.intervals++; const id = si(() => { T.fired++; f(...a); }, ms); T.live.add(id); return id; };
  window.clearInterval = (id) => { T.live.delete(id); ci(id); };
  window.setTimeout = (f, ms, ...a) => { T.timeouts++; return sto(() => { T.fired++; if (typeof f === "function") f(...a); }, ms); };
  window.requestAnimationFrame = (f) => raf((t) => { T.raf++; f(t); });

  const post = (url, body) => fetch(url, { method: "POST", body: JSON.stringify(body) }).then((r) => r.json());
  const invoke = async (channel, ...args) => {
    stress.calls.push(channel === "api" ? `${args[0]} ${args[1]}` : channel);
    const r = await post("/__ipc/invoke", { channel, args });
    if (r.error) throw new Error(r.error);
    return r.value;
  };
  const quiet = ["regions", "hover", "widget-fold"];
  const send = (channel, ...args) => { if (!quiet.includes(channel)) stress.calls.push(channel); void post("/__ipc/send", { channel, args }); };
  const subs = {};
  const es = new EventSource("/__ipc/events");
  es.onmessage = (m) => { const { channel, data } = JSON.parse(m.data); for (const fn of subs[channel] ?? []) fn(data); };
  stress.emit = (channel, data) => { for (const fn of subs[channel] ?? []) fn(data); };
  stress.ctl = (b) => post("/__ctl", b);
  window.maid = {
    api: (method, path, body) => invoke("api", method, path, body),
    settings: () => invoke("settings:get"),
    saveSettings: (patch) => invoke("settings:set", patch),
    login: (form) => invoke("settings:login", form),
    trackNow: () => invoke("tracker:now"),
    idle: () => (stress.idle !== undefined ? Promise.resolve(stress.idle) : invoke("idle")),
    changed: () => send("changed"),
    openMain: () => send("open-main"),
    openDay: (day) => send("open-day", day),
    openSection: (p) => send("open-section", p),
    openQuick: () => send("quick-show"),
    hideQuick: () => send("quick-hide"),
    grab: (on) => send("grab", on),
    hover: (on) => send("hover", on),
    alive: (drawn) => send("alive", drawn),
    thinking: (on) => send("thinking", on),
    reply: (r) => send("reply", r),
    widgetReady: () => send("widget-ready"),
    focusInput: (on) => send("focus-input", on),
    regions: (list) => send("regions", list),
    dragWidget: (phase) => send("widget-drag", phase),
    resetWidget: () => send("widget-reset"),
    resizeWidget: (phase) => send("widget-resize", phase),
    foldState: (folded, miniH, head) => send("widget-fold", folded, miniH, head),
    memFlash: (x, y) => send("mem-flash", x, y),
    memFlashPrep: () => send("mem-flash-prep"),
    downReady: () => send("down-ready"),
    on: (channel, fn) => (subs[channel] ??= []).push(fn),
  };
})();
