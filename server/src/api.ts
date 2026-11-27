import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { z } from "zod";
import { PERSONAS } from "./personas.ts";
import { PREVIEW_PREFIX, PreviewFiles, PreviewPasses, previewCookie, previewKey, servePreview, WIDGET_DIR_DEFAULT } from "./preview.ts";
import { authByToken, clientMeta, isAdmin, login, LoginGate, tokenHash } from "./auth.ts";
import { adminJournal, adminUntil, confirmAdminCode, issueAdminCode, leaveAdmin } from "./admin.ts";
import { accountAction, accountCard, AccountError, accountReason, MAX_ACCOUNT_ID } from "./admin-account.ts";
import { createTestAccount, testAccountAction, testsView } from "./admin-tests.ts";
import { adminAudience, adminFeatures, adminHealth, adminOverview, adminPayments, adminQualityReport, adminSpend, adminUsers } from "./admin-stats.ts";
import { cachedAnalytics, parseAnalyticsQuery } from "./admin-analytics.ts";
import { acceptUsage, countFeature, countPersona, featureClient, USAGE_MAX_KEYS } from "./feature-events.ts";
import { featureOfApi } from "./feature-list.ts";
import type { DateRow, Store, UsageRow, User } from "./db.ts";
import { ActivityInput, IconsInput, iconKey, recordActivity } from "./activity.ts";
import { ALBUM, albumOf, albumSee } from "./album.ts";
import { dayCount, finishedHabits, finishPatch, habitBefore, habitMonth, habitsOfDay, habitStats, markClosed, markRefusal, perDayOf, reopenPatch } from "./habits.ts";
import { MAID_EYES, MAID_HAIR } from "./look.ts";
import { historyOf, NOTICE_KINDS } from "./notices.ts";
import { NOTE_TEXT_MAX, NOTE_TITLE_MAX, RATED_SHELVES, SHELF_KEYS, SHELVES, noteCounts, sameNote, type Shelf } from "./notes.ts";
import { HEALTH_TOPICS, METRICS } from "./parse.ts";
import { proposalView, TRASH_DAYS, type Pipeline } from "./pipeline.ts";

/** Для поиска: нижний регистр, «ё» как «е». */
const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е");
const ShelfKey = z.enum(SHELF_KEYS as [Shelf, ...Shelf[]]);
import { backupName, exportJson } from "./backup.ts";
import { Push } from "./push.ts";
import { RepeatSpec, setRepeat } from "./repeat.ts";
import { moneyTotals, upcomingDates, yearKnown } from "./report.ts";
import { decideTrait, profileView, saveProfile, xpOf, sameTrait, steamAvatar, traitCategory, traitView, AVATAR_MAX } from "./profile.ts";
import { HABIT_DATA, RATE_MAX, habitButtons, planEventReminders, snoozeDayRefusal, snoozeOptions, RATE, rateDay, remindText, replanEvents as replanEventsOf, snooze, type Button, type Send } from "./scheduler.ts";
import { addDays, dayKey, isDayKey, isEveningTime, isTime, normalizeTime, shortDay, zonedToUtc } from "./time.ts";
import { isOpusMime, transcribe, VOICE_MAX_BYTES, voiceSeconds } from "./voice.ts";
import { moveToTomorrow, weatherFor } from "./weather.ts";
import { ADDRESSES, addressWord, askNext, askOf, wakeAt, wakeMinOf, askShown, findCities, saveYou, youButton, youView, type City } from "./you.ts";
import { enterUser, IMAGE_MAX_BYTES, IMAGE_MAX_COUNT, IMAGE_TYPES, IMAGES_MAX_BYTES, llmErrorCode } from "./llm.ts";
import { accessOf, accessView, FROZEN_TEXT, RATE_AGAIN, todayView, type Access, type Refusal } from "./access.ts";
import type { Billing } from "./billing.ts";
import { applyTariffs, TariffError, tariffs, tariffsView, undoTariff } from "./tariffs.ts";
import { AlertError, Alerts } from "./alerts.ts";
import { DbCopies, DbCopyBusy } from "./snapshot.ts";
import { acceptCrashes, adminCrashes, CRASH_MAX_ITEMS, noteDesktopDay } from "./crashes.ts";
import { changeRelease, editNotes, notesFile, ReleaseError, releasesView, servedYml, ymlVersion } from "./releases.ts";
import { setSwitch, SwitchError, switchesView, switchOffText, switchOn } from "./switches.ts";
import { promptCard, PromptError, promptsView, savePrompt, selectPrompt } from "./prompts.ts";
import { createPromo, PromoError, promoView, redeemPromo, togglePromo } from "./promo.ts";
import { createTicket, SupportError, supportOf, ticketAction, ticketCard, ticketsView } from "./support.ts";
import { AnnounceError, announcementsView, createAnnouncement, deliverToWidget, siteAnnouncements, toggleAnnouncement } from "./announce.ts";
import { prognosisView } from "./prognosis.ts";
import { healthRange, noteActive, noteHttp, serverLoad } from "./server-metrics.ts";
import { OpenRouterBill, OpenRouterBillError } from "./openrouter-bill.ts";

// HTTP: API для веб-приложения, десктопа и айфона (Bearer-ключ после входа, /token в боте или DESKTOP_TOKEN)
// и webhook Telegram.

export { userByToken } from "./auth.ts";

export interface ApiDeps {
  store: Store;
  pipeline: Pipeline;
  send?: Send;
  webhook?: (req: http.IncomingMessage, res: http.ServerResponse) => unknown;
  /** Папка собранного веб-приложения; пусто — не отдавать. */
  webDir?: string;
  /** Папка обновлений программы для ПК (/desktop/latest.yml, установщик); пусто — не отдавать. */
  desktopDir?: string;
  /** Папка программы на ПК с renderer/ и assets/ — живой показ виджета в «Витрине» админки (preview.ts); по умолчанию desktop/ репозитория. */
  widgetDir?: string;
  push?: Push;
  /** Имя Telegram-бота без @ (ссылка на экране входа); нет бота — undefined. */
  botName?: () => string | undefined;
  /** Счётчик неудачных входов (тесты подставляют свой). */
  loginGate?: LoginGate;
  /** Куда слать код входа в админку (admin.ts): Telegram владельца; нет — вход в админку недоступен (503). */
  adminCode?: (u: User, text: string) => Promise<void>;
  /** Поиск города для «О вас» (тесты подставляют свой; по умолчанию — геокодер Open-Meteo). */
  cities?: (q: string) => Promise<City[]>;
  /** Подписка Telegram Stars (billing.ts): ссылка на оплату, отмена продления, возврат из админки. Нет — 503 на /api/billing/*. */
  billing?: Billing;
  /** Оповещения владельцу (alerts.ts); нет — свои, с письмом через adminCode всем админам (тесты). */
  alerts?: Alerts;
  /** Ночные копии базы (snapshot.ts); нет — без папки снимков (раздел покажет «не настроено»). */
  copies?: DbCopies;
  /** Потолок провайдера модели, запросов в минуту (config.llm.rpm; 0 — не известен) — для «Сколько выдержит» (server-metrics.ts). */
  llmRpm?: number;
  /** «Счёт OpenRouter» (openrouter-bill.ts); нет — без ключа (блок покажет «ключ не задан»). */
  openrouter?: OpenRouterBill;
}

/** Ошибка проверки действия с аккаунтом (admin-account.ts) — в ответ с её кодом. */
function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof AccountError) throw new HttpError(e.status, e.message);
    throw e;
  }
}
async function guardAsync<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AccountError) throw new HttpError(e.status, e.message);
    throw e;
  }
}

/** Ошибки этапа 6 (переключатели, промокоды, обращения, объявления) и промптов — в ответ с их кодом. */
async function stage6<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof SwitchError || e instanceof PromoError || e instanceof SupportError || e instanceof AnnounceError || e instanceof PromptError) {
      throw new HttpError(e.status, e.message);
    }
    throw e;
  }
}

/** extra — ещё поля ответа рядом с error (402: pay_url, messageId). */
export class HttpError extends Error {
  constructor(public status: number, msg: string, public extra?: Record<string, unknown>) {
    super(msg);
  }
}

async function readJson(req: http.IncomingMessage, limit = 1_000_000): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, "слишком большой запрос");
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "не JSON");
  }
}

function parseBody<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body);
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return r.data;
}

const Day = z.string().refine(isDayKey, "день YYYY-MM-DD");

/** Всё, что записано за один день (дневник по дням в приложении). */
export async function dayJson(store: Store, u: User, day: string) {
  return {
    day,
    events: await store.eventsBetween(u.id, day, day),
    diary: await store.diaryOf(u.id, day),
    habits: (await habitsOfDay(store, u, day)).map((d) => ({
      id: d.habit.id, title: d.habit.title, times: d.times, status: d.status, streak: d.streak, done: d.doneDays, planned: d.plannedDays,
      start: d.habit.start_date, end: d.habit.end_date, course: d.course, yesterday: d.yesterday, quiet: d.habit.quiet ?? 0,
      // ×N (шаг 42): сколько раз отмечено сегодня и сколько нужно; status null при count < need — отмечено не всё.
      count: d.count, need: d.need,
      // Когда отметили (сайт «Сегодня», виджет: «✓ 21:14»): «ЧЧ:ММ» в поясе человека; at_day — день отметки, если задним числом.
      at_time: d.at_time, at_day: d.at_day,
    })),
    metrics: await store.metricsRange(u.id, day, day),
    money: await store.moneyRange(u.id, day, day),
    activity: await store.activityOf(u.id, day),
  };
}

const FAR_FRESH_MS = 15 * 60_000;

export async function todayJson(store: Store, u: User, now = new Date()) {
  const today = dayKey(now, u.tz);
  return {
    ...(await dayJson(store, u, today)),
    persona: u.persona,
    // «Перекрасить Рину»: в каком цвете виджет ПК показывает её анимации (desktop/renderer/look.js) — с каждым опросом.
    maid_hair: u.maid_hair,
    maid_eyes: u.maid_eyes,
    // «О вас» (you.ts): как обращаться в готовых репликах виджета, подъём и отбой — для сна на ПК (одни на все компьютеры).
    call: addressWord(u),
    // wake — час (виджеты до 0.1.83 знают только его), wake_at — подъём с минутами «06:30» (с 20.11.2026).
    wake: Math.floor(wakeMinOf(u) / 60),
    wake_at: wakeAt(u),
    bed: u.bed,
    // Подъём и отбой, выбранные самим (ask.set): виджет не переносит поверх них прежние настройки ПК (sleepMove).
    you_set: askOf(u).set.filter((k) => k === "wake" || k === "bed"),
    // Вопрос Рины о вас для облачка виджета (askNext): не чаще раза в 3 дня, иначе null.
    ask: askNext(u, now),
    upcoming: await store.eventsBetween(u.id, addDays(today, 1), addDays(today, 14)),
    // Далёкие (дальше upcoming) планы, добавленные или изменённые за 15 минут: виджет ПК едет к их дню, откуда бы их ни записали.
    far_fresh: await store.eventsChangedSince(u.id, addDays(today, 14), new Date(now.getTime() - FAR_FRESH_MS).toISOString()),
    // Планы, отменённые или удалённые за 15 минут (откуда угодно): виджет ПК едет к их дню и показывает, как запись уходит.
    gone_fresh: await store.eventsClosedSince(u.id, today, new Date(now.getTime() - FAR_FRESH_MS).toISOString()),
    // Отмеченные сделанными за 15 минут (в чате, в Telegram, с телефона): виджет ПК ставит им галочку на их дне.
    done_fresh: await store.eventsClosedSince(u.id, today, new Date(now.getTime() - FAR_FRESH_MS).toISOString(), ["done"]),
    tasks: await store.openTasks(u.id),
    // Сколько заметок «на потом» ждёт на каждой полке: подсказки над строкой чата виджета ПК (desktop hints.js).
    notes: noteCounts(await store.notesOf(u.id)),
    // Сделанные сегодня (где угодно: виджет, телефон, Telegram) — виджет показывает их внизу и считает в настроение дня.
    done_today: (await store.doneTasksBetween(u.id, zonedToUtc(today, "00:00", u.tz), zonedToUtc(addDays(today, 1), "00:00", u.tz)))
      .map((t) => ({ id: t.id, title: t.title, done_at: t.done_at })),
    dates: upcomingDates(await store.activeDates(u.id), today, 30).map((d) => ({ ...d.row, on: d.on, inDays: d.inDays, age: d.age })),
    // Опыт и уровень (profile.ts xpOf): полоса опыта в шапке виджета ПК — три COUNT на опрос.
    xp: await xpOf(store, u.id),
  };
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml",
  ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
};

/** Политика безопасности страницы (24.11.2026, к админке): скрипты — только свои файлы и встроенные блоки этой страницы
 *  (по хешу), чужих адресов нет — внедрённый скрипт не запустится и не отправит данные наружу (connect-src 'self').
 *  Стили — свои и style="…" (React), картинки и звук — свои, data: и blob: (рисунки, запись голоса). */
export function pageCsp(html: string): string {
  const hashes = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => `'sha256-${crypto.createHash("sha256").update(m[1]).digest("base64")}'`);
  return [
    "default-src 'self'", `script-src 'self' ${hashes.join(" ")}`.trim(), "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:", "media-src 'self' data: blob:", "font-src 'self' data:", "connect-src 'self'",
    "worker-src 'self'", "manifest-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'",
  ].join("; ");
}

/** Собранное веб-приложение из папки: файл по пути, иначе index.html (адреса экранов — внутри приложения). */
async function serveStatic(dir: string, pathname: string, res: http.ServerResponse): Promise<boolean> {
  if (!dir) return false;
  const safe = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = path.join(dir, safe);
  if (!file.startsWith(dir)) return false;
  const statOf = async (f: string) => {
    const st = await fs.promises.stat(f).catch(() => null);
    return st?.isFile() ? st : null;
  };
  let st = await statOf(file);
  if (!st) {
    // Путь с точкой — файл, которого нет; кроме экранов админки: ключ промпта с точкой (/admin/prompts/parse.rules).
    if (path.extname(safe) && !safe.replace(/\\/g, "/").startsWith("/admin/")) return false;
    file = path.join(dir, "index.html");
    st = await statOf(file);
    if (!st) return false;
  }
  const ext = path.extname(file).toLowerCase();
  const immutable = /\/assets\//.test(file.replace(/\\/g, "/"));
  if (ext === ".html") {
    const html = await fs.promises.readFile(file);
    res.writeHead(200, { "Content-Type": MIME[ext], "Content-Length": html.length, "Cache-Control": "no-cache", "Content-Security-Policy": pageCsp(html.toString("utf8")) });
    res.end(html);
    return true;
  }
  res.writeHead(200, {
    "Content-Type": MIME[ext] ?? "application/octet-stream",
    "Content-Length": st.size,
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  });
  await new Promise<void>((ok, fail) => fs.createReadStream(file).on("error", fail).on("end", ok).pipe(res));
  return true;
}

