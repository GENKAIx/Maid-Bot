import { useEffect, useState } from "react";
import { get, post } from "../api";
import { Card, Empty, Spinner } from "../components";
import { shortDay, todayKey } from "../format";
import type { EventRow, TaskRow } from "../types";

// Корзина: удалённые и отменённые задачи и планы за последние дни (сервер держит их TRASH_DAYS дней). «Вернуть» —
// задача снова открыта, план снова в планах; то же, что «верни … из корзины» словами.

type Trash = {
  days: number;
  tasks: (TaskRow & { closed_at: string | null })[];
  events: (EventRow & { updated_at: string })[];
};

/** Когда удалено: «сегодня 14:05», «вчера», «8 ноя». */
function when(iso: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const ago = Math.round((day(new Date()) - day(d)) / 86_400_000);
  if (ago === 0) return `сегодня ${d.toTimeString().slice(0, 5)}`;
  if (ago === 1) return "вчера";
  return shortDay(todayKey(d));
}

export function Trash({ version, onChanged }: { version: number; onChanged: () => void }) {
  const [trash, setTrash] = useState<Trash | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  useEffect(() => {
    let alive = true;
    get<Trash>("/api/trash").then((t) => alive && setTrash(t)).catch((e) => alive && setError((e as Error).message));
    return () => { alive = false; };
  }, [version]);

  async function restore(kind: "task" | "event", id: number) {
    setBusy(`${kind}${id}`);
    try {
      if (kind === "task") await post(`/api/tasks/${id}`, { status: "open" });
      else await post(`/api/events/${id}`, { status: "active" });
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  if (error) return <Empty>Нет связи: {error}</Empty>;
  if (!trash) return <Spinner />;
  const back = (kind: "task" | "event", id: number) => (
    <button className="link" disabled={busy === `${kind}${id}`} onClick={() => restore(kind, id)}>↩ Вернуть</button>
  );

  return (
    <div className="screen">
      <h2 className="screen-title">Корзина</h2>
      <p className="muted small trash-note">Удалённое и отменённое хранится {trash.days} дней, потом пропадает из корзины.</p>
      <div className="cards">
        <Card title={`Задачи · ${trash.tasks.length}`} className="reveal wide">
          {trash.tasks.length ? (
            <ul className="list trash">
              {trash.tasks.map((t) => (
                <li key={t.id}>
                  <span className="grow">{t.title}{t.due_date && <span className="muted small"> · до {shortDay(t.due_date)}</span>}</span>
                  <span className="muted small">{t.status === "deleted" ? "удалена" : "отменена"} {when(t.closed_at)}</span>
                  {back("task", t.id)}
                </li>
              ))}
            </ul>
          ) : <Empty>Удалённых задач нет</Empty>}
        </Card>
        <Card title={`Планы · ${trash.events.length}`} className="reveal wide">
          {trash.events.length ? (
            <ul className="list trash">
              {trash.events.map((e) => (
                <li key={e.id}>
                  <span className="time">{shortDay(e.date_iso)}</span>
                  <span className="grow">{e.title}{e.time && <span className="muted small"> · {e.time}</span>}</span>
                  <span className="muted small">{e.status === "deleted" ? "удалён" : "отменён"} {when(e.updated_at)}</span>
                  {back("event", e.id)}
                </li>
              ))}
            </ul>
          ) : <Empty>Удалённых планов нет</Empty>}
        </Card>
      </div>
    </div>
  );
}
