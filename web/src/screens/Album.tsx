import { useEffect, useState } from "react";
import { get } from "../api";
import { ALBUM_CARDS, albumCount } from "../album";
import { Empty, Spinner } from "../components";
import { humanDay, todayKey } from "../format";

// Альбом реакций: 27 анимаций горничной. Те, что уже показал виджет на ПК, открыты; остальные — силуэты: щелчок по силуэту
// показывает подсказку, как увидеть. Отметки шлёт виджет (desktop/renderer/album.js → /api/album), сайт только читает.

type Album = { seen: Record<string, string>; total: number };

export function Album({ version }: { version: number }) {
  const [album, setAlbum] = useState<Album | null>(null);
  const [error, setError] = useState("");
  const [picked, setPicked] = useState("");

  useEffect(() => {
    let alive = true;
    get<Album>("/api/album").then((a) => alive && setAlbum(a)).catch((e) => alive && setError((e as Error).message));
    return () => { alive = false; };
  }, [version]);

  if (error) return <Empty>Нет связи: {error}</Empty>;
  if (!album) return <Spinner />;

  const open = albumCount(album.seen);
  const all = ALBUM_CARDS.length;
  // Пока ничего не выбрано — показываем последнюю открытую, а в пустом альбоме — первую карточку с подсказкой.
  const last = ALBUM_CARDS.filter((c) => album.seen[c.id]).sort((a, b) => album.seen[b.id].localeCompare(album.seen[a.id]))[0];
  const card = ALBUM_CARDS.find((c) => c.id === picked) ?? last ?? ALBUM_CARDS[0];
  const seenAt = album.seen[card.id];

  return (
    <div className="alb">
      <header className="alb-head">
        <div>
          <h2 className="screen-title">Альбом</h2>
          <p className="alb-lead">Реакции горничной. Карточка открывается, когда вы впервые видите анимацию в программе на ПК.</p>
        </div>
        <div className="alb-count" aria-label={`Открыто ${open} из ${all}`}>
          <b>{open}</b><span>из {all}</span>
          <i><i style={{ width: `${(open / all) * 100}%` }} /></i>
        </div>
      </header>

      <section className={`alb-show ${seenAt ? "" : "lock"}`} aria-live="polite">
        <img key={card.id} src={`/maid/${card.id}.webp`} alt="" width={150} height={160} />
        <div>
          <h3>{seenAt ? card.name : "Ещё не открыта"}</h3>
          <p>{seenAt ? card.about : card.hint}</p>
          {seenAt
            ? <small>Впервые — {humanDay(todayKey(new Date(seenAt)))}</small>
            : <small>Это подсказка. Сделайте так в программе на ПК — карточка откроется сама.</small>}
        </div>
      </section>

      <div className="alb-grid">
        {ALBUM_CARDS.map((c) => {
          const seen = Boolean(album.seen[c.id]);
          return (
            <button key={c.id} className={`alb-card ${seen ? "" : "lock"} ${c.id === card.id ? "on" : ""}`} onClick={() => setPicked(c.id)}
              aria-label={seen ? c.name : "Не открыта — показать подсказку"}>
              <img src={`/maid/${c.id}.webp`} alt="" width={84} height={90} loading="lazy" />
              <span>{seen ? c.name : "?"}</span>
            </button>
          );
        })}
      </div>
      {open === all && <p className="alb-done">Альбом собран целиком.</p>}
    </div>
  );
}
