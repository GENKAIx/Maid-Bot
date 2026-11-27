import { type CSSProperties, type PointerEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { get, post } from "../api";
import { Bars } from "../charts";
import { Spinner } from "../components";
import { MONTHS, MONTHS_GEN, addDays, shortDay } from "../format";
import {
  type MarkPoint, type RinaAct, type Span, PRESETS, applyRinaAct, bandText, clockDots, clockPos, daysText, dayName, durText, fixSpan, hourAt, marksText, plural,
  dueFn, pointsIn, presetSpan, rangeText, rhythmView, rinaNote, responseView, scheduleFrom, streakView, tallyYear, timesText, usualBands, weekFromYear, weekView,
  yearMonths,
} from "../habitpanel";
import { daysBetween } from "../habitview";
import { hhmm, toMin } from "../timechart";
import type { HabitStatCell, HabitStats } from "../types";
import { MarkChart, Overview } from "./HabitMarkChart";
import { fullNum } from "./Habits";

// Раскрытая привычка на странице «Привычки» (27.11.2026, макет «Привычки: месяц сеткой») — строкой во всю ширину под
// привычкой: сверху head (отметка за сегодня, 🔔, 🏁 — их рисует Habits.tsx), «Во сколько отмечали» с отрезками и рамкой обзора,
// серия к рекорду и вехи, сутки циферблатом, дни недели, год по месяцам, отклик на напоминание (у ×N — ритм дня), «Рина заметила»,
// «Сколько — по вашим словам». Циферблат, дни недели (не короче 3 месяцев), отклик, ритм и Рина считаются по выбранному отрезку.
// Данные — GET /api/habits/:id/stats; совет Рины кнопкой меняет напоминания (POST /api/habits/:id, с «↩ Отменить»).

const WEEK_SHORT = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];
const pct = (r: { done: number; planned: number }) => (r.planned ? Math.round((r.done / r.planned) * 100) : null);
const CELL_TEXT: Record<HabitStatCell | "skip" | "part", string> = {
  done: "сделано", miss: "не сделано", today: "сегодня, ещё не отмечено", wait: "впереди", rest: "не по расписанию", off: "вне срока привычки",
  skip: "пропуск", part: "отмечено не всё",
};
/** Расписание из сетки месяца (scheduleFrom; не видно — null), сколько раз в день и сколько отмечено сегодня. */
type Sched = { days: string | null; per_day?: number; count?: number };

/** finished — привычка из «Завершённых»: вместо серии — сколько длилась и итог за срок. version — данные поменялись (отметка):
 *  статистика перечитывается, выбранный отрезок остаётся. */
export function HabitStatsPanel({ id, version = 0, finished = false, head, habit, onChanged }: {
  id: number; version?: number; finished?: boolean; head?: ReactNode; habit?: Sched; onChanged?: () => void;
}) {
  const [s, setS] = useState<HabitStats | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    get<HabitStats>(`/api/habits/${id}/stats`).then((d) => alive && setS(d)).catch((e) => alive && setError((e as Error).message));
    return () => { alive = false; };
  }, [id, version]);

  return (
    <div className="hg-panel hp" id={`hp-${id}`} style={{ gridColumn: "1 / -1" }}>
      {head}
      {error ? <p className="muted small">Не загрузилось: {error}</p> : !s ? <Spinner /> : <StatsBody s={s} finished={finished} habit={habit} id={id} onChanged={onChanged} />}
    </div>
  );
}

