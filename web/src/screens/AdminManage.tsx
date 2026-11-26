import { useContext, useState } from "react";
import { ApiError, post } from "../api";
import {
  capDaysText, fewDataText, growTitle, NEWS_PREFIX, newsTextError, promoCodeError, promoStateText, ticketAnswerText, TICKET_STATUS_NAMES, usd, waitText,
  type NewsAudience, type NewsData, type PrognosisData, type PromoData, type SwitchesData, type TicketCard, type TicketsData, type TicketStatus,
} from "../admin";
import { AdminLost, AdmBars, Loading, useAdmin } from "./AdminSections";

// Этап 6 «Тарифы и управление» (24.11.2026; макет docs/review/тарифы-и-управление-макет-2026-11-24.html): «Переключатели»,
// «Промокоды», «Обращения», «Объявления», «Прогноз». Сервер — server/src/switches.ts, promo.ts, support.ts, announce.ts,
// prognosis.ts. Каждое действие — с причиной (сервер пишет её в журнал админа). Только числа и номера аккаунтов; текст человека —
// только в карточке обращения (он сам написал владельцу).

const dt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");
const dmy = (iso: string | null) => (iso ? iso.slice(0, 10).split("-").reverse().join(".") : "без срока");
const n0 = (v: number) => Math.round(v).toLocaleString("ru-RU");

export type ActNote = { ok: boolean; text: string } | null;
type PageProps<T> = { data: T; onChanged: () => void; note: ActNote; setNote: (n: ActNote) => void };

/** Отправка действия: ответ или текст ошибки; 403 — вход в админку кончился. */
export function useSend() {
  const lost = useContext(AdminLost);
  return async <T,>(path: string, body: unknown): Promise<{ ok: T } | { err: string }> => {
    try {
      return { ok: await post<T>(path, body) };
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) lost();
      return { err: (e as Error).message || "не вышло" };
    }
  };
}

/** Действие с причиной: проверка причины, отправка, итог в note, перечитать раздел. */
export function useAct(reason: string, setReason: (v: string) => void, setNote: (n: ActNote) => void, onChanged: () => void) {
  const send = useSend();
  const [busy, setBusy] = useState(false);
  const act = async <T,>(path: string, body: Record<string, unknown>, done: (r: T) => string): Promise<boolean> => {
    if (reason.trim().length < 3) return setNote({ ok: false, text: "Напишите причину — хотя бы 3 знака." }), false;
    setBusy(true);
    const r = await send<T>(path, { ...body, reason: reason.trim() });
    setBusy(false);
    if ("err" in r) return setNote({ ok: false, text: r.err }), false;
    setNote({ ok: true, text: `${done(r.ok)} Записано в журнал админа.` });
    setReason("");
    onChanged();
    return true;
  };
  return { act, busy };
}

export function Reason({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input className="adm-tf-reason adm-al-reason" placeholder="Причина (обязательно): например, «акция на стриме»" aria-label="Причина" maxLength={300}
      value={value} onChange={(e) => onChange(e.target.value)} />
  );
}
export const Note = ({ note }: { note: ActNote }) => (note ? <p className={note.ok ? "adm-muted" : "adm-err"} role={note.ok ? "status" : "alert"}>{note.text}</p> : null);
function Kpi({ title, value, hint, warn }: { title: string; value: string; hint?: string; warn?: boolean }) {
  return <div className={`adm-kpi ${warn ? "warn" : ""}`}><span>{title}</span><b className="adm-num">{value}</b>{hint && <i>{hint}</i>}</div>;
}

/** Обёртка раздела: данные, «перечитать после действия» (key={tick}) и итог действия, который переживает перерисовку. */
export function useSection<T>(path: string) {
  const [tick, setTick] = useState(0);
  const [note, setNote] = useState<ActNote>(null);
  const [data, err] = useAdmin<T>(`${path}${tick ? `?t=${tick}` : ""}`);
  return { data, err, tick, note, setNote, onChanged: () => setTick((t) => t + 1) };
}

