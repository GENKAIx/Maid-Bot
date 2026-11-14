import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { z } from "zod";
import { login, LoginGate, tokenHash, userByToken } from "./auth.ts";
import type { Store, UsageRow, User } from "./db.ts";
import { ActivityInput, IconsInput, iconKey, recordActivity } from "./activity.ts";
import { habitMonth, habitsOfDay, habitStats } from "./habits.ts";
import { HEALTH_TOPICS, METRICS } from "./parse.ts";
import { proposalView, TRASH_DAYS, type Pipeline } from "./pipeline.ts";

/** Для поиска: нижний регистр, «ё» как «е». */
const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е");
import { backupName, exportJson } from "./backup.ts";
import { Push } from "./push.ts";
import { RepeatSpec, setRepeat } from "./repeat.ts";
import { moneyTotals, upcomingDates } from "./report.ts";
import { decideTrait, profileView, saveProfile, sameTrait, steamAvatar, traitCategory, traitView, AVATAR_MAX } from "./profile.ts";
import { habitButtons, planEventReminders, remindText, snooze, type Button, type Send } from "./scheduler.ts";
import { addDays, dayKey, isDayKey, isEveningTime, isTime, zonedToUtc } from "./time.ts";
import { transcribe, VOICE_MAX_BYTES } from "./voice.ts";
import { enterUser, IMAGE_MAX_BYTES, IMAGE_MAX_COUNT, IMAGE_TYPES, IMAGES_MAX_BYTES } from "./llm.ts";

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
  push?: Push;
  /** Имя Telegram-бота без @ (ссылка на экране входа); нет бота — undefined. */
  botName?: () => string | undefined;
  /** Счётчик неудачных входов (тесты подставляют свой). */
  loginGate?: LoginGate;
}

class HttpError extends Error {
  constructor(public status: number, msg: string) {
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
    upcoming: await store.eventsBetween(u.id, addDays(today, 1), addDays(today, 14)),
    // Далёкие (дальше upcoming) планы, добавленные или изменённые за 15 минут: виджет ПК едет к их дню, откуда бы их ни записали.
    far_fresh: await store.eventsChangedSince(u.id, addDays(today, 14), new Date(now.getTime() - FAR_FRESH_MS).toISOString()),
    // Планы, отменённые или удалённые за 15 минут (откуда угодно): виджет ПК едет к их дню и показывает, как запись уходит.
    gone_fresh: await store.eventsClosedSince(u.id, today, new Date(now.getTime() - FAR_FRESH_MS).toISOString()),
    // Отмеченные сделанными за 15 минут (в чате, в Telegram, с телефона): виджет ПК ставит им галочку на их дне.
    done_fresh: await store.eventsClosedSince(u.id, today, new Date(now.getTime() - FAR_FRESH_MS).toISOString(), ["done"]),
    tasks: await store.openTasks(u.id),
    // Сделанные сегодня (где угодно: виджет, телефон, Telegram) — виджет показывает их внизу и считает в настроение дня.
    done_today: (await store.doneTasksBetween(u.id, zonedToUtc(today, "00:00", u.tz), zonedToUtc(addDays(today, 1), "00:00", u.tz)))
      .map((t) => ({ id: t.id, title: t.title, done_at: t.done_at })),
    dates: upcomingDates(await store.activeDates(u.id), today, 30).map((d) => ({ ...d.row, on: d.on, inDays: d.inDays, age: d.age })),
  };
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml",
  ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
};

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
    if (path.extname(safe)) return false;
    file = path.join(dir, "index.html");
    st = await statOf(file);
    if (!st) return false;
  }
  const ext = path.extname(file).toLowerCase();
  const immutable = /\/assets\//.test(file.replace(/\\/g, "/"));
  res.writeHead(200, {
    "Content-Type": MIME[ext] ?? "application/octet-stream",
    "Content-Length": st.size,
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  });
  await new Promise<void>((ok, fail) => fs.createReadStream(file).on("error", fail).on("end", ok).pipe(res));
  return true;
}

/** Обновление программы для ПК: только latest.yml и установщики из папки, без подпапок и без index.html.
 *  Открыто без входа — в установщике нет ничего личного, а программа проверяет обновления до входа. */
