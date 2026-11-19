import { useEffect, useState } from "react";
import { get, post } from "../api";
import { Card, Empty, Spinner } from "../components";

// Вкладка «Горничная» в «Настройках» (до 19.11.2026 — страница «Персонализация»): как и когда горничная с вами общается — характер, время сообщений, напоминания о планах, игры.
// Техническое (тема, push, расход модели, вход) — в «Настройках». Кто она — карточка RINA в server/src/personas.ts.

interface Me {
  persona: string;
  morning_time: string; tomorrow_time: string; evening_time: string; habit_first: string; habit_last: string; event_lead_min: number; event_reminders: string;
  game_alerts: number; game_first_min: number; game_every_min: number;
}
interface PersonaInfo { id: string; name: string; samples: string[] }

/** Настройка users.event_reminders: «day» — в начале дня, число — за столько минут, 0 — в момент начала; «off» — никогда; пусто — за event_lead_min и в момент. */
function remindTokens(me: Pick<Me, "event_reminders" | "event_lead_min">): string[] {
  const raw = me.event_reminders.trim() || `${me.event_lead_min},0`;
  return raw === "off" ? [] : [...new Set(raw.split(",").map((t) => t.trim()).filter((t) => t === "day" || /^\d+$/.test(t)))];
}
const leadName = (min: number) =>
  min % 1440 === 0 ? `За ${min / 1440} дн.` : min < 60 ? `За ${min} мин` : min % 60 ? `За ${Math.floor(min / 60)} ч ${min % 60} мин` : `За ${min / 60} ч`;
const REMIND_PRESETS: [string, string][] = [["day", "В начале дня"], ["60", "За час"], ["5", "За 5 минут"], ["0", "В момент события"]];

/** Сколько раз и когда напоминать о плане со временем: готовые варианты и свои. */
function EventReminders({ me, busy, onSave }: { me: Me; busy: boolean; onSave: (v: string) => void }) {
  const on = remindTokens(me);
  const [num, setNum] = useState("30");
  const [unit, setUnit] = useState<"1" | "60" | "1440">("1");
  const own = on.filter((t) => !REMIND_PRESETS.some(([k]) => k === t)).map(Number).sort((a, b) => b - a);
  const put = (list: string[]) => onSave(list.length ? list.join(",") : "off");
  const flip = (t: string) => put(on.includes(t) ? on.filter((x) => x !== t) : [...on, t]);
  const mins = Math.round(Number(num) * Number(unit));
  const okOwn = Number.isFinite(mins) && mins >= 1 && mins <= 7 * 1440 && !on.includes(String(mins));
  return (
    <div className="form">
      <div className="remind-opts" role="group" aria-label="Когда напоминать">
        {REMIND_PRESETS.map(([t, name]) => (
          <button key={t} className={`remind-opt${on.includes(t) ? " on" : ""}`} aria-pressed={on.includes(t)} disabled={busy} onClick={() => flip(t)}>
            {on.includes(t) ? "✓ " : ""}{name}
          </button>
        ))}
        {own.map((m) => (
          <span key={m} className="remind-opt on">
            ✓ {leadName(m)}
            <button className="ghost" aria-label={`Убрать «${leadName(m)}»`} disabled={busy} onClick={() => flip(String(m))}>✕</button>
          </span>
        ))}
      </div>
      <div className="row remind-own">
        <span className="muted small">Свой вариант: за</span>
        <input type="number" min={1} max={unit === "1" ? 10080 : unit === "60" ? 168 : 7} value={num} onChange={(e) => setNum(e.target.value)} aria-label="Сколько" />
        <select value={unit} onChange={(e) => setUnit(e.target.value as typeof unit)} aria-label="Единица">
          <option value="1">мин</option><option value="60">ч</option><option value="1440">дн.</option>
        </select>
        <button disabled={busy || !okOwn} onClick={() => put([...on, String(mins)])}>Добавить</button>
      </div>
      <p className="muted small">
        {on.length ? `Напомню ${on.length} ${on.length === 1 ? "раз" : on.length < 5 ? "раза" : "раз"}. «В начале дня» — в час утреннего списка (${me.morning_time}). Если момент уже прошёл (план добавлен впритык), это напоминание пропускается.` : "Напоминаний о планах не будет."}
      </p>
    </div>
  );
}

