import type { EventRow, Store, User } from "./db.ts";
import { habitLine, habitsOfDay } from "./habits.ts";
import type { LlmCall } from "./llm.ts";
import { persona, type Emotion } from "./personas.ts";
import {
  activityLines, dateLine, diaryBySection, esc, eventLine, metricLine, moneyLine, plansText, sectionName, todayText, upcomingDates,
} from "./report.ts";
import { escapesText } from "./escapes.ts";
import { findPatterns, patternText, traitButtons } from "./profile.ts";
import { extendSeries } from "./repeat.ts";
import { addDays, dayKey, humanDay, timeOf, zonedToUtc } from "./time.ts";

// Напоминания и итоги. Всё состояние — в базе (reminders, kv), поэтому перезапуск ничего не теряет,
// а повторный запуск не шлёт то же самое дважды.

/** Кнопка под уведомлением: текст и что вернуть боту (callback) или приложению. */
export interface Button {
  text: string;
  data: string;
}
export type Send = (u: User, text: string, emotion: Emotion, buttons?: Button[]) => Promise<void>;

/** Кнопки «да / нет» для привычки на день: «нет» — пропуск (в курсе — крестик за день). */
export const habitButtons = (habitId: number, day: string): Button[] => [
  { text: "✅ Да", data: `habit:${habitId}:${day}:done` },
  { text: "✖ Нет", data: `habit:${habitId}:${day}:skipped` },
];

