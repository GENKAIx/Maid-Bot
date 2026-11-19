import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Команда /token в боте (bot.ts), 19.11.2026: подсказка и ответ звали ключ «для приложения на ПК», а поля «Ключ» в программе
// на ПК нет давно — там вход логином и паролем. Ключ из /token нужен виджету на айфоне (iphone/Горничная-виджет.js, Scriptable).

const bot = readFileSync(new URL("../src/bot.ts", import.meta.url), "utf8");

test("/token — ключ для виджета на айфоне, а не для программы на ПК", () => {
  const help = bot.match(/\/token — [^"\\]*/)?.[0] ?? "";
  assert.ok(help, "в подсказке команд нет /token");
  assert.doesNotMatch(help, /ПК/, `подсказка: ${help}`);
  assert.match(help, /айфон/, `подсказка: ${help}`);
  const reply = bot.match(/bot\.command\("token"[^]*?ctx\.reply\(`([^`]*)`/)?.[1] ?? "";
  assert.ok(reply, "не нашёлся ответ на /token");
  assert.doesNotMatch(reply, /ПК/, `ответ: ${reply}`);
  assert.match(reply, /айфон/, `ответ: ${reply}`);
});
