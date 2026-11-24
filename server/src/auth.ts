import crypto from "node:crypto";
import { promisify } from "node:util";
import { config } from "./config.ts";
import type { Store, User } from "./db.ts";
import { dayKey, timeOf } from "./time.ts";

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

/** Какой клиент пришёл (заголовок X-Maid-Client) и его версия (X-Maid-Version). Только из белого списка — сырое не хранится. */
export const MAID_CLIENTS = ["web", "desktop", "widget", "quick", "iphone", "telegram-widget"] as const;
export interface ClientMeta { client: string; version: string }
export function clientMeta(headers: Record<string, string | string[] | undefined>): ClientMeta {
  const hdr = (k: string) => String(headers[k] ?? "").trim();
  const c = hdr("x-maid-client");
  const v = hdr("x-maid-version");
  return { client: MAID_CLIENTS.find((x) => x === c) ?? "", version: /^\d{1,3}\.\d{1,3}\.\d{1,4}$/.test(v) ? v : "" };
}
/** Старые клиенты без заголовка: клиент по метке входа. */
export function clientFromLabel(label: string): string {
  if (label === "web" || label === "iphone" || label === "desktop") return label;
  if (label === "Программа на ПК") return "desktop";
  if (label === "telegram /token") return "iphone";
  return "other";
}
/** Окна программы на ПК (виджет, быстрая запись) — одна программа: вход и присутствие пишутся как «desktop». */
const familyOf = (client: string) => (client === "widget" || client === "quick" ? "desktop" : client);
/** Что записать входу из заголовков. Сайт в главном окне программы ходит с её ключом и шлёт «web» и версию сайта:
 *  вход программы остаётся «desktop», версия сайта ему не пишется (иначе клиент и версия скачут между сайтом и программой). */
function sessionMeta(known: string, meta: ClientMeta): ClientMeta {
  if (meta.client === "web" && known === "desktop") return { client: "", version: "" };
  return { client: familyOf(meta.client), version: meta.version };
}
/** Последняя минута присутствия по человеку и клиенту — в памяти: два входа одного человека с одного клиента
 *  (сайт на телефоне и на ПК) дают одну минуту, и одновременные запросы не прибавляют дважды. */
const presenceSeen = new Map<string, number>();
/** Минута присутствия в час человека по его поясу (таблица presence), не чаще раза в минуту на человека и клиента.
 *  Ошибка учёта ответу не мешает. */
export async function notePresence(store: Store, user: User, client: string, at = new Date()) {
  const key = `${user.id} ${client}`;
  const t = at.getTime();
  if (t - (presenceSeen.get(key) ?? -Infinity) < 60_000) return;
  presenceSeen.set(key, t);
  await store.bumpPresence(user.id, dayKey(at, user.tz), Number(timeOf(at, user.tz).slice(0, 2)), client)
    .catch((e) => console.error("[presence]", e));
}

/** Новый ключ входа для устройства. Сам ключ показывается один раз. */
export async function issueToken(store: Store, userId: number, label: string, meta?: ClientMeta): Promise<string> {
  const token = crypto.randomBytes(32).toString("base64url");
  await store.addSession(tokenHash(token), userId, label.slice(0, 80), meta && sessionMeta(clientFromLabel(label), meta));
  return token;
}

export async function login(store: Store, loginName: string, password: string, label: string, meta?: ClientMeta): Promise<string | null> {
  const u = await store.userByLogin(loginName.trim());
  if (!u || !(await verifyPassword(password, u.password_hash))) return null;
  return issueToken(store, u.id, label, meta);
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

/** Запасной DESKTOP_TOKEN сессий не пишет: когда и с какой версией он был в последний раз — в памяти (для админки). */
const desktopSeen = new Map<number, { at: number; version: string }>();
export const desktopTokenSeen = (): { userId: number; at: string; version: string }[] =>
  [...desktopSeen].map(([userId, s]) => ({ userId, at: new Date(s.at).toISOString(), version: s.version }));
/** Для тестов: забыть память ограничителей (DESKTOP_TOKEN, минуты присутствия) — между базами и «через минуту». */
export function resetSeen() {
  desktopSeen.clear();
  presenceSeen.clear();
}

/** Кто пришёл с этим ключом и как вошёл. meta — клиент и версия из заголовков (пусто — неизвестно). */
export async function authByToken(store: Store, token: string, meta: ClientMeta = { client: "", version: "" }): Promise<{ user: User; via: Via } | undefined> {
  if (!token) return undefined;
  const h = tokenHash(token);
  const u = await store.sessionUser(h);
  if (u) {
    if (Date.now() - new Date(u.last_seen).getTime() > SESSION_IDLE_DAYS * 86_400_000) {
      await store.dropSession(h);
      return undefined;
    }
    const { last_seen, session_label, session_client, ...user } = u;
    // last_seen, клиент, версию и минуту присутствия пишем не чаще раза в минуту.
    if (Date.now() - new Date(last_seen).getTime() > 60_000) {
      const known = session_client || clientFromLabel(session_label);
      const m = sessionMeta(known, meta);
      await store.touchSession(h, m.client, m.version);
      await notePresence(store, user, m.client || known);
    }
    return { user, via: "session" };
  }
  if (config.desktopToken && safeEq(token, config.desktopToken)) {
    const owner = config.allowedChatIds[0];
    const user = owner ? await store.ensureUser(owner, "", config.defaultTimezone) : (await store.users())[0];
    if (!user) return undefined;
    const seen = desktopSeen.get(user.id);
    const t = Date.now();
    if (!seen || t - seen.at > 60_000) {
      // Ключ лежит в программе на ПК: «desktop», версия сайта из её главного окна не пишется (sessionMeta).
      const m = sessionMeta("desktop", meta);
      desktopSeen.set(user.id, { at: t, version: m.version || seen?.version || "" });
      await notePresence(store, user, m.client || "desktop");
    }
    return { user, via: "desktop" };
  }
  return undefined;
}
