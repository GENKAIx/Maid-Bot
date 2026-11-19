// «Перекрасить Рину»: волосы (свои — тёмно-красные) и глаза (свои — фиолетовые) горничной в другой цвет. Здесь только
// ядро, без кнопок: таблицы цветов, перекраска пикселей, разбор и сборка анимированного WebP, перекраска целой анимации.
//
// Путь анимации (lookRender, ниже метки «браузер»): исходник assets/maid/<имя>.webp и его маска assets/maid-keep/<имя>.webp
// (те же кадры, длительности и холст 400×427; белое непрозрачное — «оставить свой цвет»: румянец, рот, сердечки, складки
// на коже, брови и линии век, огонёк — всё, что по цвету похоже на волосы, но не волосы; маски делает
// tools/maid-look/make_masks.py, он же пишет assets/maid-keep/sources.json — sha256 анимаций и масок и LOOK_VERSION, для
// которой они сделаны; тест сверяет его с файлами)
// раскладываются ImageDecoder на кадры → кадр рисуется на OffscreenCanvas → getImageData → lookPixels → convertToBlob
// в WebP (качество 0,9) → lookMuxAnim собирает кадры обратно в анимацию с тем же числом повторов (forget — один раз).
// Между кадрами — await pause(), чтобы окно не замирало; кадры VideoFrame закрываются сразу.
//
// Ключ (lookPixels): пиксель — волосы, если тон 349° ± 12° (и ещё 8° мягкого края), насыщенность от 0,30 (полный вес
// с 0,42), яркость от 0,08 (полный с 0,16) и не светлее 0,90 (к 0,97 вес падает до нуля — румянец, язык, блики);
// глаза — тон 283° ± 18° (+12°), насыщенность 0,22 → 0,32, яркость 0,16 → 0,26 (строже — не задеть фиолетовый оттенок
// чёрного контура). Новый цвет: тон цели + 0,3 · (отклонение тона пикселя от центра ключа) — живые блики и тени;
// насыщенность и яркость — по правилу цели (LOOK_HAIR / LOOK_EYES). Итог — смесь исходного и нового по весу ключа в RGB,
// прозрачность не трогается. Свои цвета (red, violet) — без перекраски.
//
// Те же числа и формулы — в эталоне tools/maid-look/look_math.py (по нему сделаны маски). Поменял тут — поменяй там,
// подними LOOK_VERSION (входит в ключ кэша lookKey) и прогони node desktop/test/look.test.cjs: он сверяет lookPixels
// с эталоном на настоящих кадрах.
//
// Числа: 41 анимация, 72–132 кадра по 41–42 мс, 3438 кадров всего; маски — 2,0 МБ без потерь.

// Поднимать при любой правке чисел ключей и целей ниже и при каждой пересборке масок, которая их поменяла
// (make_masks.py без подъёма не обновит sources.json, и тест упадёт). 2 — маски с вырезами у прядей (20.11.2026).
const LOOK_VERSION = 2;
// Ключи: центр тона, полуширина ядра, мягкий край (градусы); насыщенность и яркость — линейный подъём веса (от, до);
// vu — яркость, с которой вес снова падает (светлое — не волосы).
const LOOK_HAIR_KEY = { center: 349, half: 12, feather: 8, s: [0.3, 0.42], v: [0.08, 0.16], vu: [0.9, 0.97] };
const LOOK_EYE_KEY = { center: 283, half: 18, feather: 12, s: [0.22, 0.32], v: [0.16, 0.26], vu: null };
const LOOK_HUE_KEEP = 0.3; // доля отклонения тона от центра ключа, которая остаётся у нового цвета

