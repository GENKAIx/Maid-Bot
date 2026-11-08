import type { ActivityRow, DateRow, DiaryRow, EventRow, Store, TaskRow, User } from "./db.ts";
import { SECTIONS, TRACKER_SECTIONS, type Section } from "./parse.ts";
import { addDays, daysBetween, durationHuman, humanDay, nextYearly } from "./time.ts";

// Готовые тексты для бота, десктопа и зеркала. Telegram — HTML.

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function eventLine(e: EventRow, withDay = false): string {
  const time = e.time ? `${e.time}${e.end_time ? "–" + e.end_time : ""}` : "весь день";
  return `${withDay ? humanDay(e.date_iso) + ", " : ""}${time} — ${esc(e.title)}`;
}

export function taskLine(t: TaskRow, today: string): string {
  const mark = t.priority === "high" ? "❗ " : "";
  let due = "";
  if (t.due_date) {
    const d = daysBetween(today, t.due_date);
    due = d < 0 ? ` <i>(просрочено ${-d} дн.)</i>` : d === 0 ? " <i>(сегодня)</i>" : ` <i>(до ${humanDay(t.due_date)})</i>`;
  }
  return `${mark}${esc(t.title)}${due}`;
}

export interface UpcomingDate {
  row: DateRow;
  on: string;
  inDays: number;
  age: number | null;
}

export function upcomingDates(rows: DateRow[], today: string, within = 60): UpcomingDate[] {
  const out: UpcomingDate[] = [];
  for (const r of rows) {
    const on = r.yearly ? nextYearly(r.date_iso, today) : r.date_iso;
    const inDays = daysBetween(today, on);
    if (inDays < 0 || inDays > within) continue;
    const startYear = Number(r.date_iso.slice(0, 4));
    const age = r.yearly && startYear > 1900 && on.slice(0, 4) !== r.date_iso.slice(0, 4) ? Number(on.slice(0, 4)) - startYear : null;
    out.push({ row: r, on, inDays, age });
  }
  return out.sort((a, b) => a.inDays - b.inDays);
}

export function dateLine(u: UpcomingDate): string {
  const when = u.inDays === 0 ? "сегодня" : u.inDays === 1 ? "завтра" : `через ${u.inDays} дн., ${humanDay(u.on)}`;
  return `${esc(u.row.title)}${u.age ? ` (${u.age})` : ""} — ${when}`;
}

/** Дневник дня по разделам: раздел → строки. */
export function diaryBySection(rows: DiaryRow[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const r of rows) {
    const list = m.get(r.section) ?? [];
    list.push(r.text);
    m.set(r.section, list);
  }
  return m;
}

export const sectionName = (s: string) =>
  (SECTIONS as Record<string, string>)[s] ?? (TRACKER_SECTIONS as Record<string, string>)[s] ?? (s === "summary" ? "Саммари" : s);

export function activityLines(rows: ActivityRow[]): string[] {
  const out: string[] = [];
  for (const a of rows) {
    if (a.active_sec > 0) {
      const top = a.apps.slice(0, 3).map((x) => `${x.name} ${durationHuman(x.sec)}`).join(", ");
      out.push(`💻 ${durationHuman(a.active_sec)} за ПК${top ? ": " + esc(top) : ""}`);
    }
    const games = a.games.reduce((s, g) => s + g.sec, 0);
    if (games > 0) out.push(`🎮 ${durationHuman(games)}: ${esc(a.games.map((g) => `${g.name} ${durationHuman(g.sec)}`).join(", "))}`);
    if (a.steps) out.push(`🚶 ${a.steps.toLocaleString("ru-RU")} шагов`);
  }
  return out;
}

export function todayText(store: Store, u: User, today: string): string {
  const parts: string[] = [`<b>${humanDay(today)}</b>`];
  const evs = store.eventsBetween(u.id, today, today);
  parts.push(evs.length ? `\n<b>Планы</b>\n${evs.map((e) => "• " + eventLine(e)).join("\n")}` : "\nПланов на сегодня нет.");
  const tasks = store.openTasks(u.id).slice(0, 7);
  if (tasks.length) parts.push(`\n<b>Задачи</b>\n${tasks.map((t) => "• " + taskLine(t, today)).join("\n")}`);
  const dates = upcomingDates(store.activeDates(u.id), today, 7);
  if (dates.length) parts.push(`\n<b>Скоро</b>\n${dates.map((d) => "• " + dateLine(d)).join("\n")}`);
  const diary = diaryBySection(store.diaryOf(u.id, today).filter((r) => r.section !== "summary"));
  if (diary.size) {
    parts.push(
      `\n<b>Дневник</b>\n${[...diary].map(([s, l]) => `${sectionName(s)}: ${esc(l.join("; "))}`).join("\n")}`,
    );
  }
  const act = activityLines(store.activityOf(u.id, today));
  if (act.length) parts.push("\n" + act.join("\n"));
  return parts.join("\n");
}

