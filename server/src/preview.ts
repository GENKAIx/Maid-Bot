import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

// Живой показ виджета в «Витрине» админки (25.11.2026, web/src/screens/AdminShowcase.tsx): настоящие файлы desktop/renderer
// (widget.html, стили, скрипты) и desktop/assets (анимации горничной, значки, шрифты, звуки) — в iframe сайта. Вместо preload.js
// программы — своя заглушка server/preview/stub.js: window.maid с тестовыми данными в памяти, без записей человека и без
// запросов к серверу (connect-src — только свои файлы показа: медленный показ фигурки читает её картинку); управление показом —
// server/preview/control.js (postMessage от страницы админки).
// Код виджета не меняется: в widget.html при отдаче вставляются только два своих <script>.
//
// Кэш (26.11.2026): у каждого файла показа — метка версии (первые 16 знаков sha256 того, что отдаётся; PreviewFiles считает при
// первом пропуске и держит в памяти, сверяя время и размер файла). Адрес с меткой («…/assets/maid/idle.webp?v=<метка>») —
// «private, max-age=31536000, immutable»: браузер берёт его из своего кэша без запроса; новая версия файла — новая метка и
// новый адрес. Без метки — как раньше (картинки, шрифты, звуки — на сутки; скрипты и стили — каждый раз проверять), с чужой
// меткой — «каждый раз проверять» (не immutable: под старым адресом не застрянет новый файл). У всех ответов — ETag и 304.
// Метки в адреса ставит сам сервер: в widget.html (src и href) и в стилях (url(…)) при отдаче; адреса, которые виджет собирает
// сам (`../assets/maid/${n}.webp`, new Audio(…)), — заглушка по списку «путь → метка» из страницы (stub.js). Пропуск нужен
// и для адресов с меткой (кэш — private: только браузер админа, не общие прокси).
// Ещё: poster/<имя>.webp — первый кадр анимации (вырезан из WebP без перекодирования, webpFirstFrame) для неподвижных карточек
// и files.json — список файлов с метками и весом для кнопки «Загрузить всё заранее».
//
// Доступ — только админу с подтверждённым входом в админку (те же проверки, что у /api/admin/*): POST /api/admin/preview выдаёт
// пропуск — случайный ключ в cookie maid_preview (HttpOnly, SameSite=Strict, Path=/admin-preview/), потому что iframe не умеет
// слать заголовок Authorization. Каждый запрос к /admin-preview/… проверяет пропуск заново: сессия жива, человек — админ, вход
// в админку не кончился (вышел из админки или из сайта — пропуск больше не действует). Нет пропуска — 401. Пути — только по
// белому списку PREVIEW_FILES (выйти из папки через «..» нельзя: в нём нет ни точек, ни косых, кроме расширения).

export const PREVIEW_PREFIX = "/admin-preview/";
export const PREVIEW_COOKIE = "maid_preview";
/** Сколько пропусков держим в памяти (по одному на устройство админа; лишние — самые старые — забываются). */
export const PREVIEW_MAX_PASSES = 50;

const here = path.dirname(fileURLToPath(import.meta.url));
/** Папка программы на ПК в репозитории и в образе (Dockerfile копирует сюда только renderer и assets). */
export const WIDGET_DIR_DEFAULT = path.resolve(here, "..", "..", "desktop");
/** Свои файлы показа: заглушка window.maid и управление. */
export const PREVIEW_OWN_DIR = path.resolve(here, "..", "preview");

/** Что можно отдать: путь после /admin-preview/ → откуда (renderer/assets — из папки программы, preview — свои). */
export const PREVIEW_FILES: RegExp[] = [
  /^renderer\/widget\.html$/,
  /^renderer\/[a-z0-9-]+\.(js|css)$/,
  /^assets\/(maid|inbox|fonts|sounds)\/[a-z0-9-]+\.(webp|png|woff2|wav)$/,
  /^assets\/star\.png$/,
  /^preview\/(stub|control)\.js$/,
  /^poster\/[a-z0-9-]+\.webp$/,
  /^files\.json$/,
];

