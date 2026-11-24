import { useContext, useState } from "react";
import { ApiError, post } from "../api";
import {
  CAP_GROUPS, changeText, fromInput, money, PART_KEYS, paidRevenue, PLAN_CARDS, PLAN_EXTRA, TARIFF_KEYS, TARIFF_SOURCES, tariffDiff, tariffValueText,
  tariffWarnings, toInput, undoPreview, type PlanEconomy, type TariffField, type TariffKey, type TariffPart, type TariffsData, type TariffValues,
} from "../tariffs";
import { AdminLost, Loading, useAdmin } from "./AdminSections";

// Разделы админки «Тарифы» и «Общие потолки» (24.11.2026, этап 1 макета docs/review/тарифы-и-управление-макет-2026-11-24.html):
// числа платного доступа из базы (server/src/tariffs.ts). Поля с единицами; изменённые подсвечены, итог — в плашке «Применить /
// Сбросить» внизу (причина обязательна); история с «Вернуть как было» (возвращает только поля этой строки; перед откатом — что
// изменится и какие более поздние строки трогали те же поля); предупреждения — только те, что честно считаются из чисел;
// экономика тарифа — из llm_usage за 30 дней, нет данных — «—». Только числа и номера аккаунтов, без имён и текстов людей.

type Send = (body: unknown) => Promise<string | null>;

/** Загрузка и отправка: после «Применить» и отката — перечитать (tick), 403 — вход в админку кончился. */
export function AdminTariffs({ part }: { part: TariffPart }) {
  const [tick, setTick] = useState(0);
  const [data, err] = useAdmin<TariffsData>(`/api/admin/tariffs${tick ? `?t=${tick}` : ""}`);
  const lost = useContext(AdminLost);
  if (!data) return <Loading err={err} />;
  const send = (path: string): Send => async (body) => {
    try {
      await post(path, body);
      setTick((t) => t + 1);
      return null;
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) lost();
      return (e as Error).message || "не вышло";
    }
  };
  return <TariffsPage key={tick} data={data} part={part} onApply={send("/api/admin/tariffs")} onUndo={send("/api/admin/tariffs/undo")} />;
}

const inputsOf = (v: TariffValues) =>
  Object.fromEntries(TARIFF_KEYS.filter((k) => k !== "signupsOpen").map((k) => [k, toInput(k, v[k] as number)])) as Record<TariffKey, string>;

