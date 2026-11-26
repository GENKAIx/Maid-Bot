import { PGlite } from "@electric-sql/pglite";
import assert from "node:assert/strict";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Alerts } from "../src/alerts.ts";
import { createApi } from "../src/api.ts";
import { hashPassword, resetSeen } from "../src/auth.ts";
import { config } from "../src/config.ts";
import { acceptCrashes, adminCrashes, CRASH_BATCH_MS, CRASH_DAY_KEYS, CRASH_MAX_COUNT, CRASH_MAX_ITEMS, crashItem, DESKTOP_DAY_VERSIONS, noteDesktopDay, resetCrashes, versionOk } from "../src/crashes.ts";
import { Store } from "../src/db.ts";
import { PgDriver } from "../src/driver.ts";
import { Pipeline } from "../src/pipeline.ts";
import {
  autoPause, changeRelease, crashRatio, readRelease, RELEASE_CRASH_DAYS, RELEASE_CRASH_MIN_PREV, RELEASE_KEY, releaseDone, releaseFor, servedPercent, servedYml, withStaging,
  ymlStaging, ymlVersion,
} from "../src/releases.ts";
import { addDays, dayKey } from "../src/time.ts";

// Этап 5 «Тарифы и управление»: падения программы на ПК (crashes.ts) и поэтапный выпуск (releases.ts, правило release_crash в alerts.ts).

const TZ = "Europe/Moscow";
const NOW = new Date("2026-11-24T12:00:00Z");
const DAY = dayKey(NOW, TZ);
const item = (o: Record<string, unknown> = {}) => ({ version: "0.1.93", process: "widget", kind: "TypeError", place: "renderer/widget.js:12:5", fp: "0123456789ab", count: 1, ...o });

test("падения: белый список полей — сообщение и пути ПК не проходят, счёт срезается", () => {
  const ok = crashItem({ ...item(), message: "Cannot read 'Аня'", stack: "C:\\Users\\Аня\\x.js" });
  assert.deepEqual(ok, { version: "0.1.93", process: "widget", kind: "TypeError", place: "renderer/widget.js:12:5", fingerprint: "0123456789ab", count: 1 });
  assert.ok(!JSON.stringify(ok).includes("Аня"), "лишние поля не берутся");
  assert.equal(crashItem(item({ count: 99_999 }))!.count, CRASH_MAX_COUNT);
  assert.equal(crashItem(item({ place: "-", fp: "" }))!.place, "-");
  assert.equal(crashItem(item({ place: "src/main.js:1190:3", process: "main" }))!.place, "src/main.js:1190:3");
  for (const bad of [
    { place: "C:/Users/Аня/AppData/app.asar/renderer/widget.js:1:1" }, { place: "/home/anya/renderer/widget.js:1:1" },
    { place: "renderer/../../secret.js:1:1" }, { place: "renderer/widget.js" }, { place: "node_modules/x/y.js:1:1" },
    { process: "browser" }, { kind: "Type Error: Аня" }, { kind: "" }, { version: "1.2" }, { fp: "Cannot read" }, { count: 0 }, { count: "x" },
  ]) assert.equal(crashItem(item(bad)), null, JSON.stringify(bad));
  assert.equal(crashItem("TypeError"), null);
  assert.equal(crashItem([item()]), null);
});

test("падения: пачки склеиваются по дню, версии и месту; люди — разные, один человек за день — один раз; чаще минуты — 429", async () => {
  resetCrashes();
  const store = await Store.open(":memory:");
  try {
    const t = NOW.getTime();
    const a = { id: 1, tz: TZ }, b = { id: 2, tz: TZ };
    assert.deepEqual(await acceptCrashes(store, a, [item({ count: 2 }), item({ count: 3 }), item({ kind: "RangeError" }), { message: "x" }], t), { ok: true, accepted: 3, dropped: 1 });
    const busy = await acceptCrashes(store, a, [item()], t + 1000);
    assert.equal(busy.ok, false);
    assert.equal(!busy.ok && busy.wait, Math.ceil((CRASH_BATCH_MS - 1000) / 1000));
    await acceptCrashes(store, a, [item()], t + CRASH_BATCH_MS); // тот же человек снова — раз прибавились, людей нет
    await acceptCrashes(store, b, [item({ count: 4 })], t);
    await acceptCrashes(store, b, [item({ version: "0.1.92", place: "src/main.js:5:1", process: "main", kind: "Error" })], t + CRASH_BATCH_MS);
    const rows = await store.crashPlaces(DAY);
    const top = rows.find((r) => r.kind === "TypeError" && r.version === "0.1.93")!;
    assert.equal(top.count, 2 + 3 + 1 + 4);
    assert.equal(top.users, 2, "двое разных людей");
    assert.equal(rows.find((r) => r.kind === "RangeError")!.users, 1);
    const vers = await store.crashVersions(DAY);
    assert.deepEqual(vers.find((v) => v.version === "0.1.93"), { version: "0.1.93", active: 2, crashed: 2, crashes: 2 + 3 + 1 + 1 + 4 });
    assert.ok(await acceptCrashes(store, { id: 3, tz: TZ }, Array.from({ length: CRASH_MAX_ITEMS }, () => item()), t), "до CRASH_MAX_ITEMS — берётся");
  } finally {
    resetCrashes();
    await store.close();
  }
});

