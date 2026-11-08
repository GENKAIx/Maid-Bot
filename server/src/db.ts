import { openPostgres, schemaFor, SqliteDriver, type Driver } from "./driver.ts";

// Главное хранилище. Каждая запись знает сообщение, из которого родилась (message_id),
// а каждое действие пишется в actions — по ним работает «Отменить».
// База — SQLite у себя или Postgres на Render: SQL общий, различия прячет driver.ts.

/** Шаги схемы по порядку; номер последнего пройденного — kv.schema_version. Новое — только дописывать в конец. */
const MIGRATIONS: string[] = [
  `
CREATE TABLE IF NOT EXISTS users (
  id {pk},
  login TEXT UNIQUE,
  password_hash TEXT,
  chat_id TEXT UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  tz TEXT NOT NULL,
  persona TEXT NOT NULL DEFAULT 'strict',
  morning_time TEXT NOT NULL DEFAULT '09:00',
  tomorrow_time TEXT NOT NULL DEFAULT '20:00',
  evening_time TEXT NOT NULL DEFAULT '22:00',
  event_lead_min INTEGER NOT NULL DEFAULT 60,
  game_alerts INTEGER NOT NULL DEFAULT 1,
  game_first_min INTEGER NOT NULL DEFAULT 120,
  game_every_min INTEGER NOT NULL DEFAULT 120,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  last_seen TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id {pk},
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
  id {pk},
  user_id INTEGER NOT NULL,
  day_key TEXT NOT NULL,
  section TEXT NOT NULL,
  topic TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  message_id INTEGER,
  created_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS diary_day ON diary (user_id, day_key);
CREATE TABLE IF NOT EXISTS events (
  id {pk},
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
  id {pk},
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
  id {pk},
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
  id {pk},
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  message_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS metrics (
  id {pk},
  user_id INTEGER NOT NULL,
  day_key TEXT NOT NULL,
  key TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  value {real} NOT NULL,
  unit TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'text',
  message_id INTEGER,
  created_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS metrics_day ON metrics (user_id, key, day_key);
CREATE TABLE IF NOT EXISTS habits (
  id {pk},
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  days TEXT NOT NULL DEFAULT '1234567',
  times TEXT NOT NULL DEFAULT '[]',
  start_date TEXT NOT NULL,
  end_date TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  message_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS habit_marks (
  id {pk},
  habit_id INTEGER NOT NULL,
  day_key TEXT NOT NULL,
  status TEXT NOT NULL,
  at TEXT NOT NULL,
  message_id INTEGER,
  UNIQUE (habit_id, day_key)
);
CREATE TABLE IF NOT EXISTS money (
  id {pk},
  user_id INTEGER NOT NULL,
  day_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount {real} NOT NULL,
  currency TEXT NOT NULL DEFAULT 'RUB',
  category TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  message_id INTEGER,
  created_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS money_day ON money (user_id, day_key);
CREATE TABLE IF NOT EXISTS reminders (
  id {pk},
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
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, day_key, source)
);
CREATE TABLE IF NOT EXISTS actions (
  id {pk},
  user_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  tbl TEXT NOT NULL,
  row_id INTEGER NOT NULL,
  before_json TEXT,
  undone INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
`,
  // Шаг 2: push-подписки браузеров и кнопки у отложенных напоминаний.
  `
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  keys_json TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  last_ok TEXT
);
ALTER TABLE reminders ADD COLUMN buttons TEXT NOT NULL DEFAULT '';
`,
  // Шаг 3: лента уведомлений — то же, что ушло в Telegram и push, для горничной на ПК.
  `
CREATE TABLE IF NOT EXISTS notices (
  id {pk},
  user_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  emotion TEXT NOT NULL DEFAULT 'neutral',
  buttons TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS notices_user ON notices (user_id, id);
`,
];

