import { type FormEvent, useState } from "react";
import { post, setToken } from "../api";

export function Login({ onDone }: { onDone: () => void }) {
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

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
    </div>
  );
}
