import { PGlite } from "@electric-sql/pglite";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import zlib from "node:zlib";
import { ALERT_CHECK_MS, ALERT_LLM_MIN_CALLS, Alerts, noteSendFailure, resetSendFailures } from "../src/alerts.ts";
import { createApi } from "../src/api.ts";
import { hashPassword } from "../src/auth.ts";
import { config } from "../src/config.ts";
import { Store } from "../src/db.ts";
import { PgDriver } from "../src/driver.ts";
import { Pipeline } from "../src/pipeline.ts";
import { checkSnapshot, DbCopies, sendEach, takeSnapshot } from "../src/snapshot.ts";
import { dayKey } from "../src/time.ts";

// Этап 4 «Тарифы и управление»: оповещения владельцу по правилам (alerts.ts) и ночная копия базы (snapshot.ts DbCopies).
// Telegram подменён: письма — в массив, файлы — в массив; видно, что и сколько раз ушло.

const TZ = "Europe/Moscow";
const NOW = new Date("2026-11-24T12:00:00Z");
const MIN = 60_000;

function inbox() {
  const sent: string[] = [];
  return { sent, notify: async (text: string) => (sent.push(text), 1) };
}

const rule = async (a: Alerts, id: string) => (await a.view(NOW)).rules.find((r) => r.id === id)!;

test("оповещения: правила по умолчанию — в базе, тихо в обычный день", async () => {
  const store = await Store.open(":memory:");
  try {
    const box = inbox();
    const a = new Alerts(store, { notify: box.notify, publicUrl: "https://maid.test" });
    const v = await a.view(NOW);
    for (const id of ["spend_day", "spend_spike", "llm_errors", "failed_msgs", "send_fail", "webhook", "signup_cap", "refund", "payment", "backup", "db_size", "newcomers"]) {
      assert.ok(v.rules.find((r) => r.id === id), id);
    }
    assert.equal((await store.alertRules()).length, v.rules.length, "правила записаны в базу");
    assert.ok(Math.abs(v.rules.find((r) => r.id === "spend_day")!.threshold - 8) < 1e-9, "80% потолка проб $10");
    const r = await a.check(new Date(Date.UTC(2026, 10, 24, 5)), true); // до 06:00 UTC — без сводки новичков
    assert.ok(r && r.every((x) => !x.hit), "ничего не сработало");
    assert.equal(box.sent.length, 0);
    assert.equal(await a.check(new Date(Date.UTC(2026, 10, 24, 5, 1))), null, "реже раза в 5 минут без кнопки — не проверяет");
  } finally {
    await store.close();
  }
});

