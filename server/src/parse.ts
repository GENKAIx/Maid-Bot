import { z } from "zod";
import type { DateRow, EventRow, MemoryRow, TaskRow } from "./db.ts";
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
export const TRACKER_SECTIONS = { pc: "Компьютер", games: "Игры", steps: "Шаги" } as const;

const str = z.string().trim();
const optStr = z.preprocess((v) => (v === "" ? null : v), str.nullable().optional());

const Diary = z.object({
  section: z.string(),
  text: str.min(1),
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
  kind: z.enum(["event", "task", "date", "memory"]),
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
  edits: arr(Edit),
  question: optStr,
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
  diary: { section: Section; text: string; dayKey: string }[];
  tags: string[];
  summary: string;
  events: { title: string; date: string; time: string | null; endTime: string | null; details: string }[];
  tasks: { title: string; priority: "high" | "normal" | "low"; due: string | null; category: string }[];
  dates: { title: string; date: string; type: string; person: string; yearly: boolean }[];
  memory: { kind: string; subject: string; text: string; replaces: number | null }[];
  edits: { action: "cancel" | "done" | "move" | "reopen"; kind: "event" | "task" | "date" | "memory"; id: number; newDate: string | null; newTime: string | null }[];
  question: string | null;
  lookup: { from: string; to: string } | null;
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
  recent: { role: "user" | "assistant"; text: string }[];
  /** Если ответ на уточнение — исходное сообщение и вопрос. */
  clarifying?: { original: string; question: string };
}

export function buildPrompt(ctx: ParseContext, voice: string): string {
  const evs = ctx.events.map((e) => `#${e.id} ${e.date_iso}${e.time ? " " + e.time : ""} — ${e.title}`).join("\n") || "нет";
  const tks = ctx.tasks.map((t) => `#${t.id} ${t.title}${t.due_date ? " (до " + t.due_date + ")" : ""}`).join("\n") || "нет";
  const dts = ctx.dates.map((d) => `#${d.id} ${d.date_iso.slice(5)} — ${d.title}`).join("\n") || "нет";
  const mem = ctx.memory.map((m) => `#${m.id} [${m.kind}] ${m.subject ? m.subject + ": " : ""}${m.text}`).join("\n") || "нет";
  return `Ты разбираешь сообщения пользователя для его личного дневника-помощника.
Сегодня ${ctx.today} (${weekdayLong(ctx.today)}), сейчас ${ctx.now}, часовой пояс ${ctx.tz}.
Вчера = ${addDays(ctx.today, -1)}, завтра = ${addDays(ctx.today, 1)}, послезавтра = ${addDays(ctx.today, 2)}.

Ответь ОДНИМ JSON-объектом:
{
 "date_iso": "YYYY-MM-DD — день, к которому относится запись дневника (по умолчанию сегодня)",
 "diary": [{"section": "notes|sleep|food|sport|health|hobby|mood", "text": "...", "day_iso": "если не date_iso"}],
 "tags": ["короткие теги"],
 "summary": "[ЧЧ:ММ] почти дословная очищенная выжимка сообщения",
 "events": [{"title": "...", "date_iso": "YYYY-MM-DD", "time": "ЧЧ:ММ или null", "end_time": null, "details": ""}],
 "tasks": [{"title": "...", "priority": "high|normal|low", "due_date": "YYYY-MM-DD или null", "category": ""}],
 "dates": [{"title": "...", "date_iso": "YYYY-MM-DD", "type": "birthday|anniversary|holiday|deadline|other", "person": "", "yearly": true}],
 "memory": [{"kind": "fact|preference|person|goal", "subject": "о ком/о чём", "text": "...", "replaces": null}],
 "edits": [{"action": "cancel|done|move|reopen", "kind": "event|task|date|memory", "id": 12, "new_date": null, "new_time": null}],
 "question": "если пользователь спрашивает о своих данных — вопрос, иначе null",
 "lookup": {"from": "YYYY-MM-DD", "to": "YYYY-MM-DD"} или null — какие дни дневника нужны для ответа,
 "clarify": "один короткий вопрос, если без него нельзя записать правильно, иначе null",
 "emotion": "${EMOTIONS.join("|")}",
 "reply": "короткая живая реплика на сообщение (1 предложение) или null"
}

Правила:
- Одно сообщение может содержать много всего сразу: дневник, планы, задачи, даты — разбери всё.
- Обычный рассказ о дне — это дневник. Будущее с датой/временем («встреча завтра в 15») — events.
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
- memory — устойчивые факты о жизни пользователя (люди, предпочтения, цели), не события дня.
  Если факт меняет старый — replaces = номер старого.
- Вопрос о прошлом («что я ел в понедельник?») — question + lookup, остальное пустое.
- Только поболтать (без фактов) — всё пустое, кроме reply и emotion.

Голос для reply: ${voice}

Ближайшие планы:
${evs}
Открытые задачи:
${tks}
Важные даты:
${dts}
Что известно о пользователе:
${mem}`;
}

const SECTION_KEYS = Object.keys(SECTIONS) as Section[];
const SECTION_ALIASES: Record<string, Section> = {
  note: "notes", заметки: "notes", sleep: "sleep", сон: "sleep", food: "food", еда: "food",
  sport: "sport", спорт: "sport", health: "health", здоровье: "health", hobby: "hobby", хобби: "hobby",
  mood: "mood", настроение: "mood",
};

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
    diary.push({ section: sec, text: d.text, dayKey: day(d.day_iso, "diary.day_iso", { future: false }) ?? dayKey });
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

  const tasks = r.tasks.map((t) => ({
    title: t.title,
    priority: t.priority ?? "normal",
    due: day(t.due_date, "tasks.due_date"),
    category: t.category ?? "",
  }));

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

  let lookup: Parsed["lookup"] = null;
  if (r.question && r.lookup) {
    const from = day(r.lookup.from, "lookup.from") ?? addDays(ctx.today, -7);
    const to = day(r.lookup.to, "lookup.to") ?? ctx.today;
    lookup = from <= to ? { from, to } : { from: to, to: from };
  }

  let summary = r.summary.trim();
  const hasContent = diary.length || events.length || tasks.length || dates.length || memory(r).length || edits.length;
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
    edits,
    question: r.question ?? null,
    lookup,
    clarify,
    emotion: r.emotion,
    reply: r.reply ?? null,
    dropped,
  };
}

function memory(r: RawParse) {
  return r.memory.map((m) => ({ kind: m.kind, subject: m.subject ?? "", text: m.text, replaces: m.replaces ?? null }));
}
