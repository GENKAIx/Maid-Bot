import { createContext, useContext, useEffect, useState } from "react";
import { ApiError, get } from "../api";
import { ago, SOURCE_NAMES, sortRows, usd } from "../admin";

// Разделы админки этапа 1 (24.11.2026): Обзор, Пользователи, Расходы, Аудитория, Качество разбора. Данные — /api/admin/*
// (server/src/admin-stats.ts): только счётчики и имена. Свои простые графики (AdmBars) — в цветах админки, не сайта.

/** Вход в админку кончился (сервер ответил 403) — Shell (Admin.tsx) перечитывает состояние и показывает ввод кода. */
export const AdminLost = createContext<() => void>(() => {});

/** Данные раздела и текст ошибки, если не загрузились (сеть, 500, тайм-аут). */
function useAdmin<T>(path: string): [T | null, string] {
  const [v, setV] = useState<T | null>(null);
  const [err, setErr] = useState("");
  const lost = useContext(AdminLost);
  useEffect(() => {
    let alive = true;
    setV(null);
    setErr("");
    get<T>(path).then((x) => alive && setV(x)).catch((e) => {
      if (!alive) return;
      if (e instanceof ApiError && e.status === 403) lost();
      else setErr((e as Error).message || "не загрузилось");
    });
    return () => { alive = false; };
  }, [path, lost]);
  return [v, err];
}

const Loading = ({ err }: { err?: string }) =>
  err ? <span className="adm-err" role="alert">Не загрузилось: {err}</span> : <span className="adm-muted">Загрузка…</span>;
const dayLabel = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });

function Kpi({ title, value, hint, warn }: { title: string; value: string | number; hint?: string; warn?: boolean }) {
  return (
    <div className={`adm-kpi ${warn ? "warn" : ""}`}>
      <span>{title}</span><b className="adm-num">{value}</b>{hint && <i>{hint}</i>}
    </div>
  );
}

/** Столбики по дням; parts — стопка (цвета по порядку), подсказка при наведении. */
export function AdmBars({ days, parts, format, height = 120 }: {
  days: { day: string; values: number[] }[]; parts: string[]; format: (v: number) => string; height?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1e-9, ...days.map((d) => d.values.reduce((s, v) => s + v, 0)));
  const step = Math.max(1, Math.ceil(days.length / 8));
  return (
    <div className="adm-chart">
      <div className="adm-bars" style={{ height }} onMouseLeave={() => setHover(null)}>
        {days.map((d, i) => (
          <div key={d.day} className={`adm-col ${hover === i ? "on" : ""}`} onMouseEnter={() => setHover(i)} onClick={() => setHover(i)}>
            {d.values.map((v, k) => <div key={k} className={`adm-seg s${k}`} style={{ height: `${(v / max) * 100}%` }} />)}
          </div>
        ))}
        {hover !== null && (
          <div className="adm-tip" style={{ left: `${((hover + 0.5) / days.length) * 100}%` }}>
            <b>{dayLabel(days[hover].day)}</b>
            {days[hover].values.map((v, k) => <span key={k}><i className={`adm-dot s${k}`} />{parts[k]}: <span className="adm-num">{format(v)}</span></span>)}
          </div>
        )}
      </div>
      <div className="adm-axis">{days.map((d, i) => <span key={d.day}>{i % step === 0 || i === days.length - 1 ? dayLabel(d.day) : ""}</span>)}</div>
      {parts.length > 1 && <div className="adm-legend">{parts.map((p, k) => <span key={p}><i className={`adm-dot s${k}`} />{p}</span>)}</div>}
    </div>
  );
}

function Period({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="adm-seg-ctl" role="tablist">
      {[7, 30, 90].map((d) => <button key={d} role="tab" aria-selected={value === d} className={value === d ? "on" : ""} onClick={() => onChange(d)}>{d} дн.</button>)}
    </div>
  );
}

