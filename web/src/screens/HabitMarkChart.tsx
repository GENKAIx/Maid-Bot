import { type KeyboardEvent, type PointerEvent, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { addDays } from "../format";
import { daysBetween } from "../habitview";
import { type Band, type MarkPoint, type Span, bandText, dayIndexAt, dayName, dragSpan, fixSpan, keySpan, marksText, rangeText, usualBands, xLabels } from "../habitpanel";
import { hhmm, lineRuns, timeScale, tipLeft, tipTop, toMin } from "../timechart";

// «Во сколько отмечали» в раскрытой привычке (27.11.2026, макет «Привычки: месяц сеткой»): график отметок на выбранном отрезке
// и полоса обзора всего срока с рамкой. Расчёты — habitpanel.ts и timechart.ts. Точки — отдельным memo-слоем: наведение
// перерисовывает только перекрестье и подсказку (у «Всё» на ×12 за год — тысячи точек).

/** Ширина блока — по ResizeObserver (графики рисуются в пикселях, без растяжения). */
function useWidth(fallback: number) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    if (el.clientWidth) setW(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((es) => { const x = Math.round(es[0]?.contentRect.width ?? 0); if (x) setW(x); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [box, w] as const;
}

/** График: X — дни отрезка [a, b], Y — время суток (позже — выше). «По отметкам» — шкала по отметкам и напоминаниям,
 *  «Сутки целиком» — 00:00–23:59. Обычная привычка — полоса «обычно» и линия (рвётся на днях без отметки), ×N — точки всех
 *  отметок и черта дня от первой до последней. Пунктир — напоминания. Наведение, касание, стрелки — подсказка отметки. */
export function MarkChart({ points, remind, perDay, a, b, full, today }: {
  points: MarkPoint[]; remind: string[]; perDay: number; a: string; b: string; full: boolean; today: string;
}) {
  const [box, w0] = useWidth(320);
  // Ширина — ровно блока (на телефоне ~250 px): шире — график вылезал за край, подписи напоминаний справа терялись.
  const w = Math.max(120, w0);
  const [hover, setHover] = useState(-1);
  // Другой отрезок — прежняя подсказка не про эти точки (на телефоне палец не «уходит», pointerleave не приходит).
  useEffect(() => setHover(-1), [a, b, points.length]);
  const tipRef = useRef<HTMLDivElement>(null);
  const [tipW, setTipW] = useState(0);
  useLayoutEffect(() => { const el = tipRef.current; if (el && el.offsetWidth !== tipW) setTipW(el.offsetWidth); });
  const year = Number(today.slice(0, 4));
  const rem = remind.map(toMin);
  const H = w < 480 ? 200 : 230, L = 44, R = rem.length ? 42 : 10, T = 14, B = 24;
  const pw = w - L - R, ph = H - T - B;
  const sc = full || !points.length ? timeScale([]) : timeScale([...points.map((p) => p.min), ...rem]);
  const hi = full ? 1440 : sc.hi;
  const n = daysBetween(a, b) + 1;
  const X = (day: string) => L + ((daysBetween(a, day) + 0.5) / n) * pw;
  const Y = (v: number) => T + ((hi - v) / (hi - sc.lo)) * ph;
  const bands: Band[] = useMemo(() => (perDay === 1 ? usualBands(points, 1) : []), [points, perDay]);
  const dense = n <= 120;
  const rad = n <= 31 ? 4 : n <= 100 ? 2.8 : 1.6;
  const { xs, ys } = useMemo(() => ({ xs: points.map((p) => X(p.day)), ys: points.map((p) => Y(p.min)) }), [points, a, n, pw, hi, sc.lo, ph]); // eslint-disable-line react-hooks/exhaustive-deps
  const days = useMemo(() => {
    const m = new Map<string, MarkPoint[]>();
    for (const p of points) { const l = m.get(p.day); if (l) l.push(p); else m.set(p.day, [p]); }
    return m;
  }, [points]);
  const pick = hover >= 0 && hover < points.length ? points[hover] : null;
  function nearest(e: PointerEvent<HTMLDivElement>) {
    if (!points.length) return;
    const rc = e.currentTarget.getBoundingClientRect(), x = e.clientX - rc.left, y = e.clientY - rc.top;
    let best = 0, bd = Infinity;
    xs.forEach((px, i) => { const d = (px - x) ** 2 + (ys[i] - y) ** 2 * 0.5; if (d < bd) { bd = d; best = i; } });
    setHover(best);
  }
  function key(e: KeyboardEvent<HTMLDivElement>) {
    if (!points.length || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    e.preventDefault();
    const i = (hover < 0 ? points.length : hover) + (e.key === "ArrowLeft" ? -1 : 1);
    setHover(Math.max(0, Math.min(points.length - 1, i)));
  }
  const usual = bands[0] ? `, ${bandText(bands[0])}` : "";
  const label = `Во сколько отмечали, ${rangeText(a, b, year)}: ${marksText(points.length)}${usual}${remind.length ? `, напоминание в ${remind.join(", ")}` : ""}. Стрелки влево и вправо переходят по отметкам`;
  const labels = xLabels(a, n, pw);
  return (
    <div
      className="hp-chart" ref={box} tabIndex={0} role="img" aria-label={label}
      onPointerMove={nearest} onPointerDown={nearest} onPointerLeave={(e) => e.pointerType === "mouse" && setHover(-1)}
      onFocus={() => points.length && setHover(points.length - 1)} onBlur={() => setHover(-1)} onKeyDown={key}
    >
      <svg width={w} height={H} viewBox={`0 0 ${w} ${H}`} aria-hidden="true">
        {(full ? [0, 360, 720, 1080, 1440] : sc.ticks).map((t) => (
          <g key={t}>
            <line className="gr" x1={L} x2={L + pw} y1={Y(t)} y2={Y(t)} />
            <text x={L - 8} y={Y(t) + 4} textAnchor="end">{t >= 1440 ? "24:00" : hhmm(t)}</text>
          </g>
        ))}
        {bands.map((bd) => {
          const y1 = Y(bd.hi), y2 = Y(bd.lo);
          return (
            <g key={bd.i ?? 0}>
              <rect className="bd" x={L} y={y1} width={pw} height={Math.max(3, y2 - y1)} />
              <text className="bt" x={L + pw - 6} y={y1 - 5 < T + 8 ? y2 + 13 : y1 - 5} textAnchor="end">{bandText(bd)}</text>
            </g>
          );
        })}
        {rem.filter((m) => m >= sc.lo && m <= hi).map((m, i) => (
          <g key={i}>
            <line className="rm" x1={L} x2={L + pw} y1={Y(m)} y2={Y(m)} />
            <text className="rt" x={L + pw + 5} y={Y(m) + 4}>{hhmm(m)}</text>
          </g>
        ))}
        {labels.map((l, i) => {
          const anc = l.month || i === 0 ? "start" : i === labels.length - 1 ? "end" : "middle";
          const x = l.month ? L + (l.k / n) * pw : anc === "start" ? L : anc === "end" ? L + pw : L + ((l.k + 0.5) / n) * pw;
          return <text key={l.k} x={x} y={H - 6} textAnchor={anc}>{l.label}</text>;
        })}
        {dense && perDay > 1 && [...days].filter(([, ps]) => ps.length > 1).map(([day, ps]) => (
          <line key={day} className="vt" x1={X(day)} x2={X(day)} y1={Y(ps[0].min)} y2={Y(ps.at(-1)!.min)} />
        ))}
        {dense && perDay === 1 && lineRuns(points).filter((r) => r.length > 1).map((r) => (
          <polyline key={r[0].day} className="ln" points={r.map((p) => `${X(p.day).toFixed(1)},${Y(p.min).toFixed(1)}`).join(" ")} />
        ))}
        <Dots points={points} xs={xs} ys={ys} rad={rad} today={today} />
        {pick && <line className="cr" x1={xs[hover]} x2={xs[hover]} y1={T} y2={T + ph} />}
        {pick && <circle className="hl" cx={xs[hover]} cy={ys[hover]} r={rad + 3} />}
      </svg>
      {pick && (
        <div ref={tipRef} className="hp-tip" style={{ left: tipLeft(xs[hover], tipW, w), top: tipTop(ys[hover]), visibility: tipW ? undefined : "hidden" }}>
          {dayName(pick.day, year)} · {pick.time}{perDay > 1 ? ` · отметка ${pick.n} из ${Math.max(perDay, days.get(pick.day)?.length ?? 0)}` : ""}
        </div>
      )}
      {!points.length && <p className="hp-empty">На этом отрезке отметок нет.</p>}
    </div>
  );
}

/** Точки отметок — отдельно от наведения (memo): xs, ys пересчитываются только с отрезком и шириной. */
const Dots = memo(function Dots({ points, xs, ys, rad, today }: { points: MarkPoint[]; xs: number[]; ys: number[]; rad: number; today: string }) {
  return (
    <>
      {points.map((p, i) => (
        <circle key={`${p.day}-${p.n}`} className={`pt ${p.day === today ? "now" : ""}`} cx={xs[i]} cy={ys[i]} r={rad} strokeWidth={rad > 3 ? 2 : 1} />
      ))}
    </>
  );
});

/** Полоса обзора всего срока [from, from + total − 1]: у обычной привычки — засечка времени отметки, у ×N — столбик доли нормы.
 *  Рамка — выбранный отрезок: протянуть по полосе — новый, за середину — сдвинуть, за края — растянуть (мышь и палец);
 *  касание без протяжки — неделя вокруг дня. С клавиатуры: стрелки двигают, с Shift — растягивают. */
export function Overview({ points, perDay, from, total, span, onSpan, today }: {
  points: MarkPoint[]; perDay: number; from: string; total: number; span: Span; onSpan: (s: Span) => void; today: string;
}) {
  const drag = useRef<{ mode: "l" | "r" | "m" | "n"; k0: number; start: Span; moved: boolean; last: Span } | null>(null);
  const N = Math.max(1, total);
  // Путь полосы — только когда меняются отметки (рамку двигают часто, точки те же).
  const d = useMemo(() => {
    let lo = 1440, hi = 0;
    const by = new Map<string, number[]>();
    for (const p of points) { lo = Math.min(lo, p.min); hi = Math.max(hi, p.min); const l = by.get(p.day); if (l) l.push(p.min); else by.set(p.day, [p.min]); }
    const bw = Math.max(0.8, (600 / N) * 0.6);
    let d = "";
    for (const [day, ms] of by) {
      const x = ((daysBetween(from, day) + 0.5) / N) * 600;
      if (perDay > 1) d += `M${(x - bw / 2).toFixed(1)} 42v${(-Math.max(2, Math.min(1, ms.length / perDay) * 34)).toFixed(1)}h${bw.toFixed(1)}V42Z`;
      else d += `M${x.toFixed(1)} ${(40 - ((ms[0] - lo) / Math.max(30, hi - lo)) * 34).toFixed(1)}v-1.5`;
    }
    return d;
  }, [points, perDay, from, N]);
  const l = (span.a / N) * 100, wd = ((span.b - span.a + 1) / N) * 100;
  const at = (e: PointerEvent<HTMLDivElement>) => { const rc = e.currentTarget.getBoundingClientRect(); return dayIndexAt((e.clientX - rc.left) / Math.max(1, rc.width), N); };
  function down(e: PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement;
    const mode = t.closest(".hp-hl") ? "l" : t.closest(".hp-hr") ? "r" : t.closest(".hp-br") ? "m" : "n";
    drag.current = { mode, k0: at(e), start: span, moved: false, last: span };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  }
  function move(e: PointerEvent<HTMLDivElement>) {
    const g = drag.current;
    if (!g) return;
    const k = at(e);
    if (k !== g.k0) g.moved = true;
    if (!g.moved) return;
    g.last = dragSpan(g.mode, g.start, g.k0, k, N);
    onSpan(g.last);
  }
  function up() {
    const g = drag.current;
    if (!g) return;
    drag.current = null;
    // Касание рамки или её края без протяжки — отрезок тот же, кнопка отрезка («30 дней») остаётся нажатой.
    if (!g.moved && g.mode !== "n") return;
    onSpan(fixSpan(g.mode === "n" && !g.moved ? { a: g.k0 - 3, b: g.k0 + 3 } : g.last, N));
  }
  function key(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    onSpan(keySpan(span, e.key === "ArrowLeft" ? -1 : 1, e.shiftKey, N));
  }
  const year = Number(today.slice(0, 4));
  const a = addDays(from, span.a), b = addDays(from, span.b);
  return (
    <div className="hp-ov" role="group" aria-label="Весь срок. Протяните, чтобы выбрать отрезок" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onLostPointerCapture={up}>
      <svg viewBox="0 0 600 46" preserveAspectRatio="none" aria-hidden="true"><path className={perDay > 1 ? "q" : ""} d={d} vectorEffect="non-scaling-stroke" /></svg>
      <i className="hp-dim l" style={{ width: `${l}%` }} />
      <i className="hp-dim r" style={{ width: `${Math.max(0, 100 - l - wd)}%` }} />
      <div
        className="hp-br" style={{ left: `${l}%`, width: `${wd}%` }} tabIndex={0} role="slider" onKeyDown={key}
        aria-label="Выбранный отрезок. Стрелки двигают, стрелки с Shift растягивают" aria-valuemin={0} aria-valuemax={N - 1} aria-valuenow={span.b}
        aria-valuetext={`${rangeText(a, b, year)}, ${span.b - span.a + 1} дн.`}
      >
        <i className="hp-hl" /><i className="hp-hr" />
      </div>
    </div>
  );
}
