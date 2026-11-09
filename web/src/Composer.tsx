import { type FormEvent, useEffect, useRef, useState } from "react";
import { post } from "./api";
import { Recorder } from "./recorder";
import { plainReply } from "./format";
import { navigate } from "./router";
import { imageFrom, shrinkImage, type Picture } from "./picture";
import type { Reply } from "./types";

// Строка ввода на каждом экране: пишешь как в чат. Ответ горничной — снизу, с кнопкой «Отменить».

export function Composer({ onChanged }: { onChanged: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<{ text: string; reply?: Reply; error?: boolean } | null>(null);
  const timer = useRef<number>(0);
  const area = useRef<HTMLTextAreaElement>(null);
  const rec = useRef(new Recorder());
  const wave = useRef<HTMLCanvasElement>(null);
  const [recording, setRecording] = useState(false);
  const [clock, setClock] = useState("0:00");
  // Картинка к сообщению: скрепка, Ctrl+V в строке или перетащить на строку; текст тогда — подпись.
  const [picture, setPicture] = useState<Picture | null>(null);
  const file = useRef<HTMLInputElement>(null);

  async function attach(f: File | null | undefined) {
    if (!f) return;
    try {
      setPicture(await shrinkImage(f));
      area.current?.focus();
    } catch {
      show({ text: "Не получилось открыть картинку.", error: true }, 6000);
    }
  }

  useEffect(() => {
    if (!recording) return;
    if (wave.current) rec.current.wave(wave.current, "#e5484d");
    const t = window.setInterval(() => setClock(rec.current.clock()), 250);
    const keys = (e: KeyboardEvent) => {
      if (e.key === "Escape") void dropMic();
      else if (e.key === "Enter") { e.preventDefault(); void stopMic(); }
    };
    document.addEventListener("keydown", keys);
    return () => { clearInterval(t); document.removeEventListener("keydown", keys); };
  }, [recording]);

  // Голосом: щелчок — запись, ещё щелчок (Enter) — распознать и записать, корзина (Esc) — удалить.
  async function startMic() {
    if (busy || rec.current.on) return;
    try {
      await rec.current.start(() => void stopMic());
      setClock("0:00");
      setRecording(true);
    } catch (err) {
      show({ text: `Нет доступа к микрофону: ${(err as Error).message}`, error: true });
    }
  }

  async function dropMic() {
    await rec.current.cancel();
    setRecording(false);
  }

  async function stopMic() {
    if (!rec.current.on) return;
    setRecording(false);
    const v = await rec.current.stop();
    if (!v) return;
    setBusy(true);
    show({ text: "🎙 Распознаю…" }, 60000);
    try {
      const r = await post<Reply & { heard: string }>("/api/voice", { ...v, id: crypto.randomUUID() });
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
    if ((!t && !picture) || busy) return;
    const image = picture ? { data: picture.data, mime: picture.mime } : undefined;
    setBusy(true);
    if (image) show({ text: "📷 Смотрю…" }, 60000);
    try {
      const r = await post<Reply>("/api/input", { text: t, image, id: crypto.randomUUID() });
      setText("");
      setPicture(null);
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
      <form
        className={`composer ${recording ? "recording" : ""}`}
        onSubmit={send}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); void attach(imageFrom(e.dataTransfer)); }}
      >
        {picture && !recording && (
          <div className="attach" title="Картинка уйдёт вместе с сообщением">
            <img src={picture.url} alt="" />
            <button type="button" className="ghost" onClick={() => setPicture(null)} title="Убрать картинку" aria-label="Убрать картинку">✕</button>
          </div>
        )}
        {recording ? (
          <div className="rec-bar" aria-live="polite">
            <button type="button" className="rec-trash ghost" onClick={() => void dropMic()} title="Удалить запись (Esc)" aria-label="Удалить запись">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></svg>
            </button>
            <span className="rec-dot" />
            <span className="rec-time">{clock}</span>
            <canvas ref={wave} className="rec-wave" />
          </div>
        ) : (
          <textarea
            ref={area}
            value={text}
            rows={1}
            placeholder={picture ? "Подпись к картинке (можно пусто)" : "Что было или что запланировать…"}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              const f = imageFrom(e.clipboardData);
              if (f) { e.preventDefault(); void attach(f); }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
              if (e.key === "Escape" && picture) setPicture(null);
            }}
          />
        )}
        {!recording && (
          <>
            <input ref={file} type="file" accept="image/*" hidden onChange={(e) => { void attach(e.target.files?.[0]); e.target.value = ""; }} />
            <button type="button" className="mic" disabled={busy} onClick={() => file.current?.click()} title="Картинка: чек, билет, скриншот (или Ctrl+V)" aria-label="Приложить картинку">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5l-8.6 8.6a5 5 0 0 1-7.1-7.1l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9" /></svg>
            </button>
          </>
        )}
        {(recording || (!text.trim() && !picture)) && (
          <button
            type="button"
            className={`mic ${recording ? "rec" : ""}`}
            disabled={busy}
            onClick={() => void (recording ? stopMic() : startMic())}
            title={recording ? "Отправить запись (Enter)" : "Сказать голосом"}
            aria-label={recording ? "Отправить запись" : "Сказать голосом"}
          >
            {recording ? (
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M3.4 20.4 21 12 3.4 3.6 3.4 10.2 15 12 3.4 13.8z" /></svg>
            ) : (
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
            )}
          </button>
        )}
        <button className="primary" type="submit" disabled={busy || (!text.trim() && !picture)}>{busy ? "…" : "Записать"}</button>
      </form>
    </div>
  );
}

const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
function dayChip(d: string) {
  const [y, m, day] = d.split("-").map(Number);
  return `${day} ${MONTHS[m - 1]}${y !== new Date().getFullYear() ? " " + y : ""}`;
}
