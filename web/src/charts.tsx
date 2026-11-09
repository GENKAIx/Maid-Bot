import { useState } from "react";

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

/** Горизонтальные полосы долей (категории расходов). */
export function Shares({ items, format }: { items: { label: string; value: number; color?: string }[]; format: (v: number) => string }) {
  const total = items.reduce((s, i) => s + i.value, 0) || 1;
  return (
    <ul className="shares">
      {items.map((i) => (
        <li key={i.label}>
          <span className="share-label">{i.label}</span>
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
