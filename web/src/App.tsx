import { Fragment, lazy, Suspense, useCallback, useEffect, useState } from "react";
import { getToken, post, setToken, whenUnauthorized } from "./api";
import { Composer } from "./Composer";
import { navigate, parsePath, usePath } from "./router";
import { Diary } from "./screens/Diary";
import { Habits } from "./screens/Habits";
import { Health } from "./screens/Health";
import { Login } from "./screens/Login";
import { Money } from "./screens/Money";
import { Plans } from "./screens/Plans";
import { Profile } from "./screens/Profile";
import { Settings } from "./screens/Settings";
import { Stats } from "./screens/Stats";
import { Today } from "./screens/Today";
import { Search } from "./screens/Search";
import { Trash } from "./screens/Trash";
import { desktop, Widget } from "./screens/Widget";
import { Icon } from "./icons";

// Каталог для разработки — отдельным куском: обычным экранам его тексты не нужны.
const Catalog = lazy(() => import("./screens/Catalog").then((m) => ({ default: m.Catalog })));

// Каркас: вход, навигация (слева на ПК; снизу на телефоне — четыре экрана и «Ещё»), экран, строка ввода.
// version растёт после каждой записи — экраны перечитывают данные.

// Порядок — от частого к редкому: каждый день, учёт, служебное. group — разделитель перед группой в меню.
// Профиль — на ПК сразу под логотипом, на телефоне — первым в «Ещё».
const TABS: { id: string; path: string; title: string; icon: string; more?: boolean; group?: "track" | "tools" }[] = [
  { id: "today", path: "/", title: "Сегодня", icon: "today" },
  { id: "plans", path: "/plans", title: "Планы", icon: "plans" },
  { id: "habits", path: "/habits", title: "Привычки", icon: "habits" },
  { id: "diary", path: "/diary", title: "Дневник", icon: "diary" },
  { id: "profile", path: "/profile", title: "Профиль", icon: "profile", more: true },
  { id: "health", path: "/health", title: "Здоровье", icon: "health", more: true, group: "track" },
  { id: "money", path: "/money", title: "Деньги", icon: "money", more: true },
  { id: "stats", path: "/stats", title: "Статистика", icon: "stats", more: true },
  { id: "search", path: "/search", title: "Поиск", icon: "search", more: true, group: "tools" },
  { id: "trash", path: "/trash", title: "Корзина", icon: "trash", more: true },
  // Только в программе для ПК (сайт открыт в её окне): настройки виджета на рабочем столе.
  ...(desktop() ? [{ id: "widget", path: "/widget", title: "Виджет", icon: "widget", more: true }] : []),
  { id: "settings", path: "/settings", title: "Настройки", icon: "settings", more: true },
  { id: "catalog", path: "/catalog", title: "Каталог", icon: "catalog", more: true },
];

export function App() {
  const [authed, setAuthed] = useState(Boolean(getToken()));
  const [version, setVersion] = useState(0);
  const [more, setMore] = useState(false);
  const path = usePath();
  const { tab, arg } = parsePath(path);
  const onChanged = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    whenUnauthorized(() => setAuthed(false));
  }, []);
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
        navigate("/search");
      }
    };
    addEventListener("keydown", on);
    return () => removeEventListener("keydown", on);
  }, []);

  if (!authed) return <Login onDone={() => { setAuthed(true); onChanged(); }} />;

  async function logout() {
    await post("/api/logout").catch(() => {});
    setToken("");
    setAuthed(false);
  }

  const screen =
    tab === "diary" ? <Diary day={arg} version={version} onChanged={onChanged} />
    : tab === "habits" ? <Habits month={arg} version={version} onChanged={onChanged} />
    : tab === "plans" ? <Plans version={version} onChanged={onChanged} />
    : tab === "profile" ? <Profile version={version} onChanged={onChanged} />
    : tab === "health" ? <Health version={version} />
    : tab === "money" ? <Money version={version} />
    : tab === "stats" ? <Stats version={version} />
    : tab === "search" ? <Search query={arg} version={version} />
    : tab === "trash" ? <Trash version={version} onChanged={onChanged} />
    : tab === "settings" ? <Settings onLogout={logout} />
    : tab === "widget" ? <Widget />
    : tab === "catalog" ? <Suspense fallback={null}><Catalog chapter={arg} /></Suspense>
    : <Today version={version} onChanged={onChanged} />;

  const item = (t: (typeof TABS)[number]) => (
    <a key={t.id} className={`nav-item ${tab === t.id ? "on" : ""}`} href={t.path} onClick={(e) => { e.preventDefault(); navigate(t.path); }}>
      <span className="nav-icon"><Icon name={t.icon} /></span><span>{t.title}</span>
    </a>
  );
  // Перед первым пунктом группы («Учёт», «Служебное») — тонкая линия.
  const grouped = (t: (typeof TABS)[number]) => (t.group ? <Fragment key={t.id}><div className="nav-sep" />{item(t)}</Fragment> : item(t));
  const inMore = TABS.some((t) => t.more && t.id === tab);

  return (
    <div className="app">
      <nav className="nav">
        <div className="brand"><img src="/icon.svg" alt="" width={28} height={28} /><span>Горничная</span></div>
        <div className="nav-more-group nav-profile">{TABS.filter((t) => t.id === "profile").map(item)}</div>
        {TABS.filter((t) => !t.more).map(item)}
        <div className="nav-more-group">{TABS.filter((t) => t.more && t.id !== "profile").map(grouped)}</div>
        <button className={`nav-item nav-more ${more || inMore ? "on" : ""}`} onClick={() => setMore(!more)}>
          <span className="nav-icon"><Icon name="more" /></span><span>Ещё</span>
        </button>
        <div className="spacer" />
      </nav>
      {more && (
        <div className="sheet-back" onClick={() => setMore(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            {TABS.filter((t) => t.more).map(grouped)}
          </div>
        </div>
      )}
      <main className="main">
        <div className="content" key={tab}>{screen}</div>
        <Composer onChanged={onChanged} />
      </main>
    </div>
  );
}
