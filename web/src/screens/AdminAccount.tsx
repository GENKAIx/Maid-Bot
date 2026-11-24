import { useContext, useEffect, useState } from "react";
import { ApiError, get, post } from "../api";
import {
  accountCan, accountIdOf, accountPlanText, accountQuery, ADMIN_ACTIONS, ago, BILLING_EVENT_NAMES, CLIENT_NAMES, PAYMENT_KINDS, starsText, usd, usedText,
  type AccountCard,
} from "../admin";
import { navigate } from "../router";
import { AdminLost, Loading } from "./AdminSections";

// «Аккаунт» (этап 3 «Тарифы и управление», 24.11.2026; макет docs/review/тарифы-и-управление-макет-2026-11-24.html, вкладка «Аккаунт»).
// Всё по номеру: карточка — только числа (тариф, срок, остаток лимитов сегодня, оплаты, журнал подписки, активность за 7 дней,
// устройства); действия — продлить, подарок, лимит на сегодня, вернуть звёзды, заморозить/разморозить, удалить. Каждое просит причину;
// сервер (server/src/admin-account.ts, возврат — POST /api/admin/refund) проверяет всё сам и пишет в журнал админа. «Удалить» (в макете
// его нет — добавлено 24.11.2026 для тестовых аккаунтов) ещё просит набрать номер аккаунта вручную; после — «Аккаунт #N удалён».

const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "numeric" }) : "—");
const dayShort = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("ru-RU", { weekday: "short", day: "numeric" });
const clientName = (c: string) => CLIENT_NAMES[c] ?? (c || "старый клиент");

type Act = "extend" | "grant" | "bonus" | "refund" | "freeze" | "unfreeze" | "delete";
const ACTS: { id: Act; title: string; hint: string; danger?: boolean }[] = [
  { id: "extend", title: "Продлить срок", hint: "добавить дни к пробе, подарку или подписке; кончившийся — от сегодня" },
  { id: "grant", title: "Выдать подарок", hint: "доступ без оплаты на срок, тариф «Подарок» (как приглашение /invite); не подписка" },
  { id: "bonus", title: "Поднять лимит на сегодня", hint: "если человек упёрся, а дело срочное; завтра — снова по тарифу" },
  { id: "refund", title: "Вернуть звёзды", hint: "последнюю оплату; доступ по подписке снимется сразу", danger: true },
  { id: "freeze", title: "Заморозить аккаунт", hint: "Рина перестаёт отвечать, входы закрываются, данные остаются", danger: true },
  { id: "unfreeze", title: "Разморозить", hint: "снова ИИ и вход; на сайте и в программе человек войдёт заново" },
  { id: "delete", title: "Удалить аккаунт", hint: "насовсем: все записи человека; оплаты остаются в отчётах без него. С того же Telegram можно зарегистрироваться заново", danger: true },
];

export function AdminAccount() {
  const [id, setId] = useState<number | null>(() => accountIdOf(window.location.pathname));
  const [q, setQ] = useState(id ? String(id) : "");
  const [card, setCard] = useState<AccountCard | null>(null);
  const [err, setErr] = useState("");
  const [gone, setGone] = useState<{ id: number; text: string } | null>(null);
  const lost = useContext(AdminLost);
  useEffect(() => {
    if (!id || gone?.id === id) return;
    let alive = true;
    setCard(null);
    setErr("");
    get<AccountCard>(`/api/admin/account/${id}`).then((c) => alive && setCard(c)).catch((e) => {
      if (!alive) return;
      if (e instanceof ApiError && e.status === 403) lost();
      else setErr(e instanceof ApiError && e.status === 404 ? `Аккаунта #${id} нет.` : (e as Error).message || "не загрузилось");
    });
    return () => { alive = false; };
  }, [id, lost, gone]);
  const find = () => {
    const n = accountQuery(q);
    if (!n) return setErr("Номер аккаунта — число, например 1042.");
    navigate(`/admin/account/${n}`, true);
    setId(n);
  };
  return (
    <div className="adm-acc">
      <form className="adm-toolbar" onSubmit={(e) => { e.preventDefault(); find(); }}>
        <input className="adm-tf-reason adm-acc-q" inputMode="numeric" placeholder="Номер, например 1042" aria-label="Номер аккаунта" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="adm-btn primary" type="submit">Найти</button>
        <span className="adm-muted adm-small">Номер — из «Пользователей» или из сообщения человека. Имён, текстов и чатов здесь нет — только числа.</span>
      </form>
      {!id ? null : gone?.id === id ? <AccountGone {...gone} /> : !card ? (err ? <span className="adm-err" role="alert">{err}</span> : <Loading />)
        : <AccountCardView card={card} onCard={setCard} onDeleted={(text) => { setCard(null); setGone({ id: card.id, text }); }} />}
    </div>
  );
}