// Цели: h — новый тон; s — множитель насыщенности; v — правило яркости:
//   ["mul", k] — v·k;  ["pow", p] — 1 − (1 − v)^p (светлее);  ["lin", a, k] — a + k·v (сжатие в тёмное).
// remap: null — свой цвет. swatch — как выглядит средний пиксель волос (глаз) после перекраски, для кнопки.
const LOOK_HAIR = [
  { id: "red", name: "тёмно-красные", swatch: "#a73241", remap: null },
  { id: "brown", name: "каштановые", swatch: "#784e31", remap: { h: 24, s: 0.85, v: ["mul", 0.72] } },
  { id: "gold", name: "золотистые", swatch: "#e6bb4d", remap: { h: 42, s: 0.95, v: ["pow", 2.2] } },
  { id: "silver", name: "серебристые", swatch: "#c5cbd7", remap: { h: 220, s: 0.12, v: ["pow", 1.75] } },
  { id: "violet", name: "фиолетовые", swatch: "#8b44a7", remap: { h: 282, s: 0.85, v: ["mul", 1] } },
  { id: "black", name: "чёрные", swatch: "#54566f", remap: { h: 235, s: 0.35, v: ["lin", 0.16, 0.42] } },
];
const LOOK_EYES = [
  { id: "violet", name: "фиолетовые", swatch: "#642c7f", remap: null },
  { id: "green", name: "зелёные", swatch: "#2c7f40", remap: { h: 135, s: 1, v: ["mul", 1] } },
  { id: "blue", name: "синие", swatch: "#2c547f", remap: { h: 212, s: 1, v: ["mul", 1] } },
  { id: "amber", name: "янтарные", swatch: "#b28038", remap: { h: 36, s: 1.05, v: ["pow", 1.74] } },
];

function lookOption(table, id) {
  const o = table.find((x) => x.id === id);
  if (!o) throw new Error(`Перекраска: нет цвета «${id}»`);
  return o;
}

/** Свои волосы и свои глаза — перекрашивать нечего. */
function lookIsDefault(hair, eyes) {
  return !lookOption(LOOK_HAIR, hair).remap && !lookOption(LOOK_EYES, eyes).remap;
}

/** Ключ кэша готовой анимации: меняется вместе с LOOK_VERSION (другие числа — другой результат). */
function lookKey(hair, eyes) {
  return `look${LOOK_VERSION}-${lookOption(LOOK_HAIR, hair).id}-${lookOption(LOOK_EYES, eyes).id}`;
}

// Остаток с полом (как % в Python): -1 % 6 → 5.
function lookMod(x, y) {
  const m = x % y;
  return m !== 0 && m < 0 !== y < 0 ? m + y : m;
}

function lookClamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function lookRamp(x, a, b) {
  return lookClamp01((x - a) / (b - a));
}

/** Вес ключа k (0–1) для тона h (градусы), насыщенности s и яркости v (0–1). */
function lookWeight(h, s, v, k) {
  const d = Math.abs(lookMod(h - k.center + 180, 360) - 180);
  let w = lookClamp01(1 - (d - k.half) / k.feather) * lookRamp(s, k.s[0], k.s[1]) * lookRamp(v, k.v[0], k.v[1]);
  if (k.vu) w = w * (1 - lookRamp(v, k.vu[0], k.vu[1]));
  return w;
}

/** Цвет цели t для пикселя (h, s, v) — в out[0..2] (0–255, дробные). center — центр тона ключа. */
function lookTarget(h, s, v, t, center, out) {
  const dh = lookMod(h - center + 180, 360) - 180;
  const nh = lookMod(t.h + dh * LOOK_HUE_KEEP, 360);
  const ns = lookClamp01(s * t.s);
  const rule = t.v;
  const nv = rule[0] === "mul" ? lookClamp01(v * rule[1]) : rule[0] === "pow" ? 1 - (1 - v) ** rule[1] : lookClamp01(rule[1] + rule[2] * v);
  const hh = lookMod(nh, 360) / 60;
  const fl = Math.floor(hh);
  const f = hh - fl;
  const p = nv * (1 - ns), q = nv * (1 - ns * f), u = nv * (1 - ns * (1 - f));
  const rgb = [[nv, u, p], [q, nv, p], [p, nv, u], [p, q, nv], [u, p, nv], [nv, p, q]][lookMod(fl, 6)];
  out[0] = rgb[0] * 255;
  out[1] = rgb[1] * 255;
  out[2] = rgb[2] * 255;
}

function lookByte(x) {
  return Math.floor(Math.min(Math.max(x + 0.5, 0), 255));
}

/** Перекраска кадра на месте. rgba — байты RGBA (ImageData.data); keep — такие же байты маски (альфа > 127 — оставить
 *  свой цвет) или null. Прозрачное, тёмное (ярче 20 из 255 — нет) и серое (насыщенность до 0,22) пропускаются сразу:
 *  оба ключа их не берут. Возвращает, сколько пикселей поменялось. */
