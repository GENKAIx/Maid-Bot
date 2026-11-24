import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { ApiError, get } from "../api";
import {
  AI_GROUP_NAMES, aiGroupOf, analyticsDelta, analyticsFixStep, analyticsStepOk, analyticsTab, ANALYTICS_COLLECT_SINCE, ANALYTICS_DAYS,
  ANALYTICS_NOTE_TEXT, ANALYTICS_REFRESH_MS, ANALYTICS_REPORTS, csvFileName, dayText, deltaText, DIST_NAMES, microText, msText, numText,
  PARSE_KIND_NAMES, seriesCsv, shareText, SOURCE_NAMES, sparkPoints, toCsv, bucketLabel,
  type ActData, type AiData, type AiGroup, type AnalyticsDays, type AnalyticsMeta, type AnalyticsNote, type AnalyticsReportId,
  type AnalyticsResponse, type AnalyticsStep, type FeatData, type MoneyData, type Pair, type ParseData, type ParseKind,
  type RetData, type SubsData,
} from "../admin";
import { AnaCohort, AnaHBars, AnaHeat, AnaLegend, AnaLine, AnaStack, ANA_C, ANA_ORDER } from "../adminCharts";
import { navigate, usePath } from "../router";
import { AdminLost, Loading } from "./AdminSections";

// Раздел «Аналитика» админки (этап 5, 24.11.2026): отчёты /admin/analytics/<отчёт> по макету docs/review/аналитика-макет-2026-11-24.html.
// Данные — GET /api/admin/analytics?report&days&step (server/src/admin-analytics.ts, кэш 60 с); здесь только рисуем: стрелки, проценты,
// подписи корзин и CSV считаются из готового ответа. Свой кусок (lazy в Admin.tsx): графики не попадают в основной кусок админки.
// Без имён и текстов: люди — номером аккаунта.

const PREFS_KEY = "maid.adminAnalytics";
type Prefs = { days: AnalyticsDays; step: AnalyticsStep };

function readPrefs(): Prefs {
  try {
    const s = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<Prefs>;
    const days = ANALYTICS_DAYS.includes(s.days as AnalyticsDays) ? (s.days as AnalyticsDays) : 30;
    const step = s.step === "h" || s.step === "d" || s.step === "w" ? s.step : "d";
    return { days, step: analyticsFixStep(days, step) };
  } catch {
    return { days: 30, step: "d" };
  }
}
function savePrefs(p: Prefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* приватный режим — без запоминания */ }
}

/** Ответ отчёта. Прошлый ответ держится, пока идёт новый (busy); 403 — вход кончился (AdminLost).
 *  Опрос раз в ANALYTICS_REFRESH_MS, только пока раздел открыт и вкладка браузера видна; вернулись на вкладку — сразу, если прошла минута. */
export function useAnalytics(report: AnalyticsReportId | null, days: AnalyticsDays, step: AnalyticsStep) {
  const lost = useContext(AdminLost);
  const [res, setRes] = useState<AnalyticsResponse | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!report) return;
    let alive = true, seq = 0, last = 0;
    const load = () => {
      const my = ++seq;
      last = Date.now();
      setBusy(true);
      get<AnalyticsResponse>(`/api/admin/analytics?report=${report}&days=${days}&step=${step}`)
        .then((x) => { if (alive && my === seq) { setRes(x); setErr(""); } })
        .catch((e) => {
          if (!alive || my !== seq) return;
          if (e instanceof ApiError && e.status === 403) lost();
          else setErr((e as Error).message || "не загрузилось");
        })
        .finally(() => { if (alive && my === seq) setBusy(false); });
    };
    load();
    const visible = () => document.visibilityState === "visible";
    const timer = setInterval(() => { if (visible()) load(); }, ANALYTICS_REFRESH_MS);
    const onVis = () => { if (visible() && Date.now() - last >= ANALYTICS_REFRESH_MS) load(); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [report, days, step, lost]);
  return { res, err, busy };
}

const DAYS_SHORT: Record<AnalyticsDays, string> = { 1: "24 ч", 7: "7 дн.", 30: "30 дн.", 90: "90 дн.", 365: "12 мес." };
const DAYS_LONG: Record<AnalyticsDays, string> = { 1: "24 ч", 7: "7 дней", 30: "30 дней", 90: "90 дней", 365: "12 месяцев" };
const STEP_SHORT: Record<AnalyticsStep, string> = { h: "Час", d: "День", w: "Неделя" };
const STEP_LONG: Record<AnalyticsStep, string> = { h: "час", d: "календарный день", w: "неделя" };

export function AdminAnalytics() {
  const path = usePath();
  const tab = analyticsTab(path.split("/")[3]);
  const [prefs, setPrefs] = useState(readPrefs);
  const item = ANALYTICS_REPORTS.flatMap((g) => g.items).find((x) => x.id === tab)!;
  const report = item.stub ? null : (tab as AnalyticsReportId);
  const { res, err, busy } = useAnalytics(report, prefs.days, prefs.step);
  const set = (p: Prefs) => { const q = { days: p.days, step: analyticsFixStep(p.days, p.step) }; setPrefs(q); savePrefs(q); };
  const mine = res && res.report === report ? res : null;
  return (
    <div className="ana-layout">
      <nav className="ana-sub" aria-label="Отчёты">
        {ANALYTICS_REPORTS.map((g) => [
          <small key={g.group}>{g.group}</small>,
          ...g.items.map((it) => (
            <a key={it.id} href={`/admin/analytics/${it.id}`} className={it.id === tab ? "on" : ""}
              onClick={(e) => { e.preventDefault(); navigate(`/admin/analytics/${it.id}`, true); }}>{it.title}</a>
          )),
        ])}
      </nav>
      <div className="ana-content">
        <section className="ana-card ana-params" aria-label="Параметры отчёта">
          <div>
            <span className="ana-lbl">Интервал</span>
            <div className="ana-seg">
              {ANALYTICS_DAYS.map((d) => <button key={d} className={prefs.days === d ? "on" : ""} aria-pressed={prefs.days === d} onClick={() => set({ days: d, step: prefs.step })}>{DAYS_SHORT[d]}</button>)}
            </div>
          </div>
          <div>
            <span className="ana-lbl">Шаг графиков</span>
            <div className="ana-seg">
              {(["h", "d", "w"] as AnalyticsStep[]).map((s) => (
                <button key={s} className={prefs.step === s ? "on" : ""} aria-pressed={prefs.step === s} disabled={!analyticsStepOk(prefs.days, s)}
                  onClick={() => set({ days: prefs.days, step: s })}>{STEP_SHORT[s]}</button>
              ))}
            </div>
          </div>
          <MetaLine meta={mine?.meta ?? null} days={prefs.days} step={prefs.step} busy={busy && !!mine} />
        </section>
        {item.stub ? <AnaStub title={item.title} />
          : !mine ? <Loading err={err} />
          : <>
            {err && <span className="adm-err" role="alert">Не обновилось: {err}</span>}
            <AnaReport res={mine} />
          </>}
      </div>
    </div>
  );
}