/** Дни программы: n людей с версией, из них crashed — с падением (id с from). */
async function people(store: Store, version: string, n: number, crashed: number, from: number, day = DAY) {
  for (let i = 0; i < n; i++) await store.markDesktopDay(from + i, day, version, i < crashed ? 1 : 0);
}

test("«Падения»: доля людей по версии (люди этой версии), сравнение с прошлой, топ мест, новое в версии, график по дням", async () => {
  resetCrashes();
  const store = await Store.open(":memory:");
  try {
    await people(store, "0.1.92", 20, 1, 100);
    await people(store, "0.1.93", 10, 3, 200);
    await people(store, "0.1.10", 5, 0, 300); // 0.1.10 старше 0.1.92 — по номерам, а не строкой
    await store.addCrashEvents([
      { day_key: DAY, version: "0.1.92", process: "main", kind: "Error", place: "src/main.js:5:1", fingerprint: "", count: 1, users: 1 },
      { day_key: DAY, version: "0.1.93", process: "main", kind: "Error", place: "src/main.js:5:1", fingerprint: "", count: 2, users: 1 },
      { day_key: DAY, version: "0.1.93", process: "widget", kind: "TypeError", place: "renderer/habitparty.js:212:7", fingerprint: "aaaaaaaaaaaa", count: 9, users: 3 },
    ]);
    const r = await adminCrashes(store, 30, NOW);
    assert.deepEqual(r.versions.map((v) => v.version), ["0.1.93", "0.1.92", "0.1.10"]);
    const v93 = r.versions[0];
    assert.equal(v93.share, 0.3);
    assert.deepEqual(v93.prev, { version: "0.1.92", active: 20, crashed: 1, share: 0.05 });
    assert.equal(v93.top[0].place, "renderer/habitparty.js:212:7");
    assert.equal(v93.top[0].fresh, true, "впервые — в этой версии");
    assert.equal(v93.top[1].fresh, false, "было и в прошлой");
    assert.equal(r.series.length, 30);
    assert.deepEqual(r.series.at(-1), { day: DAY, active: 35, crashed: 4, crashes: 4 });
    assert.equal(r.versions.at(-1)!.prev, null);
    // Хранение — 90 дней.
    await store.markDesktopDay(9, "2026-08-01", "0.1.50", 1);
    await store.pruneStats(NOW);
    assert.ok(!(await store.crashVersions("2000-01-01")).some((v) => v.version === "0.1.50"));
  } finally {
    await store.close();
  }
});

test("падения и дни программы — на Postgres (PGlite) те же числа", async () => {
  const pg = new PGlite();
  const store = await Store.over(new PgDriver(pg, (fn) => pg.transaction((tx) => fn(tx)), () => pg.close()));
  try {
    resetCrashes();
    await people(store, "0.1.93", 4, 2, 1);
    await store.markDesktopDay(1, DAY, "0.1.93", 2);
    await acceptCrashes(store, { id: 1, tz: TZ }, [item({ count: 5 })], NOW.getTime());
    assert.deepEqual(await store.crashVersions(DAY), [{ version: "0.1.93", active: 4, crashed: 2, crashes: 1 + 2 + 1 + 5 }]);
    assert.deepEqual((await store.crashPlaces(DAY)).map((p) => [p.place, p.count, p.users]), [["renderer/widget.js:12:5", 5, 1]]);
    assert.equal((await store.crashDays(DAY))[0].crashed, 2);
    await store.pruneStats(NOW);
  } finally {
    resetCrashes();
    await store.close();
  }
});

const YML = "version: 0.1.93\nfiles:\n  - url: Gornichnaya-Setup-0.1.93.exe\npath: Gornichnaya-Setup-0.1.93.exe\nreleaseDate: '2026-11-24T10:00:00.000Z'\n";
const Y94 = YML.replace(/0\.1\.93/g, "0.1.94");

