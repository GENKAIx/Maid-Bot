import { useEffect, useRef, useState } from "react";
import { get } from "../api";
import { Empty, Spinner } from "../components";
import { humanDay, plainReply, todayKey } from "../format";
import { byDay, HISTORY_FILTERS, KIND_NAMES, type HistoryItem } from "../history";

// История: всё, что горничная присылала сама — утро, «что завтра», итог дня, напоминания о планах и привычках, даты,
// замечания про игры, наблюдения. Свежее сверху, по дням; сверху отбор по виду письма. Сервер хранит последнюю тысячу
// (GET /api/history, server/src/notices.ts), «Показать ещё» догружает старше.

type Page = { items: HistoryItem[]; more: boolean };
const PAGE = 50;
/** Письмо длиннее — свёрнуто до «Показать целиком» (утренний список, итог дня). */
const LONG = 320;

/** start — отбор из адреса (/history/daily): так виджет открывает «Прочитать все письма». */
export function History({ version, filter: start }: { version: number; filter?: string }) {
  const [filter, setFilter] = useState(HISTORY_FILTERS.some((f) => f.id === start) ? start! : "all");
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Record<number, boolean>>({});

  const kinds = HISTORY_FILTERS.find((f) => f.id === filter)?.kinds ?? [];
  const url = (before = 0) => `/api/history?limit=${PAGE}${kinds.length ? `&kinds=${kinds.join(",")}` : ""}${before ? `&before=${before}` : ""}`;

  // Сменили отбор — лента с начала. Вернулись на вкладку или что-то записали (version) — тихо перечитать первую страницу;
  // если уже листали дальше, ленту не трогаем: иначе догруженное пропало бы из-под рук.
  const shown = useRef({ filter: "", pages: 1 });
  useEffect(() => {
    const fresh = shown.current.filter !== filter;
    if (!fresh && shown.current.pages > 1) return;
    if (fresh) setPage(null);
    shown.current = { filter, pages: 1 };
    let alive = true;
    get<Page>(url()).then((p) => alive && setPage(p)).catch((e) => alive && setError((e as Error).message));
    return () => { alive = false; };
  }, [filter, version]);

  async function more() {
    if (!page?.items.length) return;
    setBusy(true);
    try {
      const next = await get<Page>(url(page.items.at(-1)!.id));
      shown.current.pages++;
      setPage({ items: [...page.items, ...next.items], more: next.more });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const time = (iso: string) => new Date(iso).toTimeString().slice(0, 5);

  return (
    <div className="hist">
      <header>
        <h2 className="screen-title">История</h2>
        <p className="hist-lead">Письма от горничной: утро, итоги, напоминания. Свежие сверху.</p>
      </header>
      <div className="hist-filters" role="group" aria-label="Какие письма показывать">
        {HISTORY_FILTERS.map((f) => (
          <button key={f.id} className={`chip-btn ${f.id === filter ? "on" : ""}`} aria-pressed={f.id === filter} onClick={() => setFilter(f.id)}>{f.title}</button>
        ))}
      </div>

      {error ? <Empty>Нет связи: {error}</Empty>
        : !page ? <Spinner />
        : !page.items.length ? <Empty>{filter === "all" ? "Писем пока нет. Первое придёт утром." : "Таких писем пока нет."}</Empty>
        : (
          <>
            {byDay(page.items, (iso) => todayKey(new Date(iso))).map((d) => (
              <section key={d.day} className="hist-day">
                <h3>{humanDay(d.day)}</h3>
                <ul>
                  {d.items.map((it) => {
                    const text = plainReply(it.text);
                    const long = text.length > LONG && !open[it.id];
                    return (
                      <li key={it.id} className="hist-item">
                        <time dateTime={it.at}>{time(it.at)}</time>
                        <div>
                          <span className={`hist-kind k-${it.kind}`}>{KIND_NAMES[it.kind] ?? KIND_NAMES.other}</span>
                          <p>{long ? `${text.slice(0, LONG).replace(/\s+\S*$/, "")}…` : text}</p>
                          {text.length > LONG && (
                            <button className="link" onClick={() => setOpen({ ...open, [it.id]: !open[it.id] })}>{open[it.id] ? "Свернуть" : "Показать целиком"}</button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
            {page.more && <button className="hist-more" disabled={busy} onClick={more}>{busy ? "Загружаю…" : "Показать ещё"}</button>}
          </>
        )}
    </div>
  );
}