function StatsBody({ s, finished, habit, id, onChanged }: { s: HabitStats; finished: boolean; habit?: Sched; id: number; onChanged?: () => void }) {
  const t = s.mark_times ?? { from: s.start_date, to: s.end_date ?? s.start_date, per_day: 1, points: [], remind: [] };
  const today = t.to;
  const total = daysBetween(t.from, t.to) + 1;
  const [pre, setPre] = useState<number | null>(30);
  const [span, setSpan] = useState<Span>(() => presetSpan(total, 30));
  const [full, setFull] = useState(false);
  // Срок вырос (наступил новый день) — отрезок кнопкой пересчитывается, протянутый вручную — только поджимается в окно.
  useEffect(() => { setSpan((x) => (pre !== null ? presetSpan(total, pre) : fixSpan(x, total))); }, [total]); // eslint-disable-line react-hooks/exhaustive-deps
  const a = addDays(t.from, span.a), b = addDays(t.from, Math.min(span.b, total - 1));
  const pts = useMemo(() => pointsIn(t.points, a, b), [t.points, a, b]);
  const perDay = t.per_day || habit?.per_day || 1;
  // Расписание: из сетки месяца, иначе по клеткам года (не по расписанию — rest); дни года — прямо по клеткам (dueFn).
  const schedule = habit?.days ?? scheduleFrom(s.year.filter((c) => c.s !== "off").map((c) => ({ day: c.day, due: c.s !== "rest" })));
  const isDue = useMemo(() => dueFn(s.year, schedule, s.start_date, s.end_date), [s, schedule]);
  // Дни недели — по отрезку (не короче 3 месяцев); весь срок или отрезок старше года — по всем отметкам (s.weekdays).
  const week = useMemo(() => {
    const whole = a <= t.from && b >= t.to;
    if (whole || !s.year.length || a < s.year[0].day) return { w: s.weekdays, wide: false, whole };
    return { ...weekFromYear(s.year, a, b), whole };
  }, [s, a, b, t.from, t.to]);
  const year = Number(today.slice(0, 4));
  const setBy = (v: number) => { setPre(v); setSpan(presetSpan(total, v)); };
  // Протягивание рамки: не чаще кадра (иначе вся панель пересчитывается на каждое движение указателя).
  const raf = useRef(0);
  const next = useRef<Span | null>(null);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);
  const onSpan = (x: Span) => {
    setPre(null);
    next.current = x;
    if (!raf.current) raf.current = requestAnimationFrame(() => { raf.current = 0; if (next.current) setSpan(next.current); });
  };
  const tally = a <= t.from && b >= t.to ? s.total : tallyYear(s.year, a, b);
  return (
    <>
      <section className="hp-chc">
        <div className="hp-chh">
          <div>
            <p className="hp-cap">Во сколько отмечали</p>
            <p className="hp-rng" aria-live="polite"><b>{rangeText(a, b, year)}</b> · {daysText(daysBetween(a, b) + 1)} · {marksText(pts.length)}</p>
          </div>
          <div className="segment hp-seg" role="group" aria-label="Отрезок">
            {PRESETS.map(([v, name]) => <button key={v} className={pre === v ? "on" : ""} aria-pressed={pre === v} onClick={() => setBy(v)}>{name}</button>)}
          </div>
          <div className="segment hp-seg" role="group" aria-label="Время суток">
            <button className={!full ? "on" : ""} aria-pressed={!full} onClick={() => setFull(false)}>По отметкам</button>
            <button className={full ? "on" : ""} aria-pressed={full} onClick={() => setFull(true)}>Сутки целиком</button>
          </div>
        </div>
        {t.points.length < 2 ? <p className="muted small hp-empty">Пока мало отметок со временем — график появится, когда их станет больше.</p> : (
          <>
            <MarkChart points={pts} remind={t.remind} perDay={perDay} a={a} b={b} full={full} today={today} />
            <Overview points={t.points} perDay={perDay} from={t.from} total={total} span={span} onSpan={onSpan} today={today} />
            <p className="hp-ovx">
              <span>с {shortDay(t.from)}{Number(t.from.slice(0, 4)) !== year ? ` ${t.from.slice(0, 4)}` : ""}</span>
              <span>Протяните по полосе, чтобы выбрать свой отрезок; рамку можно двигать и растягивать за края.</span>
              <span>{finished ? shortDay(t.to) : "сегодня"}</span>
            </p>
          </>
        )}
      </section>
      <div className="hp-gr">
        <div className="hp-b">{finished ? <FinalBlock s={s} /> : <StreakBlock s={s} isDue={isDue} today={today} perDay={perDay} count={habit?.count ?? 0} />}</div>
        <div className="hp-b"><ClockBlock pts={pts} perDay={perDay} remind={t.remind} /></div>
        <div className="hp-b"><WeekBlock w={week.w} note={week.wide ? " за 3 месяца" : week.whole ? "" : " на отрезке"} /></div>
        <div className="hp-b wide"><YearBlock s={s} today={today} /></div>
        <div className="hp-b">
          {perDay > 1
            ? <RhythmBlock pts={pts} perDay={perDay} isDue={isDue} a={a} b={b} today={finished ? addDays(t.to, 1) : today} tally={tally} />
            : <ResponseBlock pts={pts} remind={t.remind} tally={tally} />}
        </div>
        <RinaBlock key={`${a}:${b}`} id={id} pts={pts} perDay={perDay} remind={t.remind} weekdays={week.w} s={s} live={!finished} onChanged={onChanged} />
        {s.amount && <AmountBlock a={s.amount} />}
      </div>
    </>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return <p className="hp-kv"><span>{k}</span><b>{v}</b></p>;
}

