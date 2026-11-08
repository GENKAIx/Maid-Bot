import fs from "node:fs";
import { JWT } from "google-auth-library";
import { config } from "./config.ts";
import type { Store, Table, User } from "./db.ts";
import { SECTIONS, TRACKER_SECTIONS } from "./parse.ts";
import { durationHuman, humanDay } from "./time.ts";

// Зеркало в Google Таблицу: база — главная, таблица переписывается из неё целыми листами.
// Правки, сделанные руками в таблице, обратно не читаются. Зеркалится владелец (первый пользователь).

const API = "https://sheets.googleapis.com/v4/spreadsheets";
type Cell = string | number;

export const sheetsReady = () =>
  Boolean(config.sheets.spreadsheetId && config.sheets.serviceAccountFile && fs.existsSync(config.sheets.serviceAccountFile));

export class SheetsMirror {
  private dirty = new Set<Table>();
  private timer: NodeJS.Timeout | null = null;
  private client: JWT;
  private running = false;

  constructor(private store: Store, private owner: () => User | undefined) {
    const key = JSON.parse(fs.readFileSync(config.sheets.serviceAccountFile, "utf8"));
    this.client = new JWT({ email: key.client_email, key: key.private_key, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
  }

  mark(tbl: Table, userId: number) {
    if (this.owner()?.id === userId) this.dirty.add(tbl);
  }

  start(everyMs = 60_000) {
    for (const t of ["diary", "events", "tasks", "dates", "memory", "activity"] as Table[]) this.dirty.add(t);
    this.timer = setInterval(() => void this.flush(), everyMs);
    void this.flush();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async flush() {
    const u = this.owner();
    if (!u || this.running || !this.dirty.size) return;
    this.running = true;
    const todo = new Set(this.dirty);
    this.dirty.clear();
    try {
      const tabs: Record<string, Cell[][]> = {};
      if (todo.has("diary") || todo.has("activity")) tabs["Дневник"] = this.diaryRows(u);
      if (todo.has("events")) tabs["Планы"] = this.eventRows(u);
      if (todo.has("tasks")) tabs["Задачи"] = this.taskRows(u);
      if (todo.has("dates")) tabs["Даты"] = this.dateRows(u);
      if (todo.has("memory")) tabs["Память"] = this.memoryRows(u);
      if (todo.has("activity")) tabs["Активность"] = this.activityRows(u);
      await this.write(tabs);
    } catch (e) {
      for (const t of todo) this.dirty.add(t);
      console.error("[sheets]", e);
    } finally {
      this.running = false;
    }
  }

  private async req(path: string, init: { method?: string; body?: unknown } = {}) {
    const res = await this.client.request({ url: `${API}/${config.sheets.spreadsheetId}${path}`, method: (init.method ?? "GET") as "GET", data: init.body });
    return res.data as Record<string, unknown>;
  }

  private async write(tabs: Record<string, Cell[][]>) {
    const meta = await this.req("?fields=sheets.properties.title");
    const have = new Set(((meta.sheets as { properties: { title: string } }[]) ?? []).map((s) => s.properties.title));
    const add = Object.keys(tabs).filter((t) => !have.has(t));
    if (add.length) {
      await this.req(":batchUpdate", { method: "POST", body: { requests: add.map((title) => ({ addSheet: { properties: { title } } })) } });
    }
    const names = Object.keys(tabs);
    await this.req("/values:batchClear", { method: "POST", body: { ranges: names.map((n) => `'${n}'`) } });
    await this.req("/values:batchUpdate", {
      method: "POST",
      body: { valueInputOption: "RAW", data: names.map((n) => ({ range: `'${n}'!A1`, values: tabs[n] })) },
    });
  }

  diaryRows(u: User): Cell[][] {
    const cols = [...Object.keys(SECTIONS), "tags", "pc", "games", "steps", "summary"];
    const head = ["Дата", "День", ...Object.values(SECTIONS), "Теги", TRACKER_SECTIONS.pc, TRACKER_SECTIONS.games, TRACKER_SECTIONS.steps, "Саммари"];
    const days = new Map<string, Map<string, string[]>>();
    const put = (day: string, col: string, text: string) => {
      const d = days.get(day) ?? new Map<string, string[]>();
      d.set(col, [...(d.get(col) ?? []), text]);
      days.set(day, d);
    };
    for (const day of this.store.diaryDays(u.id)) {
      for (const r of this.store.diaryOf(u.id, day)) put(day, r.section, r.text);
    }
    for (const a of this.store.activityRange(u.id, "0000-01-01", "9999-12-31")) {
      if (a.active_sec) put(a.day_key, "pc", `${durationHuman(a.active_sec)}: ${a.apps.slice(0, 5).map((x) => `${x.name} ${durationHuman(x.sec)}`).join(", ")}`);
      if (a.games.length) put(a.day_key, "games", a.games.map((g) => `${g.name} ${durationHuman(g.sec)}`).join(", "));
      if (a.steps) put(a.day_key, "steps", String(a.steps));
    }
    const rows: Cell[][] = [head];
    for (const day of [...days.keys()].sort().reverse()) {
      const d = days.get(day)!;
      rows.push([day, humanDay(day).split(", ")[1], ...cols.map((c) => (d.get(c) ?? []).join(c === "summary" ? "\n" : "; "))]);
    }
    return rows;
  }
  eventRows(u: User): Cell[][] {
    return [["#", "Дата", "Время", "До", "Что", "Детали", "Статус"],
      ...this.store.allEvents(u.id).filter((e) => e.status !== "deleted")
        .map((e) => [e.id, e.date_iso, e.time ?? "", e.end_time ?? "", e.title, e.details, e.status])];
  }
  taskRows(u: User): Cell[][] {
    return [["#", "Задача", "Важность", "Срок", "Категория", "Статус", "Создана", "Сделана"],
      ...this.store.allTasks(u.id).filter((t) => t.status !== "deleted")
        .map((t) => [t.id, t.title, t.priority, t.due_date ?? "", t.category, t.status, t.created_at.slice(0, 10), t.done_at?.slice(0, 10) ?? ""])];
  }
  dateRows(u: User): Cell[][] {
    return [["#", "Дата", "Что", "Тип", "Кто", "Каждый год"],
      ...this.store.activeDates(u.id).map((d) => [d.id, d.date_iso, d.title, d.type, d.person, d.yearly ? "да" : "нет"])];
  }
  memoryRows(u: User): Cell[][] {
    return [["#", "Вид", "О ком/чём", "Факт", "Когда"],
      ...this.store.activeMemory(u.id).map((m) => [m.id, m.kind, m.subject, m.text, m.created_at.slice(0, 10)])];
  }
  activityRows(u: User): Cell[][] {
    return [["Дата", "Источник", "Активно, мин", "AFK, мин", "Приложения", "Игры", "Шаги"],
      ...this.store.activityRange(u.id, "0000-01-01", "9999-12-31").reverse().map((a) => [
        a.day_key, a.source, Math.round(a.active_sec / 60), Math.round(a.afk_sec / 60),
        a.apps.map((x) => `${x.name} ${Math.round(x.sec / 60)}`).join(", "),
        a.games.map((x) => `${x.name} ${Math.round(x.sec / 60)}`).join(", "), a.steps ?? "",
      ])];
  }
}
