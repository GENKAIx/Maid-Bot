import { type ReactNode, useEffect, useState } from "react";

// Мелкие части интерфейса: карточка, кольцо прогресса, пустое место, тост.

export function Card({ title, children, className = "", action }: { title?: ReactNode; children: ReactNode; className?: string; action?: ReactNode }) {
  return (
    <section className={`card ${className}`}>
      {title && (
        <header className="card-head">
          <h3>{title}</h3>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

/** Кольцо прогресса: доля 0..1, в центре — подпись. Дорисовывается плавно. */
export function Ring({ value, size = 72, stroke = 8, color = "var(--accent)", children, label }: {
  value: number; size?: number; stroke?: number; color?: string; children?: ReactNode; label?: string;
}) {
  const [v, setV] = useState(0);
  useEffect(() => {
    const t = requestAnimationFrame(() => setV(Math.max(0, Math.min(1, value))));
    return () => cancelAnimationFrame(t);
  }, [value]);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <div className="ring" style={{ width: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--ring-bg)" strokeWidth={stroke} />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - v)} transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: "stroke-dashoffset .9s cubic-bezier(.3,.7,.3,1)" }}
        />
      </svg>
      <div className="ring-center">{children}</div>
      {label && <div className="ring-label">{label}</div>}
    </div>
  );
}

export function Spinner() {
  return <div className="spinner" aria-label="загрузка" />;
}

export function Chip({ children, tone = "" }: { children: ReactNode; tone?: string }) {
  return <span className={`chip ${tone}`}>{children}</span>;
}

/** Кнопка-переключатель отметки привычки. */
export function Mark({ status, onDone, onSkip, small = false }: {
  status: "done" | "skipped" | null; onDone: () => void; onSkip: () => void; small?: boolean;
}) {
  return (
    <span className={`mark ${small ? "small" : ""}`}>
      <button className={`mark-btn done ${status === "done" ? "on" : ""}`} onClick={onDone} title="Сделал" aria-label="Сделал">✓</button>
      <button className={`mark-btn skip ${status === "skipped" ? "on" : ""}`} onClick={onSkip} title="Пропуск" aria-label="Пропуск">–</button>
    </span>
  );
}
