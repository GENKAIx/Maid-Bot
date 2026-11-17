import { Bars } from "../charts";
import { Card, Empty } from "../components";
import { factChips, rateTone, type DayFacts } from "../dayrate";
import { humanDay } from "../format";

// «Статистика» → «Оценка дня»: средняя оценка и столбики за период, ниже — дни, свежие сверху: оценка и коротко, что было
// (dayrate.ts). Щелчок по дню — статистика этого дня.

export function DayRatings({ rows, bars, oneDay, onPick }: {
  rows: DayFacts[]; bars: { label: string; title: string; value: number }[]; oneDay: boolean; onPick: (day: string) => void;
}) {
  const rated = rows.filter((r) => r.rating !== undefined).map((r) => r.rating!);
  const avg = rated.length ? rated.reduce((s, v) => s + v, 0) / rated.length : 0;
  const one = (v: number) => v.toLocaleString("ru-RU", { maximumFractionDigits: 1 });
  const head = rated.length && !oneDay ? `в среднем ${one(avg)} из 10 · оценок: ${rated.length}` : "";
  return (
    <Card title="Оценка дня" className="reveal wide" action={<span className="muted small">{head}</span>}>
      {!oneDay && rated.length > 1 && <Bars bars={bars} color="var(--accent)" format={(v) => `${one(v)} из 10`} goal={10} height={110} />}
      {rows.length ? (
        <ul className="day-rates">
          {rows.map((r) => {
            const chips = factChips(r);
            return (
              <li key={r.day}>
                <button className="day-rate" onClick={() => onPick(r.day)} disabled={oneDay} title={oneDay ? undefined : "Открыть этот день"}>
                  <span className="day-rate-date">{humanDay(r.day)}</span>
                  <span className={`rate-badge ${r.rating !== undefined ? rateTone(r.rating) : "none"}`}>{r.rating !== undefined ? r.rating : "—"}</span>
                  <span className="day-rate-facts">{chips.length ? chips.join(" · ") : <span className="muted">больше ничего не записано</span>}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : <Empty>Оценок пока нет — горничная спрашивает её под вечерним итогом</Empty>}
    </Card>
  );
}