test("оповещения: срабатывание, антиспам, повтор, «снова норма»; выключенное молчит", async () => {
  const store = await Store.open(":memory:");
  try {
    const box = inbox();
    const a = new Alerts(store, { notify: box.notify, publicUrl: "https://maid.test" });
    await store.once("digest:2026-11-24"); // сводка новых — в своём тесте
    const u = await store.ensureUser("1001", "Аня", TZ);
    // Расход за день выше порога ($8): письмо одно; «снова норма» у расхода нет.
    await store.addUsage(NOW, { kind: "parse", model: "m", input: 1, output: 1, cost: 9, userId: u.id });
    // Неразобранные за час: 3.
    const failed: number[] = [];
    for (let i = 0; i < 3; i++) {
      const { message } = await store.saveMessage({ userId: u.id, source: "telegram", sourceId: `f${i}`, text: "секрет Ани", dayKey: dayKey(NOW, TZ), at: new Date(NOW.getTime() - 10 * MIN) });
      await store.setMessage(message.id, { state: "failed" });
      failed.push(message.id);
    }
    await a.update(1, { id: "failed_msgs", every_min: 20, reason: "чаще для проверки" });
    await a.check(NOW, true);
    assert.equal(box.sent.length, 3, "расход за день, всплеск расхода, неразобранные");
    assert.ok(box.sent.some((t) => /Расход на ИИ сегодня \(UTC\): \$9\.00 — порог \$8\.00/.test(t)));
    assert.ok(box.sent.some((t) => /Не разобрано сообщений за 60 мин: 3/.test(t)));
    for (const t of box.sent) {
      assert.match(t, /https:\/\/maid\.test\/admin\/alerts/, "ссылка в админку");
      assert.ok(!t.includes("Аня") && !t.includes("секрет") && !t.includes("1001"), "без имён, текстов и chat id");
    }
    // Через 5 минут — всё ещё плохо, но «не чаще раза в 20 минут» — молчит.
    await a.check(new Date(NOW.getTime() + 5 * MIN), true);
    assert.equal(box.sent.length, 3, "антиспам");
    // Через 21 минуту — повтор неразобранных (расход — раз в 6 часов).
    await a.check(new Date(NOW.getTime() + 21 * MIN), true);
    assert.equal(box.sent.length, 4);
    assert.match(box.sent[3], /Всё ещё держится.*Не разобрано/);
    // Сообщения разобрались — «снова норма» один раз.
    for (const id of failed) await store.setMessage(id, { state: "done" });
    await a.check(new Date(NOW.getTime() + 26 * MIN), true);
    assert.equal(box.sent.length, 5);
    assert.match(box.sent[4], /Снова норма: неразобранных/);
    await a.check(new Date(NOW.getTime() + 31 * MIN), true);
    assert.equal(box.sent.length, 5, "норма — тихо");
    const hist = (await a.view(NOW)).history;
    assert.deepEqual(hist.slice(0, 5).map((h) => h.kind).sort(), ["fire", "fire", "fire", "ok", "repeat"]);

    // Выключенное правило молчит, даже когда условие выполнено.
    await a.update(1, { id: "failed_msgs", enabled: false, reason: "шумит при выкладке" });
    for (let i = 0; i < 4; i++) {
      const { message } = await store.saveMessage({ userId: u.id, source: "telegram", sourceId: `g${i}`, text: "x", dayKey: dayKey(NOW, TZ), at: new Date(NOW.getTime() + 35 * MIN) });
      await store.setMessage(message.id, { state: "failed" });
    }
    const r = await a.check(new Date(NOW.getTime() + 40 * MIN), true);
    assert.equal(r!.find((x) => x.id === "failed_msgs")!.sent, null);
    assert.equal(box.sent.length, 5, "выключено — ни слова");
  } finally {
    await store.close();
  }
});

test("оповещения: первое срабатывание внутри «не чаще» — без письма, письмо — когда срок вышел; «норма» о молчавшей тревоге не пишется", async () => {
  const store = await Store.open(":memory:");
  try {
    resetSendFailures();
    const box = inbox();
    const a = new Alerts(store, { notify: box.notify });
    await a.rules(NOW);
    for (let i = 0; i < 5; i++) noteSendFailure(new Error("net"), NOW.getTime() - MIN);
    noteSendFailure({ error_code: 403 }, NOW.getTime()); // человек заблокировал бота — не в счёт
    await a.check(NOW, true);
    assert.equal(box.sent.filter((t) => /Не ушло в Telegram за 15 мин: 5/.test(t)).length, 1);
    // Прошло — «снова норма».
    await a.check(new Date(NOW.getTime() + 20 * MIN), true);
    assert.equal(box.sent.filter((t) => /сбоев отправки/.test(t)).length, 1);
    // Снова сбои через 10 минут после письма — «не чаще раза в 60 мин»: тревога без письма.
    for (let i = 0; i < 5; i++) noteSendFailure(new Error("net"), NOW.getTime() + 21 * MIN);
    const held = await a.check(new Date(NOW.getTime() + 25 * MIN), true);
    assert.equal(held!.find((x) => x.id === "send_fail")!.sent, "held");
    assert.equal((await rule(a, "send_fail")).firing, 1);
    // Сбои прошли, пока молчали, — «снова норма» не пишем (о тревоге не писали).
    const before = box.sent.length;
    await a.check(new Date(NOW.getTime() + 50 * MIN), true);
    assert.equal(box.sent.length, before);
    assert.equal((await rule(a, "send_fail")).firing, 0);
  } finally {
    resetSendFailures();
    await store.close();
  }
});

