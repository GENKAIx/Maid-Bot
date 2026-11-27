import { type FormEvent, useEffect, useRef, useState } from "react";
import { post } from "./api";
import { refusedOf, refusedView } from "./billing";
import { Recorder } from "./recorder";
import { plainReply } from "./format";
import { navigate } from "./router";
import { imagesFrom, PICS_MAX, shrinkImage, type Picture } from "./picture";
import { Icon } from "./icons";
import { canNote, draftFor, draftKey, holdsPlace, keepDraft, keepQuestion, openProposal, replyState, retryable, retryWay, stateLabel, stateLook, stillAsked, togglePick, type Draft, type Shown } from "./replyview";
import type { Reply } from "./types";

// Строка ввода на каждом экране: пишешь как в чат. Ответ Рины — над строкой: висит до следующей отправки или крестика
// (docs/ДИЗАЙН.md 5.8, решение 23). Состояние ответа, id черновика и способ повтора — чистые функции в replyview.ts.

/** Сколько висят короткие итоги кнопок («отменила», «вопрос сняла») и ошибки без записи — docs/ДИЗАЙН.md 4.4. */
const NOTE_MS = 6000;
const ERROR_MS = 14000;

/** Подставить заготовку в строку ввода (кнопки вроде «+ Привычка»): текст, фокус, курсор в конце. */
export function prefill(text: string) {
  window.dispatchEvent(new CustomEvent("maid:compose", { detail: text }));
}

