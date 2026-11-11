import { useEffect, useRef, useState } from "react";
import { get } from "../api";
import { Card, Chip, Empty, Spinner } from "../components";
import { shortDay, todayKey } from "../format";
import { navigate } from "../router";
import type { EventRow, TaskRow } from "../types";

// Поиск по задачам и планам (GET /api/search): все слова запроса — в названии или заметках, без учёта регистра и «ё».
// Находит и то, что лежит в корзине («в корзине» → экран «Корзина»). Запрос — в адресе: /search/<запрос>; Ctrl+K или «/» — сюда.

type Hit = { bin: "" | "trash" };
type Found = { tasks: (TaskRow & Hit)[]; events: (EventRow & Hit)[] };

const TASK_STATUS: Record<string, [string, string]> = {
  open: ["открыта", "good"], done: ["сделана", ""], failed: ["не буду", ""], dodged: ["без ответа", ""], planned: ["стала планом", ""],
  cancelled: ["отменена", ""], deleted: ["удалена", ""],
};

/** Совпадения в названии — подсветкой. */
function Marked({ text, words }: { text: string; words: string[] }) {
  const low = text.toLowerCase().replace(/ё/g, "е");
  const on = new Array<boolean>(text.length).fill(false);
  for (const w of words) for (let i = low.indexOf(w); i >= 0; i = low.indexOf(w, i + 1)) on.fill(true, i, i + w.length);
  const parts: { s: string; on: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    if (parts.length && parts[parts.length - 1].on === on[i]) parts[parts.length - 1].s += text[i];
    else parts.push({ s: text[i], on: on[i] });
  }
  return <>{parts.map((p, i) => (p.on ? <mark key={i}>{p.s}</mark> : <span key={i}>{p.s}</span>))}</>;
}

export function Search({ query, version }: { query?: string; version: number }) {
  const [q, setQ] = useState(() => (query ? decodeURIComponent(query) : ""));
  const [found, setFound] = useState<Found | null>(null);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const words = q.toLowerCase().replace(/ё/g, "е").split(/\s+/).filter(Boolean);

  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    const text = q.trim();
    navigate(text ? `/search/${encodeURIComponent(text)}` : "/search", true);
    if (!text) return setFound(null);
    let alive = true;
    const t = setTimeout(() => {
      get<Found>(`/api/search?q=${encodeURIComponent(text)}`)
        .then((r) => { if (alive) { setFound(r); setError(""); } })
        .catch((e) => alive && setError((e as Error).message));
    }, 220);
    return () => { alive = false; clearTimeout(t); };
  }, [q, version]);

  const today = todayKey();
  const trashChip = (
    <button className="link" onClick={() => navigate("/trash")} title="Открыть корзину — там можно вернуть"><Chip tone="bad">в корзине</Chip></button>
  );

  return (
    <div className="screen">
      <h2 className="screen-title">Поиск</h2>
      <div className="search-box">
        <input ref={input} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Что найти: «врач», «купить», «отчёт»…"
          aria-label="Поиск по задачам и планам" onKeyDown={(e) => e.key === "Escape" && setQ("")} />
      </div>
      {error ? <Empty>Нет связи: {error}</Empty>
        : !q.trim() ? <p className="muted small search-hint">Ищет по названиям и заметкам задач и планов — и в корзине тоже. Ctrl+K или «/» — открыть поиск с любого экрана.</p>
        : !found ? <Spinner />
        : !found.tasks.length && !found.events.length ? <Empty>Ничего не нашлось по «{q.trim()}»</Empty>
        : (
          <div className="cards">
            {found.tasks.length > 0 && (
              <Card title={`Задачи · ${found.tasks.length}`} className="reveal wide">
                <ul className="list search">
                  {found.tasks.map((t) => {
                    const [label, tone] = TASK_STATUS[t.status] ?? [t.status, ""];
                    return (
                      <li key={t.id} className={t.status === "open" ? "" : "closed"}>
                        <span className="grow"><Marked text={t.title} words={words} />
                          {t.due_date && <span className="muted small"> · до {shortDay(t.due_date)}</span>}
                          {t.notes && <span className="muted small note"><Marked text={t.notes} words={words} /></span>}
                        </span>
                        {t.bin === "trash" ? trashChip : <Chip tone={tone}>{label}</Chip>}
                      </li>
                    );
                  })}
                </ul>
              </Card>
            )}
            {found.events.length > 0 && (
              <Card title={`Планы · ${found.events.length}`} className="reveal wide">
                <ul className="list search">
                  {found.events.map((e) => (
                    <li key={e.id} className={e.status === "active" && e.date_iso >= today ? "" : "closed"}>
                      <span className="time">{shortDay(e.date_iso)}</span>
                      <span className="grow"><Marked text={e.title} words={words} />
                        {e.time && <span className="muted small"> · {e.time}</span>}
                        {e.details && <span className="muted small note"><Marked text={e.details} words={words} /></span>}
                      </span>
                      {e.bin === "trash" ? trashChip
                        : e.status !== "active" ? <Chip>{e.status === "cancelled" ? "отменён" : e.status}</Chip>
                        : e.date_iso === today ? <Chip tone="good">сегодня</Chip>
                        : e.date_iso < today ? <Chip>прошёл</Chip> : null}
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </div>
        )}
    </div>
  );
}
