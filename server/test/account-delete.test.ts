import { PGlite } from "@electric-sql/pglite";
import assert from "node:assert/strict";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AiGate } from "../src/access.ts";
import { createApi } from "../src/api.ts";
import { hashPassword } from "../src/auth.ts";
import { Billing, signPayload, type StarsApi } from "../src/billing.ts";
import { config } from "../src/config.ts";
import {
  ACCOUNT_ACTOR_TABLES, ACCOUNT_DETACH_TABLES, ACCOUNT_TABLES, Store, USER_KV_EXACT, USER_KV_PREFIX, USERS_GONE_KEY,
} from "../src/db.ts";
import { PgDriver } from "../src/driver.ts";
import { countFeature, flushFeatures, resetFeatureEvents } from "../src/feature-events.ts";
import { signUp } from "../src/invite.ts";
import { Pipeline } from "../src/pipeline.ts";

// «Удалить аккаунт» в админке (admin-account.ts delete, Store.deleteAccount). Данные человека генерируются по схеме: тест сам находит
// все таблицы со столбцом user_id и кладёт в каждую строку — новая таблица с user_id без решения (удалять, отвязать или оставить)
// роняет тест. Тем же путём, что кнопка: вход → код из «Telegram» → POST /api/admin/account/<id>/delete. SQLite и Postgres (PGlite).

const OWNER = "1001";
const ADMIN2 = "1002";
const TZ = "Europe/Moscow";
const DAY = 86_400_000;
const SECRET = "test-billing-secret";

const BACKENDS: Record<string, () => Promise<Store>> = {
  sqlite: () => Store.open(":memory:"),
  postgres: async () => {
    const pg = new PGlite();
    return Store.over(new PgDriver(pg, (fn) => pg.transaction((tx) => fn(tx)), () => pg.close()));
  },
};

type Col = { name: string; kind: "int" | "text" | "real"; required: boolean; auto: boolean };
/** Все таблицы и столбцы — из самой базы (SQLite: pragma_table_info, Postgres: information_schema). */
async function schemaOf(store: Store): Promise<Map<string, Col[]>> {
  const d = store.driver;
  const out = new Map<string, Col[]>();
  const kindOf = (t: string): Col["kind"] => (/int/i.test(t) ? "int" : /real|double|numeric/i.test(t) ? "real" : "text");
  if (d.dialect === "sqlite") {
    for (const { name } of await d.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")) {
      const cols = await d.all<{ name: string; type: string; notnull: number; dflt_value: unknown; pk: number }>("SELECT * FROM pragma_table_info(?)", [name]);
      const pks = cols.filter((c) => c.pk > 0).length;
      out.set(name, cols.map((c) => ({
        name: c.name, kind: kindOf(c.type), required: Boolean(c.notnull) && c.dflt_value == null || (c.pk > 0 && !(pks === 1 && /^INTEGER$/i.test(c.type))),
        auto: c.pk > 0 && pks === 1 && /^INTEGER$/i.test(c.type),
      })));
    }
  } else {
    const rows = await d.all<{ table_name: string; column_name: string; data_type: string; is_nullable: string; column_default: unknown; is_identity: string }>(
      "SELECT table_name, column_name, data_type, is_nullable, column_default, is_identity FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position",
    );
    for (const r of rows) {
      const cols = out.get(r.table_name) ?? out.set(r.table_name, []).get(r.table_name)!;
      cols.push({ name: r.column_name, kind: kindOf(r.data_type), required: r.is_nullable === "NO" && r.column_default == null && r.is_identity !== "YES", auto: r.is_identity === "YES" });
    }
  }
  return out;
}

let seq = 1;
/** Строка в таблицу: user_id и заданные поля — как сказано, остальные обязательные — уникальными значениями своего типа. */
async function put(store: Store, table: string, cols: Col[], fixed: Record<string, unknown>) {
  const names: string[] = [], vals: unknown[] = [];
  for (const c of cols) {
    if (c.name in fixed) { names.push(c.name); vals.push(fixed[c.name]); continue; }
    if (c.auto || !c.required) continue;
    names.push(c.name);
    vals.push(c.kind === "text" ? `t${seq++}` : seq++);
  }
  await store.driver.run(`INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`, vals);
}
const count = async (store: Store, sql: string, ...args: unknown[]) => Number((await store.driver.all<{ n: number }>(sql, args))[0].n);

