import type { MarkRow, Message, Store, Table, User } from "./db.ts";
import type { LlmCall } from "./llm.ts";
import { extractJson } from "./llm.ts";
import { buildPrompt, normalize, type Parsed, type Section } from "./parse.ts";
import { persona, pick, type Emotion } from "./personas.ts";
import { changesList, diaryDigest, esc } from "./report.ts";
import { addDays, dayKey, timeOf } from "./time.ts";
import { planEventReminders } from "./scheduler.ts";

// Сообщение → запись → разбор → действия → ответ.
// Порядок важен: сначала сохраняем сырое сообщение (повтор доставки найдёт его), потом разбор,
// затем все действия одной транзакцией. Ответ «записала» — только после неё.

export interface Reply {
  text: string;
  emotion: Emotion;
  messageId: number;
  /** Есть что отменить — показать кнопки. */
  undoable: boolean;
  duplicate?: boolean;
}

export interface Incoming {
  user: User;
  source: string; // telegram | desktop | web | api
  sourceId: string;
  text: string;
  at?: Date;
  /** Только поговорить (/ask): ничего не записывать. */
  chatOnly?: boolean;
}

export class Pipeline {
  constructor(private store: Store, private llm: LlmCall) {}

  async handle(inc: Incoming): Promise<Reply> {
    const s = this.store;
    const at = inc.at ?? new Date();
    const u = inc.user;
    const today = dayKey(at, u.tz);
    const p = persona(u.persona);
    const pending = inc.chatOnly ? undefined : await s.pendingClarify(u.id);
    const { message, created } = await s.saveMessage({
      userId: u.id, source: inc.source, sourceId: inc.sourceId, text: inc.text, dayKey: today, replyTo: pending?.id, at,
    });
    if (!created && message.state === "done") {
      return { text: message.reply ?? p.saved[0], emotion: "neutral", messageId: message.id, undoable: false, duplicate: true };
    }

    if (inc.chatOnly) return this.chat(u, message, at);

    // Ответ на уточнение: разбираем исходное сообщение вместе с ответом.
    const original = pending ? await s.message(pending.id) : undefined;
    const text = original ? `${original.text}\n(уточнение: ${inc.text})` : inc.text;
    const ctx = {
      today,
      now: timeOf(at, u.tz),
      tz: u.tz,
      events: await s.eventsBetween(u.id, addDays(today, -1), addDays(today, 45)),
      tasks: await s.openTasks(u.id),
      dates: await s.activeDates(u.id),
      memory: await s.activeMemory(u.id),
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
          { role: "user", content: text },
        ],
        { json: true },
      );
      parsed = normalize(extractJson(raw), { today, now: ctx.now, text: inc.text });
    } catch (e) {
      await s.setMessage(message.id, { state: "failed", reply: String(e) });
      console.error("[parse]", e);
      return { text: p.failed, emotion: "worried", messageId: message.id, undoable: false };
    }
    if (parsed.dropped.length) console.warn("[parse] отброшено:", parsed.dropped.join("; "));
    await s.setMessage(message.id, { parse_json: JSON.stringify(parsed) });

    // Уточнение — один вопрос, черновик ждёт. Повторно не спрашиваем: второй раз пишем как есть.
    if (parsed.clarify && !original) {
      const q = `${p.clarify} ${parsed.clarify}`;
      await s.setMessage(message.id, { state: "clarify", reply: q });
      return { text: q, emotion: "neutral", messageId: message.id, undoable: false };
    }

    if (parsed.question) {
      const answer = await this.answer(u, parsed, inc.text, today);
      await s.setMessage(message.id, { state: "done", reply: answer });
      if (original) await s.setMessage(original.id, { state: "done" });
      return { text: answer, emotion: parsed.emotion, messageId: message.id, undoable: false };
    }

    const target = original ?? message;
    const lines = await s.transaction(() => this.apply(u, target, parsed, at));
    if (original) await s.setMessage(message.id, { state: "done", reply: "(уточнение)" });

    const head = parsed.reply ? esc(parsed.reply) : pick(p.saved, message.id);
    const body = lines.length ? "\n" + lines.join("\n") : "";
    const reply = `${head}${body}`;
    await s.setMessage(target.id, { state: "done", reply });
    return { text: reply, emotion: parsed.emotion, messageId: target.id, undoable: lines.length > 0 };
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
  private async apply(u: User, msg: Message, r: Parsed, at: Date): Promise<string[]> {
    const s = this.store;
    const log = (kind: string, tbl: Table, id: number, before?: unknown) => s.logAction(u.id, msg.id, kind, tbl, id, before);
    const sections: Section[] = [];
    const editLines: string[] = [];
    const markLines: string[] = [];

    for (const d of r.diary) {
      await log("add", "diary", await s.addDiary(u.id, d.dayKey, d.section, d.text, msg.id, d.topic));
      sections.push(d.section);
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
    }
    for (const t of r.tasks) {
      await log("add", "tasks", await s.addTask({
        user_id: u.id, title: t.title, priority: t.priority, category: t.category, due_date: t.due, notes: "", message_id: msg.id,
      }));
    }
    for (const d of r.dates) {
      await log("add", "dates", await s.addDate({
        user_id: u.id, title: d.title, date_iso: d.date, type: d.type, person: d.person, notes: "", yearly: d.yearly ? 1 : 0,
        message_id: msg.id,
      }));
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
    }
    for (const m of r.metrics) {
      await log("add", "metrics", await s.addMetric({
        user_id: u.id, day_key: m.dayKey, key: m.key, label: m.label, value: m.value, unit: m.unit, note: m.note,
        source: "text", message_id: msg.id,
      }));
    }
    for (const m of r.money) {
      await log("add", "money", await s.addMoney({
        user_id: u.id, day_key: m.dayKey, kind: m.kind, amount: m.amount, currency: m.currency, category: m.category,
        note: m.note, message_id: msg.id,
      }));
    }
    for (const h of r.habits) {
      await log("add", "habits", await s.addHabit({
        user_id: u.id, title: h.title, days: h.days, times: JSON.stringify(h.times), start_date: h.start, end_date: h.end,
        message_id: msg.id,
      }));
    }
    for (const m of r.marks) {
      const h = await s.habit(m.habitId);
      if (!h || h.user_id !== u.id) continue;
      const { id, before } = await s.markHabit(h.id, m.dayKey, m.status, msg.id);
      await log("mark", "habit_marks", id, before ?? null);
      markLines.push(`${m.status === "done" ? "✅" : "➖"} ${esc(h.title)}`);
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

    return [
      ...changesList({
        sections, summary: Boolean(r.summary), events: r.events.length, tasks: r.tasks.length, dates: r.dates.length,
        memory: r.memory.length, metrics: r.metrics, money: r.money, habits: r.habits.map((h) => h.title), edits: editLines,
      }),
      ...markLines,
    ];
  }

  /** Отменить всё, что сделало сообщение (последнее, если не указано). */
  async undo(u: User, messageId?: number): Promise<string> {
    const s = this.store;
    const p = persona(u.persona);
    const msg = messageId ? await s.message(messageId) : await s.lastDoneMessage(u.id);
    if (!msg || msg.user_id !== u.id) return "Нечего отменять.";
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
    const s = this.store;
    const msg = await s.message(messageId);
    if (!msg || msg.user_id !== u.id) return "Не нашла сообщение.";
    await this.undo(u, messageId);
    await s.transaction(async () => {
      const id = await s.addDiary(u.id, msg.day_key, "notes", msg.text, msg.id);
      await s.logAction(u.id, msg.id, "add", "diary", id);
      const sid = await s.addDiary(u.id, msg.day_key, "summary", `[${timeOf(at, u.tz)}] ${msg.text}`, msg.id);
      await s.logAction(u.id, msg.id, "add", "diary", sid);
    });
    return "Записала целиком в заметки.";
  }

  private async answer(u: User, r: Parsed, question: string, today: string): Promise<string> {
    const range = r.lookup ?? { from: addDays(today, -7), to: today };
    const data = await diaryDigest(this.store, u, range.from, range.to);
    try {
      const out = await this.llm([
        {
          role: "system",
          content: `${persona(u.persona).voice}\nОтвечай на вопрос пользователя только по его записям ниже. ` +
            `Нет данных — так и скажи, не выдумывай. Коротко, 1–4 предложения. Сегодня ${today}.\n\nЗаписи ${range.from}…${range.to}:\n${data}`,
        },
        { role: "user", content: question },
      ], { temperature: 0.4 });
      return esc(out.trim());
    } catch (e) {
      console.error("[answer]", e);
      return persona(u.persona).failed;
    }
  }

  private async chat(u: User, msg: Message, at: Date): Promise<Reply> {
    const p = persona(u.persona);
    const today = dayKey(at, u.tz);
    const mem = (await this.store.activeMemory(u.id)).map((m) => `${m.subject ? m.subject + ": " : ""}${m.text}`).join("\n");
    try {
      const out = await this.llm([
        { role: "system", content: `${p.voice}\nЭто просто разговор, ничего не записывай. Сегодня ${today}.\nЧто знаешь о собеседнике:\n${mem || "почти ничего"}` },
        ...(await this.history(u.id, msg.id)),
        { role: "user", content: msg.text },
      ], { temperature: 0.7 });
      const text = esc(out.trim());
      await this.store.setMessage(msg.id, { state: "done", reply: text });
      return { text, emotion: "neutral", messageId: msg.id, undoable: false };
    } catch (e) {
      console.error("[chat]", e);
      await this.store.setMessage(msg.id, { state: "failed" });
      return { text: p.failed, emotion: "worried", messageId: msg.id, undoable: false };
    }
  }
}
