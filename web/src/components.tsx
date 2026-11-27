import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { post } from "./api";
import { Icon } from "./icons";
import { type Note, failNote, noteMs, noteRole } from "./notice";

// Мелкие части интерфейса: карточка, кольцо прогресса, пустое место, плашка сообщения.

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

/** Плашка сообщения экрана — одна на итог, сбой действия и сбой загрузки (28.11.2026). Итог: тёмная, role="status",
 *  «Отменить» при note.undo. Сбой (note.bad): красная, role="alert", висит до крестика; onRetry — кнопка «Повторить». */
export function NoteBar({ note, onUndo, onRetry, onClose, className = "" }: {
  note: Note; onUndo?: (id: number) => void; onRetry?: () => void; onClose?: () => void; className?: string;
}) {
  return (
    <div className={`task-note ${note.bad ? "bad" : ""} ${className}`} role={noteRole(note)}>
      <span className="grow">{note.text}</span>
      {note.undo !== undefined && onUndo && <button type="button" className="link" onClick={() => onUndo(note.undo!)}>Отменить</button>}
      {onRetry && <button type="button" className="link" onClick={onRetry}>Повторить</button>}
      {onClose && <button type="button" className="ghost note-close" onClick={onClose} aria-label="Закрыть сообщение"><Icon name="close" size={16} /></button>}
    </div>
  );
}

/** Сбой загрузки экрана или его части: причина и «Повторить». */
export function LoadError({ error, onRetry, className }: { error: string; onRetry: () => void; className?: string }) {
  return <NoteBar note={{ text: `Не загрузилось: ${error}`, bad: true }} onRetry={onRetry} className={className} />;
}

/** Сообщение экрана: say(итог) гаснет через 8 секунд, say(сбой) висит до say(null) или следующего сообщения (notice.ts noteMs). */
export function useNote() {
  const [note, setNote] = useState<Note | null>(null);
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  const say = useCallback((n: Note | null) => {
    clearTimeout(timer.current);
    setNote(n);
    const ms = n ? noteMs(n) : 0;
    if (ms) timer.current = window.setTimeout(() => setNote(null), ms);
  }, []);
  return [note, say] as const;
}

/** «Отменить» в плашке: POST /api/undo по номеру из ответа сервера; не вышло — красная плашка с причиной. */
export async function undoNote(id: number, say: (n: Note | null) => void, onChanged?: () => void) {
  say(null);
  try {
    await post("/api/undo", { messageId: id });
    onChanged?.();
  } catch (e) {
    say(failNote("Не получилось отменить", e));
  }
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
