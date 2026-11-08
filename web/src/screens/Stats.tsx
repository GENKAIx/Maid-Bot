import { useEffect, useState } from "react";
import { get } from "../api";
import { Bars, Segment } from "../charts";
import { Card, Empty, Spinner } from "../components";
import { addDays, dur, humanDay, metricText, monthTitle, shortDay, todayKey } from "../format";
import type { ActivityRow, DiaryRow, MetricRow } from "../types";

// Статистика: компьютер, игры, шаги, сон, спорт — по дням (неделя, месяц), по неделям (3 месяца), по месяцам (год).

type Range = "week" | "month" | "quarter" | "year";
const RANGES: { id: Range; title: string; days: number; group: "day" | "week" | "month" }[] = [
  { id: "week", title: "Неделя", days: 7, group: "day" },
  { id: "month", title: "Месяц", days: 30, group: "day" },
  { id: "quarter", title: "3 месяца", days: 91, group: "week" },
  { id: "year", title: "Год", days: 365, group: "month" },
];

interface Bucket { key: string; label: string; title: string; days: string[] }

function buckets(from: string, to: string, group: "day" | "week" | "month"): Bucket[] {
  const out: Bucket[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const key = group === "day" ? d : group === "month" ? d.slice(0, 7) : addDays(d, -((new Date(d).getDay() + 6) % 7));
    let b = out[out.length - 1];
    if (!b || b.key !== key) {
      b = {
        key,
        label: group === "day" ? String(Number(d.slice(-2))) : group === "month" ? monthTitle(key).slice(0, 3) : shortDay(key),
        title: group === "day" ? humanDay(d) : group === "month" ? monthTitle(key) : `неделя с ${shortDay(key)}`,
        days: [],
      };
      out.push(b);
    }
    b.days.push(d);
  }
  return out;
}

