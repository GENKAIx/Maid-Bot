import { useEffect, useState } from "react";
import { get } from "../api";
import { Bars, NestedBars, Segment } from "../charts";
import { Card, Empty, Spinner } from "../components";
import { addDays, dur, humanDay, metricText, monthTitle, shortDay, todayKey } from "../format";
import { SleepTimeline, sleepAverages, sleepDays } from "../sleep";
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
  const [icons, setIcons] = useState<Record<string, string>>({});
  const [todayRows, setTodayRows] = useState<ActivityRow[]>([]);
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
  // Сегодняшний день — отдельно: графа «Сегодня» видна, даже когда листаете прошлые периоды.
  useEffect(() => {
    get<ActivityRow[]>(`/api/activity?from=${today}&to=${today}`).then(setTodayRows).catch(() => setTodayRows([]));
  }, [today, version]);
  useEffect(() => {
    get<Record<string, string>>("/api/icons").then(setIcons).catch(() => setIcons({}));
  }, [version]);

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
  const gamesSec = (d: string) => act(d).reduce((s, a) => s + a.games.reduce((x, g) => x + g.sec, 0), 0);
  const pcSec = (d: string) => act(d).reduce((s, a) => s + a.active_sec, 0);
  const pcBars = bs.map((b) => {
    const days = b.days.filter((d) => pcSec(d) > 0 || gamesSec(d) > 0);
    const k = r.group === "day" ? 1 : days.length || 1;
    return { label: b.label, title: b.title, back: days.reduce((s, d) => s + pcSec(d), 0) / k, front: days.reduce((s, d) => s + gamesSec(d), 0) / k };
  });
  const pcDays = bs.flatMap((b) => b.days).filter((d) => pcSec(d) > 0 || gamesSec(d) > 0);
  const pcAvg = pcDays.length ? pcDays.reduce((s, d) => s + pcSec(d), 0) / pcDays.length : 0;
  const gameAvg = pcDays.length ? pcDays.reduce((s, d) => s + gamesSec(d), 0) / pcDays.length : 0;
  const pct = (v: number, of: number) => `${Math.round((v / of) * 100)}%`;
  const todayPc = todayRows.reduce((s, a) => s + a.active_sec, 0);
  const todayGames = todayRows.reduce((s, a) => s + a.games.reduce((x, g) => x + g.sec, 0), 0);
  const metric = (key: string, how: "sum" | "avg") => byDay((d) => metrics.find((m) => m.key === key && m.day_key === d)?.value ?? null, how);
  const steps = metric("steps", r.group === "day" ? "sum" : "avg");
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

  const sd = sleepDays(sleepNotes, metrics);
  const allDays = bs.flatMap((b) => b.days);
  const sleepRows = (r.group === "day" ? allDays : allDays.filter((d) => sd.get(d)?.hours).slice(-31)).map((d) => sd.get(d) ?? { day: d });
  const slept = sleepRows.filter((d) => d.hours);
  const times = sleepAverages(slept);
  const sleepHead = slept.length ? [`в среднем ${h(avg(slept.map((d) => d.hours!)))}`, times && `отбой ~${times.bed}, подъём ~${times.wake}`].filter(Boolean).join(" · ") : "";

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
        <Card title="Компьютер и игры" className="reveal wide" action={pcDays.length > 0 && <span className="muted small">{pcDays.length} дн. с данными</span>}>
          {pcDays.length > 0 ? (
            <>
              <div className="pc-summary">
                <div className="pc-stat">
                  <span className="pc-dot" style={{ background: "var(--grey)" }} />
                  <span><b>{dur(pcAvg)}</b> в день за компьютером</span>
                  <span className="pc-pct">{pct(pcAvg, 86400)} суток</span>
                </div>
                <div className="pc-stat">
                  <span className="pc-dot" style={{ background: "var(--red)" }} />
                  <span><b>{dur(gameAvg)}</b> в играх</span>
                  <span className="pc-pct">{pct(gameAvg, 86400)} суток · {pcAvg ? pct(gameAvg, Math.max(pcAvg, gameAvg)) : "0%"} времени за ПК</span>
                </div>
                <div className="pc-stat pc-today">
                  <span className="pc-today-label">Сегодня</span>
                  <span><b>{dur(todayPc)}</b> за ПК</span>
                  <span className="pc-pct">{todayGames ? <>игры <span className="pc-today-games">{dur(todayGames)}</span></> : "без игр"}</span>
                </div>
                <div className="day-share" title="Доля суток: игры, остальное время за компьютером, вне компьютера">
                  <i style={{ width: `${(gameAvg / 86400) * 100}%`, background: "var(--red)" }} />
                  <i style={{ width: `${(Math.max(0, pcAvg - gameAvg) / 86400) * 100}%`, background: "var(--grey)" }} />
                </div>
              </div>
              <NestedBars
                bars={pcBars} back="var(--grey)" front="var(--red)" format={dur} tip={(x) => `за ПК ${dur(Math.max(x.back, x.front))} · ${pct(Math.max(x.back, x.front), 86400)} суток
игры ${dur(x.front)} · ${x.back || x.front ? pct(x.front, Math.max(x.back, x.front)) : "0%"} от ПК`}
              />
              <div className="app-cols">
                <AppList title="Программы" items={topApps} icons={icons} color="var(--grey)" days={pcDays.length} />
                <AppList title="Игры" items={topGames} icons={icons} color="var(--red)" days={pcDays.length} empty="Игр не было" />
              </div>
            </>
          ) : <Empty>Нет данных трекера</Empty>}
        </Card>
        <Card title={`Сон`} className="reveal wide" action={<span className="muted small">{sleepHead}</span>}>
          {sleepRows.some((d) => d.hours) ? <SleepTimeline days={sleepRows} /> : <Empty>Сон не записан — скажите боту «лёг в 1:30, встал в 9:00»</Empty>}
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