function StreakBlock({ s, isDue, today, perDay, count }: { s: HabitStats; isDue: (d: string) => boolean | null; today: string; perDay: number; count: number }) {
  const todayCell = s.year.find((c) => c.day === today)?.s;
  const v = streakView({ streak: s.streak, best: s.best, todayOpen: todayCell === "today", isDue, today });
  const p30 = pct(s.rate30), all = pct(s.total);
  return (
    <>
      <p className="hp-cap">Серия</p>
      <p className="hp-bign"><b>{s.streak}</b>{plural(s.streak, "день", "дня", "дней")} подряд</p>
      <div className="hp-prog" role="img" aria-label={`Серия ${s.streak} из рекорда ${v.best}`}>
        <i style={{ width: `${v.pct}%` }} /><span className="end">рекорд {v.best}</span>
      </div>
      <p className="hp-tx">
        {v.record ? "Это ваш рекорд — каждый новый день его продлевает."
          : v.best === 0 ? "Серия начнётся с первого сделанного дня."
          : <>До нового рекорда ещё <b>{daysText(v.need)}</b>.{v.beatOn ? ` Без пропусков побьёте его ${shortDay(v.beatOn)}.` : ""}</>}
      </p>
      {todayCell === "today" && <p className="hp-tx">{perDay > 1 ? `Ещё ${marksText(Math.max(1, perDay - count))} сегодня, и` : "Если отметить сегодня —"} серия станет <b>{s.streak + 1}</b>.</p>}
      <ul className="hp-ms" aria-label="Вехи">{v.milestones.map((m) => <li key={m.m} className={m.got ? "got" : ""}>{daysText(m.m)}</li>)}</ul>
      {v.next && <p className="hp-tx">До вехи «{daysText(v.next)}» осталось {daysText(v.toNext)}.</p>}
      <p className="hp-tx muted">за 30 дней {p30 === null ? "—" : `${p30} %`} · всего {s.total.done} из {s.total.planned}{all === null ? "" : ` (${all} %)`}, с {shortDay(s.start_date)}</p>
    </>
  );
}

function FinalBlock({ s }: { s: HabitStats }) {
  const end = s.end_date ?? s.start_date;
  const lasted = daysBetween(s.start_date, end) + 1;
  const all = pct(s.total);
  return (
    <>
      <p className="hp-cap">Итог</p>
      <p className="hp-bign"><b>{lasted}</b>{plural(lasted, "день", "дня", "дней")} длилась</p>
      <KV k="Срок" v={`${shortDay(s.start_date)} – ${shortDay(end)}`} />
      <KV k="Лучшая серия" v={daysText(s.best)} />
      <KV k="Сделано" v={`${s.total.done} из ${s.total.planned}${all === null ? "" : ` (${all} %)`}`} />
    </>
  );
}

/** Сутки циферблатом: точки отметок отрезка (ближе к краю — недавние), дуга «обычно», стрелки — напоминания. Наведение
 *  или касание часа — сколько отметок в этот час. */
