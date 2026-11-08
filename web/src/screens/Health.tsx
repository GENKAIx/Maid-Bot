import { useEffect, useState } from "react";
import { get } from "../api";
import { Card, Chip, Empty, Spinner } from "../components";
import { HEALTH_TOPICS, humanDay } from "../format";
import { navigate } from "../router";
import type { DiaryRow } from "../types";

// Здоровье: подразделы с числом записей, поиск по словам, записи по дням.

interface Topic { topic: string; n: number; last: string; name: string }

export function Health({ version }: { version: number }) {
  const [topics, setTopics] = useState<Topic[] | null>(null);
  const [topic, setTopic] = useState("");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<DiaryRow[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    get<Topic[]>("/api/health/topics").then(setTopics).catch((e) => setError((e as Error).message));
  }, [version]);
  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      const params = new URLSearchParams({ section: "health" });
      if (topic && topic !== "~") params.set("topic", topic);
      if (q.trim()) params.set("q", q.trim());
      get<DiaryRow[]>(`/api/diary?${params}`).then((r) => alive && setRows(topic === "~" ? r.filter((x) => !x.topic) : r)).catch((e) => alive && setError((e as Error).message));
    }, q ? 250 : 0);
    return () => { alive = false; clearTimeout(t); };
  }, [topic, q, version]);

  if (error) return <Empty>Нет связи: {error}</Empty>;
  if (!topics) return <Spinner />;

  const byDay = new Map<string, DiaryRow[]>();
  for (const r of rows ?? []) byDay.set(r.day_key, [...(byDay.get(r.day_key) ?? []), r]);

  return (
    <div className="screen">
      <h2 className="screen-title">Здоровье</h2>
      <div className="topics reveal">
        <button className={`topic ${topic === "" ? "on" : ""}`} onClick={() => setTopic("")}>Всё <span className="muted">{topics.reduce((s, t) => s + t.n, 0)}</span></button>
        {topics.map((t) => (
          <button key={t.topic || "~"} className={`topic ${topic === (t.topic || "~") ? "on" : ""}`} onClick={() => setTopic(topic === (t.topic || "~") ? "" : t.topic || "~")}>
            {t.name} <span className="muted">{t.n}</span>
          </button>
        ))}
      </div>
      <input className="search" placeholder="Поиск: давление, таблетки, болела голова…" value={q} onChange={(e) => setQ(e.target.value)} />

      <div className="cards">
        <Card className="reveal wide">
          {!rows ? <Spinner /> : rows.length === 0 ? (
            <Empty>{q || topic ? "Ничего не нашлось" : "Записей о здоровье пока нет. Напишите, например: «давление 130 на 85, болит голова»"}</Empty>
          ) : (
            <div className="timeline">
              {[...byDay.entries()].map(([day, list]) => (
                <div key={day} className="tl-day">
                  <button className="link tl-date" onClick={() => navigate(`/diary/${day}`)}>{humanDay(day, true)}</button>
                  <ul>
                    {list.map((r) => (
                      <li key={r.id}>
                        {r.topic && !topic && <Chip tone="accent">{HEALTH_TOPICS[r.topic] ?? r.topic}</Chip>}
                        {r.text}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {rows.length >= 500 && <p className="muted small">Показаны первые 500 — уточните поиск.</p>}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
