import { useEffect, useState } from "react";
import { get } from "../api";
import { Bars, Segment, Shares } from "../charts";
import { Card, Chip, Empty, Spinner } from "../components";
import { addDays, addMonths, daysInMonth, humanDay, money, monthTitle, shortDay, todayKey } from "../format";
import type { MoneyRow } from "../types";

// Деньги: месяц — доходы и расходы по валютам, расходы по категориям, по дням, список.

type Period = "month" | "year" | "all";

export function Money({ version }: { version: number }) {
  const today = todayKey();
  const [period, setPeriod] = useState<Period>("month");
  const [month, setMonth] = useState(today.slice(0, 7));
  const [rows, setRows] = useState<MoneyRow[] | null>(null);
  const [cur, setCur] = useState("");
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
  const income = mine.filter((r) => r.kind === "income").reduce((s, r) => s + r.amount, 0);
  const expense = mine.filter((r) => r.kind === "expense").reduce((s, r) => s + r.amount, 0);
  const fmt = (v: number) => money(v, c);

  const cats = new Map<string, number>();
  for (const r of mine) if (r.kind === "expense") cats.set(r.category || "другое", (cats.get(r.category || "другое") ?? 0) + r.amount);
  const shares = [...cats.entries()].sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value }));

  // Расходы по дням месяца (или по месяцам года).
  let bars: { label: string; value: number; title: string }[] = [];
  if (period === "month") {
    bars = Array.from({ length: daysInMonth(month) }, (_, i) => {
      const d = `${month}-${String(i + 1).padStart(2, "0")}`;
      return { label: String(i + 1), title: humanDay(d), value: mine.filter((r) => r.kind === "expense" && r.day_key === d).reduce((s, r) => s + r.amount, 0) };
    });
  } else if (period === "year") {
    bars = Array.from({ length: 12 }, (_, i) => {
      const m = `${month.slice(0, 4)}-${String(i + 1).padStart(2, "0")}`;
      return { label: monthTitle(m).slice(0, 3), title: monthTitle(m), value: mine.filter((r) => r.kind === "expense" && r.day_key.startsWith(m)).reduce((s, r) => s + r.amount, 0) };
    });
  }

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
        <div className="total bad"><span className="muted small">Расходы</span><b>{fmt(expense)}</b></div>
        <div className="total"><span className="muted small">Итог</span><b>{(income - expense >= 0 ? "+" : "−") + fmt(Math.abs(income - expense))}</b></div>
        {currencies.length > 1 && (
          <div className="chips">{currencies.map((x) => <button key={x} className={`chip-btn ${x === c ? "on" : ""}`} onClick={() => setCur(x)}>{x}</button>)}</div>
        )}
      </div>

      <div className="cards">
        {bars.length > 0 && (
          <Card title="Расходы по дням" className="reveal wide">
            {expense ? <Bars bars={bars} color="var(--red)" format={fmt} /> : <Empty>Расходов не записано</Empty>}
          </Card>
        )}
        <Card title="По категориям" className="reveal">
          {shares.length ? <Shares items={shares} format={fmt} /> : <Empty>Расходов нет</Empty>}
        </Card>
        <Card title={`Записи · ${mine.length}`} className="reveal">
          {mine.length ? (
            <ul className="list">
              {[...mine].reverse().slice(0, 100).map((r) => (
                <li key={r.id}>
                  <span className="time">{shortDay(r.day_key)}</span>
                  <span className="grow">{r.note || r.category || (r.kind === "income" ? "доход" : "расход")}{r.note && r.category && <span className="muted small"> · {r.category}</span>}</span>
                  <Chip tone={r.kind === "income" ? "good" : "bad"}>{r.kind === "income" ? "+" : "−"}{fmt(r.amount)}</Chip>
                </li>
              ))}
            </ul>
          ) : <Empty>Напишите, например: «потратил 1200 на продукты» или «получил зарплату 90 000»</Empty>}
        </Card>
      </div>
      <p className="muted small">Период: {shortDay(from)} – {to < "2100" ? shortDay(to) : "сегодня"}{period === "all" ? "" : `, ${addDays(to, 0) > today ? "идёт" : "закрыт"}`}</p>
    </div>
  );
}
