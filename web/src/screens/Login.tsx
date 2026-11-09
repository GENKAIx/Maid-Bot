import { type FormEvent, useEffect, useState } from "react";
import { get, post, setToken } from "../api";

export function Login({ onDone }: { onDone: () => void }) {
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [bot, setBot] = useState<string | null>(null);
  useEffect(() => { get<{ bot: string | null }>("/api/public").then((r) => setBot(r.bot)).catch(() => {}); }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const label = /iPhone|iPad/.test(navigator.userAgent) ? "iphone" : /Electron/.test(navigator.userAgent) ? "desktop" : "web";
      const { token } = await post<{ token: string }>("/api/login", { login: login.trim(), password, label });
      setToken(token);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <img src="/icon.svg" alt="" width={64} height={64} />
        <h1>Горничная</h1>
        <p className="muted">Войдите, чтобы увидеть свои записи.</p>
        <label>Логин<input value={login} onChange={(e) => setLogin(e.target.value)} autoComplete="username" autoFocus /></label>
        <label>Пароль<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></label>
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