/** Кэш адреса с меткой версии, без метки (картинки, шрифты, звуки — как раньше), с чужой меткой и у страницы. */
export const PREVIEW_IMMUTABLE = "private, max-age=31536000, immutable";
export const PREVIEW_MEDIA = "private, max-age=86400";
export const PREVIEW_REVALIDATE = "private, no-cache";
const MEDIA = new Set([".webp", ".png", ".woff2", ".wav"]);

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".webp": "image/webp", ".png": "image/png", ".woff2": "font/woff2", ".wav": "audio/wav",
};

/** Политика страницы показа: только свои файлы (заглушка отвечает из памяти, к /api/ не ходит), встраивать — только сайту. */
export const PREVIEW_CSP = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' data: blob:", "media-src 'self' data: blob:",
  "font-src 'self'", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'self'",
].join("; ");

/** Путь после /admin-preview/ → файл на диске или null (не из белого списка; files.json — не файл). У poster/<имя>.webp —
 *  его анимация assets/maid/<имя>.webp. */
export function previewFile(rel: string, widgetDir = WIDGET_DIR_DEFAULT, ownDir = PREVIEW_OWN_DIR): string | null {
  if (!PREVIEW_FILES.some((re) => re.test(rel)) || rel === "files.json") return null;
  if (rel.startsWith("poster/")) rel = `assets/maid/${rel.slice("poster/".length)}`;
  const root = rel.startsWith("preview/") ? ownDir : widgetDir;
  const file = path.resolve(root, rel.startsWith("preview/") ? rel.slice("preview/".length) : rel);
  return file.startsWith(root + path.sep) ? file : null;
}

/** Адрес файла показа с меткой версии. */
export const previewUrl = (rel: string, v: string) => `${PREVIEW_PREFIX}${rel}?v=${v}`;

/** Метки версий для страницы: rel → метка (нет такого файла — null) и список «путь → метка» для заглушки (картинки и звуки,
 *  адреса которых виджет собирает сам). */
export interface PreviewTags { tag: (rel: string) => string | null; assets: Record<string, string> }

/** Ссылки страницы или стиля на свои файлы → адреса с меткой. base — папка файла («renderer»); чужие, data:, от корня и с ? или # —
 *  как есть. */