/** Сам раздел — по готовым данным (тест рисует его без сети: web/test/tariffs.test.ts). */
/** draft — начальный черновик поверх действующих чисел (тест рисует плашку изменений без ввода). */
export function TariffsPage({ data, part, onApply, onUndo, draft: start }: {
  data: TariffsData; part: TariffPart; onApply: Send; onUndo: Send; draft?: Partial<TariffValues>;
}) {
  const applied = data.values;
  const [text, setText] = useState(() => inputsOf({ ...applied, ...start }));
  const [open, setOpen] = useState(start?.signupsOpen ?? applied.signupsOpen);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const errors: Partial<Record<TariffKey, string>> = {};
  const draft = { ...applied, signupsOpen: open } as Record<TariffKey, number | boolean>;
  for (const k of PART_KEYS[part]) {
    if (k === "signupsOpen") continue;
    const r = fromInput(k, text[k]);
    if (r.error) errors[k] = r.error;
    else draft[k] = r.value;
  }
  const d = draft as TariffValues;
  const diff = tariffDiff(d, applied, PART_KEYS[part]);
  const bad = Object.keys(errors).length > 0;
  const reset = () => { setText(inputsOf(applied)); setOpen(applied.signupsOpen); setNote(""); };
  async function apply() {
    setBusy(true);
    const values = Object.fromEntries(diff.map((c) => [c.key, c.to]));
    const why = await onApply({ values, reason: reason.trim() });
    setBusy(false);
    if (why) setNote(why);
  }
  const field = (f: TariffField) => (
    <Field key={f.key} f={f} value={text[f.key]} changed={!errors[f.key] && d[f.key] !== applied[f.key]} error={errors[f.key]}
      def={data.overridden.includes(f.key) ? tariffValueText(f.key, data.defaults[f.key]) : null}
      onChange={(v) => setText((t) => ({ ...t, [f.key]: v }))} />
  );
  const warnings = tariffWarnings(d, applied, part, Boolean(data.env_closed));
  return (
    <div className="adm-tf">
      <p className="adm-muted adm-tf-lead">
        {part === "plans"
          ? "Числа меняют поведение сервера сразу после «Применить», без выкладки. Изменённые поля подсвечены, итог — в плашке внизу."
          : "Защита всего сервера, а не одного человека: наплыв одноразовых аккаунтов не съест бюджет."}
        {" "}Другие процессы сервера перечитывают таблицу раз в {Math.round(data.reload_ms / 1000)} с.
      </p>
      {part === "plans" ? <Plans d={d} data={data} field={field} /> : <Caps d={d} data={data} field={field} open={open} setOpen={setOpen} />}
      {warnings.length > 0 && (
        <div className="adm-tf-flags">
          {warnings.map((w) => <div key={w.text} className={`adm-tf-flag ${w.kind}`} role={w.kind === "bad" ? "alert" : undefined}><b>{w.kind === "info" ? "i" : "!"}</b><span>{w.text}</span></div>)}
        </div>
      )}
      <History data={data} onUndo={onUndo} />
      {(diff.length > 0 || bad) && (
        <div className="adm-tf-draft" role="region" aria-label="Несохранённые изменения">
          <b>{bad ? "Есть ошибки в полях — исправьте, чтобы применить" : `Не применено: ${diff.length}`}</b>
          {diff.length > 0 && <ul>{diff.map((c) => <li key={c.key}>{changeText(c)}</li>)}</ul>}
          <input className="adm-tf-reason" placeholder="Причина (обязательно): например, «наплыв из одного канала»" aria-label="Причина" maxLength={300}
            value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="adm-row">
            <button className="adm-btn primary" disabled={busy || bad || !diff.length || reason.trim().length < 3} onClick={() => void apply()}>Применить</button>
            <button className="adm-btn" disabled={busy} onClick={reset}>Сбросить</button>
            <span className="adm-muted adm-small">Запишется в историю и журнал админки; откатить — кнопкой в истории.</span>
          </div>
          {note && <span className="adm-err" role="alert">{note}</span>}
        </div>
      )}
    </div>
  );
}

function Field({ f, value, changed, error, def, onChange }: {
  f: TariffField; value: string; changed: boolean; error?: string; def: string | null; onChange: (v: string) => void;
}) {
  return (
    <div className="adm-tf-field">
      <span className="adm-tf-label">{f.title}{f.hint && <em>{f.hint}</em>}{def && <em>по умолчанию: {def}</em>}</span>
      <label className={`adm-tf-num${changed ? " ch" : ""}${error ? " err" : ""}`}>
        <input inputMode="decimal" value={value} aria-label={f.title} aria-invalid={Boolean(error)} onChange={(e) => onChange(e.target.value)} />
        <i>{f.unit}</i>
      </label>
      {error && <span className="adm-err adm-tf-ferr">{error}</span>}
    </div>
  );
}

function Kpi({ title, value, hint, tone }: { title: string; value: string; hint: string; tone?: "good" | "bad" }) {
  return <div className="adm-kpi"><span>{title}</span><b className={`adm-num ${tone ?? ""}`}>{value}</b><i>{hint}</i></div>;
}

function Econ({ items }: { items: [string, string, ("good" | "bad")?][] }) {
  return <div className="adm-tf-econ">{items.map(([k, v, t]) => <div key={k}><span>{k}</span><b className={`adm-num ${t ?? ""}`}>{v}</b></div>)}</div>;
}

const peopleText = (e: PlanEconomy) => (e.people ? `${e.people} чел.` : "пока никого");

