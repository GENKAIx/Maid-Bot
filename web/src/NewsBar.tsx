import { useEffect, useState } from "react";
import { get } from "./api";
import { closedNews, closeNews, visibleNews, type News } from "./announce";

// Плашка объявлений владельца над экраном (этап 6, web/src/announce.ts). Нет объявлений или не загрузились — ничего не рисует.

export function NewsBar() {
  const [items, setItems] = useState<News[]>([]);
  useEffect(() => {
    let alive = true;
    get<News[]>("/api/announcements").then((r) => alive && Array.isArray(r) && setItems(visibleNews(r, closedNews()))).catch(() => {});
    return () => { alive = false; };
  }, []);
  return <NewsList items={items} onClose={(id) => { closeNews(id); setItems((x) => x.filter((n) => n.id !== id)); }} />;
}

export function NewsList({ items, onClose }: { items: News[]; onClose: (id: number) => void }) {
  if (!items.length) return null;
  return (
    <div className="news-bars">
      {items.map((n) => (
        <div key={n.id} className="news-bar" role="status">
          <span className="grow">{n.text}</span>
          <button className="ghost news-x" aria-label="Закрыть объявление" onClick={() => onClose(n.id)}>✕</button>
        </div>
      ))}
    </div>
  );
}
