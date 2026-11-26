import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { createApi } from "../src/api.ts";
import { hashPassword } from "../src/auth.ts";
import { config } from "../src/config.ts";
import { Store } from "../src/db.ts";
import { Pipeline } from "../src/pipeline.ts";
import { PREVIEW_COOKIE, PREVIEW_CSP, PREVIEW_IMMUTABLE, PREVIEW_MEDIA, PREVIEW_REVALIDATE, PreviewFiles, PreviewPasses, previewFile, previewHtml, previewKey, servePreview, webpFirstFrame } from "../src/preview.ts";

// Живой показ виджета в «Витрине» админки (25.11.2026, server/src/preview.ts): файлы desktop/renderer и assets — только админу
// с подтверждённым входом в админку (пропуск в cookie), выйти из папки нельзя; заглушка window.maid (server/preview/stub.js)
// покрывает всё, что зовут скрипты виджета, и ничего не шлёт на сервер.

const OWNER = "1001", FRIEND = "2002";
const DESK = new URL("../../desktop/", import.meta.url);
const STUB = readFileSync(new URL("../preview/stub.js", import.meta.url), "utf8");

async function stand() {
  config.allowedChatIds.splice(0, Infinity, OWNER, FRIEND);
  config.adminChatIds.splice(0, Infinity);
  config.desktopToken = "desk-test-key";
  const store = await Store.open(":memory:");
  await store.createUser({ login: "owner", passwordHash: await hashPassword("owner-pass-1"), tz: "Europe/Moscow", chatId: OWNER, name: "Хозяин" });
  await store.createUser({ login: "friend", passwordHash: await hashPassword("friend-pass-1"), tz: "Europe/Moscow", chatId: FRIEND });
  const codes: string[] = [];
  const server = createApi({ store, pipeline: new Pipeline(store, async () => "{}"), adminCode: async (_u, text) => void codes.push(text.match(/\d{6}/)![0]) }).listen(0);
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const call = async (p: string, token: string, body?: unknown) => {
    const r = await fetch(base + p, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, cookie: r.headers.get("set-cookie") ?? "", body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  };
  const login = async (l: string, pw: string) => (await (await fetch(base + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: l, password: pw }) })).json()).token as string;
  // Запрос как есть, без разбора пути клиентом (fetch сам схлопнул бы «..»).
  const raw = (p: string, cookie = "", method = "GET", extra: Record<string, string> = {}) => new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((ok, fail) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method, headers: { ...(cookie ? { cookie } : {}), ...extra } }, (res) => {
      const parts: Buffer[] = [];
      res.on("data", (c) => parts.push(c));
      res.on("end", () => ok({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts) }));
    });
    req.on("error", fail);
    req.end();
  });
  const enter = async (token: string) => {
    await call("/api/admin/code", token, {});
    assert.equal((await call("/api/admin/confirm", token, { code: codes.at(-1) })).status, 200);
  };
  return { store, call, login, raw, enter, close: async () => { server.close(); await store.close(); } };
}

const cookieOf = (setCookie: string) => setCookie.split(";")[0];

