import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// Главное хранилище. Каждая запись знает сообщение, из которого родилась (message_id),
// а каждое действие пишется в actions — по ним работает «Отменить».

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  chat_id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  tz TEXT NOT NULL,
  persona TEXT NOT NULL DEFAULT 'strict',
  morning_time TEXT NOT NULL DEFAULT '09:00',
  tomorrow_time TEXT NOT NULL DEFAULT '20:00',
  evening_time TEXT NOT NULL DEFAULT '23:30',
  event_lead_min INTEGER NOT NULL DEFAULT 60,
  game_alerts INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  text TEXT NOT NULL,
  received_at TEXT NOT NULL,
  day_key TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'received',
  parse_json TEXT,
  reply TEXT,
  reply_to INTEGER,
  UNIQUE (user_id, source, source_id)
);
CREATE TABLE IF NOT EXISTS diary (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  day_key TEXT NOT NULL,
  section TEXT NOT NULL,
  text TEXT NOT NULL,
  message_id INTEGER,
  created_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS diary_day ON diary (user_id, day_key);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  date_iso TEXT NOT NULL,
  time TEXT,
  end_time TEXT,
  details TEXT NOT NULL DEFAULT '',
  domain TEXT NOT NULL DEFAULT 'life',
  status TEXT NOT NULL DEFAULT 'active',
  message_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_date ON events (user_id, date_iso);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  category TEXT NOT NULL DEFAULT '',
  due_date TEXT,
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  message_id INTEGER,
  created_at TEXT NOT NULL,
  done_at TEXT
);
CREATE TABLE IF NOT EXISTS dates (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  date_iso TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'other',
  person TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  yearly INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  message_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  message_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  ref_kind TEXT NOT NULL,
  ref_id INTEGER NOT NULL,
  due_at TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  sent_at TEXT,
  UNIQUE (ref_kind, ref_id, due_at)
);
CREATE INDEX IF NOT EXISTS reminders_due ON reminders (status, due_at);
CREATE TABLE IF NOT EXISTS activity (
  user_id INTEGER NOT NULL,
  day_key TEXT NOT NULL,
  source TEXT NOT NULL,
  active_sec INTEGER NOT NULL DEFAULT 0,
  afk_sec INTEGER NOT NULL DEFAULT 0,
  apps_json TEXT NOT NULL DEFAULT '[]',
  games_json TEXT NOT NULL DEFAULT '[]',
  steps INTEGER,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, day_key, source)
);
CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  tbl TEXT NOT NULL,
  row_id INTEGER NOT NULL,
  before_json TEXT,
  undone INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export interface User {
  id: number;
  chat_id: string;
  name: string;
  tz: string;
  persona: string;
  morning_time: string;
  tomorrow_time: string;
  evening_time: string;
  event_lead_min: number;
  game_alerts: number;
}
export interface Message {
  id: number;
  user_id: number;
  source: string;
  source_id: string;
  text: string;
  received_at: string;
  day_key: string;
  state: "received" | "clarify" | "done" | "failed";
  parse_json: string | null;
  reply: string | null;
  reply_to: number | null;
}
export interface DiaryRow {
  id: number;
  day_key: string;
  section: string;
  text: string;
  message_id: number | null;
  created_at: string;
}
export interface EventRow {
  id: number;
  user_id: number;
  title: string;
  date_iso: string;
  time: string | null;
  end_time: string | null;
  details: string;
  domain: string;
  status: string;
  message_id: number | null;
}
export interface TaskRow {
  id: number;
  user_id: number;
  title: string;
  priority: string;
  category: string;
  due_date: string | null;
  notes: string;
  status: string;
  message_id: number | null;
  created_at: string;
  done_at: string | null;
}
export interface DateRow {
  id: number;
  user_id: number;
  title: string;
  date_iso: string;
  type: string;
  person: string;
  notes: string;
  yearly: number;
  status: string;
}
export interface MemoryRow {
  id: number;
  kind: string;
  subject: string;
  text: string;
  status: string;
  created_at: string;
}
export interface ReminderRow {
  id: number;
  user_id: number;
  ref_kind: string;
  ref_id: number;
  due_at: string;
  text: string;
  status: string;
}
export interface ActivityRow {
  user_id: number;
  day_key: string;
  source: string;
  active_sec: number;
  afk_sec: number;
  apps: { name: string; sec: number }[];
  games: { name: string; sec: number }[];
  steps: number | null;
  updated_at: string;
}
export interface ActionRow {
  id: number;
  message_id: number;
  kind: string;
  tbl: string;
  row_id: number;
  before_json: string | null;
}

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();

export type Table = "diary" | "events" | "tasks" | "dates" | "memory" | "activity";

