import { useEffect, useState } from "react";
import { get } from "../api";
import { Segment, Shares, StackedBars } from "../charts";
import { Card, Chip, Empty, Spinner } from "../components";
import { addDays, addMonths, daysInMonth, humanDay, money, monthTitle, shortDay, todayKey } from "../format";
import { catColor, catKey, dayGroups, monthForecast } from "../moneyview";
import type { MoneyRow } from "../types";

// Деньги: месяц — доходы и расходы по валютам, расходы по дням (столбики по категориям, прогноз до конца месяца),
// категории (щелчок — показать только её), записи по дням. У категории везде один цвет (moneyview.ts).

type Period = "month" | "year" | "all";

export function Money({ version }: { version: number }) {
  const today = todayKey();
  const [period, setPeriod] = useState<Period>("month");
  const [month, setMonth] = useState(today.slice(0, 7));
  const [rows, setRows] = useState<MoneyRow[] | null>(null);
  const [cur, setCur] = useState("");
  const [pick, setPick] = useState<string | null>(null);
  const [error, setError] = useState("");

  const from = period === "month" ? `${month}-01` : period === "year" ? `${month.slice(0, 4)}-01-01` : "2000-01-01";
  const to = period === "month" ? `${month}-${daysInMonth(month)}` : period === "year" ? `${month.slice(0, 4)}-12-31` : "2100-01-01";

  useEffect(() => {
    let alive = true;
    setRows(null);
    get<{ rows: MoneyRow[] }>(`/api/money?from=${from}&to=${to}`).then((r) => alive && setRows(r.rows)).catch((e) => alive && setError((e as Error).message));
    return () => { alive = false; };
  }, [from, to, version]);

  if (error) return <Empty>Нет связи: {error}</Empty>;
  if (!rows) return <Spinner />;

  const currencies = [...new Set(rows.map((r) => r.currency))];
  const c = currencies.includes(cur) ? cur : currencies[0] ?? "RUB";
  const mine = rows.filter((r) => r.currency === c);
  const spent = mine.filter((r) => r.kind === "expense");
  const income = mine.filter((r) => r.kind === "income").reduce((s, r) => s + r.amount, 0);
  const expense = spent.reduce((s, r) => s + r.amount, 0);
  const fmt = (v: number) => money(v, c);

  const cats = new Map<string, number>();
  for (const r of spent) cats.set(catKey(r.category), (cats.get(catKey(r.category)) ?? 0) + r.amount);
  const order = [...cats.entries()].sort((a, b) => b[1] - a[1]);
  const shares = order.map(([label, value]) => ({ label, value, color: catColor(label) }));
  // Выбранная категория пропала (другой месяц или валюта) — выбора нет.
  const sel = pick && cats.has(pick) ? pick : null;
  const shown = sel ? spent.filter((r) => catKey(r.category) === sel) : mine;
  const shownExpense = sel ? cats.get(sel) ?? 0 : expense;

  const isNow = period === "month" && month === today.slice(0, 7);
  const forecast = period === "month" ? monthForecast(sel ? shown : spent, month, today) : null;

  // Расходы по дням месяца (или по месяцам года), каждый столбик — из категорий.
  const partsOf = (list: MoneyRow[]) => order.map(([key]) => ({
    key, color: catColor(key), value: list.filter((r) => catKey(r.category) === key).reduce((s, r) => s + r.amount, 0),
  }));
  let bars: { label: string; title: string; mark?: boolean; future?: boolean; parts: ReturnType<typeof partsOf> }[] = [];
  if (period === "month") {
    bars = Array.from({ length: daysInMonth(month) }, (_, i) => {
      const d = `${month}-${String(i + 1).padStart(2, "0")}`;
      return {
        label: d === today ? `сегодня, ${i + 1}` : String(i + 1), title: humanDay(d), mark: d === today,
        future: isNow && d > today, parts: partsOf(spent.filter((r) => r.day_key === d)),
      };
    });
  } else if (period === "year") {
    bars = Array.from({ length: 12 }, (_, i) => {
      const m = `${month.slice(0, 4)}-${String(i + 1).padStart(2, "0")}`;
      return { label: monthTitle(m).slice(0, 3), title: monthTitle(m), parts: partsOf(spent.filter((r) => r.day_key.startsWith(m))) };
    });
  }

  const groups = dayGroups(shown);
  let left = 100;
  const dayTitle = (d: string) => d === today ? "Сегодня" : d === addDays(today, -1) ? "Вчера" : humanDay(d);
  const title = period === "month" ? monthTitle(month) : period === "year" ? month.slice(0, 4) : "За всё время";

  return (
    <div className="screen">
      <div className="day-nav">
        {period !== "all" && <button className="ghost" onClick={() => setMonth(period === "month" ? addMonths(month, -1) : addMonths(month, -12))} aria-label="Назад">‹</button>}
        <h2 className="screen-title">{title}</h2>
        {period !== "all" && <button className="ghost" onClick={() => setMonth(period === "month" ? addMonths(month, 1) : addMonths(month, 12))} aria-label="Вперёд">›</button>}
        <span className="spacer" />
        <Segment value={period} options={[{ id: "month", title: "Месяц" }, { id: "year", title: "Год" }, { id: "all", title: "Всё" }]} onChange={setPeriod} />
      </div>

      <div className="totals reveal">
        <div className="total good"><span className="muted small">Доходы</span><b>{fmt(income)}</b></div>
        <div className="total bad"><span className="muted small">{sel ? `Расходы · ${sel}` : "Расходы"}</span><b>{fmt(shownExpense)}</b></div>
        {forecast
          ? <div className="total warn"><span className="muted small">К концу месяца{sel ? ` · ${sel}` : ""}</span><b>≈ {fmt(forecast.total)}</b></div>
          : <div className="total"><span className="muted small">Итог</span><b>{(income - expense >= 0 ? "+" : "−") + fmt(Math.abs(income - expense))}</b></div>}
        {currencies.length > 1 && (
          <div className="chips">{currencies.map((x) => <button key={x} className={`chip-btn ${x === c ? "on" : ""}`} onClick={() => setCur(x)}>{x}</button>)}</div>
        )}
      </div>

      <div className="cards">
        {bars.length > 0 && (
          <Card title="Расходы по дням" className="reveal wide">
            {expense ? (
              <StackedBars
                bars={bars}
                format={fmt}
                highlight={sel}
                avg={isNow && forecast ? { value: forecast.perDay, label: `в среднем ${fmt(forecast.perDay)} в день` } : undefined}
              />
            ) : <Empty>Расходов не записано</Empty>}
          </Card>
        )}
        <Card title="По категориям" className="reveal">
          {shares.length ? <Shares items={shares} format={fmt} active={sel} onPick={setPick} /> : <Empty>Расходов нет</Empty>}
        </Card>
        <Card title={sel ? `Записи · ${sel} · ${shown.length}` : `Записи · ${mine.length}`} className="reveal">
          {shown.length ? (
            <ul className="list">
              {groups.map((g) => {
                if (left <= 0) return null;
                const items = g.rows.slice(0, left);
                left -= items.length;
                return [
                  <li key={g.day} className="money-day">
                    <span>{dayTitle(g.day)}</span>
                    <b className={g.total >= 0 ? "good" : "bad"}>{g.total >= 0 ? "+" : "−"}{fmt(Math.abs(g.total))}</b>
                  </li>,
                  ...items.map((r) => (
                    <li key={r.id}>
                      {r.kind === "expense" ? <i className="share-dot" style={{ background: catColor(r.category) }} /> : <i className="share-dot" style={{ background: "var(--green)" }} />}
                      <span className="grow">{r.note || r.category || (r.kind === "income" ? "доход" : "расход")}{r.note && r.category && <span className="muted small"> · {r.category}</span>}</span>
                      <Chip tone={r.kind === "income" ? "good" : "bad"}>{r.kind === "income" ? "+" : "−"}{fmt(r.amount)}</Chip>
                    </li>
                  )),
                ];
              })}
            </ul>
          ) : <Empty>Напишите, например: «потратил 1200 на продукты» или «получил зарплату 90 000»</Empty>}
        </Card>
      </div>
      <p className="muted small">Период: {shortDay(from)} – {to < "2100" ? shortDay(to) : "сегодня"}{period === "all" ? "" : `, ${addDays(to, 0) > today ? "идёт" : "закрыт"}`}</p>
    </div>
  );
}
