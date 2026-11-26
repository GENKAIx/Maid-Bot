import { useContext, useState } from "react";
import { ApiError, post } from "../api";
import {
  CRASH_PROCESS_NAMES, crashCompare, notesError, notesFromText, percentError, releaseState, shareText,
  type CrashesData, type CrashVersion, type ReleaseNotesInfo, type ReleasesData,
} from "../admin";
import { AdmBars, AdminLost, Loading, useAdmin } from "./AdminSections";
import type { ActNote } from "./AdminAlerts";

// Разделы «Выпуски» и «Падения» (этап 5 «Тарифы и управление», 24.11.2026; макет docs/review/тарифы-и-управление-макет-2026-11-24.html,
// вкладки «Выпуски виджета» и «Падения»). Выпуски: какая версия выпускается, какой доле людей видно обновление (stagingPercentage в
// latest.yml подставляет сервер, server/src/releases.ts), пауза и «продолжить» — с причиной в журнал админа; доли падений новой и
// прошлой версии; люди по версиям за 7 дней. Падения (server/src/crashes.ts): по версиям — доля людей с падением, сравнение с прошлой,
// топ мест в коде, график по дням. Только числа: ни текстов ошибок, ни имён.
// 26.11.2026: новая версия по умолчанию — сразу всем (100%; поэтапно — tools/release-desktop.py --percent=N); под плашками — «Что нового»
// выпускаемой версии и «Прошлые выпуски» (пункты владельца из notes-<версия>.json, правка с причиной — POST /api/admin/releases/notes).
// В макете этого блока нет — добавлен по просьбе владельца.

const dt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");
const dayText = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });

function Kpi({ title, value, hint, tone }: { title: string; value: string; hint?: string; tone?: string }) {
  return <div className={`adm-kpi ${tone === "bad" || tone === "warn" ? "warn" : ""}`}><span>{title}</span><b className="adm-num">{value}</b>{hint && <i>{hint}</i>}</div>;
}

export function AdminReleases() {
  const [tick, setTick] = useState(0);
  const [note, setNote] = useState<ActNote>(null);
  // Раскрытые «Прошлые выпуски» и надпись о сохранённых заметках живут здесь: ReleasesPage после правки монтируется заново (key={tick}).
  const [openPast, setOpenPast] = useState<string[]>([]);
  const [notesNote, setNotesNote] = useState<NotesNote>(null);
  const [data, err] = useAdmin<ReleasesData>(`/api/admin/releases${tick ? `?t=${tick}` : ""}`);
  if (!data) return <Loading err={err} />;
  return <ReleasesPage key={tick} data={data} onChanged={() => setTick((t) => t + 1)} note={note} setNote={setNote}
    openPast={openPast} onTogglePast={(v, open) => setOpenPast((l) => (open ? (l.includes(v) ? l : [...l, v]) : l.filter((x) => x !== v)))}
    notesNote={notesNote} setNotesNote={setNotesNote} />;
}

/** Надпись после правки заметок — у того выпуска, который правили. */
export type NotesNote = { version: string; ok: boolean; text: string } | null;
type NotesUi = { openPast?: string[]; onTogglePast?: (version: string, open: boolean) => void; notesNote?: NotesNote; setNotesNote?: (n: NotesNote) => void };