export function Composer({ onChanged }: { onChanged: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  // pay — ссылка на оплату (сервер ответил 402: пробная неделя или подписка кончились): кнопка «⭐ Оформить подписку» в ответе.
  const [reply, setReply] = useState<Shown | null>(null);
  // То же, что reply, но без ожидания перерисовки: обработчики (Enter при записи голоса, ответы сервера) читают свежее.
  const cur = useRef<Shown | null>(null);
  const timer = useRef<number>(0);
  // Номер плашки: растёт с каждой новой плашкой и каждой отправкой. Итог кнопки, нажатой на прежней плашке, новую не затирает.
  const plate = useRef(0);
  // Черновик отправки: id не меняется, пока та же фраза не дошла (повтор после сбоя не создаёт вторую запись).
  const draft = useRef<Draft | null>(null);
  // Запись голоса, которая ещё не дошла до сервера: «Повторить» шлёт её же с тем же id.
  const voice = useRef<{ audio: string; mime: string; sec: number; id: string } | null>(null);
  // Отмеченные пункты вопроса «добавить?» и «идёт запрос кнопки плашки».
  const [picked, setPicked] = useState<number[]>([]);
  const [acting, setActing] = useState(false);
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
    if (room <= 0) return hint(`Больше ${PICS_MAX} картинок за раз нельзя.`, 5000);
    try {
      const shrunk = await Promise.all(files.slice(0, room).map((f) => shrinkImage(f)));
      setPictures((p) => [...p, ...shrunk].slice(0, PICS_MAX));
      area.current?.focus();
      if (files.length > room) hint(`Взяла ${room}: больше ${PICS_MAX} за раз нельзя.`, 5000);
    } catch {
      hint("Не получилось открыть картинку.", 6000);
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
      hint(`Нет доступа к микрофону: ${(err as Error).message}`, ERROR_MS);
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
    voice.current = { ...v, id: crypto.randomUUID() };
    await sendVoice();
  }

  // Запись уходит с тем же id, пока сервер её не принял: при сбое она остаётся в памяти, «Повторить» шлёт её же.
  async function sendVoice() {
    const v = voice.current;
    if (!v) return;
    const before = cur.current;
    setBusy(true);
    show({ text: "🎙 Распознаю…", wait: true }, 60000);
    try {
      const r = await post<Reply & { heard: string }>("/api/voice", v);
      const said = `🎙 ${r.heard}

${plainReply(r.text)}`;
      // Вопрос всё ещё ждёт (stillAsked): он остаётся на экране; ответ на него не разобрался — запись держим для «Повторить».
      const asked = stillAsked(before, r);
      if (!(asked && r.failed)) voice.current = null;
      show(asked ? keepQuestion(before, r, said, "voice") : { text: said, reply: r, sent: r.heard });
      onChanged();
    } catch (err) {
      refused(err, "voice", before);
    } finally {
      setBusy(false);
    }
  }

  // Плашка над строкой. Без ms висит, пока её не сменит следующая отправка или не закроют крестиком; с ms — гаснет сама
  // (ход работы и короткие итоги кнопок).
  function show(r: Shown | null, ms?: number) {
    plate.current++;
    cur.current = r;
    setReply(r);
    setPicked(openProposal(r)?.picked ?? []);
    clearTimeout(timer.current);
    if (r && ms) timer.current = window.setTimeout(() => show(null), ms);
  }

  // Сбой без записи (картинка не открылась, нет микрофона). Висящий ответ (с «Отменить», вопросом, несохранённым) при этом
  // с экрана не уходит: причина — строкой внутри него. Отдельной гаснущей плашкой — только когда над строкой пусто,
  // идёт работа или висит короткий итог (holdsPlace).
  function hint(message: string, ms: number) {
    if (holdsPlace(cur.current)) return trouble(message);
    show({ text: message, error: true }, ms);
  }

  // Сбой кнопки плашки: плашка и её кнопки остаются, причина — строкой внутри.
  function trouble(problem: string) {
    const s = cur.current;
    if (!s) return show({ text: problem, error: true }, ERROR_MS);
    cur.current = { ...s, problem };
    setReply(cur.current);
  }

  // Итог кнопки прежней плашки пришёл, когда над строкой уже другое (человек успел отправить новую фразу): новый ответ
  // и его кнопки остаются, итог — строкой под ним; над строкой пусто или идёт работа — короткой плашкой.
  function late(text: string) {
    const s = cur.current;
    if (!s || s.wait) return show({ text }, NOTE_MS);
    cur.current = { ...s, aside: [s.aside, text].filter(Boolean).join("\n") };
    setReply(cur.current);
  }

  // Одна кнопка плашки за раз; ошибка запроса — строкой в той же плашке. Итог показывает land: плашка та же, что была при
  // нажатии, — как обычно; уже другая (за время запроса ушла новая отправка) — её не трогаем, итог дописывается (late).
  async function act(run: (land: (r: Shown, ms?: number) => void, fresh: () => boolean) => Promise<void>) {
    if (acting) return;
    const n = plate.current;
    const fresh = () => plate.current === n;
    setActing(true);
    try {
      await run((r, ms) => (fresh() ? show(r, ms) : late(r.text)), fresh);
    } catch (err) {
      if (fresh()) trouble((err as Error).message);
      else late((err as Error).message);
    } finally {
      setActing(false);
    }
  }

  // Строка ввода всё ещё держит ту фразу, что ушла с этим черновиком (её не правили) — после записи её можно очистить.
  function clearSent() {
    if (!draft.current || draftKey(text, pictures) !== draft.current.key) return;
    draft.current = null;
    setText("");
    setPictures([]);
  }

  async function send(e?: FormEvent) {
    e?.preventDefault();
    const t = text.trim();
    if ((!t && !pictures.length) || busy) return;
    const images = pictures.length ? pictures.map((p) => ({ data: p.data, mime: p.mime })) : undefined;
    // Та же фраза после сбоя уходит с прежним id; новый — после успеха или правки текста (replyview.ts draftFor).
    const d = (draft.current = draftFor(draft.current, draftKey(t, pictures), () => crypto.randomUUID()));
    const before = cur.current;
    voice.current = null;
    setBusy(true);
    plate.current++;
    if (images) show({ text: images.length > 1 ? `📷×${images.length} Смотрю…` : "📷 Смотрю…", wait: true }, 60000);
    // Прежний ответ уходит с новой отправкой; вопрос остаётся, пока на него не пришёл ответ.
    else if (before && replyState(before) !== "clarify") show(null);
    try {
      const r = await post<Reply>("/api/input", { text: t, images, id: d.id });
      // Сервер фразу принял: строка очищается, следующая отправка — с новым id. Разбор не удался (failed) — фраза лежит
      // на сервере несохранённой, в плашке «Повторить» и «Оставить заметкой»; с картинками набранное остаётся (keepDraft).
      // Вопрос всё ещё ждёт (stillAsked: пришла картинка, «какая погода?» или разбор ответа на вопрос упал) — он остаётся
      // на экране с крестиком и «Оставить заметкой»; неразобранный ответ на него остаётся в строке, «Повторить» шлёт его же.
      const asked = stillAsked(before, r);
      const keep = keepDraft(r, !!images) || (asked && !!r.failed);
      if (!keep) {
        draft.current = null;
        setText("");
        setPictures([]);
      }
      const way = keep ? "draft" as const : undefined;
      show(asked ? keepQuestion(before, r, plainReply(r.text), way) : { text: plainReply(r.text), reply: r, sent: t, again: way });
      onChanged();
    } catch (err) {
      refused(err, "draft", before);
    } finally {
      setBusy(false);
      area.current?.focus();
    }
  }

  // Ошибка записи. ИИ закрыт (402 — нет пробы или подписки; 429 — слишком часто или лимит дня): сервер уже записал текст
  // заметкой (saved) — строка очищается, а ответ можно отменить; у 402 — кнопка оплаты, плашка не красная.
  // Иначе набранное остаётся в строке, запись голоса — в памяти, а в плашке есть «Повторить» (way) с тем же id.
  // before — что висело до отправки: если это был вопрос, он остаётся на экране (сервер всё ещё ждёт ответ).
  function refused(err: unknown, way: "draft" | "voice", before: Shown | null) {
    const no = refusedOf(err);
    const v = refusedView(no);
    if (v.clear) {
      draft.current = null;
      setText("");
      setPictures([]);
      onChanged();
    }
    const again = !v.clear && retryable(err) ? way : undefined;
    if (way === "voice" && !again) voice.current = null;
    const message = (err as Error).message;
    if (!v.clear && before && replyState(before) === "clarify") return show({ ...before, problem: message, again });
    const undo: Reply | undefined = no && v.undoId ? { text: no.text, emotion: "neutral", messageId: v.undoId, undoable: true } : undefined;
    show({ text: message, error: v.error, pay: no?.payUrl ?? undefined, reply: undo, again });
  }

  // «Повторить» у несохранённого: строка ввода или запись голоса с прежним id, либо разбор фразы, что лежит на сервере.
  function again() {
    const s = cur.current;
    if (!s) return;
    const way = retryWay(s);
    if (way === "draft") return text.trim() || pictures.length ? void send() : trouble("В строке ввода пусто: повторять нечего.");
    if (way === "voice") return void sendVoice();
    if (way !== "message" || !s.reply) return;
    const id = s.reply.messageId;
    void act(async (land) => {
      const r = await post<Reply>(`/api/messages/${id}/retry`);
      land({ text: plainReply(r.text), reply: r, sent: s.sent });
      onChanged();
    });
  }

  // «Оставить заметкой»: фраза целиком в заметки, без разбора. Отменить можно тем же «Отменить».
  function asNote() {
    const s = cur.current;
    if (!s?.reply || !canNote(s)) return;
    const id = s.reply.messageId;
    void act(async (land) => {
      const r = await post<{ text: string }>(`/api/messages/${id}/note`);
      clearSent();
      voice.current = null;
      land({ text: plainReply(r.text), reply: { text: r.text, emotion: "neutral", messageId: id, undoable: true } });
      onChanged();
    });
  }

  // Крестик. У вопроса он снимает ожидание на сервере (иначе следующая фраза приклеилась бы к старой), а сама фраза
  // возвращается в строку ввода, если та пуста. Не снялось — вопрос остаётся на экране.
  function close() {
    const s = cur.current;
    if (!s?.reply || replyState(s) !== "clarify") {
      voice.current = null;
      return show(null);
    }
    const id = s.reply.messageId;
    void act(async (land, fresh) => {
      const r = await post<{ text: string; closed: boolean }>(`/api/messages/${id}/dismiss`);
      // В строке мог остаться неразобранный ответ на этот вопрос (его черновик): вместе с вопросом он закрыт и на сервере.
      const answer = !!draft.current && draftKey(text, pictures) === draft.current.key;
      if (r.closed) {
        clearSent();
        voice.current = null;
      }
      const back = fresh() && r.closed && !!s.sent && !pictures.length && (answer || !text.trim());
      if (back) setText(s.sent!);
      land({ text: back ? `${r.text} Она снова в строке ввода.` : r.text }, NOTE_MS);
    });
  }

  // Вопрос «добавить?»: «Добавить …», «Добавить и напоминать», «Не надо». Итог дописывается к ответу, «Отменить» остаётся.
  function decide(action: "remind" | "add" | "decline") {
    const s = cur.current;
    const p = openProposal(s);
    if (!s?.reply || !p) return;
    const r0 = s.reply;
    void act(async (_land, fresh) => {
      const r = await post<{ text: string; done: boolean }>(`/api/proposals/${p.id}`, { action, picked: action === "decline" ? undefined : picked });
      if (!fresh()) {
        if (r.done) onChanged();
        return late(plainReply(r.text));
      }
      if (!r.done) return trouble(plainReply(r.text));
      show({ ...s, text: [s.text, plainReply(r.text)].join("\n\n"), reply: { ...r0, proposal: undefined }, problem: undefined });
      onChanged();
    });
  }

  // «Сдвинуть на …» / «Оставить» после наложения планов.
  function clash(action: "shift" | "keep") {
    const r0 = cur.current?.reply;
    if (!r0?.clash) return;
    const c = r0.clash;
    void act(async (land) => {
      const r = await post<{ text: string }>("/api/clash", { messageId: r0.messageId, eventId: c.eventId, withId: c.withId, action });
      land({ text: plainReply(r.text) }, NOTE_MS);
      onChanged();
    });
  }

  function undo() {
    const r0 = cur.current?.reply;
    if (!r0) return;
    void act(async (land) => {
      const r = await post<{ text: string }>("/api/undo", { messageId: r0.messageId });
      land({ text: plainReply(r.text) }, NOTE_MS);
      onChanged();
    });
  }

  const state = reply ? replyState(reply) : "saved";
  const look = reply ? stateLook(reply) : { bad: false, role: "status" as const };
  const prop = openProposal(reply);

  return (
    <div className="composer-wrap">
      {reply && (
        <div className={`toast${look.bad ? " bad" : ""}${state === "clarify" ? " ask" : ""}`} role={look.role}>
          <div className="toast-text">
            {stateLabel(state) && <div className="toast-state">{stateLabel(state)}</div>}
            {reply.reply?.days?.length ? reply.text.replace(/\n📅 .*$/, "") : reply.text}
            {!!reply.reply?.days?.length && (
              <div className="toast-days">
                {reply.reply.days.map((d) => (
                  <button type="button" key={d} onClick={() => { navigate(`/diary/${d}`); show(null); }}>📅 {dayChip(d)}</button>
                ))}
              </div>
            )}
            {prop && (
              <div className="toast-prop">
                {prop.items.map((it, i) => (prop.items.length > 1 ? (
                  <label key={i}>
                    <input type="checkbox" checked={picked.includes(i)} disabled={acting} onChange={() => setPicked((l) => togglePick(l, i))} />
                    <span><b>{it.title}</b>{it.detail && <i>{it.detail}</i>}</span>
                  </label>
                ) : (
                  <div key={i}><span><b>{it.title}</b>{it.detail && <i>{it.detail}</i>}</span></div>
                )))}
              </div>
            )}
            {reply.aside && <div className="toast-aside">{reply.aside}</div>}
            {reply.problem && <div className="toast-problem" role="alert">{reply.problem}</div>}
          </div>
          <div className="toast-actions">
            {prop?.remind && <button type="button" disabled={acting} onClick={() => decide("remind")}>{prop.remind.label}</button>}
            {prop && <button type="button" disabled={acting} onClick={() => decide("add")}>{prop.add}</button>}
            {prop && <button type="button" disabled={acting} onClick={() => decide("decline")}>Не надо</button>}
            {retryWay(reply) && <button type="button" disabled={acting || busy} onClick={again}>Повторить</button>}
            {canNote(reply) && <button type="button" disabled={acting || busy} onClick={asNote}>Оставить заметкой</button>}
            {reply.reply?.clash?.shiftTo && <button type="button" disabled={acting} onClick={() => clash("shift")}>➜ Сдвинуть на {reply.reply.clash.shiftTo}</button>}
            {reply.reply?.clash && <button type="button" disabled={acting} onClick={() => clash("keep")}>Оставить</button>}
            {reply.pay && <a className="btn pay" href={reply.pay} target="_blank" rel="noopener noreferrer">⭐ Оформить подписку</a>}
            {reply.reply?.undoable && <button type="button" disabled={acting} onClick={undo}>↩ Отменить</button>}
            {state !== "wait" && (
              <button
                type="button" className="ghost toast-close" disabled={acting} onClick={close}
                title={state === "clarify" ? "Закрыть вопрос: фраза не будет записана" : "Закрыть"}
                aria-label={state === "clarify" ? "Закрыть вопрос" : "Закрыть ответ"}
              >
                <Icon name="close" size={18} />
              </button>
            )}
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
