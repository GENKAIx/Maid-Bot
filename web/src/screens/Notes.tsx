import { useEffect, useRef, useState } from "react";
import { get, post } from "../api";
import { Chip, Empty, Spinner } from "../components";
import { noteAge, randomNote, shelfCounts, shownNotes } from "../notes";
import type { NoteRow, NoteShelf } from "../types";

// Заметки «на потом»: что посмотреть, во что поиграть, что почитать, идеи. Полки — кнопками сверху; запись строкой здесь или
// словами горничной («фильм Дюна 2»). Кружок — «готово»: у фильмов, сериалов, игр и книг спросит оценку 1–10 (можно без неё).
// «Случайное» выбирает одну из ждущих на выбранной полке. Удалённое лежит в «Корзине».

type Data = { shelves: NoteShelf[]; notes: NoteRow[] };
type Undo = { text: string; id?: number; bad?: boolean };
const RATES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const SHELF_KEY = "maid.notes.shelf";

export function Notes({ version, onChanged }: { version: number; onChanged: () => void }) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [shelf, setShelf] = useState(() => { try { return localStorage.getItem(SHELF_KEY) || "all"; } catch { return "all"; } });
  const [query, setQuery] = useState("");
  const [title, setTitle] = useState("");
  const [rating, setRating] = useState<number | null>(null); // у какой заметки спрашиваем оценку
  const [lucky, setLucky] = useState<number | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [note, setNote] = useState<Undo | null>(null);
  const [busy, setBusy] = useState(false);
  const luckyRow = useRef<HTMLLIElement>(null);

  useEffect(() => {
    let alive = true;
    get<Data>("/api/notes").then((d) => alive && setData(d)).catch((e) => alive && setError((e as Error).message));
    return () => { alive = false; };
  }, [version]);
  useEffect(() => { try { localStorage.setItem(SHELF_KEY, shelf); } catch { /* без памяти вкладки */ } }, [shelf]);
  useEffect(() => { luckyRow.current?.scrollIntoView({ block: "center", behavior: "smooth" }); }, [lucky]);
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 8000);
    return () => clearTimeout(t);
  }, [note]);

  if (error) return <Empty>Нет связи: {error}</Empty>;
  if (!data) return <Spinner />;

  const shelves = data.shelves;
  const titleOf = (key: string) => shelves.find((s) => s.key === key)?.title ?? key;
  const current = shelves.some((s) => s.key === shelf) ? shelf : "all";
  const counts = shelfCounts(data.notes);
  const shown = shownNotes(data.notes, current, query);
  const open = shown.filter((n) => n.status === "open");
  const done = shown.filter((n) => n.status === "done");
  const target = current === "all" ? "other" : current;

  async function change(n: NoteRow, body: Record<string, unknown>, said?: string) {
    setBusy(true);
    try {
      await post(`/api/notes/${n.id}`, body);
      setRating(null);
      if (said) setNote({ text: said, id: n.id });
      onChanged();
    } catch (e) {
      setNote({ text: (e as Error).message, bad: true });
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    const text = title.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      const made = await post<NoteRow & { duplicate?: boolean }>("/api/notes", { title: text, shelf: target });
      setTitle("");
      if (made.duplicate) setNote({ text: `«${made.title}» уже лежит на полке «${titleOf(made.shelf)}»` });
      setLucky(null);
      onChanged();
    } catch (e) {
      setNote({ text: (e as Error).message, bad: true });
    } finally {
      setBusy(false);
    }
  }

  const finish = (n: NoteRow) => (shelves.find((s) => s.key === n.shelf)?.rated ? setRating(rating === n.id ? null : n.id) : change(n, { status: "done" }, `Готово: ${n.title}`));

  return (
    <div className="screen notes">
      <h2 className="screen-title">Заметки</h2>
      <p className="muted small notes-lead">Что посмотреть, во что поиграть, что почитать и идеи. Можно сказать горничной: «фильм Дюна 2» — она положит на полку сама.</p>

      <div className="notes-shelves" role="group" aria-label="Полка">
        {[{ key: "all", title: "Все" }, ...shelves].map((s) => (
          <button key={s.key} className={`chip-btn ${s.key === current ? "on" : ""}`} aria-pressed={s.key === current}
            onClick={() => { setShelf(s.key); setRating(null); setLucky(null); }}>
            {s.title}{counts[s.key] ? <span className="notes-count"> {counts[s.key]}</span> : null}
          </button>
        ))}
      </div>

      <div className="notes-tools">
        <form className="task-new notes-new" onSubmit={(e) => { e.preventDefault(); add(); }}>
          <span className="muted" aria-hidden="true">＋</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} aria-label={`Новая заметка на полку «${titleOf(target)}»`}
            placeholder={current === "all" ? "Новая заметка — ляжет в «Прочее»" : `Записать на полку «${titleOf(target)}»`} />
          {title.trim() && <button className="link notes-add" disabled={busy}>Записать</button>}
        </form>
        <input className="notes-find" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Найти в заметках" aria-label="Найти в заметках" />
        <button disabled={!open.length} onClick={() => { const n = randomNote(open, lucky); setLucky(n?.id ?? null); setRating(null); }}
          title="Выбрать одну из ждущих на этой полке">Случайное</button>
      </div>

      {note && (
        <div className={`task-note ${note.bad ? "bad" : ""}`} role="status">
          <span className="grow">{note.text}</span>
          {note.id && <button className="link" onClick={() => { const id = note.id; setNote(null); post(`/api/notes/${id}`, { status: "open" }).then(onChanged).catch((e) => setNote({ text: (e as Error).message, bad: true })); }}>↩ Вернуть</button>}
        </div>
      )}

      <section className="card notes-card reveal">
        {open.length ? (
          <ul className="list task-list notes-list">
            {open.map((n) => (
              <li key={n.id} ref={n.id === lucky ? luckyRow : undefined} className={`notes-row ${n.id === lucky ? "lucky" : ""}`}>
                <button className="check" onClick={() => finish(n)} disabled={busy} aria-label={`Готово: ${n.title}`} title="Готово" />
                <span className="grow notes-title">{n.title}{n.note && <span className="muted small"> · {n.note}</span>}</span>
                {n.id === lucky && <Chip tone="accent">выпало</Chip>}
                <span className="muted small notes-age" title={`Записано ${new Date(n.created_at).toLocaleDateString("ru-RU")}`}>{noteAge(n.created_at)}</span>
                <select className="notes-move" value={n.shelf} disabled={busy} aria-label={`Полка заметки «${n.title}»`} title="Переложить на другую полку"
                  onChange={(e) => change(n, { shelf: e.target.value })}>
                  {shelves.map((s) => <option key={s.key} value={s.key}>{s.title}</option>)}
                </select>
                <button className="link forever" disabled={busy} title="Удалить — в корзину" aria-label={`Удалить: ${n.title}`}
                  onClick={() => change(n, { status: "deleted" }, `Удалено: ${n.title}`)}>✕</button>
                {rating === n.id && (
                  <div className="notes-rate" role="group" aria-label={`Оценка: ${n.title}`}>
                    <span className="muted small">Как вам?</span>
                    {RATES.map((r) => (
                      <button key={r} className="notes-rate-btn" disabled={busy} onClick={() => change(n, { status: "done", rating: r }, `Готово: ${n.title} · ${r}/10`)}>{r}</button>
                    ))}
                    <button className="link" disabled={busy} onClick={() => change(n, { status: "done" }, `Готово: ${n.title}`)}>без оценки</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <Empty>{query.trim() ? `Ничего не нашлось по «${query.trim()}»` : current === "all" ? "Заметок пока нет. Запишите первую строкой выше или скажите горничной: «поиграть в Hades»." : `На полке «${titleOf(current)}» пусто.`}</Empty>
        )}
      </section>

      {done.length > 0 && (
        <section className="card notes-card notes-done reveal">
          <header className="card-head">
            <h3>Готово · {done.length}</h3>
            <button className="link" onClick={() => setShowDone(!showDone)} aria-expanded={showDone}>{showDone ? "свернуть" : "показать"}</button>
          </header>
          {showDone && (
            <ul className="list task-list notes-list">
              {done.map((n) => (
                <li key={n.id} className="notes-row closed">
                  <span className="grow notes-title">{n.title}{n.note && <span className="muted small"> · {n.note}</span>}</span>
                  {current === "all" && <Chip>{titleOf(n.shelf)}</Chip>}
                  {n.rating ? <Chip tone={n.rating >= 8 ? "good" : n.rating <= 4 ? "bad" : ""}><b>{n.rating}</b>/10</Chip> : null}
                  <button className="link" disabled={busy} onClick={() => change(n, { status: "open" })}>↩ на полку</button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