export interface User {
  id: number;
  login: string | null;
  password_hash: string | null;
  chat_id: string | null;
  name: string;
  tz: string;
  persona: string;
  morning_time: string;
  tomorrow_time: string;
  evening_time: string;
  event_lead_min: number;
  game_alerts: number;
  game_first_min: number;
  game_every_min: number;
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
  topic: string;
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
export interface MetricRow {
  id: number;
  user_id: number;
  day_key: string;
  key: string;
  label: string;
  value: number;
  unit: string;
  note: string;
  source: string;
  message_id: number | null;
}
export interface HabitRow {
  id: number;
  user_id: number;
  title: string;
  /** Дни недели цифрами, 1 — понедельник … 7 — воскресенье. */
  days: string;
  /** JSON-массив времён «ЧЧ:ММ» для напоминаний. */
  times: string;
  start_date: string;
  end_date: string | null;
  status: string;
  message_id: number | null;
}
export interface MarkRow {
  id: number;
  habit_id: number;
  day_key: string;
  status: "done" | "skipped";
  at: string;
  message_id: number | null;
}
export interface MoneyRow {
  id: number;
  user_id: number;
  day_key: string;
  kind: "income" | "expense";
  amount: number;
  currency: string;
  category: string;
  note: string;
  message_id: number | null;
}
export interface ReminderRow {
  id: number;
  user_id: number;
  ref_kind: string;
  ref_id: number;
  due_at: string;
  text: string;
  status: string;
  /** JSON-массив кнопок (scheduler.Button) или пусто. */
  buttons: string;
}
export interface NoticeRow {
  id: number;
  user_id: number;
  text: string;
  emotion: string;
  buttons: string;
  at: string;
}
export interface PushSub {
  endpoint: string;
  user_id: number;
  keys_json: string;
  label: string;
  created_at: string;
  last_ok: string | null;
}
export interface ActivityRow {
  user_id: number;
  day_key: string;
  source: string;
  active_sec: number;
  afk_sec: number;
  apps: { name: string; sec: number }[];
  games: { name: string; sec: number }[];
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

export type Table = "diary" | "events" | "tasks" | "dates" | "memory" | "metrics" | "habits" | "habit_marks" | "money";

export class Store {
  private constructor(readonly driver: Driver) {}

  /** Адрес postgres://… — Postgres, иначе путь к файлу SQLite (или ":memory:"). */
  static async open(target: string): Promise<Store> {
    const d = /^postgres(ql)?:\/\//.test(target) ? await openPostgres(target) : new SqliteDriver(target);
    return Store.over(d);
  }
  static async over(driver: Driver): Promise<Store> {
    const s = new Store(driver);
    await s.migrate();
    return s;
  }
  close() {
    return this.driver.close();
  }

  private async migrate() {
    await this.driver.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    let v = Number((await this.kvGet("schema_version")) ?? 0);
    while (v < MIGRATIONS.length) {
      const step = MIGRATIONS[v];
      await this.driver.tx(async () => {
        await this.driver.exec(schemaFor(this.driver.dialect, step));
        await this.kvSet("schema_version", String(v + 1));
      });
      v++;
    }
  }

  private all<T>(sql: string, ...args: unknown[]): Promise<T[]> {
    return this.driver.all<T>(sql, args);
  }
  private async get<T>(sql: string, ...args: unknown[]): Promise<T | undefined> {
    return (await this.driver.all<T>(sql, args))[0];
  }
  private run(sql: string, ...args: unknown[]): Promise<number> {
    return this.driver.run(sql, args);
  }
  /** INSERT … и номер новой строки. */
  private async insert(sql: string, ...args: unknown[]): Promise<number> {
    const r = await this.driver.all<{ id: number }>(`${sql} RETURNING id`, args);
    return Number(r[0].id);
  }

  transaction<T>(fn: () => Promise<T>): Promise<T> {
    return this.driver.tx(fn);
  }

