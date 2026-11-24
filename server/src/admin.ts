import crypto from "node:crypto";
import type { Store, User } from "./db.ts";

// Админка сайта, каркас и доступ (24.11.2026, docs/review/админка-2026-11-24.html, «Порядок работ» → «Каркас и доступ»).
// Кто админ — auth.ts isAdmin (ADMIN_CHAT_IDS и вход по сессии, не по DESKTOP_TOKEN); не админу все /api/admin/* отвечают 404.
// Сам вход в админку подтверждается кодом из Telegram: ключ сайта лежит в localStorage, и чужой скрипт на странице мог бы
// им воспользоваться, а код из Telegram он не увидит. Код действует ADMIN_CODE_MS, вход — ADMIN_PASS_MS, и только на том
// устройстве (сессии), где код ввели. Всё хранится в kv: admin:code:<сессия> и admin:pass:<сессия>.
// В ответах админки — только счётчики и имена, без текстов пользователей (тест admin.test.ts).

export const ADMIN_CODE_MS = 10 * 60_000;
export const ADMIN_PASS_MS = 60 * 60_000;
export const ADMIN_CODE_TRIES = 5;
/** Новый код — не чаще раза в столько (кнопка «Прислать код» не засыпает Telegram). */
export const ADMIN_CODE_GAP_MS = 30_000;

const codeHash = (code: string) => crypto.createHash("sha256").update(`maid-admin:${code}`).digest("hex");

interface CodeRow { hash: string; exp: number; sent: number; tries: number }

async function codeRow(store: Store, sid: string): Promise<CodeRow | null> {
  try {
    return JSON.parse((await store.kvGet(`admin:code:${sid}`)) ?? "null") as CodeRow | null;
  } catch {
    return null;
  }
}

/** До какого времени вход в админку на этом устройстве подтверждён (null — нет). */
export async function adminUntil(store: Store, sid: string, now = new Date()): Promise<string | null> {
  const until = await store.kvGet(`admin:pass:${sid}`);
  return until && until > now.toISOString() ? until : null;
}

/** Новый шестизначный код: сохраняется хеш, сам код уходит отправителю (Telegram владельца). */
export async function issueAdminCode(store: Store, u: User, sid: string, send: (u: User, text: string) => Promise<void>, now = new Date()) {
  const old = await codeRow(store, sid);
  if (old && now.getTime() - old.sent < ADMIN_CODE_GAP_MS) return { wait: Math.ceil((ADMIN_CODE_GAP_MS - (now.getTime() - old.sent)) / 1000) };
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  await store.kvSet(`admin:code:${sid}`, JSON.stringify({ hash: codeHash(code), exp: now.getTime() + ADMIN_CODE_MS, sent: now.getTime(), tries: 0 } satisfies CodeRow));
  await send(u, `🔐 Код входа в админку: ${code}\nДействует ${ADMIN_CODE_MS / 60_000} минут. Если вы не входили в админку — смените пароль на сайте.`);
  await store.addAdminLog(u.id, "code", "", now);
  return { wait: 0 };
}

export type ConfirmResult = { ok: true; until: string } | { ok: false; why: "none" | "expired" | "locked" | "wrong"; left?: number };

/** Проверить код: верный — вход на ADMIN_PASS_MS; после ADMIN_CODE_TRIES неверных код сгорает. */
export async function confirmAdminCode(store: Store, u: User, sid: string, code: string, now = new Date()): Promise<ConfirmResult> {
  const row = await codeRow(store, sid);
  if (!row) return { ok: false, why: "none" };
  if (row.exp < now.getTime()) {
    await store.kvDel(`admin:code:${sid}`);
    return { ok: false, why: "expired" };
  }
  const want = Buffer.from(row.hash, "hex");
  const got = Buffer.from(codeHash(code.trim()), "hex");
  if (!crypto.timingSafeEqual(want, got)) {
    row.tries++;
    await store.addAdminLog(u.id, "wrong", "", now);
    if (row.tries >= ADMIN_CODE_TRIES) {
      await store.kvDel(`admin:code:${sid}`);
      return { ok: false, why: "locked" };
    }
    await store.kvSet(`admin:code:${sid}`, JSON.stringify(row));
    return { ok: false, why: "wrong", left: ADMIN_CODE_TRIES - row.tries };
  }
  await store.kvDel(`admin:code:${sid}`);
  const until = new Date(now.getTime() + ADMIN_PASS_MS).toISOString();
  await store.kvSet(`admin:pass:${sid}`, until);
  await store.addAdminLog(u.id, "enter", "", now);
  return { ok: true, until };
}

/** Выйти из админки на этом устройстве (сайт остаётся открытым). */
export async function leaveAdmin(store: Store, u: User, sid: string, now = new Date()) {
  await store.kvDel(`admin:pass:${sid}`);
  await store.addAdminLog(u.id, "leave", "", now);
}

/** Обзор для каркаса: сколько людей всего и новых за 7 дней (остальное — этап 1 ревью). */
export async function adminOverview(store: Store, now = new Date()) {
  const week = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const users = (await store.accounts(now.toISOString().slice(0, 7), week)).filter((x) => x.id); // id 0 — расход без человека
  return { users: users.length, new_week: users.filter((x) => x.created_at >= week).length };
}

/** Журнал админки: кто (имя или логин, без chat id), когда, что. */
export async function adminJournal(store: Store, limit = 100) {
  const names = new Map((await store.users()).map((x) => [x.id, x.name || x.login || `#${x.id}`]));
  return (await store.adminLog(limit)).map((r) => ({ at: r.at, who: names.get(r.user_id) ?? `#${r.user_id}`, action: r.action, detail: r.detail }));
}
