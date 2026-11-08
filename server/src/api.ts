import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { z } from "zod";
import { login, tokenHash, userByToken } from "./auth.ts";
import type { Store, User } from "./db.ts";
import { ActivityInput, recordActivity } from "./activity.ts";
import { habitMonth, habitsOfDay } from "./habits.ts";
import { HEALTH_TOPICS, METRICS } from "./parse.ts";
import type { Pipeline } from "./pipeline.ts";
import { moneyTotals, upcomingDates } from "./report.ts";
import type { Send } from "./scheduler.ts";
import { addDays, dayKey, isDayKey } from "./time.ts";

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
}

class HttpError extends Error {
  constructor(public status: number, msg: string) {
    super(msg);
  }
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new HttpError(413, "слишком большой запрос");
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
  const exists = async (f: string) => (await fs.promises.stat(f).catch(() => null))?.isFile() ?? false;
  if (!(await exists(file))) {
    if (path.extname(safe)) return false;
    file = path.join(dir, "index.html");
    if (!(await exists(file))) return false;
  }
  const ext = path.extname(file).toLowerCase();
  const immutable = /\/assets\//.test(file.replace(/\\/g, "/"));
  res.writeHead(200, {
    "Content-Type": MIME[ext] ?? "application/octet-stream",
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

  async function route(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? "/", "http://local");
    const p = url.pathname;
    const q = (k: string) => url.searchParams.get(k) ?? undefined;
    const m = req.method ?? "GET";
    if (p === "/health") return { ok: true };
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
    if (m === "GET" && p === "/api/dates") return (await todayJson(store, u)).dates;
    if (m === "GET" && p === "/api/events") return store.eventsBetween(u.id, q("from") ?? today, q("to") ?? addDays(today, 30));
    const task = p.match(/^\/api\/tasks\/(\d+)$/);
    if (m === "POST" && task) {
      const { status } = parseBody(z.object({ status: z.enum(["open", "done", "cancelled"]) }), await readJson(req));
      const t = await store.task(Number(task[1]));
      if (!t || t.user_id !== u.id) throw new HttpError(404, "нет задачи");
      await store.updateTask(t.id, { status });
      return store.task(t.id);
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
      return used.map((t) => ({ ...t, name: HEALTH_TOPICS[t.topic] ?? t.topic }));
    }

    if (m === "POST" && p === "/api/input") {
      const b = parseBody(
        z.object({ text: z.string().trim().min(1).max(4000), id: z.string().max(80).optional(), ask: z.boolean().optional() }),
        await readJson(req),
      );
      return pipeline.handle({ user: u, source: "desktop", sourceId: b.id ?? crypto.randomUUID(), text: b.text, chatOnly: b.ask });
    }
    if (m === "POST" && p === "/api/undo") {
      const b = parseBody(z.object({ messageId: z.number().int().optional() }), await readJson(req));
      return { text: await pipeline.undo(u, b.messageId) };
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
