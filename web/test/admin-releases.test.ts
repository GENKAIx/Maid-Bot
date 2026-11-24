import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ADMIN_ACTIONS, ADMIN_SECTIONS, adminSection, CRASH_PROCESS_NAMES, crashCompare, percentError, releaseState,
  type CrashesData, type ReleasesData,
} from "../src/admin.ts";
import { CrashesPage, ReleasesPage } from "../src/screens/AdminReleases.tsx";

// Этап 5 «Тарифы и управление»: разделы «Выпуски» и «Падения» в «Системе», подписи журнала, фразы и рендер по готовым данным.

test("админка, этап 5: «Выпуски» и «Падения» — в «Системе», подписи действий журнала", () => {
  for (const id of ["releases", "crashes"] as const) {
    assert.equal(adminSection(id), id);
    assert.equal(ADMIN_SECTIONS.find((s) => s.id === id)!.group, "Система");
  }
  for (const a of ["release_start", "release_percent", "release_pause", "release_resume", "release_autopause"]) assert.ok(ADMIN_ACTIONS[a], a);
  for (const p of ["main", "widget", "quick", "window", "gpu", "utility", "child"]) assert.ok(CRASH_PROCESS_NAMES[p], p);
});

test("выпуски и падения: состояние выпуска, сравнение с прошлой версией, проверка процента", () => {
  assert.equal(releaseState(null).tone, "mute");
  assert.deepEqual(releaseState({ paused: true, percent: 20, auto_paused_at: "2026-11-24T10:00:00Z" }), { text: "на паузе — сработала автопауза", tone: "bad" });
  assert.equal(releaseState({ paused: true, percent: 20, auto_paused_at: null }).text, "на паузе");
  assert.equal(releaseState({ paused: false, percent: 100, auto_paused_at: null }).text, "всем");
  assert.equal(releaseState({ paused: false, percent: 20, auto_paused_at: null }).text, "идёт: 20% людей");
  assert.equal(crashCompare({ share: 0.3, active: 10 }, { share: 0.05, active: 20 }).text, "в 6,0 раза чаще прошлой");
  assert.equal(crashCompare({ share: 0.3, active: 10 }, { share: 0.05, active: 20 }).tone, "bad");
  assert.equal(crashCompare({ share: 0.07, active: 10 }, { share: 0.05, active: 20 }).tone, "warn");
  assert.equal(crashCompare({ share: 0.01, active: 10 }, { share: 0.05, active: 20 }).text, "реже прошлой");
  assert.equal(crashCompare({ share: 0.05, active: 10 }, null).tone, "mute");
  assert.equal(crashCompare({ share: 0.05, active: 10 }, { share: 0, active: 20 }).tone, "warn");
  assert.deepEqual(crashCompare({ share: 0.1, active: 10 }, { share: 0, active: 20 }), { text: "у прошлой падений не было", tone: "bad" }, "0 из 20 — доля не ниже 1/20, 10% — в 2 раза");
  // Как автопауза на сервере (releases.ts crashRatio): прошлая не шлёт падений или на ней мало людей — не сравнивается;
  // у прошлой 0 падений — её доля не ниже 1/людей.
  assert.deepEqual(crashCompare({ share: 0.01, active: 300 }, { share: 0, active: 500, version: "0.1.92" }), { text: "прошлая версия падений не присылает", tone: "mute" });
  assert.equal(crashCompare({ share: 0.3, active: 10 }, { share: 0, active: 4, version: "0.1.93" }).tone, "mute");
  assert.match(crashCompare({ share: 0.3, active: 10 }, { share: 0, active: 4, version: "0.1.93" }).text, /мало людей \(4\)/);
  assert.equal(crashCompare({ share: 0.003, active: 1000 }, { share: 0, active: 400, version: "0.1.93" }).tone, "warn", "3 из 1000 против 0 из 400 — в 1,2 раза");
  assert.equal(crashCompare({ share: 0.03, active: 1000 }, { share: 0, active: 400, version: "0.1.93" }).tone, "bad", "30 из 1000 — в 12 раз");
  assert.equal(crashCompare({ share: 0.3, active: 10 }, { share: 0.05, active: 20, version: "0.1.93" }).text, "в 6,0 раза чаще прошлой");
  assert.equal(percentError("20"), null);
  assert.equal(percentError("0"), "от 1 до 100");
  assert.equal(percentError("101"), "от 1 до 100");
  assert.equal(percentError("2.5"), "целое число");
  assert.equal(percentError(""), "нужно число");
});