  // --- пользователи ---
  userByChat(chatId: string): Promise<User | undefined> {
    return this.get<User>("SELECT * FROM users WHERE chat_id = ?", chatId);
  }
  userByLogin(login: string): Promise<User | undefined> {
    return this.get<User>("SELECT * FROM users WHERE login = ?", login.toLowerCase());
  }
  user(id: number): Promise<User | undefined> {
    return this.get<User>("SELECT * FROM users WHERE id = ?", id);
  }
  users(): Promise<User[]> {
    return this.all<User>("SELECT * FROM users ORDER BY id");
  }
  /** Пользователь по чату Telegram (создаётся при первом сообщении). */
  async ensureUser(chatId: string, name: string, tz: string): Promise<User> {
    const u = await this.userByChat(chatId);
    if (u) return u;
    await this.run(
      "INSERT INTO users (chat_id, name, tz, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (chat_id) DO NOTHING",
      chatId, name, tz, now(),
    );
    return (await this.userByChat(chatId))!;
  }
  async createUser(u: { login: string; passwordHash: string; name?: string; tz: string; chatId?: string | null }): Promise<User> {
    const id = await this.insert(
      "INSERT INTO users (login, password_hash, chat_id, name, tz, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      u.login.toLowerCase(), u.passwordHash, u.chatId ?? null, u.name ?? "", u.tz, now(),
    );
    return (await this.user(id))!;
  }
  async updateUser(id: number, patch: Partial<Omit<User, "id">>) {
    for (const [k, v] of Object.entries(patch)) {
      if (!/^[a-z_]+$/.test(k)) throw new Error(`bad field ${k}`);
      await this.run(`UPDATE users SET ${k} = ? WHERE id = ?`, v as never, id);
    }
  }

  // --- входы (сессии веб-приложения и ключи устройств) ---
  async addSession(tokenHash: string, userId: number, label: string) {
    const t = now();
    await this.run("INSERT INTO sessions (token_hash, user_id, label, created_at, last_seen) VALUES (?, ?, ?, ?, ?)", tokenHash, userId, label, t, t);
  }
  sessionUser(tokenHash: string): Promise<(User & { last_seen: string }) | undefined> {
    return this.get(
      "SELECT u.*, s.last_seen FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?", tokenHash,
    );
  }
  async touchSession(tokenHash: string) {
    await this.run("UPDATE sessions SET last_seen = ? WHERE token_hash = ?", now(), tokenHash);
  }
  async dropSession(tokenHash: string) {
    await this.run("DELETE FROM sessions WHERE token_hash = ?", tokenHash);
  }
  sessionsOf(userId: number): Promise<{ label: string; created_at: string; last_seen: string }[]> {
    return this.all("SELECT label, created_at, last_seen FROM sessions WHERE user_id = ? ORDER BY last_seen DESC", userId);
  }

  // --- сообщения ---
  /** Сохранить входящее. Повтор того же source_id возвращает уже сохранённое (created = false). */
  async saveMessage(m: { userId: number; source: string; sourceId: string; text: string; dayKey: string; replyTo?: number; at?: Date }) {
    const find = () => this.get<Message>(
      "SELECT * FROM messages WHERE user_id = ? AND source = ? AND source_id = ?", m.userId, m.source, m.sourceId,
    );
    const old = await find();
    if (old) return { message: old, created: false };
    const added = await this.run(
      `INSERT INTO messages (user_id, source, source_id, text, received_at, day_key, reply_to) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, source, source_id) DO NOTHING`,
      m.userId, m.source, m.sourceId, m.text, (m.at ?? new Date()).toISOString(), m.dayKey, m.replyTo ?? null,
    );
    return { message: (await find())!, created: added > 0 };
  }
  message(id: number): Promise<Message | undefined> {
    return this.get<Message>("SELECT * FROM messages WHERE id = ?", id);
  }
  async setMessage(id: number, patch: { state?: Message["state"]; parse_json?: string; reply?: string }) {
    if (patch.state) await this.run("UPDATE messages SET state = ? WHERE id = ?", patch.state, id);
    if (patch.parse_json !== undefined) await this.run("UPDATE messages SET parse_json = ? WHERE id = ?", patch.parse_json, id);
    if (patch.reply !== undefined) await this.run("UPDATE messages SET reply = ? WHERE id = ?", patch.reply, id);
  }
  /** Сообщение, которое ждёт уточнения (последнее). */
  pendingClarify(userId: number): Promise<Message | undefined> {
    return this.get<Message>("SELECT * FROM messages WHERE user_id = ? AND state = 'clarify' ORDER BY id DESC LIMIT 1", userId);
  }
  lastDoneMessage(userId: number): Promise<Message | undefined> {
    return this.get<Message>(
      `SELECT m.* FROM messages m WHERE m.user_id = ? AND m.state = 'done'
       AND EXISTS (SELECT 1 FROM actions a WHERE a.message_id = m.id AND a.undone = 0)
       ORDER BY m.id DESC LIMIT 1`, userId,
    );
  }
  async recentMessages(userId: number, limit: number): Promise<Message[]> {
    return (await this.all<Message>(
      "SELECT * FROM messages WHERE user_id = ? AND source <> 'import' ORDER BY id DESC LIMIT ?", userId, limit,
    )).reverse();
  }

