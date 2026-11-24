// Счётчики фич программы на ПК для админки «Использование функций» (этап 3, docs/review/админка-2026-11-24.html).
// Окна шлют имя (preload: maid.track → "usage"), main копит здесь и раз в 10 минут и при выходе отдаёт пачкой на
// POST /api/events/usage (server/src/feature-events.ts, acceptUsage). Только имена и счётчики — ни текстов, ни данных.
// Имена — группа «Виджет» белого списка сервера (server/src/feature-list.ts). Общего кода с сервером нет (программа — JS без
// сборки), поэтому список скопирован, а test/usage.test.cjs сверяет копию с сервером: новое имя — сначала туда, потом сюда.
// Голос, отметки привычек, трекер, рисование и прочее, что идёт через api(), сервер считает сам по ручке — слать не нужно.
// Сбой — молча, без повторов сверх обычного: старый сервер (404), 400 и 401 — счёт выбрасывается; нет связи или входа, 429
// и 5xx — остаётся до следующей пачки (не больше USAGE_CAP на имя — столько срезает и сервер). Не ушло при выходе — в файл,
// уйдёт со следующего запуска.
const fs = require("node:fs");

const WIDGET_FEATURES = [
  "widget.start", "widget.fold", "widget.quick", "widget.tour", "widget.poke", "widget.hints", "widget.clock",
  "widget.inbox", "widget.tails", "widget.main", "widget.section", "widget.settings", "widget.weather", "widget.drag",
  "widget.update",
];
const USAGE_CAP = 500; // server: USAGE_MAX_COUNT
const USAGE_EVERY_MS = 10 * 60_000;
const USAGE_QUIT_MS = 4000; // выход ждёт пачку не дольше

/** send(body) — запрос к серверу; ошибка с полем status — ответ сервера, без него — нет связи (или нет входа). */
function createUsage({ send, file, log = () => {} }) {
  const counts = new Map();
  let busy = null;
  let flying = null; // пачка в пути; выход, не дождавшись ответа, кладёт её в файл (save)
  const add = (name, n = 1) => {
    if (!WIDGET_FEATURES.includes(name) || !(n >= 1)) return false;
    counts.set(name, Math.min(USAGE_CAP, (counts.get(name) ?? 0) + Math.floor(n)));
    return true;
  };
  // Остаток с прошлого выхода: только знакомые имена, файл — сразу удалить.
  try {
    const old = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const [k, v] of Object.entries(old?.counts ?? {})) add(k, Number(v));
  } catch { /* файла нет или испорчен — нечего брать */ }
  try { fs.rmSync(file, { force: true }); } catch {}

  /** Пачка на сервер; одна за раз (вторая, пока первая в пути, ждёт её). */
  function flush() {
    if (busy) return busy;
    if (!counts.size) return Promise.resolve(null);
    const batch = (flying = Object.fromEntries(counts));
    counts.clear();
    busy = (async () => {
      try {
        return await send({ counts: batch });
      } catch (e) {
        const s = Number(e?.status) || 0;
        if (flying !== batch) return null; // уже в файле (выход не дождался ответа)
        if (!s || s === 429 || s >= 500) for (const [k, v] of Object.entries(batch)) add(k, v);
        else log("счётчики: сервер ответил", s, "— пачка выброшена");
        return null;
      } finally {
        busy = null;
        if (flying === batch) flying = null;
      }
    })();
    return busy;
  }
  /** Что не ушло (и пачка без ответа) — в файл до следующего запуска, память пуста. Ответ на ту пачку придёт позже —
   *  она уже в файле и посчитается ещё раз: редкий лишний счёт лучше, чем потерянный. */
  function save() {
    if (flying) for (const [k, v] of Object.entries(flying)) add(k, v);
    flying = null;
    if (!counts.size) return;
    try { fs.writeFileSync(file, JSON.stringify({ counts: Object.fromEntries(counts) })); } catch {}
    counts.clear();
  }
  /** Выход: последняя пачка (ждём не дольше USAGE_QUIT_MS), остаток — в файл. */
  async function atQuit() {
    let t;
    await Promise.race([flush(), new Promise((r) => (t = setTimeout(r, USAGE_QUIT_MS)))]);
    clearTimeout(t);
    save();
  }
  /** Вышли или вошли другим ключом: несданный счёт — выбросить (и пачку в пути: её неудача счёт не вернёт), иначе он
   *  ушёл бы под ключом следующего. */
  function drop() {
    counts.clear();
    flying = null;
    try { fs.rmSync(file, { force: true }); } catch {}
  }
  return { count: (name) => add(String(name)), flush, save, atQuit, drop, pending: () => counts.size > 0, peek: () => Object.fromEntries(counts) };
}

module.exports = { createUsage, WIDGET_FEATURES, USAGE_CAP, USAGE_EVERY_MS, USAGE_QUIT_MS };
