// Поддельный сервер горничной для стресс-проверок: отвечает как настоящий на то, что спрашивает виджет, и умеет ломаться —
// молчать, рвать соединение до и после обработки запроса, обрывать ответ на середине, отдавать не JSON, 401/500/502, перенаправлять.
// Режим сбоя: srv.fault = { mode, ms, only } (only — регулярное выражение пути; без него — все /api/…).
const http = require("node:http");

const pad = (n) => String(n).padStart(2, "0");
const dayKey = (t = new Date()) => `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
const dayPlus = (n, from = new Date()) => { const t = new Date(from); t.setDate(t.getDate() + n); return dayKey(t); };
const hm = (t) => `${pad(t.getHours())}:${pad(t.getMinutes())}`;

/** Наборы данных для /api/today. now — «сейчас» виджета (для сдвинутых часов). */
const DATASETS = {
  normal: (now) => ({
    tasks: [
      { id: 1, title: "Оплатить интернет", priority: "high", due_date: dayKey(now) },
      { id: 2, title: "Позвонить маме", priority: "normal", due_date: null },
      { id: 3, title: "Разобрать почту", priority: "low", due_date: dayPlus(2, now) },
      { id: 4, title: "Сдать отчёт", priority: "normal", due_date: dayPlus(-1, now) },
    ],
    habits: [
      { id: 1, title: "Зарядка", status: null, streak: 4 },
      { id: 2, title: "Пить воду", status: "done", streak: 12 },
      { id: 3, title: "Читать 20 минут", status: null, streak: 0 },
    ],
    events: [
      { id: 11, title: "Спортзал", date_iso: dayKey(now), time: hm(new Date(now.getTime() + 44 * 60000)), end_time: null, status: "active" },
      { id: 12, title: "Созвон с командой", date_iso: dayKey(now), time: hm(new Date(now.getTime() + 3 * 3600000)), end_time: null, status: "active" },
    ],
    upcoming: [{ id: 13, title: "Стоматолог", date_iso: dayPlus(1, now), time: "10:30", end_time: null, status: "active" }],
  }),
  empty: () => ({ tasks: [], habits: [], events: [], upcoming: [] }),
  many: (now) => ({
    tasks: Array.from({ length: 500 }, (_, i) => ({ id: 1000 + i, title: `Задача номер ${i + 1} из пятисот`, priority: ["high", "normal", "low"][i % 3], due_date: i % 4 ? dayPlus((i % 9) - 2, now) : null })),
    habits: Array.from({ length: 40 }, (_, i) => ({ id: 100 + i, title: `Привычка ${i + 1}`, status: i % 3 ? null : "done", streak: i })),
    events: Array.from({ length: 30 }, (_, i) => ({ id: 2000 + i, title: `План ${i + 1}`, date_iso: dayKey(now), time: `${pad(8 + Math.floor(i / 3))}:${pad((i % 3) * 20)}`, end_time: null, status: "active" })),
    upcoming: [],
  }),
  nasty: (now) => ({
    tasks: [
      { id: 21, title: `<script>window.__xss = "task"</script><img src=x onerror="window.__xss='img'">`, priority: "high", due_date: dayKey(now) },
      { id: 22, title: "Длинное".repeat(286), priority: "normal", due_date: null },
      { id: 23, title: "БезПробеловОченьДлинноеСлово".repeat(80), priority: "normal", due_date: null },
      { id: 24, title: "مرحبا بالعالم — شراء الخبز ‮DESREVER‬ текст после", priority: "normal", due_date: dayPlus(1, now) },
      { id: 25, title: "👨‍👩‍👧‍👦🏳️‍🌈🧑🏽‍🚀 Z̸̢͓̓a̴̧͗l̷̰͝g̶͚̈́o̵͉͝ 🇷🇺".repeat(6), priority: "low", due_date: null },
      { id: 26, title: `"кавычки" 'одинарные' & амперсанд </li></ul><h1>верстка</h1>`, priority: "normal", due_date: null },
      { id: 27, title: "", priority: "normal", due_date: null },
    ],
    habits: [
      { id: 31, title: `<b onmouseover="window.__xss='habit'">Привычка</b>`, status: null, streak: 3 },
      { id: 32, title: "Очень-очень длинная привычка ".repeat(70), status: null, streak: 999999 },
    ],
    events: [
      { id: 41, title: `<svg onload="window.__xss='event'">`, date_iso: dayKey(now), time: hm(new Date(now.getTime() + 20 * 60000)), end_time: null, status: "active" },
      { id: 42, title: "Тот же час А", date_iso: dayKey(now), time: hm(new Date(now.getTime() + 90 * 60000)), end_time: null, status: "active" },
      { id: 43, title: "Тот же час Б", date_iso: dayKey(now), time: hm(new Date(now.getTime() + 90 * 60000)), end_time: null, status: "active" },
      { id: 44, title: "Тот же час В", date_iso: dayKey(now), time: hm(new Date(now.getTime() + 90 * 60000)), end_time: null, status: "active" },
      { id: 45, title: "Через полночь", date_iso: dayKey(now), time: "23:30", end_time: "00:30", status: "active" },
    ],
    upcoming: [],
  }),
  // Данные «не той формы»: сервер другой версии или прокси подменил ответ.
  broken: () => ({ tasks: null, habits: "нет", events: [{ id: 1 }], upcoming: [{ id: 2, title: null, date_iso: null, time: "25:99" }] }),
};

function create() {
  const srv = {
    token: "good-key",
    logins: { user: "pass" },
    sessions: [], // выданные ключи (вход логином и паролем)
    log: [], // { method, path, auth, body, at }
    fault: null,
    dataset: "normal",
    now: () => new Date(Date.now() + srv.shiftMs),
    shiftMs: 0,
    state: null, // текущие данные (задачи отмечаются по-настоящему)
    messages: new Map(), // id сообщения → ответ (повтор с тем же id не записывается дважды)
    notices: [],
    redirectTo: null,
    latency: () => 0,
    counts: () => srv.log.reduce((m, r) => ((m[`${r.method} ${r.path}`] = (m[`${r.method} ${r.path}`] ?? 0) + 1), m), {}),
    reset(dataset = srv.dataset) { srv.dataset = dataset; srv.state = DATASETS[dataset](srv.now()); },
  };
  srv.reset();

  const today = () => {
    const now = srv.now();
    return { day: dayKey(now), dates: [], done_today: [], diary: [], activity: [], far_fresh: [], gone_fresh: [], done_fresh: [], ...srv.state };
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    let raw = "";
    for await (const c of req) raw += c;
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { /* не JSON */ }
    const rec = { method: req.method, path: p, auth: req.headers.authorization ?? "", body, at: Date.now(), handled: false };
    srv.log.push(rec);
    const json = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); };

    const f = srv.fault;
    const hit = f && p.startsWith("/api/") && (!f.only || f.only.test(p)) && (!f.method || f.method === req.method);
    if (hit && f.times !== undefined && f.times-- <= 0) srv.fault = null;
    else if (hit) {
      if (f.mode === "hang") return void setTimeout(() => { if (!res.destroyed) json(200, today()); }, f.ms ?? 120000);
      if (f.mode === "reset") return void req.socket.destroy(); // соединение оборвано, запрос не обработан
      if (f.mode === "401") return json(401, { error: "нужен вход (логин и пароль) или ключ" });
      if (f.mode === "500") return json(500, { error: "внутренняя ошибка" });
      if (f.mode === "502") { res.writeHead(502, { "Content-Type": "text/html" }); return res.end("<html><body><h1>502 Bad Gateway</h1></body></html>"); }
      if (f.mode === "html200") { res.writeHead(200, { "Content-Type": "text/html" }); return res.end("<html><body>Вход в сеть Wi-Fi: примите условия</body></html>"); }
      if (f.mode === "empty200") { res.writeHead(200); return res.end(); }
      if (f.mode === "truncate") { // половина JSON и обрыв
        const s = JSON.stringify(today());
        res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(s) });
        res.write(s.slice(0, Math.floor(s.length / 2)));
        return void setTimeout(() => req.socket.destroy(), 30);
      }
      if (f.mode === "redirect") { res.writeHead(f.code ?? 308, { Location: f.to + req.url }); return res.end(); }
      // «reset-after»: сервер запрос выполнил, а ответ не дошёл (перезапуск при выкладке, обрыв VPN) — идёт дальше, в конце рвёт.
    }

    const d = srv.latency(p, req.method);
    if (d) await new Promise((r) => setTimeout(r, d));
    const finish = (code, obj) => {
      rec.handled = true;
      if (hit && f.mode === "reset-after") return void req.socket.destroy();
      json(code, obj);
    };

    if (req.method === "POST" && p === "/api/login") {
      if (srv.logins[body?.login] !== body?.password) return finish(401, { error: "неверный логин или пароль" });
      const token = `key-${srv.sessions.length + 1}`;
      srv.sessions.push({ token, label: body.label, login: body.login });
      return finish(200, { token });
    }
    if (!p.startsWith("/api/")) { res.writeHead(404); return res.end("нет такого адреса"); }
    const key = rec.auth.replace(/^Bearer\s+/i, "");
    if (key !== srv.token && !srv.sessions.some((s) => s.token === key)) return finish(401, { error: "нужен вход (логин и пароль) или ключ" });

    if (req.method === "GET" && p === "/api/today") return finish(200, today());
    if (req.method === "GET" && p === "/api/notices") {
      const after = Number(url.searchParams.get("after")) || 0;
      return finish(200, srv.notices.filter((n) => n.id > after).sort((a, b) => b.id - a.id));
    }
    if (req.method === "GET" && p === "/api/events") return finish(200, []);
    let m;
    if (req.method === "POST" && (m = p.match(/^\/api\/tasks\/(\d+)$/))) {
      const id = Number(m[1]);
      const t = srv.state.tasks?.find?.((x) => x.id === id);
      if (body?.status === "done" && t) { srv.state.tasks = srv.state.tasks.filter((x) => x !== t); (srv.done ??= []).push(t); }
      if (body?.status === "open") { const i = (srv.done ?? []).findIndex((x) => x.id === id); if (i >= 0) srv.state.tasks.push(...srv.done.splice(i, 1)); }
      return finish(200, { ok: true });
    }
    if (req.method === "POST" && (m = p.match(/^\/api\/habits\/(\d+)\/(mark|unmark)$/))) {
      const hb = srv.state.habits?.find?.((x) => x.id === Number(m[1]));
      if (hb) hb.status = m[2] === "mark" ? body?.status ?? "done" : null;
      return finish(200, { text: "Отметила ✓" });
    }
    if (req.method === "POST" && (p === "/api/input" || p === "/api/voice")) {
      // Как настоящий: повтор с тем же id второй раз не записывается.
      if (body?.id && srv.messages.has(body.id)) return finish(200, srv.messages.get(body.id));
      const r = { text: `Записала: ${String(body?.text ?? "").slice(0, 80)}`, emotion: "happy", changes: [], messageId: srv.messages.size + 1 };
      if (body?.id) srv.messages.set(body.id, r);
      (srv.inputs ??= []).push(body);
      return finish(200, r);
    }
    if (req.method === "POST" && p === "/api/rate") { (srv.rates ??= []).push(body); return finish(200, { text: "Спасибо" }); }
    if (req.method === "POST" && p === "/api/undo") { (srv.undos ??= []).push(body); return finish(200, { text: "Отменила" }); }
    if (req.method === "POST") { (srv.posts ??= []).push({ p, body }); return finish(200, { ok: true, text: "Готово" }); }
    return finish(404, { error: "нет такого адреса" });
  });
  srv.server = server;
  srv.listen = (port = 0, host = "127.0.0.1") => new Promise((ok) => server.listen(port, host, () => { srv.url = `http://${host}:${server.address().port}`; ok(srv); }));
  srv.close = () => new Promise((ok) => { server.closeAllConnections?.(); server.close(() => ok()); });
  return srv;
}

module.exports = { create, DATASETS, dayKey, dayPlus };
