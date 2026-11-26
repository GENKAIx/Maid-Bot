import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { buildRegistry, REGISTRY_FILE } from "../../tools/registry/make_registry.ts";
import { FEATURE_IDS } from "../../server/src/feature-list.ts";
import { ALBUM_CARDS } from "../src/album.ts";
import { ADMIN_LIVE_STAGE, ADMIN_SECTIONS } from "../src/admin.ts";
import { NAV_TABS } from "../src/nav.ts";
import { recolorIsOwn, recolorPixels, SHOW_EYES, SHOW_HAIR } from "../src/recolor.ts";
import { REGISTRY } from "../src/registry.gen.ts";
import { FEATURES } from "../src/features.ts";
import {
  animWhen, bigViewKey, BUBBLE_SAMPLES, previewRemain, PREVIEW_SLOW, wordfxPlain, cropOf, filterCards, frameStart, HOLIDAY_PLAY, liveSet, playerStep, PREVIEW_CROPS, PREVIEW_H, PREVIEW_LIVE_MAX, PREVIEW_W,
  previewScale, secText, SHOW_EMOTIONS, SHOW_GROUPS, showcaseCards, sizeText, usageIndex, usedCount, WEATHER_SAMPLES, WORDFX_SAMPLES,
  runPlay, runRemain, runSpeed, runStarted, posterOf, preloadAll, preloadText, previewTagged, PRELOAD_PARALLEL, type PreloadState, type PreviewFile,
} from "../src/showcase.ts";

// Этап 4 админки, «Витрина»: реестр (web/src/registry.gen.ts) свеж и собран из настоящих исходников, перекраска сайта
// = look.js виджета, счёт кадров проигрывателя, числа карты функций.

test("реестр свежий: файл совпадает с тем, что собрал бы tools/registry/make_registry.ts", () => {
  const file = readFileSync(REGISTRY_FILE, "utf8").replace(/\r\n/g, "\n");
  assert.ok(file === buildRegistry(), "исходники поменялись, а реестр — нет: npm --workspace web run registry");
});

