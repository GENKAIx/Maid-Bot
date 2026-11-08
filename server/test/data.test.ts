import { PGlite } from "@electric-sql/pglite";
import ExcelJS from "exceljs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApi, searchDiary } from "../src/api.ts";
import { hashPassword } from "../src/auth.ts";
import { Store } from "../src/db.ts";
import { PgDriver } from "../src/driver.ts";
import { habitsOfDay } from "../src/habits.ts";
import { importWorkbook, parseGames, parsePc } from "../src/import.ts";
import type { LlmCall } from "../src/llm.ts";
import { Pipeline } from "../src/pipeline.ts";
import { Scheduler, type Button } from "../src/scheduler.ts";
import { zonedToUtc } from "../src/time.ts";

// Разделы этапа «Данные» — на SQLite и на Postgres (PGlite в памяти, тот же SQL, что на Render).

const TZ = "Europe/Moscow";
const AT = zonedToUtc("2026-11-08", "14:30", TZ);

const BACKENDS: Record<string, () => Promise<Store>> = {
  sqlite: () => Store.open(":memory:"),
  postgres: async () => {
    const pg = new PGlite();
    return Store.over(new PgDriver(pg, (fn) => pg.transaction((tx) => fn(tx)), () => pg.close()));
  },
};

async function setup(open: () => Promise<Store>, answers: unknown[] = []) {
  const store = await open();
  const u = await store.ensureUser("100", "Тест", TZ);
  const llm: LlmCall = async () => JSON.stringify(answers.shift() ?? {});
  return { store, u, pipe: new Pipeline(store, llm) };
}
const msg = (text: string, id: string) => ({ source: "telegram", sourceId: id, text, at: AT });

