import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { z } from "zod";
import { login, tokenHash, userByToken } from "./auth.ts";
import type { Store, User } from "./db.ts";
import { ActivityInput, IconsInput, iconKey, recordActivity } from "./activity.ts";
import { habitMonth, habitsOfDay } from "./habits.ts";
import { HEALTH_TOPICS, METRICS } from "./parse.ts";
import type { Pipeline } from "./pipeline.ts";
import { backupName, exportJson } from "./backup.ts";
import { Push } from "./push.ts";
import { moneyTotals, upcomingDates } from "./report.ts";
import { habitButtons, planEventReminders, snooze, type Button, type Send } from "./scheduler.ts";
import { addDays, dayKey, isDayKey, isTime } from "./time.ts";
import { transcribe, VOICE_MAX_BYTES } from "./voice.ts";

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
  push?: Push;
  /** Имя Telegram-бота без @ (ссылка на экране входа); нет бота — undefined. */
  botName?: () => string | undefined;
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
      start: d.habit.start_date, end: d.habit.end_date, course: d.course, yesterday: d.yesterday,
    })),
    metrics: await store.metricsRange(u.id, day, day),
    money: await store.moneyRange(u.id, day, day),
    activity: await store.activityOf(u.id, day),
  };
}

export async function todayJson(store: Store, u: User, now = new Date()) {
  const today = dayKey(now, u.tz);
  return {
    ...(await dayJson(store, u, today)),
    persona: u.persona,
    upcoming: await store.eventsBetween(u.id, addDays(today, 1), addDays(today, 14)),
    tasks: await store.openTasks(u.id),
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

export function createApi(deps: ApiDeps) {
  const { store, pipeline } = deps;

  /** Кнопка из уведомления (push): отметка привычки или «отложить» — то же, что callback в боте. */
  async function runButton(u: User, data: string, all: string[]): Promise<string> {
    const HABIT = /^habit:(\d+):(\d{4}-\d{2}-\d{2}):(done|skipped)$/;
    const habit = data.match(HABIT);
    if (habit) return pipeline.markHabit(u, Number(habit[1]), habit[2], habit[3] as "done" | "skipped", "push");
    if (data === "snooze") {
      const buttons: Button[] = all.filter((d) => d !== "snooze").map((d) => {
        const h = d.match(HABIT);
        return { text: h ? (h[3] === "done" ? "✅ Да" : "✖ Нет") : d, data: d };
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
      if (m === "GET" && (await serveStatic(deps.webDir ?? "", p, res))) return undefined;
      throw new HttpError(404, "нет такого адреса");
    }

    if (m === "POST" && p === "/api/login") {
      const b = parseBody(
        z.object({ login: z.string().min(1).max(80), password: z.string().min(1).max(200), label: z.string().max(80).optional() }),
        await readJson(req),
      );
      const token = await login(store, b.login, b.password, b.label ?? "web");
      if (!token) throw new HttpError(401, "неверный логин или пароль");
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

    if (m === "POST" && p === "/api/logout") {
      await store.dropSession(tokenHash(token));
      return { ok: true };
    }
    const today = dayKey(new Date(), u.tz);
    if (m === "GET" && p === "/api/me") {
      const { password_hash: _, ...me } = u;
      return { ...me, sessions: await store.sessionsOf(u.id) };
    }
    if (m === "POST" && p === "/api/settings") {
      const Time = z.string().refine(isTime, "время ЧЧ:ММ");
      const b = parseBody(z.object({
        name: z.string().trim().max(80).optional(),
        persona: z.string().max(40).optional(),
        morning_time: Time.optional(), tomorrow_time: Time.optional(), evening_time: Time.optional(),
        event_lead_min: z.coerce.number().int().min(5).max(24 * 60).optional(),
        game_alerts: z.coerce.number().int().min(0).max(1).optional(),
        game_first_min: z.coerce.number().int().min(15).max(24 * 60).optional(),
        game_every_min: z.coerce.number().int().min(15).max(24 * 60).optional(),
      }), await readJson(req));
      await store.updateUser(u.id, b);
      const { password_hash: _, ...me } = (await store.user(u.id))!;
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
    // ?all=1 — все даты с ближайшим наступлением (в течение года), иначе ближайшие 30 дней.
    if (m === "GET" && p === "/api/dates") {
      const within = q("all") ? 366 : 30;
      return upcomingDates(await store.activeDates(u.id), today, within).map((d) => ({ ...d.row, on: d.on, inDays: d.inDays, age: d.age }));
    }
    // Иконки программ и игр: { ключ: data-URL }; ключ — iconKey(имя).
    if (m === "GET" && p === "/api/icons") return Object.fromEntries((await store.icons(u.id)).map((i) => [i.name_key, `data:image/png;base64,${i.png}`]));
    if (m === "GET" && p === "/api/activity") return store.activityRange(u.id, q("from") ?? addDays(today, -30), q("to") ?? today);
    if (m === "GET" && p === "/api/events") return store.eventsBetween(u.id, q("from") ?? today, q("to") ?? addDays(today, 30));
    const task = p.match(/^\/api\/tasks\/(\d+)$/);
    if (m === "POST" && task) {
      // Разбор хвостов в виджете: failed — «не буду делать», dodged — закрыл крестиком, не ответив (сбежал от задачи);
      // обе закрывают задачу невыполненной. due_date — перенос на день.
      const b = parseBody(z.object({ status: z.enum(["open", "done", "cancelled", "failed", "dodged"]).optional(), due_date: Day.optional() }), await readJson(req));
      const t = await store.task(Number(task[1]));
      if (!t || t.user_id !== u.id) throw new HttpError(404, "нет задачи");
      if (!b.status && !b.due_date) throw new HttpError(400, "нужно status или due_date");
      await store.updateTask(t.id, b);
      pipeline.changed(u);
      return store.task(t.id);
    }

    // План (событие): состоялся / отменён / снова в планах — из списка планов виджета; date — перенос на день (перетащили на день в полосе);
    // time и end_time — сдвиг по времени (потянули время на карточке), end_time: null — без конца.
    const ev = p.match(/^\/api\/events\/(\d+)$/);
    if (m === "POST" && ev) {
      const Time = z.string().refine(isTime, "время ЧЧ:ММ");
      const b = parseBody(z.object({
        status: z.enum(["active", "done", "cancelled"]).optional(),
        date: Day.optional(),
        time: Time.optional(),
        end_time: Time.nullable().optional(),
      }), await readJson(req));
      if (!b.status && !b.date && !b.time) throw new HttpError(400, "нужно status, date или time");
      if (b.end_time !== undefined && !b.time) throw new HttpError(400, "end_time — только вместе с time");
      if (b.time && b.end_time && b.end_time <= b.time) throw new HttpError(400, "конец раньше начала");
      const e = await store.event(Number(ev[1]));
      if (!e || e.user_id !== u.id) throw new HttpError(404, "нет плана");
      await store.updateEvent(e.id, {
        ...(b.status ? { status: b.status } : {}),
        ...(b.date ? { date_iso: b.date } : {}),
        ...(b.time ? { time: b.time, end_time: b.end_time ?? null } : {}),
      });
      if (b.date || b.time) pipeline.changed(u);
      await store.cancelReminders("event", e.id);
      const now = (await store.event(e.id))!;
      if (now.status === "active") await planEventReminders(store, u, now, new Date());
      return now;
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
      return { month, today: await habitsOfDay(store, u, today), habits: await habitMonth(store, u, month) };
    }
    const mark = p.match(/^\/api\/habits\/(\d+)\/mark$/);
    if (m === "POST" && mark) {
      const b = parseBody(z.object({ status: z.enum(["done", "skipped"]).default("done"), day: Day.optional() }), await readJson(req));
      return { text: await pipeline.markHabit(u, Number(mark[1]), b.day ?? today, b.status, "web") };
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
      const b = parseBody(
        z.object({ text: z.string().trim().min(1).max(4000), id: z.string().max(80).optional(), ask: z.boolean().optional() }),
        await readJson(req),
      );
      return pipeline.handle({ user: u, source: "desktop", sourceId: b.id ?? crypto.randomUUID(), text: b.text, chatOnly: b.ask });
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
