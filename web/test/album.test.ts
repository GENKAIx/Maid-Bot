import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { ALBUM_CARDS, albumCount } from "../src/album.ts";

// Альбом реакций (web/src/album.ts, screens/Album.tsx): 27 карточек, у каждой короткое имя и картинка, подсказок нет;
// имена — те же, что шлёт виджет и принимает сервер.

test("альбом: 27 карточек с именем и картинкой, без подсказок, список совпадает с сервером", () => {
  assert.equal(ALBUM_CARDS.length, 27);
  assert.equal(new Set(ALBUM_CARDS.map((c) => c.id)).size, 27);
  const server = readFileSync(new URL("../../server/src/album.ts", import.meta.url), "utf8");
  const ids = [...server.match(/export const ALBUM = \[([^\]]+)\]/)![1].matchAll(/"(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(ALBUM_CARDS.map((c) => c.id), ids);
  for (const c of ALBUM_CARDS) {
    assert.ok(c.name && c.name.length <= 16, `${c.id}: нет имени или оно длинное`);
    assert.deepEqual(Object.keys(c), ["id", "name"], `${c.id}: в карточке лишнее (подсказок быть не должно)`);
    assert.ok(existsSync(new URL(`../public/maid/${c.id}.webp`, import.meta.url)), `${c.id}: нет картинки`);
  }
});

test("альбом: счёт открытых — только известные карточки", () => {
  assert.equal(albumCount({}), 0);
  assert.equal(albumCount({ tea: "2026-11-16T10:00:00.000Z", forget: "2026-11-16T10:00:00.000Z", dance: "x" }), 2);
});
