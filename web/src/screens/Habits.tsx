import { type CSSProperties, type PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { get, post } from "../api";
import { Card, Empty, Spinner } from "../components";
import { WEEKDAYS, addMonths, monthTitle, plainReply, shortDay, todayKey } from "../format";
import { prefill } from "../Composer";
import { navigate } from "../router";
import { cellFill, cellKind, clickMark, daysText, fireTier, monthTally, perDayText, scheduleFrom, timesText } from "../habitpanel";
import { cellTitle, daysBetween, finishedSummary, habitPlace } from "../habitview";
import type { HabitFinished, HabitMarkReply, HabitMonth } from "../types";
import { HabitStatsPanel } from "./HabitStats";

// Привычки (27.11.2026 — макет «Привычки: месяц сеткой», цвета — зелёный и красный с 28.11.2026, в сделанных клетках ✓): сетка месяца (строка — привычка, столбец — день),
// у клетки три состояния — сделано (залита), пропуск (штриховка), отмечено не всё (×N: заполнена снизу, «5/8»). Щелчок отмечает
// (обычная: сделал → пропуск → сделал; ×N: всегда +1 — пропуск только кнопкой в панели), правый клик или долгое нажатие — минус
// одна отметка.
// Название раскрывает привычку строкой под ней (одна за раз, HabitStats.tsx): отметка за сегодня, 🔔 время и «раз в день»,
// 🏁 Завершить, «Во сколько отмечали» и остальные блоки. Адрес «/habits?h=12» (из виджета на ПК) — привычка раскрыта сразу,
// строка подсвечена волной. «🏁 Завершить» уносит привычку в «Завершённые» (карточка под сеткой, «↺ Вернуть»), с «↩ Отменить».

const WEEK_SHORT = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];
/** Срок привычки с концом: «день 3 из 7 · до 18 ноя»; ещё не началась — «с …». Бессрочная — пусто. Закончившиеся в сетку
 *  не приходят — они в «Завершённых». */
