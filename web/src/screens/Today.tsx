import { useEffect, useState } from "react";
import { get, post } from "../api";
import { Card, Chip, Empty, Mark, Ring, Spinner } from "../components";
import { SECTIONS, SECTION_ORDER, dateWhen, dur, humanDay, metricText, money, shortDay } from "../format";
import { navigate } from "../router";
import type { EventRow, TodayData } from "../types";

// «Сегодня»: кольца дня, планы, задачи, привычки, даты, дневник, показатели, деньги, компьютер.

const GOALS: Record<string, number> = { sleep_hours: 8, steps: 10000, sport_min: 30 };

export function Today({ version, onChanged }: { version: number; onChanged: () => void }) {
  const [data, setData] = useState<TodayData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    get<TodayData>("/api/today").then((d) => alive && setData(d)).catch((e) => alive && setError((e as Error).message));
    return () => { alive = false; };
  }, [version]);

  if (error) return <Empty>Нет связи с сервером: {error}</Empty>;
  if (!data) return <Spinner />;

  const d = data;
  const metric = (k: string) => d.metrics.find((m) => m.key === k);
  const habitsDone = d.habits.filter((h) => h.status === "done").length;
  const pcSec = d.activity.reduce((s, a) => s + a.active_sec, 0);
  const gameSec = d.activity.reduce((s, a) => s + a.games.reduce((x, g) => x + g.sec, 0), 0);
  const rings: { key: string; label: string; value: number; text: string; color: string }[] = [];
  if (d.habits.length) rings.push({ key: "habits", label: "Привычки", value: habitsDone / d.habits.length, text: `${habitsDone}/${d.habits.length}`, color: "var(--accent)" });
  for (const [k, goal] of Object.entries(GOALS)) {
    const m = metric(k);
    if (m) rings.push({ key: k, label: m.label, value: m.value / goal, text: metricText(m), color: k === "sleep_hours" ? "var(--blue)" : k === "steps" ? "var(--green)" : "var(--orange)" });
  }
  if (pcSec) rings.push({ key: "pc", label: "За ПК", value: Math.min(1, pcSec / (8 * 3600)), text: dur(pcSec), color: "var(--grey)" });
  if (gameSec) rings.push({ key: "games", label: "Игры", value: Math.min(1, gameSec / (4 * 3600)), text: dur(gameSec), color: "var(--red)" });

  const bySection = new Map<string, typeof d.diary>();
  for (const r of d.diary) bySection.set(r.section, [...(bySection.get(r.section) ?? []), r]);
  const sections = [...bySection.keys()].sort((a, b) => SECTION_ORDER.indexOf(a) - SECTION_ORDER.indexOf(b));

  async function mark(id: number, status: "done" | "skipped") {
    await post(`/api/habits/${id}/mark`, { status });
    onChanged();
  }
  async function closeTask(id: number) {
    await post(`/api/tasks/${id}`, { status: "done" });
    onChanged();
  }

  return (
    <div className="screen">
      <h2 className="screen-title">{humanDay(d.day)}</h2>

      {rings.length > 0 && (
        <div className="rings reveal">
          {rings.map((r) => (
            <Ring key={r.key} value={r.value} color={r.color} label={r.label}>
              <span className="ring-text">{r.text}</span>
            </Ring>
          ))}
        </div>
      )}

      <div className="cards">
        <Card title="Планы" className="reveal">
          {d.events.length ? <EventList events={d.events} /> : <Empty>На сегодня планов нет</Empty>}
          {d.upcoming.length > 0 && (
            <>
              <h4 className="sub">Скоро</h4>
              <EventList events={d.upcoming.slice(0, 5)} withDay />
            </>
          )}
        </Card>

        <Card title="Привычки" className="reveal" action={<button className="link" onClick={() => navigate("/habits")}>месяц →</button>}>
          {d.habits.length ? (
            <ul className="list">
              {d.habits.map((h) => (
                <li key={h.id} className={`habit ${h.status ?? ""}`}>
                  <Mark status={h.status} onDone={() => mark(h.id, "done")} onSkip={() => mark(h.id, "skipped")} />
                  <span className="grow">
                    {h.title}
                    {h.times.length > 0 && <span className="muted small"> · {h.times.join(", ")}</span>}
                  </span>
                  {h.streak >= 2 && <Chip tone="fire">🔥 {h.streak}</Chip>}
                </li>
              ))}
            </ul>
          ) : <Empty>Привычек на сегодня нет. Напишите, например: «каждый день в 9 пить витамины»</Empty>}
        </Card>

        <Card title="Задачи" className="reveal">
          {d.tasks.length ? (
            <ul className="list">
              {d.tasks.slice(0, 10).map((t) => (
                <li key={t.id} className="task">
                  <button className="check" onClick={() => closeTask(t.id)} aria-label="Сделано" />
                  <span className={`grow ${t.priority === "high" ? "high" : ""}`}>{t.title}</span>
                  {t.due_date && <Chip tone={t.due_date < d.day ? "bad" : ""}>до {shortDay(t.due_date)}</Chip>}
                </li>
              ))}
              {d.tasks.length > 10 && <li className="muted small">и ещё {d.tasks.length - 10}</li>}
            </ul>
          ) : <Empty>Открытых задач нет</Empty>}
        </Card>

        <Card title="Важные даты" className="reveal">
          {d.dates.length ? (
            <ul className="list">
              {d.dates.slice(0, 8).map((x) => (
                <li key={x.id}>
                  <span className="time">{shortDay(x.on)}</span>
                  <span className="grow">{x.title}{x.age ? <span className="muted"> · {x.age}</span> : null}</span>
                  <Chip tone={x.inDays <= 1 ? "accent" : ""}>{dateWhen(x.inDays)}</Chip>
                </li>
              ))}
            </ul>
          ) : <Empty>Ближайший месяц спокойный</Empty>}
        </Card>

        <Card title="Дневник" className="reveal wide" action={<button className="link" onClick={() => navigate(`/diary/${d.day}`)}>все дни →</button>}>
          {sections.length ? (
            <div className="diary-sections">
              {sections.map((s) => (
                <div key={s} className="diary-section">
                  <b>{SECTIONS[s] ?? s}</b>
                  <ul>
                    {bySection.get(s)!.map((r) => <li key={r.id}>{r.text}</li>)}
                  </ul>
                </div>
              ))}
            </div>
          ) : <Empty>Пока пусто — напишите, как прошёл день</Empty>}
        </Card>

        {(d.metrics.length > 0 || d.money.length > 0 || d.activity.length > 0) && (
          <Card title="Показатели и деньги" className="reveal">
            <div className="chips">
              {d.metrics.map((m) => <Chip key={m.id}>{m.label}: <b>{metricText(m)}</b></Chip>)}
              {d.money.map((m) => (
                <Chip key={m.id} tone={m.kind === "income" ? "good" : "bad"}>
                  {m.kind === "income" ? "+" : "−"}{money(m.amount, m.currency)}{m.category ? ` · ${m.category}` : ""}
                </Chip>
              ))}
            </div>
            {d.activity.map((a) => (
              <div key={a.source} className="activity">
                {a.active_sec > 0 && <div>💻 {dur(a.active_sec)} за ПК <span className="muted small">{a.apps.slice(0, 4).map((x) => x.name).join(", ")}</span></div>}
                {a.games.length > 0 && <div>🎮 {dur(a.games.reduce((s, g) => s + g.sec, 0))} — {a.games.map((g) => g.name).join(", ")}</div>}
              </div>
            ))}
          </Card>
        )}
      </div>
    </div>
  );
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
