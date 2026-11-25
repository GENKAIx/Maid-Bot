import { useContext, useState } from "react";
import { ApiError, post } from "../api";
import { numText, openRouterDiffText, openRouterStatus, usd, type OpenRouterData } from "../admin";
import { AnaLegend, AnaLine, ANA_C, type AnaSeries } from "../adminCharts";
import { AdminLost, Loading, useAdmin } from "./AdminSections";

// «Счёт OpenRouter» в разделе «Расходы на модель»: расход так, как его считает сам OpenRouter (как openrouter.ai/activity), рядом с
// нашими записями (llm_usage, usage.cost из ответов). Данные — GET /api/admin/openrouter (server/src/openrouter-bill.ts): сервер
// загружает счёт управляющим ключом раз в час; «Обновить» — с причиной, в журнал админа, не чаще раза в минуту. Людей тут нет.

const dt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");
const dayLabel = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("ru-RU", { day: "numeric", month: "short", timeZone: "UTC" });
/** Токены коротко: 950, 12,5 тыс., 3,2 млн. */
export const tokText = (v: number) => (v < 1000 ? numText(v) : v < 1e6 ? `${numText(v / 1000, v < 1e4 ? 1 : 0)} тыс.` : `${numText(v / 1e6, 1)} млн`);

export type OrNote = { ok: boolean; text: string } | null;

/** Блок с загрузкой (в AdminSpend). После «Обновить» — свежие данные из ответа кнопки. */
export function AdminOpenRouter() {
  const [fresh, setFresh] = useState<OpenRouterData | null>(null);
  const [note, setNote] = useState<OrNote>(null);
  const [data, err] = useAdmin<OpenRouterData>("/api/admin/openrouter");
  const d = fresh ?? data;
  if (!d) return <section className="adm-panel"><h2 className="adm-h2">Счёт OpenRouter</h2><Loading err={err} /></section>;
  return <OpenRouterPanel data={d} onFresh={setFresh} note={note} setNote={setNote} />;
}