test("выпуск: stagingPercentage в latest.yml — разбор и подстановка (с настройкой, без, пауза, 100%)", async () => {
  assert.equal(ymlVersion(YML), "0.1.93");
  assert.equal(ymlVersion("version: '0.1.93'\n"), "0.1.93");
  assert.equal(ymlVersion("version: latest\n"), null);
  assert.equal(ymlStaging(YML), null);
  assert.equal(ymlStaging(YML + "stagingPercentage: 50\n"), 50);
  assert.equal(ymlStaging("stagingPercentage: 150\n"), null);
  assert.equal(withStaging(YML + "stagingPercentage: 50\n", 20), YML + "stagingPercentage: 20\n");
  assert.equal(withStaging(YML + "stagingPercentage: 50\n", null), YML);
  assert.equal(withStaging("version: 0.1.93", 0), "version: 0.1.93\nstagingPercentage: 0\n");
  assert.equal(servedPercent(null), null);
  const base = { version: "0.1.93", percent: 20, paused: false, started_at: "", prev: "0.1.92", auto_paused_at: null, updated_at: "", by: 0 };
  assert.equal(servedPercent(base), 20);
  assert.equal(servedPercent({ ...base, paused: true }), 0, "пауза — 0: electron-updater не даёт обновления никому");
  assert.equal(servedPercent({ ...base, percent: 100 }), null, "100% — без строки");

  const store = await Store.open(":memory:");
  try {
    // Первая версия без настройки — уже выпущена (100%, без строки), иначе выкладка сервера закрыла бы обновление.
    assert.equal(await servedYml(store, YML.replace(/0\.1\.93/g, "0.1.92"), NOW), YML.replace(/0\.1\.93/g, "0.1.92"));
    assert.equal((await readRelease(store))!.percent, 100);
    // Новая версия — с процента из файла (tools/release-desktop.py --percent=20); без строки — сразу всем (тест ниже).
    assert.equal(await servedYml(store, YML + "stagingPercentage: 20\n", NOW), YML + "stagingPercentage: 20\n");
    const r = (await readRelease(store))!;
    assert.deepEqual([r.version, r.percent, r.paused, r.prev], ["0.1.93", 20, false, "0.1.92"]);
    assert.equal(await servedYml(store, YML + "stagingPercentage: 70\n", NOW), YML + "stagingPercentage: 20\n", "та же версия — процент из настройки, не из файла");
    await changeRelease(store, 1, { version: "0.1.93", paused: true, reason: "смотрю падения" }, NOW);
    assert.equal(await servedYml(store, YML, NOW), YML + "stagingPercentage: 0\n");
    await changeRelease(store, 1, { version: "0.1.93", paused: false, percent: 100, reason: "всё спокойно" }, NOW);
    assert.equal(await servedYml(store, YML, NOW), YML);
    const v94 = YML.replace(/0\.1\.93/g, "0.1.94") + "stagingPercentage: 50\n";
    assert.equal(await servedYml(store, v94, NOW), v94);
    assert.equal((await readRelease(store))!.prev, "0.1.93");
    const log = await store.adminLog(20);
    assert.equal(log.filter((x) => x.action === "release_start").length, 3, "начало выпуска — в журнал, раз на версию");
    assert.ok(log.some((x) => x.action === "release_pause" && x.reason === "смотрю падения"));
    assert.ok(log.some((x) => x.action === "release_resume" && x.detail.includes("20% → 100%")));
  } finally {
    await store.close();
  }
});

test("выпуск: изменение — причина, процент 1…100, версия должна совпасть", async () => {
  const store = await Store.open(":memory:");
  try {
    await assert.rejects(changeRelease(store, 1, { version: "0.1.93", percent: 50, reason: "так надо" }, NOW), /выпусков ещё не было/);
    await releaseFor(store, YML.replace(/0\.1\.93/g, "0.1.92"), NOW);
    await releaseFor(store, YML, NOW);
    const bad = async (body: Record<string, unknown>, re: RegExp) => assert.rejects(changeRelease(store, 1, { version: "0.1.93", reason: "проверка", ...body }, NOW), re);
    await bad({ reason: "" }, /причину/);
    await bad({ percent: 0 }, /от 1 до 100/);
    await bad({ percent: 101 }, /от 1 до 100/);
    await bad({ percent: 20.5 }, /от 1 до 100/);
    await bad({ paused: "да" }, /да или нет/);
    await bad({ percent: 100 }, /ничего не изменилось/);
    await bad({ version: "0.1.92", percent: 50 }, /сейчас выпускается 0\.1\.93/);
    const r = await changeRelease(store, 1, { version: "0.1.93", percent: 50, reason: "падений нет" }, NOW);
    assert.equal(r.percent, 50);
    assert.equal((await store.adminLog(1))[0].action, "release_percent");
  } finally {
    await store.close();
  }
});

