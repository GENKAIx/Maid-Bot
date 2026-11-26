import { useEffect, useRef, useState } from "react";
import { get, post } from "../api";
import { Card, Chip, Empty, Spinner } from "../components";
import { WEEKDAYS, addMonths, monthTitle, shortDay, todayKey } from "../format";
import { prefill } from "../Composer";
import { navigate } from "../router";
import { cellTitle, daysBetween, finishedSummary, habitPlace } from "../habitview";
import type { HabitFinished, HabitMonth } from "../types";
import { HabitStatsPanel } from "./HabitStats";

// Привычки: сетка месяца (строка — привычка, столбец — день), отметка щелчком, серии и время напоминаний (🔔 — правка прямо в строке),
// щелчок по названию — статистика привычки строкой под ней (HabitStats.tsx). Адрес «/habits?h=12» (из виджета на ПК) —
// статистика этой привычки раскрыта сразу, а её строка подсвечена волной по клеткам. «🏁 Завершить» уносит привычку из сетки
// в «Завершённые» (свёрнутая карточка под сеткой, с итогом за срок, статистикой и «↺ Вернуть»), с «↩ Отменить» (26.11.2026).

const WEEK_SHORT = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];
/** Срок привычки с концом: «день 3 из 7 · до 18 ноя»; ещё не началась — «с …». Бессрочная — пусто. Закончившиеся в сетку
 *  не приходят — они в «Завершённых». */
function spanText(h: { start_date: string; end_date: string | null }, today: string): string {
  if (!h.end_date) return "";
  if (today < h.start_date) return `с ${shortDay(h.start_date)} до ${shortDay(h.end_date)}`;
  return `день ${daysBetween(h.start_date, today) + 1} из ${daysBetween(h.start_date, h.end_date) + 1} · до ${shortDay(h.end_date)}`;
}
const NEW_HABIT = "каждый день ";
/** Раскрыты ли «Завершённые» — запоминается в браузере. */
const DONE_OPEN_KEY = "maid.habitsDone";
const readDoneOpen = () => { try { return localStorage.getItem(DONE_OPEN_KEY) === "1"; } catch { return false; } };
const saveDoneOpen = (v: boolean) => { try { localStorage.setItem(DONE_OPEN_KEY, v ? "1" : "0"); } catch { /* браузер не даёт хранить — не страшно */ } };
type Note = { text: string; undo?: number; bad?: boolean };
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
function monthAmount(days: HabitMonth["habits"][number]["days"]): { sum: number; unit: string } | null {
  const withNum = days.filter((x) => x.amount != null);
  if (!withNum.length) return null;
  const unit = withNum.at(-1)!.unit ?? "";
  return { sum: withNum.filter((x) => (x.unit ?? "") === unit).reduce((a, x) => a + (x.amount ?? 0), 0), unit };
}

