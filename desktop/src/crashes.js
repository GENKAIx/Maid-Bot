// Падения программы для админки «Падения» (этап 5 «Тарифы и управление», server/src/crashes.ts). main.js ловит ошибки главного процесса
// (uncaughtException, unhandledRejection), падения окон и служебных процессов (render-process-gone, child-process-gone), окна шлют
// свои ошибки (renderer/common.js: error, unhandledrejection → preload: maid.crash → "crash"). Здесь из ошибки остаётся только:
// тип (имя класса), место в коде (файл:строка:столбец первого кадра внутри программы — путь от папки программы, без диска и папки
// пользователя), процесс, версия и отпечаток сообщения (12 знаков sha256 нормализованного текста). Само сообщение и стек на сервер
// не уходят: в них могут быть данные человека.
// Одинаковые склеиваются в памяти (счёт), раз в CRASH_EVERY_MS и при выходе — пачкой на POST /api/events/crash, не больше
// CRASH_BATCH записей; что не влезло — со следующей. Нет связи, 429 и 5xx — запись остаётся, но не больше CRASH_TRIES попыток;
// 400, 401, 404 (старый сервер) — выбрасывается. Записей в памяти — не больше CRASH_KEYS (новые сверх — не берутся).
// Не ушло при выходе — в файл, со следующего запуска (с версией той сборки, где упало).
const crypto = require("node:crypto");
const fs = require("node:fs");

const CRASH_EVERY_MS = 10 * 60_000;
const CRASH_BATCH = 20; // сервер берёт до 50 (server: CRASH_MAX_ITEMS)
const CRASH_KEYS = 100;
const CRASH_COUNT_CAP = 1000; // server: CRASH_MAX_COUNT
const CRASH_TRIES = 3;
const CRASH_QUIT_MS = 3000;
const PROCESSES = ["main", "widget", "quick", "window", "gpu", "utility", "child"];
const KIND = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,4}$/;
const APP_FILE = /^(?:src|renderer)(?:\/[A-Za-z0-9_.-]{1,60}){1,4}$/;

/** Путь из кадра стека → путь внутри программы (src/main.js, renderer/widget.js) или null (Node, Electron, node_modules, чужое).
 *  appDir — папка программы (app.getAppPath(): …\resources\app.asar или папка desktop при запуске из исходников). */
