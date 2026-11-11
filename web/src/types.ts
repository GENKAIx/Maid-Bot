// Что отдаёт сервер (server/src/db.ts, api.ts). Поля — как в базе.

export interface EventRow {
  id: number;
  title: string;
  date_iso: string;
  time: string | null;
  end_time: string | null;
  details: string;
  status: string;
}
export interface TaskRow {
  id: number;
  title: string;
  priority: string;
  category: string;
  due_date: string | null;
  notes: string;
  status: string;
}
export interface DateItem {
  id: number;
  title: string;
  date_iso: string;
  type: string;
  person: string;
  yearly: number;
  on: string;
  inDays: number;
  age: number | null;
}
export interface DiaryRow {
  id: number;
  day_key: string;
  section: string;
  topic: string;
  text: string;
  created_at: string;
}
export interface HabitToday {
  id: number;
  title: string;
  times: string[];
  status: "done" | "skipped" | null;
  streak: number;
  done: number;
  planned: number;
  /** Курс со сроком («пить Аевит месяц»): каждый день срока; null — обычная привычка. */
  course?: { day: string; s: "done" | "miss" | "today" | "wait" | "rest" }[] | null;
}
export interface MetricRow {
  id: number;
  day_key: string;
  key: string;
  label: string;
  value: number;
  unit: string;
  note: string;
  source: string;
}
export interface MoneyRow {
  id: number;
  day_key: string;
  kind: "income" | "expense";
  amount: number;
  currency: string;
  category: string;
  note: string;
}
export interface ActivityRow {
  day_key: string;
  source: string;
  active_sec: number;
  afk_sec: number;
  apps: { name: string; sec: number }[];
  games: { name: string; sec: number }[];
}

export interface DayData {
  day: string;
  events: EventRow[];
  diary: DiaryRow[];
  habits: HabitToday[];
  metrics: MetricRow[];
  money: MoneyRow[];
  activity: ActivityRow[];
}
export interface TodayData extends DayData {
  persona: string;
  upcoming: EventRow[];
  tasks: TaskRow[];
  dates: DateItem[];
}

export interface HabitMonthRow {
  id: number;
  title: string;
  days: string;
  times: string[];
  start_date: string;
  end_date: string | null;
  quiet?: number;
  days_: never;
}
export interface HabitMonth {
  month: string;
  today: { habit: { id: number; title: string }; status: "done" | "skipped" | null; streak: number; doneDays: number; plannedDays: number }[];
  habits: (Omit<HabitMonthRow, "days_"> & { days: { day: string; due: boolean; status: string | null }[] })[];
  /** Общее время вопросов из настроек (habit_first, habit_last). */
  ask?: { first: string; last: string };
}

export interface Reply {
  text: string;
  emotion: string;
  messageId: number;
  undoable: boolean;
  duplicate?: boolean;
  /** Дни, о которых ответ на вопрос (ГГГГ-ММ-ДД). */
  days?: string[];
  /** План лёг на занятое время: кнопки «Сдвинуть на shiftTo» (если не null) и «Оставить» (POST /api/clash). */
  clash?: { eventId: number; withId: number; shiftTo: string | null };
}