export function Habits({ month, version, onChanged }: { month?: string; version: number; onChanged: () => void }) {
  const today = todayKey();
  const current = month ?? today.slice(0, 7);
  const [data, setData] = useState<HabitMonth | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [stats, setStats] = useState<number | null>(null);
  const [flash, setFlash] = useState<number | null>(null);
  const want = useRef(habitFromSearch(location.search));
  // Завершённую по «?h=» прокрутить, когда «Завершённые» и её статистика уже раскрыты в DOM (эффект ниже по doneOpen/doneStats).
  const scrollDone = useRef<number | null>(null);
  const [doneOpen, setDoneOpen] = useState(readDoneOpen);
  const [doneStats, setDoneStats] = useState<number | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
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

  async function mark(id: number, day: string, was: string | null) {
    // Щелчок: пусто → сделал → пропуск → сделал … (снять отметку совсем — командой «отменить» в строке ввода).
    // Сервер не даёт отметить удалённую, завершённую и день до начала — показываем его ответ.
    const status = was === "done" ? "skipped" : "done";
    try {
      await post(`/api/habits/${id}/mark`, { status, day });
      onChanged();
    } catch (e) {
      say({ text: `Не отметилось: ${(e as Error).message}`, bad: true });
    }
  }

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

  // Пришли из виджета по «?h=12»: раскрыть статистику, прокрутить к строке и подсветить её; адрес — снова чистый «/habits».
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
  const monthDone = data.habits.reduce((n, h) => n + h.days.filter((x) => x.status === "done").length, 0);
  const monthDue = data.habits.reduce((n, h) => n + h.days.filter((x) => x.due && x.day <= today).length, 0);
  const go = (m: string) => navigate(m === today.slice(0, 7) ? "/habits" : `/habits/${m}`);

  return (
    <div className="screen habits">
      <div className="day-nav">
        <button className="ghost" onClick={() => go(addMonths(current, -1))} aria-label="Прошлый месяц">‹</button>
        <h2 className="screen-title">{monthTitle(current)}</h2>
        <button className="ghost" onClick={() => go(addMonths(current, 1))} aria-label="Следующий месяц">›</button>
      </div>

      <div className="hg-sum">
        {current === today.slice(0, 7) && data.today.length > 0 && <span>Сегодня сделано <b>{doneToday} из {data.today.length}</b></span>}
        {monthDue > 0 && <span className="muted">за месяц {Math.round((monthDone / monthDue) * 100)} %</span>}
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
        <Card className="reveal wide grid-card">
          <div className="habit-grid" style={{ gridTemplateColumns: `minmax(230px, 3fr) repeat(${days.length}, minmax(26px, 1fr))` }}>
            <span />
            {days.map((d) => {
              const wd = WEEK_SHORT[(new Date(d).getDay() + 6) % 7];
              return (
                <span key={d} className={`hg-day ${d === today ? "today hg-now" : ""} ${wd === "сб" || wd === "вс" ? "weekend" : ""}`} title={WEEKDAYS[(new Date(d).getDay() + 6) % 7]}>
                  <i>{wd}</i>{Number(d.slice(-2))}
                </span>
              );
            })}
            {data.habits.map((h) => {
              const done = h.days.filter((x) => x.status === "done").length;
              const due = h.days.filter((x) => x.due && x.day <= today).length;
              const fire = data.today.find((t) => t.habit.id === h.id)?.streak ?? 0;
              const ask = data.ask ?? { first: "12:00", last: "23:00" };
              const shown = h.times.length ? h.times : [ask.first];
              const span = spanText(h, today);
              const much = monthAmount(h.days);
              return [
                <span key={`t${h.id}`} className={`hg-title ${flash === h.id ? "hg-flash" : ""}`} data-habit-row={h.id}>
                  <span className="hg-name">
                    <button className={`hg-open grow ${stats === h.id ? "on" : ""}`} onClick={() => setStats(stats === h.id ? null : h.id)} title="Статистика привычки">{h.title}</button>
                    {fire >= 2 && <span className="hg-fire" title={`Серия: ${fire} дн. подряд`}>🔥{fire}</span>}
                    <Chip>{done}/{due}</Chip>
                  </span>
                  {much && <span className="hg-much small" title="Сколько за месяц — по тому, что вы писали горничной («прочитал 35 страниц»)">за месяц {fullNum(much.sum)}{much.unit && ` ${much.unit}`}</span>}
                  {span && <span className="hg-span muted small">{span}</span>}
                  <span className="hg-tools">
                  <button
                    className={`hg-bell ${editing === h.id ? "on" : ""}`}
                    onClick={() => setEditing(editing === h.id ? null : h.id)}
                    title={h.quiet ? "Без напоминаний" : `Напомнит в ${shown.join(", ")}${h.times.length ? "" : " (общее время из «Настроек»)"}${shown.some((t) => t >= ask.last) ? "" : `; не отметите — ещё раз в ${ask.last}`}. Щелчок — изменить`}
                  >
                    {h.quiet ? "🔕 без напоминаний" : `🔔 ${shown.join(", ")}`}
                  </button>
                  <button className={`hg-bell hg-chart ${stats === h.id ? "on" : ""}`} onClick={() => setStats(stats === h.id ? null : h.id)} title="Статистика привычки: серии, год, дни недели">
                    📊 {stats === h.id ? "Скрыть" : "Статистика"}
                  </button>
                  <button className="hg-bell hg-finish" disabled={busy === h.id} onClick={() => edit(h, { finish: true })} title="Завершить привычку: уйдёт из сетки в «Завершённые» со всеми отметками" aria-label="Завершить привычку">
                    🏁
                  </button>
                  </span>
                </span>,
                ...h.days.map((x, k) => (
                  <button
                    key={`${h.id}-${x.day}`}
                    style={flash === h.id ? { animationDelay: `${k * 22}ms` } : undefined}
                    className={`hg-cell ${flash === h.id ? "hg-flash" : ""} ${x.due ? "due" : ""} ${x.status ?? ""} ${x.day === today ? "today hg-now" : ""} ${x.day > today ? "future" : ""} ${x.status === "done" && x.amount != null ? "num" : ""}`}
                    disabled={x.day > today || x.day < h.start_date}
                    onClick={() => mark(h.id, x.day, x.status)}
                    title={cellTitle(x)}
                  >
                    {x.status === "done" ? (x.amount != null ? shortNum(x.amount) : "✓") : x.status === "skipped" ? "–" : ""}
                  </button>
                )),
                ...(editing === h.id
                  ? [<HabitTimes key={`e${h.id}`} id={h.id} times={h.times} quiet={!!h.quiet} ask={ask} onDone={() => { setEditing(null); onChanged(); }} onCancel={() => setEditing(null)} />]
                  : []),
                ...(stats === h.id ? [<HabitStatsPanel key={`s${h.id}-${version}`} id={h.id} />] : []),
              ];
            })}
          </div>
          <p className="muted small">Щелчок по клетке — «сделал», ещё раз — «пропуск»; наведите — когда отметили. Серия 🔥 — сколько запланированных дней подряд сделано. 🔔 — когда напомнить, 📊 — статистика привычки, 🏁 — закончить. Число в клетке — сколько сделали, если написали горничной: «прочитал 35 страниц».</p>
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
      {open && <HabitStatsPanel key={`d${f.id}-${version}`} id={f.id} finished />}
    </li>
  );
}