/** Сам раздел по готовым данным (тест рисует его без сети: web/test/admin-releases.test.ts). */
export function ReleasesPage({ data, onChanged, note, setNote, ...notesUi }: { data: ReleasesData; onChanged: () => void; note: ActNote; setNote: (n: ActNote) => void } & NotesUi) {
  const r = data.release;
  const [pct, setPct] = useState(String(r?.percent ?? data.start_percent));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const lost = useContext(AdminLost);
  const st = releaseState(r);
  const pctErr = percentError(pct);
  async function act(body: Record<string, unknown>, done: string) {
    if (!r) return;
    if (reason.trim().length < 3) return setNote({ ok: false, text: "Напишите причину — хотя бы 3 знака." });
    setBusy(true);
    try {
      await post("/api/admin/releases", { version: r.version, ...body, reason: reason.trim() });
      setNote({ ok: true, text: `${done} Записано в журнал админа.` });
      setReason("");
      onChanged();
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) lost();
      setNote({ ok: false, text: (e as Error).message || "не вышло" });
    } finally {
      setBusy(false);
    }
  }
  const c = data.crash;
  const cmp = c ? crashCompare(c, c.prev) : null;
  return (
    <div className="adm-al">
      <p className="adm-muted">
        Новая версия программы {data.start_percent >= 100 ? "сразу уходит всем" : `сначала уходит ${data.start_percent}% людей`}; долю можно
        уменьшить здесь или выпустить поэтапно с самого начала. Долю сервер дописывает в latest.yml (stagingPercentage), программа сама решает,
        попала ли она в долю. Если у новой версии падений в разы больше, чем у прошлой, выпуск сам встаёт на паузу и владельцу приходит письмо.
      </p>
      <div className="adm-kpis">
        <Kpi title="Выпускается" value={r?.version ?? "—"} hint={r ? `с ${dt(r.started_at)}${r.prev ? `, до неё ${r.prev}` : ""}` : "сервер ещё не видел latest.yml"} />
        <Kpi title="Получают обновление" value={data.served == null ? (r ? "все" : "—") : `${data.served}%`} hint={st.text} tone={st.tone} />
        <Kpi title="В latest.yml на сервере" value={data.file_version ?? "нет файла"} hint={data.file_version && r && data.file_version !== r.version ? "не та версия, что выпускается" : undefined} />
        {c && <Kpi title={`Падения ${c.version}`} value={shareText(c.active ? c.share : null)} hint={`${c.crashed} из ${c.active} чел. за ${data.crash_days} дн.; ${cmp!.text}`} tone={cmp!.tone} />}
      </div>
      <ReleaseNotesBlock data={data} onChanged={onChanged} {...notesUi} />
      {r && (
        <section className="adm-panel adm-al-acts">
          <b>Выпуск {r.version}</b>
          <p className={r.paused ? "adm-err" : "adm-muted"} role="status">
            {r.paused
              ? `Выпуск на паузе${r.auto_paused_at ? ` — автопауза из-за падений (${dt(r.auto_paused_at)})` : ""}. Уже установленные программы не обновляются; новые установки с сайта всё равно получают ${r.version} (на сервере один установщик). «Продолжить» вернёт ${r.percent}%.`
              : r.percent >= 100 ? "Обновление видят все." : `Обновление видят ${r.percent}% людей. Пауза включится сама, если падений станет в разы больше, чем у ${r.prev || "прошлой версии"} (не меньше ${data.min_users} человек).`}
          </p>
          <div className="adm-row">
            <span className="adm-al-num">
              <input className={`adm-tf-reason adm-al-n${pctErr ? " err" : ""}`} inputMode="numeric" value={pct} onChange={(e) => setPct(e.target.value)} aria-label="Доля выпуска, %" /> %
            </span>
            {[20, 50, 100].map((p) => (
              <button key={p} className={`adm-btn small${String(p) === pct.trim() ? " primary" : ""}`} onClick={() => setPct(String(p))}>{p}%</button>
            ))}
            <button className="adm-btn" disabled={busy || Boolean(pctErr) || Number(pct) === r.percent}
              onClick={() => void act({ percent: Number(pct) }, `Доля выпуска ${r.version}: ${pct}%.`)}>Сохранить долю</button>
            <button className={`adm-btn${r.paused ? " primary" : ""}`} disabled={busy}
              onClick={() => void act({ paused: !r.paused }, r.paused ? `Выпуск ${r.version} продолжен.` : `Выпуск ${r.version} на паузе.`)}>
              {r.paused ? "Продолжить выпуск" : "Поставить на паузу"}
            </button>
          </div>
          {pctErr && <span className="adm-err adm-small">{pctErr}</span>}
          <input className="adm-tf-reason adm-al-reason" placeholder="Причина (обязательно): например, «падений нет, расширяю»" aria-label="Причина" maxLength={300}
            value={reason} onChange={(e) => setReason(e.target.value)} />
          {note && <p className={note.ok ? "adm-muted" : "adm-err"} role={note.ok ? "status" : "alert"}>{note.text}</p>}
          <p className="adm-muted adm-small">
            Уже обновившиеся не откатываются: пауза и меньшая доля только не дают обновление тем, у кого его ещё нет (откатить версию
            нельзя — на сервере лежит один установщик, последний). Новые установки с сайта пауза не останавливает: постоянная ссылка
            ведёт на этот же установщик. Кто в долю — решает программа по своему случайному номеру, поэтому
            при росте доли те, кто уже получил обновление, остаются в ней.{" "}
            {data.start_percent >= 100
              ? "Новая версия выкладывается сразу всем; поэтапно — tools/release-desktop.py --percent=20 (или другая доля меньше 100)."
              : `Новая версия выкладывается с ${data.start_percent}% (tools/release-desktop.py --percent=…).`}
          </p>
        </section>
      )}
      <section className="adm-panel">
        <b>Версии у людей за 7 дней</b>
        {data.versions.length ? (
          <div className="adm-scroll">
            <table className="adm-table">
              <thead><tr><th>Версия</th><th className="num">Людей</th><th className="num">Доля</th><th className="num">С падением</th><th className="num">Доля с падением</th></tr></thead>
              <tbody>{data.versions.map((v) => (
                <tr key={v.version}>
                  <td className="adm-num">{v.version}{r?.version === v.version ? <span className="adm-muted"> · выпускается</span> : null}</td>
                  <td className="num adm-num">{v.active}</td><td className="num adm-num">{shareText(v.share_people)}</td>
                  <td className="num adm-num">{v.crashed}</td><td className="num adm-num">{shareText(v.crash_share)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : <span className="adm-muted">Программой на ПК за 7 дней никто не пользовался.</span>}
      </section>
    </div>
  );
}

const dayOf = (iso: string) => (iso ? new Date(iso).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—");
const items = (n: number) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? "пункт" : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? "пункта" : "пунктов"}`;

/** «Что нового» выпускаемой версии и «Прошлые выпуски» (свёрнуто: версия, дата, пункты), у каждого — «Изменить заметки». */
export function ReleaseNotesBlock({ data, onChanged, openPast = [], onTogglePast, notesNote = null, setNotesNote }: { data: ReleasesData; onChanged: () => void } & NotesUi) {
  const [editing, setEditing] = useState<string | null>(null);
  const curVersion = data.release?.version ?? data.notes[0]?.version ?? null;
  const cur = data.notes.find((n) => n.version === curVersion) ?? null;
  const past = data.notes.filter((n) => n !== cur);
  const edit = (n: ReleaseNotesInfo) => (editing === n.version
    ? <NotesEditor entry={n} data={data} onDone={(saved) => {
      setEditing(null);
      if (!saved) return;
      setNotesNote?.(saved);
      if (n !== cur) onTogglePast?.(n.version, true);
      onChanged();
    }} />
    : <>
      <button className="adm-btn small" onClick={() => { setEditing(n.version); setNotesNote?.(null); }}>Изменить заметки</button>
      {notesNote?.version === n.version && <p className={notesNote.ok ? "adm-muted" : "adm-err"} role="status">{notesNote.text}</p>}
    </>);
  return (
    <>
      <section className="adm-panel adm-al-acts">
        <b>Что нового в {curVersion ?? "—"}</b>
        {cur?.notes.length ? <ul className="adm-notes">{cur.notes.map((t, i) => <li key={i}>{t}</li>)}</ul>
          : <span className="adm-muted">{cur ? "Заметок к этому выпуску нет — выпускали без --notes." : "Выпусков ещё не было."}</span>}
        {cur && <div className="adm-row adm-small adm-muted">вышла {dayOf(cur.date)}{cur.edited_at ? ` · заметки правил #${cur.by} ${dt(cur.edited_at)}` : ""}</div>}
        {cur && edit(cur)}
      </section>
      {past.length > 0 && (
        <section className="adm-panel adm-al-acts">
          <b>Прошлые выпуски</b>
          {past.map((n) => (
            <details key={n.version} className="adm-notes-past" open={openPast.includes(n.version)}
              onToggle={(e) => onTogglePast?.(n.version, e.currentTarget.open)}>
              <summary><span className="adm-num">{n.version}</span> <span className="adm-muted">· {dayOf(n.date)} · {n.notes.length ? items(n.notes.length) : "без заметок"}</span></summary>
              {n.notes.length > 0 && <ul className="adm-notes">{n.notes.map((t, i) => <li key={i}>{t}</li>)}</ul>}
              {n.edited_at && <div className="adm-small adm-muted">заметки правил #{n.by} {dt(n.edited_at)}</div>}
              {edit(n)}
            </details>
          ))}
        </section>
      )}
    </>
  );
}

/** Сохранение пунктов (кнопка «Сохранить заметки»): при успехе — надпись, как у остальных действий раздела. send — для теста. */
export async function saveReleaseNotes(version: string, notes: string[], reason: string, send: (path: string, body: unknown) => Promise<unknown> = post):
  Promise<{ ok: true; note: NonNullable<NotesNote> } | { ok: false; text: string; lost: boolean }> {
  if (reason.trim().length < 3) return { ok: false, text: "Напишите причину — хотя бы 3 знака.", lost: false };
  try {
    await send("/api/admin/releases/notes", { version, notes, reason: reason.trim() });
    return { ok: true, note: { version, ok: true, text: `Заметки ${version} сохранены. Записано в журнал админа.` } };
  } catch (e) {
    return { ok: false, text: (e as Error).message || "не вышло", lost: e instanceof ApiError && e.status === 403 };
  }
}

/** Правка пунктов: пункт на строку, причина обязательна; в журнал админа (release_notes). */
function NotesEditor({ entry, data, onDone }: { entry: ReleaseNotesInfo; data: ReleasesData; onDone: (saved: NotesNote) => void }) {
  const [text, setText] = useState(entry.notes.join("\n"));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const lost = useContext(AdminLost);
  const notes = notesFromText(text);
  const err = notesError(notes, data.notes_max_items, data.notes_max_len);
  async function save() {
    setBusy(true);
    const res = await saveReleaseNotes(entry.version, notes, reason);
    setBusy(false);
    if (res.ok) return onDone(res.note);
    if (res.lost) lost();
    setMsg(res.text);
  }
  return (
    <div className="adm-al-acts">
      <textarea className={`adm-tf-reason adm-al-reason${err ? " err" : ""}`} rows={Math.min(9, Math.max(3, notes.length + 1))} aria-label={`Что нового в ${entry.version}`}
        placeholder={`Пункт на строку: 3–7 коротких строк, не больше ${data.notes_max_items}, до ${data.notes_max_len} знаков`} value={text} onChange={(e) => setText(e.target.value)} />
      {err && <span className="adm-err adm-small">{err}</span>}
      <input className="adm-tf-reason adm-al-reason" placeholder="Причина (обязательно): например, «проще словами»" aria-label="Причина правки заметок" maxLength={300}
        value={reason} onChange={(e) => setReason(e.target.value)} />
      <div className="adm-row">
        <button className="adm-btn primary" disabled={busy || Boolean(err)} onClick={() => void save()}>Сохранить заметки</button>
        <button className="adm-btn" disabled={busy} onClick={() => onDone(null)}>Отмена</button>
      </div>
      {msg && <p className="adm-err" role="alert">{msg}</p>}
    </div>
  );
}

export function AdminCrashes() {
  const [days, setDays] = useState(30);
  const [data, err] = useAdmin<CrashesData>(`/api/admin/crashes?days=${days}`);
  if (!data) return <Loading err={err} />;
  return <CrashesPage data={data} days={days} onDays={setDays} />;
}

function PlaceRows({ v }: { v: CrashVersion }) {
  if (!v.top.length) return <span className="adm-muted">Падений нет.</span>;
  return (
    <div className="adm-scroll">
      <table className="adm-table">
        <thead><tr><th>Ошибка</th><th>Где</th><th>Процесс</th><th className="num">Раз</th><th className="num">Людей</th><th>Впервые</th><th>Статус</th></tr></thead>
        <tbody>{v.top.map((p, i) => (
          <tr key={i}>
            <td className="adm-num">{p.kind}{p.fingerprint && <div className="adm-muted adm-small">#{p.fingerprint.slice(0, 6)}</div>}</td>
            <td className="adm-num">{p.place === "-" ? <span className="adm-muted">процесс упал целиком</span> : p.place}</td>
            <td>{CRASH_PROCESS_NAMES[p.process] ?? p.process}</td>
            <td className="num adm-num">{p.count}</td><td className="num adm-num">{p.users}</td>
            <td className="adm-num">{dayText(p.first)}</td>
            <td><span className={`adm-al-st ${p.fresh ? "bad" : "mute"}`}>{p.fresh ? "новое в этой версии" : "было и раньше"}</span></td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

/** Сам раздел по готовым данным (тест рисует его без сети). */
export function CrashesPage({ data, days, onDays }: { data: CrashesData; days: number; onDays: (d: number) => void }) {
  const last = data.versions[0];
  const cmp = last ? crashCompare(last, last.prev) : null;
  const total = data.series.reduce((s, d) => s + d.crashes, 0);
  return (
    <div className="adm-al">
      <p className="adm-muted">
        Программа сама присылает, где упала: тип ошибки, место в коде, процесс и версию. Ни текста ошибки, ни путей и названий программ
        с компьютера. Доля — люди с падением среди людей этой версии; хранится {data.keep_days} дней.
      </p>
      <div className="adm-seg-ctl" role="tablist">
        {[7, 30, 90].map((d) => <button key={d} role="tab" aria-selected={days === d} className={days === d ? "on" : ""} onClick={() => onDays(d)}>{d} дн.</button>)}
      </div>
      <div className="adm-kpis">
        <Kpi title={last ? `С падением на ${last.version}` : "Последняя версия"} value={last ? shareText(last.active ? last.share : null) : "—"}
          hint={last ? `${last.crashed} из ${last.active} чел.; ${cmp!.text}` : "данных ещё нет"} tone={cmp?.tone} />
        <Kpi title={`Падений за ${data.days} дн.`} value={String(total)} hint={`людей с падением в день — до ${Math.max(0, ...data.series.map((d) => d.crashed))}`} />
        <Kpi title="Версий в работе" value={String(data.versions.length)} />
      </div>
      <section className="adm-panel">
        <b>По дням: люди с программой</b>
        <AdmBars days={data.series.map((d) => ({ day: d.day, values: [d.crashed, Math.max(0, d.active - d.crashed)] }))} parts={["С падением", "Без падений"]} format={(v) => `${v} чел.`} height={110} />
      </section>
      <section className="adm-panel">
        <b>По версиям</b>
        {data.versions.length ? (
          <div className="adm-scroll">
            <table className="adm-table">
              <thead><tr><th>Версия</th><th className="num">Людей</th><th className="num">С падением</th><th className="num">Доля</th><th className="num">Падений</th><th>С прошлой</th></tr></thead>
              <tbody>{data.versions.map((v) => {
                const c = crashCompare(v, v.prev);
                return (
                  <tr key={v.version}>
                    <td className="adm-num">{v.version}</td><td className="num adm-num">{v.active}</td><td className="num adm-num">{v.crashed}</td>
                    <td className="num adm-num">{shareText(v.active ? v.share : null)}</td><td className="num adm-num">{v.crashes}</td>
                    <td><span className={`adm-al-st ${c.tone}`}>{c.text}</span>{v.prev && <div className="adm-muted adm-small">{v.prev.version}: {shareText(v.prev.share)}</div>}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        ) : <span className="adm-muted">Падений и людей с программой за этот срок нет.</span>}
      </section>
      {data.versions.slice(0, 3).map((v) => (
        <section key={v.version} className="adm-panel">
          <b>Места падений {v.version}</b> <span className="adm-muted">· одинаковые склеены; «людей» — сумма по дням</span>
          <PlaceRows v={v} />
        </section>
      ))}
    </div>
  );
}