function ClockBlock({ pts, perDay, remind }: { pts: MarkPoint[]; perDay: number; remind: string[] }) {
  const [hour, setHour] = useState<number | null>(null);
  const bands = usualBands(pts, perDay);
  const dots = pts.length ? clockDots(pts, pts[0].day, pts.at(-1)!.day) : [];
  const rr = pts.length > 300 ? 1.2 : pts.length > 80 ? 1.8 : 2.6;
  const arc = (lo: number, hi: number) => {
    const [x1, y1] = clockPos(lo, 84), [x2, y2] = clockPos(Math.max(hi, lo + 4), 84);
    return `M${x1} ${y1} A84 84 0 ${hi - lo > 720 ? 1 : 0} 1 ${x2} ${y2}`;
  };
  function over(e: PointerEvent<SVGSVGElement>) {
    const rc = e.currentTarget.getBoundingClientRect();
    setHour(hourAt(e.clientX - rc.left - rc.width / 2, e.clientY - rc.top - rc.height / 2));
  }
  const inHour = hour === null ? 0 : pts.filter((p) => Math.floor(p.min / 60) === hour).length;
  const b0 = bands[0];
  const text = !b0 ? "Отметок на отрезке мало." : b0.win ? `Обычно с ${hhmm(b0.lo)} до ${hhmm(b0.hi)}.` : `${bands.map((x) => bandText(x)).join(", ").replace(/^о/, "О")}.`;
  const sector = (h: number) => { const [x1, y1] = clockPos(h * 60, 84), [x2, y2] = clockPos(h * 60 + 60, 84); return `M100 100 L${x1} ${y1} A84 84 0 0 1 ${x2} ${y2}Z`; };
  return (
    <>
      <p className="hp-cap">Сутки</p>
      <div className="hp-clkw">
        <svg className="hp-clk" viewBox="0 0 200 200" role="img" aria-label="Сутки циферблатом: точки отметок, стрелки напоминаний"
          onPointerMove={over} onPointerDown={over} onPointerLeave={(e) => e.pointerType === "mouse" && setHour(null)}>
          <circle className="fc" cx="100" cy="100" r="84" />
          {hour !== null && <path className="sec" d={sector(hour)} />}
          {Array.from({ length: 24 }, (_, h) => { const [x1, y1] = clockPos(h * 60, h % 6 ? 80 : 74), [x2, y2] = clockPos(h * 60, 84); return <line key={h} className="tk" x1={x1} y1={y1} x2={x2} y2={y2} />; })}
          {[0, 6, 12, 18].map((h) => { const [x, y] = clockPos(h * 60, 94); return <text key={h} x={x} y={y + 4} textAnchor="middle">{h}</text>; })}
          {bands.map((x, i) => <path key={i} className="arc" d={arc(x.lo, x.hi)} />)}
          {dots.map((d, i) => <circle key={i} className="cd" cx={d.x} cy={d.y} r={rr} />)}
          {remind.map((r) => { const [x1, y1] = clockPos(toMin(r), 50), [x2, y2] = clockPos(toMin(r), 84); return <line key={r} className="hand" x1={x1} y1={y1} x2={x2} y2={y2} />; })}
          <circle className="mid" cx="100" cy="100" r="25" />
          {b0 && b0.win ? <><text className="ct" x="100" y="97" textAnchor="middle">{hhmm(b0.lo)}</text><text className="ct" x="100" y="113" textAnchor="middle">{hhmm(b0.hi)}</text></>
            : bands.length === 1 ? <text className="ct" x="100" y="105" textAnchor="middle">{hhmm(b0.med!)}</text> : null}
        </svg>
        <p className="hp-tx" aria-live="polite">
          {hour !== null
            ? <>С {String(hour).padStart(2, "0")}:00 до {String((hour + 1) % 24).padStart(2, "0")}:00: <b>{marksText(inHour)}</b> из {pts.length}.</>
            : <>{text} Ближе к краю — недавние дни, стрелки — напоминания. Коснитесь циферблата, чтобы увидеть час.</>}
        </p>
      </div>
    </>
  );
}

function WeekBlock({ w, note }: { w: HabitStats["weekdays"]; note: string }) {
  const v = weekView(w);
  return (
    <>
      <p className="hp-cap">Дни недели{note}</p>
      <p className="hp-tx">{v.text}</p>
      <div className="hp-wk" role="img" aria-label={v.p.map((p, i) => `${WEEK_SHORT[i]} ${p === null ? "не по плану" : `${p} %`}`).join(", ")}>
        {v.p.map((p, i) => (
          <span key={i} className={p === null ? "no" : i === v.lo ? "lo" : ""} title={w[i].planned ? `${w[i].done} из ${w[i].planned}` : "не по расписанию"}>
            <em>{p !== null && (i === v.hi || i === v.lo) ? `${p}%` : ""}</em>
            <i style={{ "--h": ((p ?? 0) / 100).toFixed(2) } as CSSProperties} />
            {WEEK_SHORT[i]}
          </span>
        ))}
      </div>
    </>
  );
}

