import { useEffect, useRef, useState } from "react";
import { get } from "../api";
import { Bars, MarkTimeLine } from "../charts";
import { Spinner } from "../components";
import { MONTHS, MONTHS_GEN, WEEKDAYS, shortDay } from "../format";
import { daysBetween } from "../habitview";
import { hhmm, medianMin } from "../timechart";
import type { HabitStatCell, HabitStats } from "../types";
import { fullNum } from "./Habits";

// Статистика одной привычки — открывается щелчком по названию на странице «Привычки», строкой под ней:
// серии и проценты, год клетками (как у GitHub), по дням недели и по месяцам, во сколько отмечали.

const WEEK_SHORT = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];
const pct = (r: { done: number; planned: number }) => (r.planned ? Math.round((r.done / r.planned) * 100) : null);
const daysWord = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? "день" : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? "дня" : "дней");
const CELL_TEXT: Record<HabitStatCell, string> = {
  done: "сделано", miss: "не сделано", today: "сегодня, ещё не отмечено", wait: "впереди", rest: "не по расписанию", off: "вне срока привычки",
};
/** Где чаще пропуски: день недели с самым низким процентом, если он заметно хуже остальных. */
function weakDay(w: HabitStats["weekdays"]): string | null {
  const rated = w.map((x, i) => ({ i, p: pct(x), n: x.planned })).filter((x) => x.p !== null && x.n >= 3) as { i: number; p: number }[];
  if (rated.length < 3) return null;
  const worst = rated.reduce((a, b) => (b.p < a.p ? b : a));
  const rest = rated.filter((x) => x !== worst);
  const avg = rest.reduce((s, x) => s + x.p, 0) / rest.length;
  if (avg - worst.p < 15) return null;
  return `Чаще всего пропускаете ${["в понедельник", "во вторник", "в среду", "в четверг", "в пятницу", "в субботу", "в воскресенье"][worst.i]}: ${worst.p} % против ${Math.round(avg)} % в другие дни.`;
}

/** finished — привычка из «Завершённых»: вместо серии сейчас и «за 30 дней» — сколько длилась и итог за срок. */
export function HabitStatsPanel({ id, finished = false }: { id: number; finished?: boolean }) {
  const [s, setS] = useState<HabitStats | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    get<HabitStats>(`/api/habits/${id}/stats`).then((d) => alive && setS(d)).catch((e) => alive && setError((e as Error).message));
    return () => { alive = false; };
  }, [id]);

  return (
    <div className="hg-panel hs" style={{ gridColumn: "1 / -1" }}>
      {error ? <p className="muted small">Не загрузилось: {error}</p> : !s ? <Spinner /> : <StatsBody s={s} finished={finished} />}
    </div>
  );
}

function StatsBody({ s, finished }: { s: HabitStats; finished: boolean }) {
  const p30 = pct(s.rate30);
  const all = pct(s.total);
  const hint = weakDay(s.weekdays);
  const end = s.end_date ?? s.start_date;
  const lasted = daysBetween(s.start_date, end) + 1;
  return (
    <>
      {finished ? (
        <div className="hs-figures">
          <Figure big={`${lasted} ${daysWord(lasted)}`} small={`длилась · ${shortDay(s.start_date)} – ${shortDay(end)}`} />
          <Figure big={String(s.best)} small={`лучшая серия`} />
          <Figure big={all === null ? "—" : `${all} %`} small={`итог · ${s.total.done} из ${s.total.planned}`} />
        </div>
      ) : (
        <div className="hs-figures">
          <Figure big={`🔥 ${s.streak}`} small={`${daysWord(s.streak)} подряд сейчас`} />
          <Figure big={String(s.best)} small={`лучшая серия`} />
          <Figure big={p30 === null ? "—" : `${p30} %`} small={`за 30 дней · ${s.rate30.done} из ${s.rate30.planned}`} />
          <Figure big={all === null ? "—" : `${all} %`} small={`всего · ${s.total.done} из ${s.total.planned}, с ${shortDay(s.start_date)}`} />
        </div>
      )}
      <YearGrid year={s.year} />
      <div className="hs-charts">
        <div>
          <h4 className="hs-sub">По дням недели</h4>
          <Bars
            height={90}
            color="var(--green)"
            format={(v) => `${v} %`}
            bars={s.weekdays.map((w, i) => ({ label: WEEK_SHORT[i], value: pct(w) ?? 0, title: w.planned ? `${WEEKDAYS[i]}: ${w.done} из ${w.planned}` : `${WEEKDAYS[i]}: не по расписанию` }))}
          />
        </div>
        <div>
          <h4 className="hs-sub">По месяцам</h4>
          <Bars
            height={90}
            color="var(--accent)"
            format={(v) => `${v} %`}
            bars={s.months.map((m) => {
              const mo = Number(m.month.slice(5)) - 1;
              return { label: MONTHS[mo].slice(0, 3).toLowerCase(), value: pct(m) ?? 0, title: m.planned ? `${MONTHS[mo]} ${m.month.slice(0, 4)}: ${m.done} из ${m.planned}` : `${MONTHS[mo]}: ещё не было` };
            })}
          />
        </div>
      </div>
      {s.mark_times && <TimesBlock t={s.mark_times} />}
      {hint && <p className="small hs-hint">{hint}</p>}
      {s.amount && <AmountBlock a={s.amount} />}
    </>
  );
}