test("автопауза: падений на новой версии в 2 раза больше и не меньше 3 человек — пауза, письмо владельцу, раз на версию", async () => {
  const store = await Store.open(":memory:");
  try {
    const sent: string[] = [];
    const a = new Alerts(store, { notify: async (t) => (sent.push(t), 1), publicUrl: "https://maid.test" });
    await store.once("digest:2026-11-24"); // без сводки новичков
    const check = async (min: number) => (await a.check(new Date(NOW.getTime() + min * 60_000), true))!.find((x) => x.id === "release_crash")!;
    assert.equal((await check(0)).value, null, "выпуска нет — нечего мерить");
    // Прошлая — 0.1.93 (первая, что шлёт падения; со старшими сравнивать не с чем), новая — 0.1.94.
    await releaseFor(store, YML, NOW);
    await releaseFor(store, Y94, NOW);
    await people(store, "0.1.93", 20, 1, 100); // 5%
    await people(store, "0.1.94", 10, 2, 200); // 20%, но только 2 человека
    assert.equal((await check(1)).hit, false, "меньше 3 человек — не срабатывает");
    assert.equal((await readRelease(store))!.paused, false);
    await store.markDesktopDay(202, DAY, "0.1.94", 1); // третий — 30%, в 6 раз больше
    const hit = await check(2);
    assert.equal(hit.hit, true);
    assert.equal(hit.sent, "fire");
    const r = (await readRelease(store))!;
    assert.equal(r.paused, true);
    assert.ok(r.auto_paused_at);
    assert.match(sent.at(-1)!, /0\.1\.94 падает чаще: у 30,0% людей \(3 из 10\) против 5,0% на 0\.1\.93/);
    assert.match(sent.at(-1)!, /поставлен на паузу/);
    assert.equal(await servedYml(store, Y94, NOW), Y94 + "stagingPercentage: 0\n");
    const log = (await store.adminLog(5)).find((x) => x.action === "release_autopause")!;
    assert.equal(log.user_id, 0);
    assert.match(log.reason, /30,0%/);
    // Владелец продолжил вручную — автопауза на этой версии больше не встаёт.
    await changeRelease(store, 1, { version: "0.1.94", paused: false, reason: "падение — не наше" }, NOW);
    assert.equal(await autoPause(store, "ещё раз", NOW), false);
    await check(400);
    assert.equal((await readRelease(store))!.paused, false);
    assert.ok(!sent.join("\n").includes("Аня"));
  } finally {
    await store.close();
  }
});