function spanText(h: { start_date: string; end_date: string | null }, today: string): string {
  if (!h.end_date) return "";
  if (today < h.start_date) return `с ${shortDay(h.start_date)} до ${shortDay(h.end_date)}`;
  return `день ${daysBetween(h.start_date, today) + 1} из ${daysBetween(h.start_date, h.end_date) + 1} · до ${shortDay(h.end_date)}`;
}
/** Расписание словами: «каждый день», «по будням», «по выходным», «пн, ср, пт»; не видно по месяцу — пусто. */
function scheduleWords(days: string | null): string {
  if (!days) return "";
  if (days === "1234567") return "каждый день";
  if (days === "12345") return "по будням";
  if (days === "67") return "по выходным";
  return days.split("").map((c) => WEEK_SHORT[Number(c) - 1]).join(", ");
}
const NEW_HABIT = "каждый день ";
const HINT = "Наведите или коснитесь клетки, чтобы увидеть день. Щелчок отмечает (у ×N — ещё одна отметка), правый клик или долгое нажатие убирает последнюю.";
/** Раскрыты ли «Завершённые» — запоминается в браузере. */
const DONE_OPEN_KEY = "maid.habitsDone";
const readDoneOpen = () => { try { return localStorage.getItem(DONE_OPEN_KEY) === "1"; } catch { return false; } };
const saveDoneOpen = (v: boolean) => { try { localStorage.setItem(DONE_OPEN_KEY, v ? "1" : "0"); } catch { /* браузер не даёт хранить — не страшно */ } };
type Note = { text: string; undo?: number; bad?: boolean };
type Row = HabitMonth["habits"][number];
type Day = Row["days"][number];
/** Привычка из адреса «?h=12» — какую раскрыть и подсветить; нет или мусор — null. */
export function habitFromSearch(search: string): number | null {
  const m = /^\d{1,9}$/.exec(new URLSearchParams(search).get("h") ?? "");
  return m ? Number(m[0]) : null;
}
/** Число в клетке: 35, 1,2к — чтобы влезло в квадрат. */
export const shortNum = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1).replace(".", ",")}к` : String(Math.round(v * 10) / 10).replace(".", ","));
/** Полное число для итогов: 1 542, 2,5. */
export const fullNum = (v: number) => (Math.round(v * 10) / 10).toLocaleString("ru-RU");
/** Итог месяца по числам из слов человека («прочитал 35 страниц») — в единице последнего числа; чисел нет — null. */
function monthAmount(days: Day[]): { sum: number; unit: string } | null {
  const withNum = days.filter((x) => x.amount != null);
  if (!withNum.length) return null;
  const unit = withNum.at(-1)!.unit ?? "";
  return { sum: withNum.filter((x) => (x.unit ?? "") === unit).reduce((a, x) => a + (x.amount ?? 0), 0), unit };
}
/** Ближайший предок, который прокручивается по вертикали (у приложения это не всегда окно). */
function scroller(el: HTMLElement | null): HTMLElement | Window {
  for (let p = el?.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if ((o === "auto" || o === "scroll") && p.scrollHeight > p.clientHeight) return p;
  }
  return window;
}
/** Строка-подсказка над сеткой со своим состоянием: наведение на клетку не перерисовывает всю сетку и раскрытую панель. */
function InfoLine({ api }: { api: { current: (t: string) => void } }) {
  const [text, setText] = useState("");
  useEffect(() => { api.current = setText; return () => { api.current = () => {}; }; }, [api]);
  return <p className="hg-info" aria-live="polite">{text || HINT}</p>;
}
const FIRE = <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5c.8 3.6 5.5 5.8 5.5 11a5.5 5.5 0 0 1-11 0c0-2.4 1.1-4 2.4-5.3.2 1.7 1 2.8 2.2 3.3-.1-3.4.9-6.2.9-9z" /></svg>;

export function Habits({ month, version, onChanged }: { month?: string; version: number; onChanged: () => void }) {
  const today = todayKey();
  const current = month ?? today.slice(0, 7);
  const [data, setData] = useState<HabitMonth | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [stats, setStats] = useState<number | null>(null);
  const [flash, setFlash] = useState<number | null>(null);
  const info = useRef<(t: string) => void>(() => {});
  const setInfo = (t: string) => info.current(t);
  const want = useRef(habitFromSearch(location.search));
  // Завершённую по «?h=» прокрутить, когда «Завершённые» и её статистика уже раскрыты в DOM (эффект ниже по doneOpen/doneStats).
  const scrollDone = useRef<number | null>(null);
  const [doneOpen, setDoneOpen] = useState(readDoneOpen);
  const [doneStats, setDoneStats] = useState<number | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [bump, setBump] = useState<string | null>(null);
  const timer = useRef(0);
  // Долгое нажатие пальцем — минус одна отметка; следующий за ним щелчок не считается.
  const press = useRef(0);
  const pressedAt = useRef(0);
  // Раскрыли другую привычку — строка, по которой щёлкнули, остаётся на месте экрана (прежняя панель над ней сворачивается).
  const keep = useRef<{ id: number; top: number } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const seenToday = useRef(false);
  useEffect(() => () => { clearTimeout(timer.current); clearTimeout(press.current); }, []);
  function say(n: Note) {
    setNote(n);
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setNote(null), 8000);
  }

  useEffect(() => {
    let alive = true;
    get<HabitMonth>(`/api/habits?month=${current}`).then((d) => alive && setData(d)).catch((e) => alive && setError((e as Error).message));
    return () => { alive = false; };
  }, [current, version]);

  // Щелчок: обычная — пусто → сделал → пропуск → сделал …; ×N — всегда ещё одна отметка (clickMark).
  // minus — правый клик или долгое нажатие: снять последнюю отметку (или пропуск). Сервер не даёт отметить удалённую, завершённую
  // и день до начала — показываем его ответ.
  function mark(h: Row, x: Day, minus = false) {
    return send(h, minus ? { step: -1, day: x.day } : { ...clickMark({ status: x.status, need: x.need ?? h.per_day }), day: x.day });
  }
  /** Отметка с явным телом (кнопки панели: «Сделано», «Пропуск», +1 — без угадывания по щелчку). */
  async function send(h: Row, body: { status: "done" | "skipped"; day: string } | { step: 1 | -1; day: string }) {
    try {
      const r = await post<HabitMarkReply>(`/api/habits/${h.id}/mark`, body);
      setInfo(plainReply(r.text));
      // ×N: норма набрана этой отметкой — клетка «вздрагивает» (hg-bump в styles.css).
      if ("step" in body && body.step === 1 && r.need > 1 && r.status === "done" && r.count >= r.need) {
        setBump(`${h.id}:${body.day}`);
        window.setTimeout(() => setBump(null), 700);
      }
      onChanged();
    } catch (e) {
      say({ text: `Не отметилось: ${(e as Error).message}`, bad: true });
    }
  }
  function longPress(e: ReactPointerEvent<HTMLButtonElement>, h: Row, x: Day) {
    clearTimeout(press.current);
    if (e.pointerType === "mouse") return;
    press.current = window.setTimeout(() => { pressedAt.current = Date.now(); mark(h, x, true); }, 550);
  }
  const endPress = () => clearTimeout(press.current);

  // «🏁 Завершить» и «↺ Вернуть» — без вопроса, но с «↩ Отменить» (сервер пишет правку в журнал отмены).
  async function edit(h: { id: number; title: string }, body: { finish: true } | { reopen: true }) {
    if (busy !== null) return;
    setBusy(h.id);
    try {
      const r = await post<{ undo: number | null }>(`/api/habits/${h.id}`, body);
      if ("finish" in body) {
        if (stats === h.id) setStats(null);
        if (editing === h.id) setEditing(null);
      } else if (doneStats === h.id) setDoneStats(null);
      say({ text: "finish" in body ? `«${h.title}» — в «Завершённых»` : `«${h.title}» снова идёт`, ...(r.undo ? { undo: r.undo } : {}) });
      onChanged();
    } catch (e) {
      say({ text: `Не получилось: ${(e as Error).message}`, bad: true });
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
  function toggleDone(open: boolean) {
    setDoneOpen(open);
    saveDoneOpen(open);
  }
  /** Раскрыть привычку (одна за раз) или свернуть (null). */
  function expand(id: number | null, from?: HTMLElement) {
    if (id !== null && from) keep.current = { id, top: from.getBoundingClientRect().top };
    if (id !== stats) setEditing(null);
    setStats(id);
  }
  useLayoutEffect(() => {
    const k = keep.current;
    keep.current = null;
    if (!k || stats !== k.id) return;
    const row = document.querySelector<HTMLElement>(`[data-habit-row="${k.id}"]`);
    if (!row) return;
    const dy = row.getBoundingClientRect().top - k.top;
    if (Math.abs(dy) > 1) scroller(row).scrollBy(0, dy);
  }, [stats]);
  // Esc сворачивает раскрытую привычку и возвращает фокус на её название.
  useEffect(() => {
    if (stats === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const id = stats;
      setStats(null);
      setEditing(null);
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-habit-row="${id}"]`)?.focus());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stats]);
  // На узком экране сетка прокручивается вбок — открыть её на сегодняшнем дне (один раз).
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el || seenToday.current || el.scrollWidth <= el.clientWidth) return;
    const td = el.querySelector<HTMLElement>(".hg-day.today");
    const nm = el.querySelector<HTMLElement>(".hg-corner");
    if (!td) return;
    seenToday.current = true;
    el.scrollLeft += td.getBoundingClientRect().left - el.getBoundingClientRect().left - (nm?.offsetWidth ?? 150) - 24 * 4;
  }, [data]);

  // Пришли из виджета по «?h=12»: раскрыть привычку, прокрутить к строке и подсветить её; адрес — снова чистый «/habits».
  // Завершённая — раскрыть «Завершённые» и её статистику, прокрутить к ней.
  useEffect(() => {
    const id = want.current;
    if (!data || id == null) return;
    want.current = null;
    history.replaceState(null, "", location.pathname);
    const place = habitPlace(data, id);
    if (place === "finished") {
      setDoneOpen(true);
      setDoneStats(id);
      scrollDone.current = id;
      return;
    }
    if (place !== "grid") return;
    setStats(id);
    setFlash(id);
    requestAnimationFrame(() => document.querySelector(`[data-habit-row="${id}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" }));
    const t = setTimeout(() => setFlash(null), 2600);
    return () => clearTimeout(t);
  }, [data]);
  useEffect(() => {
    const id = scrollDone.current;
    if (id == null || !doneOpen || doneStats !== id) return;
    scrollDone.current = null;
    requestAnimationFrame(() => document.querySelector(`[data-habit-row="${id}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" }));
  }, [doneOpen, doneStats]);

  if (error) return <Empty>Нет связи: {error}</Empty>;
  if (!data) return <Spinner />;

  const days = data.habits[0]?.days.map((d) => d.day) ?? [];
  const doneToday = data.today.filter((t) => t.status === "done").length;
  const all = data.habits.reduce((n, h) => { const t = monthTally(h.days, today); return { done: n.done + t.done, due: n.due + t.due }; }, { done: 0, due: 0 });
  const go = (m: string) => navigate(m === today.slice(0, 7) ? "/habits" : `/habits/${m}`);
  const isNow = current === today.slice(0, 7);
  // Колонки: на ПК клетки тянутся, на телефоне (styles.css, до 720 px) — по 24 px, сегодня шире (40 px), чтобы попадать пальцем.
  const cols = {
    "--hg-wide": `minmax(170px, 240px) repeat(${days.length}, minmax(18px, 1fr)) 64px`,
    "--hg-narrow": `150px ${days.map((d) => (d === today ? "40px" : "24px")).join(" ")} 56px`,
  } as CSSProperties;

  return (
    <div className="screen habits">
      <div className="day-nav">
        <button className="ghost" onClick={() => go(addMonths(current, -1))} aria-label="Прошлый месяц">‹</button>
        <h2 className="screen-title">{monthTitle(current)}</h2>
        <button className="ghost" onClick={() => go(addMonths(current, 1))} aria-label="Следующий месяц">›</button>
      </div>

      <div className="hg-sum">
        {isNow && data.today.length > 0 && <span>Сегодня сделано <b>{doneToday} из {data.today.length}</b></span>}
        <button className="ghost hg-add" onClick={() => prefill(NEW_HABIT)} title="Напишите в строке ввода, что и когда: «каждый день в 8:00 зарядка», «по будням читать 20 минут до конца года»">+ Привычка</button>
      </div>

      {note && (
        <div className={`task-note hg-note ${note.bad ? "bad" : ""}`} role="status">
          <span className="grow">{note.text}</span>
          {note.undo !== undefined && <button className="link" onClick={() => undo(note.undo!)}>↩ Отменить</button>}
        </div>
      )}

      {data.habits.length === 0 ? (
        <Card className="reveal"><Empty>{data.finished?.length ? "Идущих привычек нет — завершённые ниже." : "Привычек пока нет."} Напишите, например: «каждый будний день в 7:30 зарядка до конца года»</Empty></Card>
      ) : (
        <Card className="reveal wide hg-card">
          <div className="hg-head">
            <p className="hg-month">
              <b>{monthTitle(current)}</b>
              {all.due > 0 && <span className="muted"> · {isNow ? "до сегодня выполнено" : "выполнено"} <b className="num">{Math.round((all.done / all.due) * 100)} %</b></span>}
            </p>
            <ul className="hg-leg" aria-label="Обозначения">
              <li><i className="hg-cell" data-s="done"><b className="hg-ok">✓</b></i>сделано</li>
              <li><i className="hg-cell" data-s="skip" />пропуск</li>
              <li><i className="hg-cell" data-s="part"><i className="hg-fill" style={{ height: "50%" }} /></i>отмечено не всё</li>
            </ul>
          </div>
          <InfoLine api={info} />
          <div className="hg-wrap" ref={wrap}>
            <div className="habit-grid" style={cols}>
              <span className="hg-corner">Привычка</span>
              {days.map((d) => {
                const wd = WEEK_SHORT[(new Date(d).getDay() + 6) % 7];
                return (
                  <span key={d} className={`hg-day ${d === today ? "today" : ""} ${wd === "сб" || wd === "вс" ? "weekend" : ""}`} title={WEEKDAYS[(new Date(d).getDay() + 6) % 7]}>
                    <i>{wd}</i>{Number(d.slice(-2))}
                  </span>
                );
              })}
              <span className="hg-day hg-tot-h">Итог</span>
              {data.habits.map((h) => {
                const per = h.per_day ?? 1;
                const tally = monthTally(h.days, today);
                const fire = data.today.find((t) => t.habit.id === h.id)?.streak ?? 0;
                const ask = data.ask ?? { first: "12:00", last: "23:00" };
                const shown = h.times.length ? h.times : [ask.first];
                const span = spanText(h, today);
                const much = monthAmount(h.days);
                const sub = [perDayText(per), span, much ? `за месяц ${fullNum(much.sum)}${much.unit && ` ${much.unit}`}` : ""].filter(Boolean);
                // Строки расписания в ответе нет (days — клетки месяца): берём по клеткам срока.
                const schedule = scheduleFrom(h.days.filter((x) => x.day >= h.start_date && (!h.end_date || x.day <= h.end_date)));
                const words = scheduleWords(schedule);
                const tx = isNow ? h.days.find((x) => x.day === today) : undefined;
                const opened = stats === h.id;
                return [
                  <button
                    key={`t${h.id}`} type="button" className={`hg-title ${flash === h.id ? "hg-flash" : ""}`} data-habit-row={h.id} data-t={fireTier(fire)}
                    aria-expanded={opened} aria-controls={opened ? `hp-${h.id}` : undefined} onClick={(e) => expand(opened ? null : h.id, e.currentTarget)}
                    aria-label={`${h.title}${per > 1 ? `, ${timesText(per)} в день` : ""}. Серия ${daysText(fire)}, за месяц ${tally.done} из ${tally.due}. ${opened ? "Свернуть" : "Показать подробности"}`}
                  >
                    <svg className="hg-ar" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
                    <span className="hg-nt">
                      <span className="hg-tl"><b title={h.title}>{h.title}</b>{per > 1 && <span className="hg-x" aria-hidden="true">×{per}</span>}</span>
                      <small title={sub.join(" · ")}><span className="hg-fr">{FIRE}{daysText(fire)}</span>{sub.map((x) => ` · ${x}`).join("")}</small>
                    </span>
                  </button>,
                  ...h.days.map((x, k) => {
                    const one = { ...x, need: x.need ?? per };
                    const kind = cellKind(one, today, h.start_date);
                    const label = kind === "part" ? `${x.count}/${one.need}` : kind === "done" && x.amount != null ? shortNum(x.amount) : "";
                    const title = cellTitle(one);
                    // Сегодня — что сделает нажатие (как в макете): у ×N — ещё отметка, у обычной — отметить или сменить отметку.
                    const now = x.day === today ? `Сегодня. ${title}. Нажмите, чтобы ${per > 1 ? "добавить отметку" : x.status ? "сменить отметку" : "отметить"}` : title;
                    return (
                      <button
                        key={`${h.id}-${x.day}`} type="button" data-s={kind}
                        style={flash === h.id ? { animationDelay: `${k * 22}ms` } : undefined}
                        className={`hg-cell ${flash === h.id ? "hg-flash" : ""} ${x.day === today ? "today" : ""} ${kind === "part" ? "pt" : ""} ${bump === `${h.id}:${x.day}` ? "pt-full" : ""}`}
                        disabled={x.day > today || x.day < h.start_date}
                        onClick={() => { if (Date.now() - pressedAt.current > 800) mark(h, x); }}
                        onContextMenu={(e) => { e.preventDefault(); endPress(); if (Date.now() - pressedAt.current < 1000) return; pressedAt.current = Date.now(); mark(h, x, true); }}
                        onPointerDown={(e) => longPress(e, h, x)} onPointerUp={endPress} onPointerLeave={endPress} onPointerCancel={endPress}
                        onMouseEnter={() => setInfo(`${h.title} · ${title}`)} onFocus={() => setInfo(`${h.title} · ${title}`)}
                        title={title} aria-label={`${h.title} · ${now}`}
                      >
                        {per > 1 && <i className="hg-fill" style={{ height: `${cellFill(one) * 100}%` }} />}
                        {label ? <em>{label}</em> : kind === "done" && <b className="hg-ok" aria-hidden="true">✓</b>}
                      </button>
                    );
                  }),
                  <span key={`n${h.id}`} className="hg-tot"><b>{tally.done}</b> из {tally.due}</span>,
                  ...(opened ? [
                    <HabitStatsPanel
                      key={`s${h.id}`} id={h.id} version={version} habit={{ days: schedule, per_day: per, count: tx?.count ?? 0 }} onChanged={onChanged}
                      head={
                        <>
                          <div className="hp-top">
                            <p className="hp-subl">
                              <b>{h.title}</b>{words && ` · ${words}`}{per > 1 && ` · ${timesText(per)} в день`}
                              {" · "}{h.quiet ? "без напоминаний" : `${shown.length > 1 ? "напоминания" : "напоминание"} в ${shown.join(", ")}`}
                              {span && ` · ${span}`}
                            </p>
                            <div className="hp-acts">
                              {tx && today >= h.start_date && (per > 1 ? (
                                <span className="hp-step" role="group" aria-label="Отметки за сегодня">
                                  <button disabled={!tx.count && tx.status !== "skipped"} onClick={() => mark(h, tx, true)} aria-label="Убрать последнюю отметку">−1</button>
                                  <span className="hp-cnt" aria-live="polite">{tx.status === "skipped" ? "пропуск" : `${tx.count ?? 0} из ${per}`}</span>
                                  <button className="primary" disabled={tx.status === "done"} onClick={() => send(h, { step: 1, day: tx.day })} aria-label="Добавить отметку">+1</button>
                                  {!tx.count && tx.status !== "skipped" && <button onClick={() => send(h, { status: "skipped", day: tx.day })} title="Сегодня не буду: пропуск, серия прервётся">Пропуск</button>}
                                </span>
                              ) : (
                                <span className="segment" role="group" aria-label="Отметка за сегодня">
                                  <button className={tx.status === "done" ? "on" : ""} aria-pressed={tx.status === "done"} onClick={() => tx.status !== "done" && send(h, { status: "done", day: tx.day })}>Сделано</button>
                                  <button className={tx.status === "skipped" ? "on" : ""} aria-pressed={tx.status === "skipped"} onClick={() => tx.status !== "skipped" && send(h, { status: "skipped", day: tx.day })}>Пропуск</button>
                                  <button className={!tx.status ? "on" : ""} aria-pressed={!tx.status} onClick={() => tx.status && mark(h, tx, true)}>Не отмечено</button>
                                </span>
                              ))}
                              <button
                                className={`hg-bell ${editing === h.id ? "on" : ""}`} aria-expanded={editing === h.id}
                                onClick={() => setEditing(editing === h.id ? null : h.id)}
                                title={h.quiet ? "Без напоминаний" : `Напомнит в ${shown.join(", ")}${h.times.length ? "" : " (общее время из «Настроек»)"}${shown.some((t) => t >= ask.last) ? "" : `; не отметите — ещё раз в ${ask.last}`}. Щелчок — изменить время и сколько раз в день`}
                              >
                                {h.quiet ? "🔕 без напоминаний" : `🔔 ${shown.join(", ")}`}
                              </button>
                              <button className="hg-bell" disabled={busy === h.id} onClick={() => edit(h, { finish: true })} title="Завершить привычку: уйдёт из сетки в «Завершённые» со всеми отметками" aria-label="Завершить привычку">
                                🏁
                              </button>
                              <button className="ghost hp-close" onClick={() => expand(null)} aria-label="Свернуть привычку" title="Свернуть (Esc)">
                                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 15l6-6 6 6" /></svg>
                              </button>
                            </div>
                          </div>
                          {editing === h.id && (
                            <HabitTimes id={h.id} times={h.times} quiet={!!h.quiet} perDay={per} ask={ask} onDone={() => { setEditing(null); onChanged(); }} onCancel={() => setEditing(null)} />
                          )}
                        </>
                      }
                    />,
                  ] : []),
                ];
              })}
            </div>
          </div>
          <p className="muted small hg-foot">Щелчок по клетке — «сделал», ещё раз — «пропуск»; у «несколько раз в день» (×N) — ещё одна отметка (пропуск у ×N — кнопкой в раскрытой привычке, пока отметок нет). Правый клик или долгое нажатие — убрать последнюю. Огонёк — серия: сколько запланированных дней подряд сделано. Название раскрывает привычку: время отметок, серия, 🔔 напоминания и «раз в день», 🏁 завершить. Число в клетке — сколько сделали, если написали горничной: «прочитал 35 страниц».</p>
        </Card>
      )}

      {!!data.finished?.length && (
        <Card className="reveal hg-done">
          <details open={doneOpen} onToggle={(e) => toggleDone((e.currentTarget as HTMLDetailsElement).open)}>
            <summary><b>Завершённые ({data.finished.length})</b></summary>
            <ul className="hg-done-list">
              {data.finished.map((f) => (
                <FinishedRow key={f.id} f={f} open={doneStats === f.id} busy={busy === f.id} version={version}
                  onStats={() => setDoneStats(doneStats === f.id ? null : f.id)} onReopen={() => edit(f, { reopen: true })} />
              ))}
            </ul>
          </details>
        </Card>
      )}
    </div>
  );
}