test("оповещения: доля ошибок ИИ — только при достаточном числе вызовов; возвраты и оплаты — по журналу, одним письмом", async () => {
  const store = await Store.open(":memory:");
  try {
    const box = inbox();
    const a = new Alerts(store, { notify: box.notify });
    await a.rules(new Date(NOW.getTime() - 60 * MIN));
    for (let i = 0; i < ALERT_LLM_MIN_CALLS - 1; i++) await store.addLlmCall(new Date(NOW.getTime() - 5 * MIN), { kind: "parse", model: "m", ms: 10, cost: 0, error: "timeout" });
    await a.check(NOW, true);
    assert.equal(box.sent.length, 0, "9 вызовов, все с ошибкой — мало для доли");
    await store.addLlmCall(new Date(NOW.getTime() - 4 * MIN), { kind: "parse", model: "m", ms: 10, cost: 0 });
    const u = await store.ensureUser("1001", "Аня", TZ);
    await store.addBillingEvent({ user_id: u.id, kind: "refunded", at: new Date(NOW.getTime() - 2 * MIN), amount: 150 });
    await store.addBillingEvent({ user_id: u.id, kind: "paid_first", at: new Date(NOW.getTime() - 3 * MIN), amount: 150 });
    await store.addBillingEvent({ user_id: u.id, kind: "renewed", at: new Date(NOW.getTime() - 2 * MIN), amount: 150 });
    await a.check(new Date(NOW.getTime() + MIN), true);
    assert.ok(box.sent.some((t) => /Ошибок ИИ за 60 мин: 90% \(9 из 10 вызовов\)/.test(t)));
    assert.ok(box.sent.some((t) => /Возвратов звёзд: 1 на ⭐150/.test(t)));
    assert.ok(box.sent.some((t) => /Новых оплат: 2 на ⭐300/.test(t)));
    const n = box.sent.length;
    await a.check(new Date(NOW.getTime() + 15 * MIN), true);
    assert.equal(box.sent.length, n, "те же события второй раз не приходят");
  } finally {
    await store.close();
  }
});

test("оповещения: сводка новых — раз в сутки, номера аккаунтов без логинов", async () => {
  const store = await Store.open(":memory:");
  try {
    const box = inbox();
    const a = new Alerts(store, { notify: box.notify });
    await store.kvSet("newcomers:since", new Date(NOW.getTime() - 86_400_000).toISOString());
    const x = await store.createUser({ login: "secret_login", passwordHash: "x", tz: TZ, chatId: "777" });
    await a.check(NOW, true);
    const digest = box.sent.filter((t) => t.startsWith("🆕"));
    assert.equal(digest.length, 1);
    assert.match(digest[0], new RegExp(`Новых за сутки: 1 — #${x.id}`));
    assert.ok(!digest[0].includes("secret_login"));
    await a.check(new Date(NOW.getTime() + 10 * MIN), true);
    assert.equal(box.sent.filter((t) => t.startsWith("🆕")).length, 1, "второй раз за сутки — нет");
  } finally {
    await store.close();
  }
});

