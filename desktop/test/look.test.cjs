// Перекраска Рины (renderer/look.js) — без Electron и браузера: цвета отдельных пикселей, сверка lookPixels с эталоном
// tools/maid-look/look_math.py на настоящих кадрах, разбор и сборка анимированного WebP на настоящих idle.webp и forget.webp,
// свежесть масок assets/maid-keep: кадры и длительности, sources.json (sha256 анимаций и масок, LOOK_VERSION), под маской
// нет глаз, make_masks.py --check — маски не мигают. Python с Pillow (numpy, scipy) нужен для сверки, --check и для
// проверки, что собранный файл читается чужим декодером; нет его — эти части пропускаются с пометкой.
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { spawnSync } = require("child_process");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const desk = path.join(__dirname, "..");
const repo = path.join(desk, "..");
const dir = path.join(desk, "renderer");
const maid = path.join(desk, "assets", "maid");
const keepDir = path.join(desk, "assets", "maid-keep");
const src = fs.readFileSync(path.join(dir, "look.js"), "utf8");
const MARK = "// --- браузер ---";
const pure = src.slice(0, src.indexOf(MARK));

// Чистая часть — до метки «браузер» (дальше ImageDecoder и OffscreenCanvas); запускается в пустом контексте.
const load = (code) => {
  const ctx = vm.createContext({});
  vm.runInContext(code + "\nthis.LOOK_HAIR = LOOK_HAIR; this.LOOK_EYES = LOOK_EYES; this.LOOK_VERSION = LOOK_VERSION;", ctx);
  return ctx;
};

// --- сам файл: обычный скрипт окна ---
check(src.split(MARK).length === 2, "метка «// --- браузер ---» должна быть в look.js ровно один раз");
check(!/^\s*(import|export)\b/m.test(src) && !/\brequire\s*\(/.test(src), "look.js — обычный скрипт: без import/export/require");
const names = [...src.matchAll(/^(?:async\s+)?(?:function\s*\*?\s*([A-Za-z_$][\w$]*)|(?:const|let|var|class)\s+([A-Za-z_$][\w$]*))/gm)].map((m) => m[1] || m[2]);
check(names.length > 10, "не нашлись имена верхнего уровня look.js");
for (const nm of names) check(/^(look[A-Z]|LOOK_)/.test(nm), `${nm}: имя верхнего уровня без приставки look/LOOK_ — окна делят одну область имён`);
const pureCode = pure.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
for (const api of ["window", "document", "ImageDecoder", "VideoFrame", "OffscreenCanvas", "fetch", "XMLHttpRequest", "performance", "Blob"]) {
  check(!new RegExp(`\\b${api}\\b`).test(pureCode), `${api} выше метки «браузер» — чистая часть должна работать без браузера`);
}
// Будущее подключение в виджет: со скриптами widget.html (как renderer-globals.test.cjs) — без повтора имён.
{
  const html = fs.readFileSync(path.join(dir, "widget.html"), "utf8");
  const files = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]).filter((f) => !/^https?:/.test(f) && f !== "look.js");
  const code = [...files, "look.js"].map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n;\n");
  let err = "";
  try { new vm.Script(code, { filename: "widget.html+look.js" }); } catch (e) { err = e.message; }
  check(!err, `look.js вместе со скриптами widget.html не собирается: ${err}`);
}

let L;
try {
  L = load(pure);
} catch (e) {
  console.log("FAIL чистая часть look.js не выполняется:", e.message);
  process.exit(1);
}

