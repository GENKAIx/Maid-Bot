import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { scoreNum } from "./dayscore";
import { shortDay } from "./format";
import { DAY_SEC, dayParts } from "./pcday";
import { hoursAxis, sleepHoursText, sleepScorePoints, sleepScoreSummary, sleepScoreTip, type SleepScorePair } from "./sleepscore";
import { axisLabels, dayPos, dayTicks, gapLinks, hitBands, lineRuns, markerSize, pointTip, timeScale, timeSummary, tipLeft, tipTop, toMin } from "./timechart";

// Графики без библиотек: столбики по дням/неделям/месяцам, подпись при наведении.

export interface Bar {
  label: string;
  value: number;
  /** Подпись в подсказке (день или период). */
  title?: string;
}

export function Bars({ bars, color = "var(--accent)", format = (v: number) => String(v), height = 140, goal }: {
  bars: Bar[]; color?: string; format?: (v: number) => string; height?: number; goal?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(goal ?? 0, ...bars.map((b) => b.value), 1);
  const w = 100 / bars.length;
  const step = Math.max(1, Math.ceil(bars.length / 10));
  return (
    <div className="chart">
      <div className="chart-area" style={{ height }} onMouseLeave={() => setHover(null)}>
        {goal !== undefined && <div className="chart-goal" style={{ bottom: `${(goal / max) * 100}%` }} title={`цель ${format(goal)}`} />}
        {bars.map((b, i) => (
          <div
            key={i}
            className={`chart-col ${hover === i ? "on" : ""}`}
            style={{ width: `${w}%` }}
            onMouseEnter={() => setHover(i)}
            onClick={() => setHover(hover === i ? null : i)}
          >
            <div className="chart-bar" style={{ height: `${(b.value / max) * 100}%`, background: b.value ? color : "transparent", animationDelay: `${i * 12}ms` }} />
          </div>
        ))}
        {hover !== null && bars[hover] && (
          <div className="chart-tip" style={{ left: `${(hover + 0.5) * w}%` }}>
            <b>{format(bars[hover].value)}</b> · {bars[hover].title ?? bars[hover].label}
          </div>
        )}
      </div>
      <div className="chart-labels">
        {bars.map((b, i) => (
          <span key={i} style={{ width: `${w}%` }}>{i % step === 0 ? b.label : ""}</span>
        ))}
      </div>
    </div>
  );
}

/** Столбики из частей (расходы дня по категориям). future — день ещё не наступил: пустой пунктир высотой avg.
 *  highlight — выбранная часть: остальные бледнеют. mark — подпись, которая видна всегда («сегодня, 18»). */
export function StackedBars({ bars, format, height = 150, avg, highlight }: {
  bars: { label: string; title?: string; mark?: boolean; future?: boolean; parts: { key: string; value: number; color: string }[] }[];
  format: (v: number) => string; height?: number; avg?: { value: number; label: string }; highlight?: string | null;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const sum = (b: (typeof bars)[number]) => b.parts.reduce((s, p) => s + p.value, 0);
  const max = Math.max(avg?.value ?? 0, ...bars.map(sum), 1);
  const w = 100 / bars.length;
  const step = Math.max(1, Math.ceil(bars.length / 10));
  const tip = (b: (typeof bars)[number]) => {
    const ps = b.parts.filter((p) => p.value && (!highlight || p.key === highlight)).sort((a, z) => z.value - a.value);
    const total = ps.reduce((s, p) => s + p.value, 0);
    return `${b.title ?? b.label}: ${format(total)}${ps.length > 1 ? "\n" + ps.map((p) => `${p.key} — ${format(p.value)}`).join("\n") : ""}`;
  };
  return (
    <div className="chart">
      <div className={`chart-area ${highlight ? "dim" : ""}`} style={{ height }} onMouseLeave={() => setHover(null)}>
        {avg && <div className="chart-avg" style={{ bottom: `${(avg.value / max) * 100}%` }}><span>{avg.label}</span></div>}
        {bars.map((b, i) => (
          <div
            key={i}
            className={`chart-col ${hover === i ? "on" : ""}`}
            style={{ width: `${w}%` }}
            onMouseEnter={() => !b.future && setHover(i)}
            onClick={() => !b.future && setHover(hover === i ? null : i)}
          >
            {b.future && avg
              ? <div className="chart-bar future" style={{ height: `${(avg.value / max) * 100}%` }} />
              : (
                <div className="chart-bar stack" style={{ height: `${(sum(b) / max) * 100}%`, animationDelay: `${i * 12}ms` }}>
                  {b.parts.filter((p) => p.value).map((p) => (
                    <i key={p.key} className={highlight === p.key ? "hl" : ""} style={{ flexGrow: p.value, background: p.color }} />
                  ))}
                </div>
              )}
          </div>
        ))}
        {hover !== null && bars[hover] && (
          <div className="chart-tip" style={{ left: `${(hover + 0.5) * w}%` }}>{tip(bars[hover])}</div>
        )}
      </div>
      <div className="chart-labels">
        {bars.map((b, i) => (
          <span key={i} className={b.mark ? "mark" : ""} style={{ width: `${w}%` }}>{b.mark || (i % step === 0 && !bars.slice(i + 1, i + step).some((x) => x.mark) && !bars.slice(Math.max(0, i - 2), i).some((x) => x.mark)) ? b.label : ""}</span>
        ))}
      </div>
    </div>
  );
}

/** Столбик в столбике: всё время (back) и часть его (front) снизу — время за ПК и игры в нём. */
export function NestedBars({ bars, back, front, format, tip, height = 160, goal }: {
  bars: { label: string; title?: string; back: number; front: number }[];
  back: string; front: string; format: (v: number) => string;
  tip: (b: { back: number; front: number }) => string; height?: number; goal?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(goal ?? 0, ...bars.map((b) => Math.max(b.back, b.front)), 1);
  const w = 100 / bars.length;
  const step = Math.max(1, Math.ceil(bars.length / 10));
  return (
    <div className="chart">
      <div className="chart-area" style={{ height }} onMouseLeave={() => setHover(null)}>
        {goal !== undefined && <div className="chart-goal" style={{ bottom: `${(goal / max) * 100}%` }} title={`цель ${format(goal)}`} />}
        {bars.map((b, i) => (
          <div key={i} className={`chart-col ${hover === i ? "on" : ""}`} style={{ width: `${w}%` }} onMouseEnter={() => setHover(i)} onClick={() => setHover(hover === i ? null : i)}>
            <div className="chart-bar nested" style={{ height: `${(Math.max(b.back, b.front) / max) * 100}%`, background: b.back ? back : "transparent", animationDelay: `${i * 12}ms` }}>
              {b.front > 0 && <i style={{ height: `${(b.front / Math.max(b.back, b.front)) * 100}%`, background: front }} />}
            </div>
          </div>
        ))}
        {hover !== null && bars[hover] && (
          <div className="chart-tip" style={{ left: `${(hover + 0.5) * w}%` }}>
            <b>{bars[hover].title ?? bars[hover].label}</b><br />{tip(bars[hover])}
          </div>
        )}
      </div>
      <div className="chart-labels">
        {bars.map((b, i) => (
          <span key={i} style={{ width: `${w}%` }}>{i % step === 0 ? b.label : ""}</span>
        ))}
      </div>
    </div>
  );
}

/** Круг суток: целый круг — 24 ч; красное — игры, серое — остальное время за ПК, пустое — не за компьютером.
 *  Отсчёт от верха по часовой; текста внутри нет — числа в подписях рядом. */
export function DayPie({ pc, games, format, size = 84 }: { pc: number; games: number; format: (v: number) => string; size?: number }) {
  const p = dayParts(pc, games);
  const r = 15.9155; // длина окружности 100: доли — прямо проценты
  const pct = (v: number) => (v / DAY_SEC) * 100;
  const arc = (from: number, len: number, color: string) =>
    len > 0 && <circle className="pie-arc" cx="21" cy="21" r={r} fill="none" stroke={color} strokeWidth="6"
      strokeDasharray={`${pct(len)} ${100 - pct(len)}`} strokeDashoffset={25 - pct(from)} />;
  return (
    <svg className="day-pie" width={size} height={size} viewBox="0 0 42 42" role="img"
      aria-label={`За компьютером ${format(p.pc)} из 24 часов, из них игры ${format(p.games)}`}>
      <circle cx="21" cy="21" r={r} fill="none" stroke="var(--ring-bg)" strokeWidth="6" />
      {arc(0, p.games, "var(--red)")}
      {arc(p.games, p.pcRest, "var(--grey)")}
    </svg>
  );
}

/** Горизонтальные полосы долей (категории расходов). */
export function Shares({ items, format, active, onPick }: {
  items: { label: string; value: number; color?: string }[]; format: (v: number) => string;
  /** Щелчок по строке выбирает её (повторный — снимает выбор). */ active?: string | null; onPick?: (label: string | null) => void;
}) {
  const total = items.reduce((s, i) => s + i.value, 0) || 1;
  return (
    <ul className="shares">
      {items.map((i) => (
        <li
          key={i.label}
          className={`${onPick ? "pick" : ""} ${active === i.label ? "on" : ""} ${active && active !== i.label ? "off" : ""}`}
          onClick={onPick && (() => onPick(active === i.label ? null : i.label))}
          {...(onPick ? {
            role: "button", tabIndex: 0, "aria-pressed": active === i.label,
            onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(active === i.label ? null : i.label); } },
          } : {})}
        >
          <span className="share-label">{i.color && onPick && <i className="share-dot" style={{ background: i.color }} />}{i.label}</span>
          <span className="share-bar"><i style={{ width: `${(i.value / total) * 100}%`, background: i.color ?? "var(--accent)" }} /></span>
          <span className="share-value">{format(i.value)} <span className="muted small">{Math.round((i.value / total) * 100)}%</span></span>
        </li>
      ))}
    </ul>
  );
}

export function Segment<T extends string>({ value, options, onChange }: { value: T; options: { id: T; title: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="segment">
      {options.map((o) => (
        <button key={o.id} className={o.id === value ? "on" : ""} onClick={() => onChange(o.id)}>{o.title}</button>
      ))}
    </div>
  );
}

/** «Во сколько отмечали» (статистика привычки, 26.11.2026): линия времени суток по дням — X по дате (пропущенные дни — пробел),
 *  Y — время, позже — выше (до 23:59). Напоминания (remind) — подпись «🔔 12:00» на оси слева, засечка поперёк оси и бледный
 *  пунктир через весь график (час рядом с напоминанием не подписывается). Через дни по расписанию без отметки (gap) линия
 *  идёт бледным пунктиром. Точки густо (ближе 12 px) — мельче. Подсказка — в одну строку над точкой (у верха — под ней),
 *  у краёв прижата к краю по своей ширине (ближайший день по X: наведение, фокус, касание; вертикальная линия-прицел);
 *  таблица день → время — под графиком в «Таблицей». */
export function MarkTimeLine({ data, color = "var(--green)", height = 160 }: {
  data: { from: string; to: string; points: { day: string; time: string; min: number; gap: boolean }[]; remind: string[] };
  color?: string; height?: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(320);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    if (el.clientWidth) setW(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((es) => { const x = Math.round(es[0]?.contentRect.width ?? 0); if (x) setW(x); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [hover, setHover] = useState<number | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [tipW, setTipW] = useState(0);
  useLayoutEffect(() => { const el = tipRef.current; if (el && el.offsetWidth !== tipW) setTipW(el.offsetWidth); });
  const remind = data.remind.map(toMin);
  const sc = timeScale([...data.points.map((p) => p.min), ...remind]);
  const L = remind.length ? 56 : 40, R = 8, T = 8, B = 20;
  const pw = Math.max(40, w - L - R), ph = height - T - B;
  const x = (day: string) => L + 6 + dayPos(day, data.from, data.to) * (pw - 12);
  const y = (min: number) => T + ((sc.hi - min) / (sc.hi - sc.lo)) * ph;
  const tip = hover !== null ? data.points[hover] : null;
  const xs = data.points.map((p) => x(p.day));
  const mk = markerSize(xs);
  const axis = axisLabels(sc.ticks, remind, y);
  return (
    <div className="hs-time" ref={box} onMouseLeave={() => setHover(null)}>
      <svg width={w} height={height} viewBox={`0 0 ${w} ${height}`} role="group" aria-label={timeSummary(data)}>
        {/* Линия сетки — только у подписанного часа: час, скрытый ради «🔔 …» рядом, не оставляет пустую линию (26.11.2026). */}
        {sc.ticks.filter((t) => axis.some((a) => !a.bell && a.min === t)).map((t) => <line key={t} x1={L} x2={L + pw} y1={y(t)} y2={y(t)} className="hs-grid" />)}
        {remind.map((r, i) => (
          <g key={i}>
            <title>{`Напоминание в ${data.remind[i]}`}</title>
            <line x1={L} x2={L + pw} y1={y(r)} y2={y(r)} className="hs-remind" />
            <line x1={L - 4} x2={L + 4} y1={y(r)} y2={y(r)} className="hs-remind-tick" />
          </g>
        ))}
        {axis.map((a) => (
          <text key={`${a.bell ? "b" : "t"}${a.min}`} x={L - 6} y={a.y + 3.5} textAnchor="end" className={a.bell ? "hs-axis hs-axis-bell" : "hs-axis"}>{a.label}</text>
        ))}
        {dayTicks(data.from, data.to).map((d, i, all) => (
          <text key={d.day} x={x(d.day)} y={height - 5} textAnchor={i === 0 && all.length > 1 ? "start" : i === all.length - 1 && all.length > 1 ? "end" : "middle"} className="hs-axis">{d.label}</text>
        ))}
        {hover !== null && tip && <line x1={x(tip.day)} x2={x(tip.day)} y1={T} y2={T + ph} className="hs-cross" />}
        {gapLinks(data.points).map(([a, b]) => (
          <line key={`g${b.day}`} x1={x(a.day)} y1={y(a.min)} x2={x(b.day)} y2={y(b.min)} stroke={color} strokeWidth={2} strokeDasharray="3 4" strokeLinecap="round" className="hs-gap" />
        ))}
        {lineRuns(data.points).filter((r) => r.length > 1).map((r) => (
          <polyline key={r[0].day} points={r.map((p) => `${x(p.day)},${y(p.min)}`).join(" ")} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        ))}
        {data.points.map((p, i) => (
          <circle key={p.day} cx={x(p.day)} cy={y(p.min)} r={hover === i ? mk.hover : mk.r} fill={color} stroke="var(--panel-2)" strokeWidth={mk.ring} />
        ))}
        {hitBands(xs, L, L + pw).map((band, i) => {
          // Попадание — полоса во всю высоту от середины к левому соседу до середины к правому: без нахлёста, под курсором — ближайший день.
          const p = data.points[i];
          return (
            <rect
              key={`h${p.day}`} x={band.x} y={T} width={band.w} height={ph} className="hs-hit" tabIndex={0} role="img" aria-label={pointTip(p)}
              onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} onClick={() => setHover(i)}
            />
          );
        })}
      </svg>
      {tip && (
        <div ref={tipRef} className="chart-tip hs-time-tip" style={{ left: tipLeft(x(tip.day), tipW, w), top: tipTop(y(tip.min)), visibility: tipW ? undefined : "hidden" }}>
          {pointTip(tip)}
        </div>
      )}
      <details className="hs-time-table muted small">
        <summary>Таблицей</summary>
        <table>
          <tbody>{data.points.map((p) => <tr key={p.day}><td>{pointTip(p).split(" — ")[0]}</td><td>{p.time}</td></tr>)}</tbody>
        </table>
      </details>
    </div>
  );
}

/** «Сон и оценка дня» («Статистика → Сон», 27.11.2026): точка на день — X часы сна, Y оценка дня 1–10. Одна серия — без легенды,
 *  цвет сна (--blue), как полосы на шкале выше: оценку несёт высота точки, расходящаяся шкала --score-* её бы только повторила.
 *  Подсказка — ближайшая точка в 32 px от указателя (наведение, касание) или фокус с клавиатуры; таблица — в «Таблицей». */
export function SleepScoreChart({ pairs, height = 190 }: { pairs: SleepScorePair[]; height?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(320);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    if (el.clientWidth) setW(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((es) => { const x = Math.round(es[0]?.contentRect.width ?? 0); if (x) setW(x); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [hover, setHover] = useState<number | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [tipW, setTipW] = useState(0);
  useLayoutEffect(() => { const el = tipRef.current; if (el && el.offsetWidth !== tipW) setTipW(el.offsetWidth); });
  const points = sleepScorePoints(pairs);
  const ax = hoursAxis(points.map((p) => p.hours));
  const L = 26, R = 10, T = 8, B = 22;
  const pw = Math.max(40, w - L - R), ph = height - T - B;
  const x = (h: number) => L + 8 + ((h - ax.lo) / (ax.hi - ax.lo)) * (pw - 16);
  const y = (v: number) => T + ((10.5 - v) / 10) * ph;
  const nearest = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    let best: number | null = null, bd = 32;
    points.forEach((p, i) => { const d = Math.hypot(x(p.hours) - px, y(p.score) - py); if (d < bd) { bd = d; best = i; } });
    setHover(best);
  };
  const tip = hover !== null ? points[hover] : null;
  return (
    <div className="hs-time ss-chart" ref={box} onMouseLeave={() => setHover(null)}>
      <svg width={w} height={height} viewBox={`0 0 ${w} ${height}`} role="group" aria-label={sleepScoreSummary(pairs)} onPointerMove={nearest} onPointerDown={nearest}>
        {[2, 4, 6, 8, 10].map((v) => (
          <g key={v}>
            <line x1={L} x2={L + pw} y1={y(v)} y2={y(v)} className="hs-grid" />
            <text x={L - 6} y={y(v) + 3.5} textAnchor="end" className="hs-axis">{v}</text>
          </g>
        ))}
        {ax.ticks.map((t) => <text key={t} x={x(t)} y={height - 5} textAnchor="middle" className="hs-axis">{sleepHoursText(t)}</text>)}
        {points.map((p, i) => (
          <circle key={`${p.hours}|${p.score}`} cx={x(p.hours)} cy={y(p.score)} r={(p.days.length > 1 ? 6 : 4.5) + (hover === i ? 1.5 : 0)}
            fill="var(--blue)" stroke="var(--panel)" strokeWidth={2} className="ss-dot" />
        ))}
        {points.map((p, i) => (
          <circle key={`h${p.hours}|${p.score}`} cx={x(p.hours)} cy={y(p.score)} r={12} className="hs-hit" tabIndex={0} role="img" aria-label={sleepScoreTip(p)}
            onFocus={() => setHover(i)} onBlur={() => setHover(null)} />
        ))}
      </svg>
      {tip && (
        <div ref={tipRef} className="chart-tip hs-time-tip" style={{ left: tipLeft(x(tip.hours), tipW, w), top: tipTop(y(tip.score) - 4), visibility: tipW ? undefined : "hidden" }}>
          {sleepScoreTip(tip)}
        </div>
      )}
      <details className="hs-time-table muted small">
        <summary>Таблицей</summary>
        <table>
          <thead><tr><th>День</th><th>Сон</th><th>Оценка</th></tr></thead>
          <tbody>{pairs.map((p) => <tr key={p.day}><td>{shortDay(p.day)}</td><td>{sleepHoursText(p.hours)}</td><td>{scoreNum(p.score)}</td></tr>)}</tbody>
        </table>
      </details>
    </div>
  );
}