/** Год по месяцам: у месяца свой столбец недель (сверху понедельник), подписи месяцев, лучший месяц подчёркнут. */
function YearBlock({ s, today }: { s: HabitStats; today: string }) {
  const { months, best } = yearMonths(s.year, today);
  const [pick, setPick] = useState<string | null>(null);
  const year = Number(today.slice(0, 4));
  const cell = pick ? s.year.find((c) => c.day === pick) : undefined;
  const first = months[0];
  const name = (m: string) => MONTHS[Number(m.slice(5)) - 1].toLowerCase();
  return (
    <>
      <p className="hp-cap">Год по месяцам</p>
      {/* Свежие месяцы — справа: на узком экране полоса открывается на них. */}
      <div className="hp-yr" role="img" aria-label={`Год по месяцам, с ${MONTHS_GEN[Number(first.month.slice(5)) - 1]} ${first.month.slice(0, 4)}`}
        ref={(el) => { if (el && !el.dataset.scrolled) { el.dataset.scrolled = "1"; el.scrollLeft = el.scrollWidth; } }}>
        <div className="hp-ywd" aria-hidden="true"><span />{WEEK_SHORT.map((w, i) => <span key={i}>{i % 2 || i > 4 ? "" : w}</span>)}</div>
        {months.map((m) => (
          <div key={m.month} className="hp-ym" style={{ "--n": m.weeks } as CSSProperties}>
            <span className={m === best ? "bst" : ""}>{name(m.month).slice(0, 3)}</span>
            <div>
              {Array.from({ length: m.offset }, (_, i) => <i key={`e${i}`} className="e" />)}
              {m.cells.map((c) => (
                <i key={c.day} data-s={c.s} data-k={c.k} className={pick === c.day ? "pick" : ""} onPointerEnter={() => setPick(c.day)} onPointerDown={() => setPick(c.day)}
                  style={c.k === "part" && c.p !== undefined ? ({ "--p": `${Math.round(c.p * 100)}%` } as CSSProperties) : undefined} />
              ))}
            </div>
          </div>
        ))}
      </div>
      <p className="hp-tx" aria-live="polite">
        {pick ? `${dayName(pick, year)}: ${CELL_TEXT[cell?.k ?? cell?.s ?? "off"]}.`
          : <>{best ? <>Лучший месяц: <b>{name(best.month)}{Number(best.month.slice(0, 4)) !== year ? ` ${best.month.slice(0, 4)}` : ""}</b>, {best.done} из {best.planned}. </> : ""}Коснитесь клетки, чтобы увидеть день.</>}
      </p>
    </>
  );
}

function ResponseBlock({ pts, remind, tally }: { pts: MarkPoint[]; remind: string[]; tally: { done: number; planned: number } | null }) {
  const r = responseView(pts, remind.map(toMin).sort((x, y) => x - y));
  if (!r) return <><p className="hp-cap">{remind.length ? "Отклик на напоминание" : "Ритм"}</p><p className="hp-tx">Отметок на отрезке пока мало — выберите отрезок подлиннее.</p></>;
  return (
    <>
      <p className="hp-cap">{r.after === null ? "Ритм" : "Отклик на напоминание"}</p>
      {r.after === null ? <KV k="Обычно" v={hhmm(r.usual)} />
        : <KV k="После напоминания" v={r.after >= 0 ? `через ${durText(r.after)}` : `за ${durText(r.after)} до`} />}
      {r.spread !== null && <KV k="Обычный разброс" v={`± ${durText(r.spread)}`} />}
      <KV k="Самая ранняя и поздняя" v={`${hhmm(r.early)} и ${hhmm(r.late)}`} />
      {tally && <KV k="Сделано на отрезке" v={`${tally.done} из ${tally.planned}`} />}
    </>
  );
}