/** Сам блок по готовым данным (тест рисует его без сети: web/test/admin-openrouter.test.ts). */
export function OpenRouterPanel({ data, onFresh, note, setNote }: { data: OpenRouterData; onFresh: (d: OpenRouterData) => void; note: OrNote; setNote: (n: OrNote) => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const lost = useContext(AdminLost);
  const st = openRouterStatus(data);
  async function refresh() {
    if (reason.trim().length < 3) return setNote({ ok: false, text: "Напишите причину — хотя бы 3 знака." });
    setBusy(true);
    setNote(null);
    try {
      const r = await post<OpenRouterData>("/api/admin/openrouter/refresh", { reason: reason.trim() });
      onFresh(r);
      setReason("");
      const s = openRouterStatus(r);
      setNote({ ok: r.status === "ok", text: `${r.status === "ok" ? "Обновлено" : `Не обновилось: ${s.text}`}. Записано в журнал админа.` });
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) lost();
      setNote({ ok: false, text: (e as Error).message || "не вышло" });
    } finally {
      setBusy(false);
    }
  }
  const known = data.days.filter((x) => x.bill != null);
  const hasBill = known.length > 0 && (data.ok_at != null);
  const series: AnaSeries[] = [
    { name: "По счёту OpenRouter", color: ANA_C.c1, values: data.days.map((x) => x.bill), area: true },
    { name: "По нашим записям", color: ANA_C.c3, values: data.days.map((x) => x.ours), dash: true },
  ];
  const flagged = data.days.filter((x) => x.flag).length;
  // Баланс и «потрачено» загружаются отдельными запросами: не ответили — остаются прошлые цифры, показываем, на когда они.
  const older = (at: string | null) => at != null && data.ok_at != null && Date.parse(at) < Date.parse(data.ok_at);
  const sp = data.spent;
  const spentAt = older(data.spent_at) ? `не обновилось, данные на ${dt(data.spent_at)}` : `на ${dt(data.spent_at)}`;
  const spentMiss = sp?.missing ? ` · не ответило ключей: ${sp.missing}` : "";
  const spentKpi = (label: string, v: number | null | undefined, period: string) => (
    <div className={`adm-kpi ${sp && (v == null || older(data.spent_at) || sp.missing) ? "warn" : ""}`}><span>{label}</span>
      <b className="adm-num">{sp && v != null ? usd(v) : "—"}</b>
      <i>{!sp ? "нет данных по ключам сервера" : v == null ? `устарело: данные на ${dt(data.spent_at)}, ${period} уже другой` : `по ${sp.keys === 1 ? "ключу" : "ключам"} сервера, ${period} · ${spentAt}${spentMiss}`}</i></div>
  );
  const rows = [...data.days].reverse();
  return (
    <section className="adm-panel adm-or">
      <h2 className="adm-h2">Счёт OpenRouter <span className="adm-muted">· как считает сам OpenRouter (openrouter.ai/activity), дни UTC</span></h2>
      <p className="adm-or-status">
        <span className={`adm-al-st ${st.tone}`}>{st.text}</span>
        <span className="adm-muted adm-small"> · проверено {dt(data.checked_at)} · последняя удачная загрузка {dt(data.ok_at)} · сам — раз в {data.every_min} мин.</span>
      </p>
      <div className="adm-kpis">
        <div className={`adm-kpi ${data.credits && older(data.credits_at) ? "warn" : ""}`}><span>Остаток кредитов</span><b className="adm-num">{data.credits ? usd(data.credits.left) : "—"}</b>
          <i>{data.credits ? `куплено ${usd(data.credits.total)}, потрачено ${usd(data.credits.used)} · ${older(data.credits_at) ? "не обновилось, данные" : ""} на ${dt(data.credits_at)}` : "нет данных"}</i></div>
        {spentKpi("Сегодня", sp?.daily, "день UTC")}
        {spentKpi("Эта неделя", sp?.weekly, "неделя пн–вс UTC")}
        {spentKpi("Этот месяц", sp?.monthly, "месяц с 1-го числа UTC")}
        <div className={`adm-kpi ${flagged ? "warn" : ""}`}><span>За 30 дн. по счёту</span><b className="adm-num">{hasBill ? usd(data.total.bill) : "—"}</b>
          <i>{hasBill ? `весь аккаунт OpenRouter · наши записи ${usd(data.total.ours)} · дней с расхождением: ${flagged}` : "счёт ещё не загружен"}</i></div>
      </div>
      <div className="adm-al-acts">
        <input className="adm-tf-reason adm-al-reason" placeholder="Причина (обязательно): например, «сверка перед оплатой»" aria-label="Причина" maxLength={300}
          value={reason} onChange={(e) => setReason(e.target.value)} />
        <div className="adm-row">
          <button className="adm-btn" disabled={busy || !data.has_key} onClick={() => void refresh()}>{busy ? "Обновляю…" : "Обновить"}</button>
          <span className="adm-muted adm-small">не чаще раза в {data.gap_s} с</span>
        </div>
        {note && <p className={note.ok ? "adm-muted" : "adm-err"} role={note.ok ? "status" : "alert"}>{note.text}</p>}
      </div>

      {hasBill ? (
        <>
          <h3 className="adm-h3">Расход по дням</h3>
          <AnaLine labels={data.days.map((x) => dayLabel(x.day))} series={series} fmt={usd} axis={usd} height={190} label="Расход по дням: счёт OpenRouter и наши записи" />
          <AnaLegend items={series} />

          <h3 className="adm-h3">По моделям за 30 дней</h3>
          {data.models.length ? (
            <div className="adm-scroll">
              <table className="adm-table">
                <thead><tr><th>Модель</th><th>Провайдер</th><th className="num">Деньги</th><th className="num">Запросов</th><th className="num">Токены вход</th><th className="num">Токены выход</th><th className="num">Доля</th></tr></thead>
                <tbody>{data.models.map((m) => (
                  <tr key={m.model}>
                    <td>{m.model}</td><td className="adm-small">{m.providers.join(", ") || "—"}</td>
                    <td className="num adm-num">{usd(m.cost)}{m.byok ? <div className="adm-muted adm-small">свои ключи {usd(m.byok)}</div> : null}</td>
                    <td className="num adm-num">{numText(m.requests)}</td><td className="num adm-num">{tokText(m.prompt)}</td>
                    <td className="num adm-num">{tokText(m.completion)}{m.reasoning ? <div className="adm-muted adm-small">рассуждения {tokText(m.reasoning)}</div> : null}</td>
                    <td className="num adm-num">{numText(m.share * 100, 1)}%</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          ) : <span className="adm-muted">За 30 дней OpenRouter расхода не видел.</span>}
        </>
      ) : (
        <p className="adm-muted">Данных счёта пока нет: {data.status === "ok" ? "OpenRouter не прислал строк." : st.text}.</p>
      )}

      <h3 className="adm-h3">Сверка по дням <span className="adm-muted adm-small">· подсвечено, где разница больше {Math.round(data.share * 100)}% и больше {usd(data.usd)}</span></h3>
      <div className="adm-scroll">
        <table className="adm-table adm-or-days">
          <thead><tr><th>День (UTC)</th><th className="num">По счёту OpenRouter</th><th className="num">По нашим записям</th><th className="num">Разница</th><th>Заметка</th></tr></thead>
          <tbody>{rows.map((x) => (
            <tr key={x.day} className={x.flag ? "adm-or-flag" : ""}>
              <td className="adm-num">{dayLabel(x.day)}</td>
              <td className="num adm-num">{x.bill == null ? "—" : usd(x.bill)}{x.byok ? <div className="adm-muted adm-small">свои ключи {usd(x.byok)}</div> : null}</td>
              <td className="num adm-num">{usd(x.ours)}<div className="adm-muted adm-small">{x.ours_calls} запр.{x.ours_unpriced ? `, без цены ${x.ours_unpriced}` : ""}</div></td>
              <td className="num adm-num">{openRouterDiffText(x)}</td>
              <td className="adm-small">{x.today ? "сегодня — OpenRouter считает только завершённые дни" : x.bill == null ? "нет данных OpenRouter" : x.flag ? "расхождение" : ""}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <p className="adm-muted adm-small">
        Почему суммы расходятся. Счёт OpenRouter (по дням, за 30 дней, график, модели) — по всему аккаунту, все его ключи, в том числе
        ваши личные и тестовые (ручные пробы, локальные прогоны, другие проекты); наши записи — только этот сервер. «Сегодня / неделя /
        месяц» — только по ключам сервера. Наши записи — цена из каждого ответа модели (usage.cost), дни тоже по UTC. Разница бывает, когда: часть
        запросов идёт по своим ключам провайдеров (BYOK) — OpenRouter пишет их отдельно, «свои ключи»; рисование (RunPod) или голос
        (другой сервис распознавания) идут мимо OpenRouter — они есть только у нас; запрос оборвался или упал, а OpenRouter его всё
        равно посчитал (или наоборот — провайдер не сообщил цену, такие у нас «без цены» и считаются нулём); у OpenRouter учёт
        запаздывает — сегодняшнего дня в счёте нет, а вчерашний может досчитаться позже.
      </p>
    </section>
  );
}
