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

const safeEq = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Кто пришёл с этим ключом. DESKTOP_TOKEN из .env — запасной ключ первого пользователя. */
export async function userByToken(store: Store, token: string): Promise<User | undefined> {
  if (!token) return undefined;
  const h = tokenHash(token);
  const u = await store.sessionUser(h);
  if (u) {
    // last_seen обновляем не чаще раза в минуту.
    if (Date.now() - new Date(u.last_seen).getTime() > 60_000) await store.touchSession(h);
    const { last_seen: _, ...user } = u;
    return user;
  }
  if (config.desktopToken && safeEq(token, config.desktopToken)) {
    const owner = config.allowedChatIds[0];
    return owner ? store.ensureUser(owner, "", config.defaultTimezone) : (await store.users())[0];
  }
  return undefined;
}