function appRelative(file, appDir) {
  let f = String(file ?? "");
  try { f = decodeURIComponent(f); } catch { /* битая %-последовательность — как есть */ }
  f = f.replace(/^file:\/\/\/?/i, "").replace(/\\/g, "/");
  const root = String(appDir ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  let rel = null;
  if (root && f.toLowerCase().startsWith(root.toLowerCase() + "/")) rel = f.slice(root.length + 1);
  else {
    const i = f.toLowerCase().lastIndexOf("app.asar/");
    if (i >= 0) rel = f.slice(i + "app.asar/".length);
  }
  if (rel == null || rel.includes("node_modules") || rel.includes("..")) return null;
  return APP_FILE.test(rel) ? rel : null;
}

/** Место ошибки: первый кадр стека внутри программы → «renderer/widget.js:12:5»; нет такого — «-». В ответе нет ни диска, ни папок
 *  пользователя: только путь от папки программы. */
function placeOf(stack, appDir) {
  for (const line of String(stack ?? "").split("\n").slice(0, 40)) {
    // «at fn (C:\…\file.js:12:5)», «at C:\…\file.js:12:5», «at file:///C:/…/file.js:12:5»
    const m = /^\s*at\s+(?:.*?\()?(.+?):(\d{1,6}):(\d{1,6})\)?\s*$/.exec(line);
    if (!m) continue;
    const rel = appRelative(m[1], appDir);
    if (rel) return `${rel}:${m[2]}:${m[3]}`;
  }
  return "-";
}

/** Отпечаток сообщения: числа, строки в кавычках, адреса и пути убраны, нижний регистр → 12 знаков sha256. Само сообщение не хранится
 *  и не уходит; отпечаток только различает разные ошибки в одном месте. */
function fingerprint(message) {
  const norm = String(message ?? "").slice(0, 500).toLowerCase()
    .replace(/(?:file|https?):\/\/\S+/g, "<url>")
    .replace(/[a-z]:[\\/][^\s'"`)]*/g, "<path>")
    .replace(/(?:^|\s)\/[^\s'"`)]+/g, " <path>")
    .replace(/'[^']*'|"[^"]*"|`[^`]*`|«[^»]*»/g, "<s>")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ").trim();
  return norm ? crypto.createHash("sha256").update(norm).digest("hex").slice(0, 12) : "";
}

/** Тип ошибки: имя класса (TypeError), не ошибка (бросили строку) — NonError. */
function kindOf(err) {
  const n = err && typeof err === "object" ? String(err.name ?? err.constructor?.name ?? "") : "";
  if (KIND.test(n)) return n;
  return err instanceof Error || (err && typeof err === "object" && "stack" in err) ? "Error" : "NonError";
}

/** Запись из ошибки JS: { name, message, stack } (из main) или то же от окна. */
function fromError(err, proc, version, appDir) {
  const e = err && typeof err === "object" ? err : { message: String(err) };
  return { version, process: proc, kind: kindOf(err), place: placeOf(e.stack, appDir), fp: fingerprint(e.message) };
}

/** send(body) — запрос к серверу; ошибка с полем status — ответ сервера, без него — нет связи (или нет входа). */
function createCrashes({ send, file, appDir, version, log = () => {}, now = () => Date.now() }) {
  const items = new Map(); // ключ → { version, process, kind, place, fp, count, tries }
  let busy = null;
  let flying = null;
  const keyOf = (x) => [x.version, x.process, x.kind, x.place, x.fp].join("|");
  function put(x, n = 1, tries = 0) {
    if (!x || !VERSION.test(x.version) || !PROCESSES.includes(x.process) || !KIND.test(x.kind)) return false;
    const k = keyOf(x);
    const was = items.get(k);
    if (!was && items.size >= CRASH_KEYS) return false;
    const count = Math.min(CRASH_COUNT_CAP, (was?.count ?? 0) + Math.max(1, Math.floor(n) || 1));
    items.set(k, { version: x.version, process: x.process, kind: x.kind, place: String(x.place || "-"), fp: String(x.fp ?? ""), count, tries: Math.max(was?.tries ?? 0, tries) });
    return true;
  }
  // Остаток с прошлого выхода (версия — та, на которой упало): только чистые записи, файл — сразу удалить.
  try {
    const old = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const x of Array.isArray(old?.items) ? old.items.slice(0, CRASH_KEYS) : []) put(x, Number(x.count), Number(x.tries) || 0);
  } catch { /* файла нет или испорчен */ }
  try { fs.rmSync(file, { force: true }); } catch {}

  /** Ошибка JS процесса proc (main, widget, quick, window). */
  const error = (err, proc = "main") => put(fromError(err, proc, version, appDir));
  /** Процесс упал целиком (render-process-gone, child-process-gone): тип — причина Electron (crashed, oom, killed…), места нет. */
  const gone = (proc, reason) => (reason && reason !== "clean-exit" ? put({ version, process: proc, kind: String(reason), place: "-", fp: "" }) : false);

  let lastSent = -Infinity;
  /** Пачка на сервер: не чаще CRASH_EVERY_MS (force — при выходе), одна за раз, не больше CRASH_BATCH записей. */
  function flush(force = false) {
    if (busy) return busy;
    if (!items.size || (!force && now() - lastSent < CRASH_EVERY_MS - 1000)) return Promise.resolve(null);
    lastSent = now();
    const batch = [...items.values()].slice(0, CRASH_BATCH);
    for (const x of batch) items.delete(keyOf(x));
    flying = batch;
    busy = (async () => {
      try {
        return await send({ items: batch.map(({ tries, ...x }) => x) });
      } catch (e) {
        const s = Number(e?.status) || 0;
        if (flying !== batch) return null; // уже в файле (выход не дождался)
        if (!s || s === 429 || s >= 500) {
          let lost = 0;
          for (const x of batch) if (x.tries + 1 >= CRASH_TRIES || !put(x, x.count, x.tries + 1)) lost++;
          if (lost) log("падения: не ушло после", CRASH_TRIES, "попыток — выброшено записей:", lost);
        } else log("падения: сервер ответил", s, "— пачка выброшена");
        return null;
      } finally {
        busy = null;
        if (flying === batch) flying = null;
      }
    })();
    return busy;
  }
  /** Что не ушло (и пачка без ответа) — в файл до следующего запуска. Файл, уже записанный в этом запуске (atQuit, потом will-quit
   *  с новой ошибкой между ними), дочитывается и сливается с новым, а не перезаписывается. */
  function save() {
    if (flying) for (const x of flying) put(x, x.count, x.tries);
    flying = null;
    if (!items.size) return;
    try {
      const was = JSON.parse(fs.readFileSync(file, "utf8"));
      for (const x of Array.isArray(was?.items) ? was.items : []) put(x, Number(x.count), Number(x.tries) || 0);
    } catch { /* файла нет или испорчен */ }
    try { fs.writeFileSync(file, JSON.stringify({ items: [...items.values()] })); } catch {}
    items.clear();
  }
  async function atQuit() {
    let t;
    await Promise.race([flush(true), new Promise((r) => (t = setTimeout(r, CRASH_QUIT_MS)))]);
    clearTimeout(t);
    save();
  }
  /** Вышли или вошли другим ключом: несданное — выбросить, оно ушло бы под чужим ключом. */
  function drop() {
    items.clear();
    flying = null;
    try { fs.rmSync(file, { force: true }); } catch {}
  }
  return { error, gone, flush, save, atQuit, drop, pending: () => items.size > 0, peek: () => [...items.values()] };
}

module.exports = { createCrashes, placeOf, fingerprint, kindOf, appRelative, CRASH_EVERY_MS, CRASH_BATCH, CRASH_KEYS, CRASH_TRIES, CRASH_COUNT_CAP };
