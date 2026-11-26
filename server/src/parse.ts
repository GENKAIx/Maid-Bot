import { z } from "zod";
import type { DateRow, EventRow, HabitRow, MemoryRow, NoteRow, TaskRow } from "./db.ts";
import { habitFinished, timesOf } from "./habits.ts";
import { NOTE_TEXT_MAX, NOTE_TITLE_MAX, SHELF_KEYS, sameNote, shelfKey, type Shelf } from "./notes.ts";
import { EMOTIONS } from "./personas.ts";
import { prompt, setPromptPreview } from "./prompts.ts";
import { addDays, isDayKey, normalizeTime, weekdayLong } from "./time.ts";

// Разбор одного сообщения: что записать в дневник, какие планы/задачи/даты/факты создать,
// что поправить. Модель отдаёт JSON, код проверяет даты и время и отбрасывает лишнее.

export const SECTIONS = {
  notes: "Заметки",
  sleep: "Сон",
  food: "Еда",
  sport: "Спорт",
  health: "Здоровье",
  hobby: "Хобби",
  mood: "Настроение",
} as const;
export type Section = keyof typeof SECTIONS;
/** Разделы, которые пишет только трекер — из текста их не берём. */
export const TRACKER_SECTIONS = { pc: "Компьютер", games: "Игры" } as const;

/** Подразделы здоровья, которые знаем заранее; модель может завести новый (латиницей). */
export const HEALTH_TOPICS: Record<string, string> = {
  pressure: "Давление", heart: "Сердце", head: "Голова", stomach: "Живот", teeth: "Зубы", skin: "Кожа",
  meds: "Таблетки", doctor: "Врачи", cold: "Простуда", injury: "Травмы", back: "Спина", eyes: "Глаза",
  allergy: "Аллергия", weight: "Вес", sleep: "Сон", other: "Другое",
};

/** Показатели дня с готовыми подписями. Новый ключ — новая «колонка», схему менять не нужно. */
export const METRICS: Record<string, { label: string; unit: string }> = {
  weight: { label: "Вес", unit: "кг" },
  sleep_hours: { label: "Сон", unit: "ч" },
  steps: { label: "Шаги", unit: "" },
  sport_min: { label: "Спорт", unit: "мин" },
  rating_day: { label: "Оценка дня", unit: "/10" },
  rating_food: { label: "Еда", unit: "/10" },
  rating_health: { label: "Самочувствие", unit: "/10" },
  mood: { label: "Настроение", unit: "/10" },
  energy: { label: "Энергия", unit: "/10" },
  pressure_sys: { label: "Давление верхнее", unit: "мм" },
  pressure_dia: { label: "Давление нижнее", unit: "мм" },
  pulse: { label: "Пульс", unit: "уд/мин" },
  water_l: { label: "Вода", unit: "л" },
};

export const MONEY_CATEGORIES = [
  "еда", "продукты", "кафе", "транспорт", "дом", "связь", "подписки", "здоровье", "одежда", "развлечения",
  "игры", "обучение", "подарки", "долг", "зарплата", "заказ", "перевод", "другое",
];

const str = z.string().trim();
const optStr = z.preprocess((v) => (v === "" ? null : v), str.nullable().optional());

