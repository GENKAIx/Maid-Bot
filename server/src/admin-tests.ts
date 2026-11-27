import crypto from "node:crypto";
import type { Store, User } from "./db.ts";
import { AccountError, accountReason, confirmedId, forgetAccount, SWEEP_AFTER_MS } from "./admin-account.ts";
import { hashPassword, issueToken } from "./auth.ts";
import { dayKey } from "./time.ts";

// Тестовые аккаунты (27.11.2026, план docs: «тестовые аккаунты для проверки программы на ПК»): админ создаёт в админке →
// «Тестовые аккаунты» обычную запись users без Telegram (chat_id NULL, план friend — всё бесплатно и без лимитов) с признаком
// is_test = 1 (шаг 41) и входит в неё в программе на ПК — ключом из админки (тот же issueToken и таблица sessions) или вручную
// логином и паролем. Новых способов входа нет. Тестовый — не админ (auth.ts isAdmin), не в счёте людей, регистраций, планов,
// аналитики и падений выпуска; расход ИИ — отдельной строкой «тесты»; утро и итог дня с моделью — только если входом пользовались
// за сутки (scheduler.ts). Без Telegram всё приходит в ленту уведомлений и push.
// Адреса (api.ts, только админу с подтверждённым кодом; не админу — 404, без кода — 403), у каждого действия — причина и строка
// в журнале админа «#N …» (без ключа и пароля):
//  • GET /api/admin/tests — список: только #id, план, когда создан, последний вход (когда, клиент, версия), сколько входов, заморожен ли;
//  • POST /api/admin/tests {reason, tz?} — создать (не больше TEST_ACCOUNTS_MAX сразу — иначе 409). Логин и пароль — один раз
//    в ответе, для ручного входа (исключение из правила «только #id и счётчики», как текст обращения и промпта); журнал test_create;
//  • POST /api/admin/tests/<id>/token {reason, label?} — ключ для программы на ПК, один раз в ответе; только тестовому (иначе 403 —
//    входа под чужим аккаунтом нет); журнал test_token;
//  • POST /api/admin/tests/<id>/reset {reason, confirm} — «Сбросить к чистому»: все данные — как при удалении (Store.wipeAccountData),
//    входы закрыты, номер и логин с паролем остаются; confirm — номер, набранный вручную; журнал test_reset. Расход ИИ остаётся на
//    номере (строка «тесты»). Через SWEEP_AFTER_MS — второй сброс, если в аккаунт с тех пор никто не вошёл: то, что дописали начатые
//    до сброса дела (ответ модели на сообщение, обход планировщика), — хвосты, как при удалении (там — Store.sweepOrphans).
// Удалить — обычным «Удалить» в карточке аккаунта (admin-account.ts delete).

/** Сколько тестовых аккаунтов может быть сразу (расход ИИ — настоящие деньги). */
export const TEST_ACCOUNTS_MAX = 10;
/** Метка входа по ключу из админки (видна человеку в «Входах» на сайте). */
export const TEST_TOKEN_LABEL = "Тест: программа на ПК";

export interface TestsDeps {
  store: Store;
  clock?: () => Date;
  /** Забыть номер в памяти, которой у этого модуля нет (частота ИИ у AiGate) — после сброса. */
  forget?: (id: number) => void;
  /** Через сколько после сброса — второй сброс хвостов (по умолчанию SWEEP_AFTER_MS; тесты — короче). */
  sweepAfterMs?: number;
}

const bodyOf = (b: unknown) => (b && typeof b === "object" && !Array.isArray(b) ? b : {}) as Record<string, unknown>;

/** Список тестовых: только номера и числа. */
export async function testsView(store: Store) {
  return { max: TEST_ACCOUNTS_MAX, items: await store.testAccounts() };
}

/** Пояс, который понимает Intl, иначе — 400. */
function tzOf(v: unknown, fallback: string): string {
  if (v === undefined || v === null || v === "") return fallback;
  if (typeof v !== "string" || v.length > 64) throw new AccountError(400, "пояс — строка вида Europe/Moscow");
  try {
    dayKey(new Date(0), v);
  } catch {
    throw new AccountError(400, `нет такого пояса: ${v}`);
  }
  return v;
}

