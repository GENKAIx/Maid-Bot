import { useEffect, useState } from "react";
import { get } from "../api";
import { Bars, Segment, Shares } from "../charts";
import { Empty, Spinner } from "../components";

// Расход модели, рисования и голоса (GET /api/usage): деньги и токены по дням, на что ушло, какие модели. Карточка в «Настройках».

interface Sum { calls: number; input: number; output: number; cost: number; priced: number }
interface Report {
  from: string; to: string;
  days: (Sum & { day: string; kinds: Record<string, number> })[];
  total: Sum;
  kinds: (Sum & { kind: string })[];
  models: (Sum & { model: string })[];
  month: Sum;
}

/** Назначения запросов (server/src/llm.ts, USAGE_KINDS). */
const KIND_NAMES: Record<string, string> = {
  parse: "Разбор сообщений", answer: "Ответы на вопросы", chat: "Разговор", summary: "Вечерний итог",
  patterns: "Связи в самочувствии", draw: "Рисование", voice: "Голосовые", other: "Другое",
};
const KIND_COLORS: Record<string, string> = {
  parse: "var(--accent)", answer: "var(--blue)", chat: "var(--green)", summary: "var(--orange)",
  patterns: "var(--red)", draw: "#c65fb8", voice: "#2bb3b0", other: "var(--grey)",
};
const kindName = (k: string) => KIND_NAMES[k] ?? k;

/** Доллары: мелкие суммы — с нужным числом знаков (0,0042 $), крупные — до центов. */
export function usd(v: number): string {
  if (!v) return "0 $";
  const digits = v < 0.01 ? 4 : v < 1 ? 3 : 2;
  return `${v.toLocaleString("ru-RU", { minimumFractionDigits: Math.min(2, digits), maximumFractionDigits: digits })} $`;
}
const tokens = (n: number) =>
  n < 1000 ? `${n}` : n < 1e6 ? `${Math.round(n / 1000).toLocaleString("ru-RU")} тыс.` : `${(Math.round(n / 1e4) / 100).toLocaleString("ru-RU")} млн`;
const calls = (n: number) => `${n.toLocaleString("ru-RU")} ${n % 10 === 1 && n % 100 !== 11 ? "запрос" : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? "запроса" : "запросов"}`;
const dayLabel = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });

export function SpendCard() {
  const [days, setDays] = useState<"7" | "30" | "90">("30");
  const [r, setR] = useState<Report | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setError("");
    get<Report>(`/api/usage?days=${days}`).then(setR).catch((e) => setError((e as Error).message));
  }, [days]);

  if (error) return <p className="muted small">Не загрузилось: {error}</p>;
  if (!r) return <Spinner />;
  const t = r.total;
  const money = t.priced > 0; // хоть у чего-то есть цена — столбики в долларах, иначе в запросах
  const unpriced = t.calls - t.priced;
  return (
    <div className="spend">
      <Segment value={days} onChange={setDays} options={[{ id: "7", title: "7 дней" }, { id: "30", title: "30 дней" }, { id: "90", title: "90 дней" }]} />
      <div className="spend-head">
        <b className="spend-sum">{money ? usd(t.cost) : calls(t.calls)}</b>
        <span className="muted small">
          {money ? `${calls(t.calls)} · ` : ""}{tokens(t.input + t.output)} токенов ({tokens(t.input)} на вход, {tokens(t.output)} на ответ)
        </span>
        <span className="muted small">В этом месяце: {r.month.priced ? usd(r.month.cost) + " · " : ""}{calls(r.month.calls)}</span>
      </div>
      {t.calls === 0 ? <Empty>За эти дни запросов не было</Empty> : <>
        <Bars
          height={120}
          color="var(--accent)"
          // Столбики меньше единицы график не растягивает (потолок не ниже 1) — доллары даём ему в центах.
          format={money ? (v) => usd(v / 100) : (v) => calls(v)}
          bars={r.days.map((d) => ({
            label: String(Number(d.day.slice(8))),
            value: money ? d.cost * 100 : d.calls,
            title: `${dayLabel(d.day)}${d.calls ? ` · ${calls(d.calls)}` : ""}${money && d.calls ? "\n" + Object.entries(d.kinds).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${kindName(k)}: ${usd(v)}`).join("\n") : ""}`,
          }))}
        />
        <h4 className="spend-sub">На что ушло</h4>
        <Shares
          format={(v) => (v ? (money ? usd(v) : calls(v)) : "—")}
          items={r.kinds.map((k) => ({ label: `${kindName(k.kind)} · ${k.calls}`, value: money ? k.cost : k.calls, color: KIND_COLORS[k.kind] }))}
        />
        <h4 className="spend-sub">Модели</h4>
        <ul className="spend-models">
          {r.models.map((m) => (
            <li key={m.model}>
              <span className="spend-model">{m.model}</span>
              <span className="muted small">{calls(m.calls)}{m.input + m.output ? ` · ${tokens(m.input + m.output)} токенов` : ""}</span>
              <b>{m.priced ? usd(m.cost) : "—"}</b>
            </li>
          ))}
        </ul>
        {unpriced > 0 && (
          <p className="muted small">У {calls(unpriced)} цены нет — провайдер её не сообщил, в сумму они не вошли. Цену присылают OpenRouter и RunPod.</p>
        )}
        <p className="muted small">Дни считаются по UTC (Москва — с 3:00). Расход общий для всего сервера.</p>
      </>}
    </div>
  );
}