/** Данные человека id во всех таблицах с user_id (по 2 строки), отметки его привычек и ключи kv с его номером и номерами строк. */
async function fill(store: Store, schema: Map<string, Col[]>, id: number) {
  for (const [table, cols] of schema) {
    if (!cols.some((c) => c.name === "user_id")) continue;
    const n = table === "promo_uses" ? 1 : 2; // promo_uses: user_id — ключ (один код на человека)
    for (let i = 0; i < n; i++) await put(store, table, cols, { user_id: id });
  }
  const one = async (t: string) => Number((await store.driver.all<{ id: number }>(`SELECT id FROM ${t} WHERE user_id = ? ORDER BY id LIMIT 1`, [id]))[0].id);
  const habit = await one("habits");
  await put(store, "habit_marks", schema.get("habit_marks")!, { habit_id: habit });
  const keys = [
    ...USER_KV_EXACT.map((p) => `${p}:${id}`), ...USER_KV_PREFIX.map((p) => `${p}:${id}:2026-11-24`),
    `owe:${await one("messages")}`, `retry:${await one("messages")}`, `series:${await one("events")}:laid`, `date:${await one("dates")}:2026-12-01:7`, `habit:${habit}:2026-11-24:09:00`,
  ];
  for (const k of keys) await store.kvSet(k, "1");
  return { habit, keys };
}

function fakeTelegram() {
  const log: { m: string; a: unknown[] }[] = [];
  const api: StarsApi = {
    createInvoiceLink: async (...a) => (log.push({ m: "link", a }), "https://t.me/$inv"),
    answerPreCheckoutQuery: async (...a) => (log.push({ m: "pre", a }), true),
    refundStarPayment: async (...a) => (log.push({ m: "refund", a }), true),
    editUserStarSubscription: async (...a) => (log.push({ m: "edit", a }), true),
    sendMessage: async (...a) => (log.push({ m: "send", a }), {}),
  };
  return { api, log, of: (m: string) => log.filter((x) => x.m === m), to: (chat: string) => log.filter((x) => x.m === "send" && String(x.a[0]) === chat).map((x) => String(x.a[1])) };
}

async function stand(open: () => Promise<Store>) {
  config.allowedChatIds.splice(0, Infinity, OWNER);
  config.adminChatIds.splice(0, Infinity, OWNER, ADMIN2);
  resetFeatureEvents();
  const store = await open();
  const tg = fakeTelegram();
  const billing = new Billing(store, tg.api, { secret: SECRET, price: 150 });
  const owner = await store.createUser({ login: "owner", passwordHash: await hashPassword("owner-pass-1"), tz: TZ, chatId: OWNER, name: "Хозяин" });
  const admin2 = await store.createUser({ login: "adm", passwordHash: "x", tz: TZ, chatId: ADMIN2, name: "Админ" });
  const bob = await store.createUser({ login: "bob", passwordHash: "x", tz: TZ, chatId: "12", name: "Боб", plan: "trial", accessUntil: new Date(Date.now() + 5 * DAY).toISOString(), trialLenDays: 7 });
  // Аня — последней: в SQLite её номер — наибольший, и без защиты новый человек получил бы тот же.
  const anya = await store.createUser({ login: "anya", passwordHash: "x", tz: TZ, chatId: "11", name: "Аня", plan: "trial", accessUntil: new Date(Date.now() + 2 * DAY).toISOString(), trialLenDays: 7 });
  const codes: string[] = [];
  const pipeline = new Pipeline(store, async () => "{}");
  pipeline.gate = new AiGate(store, { owners: () => [OWNER, ADMIN2] });
  const server = createApi({ store, pipeline, billing, adminCode: async (_u, text) => void codes.push(text.match(/\d{6}/)![0]) }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const r0 = await fetch(base + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: "owner", password: "owner-pass-1" }) });
  const token = String(((await r0.json()) as { token: string }).token);
  const call = async (p: string, body?: unknown) => {
    const r = await fetch(base + p, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> };
  };
  await call("/api/admin/code", {});
  assert.equal((await call("/api/admin/confirm", { code: codes[0] })).status, 200);
  return { store, tg, billing, owner, admin2, bob, anya, call, close: async () => { server.close(); await store.close(); } };
}