export function plansText(store: Store, u: User, today: string, days = 14): string {
  const evs = store.eventsBetween(u.id, today, addDays(today, days));
  if (!evs.length) return `На ${days} дней вперёд планов нет.`;
  const lines: string[] = [];
  let last = "";
  for (const e of evs) {
    if (e.date_iso !== last) {
      lines.push(`\n<b>${humanDay(e.date_iso)}</b>`);
      last = e.date_iso;
    }
    lines.push(`• ${eventLine(e)} <code>#${e.id}</code>`);
  }
  return lines.join("\n").trim();
}

export function tasksText(store: Store, u: User, today: string): string {
  const tasks = store.openTasks(u.id);
  if (!tasks.length) return "Открытых задач нет. Чисто.";
  return `<b>Задачи (${tasks.length})</b>\n` + tasks.map((t) => `• ${taskLine(t, today)} <code>#${t.id}</code>`).join("\n");
}

export function datesText(store: Store, u: User, today: string): string {
  const list = upcomingDates(store.activeDates(u.id), today, 366);
  if (!list.length) return "Важных дат пока нет. Напишите, например: «у мамы день рождения 14 марта».";
  return "<b>Важные даты</b>\n" + list.map((d) => `• ${dateLine(d)} <code>#${d.row.id}</code>`).join("\n");
}

export function memoryText(store: Store, u: User): string {
  const list = store.activeMemory(u.id);
  if (!list.length) return "Пока ничего не запомнила о вас.";
  return "<b>Что я помню</b>\n" + list.map((m) => `• ${m.subject ? esc(m.subject) + ": " : ""}${esc(m.text)} <code>#${m.id}</code>`).join("\n");
}

/** Дни дневника одним текстом — для ответа на вопрос о прошлом. */
export function diaryDigest(store: Store, u: User, from: string, to: string): string {
  const rows = store.diaryRange(u.id, from, to);
  const act = store.activityRange(u.id, from, to);
  const days = new Map<string, string[]>();
  for (const r of rows) {
    const l = days.get(r.day_key) ?? [];
    l.push(`${sectionName(r.section)}: ${r.text}`);
    days.set(r.day_key, l);
  }
  for (const a of act) {
    const l = days.get(a.day_key) ?? [];
    l.push(...activityLines([a]).map((s) => s.replace(/<[^>]+>/g, "")));
    days.set(a.day_key, l);
  }
  for (const e of store.allEvents(u.id).filter((e) => e.date_iso >= from && e.date_iso <= to)) {
    const l = days.get(e.date_iso) ?? [];
    l.push(`План: ${e.time ?? "весь день"} ${e.title} (${e.status})`);
    days.set(e.date_iso, l);
  }
  return [...days].sort(([a], [b]) => (a < b ? -1 : 1)).map(([d, l]) => `${d}:\n${l.join("\n")}`).join("\n\n") || "Записей нет.";
}

/** Короткий список того, что изменилось — ответ после записи. */
export function changesList(c: { sections: Section[]; summary: boolean; events: number; tasks: number; dates: number; memory: number; edits: string[] }): string[] {
  const out: string[] = [];
  if (c.sections.length) out.push("📓 " + [...new Set(c.sections)].map((s) => SECTIONS[s]).join(", "));
  else if (c.summary) out.push("📓 Саммари");
  if (c.events) out.push(`📅 планов: ${c.events}`);
  if (c.tasks) out.push(`✅ задач: ${c.tasks}`);
  if (c.dates) out.push(`🎂 дат: ${c.dates}`);
  if (c.memory) out.push(`🧠 запомнила: ${c.memory}`);
  out.push(...c.edits);
  return out;
}
