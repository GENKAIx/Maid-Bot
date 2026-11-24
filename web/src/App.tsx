import { Fragment, lazy, Suspense, useCallback, useEffect, useState } from "react";
import { get, getToken, post, setToken, whenUnauthorized } from "./api";
import { Composer } from "./Composer";
import { NAV_TABS, navCount, oldPath } from "./nav";
import { navigate, parsePath, usePath } from "./router";
import { Album } from "./screens/Album";
import { Diary } from "./screens/Diary";
import { Habits } from "./screens/Habits";
import { Health } from "./screens/Health";
import { History } from "./screens/History";
import { Login } from "./screens/Login";
import { Money } from "./screens/Money";
import { Notes } from "./screens/Notes";
import { Persona } from "./screens/Persona";
import { Plans } from "./screens/Plans";
import { Profile } from "./screens/Profile";
import { SettingsTabs } from "./screens/SettingsTabs";
import { Stats } from "./screens/Stats";
import { Today } from "./screens/Today";
import { Search } from "./screens/Search";
import { Trash } from "./screens/Trash";
import { Features } from "./screens/Features";
import { Icon } from "./icons";
import { NewsBar } from "./NewsBar";
import { dropUsage, logoutUsage, screenFeature, startUsage, track } from "./usage";

// Каталог для разработки — отдельным куском: обычным экранам его тексты не нужны.
const Catalog = lazy(() => import("./screens/Catalog").then((m) => ({ default: m.Catalog })));
// Админка — тоже отдельным куском и на весь экран, без меню сайта (screens/Admin.tsx; доступ решает сервер).
const Admin = lazy(() => import("./screens/Admin").then((m) => ({ default: m.Admin })));

// Каркас: вход, навигация (слева на ПК; снизу на телефоне — четыре экрана и «Ещё»), экран, строка ввода.
// version растёт после каждой записи — экраны перечитывают данные.

const TABS = NAV_TABS;
/** Пункты над главными экранами на ПК (на телефоне — первыми в «Ещё»). */
const NAV_TOP = new Set(["profile", "persona"]);

