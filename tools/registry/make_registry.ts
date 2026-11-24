// Реестр для «Витрины» админки (этап 4, docs/review/админка-2026-11-24.html): анимации Рины с кадрами и длительностью,
// эффекты виджета, меню сайта, окна программы, команды бота и белый список фич — собирается из настоящих исходников
// и пишется в web/src/registry.gen.ts (руками не править). Запуск: npm --workspace web run registry (или
// npx tsx tools/registry/make_registry.ts). Тест web/test/showcase.test.ts падает, если исходники поменялись, а файл — нет.
// Сайт собирается в Docker без desktop/ и server/ (Dockerfile: COPY web web), поэтому всё нужное копируется сюда числами
// и строками, без кода программы на ПК.
// Незнакомое окно программы или новое небо погоды без описания — ошибка: допиши описание ниже и перезапусти.

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FEATURE_GROUPS, FEATURES, FEATURE_IDS } from "../../server/src/feature-list.ts";
import { ALBUM_CARDS } from "../../web/src/album.ts";
import { NAV_TABS } from "../../web/src/nav.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const REGISTRY_FILE = join(ROOT, "web", "src", "registry.gen.ts");

// Окна программы на ПК (desktop/src/main.js, loadFile(page("…"))): название и фича, по которой его считают (этап 3).
const WINDOWS: Record<string, { title: string; text: string; feature?: string }> = {
  "index.html": { title: "Главное окно", text: "Сайт с сервера внутри программы; без связи — локальная страница настроек.", feature: "widget.main" },
  "widget.html": { title: "Виджет", text: "Рина на рабочем столе: облачко, список дня, привычки, ввод и голос.", feature: "widget.start" },
  "quick.html": { title: "Быстрая запись", text: "Строка ввода посреди экрана по горячей клавише.", feature: "widget.quick" },
  "flash.html": { title: "Вспышка «стираю память»", text: "Прозрачное окно на каждый монитор: вспышка от прибора в анимации forget." },
};
// Небо над панелью виджета (server/src/weather.ts skyOf → desktop/renderer/style.css .wx-<небо>).
const SKIES: Record<string, string> = {
  sun: "Ясно: тёплый блик в углу панели.",
  gray: "Пасмурно или туман: по панели плывут бледные облака.",
  rain: "Дождь или гроза: косые капли.",
  snow: "Снег: падают снежинки.",
  storm: "Метель: снег летит вбок.",
  frost: "Мороз: иней по краю панели.",
};

const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8").replace(/\r\n/g, "\n");

/** Кусок исходника от строки start до первой строки end после неё. */
function block(src: string, start: string, end = "\n};"): string {
  const a = src.indexOf(start);
  if (a < 0) throw new Error(`реестр: не нашлось «${start}»`);
  const b = src.indexOf(end, a);
  return src.slice(a, b < 0 ? undefined : b);
}

/** Записи верхнего уровня объекта с комментарием над ними: «  // …» и строка, подходящая под re (имя — первая группа). */
function commented(src: string, re: RegExp): { id: string; text: string; body: string }[] {
  const out: { id: string; text: string; body: string }[] = [];
  let notes: string[] = [];
  let cur: { id: string; text: string; body: string } | null = null;
  for (const line of src.split("\n")) {
    const c = /^ {2}\/\/ ?(.*)$/.exec(line);
    const m = re.exec(line);
    if (c) { notes.push(c[1].trim()); cur = null; continue; }
    if (m) { cur = { id: m[1], text: notes.join(" "), body: "" }; out.push(cur); notes = []; continue; }
    if (/^ {2}\S/.test(line)) cur = null;
    if (cur) cur.body += line + "\n";
    notes = [];
  }
  return out;
}

/** Кадры, длительность и повторы анимированного WebP по его кускам (RIFF/ANIM/ANMF) — без декодирования. */
export function webpInfo(b: Buffer): { w: number; h: number; frames: number; ms: number; loop: number } {
  if (b.toString("latin1", 0, 4) !== "RIFF" || b.toString("latin1", 8, 12) !== "WEBP") throw new Error("реестр: это не WebP");
  let at = 12, w = 0, h = 0, loop = 0, frames = 0, ms = 0;
  while (at + 8 <= b.length) {
    const type = b.toString("latin1", at, at + 4), n = b.readUInt32LE(at + 4), d = at + 8;
    if (type === "VP8X") { w = b.readUIntLE(d + 4, 3) + 1; h = b.readUIntLE(d + 7, 3) + 1; }
    if (type === "ANIM") loop = b.readUInt16LE(d + 4);
    if (type === "ANMF") { frames++; ms += b.readUIntLE(d + 12, 3); }
    at = d + n + (n & 1);
  }
  if (!frames) throw new Error("реестр: в WebP нет кадров");
  return { w, h, frames, ms, loop };
}