function Plans({ d, data, field }: { d: TariffValues; data: TariffsData; field: (f: TariffField) => JSX.Element }) {
  const rev = paidRevenue(d);
  const paid = data.economy.paid, trial = data.economy.trial;
  const margin = paid.avg_month_usd == null ? null : rev - paid.avg_month_usd;
  return (
    <>
      <div className="adm-kpis">
        <Kpi title="Подписка приносит" value={money(rev)} hint={`в месяц с человека: ${d.price} ⭐ × $${d.starUsd} (оценка)`} />
        <Kpi title="Средний расход ИИ подписчика" value={money(paid.avg_month_usd)} hint={`за 30 дней по llm_usage; подписчиков: ${paid.people}`} />
        <Kpi title="Остаётся с подписчика" value={money(margin)} tone={margin == null ? undefined : margin >= 0 ? "good" : "bad"} hint="выручка минус средний расход ИИ; без сервера и налогов" />
        <Kpi title="Проба в среднем стоит" value={money(trial.avg_month_usd)} hint={`расход людей на пробе за 30 дней на человека; на пробе: ${trial.people}`} />
      </div>
      <div className="adm-tf-plans">
        {PLAN_CARDS.map((c) => (
          <div key={c.id} className="adm-tf-card">
            <h3>{c.title}</h3>
            <div className="adm-muted adm-small">{c.who} · {c.id === "gift" ? "считаются вместе с пробой" : peopleText(c.id === "paid" ? paid : trial)}</div>
            <div className="adm-tf-price adm-num">
              {c.id === "paid" ? <>{d.price} ⭐ <small className="adm-muted">за 30 дн. ≈ {money(rev)}</small></> : "Бесплатно"}
            </div>
            <div className="adm-tf-fields">{c.fields.map(field)}</div>
            {c.id === "gift" && (
              <p className="adm-muted adm-small adm-tf-gift">
                Лимиты — как у пробы: потолок {money(d.trialDayUsd)}/день и общий потолок проб. Свои лимиты подарка — этап 2.
              </p>
            )}
            {c.id === "paid" && <Econ items={[["Приносит", money(rev)], ["Остаётся", money(margin), margin == null ? undefined : margin >= 0 ? "good" : "bad"], ["Худший человек", money(paid.worst_month_usd)], ["Дней у потолка", String(paid.capped_days)]]} />}
            {c.id === "trial" && <Econ items={[["Средний расход", money(trial.avg_month_usd)], ["Худший человек", money(trial.worst_month_usd)], ["Худший день", money(trial.worst_day_usd)], ["Дней у потолка", String(trial.capped_days)]]} />}
          </div>
        ))}
      </div>
      <div className="adm-tf-card adm-tf-wide">
        <h3>Друзья и владелец</h3>
        <p className="adm-muted adm-small">Без лимитов и без оплаты — так в коде; ручек здесь нет специально.</p>
        <div className="adm-tf-fields">{PLAN_EXTRA.map(field)}</div>
      </div>
      <details className="adm-tf-defs">
        <summary>Как считаются цифры</summary>
        <dl>
          <dt>Приносит</dt><dd>цена × оценка $ за 1 ⭐ (после комиссий), за 30 дней.</dd>
          <dt>Средний расход</dt><dd>расход ИИ за последние 30 дней (llm_usage, дни UTC; вызовы без цены — по оценке из «Общих потолков») у тех, кто сейчас на этом плане, делённый на число таких людей.</dd>
          <dt>Худший человек</dt><dd>самый большой расход одного человека за эти 30 дней; худший день — самый дорогой день одного человека.</dd>
          <dt>Дней у потолка</dt><dd>сколько раз человек за день дошёл до своего денежного потолка (по нынешнему потолку).</dd>
          <dt>Нет данных</dt><dd>«—»: людей на плане нет или расхода ещё не было — ничего не выдумываем.</dd>
        </dl>
      </details>
    </>
  );
}

function Meter({ title, cur, max, fmt }: { title: string; cur: number; max: number; fmt: (v: number) => string }) {
  const p = Math.min(100, max > 0 ? (cur / max) * 100 : 100);
  return (
    <div className="adm-tf-meter">
      <span>{title}</span><span className="adm-num">{fmt(cur)} из {fmt(max)}</span>
      <div><b className={p > 80 ? "bad" : p > 60 ? "warn" : ""} style={{ width: `${p}%` }} /></div>
    </div>
  );
}

