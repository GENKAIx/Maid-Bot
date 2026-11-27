import { useEffect, useState } from "react";
import { get, post } from "../api";
import { Card, Chip, Empty, Spinner } from "../components";
import { WEEKDAYS, addDays, shortDay, todayKey } from "../format";
import type { EventRow, TaskRow } from "../types";
import { Dates } from "./Dates";

// Планы: неделя днями, что дальше, все задачи; «Даты» (screens/Dates.tsx) — по адресу /plans/dates. Вкладки «Неделя», «Привычки»,
// «Даты» — в шапке раздела «Планы» (App.tsx, nav.ts hubs; 27.11.2026, раньше — свой ряд вкладок здесь).

export function Plans({ tab, version, onChanged }: { tab?: string; version: number; onChanged: () => void }) {
  if (tab === "dates") return (
    <div className="screen">
      <h2 className="screen-title">Важные даты</h2>
      <Dates version={version} onChanged={onChanged} />
    </div>
  );
  return <Week version={version} onChanged={onChanged} />;
}

function Week({ version, onChanged }: { version: number; onChanged: () => void }) {
  const today = todayKey();
  const [start, setStart] = useState(addDays(today, -((new Date().getDay() + 6) % 7)));
  const [events, setEvents] = useState<EventRow[] | null>(null);
  const [later, setLater] = useState<EventRow[]>([]);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    const end = addDays(start, 6);
    Promise.all([
      get<EventRow[]>(`/api/events?from=${start}&to=${end}`),
      get<EventRow[]>(`/api/events?from=${addDays(end, 1)}&to=${addDays(end, 60)}`),
      get<TaskRow[]>("/api/tasks"),
    ]).then(([e, l, t]) => {
      if (!alive) return;
      setEvents(e); setLater(l); setTasks(t);
    }).catch((e) => alive && setError((e as Error).message));
    return () => { alive = false; };
  }, [start, version]);

  async function closeTask(id: number) {
    await post(`/api/tasks/${id}`, { status: "done" });
    onChanged();
  }

  if (error) return <Empty>Нет связи: {error}</Empty>;
  if (!events) return <Spinner />;
  const week = Array.from({ length: 7 }, (_, i) => addDays(start, i));

  return (
    <div className="screen">
      <div className="day-nav">
        <button className="ghost" onClick={() => setStart(addDays(start, -7))} aria-label="Прошлая неделя">‹</button>
        <h2 className="screen-title">{shortDay(start)} – {shortDay(addDays(start, 6))}</h2>
        <button className="ghost" onClick={() => setStart(addDays(start, 7))} aria-label="Следующая неделя">›</button>
        {!week.includes(today) && <button className="link" onClick={() => setStart(addDays(today, -((new Date().getDay() + 6) % 7)))}>эта неделя</button>}
      </div>

      <div className="week reveal">
        {week.map((d, i) => {
          const list = events.filter((e) => e.date_iso === d);
          return (
            <div key={d} className={`week-day ${d === today ? "today" : ""} ${d < today ? "past" : ""}`}>
              <div className="week-head"><span className="muted small">{WEEKDAYS[i]}</span> <b>{Number(d.slice(-2))}</b></div>
              {list.length ? list.map((e) => (
                <div key={e.id} className="week-event" title={e.details || e.title}>
                  {e.time && <span className="time">{e.time}</span>}{e.title}
                </div>
              )) : <div className="muted small week-empty">—</div>}
            </div>
          );
        })}
      </div>

      <div className="cards">
        <Card title="Дальше" className="reveal">
          {later.length ? (
            <ul className="list">
              {later.slice(0, 20).map((e) => (
                <li key={e.id}><span className="time">{shortDay(e.date_iso)}</span><span className="grow">{e.title}{e.time && <span className="muted small"> · {e.time}</span>}</span></li>
              ))}
            </ul>
          ) : <Empty>Дальше двух месяцев планов нет</Empty>}
        </Card>

        <Card title={`Задачи · ${tasks.length}`} className="reveal">
          {tasks.length ? (
            <ul className="list">
              {tasks.map((t) => (
                <li key={t.id} className="task">
                  <button className="check" onClick={() => closeTask(t.id)} aria-label="Сделано" />
                  <span className={`grow ${t.priority === "high" ? "high" : ""}`}>{t.title}{t.notes && <span className="muted small"> · {t.notes}</span>}</span>
                  {t.due_date && <Chip tone={t.due_date < today ? "bad" : ""}>до {shortDay(t.due_date)}</Chip>}
                </li>
              ))}
            </ul>
          ) : <Empty>Открытых задач нет</Empty>}
        </Card>

      </div>
    </div>
  );
}
