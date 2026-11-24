import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { hashPassword } from "./auth.ts";
import { signupsOpenNow, tariffs } from "./tariffs.ts";
import type { BillingKind, Store, User } from "./db.ts";

// Приглашения друзей через бота. Владелец (chat id из ALLOWED_CHAT_IDS) пишет /invite — получает ссылку
// t.me/<бот>?start=<код>; код одноразовый, живёт INVITE_DAYS дней (kv «invite:<код>» → до-когда или «used»).
// С 24.11.2026 (платный доступ, access.ts) приглашение — подарок на giftDays дней (тарифы, tariffs.ts) (plan trial): новому создаётся
// учётная запись с логином и случайным паролем (для сайта и программы на ПК), тому, у кого запись уже есть, — срок продлевается.
// Незнакомец может прийти и без приглашения: /start — своя запись с пробой на trialDays дней (signUp).
// Свой для бота — владелец или тот, у кого есть запись с этим чатом; тратить ли на него ИИ — решает access.ts.

export const INVITE_DAYS = 7;

export async function createInvite(store: Store, now = new Date()): Promise<string> {
  const code = crypto.randomBytes(9).toString("base64url");
  await store.kvSet(`invite:${code}`, new Date(now.getTime() + INVITE_DAYS * 86_400_000).toISOString());
  return code;
}

export type Invited = {
  user: User;
  /** Логин и пароль — только у новой записи; продлили срок старой — null. */
  login: string | null;
  password: string | null;
  /** До какого времени доступ по подарку или пробе (ISO); null — человек и так бесплатно навсегда (друг). */
  until: string | null;
};

const plusDays = (now: Date, days: number) => new Date(now.getTime() + days * 86_400_000).toISOString();

/** Принять приглашение — подарок на giftDays дней. Новый чат — запись с пробой до подарка; запись уже есть — срок продлевается
 *  (от сегодня или от конца нынешнего срока, что позже); друг — ничего не меняется и код не тратится. Код не подошёл — null. */
export async function redeemInvite(
  store: Store,
  code: string,
  chat: { id: string; name: string; username?: string },
  tz: string,
  now = new Date(),
  giftDays = tariffs().giftDays,
): Promise<Invited | null> {
  if (!/^[\w-]{6,64}$/.test(code)) return null;
  const until = await store.kvGet(`invite:${code}`);
  if (!until || until === "used" || until < now.toISOString()) return null;
  const had = await store.userByChat(chat.id);
  if (had?.plan === "friend") return { user: had, login: null, password: null, until: null };
  await store.kvSet(`invite:${code}`, "used");
  if (had) {
    const from = Math.max(now.getTime(), had.access_until ? Date.parse(had.access_until) : 0);
    const gift = plusDays(new Date(from), giftDays);
    // trial_len_days 0 — теперь это подарок (и в письме об окончании, и в аналитике), даже если принят посреди пробы.
    await store.updateUser(had.id, { plan: had.plan === "paid" ? "paid" : "trial", access_until: gift, trial_len_days: 0 });
    await journal(store, had.id, "gift", now);
    return { user: (await store.user(had.id))!, login: null, password: null, until: gift };
  }
  return newAccount(store, chat, tz, plusDays(now, giftDays), now, "gift", 0);
}

/** Почему не вышло зарегистрироваться: регистрация выключена (тариф signupsOpen: /signups off в боте или «Общие потолки» в админке;
 *  SIGNUPS_OPEN=0 в .env — поверх, signupsOpenNow) или за час или сутки уже много новых. */
export type SignUpRefusal = "closed" | "busy";

/** Незнакомец написал /start: запись с пробой на trialDays дней. Запись уже есть — null. Потолки — perHour новых за час
 *  и perDay за сутки (на весь сервер). */
export async function signUp(
  store: Store,
  chat: { id: string; name: string; username?: string },
  tz: string,
  now = new Date(),
  o = { open: signupsOpenNow(), perHour: tariffs().signupsPerHour, perDay: tariffs().signupsPerDay, trialDays: tariffs().trialDays },
): Promise<Invited | SignUpRefusal | null> {
  if (await store.userByChat(chat.id)) return null;
  if (!o.open) return "closed";
  if ((await store.countUsersSince(new Date(now.getTime() - 3600_000).toISOString())) >= o.perHour) return "busy";
  if ((await store.countUsersSince(new Date(now.getTime() - 86_400_000).toISOString())) >= o.perDay) return "busy";
  return newAccount(store, chat, tz, plusDays(now, o.trialDays), now, "trial_started", o.trialDays);
}

/** Журнал подписки (billing_events, шаг 28): проба при регистрации и подарок. Сбой журнала — в лог, запись человека остаётся. */
async function journal(store: Store, userId: number, kind: BillingKind, at: Date) {
  try {
    await store.addBillingEvent({ user_id: userId, kind, at });
  } catch (e) {
    console.error("[invite] журнал", (e as Error).message);
  }
}

/** trialLen — вид срока (users.trial_len_days, access.ts trialLenOf): длина пробы в днях; 0 — подарок. */
async function newAccount(
  store: Store, chat: { id: string; name: string; username?: string }, tz: string, until: string, now: Date, kind: "gift" | "trial_started", trialLen: number,
): Promise<Invited> {
  const login = await freeLogin(store, chat.username);
  const password = crypto.randomBytes(9).toString("base64url").slice(0, 10);
  const user = await store.createUser({
    login, passwordHash: await hashPassword(password), name: chat.name, tz, chatId: chat.id, plan: "trial", accessUntil: until, at: now, trialLenDays: trialLen,
  });
  await journal(store, user.id, kind, now);
  return { user, login, password, until };
}

/** Логин из @username (латиница, цифры, _), занят — с числом: vasya, vasya2…; без username — friend, friend2… */
async function freeLogin(store: Store, username?: string): Promise<string> {
  const clean = (username ?? "").toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 24);
  const base = clean.length >= 3 ? clean : "friend";
  for (let n = 1; ; n++) {
    const login = n === 1 ? base : `${base}${n}`;
    if (!(await store.userByLogin(login))) return login;
  }
}

/** Свой для бота: владелец из ALLOWED_CHAT_IDS или чат с учётной записью (принял приглашение). */
export async function isMember(store: Store, chatId: string, owners: string[]): Promise<boolean> {
  return owners.includes(chatId) || Boolean(await store.userByChat(chatId));
}

/** Ссылка на установщик последней версии (из latest.yml в папке обновлений); нет папки или файла — null. */
export function installerUrl(desktopDir: string, publicUrl: string): string | null {
  try {
    const name = /^path:\s*(\S+\.exe)\s*$/m.exec(fs.readFileSync(path.join(desktopDir, "latest.yml"), "utf8"))?.[1];
    return name && publicUrl ? `${publicUrl}/desktop/${name}` : null;
  } catch {
    return null;
  }
}

/** Сводка владельцу о новых (раз в сутки, index.ts): сколько и логины — без chat id и текстов. Новых нет — null. */
export async function newcomersText(store: Store, since: string): Promise<string | null> {
  const rows = await store.usersCreatedSince(since);
  if (!rows.length) return null;
  const names = rows.slice(0, 30).map((r) => r.login ?? `#${r.id}`).join(", ");
  return `🆕 Новых за сутки: ${rows.length} — ${names}${rows.length > 30 ? "…" : ""}`;
}
