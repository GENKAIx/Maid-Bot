import { useEffect, useState } from "react";
import { get, getToken, post } from "../api";
import { Card, Empty, Spinner } from "../components";
import { currentSubscription, isIos, pushSupported, standalone, subscribe, unsubscribe } from "../push";
import { getTheme, setTheme, type Theme } from "../theme";

// Настройки: тема и уведомления на этом устройстве, время утреннего списка и итога, предупреждения об играх, копия, выход.

interface Me {
  id: number; login: string | null; name: string; tz: string; persona: string;
  morning_time: string; tomorrow_time: string; evening_time: string; event_lead_min: number;
  game_alerts: number; game_first_min: number; game_every_min: number;
  sessions: { label: string; created_at: string; last_seen: string }[];
}
interface PushInfo { key: string; subs: { endpoint: string; label: string; created_at: string; last_ok: string | null }[] }

export function Settings({ onLogout }: { onLogout: () => void }) {
  const [me, setMe] = useState<Me | null>(null);
  const [push, setPush] = useState<PushInfo | null>(null);
  const [here, setHere] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [theme, pickTheme] = useState<Theme>(getTheme());

  async function load() {
    try {
      const [m, p, s] = await Promise.all([get<Me>("/api/me"), get<PushInfo>("/api/push/key"), currentSubscription().catch(() => null)]);
      setMe(m); setPush(p); setHere(s?.endpoint ?? null);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => { void load(); }, []);

  if (error) return <Empty>Нет связи: {error}</Empty>;
  if (!me || !push) return <Spinner />;

  const subscribedHere = Boolean(here && push.subs.some((s) => s.endpoint === here));
  const label = isIos() ? "iphone" : /Electron/.test(navigator.userAgent) ? "desktop" : /Android/.test(navigator.userAgent) ? "android" : "браузер";

  async function toggle() {
    setMsg("");
    try {
      if (subscribedHere) {
        await unsubscribe();
        setMsg("Уведомления на этом устройстве выключены.");
      } else {
        const err = await subscribe(label);
        setMsg(err || "Готово: уведомления будут приходить сюда.");
      }
      await load();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }
  async function testPush() {
    try {
      const r = await post<{ sent: number }>("/api/push/test");
      setMsg(r.sent ? `Отправлено на ${r.sent} устр.` : "Подписок нет — сначала включите уведомления.");
    } catch (e) {
      setMsg((e as Error).message);
    }
  }
  async function save(patch: Partial<Me>) {
    setSaving(true);
    try {
      setMe({ ...(await post<Me>("/api/settings", patch)), sessions: me!.sessions });
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
      <h2 className="screen-title">Настройки</h2>
      {msg && <div className="toast" style={{ marginTop: 12 }}><div className="toast-text">{msg}</div><button className="ghost" onClick={() => setMsg("")}>✕</button></div>}
      <div className="cards">
        <Card title="Вид" className="reveal">
          <div className="segment" role="radiogroup" aria-label="Тема">
            {([["light", "Светлая"], ["dark", "Тёмная"], ["system", "Как в системе"]] as [Theme, string][]).map(([t, name]) => (
              <button key={t} role="radio" aria-checked={theme === t} className={theme === t ? "on" : ""} onClick={() => { setTheme(t); pickTheme(t); }}>{name}</button>
            ))}
          </div>
          <p className="muted small" style={{ marginTop: 8 }}>Тема запоминается на этом устройстве.</p>
        </Card>

        <Card title="Уведомления" className="reveal">
          {!pushSupported() ? (
            <Empty>Этот браузер не поддерживает push-уведомления.</Empty>
          ) : isIos() && !standalone() ? (
            <Empty>На iPhone уведомления работают только у приложения на экране «Домой»: Safari → «Поделиться» → «На экран Домой», потом включите здесь.</Empty>
          ) : (
            <p>На этом устройстве: <b>{subscribedHere ? "включены" : "выключены"}</b></p>
          )}
          <div className="row" style={{ marginTop: 8 }}>
            <button className={subscribedHere ? "" : "primary"} onClick={toggle} disabled={!pushSupported() || (isIos() && !standalone())}>
              {subscribedHere ? "Выключить здесь" : "Включить здесь"}
            </button>
            <button onClick={testPush}>Проверить</button>
          </div>
          {push.subs.length > 0 && (
            <ul className="list small" style={{ marginTop: 12 }}>
              {push.subs.map((s) => (
                <li key={s.endpoint}>
                  <span className="grow">{s.label}{s.endpoint === here ? " (это устройство)" : ""}</span>
                  <span className="muted">{s.last_ok ? `доставлено ${new Date(s.last_ok).toLocaleString("ru-RU")}` : "ещё не присылали"}</span>
                </li>
              ))}
            </ul>
          )}
          {!push.key && <p className="muted small">На сервере не заданы ключи VAPID — push выключен.</p>}
        </Card>

        <Card title="Когда писать" className="reveal">
          <div className="form">
            <label>Утренний список {field("morning_time", "time")}</label>
            <label>Что завтра {field("tomorrow_time", "time")}</label>
            <label>Вечерний итог {field("evening_time", "time")}</label>
            <label>Напомнить о плане за, мин {field("event_lead_min", "number", { min: 5, max: 1440, step: 5 })}</label>
          </div>
        </Card>

        <Card title="Игры" className="reveal">
          <div className="form">
            <label className="row"><input type="checkbox" checked={me.game_alerts === 1} onChange={(e) => save({ game_alerts: e.target.checked ? 1 : 0 })} /> Предупреждать об играх</label>
            <label>Первое предупреждение через, мин {field("game_first_min", "number", { min: 15, max: 1440, step: 15 })}</label>
            <label>Дальше каждые, мин {field("game_every_min", "number", { min: 15, max: 1440, step: 15 })}</label>
          </div>
        </Card>

        <Card title="Учётная запись" className="reveal">
          <p>{me.login} <span className="muted small">· {me.tz}</span></p>
          <p className="muted small">Устройства: {me.sessions.map((s) => s.label).join(", ") || "—"}</p>
          <div className="row">
            <a className="btn" href="/api/backup" onClick={async (e) => {
              e.preventDefault();
              const r = await fetch("/api/backup", { headers: { Authorization: `Bearer ${getToken()}` } });
              const blob = await r.blob();
              const a = document.createElement("a");
              a.href = URL.createObjectURL(blob);
              a.download = (r.headers.get("content-disposition") ?? "").match(/filename="([^"]+)"/)?.[1] ?? "maid-backup.json";
              a.click();
              URL.revokeObjectURL(a.href);
            }}>Скачать копию</a>
            <button onClick={onLogout}>Выйти</button>
          </div>
          {saving && <p className="muted small">Сохраняю…</p>}
        </Card>
      </div>
    </div>
  );
}
