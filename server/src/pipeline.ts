import type { Message, Store, User } from "./db.ts";
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
  source: string; // telegram | desktop | api
  sourceId: string;
  text: string;
  at?: Date;
  /** Только поговорить (/ask): ничего не записывать. */
  chatOnly?: boolean;
}

export class Pipeline {
  constructor(private store: Store, private llm: LlmCall) {}

  async handle(inc: Incoming): Promise<Reply> {
    const at = inc.at ?? new Date();
    const u = inc.user;
    const today = dayKey(at, u.tz);
    const p = persona(u.persona);
    const pending = inc.chatOnly ? undefined : this.store.pendingClarify(u.id);
    const { message, created } = this.store.saveMessage({
      userId: u.id, source: inc.source, sourceId: inc.sourceId, text: inc.text, dayKey: today, replyTo: pending?.id,
    });
    if (!created && message.state === "done") {
      return { text: message.reply ?? p.saved[0], emotion: "neutral", messageId: message.id, undoable: false, duplicate: true };
    }

    if (inc.chatOnly) return this.chat(u, message, at);

    // Ответ на уточнение: разбираем исходное сообщение вместе с ответом.
    const original = pending ? this.store.message(pending.id) : undefined;
    const text = original ? `${original.text}\n(уточнение: ${inc.text})` : inc.text;
    const ctx = {
      today,
      now: timeOf(at, u.tz),
      tz: u.tz,
      events: this.store.eventsBetween(u.id, addDays(today, -1), addDays(today, 45)),
      tasks: this.store.openTasks(u.id),
      dates: this.store.activeDates(u.id),
      memory: this.store.activeMemory(u.id),
      recent: [],
      clarifying: original ? { original: original.text, question: original.reply ?? "" } : undefined,
    };

    let parsed: Parsed;
    try {
      const raw = await this.llm(
        [
          { role: "system", content: buildPrompt(ctx, p.voice) },
          ...this.history(u.id, message.id),
          { role: "user", content: text },
        ],
        { json: true },
      );
      parsed = normalize(extractJson(raw), { today, now: ctx.now, text: inc.text });
    } catch (e) {
      this.store.setMessage(message.id, { state: "failed", reply: String(e) });
      console.error("[parse]", e);
      return { text: p.failed, emotion: "worried", messageId: message.id, undoable: false };
    }
    if (parsed.dropped.length) console.warn("[parse] отброшено:", parsed.dropped.join("; "));
    this.store.setMessage(message.id, { parse_json: JSON.stringify(parsed) });

    // Уточнение — один вопрос, черновик ждёт. Повторно не спрашиваем: второй раз пишем как есть.
    if (parsed.clarify && !original) {
      const q = `${p.clarify} ${parsed.clarify}`;
      this.store.setMessage(message.id, { state: "clarify", reply: q });
      return { text: q, emotion: "neutral", messageId: message.id, undoable: false };
    }

    if (parsed.question) {
      const answer = await this.answer(u, parsed, inc.text, today);
      this.store.setMessage(message.id, { state: "done", reply: answer });
      if (original) this.store.setMessage(original.id, { state: "done" });
      return { text: answer, emotion: parsed.emotion, messageId: message.id, undoable: false };
    }

    const target = original ?? message;
    const lines = this.store.transaction(() => this.apply(u, target, parsed, at));
    if (original) this.store.setMessage(message.id, { state: "done", reply: "(уточнение)" });

    const head = parsed.reply ? esc(parsed.reply) : pick(p.saved, message.id);
    const body = lines.length ? "\n" + lines.join("\n") : "";
    const reply = `${head}${body}`;
    this.store.setMessage(target.id, { state: "done", reply });
    return { text: reply, emotion: parsed.emotion, messageId: target.id, undoable: lines.length > 0 };
  }

  private history(userId: number, beforeId: number) {
    return this.store
      .recentMessages(userId, 7)
      .filter((m) => m.id !== beforeId && m.state !== "failed")
      .slice(-6)
      .flatMap((m) => [
        { role: "user" as const, content: m.text },
        ...(m.reply ? [{ role: "assistant" as const, content: m.reply.replace(/<[^>]+>/g, "") }] : []),
      ]);
  }

