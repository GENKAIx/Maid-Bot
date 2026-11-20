import { z } from "zod";
import type { DateRow, DiaryRow, EventRow, HabitRow, MemoryRow, MetricRow, MoneyRow, NoteRow, Store, TaskRow, TraitRow } from "./db.ts";
import type { Change } from "./pipeline.ts";
import { dateCard, diaryCard, eventCard, habitCard, memoryCard, metricCard, moneyCard, noteCard, taskCard, traitCard } from "./cards.ts";
import { SHELF_KEYS, SHELVES, NOTE_TEXT_MAX, NOTE_TITLE_MAX, shelfKey } from "./notes.ts";
import { CURRENCY, HEALTH_TOPICS, MONEY_CATEGORIES, SECTIONS, num, promptHeader, topicOf } from "./parse.ts";
import { EMOTIONS } from "./personas.ts";
import { esc } from "./report.ts";
import { isDayKey, normalizeTime } from "./time.ts";

// Поправка к ответу: под облачком горничной — строка «поправить этот ответ…». Сказанное там («не в 15, а в 17», «это еда,
// а не транспорт», «сумма 540», «на завтра») меняет только записи этого ответа. Модель видит только их (r1…rn) и отвечает,
// какие поля поменять; код проверяет каждое значение теми же проверками, что разбор (parse.ts), и пишет всё одной транзакцией
// (Pipeline.correct). Журнал — под id исходного сообщения (kind edit, before — прежние значения изменённых полей): одна
// «↩ Отменить» откатывает ответ вместе с поправками. Вид записи (план → задача, → заметка) поправкой не меняется.

/** Запись ответа с карточкой: таблица, id и строка из базы. */
export type AnswerRow =
  | { tbl: "events"; id: number; row: EventRow }
  | { tbl: "tasks"; id: number; row: TaskRow }
  | { tbl: "money"; id: number; row: MoneyRow & { deleted: number } }
  | { tbl: "metrics"; id: number; row: MetricRow & { deleted: number } }
  | { tbl: "diary"; id: number; row: DiaryRow & { user_id: number; deleted: number } }
  | { tbl: "notes"; id: number; row: NoteRow }
  | { tbl: "dates"; id: number; row: DateRow }
  | { tbl: "habits"; id: number; row: HabitRow }
  | { tbl: "memory"; id: number; row: MemoryRow & { user_id: number } }
  | { tbl: "traits"; id: number; row: TraitRow };
/** Что можно поправить словами: всё, кроме привычек (у них свои правки — словами в разборе и мышью), памяти и профиля
 *  (их карточки только собираются заново). */
export type Editable = Exclude<AnswerRow, { tbl: "habits" | "memory" | "traits" }>;
export const editable = (x: AnswerRow): x is Editable => x.tbl !== "habits" && x.tbl !== "memory" && x.tbl !== "traits";
/** Запись в ответе: added — записана этим ответом, corrected — её уже поправляли, alive — видна (alive ниже). */
export interface AnswerItem { x: AnswerRow; added: boolean; corrected: boolean; alive: boolean }

/** Ключ записи в ответе поправки (changed): «таблица:id». */
export const refKey = (x: { tbl: string; id: number }) => `${x.tbl}:${x.id}`;

async function loadRow(s: Store, tbl: string, id: number): Promise<AnswerRow | null> {
  switch (tbl) {
    case "events": { const row = await s.event(id); return row ? { tbl: "events", id, row } : null; }
    case "tasks": { const row = await s.task(id); return row ? { tbl: "tasks", id, row } : null; }
    case "money": { const row = await s.money(id); return row ? { tbl: "money", id, row } : null; }
    case "metrics": { const row = await s.metric(id); return row ? { tbl: "metrics", id, row } : null; }
    case "diary": { const row = await s.diaryRow(id); return row ? { tbl: "diary", id, row } : null; }
    case "notes": { const row = await s.note(id); return row ? { tbl: "notes", id, row } : null; }
    case "dates": { const row = await s.date(id); return row ? { tbl: "dates", id, row } : null; }
    case "habits": { const row = await s.habit(id); return row ? { tbl: "habits", id, row } : null; }
    case "memory": { const row = await s.memoryRow(id); return row ? { tbl: "memory", id, row } : null; }
    case "traits": { const row = await s.trait(id); return row ? { tbl: "traits", id, row } : null; }
    default: return null;
  }
}

