import { type ReactNode, useEffect, useRef, useState } from "react";
import { clientHeaders, get, getToken, post } from "../api";
import { daysLeft, isPayUrl, planView, promoAllowed, resetText, todayBars, type Access } from "../billing";
import { promoInput } from "../announce";
import { SupportCard } from "./Support";
import { LoadError, NoteBar, Ring, Spinner, useNote } from "../components";
import { backupName, backupProblem, failNote } from "../notice";
import { currentSubscription, isIos, pushSupported, standalone, subscribe, unsubscribe } from "../push";
import { getTheme, setTheme, type Theme } from "../theme";
import { track } from "../usage";
import { UpdateCard } from "./Widget";

// «Настройки → Программа» (27.11.2026, дизайн v2 — docs/design/дизайн-v2-2026-11-27.html, экран «Настройки»): слева оглавление,
// справа группы — Тариф (дни кольцом, остатки на сегодня полосками, оплата, промокод), Вид (тема на этом устройстве),
// Уведомления (push на этом устройстве, «Проверить», куда доставлялись), Вход и устройства (входы, «Выйти там», обновление
// программы на ПК), Ваши данные (копия, выход), Помощь («Написать нам»). Расход модели пользователю не показываем — он в админке.
// Как и когда пишет Рина (характер, время сообщений, напоминания, игры) — «Рина → Персонализация» (MaidSettings.tsx).

interface Me {
  id: number; login: string | null; name: string; tz: string;
  access?: Access;
  sessions: { id: string; label: string; created_at: string; last_seen: string; current?: boolean }[];
}
interface PushInfo { key: string; subs: { endpoint: string; label: string; created_at: string; last_ok: string | null }[] }

const GROUPS = [["tariff", "Тариф"], ["look", "Вид"], ["push", "Уведомления"], ["devices", "Вход и устройства"], ["data", "Ваши данные"], ["help", "Помощь"]] as const;
type GroupId = (typeof GROUPS)[number][0];

/** Группа настроек: заголовок (справа — действие) и карточка со строками. */
function Group({ id, title, action, children }: { id: GroupId; title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="set-group" id={`set-${id}`} data-group={id}>
      <div className="set-group-head"><h3>{title}</h3>{action}</div>
      {children}
    </section>
  );
}
/** Строка настройки: слева название и пояснение, справа значение или кнопка. */
function Row({ title, hint, children }: { title: ReactNode; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-row-text"><b>{title}</b>{hint && <span>{hint}</span>}</div>
      {children && <div className="set-row-side">{children}</div>}
    </div>
  );
}

