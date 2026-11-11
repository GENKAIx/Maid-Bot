// Заглушка сервера для съёмки трейлера: вымышленный день и ответы на реплики сценария. Подключается до скриптов виджета.
(() => {
  const DAY = "2026-11-10";
  const next = (n) => { const d = new Date(DAY + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const S = (window.__demo = {
    events: [{ id: 1, title: "Созвон с командой", time: "19:30", end_time: "20:15", date_iso: DAY, status: "active" }],
    upcoming: [{ id: 4, title: "Стоматолог", time: "11:00", end_time: "12:00", date_iso: next(3), status: "active" }],
    gone: [],
    tasks: [{ id: 1, title: "Купить корм коту Борису", priority: "high", status: "open", due_date: DAY }, { id: 2, title: "Оплатить интернет", priority: "normal", status: "open", due_date: null },
      { id: 3, title: "Полить кактус Геннадия", priority: "normal", status: "open", due_date: null }],
    habits: [{ id: 1, title: "Зарядка", status: null, streak: 6 }, { id: 2, title: "Вода 2 литра", status: "done", streak: 12 }, { id: 3, title: "Чтение 20 минут", status: null, streak: 3 }],
    dates: [{ id: 5, title: "День рождения Кати", type: "birthday", on: next(2), inDays: 2, age: 27 }],
    wait: 1100,
  });
  const PETYA = { id: 7, title: "Встреча с Петей", time: "15:00", end_time: "16:00", date_iso: next(1), status: "active" };
  const today = () => ({ day: DAY, events: S.events, upcoming: S.upcoming, done_fresh: [], gone_fresh: S.gone, dates: S.dates, tasks: S.tasks.filter((t) => t.status === "open"),
    habits: S.habits, done: [], doneTasks: [], done_today: [] });
  S.seedPetya = () => { S.upcoming = [PETYA, ...S.upcoming.filter((e) => e.id !== 7)]; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let mid = 100;
  async function input(text) {
    await sleep(S.wait);
    const t = text.toLowerCase();
    const id = ++mid;
    if (/встреча с петей/.test(t)) {
      S.upcoming = [PETYA, ...S.upcoming];
      S.tasks.push({ id: 9, title: "Купить лампочку", priority: "normal", status: "open", due_date: null });
      S.dates = [...S.dates, { id: 6, title: "День рождения мамы", type: "birthday", on: "2027-03-05", inDays: 115 }];
      return { text: "Записала всё.", emotion: "happy", undoable: true, messageId: id, changes: [{ kind: "event", title: "Встреча с Петей", detail: "завтра 15:00" },
        { kind: "task", title: "Купить лампочку", detail: "" }, { kind: "date", title: "День рождения мамы", detail: "5 марта" }] };
    }
    if (/отмени/.test(t)) {
      S.upcoming = S.upcoming.filter((e) => e.id !== 7);
      S.gone = [{ ...PETYA, status: "cancelled" }];
      return { text: "Отменила встречу с Петей.", emotion: "neutral", undoable: true, messageId: id, changes: [{ kind: "edit", title: "Встреча с Петей", detail: "отменена" }] };
    }
    if (/верни/.test(t)) {
      S.gone = [];
      S.upcoming = [PETYA, ...S.upcoming.filter((e) => e.id !== 7)];
      return { text: "Вернула: встреча с Петей, завтра в 15:00.", emotion: "happy", undoable: false, messageId: id, changes: [{ kind: "event", title: "Встреча с Петей", detail: "завтра 15:00" }] };
    }
    if (/репетиц/.test(t)) {
      S.upcoming = [...S.upcoming, { id: 8, title: "Репетиция группы", time: "15:00", end_time: "16:30", date_iso: next(1), status: "active" }];
      return { text: "Записала. Но на 15:00 уже стоит «Встреча с Петей».", emotion: "worried", undoable: true, messageId: id, changes: [{ kind: "event", title: "Репетиция группы", detail: "завтра 15:00" }],
        clash: { eventId: 8, withId: 7, shiftTo: "16:00" } };
    }
    if (/стрижк/.test(t)) {
      S.upcoming = [...S.upcoming, { id: 11, title: "Стрижка", time: "12:00", end_time: "13:00", date_iso: next(5), status: "active" }];
      return { text: "Записала: стрижка в субботу в 12:00.", emotion: "happy", undoable: true, messageId: id, changes: [{ kind: "event", title: "Стрижка", detail: "суббота 12:00" }] };
    }
    if (/познакомил/.test(t)) return { text: "Ну и как, перепало что-нибудь? 😏", emotion: "teasing", undoable: false, messageId: id };
    if (/забудь/.test(t)) return { text: "Я ничего не слышала.", emotion: "awkward", undoable: false, messageId: id };
    if (/спасиб/.test(t)) return { text: "Ой… всегда пожалуйста 😊", emotion: "happy", undoable: false, messageId: id };
    return { text: "Записала.", emotion: "neutral", undoable: false, messageId: id };
  }
  async function api(m, p, body) {
    if (p === "/api/today" || p.startsWith("/api/today")) return today();
    if (p === "/api/input") return input(body?.text ?? "");
    if (p === "/api/clash") { const e = S.upcoming.find((x) => x.id === body.eventId); if (e && body.action === "shift") { e.time = "16:00"; e.end_time = "17:30"; } return { text: body.action === "shift" ? "Сдвинула репетицию на 16:00." : "Хорошо, оставила оба." }; }
    if (m === "POST" && /^\/api\/tasks\/\d+/.test(p)) { const t = S.tasks.find((x) => x.id === Number(p.split("/")[3])); if (t) t.status = body?.status ?? "done"; return { ...t }; }
    if (/^\/api\/habits\/\d+\/mark/.test(p)) { const h = S.habits.find((x) => x.id === Number(p.split("/")[3])); if (h) { h.status = body.status; if (body.status === "done") h.streak = (h.streak ?? 0) + 1; } return { text: body.status === "done" ? "✅ Отмечено" : "➖ Пропуск" }; }
    if (p.startsWith("/api/events")) return [...S.events, ...S.upcoming];
    if (p.startsWith("/api/notices")) return [];
    return {};
  }
  const base = {
    api, on(ch, fn) { (window.__h ??= {})[ch] = fn; }, downReady() { setTimeout(() => window.__h?.["down-shown"]?.(), 30); },
    settings: async () => ({ keys: { grab: "Alt+Shift+M", quick: "Alt+Shift+Space" }, widget: { opacity: 0.92, side: "right", size: "m" } }),
    collapsed: async () => false, idle: async () => 0,
  };
  window.maid = new Proxy(base, { get(t, k) { if (k in t) return t[k]; if (k === "memFlash" || k === "memFlashPrep") return undefined; return (...a) => (typeof a[0] === "function" ? undefined : Promise.resolve(undefined)); } });
  try { localStorage.clear(); } catch {}
})();
