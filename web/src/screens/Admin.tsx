import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { ApiError, get, post } from "../api";
import { ADMIN_ACTIONS, ADMIN_LIVE_STAGE, ADMIN_SECTIONS, adminNavGroups, adminSection } from "../admin";
import { Icon } from "../icons";
import { AdminAudience, AdminFeatures, AdminHealth, AdminLost, AdminOverview, AdminPayments, AdminQuality, AdminSpend, AdminUsers } from "./AdminSections";
import { AdminTariffs } from "./AdminTariffs";
import { AdminAccount } from "./AdminAccount";
import { AdminAlerts, AdminBackups } from "./AdminAlerts";
import { navigate } from "../router";
import "../admin.css";

// Витрина (этап 4) — свой кусок внутри куска админки: реестр и проигрыватель грузятся, только когда её открыли.
const AdminShowcase = lazy(() => import("./AdminShowcase").then((m) => ({ default: m.AdminShowcase })));
// Аналитика (этап 5) — тоже свой кусок: отчёты и SVG-графики (adminCharts.tsx) грузятся, только когда её открыли.
const AdminAnalytics = lazy(() => import("./AdminAnalytics").then((m) => ({ default: m.AdminAnalytics })));

// Админка (/admin) — отдельным куском (lazy в App.tsx), всегда тёмная, без меню сайта. Доступ решает сервер (admin.ts):
// не админу /api/admin/* отвечает 404 — здесь это «Нет такой страницы»; админу сначала нужен код из Telegram (на час,
// только на этом устройстве). Ревью — docs/review/админка-2026-11-24.html; каркас — 24.11.2026.

type State = { until: string | null; telegram: boolean };
/** Строка журнала админа (server/src/admin.ts adminJournal): who — номер аккаунта (#id), detail — параметры, reason — причина. */
type LogRow = { at: string; who: string; action: string; detail: string; reason?: string };

const hm = (iso: string) => new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
const dt = (iso: string) => new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

export function Admin({ section }: { section?: string }) {
  const [state, setState] = useState<State | null>(null);
  const [missing, setMissing] = useState(false);
  const load = useCallback(() => {
    get<State>("/api/admin/state").then(setState).catch((e) => e instanceof ApiError && e.status === 404 && setMissing(true));
  }, []);
  useEffect(load, [load]);
  // Тёмный фон под всей страницей, пока открыта админка (тема сайта не меняется).
  useEffect(() => {
    document.body.classList.add("admin-body");
    return () => document.body.classList.remove("admin-body");
  }, []);

  if (missing) {
    return (
      <div className="admin admin-center">
        <div className="adm-gate">
          <h1>Нет такой страницы</h1>
          <button className="adm-btn" onClick={() => navigate("/")}>На главную</button>
        </div>
      </div>
    );
  }
  if (!state) return <div className="admin admin-center"><span className="adm-muted">Загрузка…</span></div>;
  if (!state.until) return <Gate telegram={state.telegram} onIn={load} />;
  return <Shell section={adminSection(section)} until={state.until} onOut={load} />;
}

/** Вход в админку: код из Telegram. */
function Gate({ telegram, onIn }: { telegram: boolean; onIn: () => void }) {
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr("");
    try { await fn(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="admin admin-center">
      <form className="adm-gate" onSubmit={(e) => { e.preventDefault(); void run(async () => { await post("/api/admin/confirm", { code }); onIn(); }); }}>
        <div className="adm-kicker">Админка</div>
        <h1>Подтвердите вход</h1>
        <p className="adm-muted">
          {telegram ? "Горничная пришлёт код в Telegram. Вход действует час и только на этом устройстве." : "Бот на сервере выключен — код некуда прислать."}
        </p>
        {!sent ? (
          <button type="button" className="adm-btn primary" disabled={!telegram || busy} onClick={() => void run(async () => { await post("/api/admin/code"); setSent(true); })}>
            Прислать код
          </button>
        ) : (
          <>
            <input className="adm-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus placeholder="000000" aria-label="Код из Telegram"
              value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} />
            <div className="adm-row">
              <button type="submit" className="adm-btn primary" disabled={code.length !== 6 || busy}>Войти</button>
              <button type="button" className="adm-btn" disabled={busy} onClick={() => void run(() => post("/api/admin/code"))}>Новый код</button>
            </div>
          </>
        )}
        {err && <div className="adm-err" role="alert">{err}</div>}
        <a className="adm-link" href="/" onClick={(e) => { e.preventDefault(); navigate("/"); }}>← На сайт</a>
      </form>
    </div>
  );
}

