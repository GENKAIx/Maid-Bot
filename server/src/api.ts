import crypto from "node:crypto";
import http from "node:http";
import { z } from "zod";
import { config } from "./config.ts";
import type { Store, User } from "./db.ts";
import type { Pipeline } from "./pipeline.ts";
import type { Send } from "./scheduler.ts";
import { ActivityInput, recordActivity } from "./activity.ts";
import { upcomingDates } from "./report.ts";
import { addDays, dayKey } from "./time.ts";

// HTTP: API для десктопа (Bearer-ключ из /token или DESKTOP_TOKEN) и webhook Telegram.

export interface ApiDeps {
  store: Store;
  pipeline: Pipeline;
  send?: Send;
  webhook?: (req: http.IncomingMessage, res: http.ServerResponse) => unknown;
}

class HttpError extends Error {
  constructor(public status: number, msg: string) {
    super(msg);
  }
}

const safeEq = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function userByToken(store: Store, token: string): User | undefined {
  if (!token) return undefined;
  const id = store.kvGet(`token:${token}`);
  if (id) return store.user(Number(id));
  if (config.desktopToken && safeEq(token, config.desktopToken)) {
    const owner = config.allowedChatIds[0];
    return store.ensureUser(owner ?? "local", "", config.defaultTimezone);
  }
  return undefined;
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

export function todayJson(store: Store, u: User, now = new Date()) {
  const today = dayKey(now, u.tz);
  return {
    day: today,
    persona: u.persona,
    events: store.eventsBetween(u.id, today, today),
    upcoming: store.eventsBetween(u.id, addDays(today, 1), addDays(today, 14)),
    tasks: store.openTasks(u.id),
    dates: upcomingDates(store.activeDates(u.id), today, 30).map((d) => ({ ...d.row, on: d.on, inDays: d.inDays, age: d.age })),
    diary: store.diaryOf(u.id, today),
    activity: store.activityOf(u.id, today),
  };
}

export function createApi(deps: ApiDeps) {
  const { store, pipeline } = deps;

  async function route(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? "/", "http://local");
    const p = url.pathname;
    if (p === "/health") return { ok: true };
    if (p === "/webhook" && req.method === "POST" && deps.webhook) {
      await deps.webhook(req, res);
      return undefined;
    }
    if (!p.startsWith("/api/")) throw new HttpError(404, "нет такого адреса");

    const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const u = userByToken(store, token);
    if (!u) throw new HttpError(401, "нужен ключ (команда /token в боте)");
    const m = req.method ?? "GET";

    if (m === "GET" && p === "/api/today") return todayJson(store, u);
    if (m === "GET" && p === "/api/tasks") return store.openTasks(u.id);
    if (m === "GET" && p === "/api/dates") return todayJson(store, u).dates;
    if (m === "GET" && p === "/api/events") {
      const today = dayKey(new Date(), u.tz);
      return store.eventsBetween(u.id, url.searchParams.get("from") ?? today, url.searchParams.get("to") ?? addDays(today, 30));
    }
    const task = p.match(/^\/api\/tasks\/(\d+)$/);
    if (m === "POST" && task) {
      const { status } = parseBody(z.object({ status: z.enum(["open", "done", "cancelled"]) }), await readJson(req));
      const t = store.task(Number(task[1]));
      if (!t || t.user_id !== u.id) throw new HttpError(404, "нет задачи");
      store.updateTask(t.id, { status });
      return store.task(t.id);
    }
    if (m === "POST" && p === "/api/input") {
      const b = parseBody(z.object({ text: z.string().trim().min(1).max(4000), id: z.string().max(80).optional(), ask: z.boolean().optional() }), await readJson(req));
      return pipeline.handle({ user: u, source: "desktop", sourceId: b.id ?? crypto.randomUUID(), text: b.text, chatOnly: b.ask });
    }
    if (m === "POST" && p === "/api/undo") {
      const b = parseBody(z.object({ messageId: z.number().int().optional() }), await readJson(req));
      return { text: pipeline.undo(u, b.messageId) };
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