const GONE = ["deleted", "cancelled", "purged"];
/** Запись стала другим видом (виджет, api.ts): план без времени — задачей (план — status tasked), задача со временем —
 *  планом (задача — status planned). Закрытая строка скрыта, видна новая — поправлять закрытую нельзя. */
export const turned = (x: AnswerRow) => (x.tbl === "events" && x.row.status === "tasked") || (x.tbl === "tasks" && x.row.status === "planned");
/** Запись ещё видна: не удалена, не отменена, не стёрта, не стала другим видом записи. */
export function alive(x: AnswerRow): boolean {
  if (x.tbl === "money" || x.tbl === "metrics" || x.tbl === "diary") return !Number(x.row.deleted);
  // Память заменяют (superseded), бафы и дебафы снимают (removed).
  if (x.tbl === "memory" || x.tbl === "traits") return x.row.status === "active";
  return !GONE.includes(x.row.status) && !turned(x);
}

/** Записи ответа messageId по журналу отмены (записанные и поправленные), в порядке записи, без повторов.
 *  Хроника дня (summary) и теги — не записи для поправки и не карточки. */
export async function answerRows(s: Store, userId: number, messageId: number): Promise<AnswerItem[]> {
  const out: AnswerItem[] = [];
  const seen = new Map<string, AnswerItem | null>();
  for (const a of [...(await s.actionsOf(messageId))].reverse()) {
    const key = `${a.tbl}:${a.row_id}`;
    if (seen.has(key)) {
      const was = seen.get(key);
      if (was) {
        was.added ||= a.kind === "add";
        was.corrected ||= a.kind === "edit";
      }
      continue;
    }
    const x = await loadRow(s, a.tbl, a.row_id);
    const skip = !x || x.row.user_id !== userId || (x.tbl === "diary" && (x.row.section === "summary" || x.row.section === "tags"));
    const item = skip ? null : { x: x!, added: a.kind === "add", corrected: a.kind === "edit", alive: alive(x!) };
    seen.set(key, item);
    if (item) out.push(item);
  }
  return out;
}

/** Карточка записи — та же, что под ответом разбора (cards.ts). */
export function cardOf(x: AnswerRow): Change {
  switch (x.tbl) {
    case "events": return eventCard(x.row);
    case "tasks": return taskCard(x.row);
    case "money": return moneyCard({ ...x.row, amount: Number(x.row.amount) });
    case "metrics": return metricCard({ ...x.row, value: Number(x.row.value) });
    case "diary": return diaryCard(x.row);
    case "notes": return noteCard(x.row);
    case "dates": return dateCard(x.row);
    case "habits": return habitCard(x.row);
    case "memory": return memoryCard(x.row);
    case "traits": return traitCard(x.row);
  }
}

/** Карточки ответа после поправки: записанное им и поправленное, что ещё живо, — в порядке записи. */
export const answerCards = (items: AnswerItem[]) => items.filter((i) => i.alive && (i.added || i.corrected)).map((i) => cardOf(i.x));

const KIND_NAME: Record<Editable["tbl"], string> = {
  events: "план", tasks: "задача", money: "деньги", metrics: "показатель", diary: "дневник", notes: "заметка «на потом»", dates: "важная дата",
};