function RhythmBlock({ tally, ...o }: { pts: MarkPoint[]; perDay: number; isDue: (d: string) => boolean | null; a: string; b: string; today: string; tally: { done: number; planned: number } | null }) {
  const r = rhythmView(o);
  if (!r) return <><p className="hp-cap">Ритм дня</p><p className="hp-tx">Отметок на отрезке пока мало — выберите отрезок подлиннее.</p></>;
  return (
    <>
      <p className="hp-cap">Ритм дня · {timesText(o.perDay)} в день</p>
      <KV k="В среднем в день" v={r.avg === null ? "нет данных" : `${r.avg.toFixed(1).replace(".", ",")} из ${o.perDay}`} />
      {tally && <KV k="Норма набрана" v={`${tally.done} из ${tally.planned} ${plural(tally.planned, "дня", "дней", "дней")}`} />}
      {r.first !== null && <KV k="Первая отметка обычно" v={hhmm(r.first)} />}
      {r.last !== null && <KV k="Последняя обычно" v={hhmm(r.last)} />}
      {r.gap !== null && <KV k="Между отметками" v={`около ${durText(r.gap)}`} />}
    </>
  );
}

/** «Рина заметила»: наблюдение по отрезку и совет кнопкой (live — у идущей привычки): «Напоминать в 12:40» меняет время
 *  напоминаний тем же путём, что 🔔 (POST /api/habits/:id times), с «↩ Отменить». */
function RinaBlock({ id, pts, perDay, remind, weekdays, s, live, onChanged }: {
  id: number; pts: MarkPoint[]; perDay: number; remind: string[]; weekdays: HabitStats["weekdays"]; s: HabitStats; live: boolean; onChanged?: () => void;
}) {
  const note = useMemo(() => rinaNote({ pts, perDay, remind, weekdays, streak: s.streak, best: s.best }), [pts, perDay, remind, weekdays, s.streak, s.best]);
  const [done, setDone] = useState<{ text: string; undo: number | null; bad?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  async function apply(act: RinaAct) {
    setBusy(true);
    try {
      const r = await post<{ undo: number | null }>(`/api/habits/${id}`, { times: applyRinaAct(remind, act) });
      setDone({ text: `Готово, напоминание теперь ${act.replace ? "в" : "ещё и в"} ${act.time}. Посмотрим через неделю, помогло ли.`, undo: r.undo });
      onChanged?.();
    } catch (e) {
      setDone({ text: `Не получилось: ${(e as Error).message}`, undo: null, bad: true });
    } finally {
      setBusy(false);
    }
  }
  async function undo(m: number) {
    setDone(null);
    try {
      await post("/api/undo", { messageId: m });
      onChanged?.();
    } catch (e) {
      setDone({ text: `Не получилось отменить: ${(e as Error).message}`, undo: null, bad: true });
    }
  }
  return (
    <div className="hp-b hp-rn">
      <img src={`/maid/${done && !done.bad ? "happy" : note.mood}.webp`} alt="" width={48} height={51} />
      <div>
        <p className="hp-cap">Рина заметила</p>
        <p aria-live="polite">{done ? done.text : note.text}</p>
        {done?.undo != null && <button className="link" onClick={() => undo(done.undo!)}>↩ Отменить</button>}
        {!done && live && note.act && <button className="primary" disabled={busy} onClick={() => apply(note.act!)}>{note.act.label}</button>}
      </div>
    </div>
  );
}

/** Сколько сделано — по числам, которые человек называл горничной («прочитал 35 страниц»). */
function AmountBlock({ a }: { a: NonNullable<HabitStats["amount"]> }) {
  const u = (v: number) => `${fullNum(v)}${a.unit ? " " + a.unit : ""}`;
  return (
    <div className="hp-b wide hs-amount">
      <p className="hp-cap">Сколько — по вашим словам</p>
      <div className="hs-figures">
        <Figure big={u(a.week)} small="за эту неделю" />
        <Figure big={u(a.month)} small="за этот месяц" />
        <Figure big={u(a.total)} small="всего" />
        <Figure big={u(a.best.value)} small={`лучший день · ${shortDay(a.best.day)}`} />
      </div>
      <Bars
        height={90}
        color="var(--habit-done)"
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
