import { useCallback, useEffect, useState } from "react";
import { getToken, post, setToken, whenUnauthorized } from "./api";
import { Composer } from "./Composer";
import { navigate, parsePath, usePath } from "./router";
import { Diary } from "./screens/Diary";
import { Habits } from "./screens/Habits";
import { Health } from "./screens/Health";
import { Login } from "./screens/Login";
import { Money } from "./screens/Money";
import { Plans } from "./screens/Plans";
import { Stats } from "./screens/Stats";
import { Today } from "./screens/Today";

// Каркас: вход, навигация (слева на ПК; снизу на телефоне — четыре экрана и «Ещё»), экран, строка ввода.
// version растёт после каждой записи — экраны перечитывают данные.

const TABS = [
  { id: "today", path: "/", title: "Сегодня", icon: "☀️" },
  { id: "diary", path: "/diary", title: "Дневник", icon: "📖" },
  { id: "plans", path: "/plans", title: "Планы", icon: "📅" },
  { id: "habits", path: "/habits", title: "Привычки", icon: "✅" },
  { id: "health", path: "/health", title: "Здоровье", icon: "❤️", more: true },
  { id: "money", path: "/money", title: "Деньги", icon: "💰", more: true },
  { id: "stats", path: "/stats", title: "Статистика", icon: "📊", more: true },
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
    : tab === "health" ? <Health version={version} />
    : tab === "money" ? <Money version={version} />
    : tab === "stats" ? <Stats version={version} />
    : <Today version={version} onChanged={onChanged} />;

  const item = (t: (typeof TABS)[number]) => (
    <a key={t.id} className={`nav-item ${tab === t.id ? "on" : ""}`} href={t.path} onClick={(e) => { e.preventDefault(); navigate(t.path); }}>
      <span className="nav-icon">{t.icon}</span><span>{t.title}</span>
    </a>
  );
  const inMore = TABS.some((t) => t.more && t.id === tab);

  return (
    <div className="app">
      <nav className="nav">
        <div className="brand"><img src="/icon.svg" alt="" width={28} height={28} /><span>Горничная</span></div>
        {TABS.filter((t) => !t.more).map(item)}
        <div className="nav-more-group">{TABS.filter((t) => t.more).map(item)}</div>
        <button className={`nav-item nav-more ${more || inMore ? "on" : ""}`} onClick={() => setMore(!more)}>
          <span className="nav-icon">⋯</span><span>Ещё</span>
        </button>
        <div className="spacer" />
        <button className="ghost nav-item nav-logout" onClick={logout}>Выйти</button>
      </nav>
      {more && (
        <div className="sheet-back" onClick={() => setMore(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            {TABS.filter((t) => t.more).map(item)}
            <button className="nav-item" onClick={logout}><span className="nav-icon">🚪</span><span>Выйти</span></button>
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
