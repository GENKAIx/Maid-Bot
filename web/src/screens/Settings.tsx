import { useEffect, useState } from "react";
import { clientHeaders, get, getToken, post } from "../api";
import { isPayUrl, planView, type Access } from "../billing";
import { Card, Empty, Spinner } from "../components";
import { currentSubscription, isIos, pushSupported, standalone, subscribe, unsubscribe } from "../push";
import { getTheme, setTheme, type Theme } from "../theme";
import { track } from "../usage";
import { SpendCard } from "./Spend";
import { UpdateCard } from "./Widget";

// Настройки — техническое: тариф (проба, подписка Telegram Stars, billing.ts), обновление программы, тема и уведомления на этом устройстве, расход модели, вход, копия, выход.
// Как и когда пишет горничная (характер, время сообщений, напоминания, игры) — вкладка «Горничная» (MaidSettings.tsx); обе — вкладки экрана «Настройки» (SettingsTabs.tsx).

interface Me {
  id: number; login: string | null; name: string; tz: string;
  access?: Access;
  sessions: { id: string; label: string; created_at: string; last_seen: string; current?: boolean }[];
}
interface PushInfo { key: string; subs: { endpoint: string; label: string; created_at: string; last_ok: string | null }[] }

export function Settings({ onLogout }: { onLogout: () => void }) {
  const [me, setMe] = useState<Me | null>(null);
  const [push, setPush] = useState<PushInfo | null>(null);
  const [here, setHere] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
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
  return (
    <div className="screen">
      {msg && <div className="toast" style={{ marginTop: 12 }}><div className="toast-text">{msg}</div><button className="ghost" onClick={() => setMsg("")}>✕</button></div>}
      <div className="cards">
        <TariffCard access={me.access} onChanged={() => void load()} />
        <UpdateCard />
        <Card title="Вид" className="reveal">
          <div className="segment" role="radiogroup" aria-label="Тема">
            {([["light", "Светлая"], ["dark", "Тёмная"], ["system", "Как в системе"]] as [Theme, string][]).map(([t, name]) => (
              <button key={t} role="radio" aria-checked={theme === t} className={theme === t ? "on" : ""} onClick={() => { setTheme(t); pickTheme(t); track("site.theme"); }}>{name}</button>
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

        <Card title="Расход модели" className="reveal">
          <SpendCard />
        </Card>

        <Card title="Учётная запись" className="reveal">
          <p>{me.login} <span className="muted small">· {me.tz}</span></p>
          <p className="muted small">Где выполнен вход (вход, которым не пользовались 90 дней, закрывается сам):</p>
          <ul className="devices">
            {me.sessions.map((s) => (
              <li key={s.id} className="row">
                <span>{s.label || "устройство"}{s.current ? <span className="muted small"> · это устройство</span> : null}</span>
                <span className="muted small">был {new Date(s.last_seen).toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}</span>
                {s.current ? null : (
                  <button className="small" onClick={async () => {
                    if (!confirm(`Выйти на «${s.label || "устройство"}»? Там придётся войти заново.`)) return;
                    try {
                      const r = await post<{ sessions: Me["sessions"] }>("/api/sessions/drop", { id: s.id });
                      setMe({ ...me, sessions: r.sessions.map((x) => ({ ...x, current: me.sessions.find((y) => y.id === x.id)?.current })) });
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}>Выйти там</button>
                )}
              </li>
            ))}
          </ul>
          <div className="row">
            <a className="btn" href="/api/backup" onClick={async (e) => {
              e.preventDefault();
              const r = await fetch("/api/backup", { headers: { ...clientHeaders(), Authorization: `Bearer ${getToken()}` } });
              const blob = await r.blob();
              const a = document.createElement("a");
              a.href = URL.createObjectURL(blob);
              a.download = (r.headers.get("content-disposition") ?? "").match(/filename="([^"]+)"/)?.[1] ?? "maid-backup.json";
              a.click();
              URL.revokeObjectURL(a.href);
            }}>Скачать копию</a>
            <button onClick={onLogout}>Выйти</button>
          </div>
        </Card>
      </div>
    </div>
  );
}

/** «Тариф» (24.11.2026): план, срок, дни пробы; оплата — ссылкой на счёт в Telegram (POST /api/billing/link, берётся заранее,
 *  чтобы браузер не счёл окно оплаты всплывающим), отмена продления — POST /api/billing/cancel (доступ остаётся до конца срока). */
function TariffCard({ access, onChanged }: { access?: Access; onChanged: () => void }) {
  const v = planView(access);
  const [url, setUrl] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  // quiet — ссылка заранее, при показе: не вышло — молча (кнопка «Получить ссылку» скажет причину по нажатию).
  async function link(quiet = false) {
    try {
      const r = await post<{ url?: string }>("/api/billing/link");
      if (isPayUrl(r.url)) { setUrl(r.url); setNote(""); } else if (!quiet) setNote("Сервер прислал непонятную ссылку на оплату.");
    } catch (e) {
      if (!quiet) setNote((e as Error).message);
    }
  }
  useEffect(() => { if (v.pay) void link(true); }, [v.pay]); // eslint-disable-line react-hooks/exhaustive-deps -- ссылка — раз на показ
  // Оплатили в Telegram и вернулись во вкладку — перечитать тариф (иначе висит «Пробный период» и кнопка второй оплаты).
  useEffect(() => {
    if (!v.pay && !v.resume) return;
    const back = () => { if (document.visibilityState === "visible") onChanged(); };
    document.addEventListener("visibilitychange", back);
    return () => document.removeEventListener("visibilitychange", back);
  }, [onChanged, v.pay, v.resume]);
  async function change(what: "cancel" | "resume") {
    if (what === "cancel" && !confirm("Отменить продление подписки? Звёзды больше не спишутся, доступ останется до конца оплаченного срока.")) return;
    setBusy(true);
    try {
      const r = await post<{ text: string }>(`/api/billing/${what}`);
      setNote(r.text);
      onChanged();
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card title="Тариф" className="reveal">
      <p><b>{v.title}</b></p>
      <p className="muted small">{v.text}</p>
      {(v.pay || v.cancel || v.resume) && (
        <div className="tariff-actions">
          {v.pay && (url
            ? <a className="btn tg" href={url} target="_blank" rel="noopener noreferrer">⭐ Оплатить в Telegram</a>
            : <button onClick={() => void link()}>Получить ссылку на оплату</button>)}
          {v.cancel && <button disabled={busy} onClick={() => void change("cancel")}>Отменить продление</button>}
          {v.resume && <button disabled={busy} onClick={() => void change("resume")}>Возобновить продление</button>}
        </div>
      )}
      {note && <p className="small" style={{ marginTop: 8 }} role="status">{note}</p>}
      {v.pay && <p className="muted small" style={{ marginTop: 8 }}>Оплата — звёздами Telegram, продление раз в месяц; отменить можно в любой момент. Условия — /terms в боте.</p>}
    </Card>
  );
}