function anims() {
  const widget = read("desktop", "renderer", "widget.js");
  const fun = read("desktop", "renderer", "fun.js");
  const moods = [...block(widget, "const MOODS = [", "];").matchAll(/"(\w+)"/g)].map((m) => m[1]);
  const ids = ALBUM_CARDS.map((c) => c.id);
  if ([...moods].sort().join() !== [...ids].sort().join()) throw new Error("реестр: MOODS в widget.js ≠ альбому (web/src/album.ts)");
  // Основа — то, что возвращает baseMood() (и вторая «думает» из thinkPick); при просрочке — dueMood из fun.js.
  const base = new Set([...block(widget, "function baseMood() {", "\n}").matchAll(/"(\w+)"/g), ...widget.matchAll(/thinkPick = [^;]*/g)]
    .flatMap((m) => (m[1] ? [m[1]] : [...m[0].matchAll(/"(\w+)"/g)].map((x) => x[1]))).filter((n) => moods.includes(n)));
  const due = /const next = overdue \? "(\w+)"/.exec(fun)?.[1];
  // Эмоция ответа сервера → анимация (EMOTION_MOOD).
  const emo: Record<string, string[]> = {};
  for (const [, e, m] of block(widget, "const EMOTION_MOOD = {", "};").matchAll(/(\w+): "(\w+)"/g)) (emo[m] ??= []).push(e);
  return ALBUM_CARDS.map((c) => {
    const file = join(ROOT, "web", "public", "maid", `${c.id}.webp`);
    const site = webpInfo(readFileSync(file));
    const desk = webpInfo(readFileSync(join(ROOT, "desktop", "assets", "maid", `${c.id}.webp`)));
    const group = site.loop !== 0 ? "once" : base.has(c.id) ? "base" : "event";
    return {
      id: c.id, name: c.name, group, ...(c.id === due ? { due: true } : {}), emotions: emo[c.id] ?? [],
      frames: site.frames, ms: site.ms, w: site.w, h: site.h, bytes: statSync(file).size,
      desk: { frames: desk.frames, w: desk.w, h: desk.h },
    };
  });
}

