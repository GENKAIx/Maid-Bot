import { Fragment, useState } from "react";
import { post } from "./api";
import { shortDay } from "./format";
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

/** Правка сна за день (POST /api/sleep): записи о сне за день заменяются одной «лёг в …, встал в …»; «Удалить» — убрать сон. */
function SleepEditor({ day, notes, onDone }: { day: SleepDay; notes: string[]; onDone: (saved: boolean) => void }) {
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
        {day.hours ? <button type="button" disabled={busy} onClick={() => confirm(`Убрать сон за ${shortDay(day.day)}?`) && void send({ clear: true })}>Удалить сон</button> : null}
        <button type="button" className="ghost" disabled={busy} onClick={() => onDone(false)}>Отмена</button>
        {err && <span className="small err">{err}</span>}
      </div>
    </form>
  );
}

/** onChanged — после правки сна (без него шкала только для просмотра); notes — тексты записей о сне по дням. */
export function SleepTimeline({ days, notes, onChanged }: { days: SleepDay[]; notes?: Map<string, string[]>; onChanged?: () => void }) {
  const [hover, setHover] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="sleep">
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
        const edit = onChanged ? { role: "button", tabIndex: 0, onClick: () => setOpen(open === d.day ? null : d.day), onKeyDown: (e: { key: string }) => e.key === "Enter" && setOpen(open === d.day ? null : d.day) } : {};
        return (
          <Fragment key={d.day}>
          <div className={`sleep-row ${hover === d.day || open === d.day ? "on" : ""}${onChanged ? " editable" : ""}`} onMouseEnter={() => setHover(d.day)} onMouseLeave={() => setHover(null)} title={onChanged ? `${tip} · щёлкните, чтобы исправить` : tip} {...edit}>
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
          {open === d.day && onChanged && <SleepEditor day={d} notes={notes?.get(d.day) ?? []} onDone={(saved) => { setOpen(null); if (saved) onChanged(); }} />}
          </Fragment>
        );
      })}
      <p className="muted small sleep-legend"><i className="sleep-night-dot" /> 22:00–7:00 — ночное время{onChanged ? " · щёлкните по дню, чтобы записать или исправить сон" : ""}</p>
    </div>
  );
}
