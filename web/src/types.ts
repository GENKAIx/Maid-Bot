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
/** Заметка «на потом» (экран «Заметки»): полка shelf, оценка rating — у готовой. */
export interface NoteRow {
  id: number;
  shelf: string;
  title: string;
  note: string;
  status: string;
  rating: number | null;
  created_at: string;
  closed_at: string | null;
}
/** Полка заметок; rated — у готового спрашивают оценку (фильмы, сериалы, игры, книги). */
export interface NoteShelf { key: string; title: string; rated: boolean }
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
  /** Год настоящий (год рождения), а не год записи — сервер report.ts yearKnown. */
  year_known: boolean;
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
  /** Когда отметили (26.11.2026, сервер — в поясе человека): «ЧЧ:ММ»; at_day — день отметки «ГГГГ-ММ-ДД», только если
   *  отметили задним числом. Нет отметки или минус в полночь — null. */
  at_time?: string | null;
  at_day?: string | null;
}
/** «Завершённые» на странице «Привычки» (GET /api/habits → finished): done из planned — за весь срок, best — лучшая серия. */
export interface HabitFinished {
  id: number;
  title: string;
  start_date: string;
  end_date: string;
  /** Когда закончили вручную (UTC ISO); null — кончилась по сроку сама. */
  finished_at: string | null;
  done: number;
  planned: number;
  best: number;
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
  today: { habit: { id: number; title: string }; status: "done" | "skipped" | null; streak: number; doneDays: number; plannedDays: number; at_time?: string | null; at_day?: string | null }[];
  /** amount — сколько сделано за день, если человек сам назвал число («прочитал 35 страниц»); unit — «стр.», «км».
   *  at_time / at_day — когда отметили (как HabitToday). Завершённых здесь нет — они в finished. */
  habits: (Omit<HabitMonthRow, "days_"> & { days: { day: string; due: boolean; status: string | null; amount?: number | null; unit?: string; at_time?: string | null; at_day?: string | null }[] })[];
  /** «Завершённые»: свежие (по концу срока) сверху. */
  finished?: HabitFinished[];
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

/** GET /api/habits/:id/stats (server/src/habits.ts, habitStatsOf). */
export type HabitStatCell = "done" | "miss" | "today" | "wait" | "rest" | "off";
export interface HabitStats {
  id: number;
  title: string;
  start_date: string;
  end_date: string | null;
  year: { day: string; s: HabitStatCell }[];
  streak: number;
  best: number;
  rate30: { done: number; planned: number };
  rate90: { done: number; planned: number };
  total: { done: number; planned: number };
  weekdays: { done: number; planned: number }[];
  months: { month: string; done: number; planned: number }[];
  /** Сколько сделано — если человек хоть раз называл число: суммы за неделю (с пн), месяц, всё время, лучший день, 30 дней. */
  amount?: { unit: string; week: number; month: number; total: number; best: { day: string; value: number }; days: { day: string; value: number | null }[] } | null;
}