  // --- действия (для отмены) ---
  async logAction(userId: number, messageId: number, kind: string, tbl: Table, rowId: number, before?: unknown) {
    await this.run(
      "INSERT INTO actions (user_id, message_id, kind, tbl, row_id, before_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      userId, messageId, kind, tbl, rowId, before === undefined ? null : JSON.stringify(before), now(),
    );
  }
  actionsOf(messageId: number): Promise<ActionRow[]> {
    return this.all<ActionRow>("SELECT * FROM actions WHERE message_id = ? AND undone = 0 ORDER BY id DESC", messageId);
  }
  async markUndone(actionId: number) {
    await this.run("UPDATE actions SET undone = 1 WHERE id = ?", actionId);
  }

  // --- дневник ---
  addDiary(userId: number, dayKey: string, section: string, text: string, messageId: number | null, topic = ""): Promise<number> {
    return this.insert(
      "INSERT INTO diary (user_id, day_key, section, topic, text, message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      userId, dayKey, section, topic, text, messageId, now(),
    );
  }
  diaryOf(userId: number, dayKey: string): Promise<DiaryRow[]> {
    return this.all<DiaryRow>("SELECT * FROM diary WHERE user_id = ? AND day_key = ? AND deleted = 0 ORDER BY id", userId, dayKey);
  }
  diaryRange(userId: number, from: string, to: string): Promise<DiaryRow[]> {
    return this.all<DiaryRow>(
      "SELECT * FROM diary WHERE user_id = ? AND day_key BETWEEN ? AND ? AND deleted = 0 ORDER BY day_key, id", userId, from, to,
    );
  }
  /** Все записи раздела (для поиска; фильтр по словам — в коде: SQLite не знает регистра кириллицы). */
  diarySection(userId: number, section: string): Promise<DiaryRow[]> {
    return this.all<DiaryRow>(
      "SELECT * FROM diary WHERE user_id = ? AND section = ? AND deleted = 0 ORDER BY day_key, id", userId, section,
    );
  }
  async diaryTopics(userId: number, section: string): Promise<{ topic: string; n: number; last: string }[]> {
    return this.all(
      `SELECT topic, CAST(COUNT(*) AS INTEGER) AS n, MAX(day_key) AS last FROM diary
       WHERE user_id = ? AND section = ? AND deleted = 0 GROUP BY topic ORDER BY n DESC`, userId, section,
    );
  }
  async diaryDays(userId: number): Promise<string[]> {
    return (await this.all<{ day_key: string }>(
      "SELECT DISTINCT day_key FROM diary WHERE user_id = ? AND deleted = 0 ORDER BY day_key", userId,
    )).map((r) => r.day_key);
  }
  /** Дни, где есть записи, и сколько их — для навигации по дневнику. */
  diaryDayCounts(userId: number): Promise<{ day: string; n: number }[]> {
    return this.all<{ day: string; n: number }>(
      "SELECT day_key AS day, COUNT(*) AS n FROM diary WHERE user_id = ? AND deleted = 0 GROUP BY day_key ORDER BY day_key", userId,
    ).then((rows) => rows.map((r) => ({ day: r.day, n: Number(r.n) })));
  }
  diaryRow(id: number): Promise<(DiaryRow & { user_id: number; deleted: number }) | undefined> {
    return this.get<DiaryRow & { user_id: number; deleted: number }>("SELECT * FROM diary WHERE id = ?", id);
  }
  async setDiaryDeleted(id: number, deleted: boolean) {
    await this.run("UPDATE diary SET deleted = ? WHERE id = ?", deleted ? 1 : 0, id);
  }

