import { useEffect, useState } from "react";
import { get, post } from "../api";
import { MY_TICKET_STATUS } from "../announce";
import { Card, LoadError, NoteBar } from "../components";
import { type Note, failNote } from "../notice";

// «Написать нам» в «Настройках» (этап 6 «Тарифы и управление», 24.11.2026; сервер — server/src/support.ts): тема, текст, отправить;
// ниже — свои обращения со статусом и ответом. Не больше N в сутки (сервер отвечает 429 с понятным текстом).

export interface SupportInfo {
  topics: { id: string; title: string }[];
  per_day: number; left_today: number; text_max: number;
  tickets: { id: number; topic: string; text: string; status: string; created_at: string; answer: string | null; answered_at: string | null }[];
}

export function SupportCard() {
  const [info, setInfo] = useState<SupportInfo | null>(null);
  const [error, setError] = useState("");
  const load = () => get<SupportInfo>("/api/support").then((i) => { setInfo(i); setError(""); }).catch((e) => setError((e as Error).message));
  useEffect(() => { void load(); }, []);
  // Не загрузилось — карточка на месте, с причиной и «Повторить» (раньше молча не появлялась).
  if (!info) return error ? <Card title="Написать нам" className="reveal"><LoadError error={error} onRetry={() => { setError(""); void load(); }} /></Card> : null;
  return <SupportView info={info} onSent={() => void load()} />;
}

export function SupportView({ info, onSent }: { info: SupportInfo; onSent: () => void }) {
  const [topic, setTopic] = useState("");
  const [text, setText] = useState("");
  const [note, setNote] = useState<Note | null>(null);
  const [busy, setBusy] = useState(false);
  const titles = Object.fromEntries(info.topics.map((t) => [t.id, t.title]));
  async function send() {
    setBusy(true);
    try {
      const r = await post<{ text: string }>("/api/support", { topic, text });
      setNote({ text: r.text });
      setText("");
      setTopic("");
      onSent();
    } catch (e) {
      setNote(failNote("Обращение не отправлено", e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card title="Написать нам" className="reveal">
      <p className="muted small">Что-то не работает, вопрос об оплате или идея — напишите. Ответ придёт в Telegram и сюда, в уведомления.</p>
      <div className="support-form">
        <select value={topic} aria-label="Тема" onChange={(e) => setTopic(e.target.value)}>
          <option value="">Тема…</option>
          {info.topics.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
        </select>
        <textarea rows={4} maxLength={info.text_max} placeholder="Опишите, что случилось" aria-label="Текст обращения" value={text} onChange={(e) => setText(e.target.value)} />
        <div className="row">
          <button className="primary" disabled={busy || !topic || text.trim().length < 5 || info.left_today === 0} onClick={() => void send()}>Отправить</button>
          {info.left_today === 0 && <span className="muted small">На сегодня обращений хватит — новое можно завтра.</span>}
        </div>
        {note && <NoteBar note={note} onClose={() => setNote(null)} />}
      </div>
      {info.tickets.length > 0 && (
        <ul className="list small support-list">
          {info.tickets.map((t) => (
            <li key={t.id}>
              <span><b>№{t.id}</b> · {titles[t.topic] ?? t.topic} · <span className="muted">{MY_TICKET_STATUS[t.status] ?? t.status}, {new Date(t.created_at).toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}</span></span>
              {t.answer && <p className="support-answer">{t.answer}</p>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