/** Вместо карточки после удаления: номера больше нет. */
export function AccountGone({ id, text }: { id: number; text: string }) {
  return (
    <section className="adm-panel" role="status">
      <b>Аккаунт #{id} удалён</b>
      <span className="adm-muted">{text} Записано в журнал админа. С того же Telegram человек может зарегистрироваться заново (/start) — с новым номером.</span>
    </section>
  );
}

/** Карточка и действия (отдельно — для проверки рендера, web/test/admin.test.ts). */
export function AccountCardView({ card: c, onCard, onDeleted }: { card: AccountCard; onCard: (c: AccountCard) => void; onDeleted?: (text: string) => void }) {
  const t = c.today;
  const week = c.week.reduce((s, d) => ({ ai: s.ai + d.ai, manual: s.manual + d.manual, minutes: s.minutes + d.minutes, usd: s.usd + d.usd }), { ai: 0, manual: 0, minutes: 0, usd: 0 });
  return (
    <div className="adm-acc-grid">
      <section className="adm-panel">
        <div className="adm-card-head"><b className="adm-num">#{c.id}</b>{c.frozen_at && <span className="adm-acc-frozen">заморожен {date(c.frozen_at)}</span>}</div>
        <dl className="adm-acc-facts">
          <dt>Тариф</dt><dd>{accountPlanText(c)}{c.live_sub && <span className="adm-muted"> · списывается в Telegram</span>}</dd>
          <dt>С нами</dt><dd className="adm-num">с {date(c.created_at)}, {c.days_with_us} дн.</dd>
          {t ? (
            <>
              <dt>Сегодня</dt>
              <dd className="adm-num">{usedText(t.calls)} запросов · {usedText(t.draws)} картинок · {usedText(t.voice_sec, true)} голоса · {usd(t.spend_usd)} из {usd(t.cap_usd)}</dd>
            </>
          ) : <><dt>Сегодня</dt><dd className="adm-muted">{c.plan === "owner" || c.plan === "friend" ? "без лимитов" : "ИИ закрыт"}</dd></>}
          <dt>За 7 дней</dt><dd className="adm-num">{week.ai} с ИИ · {week.manual} без ИИ · {week.minutes} мин в сети · {usd(week.usd)}</dd>
          <dt>Устройства</dt>
          <dd>{c.devices.length ? c.devices.map((d) => `${clientName(d.client)}${d.version ? ` ${d.version}` : ""}${d.count > 1 ? ` ×${d.count}` : ""}`).join(", ") : <span className="adm-muted">входов нет</span>}</dd>
          <dt>Был в сети</dt><dd className="adm-num">{ago(c.last_seen)}</dd>
        </dl>
        <b className="adm-small">Активность по дням</b>
        <table className="adm-table adm-acc-week">
          <thead><tr><th>День</th><th className="num">С ИИ</th><th className="num">Без ИИ</th><th className="num">Мин</th><th className="num">Вызовов</th><th className="num">$</th></tr></thead>
          <tbody>{c.week.map((d) => (
            <tr key={d.day}><td>{dayShort(d.day)}</td><td className="num adm-num">{d.ai}</td><td className="num adm-num">{d.manual}</td><td className="num adm-num">{d.minutes}</td><td className="num adm-num">{d.calls}</td><td className="num adm-num">{usd(d.usd)}</td></tr>
          ))}</tbody>
        </table>
        <p className="adm-muted adm-small">Сообщения и минуты — по дню человека, вызовы и деньги — по дню UTC.</p>
      </section>
      <Actions card={c} onCard={onCard} onDeleted={onDeleted} />
      <section className="adm-panel">
        <b>Оплаты</b>
        {c.payments.length ? (
          <table className="adm-table">
            <thead><tr><th>Когда</th><th>Вид</th><th className="num">Сумма</th><th>До</th><th>Платёж</th><th>Возврат</th></tr></thead>
            <tbody>{c.payments.map((p) => (
              <tr key={p.charge + p.paid_at}>
                <td className="adm-num">{date(p.paid_at)}</td><td>{PAYMENT_KINDS[p.kind] ?? p.kind}</td><td className="num adm-num">{starsText(p.amount, p.currency)}</td>
                <td className="adm-num">{date(p.expires_at)}</td><td className="adm-muted adm-num">{p.charge}</td>
                <td>{p.refunded_at ? <span className="adm-muted">{date(p.refunded_at)}</span> : p.refundable ? "можно" : "—"}</td>
              </tr>
            ))}</tbody>
          </table>
        ) : <span className="adm-muted">Оплат не было.</span>}
        <b>Журнал подписки</b>
        {c.events.length ? (
          <table className="adm-table">
            <tbody>{c.events.map((e, i) => (
              <tr key={i}><td className="adm-num">{date(e.at)}</td><td>{BILLING_EVENT_NAMES[e.kind] ?? e.kind}</td><td className="num adm-num">{e.amount != null ? starsText(e.amount) : ""}</td></tr>
            ))}</tbody>
          </table>
        ) : <span className="adm-muted">Событий нет.</span>}
        <b>Действия админа с этим аккаунтом</b>
        {c.log.length ? (
          <table className="adm-table">
            <tbody>{c.log.map((r, i) => (
              <tr key={i}><td className="adm-num">{date(r.at)}</td><td className="adm-num">{r.who}</td><td>{ADMIN_ACTIONS[r.action] ?? r.action}<div className="adm-muted adm-small">{r.detail}</div></td><td>{r.reason}</td></tr>
            ))}</tbody>
          </table>
        ) : <span className="adm-muted">Пока ничего.</span>}
      </section>
    </div>
  );
}