for (const [kind, open] of Object.entries(BACKENDS)) {
  test(`${kind}: привычка — утреннее напоминание с кнопками один раз, отметка кнопкой и её отмена`, async () => {
    const { store, u, pipe } = await setup(open, [
      { habits: [{ title: "Зарядка", days: "1234567", times: ["08:00"], duration_days: 30 }], summary: "s" },
      { habit_marks: [{ habit_id: 1, status: "done", day_iso: null }], summary: "s" },
    ]);
    await pipe.handle({ user: u, ...msg("каждый день в 8 зарядка, месяц", "1") });
    const [h] = await store.activeHabits(u.id);
    assert.equal(h.title, "Зарядка");
    assert.equal(h.end_date, "2026-12-07");

    const sent: { text: string; buttons?: Button[] }[] = [];
    const sch = new Scheduler(store, null, async (_u, text, _e, buttons) => void sent.push({ text, buttons }));
    await sch.tick(zonedToUtc("2026-11-09", "08:05", TZ));
    await sch.tick(zonedToUtc("2026-11-09", "08:06", TZ));
    const pings = sent.filter((s) => s.text.includes("Зарядка — сегодня сделали?"));
    assert.equal(pings.length, 1);
    assert.deepEqual(pings[0].buttons?.map((b) => b.data), [`habit:${h.id}:2026-11-09:done`, `habit:${h.id}:2026-11-09:skipped`]);

    const answer = await pipe.markHabit(u, h.id, "2026-11-09", "done", "telegram");
    assert.match(answer, /Зарядка/);
    assert.equal((await habitsOfDay(store, u, "2026-11-09"))[0].status, "done");
    await pipe.undo(u);
    assert.equal((await habitsOfDay(store, u, "2026-11-09"))[0].status, null);

    // Отметка текстом «сделал зарядку» — сегодня (08.11), серия 1.
    await pipe.handle({ user: u, ...msg("сделал зарядку", "2") });
    const today = (await habitsOfDay(store, u, "2026-11-08"))[0];
    assert.equal(today.status, "done");
    assert.equal(today.streak, 1);

    // Курс на месяц: дни срока, прошедший без отметки — крестик, «нет» — крестик, сегодня и дальше — ждут.
    const c = (await habitsOfDay(store, u, "2026-11-11"))[0].course!;
    assert.equal(c.length, 30);
    assert.deepEqual(c.slice(0, 5).map((x) => x.s), ["done", "miss", "miss", "today", "wait"]);
    await pipe.markHabit(u, h.id, "2026-11-11", "skipped", "telegram");
    assert.equal((await habitsOfDay(store, u, "2026-11-11"))[0].course![3].s, "miss");
    await store.close();
  });

  test(`${kind}: привычку без времени горничная спрашивает вечером один раз, отмеченную — нет`, async () => {
    const { store, u, pipe } = await setup(open, [
      { habits: [{ title: "Аевит", days: "1234567", times: [], duration_days: 30 }], summary: "s" },
    ]);
    await pipe.handle({ user: u, ...msg("пить аевит каждый день месяц", "1") });
    const [h] = await store.activeHabits(u.id);
    const sent: { text: string; buttons?: Button[] }[] = [];
    const sch = new Scheduler(store, null, async (_u, text, _e, buttons) => void sent.push({ text, buttons }));
    await sch.tick(zonedToUtc("2026-11-09", "12:00", TZ));
    assert.equal(sent.filter((s) => s.text.includes("Аевит — сегодня")).length, 0);
    await sch.tick(zonedToUtc("2026-11-09", "20:01", TZ));
    await sch.tick(zonedToUtc("2026-11-09", "20:30", TZ));
    const asks = sent.filter((s) => s.text.includes("Аевит — сегодня сделали?"));
    assert.equal(asks.length, 1);
    assert.deepEqual(asks[0].buttons?.map((b) => b.text), ["✅ Да", "✖ Нет"]);
    await pipe.markHabit(u, h.id, "2026-11-10", "done", "telegram");
    await sch.tick(zonedToUtc("2026-11-10", "20:05", TZ));
    assert.equal(sent.filter((s) => s.text.includes("Аевит — сегодня")).length, 1);
    await store.close();
  });

  test(`${kind}: деньги и новый показатель из текста, отмена убирает их`, async () => {
    const { store, u, pipe } = await setup(open, [{
      money: [
        { kind: "expense", amount: 450, currency: "RUB", category: "кафе", note: "кофе" },
        { kind: "income", amount: 300, currency: "USD", category: "заказ", note: "иллюстрация" },
      ],
      metrics: [{ key: "coffee_cups", label: "Кофе", value: 3, unit: "чашки" }, { key: "weight", value: 85.3 }],
      summary: "s",
    }]);
    const r = await pipe.handle({ user: u, ...msg("кофе 450 р, 3 чашки за день, вес 85.3, пришло 300$ за иллюстрацию", "1") });
    const money = await store.moneyRange(u.id, "2026-11-08", "2026-11-08");
    assert.deepEqual(money.map((m) => [m.kind, m.amount, m.currency]), [["expense", 450, "RUB"], ["income", 300, "USD"]]);
    const keys = (await store.metricKeys(u.id)).map((k) => k.key).sort();
    assert.deepEqual(keys, ["coffee_cups", "weight"]);
    const w = await store.metricsRange(u.id, "2026-11-08", "2026-11-08", "weight");
    assert.equal(w[0].label, "Вес");
    assert.equal(w[0].unit, "кг");
    await pipe.undo(u, r.messageId);
    assert.equal((await store.moneyRange(u.id, "2026-11-08", "2026-11-08")).length, 0);
    assert.equal((await store.metricsRange(u.id, "2026-11-08", "2026-11-08")).length, 0);
    await store.close();
  });

  test(`${kind}: вход по паролю, шаги с айфона, поиск по здоровью, отметка привычки из приложения`, async () => {
    const { store, u, pipe } = await setup(open);
    await store.updateUser(u.id, { login: "owner", password_hash: await hashPassword("secret-pass-1") });
    await store.addDiary(u.id, "2026-11-01", "health", "Болела голова после экрана", null, "head");
    await store.addDiary(u.id, "2026-11-02", "health", "Пломба в зубе", null, "teeth");
    await store.addDiary(u.id, "2026-11-03", "notes", "голова свежая", null);
    const hid = await store.addHabit({
      user_id: u.id, title: "Витамины", days: "1234567", times: "[]", start_date: "2026-11-01", end_date: null, message_id: null,
    });

    const server = createApi({ store, pipeline: pipe }).listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = async (path: string, body?: unknown, token?: string) => {
      const r = await fetch(base + path, {
        method: body ? "POST" : "GET",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: r.status, json: (await r.json()) as any };
    };
    try {
      assert.equal((await call("/api/today")).status, 401);
      assert.equal((await call("/api/login", { login: "owner", password: "wrong" })).status, 401);
      const { json: { token } } = await call("/api/login", { login: "Owner", password: "secret-pass-1", label: "test" });
      assert.ok(token);
      assert.equal((await call("/api/me", undefined, token)).json.login, "owner");
      assert.equal((await call("/api/me", undefined, token)).json.password_hash, undefined);

      await call("/api/steps", { steps: 4200, day: "2026-11-05" }, token);
      await call("/api/steps", { steps: 6100, day: "2026-11-05" }, token); // повтор за день заменяет
      const steps = (await call("/api/metrics?from=2026-11-05&to=2026-11-05&key=steps", undefined, token)).json.rows;
      assert.deepEqual(steps.map((s: any) => [s.value, s.source]), [[6100, "iphone"]]);

      const head = (await call("/api/diary?section=health&topic=head", undefined, token)).json;
      assert.deepEqual(head.map((d: any) => d.text), ["Болела голова после экрана"]);
      const found = await searchDiary(store, u, { text: "ГОЛОВА" });
      assert.equal(found.length, 2);
      const topics = (await call("/api/health/topics", undefined, token)).json;
      assert.deepEqual(topics.map((t: any) => t.name).sort(), ["Голова", "Зубы"]);

      const day = "2026-11-06";
      assert.equal((await call(`/api/habits/${hid}/mark`, { status: "done", day }, token)).status, 200);
      const month = (await call("/api/habits?month=2026-11", undefined, token)).json;
      assert.ok(JSON.stringify(month.habits).includes(day));
      assert.equal((await habitsOfDay(store, u, day))[0].status, "done");

      // Статистика и даты для приложения.
      await store.upsertActivity({ user_id: u.id, day_key: "2026-11-02", source: "aw", active_sec: 3600, afk_sec: 0, apps: [{ name: "chrome.exe", sec: 3600 }], games: [] });
      const act = (await call("/api/activity?from=2026-11-01&to=2026-11-03", undefined, token)).json;
      assert.deepEqual(act.map((a: any) => [a.day_key, a.active_sec]), [["2026-11-02", 3600]]);
      await store.addDate({ user_id: u.id, title: "ДР Васи", date_iso: "1990-03-15", type: "birthday", person: "Вася", notes: "", yearly: 1, message_id: null });
      assert.equal((await call("/api/dates?all=1", undefined, token)).json.length, 1);

      // Веб-приложение: любой день, список дней, удаление записи.
      const d1 = (await call("/api/day?day=2026-11-01", undefined, token)).json;
      assert.deepEqual(d1.diary.map((r: any) => r.text), ["Болела голова после экрана"]);
      assert.equal((await call("/api/day?day=2026-13-01", undefined, token)).status, 400);
      const days = (await call("/api/diary/days", undefined, token)).json;
      assert.deepEqual(days, [{ day: "2026-11-01", n: 1 }, { day: "2026-11-02", n: 1 }, { day: "2026-11-03", n: 1 }]);
      const del = await fetch(`${base}/api/diary/${d1.diary[0].id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
      assert.equal(del.status, 200);
      assert.equal((await call("/api/day?day=2026-11-01", undefined, token)).json.diary.length, 0);
      assert.equal((await fetch(`${base}/api/diary/999999`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } })).status, 404);

      await call("/api/logout", {}, token);
      assert.equal((await call("/api/today", undefined, token)).status, 401);
    } finally {
      server.close();
      await store.close();
    }
  });

  test(`${kind}: импорт Excel — обе разметки, другие листы, повторный запуск ничего не дублирует`, async () => {
    const { store, u } = await setup(open);
    const wb = sampleWorkbook();
    const r1 = await importWorkbook(store, u, wb);
    assert.equal(r1.days, 2);
    assert.deepEqual(r1.byMonth, { Январь: 1, Май: 1 });
    assert.equal(r1.events, 1);
    assert.equal(r1.tasks, 2);
    assert.equal(r1.dates, 1);
    assert.equal(r1.money, 2);

    // Старая разметка: оценки, шаги, часы сна, игры.
    const jan = await store.metricsRange(u.id, "2026-01-08", "2026-01-08");
    const val = (rows: typeof jan, k: string) => rows.find((m) => m.key === k)?.value;
    assert.equal(val(jan, "sleep_hours"), 8);
    assert.equal(val(jan, "rating_day"), 5);
    assert.equal(val(jan, "steps"), 500);
    assert.equal((await store.activityOf(u.id, "2026-01-08"))[0].games[0].sec, 6 * 3600);
    assert.ok((await store.diaryOf(u.id, "2026-01-08")).some((d) => d.section === "notes" && d.text.includes("ветеринарку")));

    // Новая разметка: ПК, игры, шаги и вес из «Здоровья», сон, спорт.
    const may = await store.metricsRange(u.id, "2026-05-19", "2026-05-19");
    assert.equal(val(may, "steps"), 2407);
    assert.equal(val(may, "weight"), 85.3);
    assert.equal(val(may, "sleep_hours"), 6);
    assert.equal(val(may, "sport_min"), 30);
    const act = (await store.activityOf(u.id, "2026-05-19"))[0];
    assert.equal(act.active_sec, 9 * 3600 + 37 * 60);
    assert.equal(act.apps[0].name, "chrome.exe");
    assert.deepEqual(act.games.map((g) => g.name), ["Hearthstone", "Counter-Strike 2"]);
    const health = (await store.diaryOf(u.id, "2026-05-19")).filter((d) => d.section === "health");
    assert.deepEqual(health.map((d) => d.text), ["Болел живот."]);

    const goals = (await store.activeMemory(u.id)).filter((m) => m.kind === "goal");
    assert.equal(goals.length, 1);
    assert.equal(goals[0].subject, "План на январь 2026");
    const tasks = await store.allTasks(u.id);
    assert.deepEqual(tasks.map((t) => t.status).sort(), ["done", "open"]);
    const money = await store.moneyRange(u.id, "2026-03-01", "2026-03-31");
    assert.deepEqual(money.map((m) => [m.amount, m.currency]), [[3402, "USD"], [264106, "RUB"]]);

    const r2 = await importWorkbook(store, u, sampleWorkbook());
    assert.equal(r2.days + r2.events + r2.tasks + r2.dates + r2.money + r2.memory + r2.diary + r2.metrics, 0);
    assert.ok(r2.skipped > 0);
    assert.equal((await store.metricsRange(u.id, "2026-01-01", "2026-12-31")).length, r1.metrics);
    await store.close();
  });
}

test("разбор текста ПК и игр из старого трекера", () => {
  const pc = parsePc("Активность ПК: 6 ч 4 мин активно, 8 ч 22 мин AFK.\n\nПриложения:\nchrome.exe : 2 ч 6 мин\nFigma.exe : 50 мин");
  assert.deepEqual(pc, { active: 6 * 3600 + 4 * 60, afk: 8 * 3600 + 22 * 60, apps: [{ name: "chrome.exe", sec: 7560 }, { name: "Figma.exe", sec: 3000 }] });
  assert.deepEqual(parseGames("Общее время: 2 ч 6 мин\nHearthstone - 2 ч 6 мин"), [{ name: "Hearthstone", sec: 7560 }]);
  assert.equal(parsePc("Лег в 3\nПроснулся в 12"), null);
});

function sampleWorkbook(): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  const main = wb.addWorksheet("2026");
  main.addRow(["Дата", "День", "ISO-неделя", "Месяц", "План месяца (глобальный)", "Заметки", "Теги", "Хобби", "Сон ",
    "Компьютерная активность", "Игры (часы)", "Спорт", "Еда", "Здоровье", "Саммари дня AI"]);
  const d = (s: string) => new Date(`${s}T00:00:00Z`);
  const old: unknown[] = [d("2026-01-08"), "Чт", 2, "Январь", "1. Выучить термины\n2. Комиксы", "Отвозил кота в ветеринарку."];
  old[8] = "Смотрел уроки";
  old[10] = 8;
  old[11] = 6;
  Object.assign(old, { 14: 4, 15: 8, 16: 5, 17: 5, 18: 7, 19: 500, 20: "Апатия" });
  main.addRow(old);
  main.addRow([d("2026-01-09"), "Пт", 2, "Январь", "1. Выучить термины\n2. Комиксы"]); // пустой день, тот же план
  main.addRow([
    d("2026-05-19"), "Вт", 21, "Май", null, "Сходил на ТО.", "баня, еда", null, "6 ч, плохо спал",
    "Активность ПК: 9 ч 37 мин активно, 13 ч 58 мин AFK.\n\nПриложения:\nchrome.exe : 2 ч 47 мин\nFigma.exe : 1 ч 47 мин",
    "Общее время: 37 мин\nHearthstone - 22 мин\nCounter-Strike 2 - 15 мин",
    "30 мин, бег", "Котлеты", "Болел живот. Шаги: 2407. Вес 85.3", "[23:30] Хороший день",
  ]);

  const plans = wb.addWorksheet("Планы");
  plans.addRow(["ID", "Дата", "Время", "Событие", "Детали", "Исходный текст", "Напомнить за день", "Напомнить в день", "Статус", "Создано"]);
  plans.addRow(["p1", d("2026-05-19"), new Date("1899-12-30T10:00:00Z"), "Автомастер", "ТО машины", "19 мая 10.00 автомастер", "yes", "yes", "active", d("2026-05-02")]);

  const tasks = wb.addWorksheet("Задачи");
  tasks.addRow(["ID", "Задача", "Категория", "Приоритет", "Срок", "Заметки", "Исходный текст", "Статус", "Создано", "Завершено"]);
  tasks.addRow(["t1", "Помыть окна", "дом", "normal", null, null, "Помыть окна", "done", d("2026-05-05"), d("2026-05-05")]);
  tasks.addRow(["t2", "Научиться спорить", "другое", "normal", null, null, "Научиться спорить", "active", d("2026-05-16"), null]);

  const dates = wb.addWorksheet("Даты");
  dates.addRow(["ID", "Дата", "Название", "Тип", "Кого касается", "Заметки", "Повторять каждый год", "Статус", "Создано"]);
  dates.addRow(["d1", d("2026-12-18"), "День рождения мамы", "birthday", "Мама", null, "yes", "active", d("2026-05-02")]);

  const inc = wb.addWorksheet("Доходы");
  inc.addRow(["Месяц", "Доллар", "Руб", null, "Дата"]);
  inc.addRow(["Январь", null, null, null, "Должники", "Даник", "1к"]);
  inc.addRow(["Март", 3402, 264106]);
  return wb;
}

test("сервер отдаёт собранное веб-приложение: файл по пути, иначе index.html; наружу из папки не выйти", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maid-web-"));
  fs.mkdirSync(path.join(dir, "assets"));
  fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>Горничная</title>");
  fs.writeFileSync(path.join(dir, "assets", "app-abc.js"), "console.log(1)");
  const store = await Store.open(":memory:");
  const pipe = new Pipeline(store, async () => "{}");
  const server = createApi({ store, pipeline: pipe, webDir: dir }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await index.text(), /Горничная/);
    const deep = await fetch(`${base}/diary/2026-11-01`);
    assert.equal(deep.status, 200);
    assert.match(await deep.text(), /Горничная/);
    const js = await fetch(`${base}/assets/app-abc.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get("cache-control") ?? "", /immutable/);
    assert.equal((await fetch(`${base}/assets/missing.js`)).status, 404);
    assert.equal((await fetch(`${base}/api/nothing`)).status, 401); // API — только со входом
    assert.equal((await fetch(`${base}/..%2F..%2Fpackage.json`)).status, 404); // не выше папки
  } finally {
    server.close();
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