test("реестр: анимации альбома с кадрами и группами, эффекты, меню, окна, команды бота, белый список", () => {
  const r = REGISTRY;
  assert.deepEqual(r.anims.map((a) => a.id), ALBUM_CARDS.map((c) => c.id));
  assert.equal(r.anims.length, 41);
  for (const a of r.anims) {
    assert.ok(existsSync(new URL(`../public/maid/${a.id}.webp`, import.meta.url)), a.id);
    assert.ok(a.frames >= 30 && a.ms >= 2500 && a.ms <= 6000, `${a.id}: ${a.frames} кадров, ${a.ms} мс`);
    assert.equal(a.desk.frames, a.frames * 2, `${a.id}: в виджете кадров вдвое больше`);
    assert.deepEqual([a.w, a.h, a.desk.w, a.desk.h], [180, 192, 400, 427]);
  }
  const ids = (g: string) => r.anims.filter((a) => a.group === g).map((a) => a.id).sort();
  assert.deepEqual(ids("base"), ["clean", "idle", "offline", "pout", "sleep", "think", "think2"]);
  assert.deepEqual(ids("once"), ["forget"]);
  assert.deepEqual(r.anims.filter((a) => a.due).map((a) => a.id), ["angry"]);
  assert.ok(r.anims.find((a) => a.id === "think")!.emotions.includes("thinking"));

  assert.equal(r.effects.wordfx.length, 18);
  for (const w of r.effects.wordfx) assert.ok(w.ru && w.text.length > 10, w.id);
  assert.deepEqual(r.effects.bubble.map((b) => b.id), ["melt", "deflate", "heart", "bloom", "fall", "gloom", "drop"]);
  assert.deepEqual(r.effects.weather.map((w) => w.id).sort(), ["frost", "gray", "rain", "snow", "storm", "sun"]);
  assert.deepEqual(r.effects.gait.map((g) => g.id).sort(), ["happy", "neutral", "sad", "stern", "surprised", "teasing"]);
  for (const g of r.effects.gait) assert.match(g.keyframes, /^(from|\d+%) \{/, g.id);
  assert.deepEqual(r.effects.holidays.map((h) => h.title), ["Огонёк взрослеет", "Волна по отметкам", "Салют из искр"]);

  assert.deepEqual(r.map.site.map((s) => s.id), NAV_TABS.map((t) => t.id));
  assert.equal(r.map.site.length, 15);
  assert.deepEqual(r.map.windows.map((w) => w.file).sort(), ["flash.html", "index.html", "quick.html", "widget.html"]);
  // 17 + подписка (24.11.2026, billing.ts): /terms, /paysupport, /cancel_sub, /resume_sub и владельцу /answer, /signups, /refund.
  assert.equal(r.map.bot.length, 24);
  assert.deepEqual(r.map.bot.filter((b) => b.owner).map((b) => b.cmd), ["answer", "signups", "refund", "accounts", "invite", "model"]);
  assert.ok(!r.map.bot.find((b) => b.cmd === "chatid")!.feature, "у /chatid нет счётчика");
  assert.equal(r.map.features.length, FEATURE_IDS.size);
  for (const x of [...r.map.site, ...r.map.windows, ...r.map.bot]) if (x.feature) assert.ok(FEATURE_IDS.has(x.feature), x.feature);
  // В реестре нет ничего личного: только имена из кода.
  assert.doesNotMatch(readFileSync(REGISTRY_FILE, "utf8"), /chat_id|@|https?:/);
});

test("перекраска сайта = look.js виджета: таблицы и пиксели во всех 24 сочетаниях", () => {
  const src = readFileSync(new URL("../../desktop/renderer/look.js", import.meta.url), "utf8");
  const pure = src.slice(0, src.indexOf("// --- браузер ---"));
  assert.ok(pure.length > 1000, "в look.js нет метки «// --- браузер ---»");
  const look = runInNewContext(`${pure};({ LOOK_HAIR, LOOK_EYES, lookPixels })`, {}) as {
    LOOK_HAIR: unknown[]; LOOK_EYES: unknown[]; lookPixels: (rgba: Uint8ClampedArray, keep: null, h: string, e: string) => number;
  };
  assert.deepEqual(JSON.parse(JSON.stringify(SHOW_HAIR)), JSON.parse(JSON.stringify(look.LOOK_HAIR)));
  assert.deepEqual(JSON.parse(JSON.stringify(SHOW_EYES)), JSON.parse(JSON.stringify(look.LOOK_EYES)));
  // Случайные точки: половина — около тонов волос (349°) и глаз (283°), остальное — что угодно, часть прозрачная.
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const n = 6000, px = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const near = i % 3;
    const h = near === 0 ? 349 + (rnd() - 0.5) * 50 : near === 1 ? 283 + (rnd() - 0.5) * 70 : rnd() * 360;
    const s = rnd(), v = rnd();
    const c = v * s, x = c * (1 - Math.abs(((((h % 360) + 360) % 360) / 60) % 2 - 1)), m = v - c;
    const k = Math.floor(((((h % 360) + 360) % 360) / 60)) % 6;
    const [r, g, b] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][k];
    px.set([(r + m) * 255, (g + m) * 255, (b + m) * 255, rnd() < 0.1 ? 0 : 255], i * 4);
  }
  let moved = 0;
  for (const h of SHOW_HAIR) for (const e of SHOW_EYES) {
    const a = new Uint8ClampedArray(px), b = new Uint8ClampedArray(px);
    const ca = recolorPixels(a, h.id, e.id), cb = look.lookPixels(b, null, h.id, e.id);
    assert.equal(ca, cb, `${h.id}-${e.id}: поменялось точек`);
    assert.deepEqual(a, b, `${h.id}-${e.id}: точки`);
    moved += ca;
  }
  assert.ok(moved > 1000, "перекраска хоть что-то поменяла");
  assert.ok(recolorIsOwn("red", "violet") && !recolorIsOwn("gold", "violet") && !recolorIsOwn("red", "blue"));
});

test("проигрыватель: шаг кадров по длительностям, круг, один раз, долгий провал", () => {
  const d = [100, 100, 100];
  assert.deepEqual(playerStep(d, 0, 0, 50, true), { i: 0, carry: 50, end: false });
  assert.deepEqual(playerStep(d, 0, 50, 60, true), { i: 1, carry: 10, end: false });
  assert.deepEqual(playerStep(d, 2, 90, 20, true), { i: 0, carry: 10, end: false });
  assert.deepEqual(playerStep(d, 2, 90, 20, false), { i: 2, carry: 0, end: true });
  const far = playerStep(d, 0, 0, 3_000_050, true);
  assert.deepEqual(far, { i: 0, carry: 50, end: false }, "вкладка спала — без тысяч кругов");
  assert.deepEqual(playerStep([], 0, 0, 10, true), { i: 0, carry: 0, end: true });
  assert.equal(frameStart(d, 2), 200);
  assert.equal(secText(3000), "3 с");
  assert.equal(secText(5478), "5.5 с");
  assert.equal(sizeText(290_000), "283 КБ");
  assert.equal(sizeText(1_665_222), "1.6 МБ");
  const a = REGISTRY.anims;
  assert.match(animWhen(a.find((x) => x.id === "idle")!), /основа/);
  assert.match(animWhen(a.find((x) => x.id === "angry")!), /просроч/);
  assert.match(animWhen(a.find((x) => x.id === "forget")!), /один раз/);
});

