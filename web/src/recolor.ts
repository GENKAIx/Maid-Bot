// Перекраска Рины для «Витрины» админки (этап 4): копия чистой части desktop/renderer/look.js — таблицы цветов с формулами
// (LOOK_HAIR / LOOK_EYES), ключи и lookPixels. Сайт собирается без desktop/ (Dockerfile), поэтому код скопирован;
// web/test/showcase.test.ts грузит настоящий look.js и сверяет таблицы и результат на случайных пикселях.
// Отличие от виджета: маски assets/maid-keep (румянец, рот, сердечки — «оставить свой цвет») есть только у анимаций
// программы 400×427, у картинок сайта 180×192 их нет — поэтому здесь перекраска без маски, похожие на волосы мелочи
// тоже чуть меняют цвет. Поменял формулы в look.js — поменяй здесь (тест подскажет).

type Rule = ["mul", number] | ["pow", number] | ["lin", number, number];
type Remap = { h: number; s: number; v: Rule } | null;
export type RecolorOption = { id: string; name: string; swatch: string; remap: Remap };
type Key = { center: number; half: number; feather: number; s: [number, number]; v: [number, number]; vu: [number, number] | null };

const HAIR_KEY: Key = { center: 349, half: 12, feather: 8, s: [0.3, 0.42], v: [0.08, 0.16], vu: [0.9, 0.97] };
const EYE_KEY: Key = { center: 283, half: 18, feather: 12, s: [0.22, 0.32], v: [0.16, 0.26], vu: null };
const HUE_KEEP = 0.3;

export const SHOW_HAIR: RecolorOption[] = [
  { id: "red", name: "тёмно-красные", swatch: "#a73241", remap: null },
  { id: "brown", name: "каштановые", swatch: "#784e31", remap: { h: 24, s: 0.85, v: ["mul", 0.72] } },
  { id: "gold", name: "золотистые", swatch: "#e6bb4d", remap: { h: 42, s: 0.95, v: ["pow", 2.2] } },
  { id: "silver", name: "серебристые", swatch: "#c5cbd7", remap: { h: 220, s: 0.12, v: ["pow", 1.75] } },
  { id: "violet", name: "фиолетовые", swatch: "#8b44a7", remap: { h: 282, s: 0.85, v: ["mul", 1] } },
  { id: "black", name: "чёрные", swatch: "#54566f", remap: { h: 235, s: 0.35, v: ["lin", 0.16, 0.42] } },
];
export const SHOW_EYES: RecolorOption[] = [
  { id: "violet", name: "фиолетовые", swatch: "#642c7f", remap: null },
  { id: "green", name: "зелёные", swatch: "#2c7f40", remap: { h: 135, s: 1, v: ["mul", 1] } },
  { id: "blue", name: "синие", swatch: "#2c547f", remap: { h: 212, s: 1, v: ["mul", 1] } },
  { id: "amber", name: "янтарные", swatch: "#b28038", remap: { h: 36, s: 1.05, v: ["pow", 1.74] } },
];

const mod = (x: number, y: number) => { const m = x % y; return m !== 0 && m < 0 !== y < 0 ? m + y : m; };
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const ramp = (x: number, a: number, b: number) => clamp01((x - a) / (b - a));
const byte = (x: number) => Math.floor(Math.min(Math.max(x + 0.5, 0), 255));

function weight(h: number, s: number, v: number, k: Key) {
  const d = Math.abs(mod(h - k.center + 180, 360) - 180);
  let w = clamp01(1 - (d - k.half) / k.feather) * ramp(s, k.s[0], k.s[1]) * ramp(v, k.v[0], k.v[1]);
  if (k.vu) w = w * (1 - ramp(v, k.vu[0], k.vu[1]));
  return w;
}

function target(h: number, s: number, v: number, t: NonNullable<Remap>, center: number, out: number[]) {
  const dh = mod(h - center + 180, 360) - 180;
  const nh = mod(t.h + dh * HUE_KEEP, 360);
  const ns = clamp01(s * t.s);
  const r = t.v;
  const nv = r[0] === "mul" ? clamp01(v * r[1]) : r[0] === "pow" ? 1 - (1 - v) ** r[1] : clamp01(r[1] + r[2] * v);
  const hh = mod(nh, 360) / 60;
  const fl = Math.floor(hh);
  const f = hh - fl;
  const p = nv * (1 - ns), q = nv * (1 - ns * f), u = nv * (1 - ns * (1 - f));
  const rgb = [[nv, u, p], [q, nv, p], [p, nv, u], [p, q, nv], [u, p, nv], [nv, p, q]][mod(fl, 6)];
  out[0] = rgb[0] * 255;
  out[1] = rgb[1] * 255;
  out[2] = rgb[2] * 255;
}

const remapOf = (table: RecolorOption[], id: string) => (table.find((o) => o.id === id) ?? table[0]).remap;

/** Свои волосы и глаза — перекрашивать нечего. */
export const recolorIsOwn = (hair: string, eyes: string) => !remapOf(SHOW_HAIR, hair) && !remapOf(SHOW_EYES, eyes);

/** Перекраска кадра на месте (байты RGBA, как ImageData.data), без маски; возвращает, сколько пикселей поменялось.
 *  То же, что lookPixels(rgba, null, hair, eyes) в look.js. */
export function recolorPixels(rgba: Uint8ClampedArray | Uint8Array, hair: string, eyes: string): number {
  const th = remapOf(SHOW_HAIR, hair), te = remapOf(SHOW_EYES, eyes);
  if (!th && !te) return 0;
  const out = [0, 0, 0];
  let changed = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] === 0) continue;
    const R = rgba[i], G = rgba[i + 1], B = rgba[i + 2];
    const imx = Math.max(R, G, B);
    if (imx <= 20 || (imx - Math.min(R, G, B)) * 100 <= imx * 22) continue;
    const r = R / 255, g = G / 255, b = B / 255;
    const mx = Math.max(r, g, b);
    const d = mx - Math.min(r, g, b);
    const h = 60 * (mx === r ? mod((g - b) / d, 6) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4);
    const s = d / mx;
    const wh = th ? weight(h, s, mx, HAIR_KEY) : 0;
    const we = te ? weight(h, s, mx, EYE_KEY) : 0;
    if (!(wh > 0) && !(we > 0)) continue;
    let fr = R, fg = G, fb = B;
    if (th && wh > 0) {
      target(h, s, mx, th, HAIR_KEY.center, out);
      fr = fr * (1 - wh) + out[0] * wh;
      fg = fg * (1 - wh) + out[1] * wh;
      fb = fb * (1 - wh) + out[2] * wh;
    }
    if (te && we > 0) {
      target(h, s, mx, te, EYE_KEY.center, out);
      fr = fr * (1 - we) + out[0] * we;
      fg = fg * (1 - we) + out[1] * we;
      fb = fb * (1 - we) + out[2] * we;
    }
    const nr = byte(fr), ng = byte(fg), nb = byte(fb);
    if (nr !== R || ng !== G || nb !== B) {
      rgba[i] = nr;
      rgba[i + 1] = ng;
      rgba[i + 2] = nb;
      changed++;
    }
  }
  return changed;
}