test("ключи kv с номером человека: каждый префикс из кода разобран — удаляется с аккаунтом, по строкам или общий", () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
  const found = new Set<string>();
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
    for (const line of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) {
      if (!/(once|kvSet|kvGet|kvDel)\(|Key = \(|key = `/.test(line)) continue;
      for (const m of line.matchAll(/`([A-Za-z][\w-]*(?::[A-Za-z][\w-]*)*):\$\{/g)) found.add(m[1]);
    }
  }
  const user = new Set<string>([...USER_KV_EXACT, ...USER_KV_PREFIX]);
  const byRow = new Set(["owe", "retry", "date", "habit", "series"]); // по сообщению, плану, дате, привычке — Store.deleteAccount
  const byTg = new Set(["paysupport"]); // по Telegram id — Store.deleteAccount (по users.tg_user_id и chat_id), и pruneOnce
  const global = new Set(["admin:code", "admin:pass", "billing", "digest", "invite", "prune", "release-start", "snapshot", "llm"]);
  const notKv = new Set(["clash"]); // данные кнопки Telegram (bot.ts), не ключ kv
  assert.ok(found.size >= 20, `нашлось мало ключей: ${[...found]}`);
  for (const p of found) assert.ok(user.has(p) || byRow.has(p) || byTg.has(p) || global.has(p) || notKv.has(p), `ключ kv «${p}:…» не разобран: с номером человека — в USER_KV_EXACT/USER_KV_PREFIX (db.ts), иначе — в список этого теста`);
});

