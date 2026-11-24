import crypto from "node:crypto";
import { promisify } from "node:util";
import { config } from "./config.ts";
import type { Store, User } from "./db.ts";

// Учётные записи: логин и пароль (scrypt), вход выдаёт ключ. В базе лежит только хеш ключа —
// утечка базы не даёт войти. Ключ один и тот же для веб-приложения, десктопа и айфона.

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password.normalize("NFKC"), salt, 32);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const [kind, salt, hash] = (stored ?? "").split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const key = await scrypt(password.normalize("NFKC"), Buffer.from(salt, "hex"), 32);
  const want = Buffer.from(hash, "hex");
  return key.length === want.length && crypto.timingSafeEqual(key, want);
}

export const tokenHash = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

/** Новый ключ входа для устройства. Сам ключ показывается один раз. */
export async function issueToken(store: Store, userId: number, label: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("base64url");
  await store.addSession(tokenHash(token), userId, label.slice(0, 80));
  return token;
}

export async function login(store: Store, loginName: string, password: string, label: string): Promise<string | null> {
  const u = await store.userByLogin(loginName.trim());
  if (!u || !(await verifyPassword(password, u.password_hash))) return null;
  return issueToken(store, u.id, label);
}

/** Вход, которым не пользовались столько дней, перестаёт действовать (потерянный телефон не открывает дневник вечно). */
export const SESSION_IDLE_DAYS = 90;

/** Ограничение подбора пароля: после LOGIN_MAX_FAILS неудач с одного адреса (или LOGIN_MAX_FAILS × 2 на один логин)
 *  за LOGIN_WINDOW_MS вход закрыт на LOGIN_WINDOW_MS. Удачный вход сбрасывает счёт. Хранится в памяти: перезапуск сбрасывает. */
export const LOGIN_MAX_FAILS = 5;
export const LOGIN_WINDOW_MS = 15 * 60_000;
export class LoginGate {
  private fails = new Map<string, { n: number; since: number; until: number }>();
  constructor(private clock = () => Date.now()) {}
  private keys = (ip: string, login: string) => [[`ip:${ip}`, LOGIN_MAX_FAILS], [`login:${login.trim().toLowerCase()}`, LOGIN_MAX_FAILS * 2]] as const;
  /** Через сколько мс можно снова пробовать (0 — можно сейчас). */
  wait(ip: string, login: string): number {
    const t = this.clock();
    let w = 0;
    for (const [k] of this.keys(ip, login)) {
      const f = this.fails.get(k);
      if (f && f.until > t) w = Math.max(w, f.until - t);
    }
    return w;
  }
  failed(ip: string, login: string) {
    const t = this.clock();
    for (const [k, max] of this.keys(ip, login)) {
      let f = this.fails.get(k);
      if (!f || t - f.since > LOGIN_WINDOW_MS) f = { n: 0, since: t, until: 0 };
      f.n++;
      if (f.n >= max) f.until = t + LOGIN_WINDOW_MS;
      this.fails.set(k, f);
    }
    if (this.fails.size > 10_000) for (const [k, f] of this.fails) if (t - f.since > LOGIN_WINDOW_MS && f.until < t) this.fails.delete(k);
  }
  passed(ip: string, login: string) {
    for (const [k] of this.keys(ip, login)) this.fails.delete(k);
  }
}

const safeEq = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Как вошёл: по ключу сессии (логин и пароль) или по запасному DESKTOP_TOKEN из .env. */
export type Via = "session" | "desktop";

/** Кто пришёл с этим ключом. DESKTOP_TOKEN из .env — запасной ключ первого пользователя. */
export async function userByToken(store: Store, token: string): Promise<User | undefined> {
  return (await authByToken(store, token))?.user;
}

/** Админ сайта (24.11.2026, docs/review/админка-2026-11-24.html): chat id из ADMIN_CHAT_IDS (пусто — первый из ALLOWED_CHAT_IDS)
 *  и вход по сессии. Запасной DESKTOP_TOKEN подставляет того же владельца, но в админку не пускает: ключ лежит в программе на ПК. */
export function isAdmin(u: User, via: Via): boolean {
  const admins = config.adminChatIds.length ? config.adminChatIds : config.allowedChatIds.slice(0, 1);
  return via === "session" && Boolean(u.chat_id) && admins.includes(String(u.chat_id));
}

/** Кто пришёл с этим ключом и как вошёл. */
export async function authByToken(store: Store, token: string): Promise<{ user: User; via: Via } | undefined> {
  if (!token) return undefined;
  const h = tokenHash(token);
  const u = await store.sessionUser(h);
  if (u) {
    if (Date.now() - new Date(u.last_seen).getTime() > SESSION_IDLE_DAYS * 86_400_000) {
      await store.dropSession(h);
      return undefined;
    }
    // last_seen обновляем не чаще раза в минуту.
    if (Date.now() - new Date(u.last_seen).getTime() > 60_000) await store.touchSession(h);
    const { last_seen: _, ...user } = u;
    return { user, via: "session" };
  }
  if (config.desktopToken && safeEq(token, config.desktopToken)) {
    const owner = config.allowedChatIds[0];
    const user = owner ? await store.ensureUser(owner, "", config.defaultTimezone) : (await store.users())[0];
    return user ? { user, via: "desktop" } : undefined;
  }
  return undefined;
}
