import { useEffect, useState } from "react";
import { post } from "./api";
import { undoNote, useNote } from "./components";
import { failNote } from "./notice";
import type { TaskRow } from "./types";

// Отметка задачи — одна на «Сегодня» и «Планы» (28.11.2026; docs/ДИЗАЙН.md 4.3): квадрат .box, строка зачёркнута, плашка
// «Отменить» на 8 секунд (POST /api/undo с номером из ответа), при сбое отметка снимается и видна причина.

/** tasks — открытые задачи экрана. closing — отмеченные, пока сервер не прислал список без них. */
export function useTaskDone(tasks: TaskRow[], onChanged: () => void) {
  const [closing, setClosing] = useState<Set<number>>(new Set());
  const [note, say] = useNote();

  // Отмеченная остаётся зачёркнутой, пока сервер не прислал новый список без неё.
  useEffect(() => setClosing((c) => new Set([...c].filter((id) => tasks.some((t) => t.id === id)))), [tasks]);

  async function close(t: TaskRow) {
    if (closing.has(t.id)) return;
    setClosing((c) => new Set(c).add(t.id));
    try {
      const r = await post<{ undo: number }>(`/api/tasks/${t.id}`, { status: "done" });
      say({ text: `«${t.title}» — сделано`, undo: r.undo });
      onChanged();
    } catch (e) {
      setClosing((c) => { const n = new Set(c); n.delete(t.id); return n; });
      say(failNote(`Не получилось отметить «${t.title}»`, e));
    }
  }
  const undo = (id: number) => void undoNote(id, say, onChanged);

  return { closing, note, say, close, undo };
}

/** Квадрат отметки задачи. */
export function TaskBox({ task, done, onClose }: { task: TaskRow; done: boolean; onClose: (t: TaskRow) => void }) {
  return (
    <button type="button" className={`box ${done ? "on" : ""}`} onClick={() => onClose(task)} disabled={done} aria-label={`Сделано: ${task.title}`} title="Сделано">
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </button>
  );
}