test("карта функций: числа этапа 3 у пунктов, без отчёта — пусто; раздел живой", () => {
  const none = usageIndex(null);
  assert.equal(none("screen.today"), null);
  const u = usageIndex({ features: [{ id: "screen.today", all: { uses30: 12, people30: 3 } }] });
  assert.deepEqual(u("screen.today"), { uses30: 12, people30: 3 });
  assert.deepEqual(u("screen.plans"), { uses30: 0, people30: 0, missing: true }, "нет в отчёте — ноль с пометкой «нет на сервере», не «не используется»");
  assert.equal(u(undefined), null, "нет фичи — нет числа");
  assert.deepEqual(usedCount(["screen.today", "screen.plans", undefined], u), { used: 1, counted: 2 });
  assert.ok(ADMIN_LIVE_STAGE >= 4, "этап 4 живой (дальше — этап 5, Аналитика)");
  assert.ok(ADMIN_SECTIONS.find((s) => s.id === "showcase")!.stage <= ADMIN_LIVE_STAGE);
});

// ——— Живой показ (25.11.2026): карточки — все анимации и эффекты из кода виджета, у каждого показа — свой пример и вид,
// который умеет server/preview/control.js; раздел рисуется.

const DESK = (f: string) => readFileSync(new URL(`../../desktop/renderer/${f}`, import.meta.url), "utf8");
const CARDS = showcaseCards(REGISTRY, FEATURES);
const idsOf = (g: string) => CARDS.filter((c) => c.group === g || (g === "anim" && c.group.startsWith("anim-"))).map((c) => c.id);
const keysIn = (src: string, name: string) => {
  const i = src.indexOf(`const ${name} = {`);
  assert.ok(i >= 0, `нет ${name}`);
  return [...src.slice(i, src.indexOf("\n};", i)).matchAll(/^ {2}(\w+)\s*(?:\(|:)/gm)].map((m) => m[1]);
};

test("живой показ: карточки совпадают с анимациями и эффектами в коде виджета — новая не потеряется", () => {
  const moodsSrc = DESK("widget.js").match(/const MOODS = (\[[\s\S]*?\]);/)![1];
  const moods = [...moodsSrc.matchAll(/"(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual([...idsOf("anim")].sort(), [...moods].sort(), "анимации = MOODS в widget.js");
  assert.equal(idsOf("anim").length, 41);
  assert.deepEqual([...idsOf("wordfx")].sort(), keysIn(DESK("wordfx.js"), "WORDFX").sort(), "слова = WORDFX в wordfx.js");
  const bfx = DESK("bubblefx.js");
  assert.deepEqual([...idsOf("bubble")].sort(), [...keysIn(bfx, "BUBBLEFX_KINDS"), ...keysIn(bfx, "BUBBLEFX_MARK")]
    .filter((k) => !k.endsWith("Exit")).sort(), "облачко = bubblefx.js (…Exit — уход того же превращения)");
  const gaits = [...new Set([...DESK("style.css").matchAll(/#bubbleText\[data-gait="(\w+)"\]/g)].map((m) => m[1]))];
  assert.deepEqual([...idsOf("gait")].sort(), gaits.sort(), "походка = style.css");
  assert.deepEqual([...idsOf("weather")].sort(), REGISTRY.effects.weather.map((w) => w.id).sort());
  assert.deepEqual(CARDS.filter((c) => c.group === "holiday").map((c) => c.title), REGISTRY.effects.holidays.map((h) => h.title));
  assert.deepEqual(idsOf("scene"), FEATURES.map((f) => f.id));
  assert.equal(idsOf("scene").length, 12);
  const n = REGISTRY.anims.length + REGISTRY.effects.wordfx.length + REGISTRY.effects.bubble.length + REGISTRY.effects.gait.length
    + REGISTRY.effects.weather.length + REGISTRY.effects.holidays.length + FEATURES.length;
  assert.equal(CARDS.length, n);
  assert.equal(new Set(CARDS.map((c) => c.key)).size, CARDS.length, "ключи карточек разные");
  for (const g of SHOW_GROUPS) assert.ok(CARDS.some((c) => c.group === g.id), `группа ${g.id} не пустая`);
});

test("живой показ: у каждого показа — свой пример, и его умеет server/preview/control.js", () => {
  assert.deepEqual(Object.keys(WORDFX_SAMPLES).sort(), REGISTRY.effects.wordfx.map((w) => w.id).sort(), "пример у каждого слова");
  for (const w of REGISTRY.effects.wordfx) {
    const m = WORDFX_SAMPLES[w.id].match(/\[([^\]=]+)(=[^\]]+)?\]([^[]+)\[\/\]/);
    assert.ok(m, `${w.id}: нет пометки`);
    assert.equal(m[1], w.ru, `${w.id}: пометка [${w.ru}]`);
    if (w.id === "count") assert.match(m[3], /^\d+$/, "у счёта — число");
    if (w.id === "fix") assert.ok(m[2], "у правки — новое слово");
  }
  assert.deepEqual(Object.keys(BUBBLE_SAMPLES).sort(), REGISTRY.effects.bubble.map((b) => b.id).sort(), "пример у каждого облачка");
  assert.deepEqual(Object.keys(WEATHER_SAMPLES).sort(), REGISTRY.effects.weather.map((w) => w.id).sort(), "пример у каждой погоды");
  // Сцены погоды виджета (weather.js WX_SCENES, 26.11.2026) — те же, что небо сервера в реестре; показ — тем же путём, что фраза
  // (wxSay: say + сцена), и длится, пока сцена играет и угасает (WX_FX_MS + WX_FX_FADE).
  const wxFile = new URL("../../desktop/renderer/weather.js", import.meta.url);
  if (existsSync(wxFile)) { // в Docker на этапе проверок desktop/ может не быть
    const wxSrc = readFileSync(wxFile, "utf8");
    const scenes = JSON.parse(wxSrc.match(/const WX_SCENES = (\[[^\]]*\]);/)![1]) as string[];
    assert.deepEqual([...scenes].sort(), REGISTRY.effects.weather.map((w) => w.id).sort(), "сцены виджета = погоды витрины");
    const fxMs = Number(wxSrc.match(/const WX_FX_MS = ([\d_]+);/)![1].replace(/_/g, "")) + Number(wxSrc.match(/const WX_FX_FADE = (\d+);/)![1]);
    for (const c of CARDS.filter((x) => x.group === "weather")) assert.equal(c.ms, fxMs, `${c.key}: показ — вся сцена`);
  }
  for (const [id, s] of Object.entries(WEATHER_SAMPLES)) assert.ok(s.say.length > 20 && s.pose && s.emotion, `погода ${id}: фраза, поза, эмоция`);
  for (const h of REGISTRY.effects.holidays) assert.ok(HOLIDAY_PLAY[h.title], `праздник «${h.title}» — без показа`);
  const control = readFileSync(new URL("../../server/preview/control.js", import.meta.url), "utf8");
  const kinds = JSON.parse(control.match(/const PREVIEW_KINDS = (\[[^\]]*\]);/)![1]) as string[];
  for (const k of kinds) assert.match(control, new RegExp(`^ {4}${k}: `, "m"), `в control.js нет показа ${k}`);
  assert.match(control.slice(control.indexOf("    weather: (x) =>"), control.indexOf("    holiday:")), /wxSay\(wxNow\);/, "погода в показе — тем же путём, что фраза");
  for (const c of CARDS) {
    for (const m of [undefined, ...(c.moods ?? []).map((x) => x.id)]) {
      const p = c.play(m);
      assert.ok(kinds.includes(p.kind), `${c.key}: вид ${p.kind} не умеет control.js`);
      if (p.kind === "say" && m) assert.equal(p.emotion, m, `${c.key}: настроение доходит до реплики`);
    }
    assert.ok(c.ms > 0, c.key);
  }
  const server = readFileSync(new URL("../../server/src/personas.ts", import.meta.url), "utf8");
  assert.deepEqual(SHOW_EMOTIONS, JSON.parse(server.match(/export const EMOTIONS = (\[[^\]]*\])/)![1]), "настроения = эмоции сервера");
  assert.deepEqual(CARDS.find((c) => c.group === "holiday" && c.id === "flame")!.play("30"), { kind: "holiday", party: "flame", tier: 30 });
  assert.equal(CARDS.find((c) => c.key === "anim:forget")!.ms, REGISTRY.anims.find((a) => a.id === "forget")!.ms, "forget — один показ");
});

test("живой показ: поиск и фильтр, кто живой, масштаб, кадр окна", () => {
  assert.equal(filterCards(CARDS, "all", "").length, CARDS.length);
  assert.equal(filterCards(CARDS, "anim", "").length, 41);
  assert.equal(filterCards(CARDS, "wordfx", "").length, REGISTRY.effects.wordfx.length);
  assert.deepEqual(filterCards(CARDS, "all", "FORGET").map((c) => c.key), ["anim:forget"]);
  assert.equal(filterCards(CARDS, "all", "ещё").length, filterCards(CARDS, "all", "еще").length, "ё = е");
  assert.equal(filterCards(CARDS, "wordfx", "forget").length, 0, "фильтр и поиск вместе");
  assert.ok(filterCards(CARDS, "all", "метель").some((c) => c.key === "weather:storm"));
  const vis = Array.from({ length: 10 }, (_, i) => `k${i}`);
  assert.deepEqual(liveSet(vis, ["k9", "x"], "k5"), ["k5", "k9"], "играющая и недавняя видимая; сами видимые — без виджета");
  assert.deepEqual(liveSet(vis, [], null), [], "ничего не запускали — ни одного виджета (первые кадры)");
  assert.equal(liveSet(vis, vis, "k5").length, PREVIEW_LIVE_MAX);
  assert.deepEqual(liveSet(["a"], ["b"], "c"), ["c"], "играющая живёт, даже ушла с экрана; невидимая недавняя — нет");
  assert.deepEqual(liveSet([], [], null), []);
  assert.equal(previewScale(PREVIEW_W), 1);
  assert.equal(previewScale(310), 0.5);
  assert.equal(previewScale(5000, 380), 0.5, "по высоте");
  for (const c of Object.values(PREVIEW_CROPS)) assert.ok(c.x + c.w <= PREVIEW_W && c.y + c.h <= PREVIEW_H, "кадр внутри окна");
  assert.equal(cropOf("scene"), "panel");
  assert.equal(cropOf("anim-base"), "face");
});

test("живой показ: раздел рисуется — группы, карточки с кнопками и настроением; без пропуска — картинки, без iframe", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { LiveShow } = await import("../src/screens/AdminShowcase.tsx");
  const html = renderToStaticMarkup(createElement(LiveShow, { pass: "нет доступа" }));
  assert.equal((html.match(/<article class="adm-live-card/g) ?? []).length, CARDS.length);
  for (const g of SHOW_GROUPS) assert.ok(html.includes(`aria-label="${g.title}"`), g.title);
  assert.equal((html.match(/▶ играть/g) ?? []).length, CARDS.length);
  assert.equal((html.match(/🐢 медленно/g) ?? []).length, CARDS.length);
  const withMood = CARDS.filter((c) => c.moods && c.group !== "holiday").length;
  assert.equal((html.match(/aria-label="Настроение реплики"/g) ?? []).length, withMood, "настроение — у слов и походки");
  assert.equal((html.match(/aria-label="Рубеж серии"/g) ?? []).length, 1);
  assert.equal((html.match(/<img class="adm-live-poster" src="\/maid\/\w+\.webp"/g) ?? []).length, 41, "без пропуска — картинки сайта");
  assert.ok(!html.includes("<iframe"), "без пропуска виджетов нет");
  const still = CARDS.filter((c) => !c.poster).length;
  assert.equal((html.match(/<span class="adm-live-still">/g) ?? []).length, still, "у карточек без картинки — образец, а не голый id");
  assert.ok(html.includes("<mark>сегодня</mark>"), "слово с эффектом выделено");
  assert.equal((html.match(/Второй пример — «/g) ?? []).length, FEATURES.filter((f) => f.manual).length);
  assert.ok((html.match(/aria-label="Позы горничной"/g) ?? []).length >= FEATURES.length - 1, "позы сценариев");
  assert.match(html, /Живой показ недоступен: нет доступа/);
  assert.ok(html.includes('type="search"'));
});

// --- исправления этапа 10 (25.11.2026) ---

test("живой показ: «медленно» тянет конец показа, переключение посреди — конец переставляется", () => {
  assert.equal(previewRemain(9000, 0, 1), 10_500);
  assert.equal(previewRemain(9000, 0, PREVIEW_SLOW), 9000 * 4 + 1500, "вчетверо медленнее — вчетверо дольше");
  // 3 с шло обычно, потом «медленно»: осталось 6 с своего времени — 24 с реального.
  assert.equal(previewRemain(9000, 3000, PREVIEW_SLOW), 6000 * 4 + 1500);
  assert.equal(previewRemain(9000, 20_000, 1), 1500, "уже кончился — только хвост");
  assert.equal(previewRemain(9000, 0, 0), 10_500, "ноль — обычная скорость");
  const src = readFileSync(new URL("../src/screens/AdminShowcase.tsx", import.meta.url), "utf8");
  assert.match(src, /onPlay\(card, slow \? PREVIEW_SLOW : 1\)/, "карточка передаёт свою скорость");
  assert.match(src, /runRemain\(r\)/, "таймер конца — по скорости (runRemain → previewRemain)");
  assert.match(src, /if \(active\) onSpeed\(card/, "переключили посреди показа — таймер переставляется");
});

test("живой показ: клавиши большого просмотра — стрелки проигрывателя шагают по кадрам, из виджета Esc и стрелки доходят", () => {
  assert.equal(bigViewKey("Escape"), "close");
  assert.equal(bigViewKey("ArrowLeft"), "prev");
  assert.equal(bigViewKey("ArrowRight"), "next");
  assert.equal(bigViewKey("ArrowRight", { handled: true }), null, "проигрыватель уже шагнул кадром — карточка не меняется");
  assert.equal(bigViewKey("ArrowLeft", { field: true }), null, "в поле ввода — стрелки поля");
  assert.equal(bigViewKey("Escape", { field: true }), "close");
  assert.equal(bigViewKey("a"), null);
  const src = readFileSync(new URL("../src/screens/AdminShowcase.tsx", import.meta.url), "utf8");
  const player = src.slice(src.indexOf("function Player("), src.indexOf("// ——— Карта функций"));
  assert.equal((player.match(/e\.stopPropagation\(\)/g) ?? []).length, 2, "пробел и стрелки проигрывателя не всплывают");
  assert.match(src, /handled: e\.defaultPrevented/);
  assert.match(src, /e\.data\.ev === "key"/, "клавиши из iframe");
  // control.js: Esc и стрелки вне строки ввода уходят странице; в строке ввода — нет.
  const w = runControl();
  w.handlers.keydown({ key: "Escape", target: { tagName: "DIV" } });
  w.handlers.keydown({ key: "ArrowRight", target: { tagName: "IMG" } });
  w.handlers.keydown({ key: "ArrowLeft", target: { tagName: "INPUT" } });
  w.handlers.keydown({ key: "a", target: { tagName: "DIV" } });
  assert.deepEqual(w.posted.filter((m) => m.ev === "key").map((m) => m.key), ["Escape", "ArrowRight"]);
});

test("живой показ: кто живой — сначала карточки на самом экране, потом запас у края", () => {
  const near = ["a", "b", "c", "d", "e", "f", "g", "h"]; // a, b — ушли за верх в запас 200 px
  assert.deepEqual(liveSet(near, [], null, 6, ["c", "d", "e", "f", "g", "h"]), [], "на экране — первые кадры, виджеты не запускаются сами");
  assert.deepEqual(liveSet(near, ["a", "h"], "z", 4, ["g", "h"]), ["z", "h", "a"], "играющая, недавняя на экране, недавняя в запасе");
  assert.deepEqual(liveSet(near, ["a", "b", "c", "d"], null, 3, ["d"]), ["d", "a", "b"], "не больше max: сначала на экране");
});

test("живой показ: образцы карточек без картинки, второй пример и позы сценариев", () => {
  for (const c of CARDS) assert.ok(c.poster || c.still?.text, `${c.key}: ни картинки, ни образца`);
  assert.deepEqual(wordfxPlain("Сдадите [правка=никогда]завтра[/]."), { text: "Сдадите завтра.", word: "завтра" });
  assert.deepEqual(wordfxPlain("Без пометок."), { text: "Без пометок.", word: undefined });
  for (const w of REGISTRY.effects.wordfx) {
    const c = CARDS.find((x) => x.key === `wordfx:${w.id}`)!;
    assert.ok(c.still?.word && !/\[/.test(c.still.text) && c.still.text.includes(c.still.word), `${c.key}: ${JSON.stringify(c.still)}`);
  }
  const anims = new Set(REGISTRY.anims.map((a) => a.id));
  for (const f of FEATURES) {
    const c = CARDS.find((x) => x.key === `scene:${f.id}`)!;
    if (f.manual) assert.ok(c.extra?.includes(`«${f.manualTitle ?? "Вручную"}»`), `${f.id}: второй пример потерян`);
    else assert.equal(c.extra, undefined);
    assert.ok(c.poses!.every((m) => anims.has(m)), `${f.id}: позы — анимации из реестра`);
    const used = new Set([f.ai.start, ...f.ai.steps.map((x) => x.set)].map((x) => x.maid).filter(Boolean));
    assert.deepEqual(new Set(c.poses), new Set([...used].filter((m) => anims.has(m!))), `${f.id}: все позы`);
  }
  assert.ok(FEATURES.filter((f) => f.manual).length >= 5);
});

test("живой показ: сценарии в виджете — запись голоса, самонажатие и вспышка кнопки, реплика человека в чате", async () => {
  const control = readFileSync(new URL("../../server/preview/control.js", import.meta.url), "utf8");
  const fields = JSON.parse(control.match(/const PREVIEW_FIELDS = (\[[^\]]*\]);/)![1]) as string[];
  for (const f of FEATURES) {
    for (const fr of [f.ai.start, ...f.ai.steps.map((x) => x.set)]) {
      for (const k of Object.keys(fr)) assert.ok(fields.includes(k), `${f.id}: поле ${k} показ не умеет (control.js PREVIEW_FIELDS)`);
    }
  }
  const scene = async (demo: unknown) => {
    const w = runControl();
    await w.handlers.message({ source: w.parent, origin: "o", data: { maidPreview: 1, cmd: "play", play: { kind: "scene", demo } } });
    await w.flush();
    return w;
  };
  const voice = await scene(FEATURES.find((f) => f.id === "voice")!.ai);
  assert.deepEqual(voice.rec, [true, false], "волна записи включилась и выключилась");
  const days = await scene(FEATURES.find((f) => f.id === "days")!.ai);
  const ask = days.said.find((x) => x.text === "В 15:00 у вас уже «Врач».")!;
  assert.equal(ask.buttons[1].auto, 4, "«Оставить» заполняется сама");
  assert.equal(ask.buttons[0].auto, undefined);
  assert.deepEqual(days.pressed, ["0:pressed"], "нажатая кнопка вспыхнула");
  const chat = await scene({ kind: "chat", start: { maid: "idle", msgs: [] }, steps: [
    { at: 100, set: { msgs: [{ me: true, text: "🎙 Голосовое", time: "9:00" }] } },
    { at: 900, set: { msgs: [{ me: true, text: "🎙 Голосовое", time: "9:00" }, { text: "Трата: 1 240 ₽ — продукты", time: "9:00" }] } },
  ] });
  assert.deepEqual(chat.said.map((x) => [x.text, x.heard]), [["…", "🎙 Голосовое"], ["Трата: 1 240 ₽ — продукты", "🎙 Голосовое"]], "видно, на что отвечает");
  assert.deepEqual([...voice.errors, ...days.errors, ...chat.errors], []);
});

/** server/preview/control.js в песочнице: функции виджета — записывающие заглушки, таймеры — по очереди вручную. */
function runControl() {
  const handlers: Record<string, (e: unknown) => unknown> = {};
  const posted: { ev: string; key?: string }[] = [];
  const said: { text: string; heard?: string; buttons: { text: string; auto?: number }[] }[] = [];
  const rec: boolean[] = [], pressed: string[] = [], errors: string[] = [];
  let timers: { at: number; f: () => void }[] = [], clock = 0;
  const P = { k: 1, errors, data: {}, sample: () => ({}), realTimeout: () => 0, dayKey: () => "2026-11-25", dayPlus: () => "2026-11-26", speed: () => {} };
  const btn = { classList: { add: (c: string) => pressed.push(`0:${c}`) }, animate: () => ({}) };
  const ctx: Record<string, unknown> = {
    __preview: P, parent: { postMessage: (m: { ev: string }) => posted.push(m) }, location: { origin: "o" },
    document: { getElementById: () => null, querySelector: (q: string) => (q === '#bubble button[data-i="0"]' ? btn : null) },
    addEventListener: (t: string, f: (e: unknown) => unknown) => { handlers[t] = f; },
    setTimeout: (f: () => void, ms: number) => timers.push({ at: clock + ms, f }), clearTimeout: () => {},
    say: (text: string, o: { heard?: string; buttons?: { text: string; auto?: number }[] }) => said.push({ text, heard: o?.heard, buttons: o?.buttons ?? [] }),
    react: () => {}, hideBubble: () => {}, load: async () => {}, mood: "idle", data: null,
    chatInput: { value: "", dispatchEvent: () => true }, Event: class { constructor(public type: string) {} },
    chatBox: { classList: { toggle: (_c: string, on: boolean) => rec.push(on), remove: () => {} } },
    JSON, Number, String, Math, Promise, Object, Array, Set, Error,
  };
  ctx.window = ctx;
  runInNewContext(control(), ctx);
  const flush = async () => {
    for (let guard = 0; timers.length && guard < 2000; guard++) {
      timers.sort((a, b) => a.at - b.at);
      const t = timers.shift()!;
      clock = t.at;
      t.f();
      await new Promise((ok) => setImmediate(ok));
    }
  };
  return { handlers, posted, said, rec, pressed, errors, parent: ctx.parent, flush };
}
function control() { return readFileSync(new URL("../../server/preview/control.js", import.meta.url), "utf8"); }

// --- скорость «Живого показа» (26.11.2026): первые кадры с меткой, «Загрузить всё заранее» ---

test("живой показ: с пропуском и списком файлов — первые кадры с меткой, ни одного iframe, кнопка «Загрузить всё заранее»", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { LiveShow } = await import("../src/screens/AdminShowcase.tsx");
  const files: PreviewFile[] = REGISTRY.anims.map((a, i) => ({ path: `poster/${a.id}.webp`, v: i.toString(16).padStart(16, "0"), bytes: 30_000 }));
  files.push({ path: "assets/maid/idle.webp", v: "f".repeat(16), bytes: 1_665_222 });
  const html = renderToStaticMarkup(createElement(LiveShow, { pass: "ok", files }));
  const posters = [...html.matchAll(/<img class="adm-live-poster" src="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
  assert.equal(posters.length, 41);
  for (const p of posters) assert.match(p, /^\/admin-preview\/poster\/[a-z0-9-]+\.webp\?v=[0-9a-f]{16}$/);
  assert.equal(posterOf(files, "idle"), `/admin-preview/poster/idle.webp?v=${files.find((f) => f.path === "poster/idle.webp")!.v}`);
  assert.equal(posterOf(files, "nope"), null);
  assert.ok(!html.includes("<iframe"), "пока ничего не играли — виджетов нет");
  assert.match(html, /⬇ Загрузить всё заранее/);
  // Пропуск ещё ждём — ни картинок сайта, ни первых кадров (не тянуть 17 МБ анимаций сайта зря).
  const wait = renderToStaticMarkup(createElement(LiveShow, { pass: "" }));
  assert.equal((wait.match(/adm-live-poster/g) ?? []).length, 0);
  assert.ok(!wait.includes("Загрузить всё заранее"));
});

test("живой показ: «Загрузить всё заранее» — по 4 сразу, прогресс «N из M, X МБ», отмена останавливает новые", async () => {
  const files: PreviewFile[] = Array.from({ length: 10 }, (_, i) => ({ path: `assets/maid/a${i}.webp`, v: String(i).padStart(16, "0"), bytes: 1048576 * (i + 1) }));
  let now = 0, peak = 0;
  const asked: string[] = [];
  const get = async (url: string, signal?: AbortSignal) => {
    asked.push(url);
    now++;
    peak = Math.max(peak, now);
    await new Promise((ok) => setTimeout(ok, 5));
    now--;
    if (signal?.aborted) throw new Error("отменено");
    if (url.includes("a3.webp")) throw new Error("HTTP 500");
  };
  const seen: PreloadState[] = [];
  const end = await preloadAll(files, get, { onProgress: (x) => seen.push(x) });
  assert.equal(PRELOAD_PARALLEL, 4);
  assert.equal(peak, 4, "по четыре сразу");
  assert.deepEqual(asked.sort(), files.map(previewTagged).sort(), "все адреса — с меткой");
  assert.equal(end.done, 9);
  assert.equal(end.failed, 1);
  assert.equal(end.total, 10);
  assert.equal(end.bytes, 1048576 * (55 - 4));
  assert.equal(seen.length, 10);
  assert.deepEqual(seen.map((x) => x.done + x.failed), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "прогресс растёт по одному");
  assert.equal(preloadText({ done: 3, total: 10, bytes: 1048576 * 6, totalBytes: 1048576 * 55, failed: 0 }), "3 из 10, 6.0 из 55.0 МБ");
  // Отмена посреди: в работе были 4, новых не начинается, итог — stopped.
  const ctl = new AbortController();
  let started = 0;
  const stopped = await preloadAll(files, async (u, sig) => { if (++started === 2) ctl.abort(); await get(u, sig); }, { signal: ctl.signal, parallel: 2 });
  assert.equal(stopped.stopped, true);
  assert.equal(started, 2, "после отмены новых нет");
  assert.ok(stopped.done < files.length);
  assert.equal((await preloadAll([], get)).total, 0, "пустой список — сразу итог");
});

// --- исправление этапа 12 (26.11.2026): конец показа считается с запуска виджета, а не с нажатия «играть» ---

test("живой показ: виджет грузится дольше ms+1,5 с — play всё равно уходит, показ идёт целиком", () => {
  const ms = 2500, load = 5000; // загрузка дольше previewRemain(ms, 0, 1) = 4000
  let r = runPlay("anim:a", ms, 1);
  assert.equal(runRemain(r), null, "виджет ещё не готов — таймер конца не ставится, карточка остаётся играющей");
  // Пока грузится, переключили «медленно» — своё время не копится, только скорость.
  r = runSpeed(r, "anim:a", PREVIEW_SLOW, 1000);
  assert.deepEqual([r!.done, r!.at, r!.k], [0, null, PREVIEW_SLOW]);
  r = runSpeed(r, "anim:a", 1, 2000);
  assert.equal(runRemain(r), null);
  assert.equal(runStarted(r, "anim:b", load), r, "чужая карточка показ не запускает");
  // ready через 5 с, play ушёл: конец — через весь показ и хвост от этой минуты, а не от нажатия.
  r = runStarted(r, "anim:a", load);
  assert.equal(runRemain(r), ms + 1500);
  // Через 1 с показа — «медленно»: осталось 1,5 с своего времени вчетверо дольше.
  r = runSpeed(r, "anim:a", PREVIEW_SLOW, load + 1000);
  assert.equal(runRemain(r), 1500 * 4 + 1500);
  // «Ещё раз»: снова ждём, пока виджет примет play (живой — сразу), отсчёт с нуля.
  r = runStarted(runPlay("anim:a", ms, 1), "anim:a", 9000);
  assert.deepEqual([r!.done, r!.at, runRemain(r)], [0, 9000, ms + 1500]);
  const src = readFileSync(new URL("../src/screens/AdminShowcase.tsx", import.meta.url), "utf8");
  assert.match(src, /run\.current = runPlay\(c\.key, c\.ms, k\)/, "«играть» — показ ждёт запуска виджета");
  assert.match(src, /send\(\{ cmd: "play", play: order\.play \}\); startedTo\.current\?\.\(\);/, "play ушёл — WidgetFrame сообщает наверх");
  assert.match(src, /onStarted=\{\(\) => onStarted\(card\)\}/, "карточка передаёт запуск в LiveShow");
  assert.match(src, /runStarted\(run\.current, c\.key, performance\.now\(\)\)/, "конец — от запуска");
  assert.doesNotMatch(src, /at: performance\.now\(\), k \}/, "отсчёта от нажатия больше нет");
});
