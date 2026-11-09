window.maid = {
  api: async (m, p, body) => {
    window.__marks ??= { "2026-11-01": "done", "2026-11-02": "done", "2026-11-04": "done", "2026-11-05": "done", "2026-11-06": "done", "2026-11-07": "done" };
    const mk = (id, title, start, n, marks, today = "2026-11-08", step = 1) => {
      const c = []; const d0 = new Date(start + "T12:00:00Z");
      for (let i = 0; i < n; i++) { const day = new Date(d0.getTime() + i * 864e5).toISOString().slice(0, 10); const m = marks[day];
        c.push({ day, s: i % step ? "rest" : m === "done" ? "done" : m === "skipped" ? "miss" : day < today ? "miss" : day === today ? "today" : "wait" }); }
      return { id, title, status: marks[today] ?? null, streak: 3, course: c };
    };
    if (m === "POST" && p.startsWith("/api/events/")) { const id = Number(p.split("/")[3]); const e = window.__events.find((x) => x.id === id) ?? (window.__gone ??= {})[id]; if (body.status === "active") { if (e && !window.__events.includes(e)) window.__events.push(e); } else { (window.__gone ??= {})[id] = e; window.__events = window.__events.filter((x) => x.id !== id); } return { ...e, status: body.status }; }
    if (m === "GET" && p.startsWith("/api/events")) return [{ id: 90, title: "Далёкий план", time: "11:00", date_iso: "2026-11-25" }];
    if (p.startsWith("/api/tasks/")) { const id = Number(p.split("/")[3]); window.__tasks = window.__tasks.filter((t) => t.id !== id); return {}; }
    if (p.startsWith("/api/habits/")) { const id = Number(p.split("/")[3]); const tgt = id === 2 ? (window.__m2 ??= {}) : window.__marks; tgt[body.day ?? "2026-11-08"] = body.status; return { text: body.status === "done" ? "✅ Отмечено" : "➖ Пропуск" }; }
    if (p === "/api/today") return { day: "2026-11-08", events: (window.__events ??= [{ id: 1, title: "Репетиция группы", time: "19:30", end_time: "20:30", date_iso: "2026-11-08" }, { id: 2, title: "Обед с Лёшей", time: "13:00", end_time: "14:00", date_iso: "2026-11-08" }, { id: 3, title: "Йога на балконе", time: "08:00", end_time: "09:00", date_iso: "2026-11-08" }, { id: 4, title: "Квиз в баре", time: "21:00", end_time: "23:00", date_iso: "2026-11-08" }, { id: 5, title: "Забрать посылку", date_iso: "2026-11-08" }]), upcoming: [],
      tasks: (window.__tasks ??= [{ id: 1, title: "Полить кактус Геннадия", priority: "normal" }, { id: 2, title: "Батарейки для геймпада", priority: "high" }, { id: 3, title: "Вернуть книгу в библиотеку", priority: "normal", due_date: "2026-11-05" }]), dates: [{ id: 5, title: "День рождения Кати", type: "birthday", on: "2026-11-09", inDays: 1, age: 27 }, { id: 6, title: "Коту Борису 3 года", type: "anniversary", on: "2026-11-12", inDays: 4 }], habits: [{ id: 1, title: "Вода 2 литра", status: "done", streak: 5 },
        mk(7, "Омега-3", "2026-11-01", 30, window.__marks), ...(window.__two ? [mk(2, "Магний", "2026-11-05", 14, (window.__m2 ??= {}))] : [])] };
    if (p === "/api/voice") { await new Promise((r)=>setTimeout(r,700)); return { heard: "завтра в десять записаться на стрижку", text: "Записала, хозяин.", emotion: "happy", changes: [{ kind: "task", title: "Записаться на стрижку", detail: "завтра 10:00" }], undoable: true, messageId: 9 }; }
    if (p.startsWith("/api/notices")) return [];
    if (p === "/api/input" && /\?/.test(body?.text || "")) { await new Promise((r)=>setTimeout(r,600)); return { text: "Бегал 14 марта и 2 октября, хозяин. Пора снова!\n📅 <a href=\"x\">14 марта</a> · <a href=\"x\">2 октября</a>", emotion: "worried", undoable: false, messageId: 7, days: ["2026-03-14","2026-10-02"] }; }
    if (p === "/api/input") {
      await new Promise((r) => setTimeout(r, 1200));
      return { text: "Записала, хозяин.\n📓 Сон, Спорт\n📅 планов: 1", emotion: "happy", undoable: true, messageId: 5,
        changes: [{ kind: "diary", title: "Сон", detail: "спал 8 часов, бодрый" }, { kind: "diary", title: "Спорт · Бег", detail: "5 км" }, { kind: "event", title: "Концерт", detail: "13 ноября 19:00" }, { kind: "metric", title: "Сон", detail: "8 ч" }] };
    }
    return { text: "ок" };
  },
  _w: { opacity: 0.92, side: "right", size: "m" },
  settings: async function () { return { keys: { grab: "Alt+Shift+M", quick: "Alt+Shift+Space" }, widget: this._w }; },
  saveSettings: async function (p) { Object.assign(this._w, p.widget); return {}; },
  dragWidget(p) { (window.__drag = window.__drag || []).push(p); }, resetWidget() { window.__reset = true; }, regions(r) { window.__regions = r; },
  changed() {}, openMain() {}, openQuick() {}, hideQuick() {}, grab() {}, hover() {}, thinking() {}, reply() {}, widgetReady() {}, focusInput() {}, openDay(d) { window.__opened = d; },
  on(ch, fn) { window.__h = window.__h || {}; window.__h[ch] = fn; },
};
