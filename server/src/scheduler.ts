import type { EventRow, Store, User } from "./db.ts";
import { habitLine, habitsOfDay } from "./habits.ts";
import type { LlmCall } from "./llm.ts";
import { persona, type Emotion } from "./personas.ts";
import {
  activityLines, dateLine, diaryBySection, esc, eventLine, metricLine, moneyLine, moneyTotals, plansText, sectionName, todayText,
  upcomingDates,
} from "./report.ts";
import { escapesText } from "./escapes.ts";
import { findPatterns, patternText, traitButtons } from "./profile.ts";
import { extendSeries } from "./repeat.ts";
import { addDays, dayKey, durationHuman, humanDay, timeOf, userDay, zonedToUtc } from "./time.ts";

/** Слова горничной в вечернем итоге — не длиннее (знаков); длиннее в полтора раза — обрезаем по слову. */
export const EVENING_MAX = 300;

const plural = (n: number, one: string, few: string, many: string) =>
  n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many;

/** Цифры дня одной строкой — только то, что было: «✔ 3 задачи · привычки 3/3 · 🎮 2 ч · 📝 4 записи · −1 200 RUB». */
export function dayNumbers(d: { tasks: number; habitsDone: number; habits: number; gameSec: number; notes: number; spent: string[] }): string {
  return [
    d.tasks ? `✔ ${d.tasks} ${plural(d.tasks, "задача", "задачи", "задач")}` : "",
    d.habits ? `привычки ${d.habitsDone}/${d.habits}` : "",
    d.gameSec >= 60 ? `🎮 ${durationHuman(d.gameSec)}` : "",
    d.notes ? `📝 ${d.notes} ${plural(d.notes, "запись", "записи", "записей")}` : "",
    ...d.spent.map((x) => `💸 ${x}`),
  ].filter(Boolean).join(" · ");
}

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
  { text: "⏳ Ещё нет", data: `habit:${habitId}:${day}:later` },
  { text: "✖ Нет", data: `habit:${habitId}:${day}:skipped` },
];

/** Когда спросить про привычку: в её время (или habit_first, 12:00), и ещё раз в habit_last (23:00), если тот позже. */
export function habitAskTimes(u: Pick<User, "habit_first" | "habit_last">, own: string[]): string[] {
  const first = own.length ? own : [u.habit_first];
  return first.some((t) => t >= u.habit_last) ? first : [...first, u.habit_last];
}

/** Вопрос горничной про привычку: «Витамины — сегодня сделали?», с серией, если есть. */
export const habitQuestion = (title: string, streak: number) =>
  `🔁 ${esc(title)} — сегодня сделали?${streak >= 2 ? ` (серия ${streak} 🔥)` : ""}`;

/** Самое раннее «за сколько» в своём варианте — неделя. */
export const REMIND_MAX_MIN = 7 * 24 * 60;
/** Когда напоминать о плане со временем (настройка «Когда напоминать о событиях», users.event_reminders, через запятую):
 * «day» — в начале дня (в час утренней сводки), число — за столько минут до начала, 0 — в момент начала, «off» — никогда.
 * Пусто (старые пользователи) — за event_lead_min и в момент начала. */
export function remindPlan(u: Pick<User, "event_reminders" | "event_lead_min">): ("day" | number)[] {
  const raw = (u.event_reminders ?? "").trim() || `${u.event_lead_min},0`;
  const out: ("day" | number)[] = [];
  for (const t of raw.split(",").map((x) => x.trim())) {
    const v = t === "day" ? "day" : /^\d+$/.test(t) && Number(t) <= REMIND_MAX_MIN ? Number(t) : null;
    if (v !== null && !out.includes(v)) out.push(v);
  }
  return out;
}
/** Настройка как её хранить: без повторов и непонятного, по порядку — «day», потом от раннего к позднему; ничего — «off». */
export function remindText(raw: string): string {
  if (raw.trim() === "off") return "off";
  const plan = remindPlan({ event_reminders: raw, event_lead_min: 60 });
  const mins = plan.filter((x): x is number => x !== "day").sort((a, b) => b - a);
  const out = [...(plan.includes("day") ? ["day"] : []), ...mins.map(String)];
  return out.length ? out.join(",") : "off";
}
/** «Через 5 мин», «Через 1 ч», «Через 2 ч 30 мин», «Через 1 дн.». */
export function leadText(min: number): string {
  if (min >= 1440 && min % 1440 === 0) return `${min / 1440} дн.`;
  if (min < 60) return `${min} мин`;
  return min % 60 ? `${Math.floor(min / 60)} ч ${min % 60} мин` : `${min / 60} ч`;
}

