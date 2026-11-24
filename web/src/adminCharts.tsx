import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { ADM_WEEKDAYS, numText } from "./admin";

// Графики раздела «Аналитика» админки (этап 5, 24.11.2026; screens/AdminAnalytics.tsx) — свои SVG в цветах админки,
// по макету docs/review/аналитика-макет-2026-11-24.html. Графики сайта — отдельно (charts.tsx), сюда не смешивать.
// Цвета рядов — токены --a-c1…--a-c6 и --a-star в .admin (admin.css); в SVG — через style, потому что var() в атрибутах не работает.

export const ANA_C = {
  c1: "var(--a-c1)", c2: "var(--a-c2)", c3: "var(--a-c3)", c4: "var(--a-c4)", c5: "var(--a-c5)", c6: "var(--a-c6)",
  star: "var(--a-star)", prev: "#5a6270", other: "#6b7684",
};
/** Цвета по порядку для рядов без своего цвета (источники обращений). */
export const ANA_ORDER = [ANA_C.c1, ANA_C.c3, ANA_C.c4, ANA_C.c5, ANA_C.c6, ANA_C.c2, ANA_C.other];

/** Ряд графика. sign −1 — стопка вниз от нуля (возвраты, отмены, истечения; значения положительные). null — нет данных:
 *  у линии — разрыв, у стопки — пусто, в подсказке — «—». */
export type AnaSeries = { name: string; color: string; values: (number | null)[]; area?: boolean; dash?: boolean; sign?: 1 | -1 };
export type AnaTipRow = { name: string; value: string; color?: string };
export type AnaTipState = { x: number; y: number; title: string; rows: AnaTipRow[] };

/** Верх шкалы, как в макете: 1, 2, 2,5, 5, 10 × степень десяти; 0 и меньше — 1. */
export function niceMax(m: number): number {
  if (!(m > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(m))), f = m / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

/** Пределы оси: у стопки — сумма вверх и сумма вниз по корзине, у линии — от наименьшего до наибольшего (ноль всегда виден). */
export function chartRange(kind: "line" | "stack", series: AnaSeries[]): { min: number; max: number } {
  const n = Math.max(0, ...series.map((s) => s.values.length));
  let lo = 0, hi = 0;
  if (kind === "stack") {
    for (let i = 0; i < n; i++) {
      let up = 0, dn = 0;
      for (const s of series) {
        const v = s.values[i];
        if (v == null) continue;
        if ((s.sign ?? 1) < 0) dn += Math.abs(v); else up += v;
      }
      hi = Math.max(hi, up);
      lo = Math.max(lo, dn);
    }
    return { min: lo > 0 ? -niceMax(lo) : 0, max: niceMax(hi) };
  }
  for (const s of series) for (const v of s.values) if (v != null && Number.isFinite(v)) { hi = Math.max(hi, v); lo = Math.min(lo, v); }
  return { min: lo < 0 ? -niceMax(-lo) : 0, max: niceMax(hi) };
}

/** Подписывать каждую k-ю корзину, чтобы подписи не налезали (≈ 70 px на подпись, как в макете). */
export function tickEvery(n: number, plotWidth: number, px = 70): number {
  return Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotWidth / px))));
}

/** Подпись оси по умолчанию: 1 200 → «1,2k», дроби меньше 10 — с десятой. */
export function axisText(v: number): string {
  const a = Math.abs(v);
  if (a >= 1000) return `${numText(v / 1000, 1)}k`;
  return numText(v, a < 10 ? 1 : 0);
}

function useWidth(ref: RefObject<HTMLElement | null>, fallback = 640): number {
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.clientWidth) setW(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((es) => { const x = Math.round(es[0]?.contentRect.width ?? 0); if (x) setW(x); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

/** Подсказка у курсора; не выходит за край окна (переносится на другую сторону курсора). */
export function AnaTip({ tip }: { tip: AnaTipState | null }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!tip || !el) return;
    const w = el.offsetWidth, h = el.offsetHeight;
    let x = tip.x + 14, y = tip.y + 14;
    if (x + w > innerWidth - 8) x = Math.max(8, tip.x - w - 14);
    if (y + h > innerHeight - 8) y = Math.max(8, tip.y - h - 14);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }, [tip]);
  if (!tip) return null;
  return (
    <div ref={ref} className="ana-tip" role="tooltip">
      <b>{tip.title}</b>
      {tip.rows.map((r, i) => (
        <div key={i}><span>{r.color && <i style={{ background: r.color }} />}{r.name}</span><span>{r.value}</span></div>
      ))}
    </div>
  );
}

export function AnaLegend({ items }: { items: { name: string; color: string }[] }) {
  return <div className="ana-legend">{items.map((it) => <span key={it.name}><i style={{ background: it.color }} />{it.name}</span>)}</div>;
}

type ChartProps = {
  labels: string[]; series: AnaSeries[];
  /** Значение в подсказке. */
  fmt?: (v: number) => string;
  /** Подпись оси (по умолчанию — короткое число). */
  axis?: (v: number) => string;
  height?: number; label?: string;
};