  private apply(u: User, msg: Message, r: Parsed, at: Date): string[] {
    const s = this.store;
    const log = (kind: string, tbl: Parameters<Store["logAction"]>[3], id: number, before?: unknown) =>
      s.logAction(u.id, msg.id, kind, tbl, id, before);
    const sections: Section[] = [];
    const editLines: string[] = [];

    for (const d of r.diary) {
      log("add", "diary", s.addDiary(u.id, d.dayKey, d.section, d.text, msg.id));
      sections.push(d.section);
    }
    if (r.summary) log("add", "diary", s.addDiary(u.id, r.dayKey, "summary", r.summary, msg.id));
    if (r.tags.length) log("add", "diary", s.addDiary(u.id, r.dayKey, "tags", r.tags.join(", "), msg.id));

    for (const e of r.events) {
      const id = s.addEvent({
        user_id: u.id, title: e.title, date_iso: e.date, time: e.time, end_time: e.endTime, details: e.details,
        domain: "life", message_id: msg.id,
      });
      log("add", "events", id);
      planEventReminders(s, u, s.event(id)!, at);
    }
    for (const t of r.tasks) {
      log("add", "tasks", s.addTask({
        user_id: u.id, title: t.title, priority: t.priority, category: t.category, due_date: t.due, notes: "", message_id: msg.id,
      }));
    }
    for (const d of r.dates) {
      log("add", "dates", s.addDate({
        user_id: u.id, title: d.title, date_iso: d.date, type: d.type, person: d.person, notes: "", yearly: d.yearly ? 1 : 0,
        message_id: msg.id,
      }));
    }
    for (const m of r.memory) {
      if (m.replaces) {
        const old = s.activeMemory(u.id).find((x) => x.id === m.replaces);
        if (old) {
          s.setMemoryStatus(old.id, "superseded");
          log("status", "memory", old.id, { status: "active" });
        }
      }
      log("add", "memory", s.addMemory(u.id, m.kind, m.subject, m.text, msg.id));
    }

    for (const e of r.edits) {
      if (e.kind === "event") {
        const ev = s.event(e.id);
        if (!ev || ev.user_id !== u.id) continue;
        const before = { date_iso: ev.date_iso, time: ev.time, status: ev.status };
        if (e.action === "cancel") s.updateEvent(ev.id, { status: "cancelled" });
        else if (e.action === "done") s.updateEvent(ev.id, { status: "done" });
        else if (e.action === "reopen") s.updateEvent(ev.id, { status: "active" });
        else s.updateEvent(ev.id, { date_iso: e.newDate ?? ev.date_iso, time: e.newTime ?? ev.time });
        log("update", "events", ev.id, before);
        s.cancelReminders("event", ev.id);
        const now = s.event(ev.id)!;
        if (now.status === "active") planEventReminders(s, u, now, at);
        editLines.push(
          e.action === "cancel" ? `✖ отменено: ${esc(ev.title)}`
            : e.action === "done" ? `✔ состоялось: ${esc(ev.title)}`
            : e.action === "reopen" ? `↺ снова в планах: ${esc(ev.title)}`
            : `➜ перенесено: ${esc(ev.title)} → ${now.date_iso}${now.time ? " " + now.time : ""}`,
        );
      } else if (e.kind === "task") {
        const t = s.task(e.id);
        if (!t || t.user_id !== u.id) continue;
        const before = { status: t.status, due_date: t.due_date };
        if (e.action === "done") s.updateTask(t.id, { status: "done" });
        else if (e.action === "cancel") s.updateTask(t.id, { status: "cancelled" });
        else if (e.action === "reopen") s.updateTask(t.id, { status: "open" });
        else s.updateTask(t.id, { due_date: e.newDate ?? t.due_date });
        log("update", "tasks", t.id, before);
        editLines.push(e.action === "done" ? `✔ сделано: ${esc(t.title)}` : e.action === "cancel" ? `✖ убрано: ${esc(t.title)}`
          : e.action === "reopen" ? `↺ снова открыто: ${esc(t.title)}` : `➜ срок: ${esc(t.title)} → ${e.newDate}`);
      } else if (e.kind === "date") {
        const d = s.date(e.id);
        if (!d || d.user_id !== u.id || e.action !== "cancel") continue;
        s.setDateStatus(d.id, "deleted");
        log("status", "dates", d.id, { status: d.status });
        editLines.push(`✖ дата убрана: ${esc(d.title)}`);
      } else if (e.kind === "memory" && e.action === "cancel") {
        const m = s.activeMemory(u.id).find((x) => x.id === e.id);
        if (!m) continue;
        s.setMemoryStatus(m.id, "superseded");
        log("status", "memory", m.id, { status: "active" });
        editLines.push(`✖ забыла: ${esc(m.text)}`);
      }
    }

    return changesList({
      sections, summary: Boolean(r.summary), events: r.events.length, tasks: r.tasks.length, dates: r.dates.length,
      memory: r.memory.length, edits: editLines,
    });
  }

