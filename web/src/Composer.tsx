import { type FormEvent, useEffect, useRef, useState } from "react";
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
  const rec = useRef<{ r: MediaRecorder; chunks: Blob[]; at: number; cancel?: boolean } | null>(null);
  const [recSec, setRecSec] = useState<number | null>(null);

  useEffect(() => {
    if (recSec === null) return;
    const t = window.setInterval(() => {
      const r = rec.current;
      if (!r) return;
      const sec = Math.floor((Date.now() - r.at) / 1000);
      setRecSec(sec);
      if (sec >= 120) void stopMic();
    }, 500);
    return () => clearInterval(t);
  }, [recSec === null]);

  // Голосом: щелчок — запись, ещё щелчок — распознать и записать, ✕ — отменить.
  async function startMic() {
    if (busy || rec.current) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find((t) => MediaRecorder.isTypeSupported(t));
      const r = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32_000 } : undefined);
      const state = { r, chunks: [] as Blob[], at: Date.now() };
      r.ondataavailable = (e) => e.data.size && state.chunks.push(e.data);
      r.start(250);
      rec.current = state;
      setRecSec(0);
    } catch (err) {
      show({ text: `Нет доступа к микрофону: ${(err as Error).message}`, error: true });
    }
  }

  async function stopMic(cancel = false) {
    const st = rec.current;
    if (!st) return;
    rec.current = null;
    setRecSec(null);
    const blob = await new Promise<Blob>((resolve) => {
      st.r.onstop = () => {
        st.r.stream.getTracks().forEach((t) => t.stop());
        resolve(new Blob(st.chunks, { type: st.r.mimeType || "audio/webm" }));
      };
      st.r.stop();
    });
    if (cancel || Date.now() - st.at < 500 || !blob.size) return;
    setBusy(true);
    show({ text: "🎙 Распознаю…" }, 60000);
    try {
      const audio = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result).split(",")[1] ?? "");
        fr.onerror = () => reject(fr.error);
        fr.readAsDataURL(blob);
      });
      const r = await post<Reply & { heard: string }>("/api/voice", { audio, mime: blob.type, id: crypto.randomUUID() });
      show({ text: `🎙 ${r.heard}

${plainReply(r.text)}`, reply: r });
      onChanged();
    } catch (err) {
      show({ text: (err as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  }

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
          placeholder={recSec !== null ? `🔴 Слушаю… ${recSec} с` : "Что было или что запланировать…"}
          readOnly={recSec !== null}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) void send();
          }}
        />
        {recSec !== null && (
          <button type="button" className="ghost mic-cancel" onClick={() => void stopMic(true)} aria-label="Отменить запись">✕</button>
        )}
        {(recSec !== null || !text.trim()) && (
          <button
            type="button"
            className={`mic ${recSec !== null ? "rec" : ""}`}
            disabled={busy}
            onClick={() => void (recSec !== null ? stopMic() : startMic())}
            title={recSec !== null ? "Отправить запись" : "Сказать голосом"}
            aria-label={recSec !== null ? "Отправить запись" : "Сказать голосом"}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
          </button>
        )}
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