function effects() {
  const wf = block(read("desktop", "renderer", "wordfx.js"), "const WORDFX = {");
  const wordfx = commented(wf, /^ {2}(\w+): \{$/).map((e) => ({ id: e.id, ru: /ru: "([^"]+)"/.exec(e.body)?.[1] ?? e.id, text: e.text }));
  const bfx = read("desktop", "renderer", "bubblefx.js");
  const bubble = [
    ...commented(block(bfx, "const BUBBLEFX_KINDS = {"), /^ {2}(\w+)\(run\) \{$/).map((e) => ({ id: e.id, kind: "shape", text: e.text })),
    ...commented(block(bfx, "const BUBBLEFX_MARK = {"), /^ {2}(\w+): \{$/).map((e) => ({ id: e.id, kind: "mark", text: e.text })),
  ];
  const skies = [...new Set([...block(read("server", "src", "weather.ts"), "function skyOf(", "\n}").matchAll(/"([a-z]+)"/g)].map((m) => m[1]))];
  const weather = skies.map((id) => {
    if (!SKIES[id]) throw new Error(`реестр: у неба «${id}» нет описания — допиши SKIES в tools/registry/make_registry.ts`);
    return { id, text: SKIES[id] };
  });
  // Походка букв: эмоции → шесть походок (TYPE_GAIT в widget.js), анимация и ключевые кадры — из style.css, как есть.
  const widget = read("desktop", "renderer", "widget.js"), css = read("desktop", "renderer", "style.css");
  const gaits: Record<string, string[]> = {};
  for (const [, e, g] of block(widget, "const TYPE_GAIT = {", "};").matchAll(/(\w+): "(\w+)"/g)) (gaits[g] ??= []).push(e);
  const gait = Object.entries(gaits).map(([id, emotions]) => {
    const anim = new RegExp(`data-gait="${id}"\\] \\.gw > \\.tw\\.on \\{ animation: gait-${id} ([^;]+);`).exec(css)?.[1];
    const keys = new RegExp(`@keyframes gait-${id} \\{ (.+) \\}\\n`).exec(css)?.[1];
    if (!anim || !keys) throw new Error(`реестр: в style.css нет походки «${id}»`);
    return { id, emotions, animation: anim, keyframes: keys };
  });
  // Праздники привычек — пункты «  • «Название» — …» в шапке habitparty.js.
  const head = read("desktop", "renderer", "habitparty.js").split("\n").filter((l) => l.startsWith("//"));
  const holidays: { title: string; text: string }[] = [];
  let open: { title: string; text: string } | null = null;
  for (const l of head) {
    const m = /^\/\/ {2}• «([^»]+)» — (.+)$/.exec(l);
    if (m) holidays.push((open = { title: m[1], text: m[2] }));
    else if (open && /^\/\/ {4}\S/.test(l)) open.text += " " + l.slice(2).trim();
    else open = null;
  }
  return { wordfx, bubble, weather, gait, holidays };
}

function functions() {
  const site = NAV_TABS.map((t) => ({ id: t.id, path: t.path, title: t.title, feature: `screen.${t.id}` }));
  const main = read("desktop", "src", "main.js");
  const files = [...new Set([...main.matchAll(/\.loadFile\(page\("([\w.-]+)"\)/g)].map((m) => m[1]))];
  const windows = files.map((file) => {
    const w = WINDOWS[file];
    if (!w) throw new Error(`реестр: незнакомое окно ${file} — допиши WINDOWS в tools/registry/make_registry.ts`);
    return { file, title: w.title, text: w.text, ...(w.feature ? { feature: w.feature } : {}) };
  });
  const botSrc = read("server", "src", "bot.ts").split("\n");
  const bot = botSrc.flatMap((l, i) => {
    const m = /bot\.command\("(\w+)"/.exec(l);
    if (!m) return [];
    const f = `bot.${m[1]}`;
    // Только владельцу — в первых строках обработчика проверка owner(ctx).
    const owner = botSrc.slice(i, i + 3).some((x) => x.includes("owner(ctx)"));
    return [{ cmd: m[1], title: FEATURES.find((x) => x.id === f)?.title ?? `/${m[1]}`, owner, ...(FEATURE_IDS.has(f) ? { feature: f } : {}) }];
  });
  const features = FEATURES.map((f) => ({ id: f.id, title: f.title, group: f.group, by: f.by }));
  for (const x of [...site, ...windows, ...bot]) if ("feature" in x && x.feature && !FEATURE_IDS.has(x.feature)) throw new Error(`реестр: нет фичи ${x.feature}`);
  return { site, windows, bot, features, groups: FEATURE_GROUPS };
}

/** JSON по строке на запись: массивы и объекты верхних уровней раскрыты, запись массива — одной строкой (диф читается). */
function lines(v: unknown, pad = ""): string {
  if (Array.isArray(v)) return ["[", v.map((x) => `${pad}  ${JSON.stringify(x)}`).join(",\n"), `${pad}]`].join("\n");
  if (v && typeof v === "object") {
    return ["{", Object.entries(v).map(([k, x]) => `${pad}  ${JSON.stringify(k)}: ${lines(x, pad + "  ")}`).join(",\n"), `${pad}}`].join("\n");
  }
  return JSON.stringify(v);
}

/** Текст web/src/registry.gen.ts. */
export function buildRegistry(): string {
  const data = { anims: anims(), effects: effects(), map: functions() };
  return [
    "// Создано tools/registry/make_registry.ts — руками не править: npm --workspace web run registry.",
    "// Реестр «Витрины» админки: анимации, эффекты виджета, меню сайта, окна программы, команды бота, белый список фич.",
    'import type { Registry } from "./showcase";',
    "",
    `export const REGISTRY: Registry = ${lines(data)};`,
    "",
  ].join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  writeFileSync(REGISTRY_FILE, buildRegistry());
  const files = readdirSync(join(ROOT, "web", "public", "maid")).filter((f) => f.endsWith(".webp")).length;
  console.log(`реестр записан: ${REGISTRY_FILE} (анимаций в web/public/maid: ${files})`);
}