/** Действия карточки; open — какое раскрыто сразу (проверка рендера диалога, web/test/admin.test.ts). */
export function Actions({ card: c, onCard, onDeleted, open: open0 = null }: { card: AccountCard; onCard: (c: AccountCard) => void; onDeleted?: (text: string) => void; open?: Act | null }) {
  const [open, setOpen] = useState<Act | null>(open0);
  const [days, setDays] = useState("7");
  const [n, setN] = useState("20");
  const [what, setWhat] = useState<"calls" | "draws" | "voice_min">("calls");
  const [reason, setReason] = useState("");
  const [typed, setTyped] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const lost = useContext(AdminLost);
  const can = { ...accountCan(c), refund: c.payments.some((p) => p.refundable) };
  const pay = c.payments.find((p) => p.refundable);
  const toggle = (a: Act) => { setOpen(open === a ? null : a); setReason(""); setTyped(""); setNote(null); setDays(a === "grant" ? "30" : "7"); };
  /** «Удалить»: номер набран вручную и совпал («1042» или «#1042»). */
  const typedOk = accountQuery(typed) === c.id;
  async function run(a: Act) {
    if (reason.trim().length < 3) return setNote({ ok: false, text: "Напишите причину — хотя бы 3 знака." });
    if (a === "refund" && pay && !confirm(`Вернуть ${starsText(pay.amount, pay.currency)} аккаунту #${c.id}? Доступ по подписке снимется сразу.`)) return;
    if (a === "freeze" && !confirm(`Заморозить #${c.id}? Входы закроются, Рина перестанет отвечать. Данные останутся.`)) return;
    if (a === "delete" && !typedOk) return setNote({ ok: false, text: `Наберите номер аккаунта — ${c.id}.` });
    setBusy(true);
    setNote(null);
    try {
      if (a === "refund") {
        const r = await post<{ text: string }>("/api/admin/refund", { user_id: c.id, charge: pay?.charge, reason });
        onCard(await get<AccountCard>(`/api/admin/account/${c.id}`));
        setNote({ ok: true, text: r.text });
      } else {
        const body = a === "extend" || a === "grant" ? { days: Number(days), reason } : a === "bonus" ? { what, n: Number(n), reason }
          : a === "delete" ? { reason, confirm: typed.trim() } : { reason };
        const r = await post<{ text: string; card: AccountCard | null }>(`/api/admin/account/${c.id}/${a}`, body);
        if (a === "delete" || !r.card) return onDeleted?.(r.text);
        onCard(r.card);
        setNote({ ok: true, text: `${r.text} Записано в журнал админа.` });
      }
      setOpen(null);
      setReason("");
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) lost();
      else setNote({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="adm-panel">
      <b>Действия</b>
      <span className="adm-muted adm-small">Каждое просит причину и попадает в журнал админа. О продлении, подарке, лимите, заморозке и удалении Рина пишет человеку.</span>
      <div className="adm-acc-acts">
        {ACTS.filter((a) => (a.id === "unfreeze" ? can.unfreeze : a.id !== "freeze" || !c.frozen_at)).map((a) => (
          <div key={a.id} className="adm-acc-act">
            <div className="adm-acc-row">
              <span>{a.title}<em>{a.id === "refund" && pay ? `${starsText(pay.amount, pay.currency)} от ${date(pay.paid_at)} (${pay.charge}); доступ сразу закончится`
                : a.id === "delete" && !can.delete ? "владельца и админа удалить нельзя" : a.hint}</em></span>
              <button className={`adm-btn small ${a.danger ? "danger" : ""}`} disabled={!can[a.id] || busy} onClick={() => toggle(a.id)}
                title={can[a.id] ? undefined : a.id === "delete" ? "Владельца и админа удалить нельзя" : "Для этого аккаунта недоступно"}>{open === a.id ? "Отмена" : `${a.title.split(" ")[0]}…`}</button>
            </div>
            {open === a.id && (
              <form className="adm-acc-form" onSubmit={(e) => { e.preventDefault(); void run(a.id); }}>
                {(a.id === "extend" || a.id === "grant") && (
                  <label className="adm-acc-num">Дней <input type="number" min={1} max={365} value={days} onChange={(e) => setDays(e.target.value)} aria-label="Дней" /></label>
                )}
                {a.id === "extend" && c.live_sub && (
                  <p className="adm-muted adm-small">
                    Это оплаченная подписка: срок сдвинется, но Telegram спишет звёзды в свой день, как раньше. После его продления срок станет
                    концом оплаченного месяца — добавленные дни поверх оплаты не складываются. Если человек отменит продление, дни останутся.
                  </p>
                )}
                {a.id === "grant" && <p className="adm-muted adm-small">Подарок — не подписка: звёзды не списываются, лимиты — тарифа «Подарок».</p>}
                {a.id === "bonus" && (
                  <div className="adm-row">
                    <label className="adm-acc-num">+ <input type="number" min={1} value={n} onChange={(e) => setN(e.target.value)} aria-label="Сколько" /></label>
                    <select className="adm-tf-reason" value={what} onChange={(e) => setWhat(e.target.value as typeof what)} aria-label="Чего">
                      <option value="calls">запросов</option><option value="draws">картинок</option><option value="voice_min">минут голоса</option>
                    </select>
                    <span className="adm-muted adm-small">только на сегодня по поясу человека{c.today ? ` (до ${new Date(c.today.resets_at).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })})` : ""}</span>
                  </div>
                )}
                {a.id === "freeze" && c.live_sub && <p className="adm-muted adm-small">Продление подписки Telegram при заморозке отменится — звёзды больше не спишутся; оплаченный срок останется. После разморозки человек возобновит его сам (/resume_sub).</p>}
                {a.id === "delete" && (
                  <p className="adm-err adm-small" role="note">
                    Отменить нельзя — вернуть можно только из ночной копии базы. Удалятся все записи #{c.id}: дневник, планы, задачи, привычки,
                    входы, лента, обращения. Оплаты и расход останутся в отчётах — без человека.{c.live_sub ? " Продление подписки Telegram отменится." : ""}
                  </p>
                )}
                <input className="adm-tf-reason" placeholder="Причина (обязательно): например, «сбой оплаты 24.11»" aria-label="Причина" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
                {a.id === "delete" && (
                  <input className="adm-tf-reason" inputMode="numeric" autoComplete="off" placeholder={`Наберите номер аккаунта: ${c.id}`} aria-label="Наберите номер аккаунта"
                    value={typed} onChange={(e) => setTyped(e.target.value)} onPaste={(e) => e.preventDefault()} />
                )}
                <div className="adm-row">
                  <button type="submit" className={`adm-btn ${a.danger ? "danger" : "primary"}`} disabled={busy || reason.trim().length < 3 || (a.id === "delete" && !typedOk)}>
                    {a.id === "delete" ? "Удалить навсегда" : "Подтвердить"}
                  </button>
                </div>
              </form>
            )}
          </div>
        ))}
      </div>
      {note && <p className={note.ok ? "adm-muted" : "adm-err"} role={note.ok ? "status" : "alert"}>{note.text}</p>}
    </section>
  );
}