for (const [name, open] of Object.entries(BACKENDS)) {
  test(`удалить аккаунт (${name}): все строки человека во всех таблицах с user_id, деньги отвязаны, другой человек не тронут, регистрация заново`, async () => {
    const s = await stand(open);
    try {
      const schema = await schemaOf(s.store);
      // Каждая таблица с user_id — в одном из трёх списков db.ts (и наоборот: список не врёт о схеме).
      const withUser = [...schema].filter(([, cols]) => cols.some((c) => c.name === "user_id")).map(([t]) => t).sort();
      assert.deepEqual(withUser, [...ACCOUNT_TABLES, ...ACCOUNT_DETACH_TABLES, ...ACCOUNT_ACTOR_TABLES].sort(), "новая таблица с user_id — решите в db.ts, что с ней при удалении");
      const a = await fill(s.store, schema, s.anya.id);
      const b = await fill(s.store, schema, s.bob.id);
      // Отметки /paysupport — по Telegram id (в личке = chat_id): Ани — удаляются, Боба — нет.
      a.keys.push("paysupport:11:2941234");
      b.keys.push("paysupport:12:2941234");
      for (const k of ["paysupport:11:2941234", "paysupport:12:2941234"]) await s.store.kvSet(k, "1");
      // Строка расхода «без человека» на тот же день и модель — строка Ани сложится с ней.
      const usageCols = schema.get("llm_usage")!;
      const ua = (await s.store.driver.all<Record<string, unknown>>("SELECT day, kind, model FROM llm_usage WHERE user_id = ? LIMIT 1", [s.anya.id]))[0];
      await put(s.store, "llm_usage", usageCols, { user_id: 0, day: ua.day, kind: ua.kind, model: ua.model, micro_usd: 5, calls: 1 });
      await s.store.driver.run("UPDATE llm_usage SET micro_usd = 7, calls = 2 WHERE user_id = ? AND day = ? AND kind = ? AND model = ?", [s.anya.id, ua.day, ua.kind, ua.model]);
      const totals = async () => [
        await count(s.store, "SELECT COALESCE(SUM(micro_usd), 0) AS n FROM llm_usage"), await count(s.store, "SELECT COUNT(*) AS n FROM llm_calls"),
        await count(s.store, "SELECT COALESCE(SUM(amount), 0) AS n FROM payments"), await count(s.store, "SELECT COUNT(*) AS n FROM billing_events"),
        await count(s.store, "SELECT COUNT(DISTINCT user_id) AS n FROM payments"),
      ];
      const money0 = await totals();
      const pays = await count(s.store, "SELECT COUNT(*) AS n FROM payments WHERE user_id = ?", s.anya.id);
      const events = await count(s.store, "SELECT COUNT(*) AS n FROM billing_events WHERE user_id = ?", s.anya.id);
      const bobRows = async () => Object.fromEntries(await Promise.all(withUser.map(async (t) => [t, await count(s.store, `SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`, s.bob.id)])));
      const bob0 = await bobRows();
      const actor0 = await Promise.all(ACCOUNT_ACTOR_TABLES.map((t) => count(s.store, `SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`, s.anya.id)));
      // Счётчик фичи в памяти (пишется пачкой раз в минуту) — после удаления не должен вернуть строку удалённого.
      countFeature(s.anya, "web", "onboarding.persona");

      const p = `/api/admin/account/${s.anya.id}/delete`;
      assert.equal((await s.call(p, { confirm: String(s.anya.id) })).status, 400, "без причины — 400");
      assert.equal((await s.call(p, { reason: "тестовый аккаунт" })).status, 400, "без номера — 400");
      assert.equal((await s.call(p, { reason: "тестовый аккаунт", confirm: String(s.bob.id) })).status, 400, "чужой номер — 400");
      assert.equal((await s.call(p, { reason: "тестовый аккаунт", confirm: `${s.anya.id}0` })).status, 400);
      assert.equal((await s.call(`/api/admin/account/${s.owner.id}/delete`, { reason: "проверка", confirm: String(s.owner.id) })).status, 403, "владельца (и себя) — 403");
      assert.equal((await s.call(`/api/admin/account/${s.admin2.id}/delete`, { reason: "проверка", confirm: String(s.admin2.id) })).status, 403, "админа (ADMIN_CHAT_IDS) — 403");
      assert.equal((await s.call(`/api/admin/account/${s.admin2.id}`)).body.protected, true);
      assert.ok(await s.store.user(s.anya.id), "после отказов — на месте");

      // Ведущий ноль — тот же номер (как поле на сайте, accountQuery): «#0N» — это #N.
      const r = await s.call(p, { reason: "тестовый аккаунт", confirm: `#0${s.anya.id}` });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual([r.body.deleted, r.body.card], [s.anya.id, null]);
      assert.match(r.body.text, new RegExp(`^Аккаунт #${s.anya.id} удалён`));
      assert.equal(await s.store.user(s.anya.id), undefined);
      assert.equal((await s.call(`/api/admin/account/${s.anya.id}`)).status, 404, "карточки больше нет");
      assert.equal((await s.call(p, { reason: "ещё раз", confirm: String(s.anya.id) })).status, 404);

      for (const t of withUser) {
        const n = await count(s.store, `SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`, s.anya.id);
        if ((ACCOUNT_ACTOR_TABLES as readonly string[]).includes(t)) continue;
        assert.equal(n, 0, `${t}: остались строки удалённого`);
      }
      assert.deepEqual(await Promise.all(ACCOUNT_ACTOR_TABLES.map((t) => count(s.store, `SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`, s.anya.id))), actor0, "журналы админа не трогаются");
      assert.equal(await count(s.store, "SELECT COUNT(*) AS n FROM habit_marks WHERE habit_id = ?", a.habit), 0, "отметки привычек");
      for (const k of a.keys) assert.equal(await s.store.kvGet(k), undefined, `kv ${k}`);
      for (const k of b.keys) assert.equal(await s.store.kvGet(k), "1", `kv другого человека ${k}`);
      assert.deepEqual(await bobRows(), bob0, "строки другого человека — все на месте");
      assert.equal(await count(s.store, "SELECT COUNT(*) AS n FROM habit_marks WHERE habit_id = ?", b.habit), 1);
      // Деньги: суммы и число плательщиков те же, строки — на номер −id, Telegram id стёрт; расход — «без человека».
      assert.deepEqual(await totals(), money0, "отчёты о деньгах не изменились");
      assert.equal(await count(s.store, "SELECT COUNT(*) AS n FROM payments WHERE user_id = ? AND tg_user_id = ''", -s.anya.id), pays);
      assert.equal(await count(s.store, "SELECT COUNT(*) AS n FROM billing_events WHERE user_id = ?", -s.anya.id), events);
      assert.equal(await count(s.store, "SELECT micro_usd AS n FROM llm_usage WHERE user_id = 0 AND day = ? AND kind = ? AND model = ?", ua.day, ua.kind, ua.model), 12, "строки расхода сложились");
      assert.ok(await count(s.store, "SELECT COUNT(*) AS n FROM llm_calls WHERE user_id = 0") >= 2);
      const pay = ((await s.call("/api/admin/payments")).body as unknown as { user_id: number; name: string }[]).find((x) => x.user_id === -s.anya.id);
      assert.equal(pay?.name, `удалён #${s.anya.id}`, "в «Оплатах» — без имени");
      // Журнал админа: строка с причиной и номером, без имён.
      const log = (await s.call("/api/admin/log")).body as unknown as { who: string; action: string; detail: string; reason: string }[];
      assert.deepEqual([log[0].who, log[0].action, log[0].reason], [`#${s.owner.id}`, "delete", "тестовый аккаунт"]);
      assert.match(log[0].detail, new RegExp(`^#${s.anya.id} удалён аккаунт, строк удалено: \\d+, отвязано \\(деньги\\): \\d+$`));
      assert.ok(!JSON.stringify(log).includes("Аня"));
      assert.match(s.tg.to("11").at(-1)!, /Аккаунт удалён.*\/start/, "человеку — письмо после удаления, в Telegram");
      assert.equal(await flushFeatures(s.store, Date.now(), true), 0, "счёт фич удалённого из памяти не пишется");
      assert.equal(await count(s.store, "SELECT COUNT(*) AS n FROM feature_events WHERE user_id = ?", s.anya.id), 0);
      assert.equal(await s.store.kvGet(USERS_GONE_KEY), String(s.anya.id));

      // Хвосты: начатые до удаления дела (ответ модели, обход планировщика, пачка счётчиков) дописали строки и ключи под номером
      // удалённого — Store.sweepOrphans убирает их так же, как удаление; другой человек не тронут.
      const tail = await fill(s.store, schema, s.anya.id);
      await s.store.kvSet("owe:987654", "1"); // долг разбора по сообщению, которого уже нет
      assert.ok((await s.store.sweepOrphans()) > 0);
      for (const t of withUser) {
        if ((ACCOUNT_ACTOR_TABLES as readonly string[]).includes(t)) continue;
        assert.equal(await count(s.store, `SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`, s.anya.id), 0, `${t}: хвост удалённого остался`);
      }
      assert.equal(await count(s.store, "SELECT COUNT(*) AS n FROM habit_marks WHERE habit_id = ?", tail.habit), 0);
      for (const k of [...tail.keys, "owe:987654"]) assert.equal(await s.store.kvGet(k), undefined, `kv ${k}`);
      for (const k of b.keys) assert.equal(await s.store.kvGet(k), "1", `kv другого человека ${k}`);
      assert.deepEqual(await bobRows(), bob0, "строки другого человека — все на месте и после чистки хвостов");
      assert.equal(await count(s.store, "SELECT COUNT(*) AS n FROM payments WHERE user_id = ? AND tg_user_id = ''", -s.anya.id), pays + 2, "оплаты-хвосты — отвязаны");
      assert.equal(await s.store.sweepOrphans(), 0, "второй раз — нечего");

      // Тот же Telegram — регистрация заново: новый человек с новым номером (больше удалённого), с пробой, без старых данных.
      const again = await signUp(s.store, { id: "11", name: "Аня" }, TZ, new Date(), { open: true, perHour: 100, perDay: 100, trialDays: 7 });
      assert.ok(again && typeof again === "object", "регистрация прошла");
      const nu = again.user;
      assert.ok(nu.id > s.anya.id, `новый номер ${nu.id} больше удалённого ${s.anya.id}`);
      assert.deepEqual([nu.chat_id, nu.plan], ["11", "trial"]);
      assert.deepEqual((await s.store.billingEventsOf(nu.id)).map((e) => e.kind), ["trial_started"]);
      const card = (await s.call(`/api/admin/account/${nu.id}`)).body;
      assert.deepEqual([card.payments.length, card.log.length], [0, 0], "у нового — ни чужих оплат, ни чужого журнала");
      assert.equal((await s.store.ensureUser("13", "Новый", TZ)).id > nu.id, true, "и первый вход из бота — тоже новый номер");
    } finally {
      await s.close();
    }
  });
}