export function App() {
  const [authed, setAuthed] = useState(Boolean(getToken()));
  const [version, setVersion] = useState(0);
  const [more, setMore] = useState(false);
  const path = usePath();
  const { tab, arg } = parsePath(path);
  // Прежние адреса: /maid, /settings/persona — «Персонализация», /widget — вкладка «Настроек» (его открывает виджет на ПК).
  useEffect(() => { const to = oldPath(path); if (to) navigate(to, true); }, [path]);
  const onChanged = useCallback(() => setVersion((v) => v + 1), []);
  // Сколько заполнено в «Персонализации → О вас» — счётчик «2/7» в меню; перечитывается после каждой записи.
  const [youFilled, setYouFilled] = useState<number | null>(null);
  useEffect(() => {
    if (!authed) return;
    let alive = true;
    get<{ filled?: string[] }>("/api/you").then((v) => alive && setYouFilled(Array.isArray(v.filled) ? v.filled.length : null)).catch(() => {});
    return () => { alive = false; };
  }, [authed, version]);

  // Пункт «Админка» в меню — только админу (/api/me → admin); данные админки сервер всё равно отдаёт только админу с кодом.
  const [admin, setAdmin] = useState(false);
  useEffect(() => {
    if (!authed) return;
    let alive = true;
    get<{ admin?: boolean }>("/api/me").then((m) => alive && setAdmin(m.admin === true)).catch(() => {});
    return () => { alive = false; };
  }, [authed]);

  useEffect(() => {
    whenUnauthorized(() => { dropUsage(); setAuthed(false); });
  }, []);
  // Счётчики фич для админки (usage.ts): открытый экран — раз на переход (прежний адрес — по новому, куда его сменят);
  // пачка на сервер раз в 10 минут и при уходе со страницы.
  useEffect(() => (authed ? startUsage() : undefined), [authed]);
  useEffect(() => {
    const f = authed && tab !== "admin" ? screenFeature(path) : null;
    if (f) track(f);
  }, [authed, tab]); // eslint-disable-line react-hooks/exhaustive-deps -- раз на экран, не на каждый адрес внутри него
  // Вернулись в приложение (вкладка снова видна) — обновить.
  useEffect(() => {
    const on = () => document.visibilityState === "visible" && onChanged();
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, [onChanged]);
  useEffect(() => setMore(false), [path]);
  // Ctrl+K (⌘K) или «/» вне поля ввода — поиск по задачам и планам.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && e.target.closest("input, textarea, [contenteditable]");
      if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") || (e.key === "/" && !typing && !e.ctrlKey && !e.metaKey && !e.altKey)) {
        e.preventDefault();
        track("site.hotkey_search");
        navigate("/search");
      }
    };
    addEventListener("keydown", on);
    return () => removeEventListener("keydown", on);
  }, []);

  if (!authed) return <Login onDone={() => { setAuthed(true); onChanged(); }} />;

  if (tab === "admin") return <Suspense fallback={null}><Admin section={arg} /></Suspense>;

  async function logout() {
    await logoutUsage(); // пока ключ ещё действует; не ушедшее — выбросить
    await post("/api/logout").catch(() => {});
    setToken("");
    setAuthed(false);
  }

  const screen =
    tab === "diary" ? <Diary day={arg} version={version} onChanged={onChanged} />
    : tab === "habits" ? <Habits month={arg} version={version} onChanged={onChanged} />
    : tab === "plans" ? <Plans tab={arg} version={version} onChanged={onChanged} />
    : tab === "notes" ? <Notes version={version} onChanged={onChanged} />
    : tab === "profile" ? <Profile version={version} onChanged={onChanged} />
    : tab === "persona" ? <Persona onChanged={onChanged} />
    : tab === "health" ? <Health version={version} />
    : tab === "money" ? <Money version={version} />
    : tab === "stats" ? <Stats version={version} />
    : tab === "search" ? <Search query={arg} version={version} />
    : tab === "trash" ? <Trash version={version} onChanged={onChanged} />
    : tab === "settings" ? <SettingsTabs tab={arg} onLogout={logout} />
    : tab === "history" ? <History filter={arg} version={version} />
    : tab === "album" ? <Album version={version} />
    : tab === "features" ? <Features />
    : tab === "catalog" ? <Suspense fallback={null}><Catalog chapter={arg} /></Suspense>
    : <Today version={version} onChanged={onChanged} />;

  const item = (t: (typeof TABS)[number]) => {
    const count = navCount(t.id, youFilled);
    return (
      <a key={t.id} className={`nav-item ${tab === t.id ? "on" : ""}`} href={t.path} onClick={(e) => { e.preventDefault(); navigate(t.path); }}>
        <span className="nav-icon"><Icon name={t.icon} /></span><span>{t.title}</span>
        {count && <span className="nav-count" title="Заполнено в «О вас»">{count}</span>}
      </a>
    );
  };
  // Перед первым пунктом группы («Учёт», «Служебное») — тонкая линия.
  const grouped = (t: (typeof TABS)[number]) => (t.group ? <Fragment key={t.id}><div className="nav-sep" />{item(t)}</Fragment> : item(t));
  const inMore = TABS.some((t) => t.more && t.id === tab);
  // Поиск — не пункт меню, а строка под логотипом (на телефоне — первой в «Ещё»); Ctrl+K и «/» открывают его отовсюду.
  const find = (
    <a key="search" className={`nav-find ${tab === "search" ? "on" : ""}`} href="/search" onClick={(e) => { e.preventDefault(); navigate("/search"); }}>
      <span className="nav-icon"><Icon name="search" /></span><span className="grow">Поиск</span><kbd>Ctrl K</kbd>
    </a>
  );

  return (
    <div className="app">
      <nav className="nav">
        <div className="brand"><img src="/icon.svg" alt="" width={28} height={28} /><span>Горничная</span></div>
        <div className="nav-more-group">{find}</div>
        <div className="nav-more-group nav-profile">{TABS.filter((t) => NAV_TOP.has(t.id)).map(item)}</div>
        {TABS.filter((t) => !t.more).map(item)}
        <div className="nav-more-group">{TABS.filter((t) => t.more && !NAV_TOP.has(t.id)).map(grouped)}</div>
        <button className={`nav-item nav-more ${more || inMore ? "on" : ""}`} onClick={() => setMore(!more)}>
          <span className="nav-icon"><Icon name="more" /></span><span>Ещё</span>
        </button>
        <div className="spacer" />
        {admin && (
          <a className="nav-item nav-admin" href="/admin" onClick={(e) => { e.preventDefault(); navigate("/admin"); }}>
            <span className="nav-icon"><Icon name="profile" /></span><span>Админка</span>
          </a>
        )}
      </nav>
      {more && (
        <div className="sheet-back" onClick={() => setMore(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            {find}
            {TABS.filter((t) => t.more).map(grouped)}
            {admin && <a className="nav-item" href="/admin" onClick={(e) => { e.preventDefault(); navigate("/admin"); }}><span className="nav-icon"><Icon name="profile" /></span><span>Админка</span></a>}
          </div>
        </div>
      )}
      <main className="main">
        {/* Объявления владельца (этап 6, NewsBar.tsx): плашка с крестиком над экраном. */}
        <NewsBar />
        <div className="content" key={tab}>{screen}</div>
        <Composer onChanged={onChanged} />
      </main>
    </div>
  );
}