const Diary = z.object({
  section: z.string(),
  topic: optStr,
  text: str.min(1),
  day_iso: optStr,
});
/** Число от модели: «1 200», «85,3» тоже (поправка к ответу проверяет им суммы и показатели — correct.ts). */
export const num = z.preprocess((v) => (typeof v === "string" ? Number(v.replace(",", ".").replace(/\s/g, "")) : v), z.number().finite());
const Metric = z.object({
  key: str.min(1),
  label: optStr,
  value: num,
  unit: optStr,
  note: optStr,
  day_iso: optStr,
});
const Habit = z.object({
  title: str.min(1),
  days: z.union([z.string(), z.array(z.number().int())]).nullable().optional(),
  times: z.preprocess((v) => (typeof v === "string" ? [v] : Array.isArray(v) ? v : []), z.array(z.unknown())),
  start_iso: optStr,
  end_iso: optStr,
  duration_days: z.number().int().positive().nullable().optional(),
});
const HabitMark = z.object({
  habit_id: z.number().int(),
  status: z.enum(["done", "skipped"]).catch("done"),
  day_iso: optStr,
  amount: z.number().positive().max(1e6).nullable().optional().catch(null),
  unit: optStr.catch(null),
});
const Money = z.object({
  kind: z.enum(["income", "expense"]),
  amount: num,
  currency: optStr,
  category: optStr,
  note: optStr,
  day_iso: optStr,
});
const Event = z.object({
  title: str.min(1),
  date_iso: optStr,
  time: optStr,
  end_time: optStr,
  details: optStr,
});
const Task = z.object({
  title: str.min(1),
  priority: z.enum(["high", "normal", "low"]).catch("normal").optional(),
  due_date: optStr,
  category: optStr,
});
const DateItem = z.object({
  title: str.min(1),
  date_iso: optStr,
  type: z.enum(["birthday", "anniversary", "holiday", "deadline", "other"]).catch("other").optional(),
  person: optStr,
  yearly: z.boolean().optional(),
});
const Memory = z.object({
  kind: z.enum(["fact", "preference", "person", "goal"]).catch("fact"),
  subject: optStr,
  text: str.min(1),
  replaces: z.number().int().nullable().optional(),
});
const Trait = z.object({
  kind: z.enum(["debuff", "buff"]).catch("debuff"),
  category: optStr,
  title: str.min(1),
  note: optStr,
});
// Заметка «на потом» (notes.ts): что посмотреть, во что поиграть, что почитать, идея.
const Stash = z.object({
  shelf: optStr,
  title: str.min(1),
  note: optStr,
});
const Edit = z.object({
  action: z.enum(["cancel", "done", "move", "reopen", "rename", "remind"]),
  kind: z.enum(["event", "task", "date", "memory", "habit", "note"]),
  id: z.number().int(),
  // Только заметка: move — на какую полку переложить; done — оценка 1–10, если названа.
  new_shelf: optStr,
  rating: z.number().nullable().optional().catch(null),
  new_title: optStr,
  new_date: optStr,
  new_time: optStr,
  // remind (только привычка): время напоминаний; пусто — без напоминаний.
  new_times: z.array(z.string()).optional().catch(undefined),
});

const arr = <T extends z.ZodTypeAny>(t: T) =>
  z.preprocess((v) => (Array.isArray(v) ? v : []), z.array(z.unknown())).transform((list) =>
    list.flatMap((x) => {
      const r = t.safeParse(x);
      return r.success ? [r.data as z.infer<T>] : [];
    }),
  );