// ——— Переключатели функций.
export function AdminSwitches() {
  const s = useSection<SwitchesData>("/api/admin/switches");
  if (!s.data) return <Loading err={s.err} />;
  return <SwitchesPage key={s.tick} data={s.data} onChanged={s.onChanged} note={s.note} setNote={s.setNote} />;
}
export function SwitchesPage({ data, onChanged, note, setNote }: PageProps<SwitchesData>) {
  const [reason, setReason] = useState("");
  const { act, busy } = useAct(reason, setReason, setNote, onChanged);
  return (
    <div className="adm-al">
      <p className="adm-muted">
        Выключить крупную функцию без выкладки — например, если она сломалась или стала дорогой. Сервер берёт новое значение сразу,
        другие копии сервера — в течение {Math.round(data.reload_ms / 1000)} с. Выключенная функция отвечает человеку коротким текстом.
      </p>
      {data.env_closed && <p className="adm-err" role="alert">SIGNUPS_OPEN=0 на сервере: регистрация закрыта, что бы ни стояло здесь.</p>}
      <section className="adm-panel adm-al-acts">
        <Reason value={reason} onChange={setReason} />
        <Note note={note} />
      </section>
      <section className="adm-panel">
        <div className="adm-scroll">
          <table className="adm-table adm-al-rules">
            <thead><tr><th>Функция</th><th>Сейчас</th><th>Что увидит человек, пока выключено</th><th>Изменено</th><th /></tr></thead>
            <tbody>{data.switches.map((x) => (
              <tr key={x.id}>
                <td>{x.title}<div className="adm-muted adm-small">{x.hint}</div></td>
                <td><span className={`adm-al-st ${x.on ? "ok" : "bad"}`}>{x.on ? "включено" : "выключено"}</span></td>
                <td className="adm-al-text">{x.off_text || <span className="adm-muted">новых в боте не пускает</span>}</td>
                <td className="adm-num">{dt(x.updated_at)}{x.updated_by && <div className="adm-muted adm-small">{x.updated_by}</div>}</td>
                <td>
                  <button className={`adm-btn small${x.on ? " danger" : " primary"}`} disabled={busy}
                    onClick={() => void act("/api/admin/switches", { id: x.id, on: !x.on }, () => `«${x.title}»: ${x.on ? "выключено" : "включено"}.`)}>
                    {x.on ? "Выключить" : "Включить"}
                  </button>
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

// ——— Промокоды.
export function AdminPromo() {
  const s = useSection<PromoData>("/api/admin/promo");
  if (!s.data) return <Loading err={s.err} />;
  return <PromoPage key={s.tick} data={s.data} onChanged={s.onChanged} note={s.note} setNote={s.setNote} />;
}
export function PromoPage({ data, onChanged, note, setNote }: PageProps<PromoData>) {
  const [reason, setReason] = useState("");
  const [code, setCode] = useState("");
  const [days, setDays] = useState("7");
  const [max, setMax] = useState("100");
  const [until, setUntil] = useState("");
  const { act, busy } = useAct(reason, setReason, setNote, onChanged);
  const codeErr = promoCodeError(code);
  const d = Number(days), m = Number(max);
  const daysErr = Number.isInteger(d) && d >= 1 && d <= data.days_max ? null : `1…${data.days_max}`;
  const maxErr = Number.isInteger(m) && m >= 1 && m <= data.uses_max ? null : `1…${data.uses_max}`;
  const create = () => act<{ code: string }>("/api/admin/promo", {
    ...(code.trim() ? { code: code.trim() } : { generate: true }), days: d, max_uses: m, until: until || null,
  }, (r) => `Код ${r.code} создан.`);
  return (
    <div className="adm-al">
      <p className="adm-muted">
        Звёздную подписку нельзя продать со скидкой, поэтому промокод дарит дни. Человек вводит его в «Настройки → Тариф»: дни
        прибавляются к сроку (кончился — от сегодня). Один человек — один промокод. Идущую подписку с продлением код не трогает.
        Перебор: не больше {data.tries} неудачных попыток за {data.window_min} мин.
      </p>
      <section className="adm-panel adm-al-acts">
        <Reason value={reason} onChange={setReason} />
        <Note note={note} />
      </section>
      <section className="adm-panel adm-acc-form">
        <b>Новый код</b>
        <div className="adm-row">
          <label className="adm-acc-num">Код
            <input className={codeErr ? "err" : ""} style={{ width: 140 }} value={code} maxLength={20} placeholder="сгенерировать" aria-label="Код" onChange={(e) => setCode(e.target.value.toUpperCase())} />
          </label>
          <label className="adm-acc-num">Дней<input inputMode="numeric" value={days} aria-label="Сколько дней" onChange={(e) => setDays(e.target.value)} /></label>
          <label className="adm-acc-num">Сколько раз<input inputMode="numeric" value={max} aria-label="Сколько раз" onChange={(e) => setMax(e.target.value)} /></label>
          <label className="adm-acc-num">До (включительно)<input type="date" style={{ width: 150 }} value={until} aria-label="Действует до" onChange={(e) => setUntil(e.target.value)} /></label>
        </div>
        {(codeErr || daysErr || maxErr) && <span className="adm-err adm-small">{[codeErr && `код: ${codeErr}`, daysErr && `дней: ${daysErr}`, maxErr && `раз: ${maxErr}`].filter(Boolean).join("; ")}</span>}
        <div className="adm-row">
          <button className="adm-btn primary" disabled={busy || Boolean(codeErr || daysErr || maxErr)} onClick={() => void create()}>Создать</button>
          <span className="adm-muted adm-small">Пустое поле «Код» — сервер придумает 8 знаков без похожих букв.</span>
        </div>
      </section>
      <section className="adm-panel">
        <b>Коды</b>
        {data.codes.length ? (
          <div className="adm-scroll">
            <table className="adm-table">
              <thead><tr><th>Код</th><th className="num">Дарит</th><th className="num">Применено</th><th>До</th><th>Создан</th><th>Статус</th><th /></tr></thead>
              <tbody>{data.codes.map((p) => {
                const st = promoStateText(p.state);
                const on = p.state !== "off";
                return (
                  <tr key={p.id}>
                    <td className="adm-num"><code>{p.code}</code></td><td className="num adm-num">+{p.days} дн.</td>
                    <td className="num adm-num">{p.used} / {p.max_uses}</td><td className="adm-num">{dmy(p.ends_at)}</td>
                    <td className="adm-num">{dt(p.created_at)}<div className="adm-muted adm-small">{p.created_by}</div></td>
                    <td><span className={`adm-al-st ${st.tone}`}>{st.text}</span></td>
                    <td><button className="adm-btn small" disabled={busy}
                      onClick={() => void act("/api/admin/promo/toggle", { id: p.id, on: !on }, () => `Код ${p.code} ${on ? "выключен" : "включён"}.`)}>{on ? "Выключить" : "Включить"}</button></td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        ) : <span className="adm-muted">Кодов пока нет.</span>}
      </section>
    </div>
  );
}

// ——— Обращения.
export function AdminTickets() {
  const s = useSection<TicketsData>("/api/admin/tickets");
  const [open, setOpen] = useState<number | null>(null);
  if (!s.data) return <Loading err={s.err} />;
  if (open != null) return <TicketOpen id={open} topics={s.data.topics} onBack={() => { setOpen(null); s.onChanged(); }} />;
  return <TicketsPage key={s.tick} data={s.data} onOpen={setOpen} />;
}
export function TicketsPage({ data, onOpen, now = new Date() }: { data: TicketsData; onOpen: (id: number) => void; now?: Date }) {
  const c = data.counts;
  return (
    <div className="adm-al">
      <p className="adm-muted">
        Человек пишет из «Настройки → Написать нам»: тема и текст, не больше {data.per_day} в сутки. Здесь — номер, аккаунт, тема и
        статус; текст виден только в карточке обращения. Ответ уходит человеку от бота в Telegram и в уведомления.
      </p>
      <div className="adm-kpis">
        <Kpi title="Новых" value={String(c.new)} warn={c.new > 0} />
        <Kpi title="В работе" value={String(c.work)} />
        <Kpi title="Самое старое открытое ждёт" value={waitText(c.oldest_open, now)} />
        <Kpi title="За 7 дней" value={String(c.week)} />
        <Kpi title="Ответ в среднем" value={c.answer_hours == null ? "—" : `${c.answer_hours < 1 ? "<1" : Math.round(c.answer_hours)} ч`} hint="за 30 дней" />
      </div>
      <section className="adm-panel">
        {data.tickets.length ? (
          <div className="adm-scroll">
            <table className="adm-table">
              <thead><tr><th>№</th><th>Аккаунт</th><th>Тема</th><th>Создано</th><th>Ждёт</th><th>Ответ</th><th>Статус</th><th /></tr></thead>
              <tbody>{data.tickets.map((t) => (
                <tr key={t.id}>
                  <td className="adm-num">{t.id}</td><td className="adm-num">{t.account}</td><td>{data.topics[t.topic] ?? t.topic}</td>
                  <td className="adm-num">{dt(t.created_at)}</td><td className="adm-num">{t.status === "closed" ? "—" : waitText(t.created_at, now)}</td>
                  <td>{t.answered ? "есть" : <span className="adm-muted">нет</span>}</td>
                  <td><span className={`adm-al-st ${t.status === "new" ? "bad" : t.status === "work" ? "warn" : "ok"}`}>{TICKET_STATUS_NAMES[t.status]}</span></td>
                  <td><button className="adm-btn small" onClick={() => onOpen(t.id)}>Открыть</button></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : <span className="adm-muted">Обращений пока нет.</span>}
      </section>
    </div>
  );
}
function TicketOpen({ id, topics, onBack }: { id: number; topics: Record<string, string>; onBack: () => void }) {
  const s = useSection<TicketCard>(`/api/admin/tickets/${id}`);
  if (!s.data) return <><button className="adm-btn small" onClick={onBack}>← Все обращения</button> <Loading err={s.err} /></>;
  return <TicketCardPage key={s.tick} card={s.data} topics={topics} onBack={onBack} onChanged={s.onChanged} note={s.note} setNote={s.setNote} />;
}
export function TicketCardPage({ card, topics, onBack, onChanged, note, setNote }: { card: TicketCard; topics: Record<string, string>; onBack: () => void } & Omit<PageProps<TicketCard>, "data">) {
  const [reason, setReason] = useState("");
  const [answer, setAnswer] = useState("");
  const [close, setClose] = useState(true);
  const { act, busy } = useAct(reason, setReason, setNote, onChanged);
  const status = (to: TicketStatus) => act(`/api/admin/tickets/${card.id}/status`, { status: to }, () => `Обращение №${card.id}: ${TICKET_STATUS_NAMES[to]}.`);
  return (
    <div className="adm-al">
      <button className="adm-btn small" onClick={onBack}>← Все обращения</button>
      <section className="adm-panel adm-acc-form">
        <b>Обращение №{card.id} · {card.account} · {topics[card.topic] ?? card.topic}</b>
        <span className="adm-muted adm-small">
          {dt(card.created_at)} · {TICKET_STATUS_NAMES[card.status]}{card.plan ? ` · тариф: ${card.plan}` : ""} · ответ уйдёт {card.telegram ? "в Telegram и в уведомления" : "только в уведомления (Telegram не привязан)"}
        </span>
        <p className="adm-muted adm-small">Текст человека — только здесь: он написал его владельцу сам. Не пересылайте и не копируйте в журнал.</p>
        <blockquote className="adm-al-text adm-ticket-text">{card.text}</blockquote>
        {card.answer && <><b className="adm-small">Ответ ({dt(card.answered_at)})</b><blockquote className="adm-al-text adm-ticket-text">{card.answer}</blockquote></>}
      </section>
      <section className="adm-panel adm-al-acts">
        <Reason value={reason} onChange={setReason} />
        <textarea className="adm-tf-reason adm-al-reason" rows={4} maxLength={2000} placeholder="Ответ человеку" aria-label="Ответ" value={answer} onChange={(e) => setAnswer(e.target.value)} />
        <label className="adm-small"><input type="checkbox" checked={close} onChange={(e) => setClose(e.target.checked)} /> После ответа — закрыть</label>
        <div className="adm-row">
          <button className="adm-btn primary" disabled={busy || answer.trim().length < 2}
            onClick={() => void act<TicketCard>(`/api/admin/tickets/${card.id}/answer`, { text: answer.trim(), close }, (r) => ticketAnswerText(r.delivered)).then((ok) => ok && setAnswer(""))}>Ответить</button>
          {card.status !== "work" && <button className="adm-btn" disabled={busy} onClick={() => void status("work")}>В работу</button>}
          {card.status !== "closed" && <button className="adm-btn" disabled={busy} onClick={() => void status("closed")}>Закрыть</button>}
          {card.status === "closed" && <button className="adm-btn" disabled={busy} onClick={() => void status("new")}>Открыть снова</button>}
        </div>
        <Note note={note} />
      </section>
    </div>
  );
}

// ——— Объявления.
export function AdminNews() {
  const s = useSection<NewsData>("/api/admin/announcements");
  if (!s.data) return <Loading err={s.err} />;
  return <NewsPage key={s.tick} data={s.data} onChanged={s.onChanged} note={s.note} setNote={s.setNote} />;
}
export function NewsPage({ data, onChanged, note, setNote }: PageProps<NewsData>) {
  const [reason, setReason] = useState("");
  const [text, setText] = useState("");
  const [who, setWho] = useState<NewsAudience>("all");
  const [site, setSite] = useState(true);
  const [widget, setWidget] = useState(false);
  const [until, setUntil] = useState("");
  const { act, busy } = useAct(reason, setReason, setNote, onChanged);
  const err = text ? newsTextError(text, data.text_max) : null;
  const shown = text.trim() || "Сегодня в 3:00 по Москве обновляю сервер — минут на десять я задумаюсь.";
  return (
    <div className="adm-al">
      <p className="adm-muted">
        Короткое сообщение всем или части людей: плашка на сайте (человек закрывает её крестиком) и/или реплика Рины в виджете — один
        раз. Для важного, не для рекламы. Рассылки в Telegram всем сразу здесь нет.
      </p>
      <div className="adm-acc-grid">
        <section className="adm-panel adm-acc-form">
          <b>Новое объявление</b>
          <textarea className="adm-tf-reason" rows={3} maxLength={data.text_max} aria-label="Текст объявления" placeholder={`Текст (до ${data.text_max} знаков)`} value={text} onChange={(e) => setText(e.target.value)} />
          {err && <span className="adm-err adm-small">{err}</span>}
          <div className="adm-row">
            <label className="adm-acc-num">Кому
              <select className="adm-tf-reason" value={who} aria-label="Кому" onChange={(e) => setWho(e.target.value as NewsAudience)}>
                {(Object.keys(data.audiences) as NewsAudience[]).map((k) => <option key={k} value={k}>{data.audiences[k]}</option>)}
              </select>
            </label>
            <label className="adm-acc-num">До (включительно)<input type="date" style={{ width: 150 }} value={until} aria-label="Показывать до" onChange={(e) => setUntil(e.target.value)} /></label>
          </div>
          <div className="adm-row">
            <label className="adm-small"><input type="checkbox" checked={site} onChange={(e) => setSite(e.target.checked)} /> плашка на сайте</label>
            <label className="adm-small"><input type="checkbox" checked={widget} onChange={(e) => setWidget(e.target.checked)} /> Рина в виджете</label>
          </div>
          <Reason value={reason} onChange={setReason} />
          <div className="adm-row">
            <button className="adm-btn primary" disabled={busy || !text.trim() || Boolean(err) || (!site && !widget)}
              onClick={() => void act("/api/admin/announcements", { text: text.trim(), audience: who, site, widget, until: until || null }, () => "Объявление опубликовано.").then((ok) => ok && setText(""))}>
              Опубликовать
            </button>
            <span className="adm-muted adm-small">Подходит сейчас: примерно {data.people[who]} чел.</span>
          </div>
          <Note note={note} />
        </section>
        <section className="adm-panel adm-acc-form">
          <b>Как увидят</b>
          {site && <div className="adm-news-bar" aria-label="Плашка на сайте"><span>{shown}</span><span className="adm-muted" aria-hidden="true">✕</span></div>}
          {widget && <div className="adm-news-bubble" aria-label="Облачко Рины"><b>Рина</b><span>{NEWS_PREFIX}{shown}</span></div>}
          {!site && !widget && <span className="adm-muted">Выберите, где показать.</span>}
        </section>
      </div>
      <section className="adm-panel">
        <b>Объявления</b>
        {data.items.length ? (
          <div className="adm-scroll">
            <table className="adm-table">
              <thead><tr><th>Текст</th><th>Кому</th><th>Где</th><th>До</th><th className="num">В виджете получили</th><th>Статус</th><th /></tr></thead>
              <tbody>{data.items.map((a) => (
                <tr key={a.id}>
                  <td className="adm-al-text">{a.text}<div className="adm-muted adm-small">№{a.id} · {dt(a.created_at)} · {a.created_by}</div></td>
                  <td>{data.audiences[a.audience] ?? a.audience}</td><td>{[a.site && "сайт", a.widget && "виджет"].filter(Boolean).join(", ")}</td>
                  <td className="adm-num">{dmy(a.ends_at)}</td><td className="num adm-num">{a.widget ? a.widget_got : "—"}</td>
                  <td><span className={`adm-al-st ${a.live ? "ok" : "mute"}`}>{a.live ? "показывается" : a.enabled ? "срок вышел" : "выключено"}</span></td>
                  <td><button className="adm-btn small" disabled={busy}
                    onClick={() => void act("/api/admin/announcements/toggle", { id: a.id, on: !a.enabled }, () => `Объявление №${a.id} ${a.enabled ? "выключено" : "включено"}.`)}>{a.enabled ? "Выключить" : "Включить"}</button></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : <span className="adm-muted">Объявлений пока нет.</span>}
      </section>
    </div>
  );
}

// ——— Прогноз.
export function AdminPrognosis() {
  const [data, err] = useAdmin<PrognosisData>("/api/admin/prognosis");
  if (!data) return <Loading err={err} />;
  return <PrognosisPage data={data} />;
}
export function PrognosisPage({ data }: { data: PrognosisData }) {
  const f = data;
  const pair = (p: { by7: number; by30: number }, fmt: (v: number) => string) => `${fmt(p.by7)} · ${fmt(p.by30)}`;
  const stars = (v: number) => `⭐${n0(v)}`;
  const grow = f.spend.slope_per_day;
  const fewSpend = fewDataText(f.spend.data_days, f.min_days);
  const fewTrial = fewDataText(f.trial_pool.data_days, f.min_days);
  const fewIncome = fewDataText(f.income.stars.data_days, f.min_days);
  const had = (n: number | undefined) => (n != null && n < f.days ? ` · данных ${n} дн.` : "");
  return (
    <div className="adm-al">
      <p className="adm-muted">
        Прямой счёт по фактическим дням: среднее за 7 и за 30 полных дней (сегодня не в счёт; дни — с первого дня с данными) × 30.
        Рост расхода — прямая по {f.days} дням; данных меньше {f.min_days} дн. — «мало данных».
        Только числа, без людей. Доход в долларах — по курсу ⭐1 = ${f.star_usd} из «Тарифов».
      </p>
      <div className="adm-kpis">
        <Kpi title="Расход на ИИ в месяц (по 7 · по 30 дн.)" value={pair(f.spend.month, usd)} hint={`сегодня пока ${usd(f.spend.today)}${had(f.spend.data_days)}`} warn={Boolean(fewSpend)} />
        <Kpi title="Доход в месяц (по 7 · по 30 дн.)" value={pair(f.income.stars, stars)} hint={`≈ ${pair(f.income.usd, usd)}${had(f.income.stars.data_days)}`} warn={Boolean(fewIncome)} />
        <Kpi title="Остаётся в месяц (по 30 дн.)" value={usd(f.income.usd.by30 - f.spend.month.by30)} warn={f.income.usd.by30 < f.spend.month.by30} hint="доход минус ИИ, без сервера" />
        <Kpi title="Продлений за 30 дней" value={String(f.renewals.n)} hint={`${stars(f.renewals.stars)} ≈ ${usd(f.renewals.usd)}; без продления кончится: ${f.renewals.ending_without_renew}`} />
      </div>
      <div className="adm-kpis" style={{ marginTop: 12 }}>
        <Kpi title={growTitle(grow)} value={fewSpend ?? usd(Math.abs(grow))} hint={`в день, по прямой за ${Math.min(f.days, f.spend.data_days)} дн.`} />
        <Kpi title={`Общий потолок проб ($${f.trial_pool.cap}/день)`} value={fewTrial ?? capDaysText(f.trial_pool.days_to_cap)} warn={f.trial_pool.days_to_cap != null && f.trial_pool.days_to_cap <= 7}
          hint={`пробы сегодня ${usd(f.trial_pool.today)}, по прямой ${usd(f.trial_pool.trend_last)}/день`} />
        <Kpi title={`Порог оповещения ($${f.spend.alert_cap}/день)`} value={fewSpend ?? capDaysText(f.spend.days_to_alert)} warn={f.spend.days_to_alert != null && f.spend.days_to_alert <= 7}
          hint={`по прямой ${usd(f.spend.trend_last)}/день`} />
      </div>
      <section className="adm-panel">
        <b>Расход на ИИ по дням, $</b>
        <AdmBars days={f.series.map((d) => ({ day: d.day, values: [d.cost] }))} parts={["Расход"]} format={usd} />
      </section>
      <section className="adm-panel">
        <b>Ожидаемые продления по датам окончания</b>
        {f.renewals.by_day.length ? (
          <div className="adm-scroll">
            <table className="adm-table">
              <thead><tr><th>День</th><th className="num">Подписок</th><th className="num">Звёзд</th></tr></thead>
              <tbody>{f.renewals.by_day.map((r) => <tr key={r.day}><td className="adm-num">{dmy(r.day)}</td><td className="num adm-num">{r.n}</td><td className="num adm-num">{stars(r.stars)}</td></tr>)}</tbody>
            </table>
          </div>
        ) : <span className="adm-muted">В ближайшие 30 дней продлений нет.</span>}
      </section>
    </div>
  );
}
