// «Перекрасить Рину» в виджете: renderer/maidlook.js на поддельной странице (сборка набора, кэш, смена цвета посреди сборки,
// свои цвета, сбой, адреса forget), обработчики look:* настоящего main.js на стенде (harness.cjs: только виджету, имена без
// путей, только WebP, хранится один набор) и подключение в widget.js / widget.html / preload.js.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { boot } = require("./stress/harness.cjs");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const eq = (a, b, m) => check(JSON.stringify(a) === JSON.stringify(b), `${m}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
const look = read("renderer/look.js"), maidlook = read("renderer/maidlook.js");
const widget = read("renderer/widget.js"), html = read("renderer/widget.html"), preload = read("src/preload.js");
const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(f, m, ms = 3000) {
  const t0 = Date.now();
  while (!f()) {
    if (Date.now() - t0 > ms) return check(false, `не дождались: ${m}`);
    await new Promise((r) => setTimeout(r, 5));
  }
  check(true, m);
}
const WEBP = (tag) => new Uint8Array([...Buffer.from("RIFF"), 4, 0, 0, 0, ...Buffer.from("WEBP"), ...Buffer.from(tag)]);

/** Поддельная страница: look.js (настоящие lookKey / lookIsDefault, lookRender подменён), maidlook.js, window.maid.look. */
function page({ store = true, fail = null, slow = 0 } = {}) {
  const disk = new Map(); // "ключ/имя" → байты
  const log = { render: [], put: [], keep: [], get: 0, asset: [], revoked: [] };
  let urls = 0;
  const face = { src: "../assets/maid/idle.webp" };
  const ctx = {
    console: { warn: (...a) => log.warn = a.join(" ") },
    setTimeout, Blob, Error, Promise, Object, JSON, Date,
    URL: { createObjectURL: (b) => `blob:${++urls}:${b.tag}`, revokeObjectURL: (u) => log.revoked.push(u) },
    Image: class { set src(v) {} },
    document: { getElementById: (id) => (id === "face" ? face : null) },
    maid: {},
  };
  if (store) ctx.maid.look = {
    asset: async (name, keep) => WEBP(keep ? `k-${name}` : `a-${name}`),
    get: async (set, name) => { log.get++; return disk.get(`${set}/${name}`) ?? null; },
    put: async (set, name, bytes) => { log.put.push(`${set}/${name}`); disk.set(`${set}/${name}`, bytes); return true; },
    keep: async (set) => { log.keep.push(set); for (const k of [...disk.keys()]) if (!k.startsWith(`${set}/`)) disk.delete(k); return true; },
  };
  vm.createContext(ctx);
  const core = look.slice(0, look.indexOf("// --- браузер ---"));
  vm.runInContext(`${core}\nconst MOODS = ["idle", "think", "forget"];\nlet mood = "";\n${maidlook}
    lookRender = async ({ src, keep, hair, eyes, pause }) => {
      __log.render.push(hair + "/" + eyes + ":" + (typeof src === "string" ? src : Buffer.from(src).toString("latin1").slice(12)));
      for (let i = 0; i < 3; i++) { await pause(); if (__slow) await new Promise((r) => setTimeout(r, __slow)); }
      if (__fail && __fail(src)) throw new Error("декодер не смог");
      return { bytes: new Uint8Array([7, 7]) };
    };
    const __origBlob = Blob;
    let blobN = 0; Blob = class extends __origBlob { constructor(parts, o) { super(parts, o); this.tag = String(++blobN); } };
    this.api = { lookSync: (h, e) => lookSync(h, e), maidSrc: (x) => maidSrc(x), maidSrcFresh: (x) => maidSrcFresh(x),
      setMood: (m) => { mood = m; }, state: () => ({ lookWant, lookFailed, urls: { ...lookUrls } }) };`.replace(/__log/g, "this.__log").replace(/__fail/g, "this.__fail").replace(/__slow/g, "this.__slow"),
    Object.assign(ctx, { __log: log, __fail: fail, __slow: slow, Buffer }));
  return { ...ctx.api, log, disk, face, ctx };
}

