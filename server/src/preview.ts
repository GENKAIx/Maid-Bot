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
];

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".webp": "image/webp", ".png": "image/png", ".woff2": "font/woff2", ".wav": "audio/wav",
};

/** Политика страницы показа: только свои файлы (заглушка отвечает из памяти, к /api/ не ходит), встраивать — только сайту. */
export const PREVIEW_CSP = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' data: blob:", "media-src 'self' data: blob:",
  "font-src 'self'", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'self'",
].join("; ");

/** Путь после /admin-preview/ → файл на диске или null (не из белого списка). */
export function previewFile(rel: string, widgetDir = WIDGET_DIR_DEFAULT, ownDir = PREVIEW_OWN_DIR): string | null {
  if (!PREVIEW_FILES.some((re) => re.test(rel))) return null;
  const root = rel.startsWith("preview/") ? ownDir : widgetDir;
  const file = path.resolve(root, rel.startsWith("preview/") ? rel.slice("preview/".length) : rel);
  return file.startsWith(root + path.sep) ? file : null;
}

/** widget.html для показа: заглушка — первым скриптом (как preload), управление — последним. Больше ничего не меняется. */
export function previewHtml(html: string): string {
  if (!/<script src="common\.js"><\/script>/.test(html) || !/<\/body>/.test(html)) throw new Error("widget.html другой формы: нет common.js или </body>");
  return html
    .replace(/<script src="common\.js"><\/script>/, `<script src="../preview/stub.js"></script>\n  <script src="common.js"></script>`)
    .replace(/<\/body>/, `  <script src="../preview/control.js"></script>\n</body>`);
}

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

/** Отдать файл показа (пропуск уже проверен). false — нет такого файла (404). */
export async function servePreview(rel: string, res: http.ServerResponse, widgetDir = WIDGET_DIR_DEFAULT, ownDir = PREVIEW_OWN_DIR): Promise<boolean> {
  const file = previewFile(rel, widgetDir, ownDir);
  if (!file) return false;
  // Ссылка в папке, ведущая наружу, — тоже нет.
  const real = await fs.promises.realpath(file).catch(() => "");
  const root = await fs.promises.realpath(rel.startsWith("preview/") ? ownDir : widgetDir).catch(() => "");
  if (!real || !root || !real.startsWith(root + path.sep)) return false;
  const st = await fs.promises.stat(real).catch(() => null);
  if (!st?.isFile()) return false;
  const ext = path.extname(real).toLowerCase();
  const common = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Content-Security-Policy": PREVIEW_CSP };
  if (ext === ".html") {
    const body = Buffer.from(previewHtml(await fs.promises.readFile(real, "utf8")), "utf8");
    res.writeHead(200, { ...common, "Content-Type": TYPES[ext], "Content-Length": body.length, "Cache-Control": "private, no-store",
      "Permissions-Policy": "microphone=(), camera=(), geolocation=()" });
    res.end(body);
    return true;
  }
  // Картинки, шрифты и звуки — из кэша браузера (их 90 МБ, один набор на все карточки); скрипты и стили — каждый раз свежие.
  const media = ext === ".webp" || ext === ".png" || ext === ".woff2" || ext === ".wav";
  res.writeHead(200, { ...common, "Content-Type": TYPES[ext] ?? "application/octet-stream", "Content-Length": st.size,
    "Cache-Control": media ? "private, max-age=86400" : "private, no-cache" });
  // pipeline, а не pipe: оборвал человек ответ (витрина снимает iframe посреди загрузки картинок) — поток файла закрывается
  // вместе с дескриптором, и ожидание кончается; обрыв — не ошибка.
  await pipeline(fs.createReadStream(real), res).catch((e: NodeJS.ErrnoException) => {
    if (e?.code !== "ERR_STREAM_PREMATURE_CLOSE" && !res.destroyed) throw e;
  });
  return true;
}