/** Обновление программы для ПК: только latest.yml и установщики из папки, без подпапок и без index.html.
 *  Открыто без входа — в установщике нет ничего личного, а программа проверяет обновления до входа.
 *  yml — что отдать вместо latest.yml с диска (поэтапный выпуск, releases.ts servedYml: процент из настройки); файл не меняется. */
export async function serveDesktop(dir: string, pathname: string, res: http.ServerResponse, yml?: (text: string) => Promise<string>): Promise<boolean> {
  const name = pathname.slice("/desktop/".length);
  if (!dir || !/^(latest\.yml|[\w.-]+\.exe)$/.test(name) || name.startsWith(".")) return false;
  const file = path.join(dir, name);
  const st = await fs.promises.stat(file).catch(() => null);
  if (!st?.isFile()) {
    // Постоянная ссылка «Gornichnaya-Setup.exe» и ссылки на старые версии (при выпуске старый установщик удаляется) —
    // переадресация на нынешний установщик из latest.yml, а не «нет такого файла».
    const now = /^Gornichnaya-Setup(-[\w.-]+)?\.exe$/.test(name) ? await latestExe(dir) : null;
    if (!now || now === name) return false;
    res.writeHead(302, { Location: `/desktop/${encodeURIComponent(now)}`, "Cache-Control": "no-cache" }).end();
    return true;
  }
  if (name === "latest.yml" && yml) {
    const body = Buffer.from(await yml(await fs.promises.readFile(file, "utf8")), "utf8");
    res.writeHead(200, { "Content-Type": "text/yaml; charset=utf-8", "Content-Length": body.length, "Cache-Control": "no-cache" });
    res.end(body);
    return true;
  }
  res.writeHead(200, {
    "Content-Type": name.endsWith(".yml") ? "text/yaml; charset=utf-8" : "application/octet-stream",
    "Content-Length": st.size,
    "Cache-Control": "no-cache",
  });
  await new Promise<void>((ok, fail) => fs.createReadStream(file).on("error", fail).on("end", ok).pipe(res));
  return true;
}

/** Нынешний установщик программы: имя из latest.yml (path:), если такой файл есть в папке; иначе null. */
async function latestExe(dir: string): Promise<string | null> {
  const yml = await fs.promises.readFile(path.join(dir, "latest.yml"), "utf8").catch(() => "");
  const name = /^path:\s*(\S+)\s*$/m.exec(yml)?.[1] ?? "";
  if (!/^[\w.-]+\.exe$/.test(name)) return null;
  const st = await fs.promises.stat(path.join(dir, name)).catch(() => null);
  return st?.isFile() ? name : null;
}

/** Поиск по дневнику: раздел, подраздел, слова (без учёта регистра, кириллица тоже). */
export async function searchDiary(store: Store, u: User, q: { section?: string; topic?: string; text?: string; from?: string; to?: string }) {
  let rows = q.from || q.to
    ? await store.diaryRange(u.id, q.from ?? "0000-01-01", q.to ?? "9999-12-31")
    : q.section ? await store.diarySection(u.id, q.section) : await store.diaryRange(u.id, "0000-01-01", "9999-12-31");
  if (q.section) rows = rows.filter((r) => r.section === q.section);
  if (q.topic) rows = rows.filter((r) => r.topic === q.topic);
  const words = (q.text ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length) rows = rows.filter((r) => words.every((w) => r.text.toLowerCase().includes(w)));
  return rows.reverse().slice(0, 500);
}

/** Адрес клиента для ограничения входа. X-Forwarded-For верим, только если пришли с локального или внутреннего адреса
 *  (Caddy в Docker); с открытого адреса заголовок подделывается — берём сам сокет. */
export function clientIp(req: http.IncomingMessage): string {
  const sock = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
  const inner = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|f[cd])/.test(sock);
  const fwd = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
  return inner && fwd ? fwd : sock || "?";
}

