import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "./db.ts";

// Ночной снимок всей базы — один файл SQLite со всем (сообщения, журнал отмены, напоминания, настройки), в отличие от
// JSON-копии в Telegram. Лежит рядом с базой в snapshots/: maid-ГГГГ-ММ-ДД.sqlite за последние SNAPSHOT_KEEP дней и
// latest.sqlite — его забирает с сервера deploy/pull-backup.ps1, поднимает обратно deploy/restore.sh.

export const SNAPSHOT_KEEP = 14;

/** Проверить файл базы: открывается, целый, в нём есть пользователи. Ошибка — текст, иначе null. */
export function checkSnapshot(file: string): string | null {
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const ok = (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
      if (ok !== "ok") return `повреждён: ${ok}`;
      db.prepare("SELECT count(*) AS n FROM users").get();
      return null;
    } finally {
      db.close();
    }
  } catch (e) {
    return (e as Error).message;
  }
}

/** Снять снимок в dir (только SQLite; у Postgres свои копии — вернёт null). Возвращает путь к снимку дня. */
export async function takeSnapshot(store: Store, dir: string, now = new Date(), keep = SNAPSHOT_KEEP): Promise<string | null> {
  if (store.driver.dialect !== "sqlite") return null;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `maid-${now.toISOString().slice(0, 10)}.sqlite`);
  const tmp = `${file}.tmp`;
  fs.rmSync(tmp, { force: true });
  await store.raw("VACUUM INTO ?", tmp);
  const bad = checkSnapshot(tmp);
  if (bad) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`снимок не прошёл проверку: ${bad}`);
  }
  fs.renameSync(tmp, file);
  fs.copyFileSync(file, path.join(dir, "latest.sqlite.tmp"));
  fs.renameSync(path.join(dir, "latest.sqlite.tmp"), path.join(dir, "latest.sqlite"));
  const old = fs.readdirSync(dir).filter((f) => /^maid-\d{4}-\d{2}-\d{2}\.sqlite$/.test(f)).sort().slice(0, -keep);
  for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
  return file;
}

// Из командной строки: node --import tsx server/src/snapshot.ts check <файл> — проверить снимок (deploy/restore.sh);
// node --import tsx server/src/snapshot.ts take — снять снимок сейчас.
if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "check") {
    const bad = checkSnapshot(arg);
    console.log(bad ? `Снимок не годится: ${bad}` : "Снимок цел.");
    process.exit(bad ? 1 : 0);
  } else if (cmd === "take") {
    const { config } = await import("./config.ts");
    const store = await Store.open(config.databaseUrl || config.dbFile);
    try {
      console.log((await takeSnapshot(store, path.join(path.dirname(config.dbFile), "snapshots"))) ?? "Снимки — только для SQLite.");
    } finally {
      await store.close();
    }
  } else {
    console.log("check <файл> | take");
    process.exit(2);
  }
}