type Overview = {
  users: number; new_week: number; active_day: number; active_week: number; active_month: number;
  spend_today: number; spend_month: number; spend_forecast: number; unpriced_month: number;
  requests_week: number; failed_week: number; clarify_week: number; undone_week: number;
};

export function AdminOverview() {
  const [o, err] = useAdmin<Overview>("/api/admin/overview");
  if (!o) return <Loading err={err} />;
  const pct = (n: number) => (o.requests_week ? `${Math.round((n / o.requests_week) * 100)}%` : "—");
  return (
    <>
      <h2 className="adm-h2">Люди</h2>
      <div className="adm-kpis">
        <Kpi title="Всего" value={o.users} hint={`новых за 7 дней: ${o.new_week}`} />
        <Kpi title="Активны сегодня" value={o.active_day} />
        <Kpi title="За 7 дней" value={o.active_week} />
        <Kpi title="За 30 дней" value={o.active_month} />
      </div>
      <h2 className="adm-h2">Деньги <span className="adm-muted">· дни по UTC</span></h2>
      <div className="adm-kpis">
        <Kpi title="Сегодня" value={usd(o.spend_today)} />
        <Kpi title="В этом месяце" value={usd(o.spend_month)} hint={o.unpriced_month ? `без цены: ${o.unpriced_month} запр.` : undefined} />
        <Kpi title="Прогноз на месяц" value={usd(o.spend_forecast)} hint="по среднему за 7 дней" />
      </div>
      <h2 className="adm-h2">Разбор за 7 дней</h2>
      <div className="adm-kpis">
        <Kpi title="Обращений" value={o.requests_week} />
        <Kpi title="Сейчас в ошибке" value={o.failed_week} hint={pct(o.failed_week)} warn={o.failed_week > 0} />
        <Kpi title="Ждут ответа" value={o.clarify_week} hint={pct(o.clarify_week)} />
        <Kpi title="Отменено" value={o.undone_week} hint={pct(o.undone_week)} />
      </div>
    </>
  );
}

type UserRow = {
  id: number; name: string; login: string | null; created_at: string; last_at: string | null; total: number; n30: number;
  ai30: number; manual30: number; undone30: number; cost30: number; background30: number; cost_month: number; cost_total: number;
};
const USER_COLS: { key: keyof UserRow; title: string; num?: boolean; hint?: string }[] = [
  { key: "name", title: "Человек" },
  { key: "created_at", title: "С нами с" },
  { key: "last_at", title: "Последнее" },
  { key: "n30", title: "За 30 дн.", num: true, hint: "обращений и отметок" },
  { key: "ai30", title: "С ИИ", num: true, hint: "разобрано моделью" },
  { key: "manual30", title: "Без ИИ", num: true, hint: "кнопки, push, правки мышью" },
  { key: "cost30", title: "Расход 30 дн.", num: true },
  { key: "cost_total", title: "Всего", num: true },
];

