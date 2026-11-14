import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { accountsText } from "../src/accounts.ts";
import { Store } from "../src/db.ts";
import { asUser, type LlmUsage, onLlmUsage, reportUsage } from "../src/llm.ts";

// Учёт по людям: запрос к ИИ идёт на счёт того, для кого сделан (asUser); владелец видит сводку командой /accounts.

const TZ = "Europe/Moscow";
const NOW = new Date("2026-11-14T10:00:00Z"); // 13:00 по Москве
const use = (cost: number, userId?: number) => ({ kind: "answer", model: "m", input: 10, output: 5, cost, userId });

test("расход: внутри asUser — на счёт человека, и после await тоже; вне — ничей (0); явный userId не перебивается", async () => {
  const seen: LlmUsage[] = [];
  onLlmUsage((u) => seen.push(u));
  try {
    reportUsage({ kind: "chat", model: "m", input: 1, output: 1, cost: 0.01 });
    await asUser(7, async () => {
      await new Promise((r) => setTimeout(r, 5));
      reportUsage({ kind: "chat", model: "m", input: 1, output: 1, cost: 0.01 });
      reportUsage({ kind: "chat", model: "m", input: 1, output: 1, cost: 0.01, userId: 3 });
    });
    reportUsage({ kind: "chat", model: "m", input: 1, output: 1, cost: 0.01 });
  } finally {
    onLlmUsage(null);
  }
  assert.deepEqual(seen.map((u) => u.userId), [0, 7, 3, 0]);
});

test("учёт: строки по людям, а «Расход» на сайте (usageDays) и сумма за месяц — все вместе", async () => {
  const store = await Store.open(":memory:");
  const day = new Date("2026-11-14T10:00:00Z");
  await store.addUsage(day, use(0.1, 1));
  await store.addUsage(day, use(0.2, 2));
  await store.addUsage(day, use(0.3, 2));
  const days = await store.usageDays("2026-11-14", "2026-11-14");
  assert.equal(days.length, 1);
  assert.equal(days[0].calls, 3);
  assert.ok(Math.abs(days[0].cost - 0.6) < 1e-9);
  assert.ok(Math.abs((await store.llmUsage("2026-11")).cost - 0.6) < 1e-9);
});

test("сводка аккаунтов: кто когда писал, сколько за 7 дней, расход за месяц и всего; ничей — отдельной строкой", async () => {
  const store = await Store.open(":memory:");
  const me = await store.ensureUser("111", "Хозяин", TZ);
  const friend = await store.createUser({ login: "vasya", passwordHash: "x", name: "Вася", tz: TZ, chatId: "222" });
  await store.saveMessage({ userId: me.id, source: "telegram", sourceId: "1", text: "давно", dayKey: "2026-11-01", at: new Date("2026-11-01T10:00:00Z") });
  await store.saveMessage({ userId: me.id, source: "telegram", sourceId: "2", text: "сегодня", dayKey: "2026-11-14", at: new Date("2026-11-14T09:20:00Z") });
  await store.saveMessage({ userId: friend.id, source: "telegram", sourceId: "3", text: "вчера", dayKey: "2026-11-13", at: new Date("2026-11-13T06:05:00Z") });
  await store.addUsage(new Date("2026-10-20T10:00:00Z"), use(1, me.id)); // прошлый месяц — только во «всего»
  await store.addUsage(NOW, use(0.25, me.id));
  await store.addUsage(NOW, use(0.5, friend.id));
  await store.addUsage(NOW, use(2)); // ничей
  const rows = await store.accounts("2026-11", new Date(NOW.getTime() - 7 * 86_400_000).toISOString());
  const mine = rows.find((r) => r.id === me.id)!;
  assert.equal(mine.recent, 1);
  assert.equal(mine.last_at, new Date("2026-11-14T09:20:00Z").toISOString());
  assert.ok(Math.abs(mine.month - 0.25) < 1e-9 && Math.abs(mine.total - 1.25) < 1e-9);
  assert.ok(Math.abs(rows.find((r) => r.id === friend.id)!.month - 0.5) < 1e-9);
  assert.ok(Math.abs(rows.find((r) => r.id === 0)!.total - 2) < 1e-9);

  const text = await accountsText(store, ["111"], TZ, NOW);
  assert.match(text, /Аккаунты: 2/);
  assert.match(text, /<b>Хозяин<\/b> · вы/);
  assert.match(text, /писал\(а\): сегодня 12:20 · сообщений за 7 дн\.: 1/);
  assert.match(text, /<b>Вася<\/b> · vasya · с /);
  assert.match(text, /писал\(а\): вчера 09:05/);
  assert.match(text, /ИИ: \$0\.50 за месяц · \$0\.50 всего/);
  assert.match(text, /Ничей и до учёта по людям: \$2\.00/);
  assert.match(text, /Всего на ИИ за месяц: \$2\.75/);
});

test("шаг 14 базы: старый расход (без людей) сохраняется как ничей", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "maid-acc-")), "maid.sqlite");
  (await Store.open(file)).close();
  // Вернуть базу к шагу 13: старая таблица расхода без user_id и одна строка в ней.
  const db = new DatabaseSync(file);
  db.exec(`DROP TABLE llm_usage;
    CREATE TABLE llm_usage (day TEXT NOT NULL, kind TEXT NOT NULL, model TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0, input INTEGER NOT NULL DEFAULT 0,
      output INTEGER NOT NULL DEFAULT 0, micro_usd INTEGER NOT NULL DEFAULT 0, priced INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, kind, model));
    INSERT INTO llm_usage VALUES ('2026-11-10', 'answer', 'm', 4, 40, 20, 1500000, 4);
    UPDATE kv SET value = '13' WHERE key = 'schema_version';`);
  db.close();
  const store = await Store.open(file);
  const rows = await store.accounts("2026-11", "2026-11-01T00:00:00Z");
  assert.ok(Math.abs(rows.find((r) => r.id === 0)!.total - 1.5) < 1e-9);
  await store.addUsage(NOW, use(0.5, 1)); // новая запись с человеком ложится в новую таблицу
  assert.ok(Math.abs((await store.llmUsage("2026-11")).cost - 2) < 1e-9);
  store.close();
});
