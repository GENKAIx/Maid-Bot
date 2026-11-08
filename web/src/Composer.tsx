import { type FormEvent, useRef, useState } from "react";
import { post } from "./api";
import { plainReply } from "./format";
import { navigate } from "./router";
import type { Reply } from "./types";

// Строка ввода на каждом экране: пишешь как в чат. Ответ горничной — снизу, с кнопкой «Отменить».

export function Composer({ onChanged }: { onChanged: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<{ text: string; reply?: Reply; error?: boolean } | null>(null);
  const timer = useRef<number>(0);
  const area = useRef<HTMLTextAreaElement>(null);

  function show(r: { text: string; reply?: Reply; error?: boolean }, ms = 14000) {
    setReply(r);
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setReply(null), ms);
  }

  async function send(e?: FormEvent) {
    e?.preventDefault();
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      const r = await post<Reply>("/api/input", { text: t, id: crypto.randomUUID() });
      setText("");
      show({ text: plainReply(r.text), reply: r });
      onChanged();
    } catch (err) {
      show({ text: (err as Error).message, error: true });
    } finally {
      setBusy(false);
      area.current?.focus();
    }
  }

  async function undo() {
    if (!reply?.reply) return;
    try {
      const r = await post<{ text: string }>("/api/undo", { messageId: reply.reply.messageId });
      show({ text: plainReply(r.text) }, 6000);
      onChanged();
    } catch (err) {
      show({ text: (err as Error).message, error: true });
    }
  }

  return (
    <div className="composer-wrap">
      {reply && (
        <div className={`toast ${reply.error ? "bad" : ""}`}>
          <div className="toast-text">
            {reply.reply?.days?.length ? reply.text.replace(/\n📅 .*$/, "") : reply.text}
            {!!reply.reply?.days?.length && (
              <div className="toast-days">
                {reply.reply.days.map((d) => (
                  <button key={d} onClick={() => { navigate(`/diary/${d}`); setReply(null); }}>📅 {dayChip(d)}</button>
                ))}
              </div>
            )}
          </div>
          <div className="toast-actions">
            {reply.reply?.undoable && <button onClick={undo}>↩ Отменить</button>}
            <button className="ghost" onClick={() => setReply(null)}>✕</button>
          </div>
        </div>
      )}
      <form className="composer" onSubmit={send}>
        <textarea
          ref={area}
          value={text}
          rows={1}
          placeholder="Что было, что запланировать, что не забыть…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) void send();
          }}
        />
        <button className="primary" type="submit" disabled={busy || !text.trim()}>{busy ? "…" : "Записать"}</button>
      </form>
    </div>
  );
}

const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
function dayChip(d: string) {
  const [y, m, day] = d.split("-").map(Number);
  return `${day} ${MONTHS[m - 1]}${y !== new Date().getFullYear() ? " " + y : ""}`;
}
