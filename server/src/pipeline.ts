import type { MarkRow, Message, ProposalRow, Store, Table, User } from "./db.ts";
import type { LlmCall, Picture } from "./llm.ts";
import { extractJson } from "./llm.ts";
import { HEALTH_TOPICS, SECTIONS, buildPrompt, normalize, type Parsed, type Section } from "./parse.ts";
import { scheduleText } from "./habits.ts";
import { persona, pick, type Emotion } from "./personas.ts";
import { changesList, esc, metricLine, moneyLine, upcomingDates } from "./report.ts";
import { addDays, dayKey, humanDay, timeOf } from "./time.ts";
import { planEventReminders } from "./scheduler.ts";
import { EVER, answerData, linkDays } from "./ask.ts";

// Сообщение → запись → разбор → действия → ответ.
// Порядок важен: сначала сохраняем сырое сообщение (повтор доставки найдёт его), потом разбор,
// затем все действия одной транзакцией. Ответ «записала» — только после неё.

/** Что и куда записалось — для карточек в приложении. */
export interface Change {
  kind: "diary" | "event" | "task" | "date" | "memory" | "metric" | "money" | "habit" | "mark" | "edit";
  title: string;
  detail?: string;
}

export interface Reply {
  text: string;
  emotion: Emotion;
  messageId: number;
  /** Есть что отменить — показать кнопки. */
  undoable: boolean;
  duplicate?: boolean;
  changes?: Change[];
  /** Дни, о которых ответ на вопрос (ГГГГ-ММ-ДД) — ссылки на дневник. */
  days?: string[];
  /** Спорное — спросить кнопками: завести ли привычки / задачи из рассказа. */
  proposal?: Proposal;
  /** Разобрать не вышло (модель не ответила): кнопки «Повторить» и «Оставить заметкой»; сервер и сам повторит (retryFailed). */
  failed?: boolean;
}

/** Потолки списков в запросе к модели: данные растут, а запрос — нет. Берётся ближайшее и упомянутое в сообщении. */
export const PROMPT_CAP = { events: 120, tasks: 80, dates: 50, memory: 100 };

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
    tasks: capped(await s.openTasks(userId), PROMPT_CAP.tasks, words, (t) => t.title),
    dates: capped(dates, PROMPT_CAP.dates, words, (d) => `${d.title} ${d.person ?? ""}`),
    memory,
  };
}

/** Через сколько минут после сообщения повторять неудавшийся разбор; после последней попытки — заметкой. */
export const RETRY_AFTER_MIN = [2, 10, 30];
/** Признак неудачи разговора (/ask) в reply — такие не повторяются разбором. */
const CHAT_FAILED = "chat:";

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
}

/** Что модели сказать о картинке — рядом с подписью. */
const pictureNote = (n: number) =>
  n > 1
    ? `(К сообщению приложено изображений: ${n} — разбери каждое по правилам для изображений, одно и то же не записывай дважды. Подпись выше, если есть, важнее картинок.)`
    : "(К сообщению приложено изображение — разбери его по правилам для изображений. Подпись выше, если есть, важнее картинки.)";

/** Как сообщение с картинками выглядит в истории и в базе. */
export const pictureText = (caption: string, n = 1) => {
  const mark = n > 1 ? `📷×${n}` : "📷";
  return caption.trim() ? `${mark} ${caption.trim()}` : n > 1 ? `${mark} Фото` : "📷 Фото";
};

export class Pipeline {
  /** publicUrl — адрес веб-приложения для ссылок на дни в ответах (пусто — без ссылок). */
  constructor(private store: Store, private llm: LlmCall, private publicUrl = "") {}

  /** Зовётся, когда у пользователя что-то поменялось (записали, отметили, отменили) — например, чтобы обновить список-виджет. */
  onChange: ((u: User) => void) | null = null;
  /** Вопрос «добавить?» закрыт (ответили, отказались, истёк) — убрать кнопки там, где он висит (Telegram).
   *  text — новый текст ответа целиком, outcome — строка итога. */
  onProposal: ((u: User, p: ProposalRow, text: string, outcome: string) => Promise<void>) | null = null;
  changed(u: User) {
    try { this.onChange?.(u); } catch (e) { console.error("[pipeline] onChange", e); }
  }

  async handle(inc: Incoming): Promise<Reply> {
    const r = await this.handleOne(inc);
    if (!r.duplicate && (r.undoable || r.changes?.length)) this.changed(inc.user);
    return r;
  }

