import { type FormEvent, useEffect, useRef, useState } from "react";
import { post } from "./api";
import { Recorder } from "./recorder";
import { plainReply } from "./format";
import { navigate } from "./router";
import { imagesFrom, PICS_MAX, shrinkImage, type Picture } from "./picture";
import type { Reply } from "./types";

// Строка ввода на каждом экране: пишешь как в чат. Ответ горничной — снизу, с кнопкой «Отменить».

/** Подставить заготовку в строку ввода (кнопки вроде «+ Привычка»): текст, фокус, курсор в конце. */
export function prefill(text: string) {
  window.dispatchEvent(new CustomEvent("maid:compose", { detail: text }));
}

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
  // Картинки к сообщению (до PICS_MAX): скрепка, Ctrl+V в строке или перетащить на строку; ряд над вводом, текст — подпись.
  const [pictures, setPictures] = useState<Picture[]>([]);
  const file = useRef<HTMLInputElement>(null);

  async function attach(list: Iterable<File> | null | undefined) {
    const files = [...(list ?? [])];
    if (!files.length) return;
    const room = PICS_MAX - pictures.length;
    if (room <= 0) return show({ text: `Больше ${PICS_MAX} картинок за раз нельзя.`, error: true }, 5000);
    try {
      const shrunk = await Promise.all(files.slice(0, room).map((f) => shrinkImage(f)));
      setPictures((p) => [...p, ...shrunk].slice(0, PICS_MAX));
      area.current?.focus();
      if (files.length > room) show({ text: `Взяла ${room}: больше ${PICS_MAX} за раз нельзя.`, error: true }, 5000);
    } catch {
      show({ text: "Не получилось открыть картинку.", error: true }, 6000);
    }
  }

  useEffect(() => {
    const put = (e: Event) => {
      const t = String((e as CustomEvent).detail ?? "");
      setText(t);
      window.setTimeout(() => { const a = area.current; if (a) { a.focus(); a.setSelectionRange(t.length, t.length); } });
    };
    window.addEventListener("maid:compose", put);
    return () => window.removeEventListener("maid:compose", put);
  }, []);

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
    if ((!t && !pictures.length) || busy) return;
    const images = pictures.length ? pictures.map((p) => ({ data: p.data, mime: p.mime })) : undefined;
    setBusy(true);
    if (images) show({ text: images.length > 1 ? `📷×${images.length} Смотрю…` : "📷 Смотрю…" }, 60000);
    try {
      const r = await post<Reply>("/api/input", { text: t, images, id: crypto.randomUUID() });
      setText("");
      setPictures([]);
      show({ text: plainReply(r.text), reply: r });
      onChanged();
    } catch (err) {
      show({ text: (err as Error).message, error: true });
    } finally {
      setBusy(false);
      area.current?.focus();
    }
  }

  // «Сдвинуть на …» / «Оставить» после наложения планов.
  async function clash(action: "shift" | "keep") {
    const r0 = reply?.reply;
    if (!r0?.clash) return;
    try {
      const r = await post<{ text: string }>("/api/clash", { messageId: r0.messageId, eventId: r0.clash.eventId, withId: r0.clash.withId, action });
      show({ text: plainReply(r.text) }, 6000);
      onChanged();
    } catch (err) {
      show({ text: (err as Error).message, error: true });
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
            {reply.reply?.clash?.shiftTo && <button onClick={() => clash("shift")}>➜ Сдвинуть на {reply.reply.clash.shiftTo}</button>}
            {reply.reply?.clash && <button onClick={() => clash("keep")}>Оставить</button>}
            {reply.reply?.undoable && <button onClick={undo}>↩ Отменить</button>}
            <button className="ghost" onClick={() => setReply(null)}>✕</button>
          </div>
        </div>
      )}
      <form
        className={`composer ${recording ? "recording" : ""}`}
        onSubmit={send}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); void attach(imagesFrom(e.dataTransfer)); }}
      >
        {pictures.length > 0 && !recording && (
          <div className="pics" title="Картинки уйдут вместе с сообщением">
            {pictures.map((p, i) => (
              <div className="pic" key={p.url.slice(-40) + i}>
                <img src={p.url} alt="" />
                <button type="button" className="ghost" onClick={() => setPictures((l) => l.filter((_, j) => j !== i))} title="Убрать картинку" aria-label="Убрать картинку">✕</button>
              </div>
            ))}
          </div>
        )}
        {!recording && (
          <>
            <input ref={file} type="file" accept="image/*" multiple hidden onChange={(e) => { void attach(e.target.files); e.target.value = ""; }} />
            <button type="button" className="mic plus ghost" disabled={busy} onClick={() => file.current?.click()} title="Приложить картинку: чек, билет, скриншот (или Ctrl+V)" aria-label="Приложить картинку">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
            </button>
          </>
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
            placeholder={pictures.length ? "Подпись к картинкам (можно пусто)" : "Что было или что запланировать…"}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              const f = imagesFrom(e.clipboardData);
              if (f.length) { e.preventDefault(); void attach(f); }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
              if (e.key === "Escape" && pictures.length) setPictures((l) => l.slice(0, -1));
            }}
          />
        )}
        {(() => {
          const ready = !!text.trim() || pictures.length > 0;
          // Одна кнопка, как в виджете: пусто — микрофон, есть текст или картинка — отправить, идёт запись — отправить запись.
          return recording ? (
            <button type="button" className="mic rec" disabled={busy} onClick={() => void stopMic()} title="Отправить запись (Enter)" aria-label="Отправить запись">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M3.4 20.4 21 12 3.4 3.6 3.4 10.2 15 12 3.4 13.8z" /></svg>
            </button>
          ) : ready ? (
            <button type="submit" className="mic send" disabled={busy} title="Записать (Enter)" aria-label="Записать">
              {busy ? "…" : <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M3.4 20.4 21 12 3.4 3.6 3.4 10.2 15 12 3.4 13.8z" /></svg>}
            </button>
          ) : (
            <button type="button" className="mic talk" disabled={busy} onClick={() => void startMic()} title="Сказать голосом" aria-label="Сказать голосом">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
            </button>
          );
        })()}
      </form>
    </div>
  );
}

const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
function dayChip(d: string) {
  const [y, m, day] = d.split("-").map(Number);
  return `${day} ${MONTHS[m - 1]}${y !== new Date().getFullYear() ? " " + y : ""}`;
}