test("отметки /paysupport (по Telegram id) убирает и чистка по времени", async () => {
  const store = await Store.open(":memory:");
  try {
    await store.kvSet("paysupport:77:2941234", "2026-01-01T00:00:00.000Z");
    await store.kvSet("paysupport:78:2941235", new Date().toISOString());
    await store.pruneOnce(new Date(Date.now() - 60 * DAY));
    assert.deepEqual([await store.kvGet("paysupport:77:2941234"), Boolean(await store.kvGet("paysupport:78:2941235"))], [undefined, true]);
  } finally {
    await store.close();
  }
});

test("удалить аккаунт: продление Telegram отменить не вышло — 409, аккаунт и подписка на месте, письма нет", async () => {
  const s = await stand(BACKENDS.sqlite);
  try {
    const exp = Math.floor((Date.now() + 30 * DAY) / 1000);
    await s.billing.paid({ id: 11 }, { currency: "XTR", total_amount: 150, invoice_payload: signPayload(SECRET, s.anya.id), telegram_payment_charge_id: "charge-del-33334444", subscription_expiration_date: exp, is_recurring: true, is_first_recurring: true });
    s.tg.api.editUserStarSubscription = async () => { throw new Error("Telegram недоступен"); };
    const sent = s.tg.to("11").length;
    const r = await s.call(`/api/admin/account/${s.anya.id}/delete`, { reason: "тестовый аккаунт", confirm: String(s.anya.id) });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.match(JSON.stringify(r.body), /отмените продление/);
    const u = (await s.store.user(s.anya.id))!;
    assert.ok(u, "аккаунт на месте");
    assert.deepEqual([u.sub_charge_id, Number(u.sub_canceled), u.tg_user_id], ["charge-del-33334444", 0, "11"], "подписку можно отменить позже");
    assert.equal(s.tg.to("11").length, sent, "письма нет");
    assert.equal((await s.call(`/api/admin/account/${s.anya.id}`)).body.live_sub, true);
    assert.ok(!(await s.store.adminLog(50)).some((x) => x.action === "delete"));
  } finally {
    await s.close();
  }
});

