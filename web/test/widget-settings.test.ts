import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// «Настройки → Виджет» (screens/Widget.tsx): 27.11.2026 раздел переложен по дизайну v2 — каждая настройка виджета
// (ключ из DEFAULTS) должна остаться на странице и сохраняться, а «Так это выглядит» — показывать облачко и панель.

const src = readFileSync(new URL("../src/screens/Widget.tsx", import.meta.url), "utf8");

test("каждая настройка виджета из DEFAULTS сохраняется со страницы", () => {
  const body = src.match(/const DEFAULTS: Required<WidgetPrefs> = \{([\s\S]*?)\n\};/)?.[1] ?? "";
  const keys = [...body.matchAll(/(\w+): /g)].map((m) => m[1]).filter((k) => !["next", "habits", "tasks"].includes(k));
  assert.ok(keys.length >= 25, `ключей мало: ${keys.length}`);
  for (const k of keys) assert.match(src, new RegExp(`save\\(\\{ ${k}`), `нет сохранения «${k}»`);
});

test("«Так это выглядит»: облачко, копия панели и «Ещё реплику»", () => {
  const aside = src.slice(src.indexOf('<aside className="wp-aside">'), src.indexOf("</aside>"));
  assert.match(aside, /<SayPreview say=\{SAYS\[line % SAYS\.length\]\}/);
  assert.match(aside, /<PanelPreview p=\{p\} opacity=\{opacity\} \/>/);
  assert.match(aside, /Ещё реплику/);
});