/** Отрезки линии без null (разрыв там, где данных нет). */
function segments(values: (number | null)[]): number[][] {
  const out: number[][] = [];
  let cur: number[] = [];
  values.forEach((v, i) => {
    if (v == null || !Number.isFinite(v)) { if (cur.length) out.push(cur); cur = []; }
    else cur.push(i);
  });
  if (cur.length) out.push(cur);
  return out;
}

function AnaChart({ kind, labels, series, fmt = (v) => numText(v, 1), axis = axisText, height = 210, label }: ChartProps & { kind: "line" | "stack" }) {
  const box = useRef<HTMLDivElement>(null);
  const W = useWidth(box);
  const [hover, setHover] = useState<number | null>(null);
  const [tip, setTip] = useState<AnaTipState | null>(null);
  const n = labels.length;
  if (!n) return <div className="ana-chart ana-empty" ref={box} style={{ height }}><span className="adm-muted">Нет корзин за интервал</span></div>;
  const H = height, L = 46, R = 8, T = 8, B = 22;
  const pw = Math.max(10, W - L - R), ph = H - T - B;
  const { min, max } = chartRange(kind, series);
  const y = (v: number) => T + ph - ((v - min) / (max - min)) * ph;
  const bw = pw / n;
  const xs = (i: number) => L + bw * i + bw / 2;
  const every = tickEvery(n, pw);
  const grid = [0, 1, 2, 3, 4].map((g) => min + ((max - min) * g) / 4);
  const zero = y(0);

  const move = (e: { clientX: number; clientY: number; currentTarget: SVGRectElement }) => {
    const svg = e.currentTarget.ownerSVGElement!;
    const r = svg.getBoundingClientRect();
    const mx = ((e.clientX - r.left) * W) / (r.width || W);
    const i = Math.max(0, Math.min(n - 1, Math.floor((mx - L) / bw)));
    setHover(i);
    const rows: AnaTipRow[] = series.map((s) => ({ name: s.name, value: s.values[i] == null ? "—" : fmt(s.values[i]!), color: s.color }));
    if (kind === "stack" && series.length > 1) {
      const known = series.filter((s) => s.values[i] != null);
      const total = known.reduce((a, s) => a + (s.sign ?? 1) * Math.abs(s.values[i]!), 0);
      rows.push({ name: "Всего", value: known.length ? fmt(total) : "—" });
    }
    setTip({ x: e.clientX, y: e.clientY, title: labels[i], rows });
  };
  const leave = () => { setHover(null); setTip(null); };

  const bars: JSX.Element[] = [];
  if (kind === "stack") {
    const barW = Math.max(1.5, Math.min(26, bw - 2));
    for (let b = 0; b < n; b++) {
      let up = 0, dn = 0;
      series.forEach((s, si) => {
        const raw = s.values[b];
        if (raw == null || !raw) return;
        const v = Math.abs(raw), down = (s.sign ?? 1) < 0;
        const y0 = down ? y(-dn) : y(up), y1 = down ? y(-dn - v) : y(up + v);
        if (down) dn += v; else up += v;
        const top = Math.min(y0, y1), h = Math.max(0.5, Math.abs(y1 - y0) - (series.length > 1 ? 1 : 0));
        bars.push(<rect key={`${b}-${si}`} x={xs(b) - barW / 2} y={top} width={barW} height={h} rx={Math.min(3, barW / 3)} style={{ fill: s.color }} />);
      });
    }
  }

  return (
    <div className="ana-chart" ref={box} style={{ height }}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={label}>
        {grid.map((gv, k) => (
          <g key={k}>
            <line x1={L} x2={W - R} y1={y(gv)} y2={y(gv)} stroke={gv === 0 && min < 0 ? "#3a414c" : "#262b33"} strokeDasharray={gv === 0 ? undefined : "2 4"} />
            <text x={L - 6} y={y(gv) + 3.5} textAnchor="end" fill="#8a93a0" fontSize={10.5}>{axis(gv)}</text>
          </g>
        ))}
        <line x1={L} x2={W - R} y1={zero} y2={zero} stroke="#3a414c" />
        {labels.map((t, i) => (i % every === 0 ? <text key={i} x={xs(i)} y={H - 5} textAnchor="middle" fill="#8a93a0" fontSize={10.5}>{t}</text> : null))}
        {bars}
        {kind === "line" && series.map((s, si) => segments(s.values).map((seg, k) => {
          const d = seg.map((i, j) => `${j ? "L" : "M"}${xs(i).toFixed(1)} ${y(s.values[i]!).toFixed(1)}`).join(" ");
          return (
            <g key={`${si}-${k}`}>
              {s.area && seg.length > 1 && <path d={`${d} L${xs(seg[seg.length - 1]).toFixed(1)} ${zero.toFixed(1)} L${xs(seg[0]).toFixed(1)} ${zero.toFixed(1)}Z`} style={{ fill: s.color, fillOpacity: 0.12 }} />}
              {seg.length > 1
                ? <path d={d} fill="none" strokeWidth={2} strokeLinejoin="round" strokeDasharray={s.dash ? "5 4" : undefined} style={{ stroke: s.color }} />
                : <circle cx={xs(seg[0])} cy={y(s.values[seg[0]]!)} r={2.5} style={{ fill: s.color }} />}
            </g>
          );
        }))}
        {hover != null && <line x1={xs(hover)} x2={xs(hover)} y1={T} y2={T + ph} stroke="#5a6270" />}
        {hover != null && kind === "line" && series.map((s, si) => s.values[hover] == null ? null
          : <circle key={si} cx={xs(hover)} cy={y(s.values[hover]!)} r={4.5} stroke="#161a1f" strokeWidth={2} style={{ fill: s.color }} />)}
        <rect x={L} y={T} width={pw} height={ph} fill="transparent" onPointerMove={move} onPointerDown={move} onPointerLeave={leave} />
      </svg>
      <AnaTip tip={tip} />
    </div>
  );
}

