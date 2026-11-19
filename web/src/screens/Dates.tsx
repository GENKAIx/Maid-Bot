import { useEffect, useRef, useState } from "react";
import { get, post } from "../api";
import { Card, Chip, Empty, Spinner } from "../components";
import { ageText, DATE_TYPES, dateGroups, formOf, type DateForm } from "../dates";
import { dateWhen, humanDay, MONTHS, MONTHS_GEN, shortDay } from "../format";
import type { DateItem } from "../types";

// «Планы» → «Даты» (19.11.2026; раньше — простыня внизу «Планов», только для чтения): «Скоро» (30 дней) и по месяцам,
// «+ Дата» и щелчок по строке — форма: название, день и месяц, год (если известен — для возраста), вид, «каждый год».
// Удалить — в корзину. Каждое действие отменяется («↩ Отменить»), как правка задачи. Сервер — POST /api/dates, /api/dates/:id.

type Note = { text: string; undo?: number; bad?: boolean };

export function Dates({ version, onChanged }: { version: number; onChanged: () => void }) {
  const [dates, setDates] = useState<DateItem[] | null>(null);
  const [error, setError] = useState("");
  // Открытая форма: null — закрыта, id 0 — новая дата.
  const [edit, setEdit] = useState<{ id: number; f: DateForm } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const timer = useRef(0);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    let alive = true;
    get<DateItem[]>("/api/dates?all=1").then((d) => alive && setDates(d)).catch((e) => alive && setError((e as Error).message));
    return () => { alive = false; };
  }, [version]);
  useEffect(() => { if (edit) formRef.current?.querySelector("input")?.focus(); }, [edit?.id]);

  function say(n: Note) {
    setNote(n);
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setNote(null), 8000);
  }
  async function undo(id: number) {
    setNote(null);
    try {
      await post("/api/undo", { messageId: id });
      onChanged();
    } catch (e) {
      say({ text: `Не получилось отменить: ${(e as Error).message}`, bad: true });
    }
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!edit || busy || !edit.f.title.trim()) return;
    const { f } = edit;
    const body = { title: f.title.trim(), day: f.day, month: f.month, year: f.year ? Number(f.year) : null, type: f.type, yearly: f.yearly };
    setBusy(true);
    try {
      const r = await post<{ undo: number }>(edit.id ? `/api/dates/${edit.id}` : "/api/dates", body);
      say({ text: edit.id ? `«${body.title}» — сохранено` : `«${body.title}» — добавлено, ${body.day} ${MONTHS_GEN[body.month - 1]}`, undo: r.undo });
      setEdit(null);
      onChanged();
    } catch (err) {
      say({ text: `Не получилось сохранить: ${(err as Error).message}`, bad: true });
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!edit?.id || busy) return;
    setBusy(true);
    try {
      const r = await post<{ undo: number }>(`/api/dates/${edit.id}`, { status: "deleted" });
      say({ text: `«${edit.f.title}» — в корзине`, undo: r.undo });
      setEdit(null);
      onChanged();
    } catch (err) {
      say({ text: `Не получилось удалить: ${(err as Error).message}`, bad: true });
    } finally {
      setBusy(false);
    }
  }

  if (error) return <Empty>Нет связи: {error}</Empty>;
  if (!dates) return <Spinner />;
  const { soon, months } = dateGroups(dates);
  const set = (p: Partial<DateForm>) => setEdit((x) => (x ? { ...x, f: { ...x.f, ...p } } : x));
  const yearOk = !edit?.f.year || /^\d{4}$/.test(edit.f.year);

  const row = (x: DateItem) => (
    <li key={x.id} className={`date-row ${edit?.id === x.id ? "on" : ""}`}>
      <button className="date-pick-row" onClick={() => setEdit({ id: x.id, f: formOf(x) })} title="Поправить или удалить">
        <span className="time">{shortDay(x.on)}</span>
        <span className="grow">
          {x.type === "birthday" ? "🎂 " : ""}{x.title}
          {ageText(x) && <span className="muted small"> · {ageText(x)}</span>}
          <span className="muted small"> · {humanDay(x.on, true).split(", ")[1]}</span>
        </span>
        <Chip tone={x.inDays <= 7 ? "accent" : ""}>{dateWhen(x.inDays)}</Chip>
      </button>
    </li>
  );

  return (
    <div className="dates-tab">
      <div className="dates-top">
        <p className="muted small">Дни рождения, годовщины, праздники. Горничная напомнит заранее — в утреннем списке и в виджете.</p>
        <button className="btn" onClick={() => setEdit({ id: 0, f: formOf(null) })} disabled={edit?.id === 0}>+ Дата</button>
      </div>
      {note && (
        <div className={`task-note ${note.bad ? "bad" : ""}`} role="status">
          <span className="grow">{note.text}</span>
          {note.undo !== undefined && <button className="link" onClick={() => undo(note.undo!)}>↩ Отменить</button>}
        </div>
      )}
      {edit && (
        <Card title={edit.id ? "Поправить дату" : "Новая дата"} className="reveal date-form-card">
          <form ref={formRef} className="date-form" onSubmit={save} onKeyDown={(e) => e.key === "Escape" && setEdit(null)}>
            <label className="df-title">Что за дата
              <input value={edit.f.title} maxLength={200} placeholder="День рождения мамы" onChange={(e) => set({ title: e.target.value })} />
            </label>
            <label>День
              <input type="number" min={1} max={31} value={edit.f.day} onChange={(e) => set({ day: Math.max(1, Math.min(31, Number(e.target.value) || 1)) })} />
            </label>
            <label>Месяц
              <select value={edit.f.month} onChange={(e) => set({ month: Number(e.target.value) })}>
                {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
              </select>
            </label>
            <label>Год
              <input inputMode="numeric" maxLength={4} value={edit.f.year} placeholder="если знаете" aria-invalid={!yearOk}
                title="Год рождения или начала — тогда будет видно, сколько исполнится" onChange={(e) => set({ year: e.target.value.replace(/\D/g, "") })} />
            </label>
            <label>Вид
              <select value={edit.f.type} onChange={(e) => set({ type: e.target.value, yearly: e.target.value === "deadline" ? false : edit.f.yearly })}>
                {DATE_TYPES.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
              </select>
            </label>
            <label className="row df-yearly"><input type="checkbox" checked={edit.f.yearly} onChange={(e) => set({ yearly: e.target.checked })} /> Каждый год</label>
            <div className="row df-actions">
              <button type="submit" className="primary" disabled={busy || !edit.f.title.trim() || !yearOk}>{edit.id ? "Сохранить" : "Добавить"}</button>
              <button type="button" className="ghost" onClick={() => setEdit(null)}>Отмена</button>
              {edit.id > 0 && <><span className="spacer" /><button type="button" className="ghost danger" disabled={busy} onClick={remove}>Удалить</button></>}
            </div>
          </form>
        </Card>
      )}
      <div className="cards">
        <Card title={`Скоро · ${soon.length}`} className="reveal wide">
          {soon.length ? <ul className="list dates">{soon.map(row)}</ul> : <Empty>В ближайший месяц дат нет</Empty>}
        </Card>
        {months.length > 0 && (
          <Card title="Дальше" className="reveal wide">
            <ul className="list dates">
              {months.map((m) => [<li key={m.key} className="dates-month">{m.title}</li>, ...m.items.map(row)])}
            </ul>
          </Card>
        )}
        {!dates.length && <Empty>Дат нет. Нажмите «+ Дата» или напишите горничной: «день рождения мамы 3 мая»</Empty>}
      </div>
    </div>
  );
}
