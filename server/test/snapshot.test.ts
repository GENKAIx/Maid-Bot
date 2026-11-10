import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Store } from "../src/db.ts";
import { checkSnapshot, takeSnapshot } from "../src/snapshot.ts";

// Ночной снимок базы: целый файл со всеми записями, latest.sqlite, старые снимки уходят, база из снимка открывается.

test("снимок базы: всё внутри, latest, хранит последние N, открывается как база", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maid-snap-"));
  const store = await Store.open(path.join(dir, "maid.sqlite"));
  try {
    const u = await store.ensureUser("100", "Тест", "Europe/Moscow");
    await store.addTask({ user_id: u.id, title: "Купить хлеб", priority: "normal", category: "", due_date: null, notes: "", message_id: null });
    const snaps = path.join(dir, "snapshots");
    for (let d = 1; d <= 5; d++) await takeSnapshot(store, snaps, new Date(Date.UTC(2026, 10, d, 1)), 3);
    const files = fs.readdirSync(snaps).sort();
    assert.deepEqual(files, ["latest.sqlite", "maid-2026-11-03.sqlite", "maid-2026-11-04.sqlite", "maid-2026-11-05.sqlite"]);
    assert.equal(checkSnapshot(path.join(snaps, "latest.sqlite")), null);

    const back = await Store.open(path.join(snaps, "maid-2026-11-05.sqlite"));
    try {
      const [v] = await back.users();
      assert.equal(v.chat_id, "100");
      assert.equal((await back.allTasks(v.id))[0].title, "Купить хлеб");
    } finally {
      await back.close();
    }

    fs.writeFileSync(path.join(dir, "junk.sqlite"), "не база");
    assert.notEqual(checkSnapshot(path.join(dir, "junk.sqlite")), null);
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
