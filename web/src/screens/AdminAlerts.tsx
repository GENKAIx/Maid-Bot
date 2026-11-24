import { useContext, useState } from "react";
import { ApiError, post } from "../api";
import {
  ALERT_LOG_KINDS, alertState, alertThresholdError, alertValueText, bytesText, copyStatus,
  type AlertRule, type AlertsData, type BackupsData, type DbCopy,
} from "../admin";
import { AdminLost, Loading, useAdmin } from "./AdminSections";

// Разделы «Оповещения» и «Копии базы» (этап 4 «Тарифы и управление», 24.11.2026; макет docs/review/тарифы-и-управление-макет-2026-11-24.html).
// Оповещения: правила по порогам (server/src/alerts.ts) — переключатель, порог, окно, «не чаще раза в»; история срабатываний;
// «Проверить сейчас» и «Тестовое оповещение». Копии базы: ночная копия в 04:00 по поясу владельца, сжатая — владельцу в Telegram
// (server/src/snapshot.ts DbCopies); «Сделать копию сейчас» и «Проверить восстановление». Каждое действие — с причиной, сервер
// пишет его в журнал админа. Только числа и номера аккаунтов, без имён и текстов людей.

const dt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");

/** Отправка действия: null — получилось, иначе текст ошибки; 403 — вход в админку кончился. */
function useSend() {
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

function Reason({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input className="adm-tf-reason adm-al-reason" placeholder="Причина (обязательно): например, «после выкладки»" aria-label="Причина" maxLength={300}
      value={value} onChange={(e) => onChange(e.target.value)} />
  );
}

/** Итог действия («письмо ушло», «проверено…»). Живёт в родителе раздела: страница после действия перемонтируется со свежими
 *  данными (key={tick}), и сообщение в её собственном состоянии пропадало бы сразу. */
export type ActNote = { ok: boolean; text: string } | null;
type PageProps<T> = { data: T; onChanged: () => void; note: ActNote; setNote: (n: ActNote) => void };

export function AdminAlerts() {
  const [tick, setTick] = useState(0);
  const [note, setNote] = useState<ActNote>(null);
  const [data, err] = useAdmin<AlertsData>(`/api/admin/alerts${tick ? `?t=${tick}` : ""}`);
  if (!data) return <Loading err={err} />;
  return <AlertsPage key={tick} data={data} onChanged={() => setTick((t) => t + 1)} note={note} setNote={setNote} />;
}

/** Сам раздел по готовым данным (тест рисует его без сети: web/test/admin-alerts.test.ts). */
export function AlertsPage({ data, onChanged, note, setNote }: PageProps<AlertsData>) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const send = useSend();
  const titles = Object.fromEntries(data.rules.map((r) => [r.id, r.title]));
  async function act(path: string, body: Record<string, unknown>, done: (r: Record<string, unknown>) => string) {
    if (reason.trim().length < 3) return setNote({ ok: false, text: "Напишите причину — хотя бы 3 знака." });
    setBusy(true);
    const r = await send<Record<string, unknown>>(path, { ...body, reason: reason.trim() });
    setBusy(false);
    if ("err" in r) return setNote({ ok: false, text: r.err });
    setNote({ ok: true, text: `${done(r.ok)} Записано в журнал админа.` });
    setReason("");
    onChanged();
  }
  return (
    <div className="adm-al">
      <p className="adm-muted">
        Горничная сама пишет владельцу в Telegram, когда что-то идёт не так. Проверка — раз в {data.check_every_min} мин; одно правило —
        не чаще, чем указано; когда всё прошло — «снова норма». В письмах только числа и номера аккаунтов.
      </p>
      <section className="adm-panel adm-al-acts">
        <Reason value={reason} onChange={setReason} />
        <div className="adm-row">
          <button className="adm-btn" disabled={busy} onClick={() => void act("/api/admin/alerts/check", {}, (r) => {
            const rows = (r.results as { hit: boolean; sent: string | null }[] | undefined) ?? [];
            return `Проверено: тревог ${rows.filter((x) => x.hit).length}, писем ${rows.filter((x) => x.sent && x.sent !== "held").length}.`;
          })}>Проверить сейчас</button>
          <button className="adm-btn" disabled={busy} onClick={() => void act("/api/admin/alerts/test", {}, (r) => (Number(r.sent) ? "Тестовое письмо ушло в Telegram." : "Не ушло: бот выключен или у владельца нет Telegram."))}>
            Тестовое оповещение
          </button>
        </div>
        {note && <p className={note.ok ? "adm-muted" : "adm-err"} role={note.ok ? "status" : "alert"}>{note.text}</p>}
      </section>
      <section className="adm-panel">
        <b>Правила</b>
        <div className="adm-scroll">
          <table className="adm-table adm-al-rules">
            <thead><tr><th>Вкл</th><th>Когда писать</th><th className="num">Порог</th><th className="num">Окно, мин</th><th className="num">Не чаще, мин</th><th>Сейчас</th><th>Последнее письмо</th><th /></tr></thead>
            <tbody>{data.rules.map((r) => (
              <RuleRow key={r.id} r={r} busy={busy} onSave={(body, what) => act("/api/admin/alerts/rule", { id: r.id, ...body }, () => `«${r.title}»: ${what}.`)} />
            ))}</tbody>
          </table>
        </div>
      </section>
      <section className="adm-panel">
        <b>Последние оповещения</b>
        {data.history.length ? (
          <div className="adm-scroll">
            <table className="adm-table">
              <thead><tr><th>Когда</th><th>Правило</th><th>Что</th><th>Письмо</th><th>Текст</th></tr></thead>
              <tbody>{data.history.map((h, i) => (
                <tr key={i}>
                  <td className="adm-num">{dt(h.at)}</td><td>{h.rule === "test" ? "Проверка" : titles[h.rule] ?? h.rule}</td>
                  <td>{ALERT_LOG_KINDS[h.kind] ?? h.kind}</td><td>{h.sent ? "ушло" : <span className="adm-muted">нет</span>}</td>
                  <td className="adm-al-text">{h.text || <span className="adm-muted">—</span>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : <span className="adm-muted">Пока ни одного — всё спокойно.</span>}
      </section>
    </div>
  );
}

function RuleRow({ r, busy, onSave }: { r: AlertRule; busy: boolean; onSave: (body: Record<string, unknown>, what: string) => void }) {
  const [on, setOn] = useState(r.enabled);
  const [th, setTh] = useState(String(r.threshold));
  const [win, setWin] = useState(String(r.window_min));
  const [every, setEvery] = useState(String(r.every_min));
  const thErr = alertThresholdError(r, th);
  const winN = Number(win), everyN = Number(every);
  const winErr = r.window && !(Number.isInteger(winN) && winN >= 5 && winN <= 1440) ? "5…1440" : null;
  const everyErr = r.kind !== "daily" && !(Number.isInteger(everyN) && everyN >= 5 && everyN <= 10_080) ? "5…10080" : null;
  const body: Record<string, unknown> = {};
  if (on !== r.enabled) body.enabled = on;
  if (!thErr && Number(th.replace(",", ".")) !== r.threshold) body.threshold = Number(th.replace(",", "."));
  if (r.window && !winErr && winN !== r.window_min) body.window_min = winN;
  if (r.kind !== "daily" && !everyErr && everyN !== r.every_min) body.every_min = everyN;
  const changed = Object.keys(body).length > 0;
  const bad = Boolean(thErr || winErr || everyErr);
  const st = alertState(r);
  const what = [
    "enabled" in body ? (on ? "включено" : "выключено") : "",
    "threshold" in body ? `порог ${body.threshold}` : "", "window_min" in body ? `окно ${body.window_min} мин` : "", "every_min" in body ? `не чаще ${body.every_min} мин` : "",
  ].filter(Boolean).join(", ");
  return (
    <tr className={changed ? "adm-al-ch" : ""}>
      <td><input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} aria-label={`${r.title}: вкл`} /></td>
      <td>{r.title}<div className="adm-muted adm-small">{r.hint}</div></td>
      <td className="num">
        <span className="adm-al-num"><input className={`adm-tf-reason${thErr ? " err" : ""}`} inputMode="decimal" value={th} onChange={(e) => setTh(e.target.value)} aria-label={`${r.title}: порог`} /> {r.unit}</span>
        {thErr && <div className="adm-err adm-small">{thErr}</div>}
      </td>
      <td className="num">{r.window
        ? <input className={`adm-tf-reason adm-al-n${winErr ? " err" : ""}`} inputMode="numeric" value={win} onChange={(e) => setWin(e.target.value)} aria-label={`${r.title}: окно`} />
        : <span className="adm-muted">—</span>}</td>
      <td className="num">{r.kind !== "daily"
        ? <input className={`adm-tf-reason adm-al-n${everyErr ? " err" : ""}`} inputMode="numeric" value={every} onChange={(e) => setEvery(e.target.value)} aria-label={`${r.title}: не чаще`} />
        : <span className="adm-muted">раз в сутки</span>}</td>
      <td><span className={`adm-al-st ${st.tone}`}>{st.text}</span><div className="adm-muted adm-small adm-num">{alertValueText(r)}</div></td>
      <td className="adm-num">{dt(r.last_sent)}</td>
      <td>{changed && <button className="adm-btn small primary" disabled={busy || bad} onClick={() => onSave(body, what)}>Сохранить</button>}</td>
    </tr>
  );
}

export function AdminBackups() {
  const [tick, setTick] = useState(0);
  const [note, setNote] = useState<ActNote>(null);
  const [data, err] = useAdmin<BackupsData>(`/api/admin/backups${tick ? `?t=${tick}` : ""}`);
  if (!data) return <Loading err={err} />;
  return <BackupsPage key={tick} data={data} onChanged={() => setTick((t) => t + 1)} note={note} setNote={setNote} />;
}

function Kpi({ title, value, hint, tone }: { title: string; value: string; hint?: string; tone?: string }) {
  return <div className={`adm-kpi ${tone === "bad" || tone === "warn" ? "warn" : ""}`}><span>{title}</span><b className="adm-num">{value}</b>{hint && <i>{hint}</i>}</div>;
}

const CopyRows = ({ rows }: { rows: DbCopy[] }) => (
  <div className="adm-scroll">
    <table className="adm-table">
      <thead><tr><th>Когда</th><th>Файл</th><th className="num">Размер</th><th className="num">Сжатая</th><th>Итог</th><th>Подробности</th></tr></thead>
      <tbody>{rows.map((c, i) => {
        const st = copyStatus(c);
        return (
          <tr key={i}>
            <td className="adm-num">{dt(c.at)}{c.by_user ? <div className="adm-muted adm-small">#{c.by_user}</div> : null}</td>
            <td className="adm-num">{c.file || "—"}</td><td className="num adm-num">{c.bytes ? bytesText(c.bytes) : "—"}</td>
            <td className="num adm-num">{c.gz_bytes ? bytesText(c.gz_bytes) : "—"}</td>
            <td><span className={`adm-al-st ${st.tone}`}>{st.text}</span></td>
            <td className="adm-small">{c.problem || c.note || <span className="adm-muted">—</span>}</td>
          </tr>
        );
      })}</tbody>
    </table>
  </div>
);

/** Сам раздел по готовым данным (тест рисует его без сети). */
export function BackupsPage({ data, onChanged, note, setNote }: PageProps<BackupsData>) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const send = useSend();
  const last = data.copies[0];
  const lastOk = data.copies.find((c) => c.status === "ok");
  const ver = data.verifies[0];
  async function act(what: "run" | "verify") {
    if (reason.trim().length < 3) return setNote({ ok: false, text: "Напишите причину — хотя бы 3 знака." });
    setBusy(true);
    setNote(null);
    const r = await send<{ result: DbCopy }>(`/api/admin/backups/${what}`, { reason: reason.trim() });
    setBusy(false);
    if ("err" in r) return setNote({ ok: false, text: r.err });
    const res = r.ok.result;
    setNote({ ok: res.status !== "fail", text: `${copyStatus(res).text}${res.problem ? `: ${res.problem}` : res.note ? ` — ${res.note}` : ""}. Записано в журнал админа.` });
    setReason("");
    onChanged();
  }
  const where = data.mode === "postgres" ? "у провайдера" : data.telegram ? "сервер + Telegram" : "только сервер";
  return (
    <div className="adm-al">
      <p className="adm-muted">
        Без копии один сбой диска на сервере стирает всё. {data.mode === "sqlite"
          ? `Каждую ночь в ${data.at} по поясу владельца сервер снимает целую копию базы, хранит ${data.keep} последних рядом с базой и присылает сжатую владельцу в Telegram (до ${bytesText(data.max_send_bytes)}). В файле все записи людей — не пересылайте его.`
          : data.mode === "postgres" ? "База — Postgres: копии делает провайдер базы, здесь их нет." : "Папки для копий нет — база не в файле."}
      </p>
      <div className="adm-kpis">
        <Kpi title="Последняя копия" value={last ? dt(last.at) : "не было"} hint={last ? copyStatus(last).text : `ночью в ${data.at}`} tone={last ? copyStatus(last).tone : "warn"} />
        <Kpi title="Размер" value={bytesText(lastOk?.bytes || data.db_bytes)} hint={lastOk?.gz_bytes ? `сжатая ${bytesText(lastOk.gz_bytes)}` : data.db_bytes != null ? "база сейчас" : undefined} />
        <Kpi title="Где лежит" value={where} hint={data.mode === "sqlite" ? `${data.local.length} из ${data.keep} на сервере` : undefined} />
        <Kpi title="Восстановление проверено" value={ver ? dt(ver.at) : "ни разу"} hint={ver ? copyStatus(ver).text : "копия, которую не пробовали поднять, — не копия"} tone={ver ? copyStatus(ver).tone : "warn"} />
      </div>
      <section className="adm-panel adm-al-acts">
        <Reason value={reason} onChange={setReason} />
        <div className="adm-row">
          <button className="adm-btn primary" disabled={busy || data.mode !== "sqlite"} onClick={() => void act("verify")}>Проверить восстановление</button>
          <button className="adm-btn" disabled={busy || data.mode !== "sqlite"} onClick={() => void act("run")}>Сделать копию сейчас</button>
        </div>
        <span className="adm-muted adm-small">
          Проверка поднимает последнюю копию во временную базу рядом, проверяет целостность и сверяет число людей и сообщений с живой
          базой. Настоящую базу не трогает. Копия сейчас — то же, что ночная: снимок, сжатие, файл в Telegram.
        </span>
        {note && <p className={note.ok ? "adm-muted" : "adm-err"} role={note.ok ? "status" : "alert"}>{note.text}</p>}
      </section>
      <section className="adm-panel">
        <b>Последние копии</b>
        {data.copies.length ? <CopyRows rows={data.copies} /> : <span className="adm-muted">Ещё ни одной.</span>}
      </section>
      <section className="adm-panel">
        <b>Проверки восстановления</b>
        {data.verifies.length ? <CopyRows rows={data.verifies} /> : <span className="adm-muted">Ещё ни одной.</span>}
      </section>
      {data.local.length > 0 && (
        <section className="adm-panel">
          <b>На сервере</b>
          <div className="adm-scroll">
            <table className="adm-table">
              <thead><tr><th>Файл</th><th className="num">Размер</th><th>Когда</th></tr></thead>
              <tbody>{data.local.map((f) => <tr key={f.file}><td className="adm-num">{f.file}</td><td className="num adm-num">{bytesText(f.bytes)}</td><td className="adm-num">{dt(f.at)}</td></tr>)}</tbody>
            </table>
          </div>
          <span className="adm-muted adm-small">Скачать с сайта нельзя намеренно: файл со всеми записями людей не должен уходить через браузер. Забрать — deploy/pull-backup.ps1 или из Telegram.</span>
        </section>
      )}
    </div>
  );
}
