import { useState } from "react";
import { accountQuery, ago, testActs, testSeenText, type TestAccountRow, type TestCreated, type TestsData } from "../admin";
import { navigate } from "../router";
import { Note, Reason, useSend, type ActNote } from "./AdminManage";
import { Loading, useAdmin } from "./AdminSections";

// «Тестовые аккаунты» (27.11.2026; сервер — server/src/admin-tests.ts): аккаунты без Telegram (план «Друг», всё бесплатно), чтобы
// проверять программу на ПК, не трогая свой аккаунт. Список — только #id и числа. «Создать» — логин и пароль один раз (ручной вход
// на другом ПК). У строки: «Войти в программе на ПК» (сайт открыт в программе, мост maidDesktop.enterTest — ключ сразу уходит
// программе, на экран не выводится; программа откладывает свой ключ и возвращается к нему кнопкой «Вернуться в свой аккаунт»),
// в браузере — «Показать ключ» один раз; «Сбросить к чистому» — с номером, набранным вручную; «Аккаунт #N» — карточка, удаление там.
// Каждое действие — с причиной и строкой в журнале админа (без ключа и пароля).

const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit" }) : "—");

/** Мост программы на ПК, если сайт открыт в ней и она умеет входить в тестовый (desktop/src/preload-app.js). */
export type EnterTest = (token: string) => Promise<{ ok: boolean; error?: string } | null>;
export const testsBridge = (): EnterTest | null => {
  const b = typeof window === "undefined" ? undefined : window.maidDesktop;
  return typeof b?.enterTest === "function" ? (t) => b.enterTest!(t) : null;
};

/** Секрет, показанный один раз: логин и пароль нового аккаунта или ключ для ПК. */
export type TestSecret = { id: number; login?: string; password?: string; token?: string } | null;

export function AdminTests() {
  const [data, err] = useAdmin<TestsData>("/api/admin/tests");
  if (!data) return <Loading err={err} />;
  return <TestsPage data={data} enter={testsBridge()} />;
}

/** Что делать с выданным ключом: в браузере — показать один раз; в программе — сразу отдать ей (на экран и в итог не выводится).
 *  Программа сама проверяет, что это тестовый аккаунт (/api/me is_test). */
export async function testKeyFlow(id: number, token: string, enter: EnterTest | null): Promise<{ secret: TestSecret; note: ActNote }> {
  if (!enter) return { secret: { id, token }, note: { ok: true, text: `Ключ для #${id} выдан — виден один раз. Записано в журнал админа.` } };
  const res = await enter(token).catch((e: unknown) => ({ ok: false, error: (e as Error)?.message }));
  if (res?.ok) {
    return { secret: null, note: { ok: true, text: `Программа на ПК вошла в тестовый #${id}. Вернуться — «Вернуться в свой аккаунт» в настройках программы или в меню значка у часов. Записано в журнал админа.` } };
  }
  return { secret: null, note: { ok: false, text: `Программа не вошла в #${id}: ${res?.error || "нет ответа"}. Выданный ключ не используется — он закроется сам через 90 дней простоя.` } };
}