  private async handleOne(inc: Incoming): Promise<Reply> {
    const s = this.store;
    const at = inc.at ?? new Date();
    const u = inc.user;
    const today = dayKey(at, u.tz);
    const p = persona(u.persona);
    const pending = inc.chatOnly ? undefined : await s.pendingClarify(u.id);
    const pics = inc.images?.length ? inc.images : undefined;
    const { message, created } = await s.saveMessage({
      userId: u.id, source: inc.source, sourceId: inc.sourceId, text: pics ? pictureText(inc.text, pics.length) : inc.text, dayKey: today,
      replyTo: pics ? undefined : pending?.id, at,
    });
    if (!created && message.state === "done") {
      return { text: message.reply ?? p.saved[0], emotion: "neutral", messageId: message.id, undoable: false, duplicate: true };
    }
    // Новое сообщение — прежний вопрос «добавить?» без ответа закрывается (кнопки висят до следующего сообщения).
    await this.closeProposals(u, "expired");

    if (inc.chatOnly) return this.chat(u, message, at, pics);

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
      recent: [],
      clarifying: original ? { original: original.text, question: original.reply ?? "" } : undefined,
    };

    let parsed: Parsed;
    try {
      const raw = await this.llm(
        [
          { role: "system", content: buildPrompt(ctx, p.voice) },
          ...(await this.history(u.id, message.id)),
          { role: "user", content: text, images: pics },
        ],
        { json: true },
      );
      parsed = normalize(extractJson(raw), { today, now: ctx.now, text: inc.text });
    } catch (e) {
      await s.setMessage(message.id, { state: "failed", reply: String(e) });
      console.error("[parse]", e);
      return { text: p.failed, emotion: "worried", messageId: message.id, undoable: false, failed: true };
    }
    if (parsed.dropped.length) console.warn("[parse] отброшено:", parsed.dropped.join("; "));
    await s.setMessage(message.id, { parse_json: JSON.stringify(parsed) });

    // Уточнение — один вопрос, черновик ждёт. Повторно не спрашиваем: второй раз пишем как есть.
    // У картинки не спрашиваем: на ответ её уже не будет — пишем, что разобрали.
    if (parsed.clarify && !original && !pics) {
      const q = `${p.clarify} ${parsed.clarify}`;
      await s.setMessage(message.id, { state: "clarify", reply: q });
      return { text: q, emotion: "neutral", messageId: message.id, undoable: false };
    }

    // Вопрос про саму картинку («что это?») — отвечаем по ней, а не по записям.
    if (parsed.question && pics) return this.chat(u, message, at, pics);

    if (parsed.question) {
      const { text: answer, days } = await this.answer(u, parsed, inc.text, today);
      await s.setMessage(message.id, { state: "done", reply: answer });
      if (original) await s.setMessage(original.id, { state: "done" });
      return { text: answer, emotion: parsed.emotion, messageId: message.id, undoable: false, days };
    }

    const target = original ?? message;
    const { lines, changes } = await s.transaction(() => this.apply(u, target, parsed, at));
    if (original) await s.setMessage(message.id, { state: "done", reply: "(уточнение)" });