(async () => {
  // --- набор собирается целиком, потом подменяется разом; кэш на следующий запуск ---
  {
    const p = page();
    eq(p.maidSrc("idle"), "../assets/maid/idle.webp", "до перекраски — свои картинки");
    p.lookSync("gold", "green");
    await tick();
    check(p.maidSrc("idle") === "../assets/maid/idle.webp", "пока набор не готов — прежние цвета");
    await until(() => p.log.keep.length === 1, "набор gold/green собран");
    eq(p.log.render, ["gold/green:a-idle", "gold/green:a-think", "gold/green:a-forget"], "каждая анимация перекрашена один раз, из исходника assets");
    eq(p.log.put, ["look2-gold-green/idle", "look2-gold-green/think", "look2-gold-green/forget"], "все три положены в кэш (ключ — lookKey с LOOK_VERSION)");
    eq(p.log.keep, [p.log.put[0].split("/")[0]], "после сборки кэш оставляет только этот набор");
    check(/^blob:/.test(p.maidSrc("idle")) && /^blob:/.test(p.maidSrc("think")), "готово — адреса перекрашенных");
    check(/^blob:/.test(p.face.src), "картинка на экране (ещё ничего не показано — idle) сразу в новых цветах");
    const before = p.log.render.length;
    p.lookSync("gold", "green");
    await new Promise((r) => setTimeout(r, 30));
    eq(p.log.render.length, before, "те же цвета при следующем опросе — ничего не пересобирается");

    // следующий запуск: тот же диск, ничего не перекрашивается
    const q = page();
    for (const [k, v] of p.disk) q.disk.set(k, v);
    q.lookSync("gold", "green");
    await until(() => q.log.keep.length === 1, "второй запуск собрал набор из кэша");
    eq(q.log.render, [], "из кэша — без перекраски");
  }

  // --- смена цвета посреди сборки: старая бросает работу и ничего не подменяет ---
  {
    const p = page({ slow: 15 });
    p.lookSync("silver", "blue");
    await until(() => p.log.render.length === 1, "сборка silver/blue началась");
    p.lookSync("black", "amber");
    await until(() => p.log.keep.length === 1, "сборка black/amber закончилась");
    await new Promise((r) => setTimeout(r, 80));
    eq(p.log.keep.length, 1, "старая сборка не дошла до конца");
    check(p.log.render.filter((x) => x.startsWith("silver")).length === 1, "silver/blue: перекраска остановилась на первой анимации");
    check(!p.log.put.some((x) => x.includes("silver")), "недоделанная silver/blue в кэш не попала");
    check(/black-amber/.test(p.log.keep[0]), "кэш оставил black/amber");
    check(!p.log.warn, `отмена — не ошибка (${p.log.warn})`);
  }

  // --- свои цвета: исходные файлы, кэш чистится; адреса перекрашенных отпускаются ---
  {
    const p = page();
    p.setMood("think");
    p.lookSync("violet", "blue");
    await until(() => p.log.keep.length === 1, "набор violet/blue собран");
    const shown = p.maidSrc("think");
    eq(p.face.src, shown, "на экране think — подменена на перекрашенную think");
    p.lookSync("red", "violet");
    eq(p.maidSrc("think"), "../assets/maid/think.webp", "свои цвета — снова исходные файлы");
    eq(p.face.src, "../assets/maid/think.webp", "картинка на экране вернулась к своей сразу");
    check(p.log.revoked.includes(shown), "адреса перекрашенных отпущены");
    await tick();
    eq(p.log.keep.at(-1), null, "свои цвета — кэш стирается целиком");
    p.lookSync(undefined, undefined);
    eq(p.log.keep.length, 2, "нет полей (старый сервер) — те же свои цвета, ничего не делается");
    p.lookSync("nope", "violet");
    eq(p.log.render.length, 3, "неизвестный цвет волос (сервер новее) и свои глаза — свои цвета, без перекраски");
    p.lookSync("nope", "green");
    await until(() => p.log.keep.length === 3, "неизвестные волосы и зелёные глаза — собран набор");
    eq(p.log.render.at(-1), "red/green:a-forget", "неизвестный цвет волос — свой, глаза перекрашены");
  }

  // --- forget: каждый показ — новый адрес, предыдущий отпускается ---
  {
    const p = page();
    check(/^\.\.\/assets\/maid\/forget\.webp\?\d+$/.test(p.maidSrcFresh("forget")), "свои цвета — forget с меткой времени, как было");
    p.lookSync("brown", "green");
    await until(() => p.log.keep.length === 1, "набор brown/green собран");
    const a = p.maidSrcFresh("forget"), b = p.maidSrcFresh("forget");
    check(a !== b && /^blob:/.test(a) && /^blob:/.test(b), "перекрашенная forget — новый адрес на каждый показ");
    check(p.log.revoked.includes(a), "прошлый адрес forget отпущен");
    p.setMood("forget");
    const was = p.face.src;
    p.lookSync("gold", "violet");
    await until(() => p.log.keep.length === 2, "набор gold/violet собран");
    eq(p.face.src, was, "forget на экране доигрывает свой раз — не перебивается");
  }

  // --- сбой перекраски: прежние цвета, без повтора каждые 5 с, другой цвет — новая попытка ---
  {
    const p = page({ fail: (src) => Buffer.from(src).toString("latin1").includes("think") });
    p.lookSync("gold", "amber");
    await until(() => p.log.warn, "сбой записан в консоль");
    eq(p.maidSrc("idle"), "../assets/maid/idle.webp", "после сбоя — прежние цвета");
    await tick();
    eq(p.log.keep, [null], "после сбоя недоделанный набор стёрт (на экране были свои — на диске ничего)");
    const tried = p.log.render.length;
    p.lookSync("gold", "amber");
    await new Promise((r) => setTimeout(r, 30));
    eq(p.log.render.length, tried, "тот же цвет при следующем опросе — не повторяет");
    p.lookSync("silver", "amber");
    await until(() => p.log.render.length > tried, "другой цвет — новая попытка");
  }

  // --- сбой после готового набора: на экране прежний набор; свои цвета после этого — срабатывают (ревью) ---
  {
    const p = page({ fail: (src) => Buffer.from(src).toString("latin1").includes("think") });
    p.ctx.__fail = null;
    p.lookSync("brown", "blue");
    await until(() => p.log.keep.length === 1, "набор brown/blue собран");
    const brown = p.maidSrc("idle");
    p.ctx.__fail = (src) => Buffer.from(src).toString("latin1").includes("think");
    p.lookSync("gold", "amber");
    await until(() => p.log.warn, "gold/amber сломалась");
    eq(p.maidSrc("idle"), brown, "после сбоя — прежний набор brown/blue на месте");
    check(/brown-blue/.test(String(p.log.keep.at(-1))), `после сбоя недоделанный набор стёрт, brown/blue оставлен (${p.log.keep.at(-1)})`);
    p.lookSync("red", "violet");
    eq(p.maidSrc("idle"), "../assets/maid/idle.webp", "свои цвета после сбоя — исходные картинки");
    await tick();
    eq(p.log.keep.at(-1), null, "свои цвета после сбоя — кэш стёрт");
  }

  // --- первый опрос со своими цветами стирает набор, оставшийся с прошлого запуска (ревью) ---
  {
    const p = page();
    p.disk.set("look2-gold-green/idle", new Uint8Array([1]));
    p.lookSync("red", "violet");
    await tick();
    eq(p.log.keep, [null], "первый опрос со своими цветами — кэш стирается");
    eq(p.disk.size, 0, "старый набор стёрт");
    eq(p.face.src, "../assets/maid/idle.webp", "картинку свои цвета не трогают");
    p.lookSync("red", "violet");
    await tick();
    eq(p.log.keep.length, 1, "дальше те же свои цвета — ничего не делается");
  }

  // --- адрес forget отпускается при подмене набора, в том числе при возврате к своим (ревью) ---
  {
    const p = page();
    p.lookSync("silver", "green");
    await until(() => p.log.keep.length === 1, "набор silver/green собран");
    const f = p.maidSrcFresh("forget");
    p.lookSync("red", "violet");
    check(p.log.revoked.includes(f), "свои цвета — одноразовый адрес forget отпущен");
  }

  // --- без программы (стенд в браузере): файлы по адресу, кэша нет ---
  {
    const p = page({ store: false });
    p.lookSync("gold", "green");
    await until(() => /^blob:/.test(p.maidSrc("forget")), "на стенде набор тоже собирается");
    eq(p.log.render[0], "gold/green:../assets/maid/idle.webp", "на стенде исходник — по адресу");
  }

  // --- main.js: look:* на стенде ---
  {
    const h = boot({});
    await h.ready();
    try {
      const asset = await h.invoke("look:asset", ["idle", false]);
      check(asset && Buffer.from(asset).toString("latin1", 8, 12) === "WEBP" && asset.length === fs.statSync(path.join(root, "assets/maid/idle.webp")).size, "look:asset отдаёт assets/maid/idle.webp");
      const mask = await h.invoke("look:asset", ["idle", true]);
      check(mask && mask.length === fs.statSync(path.join(root, "assets/maid-keep/idle.webp")).size, "look:asset(keep) отдаёт маску assets/maid-keep/idle.webp");
      for (const bad of ["../maid/idle", "..\\icon", "idle.webp", "", "IDLE", "a/b"]) eq(await h.invoke("look:asset", [bad, false]), null, `look:asset: имя «${bad}» не принимается`);
      eq(await h.invoke("look:asset", ["nosuch", false]), null, "look:asset: нет файла — null");

      const set = "look2-gold-green";
      const bytes = WEBP("data");
      eq(await h.invoke("look:get", [set, "idle"]), null, "look:get: пустой кэш — null");
      eq(await h.invoke("look:put", [set, "idle", bytes]), true, "look:put кладёт WebP");
      const file = path.join(h.dir, "maid-look", set, "idle.webp");
      check(fs.existsSync(file) && !fs.existsSync(file + ".tmp"), "файл в userData/maid-look/<набор>/idle.webp, без .tmp");
      const got = await h.invoke("look:get", [set, "idle"]);
      check(got && Buffer.from(got).equals(Buffer.from(bytes)), "look:get отдаёт то, что положили");
      eq(await h.invoke("look:put", [set, "think", new Uint8Array([1, 2, 3])]), false, "look:put: не WebP — отказ");
      eq(await h.invoke("look:put", [set, "think", "строка"]), false, "look:put: не байты — отказ");
      eq(await h.invoke("look:put", ["../x", "think", bytes]), false, "look:put: набор с путём — отказ");
      eq(await h.invoke("look:put", [set, "../../settings", bytes]), false, "look:put: имя с путём — отказ");
      fs.writeFileSync(path.join(h.dir, "maid-look", set, "broken.webp"), "мусор");
      eq(await h.invoke("look:get", [set, "broken"]), null, "look:get: испорченный файл — null (перекрасит заново)");

      // чужое окно (главное — сайт; окно быстрой записи) — ничего
      const other = { webContents: {} };
      eq(await h.invoke("look:asset", ["idle", false], other), null, "look:asset из другого окна — null");
      eq(await h.invoke("look:get", [set, "idle"], other), null, "look:get из другого окна — null");
      eq(await h.invoke("look:put", [set, "x", bytes], other), false, "look:put из другого окна — отказ");
      eq(await h.invoke("look:keep", [null], other), false, "look:keep из другого окна — отказ");
      check(fs.existsSync(file), "чужое окно ничего не стёрло");

      await h.invoke("look:put", ["look2-black-blue", "idle", bytes]);
      eq(await h.invoke("look:keep", [set]), true, "look:keep(набор)");
      eq(fs.readdirSync(path.join(h.dir, "maid-look")), [set], "look:keep оставил только нынешний набор");
      eq(await h.invoke("look:keep", ["../.."]), false, "look:keep: набор с путём — отказ");
      eq(await h.invoke("look:keep", [null]), true, "look:keep(null) — свои цвета");
      eq(fs.readdirSync(path.join(h.dir, "maid-look")), [], "свои цвета — кэш пуст");
    } finally {
      h.stop();
    }
  }

  // --- подключение ---
  check(/<script src="look\.js"><\/script>\s*<script src="maidlook\.js"><\/script>[\s\S]*<script src="widget\.js">/.test(html), "widget.html: look.js и maidlook.js до widget.js");
  check(!/assets\/maid\//.test(widget.replace(/^\s*\/\/.*$/gm, "").replace(/new Image\(\)\.src = `\.\.\/assets\/maid\/\$\{n\}\.webp`/, "")), "widget.js: картинки горничной только через maidSrc (кроме заготовки своих)");
  check(/\$\("#face"\)\.src = maidSrc\(n\)/.test(widget), "widget.js: showMood берёт maidSrc");
  check(/face\.src = maidSrcFresh\("forget"\)/.test(widget), "widget.js: forget берёт maidSrcFresh");
  check(/data = fresh;\s*syncMarks\(\);[^\n]*\n\s*lookSync\(data\.maid_hair, data\.maid_eyes\)/.test(widget.replace(/\r/g, "")), "widget.js: load зовёт lookSync с каждым ответом /api/today");
  for (const ch of ["look:asset", "look:get", "look:put", "look:keep"]) check(preload.includes(`"${ch}"`), `preload.js: ${ch}`);

  console.log(bad ? `look-widget: ${bad} из ${n} не прошли` : `look-widget: ${n} проверок, всё хорошо`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.log("FAIL", e?.stack ?? e); process.exit(1); });
