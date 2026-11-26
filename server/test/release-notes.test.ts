import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../src/db.ts";
import {
  cleanNotes, editNotes, NOTE_MAX_LEN, NOTES_MAX_ITEMS, NOTES_SEED, notesFile, readNotes, readRelease, RELEASE_NOTES_KEEP, RELEASE_NOTES_KEY,
  RELEASE_START_PERCENT, releaseFor, releasesView, servedYml,
} from "../src/releases.ts";

// Выпуски программы на ПК, 26.11.2026: по умолчанию — сразу всем (решение владельца), «что нового» у каждого выпуска
// (notes-<версия>.json рядом с latest.yml → история в kv, правка в админке с причиной и журналом).

const NOW = new Date("2026-11-26T12:00:00Z");
const yml = (v: string, staging?: number) =>
  `version: ${v}\nfiles:\n  - url: Gornichnaya-Setup-${v}.exe\npath: Gornichnaya-Setup-${v}.exe\n` + (staging == null ? "" : `stagingPercentage: ${staging}\n`);
const notesFrom = (map: Record<string, string[]>) => async (v: string) => map[v] ?? null;

test("выпуск: новая версия без stagingPercentage — сразу всем (100%); поэтапно — только с процентом в файле", async () => {
  assert.equal(RELEASE_START_PERCENT, 100);
  const store = await Store.open(":memory:");
  try {
    await releaseFor(store, yml("0.1.94"), NOW);
    assert.equal(await servedYml(store, yml("0.1.95"), NOW), yml("0.1.95"), "без строки — отдаётся без строки (всем)");
    const r = (await readRelease(store))!;
    assert.deepEqual([r.version, r.percent, r.paused, r.prev], ["0.1.95", 100, false, "0.1.94"]);
    assert.equal(await servedYml(store, yml("0.1.96", 100), NOW), yml("0.1.96"), "100 — тоже всем");
    assert.equal(await servedYml(store, yml("0.1.97", 20), NOW), yml("0.1.97", 20), "--percent=20 — с 20%");
    assert.equal((await readRelease(store))!.percent, 20);
    // stagingPercentage: 0 — на паузе; «Продолжить» вернёт 100%, а не 20%.
    await releaseFor(store, yml("0.1.98", 0), NOW);
    assert.deepEqual([(await readRelease(store))!.paused, (await readRelease(store))!.percent], [true, 100]);
  } finally {
    await store.close();
  }
});

test("что нового: разбор пунктов — «- » в начале, пустые строки, не больше 12, пункт до 200 знаков, без HTML", () => {
  assert.deepEqual(cleanNotes(["  Первое ", "", "- Второе", "• Третье", "* Четвёртое"]), { notes: ["Первое", "Второе", "Третье", "Четвёртое"], error: null });
  assert.deepEqual(cleanNotes("- раз\r\n\n- два\n"), { notes: ["раз", "два"], error: null });
  assert.equal(cleanNotes("стрелка -> и 2 < 3").error, null, "стрелки и знаки сравнения — не HTML");
  assert.match(cleanNotes(Array.from({ length: NOTES_MAX_ITEMS + 1 }, (_, i) => `п${i}`)).error!, /не больше 12/);
  assert.equal(cleanNotes(Array.from({ length: NOTES_MAX_ITEMS }, (_, i) => `п${i}`)).error, null);
  assert.match(cleanNotes(["ок", "я".repeat(NOTE_MAX_LEN + 1)]).error!, /пункт 2 длиннее 200/);
  assert.equal(cleanNotes(["я".repeat(NOTE_MAX_LEN)]).error, null);
  for (const bad of ["<b>жирно</b>", "<script>x</script>", "a <img src=x>", "<!-- -->"]) assert.match(cleanNotes([bad]).error!, /без HTML/, bad);
  assert.match(cleanNotes([1, 2]).error!, /список строк/);
  assert.match(cleanNotes(null).error!, /список строк/);
  // Файл рядом с latest.yml: та же версия и годные пункты — пункты; иначе null.
  assert.deepEqual(notesFile(JSON.stringify({ version: "0.1.95", notes: ["а", "б"] }), "0.1.95"), ["а", "б"]);
  assert.equal(notesFile(JSON.stringify({ version: "0.1.94", notes: ["а"] }), "0.1.95"), null, "чужая версия");
  assert.equal(notesFile(JSON.stringify({ version: "0.1.95", notes: ["<b>а</b>"] }), "0.1.95"), null);
  assert.equal(notesFile("не json", "0.1.95"), null);
  assert.equal(notesFile("null", "0.1.95"), null);
});