/** Запланировать напоминания о плане со временем — по настройке пользователя (remindPlan); уже прошедшие моменты пропускаются. */
export async function planEventReminders(store: Store, u: User, e: EventRow, now: Date) {
  if (!e.time || e.status !== "active") return;
  const start = zonedToUtc(e.date_iso, e.time, u.tz);
  for (const r of remindPlan(u)) {
    const due = r === "day" ? zonedToUtc(e.date_iso, u.morning_time, u.tz) : new Date(start.getTime() - r * 60_000);
    if (due <= now || due > start || (r === "day" && +due === +start)) continue;
    const text = r === "day" ? `📅 Сегодня: ${eventLine(e)}` : r === 0 ? `⏰ Пора: ${eventLine(e)}` : `⏰ Через ${leadText(r)}: ${eventLine(e)}`;
    await store.addReminder(u.id, "event", e.id, due, text);
  }
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

  /** Привычки: спросить в своё время (или в habit_first), ещё раз в habit_last, пока не отмечена; в начале нового дня (DAY_START_HOUR) — минус (daily). */
  private async habits(u: User, now: Date) {
    const today = userDay(now, u.tz);
    for (const d of await habitsOfDay(this.store, u, today)) {
      if (d.status || d.habit.quiet) continue;
      for (const t of habitAskTimes(u, d.times)) {
        if (!this.due(u, t, now, HABIT_LATE_MIN) || !(await this.store.once(`habit:${d.habit.id}:${today}:${t}`))) continue;
        await this.safeSend(u, habitQuestion(d.habit.title, d.streak), "neutral", habitButtons(d.habit.id, today));
      }
    }
  }

  private async daily(u: User, now: Date) {
    const today = userDay(now, u.tz);
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
    // Привычки вчерашнего дня, на которые так и не ответили, — минус (без сообщения: «спасти серию» ещё может его исправить).
    if (await s.once(`habitMinus:${u.id}:${today}`)) {
      const y = addDays(today, -1);
      for (const d of await habitsOfDay(s, u, y)) if (!d.status) await s.markHabit(d.habit.id, y, "skipped", null);
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

  /** Вечерний итог — коротко: строка цифр дня («✔ 3 задачи · привычки 3/3 · 🎮 2 ч») и 2–3 предложения горничной — одна
   * неочевидная связь (по записям за неделю) и один маленький совет на завтра. Сами записи дня не пересказываем: они в «Дневнике». */
  async eveningText(u: User, today: string): Promise<string> {
    const s = this.store;
    const diary = diaryBySection(await s.diaryOf(u.id, today));
    const facts: string[] = [];
    for (const [sec, lines] of diary) {
      if (sec === "summary" || sec === "tags") continue;
      facts.push(`${sectionName(sec)}: ${lines.join(" / ")}`);
    }
    const activity = await s.activityOf(u.id, today);
    const act = activityLines(activity).map((l) => l.replace(/<[^>]+>/g, ""));
    const done = (await s.allTasks(u.id)).filter((t) => t.done_at && userDay(new Date(t.done_at), u.tz) === today);
    const plans = (await s.allEvents(u.id)).filter((e) => e.date_iso === today && e.status !== "deleted" && e.status !== "purged");
    const habits = await habitsOfDay(s, u, today);
    const metrics = metricLine(await s.metricsRange(u.id, today, today));
    const money = await s.moneyRange(u.id, today, today);
    const head = `<b>Итог дня, ${humanDay(today)}</b>`;
    const numbers = dayNumbers({
      tasks: done.length,
      habitsDone: habits.filter((h) => h.status === "done").length,
      habits: habits.length,
      gameSec: activity.reduce((sum, a) => sum + a.games.reduce((g, x) => g + x.sec, 0), 0),
      notes: [...diary].filter(([sec]) => sec !== "summary" && sec !== "tags").reduce((n, [, l]) => n + l.length, 0),
      spent: moneyTotals(money).filter((t) => t.expense > 0).map((t) => `−${t.expense.toLocaleString("ru-RU")} ${t.currency}`),
    });
    const short = `${head}\n${numbers ? esc(numbers) : "Сегодня записей нет."}`;
    if (!this.llm) return short;
    // Горничной — всё подробно (за сегодня и записи за прошлые 6 дней, чтобы видеть повторы), человеку — только её вывод.
    const todayFacts = [
      ...facts, ...act, metrics ? `Показатели: ${metrics.replace(/<[^>]+>/g, "")}` : "",
      ...money.map((m) => "Деньги: " + moneyLine(m).replace(/<[^>]+>/g, "")),
      ...habits.map((h) => habitLine(h).replace(/<[^>]+>/g, "")),
      `Сделано задач: ${done.length}`, plans.length ? `Планов было: ${plans.length}` : "",
    ].filter(Boolean);
    const week = (await s.diaryRange(u.id, addDays(today, -6), addDays(today, -1)))
      .filter((r) => r.section !== "tags" && r.section !== "summary").slice(-80)
      .map((r) => `${r.day_key} ${sectionName(r.section)}: ${r.text}`);
    try {
      const words = await this.llm([
        {
          role: "system",
          content: `${persona(u.persona).voice}\nВечерний итог дня для хозяина — 2–3 коротких предложения, не длиннее ${EVENING_MAX} знаков, ` +
            `без заголовков, списков и эмодзи в начале строк. НЕ пересказывай, что было за день: цифры он уже видит. ` +
            `Найди одну неочевидную связь по записям за неделю (что повторяется, что идёт после чего: еда и самочувствие, игры и сон, ` +
            `дела и настроение) и дай один конкретный маленький совет на завтра с учётом завтрашних планов. Только по фактам ниже, ` +
            `без выдумок; связи нет — один точный совет. О здоровье — без диагнозов: «заметь и проверь», при повторах несколько дней — к врачу.`,
        },
        {
          role: "user",
          content: `Сегодня, ${today}:\n${todayFacts.join("\n") || "записей нет"}\n\nПрошлые 6 дней:\n${week.join("\n") || "записей нет"}` +
            `\n\nЗавтра:\n${(await plansText(s, u, addDays(today, 1), 0)).replace(/<[^>]+>/g, "")}`,
        },
      ], { temperature: 0.6, kind: "summary" });
      const text = words.trim().replace(/\s*\n+\s*/g, " ");
      const cut = text.length > EVENING_MAX * 1.5 ? `${text.slice(0, EVENING_MAX * 1.5).replace(/\s+\S*$/, "")}…` : text;
      return cut ? `${short}\n\n${esc(cut)}` : short;
    } catch (e) {
      console.error("[evening]", e);
      return short;
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
