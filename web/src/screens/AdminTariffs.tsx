import { useContext, useState } from "react";
import { ApiError, post } from "../api";
import {
  CAP_GROUPS, changeText, fromInput, LIMIT_TEXTS, money, PART_KEYS, paidRevenue, PLAN_CARDS, PLAN_EXTRA, TARIFF_KEYS, TARIFF_SOURCES, tariffDiff,
  tariffValueText, tariffWarnings, toInput, undoPreview, unitMoney, type PlanEconomy, type TariffField, type TariffKey, type TariffPart, type TariffsData,
  type TariffValue, type TariffValues,
} from "../tariffs";
import { CALC_DAYS, CALC_PLANS, CALC_PRESETS, calcAvgDay, calcLimitDay, calcPeople, calcPrices, tariffCalc, type CalcLimit, type CalcPlan } from "../tariffCalc";
import { AdminLost, Loading, useAdmin } from "./AdminSections";

// Разделы админки «Тарифы» и «Общие потолки» (24.11.2026, этап 1 макета docs/review/тарифы-и-управление-макет-2026-11-24.html):
// числа платного доступа из базы (server/src/tariffs.ts). Поля с единицами; изменённые подсвечены, итог — в плашке «Применить /
// Сбросить» внизу (причина обязательна); история с «Вернуть как было» (возвращает только поля этой строки; перед откатом — что
// изменится и какие более поздние строки трогали те же поля); предупреждения — только те, что честно считаются из чисел;
// экономика тарифа — из llm_usage за 30 дней, нет данных — «—». Только числа и номера аккаунтов, без имён и текстов людей.
// Этап 2: у пробы, подписки и подарка — лимиты в штуках (запросы, картинки, минуты голоса) и денежный предохранитель; худший
// случай — по средним ценам единиц (unit_prices) и лимитам; тексты при упоре в лимит — в «Общих потолках».
// 25.11.2026: карточки тарифов — широкие, друг под другом, поля сеткой (подпись, поле с единицей, пояснение серой строкой под полем);
// вверху «Тарифов» — «Калькулятор» (web/src/tariffCalc.ts): люди на пробе / подписке / с подарком и активность → расход ИИ, доход
// подписок, итог в месяц и худший случай — по числам из полей (и ещё не применённым), на сервере ничего не меняет.

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
  Object.fromEntries(TARIFF_KEYS.filter((k) => k !== "signupsOpen").map((k) => [k, toInput(k, v[k] as number | string)])) as Record<TariffKey, string>;

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
  const draft = { ...applied, signupsOpen: open } as Record<TariffKey, TariffValue>;
  for (const k of PART_KEYS[part]) {
    if (k === "signupsOpen") continue;
    const r = fromInput(k, text[k]);
    if (r.error) errors[k] = r.error;
    else draft[k] = r.value;
  }
  const d = draft as unknown as TariffValues;
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
  const warnings = tariffWarnings(d, applied, part, Boolean(data.env_closed), data.unit_prices);
  return (
    <div className="adm-tf">
      <p className="adm-muted adm-tf-lead">
        {part === "plans"
          ? "Числа меняют поведение сервера сразу после «Применить», без выкладки. Изменённые поля подсвечены, итог — в плашке внизу."
          : "Защита всего сервера, а не одного человека: наплыв одноразовых аккаунтов не съест бюджет."}
        {" "}Другие процессы сервера перечитывают таблицу раз в {Math.round(data.reload_ms / 1000)} с.
      </p>
      {part === "plans" ? <Plans d={d} data={data} field={field} /> : (
        <Caps d={d} data={data} field={field} open={open} setOpen={setOpen}
          texts={LIMIT_TEXTS.map((f) => (
            <TextField key={f.key} f={f} value={text[f.key]} changed={!errors[f.key] && d[f.key] !== applied[f.key]} error={errors[f.key]}
              onChange={(v) => setText((t) => ({ ...t, [f.key]: v }))} />
          ))} />
      )}
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
      <span className="adm-tf-label">{f.title}</span>
      <label className={`adm-tf-num${changed ? " ch" : ""}${error ? " err" : ""}`}>
        <input inputMode="decimal" value={value} aria-label={f.title} aria-invalid={Boolean(error)} onChange={(e) => onChange(e.target.value)} />
        <i>{f.unit}</i>
      </label>
      {(f.hint || def) && <span className="adm-tf-hint">{f.hint}{f.hint && def ? " · " : ""}{def && `по умолчанию: ${def}`}</span>}
      {error && <span className="adm-err adm-tf-ferr">{error}</span>}
    </div>
  );
}