/** «Во сколько отмечали» — время «сделал» за последние 30 дней срока, 🔔 — когда напоминает. Меньше двух точек — строка вместо графика. */
function TimesBlock({ t }: { t: NonNullable<HabitStats["mark_times"]> }) {
  const med = medianMin(t.points.map((p) => p.min));
  return (
    <div className="hs-times">
      <h4 className="hs-sub">Во сколько отмечали</h4>
      {t.points.length < 2 ? <p className="muted small hs-hint">Пока мало отметок со временем</p> : (
        <>
          {med !== null && <p className="muted small hs-hint">обычно около {hhmm(med)}</p>}
          <MarkTimeLine data={t} />
        </>
      )}
    </div>
  );
}

/** Сколько сделано — по числам, которые человек называл горничной («прочитал 35 страниц»). */
function AmountBlock({ a }: { a: NonNullable<HabitStats["amount"]> }) {
  const u = (v: number) => `${fullNum(v)}${a.unit ? " " + a.unit : ""}`;
  return (
    <div className="hs-amount">
      <h4 className="hs-sub">Сколько — по вашим словам</h4>
      <div className="hs-figures">
        <Figure big={u(a.week)} small="за эту неделю" />
        <Figure big={u(a.month)} small="за этот месяц" />
        <Figure big={u(a.total)} small="всего" />
        <Figure big={u(a.best.value)} small={`лучший день · ${shortDay(a.best.day)}`} />
      </div>
      <Bars
        height={90}
        color="var(--green)"
        format={(v) => (v ? u(v) : "—")}
        bars={a.days.map((d) => ({ label: String(Number(d.day.slice(-2))), value: d.value ?? 0, title: `${shortDay(d.day)}${d.value == null ? ": числа нет" : ""}` }))}
      />
    </div>
  );
}

function Figure({ big, small }: { big: string; small: string }) {
  return (
    <div className="hs-figure">
      <b>{big}</b>
      <span className="muted small">{small}</span>
    </div>
  );
}

/** Год клетками: столбец — неделя (сверху понедельник), подписи месяцев над первой неделей месяца. */
function YearGrid({ year }: { year: HabitStats["year"] }) {
  const C = 11, G = 3, TOP = 14, LEFT = 22;
  const weeks = Math.ceil(year.length / 7);
  const w = LEFT + weeks * (C + G);
  const h = TOP + 7 * (C + G);
  const labels: { x: number; text: string }[] = [];
  for (let k = 0; k < weeks; k++) {
    const first = year[k * 7];
    const m = Number(first.day.slice(5, 7)) - 1;
    const prev = k ? Number(year[(k - 1) * 7].day.slice(5, 7)) - 1 : -1;
    if (m !== prev && (labels.length === 0 || k * (C + G) + LEFT - labels.at(-1)!.x > 24)) labels.push({ x: LEFT + k * (C + G), text: MONTHS[m].slice(0, 3).toLowerCase() });
  }
  // Свежие недели — справа: на узком экране сразу видно их, а не год назад.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { if (box.current) box.current.scrollLeft = box.current.scrollWidth; }, []);
  return (
    <div className="hs-year" ref={box}>
      <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} role="img" aria-label="Год по дням">
        {labels.map((l) => <text key={l.x} x={l.x} y={10} className="hs-label">{l.text}</text>)}
        {[0, 2, 4].map((r) => <text key={r} x={0} y={TOP + r * (C + G) + C - 2} className="hs-label">{WEEK_SHORT[r]}</text>)}
        {year.map((d, i) => {
          const [, mo, dd] = d.day.split("-").map(Number);
          return (
            <rect key={d.day} x={LEFT + Math.floor(i / 7) * (C + G)} y={TOP + (i % 7) * (C + G)} width={C} height={C} rx={2.5} className={`hs-c ${d.s}`}>
              <title>{`${dd} ${MONTHS_GEN[mo - 1]} — ${CELL_TEXT[d.s]}`}</title>
            </rect>
          );
        })}
      </svg>
      <div className="hs-legend muted small">
        <i className="hs-c done" /> сделано <i className="hs-c miss" /> не сделано <i className="hs-c rest" /> не по расписанию
      </div>
    </div>
  );
}
