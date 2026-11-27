import { AsyncLocalStorage } from "node:async_hooks";
import type { MarkRow, Message, ProposalRow, Store, Table, User } from "./db.ts";
import type { LlmCall, Picture } from "./llm.ts";
import type { DrawCall } from "./draw.ts";
import { asUser, extractJson, llmErrorCode } from "./llm.ts";
import { buildPrompt, normalize, type Parsed, type Section } from "./parse.ts";
import { finishPatch, habitBefore, habitsOfDay, markRefusal, reopenPatch, scheduleText } from "./habits.ts";
import { persona, pick, type Emotion } from "./personas.ts";
import { prompt } from "./prompts.ts";
import { changesList, esc, upcomingDates, wholeSentences } from "./report.ts";
import { addDays, dayKey, humanDay, timeOf, zonedToUtc } from "./time.ts";
import { habitButtons, habitQuestion, planEventReminders, snoozeDayRefusal, snoozeOptions } from "./scheduler.ts";
import { EVER, answerData, linkDays } from "./ask.ts";
import { clashLine, findClash, keepPair, overlaps, shiftTime, type Clash } from "./clash.ts";
import { addTraitFromChat, traitPrompt } from "./profile.ts";
import { aboutOffer, cityOf, findCities, type City, type YouButton } from "./you.ts";
import { weatherFor } from "./weather.ts";
import { countFeature } from "./feature-events.ts";
import { RATE_AGAIN, type AiGate, type Refusal, type Taken, type Verdict } from "./access.ts";
import { SHELVES, notesData, sameNote } from "./notes.ts";
import { noteQueue } from "./server-metrics.ts";
import { dateCard, diaryCard, eventCard, habitCard, memoryCard, metricCard, moneyCard, noteCard, taskCard, traitCard } from "./cards.ts";
import {
  ALREADY_UNDONE, CorrectSchema, KIND_CHANGE, NOT_UNDERSTOOD, addLine, addOf, alive, answerCards, answerRows, applyPlanned, cardOf, changeLine, correctPrompt, editable,
  removeLine, removeRow,
  goneReply, planEdit, refKey, reload, turned, type CorrectOut, type Editable, type Planned,
} from "./correct.ts";

// Сообщение → запись → разбор → действия → ответ.
// Порядок важен: сначала сохраняем сырое сообщение (повтор доставки найдёт его), потом разбор,
// затем все действия одной транзакцией. Ответ «записала» — только после неё.

/** Что и куда записалось — для карточек в приложении. */
export interface Change {
  kind: "diary" | "event" | "task" | "date" | "memory" | "metric" | "money" | "habit" | "mark" | "edit" | "trait" | "note";
  title: string;
  detail?: string;
  /** Запись за карточкой (ровно одна строка таблицы): по ней виджет узнаёт карточку после поправки к ответу (cards.ts). */
  ref?: { tbl: Table; id: number };
}

/** Задача, которая уже есть и о которой ответ («Эта задача уже в списке, под номером #102: «…»», правка задачи словами):
 *  плашка «↗ название» под ответом, щелчок в виджете — к строке задачи в списке (26.11.2026, виджет 0.1.94).
 *  Отдельным полем, а не в changes: changes — «записала» (облачко старого виджета тогда обрезает текст до первой строки и
 *  ставит «записала»), а незнакомое поле старый виджет просто не читает. id — только известный коду, по тексту не угадывается. */
export interface TaskRef { tbl: "tasks"; id: number; title: string }
/** Больше ссылок под одним ответом не нужно: это не список задач. */
export const REFS_MAX = 5;