function MetaLine({ meta, days, step, busy }: { meta: AnalyticsMeta | null; days: AnalyticsDays; step: AnalyticsStep; busy: boolean }) {
  const at = meta ? new Date(meta.generated_at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }) : "";
  return (
    <div className="ana-meta">
      <span><b>{DAYS_LONG[days]}</b>{meta && <> до {dayText(meta.today)}, {at}</>}</span>
      <span>Шаг графиков: <b>{STEP_LONG[step]}</b></span>
      <span>Сравнение: <b>{days === 1 ? "прошлые 24 ч" : `прошлые ${days} дн.`}</b></span>
      <span>Обновление каждые 60 с</span>
      {meta && (meta.zone === "user"
        ? <span>Пояс: <b>каждого человека</b> (деньги — UTC)</span>
        : <span>Пояс: <b>UTC</b> (деньги)</span>)}
      {busy && <span className="ana-busy">обновляется…</span>}
    </div>
  );
}

function AnaStub({ title }: { title: string }) {
  return (
    <div className="adm-soon">
      <b>{title}</b>
      <span className="adm-muted">Копим данные с {dayText(ANALYTICS_COLLECT_SINCE, true)} — отчёт появится на этапе 2.</span>
    </div>
  );
}

/** Отчёт по готовому ответу (без запросов) — его же проверяет web/test/analytics.test.ts. */
export function AnaReport({ res }: { res: AnalyticsResponse }) {
  const labels = res.meta.buckets.map((b) => bucketLabel(b, res.meta.step));
  const p = { meta: res.meta, labels };
  return (
    <MetaCtx.Provider value={res.meta}>
      <div className="ana-view">
        {res.report === "money" ? <MoneyView {...p} d={res.data} />
          : res.report === "subs" ? <SubsView {...p} d={res.data} />
          : res.report === "ai" ? <AiView {...p} d={res.data} />
          : res.report === "act" ? <ActView {...p} d={res.data} />
          : res.report === "ret" ? <RetView {...p} d={res.data} />
          : res.report === "feat" ? <FeatView {...p} d={res.data} />
          : <ParseView {...p} d={res.data} />}
      </div>
    </MetaCtx.Provider>
  );
}

// ——— общие куски
const MetaCtx = createContext<AnalyticsMeta | null>(null);
type ViewProps<T> = { meta: AnalyticsMeta; labels: string[]; d: T };