/** Поля записи, которые видит модель (у показателя подпись и единица — только для понимания, их не правят). */
function fieldsOf(x: Editable): Record<string, unknown> {
  switch (x.tbl) {
    case "events": return { title: x.row.title, date_iso: x.row.date_iso, time: x.row.time, end_time: x.row.end_time, details: x.row.details };
    case "tasks": return { title: x.row.title, due_date: x.row.due_date, priority: x.row.priority };
    case "money": return { kind: x.row.kind, amount: Number(x.row.amount), currency: x.row.currency, category: x.row.category, note: x.row.note, day_key: x.row.day_key };
    case "metrics": return { label: x.row.label, value: Number(x.row.value), unit: x.row.unit, day_key: x.row.day_key, note: x.row.note };
    case "diary": return { section: x.row.section, ...(x.row.section === "health" ? { topic: x.row.topic } : {}), text: x.row.text, day_key: x.row.day_key };
    case "notes": return { shelf: x.row.shelf, title: x.row.title, note: x.row.note };
    case "dates": return { title: x.row.title, date_iso: x.row.date_iso, type: x.row.type, yearly: Boolean(Number(x.row.yearly)) };
  }
}

export const DATE_TYPES = ["birthday", "anniversary", "holiday", "deadline", "other"];
const PRIORITIES = ["high", "normal", "low"];

/** Запрос к модели: голос характера, «сегодня» как у разбора, исходное сообщение и только записи этого ответа.
 *  question — прошлая поправка этого ответа кончилась вопросом: тогда в сообщении пользователя — та поправка и ответ на вопрос. */
export function correctPrompt(o: { voice: string; today: string; now: string; tz: string; original: string; rows: Editable[]; question?: string }): string {
  const list = o.rows.map((x, i) => `r${i + 1} ${KIND_NAME[x.tbl]}: ${JSON.stringify(fieldsOf(x))}`).join("\n");
  const asked = o.question
    ? `\nНа прошлую поправку ты переспросила: «${plain(o.question)}». Ниже в сообщении — та поправка и ответ на вопрос («(уточнение: …)»): исполни поправку с ним.\n`
    : "";
  return `${o.voice}
Пользователь поправляет один твой ответ — записи, которые ты сделала из его сообщения. Меняй только их: других записей здесь нет.
${promptHeader(o.today, o.now, o.tz)}

Его сообщение, из которого сделаны записи:
${o.original}

Записи этого ответа (ref — номер, дальше — вид записи и её поля сейчас):
${list}
${asked}
Какие поля можно менять:
- план: title, date_iso (ГГГГ-ММ-ДД), time (ЧЧ:ММ или null — на весь день), end_time (ЧЧ:ММ или null), details
- задача: title, due_date (ГГГГ-ММ-ДД или null — без срока), priority (${PRIORITIES.join("|")})
- деньги: kind (expense — трата, income — доход), amount (число больше 0), currency (RUB|USD|EUR…), category (${MONEY_CATEGORIES.join("|")}), note (на что / от кого), day_key (ГГГГ-ММ-ДД, не позже сегодня)
- показатель: value (число), day_key (ГГГГ-ММ-ДД, не позже сегодня), note
- дневник: section (${Object.keys(SECTIONS).join("|")}), topic (только для health: ${Object.keys(HEALTH_TOPICS).join("|")}), text, day_key (не позже сегодня)
- заметка «на потом»: shelf (${SHELF_KEYS.join("|")}), title, note
- важная дата: title, date_iso (ГГГГ-ММ-ДД), type (${DATE_TYPES.join("|")}), yearly (true|false)

Ответь ОДНИМ JSON-объектом:
{"edits": [{"ref": "r1", "set": {"time": "17:00"}}], "clarify": null, "unsupported": false, "reply": "короткая живая реплика, что поправила (1 предложение)", "emotion": "${EMOTIONS.join("|")}"}

Правила:
- В set — только поля, которые просит поменять поправка; остальное оставь как есть и не повторяй.
- Поправка про одну запись — меняй только её. Неясно, какую запись или на что поменять, — clarify: один короткий вопрос, edits пустой.
- Время «в 7» без утра/вечера, где оба варианта правдоподобны, — clarify. «В 7 вечера» — 19:00. Время — только ЧЧ:ММ.
- Сдвигаешь начало плана, а конец не назван — end_time не ставь: длительность сохранит сервер. Конец раньше начала («с 22 до 2») — до утра следующего дня, так можно.
- «Это еда, а не транспорт» — category; «сумма 540» — amount; «на завтра», «это было вчера» — date_iso, due_date или day_key.
- Трата или доход — это поле kind у денег, его менять можно.
- Просят поменять вид записи («это задача, а не план», «это заметка», «запиши в дневник, а не в планы») — unsupported: true, edits пустой: вид записи ты менять не умеешь.
- Ничего не выдумывай: числа, даты и время — только названные в поправке или прямо из неё вытекающие («на час позже»).`;
}

