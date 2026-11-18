import { useState } from "react";
import { DAY_SEC, dayParts } from "./pcday";

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
