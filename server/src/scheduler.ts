import type { EventRow, Store, User } from "./db.ts";
import type { LlmCall } from "./llm.ts";
import { persona, type Emotion } from "./personas.ts";
import { activityLines, dateLine, diaryBySection, esc, eventLine, plansText, sectionName, todayText, upcomingDates } from "./report.ts";
import { addDays, dayKey, humanDay, timeOf, zonedToUtc } from "./time.ts";

// Напоминания и итоги. Всё состояние — в базе (reminders, kv), поэтому перезапуск ничего не теряет,
// а повторный запуск не шлёт то же самое дважды.

export type Send = (u: User, text: string, emotion: Emotion) => Promise<void>;

/** Запланировать «за N минут» до плана со временем. */
export function planEventReminders(store: Store, u: User, e: EventRow, now: Date) {
  if (!e.time || e.status !== "active") return;
  const start = zonedToUtc(e.date_iso, e.time, u.tz);
  const due = new Date(start.getTime() - u.event_lead_min * 60_000);
  if (due <= now) return;
  const lead = u.event_lead_min >= 60 && u.event_lead_min % 60 === 0 ? `${u.event_lead_min / 60} ч` : `${u.event_lead_min} мин`;
  store.addReminder(u.id, "event", e.id, due, `⏰ Через ${lead}: ${eventLine(e)}`);
}

/** Окно, в котором ещё не поздно прислать дайджест после простоя сервера. */
const LATE_MIN = 180;

function minutesOf(t: string) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(private store: Store, private llm: LlmCall | null, private send: Send) {}

  start(everyMs = 30_000) {
    this.timer = setInterval(() => void this.tick(), everyMs);
    void this.tick();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(now = new Date()) {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const r of this.store.dueReminders(now)) {
        const u = this.store.user(r.user_id);
        if (!u) continue;
        // Устарело больше чем на час (сервер спал) — не будим зря.
        const late = now.getTime() - new Date(r.due_at).getTime() > 60 * 60_000;
        if (!late) await this.safeSend(u, r.text, "neutral");
        this.store.markReminder(r.id, late ? "cancelled" : "sent");
      }
      for (const u of this.store.users()) await this.daily(u, now);
    } finally {
      this.busy = false;
    }
  }

  private due(u: User, at: string, now: Date) {
    const m = minutesOf(timeOf(now, u.tz)) - minutesOf(at);
    return m >= 0 && m <= LATE_MIN;
  }

  private async daily(u: User, now: Date) {
    const today = dayKey(now, u.tz);
    const s = this.store;
    if (this.due(u, u.morning_time, now) && s.once(`morning:${u.id}:${today}`)) {
      await this.safeSend(u, `☀️ Доброе утро.\n\n${todayText(s, u, today)}`, "happy");
      for (const d of upcomingDates(s.activeDates(u.id), today, 7)) {
        if ([7, 1, 0].includes(d.inDays) && s.once(`date:${d.row.id}:${d.on}:${d.inDays}`)) {
          await this.safeSend(u, `🎂 ${dateLine(d)}`, d.inDays === 0 ? "happy" : "neutral");
        }
      }
    }
    if (this.due(u, u.tomorrow_time, now) && s.once(`tomorrow:${u.id}:${today}`)) {
      const tomorrow = addDays(today, 1);
      const evs = s.eventsBetween(u.id, tomorrow, tomorrow);
      if (evs.length) {
        await this.safeSend(u, `🌙 Завтра, ${humanDay(tomorrow)}:\n${evs.map((e) => "• " + eventLine(e)).join("\n")}`, "neutral");
      }
    }
    if (this.due(u, u.evening_time, now) && s.once(`evening:${u.id}:${today}`)) {
      await this.safeSend(u, await this.eveningText(u, today), "proud");
    }
  }

  /** Вечерний итог: сводка фактами + несколько строк в голосе горничной. */
  async eveningText(u: User, today: string): Promise<string> {
    const s = this.store;
    const diary = diaryBySection(s.diaryOf(u.id, today));
    const facts: string[] = [];
    for (const [sec, lines] of diary) {
      if (sec === "summary" || sec === "tags") continue;
      facts.push(`${sectionName(sec)}: ${lines.join("; ")}`);
    }
    const act = activityLines(s.activityOf(u.id, today)).map((l) => l.replace(/<[^>]+>/g, ""));
    const done = s.allTasks(u.id).filter((t) => t.done_at && dayKey(new Date(t.done_at), u.tz) === today);
    const plans = s.allEvents(u.id).filter((e) => e.date_iso === today && e.status !== "deleted");
    const head = [
      `<b>Итог дня, ${humanDay(today)}</b>`,
      ...facts.map((f) => "• " + esc(f)),
      ...act,
      done.length ? `✔ сделано задач: ${done.length}` : "",
      plans.length ? `📅 планов было: ${plans.length}` : "",
    ].filter(Boolean);
    if (facts.length === 0 && act.length === 0 && done.length === 0) head.push("Сегодня записей нет.");
    if (!this.llm) return head.join("\n");
    const summaries = diary.get("summary")?.join("\n") ?? "";
    try {
      const words = await this.llm([
        {
          role: "system",
          content: `${persona(u.persona).voice}\nНапиши 3–6 коротких строк вечернего итога дня для хозяина: что было хорошо, ` +
            `что тревожит (сон, еда, игры, несделанное), один совет на завтра. Только по фактам ниже, без выдумок, без заголовков.`,
        },
        { role: "user", content: `${head.join("\n").replace(/<[^>]+>/g, "")}\n\nЗаписи дня:\n${summaries || "нет"}\n\nЗавтра:\n${plansText(s, u, addDays(today, 1), 0).replace(/<[^>]+>/g, "")}` },
      ], { temperature: 0.6 });
      return `${head.join("\n")}\n\n${esc(words.trim())}`;
    } catch (e) {
      console.error("[evening]", e);
      return head.join("\n");
    }
  }

  private async safeSend(u: User, text: string, emotion: Emotion) {
    try {
      await this.send(u, text, emotion);
    } catch (e) {
      console.error("[send]", u.id, e);
    }
  }
}