/** Страница по готовым данным (проверка рендера — web/test/admin-tests.test.ts). enter — мост программы на ПК или null (браузер). */
export function TestsPage({ data, enter, secret: secret0 = null, open: open0 = null }: { data: TestsData; enter: EnterTest | null; secret?: TestSecret; open?: number | null }) {
  const [items, setItems] = useState<TestAccountRow[]>(data.items);
  const [max, setMax] = useState(data.max);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState<ActNote>(null);
  const [secret, setSecret] = useState<TestSecret>(secret0);
  const [open, setOpen] = useState<number | null>(open0);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const send = useSend();
  const full = items.length >= max;

  /** Причина — от 3 знаков, как у всех действий админки (сервер проверяет то же). */
  async function run<T>(path: string, body: Record<string, unknown>): Promise<T | null> {
    if (reason.trim().length < 3) return setNote({ ok: false, text: "Напишите причину — хотя бы 3 знака." }), null;
    setBusy(true);
    setNote(null);
    const r = await send<T>(path, { ...body, reason: reason.trim() });
    setBusy(false);
    if ("err" in r) return setNote({ ok: false, text: r.err }), null;
    return r.ok;
  }
  const done = (text: string) => { setNote({ ok: true, text: `${text} Записано в журнал админа.` }); setReason(""); };

  async function create() {
    const r = await run<TestCreated>("/api/admin/tests", {});
    if (!r) return;
    setItems(r.items);
    setMax(r.max);
    setSecret({ id: r.id, login: r.login, password: r.password });
    done(r.text);
  }
  async function token(row: TestAccountRow) {
    const r = await run<{ text: string; id: number; token: string }>(`/api/admin/tests/${row.id}/token`, {});
    if (!r) return;
    setBusy(true);
    const k = await testKeyFlow(r.id, r.token, enter);
    setBusy(false);
    if (k.secret) setSecret(k.secret);
    setNote(k.note);
    setReason("");
  }
  async function reset(row: TestAccountRow) {
    if (accountQuery(typed) !== row.id) return setNote({ ok: false, text: `Наберите номер аккаунта — ${row.id}.` });
    const r = await run<TestsData & { text: string }>(`/api/admin/tests/${row.id}/reset`, { confirm: typed.trim() });
    if (!r) return;
    setItems(r.items);
    setMax(r.max);
    setOpen(null);
    setTyped("");
    if (secret?.id === row.id && secret.token) setSecret(null);
    done(r.text);
  }

  return (
    <div className="adm-al adm-ts">
      <p className="adm-muted">
        Аккаунты без Telegram для проверки программы на ПК: план «Друг» (всё бесплатно, без лимитов), в счёте людей, регистраций,
        аналитики и падений выпуска их нет; расход модели — отдельной строкой «тесты» (деньги настоящие). Утро и итог дня с ИИ — только
        если входом пользовались за сутки. Уведомления приходят в ленту и push. Не больше {max} сразу; удалить — в карточке аккаунта.
      </p>
      <section className="adm-panel adm-al-acts">
        <Reason value={reason} onChange={setReason} />
        <div className="adm-row adm-ts-create">
          <button className="adm-btn primary" disabled={busy || full || reason.trim().length < 3} onClick={() => void create()}>Создать тестовый</button>
          <span className="adm-muted adm-small adm-num">{items.length} из {max}{full ? " — удалите ненужный" : ""}</span>
        </div>
        <span className="adm-muted adm-small">
          {enter ? "Сайт открыт в программе на ПК: «Войти в программе» переключит её на тестовый, свой вход программа сохранит."
            : "Сайт открыт в браузере: ключ для программы на ПК — «Показать ключ», он виден один раз."}
        </span>
        <Note note={note} />
        {secret && <SecretBox secret={secret} onHide={() => setSecret(null)} />}
      </section>
      <section className="adm-panel">
        {items.length ? (
          <div className="adm-scroll">
            <table className="adm-table adm-al-rules adm-ts-table">
              <thead><tr><th>Аккаунт</th><th>Создан</th><th>Последний вход</th><th className="num">Входов</th><th>Состояние</th><th /></tr></thead>
              <tbody>{items.map((r) => (
                <TestRow key={r.id} row={r} acts={testActs(r, Boolean(enter))} busy={busy} open={open === r.id} typed={typed}
                  onToggle={() => { setOpen(open === r.id ? null : r.id); setTyped(""); }} onTyped={setTyped}
                  onToken={() => void token(r)} onReset={() => void reset(r)} />
              ))}</tbody>
            </table>
          </div>
        ) : <span className="adm-muted">Тестовых аккаунтов нет. Напишите причину и нажмите «Создать тестовый».</span>}
      </section>
    </div>
  );
}

