import { z } from "zod";
import type { DateRow, EventRow, HabitRow, MemoryRow, TaskRow } from "./db.ts";
import { EMOTIONS } from "./personas.ts";
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
const num = z.preprocess((v) => (typeof v === "string" ? Number(v.replace(",", ".").replace(/\s/g, "")) : v), z.number().finite());
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
const Edit = z.object({
  action: z.enum(["cancel", "done", "move", "reopen"]),
  kind: z.enum(["event", "task", "date", "memory", "habit"]),
  id: z.number().int(),
  new_date: optStr,
  new_time: optStr,
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
  dates: arr(DateItem),
  memory: arr(Memory),
  metrics: arr(Metric),
  habits: arr(Habit),
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
  clarify: optStr,
  emotion: z.enum(EMOTIONS).catch("neutral"),
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
  dates: { title: string; date: string; type: string; person: string; yearly: boolean }[];
  memory: { kind: string; subject: string; text: string; replaces: number | null }[];
  metrics: { key: string; label: string; value: number; unit: string; note: string; dayKey: string }[];
  habits: { title: string; days: string; times: string[]; start: string; end: string | null }[];
  marks: { habitId: number; status: "done" | "skipped"; dayKey: string }[];
  money: { kind: "income" | "expense"; amount: number; currency: string; category: string; note: string; dayKey: string }[];
  edits: { action: "cancel" | "done" | "move" | "reopen"; kind: "event" | "task" | "date" | "memory" | "habit"; id: number; newDate: string | null; newTime: string | null }[];
  question: string | null;
  lookup: { from: string; to: string } | null;
  /** Корни слов для поиска по всем записям («сердц», «голов»). */
  search: string[];
  clarify: string | null;
  emotion: (typeof EMOTIONS)[number];
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
  habits: HabitRow[];
  recent: { role: "user" | "assistant"; text: string }[];
  /** Если ответ на уточнение — исходное сообщение и вопрос. */
  clarifying?: { original: string; question: string };
}

export function buildPrompt(ctx: ParseContext, voice: string): string {
  const evs = ctx.events.map((e) => `#${e.id} ${e.date_iso}${e.time ? " " + e.time : ""} — ${e.title}`).join("\n") || "нет";
  const tks = ctx.tasks.map((t) => `#${t.id} ${t.title}${t.due_date ? " (до " + t.due_date + ")" : ""}`).join("\n") || "нет";
  const dts = ctx.dates.map((d) => `#${d.id} ${d.date_iso.slice(5)} — ${d.title}`).join("\n") || "нет";
  const mem = ctx.memory.map((m) => `#${m.id} [${m.kind}] ${m.subject ? m.subject + ": " : ""}${m.text}`).join("\n") || "нет";
  const hab = ctx.habits.map((h) => `#${h.id} ${h.title} (дни ${h.days}${h.end_date ? ", до " + h.end_date : ""})`).join("\n") || "нет";
  return `Ты разбираешь сообщения пользователя для его личного дневника-помощника.
Сегодня ${ctx.today} (${weekdayLong(ctx.today)}), сейчас ${ctx.now}, часовой пояс ${ctx.tz}.
Вчера = ${addDays(ctx.today, -1)}, завтра = ${addDays(ctx.today, 1)}, послезавтра = ${addDays(ctx.today, 2)}.

Ответь ОДНИМ JSON-объектом:
{
 "date_iso": "YYYY-MM-DD — день, к которому относится запись дневника (по умолчанию сегодня)",
 "diary": [{"section": "notes|sleep|food|sport|health|hobby|mood", "topic": "только для health: ${Object.keys(HEALTH_TOPICS).join("|")} или новое слово латиницей", "text": "...", "day_iso": "если не date_iso"}],
 "metrics": [{"key": "${Object.keys(METRICS).join("|")} или новый ключ латиницей", "label": "подпись по-русски для нового ключа", "value": 85.3, "unit": "", "note": "", "day_iso": null}],
 "habits": [{"title": "...", "days": "1234567 (1 — пн … 7 — вс)", "times": ["ЧЧ:ММ"], "start_iso": null, "end_iso": null, "duration_days": 30}],
 "habit_marks": [{"habit_id": 3, "status": "done|skipped", "day_iso": null}],
 "money": [{"kind": "income|expense", "amount": 450, "currency": "RUB|USD|EUR…", "category": "${MONEY_CATEGORIES.join("|")}", "note": "на что / от кого", "day_iso": null}],
 "tags": ["короткие теги"],
 "summary": "[ЧЧ:ММ] почти дословная очищенная выжимка сообщения",
 "events": [{"title": "...", "date_iso": "YYYY-MM-DD", "time": "ЧЧ:ММ или null", "end_time": null, "details": ""}],
 "tasks": [{"title": "...", "priority": "high|normal|low", "due_date": "YYYY-MM-DD или null", "category": ""}],
 "dates": [{"title": "...", "date_iso": "YYYY-MM-DD", "type": "birthday|anniversary|holiday|deadline|other", "person": "", "yearly": true}],
 "memory": [{"kind": "fact|preference|person|goal", "subject": "о ком/о чём", "text": "...", "replaces": null}],
 "edits": [{"action": "cancel|done|move|reopen", "kind": "event|task|date|memory", "id": 12, "new_date": null, "new_time": null}],
 "question": "если пользователь спрашивает о своих данных — вопрос, иначе null",
 "lookup": {"from": "YYYY-MM-DD", "to": "YYYY-MM-DD"} или null — какие дни нужны для ответа (null — за всё время),
 "search": ["корни слов для поиска по записям, напр. сердц, кардиолог"] — только если вопрос про конкретную вещь,
 "clarify": "один короткий вопрос, если без него нельзя записать правильно, иначе null",
 "emotion": "${EMOTIONS.join("|")}",
 "reply": "короткая живая реплика на сообщение (1 предложение) или null"
}

Правила:
- Одно сообщение может содержать много всего сразу: дневник, планы, задачи, даты — разбери всё.
- Обычный рассказ о дне — это дневник. Будущее с датой/временем («встреча завтра в 15») — events.
  Дело с точным временем, даже без даты («Озон в 20:00», «забрать посылку в 18:30») — events на ближайший такой час.
  Дело без конкретного времени («надо купить лампочку») — tasks. День рождения, годовщина — dates.
- Сон: время отбоя и подъёма только если они названы. НЕ выдумывай время подъёма. Сны — в конец текста раздела sleep.
- Еда: только то, что съедено/выпито. «Купил продукты» — это notes, не food.
- Игры и время за компьютером НЕ пиши в дневник: их считает трекер. Можно упомянуть только в summary.
- Если разделы не распознаны — diary пустой, заполни только summary. Ничего не раскидывай наугад.
- summary: начинается с [${ctx.now}], близко к словам пользователя, без фраз вроде «записано», «пользователь сообщил».
- «Вчера я …» — day_iso вчерашнего дня. Записи о сне после полуночи относятся к ночи, которая началась вчера.
- edits: только по номерам из списков ниже. «Встречу с Петей перенесли на пятницу» — move с new_date.
  «Сделал лампочку» — done для задачи. Если номер неясен — clarify.
- Время «в 7» без утра/вечера, где оба варианта правдоподобны — clarify. «Завтра в 7 утра» — 07:00.
- dates.yearly = true только для повторяющихся каждый год (дни рождения, годовщины, праздники).
- Здоровье (самочувствие, врачи, таблетки, давление) — diary.health с topic. Числа (давление 130/85, пульс, вес) — ещё и metrics.
- Числа дня — metrics: вес, часы сна, шаги, минуты спорта, оценки 1–10. Только названные числа, ничего не досчитывай.
- Привычка — то, что надо делать регулярно («пить таблетку каждый день месяц», «зарядка по будням в 8»): habits.
  «Каждый день месяц» — duration_days 30; без срока — end_iso и duration_days null. Время — только если названо.
- «Выпил таблетку», «сделал зарядку» про привычку из списка — habit_marks с её номером (не задача и не дневник).
  «Бросаю привычку X» — edits kind=habit action=cancel.
- Деньги: «потратил 450 на такси», «пришло 30к за заказ» — money; сумма числом (30к = 30000), валюта по умолчанию RUB.
  Долги: дал в долг — expense с category «долг», вернули — income с «долг»; кто должен — ещё и memory.
- memory — устойчивые факты о жизни пользователя (люди, предпочтения, цели), не события дня.
  Если факт меняет старый — replaces = номер старого.
- Вопрос о прошлом («что я ел в понедельник?») — question + lookup, остальное пустое.
  «Когда болело сердце?» — question + search ["сердц", "кардиолог"], lookup null (искать за всё время).
  «Сколько потратил на еду в октябре?» — question + lookup на октябрь, search пустой (суммы код посчитает сам).
- Только поболтать (без фактов) — всё пустое, кроме reply и emotion.
- Изображения (если приложено):
  Чек — money expense одной строкой на чек: amount = ИТОГО к оплате, category по магазину и покупкам,
  note «Магазин: главное из купленного» (до 6 позиций), day_iso — дата с чека (нет даты — null); summary — коротко, где и сколько.
  Несколько чеков на одной картинке — по строке на каждый. Чек о возврате или поступлении — income.
  Билет, афиша, приглашение, скриншот расписания или переписки с договорённостью — events (дата и время с картинки).
  Назначение врача, рецепт, анализы — diary.health с topic; показатели — metrics; курс таблеток — habits.
  Список дел или покупок на фото — tasks.
  Не разобрать или ничего полезного — всё пустое, reply — что видно на картинке, одним предложением.
  Не выдумывай то, чего на картинке не видно: неразборчивую сумму не угадывай, лучше reply «не разобрала сумму».

Голос для reply: ${voice}

Ближайшие планы:
${evs}
Открытые задачи:
${tks}
Важные даты:
${dts}
Что известно о пользователе:
${mem}
Привычки:
${hab}`;
}

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
export function normalize(raw: unknown, ctx: { today: string; now: string; text: string }): Parsed {
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
    if (at && (due ?? ctx.today) >= ctx.today) {
      events.push({ title: at.title, date: due ?? (at.time > ctx.now ? ctx.today : addDays(ctx.today, 1)), time: at.time, endTime: null, details: "" });
      continue;
    }
    tasks.push({ title: t.title, priority: t.priority ?? "normal", due, category: t.category ?? "" });
  }

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
    if (e.action === "move" && !newDate && !newTime) {
      dropped.push(`edits: перенос #${e.id} без даты`);
      clarify ??= "На когда перенести?";
      continue;
    }
    edits.push({ action: e.action, kind: e.kind, id: e.id, newDate, newTime });
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

  const habits: Parsed["habits"] = [];
  for (const h of r.habits) {
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
    habits.push({ title: h.title, days, times: [...new Set(times)].sort(), start, end });
  }

  const marks: Parsed["marks"] = r.habit_marks.map((m) => ({
    habitId: m.habit_id,
    status: m.status,
    dayKey: day(m.day_iso, "habit_marks.day_iso", { future: false }) ?? ctx.today,
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
  const hasContent = diary.length || events.length || tasks.length || dates.length || memory(r).length || edits.length ||
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
    dates,
    memory: memory(r),
    metrics,
    habits,
    marks,
    money,
    edits,
    question: r.question ?? null,
    lookup,
    search,
    clarify,
    emotion: r.emotion,
    reply: r.reply ?? null,
    dropped,
  };
}

function memory(r: RawParse) {
  return r.memory.map((m) => ({ kind: m.kind, subject: m.subject ?? "", text: m.text, replaces: m.replaces ?? null }));
}

const CURRENCY: Record<string, string> = {
  "РУБ": "RUB", "Р": "RUB", "₽": "RUB", "RUR": "RUB", "$": "USD", "ДОЛЛАР": "USD", "БАКС": "USD", "€": "EUR", "ЕВРО": "EUR",
};

/** Ключ латиницей (weight, sleep_hours…) или null. */
export function latinKey(s: string): string | null {
  const k = s.toLowerCase().trim().replace(/[^a-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "").slice(0, 30);
  return /^[a-z]/.test(k) ? k : null;
}

function topicOf(t: string | null | undefined): string {
  if (!t) return "other";
  const k = t.toLowerCase().trim();
  if (HEALTH_TOPICS[k]) return k;
  const byName = Object.entries(HEALTH_TOPICS).find(([, v]) => v.toLowerCase() === k);
  if (byName) return byName[0];
  return latinKey(k) ?? "other";
}
