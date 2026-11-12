import { useEffect, useState } from "react";
import { get, post } from "../api";
import { Card, Chip, Empty, Spinner } from "../components";
import { WEEKDAYS, addMonths, monthTitle, todayKey } from "../format";
import { navigate } from "../router";
import type { HabitMonth } from "../types";
import { HabitStatsPanel } from "./HabitStats";

// Привычки: сетка месяца (строка — привычка, столбец — день), отметка щелчком, серии и время напоминаний (🔔 — правка прямо в строке),
// щелчок по названию — статистика привычки строкой под ней (HabitStats.tsx).

const WEEK_SHORT = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];

export function Habits({ month, version, onChanged }: { month?: string; version: number; onChanged: () => void }) {
  const today = todayKey();
  const current = month ?? today.slice(0, 7);
  const [data, setData] = useState<HabitMonth | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [stats, setStats] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    get<HabitMonth>(`/api/habits?month=${current}`).then((d) => alive && setData(d)).catch((e) => alive && setError((e as Error).message));
    return () => { alive = false; };
  }, [current, version]);

  async function mark(id: number, day: string, was: string | null) {
    // Щелчок: пусто → сделал → пропуск → сделал … (снять отметку совсем — командой «отменить» в строке ввода).
    const status = was === "done" ? "skipped" : "done";
    await post(`/api/habits/${id}/mark`, { status, day });
    onChanged();
  }

  if (error) return <Empty>Нет связи: {error}</Empty>;
  if (!data) return <Spinner />;

  const days = data.habits[0]?.days.map((d) => d.day) ?? [];
  const go = (m: string) => navigate(m === today.slice(0, 7) ? "/habits" : `/habits/${m}`);

  return (
    <div className="screen habits">
      <div className="day-nav">
        <button className="ghost" onClick={() => go(addMonths(current, -1))} aria-label="Прошлый месяц">‹</button>
        <h2 className="screen-title">{monthTitle(current)}</h2>
        <button className="ghost" onClick={() => go(addMonths(current, 1))} aria-label="Следующий месяц">›</button>
      </div>

      {data.habits.length === 0 ? (
        <Card className="reveal"><Empty>Привычек пока нет. Напишите, например: «каждый будний день в 7:30 зарядка до конца года»</Empty></Card>
      ) : (
        <Card className="reveal wide grid-card">
          <div className="habit-grid" style={{ gridTemplateColumns: `minmax(180px, 2.2fr) repeat(${days.length}, minmax(26px, 1fr))` }}>
            <span />
            {days.map((d) => {
              const wd = WEEK_SHORT[(new Date(d).getDay() + 6) % 7];
              return (
                <span key={d} className={`hg-day ${d === today ? "today" : ""} ${wd === "сб" || wd === "вс" ? "weekend" : ""}`} title={WEEKDAYS[(new Date(d).getDay() + 6) % 7]}>
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
              return [
                <span key={`t${h.id}`} className="hg-title">
                  <span className="hg-name">
                    <button className={`hg-open grow ${stats === h.id ? "on" : ""}`} onClick={() => setStats(stats === h.id ? null : h.id)} title="Статистика привычки">{h.title}</button>
                    {fire >= 2 && <span className="hg-fire" title={`Серия: ${fire} дн. подряд`}>🔥{fire}</span>}
                    <Chip>{done}/{due}</Chip>
                  </span>
                  <span className="hg-tools">
                  <button
                    className={`hg-bell ${editing === h.id ? "on" : ""}`}
                    onClick={() => setEditing(editing === h.id ? null : h.id)}
                    title={h.quiet ? "Без напоминаний" : `Напомнит в ${shown.join(", ")}${shown.some((t) => t >= ask.last) ? "" : `; не отметите — ещё раз в ${ask.last}`}. Щелчок — изменить`}
                  >
                    {h.quiet ? "🔕 без напоминаний" : `🔔 ${shown.join(", ")}`}
                    {!h.quiet && !h.times.length && <i> · общее</i>}
                  </button>
                  <button className={`hg-bell hg-chart ${stats === h.id ? "on" : ""}`} onClick={() => setStats(stats === h.id ? null : h.id)} title="Статистика привычки: серии, год, дни недели">
                    📊 {stats === h.id ? "Скрыть" : "Статистика"}
                  </button>
                  </span>
                </span>,
                ...h.days.map((x) => (
                  <button
                    key={`${h.id}-${x.day}`}
                    className={`hg-cell ${x.due ? "due" : ""} ${x.status ?? ""} ${x.day === today ? "today" : ""} ${x.day > today ? "future" : ""}`}
                    disabled={x.day > today}
                    onClick={() => mark(h.id, x.day, x.status)}
                    title={`${x.day}${x.status === "done" ? " — сделано" : x.status === "skipped" ? " — пропуск" : x.due ? " — запланировано" : ""}`}
                  >
                    {x.status === "done" ? "✓" : x.status === "skipped" ? "–" : ""}
                  </button>
                )),
                ...(editing === h.id
                  ? [<HabitTimes key={`e${h.id}`} id={h.id} times={h.times} quiet={!!h.quiet} ask={ask} onDone={() => { setEditing(null); onChanged(); }} onCancel={() => setEditing(null)} />]
                  : []),
                ...(stats === h.id ? [<HabitStatsPanel key={`s${h.id}-${version}`} id={h.id} />] : []),
              ];
            })}
          </div>
          <p className="muted small">Щелчок по клетке — «сделал», ещё раз — «пропуск». Серия 🔥 — сколько запланированных дней подряд сделано. 🔔 — когда напомнить, 📊 — статистика привычки.</p>
        </Card>
      )}
    </div>
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
