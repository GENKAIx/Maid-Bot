import assert from "node:assert/strict";
import { test } from "node:test";
import { appsWithoutGames, iconKey as siteKey, sumByApp } from "../src/appnames.ts";
import { iconKey } from "../../server/src/activity.ts";

// Статистика на сайте (web/src/appnames.ts): одна программа под разными именами — одна строка, ключ — как у значков на сервере.

test("sumByApp: chrome.exe и chrome, Claude и claude — по одной строке, подпись — имя с наибольшим временем", () => {
  const m = sumByApp([
    { name: "chrome.exe", sec: 100 }, { name: "chrome", sec: 300 }, { name: "claude", sec: 50 }, { name: "Claude.exe", sec: 10 },
    { name: "Counter-Strike 2", sec: 7 },
  ]);
  assert.deepEqual([...m], [["chrome", 400], ["claude", 60], ["Counter-Strike 2", 7]]);
});

test("ключ сайта совпадает с ключом сервера", () => {
  for (const n of ["chrome.exe", "Counter-Strike 2", "VALORANT-Win64-Shipping.exe", "Горничная", "?"]) assert.equal(siteKey(n), iconKey(n), n);
});

// 15.11.2026: в днях из прежнего трекера игра стояла и в программах, и в играх — «Программы» и «Игры» показывали одно и то же.
test("appsWithoutGames: игра этого же дня не попадает в программы, в другие дни — остаётся", () => {
  const rows = [
    { apps: [{ name: "chrome", sec: 100 }, { name: "Hearthstone", sec: 50 }, { name: "CastleBattle", sec: 40 }], games: [{ name: "Hearthstone", sec: 30 }, { name: "Castle Battle", sec: 20 }] },
    { apps: [{ name: "CastleBattle.exe", sec: 70 }], games: [] },
  ];
  assert.deepEqual(appsWithoutGames(rows).map((x) => x.name), ["chrome", "CastleBattle.exe"]);
});

test("sumByApp: cs2 и Counter-Strike 2 — одна игра", () => {
  assert.deepEqual([...sumByApp([{ name: "Counter-Strike 2", sec: 300 }, { name: "cs2", sec: 15 }])], [["Counter-Strike 2", 315]]);
});