export function tagLinks(text: string, base: string, tag: PreviewTags["tag"], re: RegExp): string {
  return text.replace(re, (all, pre: string, ref: string, post: string) => {
    if (/^[a-z]+:|^\/|[?#]/i.test(ref)) return all;
    const rel = path.posix.normalize(path.posix.join(base, ref));
    const v = rel.startsWith("..") ? null : tag(rel);
    return v ? `${pre}${previewUrl(rel, v)}${post}` : all;
  });
}
const HTML_LINK = /(\s(?:src|href)=")([^"]+)(")/g;
const CSS_LINK = /(url\(\s*["']?)([^"')]+)(["']?\s*\))/g;

/** widget.html для показа: заглушка — первым скриптом (как preload), управление — последним; с метками (tags) — перед заглушкой
 *  список «путь → метка» (JSON, не скрипт: CSP его не исполняет), ссылки src и href — с меткой. Код виджета не меняется. */
export function previewHtml(html: string, tags?: PreviewTags): string {
  if (!/<script src="common\.js"><\/script>/.test(html) || !/<\/body>/.test(html)) throw new Error("widget.html другой формы: нет common.js или </body>");
  const list = tags ? `<script type="application/json" id="preview-files">${JSON.stringify(tags.assets).replace(/</g, "\\u003c")}</script>\n  ` : "";
  const out = html
    .replace(/<script src="common\.js"><\/script>/, `${list}<script src="../preview/stub.js"></script>\n  <script src="common.js"></script>`)
    .replace(/<\/body>/, `  <script src="../preview/control.js"></script>\n</body>`);
  return tags ? tagLinks(out, "renderer", tags.tag, HTML_LINK) : out;
}

/** Первый кадр анимированного WebP — тот же WebP из одного кадра (VP8X, ANIM и первый ANMF без перекодирования: 25–35 КБ
 *  вместо 1,6–3,5 МБ анимации). Не анимация — как есть; испорченный файл — null. */
export function webpFirstFrame(b: Buffer): Buffer | null {
  if (b.length < 20 || b.toString("latin1", 0, 4) !== "RIFF" || b.toString("latin1", 8, 12) !== "WEBP") return null;
  const keep: Buffer[] = [];
  let animated = false;
  for (let off = 12; off + 8 <= b.length;) {
    const type = b.toString("latin1", off, off + 4), n = b.readUInt32LE(off + 4);
    const end = off + 8 + n + (n & 1);
    if (off + 8 + n > b.length) return null;
    const chunk = Buffer.from(b.subarray(off, Math.min(end, b.length)));
    if (type === "VP8X") {
      animated = (chunk[8] & 0x02) !== 0;
      chunk[8] &= ~0x0c; // EXIF и XMP не переносятся — и флагов их нет
    }
    if (type === "VP8X" || type === "ICCP" || type === "ANIM") keep.push(chunk);
    if (type === "ANMF") {
      if (!animated) return null;
      keep.push(chunk);
      const body = Buffer.concat(keep);
      const head = Buffer.alloc(12);
      head.write("RIFF", 0, "latin1");
      head.writeUInt32LE(4 + body.length, 4);
      head.write("WEBP", 8, "latin1");
      return Buffer.concat([head, body]);
    }
    off = end;
  }
  return animated ? null : b;
}

/** Файл показа с меткой: метка, вес, путь на диске; body — что отдать, если это не файл как есть (стиль с метками, кадр). */
interface Entry { v: string; bytes: number; file: string; body?: Buffer }
const sha = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex").slice(0, 16);

/** Метки версий файлов показа (в памяти процесса): файл как есть и кадр-превью — по времени и размеру файла (изменился —
 *  посчитать заново; один расчёт на файл, даже если спросили сразу несколько карточек), стиль — каждый раз (в нём метки шрифтов). */
export class PreviewFiles {
  private known = new Map<string, { stamp: string; got: Promise<Entry | null> }>();
  constructor(readonly widgetDir = WIDGET_DIR_DEFAULT, readonly ownDir = PREVIEW_OWN_DIR) {}

  /** Настоящий путь файла и его stat; ссылка в папке, ведущая наружу, или не файл — null. */
  private async real(rel: string): Promise<{ file: string; st: fs.Stats } | null> {
    const file = previewFile(rel, this.widgetDir, this.ownDir);
    if (!file) return null;
    const real = await fs.promises.realpath(file).catch(() => "");
    const root = await fs.promises.realpath(rel.startsWith("preview/") ? this.ownDir : this.widgetDir).catch(() => "");
    if (!real || !root || !real.startsWith(root + path.sep)) return null;
    const st = await fs.promises.stat(real).catch(() => null);
    return st?.isFile() ? { file: real, st } : null;
  }

  /** Метка и что отдать для пути из белого списка; нет такого — null. Страница и список файлов — не здесь (page, list). */
  async entry(rel: string): Promise<Entry | null> {
    const r = await this.real(rel);
    if (!r || rel === "renderer/widget.html") return null;
    if (path.extname(r.file).toLowerCase() === ".css") {
      const css = await fs.promises.readFile(r.file, "utf8");
      const tags = new Map<string, string>();
      for (const [, , ref] of css.matchAll(CSS_LINK)) {
        const x = path.posix.normalize(path.posix.join(path.posix.dirname(rel), ref));
        const e = /^[a-z]+:|^\/|[?#]/i.test(ref) || x.startsWith("..") || x.endsWith(".css") ? null : await this.entry(x);
        if (e) tags.set(x, e.v);
      }
      const body = Buffer.from(tagLinks(css, path.posix.dirname(rel), (x) => tags.get(x) ?? null, CSS_LINK), "utf8");
      return { v: sha(body), bytes: body.length, file: r.file, body };
    }
    const stamp = `${r.st.mtimeMs}:${r.st.size}`;
    const had = this.known.get(rel);
    if (had?.stamp === stamp) return had.got;
    const got = (async (): Promise<Entry | null> => {
      if (rel.startsWith("poster/")) {
        const body = webpFirstFrame(await fs.promises.readFile(r.file));
        return body ? { v: sha(body), bytes: body.length, file: r.file, body } : null;
      }
      const h = crypto.createHash("sha256");
      await pipeline(fs.createReadStream(r.file), h);
      return { v: h.digest("hex").slice(0, 16), bytes: r.st.size, file: r.file };
    })();
    this.known.set(rel, { stamp, got });
    got.catch(() => this.known.delete(rel));
    return got;
  }

  /** Все файлы показа с метками (кроме страницы): картинки, шрифты, звуки, кадры-превью, скрипты и стили. */
  async list(): Promise<{ path: string; v: string; bytes: number }[]> {
    const names = async (dir: string) => (await fs.promises.readdir(dir).catch(() => [] as string[])).sort();
    const rels: string[] = [];
    for (const d of ["maid", "inbox", "fonts", "sounds"]) for (const n of await names(path.join(this.widgetDir, "assets", d))) rels.push(`assets/${d}/${n}`);
    rels.push("assets/star.png");
    for (const n of await names(path.join(this.widgetDir, "assets", "maid"))) rels.push(`poster/${n}`);
    rels.push(...(await names(path.join(this.widgetDir, "renderer"))).map((n) => `renderer/${n}`), "preview/stub.js", "preview/control.js");
    const out: { path: string; v: string; bytes: number }[] = [];
    for (const rel of rels) {
      if (!PREVIEW_FILES.some((re) => re.test(rel))) continue;
      const e = await this.entry(rel).catch(() => null);
      if (e) out.push({ path: rel, v: e.v, bytes: e.bytes });
    }
    return out;
  }

  /** widget.html для показа: вставки и метки (previewHtml). */
  async page(): Promise<Buffer | null> {
    const r = await this.real("renderer/widget.html");
    if (!r) return null;
    const all = await this.list();
    const by = new Map(all.map((f) => [f.path, f.v]));
    const assets = Object.fromEntries(all.filter((f) => f.path.startsWith("assets/")).map((f) => [f.path, f.v]));
    return Buffer.from(previewHtml(await fs.promises.readFile(r.file, "utf8"), { tag: (x) => by.get(x) ?? null, assets }), "utf8");
  }
}

/** Совпал ли ETag с If-None-Match (список через запятую; W/ — не важно). */
const etagHit = (inm: string | undefined, etag: string) => Boolean(inm) && inm!.split(",").some((x) => x.trim().replace(/^W\//, "") === etag);

interface Pass { hash: string; exp: number }

/** Пропуски показа: ключ cookie → сессия (хеш ключа входа) и срок (до конца входа в админку). Только в памяти процесса. */
export class PreviewPasses {
  private passes = new Map<string, Pass>();

  /** Пропуск этой сессии: прежний, если ещё действует (тот же адрес — картинки из кэша браузера), иначе новый. */
  issue(hash: string, until: Date, now = Date.now()): { key: string; fresh: boolean } {
    for (const [k, p] of this.passes) if (p.exp <= now) this.passes.delete(k);
    for (const [k, p] of this.passes) if (p.hash === hash) {
      p.exp = until.getTime();
      return { key: k, fresh: false };
    }
    const key = crypto.randomBytes(24).toString("hex");
    this.passes.set(key, { hash, exp: until.getTime() });
    while (this.passes.size > PREVIEW_MAX_PASSES) this.passes.delete(this.passes.keys().next().value!);
    return { key, fresh: true };
  }

  /** Хеш сессии по ключу cookie (null — нет такого или срок вышел). */
  check(key: string, now = Date.now()): string | null {
    const p = key ? this.passes.get(key) : undefined;
    if (!p) return null;
    if (p.exp <= now) {
      this.passes.delete(key);
      return null;
    }
    return p.hash;
  }

  drop(hash: string) {
    for (const [k, p] of this.passes) if (p.hash === hash) this.passes.delete(k);
  }
}

/** Ключ пропуска из заголовка Cookie. */
export function previewKey(cookie: string | undefined): string {
  for (const part of (cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === PREVIEW_COOKIE) return /^[0-9a-f]{48}$/.test(v.join("=")) ? v.join("=") : "";
  }
  return "";
}

/** Set-Cookie пропуска; secure — сайт открыт по https (за Caddy — X-Forwarded-Proto). */
export function previewCookie(key: string, until: Date, secure: boolean, now = Date.now()): string {
  const age = Math.max(0, Math.floor((until.getTime() - now) / 1000));
  return `${PREVIEW_COOKIE}=${key}; Path=${PREVIEW_PREFIX}; Max-Age=${age}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

/** Отдать файл показа (пропуск уже проверен). v — метка из адреса (?v=, null — без неё), inm — If-None-Match. false — нет
 *  такого файла (404). */
export async function servePreview(rel: string, res: http.ServerResponse, files: PreviewFiles = new PreviewFiles(), ask: { v?: string | null; inm?: string } = {}): Promise<boolean> {
  const common = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Content-Security-Policy": PREVIEW_CSP };
  const send = (body: Buffer, type: string, cache: string, etag: string, extra: Record<string, string> = {}) => {
    const head = { ...common, ...extra, "Content-Type": type, "Cache-Control": cache, ETag: etag };
    if (etagHit(ask.inm, etag)) {
      res.writeHead(304, head);
      res.end();
    } else {
      res.writeHead(200, { ...head, "Content-Length": body.length });
      res.end(body);
    }
    return true;
  };
  // Страница и список файлов — каждый раз проверять (ETag по содержимому: поменялась метка любого файла — страница другая).
  if (rel === "renderer/widget.html") {
    const body = await files.page();
    return body ? send(body, TYPES[".html"], PREVIEW_REVALIDATE, `"${sha(body)}"`, { "Permissions-Policy": "microphone=(), camera=(), geolocation=()" }) : false;
  }
  if (rel === "files.json") {
    const body = Buffer.from(JSON.stringify({ files: await files.list() }), "utf8");
    return send(body, "application/json; charset=utf-8", PREVIEW_REVALIDATE, `"${sha(body)}"`);
  }
  const e = await files.entry(rel);
  if (!e) return false;
  const ext = path.extname(rel).toLowerCase();
  const cache = ask.v === e.v ? PREVIEW_IMMUTABLE : ask.v != null ? PREVIEW_REVALIDATE : MEDIA.has(ext) ? PREVIEW_MEDIA : PREVIEW_REVALIDATE;
  const type = TYPES[ext] ?? "application/octet-stream";
  const etag = `"${e.v}"`;
  if (e.body) return send(e.body, type, cache, etag);
  if (etagHit(ask.inm, etag)) {
    res.writeHead(304, { ...common, "Content-Type": type, "Cache-Control": cache, ETag: etag });
    res.end();
    return true;
  }
  res.writeHead(200, { ...common, "Content-Type": type, "Content-Length": e.bytes, "Cache-Control": cache, ETag: etag });
  // pipeline, а не pipe: оборвал человек ответ (витрина снимает iframe посреди загрузки картинок) — поток файла закрывается
  // вместе с дескриптором, и ожидание кончается; обрыв — не ошибка.
  await pipeline(fs.createReadStream(e.file), res).catch((err: NodeJS.ErrnoException) => {
    if (err?.code !== "ERR_STREAM_PREMATURE_CLOSE" && !res.destroyed) throw err;
  });
  return true;
}