test("что нового: заготовка 0.1.93 и 0.1.94, пункты из файла при первом виде версии, история — последние 30", async () => {
  const store = await Store.open(":memory:");
  try {
    // Истории в базе нет — уже вышедшие 0.1.94 и 0.1.93 из заготовки (сервер на проде выпуск 0.1.94 уже видел: файла заметок не было).
    const seed = await readNotes(store);
    assert.deepEqual(seed.map((n) => n.version), ["0.1.94", "0.1.93"]);
    assert.ok(seed[0].notes.some((n) => n.includes("↗")) && seed[0].notes.some((n) => n.includes("«Сегодня»")));
    assert.ok(seed[1].notes.some((n) => n.includes("падени")));
    for (const n of NOTES_SEED) assert.equal(cleanNotes(n.notes).error, null, n.version);
    seed[0].notes.push("порча копии");
    assert.equal((await readNotes(store))[0].notes.length, NOTES_SEED[0].notes.length, "заготовка не портится");

    await releaseFor(store, yml("0.1.94"), NOW); // первая версия, файла нет — заготовка остаётся
    assert.equal((await readNotes(store)).find((n) => n.version === "0.1.94")!.notes.length, 3);
    const notesOf = notesFrom({ "0.1.95": ["Новая кнопка", "Быстрее открывается"] });
    await servedYml(store, yml("0.1.95"), NOW, notesOf);
    const h = await readNotes(store);
    assert.deepEqual(h.map((n) => n.version), ["0.1.95", "0.1.94", "0.1.93"]);
    assert.deepEqual([h[0].notes, h[0].date, h[0].edited_at, h[0].by], [["Новая кнопка", "Быстрее открывается"], NOW.toISOString(), null, 0]);
    // Та же версия ещё раз — файл не перечитывается (выпуск уже заведён).
    await servedYml(store, yml("0.1.95"), NOW, async () => ["другое"]);
    assert.deepEqual((await readNotes(store))[0].notes, ["Новая кнопка", "Быстрее открывается"]);

    // Выпуск без заметок — всё равно идёт, в истории пустая запись; файл лёг позже — раздел «Выпуски» дозаполняет.
    await servedYml(store, yml("0.1.96"), NOW, notesFrom({}));
    assert.deepEqual((await readNotes(store))[0], { version: "0.1.96", date: NOW.toISOString(), notes: [], edited_at: null, by: 0 });
    const view = await releasesView(store, yml("0.1.96"), NOW, notesFrom({ "0.1.96": ["Пришло позже"] }));
    assert.deepEqual(view.notes[0].notes, ["Пришло позже"]);
    assert.deepEqual([view.notes_max_items, view.notes_max_len, view.start_percent], [12, 200, 100]);

    // История — не больше 30: старые уходят.
    for (let i = 0; i < 40; i++) await releaseFor(store, yml(`0.2.${i}`), NOW, async (v) => [`пункт ${v}`]);
    const all = await readNotes(store);
    assert.equal(all.length, RELEASE_NOTES_KEEP);
    assert.equal(all[0].version, "0.2.39");
    assert.equal(all.at(-1)!.version, "0.2.10");
    assert.ok(JSON.parse((await store.kvGet(RELEASE_NOTES_KEY))!).length <= RELEASE_NOTES_KEEP, "в базе тоже не больше 30");
  } finally {
    await store.close();
  }
});

test("что нового: правка — только с причиной, версия из истории, проверка пунктов; в журнал админа; файл правку не перетирает", async () => {
  const store = await Store.open(":memory:");
  try {
    await releaseFor(store, yml("0.1.94"), NOW);
    await assert.rejects(editNotes(store, 1, { version: "0.1.94", notes: ["Новое"] }, NOW), /причину/);
    await assert.rejects(editNotes(store, 1, { version: "0.1.94", notes: ["Новое"], reason: "ok" }, NOW), /причину/, "меньше 3 знаков");
    await assert.rejects(editNotes(store, 1, { version: "0.1.99", notes: ["Новое"], reason: "проверка" }, NOW), /нет в истории/);
    await assert.rejects(editNotes(store, 1, { version: "0.1.94", notes: ["<i>x</i>"], reason: "проверка" }, NOW), /без HTML/);
    await assert.rejects(editNotes(store, 1, { version: "0.1.94", notes: Array(13).fill("п"), reason: "проверка" }, NOW), /не больше 12/);
    await assert.rejects(editNotes(store, 1, { version: "0.1.94", notes: [...NOTES_SEED[0].notes], reason: "проверка" }, NOW), /ничего не изменилось/);
    assert.equal((await store.adminLog(10)).filter((x) => x.action === "release_notes").length, 0, "отказ — не в журнал");

    const r = await editNotes(store, 7, { version: "0.1.93", notes: "- Падения\n- Выпуск по шагам", reason: "проще словами" }, NOW);
    assert.deepEqual([r.notes, r.edited_at, r.by], [["Падения", "Выпуск по шагам"], NOW.toISOString(), 7]);
    const log = (await store.adminLog(10)).find((x) => x.action === "release_notes")!;
    assert.deepEqual([log.user_id, log.detail, log.reason], [7, "0.1.93: пунктов 2 → 2", "проще словами"]);
    assert.deepEqual((await readNotes(store)).map((n) => n.version), ["0.1.94", "0.1.93"], "заготовка попала в базу вместе с правкой");

    // Правленые пункты файл не перетирает (та же версия выпущена заново).
    await editNotes(store, 7, { version: "0.1.94", notes: ["Своё"], reason: "переписал" }, NOW);
    await releaseFor(store, yml("0.1.95"), NOW);
    await releaseFor(store, yml("0.1.94"), NOW, async () => ["Из файла"]);
    assert.deepEqual((await readNotes(store)).find((n) => n.version === "0.1.94")!.notes, ["Своё"]);
  } finally {
    await store.close();
  }
});