export function Settings({ onLogout }: { onLogout: () => void }) {
  const [me, setMe] = useState<Me | null>(null);
  const [push, setPush] = useState<PushInfo | null>(null);
  const [here, setHere] = useState<string | null>(null);
  // Итог и сбой действий (уведомления, выход на устройстве, копия) — плашка; error — только сбой загрузки экрана.
  const [msg, say] = useNote();
  const [error, setError] = useState("");
  const [theme, pickTheme] = useState<Theme>(getTheme());
  const [at, setAt] = useState<GroupId>("tariff");
  const body = useRef<HTMLDivElement>(null);

  async function load() {
    try {
      const [m, p, s] = await Promise.all([get<Me>("/api/me"), get<PushInfo>("/api/push/key"), currentSubscription().catch(() => null)]);
      setMe(m); setPush(p); setHere(s?.endpoint ?? null);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => { void load(); }, []);
  // Оглавление подсвечивает группу, которая сейчас вверху экрана.
  useEffect(() => {
    const root = body.current;
    if (!root || !("IntersectionObserver" in window)) return;
    const io = new IntersectionObserver((es) => {
      const top = es.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (top) setAt((top.target as HTMLElement).dataset.group as GroupId);
    }, { rootMargin: "0px 0px -60% 0px" });
    root.querySelectorAll(".set-group").forEach((g) => io.observe(g));
    return () => io.disconnect();
  }, [me, push]);

  if (error && (!me || !push)) return <LoadError error={error} onRetry={() => { setError(""); void load(); }} />;
  if (!me || !push) return <Spinner />;

  const subscribedHere = Boolean(here && push.subs.some((s) => s.endpoint === here));
  const label = isIos() ? "iphone" : /Electron/.test(navigator.userAgent) ? "desktop" : /Android/.test(navigator.userAgent) ? "android" : "браузер";
  const canPush = pushSupported() && !(isIos() && !standalone());

  async function toggle() {
    say(null);
    try {
      if (subscribedHere) {
        await unsubscribe();
        say({ text: "Уведомления на этом устройстве выключены." });
      } else {
        const err = await subscribe(label);
        say(err ? { text: err, bad: true } : { text: "Готово: уведомления будут приходить сюда." });
      }
      await load();
    } catch (e) {
      say(failNote("Не получилось переключить уведомления", e));
    }
  }
  async function testPush() {
    say(null);
    try {
      const r = await post<{ sent: number }>("/api/push/test");
      say({ text: r.sent ? `Отправлено на ${r.sent} устр.` : "Подписок нет — сначала включите уведомления." });
    } catch (e) {
      say(failNote("Не получилось проверить уведомления", e));
    }
  }
  async function dropSession(s: Me["sessions"][number]) {
    if (!me || !confirm(`Выйти на «${s.label || "устройство"}»? Там придётся войти заново.`)) return;
    say(null);
    try {
      const r = await post<{ sessions: Me["sessions"] }>("/api/sessions/drop", { id: s.id });
      setMe({ ...me, sessions: r.sessions.map((x) => ({ ...x, current: me.sessions.find((y) => y.id === x.id)?.current })) });
    } catch (e) {
      say(failNote(`Не получилось выйти на «${s.label || "устройство"}»`, e));
    }
  }
  // Копия: сервер отказал или связи нет — файл не скачивается (иначе в нём оказался бы текст ошибки), причина — в плашке.
  async function backup() {
    say(null);
    try {
      const r = await fetch("/api/backup", { headers: { ...clientHeaders(), Authorization: `Bearer ${getToken()}` } }).catch(() => null);
      if (!r) throw new Error("нет связи с сервером");
      if (!r.ok) throw new Error(backupProblem(r.status, await r.json().catch(() => null)));
      const blob = await r.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = backupName(r.headers.get("content-disposition"));
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      say(failNote("Копия не скачалась", e));
    }
  }
  const jump = (id: GroupId) => {
    setAt(id);
    document.getElementById(`set-${id}`)?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  };
  const when = (iso: string) => new Date(iso).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  return (
    <div className="set">
      <nav className="set-toc" aria-label="Разделы настроек">
        {GROUPS.map(([id, title]) => (
          <button key={id} className={at === id ? "on" : ""} aria-current={at === id ? "true" : undefined} onClick={() => jump(id)}>{title}</button>
        ))}
      </nav>
      <div className="set-body" ref={body}>
        <Group id="tariff" title="Тариф">
          <TariffCard access={me.access} onChanged={() => void load()} />
        </Group>

        <Group id="look" title="Вид">
          <div className="card set-card">
            <Row title="Тема" hint="Запоминается на этом устройстве">
              <div className="segment" role="radiogroup" aria-label="Тема">
                {([["dark", "Тёмная"], ["light", "Светлая"], ["system", "Как в системе"]] as [Theme, string][]).map(([t, name]) => (
                  <button key={t} role="radio" aria-checked={theme === t} className={theme === t ? "on" : ""} onClick={() => { setTheme(t); pickTheme(t); track("site.theme"); }}>{name}</button>
                ))}
              </div>
            </Row>
          </div>
        </Group>

        <Group id="push" title="Уведомления" action={<button onClick={testPush}>Проверить</button>}>
          <div className="card set-card">
            <Row title="На этом устройстве"
              hint={!pushSupported() ? "Этот браузер не поддерживает push-уведомления"
                : isIos() && !standalone() ? "На iPhone — только у приложения на экране «Домой»: Safari → «Поделиться» → «На экран Домой»"
                : subscribedHere ? "Включены: Рина пишет сюда" : "Выключены"}>
              <button role="switch" aria-checked={subscribedHere} aria-label="Уведомления на этом устройстве" className={`wp-toggle${subscribedHere ? " on" : ""}`}
                disabled={!canPush} onClick={() => void toggle()}><i /></button>
            </Row>
            {push.subs.map((s) => (
              <Row key={s.endpoint} title={<>{s.label}{s.endpoint === here && <span className="set-here"> · это устройство</span>}</>}
                hint={s.last_ok ? `доставлено ${when(s.last_ok)}` : "ещё не присылали"} />
            ))}
            {!push.key && <p className="muted small">На сервере не заданы ключи VAPID — push выключен.</p>}
          </div>
        </Group>

        <Group id="devices" title="Вход и устройства">
          <div className="card set-card">
            <Row title={me.login ?? me.name} hint={`Часовой пояс ${me.tz} · вход, которым не пользовались 90 дней, закрывается сам`} />
            {me.sessions.map((s) => (
              <Row key={s.id} title={<>{s.label || "устройство"}{s.current && <span className="set-here"> ✓ вы здесь</span>}</>}
                hint={`был ${new Date(s.last_seen).toLocaleDateString("ru-RU", { day: "numeric", month: "long" })}`}>
                {!s.current && <button onClick={() => void dropSession(s)}>Выйти там</button>}
              </Row>
            ))}
          </div>
          <UpdateCard />
        </Group>

        <Group id="data" title="Ваши данные">
          <div className="card set-card">
            <Row title="Копия всех записей" hint="Дневник, планы, задачи, привычки, сон и деньги одним файлом">
              <button onClick={() => void backup()}>Скачать копию</button>
            </Row>
            <Row title="Выйти на этом устройстве" hint="Записи останутся, войти можно снова">
              <button onClick={onLogout}>Выйти</button>
            </Row>
          </div>
        </Group>

        <Group id="help" title="Помощь">
          <SupportCard />
        </Group>
        {/* Внизу и прилипает к низу экрана: видно у любой группы, где бы ни нажали. */}
        {msg && <NoteBar note={msg} className="note-stick" onClose={() => say(null)} />}
      </div>
    </div>
  );
}

/** Промокод (этап 6, server/src/promo.ts POST /api/promo): дни добавляются к сроку; ответ сервера — одной строкой под полем. */
export function PromoForm({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const ok = promoInput(code);
  async function apply() {
    if (!ok) return;
    setBusy(true);
    try {
      const r = await post<{ text: string }>("/api/promo", { code: ok });
      setNote(r.text);
      setCode("");
      onDone();
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="promo-form">
      <div className="row">
        <input value={code} maxLength={20} placeholder="Промокод" aria-label="Промокод" autoCapitalize="characters" onChange={(e) => setCode(e.target.value.toUpperCase())}
          onKeyDown={(e) => { if (e.key === "Enter") void apply(); }} />
        <button disabled={busy || !ok} onClick={() => void apply()}>Применить</button>
      </div>
      {note && <p className="small" role="status">{note}</p>}
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
  const days = daysLeft(access);
  const bars = todayBars(access?.today);
  const reset = resetText(access?.today);
  const [promo, setPromo] = useState(false);
  return (
    <div className="card set-card set-tariff">
      <div className="set-plan">
        {days !== null && <Ring value={Math.min(1, days / 30)} size={64} stroke={6}><b>{days}</b></Ring>}
        <div className="set-plan-text">
          <span className="muted small">Сейчас у вас</span>
          <b className="set-plan-name">{v.title}</b>
          <span className="muted small">{v.text}</span>
        </div>
        {(v.pay || v.cancel || v.resume) && (
          <div className="set-plan-acts">
            {v.pay && (url
              ? <a className="btn primary tg" href={url} target="_blank" rel="noopener noreferrer">⭐ Оплатить в Telegram</a>
              : <button className="primary" onClick={() => void link()}>Получить ссылку на оплату</button>)}
            {v.cancel && <button disabled={busy} onClick={() => void change("cancel")}>Отменить продление</button>}
            {v.resume && <button className="primary" disabled={busy} onClick={() => void change("resume")}>Возобновить продление</button>}
          </div>
        )}
      </div>
      {note && <p className="small" role="status">{note}</p>}
      {bars.length > 0 && (
        <div className="set-today">
          <p className="small"><b>Остатки на сегодня</b>{reset && <span className="muted"> · {reset}</span>}</p>
          <div className="set-bars">
            {bars.map((x) => (
              <div key={x.title} className="set-bar">
                <div><b className="set-bar-num">{x.used}</b> <span className="muted small">из {x.limit}</span></div>
                <div className="set-bar-line" role="meter" aria-label={x.title} aria-valuemin={0} aria-valuemax={x.limit} aria-valuenow={x.used}>
                  <i style={{ width: `${x.limit ? (x.used / x.limit) * 100 : 0}%` }} />
                </div>
                <span className="muted small">{x.title} · осталось {x.left}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {v.pay && <p className="muted small">Оплата — звёздами Telegram, продление раз в месяц; отменить можно в любой момент. Условия — /terms в боте.</p>}
      {promoAllowed(access) && (promo
        ? <PromoForm onDone={onChanged} />
        : <Row title="Промокод"><button className="ghost" onClick={() => setPromo(true)}>Ввести</button></Row>)}
    </div>
  );
}