/** Каркас: разделы слева, раздел справа. */
function Shell({ section, until, onOut }: { section: string; until: string; onOut: () => void }) {
  const cur = ADMIN_SECTIONS.find((s) => s.id === section)!;
  const go = (id: string) => navigate(id === "overview" ? "/admin" : `/admin/${id}`);
  const leave = async () => {
    await post("/api/admin/leave").catch(() => {});
    onOut();
  };
  return (
    <div className="admin adm-shell">
      <aside className="adm-side">
        <div className="adm-brand"><img src="/icon.svg" alt="" width={22} height={22} /><span>Админка</span></div>
        <nav className="adm-nav">
          {adminNavGroups().map((g) => [
            <small key={g.group} className="adm-nav-group">{g.group}</small>,
            ...g.items.map((s) => (
              <a key={s.id} href={s.id === "overview" ? "/admin" : `/admin/${s.id}`} className={s.id === section ? "on" : ""}
                onClick={(e) => { e.preventDefault(); go(s.id); }}>
                <Icon name={s.icon} size={17} /><span className="adm-nav-title">{s.title}</span>
                {s.stage > ADMIN_LIVE_STAGE && <span className="adm-stage">этап {s.stage}</span>}
              </a>
            )),
          ])}
        </nav>
        <div className="adm-side-foot">
          <span className="adm-muted">Вход до <b className="adm-num">{hm(until)}</b></span>
          <button className="adm-btn small" onClick={() => void leave()}>Выйти из админки</button>
          <a className="adm-link" href="/" onClick={(e) => { e.preventDefault(); navigate("/"); }}>← На сайт</a>
        </div>
      </aside>
      <AdminLost.Provider value={onOut}>
      <main className="adm-main">
        <header className="adm-head"><h1>{cur.title}</h1></header>
        {section === "overview" ? <AdminOverview />
          : section === "analytics" ? <Suspense fallback={<span className="adm-muted">Загрузка…</span>}><AdminAnalytics /></Suspense>
          : section === "users" ? <AdminUsers />
          : section === "account" ? <AdminAccount />
          : section === "payments" ? <AdminPayments />
          : section === "tariffs" ? <AdminTariffs key="plans" part="plans" />
          : section === "caps" ? <AdminTariffs key="caps" part="caps" />
          : section === "spend" ? <AdminSpend />
          : section === "audience" ? <AdminAudience />
          : section === "quality" ? <AdminQuality />
          : section === "health" ? <AdminHealth />
          : section === "alerts" ? <AdminAlerts />
          : section === "backups" ? <AdminBackups />
          : section === "features" ? <AdminFeatures />
          : section === "showcase" ? <Suspense fallback={<span className="adm-muted">Загрузка…</span>}><AdminShowcase /></Suspense>
          : section === "log" ? <Journal /> : <Soon stage={cur.stage} />}
      </main>
      </AdminLost.Provider>
    </div>
  );
}

function Journal() {
  const [rows, setRows] = useState<LogRow[] | null>(null);
  useEffect(() => { get<LogRow[]>("/api/admin/log").then(setRows).catch(() => setRows([])); }, []);
  if (!rows) return <span className="adm-muted">Загрузка…</span>;
  if (!rows.length) return <span className="adm-muted">Пока пусто.</span>;
  return (
    <div className="adm-scroll">
      <table className="adm-table">
        <thead><tr><th>Когда</th><th>Кто</th><th>Что</th><th>Параметры</th><th>Причина</th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td className="adm-num">{dt(r.at)}</td><td className="adm-num">{r.who}</td><td>{ADMIN_ACTIONS[r.action] ?? r.action}</td>
              <td className="adm-muted adm-num">{r.detail || "—"}</td><td>{r.reason || <span className="adm-muted">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Soon({ stage }: { stage: number }) {
  return (
    <div className="adm-soon">
      <b>Появится на этапе {stage}</b>
      <span className="adm-muted">План и макет раздела — в ревью «Админка» (docs/review/админка-2026-11-24.html).</span>
    </div>
  );
}