function saveFile(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Кнопка выгрузки: файл собирается из уже полученного ответа, нового запроса нет. */
function CsvBtn({ table, label = "CSV", make }: { table: string; label?: string; make: () => string }) {
  const meta = useContext(MetaCtx);
  if (!meta) return null;
  return <button className="adm-btn small ana-csv" onClick={() => saveFile(csvFileName(meta.report, table, meta.days, meta.today), make())}>{label}</button>;
}

/** Как писать число в подсказке стрелки — тем же форматом, что значение карточки (micro$ → «$1,23», доля → «12%», мс → «2.1 с»). */
type Fmt = (v: number | null) => string;
const starsText: Fmt = (v) => (v == null ? "—" : `${numText(v, 1)} ⭐`);

function Delta({ pair, inverse, fmt }: { pair: Pair; inverse?: boolean; fmt?: Fmt }) {
  const d = analyticsDelta(pair.cur, pair.prev);
  const prev = `прошлый период: ${fmt ? fmt(pair.prev) : numText(pair.prev, 2)}`;
  if (d == null) return <span className="ana-dl flat" title={pair.prev == null ? "нет прошлого периода" : prev}>—</span>;
  const good = inverse ? d < 0 : d > 0;
  return <span className={`ana-dl ${d > 0 ? "up" : "down"} ${good ? "good" : "bad"}`} title={prev}>{deltaText(d)}</span>;
}

function Kpi({ title, value, hint, pair, inverse, fmt }: { title: string; value: ReactNode; hint?: ReactNode; pair?: Pair; inverse?: boolean; fmt?: Fmt }) {
  return (
    <div className="ana-kpi">
      <span className="ana-k">{title}</span>
      <div className="ana-row"><span className="ana-v">{value}</span>{pair && <Delta pair={pair} inverse={inverse} fmt={fmt} />}</div>
      {hint && <span className="ana-h">{hint}</span>}
    </div>
  );
}

const Stars = ({ v, digits = 0 }: { v: number | null; digits?: number }) =>
  v == null ? <>—</> : <>{numText(v, digits)} <span className="ana-st">⭐</span></>;

function Block({ title, desc, children }: { title: string; desc: string; children: ReactNode }) {
  return <section className="ana-block"><header><h2>{title}</h2><p className="ana-d">{desc}</p></header>{children}</section>;
}

/** Карточка; cols — ряды графика для кнопки «Ряды» (CSV по корзинам); notes — какие сноски meta.notes показать под ней. */
function Card({ title, desc, children, cols, table, notes, extra }: {
  title: string; desc: string; children: ReactNode; cols?: { name: string; values: (number | null)[] }[]; table?: string;
  notes?: AnalyticsNote[]; extra?: ReactNode;
}) {
  const meta = useContext(MetaCtx);
  return (
    <div className="ana-card">
      <div className="ana-card-head">
        <h3>{title}</h3>
        <span className="ana-card-btns">{extra}{cols && meta && <CsvBtn table={table ?? "series"} label="Ряды" make={() => seriesCsv(meta.buckets, cols)} />}</span>
      </div>
      <p className="ana-d">{desc}</p>
      {children}
      {notes && <Notes only={notes} />}
    </div>
  );
}

function Notes({ only }: { only: AnalyticsNote[] }) {
  const meta = useContext(MetaCtx);
  const list = (meta?.notes ?? []).filter((n) => only.includes(n));
  if (!list.length) return null;
  return <p className="ana-notes">{list.map((n) => <span key={n}>* {ANALYTICS_NOTE_TEXT[n]}</span>)}</p>;
}

function Defs({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <details className="ana-defs">
      <summary>Как считаются цифры</summary>
      <dl>{rows.map(([t, d]) => [<dt key={`t${t}`}>{t}</dt>, <dd key={`d${t}`}>{d}</dd>])}</dl>
    </details>
  );
}

const starFmt = (v: number) => `${numText(v)} ⭐`;
const starFmt1 = (v: number) => `${numText(v, 1)} ⭐`;
const cnt = (v: number) => numText(v, 1);
const ACTIVE_DEF = "Хоть одно действие в день по своему поясу: сообщение с ИИ в любом клиенте, отметка привычки или задачи кнопкой (бот, сайт, push, виджет Telegram), правка мышью — или минута, когда программа, сайт или айфон были открыты. Поправки к ответам, импорт прошлого и авто-«пропуск» планировщика не в счёт.";

// ——— Деньги: обзор
function MoneyView({ meta, labels, d }: ViewProps<MoneyData>) {
  const k = d.kpi, s = d.series;
  const rate = numText(meta.star_usd, 3);
  return (
    <>
      <Defs rows={[
        ["Выручка", `Сумма Stars по успешным оплатам за интервал (подписка + разовые покупки), минус возвраты. В долларах — по курсу ~${rate} $ за ⭐ (STAR_USD в настройке сервера).`],
        ["Маржа", "Выручка в $ минус расход на ИИ в $ за тот же интервал. Сервер и домен сюда не входят — это постоянные траты."],
        ["ARPU", "Выручка ÷ активные за интервал (хоть одно действие: сообщение, отметка кнопкой или открытая программа)."],
        ["ARPPU", "Выручка ÷ платившие за интервал (возвращённые оплаты не в счёт)."],
        ["LTV", "Сколько в среднем принёс платящий за всё время до конца интервала."],
        ["Средний чек", "Сумма оплат за интервал без вычета возвратов ÷ число этих оплат."],
        ["Расход на активного", "Сколько стоит ИИ на одного активного человека. Если он выше ARPU — каждый новый человек в минус."],
        ["Дни", "Деньги — по UTC. Активные в денежной корзине — люди, у которых по их поясу был активный день с тем же числом (допущение)."],
      ]} />
      <Block title="Деньги" desc="Доход в Stars и главный расход — ИИ. Стрелка — изменение к прошлому периоду той же длины.">
        <div className="ana-kpis">
          <Kpi title="Выручка" pair={k.revenue_stars} fmt={starsText} value={<Stars v={k.revenue_stars.cur} />}
            hint={`≈ ${microText(k.revenue_micro.cur)} · подписка ${numText(k.revenue_sub_stars.cur)} ⭐ · разовые ${numText(k.revenue_once_stars.cur)} ⭐${k.refunds_stars.cur ? ` · возвраты ${numText(k.refunds_stars.cur)} ⭐` : ""}`} />
          <Kpi title="Расход на ИИ" pair={k.ai_micro} fmt={microText} inverse value={microText(k.ai_micro.cur)} hint="разбор, разговор, картинки, голос, сводки" />
          <Kpi title="Маржа" pair={k.margin_micro} fmt={microText} value={microText(k.margin_micro.cur)} hint="выручка минус ИИ" />
          <Kpi title="ARPU" pair={k.arpu_stars} fmt={starsText} value={<Stars v={k.arpu_stars.cur} digits={1} />} hint={`на одного активного (${numText(k.active.cur)} чел.)`} />
          <Kpi title="ARPPU" pair={k.arppu_stars} fmt={starsText} value={<Stars v={k.arppu_stars.cur} />} hint={`на одного платившего (${numText(k.payers.cur)} чел.)`} />
          <Kpi title="LTV" pair={k.ltv_stars} fmt={starsText} value={<Stars v={k.ltv_stars.cur} />} hint="в среднем от платящего за всё время" />
          <Kpi title="Средний чек" pair={k.avg_check_stars} fmt={starsText} value={<Stars v={k.avg_check_stars.cur} />} hint={`на одну успешную оплату (${numText(k.payments.cur)} оплат)`} />
          <Kpi title="ИИ на активного" pair={k.ai_per_active_micro} fmt={microText} inverse value={microText(k.ai_per_active_micro.cur)} hint="за интервал; лимит в настройке" />
        </div>
        <Notes only={["prev_before_data", "hour_from_calls"]} />
      </Block>
      <div className="ana-grid2">
        <Card title="Выручка во времени" desc="Подписка и разовые покупки стопкой, возвраты — вниз от нуля. Сумма за интервал совпадает с карточкой «Выручка»."
          table="revenue" cols={[{ name: "sub_stars", values: s.sub_stars }, { name: "once_stars", values: s.once_stars }, { name: "refund_stars", values: s.refund_stars }]}>
          <AnaStack labels={labels} fmt={starFmt} label="Выручка во времени" series={[
            { name: "Подписка", color: ANA_C.c4, values: s.sub_stars },
            { name: "Разовые покупки", color: ANA_C.c6, values: s.once_stars },
            { name: "Возвраты", color: ANA_C.c2, values: s.refund_stars, sign: -1 },
          ]} />
          <AnaLegend items={[{ name: "Подписка", color: ANA_C.c4 }, { name: "Разовые покупки", color: ANA_C.c6 }, { name: "Возвраты", color: ANA_C.c2 }]} />
        </Card>
        <Card title="Выручка и расход на ИИ" desc="Оба ряда в долларах, на одной оси. Зелёная выше оранжевой — работаем в плюс."
          table="unit" cols={[{ name: "revenue_micro_usd", values: s.revenue_micro }, { name: "ai_micro_usd", values: s.ai_micro }]}>
          <AnaLine labels={labels} fmt={microText} axis={microText} label="Выручка и расход на ИИ" series={[
            { name: "Выручка, $", color: ANA_C.c3, values: s.revenue_micro, area: true },
            { name: "Расход на ИИ, $", color: ANA_C.c2, values: s.ai_micro },
          ]} />
          <AnaLegend items={[{ name: "Выручка, $", color: ANA_C.c3 }, { name: "Расход на ИИ, $", color: ANA_C.c2 }]} />
        </Card>
        <Card title="Выручка на активного" desc="ARPU по шагам времени: чистые звёзды шага ÷ активные в этот шаг." table="arpu" cols={[{ name: "arpu_stars", values: s.arpu_stars }, { name: "active", values: s.active }]}>
          <AnaLine labels={labels} fmt={starFmt1} label="Выручка на активного" series={[{ name: "Выручка на активного, ⭐", color: ANA_C.c1, values: s.arpu_stars }]} />
        </Card>
        <Card title="Расход ИИ на активного" desc="Средний расход на модель на человека, активного в этот шаг." table="ai_per_active" cols={[{ name: "ai_per_active_micro_usd", values: s.ai_per_active_micro }]}>
          <AnaLine labels={labels} fmt={microText} axis={microText} label="Расход ИИ на активного" series={[{ name: "Расход ИИ на активного", color: ANA_C.c2, values: s.ai_per_active_micro }]} />
        </Card>
      </div>
    </>
  );
}

// ——— Деньги: подписки
function SubsView({ labels, d }: ViewProps<SubsData>) {
  const k = d.kpi, s = d.series;
  return (
    <>
      <Defs rows={[
        ["Активная подписка", `Оплаченный период ещё не кончился (Telegram Stars, ⭐${d.price_stars} в месяц).`],
        ["На пробе", `Первые ${d.trial_days} дней после регистрации, ИИ работает без оплаты. Подарок по приглашению — не проба.`],
        ["Риск оттока", "Подписка активна, но автопродление выключено — вероятный уход."],
        ["Конверсия пробы", `Из закончивших пробу в интервале — доля оплативших в течение 3 дней после её конца (оплата во время пробы тоже в счёт). Ещё ждут решения: ${k.trial_pending}.`],
        ["Отмены и истечения", "Пишутся с 24 нояб. 2026 (журнал оплат); окно, начатое раньше, — «—». «Истекли» — только конец подписки; конец пробы и подарка сюда не входит (проба — в «Конверсии пробы»)."],
        ["Сравнение", "Снимок «сейчас» (пробы, автопродление, риск) сравнивать не с чем — у них «—». Активные подписки сравниваются с началом периода."],
      ]} />
      <Block title={`Подписка «Горничная» ⭐${d.price_stars} / месяц`} desc="Снимок на «сейчас»: кто платит, кто на пробе, кто может уйти. Выручка за интервал — в «Обзоре».">
        <div className="ana-kpis">
          <Kpi title="Активных подписок" pair={k.active_subs} value={numText(k.active_subs.cur)} hint="оплаченный период не кончился" />
          <Kpi title="На пробе" pair={k.trials} value={numText(k.trials.cur)} hint={`${d.trial_days} дней бесплатно после регистрации`} />
          <Kpi title="Проба кончится ≤ 3 дн." pair={k.trials_ending_3d} value={numText(k.trials_ending_3d.cur)} hint="время для мягкого напоминания Рины" />
          <Kpi title="С автопродлением" pair={k.autorenew} value={numText(k.autorenew.cur)} hint="Telegram продлит сам" />
          <Kpi title="Риск оттока" pair={k.churn_risk} inverse value={numText(k.churn_risk.cur)} hint="автопродление выключено" />
          <Kpi title="Конверсия пробы" pair={k.trial_conversion} fmt={shareText} value={shareText(k.trial_conversion.cur)}
            hint={`закончили пробу → оплатили (решили ${numText(k.trial_decided.cur)}, ждут ${numText(k.trial_pending)})`} />
          <Kpi title="Новые подписки" pair={k.new_subs} value={numText(k.new_subs.cur)} hint="первая оплата за интервал" />
          <Kpi title="Продления" pair={k.renewals} value={numText(k.renewals.cur)} hint="за интервал" />
          <Kpi title="Отмены" pair={k.cancels} inverse value={numText(k.cancels.cur)} hint="за интервал" />
          <Kpi title="Истекли" pair={k.expired} inverse value={numText(k.expired.cur)} hint="срок кончился без продления" />
          <Kpi title="Возвраты" pair={k.refunds} inverse value={numText(k.refunds.cur)} hint="оплата возвращена (refundStarPayment)" />
        </div>
        <Notes only={["prev_before_data"]} />
      </Block>
      <div className="ana-grid2">
        <Card title="Подписки во времени" desc="Новые и продлённые вверх, отмены и истечения вниз — от одной нулевой линии."
          table="subs" cols={[{ name: "new", values: s.new }, { name: "renewed", values: s.renewed }, { name: "canceled", values: s.canceled }, { name: "expired", values: s.expired }]}>
          <AnaStack labels={labels} fmt={(v) => numText(v)} label="Подписки во времени" series={[
            { name: "Новые", color: ANA_C.c3, values: s.new },
            { name: "Продлённые", color: ANA_C.c1, values: s.renewed },
            { name: "Отмены", color: ANA_C.c2, values: s.canceled, sign: -1 },
            { name: "Истекли", color: ANA_C.c4, values: s.expired, sign: -1 },
          ]} />
          <AnaLegend items={[{ name: "Новые", color: ANA_C.c3 }, { name: "Продлённые", color: ANA_C.c1 }, { name: "Отмены", color: ANA_C.c2 }, { name: "Истекли", color: ANA_C.c4 }]} />
        </Card>
        <Card title="Конверсия пробы во времени" desc="По дате конца пробы; шаг без решённых — пусто." table="trial" cols={[{ name: "trial_conversion_share_0_1", values: s.trial_conversion }]}>
          <AnaLine labels={labels} fmt={shareText} axis={shareText} label="Конверсия пробы" series={[{ name: "Конверсия проба → оплата", color: ANA_C.c1, values: s.trial_conversion }]} />
        </Card>
      </div>
      <Card title="Кто скоро решит" desc="Ближайшие концы пробы и подписок без автопродления на 7 дней вперёд (до 10). Без имён: номер, сколько дней с нами, активность за неделю."
        extra={<CsvBtn table="soon" make={() => toCsv(["user_id", "what", "left_days", "days_with_us", "active_days_7", "ai_micro_usd_30d"],
          d.soon.map((r) => [r.user_id, r.what, r.left_days, r.days_with_us, r.active_days_7, r.ai_micro_30]))} />}>
        {d.soon.length ? (
          <div className="adm-scroll">
            <table className="ana-table">
              <thead><tr><th>Номер</th><th>Что</th><th className="n">Осталось</th><th className="n">С нами, дн.</th><th className="n">Дней активен из 7</th><th className="n">Расход ИИ за 30 дн.</th></tr></thead>
              <tbody>
                {d.soon.map((r) => (
                  <tr key={`${r.user_id}-${r.what}`}>
                    <td>#{r.user_id}</td><td>{r.what === "trial" ? "проба" : "без автопродления"}</td>
                    <td className="n">{r.left_days} дн.</td><td className="n">{r.days_with_us}</td><td className="n">{r.active_days_7}</td><td className="n">{microText(r.ai_micro_30)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="ana-empty-text">На ближайшие 7 дней никто не решает.</p>}
      </Card>
    </>
  );
}

// ——— Деньги: расход на ИИ
const AI_COLORS: Record<AiGroup, string> = { parse: ANA_C.c1, talk: ANA_C.c3, draw: ANA_C.c5, voice: ANA_C.c4, background: ANA_C.c6, other: ANA_C.other };

function AiView({ labels, d }: ViewProps<AiData>) {
  const k = d.kpi;
  const groups = d.groups.length ? d.groups : [];
  const ratio = k.subscriber_avg_micro && k.subscriber_avg_revenue_micro ? k.subscriber_avg_revenue_micro / k.subscriber_avg_micro : null;
  return (
    <>
      <Defs rows={[
        ["Назначение", "Для чего звали модель: дневные итоги расхода по назначениям (UTC); на шаге «час» — журнал вызовов, он хранится 30 дней."],
        ["Лимит", `Дневной потолок на человека: проба — ${microText(d.limits.trial_day_micro)}, подписка — ${microText(d.limits.paid_day_micro)}, общий котёл проб — ${microText(d.limits.trial_pool_day_micro)} в день. Упёрся — Рина отвечает «на сегодня я устала», запись сохраняется заметкой.`],
        ["Упёрлись в лимит", "Доля активных, кому ИИ хоть раз отказал из-за своего дневного потолка (счётчики с 24 нояб. 2026)."],
        ["Прогноз на месяц", "Сумма за 7 полных прошедших дней ÷ 7 × 30; от интервала не зависит."],
        ["Без цены", "Вызовы, у которых провайдер не сообщил цену: в расходе они нулём."],
        ["Распределение", "Доли активных по расходу за последние 30 дней (UTC), от интервала не зависит. Хвост справа — те, кого стоит посмотреть."],
        ["Модели", "Доля расхода и время ответа (медиана и 95%) по удачным попыткам; время — только за последние 30 дней."],
      ]} />
      <Block title="Расход на ИИ" desc="Главная статья трат. Нужен, чтобы цена подписки всегда была выше того, что тратит средний и самый активный человек.">
        <div className="ana-kpis">
          <Kpi title="Всего за интервал" pair={k.total_micro} fmt={microText} inverse value={microText(k.total_micro.cur)} hint={`все назначения · ${numText(k.calls.cur)} вызовов`} />
          <Kpi title="Прогноз на месяц" value={microText(k.forecast_month_micro)} hint="по среднему за 7 дней" />
          <Kpi title="Упёрлись в лимит" pair={k.capped_share} fmt={shareText} inverse value={shareText(k.capped_share.cur)} hint={`активных хоть раз за интервал (${numText(k.capped_users.cur)} чел.)`} />
          <Kpi title="Самый дорогой" value={k.top_user ? microText(k.top_user.micro) : "—"} hint={k.top_user ? `за интервал, номер #${k.top_user.user_id}` : "за интервал никого"} />
          <Kpi title="Подписчик в среднем" value={microText(k.subscriber_avg_micro)}
            hint={k.subscriber_avg_revenue_micro != null ? `≈ ${microText(k.subscriber_avg_revenue_micro)} выручки${ratio ? ` — маржа ~${numText(ratio, 1)}×` : ""} · подписчиков ${k.subscribers}` : `подписчиков ${k.subscribers}`} />
          <Kpi title="Без цены" pair={k.unpriced_calls} inverse value={numText(k.unpriced_calls.cur)} hint="вызовов, расход которых — ноль" />
        </div>
        <Notes only={["prev_before_data", "hour_from_calls", "days_for_hours"]} />
      </Block>
      <Card title="Расход по назначениям" desc="Стопкой по шагам времени, в долларах."
        table="groups" cols={groups.map((g) => ({ name: `${g.id}_micro_usd`, values: d.series[g.id] ?? [] }))} notes={["hour_from_calls"]}>
        <AnaStack labels={labels} fmt={microText} axis={microText} height={260} label="Расход по назначениям"
          series={groups.map((g) => ({ name: AI_GROUP_NAMES[g.id] ?? g.id, color: AI_COLORS[g.id] ?? ANA_C.other, values: d.series[g.id] ?? [] }))} />
        <AnaLegend items={groups.map((g) => ({ name: AI_GROUP_NAMES[g.id] ?? g.id, color: AI_COLORS[g.id] ?? ANA_C.other }))} />
      </Card>
      <div className="ana-grid2">
        <Card title="Сколько людей тратят сколько" desc={`За 30 дней, доля активных (${numText(d.dist_users)} чел.).`}>
          {d.dist_users
            ? <AnaHBars color={ANA_C.c2} rows={d.dist.map((x) => ({ label: DIST_NAMES[x.id] ?? x.id, value: x.users, text: `${shareText(x.share)} · ${x.users}` }))} />
            : <p className="ana-empty-text">За 30 дней активных не было.</p>}
        </Card>
        <Card title="Модели" desc="Доля расхода, главное назначение и время ответа." notes={["latency_30d_only"]}
          extra={<CsvBtn table="models" make={() => toCsv(["model", "micro_usd", "share_0_1", "calls", "top_kind", "p50_ms", "p95_ms", "timed"],
            d.models.map((m) => [m.model, m.micro, m.share, m.calls, m.top_kind, m.p50_ms, m.p95_ms, m.timed]))} />}>
          {d.models.length ? (
            <div className="adm-scroll">
              <table className="ana-table">
                <thead><tr><th>Модель</th><th className="n">Доля</th><th className="n">Расход</th><th className="n">Вызовов</th><th>Назначение</th><th className="n">p50</th><th className="n">p95</th></tr></thead>
                <tbody>
                  {d.models.map((m) => (
                    <tr key={m.model}>
                      <td>{m.model}</td><td className="n">{shareText(m.share)}</td><td className="n">{microText(m.micro)}</td><td className="n">{numText(m.calls)}</td>
                      <td>{AI_GROUP_NAMES[aiGroupOf(m.top_kind)]}</td><td className="n">{msText(m.p50_ms)}</td><td className="n">{msText(m.p95_ms)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="ana-empty-text">За интервал модель не звали.</p>}
        </Card>
      </div>
    </>
  );
}

// ——— Люди: активность
function ActView({ labels, d }: ViewProps<ActData>) {
  const k = d.kpi, s = d.series;
  const src = d.sources.map((id, i) => ({ id, name: SOURCE_NAMES[id] ?? id, color: ANA_ORDER[i % ANA_ORDER.length] }));
  const hourLabels = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, "0")}:00`);
  return (
    <>
      <Defs rows={[
        ["Активный", ACTIVE_DEF],
        ["Обращения", "Сообщения с ИИ во всех клиентах (без поправок к ответам и импорта)."],
        ["Без ИИ", "Отметки кнопкой (бот, сайт, push, виджет Telegram) и правки мышью — бесплатные действия."],
        ["Источник", "Откуда пришло сообщение. Сайт и виджет пишут одним источником — разделить их нельзя."],
        ["Часы суток", "Всего сообщений в местный час человека ÷ дней в интервале."],
        ["Неделя × час", "Минуты присутствия, сложенные по людям, за 28 дней до сегодня; от интервала не зависит."],
        ["Оговорка", "«Активны» в «Обзоре» админки считаются только по сообщениям — там числа бывают меньше, чем здесь."],
      ]} />
      <Block title="Приток и объём" desc="Сколько людей пришло и сколько они делают. Отметка кнопкой и запись через ИИ — разные вещи: первое бесплатно, второе стоит денег.">
        <div className="ana-kpis">
          <Kpi title="Регистрации" pair={k.signups} value={numText(k.signups.cur)} hint="новые аккаунты за интервал" />
          <Kpi title="Обращения" pair={k.requests} value={numText(k.requests.cur)} hint="сообщения с ИИ во всех клиентах" />
          <Kpi title="Активные" pair={k.active} value={numText(k.active.cur)} hint="хотя бы одно действие за интервал" />
          <Kpi title="Обращений на активного" pair={k.requests_per_active} value={numText(k.requests_per_active.cur, 1)} hint="обращения ÷ активные" />
          <Kpi title="Без ИИ на активного" pair={k.manual_per_active} value={numText(k.manual_per_active.cur, 1)} hint="отметки кнопкой, push, правки мышью" />
          <Kpi title="Платящие среди активных" pair={k.payers_share} fmt={shareText} value={shareText(k.payers_share.cur)} hint="хотя бы одна оплата в интервале" />
        </div>
        <Notes only={["prev_before_data"]} />
      </Block>
      <div className="ana-grid2">
        <Card title="Регистрации во времени" desc="Новые аккаунты по шагам." table="signups" cols={[{ name: "signups", values: s.signups }]}>
          <AnaStack labels={labels} fmt={(v) => numText(v)} label="Регистрации" series={[{ name: "Регистрации", color: ANA_C.c4, values: s.signups }]} />
        </Card>
        <Card title="Обращения по источнику" desc="Откуда пишут: стопкой по шагам." table="sources" cols={src.map((x) => ({ name: x.id, values: s.requests_by_source[x.id] ?? [] }))}>
          <AnaStack labels={labels} fmt={(v) => numText(v)} label="Обращения по источнику" series={src.map((x) => ({ name: x.name, color: x.color, values: s.requests_by_source[x.id] ?? [] }))} />
          <AnaLegend items={src} />
        </Card>
      </div>
      <Card title="Записи и отметки" desc="Сколько разобрал ИИ и сколько сделано без него. Растут отметки при тех же записях — привычка закрепляется."
        table="requests_manual" cols={[{ name: "manual", values: s.manual }, { name: "requests", values: s.requests }]}>
        <AnaLine labels={labels} fmt={(v) => numText(v)} label="Записи и отметки" series={[
          { name: "Без ИИ: отметки и правки", color: ANA_C.c3, values: s.manual },
          { name: "Обращения к ИИ", color: ANA_C.c1, values: s.requests },
        ]} />
        <AnaLegend items={[{ name: "Без ИИ: отметки и правки", color: ANA_C.c3 }, { name: "Обращения к ИИ", color: ANA_C.c1 }]} />
      </Card>
      <div className="ana-grid2">
        <Card title="Активность по часам суток" desc="Среднее число сообщений на час, по поясу каждого человека."
          extra={<CsvBtn table="hours" label="Ряды" make={() => toCsv(["hour_local", "messages_per_day"], d.hours.map((v, h) => [h, v]))} />}>
          <AnaStack labels={hourLabels} fmt={cnt} label="Активность по часам суток" series={[{ name: "Сообщений в час, в среднем", color: ANA_C.c4, values: d.hours }]} />
        </Card>
        <Card title="Неделя × час" desc={`Минуты, когда программа была открыта, за ${d.heat_days} дней. Ярче — больше минут.`}
          extra={<CsvBtn table="heat" label="Ряды" make={() => toCsv(["weekday_1_mon", ...Array.from({ length: 24 }, (_, h) => `h${h}_minutes`)], d.heat.map((r, i) => [i + 1, ...r]))} />}>
          <AnaHeat heat={d.heat} />
        </Card>
      </div>
    </>
  );
}

// ——— Люди: удержание
function RetView({ meta, labels, d }: ViewProps<RetData>) {
  const k = d.kpi, b = d.bridge;
  const title = meta.step === "h" ? "Активные по часам" : meta.step === "w" ? "Активные по неделям" : "Активные по дням";
  return (
    <>
      <Defs rows={[
        ["DAU / WAU / MAU", "Люди, сделавшие хоть что-то сегодня / за 7 / за 30 дней (сообщение, отметка, открыли программу)."],
        ["Активный", ACTIVE_DEF],
        ["Липкость", "Среднее число активных за день за 30 дней ÷ MAU: какую часть месяца человек в среднем приходит. Для ежедневника хорошо — от 30%."],
        ["Кто пропал", "Последний активный день — от 14 до 59 дней назад."],
        ["Мост MAU", "Было в прошлые 30 дней → осталось + ушло; пришло новых (зарегистрировались за 30 дней) или вернувшихся."],
        ["Когорта", "Строка — неделя регистрации (пн–вс), столбец Н+k — доля тех, кто был активен на k-й неделе после неё; «—» — неделя ещё не наступила."],
      ]} />
      <Block title="Удержание" desc="Самая важная страница: возвращаются ли люди. Цифры — на сегодня, стрелки — к той же точке неделю назад; от интервала не зависят.">
        <div className="ana-kpis">
          <Kpi title="DAU" pair={k.dau} value={numText(k.dau.cur)} hint="за сегодня" />
          <Kpi title="WAU" pair={k.wau} value={numText(k.wau.cur)} hint="за 7 дней" />
          <Kpi title="MAU" pair={k.mau} value={numText(k.mau.cur)} hint="за 30 дней" />
          <Kpi title="Липкость DAU/MAU" pair={k.stickiness} fmt={shareText} value={shareText(k.stickiness.cur)} hint="в среднем дней в месяц ÷ 30" />
          <Kpi title="Кто пропал" pair={k.gone} inverse value={numText(k.gone.cur)} hint="активны за 60 дней, но не за 14" />
        </div>
      </Block>
      <Card title="Мост MAU" desc="Два окна по 30 дней до сегодня.">
        <div className="ana-bridge">
          <div><span className="ana-k">Прошлый MAU</span><b>{numText(b.prev_mau)}</b></div>
          <div><span className="ana-k">Остались</span><b className="ana-good">{numText(b.stayed)}</b></div>
          <div><span className="ana-k">Ушли</span><b className="ana-bad">{numText(b.left)}</b></div>
          <div><span className="ana-k">Новые</span><b>{numText(b.new)}</b></div>
          <div><span className="ana-k">Вернулись</span><b>{numText(b.returned)}</b></div>
          <div><span className="ana-k">Сейчас MAU</span><b>{numText(b.mau)}</b></div>
        </div>
      </Card>
      <Card title={title} desc="Пунктир — та же длина периода раньше, для сравнения." table="active" cols={[{ name: "active", values: d.series.active }, { name: "prev_active", values: d.series.prev_active }]}>
        <AnaLine labels={labels} fmt={(v) => numText(v)} height={260} label={title} series={[
          { name: "Этот период", color: ANA_C.c1, values: d.series.active, area: true },
          { name: "Прошлый период", color: ANA_C.prev, values: d.series.prev_active, dash: true },
        ]} />
        <AnaLegend items={[{ name: "Этот период", color: ANA_C.c1 }, { name: "Прошлый период", color: ANA_C.prev }]} />
      </Card>
      <Card title="Когорты по неделям регистрации" desc="Доля когорты, активной на k-й неделе. Наведите на ячейку — сколько людей."
        extra={<CsvBtn table="cohorts" make={() => toCsv(["week", "size", ...Array.from({ length: d.cohort_cols }, (_, i) => `w${i}_share_0_1`), ...Array.from({ length: d.cohort_cols }, (_, i) => `w${i}_users`)],
          d.cohorts.map((r) => [r.week, r.size, ...Array.from({ length: d.cohort_cols }, (_, i) => r.cells[i]?.share ?? null), ...Array.from({ length: d.cohort_cols }, (_, i) => r.cells[i]?.users ?? null)]))} />}>
        {d.cohorts.length ? <AnaCohort rows={d.cohorts} cols={d.cohort_cols} weekText={(w) => dayText(w)} /> : <p className="ana-empty-text">Когорт пока нет.</p>}
      </Card>
    </>
  );
}

// ——— Рина и функции: функции
function FeatView({ d }: ViewProps<FeatData>) {
  const k = d.kpi;
  const used = d.rows.filter((r) => (r.uses.cur ?? 0) > 0);
  const max = Math.max(0, ...used.map((r) => r.uses.cur ?? 0));
  const title = (id: string) => d.rows.find((r) => r.id === id)?.title ?? id;
  // Окно раньше начала счётчиков (правило since): у всех функций «—» — данных нет, а не «никто не пользовался».
  const noData = k.used.cur == null;
  const noDataText = <p className="ana-empty-text">{d.since ? `Счётчики функций копятся с ${dayText(d.since, true)} — для такого интервала «—»; выберите интервал короче.` : "Счётчиков функций пока нет — данные копятся."}</p>;
  return (
    <>
      <Defs rows={[
        ["Функция в ходу", "Хоть раз за интервал у кого угодно, из белого списка функций (сайт, виджет, бот, общие). Отказы ИИ, шаги экскурсии и реакции Рины — не функции: они в «Расходе на ИИ», «Воронках» и «Рине»."],
        ["На человека", "Сколько разных функций в среднем у тех, кто тронул хоть одну."],
        ["Доля активных", "Люди с функцией ÷ активные за интервал."],
        ["Не трогали", "Ни разу за интервал — кандидаты спрятать, объяснить в экскурсии или убрать."],
        ["Откуда", `Счётчики функций по дням (пояс человека)${d.since ? `, копятся с ${dayText(d.since, true)}` : ", пока пусто"}.`],
      ]} />
      <Block title="Функции" desc="Чем пользуются и чем нет: тот же список, что «Использование функций», но с людьми, долей активных и сравнением.">
        <div className="ana-kpis">
          <Kpi title="Функций в ходу" pair={k.used} value={`${numText(k.used.cur)} из ${k.total}`} hint="хоть раз за интервал" />
          <Kpi title="Функций на человека" pair={k.per_person} value={numText(k.per_person.cur, 1)} hint="разных, в среднем" />
          <Kpi title="Людей с функциями" pair={k.people} value={numText(k.people.cur)} hint={`из ${numText(d.active.cur)} активных`} />
          <Kpi title="Не трогали" pair={k.unused} inverse value={numText(k.unused.cur)} hint="ни разу за интервал" />
        </div>
        <Notes only={["prev_before_data", "days_for_hours"]} />
      </Block>
      <Card title="Самые частые" desc="Раз и людей за интервал. Полоса — раз." notes={["no_hourly_features", "days_for_hours"]}
        extra={<CsvBtn table="features" make={() => toCsv(["id", "title", "group", "by", "uses", "uses_prev", "people", "people_prev", "share_0_1", "share_prev_0_1"],
          d.rows.map((r) => [r.id, r.title, d.groups[r.group] ?? r.group, r.by, r.uses.cur, r.uses.prev, r.people.cur, r.people.prev, r.share.cur, r.share.prev]))} />}>
        {used.length ? (
          <div className="adm-scroll">
            <table className="ana-table ana-feat">
              <thead><tr><th>Функция</th><th>Где</th><th className="ana-barcol" /><th className="n">Раз</th><th className="n">Изм.</th><th className="n">Людей</th><th className="n">Доля активных</th><th>Тренд</th></tr></thead>
              <tbody>
                {used.map((r) => (
                  <tr key={r.id}>
                    <td>{r.title}</td><td>{d.groups[r.group] ?? r.group}</td>
                    <td className="ana-barcol"><div className="ana-tbar" style={{ width: `${max ? ((r.uses.cur ?? 0) / max) * 100 : 0}%` }} /></td>
                    <td className="n">{numText(r.uses.cur)}</td><td className="n"><Delta pair={r.uses} /></td>
                    <td className="n">{numText(r.people.cur)}</td><td className="n">{shareText(r.share.cur)}</td>
                    <td>{r.spark ? <svg className="adm-spark" width={72} height={18} viewBox="0 0 72 18"><polyline fill="none" points={sparkPoints(r.spark, 72, 18)} /></svg> : <span className="adm-muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : noData ? noDataText : <p className="ana-empty-text">За интервал функциями не пользовались.</p>}
      </Card>
      <Card title="Ни разу за интервал" desc="Кандидаты: спрятать, объяснить в экскурсии или убрать.">
        {noData ? noDataText
          : d.unused.length ? <div className="adm-unused">{d.unused.map((id) => <span key={id} className="adm-chip">{title(id)}</span>)}</div>
          : <p className="ana-empty-text">Все функции хоть раз использовались.</p>}
      </Card>
    </>
  );
}

// ——— Рина и функции: разбор
const KIND_COLORS: Record<ParseKind, string> = { tasks: ANA_C.c1, plans: ANA_C.c3, diary: ANA_C.c6, habits: ANA_C.c4, money: ANA_C.c5, other: ANA_C.other, talk: ANA_C.c2 };

function ParseView({ labels, d }: ViewProps<ParseData>) {
  const k = d.kpi, s = d.series;
  const kinds = d.kinds.length ? d.kinds : [];
  return (
    <>
      <Defs rows={[
        ["Сообщений с ИИ", "Обращения к ИИ во всех клиентах, как в «Активности»."],
        ["Отменено", "У записи нажали «↩ Отменить» или «просто заметка» — доля обращений."],
        ["Поправки", "«Поправить этот ответ…» — доля обращений."],
        ["Виды записей", "Что легло в базу из сообщения; одно сообщение может попасть в несколько видов, поэтому стопка бывает выше числа обращений. «Разговор без записи» — ответ без единой записи."],
        ["Время ответа", "Медиана и 95% по удачным попыткам разбора, разговора и ответов; только за последние 30 дней."],
        ["Сейчас в ошибке", "Нынешнее состояние, от интервала не зависит."],
      ]} />
      <Block title="Разбор" desc="Что люди пишут и как часто ИИ ошибается. Частично это есть в «Качестве разбора» — здесь добавлены виды записей и сравнение.">
        <div className="ana-kpis">
          <Kpi title="Сообщений с ИИ" pair={k.requests} value={numText(k.requests.cur)} hint="за интервал" />
          <Kpi title="Отменено" pair={k.undone_share} fmt={shareText} inverse value={shareText(k.undone_share.cur)} hint={`${numText(k.undone.cur)} · «↩ Отменить», «просто заметка»`} />
          <Kpi title="Поправки" pair={k.corrections_share} fmt={shareText} inverse value={shareText(k.corrections_share.cur)} hint={`${numText(k.corrections.cur)} · «поправить этот ответ…»`} />
          <Kpi title="Сейчас в ошибке" value={numText(k.failed_now)} hint={`ждут повтора: ${numText(k.failed_retry)} · ждут ответа: ${numText(k.clarify_now)}`} />
          <Kpi title="Ответ за" pair={k.p50_ms} fmt={msText} inverse value={msText(k.p50_ms.cur)} hint="медиана" />
          <Kpi title="95% быстрее" pair={k.p95_ms} fmt={msText} inverse value={msText(k.p95_ms.cur)} hint="95-й перцентиль" />
        </div>
        <Notes only={["prev_before_data", "latency_30d_only"]} />
      </Block>
      <Card title="Что записывается" desc="По виду записи, стопкой по шагам. Одно сообщение может попасть в несколько видов."
        table="kinds" cols={[{ name: "requests", values: s.requests }, ...kinds.map((x) => ({ name: x, values: s.kinds[x] ?? [] }))]}>
        <AnaStack labels={labels} fmt={(v) => numText(v)} height={260} label="Что записывается"
          series={kinds.map((x) => ({ name: PARSE_KIND_NAMES[x] ?? x, color: KIND_COLORS[x] ?? ANA_C.other, values: s.kinds[x] ?? [] }))} />
        <AnaLegend items={kinds.map((x) => ({ name: PARSE_KIND_NAMES[x] ?? x, color: KIND_COLORS[x] ?? ANA_C.other }))} />
      </Card>
      <Card title="Доля отмен и поправок" desc="Растёт — разбор стал хуже (сменили модель, промпт). Шаг без обращений — пусто." table="errors" cols={[{ name: "err_share_0_1", values: s.err_share }]}>
        <AnaLine labels={labels} fmt={shareText} axis={shareText} label="Доля отмен и поправок" series={[{ name: "Отменено или поправлено", color: ANA_C.c2, values: s.err_share }]} />
      </Card>
    </>
  );
}