export function MaidSettings() {
  const [me, setMe] = useState<Me | null>(null);
  const [personas, setPersonas] = useState<PersonaInfo[] | null>(null);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([get<Me>("/api/me"), get<PersonaInfo[]>("/api/personas")])
      .then(([m, p]) => { setMe(m); setPersonas(p); })
      .catch((e) => setError((e as Error).message));
  }, []);

  if (error) return <Empty>Нет связи: {error}</Empty>;
  if (!me || !personas) return <Spinner />;

  async function save(patch: Partial<Me>) {
    setSaving(true);
    try {
      setMe(await post<Me>("/api/settings", patch));
      setMsg("Сохранено.");
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  const field = (key: keyof Me, type: "time" | "number", extra: Record<string, unknown> = {}) => (
    <input
      type={type} defaultValue={String(me![key])} {...extra}
      onBlur={(e) => e.target.value !== String(me![key]) && save({ [key]: type === "number" ? Number(e.target.value) : e.target.value } as Partial<Me>)}
    />
  );

  return (
    <div className="screen">
      {msg && <div className="toast" style={{ marginTop: 12 }}><div className="toast-text">{msg}</div><button className="ghost" onClick={() => setMsg("")}>✕</button></div>}
      <div className="cards">
        <Card title="Характер" className="reveal">
          <div className="maid-who">
            <img src="/maid/hello.webp" alt="" width={72} height={77} />
            <p><b>Рина</b>, 22 года. Характер меняет только то, как она говорит, — сама она та же.</p>
          </div>
          <div className="persona-pick" role="radiogroup" aria-label="Характер">
            {personas.map((p) => (
              <button key={p.id} role="radio" aria-checked={me.persona === p.id} className={`persona-opt${me.persona === p.id ? " on" : ""}`}
                disabled={saving} onClick={() => me.persona !== p.id && save({ persona: p.id })}>
                <b>{p.name}</b>
                {p.samples.map((s) => <span key={s} className="muted small">«{s}»</span>)}
              </button>
            ))}
          </div>
        </Card>

        <Card title="Когда писать" className="reveal">
          <div className="form">
            <label>Утренний список {field("morning_time", "time")}</label>
            <label>Что завтра {field("tomorrow_time", "time")}</label>
            <label>Вечерний итог {field("evening_time", "time", { min: "12:00", max: "23:59" })}</label>
            <p className="muted small">Итог — за этот день, поэтому его время — до полуночи, с 12:00 до 23:59 (например 23:55).</p>
            <label>Привычки: первый вопрос {field("habit_first", "time")}</label>
            <label>Привычки: ещё раз, если не ответили {field("habit_last", "time")}</label>
            <p className="muted small">Так горничная спрашивает про привычки без своего времени, а второй вопрос приходит всем неотмеченным. Не ответили до 00:00 — день с минусом. Второй вопрос — позже первого.</p>
          </div>
        </Card>

        <Card title="Когда напоминать о событиях" className="reveal">
          <EventReminders me={me} busy={saving} onSave={(event_reminders) => save({ event_reminders })} />
        </Card>

        <Card title="Игры" className="reveal">
          <div className="form">
            <label className="row"><input type="checkbox" checked={me.game_alerts === 1} onChange={(e) => save({ game_alerts: e.target.checked ? 1 : 0 })} /> Предупреждать об играх</label>
            <label>Первое предупреждение через, мин {field("game_first_min", "number", { min: 15, max: 1440, step: 15 })}</label>
            <label>Дальше каждые, мин {field("game_every_min", "number", { min: 15, max: 1440, step: 15 })}</label>
          </div>
        </Card>
      </div>
    </div>
  );
}