/** Создать тестовый аккаунт от админа by. */
export async function createTestAccount(deps: TestsDeps, by: User, body: unknown) {
  const { store } = deps;
  const now = deps.clock?.() ?? new Date();
  const b = bodyOf(body);
  const reason = accountReason(b.reason);
  const tz = tzOf(b.tz, by.tz);
  if ((await store.testAccounts()).length >= TEST_ACCOUNTS_MAX) {
    throw new AccountError(409, `тестовых аккаунтов уже ${TEST_ACCOUNTS_MAX} — удалите ненужный`);
  }
  let login = "";
  for (let i = 0; i < 5 && !login; i++) {
    const x = `test-${crypto.randomBytes(6).toString("hex").slice(0, 6)}`;
    if (!(await store.userByLogin(x))) login = x;
  }
  if (!login) throw new AccountError(500, "не вышло подобрать свободный логин — повторите");
  // Пароль — как у приглашения (invite.ts newAccount): 10 случайных знаков.
  const password = crypto.randomBytes(9).toString("base64url").slice(0, 10);
  const u = await store.createUser({ login, passwordHash: await hashPassword(password), tz, chatId: null, plan: "friend", isTest: true, at: now });
  await store.addAdminLog(by.id, "test_create", `#${u.id}`, now, reason);
  return {
    ok: true, text: `Тестовый аккаунт #${u.id} создан. Логин и пароль видны один раз — сохраните, если нужен ручной вход.`,
    id: u.id, login, password, ...(await testsView(store)),
  };
}

/** Действие с тестовым аккаунтом id: token — ключ для программы на ПК, reset — сбросить к чистому. Не тестовому — 403. */
export async function testAccountAction(deps: TestsDeps, by: User, id: number, action: string, body: unknown) {
  const { store } = deps;
  const now = deps.clock?.() ?? new Date();
  if (action !== "token" && action !== "reset") throw new AccountError(404, "нет такого действия");
  const u = await store.user(id);
  if (!u) throw new AccountError(404, `нет аккаунта #${id}`);
  const b = bodyOf(body);
  const reason = accountReason(b.reason);
  if (Number(u.is_test ?? 0) !== 1) throw new AccountError(403, `#${u.id} — не тестовый аккаунт`);

  if (action === "token") {
    if (u.frozen_at) throw new AccountError(409, `#${u.id} заморожен — сначала разморозьте`);
    if (b.label !== undefined && (typeof b.label !== "string" || b.label.length > 80)) throw new AccountError(400, "метка входа — строка до 80 знаков");
    const label = typeof b.label === "string" && b.label.trim() ? b.label.trim() : TEST_TOKEN_LABEL;
    const token = await issueToken(store, u.id, label);
    await store.addAdminLog(by.id, "test_token", `#${u.id}`, now, reason);
    return { ok: true, text: `Ключ для #${u.id} выдан. Он виден один раз.`, id: u.id, token };
  }

  confirmedId(b.confirm, u.id, "сбрасываете");
  const r = await store.wipeAccountData(u.id, (n) =>
    store.addAdminLog(by.id, "test_reset", `#${u.id} сброшен к чистому, строк удалено: ${n.deleted}, отвязано (деньги): ${n.detached}`, now, reason));
  forgetAccount(u.id, deps.forget);
  // Хвосты: начатые до сброса дела (ответ модели, обход планировщика) допишут строки уже после него. Через SWEEP_AFTER_MS — ещё раз,
  // но только если в аккаунт с тех пор не вошли (новый вход — значит, строки уже свои, их не трогаем).
  const tails = setTimeout(() => void (async () => {
    if ((await store.accountSessions(u.id)).length) return;
    const again = await store.wipeAccountData(u.id);
    if (again.deleted) console.log(`[tests] #${u.id}: хвосты после сброса убраны, строк ${again.deleted}`);
    forgetAccount(u.id, deps.forget);
  })().catch((e: Error) => console.error("[tests] хвосты сброса", e.message)), deps.sweepAfterMs ?? SWEEP_AFTER_MS);
  tails.unref?.();
  return {
    ok: true, text: `Тестовый аккаунт #${u.id} сброшен: строк ${r.deleted}, входы закрыты. Логин и пароль прежние.`,
    id: u.id, deleted: r.deleted, detached: r.detached, ...(await testsView(store)),
  };
}
