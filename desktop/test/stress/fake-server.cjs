// Поддельный сервер горничной для стресс-проверок: отвечает как настоящий на то, что спрашивает виджет, и умеет ломаться —
// молчать, рвать соединение до и после обработки запроса, обрывать ответ на середине, отдавать не JSON, 401/500/502, перенаправлять.
// Режим сбоя: srv.fault = { mode, ms, only } (only — регулярное выражение пути; без него — все /api/…).
const http = require("node:http");

const pad = (n) => String(n).padStart(2, "0");
const dayKey = (t = new Date()) => `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
const dayPlus = (n, from = new Date()) => { const t = new Date(from); t.setDate(t.getDate() + n); return dayKey(t); };
const hm = (t) => `${pad(t.getHours())}:${pad(t.getMinutes())}`;
// Карточки «что куда записалось» — того же вида, что у сервера (server/src/cards.ts): у каждой ref — таблица и id записи.
const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const WD_SHORT = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
const humanDay = (key) => { const [y, m, d] = key.split("-").map(Number); return `${d} ${MONTHS_GEN[m - 1]}, ${WD_SHORT[new Date(y, m - 1, d).getDay()]}`; };
const MONEY_OF = { такси: "транспорт", метро: "транспорт", кофе: "кафе", обед: "еда", хлеб: "продукты" };
const MONEY_CATS = ["еда", "продукты", "кафе", "транспорт", "дом", "связь", "подписки", "здоровье", "одежда", "развлечения", "игры", "подарки", "другое"];
function cardOf(x) {
  if (x.card) return x.card; // карточка, заданная целиком (srv.nextReply)
  if (x.tbl === "events") return { kind: "event", title: x.title, detail: `${humanDay(x.date)}${x.time ? " " + x.time : ""}`, ref: { tbl: "events", id: x.id } };
  const what = [x.category, x.note].filter(Boolean).join(", ");
  return { kind: "money", title: x.note || x.category || "Расход", detail: `−${x.amount.toLocaleString("ru-RU")} ${x.currency}${what ? " — " + what : ""}`, ref: { tbl: "money", id: x.id } };
}
const changeLine = (was, now) => `✎ ${was.title}${(was.detail ?? "") === (now.detail ?? "") ? " — поправила" : `: ${was.detail || "—"} → ${now.detail || "—"}`}`;
const KIND_CHANGE = "Поменять вид записи (план, задача, заметка, дневник…) я пока не умею. Нажмите «↩ Отменить» и скажите заново, как нужно.";
const NOT_UNDERSTOOD = "Не поняла, что поправить в этом ответе. Скажите иначе — например, «не в 15, а в 17».";

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

// Уровень по опыту — копия levelOf из server/src/profile.ts.
function xpLevel(xp) {
  let level = 1;
  let left = xp;
  while (left >= 100 + 25 * (level - 1)) { left -= 100 + 25 * (level - 1); level++; }
  return { xp, level, into: left, need: 100 + 25 * (level - 1) };
}

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
    // Поправка к ответу: записи за карточками («таблица:id» → запись), ответы с ними (messageId → { keys, asked, undone }),
    // итоги поправок по id (повтор не пишет второй раз). nextReply — следующий ответ /api/input целиком (один раз).
    records: new Map(),
    answers: new Map(),
    corrections: new Map(),
    nextReply: null,
    notices: [],
    redirectTo: null,
    latency: () => 0,
    xp: 740, // опыт для полосы в шапке (как server/src/profile.ts): 5-й уровень, 190 из 200 — две задачи до 6-го
    counts: () => srv.log.reduce((m, r) => ((m[`${r.method} ${r.path}`] = (m[`${r.method} ${r.path}`] ?? 0) + 1), m), {}),
    reset(dataset = srv.dataset) { srv.dataset = dataset; srv.state = DATASETS[dataset](srv.now()); },
  };
  srv.reset();

  const today = () => {
    const now = srv.now();
    return { day: dayKey(now), dates: [], done_today: [], diary: [], activity: [], far_fresh: [], gone_fresh: [], done_fresh: [], xp: xpLevel(srv.xp), ...srv.state };
  };

  // --- поправка к ответу (как server/src/pipeline.ts, correct): простые правила вместо модели ---
  const record = (x) => {
    const r = { ...x, id: x.id ?? 500 + srv.records.size + 1 };
    srv.records.set(`${r.tbl}:${r.id}`, r);
    return r;
  };
  const answer = (messageId, recs) => srv.answers.set(messageId, { keys: recs.map((x) => `${x.tbl}:${x.id}`), asked: null, undone: false });
  // /api/input: «завтра в 15 стоматолог» — план, «такси 450» (или «450 на такси») — трата; и то и другое — две карточки.
  // srv.nextReply — ответ целиком (его карточки с ref тоже можно поправлять, но только правилами без полей: «это задача», вопрос).
  function inputReply(text, messageId) {
    if (srv.nextReply) {
      const r = { emotion: "neutral", undoable: true, changes: [], ...srv.nextReply, messageId };
      srv.nextReply = null;
      const recs = (r.changes ?? []).filter((c) => c?.ref).map((c) => record({ tbl: c.ref.tbl, id: c.ref.id, card: c }));
      if (recs.length) answer(messageId, recs);
      return r;
    }
    const recs = [], lines = [];
    const ev = text.match(/(сегодня|завтра)\s+в\s+(\d{1,2})(?::(\d{2}))?(?!\d)\s*([^,.;]*)/i);
    if (ev && Number(ev[2]) <= 23) {
      const title = ev[4].replace(/\s*(такси|метро|кофе|обед|хлеб)\s+\d+.*$/i, "").trim().replace(/^./, (c) => c.toUpperCase()) || "План";
      const e = record({ tbl: "events", title, date: dayPlus(/завтра/i.test(ev[1]) ? 1 : 0, srv.now()), time: `${pad(Number(ev[2]))}:${ev[3] ?? "00"}` });
      recs.push(e);
      lines.push(`📅 ${title} — ${cardOf(e).detail}`);
    }
    const mo = text.match(/(такси|метро|кофе|обед|хлеб)\s+(\d+)|(\d+)\s+на\s+(такси|метро|кофе|обед|хлеб)/i);
    if (mo) {
      const note = (mo[1] ?? mo[4]).toLowerCase();
      const m = record({ tbl: "money", amount: Number(mo[2] ?? mo[3]), currency: "RUB", category: MONEY_OF[note], note });
      recs.push(m);
      lines.push(`💰 ${cardOf(m).detail}`);
    }
    if (!recs.length) return null;
    answer(messageId, recs);
    return { text: `Записала:\n${lines.join("\n")}`, emotion: "happy", changes: recs.map(cardOf), messageId, undoable: true };
  }
  // /api/correct: «не в 15, а в 17» / «в 17» — время плана, «в 7» — вопрос «утра или вечера?» (следующая поправка — ответ),
  // «сумма 540» / «не 450, а 540» — сумма, «это еда» — категория, «это задача» — не умеет (честный текст), «в 19» — ещё и наложение
  // на «Ужин с друзьями» (кнопки «Сдвинуть» / «Оставить»). Ответ отменён (/api/undo) — записей нет, поправлять нечего.
  function correctReply(a, messageId, text) {
    const recs = () => a.keys.map((k) => srv.records.get(k)).filter(Boolean);
    const view = (reply, changed = [], extra = {}) => ({
      text: reply, emotion: changed.length ? "happy" : "neutral", messageId, undoable: !a.undone, changes: recs().map(cardOf), changed, ...extra,
    });
    if (a.undone) return view("Этот ответ уже отменён — поправлять нечего.");
    const t = text.toLowerCase();
    const ev = recs().find((x) => x.tbl === "events" && !x.card);
    const mo = recs().find((x) => x.tbl === "money" && !x.card);
    const edit = (x, patch, head) => {
      const was = cardOf(x);
      Object.assign(x, patch);
      const now = cardOf(x);
      if (was.title === now.title && was.detail === now.detail) return view("Так и записано — ничего не меняла.");
      const clash = x.tbl === "events" && x.time === "19:00"
        ? { eventId: x.id, title: x.title, withId: 9001, withTitle: "Ужин с друзьями", span: "19:00–20:30", shiftTo: "20:30" } : null;
      const warn = clash ? `\n⚠ В ${clash.span} у тебя уже «${clash.withTitle}». Сдвинуть «${clash.title}» на ${clash.shiftTo}?` : "";
      return view(`${head}\n${changeLine(was, now)}${warn}`, [`${x.tbl}:${x.id}`], clash ? { clash } : {});
    };
    if (/это\s+(задача|заметка|дневник|привычка)|сделай\s+задач/.test(t)) return view(KIND_CHANGE);
    let m;
    if (a.asked && ev && /утр|веч|дня|днём|ноч/.test(t)) {
      const { hour, min } = a.asked;
      a.asked = null;
      const h = /веч|дня|днём/.test(t) && hour < 12 ? hour + 12 : hour;
      return edit(ev, { time: `${pad(h)}:${min}` }, `Перенесла на ${pad(h)}:${min}.`);
    }
    if (mo && (m = t.match(/(?:сумма|не\s+\d+,?\s*а)\s+(\d+)/))) return edit(mo, { amount: Number(m[1]) }, "Поправила сумму.");
    if (mo && (m = t.match(/это\s+([а-яё]+)/)) && MONEY_CATS.includes(m[1])) return edit(mo, { category: m[1] }, "Поправила категорию.");
    const times = [...t.matchAll(/(?:^|\s)в\s+(\d{1,2})(?::(\d{2}))?(?!\d)/g)];
    if (ev && times.length) {
      const last = times.at(-1);
      const hour = Number(last[1]), min = last[2] ?? "00";
      const tail = t.slice(last.index + last[0].length);
      if (hour > 23) return view(`Уточните, пожалуйста: ${hour} — такого часа нет. Во сколько?`, [], { clarify: true });
      if (hour >= 1 && hour <= 11 && !/утр|веч|дня|днём|ноч/.test(tail)) {
        a.asked = { hour, min };
        return view(`Уточните, пожалуйста: в ${hour} утра или вечера?`, [], { clarify: true });
      }
      const h = /веч|дня|днём/.test(tail) && hour < 12 ? hour + 12 : hour;
      return edit(ev, { time: `${pad(h)}:${min}` }, `Перенесла на ${pad(h)}:${min}.`);
    }
    return view(NOT_UNDERSTOOD, [], { clarify: true });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    let raw = "";
    for await (const c of req) raw += c;
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { /* не JSON */ }
    const rec = { method: req.method, path: p, auth: req.headers.authorization ?? "", client: req.headers["x-maid-client"] ?? "",
      version: req.headers["x-maid-version"] ?? "", body, at: Date.now(), handled: false };
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
    // Погода (weather.js): что задано через /__ctl {"weather": {...}}; без города — null.
    if (req.method === "GET" && p === "/api/weather") return finish(200, { weather: srv.weather ?? null });
    let m;
    if (req.method === "POST" && (m = p.match(/^\/api\/tasks\/(\d+)$/))) {
      const id = Number(m[1]);
      const t = srv.state.tasks?.find?.((x) => x.id === id);
      if (body?.status === "done" && t) { srv.state.tasks = srv.state.tasks.filter((x) => x !== t); (srv.done ??= []).push(t); srv.xp += 10; }
      if (body?.status === "open") { const i = (srv.done ?? []).findIndex((x) => x.id === id); if (i >= 0) { srv.state.tasks.push(...srv.done.splice(i, 1)); srv.xp -= 10; } }
      return finish(200, { ok: true });
    }
    if (req.method === "POST" && (m = p.match(/^\/api\/habits\/(\d+)\/(mark|unmark)$/))) {
      const hb = srv.state.habits?.find?.((x) => x.id === Number(m[1]));
      if (hb) {
        const was = hb.status === "done";
        hb.status = m[2] === "mark" ? body?.status ?? "done" : null;
        srv.xp += (hb.status === "done" ? 5 : 0) - (was ? 5 : 0);
        // Серия как на сервере (habits.ts streak): сегодняшняя отметка «сделано» продлевает её на день, снятие — убирает этот день.
        hb.streak = Math.max(0, (hb.streak ?? 0) + (hb.status === "done" ? 1 : 0) - (was ? 1 : 0));
      }
      return finish(200, { text: "Отметила ✓" });
    }
    if (req.method === "POST" && (p === "/api/input" || p === "/api/voice")) {
      // Как настоящий: повтор с тем же id второй раз не записывается.
      if (body?.id && srv.messages.has(body.id)) return finish(200, srv.messages.get(body.id));
      const r = inputReply(String(body?.text ?? ""), 1001 + (srv.inputs?.length ?? 0))
        ?? { text: `Записала: ${String(body?.text ?? "").slice(0, 80)}`, emotion: "happy", changes: [], messageId: srv.messages.size + 1 };
      if (body?.id) srv.messages.set(body.id, r);
      (srv.inputs ??= []).push(body);
      return finish(200, r);
    }
    if (req.method === "POST" && p === "/api/correct") {
      (srv.corrects ??= []).push(body);
      const text = typeof body?.text === "string" ? body.text.trim() : "";
      const badId = body?.id !== undefined && (typeof body.id !== "string" || !body.id || body.id.length > 80);
      if (!Number.isInteger(body?.messageId) || !text || text.length > 500 || badId) return finish(400, { error: "неверный запрос" });
      const a = srv.answers.get(body.messageId);
      if (!a) return finish(404, { error: "нет такого ответа" });
      if (body.id && srv.corrections.has(body.id)) return finish(200, { ...srv.corrections.get(body.id), duplicate: true });
      const r = correctReply(a, body.messageId, text);
      if (body.id) srv.corrections.set(body.id, r);
      return finish(200, r);
    }
    // Пачка счётчиков фич (desktop/src/usage.js); srv.usageStatus — ответить ошибкой (404 старого сервера, 429, 500).
    if (req.method === "POST" && p === "/api/events/usage") {
      (srv.usage ??= []).push({ counts: body?.counts, client: rec.client });
      if (srv.usageStatus) return finish(srv.usageStatus, { error: "нет такого адреса" });
      return finish(200, { ok: true, accepted: Object.keys(body?.counts ?? {}).length, dropped: 0 });
    }
    if (req.method === "POST" && p === "/api/rate") { (srv.rates ??= []).push(body); return finish(200, { text: "Спасибо" }); }
    if (req.method === "POST" && p === "/api/undo") {
      (srv.undos ??= []).push(body);
      // Отмена ответа с карточками убирает его записи: поправка после неё — «уже отменён».
      const a = srv.answers.get(body?.messageId);
      if (a && !a.undone) { a.undone = true; for (const k of a.keys) srv.records.delete(k); }
      return finish(200, { text: "Отменила" });
    }
    if (req.method === "POST") { (srv.posts ??= []).push({ p, body }); return finish(200, { ok: true, text: "Готово" }); }
    return finish(404, { error: "нет такого адреса" });
  });
  srv.server = server;
  srv.listen = (port = 0, host = "127.0.0.1") => new Promise((ok) => server.listen(port, host, () => { srv.url = `http://${host}:${server.address().port}`; ok(srv); }));
  srv.close = () => new Promise((ok) => { server.closeAllConnections?.(); server.close(() => ok()); });
  return srv;
}

module.exports = { create, DATASETS, dayKey, dayPlus };