export const ParseSchema = z.object({
  date_iso: optStr,
  diary: arr(Diary),
  tags: z.preprocess((v) => (Array.isArray(v) ? v : []), z.array(z.unknown())).transform((l) =>
    l.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim().replace(/^#/, "")),
  ),
  summary: z.preprocess((v) => (typeof v === "string" ? v : ""), z.string()),
  events: arr(Event),
  tasks: arr(Task),
  stash: arr(Stash),
  dates: arr(DateItem),
  memory: arr(Memory),
  traits: arr(Trait),
  metrics: arr(Metric),
  habits: arr(Habit),
  // Спорное — только предложить кнопками (см. правила промпта).
  suggest_habits: arr(Habit),
  suggest_tasks: arr(Task),
  suggest_remind: z
    .object({ label: str.min(1), time: optStr })
    .nullable()
    .optional()
    .catch(null),
  habit_marks: arr(HabitMark),
  money: arr(Money),
  edits: arr(Edit),
  question: optStr,
  search: z.preprocess((v) => (typeof v === "string" ? [v] : Array.isArray(v) ? v : []), z.array(z.string()).catch([])),
  lookup: z
    .object({ from: optStr, to: optStr })
    .nullable()
    .optional()
    .catch(null),
  // Вопрос про заметки «на потом»: с каких полок показать.
  shelves: z.preprocess((v) => (typeof v === "string" ? [v] : Array.isArray(v) ? v : []), z.array(z.unknown())).transform((l) => l.filter((x): x is string => typeof x === "string")),
  clarify: optStr,
  draw: z
    .object({ prompt: str.min(1), title: optStr })
    .nullable()
    .optional()
    .catch(null),
  // Постоянное о себе: где живёт, во сколько обычно встаёт — горничная спросит «Записать в профиль?» (you.ts aboutOffer).
  about: z
    .object({
      city: optStr.catch(null),
      wake: z.preprocess((v) => (typeof v === "string" ? Number(v.split(":")[0]) : v), z.number().int().min(0).max(23).nullable().optional()).catch(null),
    })
    .nullable()
    .optional()
    .catch(null),
  emotion: z.enum(EMOTIONS).catch("neutral"),
  talk: z.boolean().catch(false),
  reply: optStr,
});
export type RawParse = z.infer<typeof ParseSchema>;

export interface Parsed {
  dayKey: string;
  diary: { section: Section; topic: string; text: string; dayKey: string }[];
  tags: string[];
  summary: string;
  events: { title: string; date: string; time: string | null; endTime: string | null; details: string }[];
  tasks: { title: string; priority: "high" | "normal" | "low"; due: string | null; category: string }[];
  /** Заметки «на потом» — на полку (notes.ts). */
  stash: { shelf: Shelf; title: string; note: string }[];
  dates: { title: string; date: string; type: string; person: string; yearly: boolean }[];
  memory: { kind: string; subject: string; text: string; replaces: number | null }[];
  /** Дебафы и бафы профиля, которые пользователь назвал сам («у меня аллергия на арахис»). */
  traits: { kind: "debuff" | "buff"; category: string; title: string; note: string }[];
  metrics: { key: string; label: string; value: number; unit: string; note: string; dayKey: string }[];
  habits: { title: string; days: string; times: string[]; start: string; end: string | null }[];
  /** Предложить, а не записывать: привычки из рассказа о распорядке, задачи из «надо бы когда-нибудь».
   *  remind — ситуативная кнопка («Напоминать перед сном») и её время. */
  suggest: {
    habits: { title: string; days: string; times: string[]; start: string; end: string | null }[];
    tasks: { title: string; priority: "high" | "normal" | "low"; due: string | null; category: string }[];
    remind: { label: string; time: string } | null;
  };
  marks: { habitId: number; status: "done" | "skipped"; dayKey: string; amount: number | null; unit: string }[];
  money: { kind: "income" | "expense"; amount: number; currency: string; category: string; note: string; dayKey: string }[];
  edits: { action: "cancel" | "done" | "move" | "reopen" | "rename" | "remind"; kind: "event" | "task" | "date" | "memory" | "habit" | "note"; id: number; newDate: string | null; newTime: string | null; newTitle?: string; newTimes?: string[]; newShelf?: Shelf; rating?: number | null }[];
  question: string | null;
  lookup: { from: string; to: string } | null;
  /** Вопрос про заметки «на потом» («что посмотреть?») — с каких полок отвечать; пусто — вопрос не про них. */
  shelves: Shelf[];
  /** Корни слов для поиска по всем записям («сердц», «голов»). */
  search: string[];
  clarify: string | null;
  /** Просьба нарисовать картинку: prompt — описание для модели картинок по-английски, title — коротко по-русски. */
  draw: { prompt: string; title: string } | null;
  emotion: (typeof EMOTIONS)[number];
  /** Человек сам назвал постоянное о себе: город, где живёт, час обычного подъёма — предложить записать в «О вас». */
  about?: { city: string | null; wake: number | null } | null;
  /** С горничной разговаривают (вопрос ей, новость или переживание, совет, шутка) — ответ ведёт разговор (pipeline talkText), а не reply. */
  talk: boolean;
  reply: string | null;
  /** Что код отбросил и почему — в журнал. */
  dropped: string[];
}

export interface ParseContext {
  today: string;
  now: string; // ЧЧ:ММ
  tz: string;
  events: EventRow[];
  tasks: TaskRow[];
  dates: DateRow[];
  memory: MemoryRow[];
  /** Заметки «на потом», что лежат на полках, — чтобы не записать второй раз и было что отметить готовым. */
  notes?: NoteRow[];
  /** Активные дебафы и бафы — готовым текстом (profile.traitPrompt); пусто — нет. */
  traits?: string;
  habits: HabitRow[];
  /** Корзина: отменённые и удалённые планы за последние дни — их можно вернуть (edits reopen). */
  trash?: EventRow[];
  recent: { role: "user" | "assistant"; text: string }[];
  /** Если ответ на уточнение — исходное сообщение и вопрос. */
  clarifying?: { original: string; question: string };
}

/** Две строки о «сегодня» для запроса к модели: день, день недели, время, пояс и даты вчера/завтра/послезавтра
 *  (разбор и поправка к ответу — correct.ts — видят одно и то же). */
export const promptHeader = (today: string, now: string, tz: string) =>
  prompt("parse.header", { today, weekday: weekdayLong(today), now, tz, yesterday: addDays(today, -1), tomorrow: addDays(today, 1), after_tomorrow: addDays(today, 2) });

/** JSON-схема ответа разбора: строит код из перечней (HEALTH_TOPICS, METRICS, MONEY_CATEGORIES, SHELF_KEYS, EMOTIONS); в админке —
 *  только в предпросмотре parse.rules. */
const parseSchema = () => `{
 "date_iso": "YYYY-MM-DD — день, к которому относится запись дневника (по умолчанию сегодня)",
 "diary": [{"section": "notes|sleep|food|sport|health|hobby|mood", "topic": "только для health: ${Object.keys(HEALTH_TOPICS).join("|")} или новое слово латиницей", "text": "...", "day_iso": "если не date_iso"}],
 "metrics": [{"key": "${Object.keys(METRICS).join("|")} или новый ключ латиницей", "label": "подпись по-русски для нового ключа", "value": 85.3, "unit": "", "note": "", "day_iso": null}],
 "habits": [{"title": "...", "days": "1234567 (1 — пн … 7 — вс)", "times": ["ЧЧ:ММ"], "start_iso": null, "end_iso": null, "duration_days": 30}],
 "suggest_habits": [то же, что habits] — регулярные дела из рассказа о распорядке: не заводить, а спросить,
 "suggest_tasks": [то же, что tasks] — дела из размышлений «надо бы как-нибудь…»: не записывать, а спросить,
 "suggest_remind": {"label": "текст кнопки по смыслу, до 28 символов", "time": "ЧЧ:ММ"} или null,
 "habit_marks": [{"habit_id": 3, "status": "done|skipped", "day_iso": null, "amount": null, "unit": ""}],
 "money": [{"kind": "income|expense", "amount": 450, "currency": "RUB|USD|EUR…", "category": "${MONEY_CATEGORIES.join("|")}", "note": "на что / от кого", "day_iso": null}],
 "tags": ["короткие теги"],
 "summary": "[ЧЧ:ММ] почти дословная очищенная выжимка сообщения",
 "events": [{"title": "...", "date_iso": "YYYY-MM-DD", "time": "ЧЧ:ММ или null", "end_time": null, "details": ""}],
 "tasks": [{"title": "...", "priority": "high|normal|low", "due_date": "YYYY-MM-DD или null", "category": ""}],
 "stash": [{"shelf": "${SHELF_KEYS.join("|")}", "title": "название как есть", "note": "пометка, если сказана: кто посоветовал, где смотреть"}] — заметки «на потом»,
 "dates": [{"title": "...", "date_iso": "YYYY-MM-DD", "type": "birthday|anniversary|holiday|deadline|other", "person": "", "yearly": true}],
 "memory": [{"kind": "fact|preference|person|goal", "subject": "о ком/о чём", "text": "...", "replaces": null}],
 "about": {"city": "город, где человек живёт, или null", "wake": "час обычного подъёма числом или null"} или null,
 "traits": [{"kind": "debuff|buff", "category": "allergy|food|med|condition|body|habit|other", "title": "коротко: «Аллергия на арахис»", "note": "подробности, если названы"}],
 "edits": [{"action": "cancel|done|move|reopen|rename|remind", "kind": "event|task|date|memory|habit|note", "id": 12, "new_date": null, "new_time": null, "new_title": null, "new_times": null, "new_shelf": null, "rating": null}],
 "question": "если пользователь спрашивает о своих данных — вопрос, иначе null",
 "lookup": {"from": "YYYY-MM-DD", "to": "YYYY-MM-DD"} или null — какие дни нужны для ответа (null — за всё время),
 "search": ["корни слов для поиска по записям, напр. сердц, кардиолог"] — только если вопрос про конкретную вещь,
 "shelves": ["${SHELF_KEYS.join("|")}"] — только если вопрос про заметки «на потом» (что посмотреть, во что поиграть), иначе [],
 "clarify": "один короткий вопрос, если без него нельзя записать правильно, иначе null",
 "draw": {"prompt": "подробное описание картинки по-английски для генератора", "title": "коротко по-русски, что рисуем"} или null — только если просят нарисовать/сгенерировать/создать картинку,
 "emotion": "${EMOTIONS.join("|")}",
 "talk": true, если пользователь хочет поговорить с тобой, иначе false,
 "reply": "короткая живая реплика на сообщение (1 предложение) или null"
}`;

/** Системное сообщение разбора. rules — правила (prompts.ts parse.rules, правятся в админке); свой текст — только для предпросмотра. */
export function buildPrompt(ctx: ParseContext, voice: string, rules = prompt("parse.rules", { now: ctx.now })): string {
  const evs = ctx.events.map((e) => `#${e.id} ${e.date_iso}${e.time ? " " + e.time : ""} — ${e.title}`).join("\n") || "нет";
  const tks = ctx.tasks.map((t) => `#${t.id} ${t.title}${t.due_date ? " (до " + t.due_date + ")" : ""}`).join("\n") || "нет";
  const dts = ctx.dates.map((d) => `#${d.id} ${d.date_iso.slice(5)} — ${d.title}`).join("\n") || "нет";
  const mem = ctx.memory.map((m) => `#${m.id} [${m.kind}] ${m.subject ? m.subject + ": " : ""}${m.text}`).join("\n") || "нет";
  const nts = (ctx.notes ?? []).map((n) => `#${n.id} [${n.shelf}] ${n.title}`).join("\n") || "нет";
  const bin = (ctx.trash ?? []).map((e) => `#${e.id} ${e.date_iso}${e.time ? " " + e.time : ""} — ${e.title} (${e.status === "deleted" ? "удалено" : "отменено"})`).join("\n") || "пусто";
  // Время напоминаний — чтобы «напоминай как в названии» или «перенеси напоминание на 9» было с чем сравнить.
  const remindOf = (h: HabitRow) => {
    const t = timesOf(h);
    return h.quiet ? "без напоминаний" : t.length ? `напоминания ${t.join(", ")}` : "напоминания — общее время";
  };
  // Завершённая (habitFinished) — «завершена»: её не отмечают, только «верни» (reopen).
  const hab = ctx.habits.map((h) => `#${h.id} ${h.title} (${habitFinished(h, ctx.today) ? "завершена; " : ""}дни ${h.days}${h.end_date ? ", до " + h.end_date : ""}; ${remindOf(h)})`).join("\n") || "нет";
  return `Ты разбираешь сообщения пользователя для его личного дневника-помощника.
${promptHeader(ctx.today, ctx.now, ctx.tz)}

Ответь ОДНИМ JSON-объектом:
${parseSchema()}

${rules}

Голос для reply: ${voice}

Ближайшие планы:
${evs}
Корзина (отменённые и удалённые планы):
${bin}
Открытые задачи:
${tks}
Заметки на потом (полка в скобках):
${nts}
Важные даты:
${dts}
Что известно о пользователе:
${mem}
${ctx.traits || "Дебафов нет."}
Привычки:
${hab}`;
}

// Предпросмотр в админке (parse.rules): системное сообщение целиком — со схемой из кода и пустыми списками.
setPromptPreview("parse.rules", {
  frame: (rules) => buildPrompt({ today: "2026-11-27", now: "14:30", tz: "Europe/Moscow", events: [], tasks: [], dates: [], memory: [], habits: [], recent: [] }, "‹голос характера›", rules),
});

const SECTION_KEYS = Object.keys(SECTIONS) as Section[];
const SECTION_ALIASES: Record<string, Section> = {
  note: "notes", заметки: "notes", sleep: "sleep", сон: "sleep", food: "food", еда: "food",
  sport: "sport", спорт: "sport", health: "health", здоровье: "health", hobby: "hobby", хобби: "hobby",
  mood: "mood", настроение: "mood",
};

/** Время прямо в названии дела: «Озон в 20:00», «забрать посылку 18.30». Без двоеточия/точки («в 7») — не время. */
export function timeInTitle(title: string): { title: string; time: string } | null {
  const m = title.match(/(?:^|\s)(?:в|к|до)?\s*(\d{1,2}[:.]\d{2})(?=\s|$|[,;!)])/i);
  if (!m) return null;
  const time = normalizeTime(m[1]);
  if (!time) return null;
  const rest = (title.slice(0, m.index) + " " + title.slice((m.index ?? 0) + m[0].length)).replace(/\s+/g, " ").replace(/\s+([,;!)])/g, "$1").trim();
  return { title: rest || title, time };
}