function TestRow({ row: r, acts, busy, open, typed, onToggle, onTyped, onToken, onReset }: {
  row: TestAccountRow; acts: ReturnType<typeof testActs>; busy: boolean; open: boolean; typed: string;
  onToggle: () => void; onTyped: (v: string) => void; onToken: () => void; onReset: () => void;
}) {
  const typedOk = accountQuery(typed) === r.id;
  return (
    <>
      <tr>
        <td className="adm-num"><b>#{r.id}</b></td>
        <td className="adm-num"><span className="adm-ts-k">создан </span>{date(r.created_at)}</td>
        <td className="adm-num">{testSeenText(r)}</td>
        <td className="num adm-num"><span className="adm-ts-k">входов: </span>{r.sessions}</td>
        <td>{r.frozen_at ? <span className="adm-al-st bad">заморожен {ago(r.frozen_at)}</span> : <span className="adm-al-st ok">{r.plan === "friend" ? "друг" : r.plan}</span>}</td>
        <td className="adm-ts-btns">
          <div className="adm-row adm-ts-acts">
            {acts.includes("enter") && <button className="adm-btn small primary" disabled={busy} onClick={onToken}>Войти в программе на ПК</button>}
            {acts.includes("key") && <button className="adm-btn small" disabled={busy} onClick={onToken}>Показать ключ</button>}
            {acts.includes("reset") && <button className="adm-btn small danger" disabled={busy} onClick={onToggle}>{open ? "Отмена" : "Сбросить к чистому…"}</button>}
            {acts.includes("card") && <button className="adm-btn small" onClick={() => navigate(`/admin/account/${r.id}`)}>Аккаунт #{r.id}</button>}
          </div>
        </td>
      </tr>
      {open && (
        <tr className="adm-al-ch">
          <td colSpan={6}>
            <form className="adm-acc-form" onSubmit={(e) => { e.preventDefault(); onReset(); }}>
              <p className="adm-err adm-small" role="note">
                Удалятся все записи #{r.id}: дневник, планы, задачи, привычки, лента, обращения; все входы закроются (программа на ПК под
                этим ключом попросит войти). Номер, логин и пароль останутся. Отменить нельзя.
              </p>
              <input className="adm-tf-reason adm-al-reason" inputMode="numeric" autoComplete="off" placeholder={`Наберите номер аккаунта: ${r.id}`}
                aria-label="Наберите номер аккаунта" value={typed} onChange={(e) => onTyped(e.target.value)} onPaste={(e) => e.preventDefault()} />
              <div className="adm-row">
                <button type="submit" className="adm-btn danger" disabled={busy || !typedOk}>Сбросить #{r.id}</button>
                <span className="adm-muted adm-small">причина — из поля над списком</span>
              </div>
            </form>
          </td>
        </tr>
      )}
    </>
  );
}

/** Логин и пароль или ключ — один раз, с копированием. Повторно — только новой выдачей. */
function SecretBox({ secret: s, onHide }: { secret: NonNullable<TestSecret>; onHide: () => void }) {
  const rows: [string, string][] = s.token ? [["Ключ", s.token]] : [["Логин", s.login ?? ""], ["Пароль", s.password ?? ""]];
  return (
    <div className="adm-ts-secret" role="status">
      <b>{s.token ? `Ключ для программы на ПК — #${s.id}` : `Тестовый аккаунт #${s.id}`}</b>
      <span className="adm-muted adm-small">
        {s.token ? "Виден один раз — для проверки по API (заголовок Authorization: Bearer …); новая выдача даст новый ключ. В программу на ПК удобнее войти из неё самой: откройте этот раздел в программе — будет «Войти в программе на ПК»."
          : "Видны один раз — для ручного входа: «Войти под другим логином» в программе или вход на сайте."}
      </span>
      <dl className="adm-acc-facts">
        {rows.map(([k, v]) => [<dt key={`${k}t`}>{k}</dt>, <dd key={`${k}d`} className="adm-ts-val"><code className="adm-num">{v}</code><Copy value={v} /></dd>])}
      </dl>
      <div className="adm-row"><button className="adm-btn small" onClick={onHide}>Сохранил — скрыть</button></div>
    </div>
  );
}

function Copy({ value }: { value: string }) {
  const [ok, setOk] = useState<boolean | null>(null);
  const copy = () => {
    const p = navigator.clipboard?.writeText(value);
    if (!p) return setOk(false);
    p.then(() => setOk(true), () => setOk(false));
  };
  return <button type="button" className="adm-btn small" onClick={copy}>{ok === null ? "Копировать" : ok ? "Скопировано" : "Не вышло — выделите вручную"}</button>;
}