test("правило из админки: причина обязательна, границы, в журнал админа — что было и стало", async () => {
  const store = await Store.open(":memory:");
  try {
    const a = new Alerts(store, { notify: async () => 1 });
    await assert.rejects(a.update(1, { id: "spend_day", threshold: 12 }), /причину/);
    await assert.rejects(a.update(1, { id: "spend_day", threshold: -1, reason: "проверка" }), /порог/);
    await assert.rejects(a.update(1, { id: "nope", threshold: 1, reason: "проверка" }), /нет такого/);
    await assert.rejects(a.update(1, { id: "spend_day", window_min: 30, reason: "проверка" }), /окно/);
    await a.update(1, { id: "spend_day", threshold: 12, enabled: false, reason: "подняли потолок проб" });
    const r = await rule(a, "spend_day");
    assert.equal(r.threshold, 12);
    assert.equal(r.enabled, false);
    const [log] = await store.adminLog(1);
    assert.equal(log.action, "alert_rule");
    assert.match(log.detail, /spend_day: выключено; порог 8 → 12/);
    assert.equal(log.reason, "подняли потолок проб");
    await assert.rejects(a.update(1, { id: "spend_day", threshold: 12, reason: "ещё раз" }), /ничего не изменилось/);
  } finally {
    await store.close();
  }
});