  // --- планы ---
  addEvent(e: Omit<EventRow, "id" | "status"> & { status?: string }): Promise<number> {
    const t = now();
    return this.insert(
      `INSERT INTO events (user_id, title, date_iso, time, end_time, details, domain, status, message_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      e.user_id, e.title, e.date_iso, e.time, e.end_time, e.details, e.domain, e.status ?? "active", e.message_id, t, t,
    );
  }
  event(id: number): Promise<EventRow | undefined> {
    return this.get<EventRow>("SELECT * FROM events WHERE id = ?", id);
  }
  async updateEvent(id: number, patch: Partial<Pick<EventRow, "title" | "date_iso" | "time" | "end_time" | "details" | "status">>) {
    for (const [k, v] of Object.entries(patch)) {
      await this.run(`UPDATE events SET ${k} = ?, updated_at = ? WHERE id = ?`, v as never, now(), id);
    }
  }
  eventsBetween(userId: number, from: string, to: string, status = "active"): Promise<EventRow[]> {
    return this.all<EventRow>(
      `SELECT * FROM events WHERE user_id = ? AND date_iso BETWEEN ? AND ? AND status = ?
       ORDER BY date_iso, COALESCE(time, '99:99'), id`,
      userId, from, to, status,
    );
  }
  allEvents(userId: number): Promise<EventRow[]> {
    return this.all<EventRow>("SELECT * FROM events WHERE user_id = ? ORDER BY date_iso, COALESCE(time, '99:99'), id", userId);
  }

  // --- задачи ---
  addTask(t: Omit<TaskRow, "id" | "status" | "created_at" | "done_at"> & { status?: string; created_at?: string; done_at?: string | null }): Promise<number> {
    return this.insert(
      "INSERT INTO tasks (user_id, title, priority, category, due_date, notes, status, message_id, created_at, done_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      t.user_id, t.title, t.priority, t.category, t.due_date, t.notes, t.status ?? "open", t.message_id, t.created_at ?? now(), t.done_at ?? null,
    );
  }
  task(id: number): Promise<TaskRow | undefined> {
    return this.get<TaskRow>("SELECT * FROM tasks WHERE id = ?", id);
  }
  async updateTask(id: number, patch: Partial<Pick<TaskRow, "title" | "due_date" | "status" | "priority" | "notes">>) {
    for (const [k, v] of Object.entries(patch)) await this.run(`UPDATE tasks SET ${k} = ? WHERE id = ?`, v as never, id);
    if (patch.status) await this.run("UPDATE tasks SET done_at = ? WHERE id = ?", patch.status === "done" ? now() : null, id);
  }
  openTasks(userId: number): Promise<TaskRow[]> {
    return this.all<TaskRow>(
      `SELECT * FROM tasks WHERE user_id = ? AND status = 'open'
       ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, COALESCE(due_date, '9999'), id`,
      userId,
    );
  }
  allTasks(userId: number): Promise<TaskRow[]> {
    return this.all<TaskRow>("SELECT * FROM tasks WHERE user_id = ? ORDER BY id", userId);
  }

  // --- важные даты ---
  addDate(d: Omit<DateRow, "id" | "status"> & { message_id: number | null; status?: string }): Promise<number> {
    return this.insert(
      "INSERT INTO dates (user_id, title, date_iso, type, person, notes, yearly, status, message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      d.user_id, d.title, d.date_iso, d.type, d.person, d.notes, d.yearly, d.status ?? "active", d.message_id, now(),
    );
  }
  date(id: number): Promise<DateRow | undefined> {
    return this.get<DateRow>("SELECT * FROM dates WHERE id = ?", id);
  }
  async setDateStatus(id: number, status: string) {
    await this.run("UPDATE dates SET status = ? WHERE id = ?", status, id);
  }
  activeDates(userId: number): Promise<DateRow[]> {
    return this.all<DateRow>("SELECT * FROM dates WHERE user_id = ? AND status = 'active' ORDER BY substr(date_iso, 6), id", userId);
  }

  // --- память ---
  addMemory(userId: number, kind: string, subject: string, text: string, messageId: number | null): Promise<number> {
    return this.insert(
      "INSERT INTO memory (user_id, kind, subject, text, message_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      userId, kind, subject, text, messageId, now(),
    );
  }
  async setMemoryStatus(id: number, status: string) {
    await this.run("UPDATE memory SET status = ? WHERE id = ?", status, id);
  }
  activeMemory(userId: number): Promise<(MemoryRow & { user_id: number })[]> {
    return this.all("SELECT * FROM memory WHERE user_id = ? AND status = 'active' ORDER BY id", userId);
  }

  // --- показатели дня: вес, сон в часах, шаги, оценки… (новый ключ — новая «колонка» без правки схемы) ---
  addMetric(m: Omit<MetricRow, "id">): Promise<number> {
    return this.insert(
      "INSERT INTO metrics (user_id, day_key, key, label, value, unit, note, source, message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      m.user_id, m.day_key, m.key, m.label, m.value, m.unit, m.note, m.source, m.message_id, now(),
    );
  }
  /** Одно значение на день от источника (шаги с айфона): заменить прежнее. */
  async setDayMetric(m: Omit<MetricRow, "id" | "message_id" | "note"> & { note?: string }): Promise<number> {
    const old = await this.get<{ id: number }>(
      "SELECT id FROM metrics WHERE user_id = ? AND day_key = ? AND key = ? AND source = ? AND deleted = 0",
      m.user_id, m.day_key, m.key, m.source,
    );
    if (old) {
      await this.run("UPDATE metrics SET value = ?, created_at = ? WHERE id = ?", m.value, now(), old.id);
      return old.id;
    }
    return this.addMetric({ ...m, note: m.note ?? "", message_id: null });
  }
  metric(id: number): Promise<MetricRow | undefined> {
    return this.get<MetricRow>("SELECT * FROM metrics WHERE id = ?", id);
  }
  metricsRange(userId: number, from: string, to: string, key?: string): Promise<MetricRow[]> {
    return key
      ? this.all<MetricRow>(
        "SELECT * FROM metrics WHERE user_id = ? AND key = ? AND day_key BETWEEN ? AND ? AND deleted = 0 ORDER BY day_key, id",
        userId, key, from, to,
      )
      : this.all<MetricRow>(
        "SELECT * FROM metrics WHERE user_id = ? AND day_key BETWEEN ? AND ? AND deleted = 0 ORDER BY day_key, id", userId, from, to,
      );
  }
  metricKeys(userId: number): Promise<{ key: string; label: string; unit: string; n: number }[]> {
    return this.all(
      `SELECT key, MAX(label) AS label, MAX(unit) AS unit, CAST(COUNT(*) AS INTEGER) AS n FROM metrics
       WHERE user_id = ? AND deleted = 0 GROUP BY key ORDER BY n DESC`, userId,
    );
  }
  async setMetricDeleted(id: number, deleted: boolean) {
    await this.run("UPDATE metrics SET deleted = ? WHERE id = ?", deleted ? 1 : 0, id);
  }

  // --- привычки ---
  addHabit(h: Omit<HabitRow, "id" | "status"> & { status?: string }): Promise<number> {
    return this.insert(
      "INSERT INTO habits (user_id, title, days, times, start_date, end_date, status, message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      h.user_id, h.title, h.days, h.times, h.start_date, h.end_date, h.status ?? "active", h.message_id, now(),
    );
  }
  habit(id: number): Promise<HabitRow | undefined> {
    return this.get<HabitRow>("SELECT * FROM habits WHERE id = ?", id);
  }
  async updateHabit(id: number, patch: Partial<Pick<HabitRow, "title" | "days" | "times" | "end_date" | "status">>) {
    for (const [k, v] of Object.entries(patch)) await this.run(`UPDATE habits SET ${k} = ? WHERE id = ?`, v as never, id);
  }
  /** Привычки, которые идут в этот день (по датам; день недели проверяет habits.ts). */
  habitsOn(userId: number, day: string): Promise<HabitRow[]> {
    return this.all<HabitRow>(
      `SELECT * FROM habits WHERE user_id = ? AND status = 'active' AND start_date <= ?
       AND (end_date IS NULL OR end_date >= ?) ORDER BY id`, userId, day, day,
    );
  }
  activeHabits(userId: number): Promise<HabitRow[]> {
    return this.all<HabitRow>("SELECT * FROM habits WHERE user_id = ? AND status = 'active' ORDER BY id", userId);
  }
  /** Отметить день; вернуть номер отметки и что было до неё (для отмены). */
  async markHabit(habitId: number, day: string, status: MarkRow["status"], messageId: number | null) {
    const before = await this.get<MarkRow>("SELECT * FROM habit_marks WHERE habit_id = ? AND day_key = ?", habitId, day);
    const id = await this.insert(
      `INSERT INTO habit_marks (habit_id, day_key, status, at, message_id) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (habit_id, day_key) DO UPDATE SET status = excluded.status, at = excluded.at, message_id = excluded.message_id`,
      habitId, day, status, now(), messageId,
    );
    return { id, before };
  }
  async restoreMark(id: number, before: MarkRow | null) {
    if (!before) await this.run("DELETE FROM habit_marks WHERE id = ?", id);
    else await this.run("UPDATE habit_marks SET status = ?, at = ?, message_id = ? WHERE id = ?", before.status, before.at, before.message_id, id);
  }
  marksOf(userId: number, from: string, to: string): Promise<MarkRow[]> {
    return this.all<MarkRow>(
      `SELECT m.* FROM habit_marks m JOIN habits h ON h.id = m.habit_id
       WHERE h.user_id = ? AND m.day_key BETWEEN ? AND ? ORDER BY m.day_key`, userId, from, to,
    );
  }

  // --- деньги ---
  addMoney(m: Omit<MoneyRow, "id">): Promise<number> {
    return this.insert(
      "INSERT INTO money (user_id, day_key, kind, amount, currency, category, note, message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      m.user_id, m.day_key, m.kind, m.amount, m.currency, m.category, m.note, m.message_id, now(),
    );
  }
  moneyRange(userId: number, from: string, to: string): Promise<MoneyRow[]> {
    return this.all<MoneyRow>(
      "SELECT * FROM money WHERE user_id = ? AND day_key BETWEEN ? AND ? AND deleted = 0 ORDER BY day_key, id", userId, from, to,
    );
  }
  async setMoneyDeleted(id: number, deleted: boolean) {
    await this.run("UPDATE money SET deleted = ? WHERE id = ?", deleted ? 1 : 0, id);
  }

  // --- напоминания ---
  async addReminder(userId: number, refKind: string, refId: number, dueAt: Date, text: string, buttons = "") {
    await this.run(
      "INSERT INTO reminders (user_id, ref_kind, ref_id, due_at, text, buttons) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (ref_kind, ref_id, due_at) DO NOTHING",
      userId, refKind, refId, dueAt.toISOString(), text, buttons,
    );
  }

  // --- лента уведомлений ---
  addNotice(userId: number, text: string, emotion: string, buttons = ""): Promise<number> {
    return this.insert("INSERT INTO notices (user_id, text, emotion, buttons, at) VALUES (?, ?, ?, ?, ?)", userId, text, emotion, buttons, now());
  }
  noticesAfter(userId: number, afterId: number, limit = 20): Promise<NoticeRow[]> {
    return this.all<NoticeRow>("SELECT * FROM notices WHERE user_id = ? AND id > ? ORDER BY id DESC LIMIT ?", userId, afterId, limit);
  }
  async pruneNotices(userId: number, keep = 200) {
    await this.run(
      "DELETE FROM notices WHERE user_id = ? AND id < (SELECT COALESCE(MIN(id), 0) FROM (SELECT id FROM notices WHERE user_id = ? ORDER BY id DESC LIMIT ?) t)",
      userId, userId, keep,
    );
  }

  // --- push-подписки ---
  async addPushSub(s: { endpoint: string; userId: number; keys: unknown; label: string }) {
    await this.run(
      `INSERT INTO push_subs (endpoint, user_id, keys_json, label, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, keys_json = excluded.keys_json, label = excluded.label`,
      s.endpoint, s.userId, JSON.stringify(s.keys), s.label, now(),
    );
  }
  pushSubsOf(userId: number): Promise<PushSub[]> {
    return this.all<PushSub>("SELECT * FROM push_subs WHERE user_id = ? ORDER BY created_at", userId);
  }
  async dropPushSub(endpoint: string) {
    await this.run("DELETE FROM push_subs WHERE endpoint = ?", endpoint);
  }
  async touchPushSub(endpoint: string) {
    await this.run("UPDATE push_subs SET last_ok = ? WHERE endpoint = ?", now(), endpoint);
  }
  allHabits(userId: number): Promise<HabitRow[]> {
    return this.all<HabitRow>("SELECT * FROM habits WHERE user_id = ? ORDER BY id", userId);
  }
  allDates(userId: number): Promise<DateRow[]> {
    return this.all<DateRow>("SELECT * FROM dates WHERE user_id = ? ORDER BY id", userId);
  }
  allMemory(userId: number): Promise<MemoryRow[]> {
    return this.all<MemoryRow>("SELECT * FROM memory WHERE user_id = ? ORDER BY id", userId);
  }
  async cancelReminders(refKind: string, refId: number) {
    await this.run("UPDATE reminders SET status = 'cancelled' WHERE ref_kind = ? AND ref_id = ? AND status = 'pending'", refKind, refId);
  }
  dueReminders(at: Date): Promise<ReminderRow[]> {
    return this.all<ReminderRow>("SELECT * FROM reminders WHERE status = 'pending' AND due_at <= ? ORDER BY due_at", at.toISOString());
  }
  pendingReminders(refKind: string, refId: number): Promise<ReminderRow[]> {
    return this.all<ReminderRow>("SELECT * FROM reminders WHERE ref_kind = ? AND ref_id = ? AND status = 'pending'", refKind, refId);
  }
  async markReminder(id: number, status: "sent" | "cancelled") {
    await this.run("UPDATE reminders SET status = ?, sent_at = ? WHERE id = ?", status, now(), id);
  }

  // --- активность ПК ---
  async upsertActivity(a: Omit<ActivityRow, "updated_at">) {
    await this.run(
      `INSERT INTO activity (user_id, day_key, source, active_sec, afk_sec, apps_json, games_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, day_key, source) DO UPDATE SET
         active_sec = excluded.active_sec, afk_sec = excluded.afk_sec, apps_json = excluded.apps_json,
         games_json = excluded.games_json, updated_at = excluded.updated_at`,
      a.user_id, a.day_key, a.source, a.active_sec, a.afk_sec, JSON.stringify(a.apps), JSON.stringify(a.games), now(),
    );
  }
  async activityOf(userId: number, dayKey: string): Promise<ActivityRow[]> {
    return (await this.all<Row>("SELECT * FROM activity WHERE user_id = ? AND day_key = ?", userId, dayKey)).map(toActivity);
  }
  async activityRange(userId: number, from: string, to: string): Promise<ActivityRow[]> {
    return (await this.all<Row>(
      "SELECT * FROM activity WHERE user_id = ? AND day_key BETWEEN ? AND ? ORDER BY day_key", userId, from, to,
    )).map(toActivity);
  }

  // --- служебное ---
  async kvGet(key: string): Promise<string | undefined> {
    return (await this.get<{ value: string }>("SELECT value FROM kv WHERE key = ?", key))?.value;
  }
  async kvSet(key: string, value: string) {
    await this.run("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, value);
  }
  /** Поставить отметку один раз; true — если её ещё не было. */
  async once(key: string): Promise<boolean> {
    return (await this.run("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING", key, now())) > 0;
  }
}

function toActivity(r: Row): ActivityRow {
  return {
    user_id: Number(r.user_id),
    day_key: r.day_key as string,
    source: r.source as string,
    active_sec: Number(r.active_sec),
    afk_sec: Number(r.afk_sec),
    apps: JSON.parse(r.apps_json as string),
    games: JSON.parse(r.games_json as string),
    updated_at: r.updated_at as string,
  };
}
