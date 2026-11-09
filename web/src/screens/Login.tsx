import { type FormEvent, useEffect, useState } from "react";
import { ApiError, get, post, setToken } from "../api";

// Экран входа с горничной: она реагирует на то, что происходит (анимации — public/maid, уменьшенные копии из desktop/assets/maid).
type Mood = "hello" | "idle" | "listen" | "write" | "think" | "sad" | "worried" | "offline" | "happy";
const MOODS: Mood[] = ["hello", "idle", "listen", "write", "think", "sad", "worried", "offline", "happy"];
const LINES: Record<Mood, string> = {
  hello: "Здравствуйте! Входите, я всё сохранила.",
  idle: "Войдите, чтобы увидеть свои записи.",
  listen: "Слушаю. Как вас зовут?",
  write: "Не подсматриваю, честно.",
  think: "Секунду, проверяю…",
  sad: "Не тот логин или пароль. Попробуем ещё раз?",
  worried: "Что-то пошло не так.",
  offline: "Сервер не отвечает. Проверьте интернет и попробуйте снова.",
  happy: "С возвращением!",
};

export function Login({ onDone }: { onDone: () => void }) {
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [bot, setBot] = useState<string | null>(null);
  const [mood, setMood] = useState<Mood>("hello");
  const [field, setField] = useState<"" | "login" | "password">("");
  const [peek, setPeek] = useState(false);
  // Приветствие, потом ждёт; пока поле в фокусе — слушает или «не смотрит» на пароль.
  useEffect(() => { const t = setTimeout(() => setMood((m) => (m === "hello" ? "idle" : m)), 2600); return () => clearTimeout(t); }, []);
  useEffect(() => { MOODS.forEach((m) => (new Image().src = `/maid/${m}.webp`)); }, []);
  const shown: Mood = busy || mood !== "idle" ? mood : field === "login" ? "listen" : field === "password" ? "write" : "idle";
  useEffect(() => { get<{ bot: string | null }>("/api/public").then((r) => setBot(r.bot)).catch(() => {}); }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setMood("think");
    try {
      const label = /iPhone|iPad/.test(navigator.userAgent) ? "iphone" : /Electron/.test(navigator.userAgent) ? "desktop" : "web";
      const { token } = await post<{ token: string }>("/api/login", { login: login.trim(), password, label });
      setToken(token);
      setMood("happy");
      setTimeout(onDone, 1300);
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      setMood(status === 401 ? "sad" : status === 0 || status >= 500 ? "offline" : "worried");
      setError(status === 401 ? "" : (err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <div className="login-head">
          <img className="login-maid" src={`/maid/${shown}.webp`} alt="" width={150} height={160} />
          <p key={shown} className={`bubble ${shown}`} aria-live="polite">{LINES[shown]}</p>
        </div>
        <h1>Твоя горничная</h1>
        <label>Логин<input value={login} onChange={(e) => { setLogin(e.target.value); if (mood !== "think" && mood !== "happy") setMood("idle"); }} onFocus={() => setField("login")} onBlur={() => setField("")} autoComplete="username" autoFocus /></label>
        <label>Пароль<span className="pass-wrap"><input type={peek ? "text" : "password"} value={password} onChange={(e) => { setPassword(e.target.value); if (mood !== "think" && mood !== "happy") setMood("idle"); }} onFocus={() => setField("password")} onBlur={() => setField("")} autoComplete="current-password" /><button type="button" className="peek" onMouseDown={(e) => e.preventDefault()} onClick={() => setPeek(!peek)} title={peek ? "Скрыть пароль" : "Показать пароль"} aria-label={peek ? "Скрыть пароль" : "Показать пароль"}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" />{peek && <path d="M4 4l16 16" />}</svg>
          </button></span></label>
        {error && <div className="form-error">{error}</div>}
        <button className="primary" disabled={busy || !login || !password}>{busy ? "…" : "Войти"}</button>
      </form>
      {bot && (
        <div className="login-bot">
          <p className="muted">Новый здесь? Горничная живёт в Telegram — напишите ей, чтобы начать.</p>
          <a className="btn tg" href={`https://t.me/${bot}`} target="_blank" rel="noreferrer">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M21.4 4.2 2.9 11.4c-1.3.5-1.2 1.2-.2 1.5l4.7 1.5 1.8 5.6c.2.6.4.8.8.8.4 0 .6-.2.9-.5l2.3-2.2 4.7 3.5c.9.5 1.5.2 1.7-.8l3.1-14.6c.3-1.3-.5-1.9-1.3-1.5ZM9.9 14.6l-.4 4 1.6-3.3 8.1-7.3-9.3 6.6Z"/></svg>
            Открыть @{bot} в Telegram
          </a>
        </div>
      )}
    </div>
  );
}