for (const [name, open] of Object.entries(BACKENDS)) {
  test(`удалить аккаунт (${name}): сбой внутри транзакции — откат всего, письма нет, в журнал — delete-fail «продление отменено»`, async () => {
    const s = await stand(open);
    try {
      const schema = await schemaOf(s.store);
      const a = await fill(s.store, schema, s.anya.id);
      const exp = Math.floor((Date.now() + 30 * DAY) / 1000);
      await s.billing.paid({ id: 11 }, { currency: "XTR", total_amount: 150, invoice_payload: signPayload(SECRET, s.anya.id), telegram_payment_charge_id: "charge-del-55556666", subscription_expiration_date: exp, is_recurring: true, is_first_recurring: true });
      const withUser = [...schema].filter(([, cols]) => cols.some((c) => c.name === "user_id")).map(([t]) => t);
      const rows = async () => Object.fromEntries(await Promise.all(withUser.filter((t) => t !== "billing_events" && t !== "admin_log")
        .map(async (t) => [t, await count(s.store, `SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`, s.anya.id)])));
      const rows0 = await rows();
      const kv = () => Promise.all(a.keys.map((k) => s.store.kvGet(k)));
      const kv0 = await kv(); // paylink:<id> оплата уже убрала
      const sent = s.tg.to("11").length;
      // Строка журнала админа пишется внутри транзакции удаления (extra) — первая её запись падает.
      const orig = s.store.addAdminLog.bind(s.store);
      let failed = false;
      s.store.addAdminLog = (async (...x: Parameters<typeof orig>) => {
        if (!failed && x[1] === "delete") { failed = true; throw new Error("сбой записи журнала"); }
        return orig(...x);
      }) as typeof orig;
      const r = await s.call(`/api/admin/account/${s.anya.id}/delete`, { reason: "тестовый аккаунт", confirm: String(s.anya.id) });
      assert.equal(r.status, 500, JSON.stringify(r.body));
      assert.match(JSON.stringify(r.body), /не прошло.*Продление подписки Telegram при этом уже отменено/);
      assert.ok(await s.store.user(s.anya.id), "аккаунт на месте");
      assert.deepEqual(await rows(), rows0, "все строки на месте");
      assert.deepEqual(await kv(), kv0, "ключи kv на месте");
      assert.ok(kv0.filter((v) => v === "1").length >= a.keys.length - 1);
      assert.equal(await s.store.kvGet(USERS_GONE_KEY), undefined);
      assert.equal(s.tg.to("11").length, sent, "письма «удалён» нет");
      const log = await s.store.adminLog(50);
      assert.ok(!log.some((x) => x.action === "delete"));
      const fail = log.find((x) => x.action === "delete-fail");
      assert.deepEqual([fail?.detail, fail?.reason], [`#${s.anya.id} удаление не прошло, продление отменено`, "тестовый аккаунт"]);
      assert.equal(Number((await s.store.user(s.anya.id))!.sub_canceled), 1, "продление отменено — и это видно");
    } finally {
      await s.close();
    }
  });
}