test("копия базы: снимок открывается как база, сжатая уходит владельцу, хранятся последние N", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maid-copy-"));
  const store = await Store.open(path.join(dir, "maid.sqlite"));
  try {
    const u = await store.ensureUser("100", "Тест", TZ);
    await store.addTask({ user_id: u.id, title: "Купить хлеб", priority: "normal", category: "", due_date: null, notes: "", message_id: null });
    const files: { name: string; data: Buffer; caption: string }[] = [];
    const copies = new DbCopies(store, { dir: path.join(dir, "snapshots"), dbFile: path.join(dir, "maid.sqlite"), keep: 3, send: async (name, data, caption) => (files.push({ name, data, caption }), 1) });
    for (let d = 1; d <= 5; d++) {
      const r = await copies.run(new Date(Date.UTC(2026, 10, d, 1)));
      assert.equal(r.status, "ok");
      assert.equal(r.sent, 1);
      assert.equal(r.problem, "");
    }
    assert.deepEqual(fs.readdirSync(path.join(dir, "snapshots")).sort(), ["latest.sqlite", "maid-2026-11-03.sqlite", "maid-2026-11-04.sqlite", "maid-2026-11-05.sqlite"]);
    assert.equal(files.length, 5);
    assert.equal(files[4].name, "maid-2026-11-05.sqlite.gz");
    assert.match(files[4].caption, /не пересылайте/);
    // Присланный файл — целая база: распаковать и открыть.
    const back = path.join(dir, "from-telegram.sqlite");
    fs.writeFileSync(back, zlib.gunzipSync(files[4].data));
    assert.equal(checkSnapshot(back), null);
    const s2 = await Store.open(back);
    try {
      assert.equal((await s2.allTasks((await s2.users())[0].id))[0].title, "Купить хлеб");
    } finally {
      await s2.close();
    }
    const v = await copies.view();
    assert.equal(v.mode, "sqlite");
    assert.equal(v.local.length, 3);
    assert.equal(v.copies.length, 5);
    assert.ok(v.db_bytes && v.db_bytes > 0);
    assert.ok(!JSON.stringify(v).includes(dir), "путей сервера наружу нет");

    // Проверка восстановления: копия целая, числа сходятся; временного файла после неё нет.
    const ok = await copies.verify(new Date(Date.UTC(2026, 10, 5, 2)), 1);
    assert.equal(ok.status, "ok", ok.problem);
    assert.match(ok.note, /людей 1 \(сейчас 1\)/);
    assert.ok(!fs.readdirSync(path.join(dir, "snapshots")).some((f) => f.startsWith(".verify")), "временный файл удалён");
    // Последняя копия испорчена — проверка это находит.
    fs.writeFileSync(path.join(dir, "snapshots", "maid-2026-11-05.sqlite"), "не база ".repeat(100));
    const bad = await copies.verify(new Date(Date.UTC(2026, 10, 5, 3)), 1);
    assert.equal(bad.status, "fail");
    assert.match(bad.problem, /не поднимается/);
    assert.ok(!fs.readdirSync(path.join(dir, "snapshots")).some((f) => f.startsWith(".verify")));
    assert.equal((await store.dbCopies("verify")).length, 2);
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("копия базы: слишком большая для Telegram и сбой отправки — не падает, правило backup пишет владельцу", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maid-copy-"));
  const store = await Store.open(path.join(dir, "maid.sqlite"));
  try {
    await store.ensureUser("100", "Тест", TZ);
    let tries = 0;
    const big = new DbCopies(store, { dir: path.join(dir, "snapshots"), maxSendBytes: 100, send: async () => (tries++, 1) });
    const r = await big.run(NOW);
    assert.equal(r.status, "ok", "сама копия на сервере есть");
    assert.equal(r.sent, 0);
    assert.match(r.problem, /не влезает в Telegram/);
    assert.equal(tries, 0, "слать не пробовали");
    const box = inbox();
    const a = new Alerts(store, { notify: box.notify });
    await a.check(new Date(NOW.getTime() + MIN), true);
    assert.equal(box.sent.filter((t) => /Копия базы: не влезает в Telegram/.test(t)).length, 1);
    // Следующая копия удалась и ушла — «снова в порядке».
    const good = new DbCopies(store, { dir: path.join(dir, "snapshots"), send: async () => 1 });
    assert.equal((await good.run(new Date(NOW.getTime() + 86_400_000))).problem, "");
    await a.check(new Date(NOW.getTime() + 86_400_000 + MIN), true);
    assert.equal(box.sent.filter((t) => /Копия базы снова в порядке/.test(t)).length, 1);
    // Telegram не принял файл — тоже строка с бедой, без исключения наружу.
    const broken = new DbCopies(store, { dir: path.join(dir, "snapshots"), send: async () => { throw new Error("Request Entity Too Large"); } });
    const f = await broken.run(new Date(NOW.getTime() + 2 * 86_400_000));
    assert.match(f.problem, /Telegram не принял файл: Request Entity Too Large/);
    // Без бота — копия только на сервере, это не беда.
    const local = await new DbCopies(store, { dir: path.join(dir, "snapshots") }).run(new Date(NOW.getTime() + 3 * 86_400_000));
    assert.equal(local.problem, "");
    assert.match(local.note, /бот выключен/);
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("копия базы: ночью — после 04:00 по поясу владельца, раз в сутки", async () => {
  const store = await Store.open(":memory:");
  try {
    const c = new DbCopies(store, { dir: null });
    assert.equal(await c.due(new Date("2026-11-24T00:30:00Z"), TZ), false, "03:30 в Москве — рано");
    assert.equal(await c.due(new Date("2026-11-24T01:05:00Z"), TZ), true, "04:05 в Москве");
    assert.equal(await c.due(new Date("2026-11-24T05:00:00Z"), TZ), false, "второй раз за сутки — нет");
    assert.equal((await c.run(NOW)).status, "skip", "нет папки — пропуск");
  } finally {
    await store.close();
  }
});

test("копия базы на Postgres: понятный пропуск, правило backup молчит", async () => {
  const pg = new PGlite();
  const store = await Store.over(new PgDriver(pg, (fn) => pg.transaction((tx) => fn(tx)), () => pg.close()));
  try {
    const c = new DbCopies(store, { dir: "/не/используется", send: async () => 1 });
    assert.equal(c.mode, "postgres");
    const r = await c.run(NOW);
    assert.equal(r.status, "skip");
    assert.match(r.note, /Postgres: копии базы делает провайдер/);
    const v = await c.verify(NOW);
    assert.equal(v.status, "skip");
    const box = inbox();
    const a = new Alerts(store, { notify: box.notify });
    const rows = await a.check(NOW, true);
    assert.equal(rows!.find((x) => x.id === "backup")!.value, null);
    assert.equal(box.sent.filter((t) => /Копия базы/.test(t)).length, 0);
    // Правила и журнал на Postgres работают тем же SQL.
    await a.update(1, { id: "db_size", threshold: 900, reason: "Postgres у провайдера" });
    assert.equal((await rule(a, "db_size")).threshold, 900);
    assert.equal((await store.dbCopies("copy")).length, 1);
  } finally {
    await store.close();
  }
});

// ——— Ручки админки: тем же путём, что сайт (вход → код из «Telegram» → /api/admin/*).
const OWNER = "987654321";
async function stand(dir: string) {
  config.allowedChatIds.splice(0, Infinity, OWNER);
  config.adminChatIds.splice(0, Infinity);
  const store = await Store.open(path.join(dir, "maid.sqlite"));
  await store.createUser({ login: "owner", passwordHash: await hashPassword("owner-pass-1"), tz: TZ, chatId: OWNER, name: "Хозяин" });
  await store.createUser({ login: "anya", passwordHash: await hashPassword("anya-pass-1"), tz: TZ, chatId: "11", name: "Аня" });
  const tg: string[] = [];
  const files: string[] = [];
  const adminCode = async (_u: unknown, text: string) => void tg.push(text);
  const alerts = new Alerts(store, { notify: async (t) => (tg.push(t), 1) });
  const copies = new DbCopies(store, { dir: path.join(dir, "snapshots"), dbFile: path.join(dir, "maid.sqlite"), send: async (name) => (files.push(name), 1) });
  const server = createApi({ store, pipeline: new Pipeline(store, async () => "{}"), adminCode, alerts, copies }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (token: string, p: string, body?: unknown) => {
    const r = await fetch(base + p, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> };
  };
  const login = async (l: string, pw: string) => String((await (await fetch(base + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: l, password: pw }) })).json()).token);
  return { store, tg, files, call, login, close: async () => { server.close(); await store.close(); } };
}

test("админка: «Оповещения» и «Копии базы» — 404 не админу, 403 без кода, действия с причиной и в журнал, без имён", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maid-adm-"));
  const s = await stand(dir);
  try {
    const anya = await s.login("anya", "anya-pass-1");
    for (const p of ["/api/admin/alerts", "/api/admin/backups"]) assert.equal((await s.call(anya, p)).status, 404, p);
    assert.equal((await s.call(anya, "/api/admin/backups/run", { reason: "хочу" })).status, 404);
    const owner = await s.login("owner", "owner-pass-1");
    assert.equal((await s.call(owner, "/api/admin/alerts")).status, 403, "без кода");
    assert.equal((await s.call(owner, "/api/admin/backups/run", { reason: "проверка" })).status, 403);
    await s.call(owner, "/api/admin/code", {});
    const code = s.tg.at(-1)!.match(/\d{6}/)![0];
    assert.equal((await s.call(owner, "/api/admin/confirm", { code })).status, 200);

    const v = await s.call(owner, "/api/admin/alerts");
    assert.equal(v.status, 200);
    assert.ok(v.body.rules.length >= 10);
    assert.equal((await s.call(owner, "/api/admin/alerts/rule", { id: "payment", enabled: false })).status, 400, "без причины");
    const ch = await s.call(owner, "/api/admin/alerts/rule", { id: "payment", enabled: false, reason: "оплат пока много" });
    assert.equal(ch.status, 200);
    assert.equal(ch.body.rules.find((r: { id: string }) => r.id === "payment").enabled, false);
    assert.equal((await s.call(owner, "/api/admin/alerts/test", {})).status, 400);
    const t = await s.call(owner, "/api/admin/alerts/test", { reason: "проверить доставку" });
    assert.equal(t.body.sent, 1);
    assert.match(s.tg.at(-1)!, /Проверка оповещений/);
    const now = await s.call(owner, "/api/admin/alerts/check", { reason: "после выкладки" });
    assert.equal(now.status, 200);
    assert.ok(Array.isArray(now.body.results));

    assert.equal((await s.call(owner, "/api/admin/backups/run", {})).status, 400, "без причины");
    const run = await s.call(owner, "/api/admin/backups/run", { reason: "перед выкладкой" });
    assert.equal(run.status, 200);
    assert.equal(run.body.result.status, "ok");
    assert.equal(run.body.result.sent, 1);
    assert.equal(s.files.length, 1);
    const ver = await s.call(owner, "/api/admin/backups/verify", { reason: "раз в неделю" });
    assert.equal(ver.body.result.status, "ok", ver.body.result.problem);
    const b = await s.call(owner, "/api/admin/backups");
    assert.equal(b.body.copies.length, 1);
    assert.equal(b.body.verifies.length, 1);

    const log = (await s.call(owner, "/api/admin/log")).body as unknown as { action: string; reason: string }[];
    for (const a of ["alert_rule", "alert_test", "alert_check", "backup_run", "backup_verify"]) {
      const row = log.find((r) => r.action === a);
      assert.ok(row && row.reason.length >= 3, `${a} — в журнале с причиной`);
    }
    for (const body of [v.body, now.body, b.body, run.body, ver.body]) {
      const txt = JSON.stringify(body);
      for (const bad of ["Аня", "anya", "Хозяин", "owner", OWNER, dir]) assert.ok(!txt.includes(bad), `нет «${bad}» в ответе`);
    }
  } finally {
    await s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("оповещения: такт раз в ALERT_CHECK_MS", () => {
  assert.equal(ALERT_CHECK_MS, 5 * MIN);
});

test("оповещения: после перезапуска счётчик сбоев отправки пуст — send_fail не пишет ложное «снова норма», ждёт полное окно", async () => {
  const store = await Store.open(":memory:");
  try {
    resetSendFailures();
    await store.once("digest:2026-11-24");
    const box = inbox();
    const a = new Alerts(store, { notify: box.notify });
    for (let i = 0; i < 5; i++) noteSendFailure(new Error("net"), NOW.getTime() - MIN);
    await a.check(NOW, true);
    assert.equal((await rule(a, "send_fail")).firing, 2, "сработало, письмо ушло");
    // Перезапуск: память процесса пуста, состояние правила — в базе.
    resetSendFailures();
    const b = new Alerts(store, { notify: box.notify });
    const n = box.sent.length;
    const first = await b.check(new Date(NOW.getTime() + 2 * MIN), true);
    assert.equal(first!.find((x) => x.id === "send_fail")!.sent, null);
    assert.equal(box.sent.length, n, "сразу после запуска — без «снова норма»");
    assert.equal((await rule(b, "send_fail")).firing, 2);
    await b.check(new Date(NOW.getTime() + 10 * MIN), true);
    assert.equal(box.sent.length, n, "окно (15 мин) после запуска ещё не набралось");
    // Сбои идут и после запуска — тревога держится, как и должна.
    for (let i = 0; i < 5; i++) noteSendFailure(new Error("net"), NOW.getTime() + 11 * MIN);
    assert.equal((await b.check(new Date(NOW.getTime() + 12 * MIN), true))!.find((x) => x.id === "send_fail")!.hit, true);
    // Полное окно без сбоев после запуска — теперь «снова норма» честное.
    await b.check(new Date(NOW.getTime() + 30 * MIN), true);
    assert.equal(box.sent.filter((t) => /Снова норма: сбоев отправки/.test(t)).length, 1);
    assert.equal((await rule(b, "send_fail")).firing, 0);
  } finally {
    resetSendFailures();
    await store.close();
  }
});

test("оповещения: письмо не дошло (Telegram сбоит) — отметки не сдвигаются, следующая проверка пишет снова", async () => {
  const store = await Store.open(":memory:");
  try {
    await store.once("digest:2026-11-24");
    let up = false;
    const sent: string[] = [];
    const a = new Alerts(store, { notify: async (t) => (up ? (sent.push(t), 1) : 0) });
    await a.rules(new Date(NOW.getTime() - 60 * MIN));
    const u = await store.ensureUser("1001", "Аня", TZ);
    await store.addBillingEvent({ user_id: u.id, kind: "refunded", at: new Date(NOW.getTime() - 2 * MIN), amount: 150 });
    await store.addUsage(NOW, { kind: "parse", model: "m", input: 1, output: 1, cost: 9, userId: u.id });
    const down = await a.check(NOW, true);
    assert.equal(down!.find((x) => x.id === "refund")!.sent, null, "возврат: письмо не ушло");
    assert.equal(down!.find((x) => x.id === "spend_day")!.sent, null);
    const sd = await rule(a, "spend_day");
    assert.equal(sd.firing, 1, "тревога без письма");
    assert.equal(sd.last_sent, null, "last_sent не тронут");
    assert.equal((await store.alertLog(50)).filter((h) => h.rule === "refund" && !h.sent).length, 1, "в истории — «не ушло»");
    up = true;
    await a.check(new Date(NOW.getTime() + 5 * MIN), true);
    assert.ok(sent.some((t) => /Возвратов звёзд: 1 на ⭐150/.test(t)), "возврат не потерялся");
    assert.ok(sent.some((t) => /Расход на ИИ сегодня/.test(t)), "тревога о расходе дошла");
    assert.equal((await rule(a, "spend_day")).firing, 2);
  } finally {
    await store.close();
  }
});

test("копия базы: отправка каждому владельцу отдельно — сбой у одного не мешает другим", async () => {
  const got: string[] = [];
  const fn = async (x: string) => { if (x === "заблокировал") throw new Error("403 Forbidden"); got.push(x); };
  assert.equal(await sendEach(["заблокировал", "владелец"], fn), 1, "первый упал — второй всё равно получил");
  assert.deepEqual(got, ["владелец"]);
  assert.equal(await sendEach(["владелец", "заблокировал"], fn), 1);
  await assert.rejects(sendEach(["заблокировал"], fn), /403/, "не ушло никому — ошибка наружу");
  assert.equal(await sendEach([], fn), 0, "некому — 0 без ошибки");
  // Через DbCopies: ушло одному из двух — копия в Telegram есть, беды нет.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maid-copy-"));
  const store = await Store.open(path.join(dir, "maid.sqlite"));
  try {
    await store.ensureUser("100", "Тест", TZ);
    const c = new DbCopies(store, { dir: path.join(dir, "snapshots"), send: () => sendEach(["заблокировал", "владелец"], fn) });
    const r = await c.run(NOW);
    assert.equal(r.sent, 1);
    assert.equal(r.problem, "");
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("копия базы: снимок упал на середине (диск полон) — временные файлы удалены", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maid-snapfail-"));
  try {
    const full = {
      driver: { dialect: "sqlite" },
      raw: async (_q: string, tmp: string) => { fs.writeFileSync(tmp, "недописанный снимок"); throw new Error("SQLITE_FULL: database or disk is full"); },
    } as unknown as Store;
    await assert.rejects(takeSnapshot(full, dir, NOW), /SQLITE_FULL/);
    assert.deepEqual(fs.readdirSync(dir), [], "ни .tmp, ни снимка");
    // Снимок не прошёл проверку — тоже без остатков.
    const junk = { driver: { dialect: "sqlite" }, raw: async (_q: string, tmp: string) => void fs.writeFileSync(tmp, "не база") } as unknown as Store;
    await assert.rejects(takeSnapshot(junk, dir, NOW), /не прошёл проверку/);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("копия базы: ночной такт во время проверки восстановления не тратит отметку дня — копия снимается следующим тактом", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maid-copy-"));
  const store = await Store.open(path.join(dir, "maid.sqlite"));
  try {
    await store.ensureUser("100", "Тест", TZ);
    const c = new DbCopies(store, { dir: path.join(dir, "snapshots") });
    await c.run(new Date(NOW.getTime() - 86_400_000));
    const night = new Date("2026-11-24T01:05:00Z"); // 04:05 в Москве
    const v = c.verify(night, 1);
    assert.equal(await c.due(night, TZ), false, "идёт проверка — пропустить такт");
    assert.equal((await v).status, "ok");
    assert.equal(await c.due(new Date(night.getTime() + MIN), TZ), true, "освободилось — копия за сегодня ещё будет");
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