test("живой показ: файлы виджета — только админу с подтверждённым входом; без пропуска 401, наружу из папки — 404", async () => {
  const s = await stand();
  try {
    const owner = await s.login("owner", "owner-pass-1");
    const friend = await s.login("friend", "friend-pass-1");
    const page = "/admin-preview/renderer/widget.html";
    assert.equal((await s.raw(page)).status, 401, "без входа");
    assert.equal((await s.raw(page, `${PREVIEW_COOKIE}=${"ab".repeat(24)}`)).status, 401, "выдуманный пропуск");
    assert.equal((await s.raw("/admin-preview/assets/star.png")).status, 401, "картинки — тоже по пропуску");
    // Пропуск выдаёт только /api/admin/*: не админу — как будто адреса нет, админу без кода — 403.
    assert.equal((await s.call("/api/admin/preview", friend, {})).status, 404);
    assert.equal((await s.call("/api/admin/preview", "desk-test-key", {})).status, 404, "ключ ПК — не админ");
    assert.equal((await s.call("/api/admin/preview", owner, {})).status, 403);
    await s.enter(owner);
    const got = await s.call("/api/admin/preview", owner, {});
    assert.equal(got.status, 200);
    assert.match(got.cookie, new RegExp(`^${PREVIEW_COOKIE}=[0-9a-f]{48}; Path=/admin-preview/; Max-Age=\\d+; HttpOnly; SameSite=Strict$`));
    const cookie = cookieOf(got.cookie);
    const again = await s.call("/api/admin/preview", owner, {});
    assert.equal(cookieOf(again.cookie), cookie, "та же сессия — тот же пропуск (картинки из кэша)");

    const html = await s.raw(page, cookie);
    assert.equal(html.status, 200);
    assert.equal(html.headers["content-security-policy"], PREVIEW_CSP);
    assert.match(PREVIEW_CSP, /frame-ancestors 'self'/);
    assert.equal(html.headers["cache-control"], PREVIEW_REVALIDATE, "страница — каждый раз проверять (ETag, 304)");
    const text = html.body.toString("utf8");
    const at = (name: string) => text.search(new RegExp(`src="/admin-preview/${name.replace(/[./]/g, "\\$&")}\\?v=[0-9a-f]{16}"`));
    assert.ok(at("preview/stub.js") >= 0 && at("preview/stub.js") < at("renderer/common.js"), "заглушка — первым скриптом");
    assert.ok(at("preview/control.js") > at("renderer/tails.js"), "управление — последним");
    for (const [p, type] of [["/admin-preview/renderer/widget.js", "text/javascript"], ["/admin-preview/renderer/style.css", "text/css"],
      ["/admin-preview/assets/star.png", "image/png"], ["/admin-preview/preview/stub.js", "text/javascript"], ["/admin-preview/preview/control.js", "text/javascript"]] as const) {
      const r = await s.raw(p, cookie);
      assert.equal(r.status, 200, p);
      assert.ok(String(r.headers["content-type"]).startsWith(type), `${p}: ${r.headers["content-type"]}`);
      assert.equal(r.headers["x-content-type-options"], "nosniff");
    }
    // Наружу — никак: «..» в любом виде, чужие папки программы, не те расширения, не GET.
    for (const p of [
      "/admin-preview/renderer/..%2f..%2fserver%2fsrc%2fconfig.ts", "/admin-preview/assets/maid/..%2f..%2f..%2fpackage.json",
      "/admin-preview/renderer/%2e%2e/%2e%2e/package.json", "/admin-preview/renderer/../../package.json", "/admin-preview/renderer/..\\..\\package.json",
      "/admin-preview/src/main.js", "/admin-preview/src/preload.js", "/admin-preview/renderer/index.html", "/admin-preview/renderer/nope.js",
      "/admin-preview/assets/maid-keep/idle.webp", "/admin-preview/preview/../src/api.ts", "/admin-preview/preview/%2e%2e%2fsrc%2fapi.ts",
      "/admin-preview/renderer/%E0%A4%A", "/admin-preview/../.env", "/admin-preview/renderer/widget.js%00.png",
    ]) {
      const r = await s.raw(p, cookie);
      assert.ok(r.status === 404, `${p}: ${r.status}`);
      assert.ok(!/DATABASE_URL|"name": "maid|createApi/.test(r.body.toString("utf8")), `${p}: отдал чужой файл`);
    }
    assert.equal((await s.raw(page, cookie, "POST")).status, 404, "только GET");
    // Чужой браузер с тем же пропуском, но вход в админку кончился (вышел) — 401; выдача пропуска — одна строка журнала.
    const log = (await s.call("/api/admin/log", owner)).body as unknown as { action: string; reason: string }[];
    assert.equal(log.filter((r) => r.action === "preview").length, 1, "второй раз — тот же пропуск, без новой строки");
    assert.ok(log.find((r) => r.action === "preview")!.reason, "с причиной");
    await s.call("/api/admin/leave", owner, {});
    assert.equal((await s.raw(page, cookie)).status, 401, "вышел из админки — пропуск не действует");
    // Новый вход, пропуск, потом выход из сайта — тоже 401.
    await s.enter(owner);
    const second = cookieOf((await s.call("/api/admin/preview", owner, {})).cookie);
    assert.notEqual(second, cookie);
    assert.equal((await s.raw(page, second)).status, 200);
    await s.call("/api/logout", owner, {});
    assert.equal((await s.raw(page, second)).status, 401, "вышел из сайта — пропуск не действует");
  } finally {
    await s.close();
  }
});

test("живой показ: кэш — адрес с меткой immutable и private, без пропуска 401, чужая метка — без immutable, ETag и 304", async () => {
  const s = await stand();
  try {
    const owner = await s.login("owner", "owner-pass-1");
    await s.enter(owner);
    const cookie = cookieOf((await s.call("/api/admin/preview", owner, {})).cookie);
    assert.equal((await s.raw("/admin-preview/files.json")).status, 401, "список файлов — тоже по пропуску");
    const list = await s.raw("/admin-preview/files.json", cookie);
    assert.equal(list.status, 200);
    assert.equal(list.headers["cache-control"], PREVIEW_REVALIDATE);
    const files = JSON.parse(list.body.toString("utf8")).files as { path: string; v: string; bytes: number }[];
    for (const f of files) {
      assert.match(f.v, /^[0-9a-f]{16}$/, f.path);
      assert.ok(previewFile(f.path), `в списке только белый список: ${f.path}`);
    }
    assert.ok(!files.some((f) => f.path.endsWith(".html")), "страницы в списке нет (она — без метки)");
    const star = files.find((f) => f.path === "assets/star.png")!;
    const tagged = `/admin-preview/assets/star.png?v=${star.v}`;
    const r = await s.raw(tagged, cookie);
    assert.equal(r.status, 200);
    assert.equal(r.headers["cache-control"], PREVIEW_IMMUTABLE);
    assert.match(PREVIEW_IMMUTABLE, /^private, max-age=31536000, immutable$/, "только кэш браузера, не общие прокси");
    assert.equal(r.headers.etag, `"${star.v}"`);
    assert.equal(r.body.length, star.bytes);
    // Метка не открывает дверь: без пропуска и с выдуманным — 401.
    assert.equal((await s.raw(tagged)).status, 401);
    assert.equal((await s.raw(tagged, `${PREVIEW_COOKIE}=${"ab".repeat(24)}`)).status, 401);
    // Чужая (старая) метка — тот же файл, но «каждый раз проверять»; без метки — как раньше.
    const wrong = await s.raw(`/admin-preview/assets/star.png?v=${"0".repeat(16)}`, cookie);
    assert.equal(wrong.status, 200);
    assert.equal(wrong.headers["cache-control"], PREVIEW_REVALIDATE, "чужая метка — не immutable");
    assert.equal((await s.raw("/admin-preview/assets/star.png", cookie)).headers["cache-control"], PREVIEW_MEDIA);
    assert.equal((await s.raw("/admin-preview/renderer/widget.js", cookie)).headers["cache-control"], PREVIEW_REVALIDATE);
    const js = files.find((f) => f.path === "renderer/widget.js")!;
    assert.equal((await s.raw(`/admin-preview/renderer/widget.js?v=${js.v}`, cookie)).headers["cache-control"], PREVIEW_IMMUTABLE);
    // ETag и 304: файл, стиль (собранный с метками), страница, список.
    for (const p of [tagged, "/admin-preview/renderer/widget.js", "/admin-preview/renderer/style.css", "/admin-preview/renderer/widget.html", "/admin-preview/files.json"]) {
      const first = await s.raw(p, cookie);
      const etag = String(first.headers.etag ?? "");
      assert.match(etag, /^"[0-9a-f]{16}"$/, p);
      const again = await s.raw(p, cookie, "GET", { "if-none-match": etag });
      assert.equal(again.status, 304, p);
      assert.equal(again.body.length, 0, p);
      assert.equal(again.headers["cache-control"], first.headers["cache-control"], p);
      assert.equal((await s.raw(p, cookie, "GET", { "if-none-match": '"0000000000000000"' })).status, 200, `${p}: чужой ETag — целиком`);
      assert.equal((await s.raw(p, "", "GET", { "if-none-match": etag })).status, 401, `${p}: без пропуска и 304 нет`);
    }
    // Страница: все свои ссылки — с меткой, и список «путь → метка» для заглушки (JSON, не скрипт).
    const page = (await s.raw("/admin-preview/renderer/widget.html", cookie)).body.toString("utf8");
    const links = [...page.matchAll(/\s(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(links.length >= 25);
    for (const l of links) assert.match(l, /^\/admin-preview\/[\w/.-]+\?v=[0-9a-f]{16}$/, `ссылка без метки: ${l}`);
    const json = page.match(/<script type="application\/json" id="preview-files">([^<]*)<\/script>/);
    assert.ok(json, "список меток в странице");
    assert.equal(JSON.parse(json![1])["assets/star.png"], star.v);
    assert.ok(page.indexOf('id="preview-files"') < page.indexOf("preview/stub.js"), "список — до заглушки");
    // Стиль — с метками шрифтов (если шрифты есть в папке).
    const css = (await s.raw("/admin-preview/renderer/style.css", cookie)).body.toString("utf8");
    if (existsSync(new URL("assets/fonts/", DESK))) assert.match(css, /url\(\/admin-preview\/assets\/fonts\/[\w-]+\.woff2\?v=[0-9a-f]{16}\)/);
    // Вне белого списка — 404 и с меткой.
    for (const p of [`/admin-preview/src/main.js?v=${star.v}`, `/admin-preview/assets/maid-keep/idle.webp?v=${star.v}`, `/admin-preview/poster/..%2fstar.png?v=${star.v}`,
      "/admin-preview/poster/nope.webp", "/admin-preview/renderer/index.html?v=0", "/admin-preview/files.json/x"]) {
      assert.equal((await s.raw(p, cookie)).status, 404, p);
    }
  } finally {
    await s.close();
  }
});

/** Заглушка с «окном» в песочнице: картинки и звуки записывают, какой адрес им поставили. */
function runStubDom(files: Record<string, string>) {
  const loads: string[] = [];
  class HTMLImageElement { isConnected = false; _src = ""; declare src: string; }
  Object.defineProperty(HTMLImageElement.prototype, "src", { configurable: true, enumerable: true, get(this: HTMLImageElement) { return this._src; },
    set(this: HTMLImageElement, v: string) { this._src = v; loads.push(v); } });
  class Audio { src: string; constructor(src?: string) { this.src = src ?? ""; if (src) loads.push(src); } }
  const ctx: Record<string, unknown> = {
    setTimeout, setInterval: () => 0, clearTimeout, clearInterval, requestAnimationFrame: () => 0, addEventListener: () => {},
    performance: { now: () => 1000 }, Object, JSON, Map, Number, String, Math, Promise, Error, URL, Date: class extends Date {},
    document: { getAnimations: () => [], getElementById: (id: string) => (id === "preview-files" ? { textContent: JSON.stringify(files) } : null) },
    location: { href: "http://maid.test/admin-preview/renderer/widget.html", origin: "http://maid.test" },
    HTMLImageElement, Audio, Image: function Image() { return new HTMLImageElement(); },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(STUB, ctx);
  return { ctx, loads, img: (on: boolean) => Object.assign(new HTMLImageElement(), { isConnected: on }) };
}

test("заглушка: карточка тянет только свою анимацию — предзагрузка всех 41 пропущена, адреса картинок и звуков — с меткой", { skip: existsSync(new URL("renderer/widget.js", DESK)) ? false : "нет desktop/" }, () => {
  const widget = readFileSync(new URL("renderer/widget.js", DESK), "utf8");
  const pre = widget.match(/const MOODS = \[[\s\S]*?\];\r?\nfor \(const n of MOODS\) new Image\(\)\.src = `[^`]+`;/);
  assert.ok(pre, "в widget.js нет предзагрузки MOODS той же формы — проверить заглушку");
  const moods = JSON.parse(pre![0].match(/\[[\s\S]*?\]/)![0].replace(/\s+/g, " ")) as string[];
  assert.equal(moods.length, 41);
  const files: Record<string, string> = { "assets/sounds/pop.wav": "a".repeat(16) };
  moods.forEach((n, i) => { files[`assets/maid/${n}.webp`] = i.toString(16).padStart(16, "0"); });
  const w = runStubDom(files);
  // Настоящая строка предзагрузки из widget.js — в песочнице: ни одного запроса анимаций.
  vm.runInContext(pre![0], w.ctx);
  assert.deepEqual(w.loads, [], "предзагрузка 41 анимации в показе не грузит ничего");
  assert.equal((w.ctx.__preview as { lazy: string[] }).lazy.length, 41);
  // Фигурка на странице: её анимация — с меткой (из кэша браузера), forget со своей меткой времени — тоже.
  const face = w.img(true);
  face.src = "../assets/maid/angry.webp";
  assert.deepEqual(w.loads, [`http://maid.test/admin-preview/assets/maid/angry.webp?v=${files["assets/maid/angry.webp"]}`]);
  face.src = "../assets/maid/forget.webp?1700000000000";
  assert.match(w.loads[1], new RegExp(`/assets/maid/forget\\.webp\\?1700000000000=&v=${files["assets/maid/forget.webp"]}$`));
  // Звук — с меткой; чужой файл и blob: — как есть; уже с меткой — не трогать.
  vm.runInContext('new Audio("../assets/sounds/pop.wav")', w.ctx);
  assert.equal(w.loads[2], `http://maid.test/admin-preview/assets/sounds/pop.wav?v=${"a".repeat(16)}`);
  face.src = "blob:http://maid.test/1";
  face.src = "../assets/maid/nope.webp";
  face.src = "/admin-preview/assets/maid/idle.webp?v=0123";
  assert.deepEqual(w.loads.slice(3), ["blob:http://maid.test/1", "../assets/maid/nope.webp", "/admin-preview/assets/maid/idle.webp?v=0123"]);
  assert.equal(w.loads.filter((u) => /\/assets\/maid\/(?!nope)/.test(u)).length, 3, "анимаций — только показанные: angry, forget и idle разметки");
});

test("кадр-превью: у каждой анимации — неподвижный первый кадр WebP, 20–60 КБ; испорченный файл — null", { skip: existsSync(new URL("assets/maid/idle.webp", DESK)) ? false : "нет desktop/assets/maid" }, async () => {
  const dir = new URL("assets/maid/", DESK);
  const names = (await import("node:fs")).readdirSync(dir).filter((n) => n.endsWith(".webp"));
  assert.ok(names.length >= 41, `анимаций: ${names.length}`);
  const files = new PreviewFiles();
  const list = await files.list();
  for (const n of names) {
    const anim = readFileSync(new URL(n, dir));
    const e = await files.entry(`poster/${n}`);
    assert.ok(e?.body, `нет превью у ${n}`);
    const b = e!.body!;
    assert.equal(b.toString("latin1", 0, 4), "RIFF");
    assert.equal(b.readUInt32LE(4), b.length - 8, `${n}: размер RIFF`);
    assert.equal(b.toString("latin1", 8, 16), "WEBPVP8X");
    assert.equal((b.toString("latin1").match(/ANMF/g) ?? []).length, 1, `${n}: один кадр`);
    assert.ok(b.length >= 10_000 && b.length <= 60_000, `${n}: ${b.length} байт`);
    assert.ok(b.length * 20 < anim.length, `${n}: превью много меньше анимации`);
    assert.ok(list.some((f) => f.path === `poster/${n}` && f.bytes === b.length), `${n}: превью в списке files.json`);
  }
  assert.equal(webpFirstFrame(Buffer.from("not a webp at all, really")), null);
  const still = Buffer.concat([Buffer.from("RIFF"), Buffer.from([12, 0, 0, 0]), Buffer.from("WEBPVP8L"), Buffer.from([0, 0, 0, 0])]);
  assert.equal(webpFirstFrame(still), still, "неподвижный WebP — как есть");
  const cut = readFileSync(new URL("idle.webp", dir)).subarray(0, 200);
  assert.equal(webpFirstFrame(Buffer.from(cut)), null, "оборванный файл — null");
});

test("живой показ: белый список путей, вставка скриптов, пропуски по сроку", () => {
  for (const ok of ["renderer/widget.html", "renderer/wordfx.js", "renderer/bubblefx.css", "assets/maid/idle.webp", "assets/inbox/mail.png",
    "assets/fonts/onest-latin-wght-normal.woff2", "assets/sounds/pop.wav", "assets/star.png", "preview/stub.js", "preview/control.js"]) {
    assert.ok(previewFile(ok), ok);
  }
  for (const bad of ["renderer/../src/main.js", "renderer/a.b.js", "renderer/index.html", "renderer/flash.html", "assets/maid/../../x.webp",
    "preview/../src/api.ts", "preview/other.js", "src/preload.js", "assets/icon.png", "renderer/WIDGET.js", "renderer/widget.js/", "/renderer/widget.js", ""]) {
    assert.equal(previewFile(bad), null, bad);
  }
  const html = previewHtml('<head></head><body>\n  <script src="common.js"></script>\n  <script src="tails.js"></script>\n</body>');
  assert.match(html, /<script src="\.\.\/preview\/stub\.js"><\/script>\s*<script src="common\.js">/);
  assert.match(html, /tails\.js"><\/script>\s*<script src="\.\.\/preview\/control\.js"><\/script>\s*<\/body>/);
  assert.throws(() => previewHtml("<body></body>"), /другой формы/);
  assert.equal(previewKey(`a=1; ${PREVIEW_COOKIE}=${"0".repeat(48)}; b=2`), "0".repeat(48));
  assert.equal(previewKey(`${PREVIEW_COOKIE}=../../x`), "");
  assert.equal(previewKey(undefined), "");
  const passes = new PreviewPasses();
  const t0 = Date.now();
  const a = passes.issue("h1", new Date(t0 + 60_000), t0);
  assert.equal(passes.check(a.key, t0 + 1000), "h1");
  assert.equal(passes.check(a.key, t0 + 61_000), null, "срок вышел");
  assert.equal(passes.check("", t0), null);
  const b = passes.issue("h2", new Date(t0 + 60_000), t0);
  passes.drop("h2");
  assert.equal(passes.check(b.key, t0), null, "выход — пропуск забыт");
});

// --- заглушка window.maid: все методы preload.js и всё, что зовут скрипты widget.html ---

/** Текст скрипта без комментариев (строчных — с начала строки или после пробела — и блочных): упоминание в комментарии — не вызов. */
const noComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
/** Обращения к window.maid в коде: maid.X, maid.X?.(…), maid.look.Y. Перед «maid» — не буква, не точка и не кавычка: имена
 *  счётчиков и ключей хранилища («maid.react.…», "maid.tour") — строки, а не вызовы. */
function maidUses(src: string): Set<string> {
  const used = new Set<string>();
  const code = noComments(src).replace(/window\.maid/g, " maid");
  for (const m of code.matchAll(/(?<![\w$."'`/-])maid\.(\w+)(?:\?\.)?(?:\.?(\w+))?/g)) used.add(m[1] === "look" && m[2] ? `look.${m[2]}` : m[1]);
  // Ссылка на maid.look под своим именем (maidlook.js: const store = maid.look) — её методы тоже.
  for (const [, alias] of code.matchAll(/(?:const|let)\s+(\w+)\s*=\s*maid\.look\s*;/g)) {
    for (const m of code.matchAll(new RegExp(String.raw`(?<![\w$.])${alias}\.(\w+)\(`, "g"))) used.add(`look.${m[1]}`);
  }
  return used;
}

function runStub() {
  const ctx: Record<string, unknown> = {
    setTimeout, setInterval: () => 0, clearTimeout, clearInterval, requestAnimationFrame: () => 0, addEventListener: () => {},
    performance: { now: () => 1000 }, document: { getAnimations: () => [] }, Object, JSON, Map, Number, String, Math, Promise, Error,
    Date: class extends Date {}, // своя копия: заглушка подменяет Date.now
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(STUB, ctx);
  return ctx as { maid: Record<string, unknown> & { look: Record<string, unknown>; api: (m: string, p: string, b?: unknown) => Promise<unknown> }; localStorage: Storage; __preview: { speed: (k: number) => void; k: number } };
}

test("заглушка: все методы preload.js программы и всё, что зовут скрипты виджета; ответы — из памяти", { skip: existsSync(new URL("renderer/widget.html", DESK)) ? false : "нет desktop/" }, async () => {
  const w = runStub();
  const preload = readFileSync(new URL("src/preload.js", DESK), "utf8");
  const top = [...preload.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]);
  const look = [...preload.slice(preload.indexOf("look: {"), preload.indexOf("},", preload.indexOf("look: {"))).matchAll(/^ {4}(\w+):/gm)].map((m) => m[1]);
  assert.ok(top.length >= 30 && top.includes("api") && top.includes("on") && look.length === 4, `preload: ${top.length} методов, look ${look.length}`);
  for (const k of top) assert.ok(k in w.maid, `в заглушке нет maid.${k} (есть в preload.js)`);
  for (const k of look) assert.equal(typeof w.maid.look[k], "function", `maid.look.${k}`);
  // Скрипты страницы — по порядку из widget.html; каждый вызов maid.X(…) / maid.X?.(…) / maid.look.Y.
  const html = readFileSync(new URL("renderer/widget.html", DESK), "utf8");
  const files = [...html.matchAll(/<script src="([\w-]+\.js)"/g)].map((m) => m[1]);
  assert.ok(files.length >= 20 && files.includes("widget.js"), `скриптов: ${files.length}`);
  const used = new Set<string>();
  for (const f of files) for (const k of maidUses(readFileSync(new URL(`renderer/${f}`, DESK), "utf8"))) used.add(k);
  assert.ok(used.has("api") && used.has("track") && used.has("look.asset") && used.size >= 25, `вызовов: ${[...used].join(", ")}`);
  for (const k of used) {
    const [a, b] = k.split(".");
    assert.ok(b ? typeof w.maid.look[b] === "function" : a in w.maid, `скрипты виджета зовут maid.${k} — в заглушке его нет`);
  }
  // Данные дня той же формы, что /api/today; запись — ответ «ничего не записывается»; без fetch и XMLHttpRequest в контексте — значит, без сети.
  const today = (await w.maid.api("GET", "/api/today")) as Record<string, unknown>;
  for (const k of ["day", "tasks", "habits", "events", "upcoming", "dates", "done_today", "xp"]) assert.ok(k in today, `today.${k}`);
  const plain = async (x: Promise<unknown>) => JSON.parse(JSON.stringify(await x)); // объекты из другого контекста vm
  assert.deepEqual(await plain(w.maid.api("GET", "/api/notices?after=0")), []);
  assert.deepEqual(await plain(w.maid.api("GET", "/api/weather")), { weather: null });
  assert.match(String(((await w.maid.api("POST", "/api/input", { text: "купить хлеб" })) as { text: string }).text), /ничего не записывается/);
  assert.ok(!/\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource/.test(noComments(STUB)), "заглушка не ходит в сеть");
  // localStorage — свой, в памяти: экскурсия первого запуска уже пройдена.
  assert.equal(w.localStorage.getItem("maid.tour"), "1");
  w.localStorage.setItem("x", "1");
  assert.equal(w.localStorage.getItem("x"), "1");
  w.__preview.speed(0.25);
  assert.equal(w.__preview.k, 0.25);
  w.__preview.speed(0);
  assert.equal(w.__preview.k, 1, "ноль и мусор — обычная скорость");
  // Date.now в показе тоже замедляется (праздники привычек считают по нему): за 400 мс вчетверо медленнее — около 100 мс.
  const D = (w as unknown as { Date: DateConstructor }).Date;
  w.__preview.speed(0.25);
  const d0 = D.now(), r0 = Date.now();
  await new Promise((ok) => setTimeout(ok, 400));
  const dv = D.now() - d0, dr = Date.now() - r0;
  assert.ok(dv >= dr * 0.2 && dv <= dr * 0.3 + 5, `медленно: ${dv} мс показа за ${dr} мс`);
  w.__preview.speed(1);
  const d1 = D.now(), r1 = Date.now();
  await new Promise((ok) => setTimeout(ok, 200));
  assert.ok(Math.abs((D.now() - d1) - (Date.now() - r1)) <= 5, "обычная скорость — как настоящие часы, без скачка");
});

test("живой показ: оборванный посреди картинки ответ не держит файл — отдача кончается, следующий запрос — целиком", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "maid-preview-"));
  mkdirSync(path.join(dir, "assets", "maid"), { recursive: true });
  const big = Buffer.alloc(8 * 1024 * 1024, 7);
  writeFileSync(path.join(dir, "assets", "maid", "idle.webp"), big);
  const done: Promise<boolean>[] = [];
  const server = http.createServer((req, res) => { done.push(servePreview("assets/maid/idle.webp", res, new PreviewFiles(dir))); }).listen(0);
  const port = (server.address() as AddressInfo).port;
  try {
    // Клиент берёт первый кусок и бросает запрос (витрина сняла iframe посреди загрузки).
    await new Promise<void>((ok, fail) => {
      const req = http.get({ host: "127.0.0.1", port, path: "/" }, (res) => res.once("data", () => { req.destroy(); ok(); }));
      req.on("error", (e) => ((e as NodeJS.ErrnoException).code === "ECONNRESET" ? ok() : fail(e)));
    });
    const settled = await Promise.race([done[0].then(() => "кончилась"), new Promise((ok) => setTimeout(() => ok("висит"), 3000))]);
    assert.equal(settled, "кончилась", "отдача оборванного ответа завершилась (поток файла закрыт)");
    // Обычный запрос после обрыва — весь файл.
    const got = await new Promise<number>((ok, fail) => http.get({ host: "127.0.0.1", port, path: "/" }, (res) => {
      let n = 0;
      res.on("data", (c: Buffer) => { n += c.length; });
      res.on("end", () => ok(n));
    }).on("error", fail));
    assert.equal(got, big.length);
    assert.equal(await done[1], true);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
