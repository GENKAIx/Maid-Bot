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
import { animWhen, frameStart, playerStep, secText, sizeText, usageIndex, usedCount } from "../src/showcase.ts";

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