/** Время напоминаний одной привычки — строка во всю ширину сетки под ней. Пусто — общее время из «Настроек». */
function HabitTimes({ id, times, quiet, ask, onDone, onCancel }: {
  id: number; times: string[]; quiet: boolean; ask: { first: string; last: string }; onDone: () => void; onCancel: () => void;
}) {
  const [list, setList] = useState<string[]>(quiet ? [] : times.length ? times : [ask.first]);
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState("");
  const valid = list.filter((t) => /^\d\d:\d\d$/.test(t));
  // Все времена убраны — «Сохранить» выключает напоминания у этой привычки.
  const off = list.length === 0;
  async function save(next: string[], general = false) {
    setBusy(true);
    setFail("");
    try {
      // Пустой список крестиками — без напоминаний; время или «Как в настройках» — напоминания снова включены.
      await post(`/api/habits/${id}`, off && !general ? { times: [], quiet: true } : quiet ? { times: next, quiet: false } : { times: next });
      onDone();
    } catch (e) {
      setFail((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <div className="hg-times" style={{ gridColumn: "1 / -1" }}>
      {!off && <span className="muted small">Напомнить в</span>}
      {list.map((t, i) => (
        <span key={i} className="hg-time">
          <input type="time" value={t} onChange={(e) => setList(list.map((x, j) => (j === i ? e.target.value : x)))} aria-label={`Время ${i + 1}`} />
          <button className="ghost" onClick={() => setList(list.filter((_, j) => j !== i))} aria-label="Убрать время" title="Убрать время">×</button>
        </span>
      ))}
      {off && <span className="small">🔕 без напоминаний</span>}
      {list.length < 4 && <button className="ghost" onClick={() => setList([...list, list.at(-1) ?? ask.first])}>{off ? "+ время" : "+ ещё время"}</button>}
      <span className="grow" />
      <button className="primary" disabled={busy || (!off && !valid.length)} onClick={() => save(valid)}>Сохранить</button>
      {(times.length > 0 || quiet) && <button className="ghost" disabled={busy} onClick={() => save([], true)} title={`${ask.first} и ${ask.last} — меняется в «Настройках»`}>Как в настройках</button>}
      <button className="ghost" disabled={busy} onClick={onCancel}>Отмена</button>
      <span className="muted small hg-times-hint">
        {off ? "Горничная не будет спрашивать про эту привычку — отмечайте сами. «+ время» вернёт напоминания." : <>{quiet && "Сейчас напоминаний нет — «Сохранить» их включит. "}Не отметите — спросит ещё раз в {ask.last}. Общее время — в «Настройках».</>}{fail && <b style={{ color: "var(--red)" }}> {fail}</b>}
      </span>
    </div>
  );
}