const optText = z.preprocess((v) => (typeof v === "string" && v.trim() ? v.trim() : null), z.string().nullable());
const EditItem = z.object({ ref: z.union([z.string(), z.number()]), set: z.record(z.unknown()).optional() }).passthrough();
/** Ответ модели. Пункт без set — поля рядом с ref (так тоже бывает). */
export const CorrectSchema = z.object({
  edits: z.preprocess((v) => (Array.isArray(v) ? v : []), z.array(z.unknown())).transform((list) =>
    list.flatMap((x) => {
      const r = EditItem.safeParse(x);
      if (!r.success) return [];
      const { ref, set, ...rest } = r.data;
      const k = String(ref).trim().toLowerCase();
      return [{ ref: /^\d+$/.test(k) ? `r${k}` : k, set: (set ?? rest) as Record<string, unknown> }];
    }),
  ),
  clarify: optText,
  unsupported: z.boolean().catch(false),
  reply: optText,
  emotion: z.enum(EMOTIONS).catch("neutral"),
});
export type CorrectOut = z.infer<typeof CorrectSchema>;

/** Что поменять в записи: patch — новые значения изменившихся полей, before — их прежние значения (журнал отмены). */
export interface Planned { x: Editable; patch: Record<string, unknown>; before: Record<string, unknown> }
/** problem — вопрос вместо записи; unsupported — просят другой вид записи. */
type Check = Planned | { problem: string } | { unsupported: true };

/** Модель не назвала ни одного поля, которое можно поменять, — переспросить. */
export const NOT_UNDERSTOOD = "Не поняла, что поправить в этом ответе. Скажите иначе — например, «не в 15, а в 17».";
/** Просят сменить вид записи — честно: не умеет. */
export const KIND_CHANGE = "Поменять вид записи (план, задача, заметка, дневник…) я пока не умею. Нажмите «↩ Отменить» и скажите заново, как нужно.";
/** Ответ отменили «↩ Отменить» (в том числе пока поправка ждала модель) — ничего не пишется. */
export const ALREADY_UNDONE = "Этот ответ уже отменён — поправлять нечего.";

/** Честный ответ, когда запись ответа поправить нельзя: стала задачей или планом — где её искать; иначе — её уже нет. */
export function goneReply(x: AnswerRow): string {
  const t = html(cardOf(x).title);
  if (x.tbl === "events" && turned(x)) return `«${t}» уже не план, а задача — поправьте её в задачах.`;
  if (x.tbl === "tasks" && turned(x)) return `«${t}» уже не задача, а план — поправьте его в планах.`;
  return `Записи «${t}» уже нет — ничего не поменяла.`;
}

/** Поля, которые поправка меняет, по видам записи (как в correctPrompt «Какие поля можно менять»). */
const FIELDS: Record<Editable["tbl"], string[]> = {
  events: ["title", "date_iso", "time", "end_time", "details"],
  tasks: ["title", "due_date", "priority"],
  money: ["kind", "amount", "currency", "category", "note", "day_key"],
  metrics: ["value", "day_key", "note"],
  diary: ["section", "topic", "text", "day_key"],
  notes: ["shelf", "title", "note"],
  dates: ["title", "date_iso", "type", "yearly"],
};
/** Поле не из списка, которое значит «это другой вид записи» (у показателя — другой показатель: «это пульс, а не вес»). */
const kindField = (tbl: Editable["tbl"], k: string) =>
  ["kind", "type", "tbl", "table"].includes(k) || (tbl === "metrics" && ["key", "label", "unit"].includes(k));
