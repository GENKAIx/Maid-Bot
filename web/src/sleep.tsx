import { Fragment, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { post } from "./api";
import { NoteBar, undoNote, useNote } from "./components";
import { shortDay } from "./format";
import { failNote } from "./notice";
import type { DiaryRow, MetricRow } from "./types";

// Сон по часам суток: из записей о сне («лёг в 5:00, проснулся в 14:00», «спал с 2 до 9») и часов сна (sleep_hours)
// — полоса на шкале от 18:00 вечера накануне до 18:00 дня записи.

export interface SleepDay { day: string; bed?: number; wake?: number; hours?: number }

const T = String.raw`(\d{1,2})(?:[:.](\d{2}))?`;
const at = (h: string, m?: string) => {
  const v = Number(h) + (m ? Number(m) / 60 : 0);
  return v >= 0 && v <= 24 ? v % 24 : undefined;
};

/** Время отбоя, подъёма и часы сна из текста записи. */
export function parseSleep(text: string): Omit<SleepDay, "day"> {
  const t = text.toLowerCase().replace(/ё/g, "е");
  const out: Omit<SleepDay, "day"> = {};
  const range = t.match(new RegExp(String.raw`(?:^|\s)с\s*${T}\s*(?:ч\S*\s*)?(?:утра|ночи|вечера)?\s*до\s*${T}`)) ?? t.match(new RegExp(String.raw`${T}\s*[–—-]\s*${T}`));
  if (range) {
    out.bed = at(range[1], range[2]);
    out.wake = at(range[3], range[4]);
  }
  const bed = t.match(new RegExp(String.raw`(?:лег\S*|уснул\S*|заснул\S*|отбой|в кровать|спать в)\D{0,14}?${T}`));
  if (bed) out.bed = at(bed[1], bed[2]);
  const wake = t.match(new RegExp(String.raw`(?:проснул\S*|встал\S*|подъем\S*|поднялс\S*)\D{0,14}?${T}`));
  if (wake) out.wake = at(wake[1], wake[2]);
  const hours = t.match(/(?:спал\S*|сон|поспал\S*)\D{0,12}?(\d{1,2}(?:[.,]\d)?)\s*(?:ч|час)/);
  if (hours) out.hours = Number(hours[1].replace(",", "."));
  return out;
}

/** День → сон: записи дня и часы сна вместе. */
export function sleepDays(notes: DiaryRow[], metrics: MetricRow[]): Map<string, SleepDay> {
  const map = new Map<string, SleepDay>();
  const of = (day: string) => map.get(day) ?? (map.set(day, { day }), map.get(day)!);
  for (const n of notes) {
    const p = parseSleep(n.text);
    const d = of(n.day_key);
    d.bed ??= p.bed;
    d.wake ??= p.wake;
    d.hours ??= p.hours;
  }
  for (const m of metrics) if (m.key === "sleep_hours" && m.value > 0) of(m.day_key).hours ??= m.value;
  for (const d of map.values()) if (d.bed !== undefined && d.wake !== undefined) d.hours = ((d.wake - d.bed + 24) % 24) || 24;
  return map;
}

const START = 18; // шкала: 18:00 накануне → 18:00
const off = (h: number) => (h - START + 24) % 24;
/** Отрезок на шкале 0..24 или null, если времени нет. */
export function span(d: SleepDay): [number, number] | null {
  if (!d.hours) return null;
  if (d.bed !== undefined) return [off(d.bed), Math.min(24, off(d.bed) + d.hours)];
  if (d.wake !== undefined) return [Math.max(0, off(d.wake) - d.hours), off(d.wake) || 24];
  return null;
}
export const clock = (h: number) => {
  const v = ((h % 24) + 24) % 24;
  const m = Math.round((v % 1) * 60);
  return `${Math.floor(v) + (m === 60 ? 1 : 0)}:${String(m % 60).padStart(2, "0")}`;
};
const hoursText = (h: number) => `${h.toLocaleString("ru-RU", { maximumFractionDigits: 1 })} ч`;

/** Среднее время отбоя и подъёма (по шкале от 18:00, чтобы 23:00 и 1:00 давали полночь). */
export function sleepAverages(days: SleepDay[]) {
  const spans = days.map(span).filter((s): s is [number, number] => !!s);
  const avg = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
  return spans.length ? { bed: clock(avg(spans.map((s) => s[0])) + START), wake: clock(avg(spans.map((s) => s[1])) + START) } : null;
}

const TICKS = [0, 3, 6, 9, 12, 15, 18, 21, 24];

const hhmm = (h: number) => clock(h).padStart(5, "0");
/** С чем открывается форма правки: время с полосы, у дня без времени — 23:00–07:00. */
export function sleepDraft(d: SleepDay): { bed: string; wake: string } {
  const s = span(d);
  return s ? { bed: hhmm(s[0] + START), wake: hhmm(s[1] + START) } : { bed: "23:00", wake: "07:00" };
}

// Перетаскивание сна на другой день (POST /api/sleep/swap, 27.11.2026): мышью — сдвинуть больше чем на DRAG_PX, пальцем —
// подержать LONG_PRESS_MS (иначе палец прокручивает страницу). Отпустить на строке дня — перенос или обмен, мимо строк или Esc — отмена.
export const DRAG_PX = 6;
export const LONG_PRESS_MS = 300;
/** Палец сдвинулся до долгого нажатия больше этого — это прокрутка, не перетаскивание. */
export const TOUCH_SLOP_PX = 10;

/** Что с нажатием: ещё ждём, началось перетаскивание или это не оно (прокрутка пальцем). */
export function pressOutcome(p: { dx: number; dy: number; ms: number; touch: boolean }): "wait" | "drag" | "cancel" {
  const moved = Math.hypot(p.dx, p.dy);
  if (!p.touch) return moved >= DRAG_PX ? "drag" : "wait";
  if (moved >= TOUCH_SLOP_PX) return p.ms >= LONG_PRESS_MS ? "drag" : "cancel";
  return p.ms >= LONG_PRESS_MS ? "drag" : "wait";
}

/** Строка дня под указателем: и по высоте, и по ширине строки; мимо (в щели, сбоку над меню) — null. */
export function rowAt(x: number, y: number, rows: { day: string; top: number; bottom: number; left: number; right: number }[]): string | null {
  return rows.find((r) => y >= r.top && y < r.bottom && x >= r.left && x < r.right)?.day ?? null;
}

/** Строка после переноса: «Сон 8 ноя ⇄ 12 ноя» или «Сон перенесён на 12 ноя». */
export function sleepMoveText(from: string, to: string, swapped: boolean): string {
  return swapped ? `Сон ${shortDay(from)} ⇄ ${shortDay(to)}` : `Сон перенесён на ${shortDay(to)}`;
}

/** Правка сна за день (POST /api/sleep): записи о сне за день заменяются одной «лёг в …, встал в …»; «Удалить» — убрать сон. */
function SleepEditor({ day, notes, onDone }: { day: SleepDay; notes: string[]; onDone: (saved: boolean, undo?: number | null) => void }) {
  const [draft, setDraft] = useState(() => ({ ...sleepDraft(day), note: "" }));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  async function send(body: object) {
    setBusy(true); setErr("");
    try {
      await post("/api/sleep", { day: day.day, ...body });
      onDone(true);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }
  // «Удалить сон» — без вопроса: сервер отдаёт undo, шкала показывает плашку «Отменить» на 8 секунд. Не вышло — сон на месте, причина здесь же.
  async function clear() {
    setBusy(true); setErr("");
    try {
      const r = await post<{ undo?: number | null }>("/api/sleep", { day: day.day, clear: true });
      onDone(true, r.undo ?? null);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <form className="sleep-edit" onSubmit={(e) => { e.preventDefault(); void send({ bed: draft.bed, wake: draft.wake, note: draft.note }); }}>
      {notes.length > 0 && <p className="muted small">Сейчас записано: {notes.map((n) => `«${n}»`).join(", ")} — заменится.</p>}
      <div className="row">
        <label>Лёг <input type="time" required value={draft.bed} onChange={(e) => setDraft({ ...draft, bed: e.target.value })} /></label>
        <label>Встал <input type="time" required value={draft.wake} onChange={(e) => setDraft({ ...draft, wake: e.target.value })} /></label>
        <input className="grow" placeholder="Заметка: просыпался ночью, снились кошмары…" maxLength={300} value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
      </div>
      <div className="row">
        <button type="submit" className="primary" disabled={busy}>Сохранить</button>
        {day.hours ? <button type="button" disabled={busy} onClick={() => void clear()}>Удалить сон</button> : null}
        <button type="button" className="ghost" disabled={busy} onClick={() => onDone(false)}>Отмена</button>
        {err && <span className="small err" role="alert">{err}</span>}
      </div>
    </form>
  );
}

type Drag = { from: string; label: string; y: number; dy: number; left: number; width: number; height: number; over: string | null };
type Press = { day: string; x: number; y: number; t: number; touch: boolean; id: number; timer: number };
/** onChanged — после правки сна (без него шкала только для просмотра); notes — тексты записей о сне по дням.
 *  С onChanged полосу сна можно перетащить на другой день (перенос или обмен, «↩ Отменить»). */
export function SleepTimeline({ days, notes, onChanged }: { days: SleepDay[]; notes?: Map<string, string[]>; onChanged?: () => void }) {
  const [hover, setHover] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [drag, setDragState] = useState<Drag | null>(null);
  const [note, say] = useNote();
  const dragRef = useRef<Drag | null>(null);
  const press = useRef<Press | null>(null);
  const dragged = useRef(false); // перетаскивание кончилось — щелчок за ним не открывает правку
  const rowEls = useRef(new Map<string, HTMLDivElement>());
  const setDrag = (d: Drag | null) => { dragRef.current = d; setDragState(d); };

  const undo = (id: number) => void undoNote(id, say, onChanged);
  function rows() {
    return [...rowEls.current].map(([day, el]) => { const r = el.getBoundingClientRect(); return { day, top: r.top, bottom: r.bottom, left: r.left, right: r.right }; });
  }
  function start(p: Press, y: number) {
    const el = rowEls.current.get(p.day);
    const bar = el?.querySelector<HTMLElement>(".sleep-bar, .sleep-unknown") ?? el?.querySelector<HTMLElement>(".sleep-track");
    if (!bar) return;
    const r = bar.getBoundingClientRect();
    const sd = days.find((d) => d.day === p.day);
    const s = sd && span(sd);
    const label = s ? `${clock(s[0] + START)} – ${clock(s[1] + START)}` : sd?.hours ? hoursText(sd.hours) : shortDay(p.day);
    setHover(null);
    setDrag({ from: p.day, label, y, dy: p.y - r.top, left: r.left, width: Math.max(r.width, 40), height: r.height, over: p.day });
  }
  function stopPress() {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  }
  function cancel() {
    stopPress();
    if (!dragRef.current) return;
    dragged.current = true; // сбрасывается следующим нажатием на шкалу: щелчок после касания приходит позже pointerup отдельной задачей
    setDrag(null);
  }
  async function drop() {
    const d = dragRef.current;
    cancel();
    if (!d || !d.over || d.over === d.from) return;
    try {
      const r = await post<{ swapped: boolean; undo: number }>("/api/sleep/swap", { from: d.from, to: d.over });
      say({ text: sleepMoveText(d.from, d.over, r.swapped), undo: r.undo });
      onChanged?.();
    } catch (e) {
      say(failNote("Не получилось перенести", e));
    }
  }
  // Слушатели на окне берут свежие функции через ref (иначе замкнутся на первый рендер).
  const live = useRef({ start, cancel, drop, rows, stopPress });
  live.current = { start, cancel, drop, rows, stopPress };
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const p = press.current;
      if (!p || p.id !== e.pointerId) return;
      if (!dragRef.current) {
        const o = pressOutcome({ dx: e.clientX - p.x, dy: e.clientY - p.y, ms: Date.now() - p.t, touch: p.touch });
        if (o === "cancel") return live.current.stopPress();
        if (o === "wait") return;
        live.current.start(p, e.clientY);
        if (!dragRef.current) return;
      }
      setDrag({ ...dragRef.current!, y: e.clientY, over: rowAt(e.clientX, e.clientY, live.current.rows()) });
    };
    const up = (e: PointerEvent) => {
      if (press.current?.id !== e.pointerId) return;
      if (dragRef.current) void live.current.drop();
      else live.current.stopPress();
    };
    const lost = (e: PointerEvent) => { if (press.current?.id === e.pointerId) live.current.cancel(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape" && dragRef.current) { e.preventDefault(); live.current.cancel(); } };
    // Пальцем: пока тащим — страница не прокручивается.
    const touch = (e: TouchEvent) => { if (dragRef.current && e.cancelable) e.preventDefault(); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", lost);
    window.addEventListener("keydown", key);
    window.addEventListener("touchmove", touch, { passive: false });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", lost);
      window.removeEventListener("keydown", key);
      window.removeEventListener("touchmove", touch);
      live.current.stopPress();
    };
  }, []);

  return (
    <div className={`sleep${drag ? " dragging" : ""}`} onPointerDownCapture={() => { dragged.current = false; }}>
      <div className="sleep-row sleep-head">
        <span />
        <div className="sleep-scale">
          {TICKS.map((t) => (
            <span key={t} className={t % 6 ? "minor" : ""} style={{ left: `${(t / 24) * 100}%` }}>{clock(t + START)}</span>
          ))}
        </div>
        <span />
      </div>
      {days.map((d, i) => {
        const s = span(d);
        const tip = s
          ? `${shortDay(d.day)}: лёг ${clock(s[0] + START)}, встал ${clock(s[1] + START)} · ${hoursText(d.hours!)}`
          : d.hours ? `${shortDay(d.day)}: ${hoursText(d.hours)}, время не записано` : `${shortDay(d.day)}: нет записи`;
        const toggle = () => setOpen(open === d.day ? null : d.day);
        const movable = !!onChanged && (!!d.hours || !!notes?.get(d.day)?.length);
        const edit = onChanged ? {
          role: "button", tabIndex: 0,
          onClick: () => { if (!dragged.current) toggle(); },
          onKeyDown: (e: { key: string }) => e.key === "Enter" && toggle(),
        } : {};
        const grab = movable ? {
          onPointerDown: (e: React.PointerEvent) => {
            if (dragRef.current || (e.pointerType === "mouse" && e.button !== 0)) return;
            stopPress();
            const p: Press = { day: d.day, x: e.clientX, y: e.clientY, t: Date.now(), touch: e.pointerType === "touch", id: e.pointerId, timer: 0 };
            if (p.touch) p.timer = window.setTimeout(() => { if (press.current === p && !dragRef.current) live.current.start(p, p.y); }, LONG_PRESS_MS);
            press.current = p;
          },
          onContextMenu: (e: React.MouseEvent) => { if (press.current || dragRef.current) e.preventDefault(); },
        } : {};
        const cls = [
          "sleep-row",
          !drag && (hover === d.day || open === d.day) ? "on" : "",
          onChanged ? "editable" : "",
          movable ? "movable" : "",
          drag?.from === d.day ? "drag-from" : "",
          drag && drag.over === d.day && drag.from !== d.day ? "drop" : "",
        ].filter(Boolean).join(" ");
        return (
          <Fragment key={d.day}>
          <div
            ref={(el) => { if (el) rowEls.current.set(d.day, el); else rowEls.current.delete(d.day); }}
            className={cls} onMouseEnter={() => setHover(d.day)} onMouseLeave={() => setHover(null)}
            title={onChanged ? `${tip} · щёлкните, чтобы исправить${movable ? ", перетащите на другой день" : ""}` : tip} {...edit} {...grab}
          >
            <span className="sleep-day">{shortDay(d.day)}</span>
            <div className="sleep-track">
              <i className="sleep-night" style={{ left: `${(off(22) / 24) * 100}%`, width: `${(9 / 24) * 100}%` }} />
              {TICKS.slice(1, -1).map((t) => <i key={t} className="sleep-tick" style={{ left: `${(t / 24) * 100}%` }} />)}
              {s && (
                <div className="sleep-bar" style={{ left: `${(s[0] / 24) * 100}%`, width: `${((s[1] - s[0]) / 24) * 100}%`, animationDelay: `${i * 25}ms` }}>
                  {s[1] - s[0] >= 4.5 && <span>{clock(s[0] + START)} – {clock(s[1] + START)}</span>}
                </div>
              )}
              {!s && d.hours ? <div className="sleep-unknown">{hoursText(d.hours)} — время не записано</div> : null}
            </div>
            <span className="sleep-hours">{d.hours ? hoursText(d.hours) : "—"}</span>
          </div>
          {open === d.day && onChanged && <SleepEditor day={d} notes={notes?.get(d.day) ?? []} onDone={(saved, undone) => {
            setOpen(null);
            if (!saved) return;
            if (undone !== undefined) say({ text: `Сон за ${shortDay(d.day)} убран`, undo: undone ?? undefined });
            onChanged();
          }} />}
          </Fragment>
        );
      })}
      {/* Призрак — в body: у карточки после появления остаётся transform, и position: fixed внутри неё считался бы от карточки. */}
      {drag && createPortal(
        <div className="sleep-ghost" aria-hidden style={{ top: drag.y - drag.dy, left: drag.left, width: drag.width, height: drag.height }}>
          <span>{drag.label}</span>
        </div>,
        document.body,
      )}
      {/* Плашка — под строками и прилипает к низу экрана: после переноса нижнего дня «↩ Отменить» видно и на телефоне. */}
      {note && <NoteBar note={note} className="sleep-note" onUndo={undo} onClose={() => say(null)} />}
      <p className="muted small sleep-legend"><i className="sleep-night-dot" /> 22:00–7:00 — ночное время{onChanged ? " · щёлкните по дню, чтобы записать или исправить сон, перетащите полосу на другой день — перенести" : ""}</p>
    </div>
  );
}