export function Stats({ version }: { version: number }) {
  const today = todayKey();
  const [range, setRange] = useState<Range>("month");
  const [end, setEnd] = useState(today);
  const [activity, setActivity] = useState<ActivityRow[] | null>(null);
  const [metrics, setMetrics] = useState<MetricRow[]>([]);
  const [sleepNotes, setSleepNotes] = useState<DiaryRow[]>([]);
  const [error, setError] = useState("");

  const r = RANGES.find((x) => x.id === range)!;
  const from = addDays(end, -(r.days - 1));

  useEffect(() => {
    let alive = true;
    setActivity(null);
    Promise.all([
      get<ActivityRow[]>(`/api/activity?from=${from}&to=${end}`),
      get<{ rows: MetricRow[] }>(`/api/metrics?from=${from}&to=${end}`),
      get<DiaryRow[]>(`/api/diary?section=sleep&from=${from}&to=${end}`),
    ]).then(([a, m, s]) => {
      if (!alive) return;
      setActivity(a); setMetrics(m.rows); setSleepNotes(s);
    }).catch((e) => alive && setError((e as Error).message));
    return () => { alive = false; };
  }, [from, end, version]);

  if (error) return <Empty>Нет связи: {error}</Empty>;
  if (!activity) return <Spinner />;

  const bs = buckets(from, end, r.group);
  const avg = (vals: number[]) => (vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0);
  const byDay = (fn: (d: string) => number | null, how: "sum" | "avg") =>
    bs.map((b) => {
      const vals = b.days.map(fn).filter((v): v is number => v !== null && v > 0);
      return { label: b.label, title: b.title, value: how === "sum" ? vals.reduce((s, v) => s + v, 0) : avg(vals) };
    });
  const act = (d: string) => activity.filter((a) => a.day_key === d);
  const pc = byDay((d) => act(d).reduce((s, a) => s + a.active_sec, 0) || null, r.group === "day" ? "sum" : "avg");
  const games = byDay((d) => act(d).reduce((s, a) => s + a.games.reduce((x, g) => x + g.sec, 0), 0) || null, r.group === "day" ? "sum" : "avg");
  const metric = (key: string, how: "sum" | "avg") => byDay((d) => metrics.find((m) => m.key === key && m.day_key === d)?.value ?? null, how);
  const steps = metric("steps", r.group === "day" ? "sum" : "avg");
  const sleep = metric("sleep_hours", "avg");
  const sport = metric("sport_min", r.group === "day" ? "sum" : "avg");
  const weight = metric("weight", "avg");
  const has = (b: { value: number }[]) => b.some((x) => x.value > 0);
  const perDay = r.group !== "day" ? " в среднем за день" : "";
  const sumText = (b: { value: number }[], f: (v: number) => string) => {
    const vals = b.filter((x) => x.value > 0).map((x) => x.value);
    return vals.length ? `среднее ${f(avg(vals))}` : "";
  };
  const h = (v: number) => `${v.toLocaleString("ru-RU", { maximumFractionDigits: 1 })} ч`;
  const n = (v: number) => Math.round(v).toLocaleString("ru-RU");

  const topGames = new Map<string, number>();
  for (const a of activity) for (const g of a.games) topGames.set(g.name, (topGames.get(g.name) ?? 0) + g.sec);
  const topApps = new Map<string, number>();
  for (const a of activity) for (const g of a.apps) topApps.set(g.name, (topApps.get(g.name) ?? 0) + g.sec);

  return (
    <div className="screen">
      <div className="day-nav">
        <button className="ghost" onClick={() => setEnd(addDays(end, -r.days))} aria-label="Назад">‹</button>
        <h2 className="screen-title">{shortDay(from)} – {shortDay(end)}</h2>
        <button className="ghost" onClick={() => setEnd(addDays(end, r.days))} disabled={end >= today} aria-label="Вперёд">›</button>
        {end !== today && <button className="link" onClick={() => setEnd(today)}>до сегодня</button>}
        <span className="spacer" />
        <Segment value={range} options={RANGES.map((x) => ({ id: x.id, title: x.title }))} onChange={(v) => { setRange(v); setEnd(today); }} />
      </div>

      <div className="cards">
        <Card title={`За компьютером${perDay}`} className="reveal wide" action={<span className="muted small">{sumText(pc, dur)}</span>}>
          {has(pc) ? <Bars bars={pc} color="var(--grey)" format={dur} /> : <Empty>Нет данных трекера</Empty>}
          {topApps.size > 0 && <p className="muted small">{[...topApps.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${dur(v)}`).join(" · ")}</p>}
        </Card>
        <Card title={`Игры${perDay}`} className="reveal wide" action={<span className="muted small">{sumText(games, dur)}</span>}>
          {has(games) ? <Bars bars={games} color="var(--red)" format={dur} goal={r.group === "day" ? 2 * 3600 : undefined} /> : <Empty>Игр не было</Empty>}
          {topGames.size > 0 && <p className="muted small">{[...topGames.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${dur(v)}`).join(" · ")}</p>}
        </Card>
        <Card title={`Сон${perDay}`} className="reveal" action={<span className="muted small">{sumText(sleep, h)}</span>}>
          {has(sleep) ? <Bars bars={sleep} color="var(--blue)" format={h} goal={8} /> : <Empty>Часы сна не записаны</Empty>}
        </Card>
        <Card title={`Шаги${perDay}`} className="reveal" action={<span className="muted small">{sumText(steps, n)}</span>}>
          {has(steps) ? <Bars bars={steps} color="var(--green)" format={n} goal={10000} /> : <Empty>Шагов нет — подключите Быструю команду на айфоне</Empty>}
        </Card>
        <Card title={`Спорт${perDay}`} className="reveal" action={<span className="muted small">{sumText(sport, (v) => `${n(v)} мин`)}</span>}>
          {has(sport) ? <Bars bars={sport} color="var(--orange)" format={(v) => `${n(v)} мин`} goal={30} /> : <Empty>Спорта не записано</Empty>}
        </Card>
        {has(weight) && (
          <Card title="Вес" className="reveal" action={<span className="muted small">{sumText(weight, (v) => `${v.toLocaleString("ru-RU", { maximumFractionDigits: 1 })} кг`)}</span>}>
            <Bars bars={weight} color="var(--accent)" format={(v) => `${v.toLocaleString("ru-RU", { maximumFractionDigits: 1 })} кг`} />
          </Card>
        )}
        {sleepNotes.length > 0 && (
          <Card title="Записи о сне" className="reveal">
            <ul className="list">
              {[...sleepNotes].slice(0, 30).map((s) => (
                <li key={s.id}><span className="time">{shortDay(s.day_key)}</span><span className="grow">{s.text}</span></li>
              ))}
            </ul>
          </Card>
        )}
        {metrics.some((m) => !["steps", "sleep_hours", "sport_min", "weight"].includes(m.key)) && (
          <Card title="Другие показатели" className="reveal wide">
            <OtherMetrics metrics={metrics.filter((m) => !["steps", "sleep_hours", "sport_min", "weight"].includes(m.key))} bs={bs} />
          </Card>
        )}
      </div>
    </div>
  );
}

function OtherMetrics({ metrics, bs }: { metrics: MetricRow[]; bs: Bucket[] }) {
  const keys = [...new Map(metrics.map((m) => [m.key, m])).values()];
  return (
    <div className="metric-grid">
      {keys.map((k) => {
        const bars = bs.map((b) => {
          const vals = b.days.map((d) => metrics.find((m) => m.key === k.key && m.day_key === d)?.value).filter((v): v is number => v !== undefined);
          return { label: b.label, title: b.title, value: vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0 };
        });
        return (
          <div key={k.key}>
            <h4 className="sub">{k.label} <span className="muted">{k.unit}</span></h4>
            <Bars bars={bars} height={80} format={(v) => metricText({ value: Math.round(v * 10) / 10, unit: k.unit })} />
          </div>
        );
      })}
    </div>
  );
}