function lookPixels(rgba, keep, hairId = "red", eyesId = "violet") {
  const th = lookOption(LOOK_HAIR, hairId).remap;
  const te = lookOption(LOOK_EYES, eyesId).remap;
  if (!th && !te) return 0;
  if (keep && keep.length !== rgba.length) throw new Error("Перекраска: маска другого размера, чем кадр");
  const out = [0, 0, 0];
  let changed = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] === 0 || (keep && keep[i + 3] > 127)) continue;
    const R = rgba[i], G = rgba[i + 1], B = rgba[i + 2];
    const imx = Math.max(R, G, B);
    if (imx <= 20 || (imx - Math.min(R, G, B)) * 100 <= imx * 22) continue;
    const r = R / 255, g = G / 255, b = B / 255;
    const mx = Math.max(r, g, b);
    const d = mx - Math.min(r, g, b);
    const h = 60 * (mx === r ? lookMod((g - b) / d, 6) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4);
    const s = d / mx;
    const wh = th ? lookWeight(h, s, mx, LOOK_HAIR_KEY) : 0;
    const we = te ? lookWeight(h, s, mx, LOOK_EYE_KEY) : 0;
    if (!(wh > 0) && !(we > 0)) continue;
    let fr = R, fg = G, fb = B;
    if (wh > 0) {
      lookTarget(h, s, mx, th, LOOK_HAIR_KEY.center, out);
      fr = fr * (1 - wh) + out[0] * wh;
      fg = fg * (1 - wh) + out[1] * wh;
      fb = fb * (1 - wh) + out[2] * wh;
    }
    if (we > 0) {
      lookTarget(h, s, mx, te, LOOK_EYE_KEY.center, out);
      fr = fr * (1 - we) + out[0] * we;
      fg = fg * (1 - we) + out[1] * we;
      fb = fb * (1 - we) + out[2] * we;
    }
    const nr = lookByte(fr), ng = lookByte(fg), nb = lookByte(fb);
    if (nr !== R || ng !== G || nb !== B) {
      rgba[i] = nr;
      rgba[i + 1] = ng;
      rgba[i + 2] = nb;
      changed++;
    }
  }
  return changed;
}

// --- WebP: разбор и сборка (RIFF: тип 4 буквы, длина u32 LE, данные, добивка до чётной длины) ---

function lookBytes(x) {
  if (ArrayBuffer.isView(x)) return x instanceof Uint8Array ? x : new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  throw new Error("Перекраска: ждала байты WebP");
}

function lookStr(b, at) {
  return String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);
}

function lookU24(b, at) {
  return b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);
}

function lookU32(b, at) {
  return lookU24(b, at) + b[at + 3] * 0x1000000;
}

function lookPut(b, at, value, n) {
  for (let k = 0; k < n; k++) b[at + k] = Math.floor(value / 2 ** (8 * k)) & 255;
}