export class Store {
  readonly db: DatabaseSync;
  /** Кто-то изменил таблицу — зеркало и десктоп узнают по этому. */
  onChange: (tbl: Table, userId: number) => void = () => {};

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
  }

  private all<T>(sql: string, ...args: unknown[]): T[] {
    return this.db.prepare(sql).all(...(args as never[])) as T[];
  }
  private get<T>(sql: string, ...args: unknown[]): T | undefined {
    return this.db.prepare(sql).get(...(args as never[])) as T | undefined;
  }
  private run(sql: string, ...args: unknown[]) {
    return this.db.prepare(sql).run(...(args as never[]));
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  // --- пользователи ---
  userByChat(chatId: string): User | undefined {
    return this.get<User>("SELECT * FROM users WHERE chat_id = ?", chatId);
  }
  user(id: number): User | undefined {
    return this.get<User>("SELECT * FROM users WHERE id = ?", id);
  }
  users(): User[] {
    return this.all<User>("SELECT * FROM users ORDER BY id");
  }
  ensureUser(chatId: string, name: string, tz: string): User {
    const u = this.userByChat(chatId);
    if (u) return u;
    this.run("INSERT INTO users (chat_id, name, tz, created_at) VALUES (?, ?, ?, ?)", chatId, name, tz, now());
    return this.userByChat(chatId)!;
  }
  updateUser(id: number, patch: Partial<Omit<User, "id" | "chat_id">>) {
    for (const [k, v] of Object.entries(patch)) {
      if (!/^[a-z_]+$/.test(k)) throw new Error(`bad field ${k}`);
      this.run(`UPDATE users SET ${k} = ? WHERE id = ?`, v as never, id);
    }
  }

  // --- сообщения ---
  /** Сохранить входящее. Повтор того же source_id возвращает уже сохранённое (created = false). */
  saveMessage(m: { userId: number; source: string; sourceId: string; text: string; dayKey: string; replyTo?: number }) {
    const old = this.get<Message>(
      "SELECT * FROM messages WHERE user_id = ? AND source = ? AND source_id = ?",
      m.userId, m.source, m.sourceId,
    );
    if (old) return { message: old, created: false };
    const r = this.run(
      "INSERT INTO messages (user_id, source, source_id, text, received_at, day_key, reply_to) VALUES (?, ?, ?, ?, ?, ?, ?)",
      m.userId, m.source, m.sourceId, m.text, now(), m.dayKey, m.replyTo ?? null,
    );
    return { message: this.message(Number(r.lastInsertRowid))!, created: true };
  }
  message(id: number): Message | undefined {
    return this.get<Message>("SELECT * FROM messages WHERE id = ?", id);
  }
  setMessage(id: number, patch: { state?: Message["state"]; parse_json?: string; reply?: string }) {
    if (patch.state) this.run("UPDATE messages SET state = ? WHERE id = ?", patch.state, id);
    if (patch.parse_json !== undefined) this.run("UPDATE messages SET parse_json = ? WHERE id = ?", patch.parse_json, id);
    if (patch.reply !== undefined) this.run("UPDATE messages SET reply = ? WHERE id = ?", patch.reply, id);
  }
  /** Сообщение, которое ждёт уточнения (последнее). */
  pendingClarify(userId: number): Message | undefined {
    return this.get<Message>(
      "SELECT * FROM messages WHERE user_id = ? AND state = 'clarify' ORDER BY id DESC LIMIT 1", userId,
    );
  }
  lastDoneMessage(userId: number): Message | undefined {
    return this.get<Message>(
      `SELECT m.* FROM messages m WHERE m.user_id = ? AND m.state = 'done'
       AND EXISTS (SELECT 1 FROM actions a WHERE a.message_id = m.id AND a.undone = 0)
       ORDER BY m.id DESC LIMIT 1`, userId,
    );
  }
  recentMessages(userId: number, limit: number): Message[] {
    return this.all<Message>("SELECT * FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT ?", userId, limit).reverse();
  }

  // --- действия (для отмены) ---
  logAction(userId: number, messageId: number, kind: string, tbl: Table, rowId: number, before?: unknown) {
    this.run(
      "INSERT INTO actions (user_id, message_id, kind, tbl, row_id, before_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      userId, messageId, kind, tbl, rowId, before === undefined ? null : JSON.stringify(before), now(),
    );
  }
  actionsOf(messageId: number): ActionRow[] {
    return this.all<ActionRow>("SELECT * FROM actions WHERE message_id = ? AND undone = 0 ORDER BY id DESC", messageId);
  }
  markUndone(actionId: number) {
    this.run("UPDATE actions SET undone = 1 WHERE id = ?", actionId);
  }

  // --- дневник ---
  addDiary(userId: number, dayKey: string, section: string, text: string, messageId: number | null): number {
    const r = this.run(
      "INSERT INTO diary (user_id, day_key, section, text, message_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      userId, dayKey, section, text, messageId, now(),
    );
    this.onChange("diary", userId);
    return Number(r.lastInsertRowid);
  }
  diaryOf(userId: number, dayKey: string): DiaryRow[] {
    return this.all<DiaryRow>(
      "SELECT * FROM diary WHERE user_id = ? AND day_key = ? AND deleted = 0 ORDER BY id", userId, dayKey,
    );
  }
  diaryRange(userId: number, from: string, to: string): DiaryRow[] {
    return this.all<DiaryRow>(
      "SELECT * FROM diary WHERE user_id = ? AND day_key BETWEEN ? AND ? AND deleted = 0 ORDER BY day_key, id",
      userId, from, to,
    );
  }
  diaryDays(userId: number): string[] {
    return this.all<{ day_key: string }>(
      "SELECT DISTINCT day_key FROM diary WHERE user_id = ? AND deleted = 0 ORDER BY day_key", userId,
    ).map((r) => r.day_key);
  }
  setDiaryDeleted(id: number, deleted: boolean) {
    this.run("UPDATE diary SET deleted = ? WHERE id = ?", deleted ? 1 : 0, id);
    const r = this.get<{ user_id: number }>("SELECT user_id FROM diary WHERE id = ?", id);
    if (r) this.onChange("diary", r.user_id);
  }

  // --- планы ---
  addEvent(e: Omit<EventRow, "id" | "status">): number {
    const t = now();
    const r = this.run(
      `INSERT INTO events (user_id, title, date_iso, time, end_time, details, domain, message_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      e.user_id, e.title, e.date_iso, e.time, e.end_time, e.details, e.domain, e.message_id, t, t,
    );
    this.onChange("events", e.user_id);
    return Number(r.lastInsertRowid);
  }
  event(id: number): EventRow | undefined {
    return this.get<EventRow>("SELECT * FROM events WHERE id = ?", id);
  }
  updateEvent(id: number, patch: Partial<Pick<EventRow, "title" | "date_iso" | "time" | "end_time" | "details" | "status">>) {
    for (const [k, v] of Object.entries(patch)) {
      this.run(`UPDATE events SET ${k} = ?, updated_at = ? WHERE id = ?`, v as never, now(), id);
    }
    const e = this.event(id);
    if (e) this.onChange("events", e.user_id);
  }
  eventsBetween(userId: number, from: string, to: string, status = "active"): EventRow[] {
    return this.all<EventRow>(
      `SELECT * FROM events WHERE user_id = ? AND date_iso BETWEEN ? AND ? AND status = ?
       ORDER BY date_iso, COALESCE(time, '99:99'), id`,
      userId, from, to, status,
    );
  }
  allEvents(userId: number): EventRow[] {
    return this.all<EventRow>("SELECT * FROM events WHERE user_id = ? ORDER BY date_iso, COALESCE(time, '99:99')", userId);
  }

  // --- задачи ---
  addTask(t: Omit<TaskRow, "id" | "status" | "created_at" | "done_at">): number {
    const r = this.run(
      "INSERT INTO tasks (user_id, title, priority, category, due_date, notes, message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      t.user_id, t.title, t.priority, t.category, t.due_date, t.notes, t.message_id, now(),
    );
    this.onChange("tasks", t.user_id);
    return Number(r.lastInsertRowid);
  }
  task(id: number): TaskRow | undefined {
    return this.get<TaskRow>("SELECT * FROM tasks WHERE id = ?", id);
  }
  updateTask(id: number, patch: Partial<Pick<TaskRow, "title" | "due_date" | "status" | "priority" | "notes">>) {
    for (const [k, v] of Object.entries(patch)) this.run(`UPDATE tasks SET ${k} = ? WHERE id = ?`, v as never, id);
    if (patch.status) this.run("UPDATE tasks SET done_at = ? WHERE id = ?", patch.status === "done" ? now() : null, id);
    const t = this.task(id);
    if (t) this.onChange("tasks", t.user_id);
  }
  openTasks(userId: number): TaskRow[] {
    return this.all<TaskRow>(
      `SELECT * FROM tasks WHERE user_id = ? AND status = 'open'
       ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, COALESCE(due_date, '9999'), id`,
      userId,
    );
  }
  allTasks(userId: number): TaskRow[] {
    return this.all<TaskRow>("SELECT * FROM tasks WHERE user_id = ? ORDER BY id", userId);
  }

  // --- важные даты ---
  addDate(d: Omit<DateRow, "id" | "status"> & { message_id: number | null }): number {
    const r = this.run(
      "INSERT INTO dates (user_id, title, date_iso, type, person, notes, yearly, message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      d.user_id, d.title, d.date_iso, d.type, d.person, d.notes, d.yearly, d.message_id, now(),
    );
    this.onChange("dates", d.user_id);
    return Number(r.lastInsertRowid);
  }
  date(id: number): DateRow | undefined {
    return this.get<DateRow>("SELECT * FROM dates WHERE id = ?", id);
  }
  setDateStatus(id: number, status: string) {
    this.run("UPDATE dates SET status = ? WHERE id = ?", status, id);
    const d = this.date(id);
    if (d) this.onChange("dates", d.user_id);
  }
  activeDates(userId: number): DateRow[] {
    return this.all<DateRow>("SELECT * FROM dates WHERE user_id = ? AND status = 'active' ORDER BY substr(date_iso, 6)", userId);
  }

  // --- память ---
  addMemory(userId: number, kind: string, subject: string, text: string, messageId: number | null): number {
    const r = this.run(
      "INSERT INTO memory (user_id, kind, subject, text, message_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      userId, kind, subject, text, messageId, now(),
    );
    this.onChange("memory", userId);
    return Number(r.lastInsertRowid);
  }
  setMemoryStatus(id: number, status: string) {
    this.run("UPDATE memory SET status = ? WHERE id = ?", status, id);
    const r = this.get<{ user_id: number }>("SELECT user_id FROM memory WHERE id = ?", id);
    if (r) this.onChange("memory", r.user_id);
  }
  activeMemory(userId: number): (MemoryRow & { user_id: number })[] {
    return this.all("SELECT * FROM memory WHERE user_id = ? AND status = 'active' ORDER BY id", userId);
  }

  // --- напоминания ---
  addReminder(userId: number, refKind: string, refId: number, dueAt: Date, text: string) {
    this.run(
      "INSERT OR IGNORE INTO reminders (user_id, ref_kind, ref_id, due_at, text) VALUES (?, ?, ?, ?, ?)",
      userId, refKind, refId, dueAt.toISOString(), text,
    );
  }
  cancelReminders(refKind: string, refId: number) {
    this.run("UPDATE reminders SET status = 'cancelled' WHERE ref_kind = ? AND ref_id = ? AND status = 'pending'", refKind, refId);
  }
  dueReminders(at: Date): ReminderRow[] {
    return this.all<ReminderRow>("SELECT * FROM reminders WHERE status = 'pending' AND due_at <= ? ORDER BY due_at", at.toISOString());
  }
  pendingReminders(refKind: string, refId: number): ReminderRow[] {
    return this.all<ReminderRow>("SELECT * FROM reminders WHERE ref_kind = ? AND ref_id = ? AND status = 'pending'", refKind, refId);
  }
  markReminder(id: number, status: "sent" | "cancelled") {
    this.run("UPDATE reminders SET status = ?, sent_at = ? WHERE id = ?", status, now(), id);
  }

  // --- активность ---
  upsertActivity(a: Omit<ActivityRow, "updated_at">) {
    this.run(
      `INSERT INTO activity (user_id, day_key, source, active_sec, afk_sec, apps_json, games_json, steps, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, day_key, source) DO UPDATE SET
         active_sec = excluded.active_sec, afk_sec = excluded.afk_sec, apps_json = excluded.apps_json,
         games_json = excluded.games_json, steps = COALESCE(excluded.steps, activity.steps), updated_at = excluded.updated_at`,
      a.user_id, a.day_key, a.source, a.active_sec, a.afk_sec, JSON.stringify(a.apps), JSON.stringify(a.games), a.steps, now(),
    );
    this.onChange("activity", a.user_id);
  }
  activityOf(userId: number, dayKey: string): ActivityRow[] {
    return this.all<Row>("SELECT * FROM activity WHERE user_id = ? AND day_key = ?", userId, dayKey).map(toActivity);
  }
  activityRange(userId: number, from: string, to: string): ActivityRow[] {
    return this.all<Row>(
      "SELECT * FROM activity WHERE user_id = ? AND day_key BETWEEN ? AND ? ORDER BY day_key", userId, from, to,
    ).map(toActivity);
  }

  // --- служебное ---
  kvGet(key: string): string | undefined {
    return this.get<{ value: string }>("SELECT value FROM kv WHERE key = ?", key)?.value;
  }
  kvSet(key: string, value: string) {
    this.run("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, value);
  }
  /** Поставить отметку один раз; true — если её ещё не было. */
  once(key: string): boolean {
    if (this.kvGet(key) !== undefined) return false;
    this.kvSet(key, now());
    return true;
  }
}

function toActivity(r: Row): ActivityRow {
  return {
    user_id: r.user_id as number,
    day_key: r.day_key as string,
    source: r.source as string,
    active_sec: r.active_sec as number,
    afk_sec: r.afk_sec as number,
    apps: JSON.parse(r.apps_json as string),
    games: JSON.parse(r.games_json as string),
    steps: (r.steps as number | null) ?? null,
    updated_at: r.updated_at as string,
  };
}
