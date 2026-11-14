import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { hashPassword } from "./auth.ts";
import type { Store, User } from "./db.ts";

// Приглашения друзей через бота. Владелец (chat id из ALLOWED_CHAT_IDS) пишет /invite — получает ссылку
// t.me/<бот>?start=<код>; код одноразовый, живёт INVITE_DAYS дней (kv «invite:<код>» → до-когда или «used»).
// Друг открывает ссылку — ему создаётся учётная запись с логином и случайным паролем (для сайта и программы на ПК),
// и бот дальше пускает его как своего: свой — владелец или тот, у кого есть запись с этим чатом.

export const INVITE_DAYS = 7;

export async function createInvite(store: Store, now = new Date()): Promise<string> {
  const code = crypto.randomBytes(9).toString("base64url");
  await store.kvSet(`invite:${code}`, new Date(now.getTime() + INVITE_DAYS * 86_400_000).toISOString());
  return code;
}

export type Invited = { user: User; login: string; password: string };

/** Принять приглашение: код живой и чат ещё без записи — создать запись; иначе null (код при этом не тратится). */
export async function redeemInvite(
  store: Store,
  code: string,
  chat: { id: string; name: string; username?: string },
  tz: string,
  now = new Date(),
): Promise<Invited | null> {
  if (!/^[\w-]{6,64}$/.test(code) || (await store.userByChat(chat.id))) return null;
  const until = await store.kvGet(`invite:${code}`);
  if (!until || until === "used" || until < now.toISOString()) return null;
  await store.kvSet(`invite:${code}`, "used");
  const login = await freeLogin(store, chat.username);
  const password = crypto.randomBytes(9).toString("base64url").slice(0, 10);
  const user = await store.createUser({ login, passwordHash: await hashPassword(password), name: chat.name, tz, chatId: chat.id });
  return { user, login, password };
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
