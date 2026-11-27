import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { get, getToken, post, setToken, whenUnauthorized } from "./api";
import { Composer } from "./Composer";
import { hubs, navCount, oldPath, whereAmI } from "./nav";
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
import { desktop } from "./screens/Widget";
import { Icon } from "./icons";
import { NewsBar } from "./NewsBar";
import { dropUsage, logoutUsage, screenFeature, startUsage, track } from "./usage";

// Каталог для разработки — отдельным куском: обычным экранам его тексты не нужны.
const Catalog = lazy(() => import("./screens/Catalog").then((m) => ({ default: m.Catalog })));
// Админка — тоже отдельным куском и на весь экран, без меню сайта (screens/Admin.tsx; доступ решает сервер).
const Admin = lazy(() => import("./screens/Admin").then((m) => ({ default: m.Admin })));

// Каркас: вход, меню разделов (узкая колонка слева на ПК; на телефоне — пять разделов внизу), шапка раздела с вкладками
// и строкой поиска, экран, строка ввода. Разделы и вкладки — nav.ts hubs (27.11.2026, дизайн v2).
// version растёт после каждой записи — экраны перечитывают данные.

export function App() {
  const [authed, setAuthed] = useState(Boolean(getToken()));
  const [version, setVersion] = useState(0);
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

  const desk = Boolean(desktop());
  const HUBS = hubs(desk);
  const here = whereAmI(path, desk);
  const hub = HUBS.find((h) => h.id === here.hub) ?? null;
  const go = (to: string, replace = false) => (e: React.MouseEvent) => { e.preventDefault(); navigate(to, replace); };
  const hubLink = (h: (typeof HUBS)[number]) => (
    <a key={h.id} className={`rail-item ${here.hub === h.id ? "on" : ""} ${h.id === "settings" ? "rail-gear" : ""}`} href={h.path}
      aria-current={here.hub === h.id ? "page" : undefined} onClick={go(h.path)}>
      <Icon name={h.icon} /><span>{h.title}</span>
    </a>
  );
  // Заголовок шапки: раздел; вне разделов — экран (Поиск, Каталог).
  const title = hub ? hub.title : tab === "catalog" ? "Каталог" : "Поиск";
  const gear = HUBS.find((h) => h.id === "settings")!;
  const adminLink = admin && (
    <a className="rail-item rail-admin" href="/admin" onClick={go("/admin")}><Icon name="profile" /><span>Админка</span></a>
  );

  return (
    <div className="app">
      <nav className="rail" aria-label="Разделы">
        <img className="rail-me" src="/maid/idle.webp" alt="" width={44} height={44} />
        {HUBS.filter((h) => h.id !== "settings").map(hubLink)}
        <div className="spacer" />
        {adminLink}
        {hubLink(gear)}
      </nav>
      <main className="main">
        {/* Объявления владельца (этап 6, NewsBar.tsx): плашка с крестиком над экраном. */}
        <NewsBar />
        <header className="top">
          <h1 className="top-title">{title}</h1>
          {hub && hub.tabs.length > 0 && (
            <div className="top-tabs" role="tablist" aria-label={`Вкладки: ${hub.title}`}>
              {hub.tabs.map((t) => {
                const count = navCount(t.key, youFilled);
                return (
                  <a key={t.key} role="tab" aria-selected={here.tab === t.key} className={here.tab === t.key ? "on" : ""} href={t.path} onClick={go(t.path, true)}>
                    {t.title}{count && <span className="top-count" title="Заполнено в «О вас»">{count}</span>}
                  </a>
                );
              })}
            </div>
          )}
          <a className={`top-find ${tab === "search" ? "on" : ""}`} href="/search" onClick={go("/search")}>
            <Icon name="search" size={18} /><span>Найти…</span><kbd>Ctrl K</kbd>
          </a>
          <a className={`top-gear ${here.hub === "settings" ? "on" : ""}`} href={gear.path} onClick={go(gear.path)} aria-label="Настройки"><Icon name="settings" /></a>
        </header>
        <div className="content" key={tab}>{screen}</div>
        <Composer onChanged={onChanged} />
      </main>
    </div>
  );
}