function Caps({ d, data, field, open, setOpen }: {
  d: TariffValues; data: TariffsData; field: (f: TariffField) => JSX.Element; open: boolean; setOpen: (v: boolean) => void;
}) {
  const n = (v: number) => String(v);
  return (
    <div className="adm-tf-caps">
      <div className="adm-tf-card">
        <h3>Сейчас</h3>
        <p className="adm-muted adm-small">Насколько заполнены потолки (с новыми числами из полей).</p>
        <Meter title="Расход всех проб сегодня (UTC)" cur={data.now.trial_pool_today_usd} max={d.trialPoolDayUsd} fmt={money} />
        <Meter title="Регистраций за этот час" cur={data.now.signups_hour} max={d.signupsPerHour} fmt={n} />
        <Meter title="Регистраций за сутки" cur={data.now.signups_day} max={d.signupsPerDay} fmt={n} />
      </div>
      {CAP_GROUPS.map((g) => (
        <div key={g.title} className="adm-tf-card">
          <h3>{g.title}</h3>
          <p className="adm-muted adm-small">{g.hint}</p>
          {g.title === "Регистрация" && (
            <label className={`adm-tf-toggle${open !== data.values.signupsOpen ? " ch" : ""}`}>
              <input type="checkbox" checked={open} onChange={(e) => setOpen(e.target.checked)} />
              <span>Регистрация новых: <b>{open ? "открыта" : "закрыта"}</b></span>
            </label>
          )}
          <div className="adm-tf-fields">{g.fields.map(field)}</div>
        </div>
      ))}
    </div>
  );
}

/** Что сделает «Вернуть» у строки h: только её поля — к значениям до неё; поля, которые эта строка не трогала, остаются. */
export function UndoPreview({ h, data }: { h: TariffsData["history"][number]; data: TariffsData }) {
  const p = undoPreview(h, data.values, data.history);
  return (
    <div className="adm-small" role="note" aria-label="Что изменит откат">
      {p.changes.length
        ? <><b>Станет:</b><ul>{p.changes.map((c) => <li key={c.key}>{changeText(c)}</li>)}</ul></>
        : <span className="adm-muted">Эти поля уже как до #{h.id} — откатывать нечего.</span>}
      <span className="adm-muted">Остальные числа не меняются.</span>
      {p.later.length > 0 && (
        <div className="adm-err">Эти же поля меняли и позже ({p.later.map((id) => `#${id}`).join(", ")}) — откат отменит и их правку этих полей.</div>
      )}
    </div>
  );
}

const when = (iso: string) => new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

function History({ data, onUndo }: { data: TariffsData; onUndo: Send }) {
  const [openId, setOpenId] = useState<number | null>(null);
  const [why, setWhy] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  async function undo(id: number) {
    setBusy(true);
    const err = await onUndo({ id, reason: why.trim() });
    setBusy(false);
    if (err) setNote(err);
  }
  return (
    <>
      <h2 className="adm-h2">История изменений <span className="adm-muted">· каждое «Применить», откат и /signups в боте</span></h2>
      {data.history.length ? (
        <div className="adm-scroll">
          <table className="adm-table adm-tf-hist">
            <thead><tr><th>Когда</th><th>Кто</th><th>Откуда</th><th>Что</th><th>Причина</th><th /></tr></thead>
            <tbody>{data.history.map((h) => (
              <tr key={h.id}>
                <td className="adm-num">{when(h.at)}</td>
                <td className="adm-num">{h.who}</td>
                <td>{TARIFF_SOURCES[h.source] ?? h.source}</td>
                <td>{h.changes.length ? h.changes.map((c) => <div key={c.key}>{changeText(c)}</div>) : <span className="adm-muted">—</span>}</td>
                <td>{h.reason}</td>
                <td>
                  {openId === h.id ? (
                    <div className="adm-tf-undo">
                      <UndoPreview h={h} data={data} />
                      <input className="adm-tf-reason" placeholder="Причина отката" aria-label="Причина отката" maxLength={300} value={why} onChange={(e) => setWhy(e.target.value)} />
                      <div className="adm-row">
                        <button className="adm-btn small primary" disabled={busy || why.trim().length < 3} onClick={() => void undo(h.id)}>Вернуть</button>
                        <button className="adm-btn small" onClick={() => setOpenId(null)}>Отмена</button>
                      </div>
                      {note && <span className="adm-err" role="alert">{note}</span>}
                    </div>
                  ) : h.changes.length > 0 && <button className="adm-btn small" onClick={() => { setOpenId(h.id); setWhy(""); setNote(""); }}>Вернуть как было</button>}
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : <p className="adm-muted">Пока не меняли — действуют значения по умолчанию.</p>}
    </>
  );
}