/** Проверить и привести ответ модели. Неверные даты и время отбрасываются, а не угадываются. */
/** literal — виды записей как названы (поправка «это задача, а не план»): задача со временем в названии остаётся задачей. */
export function normalize(raw: unknown, ctx: { today: string; now: string; text: string; literal?: boolean }): Parsed {
  const r = ParseSchema.parse(raw ?? {});
  const dropped: string[] = [];
  const day = (s: string | null | undefined, field: string, opts: { future?: boolean; past?: boolean } = {}) => {
    if (!s) return null;
    if (!isDayKey(s)) {
      dropped.push(`${field}: дата «${s}»`);
      return null;
    }
    if (opts.future === false && s > ctx.today) {
      dropped.push(`${field}: дата из будущего ${s}`);
      return null;
    }
    return s;
  };
  const dayKey = day(r.date_iso, "date_iso", { future: false }) ?? ctx.today;

  const diary: Parsed["diary"] = [];
  for (const d of r.diary) {
    const sec = (SECTION_KEYS as string[]).includes(d.section) ? (d.section as Section) : SECTION_ALIASES[d.section.toLowerCase()];
    if (!sec) {
      dropped.push(`diary: раздел «${d.section}»`);
      continue;
    }
    const topic = sec === "health" ? topicOf(d.topic) : "";
    diary.push({ section: sec, topic, text: d.text, dayKey: day(d.day_iso, "diary.day_iso", { future: false }) ?? dayKey });
  }

  const events: Parsed["events"] = [];
  let clarify = r.clarify ?? null;
  for (const e of r.events) {
    const date = day(e.date_iso, "events.date_iso");
    if (!date) {
      clarify ??= `На какой день «${e.title}»?`;
      continue;
    }
    const time = e.time ? normalizeTime(e.time) : null;
    if (e.time && !time) dropped.push(`events.time «${e.time}»`);
    events.push({
      title: e.title,
      date,
      time,
      endTime: e.end_time ? normalizeTime(e.end_time) : null,
      details: e.details ?? "",
    });
  }

  // Дело с точным временем («Озон в 20:00») — это план с напоминанием, а не задача.
  const tasks: Parsed["tasks"] = [];
  for (const t of r.tasks) {
    const due = day(t.due_date, "tasks.due_date");
    const at = timeInTitle(t.title);
    if (at && !ctx.literal && (due ?? ctx.today) >= ctx.today) {
      events.push({ title: at.title, date: due ?? (at.time > ctx.now ? ctx.today : addDays(ctx.today, 1)), time: at.time, endTime: null, details: "" });
      continue;
    }
    tasks.push({ title: t.title, priority: t.priority ?? "normal", due, category: t.category ?? "" });
  }

  // Заметки «на потом»: без названия и повторы в одном сообщении — мимо.
  const stash: Parsed["stash"] = [];
  for (const n of r.stash) {
    const title = n.title.trim().slice(0, NOTE_TITLE_MAX);
    const shelf = shelfKey(n.shelf) ?? "other";
    if (!title || stash.some((x) => x.shelf === shelf && sameNote(x.title, title))) continue;
    stash.push({ shelf, title, note: (n.note ?? "").trim().slice(0, NOTE_TEXT_MAX) });
  }
  stash.splice(20);

  const dates: Parsed["dates"] = [];
  for (const d of r.dates) {
    const date = day(d.date_iso, "dates.date_iso");
    if (!date) {
      clarify ??= `Какого числа «${d.title}»?`;
      continue;
    }
    const type = d.type ?? "other";
    dates.push({
      title: d.title,
      date,
      type,
      person: d.person ?? "",
      yearly: d.yearly ?? ["birthday", "anniversary", "holiday"].includes(type),
    });
  }

  const edits: Parsed["edits"] = [];
  for (const e of r.edits) {
    const newDate = day(e.new_date, "edits.new_date");
    const newTime = e.new_time ? normalizeTime(e.new_time) : null;
    const newTitle = (e.new_title ?? "").trim().slice(0, 200);
    // Заметка: полка — для move, оценка — для done; остальное — как у задачи.
    if (e.kind === "note") {
      const newShelf = shelfKey(e.new_shelf);
      if ((e.action === "move" && !newShelf) || e.action === "remind" || (e.action === "rename" && !newTitle)) {
        dropped.push(`edits: заметка #${e.id}, ${e.action} без данных`);
        continue;
      }
      const rating = e.action === "done" && e.rating != null && e.rating >= 1 && e.rating <= 10 ? Math.round(e.rating) : null;
      edits.push({ action: e.action, kind: "note", id: e.id, newDate: null, newTime: null, ...(e.action === "rename" ? { newTitle } : {}), ...(e.action === "move" ? { newShelf: newShelf! } : {}), rating });
      continue;
    }
    if (e.action === "move" && !newDate && !newTime) {
      dropped.push(`edits: перенос #${e.id} без даты`);
      clarify ??= "На когда перенести?";
      continue;
    }
    if (e.action === "rename" && (!newTitle || (e.kind !== "event" && e.kind !== "task" && e.kind !== "habit"))) {
      dropped.push(`edits: переименование #${e.id} без названия`);
      clarify ??= "Как назвать?";
      continue;
    }
    let newTimes: string[] | undefined;
    if (e.action === "remind") {
      newTimes = [...new Set((e.new_times ?? []).map((t) => normalizeTime(t)).filter((t): t is string => Boolean(t)))].sort().slice(0, 4);
      if (e.kind !== "habit" || (e.new_times?.length && !newTimes.length)) {
        dropped.push(`edits: напоминание #${e.id} без времени`);
        clarify ??= "Во сколько напоминать?";
        continue;
      }
    }
    edits.push({ action: e.action, kind: e.kind, id: e.id, newDate, newTime, ...(e.action === "rename" ? { newTitle } : {}), ...(newTimes ? { newTimes } : {}) });
  }

  const metrics: Parsed["metrics"] = [];
  for (const m of r.metrics) {
    const key = latinKey(m.key);
    if (!key) {
      dropped.push(`metrics: ключ «${m.key}»`);
      continue;
    }
    const known = METRICS[key];
    metrics.push({
      key,
      label: known?.label ?? m.label ?? key,
      value: m.value,
      unit: known?.unit ?? m.unit ?? "",
      note: m.note ?? "",
      dayKey: day(m.day_iso, "metrics.day_iso", { future: false }) ?? dayKey,
    });
  }

  const habitOf = (h: RawParse["habits"][number]): Parsed["habits"][number] => {
    const raw = Array.isArray(h.days) ? h.days.join("") : (h.days ?? "");
    const days = [...new Set(raw.replace(/[^1-7]/g, "").split(""))].sort().join("") || "1234567";
    const times = h.times.map(normalizeTime).filter((t): t is string => Boolean(t));
    const start = day(h.start_iso, "habits.start_iso") ?? ctx.today;
    let end = day(h.end_iso, "habits.end_iso");
    if (!end && h.duration_days) end = addDays(start, h.duration_days - 1);
    if (end && end < start) {
      dropped.push(`habits: срок до начала «${h.title}»`);
      end = null;
    }
    return { title: h.title, days, times: [...new Set(times)].sort(), start, end };
  };
  const habits = r.habits.map(habitOf);
  const known = new Set([...habits.map((h) => h.title.toLowerCase()), ...tasks.map((t) => t.title.toLowerCase())]);
  const remindTime = r.suggest_remind?.time ? normalizeTime(r.suggest_remind.time) : null;
  const suggest: Parsed["suggest"] = {
    habits: r.suggest_habits.map(habitOf).filter((h) => !known.has(h.title.toLowerCase())).slice(0, 8),
    tasks: r.suggest_tasks
      .filter((t) => !known.has(t.title.toLowerCase()))
      .slice(0, 8)
      .map((t) => ({ title: t.title, priority: t.priority ?? "normal", due: day(t.due_date, "suggest_tasks.due_date"), category: t.category ?? "" })),
    remind: r.suggest_remind && remindTime ? { label: r.suggest_remind.label.slice(0, 40), time: remindTime } : null,
  };
  if (!suggest.habits.length) suggest.remind = null;

  const marks: Parsed["marks"] = r.habit_marks.map((m) => ({
    habitId: m.habit_id,
    status: m.status,
    dayKey: day(m.day_iso, "habit_marks.day_iso", { future: false }) ?? ctx.today,
    amount: m.status === "done" && m.amount ? m.amount : null,
    unit: m.status === "done" && m.amount ? (m.unit ?? "").slice(0, 12) : "",
  }));

  const money: Parsed["money"] = [];
  for (const m of r.money) {
    if (!(m.amount > 0)) {
      dropped.push(`money: сумма «${m.amount}»`);
      continue;
    }
    const cur = (m.currency ?? "RUB").toUpperCase();
    money.push({
      kind: m.kind,
      amount: Math.round(m.amount * 100) / 100,
      currency: CURRENCY[cur] ?? (/^[A-Z]{3}$/.test(cur) ? cur : "RUB"),
      category: (m.category ?? "другое").toLowerCase().slice(0, 40),
      note: m.note ?? "",
      dayKey: day(m.day_iso, "money.day_iso", { future: false }) ?? dayKey,
    });
  }

  let lookup: Parsed["lookup"] = null;
  const search = r.question ? [...new Set(r.search.map((w) => w.trim().toLowerCase()).filter((w) => w.length >= 3))].slice(0, 8) : [];
  if (r.question && r.lookup && (r.lookup.from || r.lookup.to)) {
    const from = day(r.lookup.from, "lookup.from") ?? addDays(ctx.today, -7);
    const to = day(r.lookup.to, "lookup.to") ?? ctx.today;
    lookup = from <= to ? { from, to } : { from: to, to: from };
  }

  let summary = r.summary.trim();
  const hasContent = diary.length || events.length || tasks.length || stash.length || dates.length || memory(r).length || r.traits.length || edits.length ||
    metrics.length || habits.length || marks.length || money.length;
  if (!summary && !r.question && (hasContent || ctx.text.trim().length > 0) && !clarify) {
    summary = `[${ctx.now}] ${ctx.text.trim()}`;
  }
  if (summary && !/^\[\d{2}:\d{2}\]/.test(summary)) summary = `[${ctx.now}] ${summary}`;

  return {
    dayKey,
    diary,
    tags: [...new Set(r.tags)].slice(0, 8),
    summary,
    events,
    tasks,
    stash,
    dates,
    memory: memory(r),
    traits: r.traits.map((t) => ({ kind: t.kind, category: t.category ?? "other", title: t.title.trim().slice(0, 60), note: (t.note ?? "").trim().slice(0, 200) })),
    about: r.about && (r.about.city || r.about.wake != null) ? { city: r.about.city?.slice(0, 80) || null, wake: r.about.wake ?? null } : null,
    metrics,
    habits,
    suggest,
    marks,
    money,
    edits,
    question: r.question ?? null,
    lookup,
    shelves: r.question ? [...new Set(r.shelves.map(shelfKey).filter((x): x is Shelf => Boolean(x)))] : [],
    search,
    clarify,
    draw: r.draw?.prompt.trim() ? { prompt: r.draw.prompt.trim().slice(0, 1500), title: (r.draw.title ?? "").trim().slice(0, 80) } : null,
    emotion: r.emotion,
    talk: r.talk,
    reply: r.reply ?? null,
    dropped,
  };
}

function memory(r: RawParse) {
  return r.memory.map((m) => ({ kind: m.kind, subject: m.subject ?? "", text: m.text, replaces: m.replaces ?? null }));
}

export const CURRENCY: Record<string, string> = {
  "РУБ": "RUB", "Р": "RUB", "₽": "RUB", "RUR": "RUB", "$": "USD", "ДОЛЛАР": "USD", "БАКС": "USD", "€": "EUR", "ЕВРО": "EUR",
};

/** Ключ латиницей (weight, sleep_hours…) или null. */
export function latinKey(s: string): string | null {
  const k = s.toLowerCase().trim().replace(/[^a-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "").slice(0, 30);
  return /^[a-z]/.test(k) ? k : null;
}

/** Подраздел здоровья по слову модели: ключ, русское название или новый ключ латиницей; пусто — other. */
export function topicOf(t: string | null | undefined): string {
  if (!t) return "other";
  const k = t.toLowerCase().trim();
  if (HEALTH_TOPICS[k]) return k;
  const byName = Object.entries(HEALTH_TOPICS).find(([, v]) => v.toLowerCase() === k);
  if (byName) return byName[0];
  return latinKey(k) ?? "other";
}