export function createApi(deps: ApiDeps) {
  const { store, pipeline } = deps;
  const alerts = deps.alerts ?? new Alerts(store, {
    notify: async (text) => {
      let n = 0;
      if (deps.adminCode) for (const x of await store.users()) if (isAdmin(x, "session")) await deps.adminCode(x, text).then(() => n++, () => {});
      return n;
    },
  });
  const copies = deps.copies ?? new DbCopies(store, { dir: null });
  const orBill = deps.openrouter ?? new OpenRouterBill(store);
  const gate = deps.loginGate ?? new LoginGate();
  const previews = new PreviewPasses();
  /** Метки версий файлов живого показа (preview.ts): считаются при первом пропуске, дальше — из памяти. */
  const previewFiles = new PreviewFiles(deps.widgetDir ?? WIDGET_DIR_DEFAULT);

  const replanEvents = (u: User) => replanEventsOf(store, u);
  /** Кнопка «you:…» (вопрос Рины о вас, «Записать в профиль?»): ответ; сменился пояс — напоминания заново. */
  async function runYou(u: User, data: string): Promise<string> {
    let r;
    try { r = await youButton(store, u, data); } catch (e) { throw new HttpError(400, (e as Error).message); }
    if (r.tzChanged) await replanEvents((await store.user(u.id))!);
    return r.text;
  }

  /** Кнопка из уведомления (push): отметка привычки или «отложить» — то же, что callback в боте. */
  async function runButton(u: User, data: string, all: string[]): Promise<string> {
    const HABIT = /^habit:(\d+):(\d{4}-\d{2}-\d{2}):(done|skipped|later)$/;
    const habit = data.match(HABIT);
    if (habit?.[3] === "later") return pipeline.habitLater(u, Number(habit[1]), habit[2]);
    if (habit) return pipeline.markHabit(u, Number(habit[1]), habit[2], habit[3] as "done" | "skipped", "push");
    // Шаг «Позже» в push не приходит (там «⏰ Позже» — прежний ответ habitLater), но кнопку s<мин> / t<ЧЧММ> поймём так же, как бот.
    const step = data.match(HABIT_DATA)?.slice(1);
    if (step && /^[st]\d+$/.test(step[2])) {
      const when = step[2][0] === "s" ? { in: Number(step[2].slice(1)) } : { at: `${step[2].slice(1, 3)}:${step[2].slice(3)}` };
      if ("at" in when && !isTime(when.at)) throw new HttpError(400, "неизвестная кнопка");
      return (await pipeline.habitSnooze(u, Number(step[0]), step[1], when)).text;
    }
    const trait = data.match(/^trait:(\d+):(yes|no)$/);
    if (trait) return decideTrait(store, u, Number(trait[1]), trait[2] === "yes");
    const rate = data.match(RATE);
    if (rate) return rateDay(store, u, rate[1], Number(rate[2]));
    if (data.startsWith("you:")) return runYou(u, data);
    if (data === "snooze") {
      const buttons: Button[] = all.filter((d) => d !== "snooze").map((d) => {
        const h = d.match(HABIT);
        return { text: h ? (h[3] === "done" ? "✅ Да" : h[3] === "later" ? "⏰ Позже" : "✖ Нет") : d, data: d };
      });
      const first = buttons[0]?.data.match(HABIT);
      const title = first ? (await store.habit(Number(first[1])))?.title : undefined;
      await snooze(store, u, title ? `🔁 Напоминаю: ${title}` : "🔔 Напоминаю", buttons, Push.snoozeMinutes);
      return `Напомню через ${Push.snoozeMinutes} мин.`;
    }
    throw new HttpError(400, "неизвестная кнопка");
  }

  /** /api/admin/* (admin.ts): состояние и вход по коду — сразу, остальное — только после подтверждённого кода. sid — эта сессия. */
  async function adminApi(u: User, sid: string, m: string, p: string, req: http.IncomingMessage, res: http.ServerResponse, hash: string) {
    if (m === "GET" && p === "/api/admin/state") return { until: await adminUntil(store, sid), telegram: Boolean(deps.adminCode) };
    if (m === "POST" && p === "/api/admin/code") {
      if (!deps.adminCode) throw new HttpError(503, "бот выключен — код некуда прислать");
      const r = await issueAdminCode(store, u, sid, deps.adminCode);
      if (r.wait) throw new HttpError(429, `новый код — через ${r.wait} с`);
      return { sent: true };
    }
    if (m === "POST" && p === "/api/admin/confirm") {
      const b = parseBody(z.object({ code: z.string().trim().regex(/^\d{6}$/, "код — 6 цифр") }), await readJson(req));
      const r = await confirmAdminCode(store, u, sid, b.code);
      if (r.ok) return { until: r.until };
      const msg = { none: "сначала попросите код", expired: "код устарел — попросите новый", locked: "слишком много попыток — попросите новый код", wrong: `неверный код, осталось попыток: ${r.left}` }[r.why];
      throw new HttpError(400, msg);
    }
    if (!(await adminUntil(store, sid))) throw new HttpError(403, "вход в админку не подтверждён");
    if (m === "POST" && p === "/api/admin/leave") {
      await leaveAdmin(store, u, sid);
      previews.drop(hash);
      return { ok: true };
    }
    // Живой показ виджета в «Витрине» (preview.ts): пропуск в cookie до конца входа в админку; новый пропуск — в журнал.
    if (m === "POST" && p === "/api/admin/preview") {
      const until = new Date((await adminUntil(store, sid))!);
      const pass = previews.issue(hash, until);
      if (pass.fresh) await store.addAdminLog(u.id, "preview", "", new Date(), "витрина: живой показ виджета");
      void previewFiles.list().catch(() => {}); // метки — заранее, пока сайт ставит iframe
      res.setHeader("Set-Cookie", previewCookie(pass.key, until, req.headers["x-forwarded-proto"] === "https"));
      return { until: until.toISOString() };
    }
    const days = Number(new URL(req.url ?? "/", "http://local").searchParams.get("days")) || 30;
    if (m === "GET" && p === "/api/admin/overview") return adminOverview(store);
    if (m === "GET" && p === "/api/admin/users") return adminUsers(store);
    if (m === "GET" && p === "/api/admin/spend") return adminSpend(store, days);
    // «Счёт OpenRouter» (openrouter-bill.ts): что насчитал сам OpenRouter за 30 дней UTC, сверка с llm_usage по дням; «Обновить» —
    // с причиной (в журнал админа), не чаще раза в минуту (429). Ключа в ответе нет.
    if (m === "GET" && p === "/api/admin/openrouter") return orBill.view();
    if (m === "POST" && p === "/api/admin/openrouter/refresh") {
      const b = (await readJson(req, 20_000)) as Record<string, unknown> | null;
      const reason = guard(() => accountReason(b?.reason));
      try {
        await orBill.manual(u.id, reason);
      } catch (e) {
        if (e instanceof OpenRouterBillError) throw new HttpError(e.status, e.message);
        throw e;
      }
      return orBill.view();
    }
    if (m === "GET" && p === "/api/admin/audience") return adminAudience(store);
    if (m === "GET" && p === "/api/admin/quality") return adminQualityReport(store, days);
    if (m === "GET" && p === "/api/admin/health") return adminHealth(store);
    // Нагрузка сервера (server-metrics.ts): снимки раз в минуту за ?range=1h|24h|7d (иначе 24h), пик за сутки, «Сколько выдержит».
    if (m === "GET" && p === "/api/admin/health/load") {
      return serverLoad(store, healthRange(new URL(req.url ?? "/", "http://local").searchParams.get("range")), new Date(), { rpm: deps.llmRpm ?? 0 });
    }
    if (m === "GET" && p === "/api/admin/features") return adminFeatures(store);
    // Аналитика (этап 1, admin-analytics.ts): ?report=&days=&step=, неверные — 400; ответ считается раз в 60 с (кэш в памяти).
    if (m === "GET" && p === "/api/admin/analytics") return cachedAnalytics(store, parseAnalyticsQuery(req.url));
    if (m === "GET" && p === "/api/admin/log") return adminJournal(store);
    // Оплаты (billing.ts): список без payload и полного charge_id (хвост — для сверки с Telegram), возврат — с записью в журнал.
    if (m === "GET" && p === "/api/admin/payments") return adminPayments(store);
    // Возврат — и из «Оплат», и из карточки аккаунта (этап 3): причина обязательна (в журнал админа), charge — хвост выбранной оплаты
    // («…12345678»): сервер возвращает только последнюю невозвращённую, выбрана другая — 409 без возврата.
    if (m === "POST" && p === "/api/admin/refund") {
      if (!deps.billing) throw new HttpError(503, "оплата выключена");
      const b = parseBody(z.object({ user_id: z.number().int().positive().max(MAX_ACCOUNT_ID), reason: z.unknown(), charge: z.string().max(20).optional() }), await readJson(req));
      const reason = guard(() => accountReason(b.reason));
      const r = await deps.billing.refund(b.user_id, u.id, { reason, charge: b.charge });
      if (!r.ok) throw new HttpError(409, r.text);
      return r;
    }
    // Аккаунт по номеру (этап 3, admin-account.ts): GET — карточка (только числа), POST …/<действие> — продлить, подарок, лимит на
    // сегодня, заморозить, разморозить; причина обязательна, нет такого #id — 404 (и номер больше int4 — тоже 404, а не ошибка базы).
    const acc = /^\/api\/admin\/account\/(\d{1,12})(?:\/([a-z]+))?$/.exec(p);
    if (acc) {
      const id = Number(acc[1]);
      if (id > MAX_ACCOUNT_ID) throw new HttpError(404, `нет аккаунта #${acc[1]}`);
      if (m === "GET" && !acc[2]) return guardAsync(() => accountCard(store, id));
      if (m === "POST" && acc[2]) {
        const body = await readJson(req, 20_000);
        const tell = deps.billing ? (x: User, text: string) => deps.billing!.notify(x, text, false).then(() => {}) : undefined;
        const cancelSub = deps.billing ? (x: User) => deps.billing!.cancel(x) : undefined;
        const tellChat = deps.billing ? (chat: string, text: string) => deps.billing!.tellChat(chat, text).then(() => {}) : undefined;
        const forget = (x: number) => deps.pipeline.gate?.forget(x);
        return guardAsync(() => accountAction({ store, tell, tellChat, cancelSub, forget }, u, id, acc[2], body));
      }
      throw new HttpError(404, "нет такого адреса");
    }
    // Тестовые аккаунты (admin-tests.ts): список (только #id и числа), создать, ключ для программы на ПК, сбросить к чистому. Причина
    // обязательна; логин с паролем и ключ — один раз в ответе (в журнал не идут); ключ и сброс — только тестовому (иначе 403).
    if (m === "GET" && p === "/api/admin/tests") return testsView(store);
    const tst = /^\/api\/admin\/tests(?:\/(\d{1,12})\/(token|reset))?$/.exec(p);
    if (tst && m === "POST") {
      const body = await readJson(req, 20_000);
      const forget = (x: number) => deps.pipeline.gate?.forget(x);
      if (!tst[1]) return guardAsync(() => createTestAccount({ store }, u, body));
      const id = Number(tst[1]);
      if (id > MAX_ACCOUNT_ID) throw new HttpError(404, `нет аккаунта #${tst[1]}`);
      return guardAsync(() => testAccountAction({ store, forget }, u, id, tst[2], body));
    }
    // Тарифы из базы (tariffs.ts): текущие числа, по умолчанию, история и экономика; «Применить» (причина обязательна) и откат —
    // с проверкой чисел (400), строкой истории и записью в журнал админки.
    if (m === "GET" && p === "/api/admin/tariffs") return tariffsView(store);
    if (m === "POST" && (p === "/api/admin/tariffs" || p === "/api/admin/tariffs/undo")) {
      const b = await readJson(req, 20_000);
      const o = (b && typeof b === "object" ? b : {}) as { values?: unknown; reason?: unknown; id?: unknown };
      try {
        const r = p.endsWith("undo") ? await undoTariff(store, u.id, o.id, o.reason) : await applyTariffs(store, u.id, o.values, o.reason);
        return { id: r.id, changes: r.changes, values: r.values };
      } catch (e) {
        if (e instanceof TariffError) throw new HttpError(e.status, e.message);
        throw e;
      }
    }
    // Оповещения (этап 4, alerts.ts): правила, история, изменение правила (причина обязательна, в журнал админа), «Проверить сейчас»
    // и «Тестовое оповещение» — тоже с причиной.
    if (m === "GET" && p === "/api/admin/alerts") return alerts.view();
    if (m === "POST" && p.startsWith("/api/admin/alerts/")) {
      const b = (await readJson(req, 20_000)) as Record<string, unknown> | null;
      try {
        if (p === "/api/admin/alerts/rule") return await alerts.update(u.id, b);
        if (p === "/api/admin/alerts/check") return await alerts.checkNow(u.id, b?.reason);
        if (p === "/api/admin/alerts/test") return await alerts.test(u.id, b?.reason);
      } catch (e) {
        if (e instanceof AlertError) throw new HttpError(e.status, e.message);
        throw e;
      }
      throw new HttpError(404, "нет такого адреса");
    }
    // Копии базы (этап 4, snapshot.ts DbCopies): последние копии и проверки; «Сделать копию сейчас» и «Проверить восстановление» — с
    // причиной, в журнал админа; одна копия за раз (409).
    if (m === "GET" && p === "/api/admin/backups") return copies.view();
    if (m === "POST" && (p === "/api/admin/backups/run" || p === "/api/admin/backups/verify")) {
      const b = (await readJson(req, 20_000)) as Record<string, unknown> | null;
      const reason = guard(() => accountReason(b?.reason));
      const verify = p.endsWith("verify");
      try {
        const r = verify ? await copies.verify(new Date(), u.id) : await copies.run(new Date(), u.id);
        const what = r.status === "skip" ? "пропущено" : verify ? `${r.status}: ${r.file}` : `${r.status}: ${r.file}, ${r.bytes} Б, в Telegram ${r.sent ? "ушла" : "нет"}`;
        await store.addAdminLog(u.id, verify ? "backup_verify" : "backup_run", what, new Date(), reason);
        return { result: r, ...(await copies.view()) };
      } catch (e) {
        if (e instanceof DbCopyBusy) throw new HttpError(409, e.message);
        throw e;
      }
    }
    // Падения программы на ПК (этап 5, crashes.ts): по версиям, места, по дням (?days=, до 90). Только числа.
    if (m === "GET" && p === "/api/admin/crashes") return adminCrashes(store, days);
    // Поэтапный выпуск (этап 5, releases.ts): настройка, что в latest.yml, люди по версиям; POST — процент или пауза с причиной.
    // «Что нового» (26.11.2026): POST /api/admin/releases/notes { version, notes, reason } — пункты выпуска из истории.
    if (m === "GET" && p === "/api/admin/releases") return releasesView(store, await desktopYml(), new Date(), desktopNotes);
    if (m === "POST" && (p === "/api/admin/releases" || p === "/api/admin/releases/notes")) {
      const b = await readJson(req, 20_000);
      try {
        if (p.endsWith("/notes")) await editNotes(store, u.id, b);
        else await changeRelease(store, u.id, b);
      } catch (e) {
        if (e instanceof ReleaseError) throw new HttpError(e.status, e.message);
        throw e;
      }
      return releasesView(store, await desktopYml(), new Date(), desktopNotes);
    }
    // Этап 6 «Тарифы и управление»: переключатели функций (switches.ts), промокоды (promo.ts), обращения (support.ts), объявления
    // (announce.ts), прогноз (prognosis.ts). Каждое действие — с причиной, сервер пишет его в журнал админа.
    if (m === "GET" && p === "/api/admin/switches") return switchesView(store);
    if (m === "POST" && p === "/api/admin/switches") {
      const b = await readJson(req, 20_000);
      return stage6(() => setSwitch(store, u.id, b));
    }
    if (m === "GET" && p === "/api/admin/promo") return promoView(store);
    if (m === "POST" && (p === "/api/admin/promo" || p === "/api/admin/promo/toggle")) {
      const b = await readJson(req, 20_000);
      return stage6(() => (p.endsWith("toggle") ? togglePromo(store, u.id, b) : createPromo(store, u.id, b)));
    }
    if (m === "GET" && p === "/api/admin/tickets") return ticketsView(store);
    const tk = /^\/api\/admin\/tickets\/(\d{1,10})(?:\/([a-z]+))?$/.exec(p);
    if (tk) {
      const id = Number(tk[1]);
      if (id > MAX_ACCOUNT_ID) throw new HttpError(404, `нет обращения №${tk[1]}`);
      if (m === "GET" && !tk[2]) return stage6(() => ticketCard(store, id));
      if (m === "POST" && tk[2]) {
        const b = await readJson(req, 20_000);
        const tell = deps.billing ? (x: User, text: string) => deps.billing!.notify(x, text, false) : undefined;
        return stage6(() => ticketAction({ store, tell }, u.id, id, tk[2], b));
      }
      throw new HttpError(404, "нет такого адреса");
    }
    if (m === "GET" && p === "/api/admin/announcements") return announcementsView(store);
    if (m === "POST" && (p === "/api/admin/announcements" || p === "/api/admin/announcements/toggle")) {
      const b = await readJson(req, 20_000);
      return stage6(() => (p.endsWith("toggle") ? toggleAnnouncement(store, u.id, b) : createAnnouncement(store, u.id, b)));
    }
    if (m === "GET" && p === "/api/admin/prognosis") return prognosisView(store);
    // Промпты (prompts.ts): список без текстов; карточка — тексты владельца для ИИ (поля body / def / preview); правка — новая версия,
    // выбор — любая версия или «как в коде» (v0). Каждое действие — с причиной в журнал админа (без текста).
    if (m === "GET" && p === "/api/admin/prompts") return promptsView(store);
    const pr = /^\/api\/admin\/prompts\/([a-z][a-z0-9._-]{1,60})(?:\/(save|select))?$/.exec(p);
    if (pr) {
      if (m === "GET" && !pr[2]) return stage6(() => promptCard(store, pr[1]));
      if (m === "POST" && pr[2]) {
        const raw = await readJson(req, 100_000);
        const b = { ...(raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}), id: pr[1] };
        return stage6(() => (pr[2] === "save" ? savePrompt(store, u.id, b) : selectPrompt(store, u.id, b)));
      }
    }
    throw new HttpError(404, "нет такого адреса");
  }

  /** Пропуск живого показа действует: сессия жива, человек не заморожен и админ, вход в админку на этой сессии не кончился. */
  async function previewAllowed(key: string): Promise<boolean> {
    const hash = previews.check(key);
    if (!hash) return false;
    const u = await store.sessionUser(hash);
    const ok = Boolean(u && !u.frozen_at && isAdmin(u, "session") && (await adminUntil(store, hash.slice(0, 16))));
    if (!ok) previews.drop(hash);
    return ok;
  }

  /** latest.yml из папки обновлений (как есть) или null — нет папки или файла. */
  const desktopYml = async () => (deps.desktopDir ? fs.promises.readFile(path.join(deps.desktopDir, "latest.yml"), "utf8").catch(() => null) : null);
  /** «Что нового» выпуска: notes-<версия>.json рядом с latest.yml (tools/release-desktop.py; наружу не отдаётся — serveDesktop берёт
   *  только latest.yml и .exe). Нет файла или он не годится — null. Версия уже проверена (releases.ts ymlVersion). */
  const desktopNotes = async (v: string) =>
    deps.desktopDir ? notesFile((await fs.promises.readFile(path.join(deps.desktopDir, `notes-${v}.json`), "utf8").catch(() => "")) || "null", v) : null;
  /** Выпущенная версия программы (из latest.yml; перечитывается, только когда файл изменился) — падения и дни программы новее неё
   *  не принимаются (crashes.ts versionOk). Нет файла — null (сверять не с чем). */
  let knownYml: { stamp: string; version: string | null } | null = null;
  async function knownDesktopVersion(): Promise<string | null> {
    if (!deps.desktopDir) return null;
    const file = path.join(deps.desktopDir, "latest.yml");
    const st = await fs.promises.stat(file).catch(() => null);
    if (!st?.isFile()) return null;
    const stamp = `${st.mtimeMs}:${st.size}`;
    if (knownYml?.stamp !== stamp) knownYml = { stamp, version: ymlVersion(await fs.promises.readFile(file, "utf8").catch(() => "")) };
    return knownYml.version;
  }

  /** ИИ закрыт (access.ts): нет пробы или подписки — 402 со ссылкой на оплату (не 401: на 401 сайт и программа разлогиниваются);
   *  слишком часто или дневной потолок — 429. extra — что ещё отдать (messageId записанной заметки). */
  async function refuse(u: User, why: Refusal, text: string, extra: Record<string, unknown> = {}): Promise<never> {
    if (why === "access") throw new HttpError(402, text, { pay_url: (await deps.billing?.link(u)) ?? null, ...extra });
    throw new HttpError(429, text, extra);
  }

  /** Цена подписки в блоке «Тариф» (/api/me): у идущей подписки — её цена при оформлении (Telegram продлевает по ней), у остальных —
   *  нынешняя цена новых счетов (tariffs.ts). Идёт ли подписка — по действующему плану a (accessOf), не по plan в базе: срок кончился,
   *  а планировщик ещё не перевёл в free — кнопка «Оформить» ведёт на счёт по нынешней цене, её и показать. */
  async function priceOf(u: User, a: Access): Promise<number> {
    const first = a.plan === "paid" && u.sub_charge_id ? await store.payment(u.sub_charge_id) : undefined;
    return first && first.currency === "XTR" && !first.refunded_at ? first.amount : tariffs().price;
  }

  /** Кто сделал запрос и с какого клиента — для счётчика фич по ручкам API (feature-list.ts api), считается после удачного ответа. */
  const askedBy = new WeakMap<http.IncomingMessage, { user: User; client: string }>();

  async function route(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? "/", "http://local");
    const p = url.pathname;
    const q = (k: string) => url.searchParams.get(k) ?? undefined;
    const m = req.method ?? "GET";
    if (p === "/healthz") return { ok: true }; // проверка живости (Render); /health — экран приложения
    if (p === "/webhook" && m === "POST" && deps.webhook) {
      await deps.webhook(req, res);
      return undefined;
    }
    if (!p.startsWith("/api/")) {
      // Живой показ виджета для «Витрины» админки: только по пропуску (POST /api/admin/preview), иначе 401.
      if (p.startsWith(PREVIEW_PREFIX)) {
        if (m !== "GET") throw new HttpError(404, "нет такого файла");
        if (!(await previewAllowed(previewKey(req.headers.cookie)))) throw new HttpError(401, "нужен вход в админку");
        let rel = "";
        try { rel = decodeURIComponent(p.slice(PREVIEW_PREFIX.length)); } catch { throw new HttpError(404, "нет такого файла"); }
        const inm = req.headers["if-none-match"];
        if (await servePreview(rel, res, previewFiles, { v: url.searchParams.get("v"), inm: Array.isArray(inm) ? inm.join(",") : inm })) return undefined;
        throw new HttpError(404, "нет такого файла");
      }
      if (p.startsWith("/desktop/")) {
        if (m === "GET" && (await serveDesktop(deps.desktopDir ?? "", p, res, (t) => servedYml(store, t, new Date(), desktopNotes).catch((e) => (console.error("[release]", e), t))))) return undefined;
        throw new HttpError(404, "нет такого файла");
      }
      if (m === "GET" && (await serveStatic(deps.webDir ?? "", p, res))) return undefined;
      throw new HttpError(404, "нет такого адреса");
    }

    if (m === "POST" && p === "/api/login") {
      const b = parseBody(
        z.object({ login: z.string().min(1).max(80), password: z.string().min(1).max(200), label: z.string().max(80).optional() }),
        await readJson(req),
      );
      const ip = clientIp(req);
      const wait = gate.wait(ip, b.login);
      if (wait) throw new HttpError(429, `слишком много неудачных попыток, попробуйте через ${Math.ceil(wait / 60_000)} мин`);
      const token = await login(store, b.login, b.password, b.label ?? "web", clientMeta(req.headers));
      if (token && typeof token === "object") {
        gate.passed(ip, b.login);
        throw new HttpError(403, FROZEN_TEXT);
      }
      if (!token) {
        gate.failed(ip, b.login);
        throw new HttpError(401, "неверный логин или пароль");
      }
      gate.passed(ip, b.login);
      return { token };
    }

    // Открытые сведения для экрана входа: какой бот у этого сервера.
    if (m === "GET" && p === "/api/public") return { bot: deps.botName?.() ?? null };

    // Кнопка в push-уведомлении: без входа, по подписи сервера (см. push.ts).
    if (m === "POST" && p === "/api/push/act") {
      if (!deps.push?.ready) throw new HttpError(404, "push выключен");
      const b = parseBody(z.object({ act: z.string().min(1).max(4000), action: z.coerce.number().int().min(0).max(9) }), await readJson(req));
      const a = deps.push.action(b.act, b.action);
      if (!a) throw new HttpError(403, "кнопка устарела");
      const owner = await store.user(a.userId);
      if (!owner) throw new HttpError(404, "нет пользователя");
      const text = await runButton(owner, a.data, a.all);
      countFeature(owner, "push", "push.act"); // кнопка сработала — тогда и в счёт
      return { text };
    }

    const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    // Клиент и версия — из заголовков X-Maid-Client / X-Maid-Version по белому списку (auth.ts clientMeta); IP не храним.
    // Пачка счётчиков уходит и из фоновой вкладки, и при выходе — присутствия она не отмечает (auth.ts quiet).
    const quiet = m === "POST" && (p === "/api/events/usage" || p === "/api/events/crash");
    const auth = await authByToken(store, token, clientMeta(req.headers), { quiet });
    if (!auth) throw new HttpError(401, "нужен вход (логин и пароль) или ключ");
    const u = auth.user;
    enterUser(u.id); // расход ИИ в этом запросе — на счёт этого человека
    noteActive(u.id); // «активных за минуту» для «Здоровья сервера» (server-metrics.ts) — только число
    // Клиент для счётчиков фич: виджет и быстрая запись — «desktop», без заголовка — «other» (feature-events.ts).
    const client = featureClient(clientMeta(req.headers).client);
    askedBy.set(req, { user: u, client });
    // Программа на ПК этой версии была у человека сегодня (crashes.ts desktop_days): база доли людей с падением по версии.
    if (client === "desktop") await noteDesktopDay(store, u, clientMeta(req.headers).version, new Date(), await knownDesktopVersion());
    if (p.startsWith("/api/admin/")) {
      // Не админу (и админу, вошедшему по DESKTOP_TOKEN) — как будто адреса нет.
      if (!isAdmin(u, auth.via)) throw new HttpError(404, "нет такого адреса");
      return adminApi(u, tokenHash(token).slice(0, 16), m, p, req, res, tokenHash(token));
    }

    // Счётчики фич от клиента (этап 3 админки): { client?, counts: { фича: сколько } } раз в 10 минут и при уходе со страницы.
    // Клиент — по заголовку X-Maid-Client (нет — из тела, тоже по белому списку); чаще раза в минуту — 429 (feature-events.ts).
    if (m === "POST" && p === "/api/events/usage") {
      const b = parseBody(z.object({ client: z.string().max(40).optional(), counts: z.record(z.string().max(60), z.number()) }), await readJson(req, 20_000));
      if (Object.keys(b.counts).length > USAGE_MAX_KEYS) throw new HttpError(400, `не больше ${USAGE_MAX_KEYS} фич в пачке`);
      const from = clientMeta(req.headers).client || clientMeta({ "x-maid-client": b.client }).client;
      const r = acceptUsage(u, from, b.counts);
      if (!r.ok) throw new HttpError(429, `счётчики — не чаще раза в минуту, через ${r.wait} с`);
      return r;
    }
    // Падения программы на ПК (этап 5, crashes.ts): { items: [{ version, process, kind, place, fp, count }] } раз в 10 минут и при
    // выходе. Только эти поля и по белому списку (остальное — и текст ошибки, если пришлют, — не берётся); больше CRASH_MAX_ITEMS — 400,
    // чаще раза в минуту — 429.
    if (m === "POST" && p === "/api/events/crash") {
      const b = parseBody(z.object({ items: z.array(z.unknown()).max(CRASH_MAX_ITEMS, `не больше ${CRASH_MAX_ITEMS} записей в пачке`) }), await readJson(req, 50_000));
      const r = await acceptCrashes(store, u, b.items, Date.now(), await knownDesktopVersion());
      if (!r.ok) throw new HttpError(429, `падения — не чаще раза в минуту, через ${r.wait} с`);
      return r;
    }
    if (m === "POST" && p === "/api/logout") {
      await store.dropSession(tokenHash(token));
      return { ok: true };
    }
    const today = dayKey(new Date(), u.tz);
    // Характеры горничной для страницы «Горничная» на сайте: название и примеры фраз (сам промпт — нет).
    if (m === "GET" && p === "/api/personas") {
      return Object.values(PERSONAS).map((x) => ({ id: x.id, name: x.name, samples: [...x.saved.slice(0, 2), x.rate] }));
    }
    if (m === "GET" && p === "/api/me") {
      const { password_hash: _, ...me } = u;
      const mine = tokenHash(token).slice(0, 16);
      const a = pipeline.gate?.access(u) ?? accessOf(u);
      return {
        ...me,
        // Платный доступ (access.ts): план, срок, отменено ли продление, дней пробы — для блока «Подписка» и баннера; today — остаток
        // лимитов в штуках на сегодня и время сброса (друзья, владелец и без доступа — null: без лимита или ИИ закрыт).
        access: { ...accessView(a), price: await priceOf(u, a), today: await todayView(store, u, a) },
        admin: isAdmin(u, auth.via), // пункт «Админка» в меню сайта; сами данные админки — только через /api/admin/* с кодом
        // Тестовый аккаунт (admin-tests.ts): 1 — да, 0 — нет. Программа на ПК принимает ключ из админки только при is_test === 1.
        is_test: Number(u.is_test ?? 0) === 1 ? 1 : 0,
        sessions: (await store.sessionsOf(u.id)).map((s) => ({ ...s, current: s.id === mine })),
      };
    }
    // Подписка (billing.ts): ссылка на оплату в Telegram (сайт — window.open, программа — shell.openExternal) и отмена продления.
    // Работают и без доступа к ИИ: иначе не оплатить.
    if (m === "POST" && p === "/api/billing/link") {
      // Платить не нужно (владелец, друг, подписка и так идёт) — 409 с причиной: вторая подписка списала бы звёзды дважды.
      const why = deps.billing?.payable(u);
      if (why) throw new HttpError(409, why);
      const url = await deps.billing?.link(u);
      if (!url) throw new HttpError(503, "Оплата сейчас недоступна — попробуйте чуть позже.");
      return { url };
    }
    if (m === "POST" && (p === "/api/billing/cancel" || p === "/api/billing/resume")) {
      if (!deps.billing) throw new HttpError(503, "оплата выключена");
      const r = p.endsWith("cancel") ? await deps.billing.cancel(u) : await deps.billing.resume(u);
      if (!r.ok) throw new HttpError(409, r.text);
      return r;
    }
    // Промокод (этап 6, promo.ts): человек вводит код в «Тарифе» — дни добавляются к сроку; перебор — 429.
    if (m === "POST" && p === "/api/promo") {
      const b = parseBody(z.object({ code: z.string().max(40) }), await readJson(req, 2_000));
      return stage6(() => redeemPromo(store, u, b.code));
    }
    // «Написать нам» (этап 6, support.ts): темы, свои обращения и ответы; новое — не больше SUPPORT_PER_DAY в сутки.
    if (m === "GET" && p === "/api/support") return supportOf(store, u);
    if (m === "POST" && p === "/api/support") {
      const b = await readJson(req, 20_000);
      return stage6(() => createTicket(store, u, b));
    }
    // Объявления для плашки сайта (этап 6, announce.ts).
    if (m === "GET" && p === "/api/announcements") return siteAnnouncements(store, u);
    // Расход модели, рисования и голоса: по дням (UTC, все дни подряд — и пустые), по назначениям и моделям за эти дни, итог месяца.
    // Только свой (24.11.2026: раньше любой вошедший видел расход всего сервера; общий — в админке).
    if (m === "GET" && p === "/api/usage") {
      const n = Math.min(90, Math.max(7, Number(q("days")) || 30));
      const utc = new Date().toISOString().slice(0, 10);
      return usageReport(await store.usageDays(addDays(utc, 1 - n), utc, u.id), n, await store.llmUsage(utc.slice(0, 7), u.id), utc);
    }
    // Выйти на другом устройстве (потерянный телефон, старый ПК).
    if (m === "POST" && p === "/api/sessions/drop") {
      const b = parseBody(z.object({ id: z.string().regex(/^[0-9a-f]{16}$/) }), await readJson(req));
      if (!(await store.dropSessionOf(u.id, b.id))) throw new HttpError(404, "нет такого входа");
      return { ok: true, sessions: await store.sessionsOf(u.id) };
    }
    if (m === "POST" && p === "/api/settings") {
      const Time = z.string().refine(isTime, "время ЧЧ:ММ");
      const b = parseBody(z.object({
        name: z.string().trim().max(80).optional(),
        persona: z.string().refine((x) => x in PERSONAS, "нет такого характера").optional(),
        morning_time: Time.optional(), tomorrow_time: Time.optional(),
        // Итог — за этот день, поэтому до полуночи (12:00–23:59): в 00:15 был бы итог только что наступившего дня.
        evening_time: z.string().refine(isEveningTime, "вечерний итог — с 12:00 до 23:59").optional(),
        // Привычки без своего времени: первый вопрос и второй (если не ответили); второй — позже первого, в полночь минус.
        habit_first: Time.optional(), habit_last: Time.optional(),
        event_lead_min: z.coerce.number().int().min(5).max(24 * 60).optional(),
        // «day,60,5,0» — когда напоминать о планах (remindPlan), «off» — никогда.
        event_reminders: z.string().max(200).regex(/^(off|((day|\d{1,5})(,(day|\d{1,5}))*))$/, "day, минуты через запятую или off").optional(),
        game_alerts: z.coerce.number().int().min(0).max(1).optional(),
        game_first_min: z.coerce.number().int().min(15).max(24 * 60).optional(),
        game_every_min: z.coerce.number().int().min(15).max(24 * 60).optional(),
        // «Перекрасить Рину» (look.ts): только id из look.js виджета; Рина узнаёт свой цвет со следующего промпта.
        maid_hair: z.enum(MAID_HAIR, { message: "нет такого цвета" }).optional(),
        maid_eyes: z.enum(MAID_EYES, { message: "нет такого цвета" }).optional(),
        // «Предупредить о дожде за час» (weather.ts rainSoon).
        weather_rain: z.coerce.number().int().min(0).max(1).optional(),
      }), await readJson(req));
      if (b.event_reminders !== undefined) b.event_reminders = remindText(b.event_reminders);
      if ((b.habit_last ?? u.habit_last) <= (b.habit_first ?? u.habit_first)) throw new HttpError(400, "второй вопрос про привычки — позже первого");
      await store.updateUser(u.id, b);
      // Выбрали другой характер — счётчик первого запуска (onboarding.persona, feature-events.ts).
      if (b.persona !== undefined && b.persona !== u.persona) await countPersona(store, u, client);
      const fresh = (await store.user(u.id))!;
      // Сменили, когда напоминать, — напоминания о будущих планах перекладываются заново.
      if (["event_reminders", "event_lead_min", "morning_time"].some((k) => k in b && b[k as keyof typeof b] !== u[k as keyof User])) await replanEvents(fresh);
      const { password_hash: _, ...me } = fresh;
      return me;
    }
    // «Персонализация → О вас»: обращение, город, часовой пояс, подъём, отбой, день рождения, рост (you.ts).
    if (m === "GET" && p === "/api/you") return youView(store, u);
    if (m === "POST" && p === "/api/you") {
      const CityIn = z.object({
        name: z.string().trim().min(1).max(80), region: z.string().max(80).default(""), country: z.string().max(60).default(""),
        lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), tz: z.string().max(64),
      });
      const b = parseBody(z.object({
        address: z.enum(ADDRESSES, { message: "нет такого обращения" }).nullable().optional(),
        name: z.string().max(80).optional(),
        city: CityIn.nullable().optional(),
        tz: z.string().max(64).nullable().optional(),
        wake: z.union([z.number().int(), z.string().max(5)]).nullable().optional(), // «06:30» или час числом (старый виджет)
        bed: z.string().max(5).nullable().optional(),
        birthday: z.string().max(10).optional(),
        height: z.number().nullable().optional(),
      }), await readJson(req));
      let r;
      try { r = await saveYou(store, u, b); } catch (e) { throw new HttpError(400, (e as Error).message); }
      const fresh = (await store.user(u.id))!;
      // Другой часовой пояс — у напоминаний о будущих планах другое время.
      if (r.tzChanged) await replanEvents(fresh);
      return youView(store, fresh);
    }
    // Вопрос облачка показан (виджет) — следующий не раньше чем через 3 дня; ответ кнопкой — как кнопка уведомления.
    if (m === "POST" && p === "/api/you/ask") {
      const b = parseBody(z.object({ field: z.string().max(20) }), await readJson(req));
      return { ok: await askShown(store, u, b.field) };
    }
    if (m === "POST" && p === "/api/you/button") {
      const b = parseBody(z.object({ data: z.string().max(64) }), await readJson(req));
      return { text: await runYou(u, b.data) };
    }
    // Подсказки города: ?q=Каз → до 6 городов с регионом и поясом. Сеть не ответила — 502, на сайте «поиск не отвечает».
    if (m === "GET" && p === "/api/city") {
      try { return await (deps.cities ?? findCities)(q("q") ?? ""); } catch (e) { throw new HttpError(502, (e as Error).message); }
    }
    if (m === "GET" && p === "/api/backup") {
      const data = await exportJson(store, u.id);
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${backupName(u.login)}"`,
      });
      res.end(JSON.stringify(data));
      return undefined;
    }

    // Web Push: ключ, подписка браузера, проверка.
    if (m === "GET" && p === "/api/push/key") return { key: deps.push?.ready ? deps.push.publicKey : "", subs: await store.pushSubsOf(u.id) };
    if (m === "POST" && p === "/api/push/subscribe") {
      if (!deps.push?.ready) throw new HttpError(404, "push выключен: нет ключей VAPID на сервере");
      const b = parseBody(z.object({
        endpoint: z.string().url().max(2000), keys: z.object({ p256dh: z.string(), auth: z.string() }), label: z.string().max(80).optional(),
      }), await readJson(req));
      await store.addPushSub({ endpoint: b.endpoint, userId: u.id, keys: b.keys, label: b.label ?? "web" });
      return { ok: true };
    }
    if (m === "POST" && p === "/api/push/unsubscribe") {
      const b = parseBody(z.object({ endpoint: z.string().max(2000) }), await readJson(req));
      const own = (await store.pushSubsOf(u.id)).some((s) => s.endpoint === b.endpoint);
      if (own) await store.dropPushSub(b.endpoint);
      return { ok: own };
    }
    if (m === "POST" && p === "/api/push/test") {
      if (!deps.push?.ready) throw new HttpError(404, "push выключен");
      if (!switchOn("push")) throw new HttpError(409, switchOffText("push"));
      const sent = await deps.push.send(u, "🔔 Проверка уведомлений\nЕсли вы это видите — всё работает.", "happy",
        (await store.habitsOn(u.id, today)).slice(0, 1).map((h) => habitButtons(h.id, today)[0]));
      return { sent };
    }
    // Лента уведомлений для горничной на ПК: ?after=<id> — только новые; пусто — последние.
    if (m === "GET" && p === "/api/notices") {
      const after = Number(q("after") ?? 0);
      // Объявления «в виджет» (этап 6, announce.ts) — строкой в ленту, один раз. Только когда виджет уже знает, где он в ленте
      // (after > 0): первый опрос лишь запоминает последнее письмо и не показывает его — объявление пропало бы.
      if (after > 0) await deliverToWidget(store, u).catch((e) => console.error("[announce]", (e as Error).message));
      const rows = await store.noticesAfter(u.id, Number.isFinite(after) ? after : 0, after ? 20 : 1);
      // Своих писем ещё нет — первый опрос получает «метку места» (номер последнего письма в ленте вообще, без текста): виджет
      // запоминает её и дальше спрашивает after > 0, поэтому и объявление, и первое обычное письмо он покажет, а не проглотит.
      if (!(after > 0) && !rows.length) {
        const cursor = await store.noticeCursor();
        return cursor > 0 ? [{ id: cursor, user_id: u.id, text: "", emotion: "neutral", buttons: [], at: new Date().toISOString(), kind: "cursor" }] : [];
      }
      return rows.map((r) => ({ ...r, buttons: r.buttons ? (JSON.parse(r.buttons) as Button[]) : [] }));
    }
    // История писем горничной: ?kinds=morning,plan — только этих видов, ?before=<id> — старше этого письма.
    if (m === "GET" && p === "/api/history") {
      const kinds = (q("kinds") ?? "").split(",").filter((k): k is (typeof NOTICE_KINDS)[number] => (NOTICE_KINDS as readonly string[]).includes(k));
      const before = Number(q("before") ?? 0), limit = Number(q("limit") ?? 50);
      return historyOf(store, u.id, { kinds, before: Number.isFinite(before) ? before : 0, limit: Number.isFinite(limit) ? limit : 50 });
    }
    if (m === "GET" && p === "/api/today") return todayJson(store, u);
    // Погода утром (weather.ts): фраза «погода + одно дело», значок и температура, части дня, задетый план. Нет города или
    // прогноза — { weather: null }: утро как раньше.
    if (m === "GET" && p === "/api/weather") return { weather: await weatherFor(store, u) };
    // «Перенести на завтра» в опасную погоду (кнопка облачка виджета); back — «↩ Отменить», вернуть на сегодня.
    if (m === "POST" && p === "/api/weather/move") {
      const b = parseBody(z.object({ eventId: z.number().int(), back: z.boolean().optional() }), await readJson(req));
      const e = await moveToTomorrow(store, u, b.eventId, Boolean(b.back));
      if (!e) throw new HttpError(404, "нет такого плана на сегодня");
      await replanEvents(u);
      deps.pipeline.changed(u);
      return { ok: true, date: e.date_iso, time: e.time };
    }
    // Профиль как в RPG: уровень за дела, характеристики, дебафы и бафы, найденные закономерности.
    if (m === "GET" && p === "/api/profile") return profileView(store, u, today);
    if (m === "POST" && p === "/api/profile") {
      const b = parseBody(z.object({
        title: z.string().trim().max(40).optional(), height: z.number().nullable().optional(), birthday: z.string().max(10).optional(), avatar: z.string().max(AVATAR_MAX * 1.4).optional(),
      }), await readJson(req, 700_000));
      try { await saveProfile(store, u.id, b); } catch (e) { throw new HttpError(400, (e as Error).message); }
      return profileView(store, u, today);
    }
    // Аватар из Steam: ссылка на профиль → его картинка 184×184 становится аватаром (ключ API не нужен).
    if (m === "POST" && p === "/api/profile/steam") {
      const b = parseBody(z.object({ link: z.string().trim().min(2).max(200) }), await readJson(req, 4_000));
      try {
        const s = await steamAvatar(b.link);
        await saveProfile(store, u.id, { avatar: s.avatar, steam: s.steam });
      } catch (e) { throw new HttpError(400, (e as Error).message); }
      return profileView(store, u, today);
    }
    // Альбом реакций: что из анимаций горничной уже видели (виджет шлёт имя при первом показе, сайт рисует альбом).
    if (m === "GET" && p === "/api/album") return { seen: await albumOf(store, u.id), total: ALBUM.length };
    if (m === "POST" && p === "/api/album") {
      const b = parseBody(z.object({ moods: z.array(z.enum(ALBUM)).min(1).max(ALBUM.length) }), await readJson(req));
      return albumSee(store, u.id, b.moods);
    }
    // Оценка дня — звезда (от 1 до 10) под вечерним итогом в виджете.
    if (m === "POST" && p === "/api/rate") {
      const b = parseBody(z.object({
        day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        value: z.number().int().min(1).max(RATE_MAX),
      }), await readJson(req));
      return { text: await rateDay(store, u, b.day, b.value) };
    }
    if (m === "POST" && p === "/api/traits") {
      const b = parseBody(z.object({
        kind: z.enum(["debuff", "buff"]).default("debuff"), category: z.string().max(20).optional(),
        title: z.string().trim().min(1).max(60), note: z.string().trim().max(200).default(""),
      }), await readJson(req));
      const had = sameTrait(await store.traitsOf(u.id), b.title);
      if (had && had.status === "active") throw new HttpError(409, "такой уже есть");
      if (had) await store.updateTrait(had.id, { status: "active", kind: b.kind, category: traitCategory(b.category), note: b.note || had.note });
      else await store.addTrait({ user_id: u.id, kind: b.kind, category: traitCategory(b.category), title: b.title, note: b.note, source: "user", status: "active", evidence: "[]", message_id: null });
      return profileView(store, u, today);
    }
    // Нарисованная картинка (pipeline.drawFor): виджет хранит в переписке только id и догружает её отсюда.
    const drawingRow = p.match(/^\/api\/drawings\/(\d+)$/);
    if (m === "GET" && drawingRow) {
      const d = await store.drawing(Number(drawingRow[1]));
      if (!d || d.user_id !== u.id) throw new HttpError(404, "нет такой картинки");
      return { id: d.id, mime: d.mime, data: d.data, title: d.title, prompt: d.prompt };
    }
    const traitRow = p.match(/^\/api\/traits\/(\d+)$/);
    if (m === "POST" && traitRow) {
      const b = parseBody(z.object({
        status: z.enum(["active", "declined", "removed"]).optional(), title: z.string().trim().min(1).max(60).optional(), note: z.string().trim().max(200).optional(),
      }), await readJson(req));
      const t = await store.trait(Number(traitRow[1]));
      if (!t || t.user_id !== u.id) throw new HttpError(404, "нет такой черты");
      if (t.status === "suggested" && (b.status === "active" || b.status === "declined")) {
        return { text: await decideTrait(store, u, t.id, b.status === "active"), profile: await profileView(store, u, today) };
      }
      await store.updateTrait(t.id, { status: b.status, title: b.title, note: b.note });
      return { text: "", profile: await profileView(store, u, today), trait: traitView({ ...t, ...b } as typeof t) };
    }
    if (m === "GET" && p === "/api/day") {
      const day = q("day") ?? today;
      if (!isDayKey(day)) throw new HttpError(400, "day: YYYY-MM-DD");
      return dayJson(store, u, day);
    }
    if (m === "GET" && p === "/api/diary/days") return store.diaryDayCounts(u.id);
    const diaryRow = p.match(/^\/api\/diary\/(\d+)$/);
    if (m === "DELETE" && diaryRow) {
      const r = await store.diaryRow(Number(diaryRow[1]));
      if (!r || r.user_id !== u.id) throw new HttpError(404, "нет записи");
      await store.setDiaryDeleted(r.id, true);
      return { ok: true };
    }
    // Сон за день вручную (щелчок по дню на шкале сна в «Статистике»): записи «сон» за день и sleep_hours уходят в удалённые,
    // вместо них — одна запись «лёг в …, встал в …» (её же читают шкала, вечерний итог и горничная) и часы сна; clear — только убрать.
    if (m === "POST" && p === "/api/sleep") {
      const At = z.string().transform((s, ctx) => normalizeTime(s) ?? (ctx.addIssue({ code: "custom", message: "время ЧЧ:ММ" }), z.NEVER));
      const b = parseBody(z.object({
        day: z.string().refine((d) => isDayKey(d) && d <= today, "день — не позже сегодня"),
        bed: At.optional(), wake: At.optional(), note: z.string().trim().max(300).default(""), clear: z.boolean().default(false),
      }).refine((x) => x.clear || (x.bed && x.wake), "нужны «лёг» и «встал»"), await readJson(req));
      for (const r of await store.diaryOf(u.id, b.day)) if (r.section === "sleep") await store.setDiaryDeleted(r.id, true);
      for (const x of await store.metricsRange(u.id, b.day, b.day, "sleep_hours")) await store.setMetricDeleted(x.id, true);
      if (b.clear) return { day: b.day, hours: 0 };
      const clock = (t: string) => t.replace(/^0(\d)/, "$1");
      const h = (t: string) => Number(t.slice(0, 2)) + Number(t.slice(3)) / 60;
      const hours = Math.round((((h(b.wake!) - h(b.bed!) + 24) % 24) || 24) * 100) / 100;
      await store.addDiary(u.id, b.day, "sleep", `лёг в ${clock(b.bed!)}, встал в ${clock(b.wake!)}${b.note ? `. ${b.note}` : ""}`, null);
      await store.setDayMetric({ user_id: u.id, day_key: b.day, key: "sleep_hours", label: "Сон", value: hours, unit: "ч", source: "manual" });
      return { day: b.day, bed: b.bed, wake: b.wake, hours };
    }
    // Перетащить сон на другой день (полоса на шкале сна в «Статистике», 27.11.2026): у to сна нет — сон from переезжает туда,
    // есть — сон двух дней меняется местами. Записи «сон» и sleep_hours не переписываются, а только перекладываются на другой
    // день (day_key) — текст, заметка и число остаются как были. Журнал отмены: «↩ Отменить» возвращает оба дня.
    if (m === "POST" && p === "/api/sleep/swap") {
      const Day = z.string().refine((d) => isDayKey(d) && d <= today, "день — не позже сегодня");
      const b = parseBody(z.object({ from: Day, to: Day }).refine((x) => x.from !== x.to, "дни должны быть разными"), await readJson(req));
      const rowsOf = async (day: string) => ({
        diary: (await store.diaryOf(u.id, day)).filter((r) => r.section === "sleep"),
        metrics: await store.metricsRange(u.id, day, day, "sleep_hours"),
      });
      const [a, c] = [await rowsOf(b.from), await rowsOf(b.to)];
      if (!a.diary.length && !a.metrics.length) throw new HttpError(400, "в этот день сна нет");
      const swapped = c.diary.length > 0 || c.metrics.length > 0;
      const undo = await pipeline.manual(u, `😴 Сон ${shortDay(b.from)} ${swapped ? "⇄" : "→"} ${shortDay(b.to)}`, async (log) => {
        const move = async (r: typeof a, from: string, to: string) => {
          for (const x of r.diary) { await log("diary", x.id, { day_key: from }); await store.updateDiary(x.id, { day_key: to }); }
          for (const x of r.metrics) { await log("metrics", x.id, { day_key: from }); await store.updateMetric(x.id, { day_key: to }); }
        };
        await move(a, b.from, b.to);
        await move(c, b.to, b.from);
      });
      return { from: b.from, to: b.to, swapped, undo };
    }
    if (m === "GET" && p === "/api/tasks") return store.openTasks(u.id);
    // Корзина: удалённые и отменённые задачи и планы за TRASH_DAYS дней. Вернуть — POST /api/tasks/:id {status:"open"}
    // или POST /api/events/:id {status:"active"} (как «↩ Вернуть» после удаления).
    if (m === "GET" && p === "/api/trash") {
      const since = new Date(Date.now() - TRASH_DAYS * 86_400_000).toISOString();
      return { days: TRASH_DAYS, tasks: await store.trashTasks(u.id, since), events: await store.trashEvents(u.id, since), notes: await store.trashNotes(u.id, since), dates: await store.trashDates(u.id, since) };
    }
    // Поиск по задачам и планам (экран «Поиск»): все слова запроса — в названии, заметках или подробностях, без учёта регистра и «ё».
    // Ищет и в корзине (удалённое/отменённое за TRASH_DAYS дней, inTrash); удалённое навсегда (purged) и давно удалённое — нет.
    if (m === "GET" && p === "/api/search") {
      const words = norm(q("q") ?? "").split(/\s+/).filter(Boolean).slice(0, 8);
      if (!words.length) return { tasks: [], events: [], notes: [], days: TRASH_DAYS };
      const since = new Date(Date.now() - TRASH_DAYS * 86_400_000).toISOString();
      const hit = (...texts: (string | null)[]) => { const t = norm(texts.filter(Boolean).join(" ")); return words.every((w) => t.includes(w)); };
      const binned = (status: string, at: string | null) => status === "deleted" || status === "cancelled" ? (at && at >= since ? "trash" : "gone") : "";
      const tasks = (await store.allTasks(u.id))
        .filter((t) => t.status !== "purged" && hit(t.title, t.notes))
        .map((t) => ({ ...t, bin: binned(t.status, t.closed_at ?? null) }))
        .filter((t) => t.bin !== "gone")
        .sort((x, y) => (x.status === "open" ? 0 : 1) - (y.status === "open" ? 0 : 1) || y.id - x.id)
        .slice(0, 60);
      const events = (await store.allEvents(u.id))
        .filter((e) => e.status !== "purged" && e.status !== "tasked" && hit(e.title, e.details)) // ставший задачей — ищется задачей
        .map((e) => ({ ...e, bin: binned(e.status, (e as { updated_at?: string }).updated_at ?? null) }))
        .filter((e) => e.bin !== "gone")
        .sort((x, y) => (x.date_iso >= today ? 0 : 1) - (y.date_iso >= today ? 0 : 1)
          || (x.date_iso >= today ? x.date_iso.localeCompare(y.date_iso) : y.date_iso.localeCompare(x.date_iso)))
        .slice(0, 60);
      // Заметки «на потом»: по названию и пометке; лежащие на полке — первыми.
      const notes = (await store.allNotes(u.id))
        .filter((n) => n.status !== "purged" && hit(n.title, n.note))
        .map((n) => ({ ...n, bin: binned(n.status, n.closed_at) }))
        .filter((n) => n.bin !== "gone")
        .sort((x, y) => (x.status === "open" ? 0 : 1) - (y.status === "open" ? 0 : 1) || y.id - x.id)
        .slice(0, 60);
      return { tasks, events, notes, days: TRASH_DAYS };
    }
    // «Удалить навсегда» (× у строки) и «Очистить корзину» (all): из корзины пропадают, вернуть уже нельзя.
    if (m === "POST" && p === "/api/trash/purge") {
      const Ids = z.array(z.number().int().positive()).max(500);
      const b = parseBody(z.object({ all: z.literal(true).optional(), tasks: Ids.optional(), events: Ids.optional(), notes: Ids.optional(), dates: Ids.optional() }), await readJson(req));
      if (!b.all && !b.tasks && !b.events && !b.notes && !b.dates) throw new HttpError(400, "нужно all, tasks, events, notes или dates");
      const since = new Date(Date.now() - TRASH_DAYS * 86_400_000).toISOString();
      return store.purgeTrash(u.id, since, b.all ? undefined : { tasks: b.tasks ?? [], events: b.events ?? [], notes: b.notes ?? [], dates: b.dates ?? [] });
    }

    // Заметки «на потом» (экран «Заметки»): полки и всё, что на них лежит или отмечено готовым. Удалённые — в корзине.
    if (m === "GET" && p === "/api/notes") {
      return { shelves: SHELF_KEYS.map((key) => ({ key, title: SHELVES[key], rated: RATED_SHELVES.includes(key) })), notes: await store.notesOf(u.id) };
    }
    // Новая заметка строкой на экране: название как есть, полка — выбранная вкладка. Отменяется («↩ Отменить»).
    // На этой полке уже лежит такая же — новая не создаётся, приходит та с duplicate.
    if (m === "POST" && p === "/api/notes") {
      const b = parseBody(z.object({ title: z.string().trim().min(1).max(NOTE_TITLE_MAX), shelf: ShelfKey.optional(), note: z.string().trim().max(NOTE_TEXT_MAX).optional() }), await readJson(req));
      const shelf = b.shelf ?? "other";
      const same = (await store.notesOf(u.id)).find((n) => n.status === "open" && n.shelf === shelf && sameNote(n.title, b.title));
      if (same) return { ...same, duplicate: true };
      let id = 0;
      const undo = await pipeline.manual(u, `📌 ${b.title}`, async (log) => {
        id = await store.addNote({ user_id: u.id, shelf, title: b.title, note: b.note ?? "", message_id: null });
        await log("notes", id, { status: "deleted" });
      });
      return { ...(await store.note(id)), undo };
    }
    // Правка заметки: готово (done, с оценкой rating 1–10 или без), вернуть на полку (open), удалить (deleted — в корзину),
    // переложить (shelf), переименовать, пометка. Отменяется, как правка задачи.
    const noteRow = p.match(/^\/api\/notes\/(\d+)$/);
    if (m === "POST" && noteRow) {
      const b = parseBody(z.object({
        status: z.enum(["open", "done", "deleted"]).optional(), shelf: ShelfKey.optional(), title: z.string().trim().min(1).max(NOTE_TITLE_MAX).optional(),
        note: z.string().trim().max(NOTE_TEXT_MAX).optional(), rating: z.number().int().min(1).max(10).nullable().optional(),
      }), await readJson(req));
      const n = await store.note(Number(noteRow[1]));
      if (!n || n.user_id !== u.id || n.status === "purged") throw new HttpError(404, "нет заметки");
      if (!Object.keys(b).length) throw new HttpError(400, "нужно status, shelf, title, note или rating");
      const what = b.status === "deleted" ? "🗑" : b.status === "done" ? "✓" : b.status === "open" ? "↺" : "✎";
      const undo = await pipeline.manual(u, `${what} ${n.title}`, async (log) => {
        await log("notes", n.id, { status: n.status, shelf: n.shelf, title: n.title, note: n.note, rating: n.rating });
        // Вернули на полку — оценка снимается: она была за «готово».
        await store.updateNote(n.id, b.status === "open" && b.rating === undefined ? { ...b, rating: null } : b);
      });
      return { ...(await store.note(n.id)), undo };
    }

    // ?all=1 — все даты с ближайшим наступлением (в течение года), иначе ближайшие 30 дней.
    if (m === "GET" && p === "/api/dates") {
      const within = q("all") ? 366 : 30;
      return upcomingDates(await store.activeDates(u.id), today, within).map((d) => ({ ...d.row, on: d.on, inDays: d.inDays, age: d.age, year_known: yearKnown(d.row) }));
    }
    // Дата руками (сайт, «Планы» → «Даты»): день и месяц, год — если известен (для возраста). Без года — год записи
    // (как у дат, записанных словами; возраст тогда не считается), разовая без года — ближайшее наступление. Отменяется.
    const DateFields = { title: z.string().trim().min(1).max(200), month: z.number().int().min(1).max(12), day: z.number().int().min(1).max(31),
      year: z.number().int().min(1900).max(2200).nullable(), type: z.enum(["birthday", "anniversary", "holiday", "deadline", "other"]), yearly: z.boolean() };
    const dateIso = (month: number, dd: number, year: number | null, yearly: boolean, base: number) => {
      const md = `${String(month).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
      if (year !== null) return isDayKey(`${year}-${md}`) ? `${year}-${md}` : null;
      // Без года: с года base вперёд — первый, где такой день есть (29 февраля — ближайший високосный); разовая — не в прошлом.
      for (let y = !yearly && `${base}-${md}` < today ? base + 1 : base; y < base + 8; y++) if (isDayKey(`${y}-${md}`)) return `${y}-${md}`;
      return null;
    };
    const dateOut = async (id: number, undo: number) => { const d = (await store.date(id))!; return { ...d, year_known: yearKnown(d), undo }; };
    if (m === "POST" && p === "/api/dates") {
      const b = parseBody(z.object(DateFields), await readJson(req));
      const iso = dateIso(b.month, b.day, b.year, b.yearly, Number(today.slice(0, 4)));
      if (!iso) throw new HttpError(400, "нет такого дня");
      let id = 0;
      const undo = await pipeline.manual(u, `📅 ${b.title}`, async (log) => {
        id = await store.addDate({ user_id: u.id, title: b.title, date_iso: iso, type: b.type, person: "", notes: "", yearly: b.yearly ? 1 : 0, message_id: null });
        await log("dates", id, { status: "deleted" });
      });
      return dateOut(id, undo);
    }
    // Правка даты: название, день (month + day + year вместе), вид, «каждый год», удалить (deleted — в корзину) или вернуть (active).
    const dateRow = p.match(/^\/api\/dates\/(\d+)$/);
    if (m === "POST" && dateRow) {
      const b = parseBody(z.object({
        title: DateFields.title.optional(), month: DateFields.month.optional(), day: DateFields.day.optional(), year: DateFields.year.optional(),
        type: DateFields.type.optional(), yearly: DateFields.yearly.optional(), status: z.enum(["active", "deleted"]).optional(),
      }), await readJson(req));
      const d = await store.date(Number(dateRow[1]));
      if (!d || d.user_id !== u.id || d.status === "purged") throw new HttpError(404, "нет даты");
      if (!Object.keys(b).length) throw new HttpError(400, "нужно title, month и day, type, yearly или status");
      const patch: Partial<Pick<DateRow, "title" | "date_iso" | "type" | "yearly" | "status">> = {};
      if (b.title !== undefined) patch.title = b.title;
      if (b.type !== undefined) patch.type = b.type;
      if (b.yearly !== undefined) patch.yearly = b.yearly ? 1 : 0;
      if (b.status !== undefined) patch.status = b.status;
      if (b.month !== undefined || b.day !== undefined) {
        if (b.month === undefined || b.day === undefined) throw new HttpError(400, "день и месяц — вместе");
        // Год не указан — как было у даты без года: год её записи.
        const iso = dateIso(b.month, b.day, b.year ?? null, b.yearly ?? Boolean(d.yearly), Number((d.created_at ?? today).slice(0, 4)));
        if (!iso) throw new HttpError(400, "нет такого дня");
        patch.date_iso = iso;
      }
      const what = b.status === "deleted" ? "🗑" : b.status === "active" ? "↺" : "✎";
      const undo = await pipeline.manual(u, `${what} ${d.title}`, async (log) => {
        await log("dates", d.id, { title: d.title, date_iso: d.date_iso, type: d.type, yearly: d.yearly, status: d.status });
        await store.updateDate(d.id, patch);
      });
      return dateOut(d.id, undo);
    }
    // Иконки программ и игр: { ключ: data-URL }; ключ — iconKey(имя).
    if (m === "GET" && p === "/api/icons") return Object.fromEntries((await store.icons(u.id)).map((i) => [i.name_key, `data:image/png;base64,${i.png}`]));
    if (m === "GET" && p === "/api/activity") return store.activityRange(u.id, q("from") ?? addDays(today, -30), q("to") ?? today);
    if (m === "GET" && p === "/api/events") return store.eventsBetween(u.id, q("from") ?? today, q("to") ?? addDays(today, 30));
    // Новая задача строкой «+ Новая задача» на «Сегодня»: название как есть, без разбора моделью. Отменяется («↩ Отменить»).
    if (m === "POST" && p === "/api/tasks") {
      const b = parseBody(z.object({ title: z.string().trim().min(1).max(200), due_date: Day.nullable().optional() }), await readJson(req));
      let id = 0;
      const undo = await pipeline.manual(u, `＋ ${b.title}`, async (log) => {
        id = await store.addTask({ user_id: u.id, title: b.title, priority: "normal", category: "", due_date: b.due_date ?? null, notes: "", message_id: null });
        await log("tasks", id, { status: "deleted" });
      });
      return { ...(await store.task(id)), undo };
    }
    // Новый план кнопкой «+ план на день» в панели планов виджета: название как есть, день, время (если задали). Отменяется («↩ Отменить»).
    if (m === "POST" && p === "/api/events") {
      const Time = z.string().refine(isTime, "время ЧЧ:ММ");
      const b = parseBody(z.object({
        title: z.string().trim().min(1).max(200), date: Day.optional(), time: Time.nullable().optional(), end_time: Time.nullable().optional(),
      }), await readJson(req));
      if (b.end_time && !b.time) throw new HttpError(400, "end_time — только вместе с time");
      if (b.time && b.end_time && b.end_time <= b.time) throw new HttpError(400, "конец раньше начала");
      let id = 0;
      const undo = await pipeline.manual(u, `＋ ${b.title}`, async (log) => {
        id = await store.addEvent({
          user_id: u.id, title: b.title, date_iso: b.date ?? today, time: b.time ?? null, end_time: b.time ? b.end_time ?? null : null,
          details: "", domain: "life", message_id: null,
        });
        await log("events", id, { status: "deleted" });
        await planEventReminders(store, u, (await store.event(id))!, new Date());
      });
      return { ...(await store.event(id))!, undo };
    }
    const task = p.match(/^\/api\/tasks\/(\d+)$/);
    if (m === "POST" && task) {
      // Разбор хвостов в виджете: failed — «не буду делать», dodged — закрыл крестиком, не ответив (сбежал от задачи);
      // обе закрывают задачу невыполненной; deleted — удалить задачу (ПКМ или × на карточке). due_date — перенос на день.
      const b = parseBody(z.object({ status: z.enum(["open", "done", "cancelled", "failed", "dodged", "deleted"]).optional(), due_date: Day.optional(), title: z.string().trim().min(1).max(200).optional() }), await readJson(req));
      const t = await store.task(Number(task[1]));
      if (!t || t.user_id !== u.id) throw new HttpError(404, "нет задачи");
      if (!b.status && !b.due_date && !b.title) throw new HttpError(400, "нужно status, due_date или title");
      // В журнал отмены: «Отменить» (и «Вернуть» после удаления) откатывает правку мышью.
      const what = b.status === "deleted" ? "🗑" : b.status === "done" ? "✓" : b.status || b.title ? "✎" : "↪";
      const undo = await pipeline.manual(u, `${what} ${t.title}`, async (log) => {
        await log("tasks", t.id, { status: t.status, due_date: t.due_date, title: t.title });
        await store.updateTask(t.id, b);
      });
      return { ...(await store.task(t.id)), undo };
    }

    // Задача становится планом (ПКМ по задаче в виджете → «Задать время» или «Повторять…»): план с тем же названием на её день
    // (или date), задача закрывается статусом planned. Ответ — новый план; time/end_time — сразу со временем (одним шагом),
    // иначе время и повтор виджет ставит ему следом, как обычному плану.
    const taskPlan = p.match(/^\/api\/tasks\/(\d+)\/plan$/);
    if (m === "POST" && taskPlan) {
      const Time = z.string().refine(isTime, "время ЧЧ:ММ");
      const { date, time, end_time } = parseBody(z.object({ date: Day.optional(), time: Time.optional(), end_time: Time.nullable().optional() }), await readJson(req));
      if (end_time && !time) throw new HttpError(400, "end_time — только вместе с time");
      if (time && end_time && end_time <= time) throw new HttpError(400, "конец раньше начала");
      const t = await store.task(Number(taskPlan[1]));
      if (!t || t.user_id !== u.id) throw new HttpError(404, "нет задачи");
      if (t.status !== "open") throw new HttpError(409, "задача уже закрыта");
      const id = await store.addEvent({
        user_id: u.id, title: t.title, date_iso: date ?? t.due_date ?? today, time: time ?? null, end_time: time ? end_time ?? null : null, details: t.notes,
        domain: "life", message_id: t.message_id,
      });
      await store.updateTask(t.id, { status: "planned" });
      await store.cancelReminders("task", t.id);
      const made = (await store.event(id))!;
      await planEventReminders(store, u, made, new Date());
      pipeline.changed(u);
      return made;
    }

    // План становится задачей (у плана убрали время в виджете): открытая задача с тем же названием на его день, план закрывается
    // статусом tasked — не «отменён» и не в корзине. Ответ — новая задача.
    const evTask = p.match(/^\/api\/events\/(\d+)\/task$/);
    if (m === "POST" && evTask) {
      const e = await store.event(Number(evTask[1]));
      if (!e || e.user_id !== u.id) throw new HttpError(404, "нет плана");
      if (e.status !== "active") throw new HttpError(409, "план уже закрыт");
      let id = 0;
      // «↩ Вернуть» откатывает: план снова в планах со своим временем, задача — в удалённые.
      const undo = await pipeline.manual(u, `↪ ${e.title}`, async (log) => {
        id = await store.addTask({
          user_id: u.id, title: e.title, priority: "normal", category: "", due_date: e.date_iso, notes: e.details ?? "", message_id: e.message_id,
        });
        await log("tasks", id, { status: "deleted" });
        await log("events", e.id, { status: e.status });
        await store.updateEvent(e.id, { status: "tasked" });
        await store.cancelReminders("event", e.id);
      });
      return { ...(await store.task(id)), undo };
    }

    // Копия задачи на другой день (ПКМ → «Копия на завтра» или перетащили с Ctrl): такая же открытая задача со сроком date.
    // На том дне уже есть открытая с тем же названием — новая не создаётся, приходит та с duplicate.
    const taskCopy = p.match(/^\/api\/tasks\/(\d+)\/copy$/);
    if (m === "POST" && taskCopy) {
      const { date } = parseBody(z.object({ date: Day }), await readJson(req));
      const t = await store.task(Number(taskCopy[1]));
      if (!t || t.user_id !== u.id) throw new HttpError(404, "нет задачи");
      const same = (await store.openTasks(u.id)).find((x) => x.title === t.title && x.due_date === date);
      if (same) return { ...same, duplicate: true };
      const id = await store.addTask({
        user_id: u.id, title: t.title, priority: t.priority, category: t.category, due_date: date, notes: t.notes, message_id: t.message_id,
      });
      pipeline.changed(u);
      return store.task(id);
    }

    // План (событие): состоялся / отменён / снова в планах — из списка планов виджета; date — перенос на день (перетащили на день в полосе);
    // time и end_time — сдвиг по времени (потянули время на карточке), end_time: null — без конца; time: null — убрать время (и конец).
    const ev = p.match(/^\/api\/events\/(\d+)$/);
    if (m === "POST" && ev) {
      const Time = z.string().refine(isTime, "время ЧЧ:ММ");
      const b = parseBody(z.object({
        status: z.enum(["active", "done", "cancelled"]).optional(),
        date: Day.optional(),
        time: Time.nullable().optional(),
        end_time: Time.nullable().optional(),
        title: z.string().trim().min(1).max(200).optional(),
      }), await readJson(req));
      if (!b.status && !b.date && b.time === undefined && !b.title) throw new HttpError(400, "нужно status, date, time или title");
      if (b.end_time !== undefined && !b.time) throw new HttpError(400, "end_time — только вместе с time");
      if (b.time && b.end_time && b.end_time <= b.time) throw new HttpError(400, "конец раньше начала");
      const e = await store.event(Number(ev[1]));
      if (!e || e.user_id !== u.id) throw new HttpError(404, "нет плана");
      const what = b.status === "done" ? "✓" : b.status === "cancelled" ? "✕" : b.status || b.title ? "✎" : "↪";
      const undo = await pipeline.manual(u, `${what} ${e.title}`, async (log) => {
        await log("events", e.id, { status: e.status, date_iso: e.date_iso, time: e.time, end_time: e.end_time, title: e.title });
        await store.updateEvent(e.id, {
          ...(b.title ? { title: b.title } : {}),
          ...(b.status ? { status: b.status } : {}),
          ...(b.date ? { date_iso: b.date } : {}),
          ...(b.time ? { time: b.time, end_time: b.end_time ?? null } : {}),
          ...(b.time === null ? { time: null, end_time: null } : {}),
        });
        await store.cancelReminders("event", e.id);
        const now = (await store.event(e.id))!;
        if (now.status === "active") await planEventReminders(store, u, now, new Date());
      });
      return { ...(await store.event(e.id))!, undo };
    }

    // Повтор плана (ПКМ по плану в виджете → окно настройки): repeat — настройка (repeat.ts) или null — перестать повторять.
    // Ответ: dates — даты созданных копий (горничная показывает их пупырками), endless — без конца (дальше досоздаются сами).
    const evRepeat = p.match(/^\/api\/events\/(\d+)\/repeat$/);
    if (m === "POST" && evRepeat) {
      const { repeat } = parseBody(z.object({ repeat: RepeatSpec.nullable() }), await readJson(req));
      const e = await store.event(Number(evRepeat[1]));
      if (!e || e.user_id !== u.id) throw new HttpError(404, "нет плана");
      const r = await setRepeat(store, u, e, repeat, today);
      pipeline.changed(u);
      return r;
    }

    // Копия плана на другой день (перетащили карточку плана на день в полосе виджета): то же время, длительность, описание.
    // На том дне уже есть такой же (название и время) — новый не создаётся, приходит тот с duplicate.
    const evCopy = p.match(/^\/api\/events\/(\d+)\/copy$/);
    if (m === "POST" && evCopy) {
      const { date } = parseBody(z.object({ date: Day }), await readJson(req));
      const e = await store.event(Number(evCopy[1]));
      if (!e || e.user_id !== u.id) throw new HttpError(404, "нет плана");
      const same = (await store.eventsBetween(u.id, date, date)).find((x) => x.title === e.title && x.time === e.time);
      if (same) return { ...same, duplicate: true };
      const id = await store.addEvent({ user_id: u.id, title: e.title, date_iso: date, time: e.time, end_time: e.end_time, details: e.details, domain: e.domain, message_id: null });
      const made = (await store.event(id))!;
      await planEventReminders(store, u, made, new Date());
      pipeline.changed(u);
      return made;
    }

    // Привычки: сетка месяца и отметка.
    if (m === "GET" && p === "/api/habits") {
      const month = q("month") ?? today.slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(month)) throw new HttpError(400, "month: YYYY-MM");
      // ask — общее время вопросов из настроек: у привычки без своего времени — оно, и «ещё раз» в last, если не отмечена.
      // finished — «Завершённые» (habits.ts habitFinished): их нет в сетке месяца, карточкой с итогом за весь срок.
      return {
        month, today: await habitsOfDay(store, u, today), habits: await habitMonth(store, u, month, today), finished: await finishedHabits(store, u, today),
        ask: { first: u.habit_first, last: u.habit_last },
      };
    }
    // Статистика одной привычки: год клетками, серии, процент за 30/90 дней и всё время, по дням недели и месяцам.
    const stats = p.match(/^\/api\/habits\/(\d+)\/stats$/);
    if (m === "GET" && stats) {
      const h = await store.habit(Number(stats[1]));
      if (!h || h.user_id !== u.id) throw new HttpError(404, "нет привычки");
      return habitStats(store, u, h, today);
    }
    const mark = p.match(/^\/api\/habits\/(\d+)\/mark$/);
    if (m === "POST" && mark) {
      // later — прежнее «Ещё нет» (виджеты до второго шага «Позже»): отметки нет, вопрос придёт снова (pipeline.habitLater).
      // step (шаг 42): 1 — ещё одна отметка, -1 — снять последнюю (или пропуск); вместо status. У ×N и status done — одна отметка.
      const b = parseBody(z.object({
        status: z.enum(["done", "skipped", "later"]).default("done"), day: Day.optional(), step: z.union([z.literal(1), z.literal(-1)]).optional(),
      }), await readJson(req));
      // Удалённую, завершённую (день после конца) и день до начала не отметить — сайту ошибка 409 с текстом (markRefusal), и «Ещё нет» тоже.
      const h = await store.habit(Number(mark[1]));
      const refused = h && h.user_id === u.id ? markRefusal(h, b.day ?? today) : null;
      if (refused) throw new HttpError(409, refused);
      if (b.step === undefined && b.status === "later") return { text: await pipeline.habitLater(u, Number(mark[1]), b.day ?? today) };
      const text = await pipeline.markHabit(u, Number(mark[1]), b.day ?? today, b.step ?? (b.status as "done" | "skipped"), "web");
      // Что теперь у дня: count из need, status — закрыт ли день (null — не отмечен или отмечено не всё).
      const now = h && h.user_id === u.id ? (await store.marksOf(u.id, b.day ?? today, b.day ?? today)).find((x) => x.habit_id === h.id) : undefined;
      const need = h ? perDayOf(h) : 1;
      return { text, count: dayCount(now, need), need, status: markClosed(now) ? now!.status : null };
    }
    // «⏰ Позже» в виджете: GET — что можно выбрать сейчас (в поясе человека: у виджета его нет), POST — отложить вопрос.
    // Чужая, удалённая, завершённая, уже отмеченная или не сегодняшний день — 409 с текстом; POST: не позже, чем сейчас, за 00:00,
    // сегодня не по расписанию или тихая — тоже 409.
    const snoozeAt = p.match(/^\/api\/habits\/(\d+)\/snooze$/);
    if (snoozeAt && (m === "GET" || m === "POST")) {
      const id = Number(snoozeAt[1]);
      const h = await store.habit(id);
      if (m === "GET") {
        const day = q("day") ?? today;
        if (!isDayKey(day)) throw new HttpError(400, "day: YYYY-MM-DD");
        const refused = !h || h.user_id !== u.id ? "Нет такой привычки." : markRefusal(h, day);
        if (refused) throw new HttpError(409, refused);
        if ((await store.marksOf(u.id, day, day)).some((x) => x.habit_id === id && markClosed(x))) throw new HttpError(409, `${h!.title} — уже отмечено.`);
        // Вчерашний вопрос (виджет хранит его до утра) или будущий день — 409 с текстом, как у POST: виджет скажет его, а не уйдёт в /mark later.
        const gone = snoozeDayRefusal(day, today);
        if (gone) throw new HttpError(409, gone);
        return snoozeOptions(u, day, new Date());
      }
      const Time = z.string().refine(isTime, "время ЧЧ:ММ");
      const b = parseBody(
        z.object({ day: Day.optional(), in: z.number().int().min(1).max(1440).optional(), at: Time.optional() })
          .refine((x) => (x.in === undefined) !== (x.at === undefined), "нужно in (минут) или at (ЧЧ:ММ)"),
        await readJson(req),
      );
      const r = await pipeline.habitSnooze(u, id, b.day ?? today, b.in !== undefined ? { in: b.in } : { at: b.at! });
      if (!r.ok) throw new HttpError(409, r.text);
      return { text: r.text, at: r.at };
    }

    // Снять отметку дня («Сегодня» на сайте: галочку поставили по ошибке). Отменяется («↩ Отменить» вернёт отметку).
    const unmark = p.match(/^\/api\/habits\/(\d+)\/unmark$/);
    if (m === "POST" && unmark) {
      const b = parseBody(z.object({ day: Day.optional() }), await readJson(req));
      const h = await store.habit(Number(unmark[1]));
      if (!h || h.user_id !== u.id) throw new HttpError(404, "нет привычки");
      const day = b.day ?? today;
      const was = (await store.marksOf(u.id, day, day)).find((x) => x.habit_id === h.id);
      if (!was) return { undo: null };
      const undo = await pipeline.manual(u, `↩ ${h.title}: отметка снята`, async (log) => {
        await store.deleteMark(was.id);
        await log("habit_marks", was.id, was);
      });
      return { undo };
    }

    // Правка привычки мышью (ПКМ в виджете, сайт): title — переименовать, quiet — без напоминаний и вечерних вопросов,
    // finish — завершить (habits.ts finishPatch: конец — сегодня, если сегодня уже отмечена, иначе вчера; уходит в «Завершённые»
    // со всеми отметками; уже завершённую — не трогает, undo null), reopen — «↺ Вернуть» из «Завершённых» (reopenPatch),
    // status stopped — удалить (пропадает отовсюду, отметки в базе остаются); times — время напоминаний (пусто — общее из настроек:
    // habit_first и habit_last). Всё через журнал отмены.
    const habitEdit = p.match(/^\/api\/habits\/(\d+)$/);
    if (m === "POST" && habitEdit) {
      const b = parseBody(z.object({
        title: z.string().trim().min(1).max(200).optional(), quiet: z.boolean().optional(),
        times: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "время ЧЧ:ММ")).max(4).optional(), finish: z.literal(true).optional(),
        reopen: z.literal(true).optional(), status: z.enum(["active", "stopped"]).optional(),
        // Сколько раз в день (шаг 42): сегодняшняя отметка пересчитывается, прошлые дни — как были.
        per_day: z.number().int().min(1).max(12).optional(),
      }), await readJson(req));
      const h = await store.habit(Number(habitEdit[1]));
      if (!h || h.user_id !== u.id) throw new HttpError(404, "нет привычки");
      if (!b.title && b.quiet === undefined && !b.times && !b.finish && !b.reopen && !b.status && b.per_day === undefined) throw new HttpError(400, "нужно title, quiet, times, finish, reopen, status или per_day");
      const finish = b.finish ? await finishPatch(store, h, today) : null;
      const patch = {
        ...(b.title ? { title: b.title } : {}),
        ...(b.quiet !== undefined ? { quiet: b.quiet ? 1 : 0 } : {}),
        ...(b.times ? { times: JSON.stringify([...new Set(b.times)].sort()) } : {}),
        ...(finish ?? {}),
        ...(b.reopen ? reopenPatch(h, today) : {}),
        ...(b.status ? { status: b.status } : {}),
        ...(b.per_day !== undefined && b.per_day !== perDayOf(h) ? { per_day: b.per_day } : {}),
      };
      // Завершить уже завершённую — ничего не делать (и не писать в журнал): повтор не продлевает срок.
      if (!Object.keys(patch).length) return { ...h, undo: null };
      const what = b.status === "stopped" ? "🗑" : finish ? "🏁" : b.reopen ? "↺" : b.times && !b.title ? "🔔" : "✎";
      const undo = await pipeline.manual(u, `${what} ${h.title}`, async (log) => {
        await log("habits", h.id, habitBefore(h));
        // Пересчитанные сменой per_day отметки — в журнал после привычки: отмена вернёт их как были (в любой день).
        for (const r of await store.updateHabit(h.id, patch, today)) await log("habit_marks", r.id, r);
      });
      return { ...(await store.habit(h.id)), undo };
    }

    // Деньги и показатели за период.
    if (m === "GET" && p === "/api/money") {
      const rows = await store.moneyRange(u.id, q("from") ?? addDays(today, -30), q("to") ?? today);
      return { rows, totals: moneyTotals(rows) };
    }
    if (m === "GET" && p === "/api/metrics") {
      return {
        known: METRICS,
        keys: await store.metricKeys(u.id),
        rows: await store.metricsRange(u.id, q("from") ?? addDays(today, -30), q("to") ?? today, q("key")),
      };
    }
    // Шаги с айфона (Быстрые команды): {steps, day?}. Одно значение на день — повтор заменяет.
    if (m === "POST" && p === "/api/steps") {
      const b = parseBody(z.object({ steps: z.coerce.number().int().min(0).max(200_000), day: Day.optional() }), await readJson(req));
      const day = b.day ?? today;
      await store.setDayMetric({ user_id: u.id, day_key: day, key: "steps", label: "Шаги", value: b.steps, unit: "", source: "iphone" });
      return { day, steps: b.steps };
    }

    // Дневник и поиск (здоровье — по подразделам).
    if (m === "GET" && p === "/api/diary") {
      return searchDiary(store, u, { section: q("section"), topic: q("topic"), text: q("q"), from: q("from"), to: q("to") });
    }
    if (m === "GET" && p === "/api/health/topics") {
      const used = await store.diaryTopics(u.id, "health");
      // Пустой подраздел — записи до подразделов (перенос из Excel) и те, где модель его не назвала.
      return used.map((t) => ({ ...t, name: t.topic ? HEALTH_TOPICS[t.topic] ?? t.topic : "Без подраздела" }));
    }

    if (m === "POST" && p === "/api/input") {
      // images — картинки (чеки, билеты…) в base64, до IMAGE_MAX_COUNT; image — одна (старые клиенты); text тогда — подпись, может быть пустой.
      const pic = z.object({ data: z.string().min(1), mime: z.enum(IMAGE_TYPES as [string, ...string[]]) });
      const b = parseBody(
        z.object({
          text: z.string().trim().max(4000).default(""),
          id: z.string().max(80).optional(),
          ask: z.boolean().optional(),
          image: pic.optional(),
          images: z.array(pic).max(IMAGE_MAX_COUNT).optional(),
        }),
        await readJson(req, Math.ceil(IMAGES_MAX_BYTES * 1.4) + 20_000),
      );
      const images = [...(b.images ?? []), ...(b.image ? [b.image] : [])];
      if (!b.text && !images.length) throw new HttpError(400, "пустое сообщение");
      if (images.length > IMAGE_MAX_COUNT) throw new HttpError(400, `не больше ${IMAGE_MAX_COUNT} картинок`);
      const sizes = images.map((i) => Buffer.byteLength(i.data, "base64"));
      if (sizes.some((n) => n > IMAGE_MAX_BYTES) || sizes.reduce((a, n) => a + n, 0) > IMAGES_MAX_BYTES) throw new HttpError(413, "слишком большая картинка");
      const r = await pipeline.handle({ user: u, source: "desktop", sourceId: b.id ?? crypto.randomUUID(), text: b.text, chatOnly: b.ask, images: images.length ? images : undefined, client });
      // ИИ закрыт — текст уже записан заметкой (pipeline.ts blocked): клиенту — 402/429 с номером сообщения.
      if (r.blocked) return refuse(u, r.blocked, r.text, { messageId: r.messageId, saved: r.undoable });
      return r;
    }
    // Голосовое сообщение: аудио в base64 → текст → как обычная запись. heard — что услышали.
    if (m === "POST" && p === "/api/voice") {
      const b = parseBody(
        z.object({
          audio: z.string().min(1), mime: z.string().max(80).default("audio/webm"), id: z.string().max(80).optional(),
          // Длительность записи в секундах (сайт присылает с 24.11.2026; виджет 0.1.92 — нет: тогда по размеру, voice.ts voiceSeconds).
          sec: z.number().min(0).max(3600).optional(),
        }),
        await readJson(req, Math.ceil(VOICE_MAX_BYTES * 1.4)),
      );
      const audio = Buffer.from(b.audio, "base64");
      if (audio.length > VOICE_MAX_BYTES) throw new HttpError(413, "слишком длинная запись");
      // Повтор доставки (виджет не дождался ответа и шлёт тот же id): уже разобранное — прежний ответ, без второго списания и без
      // второго платного распознавания; ещё идёт — ждём его итог (pipeline.inFlight).
      const sourceId = b.id ?? crypto.randomUUID();
      const known = await pipeline.delivered(u, "desktop", sourceId);
      if (known) return known;
      const { value, again } = await pipeline.inFlight(`voice:${u.id}:desktop:${sourceId}`, async () => {
        // Распознавание — тоже ИИ (и платное, даже если услышали тишину): доступ, частота и потолок — до него. Частота отмечена здесь,
        // разбор ниже второй раз её не считает (gated). saved: false — голос нигде не записан (виджет оставит его в очереди).
        // Лимит в штуках (access.ts): голосовое — один запрос к ИИ и его секунды; сбой распознавания — взятое возвращается.
        const v = await pipeline.gate?.check(u, { client, take: { calls: 1, voiceSec: voiceSeconds(audio.length, b.sec, isOpusMime(b.mime)) } });
        if (v && !v.ok) return refuse(u, v.why, v.why === "rate" ? RATE_AGAIN : v.text, { saved: false });
        // Клиенту — своя фраза и код сбоя, не текст ошибки: в нём бывает тело ответа провайдера (оно — только в журнале сервера).
        const heard = await transcribe(audio, b.mime).catch(async (e) => {
          if (v?.ok) await pipeline.gate?.refund(u, v.taken);
          console.error("[voice]", e);
          const code = llmErrorCode(e);
          throw new HttpError(502, code === "no_key" ? "распознавание речи не настроено на сервере" : `не получилось распознать голос (${code}), попробуйте ещё раз`);
        });
        // Слов нет — чаще всего записалась тишина: микрофон выключен (на наушниках) или выбран не тот.
        if (!heard) throw new HttpError(422, "Ничего не услышала. Проверьте свой микрофон — может, он выключен на наушниках или выбран не тот.");
        const r = await pipeline.handle({ user: u, source: "desktop", sourceId, text: heard.slice(0, 4000), client, gated: true });
        if (r.blocked) return refuse(u, r.blocked, r.text, { messageId: r.messageId, saved: r.undoable, heard });
        return { ...r, heard };
      });
      return again ? { ...value, duplicate: true } : value;
    }
    // Вопрос «добавить?» из ответа: action remind / add / decline, picked — отмеченные пункты. GET — его состояние
    // (приложение убирает кнопки, если ответили в Telegram).
    const prop = p.match(/^\/api\/proposals\/(\d+)$/);
    if (prop && m === "GET") {
      const row = await store.proposal(Number(prop[1]));
      if (!row || row.user_id !== u.id) throw new HttpError(404, "нет вопроса");
      return proposalView(row);
    }
    if (prop && m === "POST") {
      const b = parseBody(z.object({ action: z.enum(["remind", "add", "decline"]), picked: z.array(z.number().int().min(0)).max(20).optional() }), await readJson(req));
      return pipeline.decideProposal(u, Number(prop[1]), b.action, b.picked);
    }
    const again = p.match(/^\/api\/messages\/(\d+)\/(retry|note)$/);
    if (again && m === "POST") {
      if (again[2] === "retry") {
        const r = await pipeline.retry(u, Number(again[1]), new Date(), client);
        if (r.blocked) return refuse(u, r.blocked, r.text, { messageId: r.messageId, saved: r.undoable });
        return r;
      }
      return { text: await pipeline.asNote(u, Number(again[1])) };
    }
    // Ответ на «Сдвинуть на …?» (план лёг на занятое время) — те же shift / keep, что у кнопок Telegram.
    if (m === "POST" && p === "/api/clash") {
      const b = parseBody(
        z.object({ messageId: z.number().int(), eventId: z.number().int(), withId: z.number().int(), action: z.enum(["shift", "keep"]) }),
        await readJson(req),
      );
      return pipeline.decideClash(u, b.messageId, b.eventId, b.withId, b.action);
    }
    if (m === "POST" && p === "/api/undo") {
      const b = parseBody(z.object({ messageId: z.number().int().optional() }), await readJson(req));
      return { text: await pipeline.undo(u, b.messageId) };
    }
    // Поправка к ответу (строка «поправить этот ответ…» под облачком виджета): text меняет только записи ответа messageId
    // (correct.ts). id — от клиента: повтор с тем же id вернёт прежний итог без второй записи.
    if (m === "POST" && p === "/api/correct") {
      const b = parseBody(
        z.object({ messageId: z.number().int(), text: z.string().trim().min(1).max(500), id: z.string().min(1).max(80).optional() }),
        await readJson(req),
      );
      const r = await pipeline.correct(u, b.messageId, b.text, { sourceId: b.id ?? crypto.randomUUID(), client });
      if (!r) throw new HttpError(404, "нет такого ответа");
      if (r.blocked) return refuse(u, r.blocked, r.text, { messageId: r.messageId });
      return r;
    }
    if (m === "POST" && p === "/api/icons") {
      const b = parseBody(IconsInput, await readJson(req));
      for (const i of b.icons) {
        if (!iconKey(i.name)) continue;
        if (i.png) await store.setIcon(u.id, iconKey(i.name), i.png);
        else await store.dropIcon(u.id, iconKey(i.name));
      }
      return { saved: b.icons.length };
    }
    if (m === "POST" && p === "/api/activity") {
      const b = parseBody(ActivityInput, await readJson(req));
      return recordActivity(store, u, b, deps.send);
    }
    throw new HttpError(404, "нет такого адреса");
  }

  return http.createServer(async (req, res) => {
    // Запросы в минуту, время ответа и 5xx для «Здоровья сервера» (server-metrics.ts): две метки времени на запрос, без адресов.
    // По close, а не finish: оборванный клиентом до конца ответа (таймаут, закрытая вкладка) finish не получает, а close — всегда.
    const t0 = performance.now();
    res.once("close", () => noteHttp(performance.now() - t0, res.statusCode, !res.writableFinished));
    try {
      const out = await route(req, res);
      // Удачный запрос к ручке-фиче — ещё одно использование (в памяти, в базу — пачкой раз в минуту). Повтор того же
      // сообщения (/api/input, /api/voice с прежним id после обрыва связи: разбор ответил duplicate) — не в счёт.
      const who = askedBy.get(req);
      const used = who && featureOfApi(req.method ?? "GET", new URL(req.url ?? "/", "http://local").pathname);
      const again = typeof out === "object" && out !== null && "messageId" in out && (out as { duplicate?: boolean }).duplicate === true;
      if (who && used && !again) countFeature(who.user, who.client, used);
      if (out === undefined) return;
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(out));
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error("[api]", e);
      if (!res.headersSent) res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: e instanceof HttpError ? e.message : "ошибка сервера", ...(e instanceof HttpError ? e.extra : {}) }));
    }
  });
}

/** Сумма расхода: запросы, токены, доллары; priced — сколько запросов пришло с ценой. */
export interface UsageSum { calls: number; input: number; output: number; cost: number; priced: number }
const noUsage = (): UsageSum => ({ calls: 0, input: 0, output: 0, cost: 0, priced: 0 });
const addTo = (a: UsageSum, r: UsageSum) => {
  a.calls += r.calls; a.input += r.input; a.output += r.output; a.cost += r.cost; a.priced += r.priced;
};

/** Отчёт для страницы «Расход»: каждый из n последних дней (до сегодня, UTC), назначения и модели — дороже выше. */
export function usageReport(rows: UsageRow[], n: number, month: UsageSum, today = new Date().toISOString().slice(0, 10)) {
  const days = Array.from({ length: n }, (_, i) => ({ day: addDays(today, i - n + 1), ...noUsage(), kinds: {} as Record<string, number> }));
  const byDay = new Map(days.map((d) => [d.day, d]));
  const kinds = new Map<string, UsageSum>();
  const models = new Map<string, UsageSum>();
  const total = noUsage();
  for (const r of rows) {
    const d = byDay.get(r.day);
    if (!d) continue;
    addTo(d, r);
    d.kinds[r.kind] = (d.kinds[r.kind] ?? 0) + r.cost;
    if (!kinds.has(r.kind)) kinds.set(r.kind, noUsage());
    addTo(kinds.get(r.kind)!, r);
    if (!models.has(r.model)) models.set(r.model, noUsage());
    addTo(models.get(r.model)!, r);
    addTo(total, r);
  }
  const rank = <K extends string>(m: Map<string, UsageSum>, key: K) =>
    [...m].map(([k, v]) => ({ [key]: k, ...v }) as Record<K, string> & UsageSum).sort((a, b) => b.cost - a.cost || b.calls - a.calls);
  return { from: days[0].day, to: today, days, total, kinds: rank(kinds, "kind"), models: rank(models, "model"), month };
}