/** Привычку без своего времени спросить вечером — за час до вечернего итога, но не позже 20:00. */
export function habitAskTime(u: Pick<User, "evening_time">): string {
  const [h, m] = u.evening_time.split(":").map(Number);
  const t = Math.min(20 * 60, Math.max(0, h * 60 + m - 60));
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

/** Вопрос горничной про привычку: «Витамины — сегодня сделали?», с серией, если есть. */
export const habitQuestion = (title: string, streak: number) =>
  `🔁 ${esc(title)} — сегодня сделали?${streak >= 2 ? ` (серия ${streak} 🔥)` : ""}`;

/** Запланировать «за N минут» до плана со временем. */
export async function planEventReminders(store: Store, u: User, e: EventRow, now: Date) {
  if (!e.time || e.status !== "active") return;
  const start = zonedToUtc(e.date_iso, e.time, u.tz);
  const due = new Date(start.getTime() - u.event_lead_min * 60_000);
  if (due <= now) return;
  const lead = u.event_lead_min >= 60 && u.event_lead_min % 60 === 0 ? `${u.event_lead_min / 60} ч` : `${u.event_lead_min} мин`;
  await store.addReminder(u.id, "event", e.id, due, `⏰ Через ${lead}: ${eventLine(e)}`);
}

/** Отложить уведомление: то же самое через N минут (кнопка «Через 30 мин» в push). */
export async function snooze(store: Store, u: User, text: string, buttons: Button[], minutes: number, now = new Date()) {
  const due = new Date(now.getTime() + minutes * 60_000);
  await store.addReminder(u.id, "snooze", now.getTime(), due, text, buttons.length ? JSON.stringify(buttons) : "");
}

/** Окно, в котором ещё не поздно прислать дайджест после простоя сервера. */
const LATE_MIN = 180;
/** Напоминание о привычке позже часа уже не шлём. */
const HABIT_LATE_MIN = 60;

function minutesOf(t: string) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  /** Ещё работа на каждый такт (фоновый повтор разбора — Pipeline.retryFailed). */
  extra: ((now: Date) => Promise<void>) | null = null;

  /** backup — раз в сутки (03:30 по часам пользователя) отправить резервную копию, если есть куда. */
  constructor(private store: Store, private llm: LlmCall | null, private send: Send, private backup?: (u: User) => Promise<void>) {}

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
      for (const r of await this.store.dueReminders(now)) {
        const u = await this.store.user(r.user_id);
        if (!u) continue;
        // Устарело больше чем на час (сервер спал) — не будим зря.
        const late = now.getTime() - new Date(r.due_at).getTime() > 60 * 60_000;
        let buttons: Button[] | undefined;
        try {
          buttons = r.buttons ? (JSON.parse(r.buttons) as Button[]) : undefined;
        } catch {
          buttons = undefined;
        }
        if (!late) await this.safeSend(u, r.text, "neutral", buttons);
        await this.store.markReminder(r.id, late ? "cancelled" : "sent");
      }
      for (const u of await this.store.users()) {
        await this.daily(u, now);
        await this.habits(u, now);
        if (this.backup && this.due(u, "03:30", now, 300) && (await this.store.once(`backup:${u.id}:${dayKey(now, u.tz)}`))) {
          await this.backup(u).catch((e) => console.error("[backup]", u.id, e));
        }
      }
      await this.extra?.(now).catch((e) => console.error("[tick]", e));
      // Раз в сутки — убрать отметки «уже отправлено» старше 60 дней.
      if (await this.store.once(`prune:${now.toISOString().slice(0, 10)}`)) {
        await this.store.pruneOnce(new Date(now.getTime() - 60 * 86_400_000)).catch((e) => console.error("[prune]", e));
      }
    } finally {
      this.busy = false;
    }
  }

  private due(u: User, at: string, now: Date, late = LATE_MIN) {
    const m = minutesOf(timeOf(now, u.tz)) - minutesOf(at);
    return m >= 0 && m <= late;
  }

  /** Привычки: спросить в своё время (или вечером, если времени нет), пока не отмечена. */
  private async habits(u: User, now: Date) {
    const today = dayKey(now, u.tz);
    for (const d of await habitsOfDay(this.store, u, today)) {
      if (d.status || d.habit.quiet) continue;
      for (const t of d.times.length ? d.times : [habitAskTime(u)]) {
        if (!this.due(u, t, now, HABIT_LATE_MIN) || !(await this.store.once(`habit:${d.habit.id}:${today}:${t}`))) continue;
        await this.safeSend(u, habitQuestion(d.habit.title, d.streak), "neutral", habitButtons(d.habit.id, today));
      }
    }
  }

  private async daily(u: User, now: Date) {
    const today = dayKey(now, u.tz);
    const s = this.store;
    if (this.due(u, u.morning_time, now) && (await s.once(`morning:${u.id}:${today}`))) {
      await this.safeSend(u, `☀️ Доброе утро.\n\n${await todayText(s, u, today)}`, "happy");
      for (const d of upcomingDates(await s.activeDates(u.id), today, 7)) {
        if ([7, 1, 0].includes(d.inDays) && (await s.once(`date:${d.row.id}:${d.on}:${d.inDays}`))) {
          await this.safeSend(u, `🎂 ${dateLine(d)}`, d.inDays === 0 ? "happy" : "neutral");
        }
      }
    }
    if (this.due(u, u.tomorrow_time, now) && (await s.once(`tomorrow:${u.id}:${today}`))) {
      const tomorrow = addDays(today, 1);
      const evs = await s.eventsBetween(u.id, tomorrow, tomorrow);
      if (evs.length) {
        await this.safeSend(u, `🌙 Завтра, ${humanDay(tomorrow)}:\n${evs.map((e) => "• " + eventLine(e)).join("\n")}`, "neutral");
      }
    }
    if (this.due(u, u.evening_time, now) && (await s.once(`evening:${u.id}:${today}`))) {
      await this.safeSend(u, await this.eveningText(u, today), "proud");
      // В воскресенье вечером — мягко о задачах, от которых сбежали за неделю.
      if (new Date(`${today}T12:00:00Z`).getUTCDay() === 0 && (await s.once(`escapes:${u.id}:${today}`))) {
        const text = escapesText(await s.allTasks(u.id), today, u.tz);
        if (text) await this.safeSend(u, text, "worried");
      }
    }
    // Закономерности в самочувствии: раз в день днём — предложить дебаф (добавится, только если человек согласится).
    if (this.llm && this.due(u, "13:00", now) && (await s.once(`patterns:${u.id}:${today}`))) {
      try {
        for (const t of await findPatterns(s, this.llm, u, today)) await this.safeSend(u, patternText(t, esc), "worried", traitButtons(t.id));
      } catch (err) { console.error("[patterns]", u.id, err); }
    }
    // Повторяющиеся планы: раз в день разложить серии дальше.
    if (await s.once(`series:${u.id}:${today}`)) {
      for (const e of await s.allEvents(u.id)) {
        if (e.repeat) await extendSeries(s, u, e, today, now).catch((err) => console.error("[series]", e.id, err));
      }
    }
  }

  /** Вечерний итог: сводка фактами + несколько строк в голосе горничной. */
  async eveningText(u: User, today: string): Promise<string> {
    const s = this.store;
    const diary = diaryBySection(await s.diaryOf(u.id, today));
    const facts: string[] = [];
    for (const [sec, lines] of diary) {
      if (sec === "summary" || sec === "tags") continue;
      facts.push(`${sectionName(sec)}: ${lines.join("; ")}`);
    }
    const act = activityLines(await s.activityOf(u.id, today)).map((l) => l.replace(/<[^>]+>/g, ""));
    const done = (await s.allTasks(u.id)).filter((t) => t.done_at && dayKey(new Date(t.done_at), u.tz) === today);
    const plans = (await s.allEvents(u.id)).filter((e) => e.date_iso === today && e.status !== "deleted" && e.status !== "purged");
    const habits = await habitsOfDay(s, u, today);
    const metrics = metricLine(await s.metricsRange(u.id, today, today));
    const money = await s.moneyRange(u.id, today, today);
    const head = [
      `<b>Итог дня, ${humanDay(today)}</b>`,
      ...facts.map((f) => "• " + esc(f)),
      ...act,
      metrics ? `📊 ${metrics}` : "",
      ...money.map((m) => "💰 " + moneyLine(m)),
      ...habits.map(habitLine),
      done.length ? `✔ сделано задач: ${done.length}` : "",
      plans.length ? `📅 планов было: ${plans.length}` : "",
    ].filter(Boolean);
    if (head.length === 1) head.push("Сегодня записей нет.");
    if (!this.llm) return head.join("\n");
    const summaries = diary.get("summary")?.join("\n") ?? "";
    try {
      const words = await this.llm([
        {
          role: "system",
          content: `${persona(u.persona).voice}\nНапиши 3–6 коротких строк вечернего итога дня для хозяина: что было хорошо, ` +
            `что тревожит (сон, еда, игры, несделанное), один совет на завтра. Только по фактам ниже, без выдумок, без заголовков.`,
        },
        {
          role: "user",
          content: `${head.join("\n").replace(/<[^>]+>/g, "")}\n\nЗаписи дня:\n${summaries || "нет"}\n\nЗавтра:\n${
            (await plansText(s, u, addDays(today, 1), 0)).replace(/<[^>]+>/g, "")}`,
        },
      ], { temperature: 0.6 });
      return `${head.join("\n")}\n\n${esc(words.trim())}`;
    } catch (e) {
      console.error("[evening]", e);
      return head.join("\n");
    }
  }

  private async safeSend(u: User, text: string, emotion: Emotion, buttons?: Button[]) {
    try {
      await this.send(u, text, emotion, buttons);
    } catch (e) {
      console.error("[send]", u.id, e);
    }
  }
}
