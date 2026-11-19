import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApi } from "../src/api.ts";
import { hashPassword } from "../src/auth.ts";
import { Store, type DateRow } from "../src/db.ts";
import { Pipeline } from "../src/pipeline.ts";
import { upcomingDates, yearKnown } from "../src/report.ts";
import { dayKey } from "../src/time.ts";

// Важные даты руками (сайт, вкладка «Даты» в «Планах»), 19.11.2026: раньше их можно было только написать горничной,
// а поправить или удалить — никак. И возраст: дата без года рождения хранится с годом, когда её записали, и в следующем
// году показывалось «· 1». Теперь возраст — только если год известен (раньше года записи).

const TZ = "Europe/Moscow";
const row = (date_iso: string, created_at: string, yearly = 1): DateRow =>
  ({ id: 1, user_id: 1, title: "x", date_iso, type: "birthday", person: "", notes: "", yearly, status: "active", created_at });

test("возраст — только когда год известен", () => {
  const today = "2026-11-19";
  // Записали в 2026 году «3 декабря» без года — модель поставила 2026: возраста нет ни в этом году, ни в следующем.
  assert.equal(yearKnown(row("2026-12-03", "2026-11-10T10:00:00Z")), false);
  assert.equal(upcomingDates([row("2026-12-03", "2026-11-10T10:00:00Z")], today, 400)[0].age, null);
  assert.equal(upcomingDates([row("2026-01-14", "2026-11-10T10:00:00Z")], today, 400)[0].age, null);
  // Год рождения указан — возраст на ближайший день рождения.
  assert.equal(yearKnown(row("1996-12-03", "2026-11-10T10:00:00Z")), true);
  assert.equal(upcomingDates([row("1996-12-03", "2026-11-10T10:00:00Z")], today, 400)[0].age, 30);
  // Записали в прошлом году без года — тоже не известен.
  assert.equal(upcomingDates([row("2025-12-03", "2025-11-10T10:00:00Z")], today, 400)[0].age, null);
});

test("API дат: добавить, поправить, удалить в корзину, вернуть, отменить, чужие", async () => {
  const store = await Store.open(":memory:");
  const u = await store.ensureUser("420", "Тест", TZ);
  const other = await store.ensureUser("421", "Чужой", TZ);
  await store.updateUser(u.id, { login: "owner", password_hash: await hashPassword("secret-pass-1") });
  const alien = await store.addDate({ user_id: other.id, title: "Чужой ДР", date_iso: "1990-05-01", type: "birthday", person: "", notes: "", yearly: 1, message_id: null });
  const pipeline = new Pipeline(store, async () => "{}");
  const server = createApi({ store, pipeline }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const today = dayKey(new Date(), TZ);
  const year = Number(today.slice(0, 4));
  try {
    const login = await (await fetch(base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ login: "owner", password: "secret-pass-1" }) })).json() as { token: string };
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.token}` }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };
    const list = async () => (await call("GET", "/api/dates?all=1")).body as unknown as Record<string, any>[];

    // Без года: год — текущий (как у дат, записанных словами), возраста нет.
    const mom = (await call("POST", "/api/dates", { title: "  ДР мамы ", month: 12, day: 18, year: null, type: "birthday", yearly: true })).body;
    assert.deepEqual([mom.title, mom.date_iso, mom.type, mom.yearly, mom.year_known], ["ДР мамы", `${year}-12-18`, "birthday", 1, false]);
    assert.ok(mom.undo, "добавление отменяется");
    // С годом — возраст.
    const ivan = (await call("POST", "/api/dates", { title: "ДР Ивана", month: 1, day: 14, year: 1990, type: "birthday", yearly: true })).body;
    assert.equal(ivan.date_iso, "1990-01-14");
    const ivanRow = (await list()).find((d) => d.id === ivan.id)!;
    assert.equal(ivanRow.year_known, true);
    assert.equal(ivanRow.age, Number(ivanRow.on.slice(0, 4)) - 1990);
    // 29 февраля без года — ближайший високосный, день не теряется.
    const leap = (await call("POST", "/api/dates", { title: "Високосный", month: 2, day: 29, year: null, type: "other", yearly: true })).body;
    assert.match(leap.date_iso, /^\d{4}-02-29$/);
    assert.ok(Number(leap.date_iso.slice(0, 4)) >= year);
    // Неверный день и пустое название — 400.
    assert.equal((await call("POST", "/api/dates", { title: "x", month: 2, day: 30, year: null, type: "other", yearly: true })).status, 400);
    assert.equal((await call("POST", "/api/dates", { title: "x", month: 13, day: 1, year: null, type: "other", yearly: true })).status, 400);
    assert.equal((await call("POST", "/api/dates", { title: " ", month: 1, day: 1, year: null, type: "other", yearly: true })).status, 400);

    // Отмена добавления — даты нет.
    await pipeline.undo(u, leap.undo);
    assert.equal((await store.date(leap.id))!.status, "deleted");

    // Правка: название, день, вид; без года у даты без года — год остаётся «неизвестным».
    const fixed = (await call("POST", `/api/dates/${mom.id}`, { title: "День рождения мамы", month: 12, day: 19, year: null, type: "birthday" })).body;
    assert.deepEqual([fixed.title, fixed.date_iso, fixed.year_known], ["День рождения мамы", `${year}-12-19`, false]);
    // Отмена правки — как было.
    await pipeline.undo(u, fixed.undo);
    assert.deepEqual([(await store.date(mom.id))!.title, (await store.date(mom.id))!.date_iso], ["ДР мамы", `${year}-12-18`]);
    // Указали год — возраст появился.
    assert.equal((await call("POST", `/api/dates/${mom.id}`, { month: 12, day: 18, year: 1965 })).body.year_known, true);

    // Удалить — в корзину; из списка пропала; вернуть — снова в списке.
    await call("POST", `/api/dates/${ivan.id}`, { status: "deleted" });
    assert.ok(!(await list()).some((d) => d.id === ivan.id));
    // В корзине и «Високосный» — его добавление отменили, как отменённая задача.
    assert.deepEqual((await call("GET", "/api/trash")).body.dates.map((d: any) => d.title).sort(), ["Високосный", "ДР Ивана"]);
    await call("POST", `/api/dates/${ivan.id}`, { status: "active" });
    assert.ok((await list()).some((d) => d.id === ivan.id));
    assert.deepEqual((await call("GET", "/api/trash")).body.dates.map((d: any) => d.title), ["Високосный"]);
    // Удалённая словами (как раньше: setDateStatus) — тоже в корзине.
    await store.setDateStatus(ivan.id, "deleted");
    assert.equal((await call("GET", "/api/trash")).body.dates.length, 2);
    // Удалить навсегда.
    assert.deepEqual((await call("POST", "/api/trash/purge", { dates: [ivan.id, alien] })).body, { tasks: 0, events: 0, notes: 0, dates: 1 });
    assert.deepEqual((await call("GET", "/api/trash")).body.dates.map((d: any) => d.title), ["Високосный"]);
    assert.equal((await call("POST", `/api/dates/${ivan.id}`, { status: "active" })).status, 404);

    // Чужие не трогаются; пустая правка — 400.
    assert.equal((await call("POST", `/api/dates/${alien}`, { status: "deleted" })).status, 404);
    assert.equal((await store.date(alien))!.status, "active");
    assert.equal((await call("POST", `/api/dates/${mom.id}`, {})).status, 400);
  } finally {
    server.close();
    await store.close();
  }
});
