import { useEffect, useMemo, useState } from "react";
import { del, get } from "../api";
import { Card, Chip, Empty, Spinner } from "../components";
import { HEALTH_TOPICS, SECTIONS, SECTION_ORDER, WEEKDAYS, addDays, addMonths, dur, humanDay, metricText, money, monthGrid, monthTitle, todayKey } from "../format";
import { navigate } from "../router";
import type { DayData } from "../types";
import { EventList } from "./Today";

// Дневник по дням: календарь с точками (где есть записи), день — по разделам, показатели, деньги, компьютер.

export function Diary({ day, version, onChanged }: { day?: string; version: number; onChanged: () => void }) {
  const today = todayKey();
  const current = day ?? today;
  const [month, setMonth] = useState(current.slice(0, 7));
  const [days, setDays] = useState<Map<string, number>>(new Map());
  const [data, setData] = useState<DayData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => setMonth(current.slice(0, 7)), [current]);
  useEffect(() => {
    get<{ day: string; n: number }[]>("/api/diary/days").then((rows) => setDays(new Map(rows.map((r) => [r.day, r.n])))).catch(() => {});
  }, [version]);
  useEffect(() => {
    let alive = true;
    setData(null);
    get<DayData>(`/api/day?day=${current}`).then((d) => alive && setData(d)).catch((e) => alive && setError((e as Error).message));
    return () => { alive = false; };
  }, [current, version]);

  const grid = useMemo(() => monthGrid(month), [month]);
  const go = (d: string) => navigate(`/diary/${d}`);

  async function remove(id: number) {
    if (!confirm("Удалить эту запись?")) return;
    await del(`/api/diary/${id}`);
    onChanged();
  }

  const bySection = new Map<string, DayData["diary"]>();
  for (const r of data?.diary ?? []) bySection.set(r.section, [...(bySection.get(r.section) ?? []), r]);
  const sections = [...bySection.keys()].sort((a, b) => SECTION_ORDER.indexOf(a) - SECTION_ORDER.indexOf(b));

  return (
    <div className="screen diary">
      <div className="diary-layout">
        <aside className="calendar reveal">
          <div className="cal-head">
            <button className="ghost" onClick={() => setMonth(addMonths(month, -1))} aria-label="Прошлый месяц">‹</button>
            <b>{monthTitle(month)}</b>
            <button className="ghost" onClick={() => setMonth(addMonths(month, 1))} aria-label="Следующий месяц">›</button>
          </div>
          <div className="cal-grid">
            {WEEKDAYS.map((w) => <span key={w} className="cal-wd">{w}</span>)}
            {grid.map((k, i) => k ? (
              <button
                key={k}
                className={`cal-day ${k === current ? "on" : ""} ${k === today ? "today" : ""} ${k > today ? "future" : ""}`}
                onClick={() => go(k)}
              >
                {Number(k.slice(-2))}
                {days.has(k) && <i className="dot" style={{ opacity: Math.min(1, 0.35 + (days.get(k) ?? 0) / 6) }} />}
              </button>
            ) : <span key={`e${i}`} />)}
          </div>
          <div className="cal-foot muted small">Дней с записями: {days.size}</div>
        </aside>

        <div className="diary-day">
          <div className="day-nav">
            <button className="ghost" onClick={() => go(addDays(current, -1))} aria-label="Вчера">‹</button>
            <h2 className="screen-title">{humanDay(current, current.slice(0, 4) !== today.slice(0, 4))}</h2>
            <button className="ghost" onClick={() => go(addDays(current, 1))} aria-label="Завтра">›</button>
            {current !== today && <button className="link" onClick={() => go(today)}>сегодня</button>}
          </div>

          {error && <Empty>Нет связи: {error}</Empty>}
          {!data && !error && <Spinner />}
          {data && (
            <div className="cards" key={current}>
              <Card className="reveal wide">
                {sections.length ? (
                  <div className="diary-sections">
                    {sections.map((s) => (
                      <div key={s} className="diary-section">
                        <b>{SECTIONS[s] ?? s}</b>
                        <ul>
                          {bySection.get(s)!.map((r) => (
                            <li key={r.id} className="entry">
                              <span className="grow">
                                {r.section === "health" && r.topic && <Chip tone="accent">{HEALTH_TOPICS[r.topic] ?? r.topic}</Chip>}
                                {r.text}
                              </span>
                              <button className="ghost tiny" onClick={() => remove(r.id)} title="Удалить" aria-label="Удалить">✕</button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                ) : <Empty>{current > today ? "Этот день ещё не наступил" : "В этот день записей нет"}</Empty>}
              </Card>

              {(data.metrics.length > 0 || data.money.length > 0) && (
                <Card title="Показатели и деньги" className="reveal">
                  <div className="chips">
                    {data.metrics.map((m) => <Chip key={m.id}>{m.label}: <b>{metricText(m)}</b></Chip>)}
                    {data.money.map((m) => (
                      <Chip key={m.id} tone={m.kind === "income" ? "good" : "bad"}>
                        {m.kind === "income" ? "+" : "−"}{money(m.amount, m.currency)}{m.category ? ` · ${m.category}` : ""}
                      </Chip>
                    ))}
                  </div>
                </Card>
              )}

              {data.activity.length > 0 && (
                <Card title="Компьютер" className="reveal">
                  {data.activity.map((a) => (
                    <div key={a.source} className="activity">
                      {a.active_sec > 0 && <div>💻 {dur(a.active_sec)} за ПК <span className="muted small">{a.apps.slice(0, 5).map((x) => `${x.name} ${dur(x.sec)}`).join(", ")}</span></div>}
                      {a.games.length > 0 && <div>🎮 {dur(a.games.reduce((s, g) => s + g.sec, 0))} — {a.games.map((g) => `${g.name} ${dur(g.sec)}`).join(", ")}</div>}
                    </div>
                  ))}
                </Card>
              )}

              {data.events.length > 0 && (
                <Card title="Планы этого дня" className="reveal"><EventList events={data.events} /></Card>
              )}

              {data.habits.length > 0 && (
                <Card title="Привычки" className="reveal">
                  <ul className="list">
                    {data.habits.map((h) => (
                      <li key={h.id}>
                        <span className={`mark-dot ${h.status ?? "none"}`} />
                        <span className="grow">{h.title}</span>
                        {h.streak >= 2 && <Chip tone="fire">🔥 {h.streak}</Chip>}
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
