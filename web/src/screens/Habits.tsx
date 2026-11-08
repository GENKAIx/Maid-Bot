import { useEffect, useState } from "react";
import { get, post } from "../api";
import { Card, Chip, Empty, Ring, Spinner } from "../components";
import { WEEKDAYS, addMonths, monthTitle, todayKey } from "../format";
import { navigate } from "../router";
import type { HabitMonth } from "../types";

// Привычки: сетка месяца (строка — привычка, столбец — день), отметка щелчком, серии и кольца.

const WEEK_SHORT = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];

export function Habits({ month, version, onChanged }: { month?: string; version: number; onChanged: () => void }) {
  const today = todayKey();
  const current = month ?? today.slice(0, 7);
  const [data, setData] = useState<HabitMonth | null>(null);
  const [error, setError] = useState("");

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

      {data.today.length > 0 && (
        <div className="rings reveal">
          {data.today.map((h) => (
            <Ring key={h.habit.id} value={h.plannedDays ? h.doneDays / h.plannedDays : 0} label={h.habit.title} size={84}>
              <span className="ring-text">{h.doneDays}/{h.plannedDays}</span>
              {h.streak >= 2 && <span className="ring-sub">🔥{h.streak}</span>}
            </Ring>
          ))}
        </div>
      )}

      {data.habits.length === 0 ? (
        <Card className="reveal"><Empty>Привычек пока нет. Напишите, например: «каждый будний день в 7:30 зарядка до конца года»</Empty></Card>
      ) : (
        <Card className="reveal wide grid-card">
          <div className="habit-grid" style={{ gridTemplateColumns: `minmax(120px, 1.4fr) repeat(${days.length}, minmax(26px, 1fr))` }}>
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
              return [
                <span key={`t${h.id}`} className="hg-title">
                  <span className="grow">{h.title}</span>
                  <Chip>{done}/{due}</Chip>
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
              ];
            })}
          </div>
          <p className="muted small">Щелчок по клетке — «сделал», ещё раз — «пропуск». Серия 🔥 — сколько запланированных дней подряд сделано.</p>
        </Card>
      )}
    </div>
  );
}
