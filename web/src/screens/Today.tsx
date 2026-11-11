import { useEffect, useRef, useState } from "react";
import { get, post } from "../api";
import { Card, Chip, Empty, Spinner } from "../components";
import { SECTIONS, SECTION_ORDER, dateWhen, dur, metricText, money, parts, shortDay } from "../format";
import { navigate } from "../router";
import type { EventRow, HabitToday, TaskRow, TodayData } from "../types";

// «Сегодня» — как панель виджета ПК: сверху «что сейчас» с горничной и полосой дня; задачи (квадратная галочка, срок справа,
// просроченное сверху, дальние спят до недели, «+ Новая задача»); план дня и привычки; строка фактов. Ниже — даты и дневник.

/** Задача со сроком дальше стольких дней «спит»: в списке её нет, пока срок не подойдёт (как TASK_WAKE в виджете). */
const TASK_WAKE = 7;
const WD_SHORT = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const MONTH_SHORT = ["янв", "февр", "марта", "апр", "мая", "июня", "июля", "авг", "сент", "окт", "нояб", "дек"];

const daysFrom = (a: string, b: string) => Math.round((parts(b).date.getTime() - parts(a).date.getTime()) / 864e5);
const hm = (t: string) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const live = (e: EventRow) => e.status !== "cancelled" && e.status !== "deleted";