function TextField({ f, value, changed, error, onChange }: { f: TariffField; value: string; changed: boolean; error?: string; onChange: (v: string) => void }) {
  return (
    <div className="adm-tf-field adm-tf-text">
      <span className="adm-tf-label">{f.title}{f.hint && <em>{f.hint}</em>}</span>
      <textarea className={`adm-tf-txt${changed ? " ch" : ""}${error ? " err" : ""}`} rows={3} maxLength={300} value={value} aria-label={`Текст при упоре в лимит: ${f.title}`}
        aria-invalid={Boolean(error)} onChange={(e) => onChange(e.target.value)} />
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
  const paid = data.economy.paid, trial = data.economy.trial, gift = data.economy.gift;
  const prices = data.unit_prices;
  // Та же цифра «у лимита», что в калькуляторе (calcLimitDay): оценки цен из «Общих потолков», запросов 0 — закрыт.
  const calcP = calcPrices(d, prices);
  const worst = (id: CalcPlan) => limitText(calcLimitDay(d, id, calcP, calcAvgDay(d, id, data.economy[id])?.usd ?? null));
  const atLimit = (e?: PlanEconomy) => (e?.quota_days == null ? "—" : String(e.quota_days));
  const margin = paid.avg_month_usd == null ? null : rev - paid.avg_month_usd;
  return (
    <>
      <Calculator d={d} data={data} />
      <div className="adm-kpis">
        <Kpi title="Подписка приносит" value={money(rev)} hint={`в месяц с человека: ${d.price} ⭐ × $${d.starUsd} (оценка)`} />
        <Kpi title="Средний расход ИИ подписчика" value={money(paid.avg_month_usd)} hint={`за 30 дней по llm_usage; подписчиков: ${paid.people}`} />
        <Kpi title="Остаётся с подписчика" value={money(margin)} tone={margin == null ? undefined : margin >= 0 ? "good" : "bad"} hint="выручка минус средний расход ИИ; без сервера и налогов" />
        <Kpi title="Проба в среднем стоит" value={money(trial.avg_month_usd)} hint={`расход людей на пробе за 30 дней на человека; на пробе: ${trial.people}`} />
      </div>
      <div className="adm-tf-plans">
        {PLAN_CARDS.map((c) => (
          <div key={c.id} className="adm-tf-card">
            <div className="adm-tf-head">
              <div>
                <h3>{c.title}</h3>
                <div className="adm-muted adm-small">{c.who} · {c.id === "gift" ? (gift ? peopleText(gift) : "—") : peopleText(c.id === "paid" ? paid : trial)}</div>
              </div>
              <div className="adm-tf-price adm-num">
                {c.id === "paid" ? <>{d.price} ⭐ <small className="adm-muted">за 30 дн. ≈ {money(rev)}</small></> : "Бесплатно"}
              </div>
            </div>
            <div className="adm-tf-fields">{c.fields.map(field)}</div>
            {c.id === "paid" && <Econ items={[["Приносит", money(rev)], ["Остаётся", money(margin), margin == null ? undefined : margin >= 0 ? "good" : "bad"], ["Худший человек", money(paid.worst_month_usd)], ["Худший случай/день", worst("paid")], ["Дней у потолка", String(paid.capped_days)], ["Дней у лимита шт.", atLimit(paid)]]} />}
            {c.id === "trial" && <Econ items={[["Средний расход", money(trial.avg_month_usd)], ["Худший человек", money(trial.worst_month_usd)], ["Худший день", money(trial.worst_day_usd)], ["Худший случай/день", worst("trial")], ["Дней у потолка", String(trial.capped_days)], ["Дней у лимита шт.", atLimit(trial)]]} />}
            {c.id === "gift" && <Econ items={[["Средний расход", money(gift?.avg_month_usd)], ["Худший человек", money(gift?.worst_month_usd)], ["Худший день", money(gift?.worst_day_usd)], ["Худший случай/день", worst("gift")], ["Дней у потолка", gift ? String(gift.capped_days) : "—"], ["Дней у лимита шт.", atLimit(gift)]]} />}
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
          <dt>Дней у потолка</dt><dd>сколько раз человек за день дошёл до своего денежного предохранителя (по нынешнему).</dd>
          <dt>Дней у лимита шт.</dt><dd>сколько раз человек за день выбрал целиком хоть один лимит в штуках (запросы, картинки или голос; счётчики ai_quota, по нынешним лимитам).</dd>
          <dt>Лимиты в штуках</dt><dd>на человека в день, сброс в его полночь (по поясу из настроек). Запрос — одно обращение человека: сообщение, голосовое, фото, /ask, поправка, «Повторить», /summary (внутренние вызовы модели и фоновые повторы не считаются); картинка — один рисунок; голос — секунды записи. 0 — функция на тарифе недоступна. Друзья и владелец — без лимитов.</dd>
          <dt>Худший случай/день</dt><dd>то же, что «у лимита» в калькуляторе: человек выбирает все лимиты в штуках по средним ценам за 30 дней (запрос {unitMoney(calcP.call)}, картинка {unitMoney(calcP.draw)}, минута голоса {unitMoney(calcP.voiceMin)}), но не больше денежного предохранителя («предохр.»); цены ещё нет — оценка из «Общих потолков» («оценка», не ниже того, что люди уже тратят); запросов 0 — ИИ закрыт, $0.</dd>
          <dt>Нет данных</dt><dd>«—»: людей на плане нет или расхода ещё не было — ничего не выдумываем.</dd>
        </dl>
      </details>
    </>
  );
}

/** «У лимита» на человека в день с пометкой, по чему считано: предохранитель, оценка цен, закрыт. */
export function limitText(l: CalcLimit): string {
  return unitMoney(l.usd) + (l.by === "closed" ? " (закрыт)" : l.by === "cap" ? " (предохр.)" : l.estimated ? " (оценка)" : "");
}

const CALC_TITLES: Record<CalcPlan, string> = { trial: "Проба", paid: "Подписка", gift: "Подарок" };
const CALC_INPUTS: Record<CalcPlan, string> = { trial: "Людей на пробе", paid: "Людей на подписке", gift: "Людей с подарком" };
const pct = (a: number) => `${Math.round(a * 100)}%`;
const tone = (v: number) => (v >= 0 ? "good" : "bad");

/** «Калькулятор» вверху «Тарифов»: сколько людей и насколько активны → расход ИИ, доход подписок, итог за месяц и худший случай.
 *  d — числа из полей (вместе с неприменёнными): правка лимита пересчитывает сразу. Ничего не отправляет на сервер. */
export function Calculator({ d, data, start }: { d: TariffValues; data: TariffsData; start?: { people?: Partial<Record<CalcPlan, string>>; activity?: number } }) {
  const [people, setPeople] = useState<Record<CalcPlan, string>>(() => ({
    trial: String(data.economy.trial.people), paid: String(data.economy.paid.people), gift: String(data.economy.gift?.people ?? 0), ...start?.people,
  }));
  const [act, setAct] = useState(start?.activity ?? 0);
  const parsed = Object.fromEntries(CALC_PLANS.map((id) => [id, calcPeople(people[id])])) as Record<CalcPlan, number | null>;
  const counts = Object.fromEntries(CALC_PLANS.map((id) => [id, parsed[id] ?? 0])) as Record<CalcPlan, number>;
  const r = tariffCalc(d, data.economy, data.unit_prices, { people: counts, activity: act });
  const now = (id: CalcPlan) => data.economy[id]?.people ?? 0;
  const estName = { call: `запрос ${unitMoney(r.prices.call)}`, draw: `картинка ${unitMoney(r.prices.draw)}`, voiceMin: `минута голоса ${unitMoney(r.prices.voiceMin)}` };
  const notes: string[] = [];
  if (r.prices.estimated.length) {
    notes.push(`Оценка: за 30 дней таких штук ещё не брали — цена из «Общих потолков» (вызов без цены): ${r.prices.estimated.map((k) => estName[k]).join(", ")}.`);
  }
  const other = r.rows.filter((x) => x.avg === "other").map((x) => CALC_TITLES[x.id]);
  if (other.length) notes.push(`Оценка: у тарифа ${other.map((x) => `«${x}»`).join(", ")} своего среднего ещё нет — взят средний расход другого тарифа.`);
  const avgEst = r.rows.filter((x) => x.avgEstimated).map((x) => CALC_TITLES[x.id]);
  if (avgEst.length) notes.push(`Оценка: сервер не дал среднего за день на тарифе — у ${avgEst.map((x) => `«${x}»`).join(", ")} расход за 30 дней поделён на длину срока (проба ${d.trialDays} дн., подарок ${d.giftDays} дн., подписка ${CALC_DAYS}).`);
  const raised = r.rows.filter((x) => x.limitRaised).map((x) => CALC_TITLES[x.id]);
  if (raised.length) notes.push(`Оценка: у ${raised.map((x) => `«${x}»`).join(", ")} лимиты по оценочным ценам дают меньше, чем люди уже тратят, — «у лимита» взят не ниже измеренного среднего (до предохранителя).`);
  if (r.rows.some((x) => x.avg === "none")) notes.push("Среднего расхода ещё нет ни у кого — «как сейчас» считается как 0; правый край ползунка — по лимитам.");
  if (r.pool.now || r.pool.worst || r.pool.cap) {
    notes.push(`Проба и подарок вместе упираются в общий потолок проб ${money(d.trialPoolDayUsd)}/день — расход сверх него срезан (кому не хватило, ИИ в этот день отказывает).`);
  }
  for (const x of r.rows) if (x.limitBy === "closed") notes.push(`${CALC_TITLES[x.id]}: запросов к ИИ 0 — тариф ничего не тратит.`);
  return (
    <section className="adm-tf-card adm-tf-calc" aria-label="Калькулятор">
      <div>
        <h3>Калькулятор</h3>
        <p className="adm-muted adm-small">Что будет при таком числе людей и такой активности — по числам из полей ниже, в том числе ещё не применённым. На сервере ничего не меняет.</p>
      </div>
      <div className="adm-tf-fields">
        {CALC_PLANS.map((id) => (
          <div key={id} className="adm-tf-field">
            <span className="adm-tf-label">{CALC_INPUTS[id]}</span>
            <label className={`adm-tf-num${parsed[id] == null ? " err" : ""}`}>
              <input inputMode="numeric" value={people[id]} aria-label={CALC_INPUTS[id]} aria-invalid={parsed[id] == null}
                onChange={(e) => setPeople((p) => ({ ...p, [id]: e.target.value }))} />
              <i>чел.</i>
            </label>
            <span className="adm-tf-hint">{parsed[id] == null ? "целое число от 0 — пока считается 0" : `сейчас на тарифе: ${now(id)}`}</span>
          </div>
        ))}
        <div className="adm-tf-field adm-tf-act">
          <span className="adm-tf-label">Активность: <b className="adm-num">{pct(act)}</b></span>
          <input className="adm-tf-range" type="range" min={0} max={100} step={5} value={Math.round(act * 100)} aria-label="Активность"
            onChange={(e) => setAct(Number(e.target.value) / 100)} />
          <div className="adm-row adm-tf-presets">
            {CALC_PRESETS.map((x) => {
              const on = Math.abs(act - x) < 1e-9;
              return <button key={x} type="button" className={`adm-btn small${on ? " primary" : ""}`} aria-pressed={on} onClick={() => setAct(x)}>{x === 0 ? "как сейчас" : pct(x)}</button>;
            })}
          </div>
          <span className="adm-tf-hint">0% — как сейчас в среднем, 100% — каждый день выбирают все лимиты в штуках (не больше предохранителя)</span>
        </div>
      </div>
      <div className="adm-scroll">
        <table className="adm-table adm-tf-calctab">
          <thead><tr><th>Тариф</th><th>Людей</th><th>На человека в день</th><th>Расход ИИ в день</th><th>В месяц</th><th>Доход в месяц</th><th>Худший месяц</th></tr></thead>
          <tbody>
            {r.rows.map((x) => (
              <tr key={x.id}>
                <td>{CALC_TITLES[x.id]}</td>
                <td className="adm-num">{x.people}</td>
                <td className="adm-num">
                  {unitMoney(x.personDayUsd)}
                  <span className="adm-tf-hint">средн. {unitMoney(x.avgDayUsd)}{x.avgEstimated ? " (оценка)" : ""} · у лимита {limitText({ usd: x.limitDayUsd, by: x.limitBy, estimated: x.limitEstimated, raised: x.limitRaised })}</span>
                </td>
                <td className="adm-num">
                  {money(x.dayUsd)}
                  {x.id !== "paid" && r.pool.now && x.people > 0 && <span className="adm-tf-hint">потолок проб: {unitMoney(x.dayUsd / x.people)}/чел.</span>}
                </td>
                <td className="adm-num">{money(x.monthUsd)}{x.id !== "paid" && r.pool.now && x.people > 0 && <span className="adm-tf-hint">потолок проб</span>}</td>
                <td className="adm-num">{x.id === "paid" ? money(x.revenueMonthUsd) : "—"}</td>
                <td className="adm-num">{money(x.worstMonthUsd)}{x.id !== "paid" && r.pool.worst && x.people > 0 && <span className="adm-tf-hint">потолок проб</span>}</td>
              </tr>
            ))}
            <tr className="adm-tf-total">
              <td>Всего</td>
              <td className="adm-num">{r.rows.reduce((s, x) => s + x.people, 0)}</td>
              <td />
              <td className="adm-num">{money(r.dayUsd)}</td>
              <td className="adm-num">{money(r.monthUsd)}</td>
              <td className="adm-num">{money(r.revenueMonthUsd)}</td>
              <td className="adm-num">{money(r.worstMonthUsd)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <Econ items={[
        ["Доход от подписок в месяц", money(r.revenueMonthUsd)],
        ["Расход на ИИ в месяц", money(r.monthUsd)],
        ["Итог в месяц", money(r.profitMonthUsd), tone(r.profitMonthUsd)],
      ]} />
      <div className="adm-tf-worst" role="note" aria-label="Худший случай">
        <b>Худший случай за месяц:</b>
        <span>все каждый день у лимитов в штуках — расход {money(r.worstMonthUsd)}, итог <b className={`adm-num ${tone(r.worstProfitMonthUsd)}`}>{money(r.worstProfitMonthUsd)}</b>;</span>
        <span>все тратят свой денежный предохранитель целиком — расход {money(r.capMonthUsd)}, итог <b className={`adm-num ${tone(r.capProfitMonthUsd)}`}>{money(r.capProfitMonthUsd)}</b>.</span>
      </div>
      {notes.length > 0 && <ul className="adm-tf-notes adm-muted adm-small">{notes.map((n) => <li key={n}>{n}</li>)}</ul>}
      <details className="adm-tf-defs">
        <summary>Как считает калькулятор</summary>
        <dl>
          <dt>Месяц</dt><dd>{CALC_DAYS} дней; доход — люди на подписке × цена × $ за 1 ⭐ (оценка после комиссий); проба и подарок дохода не дают.</dd>
          <dt>Как сейчас</dt><dd>средний расход ИИ человека за день на этом тарифе (llm_usage за 30 дней, делённый на дни, которые люди в окне были на тарифе: проба — не больше её срока), но не больше того, что пускают лимиты из полей.</dd>
          <dt>У лимита</dt><dd>человек каждый день выбирает все лимиты в штуках по средним ценам единиц (запрос {unitMoney(r.prices.call)}, картинка {unitMoney(r.prices.draw)}, минута голоса {unitMoney(r.prices.voiceMin)}), но не больше денежного предохранителя; цена — оценка, а люди уже тратят больше — не ниже их среднего; запросов 0 — расхода нет. Та же цифра — «Худший случай/день» в карточках тарифов.</dd>
          <dt>Активность</dt><dd>доля пути от «как сейчас» до «у лимита» — у всех людей сразу.</dd>
          <dt>Худший случай</dt><dd>все каждый день у лимитов в штуках; «предохранитель целиком» — абсолютный потолок сервера, даже если средние цены единиц занижены. Проба и подарок вместе — не больше общего потолка проб в день: где он сработал, в строке подпись «потолок проб», и людей × на человека тогда больше расхода.</dd>
          <dt>Не учтено</dt><dd>сервер, налоги, возвраты; люди за месяц не приходят и не уходят.</dd>
        </dl>
      </details>
    </section>
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

function Caps({ d, data, field, open, setOpen, texts }: {
  d: TariffValues; data: TariffsData; field: (f: TariffField) => JSX.Element; open: boolean; setOpen: (v: boolean) => void; texts: JSX.Element[];
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
      <div className="adm-tf-card">
        <h3>Что увидит человек, когда лимит кончился</h3>
        <p className="adm-muted adm-small">Текст Рины при упоре в лимит в штуках (запросы, картинки, голос). Без цифр расхода — по-человечески и с выходом. Без знаков &lt; &gt; &amp;.</p>
        <div className="adm-tf-fields">{texts}</div>
      </div>
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
