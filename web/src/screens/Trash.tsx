import { useEffect, useState } from "react";
import { get, post } from "../api";
import { Card, Chip, Empty, Spinner } from "../components";
import { shortDay, todayKey } from "../format";
import type { EventRow, TaskRow } from "../types";

// Корзина: удалённые и отменённые задачи и планы за последние дни (сервер держит их TRASH_DAYS дней). «Вернуть» —
// задача снова открыта, план снова в планах; то же, что «верни … из корзины» словами. «✕» — удалить навсегда,
// «Очистить корзину» — всё сразу (после вопроса «точно?»); вернуть такое уже нельзя.

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

/** Сколько ещё пролежит в корзине: «ещё 13 дней», «до завтра», «последний день». */
function left(iso: string | null, days: number) {
  if (!iso) return "";
  const n = Math.ceil((new Date(iso).getTime() + days * 86_400_000 - Date.now()) / 86_400_000);
  if (n <= 1) return "последний день";
  if (n === 2) return "ещё 2 дня";
  const w = n % 10 === 1 && n % 100 !== 11 ? "день" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? "дня" : "дней";
  return `ещё ${n} ${w}`;
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

  async function purge(body: { all: true } | { tasks: number[] } | { events: number[] }, ask: string, key: string) {
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
  // Меньше 3 дней до исчезновения — красным.
  const stays = (iso: string | null) => (iso && new Date(iso).getTime() + (trash.days - 3) * 86_400_000 < Date.now() ? "bad" : "");
  const back = (kind: "task" | "event", id: number) => (
    <button className="link" disabled={busy === `${kind}${id}`} onClick={() => restore(kind, id)}>↩ Вернуть</button>
  );
  const gone = (kind: "task" | "event", id: number, title: string) => (
    <button className="link forever" disabled={busy === `${kind}${id}`} title="Удалить навсегда" aria-label={`Удалить навсегда: ${title}`}
      onClick={() => purge(kind === "task" ? { tasks: [id] } : { events: [id] }, `Удалить «${title}» навсегда? Вернуть будет нельзя.`, `${kind}${id}`)}>✕</button>
  );
  const total = trash.tasks.length + trash.events.length;

  return (
    <div className="screen">
      <h2 className="screen-title">Корзина</h2>
      <div className="trash-top">
        <p className="muted small trash-note">Удалённое и отменённое лежит здесь {trash.days} дней — справа видно, сколько ещё осталось, потом пропадёт.</p>
        {total > 0 && (
          <button className="ghost" disabled={busy === "all"}
            onClick={() => purge({ all: true }, `Очистить корзину? ${total} — навсегда, вернуть будет нельзя.`, "all")}>Очистить корзину</button>
        )}
      </div>
      <div className="cards">
        <Card title={`Задачи · ${trash.tasks.length}`} className="reveal wide">
          {trash.tasks.length ? (
            <ul className="list trash">
              {trash.tasks.map((t) => (
                <li key={t.id}>
                  <span className="grow">{t.title}{t.due_date && <span className="muted small"> · до {shortDay(t.due_date)}</span>}</span>
                  <span className="muted small">{t.status === "deleted" ? "удалена" : "отменена"} {when(t.closed_at)}</span>
                  <Chip tone={stays(t.closed_at)}>{left(t.closed_at, trash.days)}</Chip>
                  {back("task", t.id)}
                  {gone("task", t.id, t.title)}
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
                  <Chip tone={stays(e.updated_at)}>{left(e.updated_at, trash.days)}</Chip>
                  {back("event", e.id)}
                  {gone("event", e.id, e.title)}
                </li>
              ))}
            </ul>
          ) : <Empty>Удалённых планов нет</Empty>}
        </Card>
      </div>
    </div>
  );
}