/** Линии: несколько рядов, area — заливка под линией, dash — пунктир (прошлый период), null — разрыв. */
export const AnaLine = (p: ChartProps) => <AnaChart kind="line" {...p} />;
/** Стопка столбцов; ряды со sign −1 — вниз от нуля. В подсказке — «Всего» (вверх минус вниз). */
export const AnaStack = (p: ChartProps) => <AnaChart kind="stack" {...p} />;

/** Тепловая карта неделя × час: строки пн…вс, столбцы 0…23. Ярче — больше. */
export function AnaHeat({ heat, unit = "Минут" }: { heat: number[][]; unit?: string }) {
  const [tip, setTip] = useState<AnaTipState | null>(null);
  const max = Math.max(0, ...heat.flat());
  return (
    <div className="ana-heat" onPointerLeave={() => setTip(null)}>
      <span />
      {Array.from({ length: 24 }, (_, h) => <span key={h} className="ana-hl">{h % 3 ? "" : h}</span>)}
      {ADM_WEEKDAYS.map((d, di) => [
        <span key={`l${di}`} className="ana-hl ana-hl-day">{d}</span>,
        ...Array.from({ length: 24 }, (_, h) => {
          const v = heat[di]?.[h] ?? 0;
          const a = max > 0 && v > 0 ? 0.12 + 0.88 * (v / max) : 0;
          return (
            <div key={`${di}-${h}`} style={a ? { background: `rgba(57, 135, 229, ${a.toFixed(3)})` } : undefined}
              onPointerMove={(e) => setTip({ x: e.clientX, y: e.clientY, title: `${d} ${String(h).padStart(2, "0")}:00`, rows: [{ name: unit, value: numText(v) }] })} />
          );
        }),
      ])}
      <AnaTip tip={tip} />
    </div>
  );
}

/** Когортная матрица: строка — неделя регистрации, Н+k — доля активных на k-й неделе; подсказка «N из M»; null — неделя не наступила. */
export function AnaCohort({ rows, cols, weekText }: {
  rows: { week: string; size: number; cells: ({ share: number; users: number } | null)[] }[]; cols: number; weekText: (week: string) => string;
}) {
  const [tip, setTip] = useState<AnaTipState | null>(null);
  return (
    <div className="adm-scroll" onPointerLeave={() => setTip(null)}>
      <table className="ana-table ana-cohort">
        <thead><tr><th>Неделя прихода</th><th className="n">Людей</th>{Array.from({ length: cols }, (_, k) => <th key={k} className="c">Н+{k}</th>)}</tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.week}>
              <td>{weekText(r.week)}</td><td className="n">{numText(r.size)}</td>
              {Array.from({ length: cols }, (_, k) => {
                const c = r.cells[k] ?? null;
                if (!c) return <td key={k} className="c ana-dim">—</td>;
                const pct = Math.round(c.share * 100);
                return (
                  <td key={k} className="c" style={{ background: `rgba(57, 135, 229, ${(0.08 + 0.92 * c.share).toFixed(3)})` }}
                    onPointerMove={(e) => setTip({ x: e.clientX, y: e.clientY, title: `${weekText(r.week)} · Н+${k}`, rows: [{ name: "Людей", value: `${c.users} из ${r.size}` }] })}>
                    {pct}%
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <AnaTip tip={tip} />
    </div>
  );
}

/** Горизонтальные полосы: длина — от наибольшего значения. */
export function AnaHBars({ rows, color = ANA_C.c1 }: { rows: { label: string; value: number; text: string; color?: string }[]; color?: string }) {
  const max = Math.max(0, ...rows.map((r) => r.value));
  return (
    <div className="ana-hbars">
      {rows.map((r) => (
        <div key={r.label} className="ana-hbar">
          <span>{r.label}</span>
          <div className="ana-hbar-track"><b style={{ width: `${max > 0 ? (r.value / max) * 100 : 0}%`, background: r.color ?? color }} /></div>
          <span>{r.text}</span>
        </div>
      ))}
    </div>
  );
}