// ——— API: тем же путём, что сайт и программа.
const OWNER = "987654321";
test("API: /api/events/crash, /desktop/latest.yml с процентом, админка «Падения» и «Выпуски» — 404 не админу, 403 без кода, журнал", async () => {
  resetCrashes();
  resetSeen();
  config.allowedChatIds.splice(0, Infinity, OWNER);
  config.adminChatIds.splice(0, Infinity);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maid-crash-"));
  fs.writeFileSync(path.join(dir, "latest.yml"), YML.replace(/0\.1\.93/g, "0.1.92"));
  const store = await Store.open(":memory:");
  await store.createUser({ login: "owner", passwordHash: await hashPassword("owner-pass-1"), tz: TZ, chatId: OWNER, name: "Хозяин" });
  await store.createUser({ login: "anya", passwordHash: await hashPassword("anya-pass-1"), tz: TZ, chatId: "11", name: "Аня" });
  const tg: string[] = [];
  const server = createApi({ store, pipeline: new Pipeline(store, async () => "{}"), desktopDir: dir, adminCode: async (_u, t) => void tg.push(t) }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (token: string, p: string, body?: unknown, client = "web", version = "") => {
    const headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${token}`, "x-maid-client": client };
    if (version) headers["x-maid-version"] = version;
    const r = await fetch(base + p, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> };
  };
  const login = async (l: string, pw: string) => String((await (await fetch(base + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: l, password: pw }) })).json()).token);
  try {
    // latest.yml: первая версия — как на диске; новая с --percent=20 — с 20%; файл на диске не меняется.
    assert.equal(await (await fetch(base + "/desktop/latest.yml")).text(), YML.replace(/0\.1\.93/g, "0.1.92"));
    fs.writeFileSync(path.join(dir, "latest.yml"), YML + "stagingPercentage: 20\n");
    // «Что нового» лежит рядом (tools/release-desktop.py) — сервер берёт его при первом виде версии; наружу файл не отдаётся.
    fs.writeFileSync(path.join(dir, "notes-0.1.93.json"), JSON.stringify({ version: "0.1.93", notes: ["Отчёты о падениях", "Поэтапный выпуск"] }));
    const y = await fetch(base + "/desktop/latest.yml");
    const text = await y.text();
    assert.equal(text, YML + "stagingPercentage: 20\n");
    assert.equal(Number(y.headers.get("content-length")), Buffer.byteLength(text));
    assert.equal(fs.readFileSync(path.join(dir, "latest.yml"), "utf8"), YML + "stagingPercentage: 20\n");
    assert.equal((await fetch(base + "/desktop/notes-0.1.93.json")).status, 404, "заметки наружу не отдаются");

    const anya = await login("anya", "anya-pass-1");
    assert.equal((await call("nope", "/api/events/crash", { items: [item()] }, "widget")).status, 401);
    const ok = await call(anya, "/api/events/crash", { items: [{ ...item(), message: "Аня: секрет" }, { ...item(), place: "C:/Users/Аня/a.js:1:1" }] }, "widget", "0.1.93");
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, { ok: true, accepted: 1, dropped: 1 });
    assert.equal((await call(anya, "/api/events/crash", { items: [item()] }, "widget", "0.1.93")).status, 429);
    assert.equal((await call(anya, "/api/events/crash", { items: Array.from({ length: CRASH_MAX_ITEMS + 1 }, () => item()) }, "widget")).status, 400);
    assert.equal((await call(anya, "/api/events/crash", { items: "много" }, "widget")).status, 400);
    const dump = JSON.stringify(await store.crashPlaces("2000-01-01"));
    assert.ok(!dump.includes("Аня") && !dump.includes("секрет") && !dump.includes("Users"), "в базе нет текста и путей");
    // Виджет с версией в заголовке — день программы этой версии отмечен (база доли).
    assert.equal((await call(anya, "/api/me", undefined, "widget", "0.1.92")).status, 200);
    assert.ok((await store.crashVersions("2000-01-01")).some((v) => v.version === "0.1.92" && v.active === 1 && v.crashed === 0));
    assert.equal((await call(anya, "/api/me", undefined, "web", "0.1.80")).status, 200);
    assert.ok(!(await store.crashVersions("2000-01-01")).some((v) => v.version === "0.1.80"), "сайт — не программа");
    // Версия новее выпущенной (в latest.yml 0.1.93) — день программы не отмечается (api.ts knownDesktopVersion).
    assert.equal((await call(anya, "/api/me", undefined, "widget", "0.1.99")).status, 200);
    assert.ok(!(await store.crashVersions("2000-01-01")).some((v) => v.version === "0.1.99"), "будущей версии нет");

    for (const p of ["/api/admin/crashes", "/api/admin/releases"]) assert.equal((await call(anya, p)).status, 404, p);
    assert.equal((await call(anya, "/api/admin/releases", { version: "0.1.93", paused: true, reason: "хочу" })).status, 404);
    assert.equal((await call(anya, "/api/admin/releases/notes", { version: "0.1.93", notes: ["моё"], reason: "хочу" })).status, 404);
    const owner = await login("owner", "owner-pass-1");
    assert.equal((await call(owner, "/api/admin/crashes")).status, 403, "без кода");
    assert.equal((await call(owner, "/api/admin/releases", { version: "0.1.93", paused: true, reason: "проверка" })).status, 403);
    assert.equal((await call(owner, "/api/admin/releases/notes", { version: "0.1.93", notes: ["x"], reason: "проверка" })).status, 403);
    await call(owner, "/api/admin/code", {});
    assert.equal((await call(owner, "/api/admin/confirm", { code: tg.at(-1)!.match(/\d{6}/)![0] })).status, 200);

    const c = await call(owner, "/api/admin/crashes?days=7");
    assert.equal(c.status, 200);
    assert.equal(c.body.days, 7);
    assert.equal(c.body.versions[0].version, "0.1.93");
    assert.equal(c.body.versions[0].top[0].place, "renderer/widget.js:12:5");
    const v = await call(owner, "/api/admin/releases");
    assert.equal(v.status, 200);
    assert.deepEqual([v.body.release.version, v.body.release.percent, v.body.served, v.body.file_version], ["0.1.93", 20, 20, "0.1.93"]);
    assert.equal(v.body.start_percent, 100, "по умолчанию — сразу всем");
    assert.deepEqual(v.body.notes.map((n: { version: string }) => n.version).slice(0, 2), ["0.1.94", "0.1.93"], "история: новые сверху (0.1.94 — из заготовки)");
    assert.deepEqual(v.body.notes.find((n: { version: string }) => n.version === "0.1.93").notes, ["Отчёты о падениях", "Поэтапный выпуск"], "пункты из файла, не из заготовки");
    assert.equal((await call(owner, "/api/admin/releases/notes", { version: "0.1.93", notes: ["Новое"] })).status, 400, "без причины");
    assert.equal((await call(owner, "/api/admin/releases/notes", { version: "0.1.93", notes: ["<b>жирно</b>"], reason: "проверка" })).status, 400, "без HTML");
    assert.equal((await call(owner, "/api/admin/releases/notes", { version: "0.1.99", notes: ["Новое"], reason: "проверка" })).status, 404);
    const ed = await call(owner, "/api/admin/releases/notes", { version: "0.1.93", notes: "- Отчёты о падениях\n- Поэтапный выпуск\n- Ещё пункт", reason: "дописал" });
    assert.equal(ed.status, 200);
    const e93 = ed.body.notes.find((n: { version: string }) => n.version === "0.1.93");
    assert.deepEqual(e93.notes, ["Отчёты о падениях", "Поэтапный выпуск", "Ещё пункт"]);
    assert.ok(e93.edited_at && Number.isInteger(e93.by) && e93.by > 0);
    assert.equal((await call(owner, "/api/admin/releases", { version: "0.1.93", percent: 50 })).status, 400, "без причины");
    assert.equal((await call(owner, "/api/admin/releases", { version: "0.1.92", percent: 50, reason: "старая страница" })).status, 409);
    const p50 = await call(owner, "/api/admin/releases", { version: "0.1.93", percent: 50, reason: "падений нет" });
    assert.equal(p50.status, 200);
    assert.equal(p50.body.served, 50);
    const pause = await call(owner, "/api/admin/releases", { version: "0.1.93", paused: true, reason: "смотрю отзыв" });
    assert.equal(pause.body.served, 0);
    assert.match(await (await fetch(base + "/desktop/latest.yml")).text(), /stagingPercentage: 0\n$/);
    await call(owner, "/api/admin/releases", { version: "0.1.93", paused: false, reason: "всё хорошо" });

    const log = (await call(owner, "/api/admin/log")).body as unknown as { who: string; action: string; reason: string }[];
    for (const a of ["release_percent", "release_pause", "release_resume", "release_notes"]) {
      const row = log.find((r) => r.action === a);
      assert.ok(row && row.reason.length >= 3 && /^#\d+$/.test(row.who), `${a} — в журнале с причиной и номером`);
    }
    assert.equal(log.find((r) => r.action === "release_start")!.who, "сервер (сам)");
    for (const body of [c.body, v.body, p50.body]) {
      const txt = JSON.stringify(body);
      for (const bad of ["Аня", "anya", "Хозяин", "owner", OWNER, dir]) assert.ok(!txt.includes(bad), `нет «${bad}» в ответе`);
    }
    assert.ok(!JSON.stringify(c.body).includes(RELEASE_KEY));
  } finally {
    server.close();
    resetCrashes();
    resetSeen();
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ——— Исправления этапа 5 (проверка 24.11.2026).
const yml = (v: string, staging?: number) => YML.replace(/0\.1\.93/g, v) + (staging == null ? "" : `stagingPercentage: ${staging}\n`);
const alertsOf = async (store: Store) => {
  const a = new Alerts(store, { notify: async () => 1, publicUrl: "https://maid.test" });
  await store.once("digest:2026-11-24");
  return async (at = NOW) => (await a.check(at, true))!.find((x) => x.id === "release_crash")!;
};

test("автопауза: сравнение с прошлой — только если она шлёт падения и на ней хватает людей; у прошлой 0 падений — не «в бесконечность раз»", async () => {
  assert.deepEqual(crashRatio({ active: 10, crashed: 3 }, null), { x: null, why: "no_prev" });
  assert.deepEqual(crashRatio({ active: 10, crashed: 3 }, { version: "0.1.92", active: 500, crashed: 0 }), { x: null, why: "old_prev" });
  assert.deepEqual(crashRatio({ active: 10, crashed: 3 }, { version: "0.1.93", active: RELEASE_CRASH_MIN_PREV - 1, crashed: 0 }), { x: null, why: "few_prev" });
  assert.deepEqual(crashRatio({ active: 1000, crashed: 3 }, { version: "0.1.93", active: 400, crashed: 0 }), { x: 0.003 / (1 / 400), why: "ok" });
  assert.ok(Math.abs(crashRatio({ active: 10, crashed: 3 }, { version: "0.1.93", active: 20, crashed: 1 }).x! - 6) < 1e-9);

  // (1) Первый выпуск с падениями: прошлая 0.1.92 их не шлёт (у неё 0 из 500) — три человека с падением паузу не ставят.
  let store = await Store.open(":memory:");
  try {
    const check = await alertsOf(store);
    await releaseFor(store, yml("0.1.92"), NOW);
    await releaseFor(store, YML, NOW);
    await people(store, "0.1.92", 500, 0, 1000);
    await people(store, "0.1.93", 300, 3, 2000);
    const c = await check();
    assert.deepEqual([c.value, c.hit], [null, false]);
    assert.equal((await readRelease(store))!.paused, false, "прошлая не шлёт падений — не пауза");
  } finally {
    await store.close();
  }
  // (2) У прошлой 0 падений при большой базе: её доля — не ниже 1/людей. 3 из 1000 против 0 из 400 — в 1,2 раза, не пауза; 30 из 1000 — пауза.
  store = await Store.open(":memory:");
  try {
    const check = await alertsOf(store);
    await releaseFor(store, YML, NOW);
    await releaseFor(store, Y94, NOW);
    await people(store, "0.1.93", 400, 0, 1000);
    await people(store, "0.1.94", 1000, 3, 2000);
    const c = await check();
    assert.deepEqual([c.value, c.hit], [1.2, false]);
    await people(store, "0.1.94", 27, 27, 2003);
    assert.equal((await check(new Date(NOW.getTime() + 60_000))).hit, true);
    assert.equal((await readRelease(store))!.paused, true);
  } finally {
    await store.close();
  }
  // (3) На прошлой за неделю 4 человека без падений — сравнивать не с чем.
  store = await Store.open(":memory:");
  try {
    const check = await alertsOf(store);
    await releaseFor(store, YML, NOW);
    await releaseFor(store, Y94, NOW);
    await people(store, "0.1.93", 4, 0, 1000);
    await people(store, "0.1.94", 800, 3, 2000);
    assert.deepEqual([(await check()).value, (await check()).hit], [null, false]);
    assert.equal((await readRelease(store))!.paused, false);
  } finally {
    await store.close();
  }
});

test("автопауза: выпуск всем (100%) дольше окна — не проверяется; --percent=100 в latest.yml — сразу всем", async () => {
  const store = await Store.open(":memory:");
  try {
    const check = await alertsOf(store);
    const old = new Date(NOW.getTime() - (RELEASE_CRASH_DAYS + 1) * 86_400_000);
    await releaseFor(store, YML, old);
    // tools/release-desktop.py --percent=100 пишет «stagingPercentage: 100» — новая версия сразу всем, а не с 20%.
    const r = (await releaseFor(store, yml("0.1.94", 100), old))!;
    assert.deepEqual([r.percent, r.paused, servedPercent(r)], [100, false, null]);
    assert.equal(await servedYml(store, yml("0.1.94", 100), NOW), Y94, "100% — строка при отдаче убрана");
    assert.equal(releaseDone(r, NOW), true);
    assert.equal(releaseDone(r, new Date(old.getTime() + 86_400_000)), false, "в пределах окна — ещё проверяется");
    assert.equal(releaseDone({ ...r, percent: 50 }, NOW), false);
    await people(store, "0.1.93", 30, 0, 1000);
    await people(store, "0.1.94", 800, 30, 2000); // в 1,5 раза — неважно: выпуск закончен
    await people(store, "0.1.94", 50, 50, 3000);
    const c = await check();
    assert.deepEqual([c.value, c.hit], [null, false]);
    assert.equal((await readRelease(store))!.paused, false);
  } finally {
    await store.close();
  }
});

test("выпуск: прошлый не дошёл до всех (пауза, меньше 100%) — новая сравнивается с той, что была до него", async () => {
  const store = await Store.open(":memory:");
  try {
    await releaseFor(store, YML, NOW); // 0.1.93 — всем
    await releaseFor(store, yml("0.1.94", 20), NOW); // 0.1.94 — 20%, prev 0.1.93
    assert.equal(await autoPause(store, "падения 6% против 1%", NOW), true);
    const r95 = (await releaseFor(store, yml("0.1.95", 20), NOW))!;
    assert.equal(r95.prev, "0.1.93", "0.1.94 стояла на паузе — сравнение с 0.1.93");
    const r96 = (await releaseFor(store, yml("0.1.96", 20), NOW))!;
    assert.equal(r96.prev, "0.1.93", "0.1.95 на 20% — всё ещё с 0.1.93");
    await changeRelease(store, 1, { version: "0.1.96", percent: 100, reason: "всё спокойно" }, NOW);
    assert.equal((await releaseFor(store, yml("0.1.97"), NOW))!.prev, "0.1.96", "0.1.96 дошла до всех — с ней");
  } finally {
    await store.close();
  }
});

test("падения: версия новее выпущенной не принимается; версий за день и новых мест за день — не больше предела", async () => {
  resetCrashes();
  const store = await Store.open(":memory:");
  try {
    const u = { id: 1, tz: TZ };
    const t = NOW.getTime();
    assert.equal(versionOk("0.1.93", "0.1.93"), true);
    assert.equal(versionOk("0.1.10", "0.1.93"), true);
    assert.equal(versionOk("0.1.94", "0.1.93"), false);
    assert.equal(versionOk("999.0.1", null), true, "файла нет — сверять не с чем");
    assert.deepEqual(await acceptCrashes(store, u, [item(), item({ version: "999.0.1" }), item({ version: "0.1.94" })], t, "0.1.93"), { ok: true, accepted: 1, dropped: 2 });
    assert.ok(!(await store.crashVersions("2000-01-01")).some((v) => v.version !== "0.1.93"), "будущих версий в базе нет");
    // Дни программы: будущая версия — нет; версий у человека за день — не больше DESKTOP_DAY_VERSIONS (0.1.93 уже есть от падения).
    await noteDesktopDay(store, u, "0.2.0", NOW, "0.1.93");
    for (const v of ["0.0.1", "0.0.2", "0.0.3", "0.0.4"]) await noteDesktopDay(store, u, v, NOW, "0.1.93");
    const mine = (await store.crashVersions("2000-01-01")).map((x) => x.version).sort(); // в базе пока один человек
    assert.equal(mine.length, DESKTOP_DAY_VERSIONS);
    assert.deepEqual(mine, ["0.0.1", "0.0.2", "0.1.93"]);
    // Новых мест от человека за день — не больше CRASH_DAY_KEYS; уже виденное место считается и сверх предела.
    resetCrashes();
    const u2 = { id: 2, tz: TZ };
    let accepted = 0, n = 0;
    for (let b = 0; b * CRASH_MAX_ITEMS < CRASH_DAY_KEYS + CRASH_MAX_ITEMS; b++) {
      const items = Array.from({ length: CRASH_MAX_ITEMS }, () => item({ place: `src/main.js:1:${++n}` }));
      const r = await acceptCrashes(store, u2, items, t + b * CRASH_BATCH_MS, "0.1.93");
      assert.ok(r.ok);
      accepted += r.accepted;
    }
    assert.equal(accepted, CRASH_DAY_KEYS);
    const again = await acceptCrashes(store, u2, [item({ place: "src/main.js:1:1" }), item({ place: "src/main.js:1:99999" })], t + 99 * CRASH_BATCH_MS, "0.1.93");
    assert.deepEqual(again, { ok: true, accepted: 1, dropped: 1 });
    assert.equal((await store.crashPlaces("2000-01-01")).filter((p) => p.place.startsWith("src/main.js:1:")).length, CRASH_DAY_KEYS);
  } finally {
    resetCrashes();
    await store.close();
  }
});

test("«Падения»: топ мест считается за выбранный срок — старые падения места не раздувают его счёт", async () => {
  const store = await Store.open(":memory:");
  try {
    await people(store, "0.1.93", 10, 5, 100);
    const old = addDays(DAY, -30);
    await store.addCrashEvents([
      { day_key: old, version: "0.1.93", process: "main", kind: "Error", place: "src/main.js:1190:17", fingerprint: "", count: 900, users: 5 },
      { day_key: DAY, version: "0.1.93", process: "main", kind: "Error", place: "src/main.js:1190:17", fingerprint: "", count: 1, users: 1 },
      { day_key: DAY, version: "0.1.93", process: "widget", kind: "TypeError", place: "renderer/widget.js:3:4", fingerprint: "", count: 40, users: 4 },
    ]);
    const week = (await adminCrashes(store, 7, NOW)).versions[0].top;
    assert.deepEqual(week.map((p) => [p.place, p.count, p.users]), [["renderer/widget.js:3:4", 40, 4], ["src/main.js:1190:17", 1, 1]]);
    assert.equal(week[1].first, old, "«впервые» — по всему хранимому");
    const q = (await adminCrashes(store, 90, NOW)).versions[0].top;
    assert.deepEqual(q.map((p) => [p.place, p.count, p.users]), [["src/main.js:1190:17", 901, 6], ["renderer/widget.js:3:4", 40, 4]]);
  } finally {
    await store.close();
  }
});