test("удалить аккаунт с идущей подпиской: продление Telegram отменяется (как при заморозке), оплата остаётся в отчётах без человека", async () => {
  const s = await stand(BACKENDS.sqlite);
  try {
    const exp = Math.floor((Date.now() + 30 * DAY) / 1000);
    await s.billing.paid({ id: 11 }, { currency: "XTR", total_amount: 150, invoice_payload: signPayload(SECRET, s.anya.id), telegram_payment_charge_id: "charge-del-11112222", subscription_expiration_date: exp, is_recurring: true, is_first_recurring: true });
    assert.equal((await s.call(`/api/admin/account/${s.anya.id}`)).body.live_sub, true);
    const r = await s.call(`/api/admin/account/${s.anya.id}/delete`, { reason: "тестовый аккаунт", confirm: s.anya.id });
    assert.equal(r.status, 200);
    assert.match(r.body.text, /Продление подписки Telegram отменено/);
    assert.deepEqual(s.tg.of("edit").map((x) => x.a.slice(1)), [["charge-del-11112222", true]], "продление выключено");
    const log = (await s.call("/api/admin/log")).body as unknown as { detail: string }[];
    assert.match(log[0].detail, /, продление отменено$/);
    const ev = await s.store.driver.all<{ kind: string }>("SELECT kind FROM billing_events WHERE user_id = ? ORDER BY id", [-s.anya.id]);
    assert.deepEqual(ev.map((e) => e.kind), ["paid_first", "canceled"]);
    assert.equal((await s.store.paymentsOf(-s.anya.id)).length, 1);
    assert.equal((await s.store.paymentsOf(-s.anya.id))[0].tg_user_id, "");
    const refund = await s.call("/api/admin/refund", { user_id: s.anya.id, reason: "проверка" });
    assert.equal(refund.status === 200, false, "вернуть звёзды удалённому из админки нельзя");
  } finally {
    await s.close();
  }
});