/** Строка «Завершённых»: «Название · 3 окт – 25 ноя · 42 из 50 (84 %)», «📊 Статистика» (панель под строкой) и «↺ Вернуть». */
function FinishedRow({ f, open, busy, version, onStats, onReopen }: {
  f: HabitFinished; open: boolean; busy: boolean; version: number; onStats: () => void; onReopen: () => void;
}) {
  return (
    <li className="hg-done-row" data-habit-row={f.id}>
      <div className="hg-done-head">
        <span className="hg-done-text"><b>{f.title}</b><span className="muted"> · {finishedSummary(f)}</span></span>
        <span className="hg-done-tools">
          <button className={`hg-bell ${open ? "on" : ""}`} onClick={onStats} title="Статистика привычки за её срок">📊 {open ? "Скрыть" : "Статистика"}</button>
          <button className="hg-bell" disabled={busy} onClick={onReopen} title="Вернуть в сетку: привычка снова идёт, без конца срока">↺ Вернуть</button>
        </span>
      </div>
      {open && <HabitStatsPanel key={`d${f.id}`} id={f.id} version={version} finished />}
    </li>
  );
}

/** Время напоминаний и «раз в день» одной привычки — под верхней строкой раскрытой привычки. Пусто — общее время из «Настроек». */
function HabitTimes({ id, times, quiet, perDay, ask, onDone, onCancel }: {
  id: number; times: string[]; quiet: boolean; perDay: number; ask: { first: string; last: string }; onDone: () => void; onCancel: () => void;
}) {
  const [list, setList] = useState<string[]>(quiet ? [] : times.length ? times : [ask.first]);
  const [per, setPer] = useState(String(perDay));
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState("");
  const valid = list.filter((t) => /^\d\d:\d\d$/.test(t));
  const n = Number(per);
  const perOk = Number.isInteger(n) && n >= 1 && n <= 12;
  // per_day — только если поменяли (сервер пересчитает сегодняшнюю отметку, прошлые дни — как были).
  const perPatch = perOk && n !== perDay ? { per_day: n } : {};
  // Все времена убраны — «Сохранить» выключает напоминания у этой привычки.
  const off = list.length === 0;
  async function save(next: string[], general = false) {
    setBusy(true);
    setFail("");
    try {
      // Пустой список крестиками — без напоминаний; время или «Как в настройках» — напоминания снова включены.
      await post(`/api/habits/${id}`, { ...(off && !general ? { times: [], quiet: true } : quiet ? { times: next, quiet: false } : { times: next }), ...perPatch });
      onDone();
    } catch (e) {
      setFail((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <div className="hg-times">
      {!off && <span className="muted small">Напомнить в</span>}
      {list.map((t, i) => (
        <span key={i} className="hg-time">
          <input type="time" value={t} onChange={(e) => setList(list.map((x, j) => (j === i ? e.target.value : x)))} aria-label={`Время ${i + 1}`} />
          <button className="ghost" onClick={() => setList(list.filter((_, j) => j !== i))} aria-label="Убрать время" title="Убрать время">×</button>
        </span>
      ))}
      {off && <span className="small">🔕 без напоминаний</span>}
      {list.length < 4 && <button className="ghost" onClick={() => setList([...list, list.at(-1) ?? ask.first])}>{off ? "+ время" : "+ ещё время"}</button>}
      <label className="hg-per small">
        <input type="number" min={1} max={12} step={1} value={per} onChange={(e) => setPer(e.target.value)} aria-invalid={!perOk} />
        раз в день
      </label>
      <span className="grow" />
      <button className="primary" disabled={busy || !perOk || (!off && !valid.length)} onClick={() => save(valid)}>Сохранить</button>
      {(times.length > 0 || quiet) && <button className="ghost" disabled={busy || !perOk} onClick={() => save([], true)} title={`${ask.first} и ${ask.last} — меняется в «Настройках»`}>Как в настройках</button>}
      <button className="ghost" disabled={busy} onClick={onCancel}>Отмена</button>
      <span className="muted small hg-times-hint">
        {off ? "Горничная не будет спрашивать про эту привычку — отмечайте сами. «+ время» вернёт напоминания." : <>{quiet && "Сейчас напоминаний нет — «Сохранить» их включит. "}Не отметите — спросит ещё раз в {ask.last}. Общее время — в «Настройках».</>}
        {" "}«Раз в день» больше 1 — клетка заполняется по отметкам («5/8»); новая норма — с сегодняшнего дня.{fail && <b style={{ color: "var(--red)" }}> {fail}</b>}
      </span>
    </div>
  );
}