const DAY_MINUTES = 24 * 60;

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const blank = (v: unknown) => v === null || v === undefined || (typeof v === "string" && !v.trim());
const shown = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v) ?? "").trim().slice(0, 40);
/** Строка поля: пустая — только если можно (empty), длинная — обрезается. null — не строка или пусто, где нельзя. */
function line(v: unknown, max: number, empty = false): string | null {
  if (v === null && empty) return "";
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t || empty ? t.slice(0, max) : null;
}
const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const hhmm = (n: number) => `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;

/** Вопрос на время, которого нет: «51 — такого часа нет». */
export function timeProblem(v: unknown): string {
  const m = shown(v).match(/^(\d{1,3})(?:[:.](\d{1,3}))?$/);
  if (m && Number(m[1]) > 23) return `${Number(m[1])} — такого часа нет. Во сколько поставить?`;
  if (m?.[2] && Number(m[2]) > 59) return `${Number(m[2])} минут не бывает. Во сколько поставить?`;
  return `«${shown(v)}» — не поняла время. Во сколько поставить?`;
}
const dayProblem = (v: unknown) => `«${shown(v)}» — такого дня нет. На какой день?`;

/** Проверить поправку записи теми же проверками, что разбор; ничего не пишет. Неверное значение — problem (вопрос).
 *  Поле, которого у записи нет, не пропускается молча: иначе горничная сказала бы «так и записано», а запись другая. */
export function planEdit(x: Editable, set: Record<string, unknown>, today: string): Check {
  const bad = (problem: string) => ({ problem });
  const keys = Object.keys(set).filter((k) => k !== "ref");
  const odd = keys.filter((k) => !FIELDS[x.tbl].includes(k));
  if (odd.some((k) => kindField(x.tbl, k))) return { unsupported: true };
  if (odd.length || !keys.length) return bad(NOT_UNDERSTOOD);
  const pastDay = (v: unknown): string | { problem: string } =>
    !isDayKey(v) ? bad(dayProblem(v)) : v > today ? bad(`${v} ещё не наступило. За какой день записать?`) : v;
  const done = (next: Record<string, unknown>, now: Record<string, unknown>): Planned => {
    const patch: Record<string, unknown> = {};
    const before: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(next)) {
      if (v === (now[k] ?? null)) continue;
      patch[k] = v;
      before[k] = now[k] ?? null;
    }
    return { x, patch, before };
  };

  if (x.tbl === "events") {
    const r = x.row;
    const now = { title: r.title, date_iso: r.date_iso, time: r.time, end_time: r.end_time, details: r.details };
    const next = { ...now };
    if (has(set, "title")) {
      const t = line(set.title, 200);
      if (t === null) return bad("Как назвать план?");
      next.title = t;
    }
    if (has(set, "date_iso")) {
      if (!isDayKey(set.date_iso)) return bad(dayProblem(set.date_iso));
      next.date_iso = set.date_iso;
    }
    if (has(set, "time")) {
      if (blank(set.time)) {
        next.time = null;
        next.end_time = null;
      } else {
        const t = normalizeTime(set.time);
        if (!t) return bad(timeProblem(set.time));
        // Начало сдвинули, конец не назвали — длительность та же, по кругу суток: «с 22 до 2» на час позже — «с 23 до 3».
        if (!has(set, "end_time") && r.time && r.end_time) {
          const len = (minutes(r.end_time) - minutes(r.time) + DAY_MINUTES) % DAY_MINUTES;
          next.end_time = len ? hhmm((minutes(t) + len) % DAY_MINUTES) : null;
        }
        next.time = t;
      }
    }
    if (has(set, "end_time")) {
      if (blank(set.end_time)) next.end_time = null;
      else {
        const t = normalizeTime(set.end_time);
        if (!t) return bad(timeProblem(set.end_time));
        next.end_time = t;
      }
    }
    // Начало и конец сверяются, только если поправка их трогает: записанные разбором (после «перенеси» конец бывает раньше
    // начала) не мешают поправить день или название. Конец раньше начала — до утра следующего дня, как в разборе
    // («с 22 до 2»); тот же час — без конца.
    if (has(set, "time") || has(set, "end_time")) {
      if (next.end_time && !next.time) return bad("Без начала конец не поставить. Во сколько начало?");
      if (next.end_time && next.end_time === next.time) next.end_time = null;
    }
    if (has(set, "details")) next.details = line(set.details, 2000, true) ?? r.details;
    return done(next, now);
  }

  if (x.tbl === "tasks") {
    const r = x.row;
    const now = { title: r.title, due_date: r.due_date, priority: r.priority };
    const next = { ...now };
    if (has(set, "title")) {
      const t = line(set.title, 200);
      if (t === null) return bad("Как назвать задачу?");
      next.title = t;
    }
    if (has(set, "due_date")) {
      if (blank(set.due_date)) next.due_date = null;
      else if (!isDayKey(set.due_date)) return bad(dayProblem(set.due_date));
      else next.due_date = set.due_date;
    }
    if (has(set, "priority")) {
      if (typeof set.priority !== "string" || !PRIORITIES.includes(set.priority)) return bad("Какая важность: высокая, обычная или низкая?");
      next.priority = set.priority;
    }
    return done(next, now);
  }

  if (x.tbl === "money") {
    const r = x.row;
    const now = { kind: r.kind, amount: Number(r.amount), currency: r.currency, category: r.category, note: r.note, day_key: r.day_key };
    const next: Record<string, unknown> = { ...now };
    if (has(set, "kind")) {
      if (set.kind !== "income" && set.kind !== "expense") return bad("Это трата или доход?");
      next.kind = set.kind;
    }
    if (has(set, "amount")) {
      const a = num.safeParse(set.amount);
      if (!a.success || !(a.data > 0) || a.data > 1e12) return bad(`«${shown(set.amount)}» — не поняла сумму. Сколько?`);
      next.amount = Math.round(a.data * 100) / 100;
    }
    if (has(set, "currency")) {
      const up = String(set.currency ?? "").trim().toUpperCase();
      const cur = CURRENCY[up] ?? (/^[A-Z]{3}$/.test(up) ? up : null);
      if (!cur) return bad(`«${shown(set.currency)}» — не знаю такой валюты. В какой валюте?`);
      next.currency = cur;
    }
    if (has(set, "category")) {
      const c = typeof set.category === "string" ? set.category.trim().toLowerCase() : "";
      if (!MONEY_CATEGORIES.includes(c)) return bad(`Категории «${shown(set.category)}» у меня нет. Какую поставить: ${MONEY_CATEGORIES.join(", ")}?`);
      next.category = c;
    }
    if (has(set, "note")) next.note = line(set.note, 200, true) ?? r.note;
    if (has(set, "day_key")) {
      const d = pastDay(set.day_key);
      if (typeof d !== "string") return d;
      next.day_key = d;
    }
    return done(next, now);
  }

  if (x.tbl === "metrics") {
    const r = x.row;
    const now = { value: Number(r.value), day_key: r.day_key, note: r.note };
    const next: Record<string, unknown> = { ...now };
    if (has(set, "value")) {
      const v = num.safeParse(set.value);
      if (!v.success) return bad(`«${shown(set.value)}» — не поняла число. Сколько записать?`);
      next.value = v.data;
    }
    if (has(set, "day_key")) {
      const d = pastDay(set.day_key);
      if (typeof d !== "string") return d;
      next.day_key = d;
    }
    if (has(set, "note")) next.note = line(set.note, 200, true) ?? r.note;
    return done(next, now);
  }

  if (x.tbl === "diary") {
    const r = x.row;
    const now = { section: r.section, topic: r.topic, text: r.text, day_key: r.day_key };
    const next = { ...now };
    if (has(set, "section")) {
      const k = typeof set.section === "string" ? set.section.trim().toLowerCase() : "";
      const sec = Object.entries(SECTIONS).find(([key, name]) => key === k || name.toLowerCase() === k)?.[0];
      if (!sec) return bad(`Раздела «${shown(set.section)}» в дневнике нет. Куда записать: ${Object.values(SECTIONS).join(", ")}?`);
      next.section = sec;
    }
    if (has(set, "topic")) next.topic = topicOf(typeof set.topic === "string" ? set.topic : null);
    if (has(set, "text")) {
      const t = line(set.text, 4000);
      if (t === null) return bad("Что записать?");
      next.text = t;
    }
    if (has(set, "day_key")) {
      const d = pastDay(set.day_key);
      if (typeof d !== "string") return d;
      next.day_key = d;
    }
    // Подраздел — только у здоровья (как в разборе): ушла из здоровья — без него, пришла без названного — «Другое».
    if (next.section !== "health") next.topic = "";
    else if (!next.topic) next.topic = "other";
    return done(next, now);
  }

  if (x.tbl === "notes") {
    const r = x.row;
    const now = { shelf: r.shelf, title: r.title, note: r.note };
    const next = { ...now };
    if (has(set, "shelf")) {
      const k = shelfKey(typeof set.shelf === "string" ? set.shelf : null);
      if (!k) return bad(`Полки «${shown(set.shelf)}» нет. Куда положить: ${Object.values(SHELVES).join(", ")}?`);
      next.shelf = k;
    }
    if (has(set, "title")) {
      const t = line(set.title, NOTE_TITLE_MAX);
      if (t === null) return bad("Как назвать заметку?");
      next.title = t;
    }
    if (has(set, "note")) next.note = line(set.note, NOTE_TEXT_MAX, true) ?? r.note;
    return done(next, now);
  }

  const r = x.row;
  const now = { title: r.title, date_iso: r.date_iso, type: r.type, yearly: Number(r.yearly) };
  const next = { ...now };
  if (has(set, "title")) {
    const t = line(set.title, 200);
    if (t === null) return bad("Как назвать дату?");
    next.title = t;
  }
  if (has(set, "date_iso")) {
    if (!isDayKey(set.date_iso)) return bad(dayProblem(set.date_iso));
    next.date_iso = set.date_iso;
  }
  if (has(set, "type")) {
    if (typeof set.type !== "string" || !DATE_TYPES.includes(set.type)) return bad("Что это за дата: день рождения, годовщина, праздник, срок или другое?");
    next.type = set.type;
  }
  if (has(set, "yearly")) {
    if (typeof set.yearly !== "boolean") return bad("Повторять эту дату каждый год?");
    next.yearly = set.yearly ? 1 : 0;
  }
  return done(next, now);
}

/** Записать проверенную поправку (внутри транзакции; журнал пишет Pipeline.correct). */
export async function applyPlanned(s: Store, p: Planned) {
  const patch = p.patch as never;
  switch (p.x.tbl) {
    case "events": return s.updateEvent(p.x.id, patch);
    case "tasks": return s.updateTask(p.x.id, patch);
    case "money": return s.updateMoney(p.x.id, patch);
    case "metrics": return s.updateMetric(p.x.id, patch);
    case "diary": return s.updateDiary(p.x.id, patch);
    case "notes": return s.updateNote(p.x.id, patch);
    case "dates": return s.updateDate(p.x.id, patch);
  }
}

/** Запись снова из базы — перед записью поправки (пока модель думала, её могли поправить мышью) и для карточки после неё. */
export const reload = (s: Store, x: AnswerRow) => loadRow(s, x.tbl, x.id);

const plain = (t = "") => t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const html = (t?: string) => esc(plain(t));
/** Строка ответа о поправке (HTML, как весь ответ): «✎ Встреча с Петей: 9 ноября, Пн 15:00 → 9 ноября, Пн 17:00». */
export function changeLine(was: Change, now: Change): string {
  const title = was.title === now.title ? html(now.title) : `${html(was.title)} → ${html(now.title)}`;
  const detail = (was.detail ?? "") === (now.detail ?? "") ? "" : `: ${html(was.detail) || "—"} → ${html(now.detail) || "—"}`;
  return `✎ ${title}${detail || (was.title === now.title ? " — поправила" : "")}`;
}