const REL: ReleasesData = {
  release: { version: "0.1.94", percent: 20, paused: true, started_at: "2026-11-24T08:00:00Z", prev: "0.1.93", auto_paused_at: "2026-11-24T11:00:00Z", updated_at: "", by: 0 },
  file_version: "0.1.94", served: 0, start_percent: 20, min_users: 3, crash_days: 7,
  versions: [{ version: "0.1.94", active: 10, share_people: 0.33, crashed: 3, crash_share: 0.3 }, { version: "0.1.93", active: 20, share_people: 0.67, crashed: 1, crash_share: 0.05 }],
  crash: { version: "0.1.94", active: 10, crashed: 3, share: 0.3, prev: { version: "0.1.93", active: 20, crashed: 1, share: 0.05 } },
};
const CR: CrashesData = {
  days: 7, from: "2026-11-18", keep_days: 90,
  series: Array.from({ length: 7 }, (_, i) => ({ day: `2026-11-${18 + i}`, active: 30, crashed: i === 6 ? 4 : 0, crashes: i === 6 ? 12 : 0 })),
  versions: [
    { version: "0.1.94", active: 10, crashed: 3, crashes: 11, share: 0.3, prev: { version: "0.1.93", active: 20, crashed: 1, share: 0.05 },
      top: [{ process: "widget", kind: "TypeError", place: "renderer/habitparty.js:212:7", fingerprint: "aaaaaaaaaaaa", count: 9, users: 3, first: "2026-11-24", last: "2026-11-24", fresh: true },
        { process: "gpu", kind: "crashed", place: "-", fingerprint: "", count: 2, users: 1, first: "2026-11-20", last: "2026-11-24", fresh: false }] },
    { version: "0.1.93", active: 20, crashed: 1, crashes: 1, share: 0.05, prev: null, top: [] },
  ],
};

test("разделы рисуются по готовым данным: выпуск на паузе с причиной автопаузы, версии, места падений", () => {
  const rel = renderToStaticMarkup(createElement(ReleasesPage, { data: REL, onChanged: () => {}, note: null, setNote: () => {} }));
  for (const s of ["Поэтапный выпуск 0.1.94", "автопауза из-за падений", "новые установки с сайта всё равно получают 0.1.94", "пауза не останавливает", "Продолжить выпуск", "20%", "50%", "100%", "Причина", "не откатываются", "Версии у людей за 7 дней", "30%"]) {
    assert.ok(rel.includes(s), `в «Выпусках» нет «${s}»`);
  }
  assert.ok(!rel.includes("Новые люди остаются на прошлой версии"), "пауза не останавливает новые установки — не обещать");
  assert.ok(!rel.includes("Откатить"), "кнопки отката нет: electron-updater не ставит старую версию");
  const fresh = renderToStaticMarkup(createElement(ReleasesPage, { data: { ...REL, release: null, served: null, crash: null, versions: [] }, onChanged: () => {}, note: null, setNote: () => {} }));
  assert.ok(fresh.includes("сервер ещё не видел latest.yml") && !fresh.includes("Поэтапный выпуск"));
  const cr = renderToStaticMarkup(createElement(CrashesPage, { data: CR, days: 7, onDays: () => {} }));
  for (const s of ["renderer/habitparty.js:212:7", "TypeError", "виджет", "новое в этой версии", "процесс упал целиком", "в 6,0 раза чаще прошлой", "Места падений 0.1.94", "С падением"]) {
    assert.ok(cr.includes(s), `в «Падениях» нет «${s}»`);
  }
});