// --- таблицы ---
const hairIds = ["red", "brown", "gold", "silver", "violet", "black"];
const hairNames = ["тёмно-красные", "каштановые", "золотистые", "серебристые", "фиолетовые", "чёрные"];
const eyeIds = ["violet", "green", "blue", "amber"];
const eyeNames = ["фиолетовые", "зелёные", "синие", "янтарные"];
check(JSON.stringify(L.LOOK_HAIR.map((o) => o.id)) === JSON.stringify(hairIds), "LOOK_HAIR: id не те или не в том порядке");
check(JSON.stringify(L.LOOK_HAIR.map((o) => o.name)) === JSON.stringify(hairNames), "LOOK_HAIR: названия не те");
check(JSON.stringify(L.LOOK_EYES.map((o) => o.id)) === JSON.stringify(eyeIds), "LOOK_EYES: id не те или не в том порядке");
check(JSON.stringify(L.LOOK_EYES.map((o) => o.name)) === JSON.stringify(eyeNames), "LOOK_EYES: названия не те");
const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const toHex = (a) => "#" + a.map((x) => x.toString(16).padStart(2, "0")).join("");
const one = (rgb, hair = "red", eyes = "violet", a = 255, keepA = null) => {
  const p = new Uint8ClampedArray([...rgb, a]);
  const changed = L.lookPixels(p, keepA == null ? null : new Uint8ClampedArray([255, 255, 255, keepA]), hair, eyes);
  return { px: [...p], changed };
};
for (const [table, def] of [[L.LOOK_HAIR, "red"], [L.LOOK_EYES, "violet"]]) {
  for (const o of table) {
    check(/^#[0-9a-f]{6}$/.test(o.swatch), `${o.id}: образец цвета не в виде #rrggbb`);
    check(!o.remap === (o.id === def), `${o.id}: без перекраски должен быть только свой цвет (${def})`);
  }
  // Образец кнопки — ровно то, во что перекрашивается свой средний цвет (образец своего цвета).
  const base = hex(table.find((o) => o.id === def).swatch);
  for (const o of table) {
    const got = table === L.LOOK_HAIR ? one(base, o.id).px : one(base, "red", o.id).px;
    check(toHex(got.slice(0, 3)) === o.swatch, `${o.id}: образец ${o.swatch}, а свой цвет перекрашивается в ${toHex(got.slice(0, 3))}`);
  }
}

// --- пиксели ---
const hueOf = ([r, g, b]) => {
  const mx = Math.max(r, g, b), d = mx - Math.min(r, g, b);
  if (!d) return 0;
  const h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return h * 60;
};
const hueGap = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
const CRIMSON = [169, 50, 65]; // самый частый цвет волос (idle, кадр 0)
const IRIS = [99, 42, 127]; // радужка
const SAME = {
  румянец: [255, 181, 176], кожа: [252, 238, 227], белое: [255, 255, 255], контур: [19, 21, 25],
  "золотая искра": [250, 214, 69], "зелёная галочка": [129, 205, 75],
};
for (const o of L.LOOK_HAIR) {
  const r = one(CRIMSON, o.id);
  if (!o.remap) {
    check(r.changed === 0 && toHex(r.px.slice(0, 3)) === toHex(CRIMSON), "свои волосы перекрасились");
    continue;
  }
  check(r.changed === 1, `волосы → ${o.id}: пиксель не перекрасился`);
  check(r.px[3] === 255, `волосы → ${o.id}: поменялась прозрачность`);
  if (o.id !== "silver") check(hueGap(hueOf(r.px), o.remap.h) <= 6, `волосы → ${o.id}: тон ${hueOf(r.px).toFixed(0)}°, ждали около ${o.remap.h}°`);
  check(toHex(one(IRIS, o.id).px.slice(0, 3)) === toHex(IRIS), `волосы → ${o.id}: задело глаза`);
  const semi = one(CRIMSON, o.id, "violet", 128);
  check(semi.changed === 1 && semi.px[3] === 128, `волосы → ${o.id}: полупрозрачный край не перекрасился или потерял прозрачность`);
  check(one(CRIMSON, o.id, "violet", 255, 255).changed === 0, `волосы → ${o.id}: пиксель под маской «оставить» перекрасился`);
  check(one(CRIMSON, o.id, "violet", 255, 0).changed === 1, `волосы → ${o.id}: свободный по маске пиксель не перекрасился`);
}
for (const o of L.LOOK_EYES) {
  const r = one(IRIS, "red", o.id);
  if (!o.remap) {
    check(r.changed === 0, "свои глаза перекрасились");
    continue;
  }
  check(r.changed === 1 && hueGap(hueOf(r.px), o.remap.h) <= 6, `глаза → ${o.id}: тон ${hueOf(r.px).toFixed(0)}°, ждали около ${o.remap.h}°`);
  check(toHex(one(CRIMSON, "red", o.id).px.slice(0, 3)) === toHex(CRIMSON), `глаза → ${o.id}: задело волосы`);
  check(one(IRIS, "red", o.id, 255, 255).changed === 0, `глаза → ${o.id}: пиксель под маской «оставить» перекрасился`);
}
for (const hair of hairIds) {
  for (const eyes of eyeIds) {
    for (const [what, rgb] of Object.entries(SAME)) {
      const r = one(rgb, hair, eyes);
      check(r.changed === 0 && toHex(r.px.slice(0, 3)) === toHex(rgb), `${hair}/${eyes}: ${what} ${toHex(rgb)} → ${toHex(r.px.slice(0, 3))}`);
    }
    check(one(CRIMSON, hair, eyes, 0).changed === 0, `${hair}/${eyes}: перекрасился прозрачный пиксель`);
  }
}
{
  const p = new Uint8ClampedArray(4 * 64);
  const all = [CRIMSON, IRIS, ...Object.values(SAME)];
  for (let i = 0; i < 64; i++) p.set([...all[i % all.length], i % 3 ? 255 : 90], 4 * i);
  const before = Buffer.from(p);
  check(L.lookPixels(p, null) === 0 && L.lookPixels(p, null, "red", "violet") === 0 && before.equals(Buffer.from(p)), "свои цвета: байты кадра поменялись");
  let thrown = "";
  try { L.lookPixels(p, null, "green", "violet"); } catch (e) { thrown = e.message; }
  check(/нет цвета/.test(thrown), "неизвестный цвет волос не дал ошибки");
  thrown = "";
  try { L.lookPixels(p, new Uint8ClampedArray(8), "gold", "violet"); } catch (e) { thrown = e.message; }
  check(/маска/.test(thrown), "маска другого размера не дала ошибки");
}

// --- ключ кэша ---
check(L.lookKey("gold", "green") === `look${L.LOOK_VERSION}-gold-green`, `lookKey: ${L.lookKey("gold", "green")}`);
check(L.lookKey("gold", "green") !== L.lookKey("gold", "blue") && L.lookKey("gold", "green") !== L.lookKey("brown", "green"), "lookKey не различает цвета");
check(L.lookIsDefault("red", "violet") && !L.lookIsDefault("red", "amber") && !L.lookIsDefault("black", "violet"), "lookIsDefault ошибается");
{
  const bumped = pure.replace(/const LOOK_VERSION = \d+;/, `const LOOK_VERSION = ${L.LOOK_VERSION + 1};`);
  check(bumped !== pure, "не нашлась строка const LOOK_VERSION = …;");
  const L2 = load(bumped);
  check(L2.lookKey("gold", "green") !== L.lookKey("gold", "green") && L2.lookKey("gold", "green").includes(String(L.LOOK_VERSION + 1)), "lookKey не меняется с версией");
  let thrown = "";
  try { L.lookKey("pink", "green"); } catch (e) { thrown = e.message; }
  check(/нет цвета/.test(thrown), "lookKey принял неизвестный цвет");
}

// --- WebP: разбор и сборка ---
const riff = (type, payload) => {
  const b = Buffer.alloc(8 + payload.length + (payload.length & 1));
  b.write(type, 0, "latin1");
  b.writeUInt32LE(payload.length, 4);
  Buffer.from(payload).copy(b, 8);
  return b;
};
const webp = (chunks) => {
  const body = Buffer.concat([Buffer.from("WEBP", "latin1"), ...chunks]);
  const head = Buffer.alloc(8);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
};
const vp8x = (flags, w, h) => {
  const b = Buffer.alloc(10);
  b[0] = flags;
  b.writeUIntLE(w - 1, 4, 3);
  b.writeUIntLE(h - 1, 7, 3);
  return riff("VP8X", b);
};
// Кадр ANMF как одиночный WebP (VP8X + ALPH + VP8 или VP8L) — так кадр отдаёт convertToBlob.
const stillOf = (f) => webp([vp8x(0x10, f.width, f.height), ...f.chunks.map((c) => riff(c.type, c.data))]);
const remux = (bytes, full = false) => {
  const top = L.lookWebpChunks(bytes);
  const x = top.find((c) => c.type === "VP8X"), a = top.find((c) => c.type === "ANIM");
  const frames = top.filter((c) => c.type === "ANMF").map((f) => (full ? { bytes: stillOf(f), duration: f.duration }
    : { bytes: stillOf(f), duration: f.duration, x: f.x, y: f.y, blend: f.blend, dispose: f.dispose }));
  return L.lookMuxAnim({ width: x.width, height: x.height, loop: a.loop, bgcolor: a.bgcolor, frames });
};
for (const [name, frames, loop] of [["idle", 72, 0], ["forget", 132, 1]]) {
  const orig = fs.readFileSync(path.join(maid, name + ".webp"));
  const info = L.lookAnimInfo(orig);
  check(info.width === 400 && info.height === 427 && info.durations.length === frames && info.loop === loop,
    `${name}.webp: ${info.width}×${info.height}, кадров ${info.durations.length}, повтор ${info.loop} — ждали 400×427, ${frames}, ${loop}`);
  const top = L.lookWebpChunks(orig);
  const anmf = top.filter((c) => c.type === "ANMF");
  check(anmf.every((f) => f.chunks.some((c) => c.type === "VP8 " || c.type === "VP8L")), `${name}.webp: не разобрались куски кадров`);
  // Те же кадры с теми же сдвигами и флагами — байт в байт исходный файл.
  const same = remux(orig);
  check(Buffer.from(same).equals(orig), `${name}.webp: разобранный и собранный обратно файл не совпал байт в байт`);
  // Целые кадры с угла 0,0 (как в lookRender): флаги VP8X, холст, повтор, длительности.
  const full = Buffer.from(remux(orig, true));
  const back = L.lookWebpChunks(full);
  const bx = back.find((c) => c.type === "VP8X");
  const bi = L.lookAnimInfo(full);
  check(bx && bx.flags === 0x12 && bx.width === 400 && bx.height === 427, `${name}: VP8X флаги ${bx && bx.flags} (ждали 0x12: анимация и прозрачность), холст ${bx && bx.width}×${bx && bx.height}`);
  check(bi.loop === loop && bi.bgcolor === info.bgcolor, `${name}: повтор ${bi.loop} и фон ${bi.bgcolor} не как в исходнике (${loop}, ${info.bgcolor})`);
  check(JSON.stringify(bi.durations) === JSON.stringify(info.durations), `${name}: длительности кадров не как в исходнике`);
  const bf = back.filter((c) => c.type === "ANMF");
  check(bf.length === frames && bf.every((f, i) => f.x === 0 && f.y === 0 && !f.blend && !f.dispose && f.width === anmf[i].width && f.height === anmf[i].height),
    `${name}: кадры собраны не с угла 0,0 или со смешиванием/очисткой`);
  check(full.readUInt32LE(4) === full.length - 8, `${name}: длина RIFF не сходится`);
}
{
  // Маски — кадры VP8L (без потерь) без VP8X: оба вида одиночного WebP.
  const orig = fs.readFileSync(path.join(keepDir, "forget.webp"));
  check(Buffer.from(remux(orig)).equals(orig), "maid-keep/forget.webp: разобранный и собранный обратно файл не совпал байт в байт");
  const f = L.lookWebpChunks(orig).find((c) => c.type === "ANMF");
  const simple = webp(f.chunks.map((c) => riff(c.type, c.data)));
  const st = L.lookStill(simple);
  check(st.width === 400 && st.height === 427 && st.chunks.length === 1 && st.chunks[0].type === "VP8L", "простой одиночный VP8L разобран неверно");
  const i0 = L.lookWebpChunks(fs.readFileSync(path.join(maid, "idle.webp"))).find((c) => c.type === "ANMF");
  const vp8only = webp(i0.chunks.filter((c) => c.type === "VP8 ").map((c) => riff(c.type, c.data)));
  const s2 = L.lookStill(vp8only);
  check(s2.width === i0.width && s2.height === i0.height && s2.chunks.length === 1, "простой одиночный VP8 разобран неверно");
  for (const [what, fn] of [
    ["не WebP", () => L.lookWebpChunks(Buffer.from("RIFF\u0004\u0000\u0000\u0000WAVE", "latin1"))],
    ["нечётный сдвиг", () => L.lookMuxAnim({ width: 400, height: 427, frames: [{ bytes: simple, duration: 40, x: 1 }] })],
    ["кадр больше холста", () => L.lookMuxAnim({ width: 100, height: 100, frames: [{ bytes: simple, duration: 40 }] })],
    ["нет кадров", () => L.lookMuxAnim({ width: 400, height: 427, frames: [] })],
  ]) {
    let thrown = false;
    try { fn(); } catch { thrown = true; }
    check(thrown, `${what}: нет ошибки`);
  }
}

// --- маски: те же кадры, длительности, холст и повтор, что у анимаций ---
{
  const list = (d) => fs.readdirSync(d).filter((f) => f.endsWith(".webp")).sort();
  const anims = list(maid), keeps = list(keepDir);
  check(anims.length === 41, `анимаций ${anims.length}, ждали 41`);
  check(JSON.stringify(anims) === JSON.stringify(keeps), `маски не на все анимации или лишние: ${anims.filter((f) => !keeps.includes(f)).concat(keeps.filter((f) => !anims.includes(f))).join(", ")}`);
  let total = 0;
  for (const f of anims.filter((x) => keeps.includes(x))) {
    const kb = fs.readFileSync(path.join(keepDir, f));
    total += kb.length;
    const a = L.lookAnimInfo(fs.readFileSync(path.join(maid, f))), k = L.lookAnimInfo(kb);
    check(a.width === k.width && a.height === k.height && a.loop === k.loop && JSON.stringify(a.durations) === JSON.stringify(k.durations),
      `${f}: маска устарела (кадры, длительности, холст или повтор не как у анимации) — python tools/maid-look/make_masks.py ${f.replace(".webp", "")}`);
    const frames = L.lookWebpChunks(kb).filter((c) => c.type === "ANMF");
    check(frames.every((c) => c.x === 0 && c.y === 0 && c.width === a.width && c.height === a.height && !c.blend && c.chunks.length === 1 && c.chunks[0].type === "VP8L"),
      `${f}: кадры маски должны быть целыми, без смешивания и без потерь (VP8L)`);
  }
  check(total <= 3.2 * 1024 * 1024, `маски весят ${(total / 1048576).toFixed(2)} МБ — больше 3 МБ`);

  // sources.json (пишет make_masks.py): маски сделаны для этих самых анимаций и для этой LOOK_VERSION. Перерисованная
  // анимация с теми же длительностями проверку выше проходит — её ловит sha256.
  const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  let man = null;
  try { man = JSON.parse(fs.readFileSync(path.join(keepDir, "sources.json"), "utf8")); } catch (e) { check(false, `maid-keep/sources.json не читается: ${e.message}`); }
  if (man) {
    const run = "python tools/maid-look/make_masks.py";
    check(man.version === L.LOOK_VERSION, `sources.json сделан для LOOK_VERSION ${man.version}, а в look.js ${L.LOOK_VERSION} — запусти ${run}`);
    const listed = Object.keys(man.files || {}).sort();
    check(JSON.stringify(listed) === JSON.stringify(anims), `в sources.json не те анимации: ${anims.filter((f) => !listed.includes(f)).concat(listed.filter((f) => !anims.includes(f))).join(", ")} — запусти ${run}`);
    for (const f of anims.filter((x) => listed.includes(x))) {
      const e = man.files[f];
      check(sha(path.join(maid, f)) === e.src, `${f}: анимация поменялась после масок — подними LOOK_VERSION в look.js и запусти ${run} ${f.replace(".webp", "")}`);
      if (keeps.includes(f)) check(sha(path.join(keepDir, f)) === e.keep, `${f}: маска не та, что записал make_masks.py (правлена руками или устарела) — запусти ${run} ${f.replace(".webp", "")}`);
    }
  }
}

// --- сверка с эталоном и чужой декодер (Python + Pillow) ---
const py = process.env.PYTHON || "python";
const hasPy = spawnSync(py, ["-c", "import PIL, numpy, scipy"], { encoding: "utf8" }).status === 0;
if (!hasPy) {
  console.log("пропуск: нет Python с Pillow, numpy и scipy — сверка с look_math.py и чтение собранного файла Pillow не проверены");
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "maid-look-"));
  try {
    // lookPixels и look_math.recolour на настоящих кадрах: расхождение не больше 1 (pow в разных библиотеках).
    // Последнее число — сколько пикселей самое меньшее должно перекраситься (одни глаза — меньше).
    const cases = [
      ["idle", 0, "gold", "green", true, 2000], ["tea", 24, "black", "amber", true, 2000], ["bedtime", 48, "silver", "blue", true, 2000],
      ["smitten", 30, "violet", "green", true, 2000], ["listen", 0, "brown", "violet", true, 2000], ["idle", 0, "black", "blue", false, 2000],
      ["smitten", 50, "red", "green", true, 300], ["excited", 24, "red", "blue", true, 300],
    ];
    for (const [name, frame, hair, eyes, withKeep, least] of cases) {
      const out = path.join(tmp, `${name}-${frame}-${hair}-${eyes}`);
      fs.mkdirSync(out);
      const keepArg = withKeep ? path.join(keepDir, name + ".webp") : "-";
      const r = spawnSync(py, [path.join(repo, "tools", "maid-look", "look_math.py"), "--dump", path.join(maid, name + ".webp"), String(frame), keepArg, hair, eyes, out], { encoding: "utf8" });
      if (r.status !== 0) { check(false, `look_math.py --dump ${name}: ${r.stderr.trim().split("\n").pop()}`); continue; }
      const inp = fs.readFileSync(path.join(out, "in.raw")), ref = fs.readFileSync(path.join(out, "out.raw"));
      const keep = withKeep ? new Uint8ClampedArray(fs.readFileSync(path.join(out, "keep.raw"))) : null;
      check(inp.length === 400 * 427 * 4 && ref.length === inp.length && (!keep || keep.length === inp.length), `${name}: не тот размер сырых кадров`);
      const mine = new Uint8ClampedArray(inp);
      check(L.lookPixels(new Uint8ClampedArray(inp), keep, "red", "violet") === 0, `${name}: свои цвета поменяли настоящий кадр`);
      const changed = L.lookPixels(mine, keep, hair, eyes);
      let diff = 0, worst = 0, refChanged = 0;
      for (let i = 0; i < mine.length; i++) {
        const dv = Math.abs(mine[i] - ref[i]);
        if (dv) diff++;
        if (dv > worst) worst = dv;
      }
      for (let i = 0; i < inp.length; i += 4) if (inp[i] !== ref[i] || inp[i + 1] !== ref[i + 1] || inp[i + 2] !== ref[i + 2]) refChanged++;
      check(worst <= 1 && diff <= 50, `${name} кадр ${frame} ${hair}/${eyes}: с эталоном расходится ${diff} байт, до ${worst}`);
      check(changed > least && Math.abs(changed - refChanged) <= 50, `${name} кадр ${frame}: перекрашено ${changed} пикселей (ждали больше ${least}), у эталона ${refChanged}`);
      if (keep) {
        // Под маской «оставить» нет глаз: всё, что перекрашивают одни глаза без маски, маска пропускает.
        const eyesOnly = new Uint8ClampedArray(inp);
        const eyePx = L.lookPixels(eyesOnly, null, "red", "green");
        let under = 0;
        for (let i = 0; i < inp.length; i += 4) if (keep[i + 3] > 127 && (eyesOnly[i] !== inp[i] || eyesOnly[i + 1] !== inp[i + 1] || eyesOnly[i + 2] !== inp[i + 2])) under++;
        check(eyePx > 0 && under === 0, `${name} кадр ${frame}: ${under} пикселей глаз (из ${eyePx}) под маской «оставить» — глаза не перекрасятся`);
      }
    }

    // make_masks.py --check по записанным маскам: ни одна вещь у волос не мигает (кусок своего цвета, перекрашенный на
    // соседнем кадре) и под маской нет ключа глаз. Здесь — анимации, где вещи касаются волос; все — без имён (~1 мин).
    {
      const makeMasks = path.join(repo, "tools", "maid-look", "make_masks.py");
      const r = spawnSync(py, [makeMasks, "--check", "forget", "giggle", "shy", "tea", "smitten", "excited"], { encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
      let res = null;
      try { res = JSON.parse(r.stdout); } catch { check(false, `make_masks.py --check: ${(r.stderr || r.stdout).trim().split("\n").pop()}`); }
      if (res) {
        check(Object.keys(res).length === 6, `make_masks.py --check: ${Object.keys(res).length} анимаций из 6`);
        for (const [name, v] of Object.entries(res)) {
          check(v.flicker.length === 0, `${name}: маска мигает ${v.flicker.length} раз (кадр, соседний, px, перекрашено, рамка): ${JSON.stringify(v.flicker.slice(0, 3))}`);
          check(v.eye === 0, `${name}: ${v.eye} пикселей маски на ключе глаз`);
        }
      }
      // Листы — только снаружи репозитория: ни корень, ни папка внутри, ни соседняя папка с тем же началом имени не путаются.
      for (const dirArg of [repo, repo + path.sep, path.join(repo, "tools"), ...(process.platform === "win32" ? [repo.toUpperCase()] : [])]) {
        const g = spawnSync(py, [makeMasks, "--sheets", dirArg, "__нет__"], { encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
        check(g.status !== 0 && /листы не кладутся в репозиторий/.test(g.stderr), `make_masks.py --sheets ${dirArg}: листы пустили в репозиторий (код ${g.status})`);
      }
      const o = spawnSync(py, ["-c", "import sys; sys.path.insert(0, sys.argv[1]); import make_masks as M; print(int(M.outside_repo(sys.argv[2])), int(M.outside_repo(sys.argv[3])))",
        path.dirname(makeMasks), repo + "-копия", tmp], { encoding: "utf8", cwd: tmp });
      check(o.status === 0 && o.stdout.trim() === "1 1", `outside_repo: соседняя папка «…-копия» и временная должны быть снаружи, получили «${o.stdout.trim()}» ${o.stderr.trim().split("\n").pop() || ""}`);
    }

    // Целые кадры (как из convertToBlob) → lookMuxAnim → Pillow читает: кадры, длительности, повтор, пиксели как у кадров.
    const PY = `
import sys, os, json
import numpy as np
from PIL import Image
mode, src, d = sys.argv[1], sys.argv[2], sys.argv[3]
if mode == 'stills':
    im = Image.open(src)
    for i in range(im.n_frames):
        im.seek(i)
        im.convert('RGBA').save(os.path.join(d, 'f%03d.webp' % i), 'WEBP', quality=90)
    print(json.dumps(dict(n=im.n_frames)))
else:
    im = Image.open(os.path.join(d, 'muxed.webp'))
    dur, wrong = [], 0
    for i in range(im.n_frames):
        im.seek(i)
        a = np.asarray(im.convert('RGBA'))
        dur.append(im.info.get('duration'))  # Pillow пишет длительность при чтении кадра
        b = np.asarray(Image.open(os.path.join(d, 'f%03d.webp' % i)).convert('RGBA'))
        wrong += int(not np.array_equal(a, b))
    print(json.dumps(dict(n=im.n_frames, size=list(im.size), loop=im.info.get('loop'), durations=dur, wrong=wrong)))
`;
    for (const [name, loop] of [["idle", 0], ["forget", 1]]) {
      const d = path.join(tmp, "mux-" + name);
      fs.mkdirSync(d);
      const file = path.join(maid, name + ".webp");
      const run = (mode) => {
        const r = spawnSync(py, ["-c", PY, mode, file, d], { encoding: "utf8", cwd: tmp });
        if (r.status !== 0) throw new Error(r.stderr.trim().split("\n").pop());
        return JSON.parse(r.stdout);
      };
      try {
        const info = L.lookAnimInfo(fs.readFileSync(file));
        const made = run("stills");
        const frames = [];
        for (let i = 0; i < made.n; i++) frames.push({ bytes: fs.readFileSync(path.join(d, `f${String(i).padStart(3, "0")}.webp`)), duration: info.durations[i] });
        fs.writeFileSync(path.join(d, "muxed.webp"), L.lookMuxAnim({ width: info.width, height: info.height, loop: info.loop, bgcolor: info.bgcolor, frames }));
        const got = run("check");
        check(got.n === info.durations.length && got.size[0] === 400 && got.size[1] === 427, `${name}: Pillow прочитал ${got.n} кадров ${got.size.join("×")}`);
        check(got.loop === loop, `${name}: Pillow прочитал повтор ${got.loop}, ждали ${loop}`);
        check(JSON.stringify(got.durations) === JSON.stringify(info.durations), `${name}: Pillow прочитал другие длительности`);
        check(got.wrong === 0, `${name}: ${got.wrong} кадров собранной анимации не совпали со своими одиночными кадрами`);
      } catch (e) {
        check(false, `${name}: Python не прочитал собранную анимацию: ${e.message}`);
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(bad ? `${bad} из ${n} не прошло` : `ok ${n}`);
process.exit(bad ? 1 : 0);