const plainOf = (t: string) => t.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const sameTitle = (a: string, b: string) => a.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim() === b.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
/** Слова, что перед номером называют его таблицу: «задача #7» — задача; «план #7», «привычка #7», «дата #7»… — не задача. */
const TASK_WORD = /^задач/;
const OTHER_WORD = /^(план|событ|встреч|привычк|дат(а|ы|у|е|ой)$|заметк|памят|корзин)/;
const NEAR_WORDS = 6;
const SENTENCE_END = [".", "!", "?", "\n", "…"];
const normOf = (t: string) => t.toLowerCase().replace(/ё/g, "е").replace(/[«»"]/g, " ").replace(/\s+/g, " ").trim();
/** Задачи из списка, что видела модель в запросе разбора («#id название»), которые называет её ответ (26.11.2026):
 *  номер («#102», «под номером 102», «№ 102») — если ближайшее слово-таблица перед ним (до NEAR_WORDS слов в той же фразе) —
 *  «задача», или в той же фразе стоит название задачи; перед номером «план», «привычка», «дата»… — не задача. У событий, дат,
 *  привычек, заметок, памяти и корзины свои счётчики id (others — их номера из того же запроса): такой номер — задача только
 *  при слове «задача» перед ним или названии задачи целиком в той же фразе, одного общего слова мало. Ещё — название целиком
 *  в кавычках «…». Только из этого списка: id другого человека или выдуманный номер ссылкой не станет. */
export function taskRefsIn(text: string, tasks: { id: number; title: string }[], others: Iterable<number> = []): number[] {
  const plain = plainOf(text);
  const taken = new Set(others);
  const ids: number[] = [];
  const add = (id: number) => { if (!ids.includes(id)) ids.push(id); };
  for (const m of plain.matchAll(/(?:#|№\s*|номер(?:ом|у|е|а)?\s+#?)(\d{1,9})(?!\d)/giu)) {
    const t = tasks.find((x) => x.id === Number(m[1]));
    if (!t) continue;
    const at = m.index ?? 0;
    const from = Math.max(...SENTENCE_END.map((c) => plain.lastIndexOf(c, at - 1))) + 1;
    const ends = SENTENCE_END.map((c) => plain.indexOf(c, at + m[0].length)).filter((i) => i >= 0);
    const sentence = plain.slice(from, ends.length ? Math.min(...ends) : plain.length);
    const before = (plain.slice(from, at).toLowerCase().replace(/ё/g, "е").match(/[\p{L}\d]+/gu) ?? []).slice(-NEAR_WORDS).reverse();
    const marker = before.find((w) => TASK_WORD.test(w) || OTHER_WORD.test(w));
    if (marker && !TASK_WORD.test(marker)) continue; // «план #7», «привычка под номером 7»
    const named = normOf(sentence).includes(normOf(t.title));
    if (marker || named || (!taken.has(t.id) && mentions(wordsOf(sentence), t.title))) add(t.id);
  }
  for (const m of plain.matchAll(/«([^«»]{2,200})»/g)) {
    const t = tasks.find((x) => sameTitle(x.title, m[1]));
    if (t) add(t.id);
  }
  return ids.slice(0, REFS_MAX);
}

/** Вопрос о погоде: «какая погода?», «что с погодой сегодня», «погода». */
export const WEATHER_ASK = /^\s*(а\s+)?((какая|какой)\s+(сегодня\s+)?(погод|прогноз)|что\s+(там\s+)?(с|по)\s+погод|погода(\s+(сегодня|на\s+сегодня))?\s*\??\s*$)/i;

export interface Reply {
  text: string;
  emotion: Emotion;
  messageId: number;
  /** Есть что отменить — показать кнопки. */
  undoable: boolean;
  duplicate?: boolean;
  changes?: Change[];
  /** Существующие открытые задачи, о которых ответ (TaskRef): ссылки под ответом. */
  refs?: TaskRef[];
  /** Дни, о которых ответ на вопрос (ГГГГ-ММ-ДД) — ссылки на дневник. */
  days?: string[];
  /** Спорное — спросить кнопками: завести ли привычки / задачи из рассказа. */
  proposal?: Proposal;
  /** Разобрать не вышло (модель не ответила): кнопки «Повторить» и «Оставить заметкой»; сервер и сам повторит (retryFailed). */
  failed?: boolean;
  /** План лёг на занятое время — кнопки «Сдвинуть на …» (если есть куда) и «Оставить» (clash.ts). */
  clash?: Clash;
  /** Нарисованная по просьбе картинка (draw.ts): показать в облачке и в переписке; id — для GET /api/drawings/:id. */
  drawing?: { id: number; mime: string; data: string; title: string };
  /** ИИ не звали (access.ts): access — нет пробы или подписки (кнопка оплаты), rate — слишком часто, money — дневной потолок.
   *  Текст сообщения при этом записан заметкой (undoable), само сообщение — done: фоновый повтор его не возьмёт. */
  blocked?: Refusal;
  /** Ответ на «какая погода?» с прогнозом: погода дня (kind) и небо сейчас (sky) — виджет играет по ним сцену погоды (weather.js
   *  wxFx). Старые виджеты поле не знают и просто показывают текст. danger — какая опасная погода у kind storm (метель, гроза,
   *  гололёд, сильный ветер): по ней виджет выбирает сцену, снег вбок — только в метель. */
  weather?: { kind: string; sky: string; danger?: string };
}

/** Итог поправки к ответу (POST /api/correct, correct.ts). */
export interface CorrectReply {
  text: string;
  emotion: Emotion;
  /** Исходное сообщение: его «↩ Отменить» откатывает ответ вместе с поправками. */
  messageId: number;
  undoable: boolean;
  /** Карточки ответа после поправки — из базы, в порядке записи, у каждой ref (и память, и баф профиля). Карточки без
   *  ref (отметки привычек, строки правок «✎/✔», возвращённый снятый баф) сюда не входят — они остаются как были в ответе;
   *  карточки с ref, которой здесь нет, — записи уже нет. */
  changes: Change[];
  /** Какие записи поменялись этой поправкой: «таблица:id» (как ref). */
  changed: string[];
  /** Горничная переспрашивает (неясно или значения нет, «51 — такого часа нет») — ничего не записано. */
  clarify?: boolean;
  /** Поправленный план лёг на занятое время — те же кнопки, что у ответа (POST /api/clash с messageId исходного сообщения). */
  clash?: Clash;
  duplicate?: boolean;
  /** Поправку не делали: ИИ закрыт (access.ts) — как у Reply. */
  blocked?: Refusal;
}
/** Что поправка помнит о себе (parse_json её служебного сообщения) — для повтора доставки. asked — что ушло модели
 *  (поправка вместе с прошлыми «(уточнение: …)»), если она переспросила: следующая поправка — ответ на вопрос. */
interface CorrectSaved { changed: string[]; clarify: boolean; emotion: Emotion; clash?: Clash; clashDone?: ClashPair; asked?: string }
const CORRECT_SOURCE = "correct:";
const CORRECT_TEXT = "✎ Поправка: ";
/** Пара вопроса «Сдвинуть?»: план eventId лёг на withId. По ней decideClash узнаёт, чей вопрос и какую строку ⚠ менять:
 *  у ответа — clash в его parse_json (handle), у поправки — clash, а после ответа кнопкой — clashDone (CorrectSaved). */
type ClashPair = Pick<Clash, "eventId" | "withId">;
const pairOf = (c: ClashPair): ClashPair => ({ eventId: c.eventId, withId: c.withId });
const samePair = (c: unknown, eventId: number, withId: number) => {
  const x = c as Partial<ClashPair> | null | undefined;
  return x?.eventId === eventId && x.withId === withId;
};
/** parse_json сообщения объектом; нет или не JSON — пустой. */
function jsonOf(t: string | null | undefined): Record<string, unknown> {
  try {
    const o = JSON.parse(t ?? "{}");
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}
/** Итог поправки из её служебного сообщения; без итога — пустой. */
function savedOf(m: Message): CorrectSaved {
  const o: CorrectSaved = { changed: [], clarify: false, emotion: "neutral" };
  try { return { ...o, ...JSON.parse(m.parse_json ?? "{}") }; } catch { return o; }
}
/** Ответ сообщения-уточнения: записи лежат у исходного сообщения. */
const CLARIFIED = "(уточнение)";

export type ClashChoice = "shift" | "keep";

/** Потолки списков в запросе к модели: данные растут, а запрос — нет. Берётся ближайшее и упомянутое в сообщении. */
export const PROMPT_CAP = { events: 120, tasks: 80, dates: 50, memory: 100, notes: 80 };
/** Длина ответа на вопрос по записям: с запасом — у модели с «обдумыванием» 800 кончались посреди фразы (18.11.2026). */
export const ANSWER_MAX_TOKENS = 1500;

/** Слова сообщения (от 4 букв) — чтобы упомянутое попало в запрос, даже если оно старое или далёкое. */
const wordsOf = (text: string) => new Set((text.toLowerCase().match(/[\p{L}\d]{4,}/gu) ?? []).map((w) => w.slice(0, 6)));
const mentions = (words: Set<string>, s: string) => (s.toLowerCase().match(/[\p{L}\d]{4,}/gu) ?? []).some((w) => words.has(w.slice(0, 6)));
/** Первые n, но упомянутые в сообщении — вперёд очереди (порядок внутри сохраняется). */
function capped<T>(list: T[], n: number, words: Set<string>, textOf: (x: T) => string): T[] {
  if (list.length <= n) return list;
  const hit = list.filter((x) => mentions(words, textOf(x)));
  const rest = list.filter((x) => !hit.includes(x));
  const keep = new Set([...hit, ...rest].slice(0, n));
  return list.filter((x) => keep.has(x));
}

/** Списки для запроса разбора: события на 46 дней, открытые задачи, ближайшие даты, память — каждый не длиннее PROMPT_CAP. */
export async function promptLists(s: Store, userId: number, today: string, text: string) {
  const words = wordsOf(text);
  const dates = upcomingDates(await s.activeDates(userId), today, 400).map((d) => d.row);
  // Память: сначала свежее (больший id), упомянутое — в любом случае.
  const memory = capped([...(await s.activeMemory(userId))].reverse(), PROMPT_CAP.memory, words, (m) => `${m.subject} ${m.text}`).reverse();
  return {
    events: capped(await s.eventsBetween(userId, addDays(today, -1), addDays(today, 45)), PROMPT_CAP.events, words, (e) => e.title),
    trash: await s.eventsClosedSince(userId, addDays(today, -1), new Date(Date.now() - TRASH_DAYS * 86_400_000).toISOString()),
    tasks: capped(await s.openTasks(userId), PROMPT_CAP.tasks, words, (t) => t.title),
    // Заметки «на потом», что лежат на полках: свежие и упомянутые.
    notes: capped((await s.notesOf(userId)).filter((n) => n.status === "open"), PROMPT_CAP.notes, words, (n) => n.title),
    dates: capped(dates, PROMPT_CAP.dates, words, (d) => `${d.title} ${d.person ?? ""}`),
    memory,
  };
}

/** Сколько дней отменённый или удалённый план виден разбору в «Корзине» (можно вернуть словами). */
export const TRASH_DAYS = 14;

/** Через сколько минут после сообщения повторять неудавшийся разбор; после последней попытки — заметкой. */
export const RETRY_AFTER_MIN = [2, 10, 30];
/** Как вести разговор (/ask и сообщения, где с горничной разговаривают, — talk в разборе): текст «как в коде» промпта chat.rules
 *  (prompts.ts, правится в админке → «Промпты»); в разговоре — prompt("chat.rules"). */
export { TALK_RULES } from "./prompts.ts";

/** Признак неудачи разговора (/ask) в reply — такие не повторяются разбором. После него — код сбоя (llmErrorCode), не текст ошибки. */
export const CHAT_FAILED = "chat:";

/** Вопрос «добавить?» с пунктами-галочками. Кнопки: remind (если есть) — завести с напоминанием, add — просто в список, «Не надо». */
export interface Proposal {
  id: number;
  items: { kind: "habit" | "task"; title: string; detail: string }[];
  /** Отмеченные номера пунктов (по умолчанию все). */
  picked: number[];
  /** Ситуативная кнопка: «Напоминать перед сном» и её время. */
  remind: { label: string; time: string } | null;
  /** Текст кнопки «добавить»: «Добавить в привычки», «Добавить в задачи» или «Добавить». */
  add: string;
  status: ProposalRow["status"];
}
type ProposalItem = { kind: "habit"; habit: Parsed["habits"][number] } | { kind: "task"; task: Parsed["tasks"][number] };
export type ProposalChoice = "remind" | "add" | "decline";
/** Сколько ждать ответа: дальше вопрос закрывается сам и ничего не создаёт. */
export const PROPOSAL_TTL_MS = 24 * 60 * 60_000;

const itemsOf = (p: ProposalRow): ProposalItem[] => JSON.parse(p.items) as ProposalItem[];
const pickedOf = (p: ProposalRow): number[] => {
  const all = itemsOf(p).map((_, i) => i);
  try {
    const v = JSON.parse(p.picked) as number[];
    return Array.isArray(v) ? v.filter((i) => all.includes(i)) : all;
  } catch {
    return all;
  }
};
const kindsOf = (items: { kind: string }[]) => ({ habits: items.some((i) => i.kind === "habit"), tasks: items.some((i) => i.kind === "task") });

export function proposalView(p: ProposalRow): Proposal {
  const items = itemsOf(p).map((it) =>
    it.kind === "habit"
      ? {
          kind: "habit" as const, title: it.habit.title,
          detail: `${scheduleText({ days: it.habit.days, start_date: it.habit.start, end_date: it.habit.end })}${it.habit.times.length ? " · " + it.habit.times.join(", ") : ""}`,
        }
      : { kind: "task" as const, title: it.task.title, detail: it.task.due ? `до ${humanDay(it.task.due)}` : "" },
  );
  const k = kindsOf(items);
  return {
    id: p.id, items, picked: pickedOf(p), remind: p.remind ? JSON.parse(p.remind) : null, status: p.status,
    add: k.habits && k.tasks ? "Добавить" : k.tasks ? "Добавить в задачи" : "Добавить в привычки",
  };
}

export interface Incoming {
  user: User;
  source: string; // telegram | desktop | web | api
  sourceId: string;
  text: string;
  at?: Date;
  /** Только поговорить (/ask): ничего не записывать. */
  chatOnly?: boolean;
  /** Картинки (чеки, билеты, скриншоты); text тогда — подпись к ним, может быть пустой. */
  images?: Picture[];
  /** Клиент для счётчиков фич (feature-events.ts): ставят только api.ts и bot.ts — фоновый повтор и импорт не считаются. */
  client?: string;
  /** Фоновый повтор разбора (retryFailed): без проверки частоты (access.ts AiGate). */
  background?: boolean;
  /** Частоту уже отметили до этого (голосовое: перед распознаванием, bot.ts и api.ts) — второй раз не считать. */
  gated?: boolean;
}

/** Ветка разбора → фича (feature-list.ts); упавший разбор и уточнение — не фичи. */
const ROUTE_FEATURES: Record<string, string> = { weather: "weather_ask", chat: "chat", draw: "draw", answer: "answer", talk: "talk", apply: "record" };

/** Что модели сказать о картинке — рядом с подписью (prompts.ts parse.picture.one / parse.picture.many). */
const pictureNote = (n: number) => (n > 1 ? prompt("parse.picture.many", { n: String(n) }) : prompt("parse.picture.one"));

/** Как сообщение с картинками выглядит в истории и в базе. */
export const pictureText = (caption: string, n = 1) => {
  const mark = n > 1 ? `📷×${n}` : "📷";
  return caption.trim() ? `${mark} ${caption.trim()}` : n > 1 ? `${mark} Фото` : "📷 Фото";
};

/** Сколько логических вызовов модели ушло на сообщение (messages.llm_calls) и по какой ветке оно прошло (messages.route).
 *  Повторы и запасная модель внутри callLlm — один вызов; попытки по отдельности — в журнале llm_calls (llm.ts). */
interface MsgCalls { id: number; calls: number; route: string; missed?: boolean }
/** Ветка не удалась (модель или художник не ответили) — в счётчики фич она не идёт (handle). */
const missBranch = () => { const c = msgCalls.getStore(); if (c) c.missed = true; };
const msgCalls = new AsyncLocalStorage<MsgCalls>();

export class Pipeline {
  private llm: LlmCall;
  /** publicUrl — адрес веб-приложения для ссылок на дни в ответах (пусто — без ссылок). */
  constructor(private store: Store, llm: LlmCall, private publicUrl = "") {
    this.llm = (m, o) => {
      const c = msgCalls.getStore();
      if (c) c.calls++;
      return llm(m, o);
    };
  }
  /** Обработать сообщение со счётчиком вызовов модели; итог — в messages (c.id ставит обработчик, когда сообщение известно). */
  private async counted<T>(fn: (c: MsgCalls) => Promise<T>): Promise<T> {
    const c: MsgCalls = { id: 0, calls: 0, route: "" };
    try {
      return await msgCalls.run(c, () => fn(c));
    } finally {
      // Без ожидания: учёт ответу не мешает и его не задерживает.
      if (c.id && (c.calls || c.route)) void this.store.addMessageCalls(c.id, c.calls, c.route).catch((e) => console.error("[llm calls]", e));
    }
  }

  /** Рисовалка картинок (draw.ts); null — ключа RunPod нет, горничная честно говорит, что не рисует. */
  draw: DrawCall | null = null;
  /** Платный доступ (access.ts): перед каждым вызовом модели по сообщению — доступ, частота, дневной потолок. null — без проверки
   *  (тесты конвейера); index.ts ставит его всегда. */
  gate: AiGate | null = null;
  /** Зовётся, когда у пользователя что-то поменялось (записали, отметили, отменили) — например, чтобы обновить список-виджет. */
  onChange: ((u: User) => void) | null = null;
  /** Вопрос «добавить?» закрыт (ответили, отказались, истёк) — убрать кнопки там, где он висит (Telegram).
   *  text — новый текст ответа целиком, outcome — строка итога. */
  onProposal: ((u: User, p: ProposalRow, text: string, outcome: string) => Promise<void>) | null = null;
  /** Человек назвал о себе город или подъём — спросить отдельным сообщением «Записать в профиль?» с кнопками (index.ts → send). */
  onAbout: ((u: User, text: string, buttons: YouButton[]) => Promise<void>) | null = null;
  /** Поиск города для «Записать в профиль?» (you.ts findCities; тесты подставляют свой). */
  cities: (q: string) => Promise<City[]> = findCities;
  /** Через сколько после ответа спросить «Записать в профиль?» (ответ должен успеть уйти первым); тесты ставят 0. */
  aboutDelayMs = 1500;
  /** Последнее отложенное «Записать в профиль?» — тесты ждут его. */
  aboutJob: Promise<void> | null = null;
  changed(u: User) {
    try { this.onChange?.(u); } catch (e) { console.error("[pipeline] onChange", e); }
  }

  /** Запросы, которые сейчас в работе, по ключу (человек, источник, id). Повтор доставки, пришедший, пока первый ещё идёт (виджет
   *  не дождался ответа, Telegram прислал обновление ещё раз), не берёт второй раз лимит и не зовёт модель: ждёт первый и
   *  получает его итог (again: true). Только в памяти процесса — сервер один. */
  private running = new Map<string, Promise<unknown>>();
  /** Сколько разборов и поправок сейчас в работе — очередь для «Здоровья сервера» (server-metrics.ts). */
  get inWork() {
    return this.running.size;
  }
  async inFlight<T>(key: string, fn: () => Promise<T>): Promise<{ value: T; again: boolean }> {
    const busy = this.running.get(key);
    if (busy) return { value: (await busy) as T, again: true };
    const job = fn();
    this.running.set(key, job);
    noteQueue(this.running.size);
    try {
      return { value: await job, again: false };
    } finally {
      this.running.delete(key);
    }
  }
  /** Уже разобранное сообщение с этим id (повтор доставки): прежний ответ — до списания лимита и до платного распознавания
   *  голоса (api.ts, bot.ts). heard — текст сообщения (что услышали). Нет или ещё не готово — null. */
  async delivered(u: User, source: string, sourceId: string): Promise<(Reply & { heard: string }) | null> {
    const m = await this.store.messageBySource(u.id, source, sourceId);
    if (!m || m.state !== "done") return null;
    return { text: m.reply ?? persona(u.persona, u).saved[0], emotion: "neutral", messageId: m.id, undoable: false, duplicate: true, heard: m.text };
  }

  async handle(inc: Incoming): Promise<Reply> {
    const { value, again } = await this.inFlight(`msg:${inc.user.id}:${inc.source}:${inc.sourceId}`, () => this.handleNew(inc));
    return again ? { ...value, duplicate: true } : value;
  }
  private async handleNew(inc: Incoming): Promise<Reply> {
    let route = "";
    const r = await this.counted(async (c) => {
      try { return await this.handleOne(inc, c); } finally { route = c.missed ? "" : c.route; }
    });
    if (!r.duplicate && (r.undoable || r.changes?.length)) this.changed(inc.user);
    // Счётчики фич: ветка, что записано (по виду карточки, раз на сообщение), картинка. Повтор доставки и упавшая ветка — не в счёт.
    if (inc.client && !r.duplicate) {
      const use = (f: string) => countFeature(inc.user, inc.client!, f, 1, inc.at);
      if (ROUTE_FEATURES[route]) use(ROUTE_FEATURES[route]);
      for (const k of new Set((r.changes ?? []).map((x) => x.kind))) use(`rec.${k}`);
      if (inc.images?.length) use("photo");
    }
    return r;
  }

  private async handleOne(inc: Incoming, c: MsgCalls): Promise<Reply> {
    const s = this.store;
    const at = inc.at ?? new Date();
    const u = inc.user;
    const today = dayKey(at, u.tz);
    const p = persona(u.persona, u);
    const pending = inc.chatOnly ? undefined : await s.pendingClarify(u.id);
    const pics = inc.images?.length ? inc.images : undefined;
    const { message, created } = await s.saveMessage({
      userId: u.id, source: inc.source, sourceId: inc.sourceId, text: pics ? pictureText(inc.text, pics.length) : inc.text, dayKey: today,
      replyTo: pics ? undefined : pending?.id, at,
    });
    if (!created && message.state === "done") {
      return { text: message.reply ?? p.saved[0], emotion: "neutral", messageId: message.id, undoable: false, duplicate: true };
    }
    c.id = message.id;
    // Запрос к ИИ, взятый за это обращение (access.ts): модель не ответила — возвращается, а сообщение помечается «запрос
    // не взят» (owe:<id>), чтобы фоновый повтор взял его сам. failed-сообщение поэтому никогда не держит взятый запрос.
    let taken: Taken | undefined;
    const giveBack = async () => {
      if (!taken || !this.gate) return;
      await this.gate.refund(u, taken);
      taken = undefined;
      await s.kvSet(`owe:${message.id}`, "1");
    };
    // Новое сообщение — прежний вопрос «добавить?» без ответа закрывается (кнопки висят до следующего сообщения).
    await this.closeProposals(u, "expired");

    // «Какая погода?» — погода дня по городу из «О вас» (weather.ts), без модели и без записи.
    if (!pics && WEATHER_ASK.test(inc.text)) {
      c.route = "weather";
      const wx = await weatherFor(s, u, at).catch(() => null);
      const text = wx ? `${wx.icon} ${wx.text}`
        : cityOf(u) ? "Не получилось узнать погоду — сервис не отвечает. Спросите чуть позже."
        : "Скажите, из какого вы города, — тогда буду знать погоду. Город — в «Персонализации → О вас».";
      await s.setMessage(message.id, { state: "done", reply: text });
      return { text, emotion: (wx?.emotion ?? "neutral") as Emotion, messageId: message.id, undoable: false, ...(wx ? { weather: { kind: wx.kind, sky: wx.sky, ...(wx.danger ? { danger: wx.danger } : {}) } } : {}) };
    }

    // Платный доступ (access.ts): дальше — только модель. Нельзя — сообщение заметкой, без единого вызова модели.
    if (this.gate) {
      // Лимит в штуках (access.ts): обращение человека — один запрос к ИИ; голосовое (gated) уже взяло свой запрос вместе с
      // секундами до распознавания. Фоновый повтор — не в счёт, если запрос уже взят (упало голосовое); не взят (отказ по частоте —
      // reply «rate», или запрос вернули после сбоя модели — owe) — фон берёт его сам, упор — заметкой (blocked), как у человека.
      const human = !inc.background && !inc.gated;
      const owed = Boolean(inc.background && !inc.gated && (message.reply === "rate" || (await s.kvGet(`owe:${message.id}`))));
      const v = await this.gate.check(u, { rate: human, client: inc.background ? undefined : inc.client, take: human || owed ? { calls: 1 } : undefined });
      if (v.ok) {
        taken = v.taken;
        if (owed) await s.kvDel(`owe:${message.id}`);
      }
      if (!v.ok) {
        c.route = "blocked";
        if (v.why === "rate") return this.tooFast(u, message, v.text, Boolean(inc.chatOnly || pics));
        return this.blocked(u, message, v, at, !inc.chatOnly && (!pics || Boolean(inc.text.trim())));
      }
    }

    if (inc.chatOnly) {
      c.route = "chat";
      return this.chat(u, message, at, pics, giveBack);
    }
    // Разбор не дошёл до ветки (упал) — останется «parse».
    c.route = "parse";

    // Ответ на уточнение: разбираем исходное сообщение вместе с ответом. Картинка уточнением не считается.
    const original = pending && !pics ? await s.message(pending.id) : undefined;
    const text = original
      ? `${original.text}\n(уточнение: ${inc.text})`
      : pics ? `${inc.text.trim()}\n${pictureNote(pics.length)}`.trim() : inc.text;
    const ctx = {
      today,
      now: timeOf(at, u.tz),
      tz: u.tz,
      ...(await promptLists(s, u.id, today, text)),
      habits: await s.activeHabits(u.id),
      traits: traitPrompt(await s.traitsOf(u.id)),
      recent: [],
      clarifying: original ? { original: original.text, question: original.reply ?? "" } : undefined,
    };

    let parsed: Parsed;
    try {
      const ask = [
        { role: "system" as const, content: buildPrompt(ctx, p.voice) },
        ...(await this.history(u.id, message.id)),
        { role: "user" as const, content: text, images: pics },
      ];
      let raw = await this.llm(ask, { json: true, kind: "parse" });
      let json: unknown;
      try {
        json = extractJson(raw);
      } catch {
        // Модель иногда отвечает словами вместо JSON — один раз переспрашиваем, только потом это сбой.
        console.warn("[parse] без JSON, переспрашиваю:", raw.slice(0, 200));
        raw = await this.llm([...ask, { role: "assistant", content: raw }, { role: "user", content: prompt("common.json_retry") }], { json: true, kind: "parse" });
        json = extractJson(raw);
      }
      parsed = normalize(json, { today, now: ctx.now, text: inc.text });
    } catch (e) {
      // В базу — только код сбоя (llmErrorCode): тело ответа провайдера остаётся в журнале сервера.
      await s.setMessage(message.id, { state: "failed", reply: llmErrorCode(e) });
      await giveBack();
      console.error("[parse]", e);
      return { text: p.failed, emotion: "worried", messageId: message.id, undoable: false, failed: true };
    }
    if (parsed.dropped.length) console.warn("[parse] отброшено:", parsed.dropped.join("; "));
    await s.setMessage(message.id, { parse_json: JSON.stringify(parsed) });

    // Уточнение — один вопрос, черновик ждёт. Повторно не спрашиваем: второй раз пишем как есть.
    // У картинки не спрашиваем: на ответ её уже не будет — пишем, что разобрали.
    if (parsed.clarify && !original && !pics) {
      const q = `${p.clarify} ${parsed.clarify}`;
      c.route = "clarify";
      await s.setMessage(message.id, { state: "clarify", reply: q });
      return { text: q, emotion: "neutral", messageId: message.id, undoable: false };
    }

    // Просьба нарисовать — рисуем, ничего не записываем.
    if (parsed.draw) {
      c.route = "draw";
      return this.drawFor(u, message, parsed, inc.background ? undefined : inc.client);
    }

    // Вопрос про саму картинку («что это?») — отвечаем по ней, а не по записям.
    if (parsed.question && pics) {
      c.route = "chat";
      return this.chat(u, message, at, pics, giveBack);
    }

    if (parsed.question) {
      c.route = "answer";
      const { text: answer, days } = await this.answer(u, parsed, inc.text, today);
      await s.setMessage(message.id, { state: "done", reply: answer });
      if (original) await s.setMessage(original.id, { state: "done" });
      return { text: answer, emotion: parsed.emotion, messageId: message.id, undoable: false, days };
    }

    const target = original ?? message;
    c.route = parsed.talk ? "talk" : "apply";
    const { lines, changes, touched, edited } = await s.transaction(() => this.apply(u, target, parsed, at));
    if (original) await s.setMessage(message.id, { state: "done", reply: CLARIFIED });

    // С горничной разговаривают — ответ разговором (как /ask), записанное — строками под ним; не вышло — короткая реплика.
    // Разговор знает, что из сообщения уже записано, — иначе отвечал «записывать не стану», а запись была.
    const talk = parsed.talk
      ? await this.talkText(u, message, at, undefined, lines.map((l) => l.replace(/<[^>]+>/g, ""))).catch((e) => { console.error("[talk]", e); missBranch(); })
      : undefined;
    const head = talk || (parsed.reply ? esc(parsed.reply) : pick(p.saved, message.id));
    const body = lines.length ? "\n" + lines.join("\n") : "";
    // Спорное (распорядок, «надо бы когда-нибудь») не записано — спросить кнопками.
    const sug = parsed.suggest;
    const items: ProposalItem[] = [
      ...sug.habits.map((habit) => ({ kind: "habit" as const, habit })),
      ...sug.tasks.map((task) => ({ kind: "task" as const, task })),
    ];
    let ask = "";
    if (items.length) {
      const k = kindsOf(items);
      ask = k.habits && k.tasks ? "Добавить себе?" : k.tasks ? (items.length > 1 ? "Добавить в задачи?" : "Добавить в задачу?")
        : items.length > 1 ? "Хочешь отслеживать как привычки?" : "Хочешь отслеживать как привычку?";
    }
    // План лёг на занятое время — спросить «Сдвинуть?» (не вместе с вопросом «добавить?»: два вопроса сразу путают).
    const clash = !ask && touched.length ? (await findClash(s, u.id, touched)) ?? undefined : undefined;
    const reply = `${head}${body}${ask ? "\n" + ask : ""}${clash ? "\n" + clashLine(clash, esc) : ""}`;
    let proposal: Proposal | undefined;
    if (ask) {
      const id = await s.addProposal({
        user_id: u.id, message_id: target.id, text: reply, ask, items: JSON.stringify(items),
        picked: JSON.stringify(items.map((_, i) => i)), remind: sug.remind ? JSON.stringify(sug.remind) : "",
      });
      proposal = proposalView((await s.proposal(id))!);
    }
    // Пара вопроса «Сдвинуть?» — в parse_json ответа, рядом с разбором: decideClash узнаёт строку ⚠ по паре планов, а не по
    // названию (план могли переименовать, пока висят кнопки), и отличает её от вопроса поправки к этому ответу.
    const base = original ? jsonOf(original.parse_json) : parsed;
    await s.setMessage(target.id, { state: "done", reply, ...(clash ? { parse_json: JSON.stringify({ ...base, clash: pairOf(clash) }) } : {}) });
    // Сказал о себе город или подъём — «Записать в профиль?» отдельным сообщением с кнопками, после ответа: ответ не ждёт
    // геокодер, а вопрос приходит вслед за ним (aboutDelayMs). Не вышло (нет сети) — молча.
    if (parsed.about && this.onAbout) {
      const onAbout = this.onAbout, about = parsed.about, cities = this.cities;
      this.aboutJob = new Promise<void>((done) => setTimeout(() => {
        aboutOffer(s, u, about, cities)
          .then((o) => (o ? onAbout(u, o.text, o.buttons) : undefined))
          .catch((e) => console.error("[about]", e))
          .finally(done);
      }, this.aboutDelayMs));
    }
    // Ссылки на задачи, что уже есть: названные в ответе (из списка, что видела модель) и поправленные словами (переименована,
    // новый срок, снова открыта). Только те, что после записи ещё открыты, — и не только что записанные (у них карточка).
    // Номера других таблиц из того же запроса: «#7» у плана — не задача #7 (taskRefsIn).
    const otherIds = [...ctx.events, ...ctx.dates, ...ctx.habits, ...ctx.memory, ...(ctx.notes ?? []), ...(ctx.trash ?? [])].map((x) => x.id);
    const refs = await this.taskRefs(u.id, [...edited, ...taskRefsIn(head, ctx.tasks, otherIds)], changes);
    return { text: reply, emotion: parsed.emotion, messageId: target.id, undoable: lines.length > 0, changes, ...(refs.length ? { refs } : {}), proposal, clash };
  }

  /** Открытые задачи человека по id (порядок сохраняется, повторы и записанные этим ответом — мимо), не больше REFS_MAX. */
  private async taskRefs(userId: number, ids: number[], changes: Change[]): Promise<TaskRef[]> {
    const fresh = new Set(changes.filter((c) => c.ref?.tbl === "tasks").map((c) => c.ref!.id));
    const out: TaskRef[] = [];
    for (const id of [...new Set(ids)]) {
      if (out.length >= REFS_MAX) break;
      if (fresh.has(id)) continue;
      const t = await this.store.task(id);
      if (t && t.user_id === userId && t.status === "open") out.push({ tbl: "tasks", id: t.id, title: t.title });
    }
    return out;
  }

  /** «Нарисуй …»: картинка от RunPod сохраняется (drawings) и уходит в ответ. Без ключа или при сбое — сказать словами. */
  private async drawFor(u: User, message: Message, parsed: Parsed, client?: string): Promise<Reply> {
    const s = this.store;
    const d = parsed.draw!;
    const done = async (text: string, emotion: Emotion, drawing?: Reply["drawing"]): Promise<Reply> => {
      await s.setMessage(message.id, { state: "done", reply: text });
      return { text, emotion, messageId: message.id, undoable: false, drawing };
    };
    if (!this.draw) return done("Рисовать я пока не умею: на сервере не задан ключ RunPod (RUNPOD_API_KEY) или OpenRouter (OPENROUTER_API_KEY).", "awkward");
    let pic: Picture;
    // Рисунок — тоже вызов модели у сообщения (самый дорогой): в «Дорогих сообщениях» и «По веткам» он виден.
    // Рисунок дороже разбора: ещё раз сверить денежные потолки (частоту не считать — это то же сообщение).
    // Лимит картинок в день (access.ts): сам запрос сообщения уже взят в разборе — здесь только рисунок.
    const v = this.gate ? await this.gate.check(u, { rate: false, client, take: { draws: 1 } }) : null;
    if (v && !v.ok) return done(v.text, "worried");
    const c = msgCalls.getStore();
    if (c) c.calls++;
    try {
      pic = await this.draw(d.prompt);
    } catch (e) {
      // Человек ничего не получил — картинка возвращается (как у голоса при сбое распознавания).
      if (v?.ok) await this.gate?.refund(u, v.taken);
      console.error("[draw]", e);
      missBranch();
      return done(`Не вышло нарисовать${d.title ? ` «${esc(d.title)}»` : ""} — художник не ответил. Попробуйте ещё раз чуть позже.`, "worried");
    }
    const id = await s.addDrawing({ user_id: u.id, message_id: message.id, prompt: d.prompt, title: d.title, mime: pic.mime, data: pic.data });
    const text = parsed.reply ? esc(parsed.reply) : d.title ? `Готово: ${esc(d.title)}.` : "Готово, вот картинка.";
    return done(text, parsed.emotion === "neutral" ? "proud" : parsed.emotion, { id, mime: pic.mime, data: pic.data, title: d.title });
  }

  /** Ответ на «Сдвинуть на …?»: shift — перенести план после занятого, keep — оставить оба и больше про эту пару не спрашивать.
   *  reply — ответ сообщения с итогом вместо строки вопроса (для Telegram), null — строки вопроса там нет или вопрос не его
   *  (задала поправка к ответу: итог тогда — у её служебного сообщения). */
  async decideClash(u: User, messageId: number, eventId: number, withId: number, choice: ClashChoice): Promise<{ text: string; reply: string | null }> {
    const s = this.store;
    const [e, other, msg] = [await s.event(eventId), await s.event(withId), await s.message(messageId)];
    if (!e || !other || !msg || e.user_id !== u.id || other.user_id !== u.id || msg.user_id !== u.id) return { text: "Не нашла эти планы.", reply: null };
    let text: string;
    if (choice === "keep" || e.status !== "active") {
      await keepPair(s, u.id, e.id, other.id);
      text = e.status === "active" ? "Хорошо, оставила оба." : "Этого плана уже нет в списке.";
    } else {
      const day = await s.eventsBetween(u.id, e.date_iso, e.date_iso);
      const to = shiftTime(e, day);
      if (!to) text = day.some((b) => b.id !== e.id && overlaps(e, b)) ? "Сдвинуть некуда: до конца дня всё занято." : "Уже ни на что не ложится.";
      else {
        await s.transaction(async () => {
          await s.logAction(u.id, messageId, "update", "events", e.id, { time: e.time, end_time: e.end_time });
          await s.updateEvent(e.id, { time: to.time, end_time: to.end });
          await s.cancelReminders("event", e.id);
          await planEventReminders(s, u, (await s.event(e.id))!, new Date());
        });
        text = `Сдвинула «${esc(e.title)}» на ${to.time}${to.end ? "–" + to.end : ""}.`;
        this.changed(u);
      }
    }
    // Чей вопрос — по паре планов, а не по названию (план могли переименовать, пока висят кнопки). Вопрос мог задать и ответ,
    // и поправка к нему (её служебное сообщение: reply_to — этот ответ, кнопки — с messageId ответа), и оба — про одну пару:
    // тогда итог встаёт вместо обеих строк. У поправки clash уходит в clashDone — повтор поправки кнопок не вернёт, а
    // повторная кнопка строку ответа не тронет. Журнал сдвига — всё равно под ответом: одна «↩ Отменить» откатывает всё.
    let byFix = false;
    for (const m of await s.repliesTo(u.id, msg.id)) {
      if (!m.source_id.startsWith(CORRECT_SOURCE)) continue;
      const { clash, ...rest } = savedOf(m);
      if (samePair(rest.clashDone, eventId, withId)) byFix = true;
      if (!clash || !samePair(clash, eventId, withId)) continue;
      byFix = true;
      await s.setMessage(m.id, { reply: (m.reply ?? "").replace(clashLine(clash, esc), text), parse_json: JSON.stringify({ ...rest, clashDone: pairOf(clash) }) });
    }
    // Строка ⚠ ответа (она у него одна) — если пара его; у ответа без пары (записан до поправок) — если пару не спрашивала поправка.
    const own = jsonOf(msg.parse_json).clash;
    const mine = own ? samePair(own, eventId, withId) : !byFix;
    const line = mine ? (msg.reply ?? "").split("\n").find((l) => l.startsWith("⚠ ")) : undefined;
    const reply = line ? msg.reply!.replace(line, text) : null;
    if (reply) await s.setMessage(messageId, { reply });
    return { text, reply };
  }

  /** Отметить / снять пункт вопроса (галочки в Telegram). */
  async toggleProposal(u: User, id: number, index: number): Promise<Proposal | null> {
    const p = await this.store.proposal(id);
    if (!p || p.user_id !== u.id || p.status !== "open" || !itemsOf(p)[index]) return null;
    const picked = pickedOf(p);
    const next = picked.includes(index) ? picked.filter((i) => i !== index) : [...picked, index].sort((a, b) => a - b);
    await this.store.updateProposal(id, { picked: JSON.stringify(next) });
    return proposalView({ ...p, picked: JSON.stringify(next) });
  }

  /** Ответ на вопрос «добавить?». picked — отмеченные (из приложения); без него — сохранённые. */
  async decideProposal(u: User, id: number, choice: ProposalChoice, picked?: number[]): Promise<{ text: string; changes: Change[]; proposal: Proposal | null; done: boolean }> {
    const s = this.store;
    const p = await s.proposal(id);
    if (!p || p.user_id !== u.id) return { text: "Не нашла этот вопрос.", changes: [], proposal: null, done: false };
    if (p.status !== "open") {
      const said = p.status === "accepted" ? "Уже добавила." : p.status === "declined" ? "Уже решили: не добавляю." : "Этот вопрос уже закрыт.";
      return { text: said, changes: [], proposal: proposalView(p), done: false };
    }
    const items = itemsOf(p);
    const chosen = (picked ?? pickedOf(p)).filter((i, k, a) => items[i] && a.indexOf(i) === k);
    if (choice !== "decline" && !chosen.length) return { text: "Отметь хотя бы одно.", changes: [], proposal: proposalView(p), done: false };
    if (choice === "decline") {
      await this.close(u, p, "declined", "Хорошо, не добавляю.");
      return { text: "Хорошо, не добавляю.", changes: [], proposal: proposalView({ ...p, status: "declined" }), done: true };
    }
    const remind: Proposal["remind"] = choice === "remind" && p.remind ? JSON.parse(p.remind) : null;
    const changes: Change[] = [];
    const habits: string[] = [];
    const tasks: string[] = [];
    await s.transaction(async () => {
      for (const i of chosen) {
        const it = items[i];
        if (it.kind === "habit") {
          const h = it.habit;
          // «Добавить в привычки» — только в список: без напоминаний и вечерних вопросов.
          const times = remind ? [remind.time] : [];
          const row = { title: h.title, days: h.days, times: JSON.stringify(times), start_date: h.start, end_date: h.end, quiet: remind ? 0 : 1 };
          const hid = await s.addHabit({ user_id: u.id, ...row, message_id: p.message_id });
          await s.logAction(u.id, p.message_id, "add", "habits", hid);
          habits.push(h.title);
          changes.push(habitCard({ id: hid, ...row }));
        } else {
          const t = it.task;
          const tid = await s.addTask({ user_id: u.id, title: t.title, priority: t.priority, category: t.category, due_date: t.due, notes: "", message_id: p.message_id });
          await s.logAction(u.id, p.message_id, "add", "tasks", tid);
          tasks.push(t.title);
          changes.push(taskCard({ id: tid, title: t.title, due_date: t.due }));
        }
      }
    });
    const out = [
      habits.length ? `✅ В привычках: ${habits.map(esc).join(", ")}${remind ? ` · напомню в ${remind.time}` : ""}` : "",
      tasks.length ? `✅ В задачах: ${tasks.map(esc).join(", ")}` : "",
    ].filter(Boolean).join("\n");
    await this.close(u, p, "accepted", out);
    this.changed(u);
    return { text: out, changes, proposal: proposalView({ ...p, status: "accepted", picked: JSON.stringify(chosen) }), done: true };
  }

  /** Закрыть открытые вопросы пользователя (только по одному сообщению, если указано). */
  private async closeProposals(u: User, status: "expired" | "declined", messageId?: number) {
    for (const p of await this.store.openProposals(u.id)) {
      if (messageId !== undefined && p.message_id !== messageId) continue;
      const k = kindsOf(itemsOf(p));
      const out = status === "declined" ? "Хорошо, не добавляю."
        : k.habits && k.tasks ? "Не стала добавлять." : k.tasks ? "Не стала добавлять в задачи." : "Не стала добавлять в привычки.";
      await this.close(u, p, status, out);
    }
  }
  private async close(u: User, p: ProposalRow, status: ProposalRow["status"], outcome: string) {
    await this.store.updateProposal(p.id, { status });
    const text = p.ask && p.text.includes(p.ask) ? p.text.replace(p.ask, outcome) : `${p.text}\n${outcome}`;
    await this.store.setMessage(p.message_id, { reply: text });
    try {
      await this.onProposal?.(u, { ...p, status }, text, outcome);
    } catch (e) {
      console.error("[pipeline] onProposal", e);
    }
  }

  /** Вопросы без ответа дольше суток — закрыть (зовётся по таймеру). */
  async sweepProposals(now = new Date()) {
    const before = new Date(now.getTime() - PROPOSAL_TTL_MS).toISOString();
    const seen = new Set<number>();
    for (const p of await this.store.openProposals(null, before)) {
      if (seen.has(p.user_id)) continue;
      seen.add(p.user_id);
      const u = await this.store.user(p.user_id);
      if (u) await this.closeProposals(u, "expired");
    }
  }

  private async history(userId: number, beforeId: number) {
    return (await this.store.recentMessages(userId, 7))
      .filter((m) => m.id !== beforeId && m.state !== "failed")
      .slice(-6)
      .flatMap((m) => [
        { role: "user" as const, content: m.text },
        ...(m.reply ? [{ role: "assistant" as const, content: m.reply.replace(/<[^>]+>/g, "") }] : []),
      ]);
  }

  /** Записать разобранное. Вызывать внутри транзакции. */
  /** touched — планы, которые записали или перенесли: их проверяет findClash. */
  private async apply(u: User, msg: Message, r: Parsed, at: Date): Promise<{ lines: string[]; changes: Change[]; touched: number[]; edited: number[] }> {
    const s = this.store;
    const log = (kind: string, tbl: Table, id: number, before?: unknown) => s.logAction(u.id, msg.id, kind, tbl, id, before);
    const sections: Section[] = [];
    const editLines: string[] = [];
    const edited: number[] = []; // задачи, поправленные словами и оставшиеся в списке, — ссылкой под ответом (TaskRef)
    const markLines: string[] = [];
    const changes: Change[] = [];
    const touched: number[] = [];

    for (const d of r.diary) {
      const id = await s.addDiary(u.id, d.dayKey, d.section, d.text, msg.id, d.topic);
      await log("add", "diary", id);
      sections.push(d.section);
      changes.push(diaryCard({ id, section: d.section, topic: d.topic, text: d.text }));
    }
    if (r.summary) await log("add", "diary", await s.addDiary(u.id, r.dayKey, "summary", r.summary, msg.id));
    if (r.tags.length) await log("add", "diary", await s.addDiary(u.id, r.dayKey, "tags", r.tags.join(", "), msg.id));

    for (const e of r.events) {
      const id = await s.addEvent({
        user_id: u.id, title: e.title, date_iso: e.date, time: e.time, end_time: e.endTime, details: e.details,
        domain: "life", message_id: msg.id,
      });
      await log("add", "events", id);
      touched.push(id);
      await planEventReminders(s, u, (await s.event(id))!, at);
      changes.push(eventCard({ id, title: e.title, date_iso: e.date, time: e.time }));
    }
    for (const t of r.tasks) {
      const id = await s.addTask({
        user_id: u.id, title: t.title, priority: t.priority, category: t.category, due_date: t.due, notes: "", message_id: msg.id,
      });
      await log("add", "tasks", id);
      changes.push(taskCard({ id, title: t.title, due_date: t.due }));
    }
    // Заметки «на потом» — на полку; то, что там уже лежит, второй раз не кладём.
    const noteLines: string[] = [];
    if (r.stash.length) {
      const shelved = (await s.notesOf(u.id)).filter((n) => n.status === "open").map((n) => ({ shelf: n.shelf, title: n.title }));
      for (const n of r.stash) {
        if (shelved.some((x) => x.shelf === n.shelf && sameNote(x.title, n.title))) {
          noteLines.push(`📌 уже на полке «${SHELVES[n.shelf]}»: ${esc(n.title)}`);
          continue;
        }
        const id = await s.addNote({ user_id: u.id, shelf: n.shelf, title: n.title, note: n.note, message_id: msg.id });
        await log("add", "notes", id);
        shelved.push(n);
        noteLines.push(`📌 на полку «${SHELVES[n.shelf]}»: ${esc(n.title)}`);
        changes.push(noteCard({ id, shelf: n.shelf, title: n.title, note: n.note }));
      }
    }
    for (const d of r.dates) {
      const id = await s.addDate({
        user_id: u.id, title: d.title, date_iso: d.date, type: d.type, person: d.person, notes: "", yearly: d.yearly ? 1 : 0,
        message_id: msg.id,
      });
      await log("add", "dates", id);
      changes.push(dateCard({ id, title: d.title, date_iso: d.date, yearly: d.yearly ? 1 : 0 }));
    }
    const memory = await s.activeMemory(u.id);
    for (const m of r.memory) {
      if (m.replaces) {
        const old = memory.find((x) => x.id === m.replaces);
        if (old) {
          await s.setMemoryStatus(old.id, "superseded");
          await log("status", "memory", old.id, { status: "active" });
        }
      }
      const id = await s.addMemory(u.id, m.kind, m.subject, m.text, msg.id);
      await log("add", "memory", id);
      changes.push(memoryCard({ id, subject: m.subject, text: m.text }));
    }
    const traitLines: string[] = [];
    for (const t of r.traits) {
      const got = await addTraitFromChat(s, u.id, t, msg.id);
      if (!got) continue;
      await log(got.before ? "status" : "add", "traits", got.id, got.before ?? undefined);
      traitLines.push(`${t.kind === "buff" ? "✨ в профиль, баф" : "🛡 в профиль, дебаф"}: ${esc(t.title)}`);
      // Вернули снятый: в базе прежнее название и пометка, а карточка — по словам модели, из базы её не собрать — без ref.
      const { ref, ...card } = traitCard({ id: got.id, kind: t.kind, title: t.title, note: t.note });
      changes.push(got.before ? card : { ...card, ref });
    }
    for (const m of r.metrics) {
      const id = await s.addMetric({
        user_id: u.id, day_key: m.dayKey, key: m.key, label: m.label, value: m.value, unit: m.unit, note: m.note,
        source: "text", message_id: msg.id,
      });
      await log("add", "metrics", id);
      changes.push(metricCard({ id, ...m }));
    }
    for (const m of r.money) {
      const id = await s.addMoney({
        user_id: u.id, day_key: m.dayKey, kind: m.kind, amount: m.amount, currency: m.currency, category: m.category,
        note: m.note, message_id: msg.id,
      });
      await log("add", "money", id);
      changes.push(moneyCard({ id, ...m }));
    }
    for (const h of r.habits) {
      const row = { title: h.title, days: h.days, times: JSON.stringify(h.times), start_date: h.start, end_date: h.end };
      const id = await s.addHabit({ user_id: u.id, ...row, message_id: msg.id });
      await log("add", "habits", id);
      changes.push(habitCard({ id, ...row, quiet: 0 }));
    }
    for (const m of r.marks) {
      const h = await s.habit(m.habitId);
      if (!h || h.user_id !== u.id) continue;
      // Завершённую (день после конца), удалённую и день до начала не отметить — строкой в ответе, как у кнопок (markRefusal).
      const refused = markRefusal(h, m.dayKey);
      if (refused) {
        markLines.push(`⛔ ${esc(h.title)}: ${esc(refused.charAt(0).toLowerCase() + refused.slice(1))}`);
        continue;
      }
      const { id, before } = await s.markHabit(h.id, m.dayKey, m.status, msg.id, m.amount ? { amount: m.amount, unit: m.unit } : undefined);
      await log("mark", "habit_marks", id, before ?? null);
      const much = m.amount ? ` · ${m.amount}${m.unit ? " " + m.unit : ""}` : "";
      markLines.push(`${m.status === "done" ? "✅" : "➖"} ${esc(h.title)}${esc(much)}`);
      changes.push({ kind: "mark", title: h.title, detail: (m.status === "done" ? "отмечено ✅" : "пропуск ➖") + much });
    }

    for (const e of r.edits) {
      if (e.kind === "event") {
        const ev = await s.event(e.id);
        if (!ev || ev.user_id !== u.id) continue;
        const before = { date_iso: ev.date_iso, time: ev.time, status: ev.status, title: ev.title };
        if (e.action === "rename") await s.updateEvent(ev.id, { title: e.newTitle! });
        else if (e.action === "cancel") await s.updateEvent(ev.id, { status: "cancelled" });
        else if (e.action === "done") await s.updateEvent(ev.id, { status: "done" });
        else if (e.action === "reopen") await s.updateEvent(ev.id, { status: "active" });
        else {
          await s.updateEvent(ev.id, { date_iso: e.newDate ?? ev.date_iso, time: e.newTime ?? ev.time });
          touched.push(ev.id);
        }
        await log("update", "events", ev.id, before);
        await s.cancelReminders("event", ev.id);
        const now = (await s.event(ev.id))!;
        if (now.status === "active") await planEventReminders(s, u, now, at);
        editLines.push(
          e.action === "cancel" ? `✖ отменено: ${esc(ev.title)}`
            : e.action === "done" ? `✔ состоялось: ${esc(ev.title)}`
            : e.action === "reopen" ? `↺ снова в планах: ${esc(ev.title)}`
            : e.action === "rename" ? `✎ переименовано: ${esc(ev.title)} → ${esc(now.title)}`
            : `➜ перенесено: ${esc(ev.title)} → ${now.date_iso}${now.time ? " " + now.time : ""}`,
        );
      } else if (e.kind === "task") {
        const t = await s.task(e.id);
        if (!t || t.user_id !== u.id) continue;
        const before = { status: t.status, due_date: t.due_date, title: t.title };
        if (e.action === "rename") await s.updateTask(t.id, { title: e.newTitle! });
        else if (e.action === "done") await s.updateTask(t.id, { status: "done" });
        else if (e.action === "cancel") await s.updateTask(t.id, { status: "cancelled" });
        else if (e.action === "reopen") await s.updateTask(t.id, { status: "open" });
        else await s.updateTask(t.id, { due_date: e.newDate ?? t.due_date });
        await log("update", "tasks", t.id, before);
        if (e.action !== "done" && e.action !== "cancel") edited.push(t.id);
        editLines.push(e.action === "done" ? `✔ сделано: ${esc(t.title)}` : e.action === "cancel" ? `✖ убрано: ${esc(t.title)}`
          : e.action === "reopen" ? `↺ снова открыто: ${esc(t.title)}`
          : e.action === "rename" ? `✎ переименовано: ${esc(t.title)} → ${esc(e.newTitle!)}` : `➜ срок: ${esc(t.title)} → ${e.newDate}`);
      } else if (e.kind === "note") {
        const n = await s.note(e.id);
        if (!n || n.user_id !== u.id || n.status === "purged") continue;
        const before = { status: n.status, title: n.title, shelf: n.shelf, rating: n.rating };
        const shelf = SHELVES[n.shelf as keyof typeof SHELVES] ?? n.shelf;
        if (e.action === "done") {
          await s.updateNote(n.id, { status: "done", rating: e.rating ?? n.rating });
          editLines.push(`✔ готово, «${shelf}»: ${esc(n.title)}${e.rating ? ` · ${e.rating}/10` : ""}`);
        } else if (e.action === "cancel") {
          await s.updateNote(n.id, { status: "deleted" });
          editLines.push(`✖ убрано из заметок: ${esc(n.title)}`);
        } else if (e.action === "reopen") {
          await s.updateNote(n.id, { status: "open" });
          editLines.push(`↺ снова на полке «${shelf}»: ${esc(n.title)}`);
        } else if (e.action === "rename") {
          await s.updateNote(n.id, { title: e.newTitle! });
          editLines.push(`✎ переименовано: ${esc(n.title)} → ${esc(e.newTitle!)}`);
        } else if (e.action === "move" && e.newShelf) {
          await s.updateNote(n.id, { shelf: e.newShelf });
          editLines.push(`➜ на полку «${SHELVES[e.newShelf]}»: ${esc(n.title)}`);
        } else continue;
        await log("update", "notes", n.id, before);
      } else if (e.kind === "date") {
        const d = await s.date(e.id);
        if (!d || d.user_id !== u.id || e.action !== "cancel") continue;
        await s.setDateStatus(d.id, "deleted");
        await log("status", "dates", d.id, { status: d.status });
        editLines.push(`✖ дата убрана: ${esc(d.title)}`);
      } else if (e.kind === "memory" && e.action === "cancel") {
        const m = memory.find((x) => x.id === e.id);
        if (!m) continue;
        await s.setMemoryStatus(m.id, "superseded");
        await log("status", "memory", m.id, { status: "active" });
        editLines.push(`✖ забыла: ${esc(m.text)}`);
      } else if (e.kind === "habit" && (e.action === "cancel" || e.action === "reopen" || e.action === "done")) {
        // «Бросаю/удали X» — cancel (удалить, stopped); «заверши/закончи X» — done (в «Завершённые», как «🏁 Завершить» на сайте:
        // finishPatch); «верни/возобнови X» — reopen (reopenPatch: снова идёт, прошедший срок снят). Журнал помнит всё (habitBefore).
        const h = await s.habit(e.id);
        if (!h || h.user_id !== u.id) continue;
        const today = dayKey(at, u.tz);
        const patch = e.action === "cancel" ? { status: "stopped" } : e.action === "done" ? await finishPatch(s, h, today, at) : reopenPatch(h, today);
        if (!patch) {
          editLines.push(`🏁 привычка уже завершена: ${esc(h.title)}`);
          continue;
        }
        await log(e.action === "done" ? "update" : "status", "habits", h.id, habitBefore(h));
        await s.updateHabit(h.id, patch);
        editLines.push(e.action === "cancel" ? `✖ привычка остановлена: ${esc(h.title)}` : e.action === "done" ? `🏁 привычка завершена: ${esc(h.title)}` : `↺ привычка снова идёт: ${esc(h.title)}`);
      } else if (e.kind === "habit" && (e.action === "rename" || e.action === "remind")) {
        // Как правка мышью (POST /api/habits/:id): журнал помнит название, время и «без напоминаний» — «Отменить» вернёт всё.
        const h = await s.habit(e.id);
        if (!h || h.user_id !== u.id) continue;
        await log("update", "habits", h.id, { status: h.status, title: h.title, times: h.times, quiet: h.quiet ?? 0 });
        if (e.action === "rename") {
          await s.updateHabit(h.id, { title: e.newTitle! });
          editLines.push(`✎ переименовано: ${esc(h.title)} → ${esc(e.newTitle!)}`);
        } else {
          const times = e.newTimes ?? [];
          await s.updateHabit(h.id, times.length ? { times: JSON.stringify(times), quiet: 0 } : { times: "[]", quiet: 1 });
          editLines.push(times.length ? `🔔 ${esc(h.title)}: напомню в ${times.join(", ")}` : `🔕 ${esc(h.title)}: без напоминаний`);
        }
      }
    }

    for (const l of editLines) changes.push({ kind: "edit", title: l.replace(/<[^>]+>/g, "") });
    return {
      lines: [
        ...changesList({
          sections, summary: Boolean(r.summary), events: r.events.length, tasks: r.tasks.length, dates: r.dates.length,
          memory: r.memory.length, metrics: r.metrics, money: r.money, habits: r.habits.map((h) => h.title), edits: [...traitLines, ...noteLines, ...editLines],
        }),
        ...markLines,
      ],
      changes,
      touched,
      edited,
    };
  }

  /** Отменить всё, что сделало сообщение (последнее, если не указано). */
  async undo(u: User, messageId?: number): Promise<string> {
    const r = await this.undoOne(u, messageId);
    this.changed(u);
    return r;
  }
  private async undoOne(u: User, messageId?: number): Promise<string> {
    const s = this.store;
    const p = persona(u.persona, u);
    const msg = messageId ? await s.message(messageId) : await s.lastDoneMessage(u.id);
    if (!msg || msg.user_id !== u.id) return "Нечего отменять.";
    await this.closeProposals(u, "declined", msg.id);
    // Журнал — в транзакции, после блокировки строки сообщения: поправка к ответу (correct) берёт её первой же. В Postgres одна
    // ждёт другую до конца и видит её итог: под отменённым ответом не остаётся живой поправки, а поправка не пишет в отменённый.
    const done = await s.transaction(async () => {
      await s.lockRow("messages", msg.id);
      const acts = await s.actionsOf(msg.id);
      for (const a of acts) {
        const before = a.before_json ? JSON.parse(a.before_json) : null;
        // Поправка к ответу (kind edit, correct.ts) помнит прежние поля — их и вернуть; записанное ответом (add) — убрать.
        // Журнал идёт от новых к старым: сначала откатываются поправки, потом сама запись.
        const restore = a.kind === "edit" && before;
        // Поправка убрала деньги, показатель или дневник (removeRow) — вернуть: снять пометку deleted.
        const unremove = restore && "deleted" in before;
        if (a.tbl === "diary") await (unremove ? s.setDiaryDeleted(a.row_id, false) : restore ? s.updateDiary(a.row_id, before) : s.setDiaryDeleted(a.row_id, true));
        else if (a.tbl === "events") {
          await s.cancelReminders("event", a.row_id);
          if (a.kind === "add") await s.updateEvent(a.row_id, { status: "deleted" });
          else if (before) {
            await s.updateEvent(a.row_id, before);
            const ev = await s.event(a.row_id);
            if (ev?.status === "active") await planEventReminders(s, u, ev, new Date());
          }
        } else if (a.tbl === "tasks") {
          if (a.kind === "add") await s.updateTask(a.row_id, { status: "deleted" });
          else if (before) await s.updateTask(a.row_id, before);
        } else if (a.tbl === "dates") await s.updateDate(a.row_id, a.kind === "add" ? { status: "deleted" } : before ?? { status: "active" });
        else if (a.tbl === "memory") await s.setMemoryStatus(a.row_id, a.kind === "add" ? "superseded" : before?.status ?? "active");
        else if (a.tbl === "metrics") await (unremove ? s.setMetricDeleted(a.row_id, false) : restore ? s.updateMetric(a.row_id, before) : s.setMetricDeleted(a.row_id, true));
        else if (a.tbl === "traits") await s.updateTrait(a.row_id, a.kind === "add" ? { status: "removed" } : before ?? {});
        else if (a.tbl === "money") await (unremove ? s.setMoneyDeleted(a.row_id, false) : restore ? s.updateMoney(a.row_id, before) : s.setMoneyDeleted(a.row_id, true));
        else if (a.tbl === "notes") await s.updateNote(a.row_id, a.kind === "add" ? { status: "deleted" } : before ?? {});
        else if (a.tbl === "habits") {
          // Правка мышью (POST /api/habits/:id) помнит и название, конец, «без напоминаний», время напоминаний; старые записи — только статус.
          if (a.kind === "add") await s.updateHabit(a.row_id, { status: "deleted" });
          else await s.updateHabit(a.row_id, before && Object.keys(before).length > 1 ? before : { status: before?.status ?? "active" });
        }
        else if (a.tbl === "habit_marks") await s.restoreMark(a.row_id, before as MarkRow | null);
        await s.markUndone(a.id);
      }
      return acts.length > 0;
    });
    return done ? p.undone : "Нечего отменять.";
  }

  /** Правка мышью (виджет, сайт): служебное сообщение с журналом, чтобы «Отменить» её откатило, как сказанное словами.
   *  fn делает правку и пишет в журнал: log(таблица, id, как было). Возвращает id сообщения (для кнопки «Вернуть»). */
  async manual(u: User, text: string, fn: (log: (tbl: Table, id: number, before: unknown) => Promise<void>) => Promise<void>, source = "panel"): Promise<number> {
    const s = this.store;
    const at = new Date();
    const { message } = await s.saveMessage({
      userId: u.id, source, sourceId: `edit:${at.getTime()}:${Math.random().toString(36).slice(2, 8)}`, text, dayKey: dayKey(at, u.tz), at,
    });
    await s.transaction(() => fn((tbl, id, before) => s.logAction(u.id, message.id, "edit", tbl, id, before)));
    await s.setMessage(message.id, { state: "done", reply: text });
    this.changed(u);
    return message.id;
  }

  /** Поправка к ответу (строка «поправить этот ответ…» под облачком): меняет только записи ответа messageId (correct.ts).
   *  Не через handle: открытые вопросы и ждущее уточнение не трогаются. Сама поправка — служебное сообщение (текст и ответ —
   *  в истории разговора), журнал — под исходным сообщением: отдельно поправка не отменяется. null — нет такого ответа.
   *  Повтор с тем же sourceId возвращает прежний итог без второй записи. */
  async correct(u: User, messageId: number, text: string, opts: { sourceId: string; at?: Date; client?: string }): Promise<CorrectReply | null> {
    const { value, again } = await this.inFlight(`correct:${u.id}:${messageId}:${opts.sourceId}`, () => this.counted((c) => this.correctOne(u, messageId, text, opts, c)));
    return again && value ? { ...value, duplicate: true } : value;
  }
  /** Вызовы модели поправки считаются на её служебное сообщение (ветка «correct»). */
  private async correctOne(u: User, messageId: number, text: string, opts: { sourceId: string; at?: Date; client?: string }, c: MsgCalls): Promise<CorrectReply | null> {
    const s = this.store;
    const at = opts.at ?? new Date();
    const p = persona(u.persona, u);
    let target = await s.message(messageId);
    if (!target || target.user_id !== u.id) return null;
    // Ответ на уточнение и прежняя поправка — служебные: записи лежат у исходного сообщения.
    if (target.reply_to && (target.reply === CLARIFIED || target.source_id.startsWith(CORRECT_SOURCE))) {
      const first = await s.message(target.reply_to);
      if (first && first.user_id === u.id) target = first;
    }
    const orig = target;
    const service = `${CORRECT_SOURCE}${orig.id}:`;
    const { message, created } = await s.saveMessage({
      userId: u.id, source: "desktop", sourceId: `${service}${opts.sourceId}`, text: `${CORRECT_TEXT}${text}`,
      dayKey: dayKey(at, u.tz), replyTo: orig.id, at,
    });
    const view = async (reply: string, o: CorrectSaved, duplicate = false): Promise<CorrectReply> => ({
      text: reply, emotion: o.emotion, messageId: orig.id, undoable: (await s.actionsOf(orig.id)).length > 0,
      changes: answerCards(await answerRows(s, u.id, orig.id)), changed: o.changed,
      ...(o.clarify ? { clarify: true } : {}), ...(o.clash ? { clash: o.clash } : {}), ...(duplicate ? { duplicate: true } : {}),
    });
    /** Итог, который уже записал запрос с тем же id (повтор доставки, в том числе пришедший, пока первый ждал модель). */
    const stored = async () => {
      const m = (await s.message(message.id))!;
      return view(m.reply ?? "", savedOf(m), true);
    };
    if (!created && message.state === "done") return stored();
    c.id = message.id;
    c.route = "correct";
    /** Итог без записи — в служебное сообщение, которое уже забрал claimMessage (повтор с тем же id вернёт его же). */
    const keep = async (reply: string, clarify = false, asked?: string) => {
      const o: CorrectSaved = { changed: [], clarify, emotion: "neutral", ...(clarify && asked ? { asked } : {}) };
      await s.setMessage(message.id, { reply, parse_json: JSON.stringify(o) });
      return { reply, o, wrote: false };
    };
    // Без записи: ответ сохраняется в служебном сообщении (state done — повтор вернёт его же, а не спросит модель снова).
    // Сообщение забирает claimMessage: из двух одновременных запросов с одним id итог пишет один.
    const say = async (reply: string, clarify = false, asked?: string): Promise<CorrectReply> => {
      const done = await s.transaction(async () => ((await s.claimMessage(message.id)) ? keep(reply, clarify, asked) : null));
      return done ? view(done.reply, done.o) : stored();
    };
    const items = await answerRows(s, u.id, orig.id);
    const cands = items.filter((i) => i.alive).map((i) => i.x).filter(editable);
    if (!cands.length) {
      // Ответ отменили «↩ Отменить» — в журнале остались только отменённые действия.
      if (!items.length && (await s.wasUndone(orig.id))) return say(ALREADY_UNDONE);
      // План стал задачей или задача — планом (виджет): сказать, где запись теперь, а не «записей нет».
      const moved = items.find((i) => turned(i.x));
      if (moved) return say(goneReply(moved.x));
      const acts = await s.actionsOf(orig.id);
      const other = items.some((i) => i.alive) || acts.some((a) => a.tbl === "habits" || a.tbl === "habit_marks" || a.tbl === "memory" || a.tbl === "traits");
      return say(other ? "Эти записи поправкой не поменять (привычки, отметки, память, профиль). Нажмите «↩ Отменить» и скажите заново, как нужно."
        : items.length ? "Записей этого ответа уже нет — поправлять нечего." : "В этом ответе нет записей — поправлять нечего.");
    }

    // Платный доступ (access.ts): поправка — тоже модель. Нельзя — ничего не меняем, отказ остаётся итогом этой поправки.
    // Проверка — здесь, перед моделью: честные ответы выше («поправлять нечего», «уже отменено») модель не зовут и запроса не берут.
    let taken: Taken | undefined;
    if (this.gate) {
      const v = await this.gate.check(u, { client: opts.client, take: { calls: 1 } });
      if (!v.ok) {
        c.route = "blocked";
        return { ...(await say(v.why === "rate" ? "Много сообщений подряд — повторите поправку через минуту, пожалуйста." : v.text)), blocked: v.why };
      }
      taken = v.taken;
    }

    // Прошлая поправка этого ответа кончилась вопросом («В 7 утра или вечера?») — эта, скорее всего, ответ на него: модель
    // видит ту поправку, вопрос и ответ вместе, как разбор с уточнением. Это всё тот же ответ — чужих данных в запросе нет.
    const prev = (await s.repliesTo(u.id, orig.id)).filter((m) => m.id < message.id && m.source_id.startsWith(service) && m.state === "done").at(-1);
    const last = prev ? savedOf(prev) : null;
    const question = prev && last?.clarify ? prev.reply ?? "" : "";
    const asked = prev && question ? `${last?.asked ?? prev.text.replace(CORRECT_TEXT, "")}\n(уточнение: ${text})` : text;

    const today = dayKey(at, u.tz);
    const ask = [
      {
        role: "system" as const,
        content: correctPrompt({ voice: p.voice, today, now: timeOf(at, u.tz), tz: u.tz, original: orig.text, rows: cands, question: question || undefined }),
      },
      { role: "user" as const, content: asked },
    ];
    let out: CorrectOut;
    try {
      let raw = await this.llm(ask, { json: true, kind: "correct" });
      let json: unknown;
      try {
        json = extractJson(raw);
      } catch {
        console.warn("[correct] без JSON, переспрашиваю:", raw.slice(0, 200));
        raw = await this.llm([...ask, { role: "assistant", content: raw }, { role: "user", content: prompt("common.json_retry") }], { json: true, kind: "correct" });
        json = extractJson(raw);
      }
      out = CorrectSchema.parse(json ?? {});
    } catch (e) {
      // Не done: повтор с тем же id спросит модель снова. Не failed: фоновый повтор разбора её не подхватит.
      // Одним условным запросом, а не «прочитать и записать»: тот же id мог уже записать другой запрос — тогда его итог.
      console.error("[correct]", e);
      await this.gate?.refund(u, taken); // модель не ответила — человек ничего не получил
      const failed = "Не получилось разобрать поправку — ничего не поменяла. Попробуйте ещё раз.";
      if (!(await s.replyUnlessDone(message.id, failed))) return stored();
      return view(failed, { changed: [], clarify: false, emotion: "worried" });
    }

    if (out.unsupported) return say(KIND_CHANGE);
    if (out.clarify) return say(`${p.clarify} ${esc(out.clarify)}`, true, asked);
    // Одна запись — один набор полей; номер не из списка ответа — мимо.
    const byRef = new Map(cands.map((x, i) => [`r${i + 1}`, x]));
    const sets = new Map<string, Record<string, unknown>>();
    let dropped = 0;
    for (const e of out.edits) {
      if (byRef.has(e.ref)) sets.set(e.ref, { ...sets.get(e.ref), ...e.set });
      else {
        dropped++;
        console.warn("[correct] нет записи", e.ref);
      }
    }
    // Убрать (remove): убранную запись не правят. Номер не из списка — мимо, как у edits.
    const removes = new Set<string>();
    for (const ref of out.remove) {
      if (byRef.has(ref)) removes.add(ref);
      else {
        dropped++;
        console.warn("[correct] нет записи", ref);
      }
    }
    for (const ref of removes) sets.delete(ref);
    // Новые записи (смена вида) — тем же разбором, что сообщение; не прошли проверку — вопрос, ничего не пишем.
    const adds = addOf(out.add, { today, now: timeOf(at, u.tz), day: orig.day_key });
    if (adds && "unsupported" in adds) return say(KIND_CHANGE);
    if (adds && "problem" in adds) return say(esc(adds.problem), true, asked);

    // Дальше всё — в транзакции и по записям из базы сейчас: пока модель думала, ответ могли отменить, а запись — подвинуть
    // мышью или сделать задачей. Проверка, длительность плана и «как было» в журнале — от записи сейчас, а не до запроса.
    const saved = await s.transaction(async () => {
      // Первой — строка ответа, как у «↩ Отменить» (undoOne): в Postgres отмена в это же время ждёт конца поправки или поправка —
      // конца отмены, и проверки ниже видят её итог. Правимую запись — тоже до того, как её перечитать: перетаскивание в виджете,
      // идущее в это время, не затрётся значениями, прочитанными до него.
      await s.lockRow("messages", orig.id);
      if (!(await s.claimMessage(message.id))) return null;
      if (!(await s.actionsOf(orig.id)).length) return keep(ALREADY_UNDONE);
      const checks: ReturnType<typeof planEdit>[] = [];
      for (const [ref, set] of sets) {
        const was = byRef.get(ref)!;
        await s.lockRow(was.tbl, was.id);
        const x = await reload(s, was);
        // Записи уже нет или она стала другим видом — не пишем ничего, и про остальные записи тоже.
        if (!x || !alive(x) || !editable(x)) return keep(goneReply(x ?? was));
        checks.push(planEdit(x, set, today));
      }
      const gone: Editable[] = [];
      for (const ref of removes) {
        const was = byRef.get(ref)!;
        await s.lockRow(was.tbl, was.id);
        const x = await reload(s, was);
        if (!x || !alive(x) || !editable(x)) return keep(goneReply(x ?? was));
        gone.push(x);
      }
      if (checks.some((c) => "unsupported" in c)) return keep(KIND_CHANGE);
      // Неверное значение или поле, которого у записи нет, — ничего не пишем, спрашиваем.
      const problem = checks.find((c): c is { problem: string } => "problem" in c);
      if (problem) return keep(esc(problem.problem), true, asked);
      const plans = checks.filter((c): c is Planned => "patch" in c && Object.keys(c.patch).length > 0);
      // «Так и записано» — только когда все названные поля и так такие; номер мимо — не поняла.
      if (!plans.length && !gone.length && !adds) return sets.size && !dropped ? keep("Так и записано — ничего не меняла.") : keep(NOT_UNDERSTOOD, true, asked);
      // Реплика модели — только если сделано всё, что она назвала: номер мимо или поле без перемен — и её «перенесла и поменяла
      // категорию» была бы неправдой. Тогда — нейтральное «Поправила.» («Убрала.», если только убрала) и строки о том, что правда поменялось.
      const whole = !dropped && plans.length === sets.size;
      const head = whole && out.reply ? esc(out.reply) : plans.length ? "Поправила." : !adds ? "Убрала." : !gone.length ? "Записала." : "Поправила.";
      const rest = dropped ? "\nОстального в этом ответе не нашла — не меняла." : "";
      const lines: string[] = [];
      const touched: number[] = [];
      const changed = plans.map((pl) => refKey(pl.x));
      for (const pl of plans) {
        const was = cardOf(pl.x);
        await s.logAction(u.id, orig.id, "edit", pl.x.tbl, pl.x.id, pl.before);
        await applyPlanned(s, pl);
        if (pl.x.tbl === "events") {
          await s.cancelReminders("event", pl.x.id);
          const ev = (await s.event(pl.x.id))!;
          if (ev.status === "active") await planEventReminders(s, u, ev, at);
          if ("date_iso" in pl.patch || "time" in pl.patch || "end_time" in pl.patch) touched.push(ev.id);
        }
        lines.push(changeLine(was, cardOf((await reload(s, pl.x))!)));
      }
      for (const x of gone) {
        await s.logAction(u.id, orig.id, "edit", x.tbl, x.id, await removeRow(s, x));
        lines.push(removeLine(x));
      }
      if (adds) {
        // Под исходным ответом (kind add): карточки ответа, следующая поправка и «↩ Отменить» видят их как записи ответа.
        const got = await this.apply(u, orig, adds.parsed, at);
        touched.push(...got.touched);
        for (const c of got.changes) {
          lines.push(addLine(c));
          if (c.ref) changed.push(refKey(c.ref));
        }
      }
      const clash = touched.length ? (await findClash(s, u.id, touched)) ?? undefined : undefined;
      const reply = `${head}\n${lines.join("\n")}${rest}${clash ? "\n" + clashLine(clash, esc) : ""}`;
      const o: CorrectSaved = { changed, clarify: false, emotion: out.emotion, ...(clash ? { clash } : {}) };
      await s.setMessage(message.id, { reply, parse_json: JSON.stringify(o) });
      return { reply, o, wrote: true };
    });
    // Тот же id уже записал другой запрос — второй раз не пишем, отдаём его итог.
    if (!saved) return stored();
    if (saved.wrote) this.changed(u); // и только убранное: changed его не называет, а списки (Telegram) обновить надо
    return view(saved.reply, saved.o);
  }

  /** Отметить привычку кнопкой (уведомление, приложение). Отменяется, как сообщение. */
  async markHabit(u: User, habitId: number, day: string, status: MarkRow["status"], source = "button"): Promise<string> {
    const r = await this.markHabitOne(u, habitId, day, status, source);
    this.changed(u);
    return r;
  }
  private async markHabitOne(u: User, habitId: number, day: string, status: MarkRow["status"], source: string): Promise<string> {
    const s = this.store;
    const h = await s.habit(habitId);
    if (!h || h.user_id !== u.id) return "Нет такой привычки.";
    // Старая кнопка в Telegram у завершённой или удалённой привычки — короткий ответ, отметки нет (сайт получает 409 раньше, api.ts).
    const refused = markRefusal(h, day);
    if (refused) return refused;
    const { message } = await s.saveMessage({
      userId: u.id, source, sourceId: `mark:${habitId}:${day}:${Date.now()}`,
      text: `${status === "done" ? "✅" : "➖"} ${h.title}`, dayKey: day,
    });
    await s.transaction(async () => {
      const { id, before } = await s.markHabit(h.id, day, status, message.id);
      await s.logAction(u.id, message.id, "mark", "habit_marks", id, before ?? null);
    });
    const text = status === "done" ? `✅ Отмечено: ${esc(h.title)}` : `➖ Пропуск: ${esc(h.title)}`;
    await s.setMessage(message.id, { state: "done", reply: text });
    // Отложенный на этот день вопрос («⏰ Позже») больше не нужен. Отметку словами в чате ловит сам планировщик (habitAnswered).
    for (const r of await s.pendingReminders("habit", h.id)) if (/habit:\d+:(\d{4}-\d{2}-\d{2}):/.exec(r.buttons)?.[1] === day) await s.markReminder(r.id, "cancelled");
    return text;
  }

  /** «⏰ Позже» → «15 мин» / «1 ч» / «Выбрать»…: тот же вопрос придёт снова в это время (напоминание ref_kind "habit", планировщик);
   *  отложить ещё раз можно сколько угодно — остаётся последнее. Только сегодня, позже, чем сейчас, и до 00:00 (у человека);
   *  отмеченную, чужую, удалённую или завершённую — нет (ok: false, text — почему). at — ЧЧ:ММ, на когда поставлено. */
  async habitSnooze(u: User, habitId: number, day: string, when: { in: number } | { at: string }, now = new Date()): Promise<{ ok: boolean; text: string; at?: string }> {
    const s = this.store;
    const h = await s.habit(habitId);
    if (!h || h.user_id !== u.id) return { ok: false, text: "Нет такой привычки." };
    const refused = markRefusal(h, day);
    if (refused) return { ok: false, text: refused };
    const today = dayKey(now, u.tz);
    const gone = snoozeDayRefusal(day, today);
    if (gone) return { ok: false, text: gone };
    const d = (await habitsOfDay(s, u, day, today)).find((x) => x.habit.id === h.id);
    // Сегодня не по расписанию или привычка тихая (без вопросов) — вопрос и не придёт, откладывать нечего.
    if (!d || d.habit.quiet) return { ok: false, text: `${h.title} — сегодня не спрашиваю.` };
    if ((await s.marksOf(u.id, day, day)).some((m) => m.habit_id === h.id)) return { ok: false, text: `${h.title} — уже отмечено.` };
    // Через N минут — от начала текущей минуты: «напомню в 15:30» и приходит в 15:30.
    const due = "in" in when ? new Date(Math.floor(now.getTime() / 60_000) * 60_000 + when.in * 60_000) : zonedToUtc(day, when.at, u.tz);
    const at = timeOf(due, u.tz);
    if (due <= now || ("at" in when && when.at <= timeOf(now, u.tz))) return { ok: false, text: "Это время уже прошло — выберите позже." };
    if (dayKey(due, u.tz) !== day) return { ok: false, text: "До 00:00 уже не успеть — выберите время раньше." };
    const buttons = habitButtons(h.id, day, snoozeOptions(u, day, due).steps.length > 0);
    // Последнее «Позже» заменяет прежнее — одной транзакцией: два нажатия разом (виджет и Telegram) не оставят двух вопросов.
    await s.transaction(async () => {
      await s.cancelReminders("habit", h.id);
      await s.addReminder(u.id, "habit", h.id, due, habitQuestion(h.title, d.streak), JSON.stringify(buttons));
    });
    // Длинное название короче: всплывашка Telegram — до 190 знаков, и «напомню в ЧЧ:ММ» не должно обрезаться.
    const title = h.title.length > 60 ? `${h.title.slice(0, 59)}…` : h.title;
    return { ok: true, text: `⏰ ${esc(title)} — напомню в ${at}. Не отметите до 00:00 — поставлю минус.`, at };
  }

  /** «Ещё нет» у вопроса про привычку: отметки нет; второй вопрос придёт в habit_last (планировщик), не отметят до полуночи — минус. */
  async habitLater(u: User, habitId: number, day: string, at = new Date()): Promise<string> {
    const h = await this.store.habit(habitId);
    if (!h || h.user_id !== u.id) return "Нет такой привычки.";
    // Завершённая или удалённая — тот же короткий ответ, что у отметки (markRefusal), без обещания минуса.
    const refused = markRefusal(h, day);
    if (refused) return refused;
    const again = day === dayKey(at, u.tz) && timeOf(at, u.tz) < u.habit_last;
    return `⏳ ${esc(h.title)} — хорошо, ${again ? `спрошу ещё раз в ${u.habit_last}` : "подожду"}. Не отметите до 00:00 — поставлю минус.`;
  }

  /** ИИ закрыт (access.ts): текст — заметкой (если keep: не /ask и не картинка без подписи), сообщение — done с текстом отказа,
   *  чтобы фоновый повтор (retryFailed) его не подхватил. Отменить заметку можно, как обычную запись. */
  private async blocked(u: User, msg: Message, v: Exclude<Verdict, { ok: true }>, at: Date, keep: boolean): Promise<Reply> {
    const s = this.store;
    let saved = false;
    if (keep && msg.text.trim() && !(await s.actionsOf(msg.id)).length) {
      await s.transaction(async () => {
        const id = await s.addDiary(u.id, msg.day_key, "notes", msg.text, msg.id);
        await s.logAction(u.id, msg.id, "add", "diary", id);
        const sid = await s.addDiary(u.id, msg.day_key, "summary", `[${timeOf(at, u.tz)}] ${msg.text}`, msg.id);
        await s.logAction(u.id, msg.id, "add", "diary", sid);
      });
      saved = true;
      this.changed(u);
    }
    const text = saved ? `${v.text}

📝 Это сообщение записала заметкой.` : v.text;
    await s.setMessage(msg.id, { state: "done", reply: text });
    return { text, emotion: "worried", messageId: msg.id, undoable: saved, blocked: v.why };
  }

  /** Слишком часто (окно частоты, access.ts): ничего не теряем и заметкой не пишем. Текст — «не удалось» (failed): его разберёт
   *  фоновый повтор (retryFailed, без частоты) или кнопка «Повторить». /ask и картинки не повторяются (картинки не хранятся,
   *  разговор — по свежему поводу) — им done и просьба прислать ещё раз. */
  private async tooFast(u: User, msg: Message, text: string, once: boolean): Promise<Reply> {
    if (once) {
      const again = RATE_AGAIN;
      await this.store.setMessage(msg.id, { state: "done", reply: again });
      return { text: again, emotion: "worried", messageId: msg.id, undoable: false };
    }
    await this.store.setMessage(msg.id, { state: "failed", reply: "rate" });
    return { text, emotion: "worried", messageId: msg.id, undoable: false, failed: true };
  }

  /** «Это просто заметка»: отменить разбор и записать текст целиком в заметки. */
  async asNote(u: User, messageId: number, at = new Date()): Promise<string> {
    const r = await this.asNoteOne(u, messageId, at);
    this.changed(u);
    return r;
  }
  private async asNoteOne(u: User, messageId: number, at: Date): Promise<string> {
    const s = this.store;
    const msg = await s.message(messageId);
    if (!msg || msg.user_id !== u.id) return "Не нашла сообщение.";
    await this.undo(u, messageId);
    if (msg.state === "failed") await s.setMessage(msg.id, { state: "done", reply: "записано заметкой" });
    await s.transaction(async () => {
      const id = await s.addDiary(u.id, msg.day_key, "notes", msg.text, msg.id);
      await s.logAction(u.id, msg.id, "add", "diary", id);
      const sid = await s.addDiary(u.id, msg.day_key, "summary", `[${timeOf(at, u.tz)}] ${msg.text}`, msg.id);
      await s.logAction(u.id, msg.id, "add", "diary", sid);
    });
    return "Записала целиком в заметки.";
  }

  private async answer(u: User, r: Parsed, question: string, today: string): Promise<{ text: string; days: string[] }> {
    const range = r.lookup ?? (r.search.length ? { from: EVER, to: today } : { from: addDays(today, -7), to: today });
    // Вопрос про заметки «на потом» («что посмотреть?») — ответ по полкам, дневник тут не нужен. Обычный вопрос со словами
    // для поиска — к найденному в дневнике добавляются и заметки с этими словами.
    const notes = r.shelves.length || r.search.length ? notesData(await this.store.notesOf(u.id), r.shelves, r.search) : "";
    const data = r.shelves.length
      ? `Заметки «на потом»:\n${notes || "ничего не записано"}`
      : (await answerData(this.store, u, range, r.search)) + (notes ? `\n\nЗаметки «на потом» с этими словами:\n${notes}` : "");
    // Тексты — промпты answer.rules и answer.shelf_rule (prompts.ts, правятся в админке → «Промпты»).
    const shelfRule = r.shelves.length ? `${prompt("answer.shelf_rule")} ` : "";
    const traits = traitPrompt(await this.store.traitsOf(u.id));
    try {
      const out = await this.llm([
        {
          role: "system",
          content: `${persona(u.persona, u).voice}\n${prompt("answer.rules", { shelf_rule: shelfRule, today })}\n\n${data}${traits ? "\n\n" + traits : ""}`,
        },
        { role: "user", content: question },
      ], { temperature: 0.4, kind: "answer", maxTokens: ANSWER_MAX_TOKENS });
      // Оборвался на полуслове (кончилась длина) — только законченные предложения; не осталось ни одного — как есть.
      const text = out.trim();
      return linkDays(esc(wholeSentences(text) || text), this.publicUrl, today);
    } catch (e) {
      console.error("[answer]", e);
      missBranch();
      return { text: persona(u.persona, u).failed, days: [] };
    }
  }

  /** Ответ разговором: голос характера, что знает о собеседнике, последние сообщения (/ask и сообщения с talk).
   *  saved — что из этого сообщения уже записал разбор (строки ответа); ответ — одним абзацем: под ним строки записанного. */
  private async talkText(u: User, msg: Message, at: Date, images?: Picture[], saved: string[] = []): Promise<string> {
    const p = persona(u.persona, u);
    const today = dayKey(at, u.tz);
    const traits = traitPrompt(await this.store.traitsOf(u.id));
    const mem = (await this.store.activeMemory(u.id)).slice(-PROMPT_CAP.memory).map((m) => `${m.subject ? m.subject + ": " : ""}${m.text}`).join("\n");
    const out = await this.llm([
      { role: "system", content: `${p.voice}\n${prompt("chat.rules")}\n${prompt("chat.system", { today, memory: mem || "почти ничего" })}${traits ? "\n\n" + traits : ""}`
        + (saved.length ? `\n\nИз этого сообщения ты уже записала (это видно под твоим ответом, не пересказывай и не говори, что не записала):\n${saved.join("\n")}` : "") },
      ...(await this.history(u.id, msg.id)),
      { role: "user", content: images ? `${msg.text}\n(Приложено изображений: ${images.length}.)` : msg.text, images },
    ], { temperature: 0.7, kind: "chat" });
    return esc(out.trim().replace(/\s*\n\s*/g, " "));
  }

  /** giveBack — вернуть запрос, взятый за это обращение (handleOne): модель не ответила — человек ничего не получил. */
  private async chat(u: User, msg: Message, at: Date, images?: Picture[], giveBack?: () => Promise<void>): Promise<Reply> {
    const p = persona(u.persona, u);
    try {
      const text = await this.talkText(u, msg, at, images);
      await this.store.setMessage(msg.id, { state: "done", reply: text });
      return { text, emotion: "neutral", messageId: msg.id, undoable: false };
    } catch (e) {
      console.error("[chat]", e);
      missBranch();
      await this.store.setMessage(msg.id, { state: "failed", reply: `${CHAT_FAILED}${llmErrorCode(e)}` });
      await giveBack?.();
      return { text: p.failed, emotion: "worried", messageId: msg.id, undoable: false };
    }
  }

  /** «Повторить»: разобрать неудавшееся сообщение ещё раз. Картинки не хранятся — их не повторить.
   *  client — кто нажал (api.ts, bot.ts): записанное идёт в счётчики фич; фоновый повтор — без клиента, не считается. */
  async retry(u: User, messageId: number, at = new Date(), client?: string, background = false): Promise<Reply> {
    const msg = await this.store.message(messageId);
    if (!msg || msg.user_id !== u.id) return { text: "Не нашла сообщение.", emotion: "neutral", messageId, undoable: false };
    if (msg.state !== "failed") return { text: "Это сообщение уже разобрано.", emotion: "neutral", messageId, undoable: false };
    if (msg.text.startsWith("📷")) return { text: "Картинку я не сохраняю — пришлите её ещё раз, пожалуйста.", emotion: "worried", messageId, undoable: false };
    return this.handle({ user: u, source: msg.source, sourceId: msg.source_id, text: msg.text, at: new Date(msg.received_at), client, background });
  }

  /** Фоновый повтор (раз в такт планировщика): сообщения, разбор которых упал, — через 2, 10 и 30 минут;
   *  не вышло и в третий раз — текст целиком в заметки. Итог присылается уведомлением (send). */
  async retryFailed(send: (u: User, text: string, emotion: Emotion) => Promise<void>, now = new Date()) {
    const s = this.store;
    for (const msg of await s.failedMessages(new Date(now.getTime() - 24 * 3600_000))) {
      if (msg.reply?.startsWith(CHAT_FAILED)) continue;
      const u = await s.user(msg.user_id);
      if (!u) continue;
      // Нет пробы или подписки (access.ts) — повтор тоже ИИ: не трогаем (сообщение остаётся неразобранным, его можно оставить заметкой).
      if (this.gate && !this.gate.allowed(u, now)) continue;
      const key = `retry:${msg.id}`;
      const tries = Number((await s.kvGet(key)) ?? 0);
      const wait = RETRY_AFTER_MIN[Math.min(tries, RETRY_AFTER_MIN.length - 1)];
      if (now.getTime() - new Date(msg.received_at).getTime() < wait * 60_000) continue;
      await s.kvSet(key, String(tries + 1));
      const short = msg.text.length > 60 ? `${msg.text.slice(0, 57)}…` : msg.text;
      if (msg.text.startsWith("📷")) {
        if (tries + 1 < RETRY_AFTER_MIN.length) continue;
        await s.setMessage(msg.id, { state: "done", reply: "картинка не разобрана" });
        await send(u, "Картинку так и не разобрала — пришлите её ещё раз, пожалуйста.", "worried");
        continue;
      }
      const r = await asUser(u.id, () => this.retry(u, msg.id, now, undefined, true)).catch(() => null);
      if (r?.blocked) continue; // потолок дня — сообщение уже заметкой, писать не о чем
      if (r && !r.failed) {
        await send(u, `Разобрала «${esc(short)}»:
${r.text}`, r.emotion);
      } else if (tries + 1 >= RETRY_AFTER_MIN.length) {
        await this.asNote(u, msg.id, now);
        await send(u, `Так и не смогла разобрать «${esc(short)}» — записала целиком в заметки.`, "worried");
      }
    }
  }
}