function lookJoin(parts) {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function lookChunk(type, payload) {
  const n = payload.length;
  const out = new Uint8Array(8 + n + (n & 1));
  for (let k = 0; k < 4; k++) out[k] = type.charCodeAt(k);
  lookPut(out, 4, n, 4);
  out.set(payload, 8);
  return out;
}

function lookChunkList(b, at, end) {
  const out = [];
  while (at + 8 <= end) {
    const type = lookStr(b, at), n = lookU32(b, at + 4);
    if (at + 8 + n > end) throw new Error(`Перекраска: кусок ${type.trim()} обрезан`);
    const data = b.subarray(at + 8, at + 8 + n);
    const c = { type, data };
    if (type === "VP8X" && n >= 10) Object.assign(c, { flags: data[0], width: lookU24(data, 4) + 1, height: lookU24(data, 7) + 1 });
    else if (type === "ANIM" && n >= 6) Object.assign(c, { bgcolor: lookU32(data, 0), loop: data[4] | (data[5] << 8) });
    else if (type === "ANMF" && n >= 16) {
      Object.assign(c, {
        x: 2 * lookU24(data, 0), y: 2 * lookU24(data, 3), width: lookU24(data, 6) + 1, height: lookU24(data, 9) + 1,
        duration: lookU24(data, 12), blend: !(data[15] & 2), dispose: !!(data[15] & 1), chunks: lookChunkList(data, 16, n),
      });
    }
    out.push(c);
    at += 8 + n + (n & 1);
  }
  return out;
}

/** Куски WebP верхнего уровня: [{type, data}], у VP8X ещё flags/width/height, у ANIM — bgcolor/loop, у ANMF —
 *  x/y/width/height/duration (мс)/blend/dispose и свои куски chunks. */
function lookWebpChunks(bytes) {
  const b = lookBytes(bytes);
  if (b.length < 12 || lookStr(b, 0) !== "RIFF" || lookStr(b, 8) !== "WEBP") throw new Error("Перекраска: это не WebP");
  return lookChunkList(b, 12, Math.min(b.length, 8 + lookU32(b, 4)));
}

/** Холст, повторы, фон и длительности кадров анимированного WebP. */
function lookAnimInfo(bytes) {
  const chunks = lookWebpChunks(bytes);
  const vp8x = chunks.find((c) => c.type === "VP8X");
  const anim = chunks.find((c) => c.type === "ANIM");
  const durations = chunks.filter((c) => c.type === "ANMF").map((c) => c.duration);
  if (!vp8x || !anim || !durations.length) throw new Error("Перекраска: это не анимированный WebP");
  return { width: vp8x.width, height: vp8x.height, loop: anim.loop, bgcolor: anim.bgcolor, durations };
}

/** Кадр из одиночного WebP (простого VP8/VP8L или расширенного VP8X + ALPH + VP8, как отдаёт convertToBlob):
 *  куски для ANMF и размер картинки из её заголовка. */
function lookStill(bytes) {
  const all = lookWebpChunks(bytes);
  const img = all.find((c) => c.type === "VP8 " || c.type === "VP8L");
  if (!img) throw new Error("Перекраска: в кадре нет картинки VP8/VP8L");
  const d = img.data;
  if (img.type === "VP8L") {
    if (d.length < 5 || d[0] !== 0x2f) throw new Error("Перекраска: битый кадр VP8L");
    const bits = lookU32(d, 1);
    return { chunks: [img], width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (d.length < 10 || d[3] !== 0x9d || d[4] !== 0x01 || d[5] !== 0x2a) throw new Error("Перекраска: битый кадр VP8");
  const alph = all.find((c) => c.type === "ALPH");
  return { chunks: alph ? [alph, img] : [img], width: (d[6] | (d[7] << 8)) & 0x3fff, height: (d[8] | (d[9] << 8)) & 0x3fff };
}

/** Анимированный WebP из одиночных кадров. frames: [{bytes (одиночный WebP), duration (мс), x, y, blend, dispose}];
 *  по умолчанию кадр с угла 0,0 без смешивания с прошлым (blend: false) и без очистки (dispose: false) — целые кадры
 *  с прозрачностью так показываются как есть. VP8X — с флагами «анимация» и «прозрачность». */
function lookMuxAnim({ width, height, loop = 0, bgcolor = 0, frames }) {
  const ok = (x) => Number.isInteger(x) && x >= 1 && x <= 0x1000000;
  if (!ok(width) || !ok(height)) throw new Error("Перекраска: холст не того размера");
  if (!frames || !frames.length) throw new Error("Перекраска: нет кадров");
  const head = new Uint8Array(10);
  head[0] = 0x12;
  lookPut(head, 4, width - 1, 3);
  lookPut(head, 7, height - 1, 3);
  const anim = new Uint8Array(6);
  lookPut(anim, 0, bgcolor >>> 0, 4);
  lookPut(anim, 4, loop & 0xffff, 2);
  const parts = [lookChunk("VP8X", head), lookChunk("ANIM", anim)];
  for (const f of frames) {
    const st = lookStill(f.bytes);
    const x = f.x || 0, y = f.y || 0;
    if (x % 2 || y % 2) throw new Error("Перекраска: сдвиг кадра должен быть чётным");
    if (x + st.width > width || y + st.height > height) throw new Error("Перекраска: кадр больше холста");
    const fh = new Uint8Array(16);
    lookPut(fh, 0, x / 2, 3);
    lookPut(fh, 3, y / 2, 3);
    lookPut(fh, 6, st.width - 1, 3);
    lookPut(fh, 9, st.height - 1, 3);
    lookPut(fh, 12, Math.min(Math.max(Math.round(f.duration) || 0, 0), 0xffffff), 3);
    fh[15] = (f.blend ? 0 : 2) | (f.dispose ? 1 : 0);
    parts.push(lookChunk("ANMF", lookJoin([fh, ...st.chunks.map((c) => lookChunk(c.type, c.data))])));
  }
  const body = lookJoin([Uint8Array.from("WEBP", (c) => c.charCodeAt(0)), ...parts]);
  const out = new Uint8Array(8 + body.length);
  out.set([0x52, 0x49, 0x46, 0x46]); // RIFF
  lookPut(out, 4, body.length, 4);
  out.set(body, 8);
  return out;
}

// --- браузер ---

/** Байты по адресу (файл рядом со страницей), из Blob или как есть. file:// в Electron fetch не берёт — тогда XHR. */
async function lookLoad(src) {
  if (typeof src !== "string") return src instanceof Blob ? new Uint8Array(await src.arrayBuffer()) : lookBytes(src);
  try {
    const r = await fetch(src);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  } catch {
    return await new Promise((ok, fail) => {
      const x = new XMLHttpRequest();
      x.open("GET", src);
      x.responseType = "arraybuffer";
      x.onload = () => ((x.status === 200 || x.status === 0) && x.response ? ok(new Uint8Array(x.response)) : fail(new Error(`Перекраска: не прочитать ${src}`)));
      x.onerror = () => fail(new Error(`Перекраска: не прочитать ${src}`));
      x.send();
    });
  }
}

async function lookDecoder(bytes) {
  const dec = new ImageDecoder({ data: bytes, type: "image/webp", colorSpaceConversion: "none", premultiplyAlpha: "none" });
  await dec.tracks.ready;
  await dec.completed;
  return dec;
}

async function lookFrame(dec, i, ctx, w, h) {
  const fr = (await dec.decode({ frameIndex: i })).image;
  try {
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(fr, 0, 0);
    return fr.duration; // мкс
  } finally {
    fr.close();
  }
}

/** Перекраска целой анимации. src и keep — адрес, Blob или байты WebP (keep — маска из assets/maid-keep или null);
 *  hair / eyes — id из LOOK_HAIR / LOOK_EYES; quality — качество кадров WebP; pause — async-функция между кадрами.
 *  Возвращает { bytes (анимированный WebP), frames, ms }. Свои цвета — исходные байты без пересборки. */
async function lookRender({ src, keep = null, hair = "red", eyes = "violet", quality = 0.9, pause = null }) {
  const t0 = performance.now();
  const bytes = await lookLoad(src);
  const info = lookAnimInfo(bytes);
  const n = info.durations.length;
  if (lookIsDefault(hair, eyes)) return { bytes, frames: n, ms: Math.round(performance.now() - t0) };
  const kbytes = keep == null ? null : await lookLoad(keep);
  if (kbytes) {
    const k = lookAnimInfo(kbytes);
    if (k.durations.length !== n || k.width !== info.width || k.height !== info.height) {
      throw new Error("Перекраска: маска не от этой анимации — перезапусти tools/maid-look/make_masks.py");
    }
  }
  const { width: w, height: h } = info;
  const frames = [];
  let dec = null, kdec = null;
  try {
    dec = await lookDecoder(bytes);
    kdec = kbytes && (await lookDecoder(kbytes));
    if (dec.tracks.selectedTrack.frameCount !== n) throw new Error("Перекраска: декодер насчитал другое число кадров");
    const cv = new OffscreenCanvas(w, h);
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    const kctx = kdec && new OffscreenCanvas(w, h).getContext("2d", { willReadFrequently: true });
    for (let i = 0; i < n; i++) {
      const us = await lookFrame(dec, i, ctx, w, h);
      const img = ctx.getImageData(0, 0, w, h);
      let km = null;
      if (kdec) {
        await lookFrame(kdec, i, kctx, w, h);
        km = kctx.getImageData(0, 0, w, h).data;
      }
      lookPixels(img.data, km, hair, eyes);
      ctx.putImageData(img, 0, 0);
      const blob = await cv.convertToBlob({ type: "image/webp", quality });
      if (blob.type !== "image/webp") throw new Error("Перекраска: браузер не сохраняет WebP");
      frames.push({ bytes: new Uint8Array(await blob.arrayBuffer()), duration: us != null ? us / 1000 : info.durations[i] });
      if (pause) await pause();
    }
  } finally {
    dec?.close();
    kdec?.close();
  }
  const out = lookMuxAnim({ width: w, height: h, loop: info.loop, bgcolor: info.bgcolor, frames });
  return { bytes: out, frames: frames.length, ms: Math.round(performance.now() - t0) };
}