  /** Отменить всё, что сделало сообщение (последнее, если не указано). */
  undo(u: User, messageId?: number): string {
    const p = persona(u.persona);
    const msg = messageId ? this.store.message(messageId) : this.store.lastDoneMessage(u.id);
    if (!msg || msg.user_id !== u.id) return "Нечего отменять.";
    const acts = this.store.actionsOf(msg.id);
    if (!acts.length) return "Нечего отменять.";
    const s = this.store;
    s.transaction(() => {
      for (const a of acts) {
        const before = a.before_json ? JSON.parse(a.before_json) : null;
        if (a.tbl === "diary") s.setDiaryDeleted(a.row_id, true);
        else if (a.tbl === "events") {
          s.cancelReminders("event", a.row_id);
          if (a.kind === "add") s.updateEvent(a.row_id, { status: "deleted" });
          else if (before) {
            s.updateEvent(a.row_id, before);
            const ev = s.event(a.row_id);
            if (ev?.status === "active") planEventReminders(s, u, ev, new Date());
          }
        } else if (a.tbl === "tasks") {
          if (a.kind === "add") s.updateTask(a.row_id, { status: "deleted" });
          else if (before) s.updateTask(a.row_id, before);
        } else if (a.tbl === "dates") s.setDateStatus(a.row_id, a.kind === "add" ? "deleted" : before?.status ?? "active");
        else if (a.tbl === "memory") s.setMemoryStatus(a.row_id, a.kind === "add" ? "superseded" : before?.status ?? "active");
        s.markUndone(a.id);
      }
    });
    return p.undone;
  }

  /** «Это просто заметка»: отменить разбор и записать текст целиком в заметки. */
  asNote(u: User, messageId: number, at = new Date()): string {
    const msg = this.store.message(messageId);
    if (!msg || msg.user_id !== u.id) return "Не нашла сообщение.";
    this.undo(u, messageId);
    this.store.transaction(() => {
      const id = this.store.addDiary(u.id, msg.day_key, "notes", msg.text, msg.id);
      this.store.logAction(u.id, msg.id, "add", "diary", id);
      const sid = this.store.addDiary(u.id, msg.day_key, "summary", `[${timeOf(at, u.tz)}] ${msg.text}`, msg.id);
      this.store.logAction(u.id, msg.id, "add", "diary", sid);
    });
    return "Записала целиком в заметки.";
  }

  private async answer(u: User, r: Parsed, question: string, today: string): Promise<string> {
    const range = r.lookup ?? { from: addDays(today, -7), to: today };
    const data = diaryDigest(this.store, u, range.from, range.to);
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
    const mem = this.store.activeMemory(u.id).map((m) => `${m.subject ? m.subject + ": " : ""}${m.text}`).join("\n");
    try {
      const out = await this.llm([
        { role: "system", content: `${p.voice}\nЭто просто разговор, ничего не записывай. Сегодня ${today}.\nЧто знаешь о собеседнике:\n${mem || "почти ничего"}` },
        ...this.history(u.id, msg.id),
        { role: "user", content: msg.text },
      ], { temperature: 0.7 });
      const text = esc(out.trim());
      this.store.setMessage(msg.id, { state: "done", reply: text });
      return { text, emotion: "neutral", messageId: msg.id, undoable: false };
    } catch (e) {
      console.error("[chat]", e);
      this.store.setMessage(msg.id, { state: "failed" });
      return { text: p.failed, emotion: "worried", messageId: msg.id, undoable: false };
    }
  }
}
