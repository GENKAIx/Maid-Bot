import { useEffect, useState } from "react";
import { get, post } from "../api";
import { Empty, Spinner } from "../components";
import { MONTHS_GEN, shortDay } from "../format";
import { Icon } from "../icons";
import { deletedWhen, leftText, soon, soonest, soonestText, trashLeft } from "../trash";
import type { EventRow, NoteRow, TaskRow } from "../types";

// Корзина (27.11.2026 — дизайн v2, docs/design/дизайн-v2-2026-11-27.html, «Настройки → Корзина»): сверху — сколько записей
// и сколько дней хранится, «Очистить всё»; строка Рины — о записи, что сотрётся через 3 дня или раньше; ниже группы
// Планы, Задачи, Заметки, Даты (пустые не показываются). В строке — что и когда удалено, «удалится через N дней» с полоской
// срока (красной, если осталось 3 дня или меньше), «Вернуть» и «✕» — удалить навсегда (после вопроса «точно?»).
// «Вернуть» — задача снова открыта, план снова в планах; то же, что «верни … из корзины» словами. Сервер держит удалённое TRASH_DAYS дней.

type Trash = {
  days: number;
  tasks: (TaskRow & { closed_at: string | null })[];
  events: (EventRow & { updated_at: string })[];
  notes: NoteRow[];
  dates?: { id: number; title: string; date_iso: string; closed_at: string | null }[];
};
type Kind = "task" | "event" | "note" | "date";
type Item = { kind: Kind; id: number; title: string; sub: string; at: string | null };

const GROUPS: [Kind, string, string][] = [["event", "Планы", "plans"], ["task", "Задачи", "habits"], ["note", "Заметки", "notes"], ["date", "Даты", "plans"]];

export function Trash({ version, onChanged }: { version: number; onChanged: () => void }) {
  const [trash, setTrash] = useState<Trash | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  useEffect(() => {
    let alive = true;
    get<Trash>("/api/trash").then((t) => alive && setTrash(t)).catch((e) => alive && setError((e as Error).message));
    return () => { alive = false; };
  }, [version]);

  async function restore(kind: Kind, id: number) {
    setBusy(`${kind}${id}`);
    try {
      if (kind === "task") await post(`/api/tasks/${id}`, { status: "open" });
      else if (kind === "note") await post(`/api/notes/${id}`, { status: "open" });
      else if (kind === "date") await post(`/api/dates/${id}`, { status: "active" });
      else await post(`/api/events/${id}`, { status: "active" });
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function purge(body: { all: true } | { tasks: number[] } | { events: number[] } | { notes: number[] } | { dates: number[] }, ask: string, key: string) {
    if (!confirm(ask)) return;
    setBusy(key);
    try {
      await post("/api/trash/purge", body);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  if (error) return <Empty>Нет связи: {error}</Empty>;
  if (!trash) return <Spinner />;

  const items: Item[] = [
    ...trash.events.map((e): Item => ({ kind: "event", id: e.id, at: e.updated_at,
      title: `${e.title}${e.time ? `, ${e.time}` : ""}`,
      sub: `план на ${shortDay(e.date_iso)} · ${e.status === "deleted" ? "удалён" : "отменён"} ${deletedWhen(e.updated_at)}` })),
    ...trash.tasks.map((t): Item => ({ kind: "task", id: t.id, at: t.closed_at, title: t.title,
      sub: `задача${t.due_date ? ` до ${shortDay(t.due_date)}` : ""} · ${t.status === "deleted" ? "удалена" : "отменена"} ${deletedWhen(t.closed_at)}` })),
    ...trash.notes.map((n): Item => ({ kind: "note", id: n.id, at: n.closed_at, title: n.title,
      sub: `заметка${n.note ? ` · ${n.note}` : ""} · удалена ${deletedWhen(n.closed_at)}` })),
    ...(trash.dates ?? []).map((d): Item => ({ kind: "date", id: d.id, at: d.closed_at, title: d.title,
      sub: `дата ${Number(d.date_iso.slice(8, 10))} ${MONTHS_GEN[Number(d.date_iso.slice(5, 7)) - 1]} · удалена ${deletedWhen(d.closed_at)}` })),
  ];
  const total = items.length;
  const urgent = soonest(items, trash.days);

  const row = (x: Item) => {
    const l = trashLeft(x.at, trash.days);
    const key = `${x.kind}${x.id}`;
    const body = x.kind === "task" ? { tasks: [x.id] } : x.kind === "note" ? { notes: [x.id] } : x.kind === "date" ? { dates: [x.id] } : { events: [x.id] };
    return (
      <div key={key} className="trash-row">
        <span className="trash-ico"><Icon name={GROUPS.find((g) => g[0] === x.kind)![2]} size={18} /></span>
        <div className="trash-text"><b>{x.title}</b><span>{x.sub}</span></div>
        {l && (
          <div className={`trash-left${soon(l.n) ? " soon" : ""}`}>
            <span>{leftText(l.n)}</span>
            <div className="trash-line" role="meter" aria-label={leftText(l.n)} aria-valuemin={0} aria-valuemax={trash.days} aria-valuenow={l.n}>
              <i style={{ width: `${Math.round(l.part * 100)}%` }} />
            </div>
          </div>
        )}
        <div className="trash-acts">
          <button disabled={busy === key} onClick={() => void restore(x.kind, x.id)}>Вернуть</button>
          <button className="ghost trash-forever" disabled={busy === key} title="Удалить навсегда" aria-label={`Удалить навсегда: ${x.title}`}
            onClick={() => void purge(body, `Удалить «${x.title}» навсегда? Вернуть будет нельзя.`, key)}>✕</button>
        </div>
      </div>
    );
  };

  return (
    <div className="screen trash">
      <div className="trash-top">
        <div>
          <p className="trash-count"><b className="num">{total}</b> {total ? "в корзине" : "— корзина пуста"}</p>
          <p className="muted small">Удалённое и отменённое хранится {trash.days} дней, потом стирается само.</p>
        </div>
        {total > 0 && (
          <button className="trash-clear" disabled={busy === "all"}
            onClick={() => void purge({ all: true }, `Очистить корзину? ${total} — навсегда, вернуть будет нельзя.`, "all")}>Очистить всё</button>
        )}
      </div>
      {urgent && (
        <div className="trash-say">
          <img src="/maid/idle.webp" alt="" width={56} height={56} />
          <p>«{urgent.title}» <b>{soonestText(urgent.n)}</b>. Если ещё нужно — верните.</p>
        </div>
      )}
      {GROUPS.map(([kind, title]) => {
        const list = items.filter((x) => x.kind === kind);
        return list.length > 0 && (
          <section key={kind} className="card trash-group reveal">
            <h3>{title} · {list.length}</h3>
            {list.map(row)}
          </section>
        );
      })}
    </div>
  );
}