export async function serveDesktop(dir: string, pathname: string, res: http.ServerResponse): Promise<boolean> {
  const name = pathname.slice("/desktop/".length);
  if (!dir || !/^(latest\.yml|[\w.-]+\.exe)$/.test(name) || name.startsWith(".")) return false;
  const file = path.join(dir, name);
  const st = await fs.promises.stat(file).catch(() => null);
  if (!st?.isFile()) return false;
  res.writeHead(200, {
    "Content-Type": name.endsWith(".yml") ? "text/yaml; charset=utf-8" : "application/octet-stream",
    "Content-Length": st.size,
    "Cache-Control": "no-cache",
  });
  await new Promise<void>((ok, fail) => fs.createReadStream(file).on("error", fail).on("end", ok).pipe(res));
  return true;
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
  const gate = deps.loginGate ?? new LoginGate();

  /** Кнопка из уведомления (push): отметка привычки или «отложить» — то же, что callback в боте. */
  async function runButton(u: User, data: string, all: string[]): Promise<string> {
    const HABIT = /^habit:(\d+):(\d{4}-\d{2}-\d{2}):(done|skipped|later)$/;
    const habit = data.match(HABIT);
    if (habit?.[3] === "later") return pipeline.habitLater(u, Number(habit[1]), habit[2]);
    if (habit) return pipeline.markHabit(u, Number(habit[1]), habit[2], habit[3] as "done" | "skipped", "push");
    const trait = data.match(/^trait:(\d+):(yes|no)$/);
    if (trait) return decideTrait(store, u, Number(trait[1]), trait[2] === "yes");
    if (data === "snooze") {
      const buttons: Button[] = all.filter((d) => d !== "snooze").map((d) => {
        const h = d.match(HABIT);
        return { text: h ? (h[3] === "done" ? "✅ Да" : h[3] === "later" ? "⏳ Ещё нет" : "✖ Нет") : d, data: d };
      });
      const first = buttons[0]?.data.match(HABIT);
      const title = first ? (await store.habit(Number(first[1])))?.title : undefined;
      await snooze(store, u, title ? `🔁 Напоминаю: ${title}` : "🔔 Напоминаю", buttons, Push.snoozeMinutes);
      return `Напомню через ${Push.snoozeMinutes} мин.`;
    }
    throw new HttpError(400, "неизвестная кнопка");
  }

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
      if (p.startsWith("/desktop/")) {
        if (m === "GET" && (await serveDesktop(deps.desktopDir ?? "", p, res))) return undefined;
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
      const token = await login(store, b.login, b.password, b.label ?? "web");
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
      return { text: await runButton(owner, a.data, a.all) };
    }

    const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const u = await userByToken(store, token);
    if (!u) throw new HttpError(401, "нужен вход (логин и пароль) или ключ");
    enterUser(u.id); // расход ИИ в этом запросе — на счёт этого человека

    if (m === "POST" && p === "/api/logout") {
      await store.dropSession(tokenHash(token));
      return { ok: true };
    }
    const today = dayKey(new Date(), u.tz);
    if (m === "GET" && p === "/api/me") {
      const { password_hash: _, ...me } = u;
      const mine = tokenHash(token).slice(0, 16);
      return {
        ...me,
        sessions: (await store.sessionsOf(u.id)).map((s) => ({ ...s, current: s.id === mine })),
      };
    }
    // Расход модели, рисования и голоса: по дням (UTC, все дни подряд — и пустые), по назначениям и моделям за эти дни, итог месяца.
    if (m === "GET" && p === "/api/usage") {
      const n = Math.min(90, Math.max(7, Number(q("days")) || 30));
      const utc = new Date().toISOString().slice(0, 10);
      return usageReport(await store.usageDays(addDays(utc, 1 - n), utc), n, await store.llmUsage(utc.slice(0, 7)), utc);
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
        persona: z.string().max(40).optional(),
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
      }), await readJson(req));
      if (b.event_reminders !== undefined) b.event_reminders = remindText(b.event_reminders);
      if ((b.habit_last ?? u.habit_last) <= (b.habit_first ?? u.habit_first)) throw new HttpError(400, "второй вопрос про привычки — позже первого");
      await store.updateUser(u.id, b);
      const fresh = (await store.user(u.id))!;
      // Сменили, когда напоминать, — напоминания о будущих планах перекладываются заново.
      if (["event_reminders", "event_lead_min", "morning_time"].some((k) => k in b && b[k as keyof typeof b] !== u[k as keyof User])) {
        const at = new Date(), today = dayKey(at, fresh.tz);
        for (const e of await store.eventsBetween(u.id, today, addDays(today, 400))) {
          if (!e.time) continue;
          await store.cancelReminders("event", e.id);
          await planEventReminders(store, fresh, e, at);
        }
      }
      const { password_hash: _, ...me } = fresh;
      return me;
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
      const sent = await deps.push.send(u, "🔔 Проверка уведомлений\nЕсли вы это видите — всё работает.", "happy",
        (await store.habitsOn(u.id, today)).slice(0, 1).map((h) => habitButtons(h.id, today)[0]));
      return { sent };
    }
    // Лента уведомлений для горничной на ПК: ?after=<id> — только новые; пусто — последние.
    if (m === "GET" && p === "/api/notices") {
      const after = Number(q("after") ?? 0);
      const rows = await store.noticesAfter(u.id, Number.isFinite(after) ? after : 0, after ? 20 : 1);
      return rows.map((r) => ({ ...r, buttons: r.buttons ? (JSON.parse(r.buttons) as Button[]) : [] }));
    }
    if (m === "GET" && p === "/api/today") return todayJson(store, u);
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
    if (m === "GET" && p === "/api/tasks") return store.openTasks(u.id);
    // Корзина: удалённые и отменённые задачи и планы за TRASH_DAYS дней. Вернуть — POST /api/tasks/:id {status:"open"}
    // или POST /api/events/:id {status:"active"} (как «↩ Вернуть» после удаления).
    if (m === "GET" && p === "/api/trash") {
      const since = new Date(Date.now() - TRASH_DAYS * 86_400_000).toISOString();
      return { days: TRASH_DAYS, tasks: await store.trashTasks(u.id, since), events: await store.trashEvents(u.id, since) };
    }
    // Поиск по задачам и планам (экран «Поиск»): все слова запроса — в названии, заметках или подробностях, без учёта регистра и «ё».
    // Ищет и в корзине (удалённое/отменённое за TRASH_DAYS дней, inTrash); удалённое навсегда (purged) и давно удалённое — нет.
    if (m === "GET" && p === "/api/search") {
      const words = norm(q("q") ?? "").split(/\s+/).filter(Boolean).slice(0, 8);
      if (!words.length) return { tasks: [], events: [], days: TRASH_DAYS };
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
      return { tasks, events, days: TRASH_DAYS };
    }
    // «Удалить навсегда» (× у строки) и «Очистить корзину» (all): из корзины пропадают, вернуть уже нельзя.
    if (m === "POST" && p === "/api/trash/purge") {
      const Ids = z.array(z.number().int().positive()).max(500);
      const b = parseBody(z.object({ all: z.literal(true).optional(), tasks: Ids.optional(), events: Ids.optional() }), await readJson(req));
      if (!b.all && !b.tasks && !b.events) throw new HttpError(400, "нужно all, tasks или events");
      const since = new Date(Date.now() - TRASH_DAYS * 86_400_000).toISOString();
      return store.purgeTrash(u.id, since, b.all ? undefined : { tasks: b.tasks ?? [], events: b.events ?? [] });
    }

    // ?all=1 — все даты с ближайшим наступлением (в течение года), иначе ближайшие 30 дней.
    if (m === "GET" && p === "/api/dates") {
      const within = q("all") ? 366 : 30;
      return upcomingDates(await store.activeDates(u.id), today, within).map((d) => ({ ...d.row, on: d.on, inDays: d.inDays, age: d.age }));
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
      return { month, today: await habitsOfDay(store, u, today), habits: await habitMonth(store, u, month), ask: { first: u.habit_first, last: u.habit_last } };
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
      // later — «Ещё нет»: отметки нет, вопрос придёт снова (pipeline.habitLater).
      const b = parseBody(z.object({ status: z.enum(["done", "skipped", "later"]).default("done"), day: Day.optional() }), await readJson(req));
      if (b.status === "later") return { text: await pipeline.habitLater(u, Number(mark[1]), b.day ?? today) };
      return { text: await pipeline.markHabit(u, Number(mark[1]), b.day ?? today, b.status, "web") };
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

    // Правка привычки мышью (ПКМ в виджете): title — переименовать, quiet — без напоминаний и вечерних вопросов,
    // finish — закончить (end_date — сегодня, если сегодня уже отмечена, иначе вчера: в истории остаётся со всеми отметками),
    // status stopped — удалить (пропадает отовсюду, отметки в базе остаются); times — время напоминаний (пусто — общее из настроек:
    // habit_first и habit_last). Всё через журнал отмены.
    const habitEdit = p.match(/^\/api\/habits\/(\d+)$/);
    if (m === "POST" && habitEdit) {
      const b = parseBody(z.object({
        title: z.string().trim().min(1).max(200).optional(), quiet: z.boolean().optional(),
        times: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "время ЧЧ:ММ")).max(4).optional(), finish: z.literal(true).optional(), status: z.enum(["active", "stopped"]).optional(),
      }), await readJson(req));
      const h = await store.habit(Number(habitEdit[1]));
      if (!h || h.user_id !== u.id) throw new HttpError(404, "нет привычки");
      if (!b.title && b.quiet === undefined && !b.times && !b.finish && !b.status) throw new HttpError(400, "нужно title, quiet, times, finish или status");
      const marked = (await store.marksOf(u.id, today, today)).some((x) => x.habit_id === h.id);
      const patch = {
        ...(b.title ? { title: b.title } : {}),
        ...(b.quiet !== undefined ? { quiet: b.quiet ? 1 : 0 } : {}),
        ...(b.times ? { times: JSON.stringify([...new Set(b.times)].sort()) } : {}),
        ...(b.finish ? { end_date: marked ? today : addDays(today, -1) } : {}),
        ...(b.status ? { status: b.status } : {}),
      };
      const what = b.status === "stopped" ? "🗑" : b.finish ? "⏸" : b.times && !b.title ? "🔔" : "✎";
      const undo = await pipeline.manual(u, `${what} ${h.title}`, async (log) => {
        await log("habits", h.id, { status: h.status, title: h.title, end_date: h.end_date, quiet: h.quiet ?? 0, times: h.times });
        await store.updateHabit(h.id, patch);
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
      return pipeline.handle({ user: u, source: "desktop", sourceId: b.id ?? crypto.randomUUID(), text: b.text, chatOnly: b.ask, images: images.length ? images : undefined });
    }
    // Голосовое сообщение: аудио в base64 → текст → как обычная запись. heard — что услышали.
    if (m === "POST" && p === "/api/voice") {
      const b = parseBody(
        z.object({ audio: z.string().min(1), mime: z.string().max(80).default("audio/webm"), id: z.string().max(80).optional() }),
        await readJson(req, Math.ceil(VOICE_MAX_BYTES * 1.4)),
      );
      const audio = Buffer.from(b.audio, "base64");
      if (audio.length > VOICE_MAX_BYTES) throw new HttpError(413, "слишком длинная запись");
      const heard = await transcribe(audio, b.mime).catch((e) => {
        throw new HttpError(502, `не получилось распознать: ${(e as Error).message}`);
      });
      if (!heard) throw new HttpError(422, "ничего не расслышала");
      const r = await pipeline.handle({ user: u, source: "desktop", sourceId: b.id ?? crypto.randomUUID(), text: heard.slice(0, 4000) });
      return { ...r, heard };
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
      if (again[2] === "retry") return pipeline.retry(u, Number(again[1]));
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
    if (m === "POST" && p === "/api/icons") {
      const b = parseBody(IconsInput, await readJson(req));
      for (const i of b.icons) if (iconKey(i.name)) await store.setIcon(u.id, iconKey(i.name), i.png);
      return { saved: b.icons.length };
    }
    if (m === "POST" && p === "/api/activity") {
      const b = parseBody(ActivityInput, await readJson(req));
      return recordActivity(store, u, b, deps.send);
    }
    throw new HttpError(404, "нет такого адреса");
  }

  return http.createServer(async (req, res) => {
    try {
      const out = await route(req, res);
      if (out === undefined) return;
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(out));
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error("[api]", e);
      if (!res.headersSent) res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: e instanceof HttpError ? e.message : "ошибка сервера" }));
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
