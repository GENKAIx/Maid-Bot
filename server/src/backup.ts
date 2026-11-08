import fs from "node:fs";
import path from "node:path";
import { config } from "./config.ts";
import { Store } from "./db.ts";

// Резервная копия: все записи пользователя одним JSON. Раз в сутки сервер шлёт её в Telegram (если бот есть),
// в приложении — «Скачать копию», из командной строки — npm run backup.

export async function exportJson(store: Store, userId: number) {
  const u = await store.user(userId);
  if (!u) throw new Error("нет пользователя");
  const { password_hash: _, ...user } = u;
  const all = ["0000-01-01", "9999-12-31"] as const;
  return {
    format: "maid-backup-1",
    exported_at: new Date().toISOString(),
    user,
    diary: await store.diaryRange(userId, ...all),
    events: await store.allEvents(userId),
    tasks: await store.allTasks(userId),
    dates: await store.allDates(userId),
    memory: await store.allMemory(userId),
    metrics: await store.metricsRange(userId, ...all),
    habits: await store.allHabits(userId),
    habit_marks: await store.marksOf(userId, ...all),
    money: await store.moneyRange(userId, ...all),
    activity: await store.activityRange(userId, ...all),
  };
}

export const backupName = (login: string | null, at = new Date()) =>
  `maid-${login ?? "user"}-${at.toISOString().slice(0, 10)}.json`;

if (import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href) {
  const store = await Store.open(config.databaseUrl || config.dbFile);
  try {
    const dir = path.join(config.dbFile ? path.dirname(config.dbFile) : ".", "backups");
    fs.mkdirSync(dir, { recursive: true });
    for (const u of await store.users()) {
      const file = path.join(dir, backupName(u.login));
      fs.writeFileSync(file, JSON.stringify(await exportJson(store, u.id)));
      console.log(`#${u.id} ${u.login ?? ""} → ${file}`);
    }
  } finally {
    await store.close();
  }
}
