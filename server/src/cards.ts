import type { DateRow, DiaryRow, EventRow, HabitRow, MemoryRow, MetricRow, MoneyRow, NoteRow, TaskRow, TraitRow } from "./db.ts";
import type { Change } from "./pipeline.ts";
import { scheduleText, timesOf } from "./habits.ts";
import { SHELVES } from "./notes.ts";
import { HEALTH_TOPICS, SECTIONS, type Section } from "./parse.ts";
import { metricLine, moneyLine } from "./report.ts";
import { humanDay } from "./time.ts";

// Карточки «что куда записалось» под ответом горничной. Одна функция на таблицу — и разбор (pipeline.apply), и поправка
// к ответу (correct.ts) строят карточку одинаково: виджет сравнивает старую и новую строку и прокручивает изменившиеся цифры.
// ref — запись, за которой стоит карточка (таблица и id): по нему виджет узнаёт карточку после поправки.

/** Обрезать длинное для карточки: «…» на конце. */
export const clip = (t: string, n = 90) => (t.length > n ? t.slice(0, n - 1) + "…" : t);

export function diaryCard(d: Pick<DiaryRow, "id" | "section" | "topic" | "text">): Change {
  const sec = SECTIONS[d.section as Section] ?? d.section;
  return {
    kind: "diary", title: `${sec}${d.section === "health" && d.topic ? " · " + (HEALTH_TOPICS[d.topic] ?? d.topic) : ""}`, detail: clip(d.text),
    ref: { tbl: "diary", id: d.id },
  };
}

export const eventCard = (e: Pick<EventRow, "id" | "title" | "date_iso" | "time">): Change =>
  ({ kind: "event", title: e.title, detail: `${humanDay(e.date_iso)}${e.time ? " " + e.time : ""}`, ref: { tbl: "events", id: e.id } });

export const taskCard = (t: Pick<TaskRow, "id" | "title" | "due_date">): Change =>
  ({ kind: "task", title: t.title, detail: t.due_date ? `до ${humanDay(t.due_date)}` : undefined, ref: { tbl: "tasks", id: t.id } });

export const noteCard = (n: Pick<NoteRow, "id" | "shelf" | "title" | "note">): Change => ({
  kind: "note", title: n.title, detail: `Заметки · ${SHELVES[n.shelf as keyof typeof SHELVES] ?? n.shelf}${n.note ? " · " + clip(n.note, 60) : ""}`,
  ref: { tbl: "notes", id: n.id },
});

export const dateCard = (d: Pick<DateRow, "id" | "title" | "date_iso" | "yearly">): Change =>
  ({ kind: "date", title: d.title, detail: `${humanDay(d.date_iso, true)}${d.yearly ? ", каждый год" : ""}`, ref: { tbl: "dates", id: d.id } });

export const metricCard = (m: Pick<MetricRow, "id" | "key" | "label" | "value" | "unit">): Change =>
  ({ kind: "metric", title: m.label, detail: metricLine([m]).replace(/^[^:]*:\s*/, ""), ref: { tbl: "metrics", id: m.id } });

export const moneyCard = (m: Pick<MoneyRow, "id" | "kind" | "amount" | "currency" | "category" | "note">): Change => ({
  kind: "money", title: m.note || m.category || (m.kind === "income" ? "Доход" : "Расход"), detail: moneyLine(m).replace(/<[^>]+>/g, ""),
  ref: { tbl: "money", id: m.id },
});

export const memoryCard = (m: Pick<MemoryRow, "id" | "subject" | "text">): Change =>
  ({ kind: "memory", title: m.subject || "Запомнила", detail: clip(m.text), ref: { tbl: "memory", id: m.id } });

/** Баф или дебаф профиля, заведённый ответом. Вернули прежний (был снят) — карточка по словам модели, без ref (pipeline.apply). */
export const traitCard = (t: Pick<TraitRow, "id" | "kind" | "title" | "note">): Change =>
  ({ kind: "trait", title: t.title, detail: t.note || (t.kind === "buff" ? "Баф профиля" : "Дебаф профиля"), ref: { tbl: "traits", id: t.id } });

/** Привычка: расписание и время напоминаний; без времени и «в список» (quiet) — «без напоминаний», как у кнопки «Добавить в привычки». */
export function habitCard(h: Pick<HabitRow, "id" | "title" | "days" | "times" | "start_date" | "end_date" | "quiet">): Change {
  const times = timesOf(h as HabitRow);
  return {
    kind: "habit", title: h.title,
    detail: `${scheduleText(h)}${times.length ? " · " + times.join(", ") : h.quiet ? " · без напоминаний" : ""}`,
    ref: { tbl: "habits", id: h.id },
  };
}