    const head = parsed.reply ? esc(parsed.reply) : pick(p.saved, message.id);
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
    const reply = `${head}${body}${ask ? "\n" + ask : ""}`;
    let proposal: Proposal | undefined;
    if (ask) {
      const id = await s.addProposal({
        user_id: u.id, message_id: target.id, text: reply, ask, items: JSON.stringify(items),
        picked: JSON.stringify(items.map((_, i) => i)), remind: sug.remind ? JSON.stringify(sug.remind) : "",
      });
      proposal = proposalView((await s.proposal(id))!);
    }
    await s.setMessage(target.id, { state: "done", reply });
    return { text: reply, emotion: parsed.emotion, messageId: target.id, undoable: lines.length > 0, changes, proposal };
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
          const hid = await s.addHabit({
            user_id: u.id, title: h.title, days: h.days, times: JSON.stringify(times), start_date: h.start, end_date: h.end,
            message_id: p.message_id, quiet: remind ? 0 : 1,
          });
          await s.logAction(u.id, p.message_id, "add", "habits", hid);
          habits.push(h.title);
          changes.push({ kind: "habit", title: h.title, detail: `${scheduleText({ days: h.days, start_date: h.start, end_date: h.end })}${times.length ? " · " + times.join(", ") : " · без напоминаний"}` });
        } else {
          const t = it.task;
          const tid = await s.addTask({ user_id: u.id, title: t.title, priority: t.priority, category: t.category, due_date: t.due, notes: "", message_id: p.message_id });
          await s.logAction(u.id, p.message_id, "add", "tasks", tid);
          tasks.push(t.title);
          changes.push({ kind: "task", title: t.title, detail: t.due ? `до ${humanDay(t.due)}` : undefined });
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
  private async apply(u: User, msg: Message, r: Parsed, at: Date): Promise<{ lines: string[]; changes: Change[] }> {
    const s = this.store;
    const log = (kind: string, tbl: Table, id: number, before?: unknown) => s.logAction(u.id, msg.id, kind, tbl, id, before);
    const sections: Section[] = [];
    const editLines: string[] = [];
    const markLines: string[] = [];
    const changes: Change[] = [];
    const short = (t: string, n = 90) => (t.length > n ? t.slice(0, n - 1) + "…" : t);

    for (const d of r.diary) {
      await log("add", "diary", await s.addDiary(u.id, d.dayKey, d.section, d.text, msg.id, d.topic));
      sections.push(d.section);
      changes.push({ kind: "diary", title: `${SECTIONS[d.section]}${d.section === "health" && d.topic ? " · " + (HEALTH_TOPICS[d.topic] ?? d.topic) : ""}`, detail: short(d.text) });
    }
    if (r.summary) await log("add", "diary", await s.addDiary(u.id, r.dayKey, "summary", r.summary, msg.id));
    if (r.tags.length) await log("add", "diary", await s.addDiary(u.id, r.dayKey, "tags", r.tags.join(", "), msg.id));

    for (const e of r.events) {
      const id = await s.addEvent({
        user_id: u.id, title: e.title, date_iso: e.date, time: e.time, end_time: e.endTime, details: e.details,
        domain: "life", message_id: msg.id,
      });
      await log("add", "events", id);
      await planEventReminders(s, u, (await s.event(id))!, at);
      changes.push({ kind: "event", title: e.title, detail: `${humanDay(e.date)}${e.time ? " " + e.time : ""}` });
    }
    for (const t of r.tasks) {
      await log("add", "tasks", await s.addTask({
        user_id: u.id, title: t.title, priority: t.priority, category: t.category, due_date: t.due, notes: "", message_id: msg.id,
      }));
      changes.push({ kind: "task", title: t.title, detail: t.due ? `до ${humanDay(t.due)}` : undefined });
    }
    for (const d of r.dates) {
      await log("add", "dates", await s.addDate({
        user_id: u.id, title: d.title, date_iso: d.date, type: d.type, person: d.person, notes: "", yearly: d.yearly ? 1 : 0,
        message_id: msg.id,
      }));
      changes.push({ kind: "date", title: d.title, detail: `${humanDay(d.date, true)}${d.yearly ? ", каждый год" : ""}` });
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
      await log("add", "memory", await s.addMemory(u.id, m.kind, m.subject, m.text, msg.id));
      changes.push({ kind: "memory", title: m.subject || "Запомнила", detail: short(m.text) });
    }
    for (const m of r.metrics) {
      await log("add", "metrics", await s.addMetric({
        user_id: u.id, day_key: m.dayKey, key: m.key, label: m.label, value: m.value, unit: m.unit, note: m.note,
        source: "text", message_id: msg.id,
      }));
      changes.push({ kind: "metric", title: m.label, detail: metricLine([m]).replace(/^[^:]*:\s*/, "") });
    }
    for (const m of r.money) {
      await log("add", "money", await s.addMoney({
        user_id: u.id, day_key: m.dayKey, kind: m.kind, amount: m.amount, currency: m.currency, category: m.category,
        note: m.note, message_id: msg.id,
      }));
      changes.push({ kind: "money", title: m.note || m.category || (m.kind === "income" ? "Доход" : "Расход"), detail: moneyLine(m).replace(/<[^>]+>/g, "") });
    }
    for (const h of r.habits) {
      await log("add", "habits", await s.addHabit({
        user_id: u.id, title: h.title, days: h.days, times: JSON.stringify(h.times), start_date: h.start, end_date: h.end,
        message_id: msg.id,
      }));
      changes.push({ kind: "habit", title: h.title, detail: `${scheduleText({ days: h.days, start_date: h.start, end_date: h.end })}${h.times.length ? " · " + h.times.join(", ") : ""}` });
    }
    for (const m of r.marks) {
      const h = await s.habit(m.habitId);
      if (!h || h.user_id !== u.id) continue;
      const { id, before } = await s.markHabit(h.id, m.dayKey, m.status, msg.id);
      await log("mark", "habit_marks", id, before ?? null);
      markLines.push(`${m.status === "done" ? "✅" : "➖"} ${esc(h.title)}`);
      changes.push({ kind: "mark", title: h.title, detail: m.status === "done" ? "отмечено ✅" : "пропуск ➖" });
    }

    for (const e of r.edits) {
      if (e.kind === "event") {
        const ev = await s.event(e.id);
        if (!ev || ev.user_id !== u.id) continue;
        const before = { date_iso: ev.date_iso, time: ev.time, status: ev.status };
        if (e.action === "cancel") await s.updateEvent(ev.id, { status: "cancelled" });
        else if (e.action === "done") await s.updateEvent(ev.id, { status: "done" });
        else if (e.action === "reopen") await s.updateEvent(ev.id, { status: "active" });
        else await s.updateEvent(ev.id, { date_iso: e.newDate ?? ev.date_iso, time: e.newTime ?? ev.time });
        await log("update", "events", ev.id, before);
        await s.cancelReminders("event", ev.id);
        const now = (await s.event(ev.id))!;
        if (now.status === "active") await planEventReminders(s, u, now, at);
        editLines.push(
          e.action === "cancel" ? `✖ отменено: ${esc(ev.title)}`
            : e.action === "done" ? `✔ состоялось: ${esc(ev.title)}`
            : e.action === "reopen" ? `↺ снова в планах: ${esc(ev.title)}`
            : `➜ перенесено: ${esc(ev.title)} → ${now.date_iso}${now.time ? " " + now.time : ""}`,
        );
      } else if (e.kind === "task") {
        const t = await s.task(e.id);
        if (!t || t.user_id !== u.id) continue;
        const before = { status: t.status, due_date: t.due_date };
        if (e.action === "done") await s.updateTask(t.id, { status: "done" });
        else if (e.action === "cancel") await s.updateTask(t.id, { status: "cancelled" });
        else if (e.action === "reopen") await s.updateTask(t.id, { status: "open" });
        else await s.updateTask(t.id, { due_date: e.newDate ?? t.due_date });
        await log("update", "tasks", t.id, before);
        editLines.push(e.action === "done" ? `✔ сделано: ${esc(t.title)}` : e.action === "cancel" ? `✖ убрано: ${esc(t.title)}`
          : e.action === "reopen" ? `↺ снова открыто: ${esc(t.title)}` : `➜ срок: ${esc(t.title)} → ${e.newDate}`);
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
      } else if (e.kind === "habit" && (e.action === "cancel" || e.action === "reopen")) {
        const h = await s.habit(e.id);
        if (!h || h.user_id !== u.id) continue;
        await s.updateHabit(h.id, { status: e.action === "cancel" ? "stopped" : "active" });
        await log("status", "habits", h.id, { status: h.status });
        editLines.push(e.action === "cancel" ? `✖ привычка остановлена: ${esc(h.title)}` : `↺ привычка снова идёт: ${esc(h.title)}`);
      }
    }

    for (const l of editLines) changes.push({ kind: "edit", title: l.replace(/<[^>]+>/g, "") });
    return {
      lines: [
        ...changesList({
          sections, summary: Boolean(r.summary), events: r.events.length, tasks: r.tasks.length, dates: r.dates.length,
          memory: r.memory.length, metrics: r.metrics, money: r.money, habits: r.habits.map((h) => h.title), edits: editLines,
        }),
        ...markLines,
      ],
      changes,
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
    const p = persona(u.persona);
    const msg = messageId ? await s.message(messageId) : await s.lastDoneMessage(u.id);
    if (!msg || msg.user_id !== u.id) return "Нечего отменять.";
    await this.closeProposals(u, "declined", msg.id);
    const acts = await s.actionsOf(msg.id);
    if (!acts.length) return "Нечего отменять.";
    await s.transaction(async () => {
      for (const a of acts) {
        const before = a.before_json ? JSON.parse(a.before_json) : null;
        if (a.tbl === "diary") await s.setDiaryDeleted(a.row_id, true);
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
        } else if (a.tbl === "dates") await s.setDateStatus(a.row_id, a.kind === "add" ? "deleted" : before?.status ?? "active");
        else if (a.tbl === "memory") await s.setMemoryStatus(a.row_id, a.kind === "add" ? "superseded" : before?.status ?? "active");
        else if (a.tbl === "metrics") await s.setMetricDeleted(a.row_id, true);
        else if (a.tbl === "money") await s.setMoneyDeleted(a.row_id, true);
        else if (a.tbl === "habits") await s.updateHabit(a.row_id, { status: a.kind === "add" ? "deleted" : before?.status ?? "active" });
        else if (a.tbl === "habit_marks") await s.restoreMark(a.row_id, before as MarkRow | null);
        await s.markUndone(a.id);
      }
    });
    return p.undone;
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
    return text;
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
    const data = await answerData(this.store, u, range, r.search);
    try {
      const out = await this.llm([
        {
          role: "system",
          content: `${persona(u.persona).voice}\nОтвечай на вопрос пользователя только по его записям ниже. ` +
            `Нет данных — так и скажи, не выдумывай. Коротко, 1–4 предложения. Сегодня ${today}. ` +
            `Дни называй датой в виде ГГГГ-ММ-ДД (их покажут ссылками), суммы и средние бери из «Итогов», сам не складывай.\n\n${data}`,
        },
        { role: "user", content: question },
      ], { temperature: 0.4 });
      return linkDays(esc(out.trim()), this.publicUrl, today);
    } catch (e) {
      console.error("[answer]", e);
      return { text: persona(u.persona).failed, days: [] };
    }
  }

  private async chat(u: User, msg: Message, at: Date, images?: Picture[]): Promise<Reply> {
    const p = persona(u.persona);
    const today = dayKey(at, u.tz);
    const mem = (await this.store.activeMemory(u.id)).slice(-PROMPT_CAP.memory).map((m) => `${m.subject ? m.subject + ": " : ""}${m.text}`).join("\n");
    try {
      const out = await this.llm([
        { role: "system", content: `${p.voice}\nЭто просто разговор, ничего не записывай. Сегодня ${today}.\nЧто знаешь о собеседнике:\n${mem || "почти ничего"}` },
        ...(await this.history(u.id, msg.id)),
        { role: "user", content: images ? `${msg.text}\n(Приложено изображений: ${images.length}.)` : msg.text, images },
      ], { temperature: 0.7 });
      const text = esc(out.trim());
      await this.store.setMessage(msg.id, { state: "done", reply: text });
      return { text, emotion: "neutral", messageId: msg.id, undoable: false };
    } catch (e) {
      console.error("[chat]", e);
      await this.store.setMessage(msg.id, { state: "failed", reply: `${CHAT_FAILED}${String(e)}` });
      return { text: p.failed, emotion: "worried", messageId: msg.id, undoable: false };
    }
  }

  /** «Повторить»: разобрать неудавшееся сообщение ещё раз. Картинки не хранятся — их не повторить. */
  async retry(u: User, messageId: number, at = new Date()): Promise<Reply> {
    const msg = await this.store.message(messageId);
    if (!msg || msg.user_id !== u.id) return { text: "Не нашла сообщение.", emotion: "neutral", messageId, undoable: false };
    if (msg.state !== "failed") return { text: "Это сообщение уже разобрано.", emotion: "neutral", messageId, undoable: false };
    if (msg.text.startsWith("📷")) return { text: "Картинку я не сохраняю — пришлите её ещё раз, пожалуйста.", emotion: "worried", messageId, undoable: false };
    return this.handle({ user: u, source: msg.source, sourceId: msg.source_id, text: msg.text, at: new Date(msg.received_at) });
  }

  /** Фоновый повтор (раз в такт планировщика): сообщения, разбор которых упал, — через 2, 10 и 30 минут;
   *  не вышло и в третий раз — текст целиком в заметки. Итог присылается уведомлением (send). */
  async retryFailed(send: (u: User, text: string, emotion: Emotion) => Promise<void>, now = new Date()) {
    const s = this.store;
    for (const msg of await s.failedMessages(new Date(now.getTime() - 24 * 3600_000))) {
      if (msg.reply?.startsWith(CHAT_FAILED)) continue;
      const u = await s.user(msg.user_id);
      if (!u) continue;
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
      const r = await this.retry(u, msg.id, now).catch(() => null);
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