const PALETTE = ["#6b3fd4", "#3d8fe0", "#e0566a", "#2fa86e", "#e98a2e", "#8a6f3b", "#c04fb0", "#4b9a9a"];
/** Тот же ключ, что на сервере (server/src/activity.ts iconKey). */
const iconKey = (name: string) => name.toLowerCase().replace(/\.exe$/, "").replace(/[^\p{L}\p{N}]+/gu, "");
const prettyName = (name: string) => name.replace(/\.exe$/i, "");

function AppIcon({ name, icons }: { name: string; icons: Record<string, string> }) {
  const key = iconKey(name);
  const src = icons[key];
  if (src) return <img className="app-icon" src={src} alt="" />;
  const hue = PALETTE[[...key].reduce((s, c) => s + c.charCodeAt(0), 0) % PALETTE.length];
  return <span className="app-icon letter" style={{ background: hue }}>{(prettyName(name)[0] ?? "?").toUpperCase()}</span>;
}

function AppList({ title, items, icons, color, days, empty }: {
  title: string; items: Map<string, number>; icons: Record<string, string>; color: string; days: number; empty?: string;
}) {
  const list = [...items.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const max = list[0]?.[1] || 1;
  const total = [...items.values()].reduce((s, v) => s + v, 0) || 1;
  return (
    <div>
      <h4 className="sub">{title}</h4>
      {list.length ? (
        <ul className="apps">
          {list.map(([name, sec]) => (
            <li key={name} title={`${prettyName(name)}: ${dur(sec)} за период${days > 1 ? `, ${dur(sec / days)} в день` : ""} · ${Math.round((sec / total) * 100)}%`}>
              <AppIcon name={name} icons={icons} />
              <span className="app-name">{prettyName(name)}</span>
              <span className="app-bar"><i style={{ width: `${(sec / max) * 100}%`, background: color }} /></span>
              <span className="app-time">{dur(sec)}</span>
            </li>
          ))}
        </ul>
      ) : <p className="muted small">{empty ?? "Нет данных"}</p>}
    </div>
  );
}