export function AdminUsers() {
  const [rows, err] = useAdmin<UserRow[]>("/api/admin/users");
  const [sort, setSort] = useState<{ key: keyof UserRow; desc: boolean }>({ key: "cost30", desc: true });
  const [open, setOpen] = useState<number | null>(null);
  if (!rows) return <Loading err={err} />;
  const shown = sortRows(rows, sort.key, sort.desc);
  const cur = rows.find((r) => r.id === open);
  const cell = (r: UserRow, k: keyof UserRow) =>
    k === "created_at" ? new Date(r.created_at).toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "2-digit" })
    : k === "last_at" ? ago(r.last_at)
    : k === "cost30" || k === "cost_total" ? usd(r[k] as number)
    : k === "name" ? <>{r.name}{r.login && r.login !== r.name && <span className="adm-muted"> · {r.login}</span>}</>
    : String(r[k]);
  return (
    <div className="adm-split">
      <div className="adm-scroll">
        <table className="adm-table">
          <thead>
            <tr>{USER_COLS.map((c) => (
              <th key={c.key} title={c.hint} className={c.num ? "num" : ""} aria-sort={sort.key === c.key ? (sort.desc ? "descending" : "ascending") : "none"}>
                <button onClick={() => setSort({ key: c.key, desc: sort.key === c.key ? !sort.desc : Boolean(c.num) })}>
                  {c.title}{sort.key === c.key ? (sort.desc ? " ↓" : " ↑") : ""}
                </button>
              </th>
            ))}</tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id} className={`click ${open === r.id ? "on" : ""}`} onClick={() => setOpen(open === r.id ? null : r.id)}>
                {USER_COLS.map((c) => <td key={c.key} className={c.num ? "num adm-num" : c.key === "last_at" || c.key === "created_at" ? "adm-num" : ""}>{cell(r, c.key)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {cur && (
        <aside className="adm-card">
          <div className="adm-card-head"><b>{cur.name}</b><button className="adm-x" aria-label="Закрыть" onClick={() => setOpen(null)}>✕</button></div>
          {cur.login && <span className="adm-muted">логин {cur.login}</span>}
          <dl>
            <dt>С нами</dt><dd className="adm-num">{new Date(cur.created_at).toLocaleDateString("ru-RU")} · {ago(cur.created_at)}</dd>
            <dt>Последнее обращение</dt><dd className="adm-num">{ago(cur.last_at)}</dd>
            <dt>Всего записей</dt><dd className="adm-num">{cur.total}</dd>
            <dt>За 30 дней</dt><dd className="adm-num">{cur.n30} · с ИИ {cur.ai30} · без ИИ {cur.manual30}</dd>
            <dt>Отменено за 30 дней</dt><dd className="adm-num">{cur.undone30}</dd>
            <dt>Расход за 30 дней</dt><dd className="adm-num">{usd(cur.cost30)} <span className="adm-muted">· фоновый {usd(cur.background30)}</span></dd>
            <dt>В этом месяце</dt><dd className="adm-num">{usd(cur.cost_month)}</dd>
            <dt>За всё время</dt><dd className="adm-num">{usd(cur.cost_total)}</dd>
          </dl>
          <p className="adm-muted adm-small">Фоновый — сводки и поиск связей, которые горничная делает сама. Текстов сообщений админка не показывает.</p>
        </aside>
      )}
    </div>
  );
}

type Sum = { calls: number; input: number; output: number; cost: number; priced: number };
type SpendReport = {
  days: (Sum & { day: string; kinds: Record<string, number> })[]; total: Sum; month: Sum; forecast: number;
  kinds: (Sum & { kind: string })[]; models: (Sum & { model: string })[]; byUser: { user_id: number; name: string; calls: number; cost: number; background: number }[];
};
const KIND_NAMES: Record<string, string> = {
  parse: "Разбор", answer: "Ответы", chat: "Разговор", summary: "Сводки", patterns: "Связи", draw: "Рисование", voice: "Голос", correct: "Поправки", other: "Другое",
};

export function AdminSpend() {
  const [days, setDays] = useState(30);
  const [r, err] = useAdmin<SpendReport>(`/api/admin/spend?days=${days}`);
  const [by, setBy] = useState<"user" | "kind" | "model">("user");
  if (!r) return <><Period value={days} onChange={setDays} /><Loading err={err} /></>;
  const top = r.kinds.slice(0, 4).map((k) => k.kind);
  const parts = [...top.map((k) => KIND_NAMES[k] ?? k), ...(r.kinds.length > 4 ? ["Остальное"] : [])];
  const bars = r.days.map((d) => ({
    day: d.day,
    values: [...top.map((k) => d.kinds[k] ?? 0), ...(r.kinds.length > 4 ? [Object.entries(d.kinds).filter(([k]) => !top.includes(k)).reduce((s, [, v]) => s + v, 0)] : [])],
  }));
  const list = by === "user" ? r.byUser.map((x) => ({ key: `u${x.user_id}`, name: x.name, calls: x.calls, cost: x.cost, extra: x.background ? `фоновый ${usd(x.background)}` : "" }))
    : by === "kind" ? r.kinds.map((x) => ({ key: `k${x.kind}`, name: KIND_NAMES[x.kind] ?? x.kind, calls: x.calls, cost: x.cost, extra: "" }))
    : r.models.map((x) => ({ key: `m${x.model}`, name: x.model, calls: x.calls, cost: x.cost, extra: `${Math.round((x.input + x.output) / 1000)}k ток.` }));
  const max = Math.max(1e-9, ...list.map((x) => x.cost));
  return (
    <>
      <div className="adm-toolbar"><Period value={days} onChange={setDays} /><span className="adm-muted adm-small">дни по UTC (Москва — с 3:00)</span></div>
      <div className="adm-kpis">
        <Kpi title={`За ${days} дн.`} value={usd(r.total.cost)} hint={`${r.total.calls} запросов`} />
        <Kpi title="В этом месяце" value={usd(r.month.cost)} />
        <Kpi title="Прогноз на месяц" value={usd(r.forecast)} hint="по среднему за 7 дней" />
        <Kpi title="Без цены" value={r.total.calls - r.total.priced} hint="провайдер не сообщил" />
      </div>
      <div className="adm-panel"><AdmBars days={bars} parts={parts} format={usd} /></div>
      <div className="adm-toolbar">
        <div className="adm-seg-ctl" role="tablist">
          {([["user", "По людям"], ["kind", "На что"], ["model", "Модели"]] as const).map(([id, t]) => (
            <button key={id} role="tab" aria-selected={by === id} className={by === id ? "on" : ""} onClick={() => setBy(id)}>{t}</button>
          ))}
        </div>
      </div>
      <div className="adm-rank">
        {list.map((x) => (
          <div key={x.key} className="adm-rank-row">
            <span className="adm-rank-name">{x.name}</span>
            <span className="adm-rank-bar"><i style={{ width: `${(x.cost / max) * 100}%` }} /></span>
            <span className="adm-num">{usd(x.cost)}</span>
            <span className="adm-muted adm-num adm-small">{x.calls} запр.{x.extra ? ` · ${x.extra}` : ""}</span>
          </div>
        ))}
        {!list.length && <span className="adm-muted">Расхода за период нет.</span>}
      </div>
    </>
  );
}

type Audience = {
  today: string; series: { day: string; dau: number; wau: number; mau: number }[];
  cohorts: { week: string; size: number; weeks: (number | null)[] }[];
  gone: { user_id: number; name: string; last_day: string }[]; sources: { source: string; messages: number; users: number }[];
};

export function AdminAudience() {
  const [a, err] = useAdmin<Audience>("/api/admin/audience");
  if (!a) return <Loading err={err} />;
  const last = a.series.at(-1)!;
  const maxCols = Math.max(0, ...a.cohorts.map((c) => c.weeks.length));
  return (
    <>
      <div className="adm-kpis">
        <Kpi title="Активны сегодня" value={last.dau} />
        <Kpi title="За 7 дней" value={last.wau} />
        <Kpi title="За 30 дней" value={last.mau} />
        <Kpi title="Сегодня / за 30 дней" value={last.mau ? `${Math.round((last.dau / last.mau) * 100)}%` : "—"} hint="насколько каждый день" />
      </div>
      <h2 className="adm-h2">Активные по дням <span className="adm-muted">· кто писал или отмечал в этот день</span></h2>
      <div className="adm-panel"><AdmBars days={a.series.map((d) => ({ day: d.day, values: [d.dau] }))} parts={["Активны"]} format={(v) => String(v)} height={100} /></div>
      <h2 className="adm-h2">Удержание <span className="adm-muted">· неделя прихода → доля активных в следующие недели</span></h2>
      <div className="adm-scroll">
        <table className="adm-table adm-cohorts">
          <thead><tr><th>Неделя</th><th className="num">Людей</th>{Array.from({ length: maxCols }, (_, k) => <th key={k} className="num">+{k + 1}</th>)}</tr></thead>
          <tbody>
            {a.cohorts.map((c) => (
              <tr key={c.week}>
                <td className="adm-num">{dayLabel(c.week)}</td><td className="num adm-num">{c.size}</td>
                {Array.from({ length: maxCols }, (_, k) => {
                  const v = c.weeks[k];
                  return <td key={k} className="num adm-num adm-heat" style={v == null ? undefined : { ["--v" as string]: String(v) }}>{v == null ? "" : `${Math.round(v * 100)}%`}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="adm-two">
        <div>
          <h2 className="adm-h2">Пропали <span className="adm-muted">· писали за 60 дней, но не за последние 14</span></h2>
          {a.gone.length ? (
            <table className="adm-table"><tbody>{a.gone.map((g) => <tr key={g.user_id}><td>{g.name}</td><td className="adm-num num">{dayLabel(g.last_day)}</td></tr>)}</tbody></table>
          ) : <span className="adm-muted">Никто не пропал.</span>}
        </div>
        <div>
          <h2 className="adm-h2">Откуда пишут <span className="adm-muted">· 30 дней</span></h2>
          <table className="adm-table">
            <thead><tr><th>Источник</th><th className="num">Сообщений</th><th className="num">Людей</th></tr></thead>
            <tbody>{a.sources.map((s) => <tr key={s.source}><td>{SOURCE_NAMES[s.source] ?? s.source}</td><td className="num adm-num">{s.messages}</td><td className="num adm-num">{s.users}</td></tr>)}</tbody>
          </table>
        </div>
      </div>
      <p className="adm-muted adm-small">Онлайн сейчас и версии виджета появятся на этапе 2: для них сервер начнёт записывать, кто и с чего заходит.</p>
    </>
  );
}

type Quality = {
  series: { day: string; requests: number; failed: number; clarify: number; corrections: number; undone: number }[];
  total: { requests: number; failed: number; clarify: number; corrections: number; undone: number };
};

export function AdminQuality() {
  const [days, setDays] = useState(30);
  const [q, err] = useAdmin<Quality>(`/api/admin/quality?days=${days}`);
  if (!q) return <><Period value={days} onChange={setDays} /><Loading err={err} /></>;
  const t = q.total;
  const pct = (n: number) => (t.requests ? `${((n / t.requests) * 100).toFixed(1)}%` : "—");
  return (
    <>
      <div className="adm-toolbar"><Period value={days} onChange={setDays} /></div>
      <div className="adm-kpis">
        <Kpi title="Обращений" value={t.requests} />
        <Kpi title="Сейчас в ошибке" value={t.failed} hint={pct(t.failed)} warn={t.failed > 0} />
        <Kpi title="Ждут ответа" value={t.clarify} hint={pct(t.clarify)} />
        <Kpi title="Отменено" value={t.undone} hint={pct(t.undone)} />
        <Kpi title="Поправки к ответам" value={t.corrections} hint={pct(t.corrections)} />
      </div>
      <div className="adm-panel">
        <AdmBars days={q.series.map((d) => ({ day: d.day, values: [Math.max(0, d.requests - d.failed - d.clarify), d.clarify, d.failed] }))}
          parts={["Разобрано", "Ждут ответа", "Сейчас в ошибке"]} format={(v) => String(v)} />
      </div>
      <p className="adm-muted adm-small">
        Считаются только обращения к модели. «Сейчас в ошибке» и «Ждут ответа» — нынешнее состояние сообщения: разобранное позже из счёта
        уходит (после повторов через 2, 10 и 30 минут ошибка уходит в заметки), поэтому за прошлые дни эти числа меньше, чем было в тот день.
        «Отменено» — сообщения, у которых нажали «↩ Отменить» или «Это просто заметка».
      </p>
    </>
  );
}