export function Today({ version, onChanged }: { version: number; onChanged: () => void }) {
  const [data, setData] = useState<TodayData | null>(null);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let alive = true;
    get<TodayData>("/api/today").then((d) => alive && setData(d)).catch((e) => alive && setError((e as Error).message));
    return () => { alive = false; };
  }, [version]);
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  if (error && !data) return <Empty>Нет связи с сервером: {error}</Empty>;
  if (!data) return <Spinner />;
  const d = data;
  const nowMin = now.getHours() * 60 + now.getMinutes();

  const bySection = new Map<string, typeof d.diary>();
  for (const r of d.diary) bySection.set(r.section, [...(bySection.get(r.section) ?? []), r]);
  const sections = [...bySection.keys()].sort((a, b) => SECTION_ORDER.indexOf(a) - SECTION_ORDER.indexOf(b));

  return (
    <div className="screen today">
      <NowCard d={d} nowMin={nowMin} />
      <div className="today-grid">
        <Tasks d={d} onChanged={onChanged} />
        <Card className="reveal day-side">
          <DayPlan d={d} nowMin={nowMin} />
          <Daily habits={d.habits} day={d.day} onChanged={onChanged} />
        </Card>
      </div>
      <Facts d={d} />

      {(d.dates.length > 0 || sections.length > 0) && (
        <div className="cards">
          {d.dates.length > 0 && (
            <Card title="Важные даты" className="reveal">
              <ul className="list">
                {d.dates.slice(0, 8).map((x) => (
                  <li key={x.id}>
                    <span className="time">{shortDay(x.on)}</span>
                    <span className="grow">{x.title}{x.age ? <span className="muted"> · {x.age}</span> : null}</span>
                    <Chip tone={x.inDays <= 1 ? "accent" : ""}>{dateWhen(x.inDays)}</Chip>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {sections.length > 0 && (
            <Card title="Дневник" className="reveal wide" action={<button className="link" onClick={() => navigate(`/diary/${d.day}`)}>Все дни</button>}>
              <div className="diary-sections">
                {sections.map((s) => (
                  <div key={s} className="diary-section">
                    <b>{SECTIONS[s] ?? s}</b>
                    <ul>{bySection.get(s)!.map((r) => <li key={r.id}>{r.text}</li>)}</ul>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

// --- «что сейчас» ---

function NowCard({ d, nowMin }: { d: TodayData; nowMin: number }) {
  const timed = d.events.filter((e) => live(e) && e.time).sort((a, b) => hm(a.time!) - hm(b.time!));
  const running = timed.find((e) => hm(e.time!) <= nowMin && e.end_time && hm(e.end_time) > nowMin);
  const next = timed.find((e) => hm(e.time!) > nowMin);
  const soon = d.upcoming.find(live);

  const title = running ? `Сейчас: ${running.title}`
    : next ? `${next.title} через ${until(hm(next.time!) - nowMin)}`
    : soon ? `${daysFrom(d.day, soon.date_iso) === 1 ? "Завтра" : shortDay(soon.date_iso)}${soon.time ? ` в ${soon.time}` : ""} — ${soon.title}`
    : "Свободный день";

  const open = awakeTasks(d.tasks, d.day);
  const overdue = open.filter((t) => t.due_date && t.due_date < d.day);
  const doneHabits = d.habits.filter((h) => h.status === "done").length;
  const bits: string[] = [];
  if (open.length) {
    let s = `Осталось ${open.length} ${plural(open.length, "дело", "дела", "дел")}`;
    if (overdue.length) s += overdue.length === 1 && daysFrom(d.day, overdue[0].due_date!) === -1 ? ", одно со вчера" : `, просрочено ${overdue.length}`;
    bits.push(s);
  } else bits.push("Открытых дел нет");
  if (d.habits.length) bits.push(doneHabits === d.habits.length ? "Все привычки отмечены" : `Привычки ${doneHabits} из ${d.habits.length}`);
  for (const h of d.habits) {
    const c = courseOf(h, d.day);
    if (c?.dayNo) bits.push(`«${h.title}» — день ${c.dayNo} из ${c.len}`);
  }

  const mood = nowMin >= 23 * 60 || nowMin < 6 * 60 ? "sleep"
    : overdue.length ? "remind"
    : !open.length && doneHabits === d.habits.length ? "happy"
    : running || (next && hm(next.time!) - nowMin <= 60) ? "listen" : "idle";

  return (
    <section className="now-card reveal">
      <img className="now-maid" src={`/maid/${mood}.webp`} alt="" />
      <div className="now-body">
        <h2 className="now-title">{title}</h2>
        <p className="now-line">{bits.join(". ")}.</p>
        <DayBar events={timed} nowMin={nowMin} next={next} />
      </div>
    </section>
  );
}

/** Полоса дня: прошедшее закрашено, отметки — планы со временем, ближайший ярче. */
function DayBar({ events, nowMin, next }: { events: EventRow[]; nowMin: number; next?: EventRow }) {
  const from = Math.min(7 * 60, ...events.map((e) => hm(e.time!)));
  const to = 24 * 60;
  const at = (m: number) => `${Math.max(0, Math.min(100, ((m - from) / (to - from)) * 100))}%`;
  return (
    <div className="day-bar" aria-hidden="true">
      <i className="day-bar-past" style={{ width: at(nowMin) }} />
      {events.map((e) => (
        <b key={e.id} className={`day-bar-mark ${e === next ? "next" : hm(e.time!) < nowMin ? "past" : ""}`} style={{ left: at(hm(e.time!)) }} title={`${e.time} ${e.title}`} />
      ))}
      <i className="day-bar-now" style={{ left: at(nowMin) }} />
    </div>
  );
}

function until(min: number) {
  if (min < 60) return `${min} ${plural(min, "минуту", "минуты", "минут")}`;
  const h = Math.round(min / 60);
  return `${h} ${plural(h, "час", "часа", "часов")}`;
}

// --- задачи ---

function awakeTasks(tasks: TaskRow[], day: string) {
  return tasks.filter((t) => !t.due_date || daysFrom(day, t.due_date) <= TASK_WAKE);
}

/** Просроченное сверху (старое первым), потом сегодня и ближайшие сроки, без срока — в конце. */
function sortTasks(tasks: TaskRow[]) {
  return [...tasks].sort((a, b) => (a.due_date ?? "9999").localeCompare(b.due_date ?? "9999") || a.id - b.id);
}

function dueTag(due: string, day: string) {
  const n = daysFrom(day, due);
  const [, m, dd] = due.split("-").map(Number);
  const text = n === -1 ? "вчера" : n === -2 ? "позавчера" : n === 0 ? "сегодня" : n === 1 ? "завтра"
    : n > 1 && n < 7 ? WD_SHORT[parts(due).date.getDay()] : `${dd} ${MONTH_SHORT[m - 1]}`;
  return <span className={`due ${n < 0 ? "over" : n === 0 ? "today" : ""}`}>{text}</span>;
}

type Note = { text: string; undo?: number; bad?: boolean };

function Tasks({ d, onChanged }: { d: TodayData; onChanged: () => void }) {
  const [closing, setClosing] = useState<Set<number>>(new Set());
  const [note, setNote] = useState<Note | null>(null);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [all, setAll] = useState(false);
  const timer = useRef(0);
  const input = useRef<HTMLInputElement>(null);

  // Отмеченная остаётся зачёркнутой, пока сервер не прислал новый список без неё.
  useEffect(() => setClosing((c) => new Set([...c].filter((id) => d.tasks.some((t) => t.id === id)))), [d.tasks]);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => { if (adding) input.current?.focus(); }, [adding]);

  function say(n: Note) {
    setNote(n);
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setNote(null), 8000);
  }

  async function close(t: TaskRow) {
    if (closing.has(t.id)) return;
    setClosing((c) => new Set(c).add(t.id));
    try {
      const r = await post<{ undo: number }>(`/api/tasks/${t.id}`, { status: "done" });
      say({ text: `«${t.title}» — сделано`, undo: r.undo });
      onChanged();
    } catch (e) {
      setClosing((c) => { const n = new Set(c); n.delete(t.id); return n; });
      say({ text: `Не получилось отметить «${t.title}»: ${(e as Error).message}`, bad: true });
    }
  }

  async function undo(id: number) {
    setNote(null);
    try {
      await post("/api/undo", { messageId: id });
      onChanged();
    } catch (e) {
      say({ text: `Не получилось отменить: ${(e as Error).message}`, bad: true });
    }
  }

  async function add() {
    const t = title.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      const r = await post<{ undo: number }>("/api/tasks", { title: t });
      setTitle("");
      say({ text: `Добавила «${t}»`, undo: r.undo });
      onChanged();
    } catch (e) {
      say({ text: `Не получилось добавить задачу: ${(e as Error).message}`, bad: true });
    } finally {
      setBusy(false);
      requestAnimationFrame(() => input.current?.focus());
    }
  }

  const awake = sortTasks(awakeTasks(d.tasks, d.day));
  const later = d.tasks.length - awake.length;
  const shown = all ? sortTasks(d.tasks) : awake.slice(0, 8);
  const hidden = d.tasks.length - shown.length;

  return (
    <Card title="Задачи" className="reveal tasks-card">
      {shown.length > 0 && (
        <ul className="list task-list">
          {shown.map((t) => {
            const done = closing.has(t.id);
            return (
              <li key={t.id} className={`task ${done ? "did" : ""}`}>
                <button className={`box ${done ? "on" : ""}`} onClick={() => close(t)} disabled={done} aria-label={`Сделано: ${t.title}`} title="Сделано">
                  <svg viewBox="0 0 16 16" width="12" height="12"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
                <span className={`grow task-title ${t.priority === "high" ? "high" : ""}`}>{t.title}</span>
                {t.due_date && dueTag(t.due_date, d.day)}
              </li>
            );
          })}
        </ul>
      )}
      {!shown.length && !adding && <Empty>Открытых задач нет</Empty>}
      {hidden > 0 && (
        <button className="link task-more" onClick={() => setAll(true)}>
          и ещё {hidden}{later ? ` — ${later === hidden ? "сроки позже недели" : `из них ${later} позже недели`}` : ""}
        </button>
      )}
      {all && <button className="link task-more" onClick={() => setAll(false)}>свернуть</button>}

      {adding ? (
        <form className="task-new" onSubmit={(e) => { e.preventDefault(); void add(); }}>
          <span className="box" aria-hidden="true" />
          <input
            ref={input} value={title} maxLength={200} placeholder="Новая задача — Enter" disabled={busy} aria-label="Новая задача"
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") { setTitle(""); setAdding(false); } }}
            onBlur={() => { if (!title.trim() && !busy) setAdding(false); }}
          />
        </form>
      ) : (
        <button className="task-add" onClick={() => setAdding(true)}>+ Новая задача</button>
      )}

      {note && (
        <div className={`task-note ${note.bad ? "bad" : ""}`} role="status">
          <span className="grow">{note.text}</span>
          {note.undo !== undefined && <button className="link" onClick={() => undo(note.undo!)}>↩ Отменить</button>}
        </div>
      )}
    </Card>
  );
}

// --- план дня и привычки ---

function DayPlan({ d, nowMin }: { d: TodayData; nowMin: number }) {
  const today = d.events.filter(live).sort((a, b) => (a.time ? hm(a.time) : -1) - (b.time ? hm(b.time) : -1));
  const next = today.find((e) => e.time && hm(e.time) > nowMin);
  const running = today.find((e) => e.time && e.end_time && hm(e.time) <= nowMin && hm(e.end_time) > nowMin);
  const free = running ? `сейчас — до ${running.end_time}` : next ? `свободно до ${next.time}` : today.some((e) => e.time) ? "дальше свободно" : "";
  const soon = d.upcoming.filter(live).slice(0, 3);
  return (
    <div className="side-block">
      <div className="side-head"><h3>План дня</h3><button className="link" onClick={() => navigate("/plans")}>Все</button></div>
      {free && <p className="side-free">{free}</p>}
      {today.length ? (
        <ul className="list plan-list">
          {today.map((e) => (
            <li key={e.id} className={e.time && hm(e.end_time ?? e.time) < nowMin ? "past" : ""}>
              <span className="time">{e.time ?? "день"}</span>
              <span className="grow">{e.title}</span>
            </li>
          ))}
        </ul>
      ) : <p className="muted small side-empty">На сегодня планов нет</p>}
      {soon.length > 0 && (
        <ul className="list plan-list soon">
          {soon.map((e) => (
            <li key={e.id}>
              <span className="time">{daysFrom(d.day, e.date_iso) === 1 ? "завтра" : shortDay(e.date_iso)}</span>
              <span className="grow">{e.title}{e.time && <span className="muted small"> · {e.time}</span>}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Курс («пить Аевит месяц»): сколько сделано из дней по расписанию и какой сегодня день срока. */
function courseOf(h: HabitToday, day: string) {
  if (!h.course?.length) return null;
  const due = h.course.filter((x) => x.s !== "rest");
  const at = h.course.findIndex((x) => x.day === day || x.s === "today");
  return { done: due.filter((x) => x.s === "done").length, total: due.length, len: h.course.length, dayNo: at >= 0 ? at + 1 : null };
}

function Daily({ habits, day, onChanged }: { habits: HabitToday[]; day: string; onChanged: () => void }) {
  const [note, setNote] = useState<Note | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  function say(n: Note) {
    setNote(n);
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setNote(null), 8000);
  }

  // Щелчок по кружку: не отмечено — «сделал»; отмечено (или пропуск) — снять отметку, с «↩ Отменить».
  async function toggle(h: HabitToday) {
    if (busy !== null) return;
    setBusy(h.id);
    try {
      if (h.status) {
        const r = await post<{ undo: number | null }>(`/api/habits/${h.id}/unmark`, {});
        if (r.undo) say({ text: `«${h.title}» — отметка снята`, undo: r.undo });
      } else {
        await post(`/api/habits/${h.id}/mark`, { status: "done" });
        setNote(null);
      }
      onChanged();
    } catch (e) {
      say({ text: `Не получилось ${h.status ? "снять отметку" : "отметить"} «${h.title}»: ${(e as Error).message}`, bad: true });
    } finally {
      setBusy(null);
    }
  }

  async function undo(id: number) {
    setNote(null);
    try {
      await post("/api/undo", { messageId: id });
      onChanged();
    } catch (e) {
      say({ text: `Не получилось отменить: ${(e as Error).message}`, bad: true });
    }
  }

  return (
    <div className="side-block">
      <div className="side-head"><h3>Каждый день</h3><button className="link" onClick={() => navigate("/habits")}>Месяц</button></div>
      {habits.length ? (
        <ul className="list habit-list">
          {habits.map((h) => {
            const c = courseOf(h, day);
            return (
              <li key={h.id} className={`habit ${h.status ?? ""}`}>
                <button className={`dot ${h.status ?? ""}`} onClick={() => toggle(h)} disabled={busy === h.id}
                  title={h.status ? "Снять отметку" : "Сделал"} aria-label={`${h.status ? "Снять отметку" : "Отметить"}: ${h.title}`} />
                <span className="grow">{h.title}</span>
                {c ? <span className="count">{c.done}/{c.total}</span> : h.streak >= 2 ? <span className="count fire">🔥 {h.streak}</span> : null}
              </li>
            );
          })}
        </ul>
      ) : <p className="muted small side-empty">Привычек нет. Напишите, например: «каждый день в 9 пить витамины»</p>}
      {note && (
        <div className={`task-note ${note.bad ? "bad" : ""}`} role="status">
          <span className="grow">{note.text}</span>
          {note.undo !== undefined && <button className="link" onClick={() => undo(note.undo!)}>↩ Отменить</button>}
        </div>
      )}
    </div>
  );
}

// --- строка фактов ---

function Facts({ d }: { d: TodayData }) {
  const metric = (k: string) => d.metrics.find((m) => m.key === k);
  const pcSec = d.activity.reduce((s, a) => s + a.active_sec, 0);
  const gameSec = d.activity.reduce((s, a) => s + a.games.reduce((x, g) => x + g.sec, 0), 0);
  const spent = d.money.filter((m) => m.kind === "expense");
  const facts: [string, string][] = [];
  const sleep = metric("sleep_hours");
  if (sleep) facts.push(["сон", metricText(sleep)]);
  const steps = metric("steps");
  if (steps) facts.push(["шаги", metricText(steps)]);
  const sport = metric("sport_min");
  if (sport) facts.push(["спорт", metricText(sport)]);
  if (pcSec) facts.push(["за ПК", dur(pcSec)]);
  if (gameSec) facts.push(["игры", dur(gameSec)]);
  if (spent.length) facts.push(["потрачено", money(spent.reduce((s, m) => s + m.amount, 0), spent[0].currency)]);
  return (
    <div className="facts reveal">
      {facts.length ? facts.map(([k, v]) => <span key={k} className="fact"><span className="muted">{k}</span> <b>{v}</b></span>)
        : <span className="muted">Сон, шаги и время за ПК появятся, когда вы их запишете</span>}
      <span className="spacer" />
      <button className="link" onClick={() => navigate("/stats")}>Вся статистика</button>
    </div>
  );
}

function plural(n: number, one: string, few: string, many: string) {
  const a = n % 10, b = n % 100;
  return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
}

export function EventList({ events, withDay = false }: { events: EventRow[]; withDay?: boolean }) {
  return (
    <ul className="list">
      {events.map((e) => (
        <li key={e.id}>
          <span className="time">{withDay ? shortDay(e.date_iso) : e.time ? `${e.time}${e.end_time ? `–${e.end_time}` : ""}` : "весь день"}</span>
          <span className="grow">
            {e.title}
            {withDay && e.time && <span className="muted small"> · {e.time}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}
