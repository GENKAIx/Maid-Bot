import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import zlib from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { Store, type DbCopyRow } from "./db.ts";
import { dayKey, timeOf } from "./time.ts";

// Ночной снимок всей базы — один файл SQLite со всем (сообщения, журнал отмены, напоминания, настройки), в отличие от
// JSON-копии в Telegram. Лежит рядом с базой в snapshots/: maid-ГГГГ-ММ-ДД.sqlite за последние SNAPSHOT_KEEP дней и
// latest.sqlite — его забирает с сервера deploy/pull-backup.ps1, поднимает обратно deploy/restore.sh.
// Этап 4 «Тарифы и управление» (24.11.2026, DbCopies ниже): снимок снимается в 04:00 по поясу владельца, сжатый (gzip) уходит
// владельцу в Telegram — «второе место», не тот же сервер; каждая копия и проверка восстановления — строка db_copies (шаг 34),
// раздел админки «Копии базы». Неудача (не снялась, не влезла в 50 МБ бота, Telegram не принял) — оповещение (alerts.ts, правило
// backup). Postgres (DATABASE_URL): снимков нет — копии делает провайдер базы, строка «пропущено» с этой пометкой.
// Нагрузка: VACUUM INTO в node:sqlite синхронный — на время копии сервер не отвечает (порядка секунды на 50–100 МБ на SSD), так же
// PRAGMA integrity_check при проверке; база горничной — десятки МБ, поэтому ночью это допустимо. Чтение файла и сжатие (zlib.gzip)
// идут в пуле потоков и сервер не держат.

export const SNAPSHOT_KEEP = 14;
/** Ночная копия — с этого времени по поясу владельца (раз в его сутки). */
export const DB_COPY_AT = "04:00";
/** Самый большой файл, который бот может отправить (sendDocument): 50 МБ. */
export const TG_FILE_MAX = 50 * 1024 * 1024;
/** Допуск сверки копии с живой базой: копия до суток давности — разница не больше доли или числа (что больше). */
export const VERIFY_TOLERANCE = { share: 0.1, users: 3, messages: 50 };

const gzip = promisify(zlib.gzip);
const SNAP_RE = /^maid-\d{4}-\d{2}-\d{2}\.sqlite$/;
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0).replace(".", ",")} МБ`;

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
  const latestTmp = path.join(dir, "latest.sqlite.tmp");
  fs.rmSync(tmp, { force: true });
  try {
    await store.raw("VACUUM INTO ?", tmp);
    const bad = checkSnapshot(tmp);
    if (bad) throw new Error(`снимок не прошёл проверку: ${bad}`);
    fs.renameSync(tmp, file);
    fs.copyFileSync(file, latestTmp);
    fs.renameSync(latestTmp, path.join(dir, "latest.sqlite"));
  } finally {
    // Сбой на любом шаге (диск полон, SQLITE_FULL) — недописанные временные файлы не держат место до следующей ночи.
    fs.rmSync(tmp, { force: true });
    fs.rmSync(latestTmp, { force: true });
  }
  const old = fs.readdirSync(dir).filter((f) => SNAP_RE.test(f)).sort().slice(0, -keep);
  for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
  return file;
}

/** Размер файла базы SQLite вместе с журналом WAL, байты; нет файла (Postgres, :memory:) — null. */
export function dbFileBytes(file: string | null | undefined): number | null {
  if (!file || file === ":memory:") return null;
  try {
    const wal = fs.existsSync(`${file}-wal`) ? fs.statSync(`${file}-wal`).size : 0;
    return fs.statSync(file).size + wal;
  } catch {
    return null;
  }
}

export interface DbCopyDeps {
  /** Папка снимков (snapshots/ рядом с базой); null — снимать некуда. */
  dir: string | null;
  /** Отправить файл владельцу в Telegram; вернуть, скольким ушло. Нет бота — не задано (копия только на сервере). */
  send?: (name: string, data: Buffer, caption: string) => Promise<number>;
  /** Потолок файла для Telegram (тесты ставят маленький). */
  maxSendBytes?: number;
  /** Файл живой базы — размер в разделе «Копии базы». */
  dbFile?: string | null;
  keep?: number;
}

/** Отправить каждому получателю отдельно: сбой у одного (бот заблокирован, 403) не мешает остальным. Вернуть, скольким ушло;
 *  не ушло никому, хотя пробовали, — бросить последнюю ошибку (в db_copies — «Telegram не принял файл»). */
export async function sendEach<T>(to: T[], fn: (x: T) => Promise<unknown>): Promise<number> {
  let n = 0;
  let err: unknown = null;
  for (const x of to) {
    try {
      await fn(x);
      n++;
    } catch (e) {
      err = e;
      console.error("[snapshot] отправка", (e as Error).message);
    }
  }
  if (!n && err) throw err;
  return n;
}

/** Копия уже снимается или проверяется (кнопка во время ночной) — 409 в админке. */
export class DbCopyBusy extends Error {}

type CopyResult = Omit<DbCopyRow, "id">;

/** Ночная копия базы, отправка владельцу и проверка восстановления (этап 4): одно место для планировщика и админки. */
export class DbCopies {
  private busy = false;
  constructor(private store: Store, private o: DbCopyDeps) {}

  get mode(): "sqlite" | "postgres" | "off" {
    return this.store.driver.dialect !== "sqlite" ? "postgres" : this.o.dir ? "sqlite" : "off";
  }
  get maxSendBytes() {
    return this.o.maxSendBytes ?? TG_FILE_MAX;
  }

  /** Пора ли ночной копии: после DB_COPY_AT по поясу владельца, раз в его сутки (store.once snapshot:<день>). */
  async due(now: Date, tz: string): Promise<boolean> {
    // Идёт ручная копия или проверка — отметку дня не тратим: копия снимется на следующем такте, когда освободится.
    if (this.busy) return false;
    return timeOf(now, tz) >= DB_COPY_AT && (await this.store.once(`snapshot:${dayKey(now, tz)}`));
  }

  private async lock<T>(fn: () => Promise<T>): Promise<T> {
    if (this.busy) throw new DbCopyBusy("копия или проверка уже идёт — подождите минуту");
    this.busy = true;
    try {
      return await fn();
    } finally {
      this.busy = false;
    }
  }

  /** Снять копию, сжать, отправить владельцу. Не бросает (кроме «уже идёт»): итог — строка db_copies. by — кто (0 — расписание). */
  run(now = new Date(), by = 0): Promise<CopyResult> {
    return this.lock(async () => {
      const t0 = Date.now();
      const row: CopyResult = { at: now.toISOString(), kind: "copy", status: "ok", file: "", bytes: 0, gz_bytes: 0, sent: 0, problem: "", note: "", by_user: by, ms: 0 };
      if (this.mode === "postgres") Object.assign(row, { status: "skip", note: "Postgres: копии базы делает провайдер (снимки и восстановление — в его панели)" });
      else if (this.mode === "off") Object.assign(row, { status: "skip", note: "нет папки для снимков (база не в файле)" });
      else {
        try {
          const file = (await takeSnapshot(this.store, this.o.dir!, now, this.o.keep ?? SNAPSHOT_KEEP))!;
          row.file = path.basename(file);
          row.bytes = fs.statSync(file).size;
          const gz = await gzip(await fs.promises.readFile(file));
          row.gz_bytes = gz.length;
          if (!this.o.send) row.note = "бот выключен — копия только на сервере";
          else if (gz.length > this.maxSendBytes) row.problem = `не влезает в Telegram: сжатая ${mb(gz.length)}, а бот отправляет до ${mb(this.maxSendBytes)}`;
          else {
            const caption = `Копия базы горничной ${row.file.slice(5, 15)}: ${mb(row.bytes)}, сжатая ${mb(gz.length)}. ` +
              "Внутри все записи людей — не пересылайте и не выкладывайте. Поднять: gunzip, затем deploy/restore.sh.";
            try {
              row.sent = (await this.o.send(`${row.file}.gz`, gz, caption)) > 0 ? 1 : 0;
              if (!row.sent) row.problem = "некому отправить: у владельца нет Telegram";
            } catch (e) {
              row.problem = `Telegram не принял файл: ${(e as Error).message.slice(0, 120)}`;
            }
          }
        } catch (e) {
          Object.assign(row, { status: "fail", problem: `копия не снялась: ${(e as Error).message.slice(0, 160)}` });
        }
      }
      row.ms = Date.now() - t0;
      await this.store.addDbCopy(row);
      return row;
    });
  }

  /** Самая свежая локальная копия: снимок дня, иначе latest.sqlite. */
  latestFile(): string | null {
    if (!this.o.dir || !fs.existsSync(this.o.dir)) return null;
    const days = fs.readdirSync(this.o.dir).filter((f) => SNAP_RE.test(f)).sort();
    const f = days.at(-1) ?? (fs.existsSync(path.join(this.o.dir, "latest.sqlite")) ? "latest.sqlite" : null);
    return f ? path.join(this.o.dir, f) : null;
  }

  /** Проверить восстановление: последнюю копию — во временный файл рядом, проверка целостности, открыть как базу (миграции),
   *  сверить число людей и сообщений с живой базой, временный файл удалить. Настоящую базу не трогает. Итог — строка db_copies. */
  verify(now = new Date(), by = 0): Promise<CopyResult> {
    return this.lock(async () => {
      const t0 = Date.now();
      const row: CopyResult = { at: now.toISOString(), kind: "verify", status: "ok", file: "", bytes: 0, gz_bytes: 0, sent: 0, problem: "", note: "", by_user: by, ms: 0 };
      const src = this.mode === "sqlite" ? this.latestFile() : null;
      if (this.mode !== "sqlite") {
        Object.assign(row, { status: "skip", note: this.mode === "postgres" ? "Postgres: восстановление проверяется у провайдера базы" : "нет папки для снимков" });
      } else if (!src) Object.assign(row, { status: "fail", problem: "локальных копий нет — сначала сделайте копию" });
      else {
        row.file = path.basename(src);
        row.bytes = fs.statSync(src).size;
        const tmp = path.join(this.o.dir!, `.verify-${now.getTime()}.sqlite`);
        try {
          await fs.promises.copyFile(src, tmp);
          const bad = checkSnapshot(tmp);
          if (bad) Object.assign(row, { status: "fail", problem: `копия не поднимается: ${bad.slice(0, 160)}` });
          else {
            const back = await Store.open(tmp);
            let copy: { users: number; messages: number };
            try {
              copy = await back.rowCounts();
            } finally {
              await back.close();
            }
            const live = await this.store.rowCounts();
            row.note = `в копии людей ${copy.users} (сейчас ${live.users}), сообщений ${copy.messages} (сейчас ${live.messages})`;
            const far = (a: number, b: number, min: number) => Math.abs(a - b) > Math.max(min, Math.ceil(b * VERIFY_TOLERANCE.share));
            if (far(copy.users, live.users, VERIFY_TOLERANCE.users) || far(copy.messages, live.messages, VERIFY_TOLERANCE.messages)) {
              Object.assign(row, { status: "warn", problem: "числа в копии сильно расходятся с живой базой — копия старая или неполная" });
            }
          }
        } catch (e) {
          Object.assign(row, { status: "fail", problem: `копия не поднимается: ${(e as Error).message.slice(0, 160)}` });
        } finally {
          for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`, `${tmp}-journal`]) fs.rmSync(f, { force: true });
        }
      }
      row.ms = Date.now() - t0;
      await this.store.addDbCopy(row);
      return row;
    });
  }

  /** Раздел «Копии базы»: как хранится, локальные снимки (имя файла, размер, когда), последние копии и проверки. Без путей сервера. */
  async view() {
    const dir = this.o.dir;
    const local = dir && fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => SNAP_RE.test(f)).sort().reverse().map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return { file: f, bytes: st.size, at: st.mtime.toISOString() };
      })
      : [];
    const strip = ({ id: _, ...r }: DbCopyRow) => r;
    return {
      mode: this.mode, at: DB_COPY_AT, keep: this.o.keep ?? SNAPSHOT_KEEP, telegram: Boolean(this.o.send), max_send_bytes: this.maxSendBytes,
      db_bytes: this.mode === "sqlite" ? dbFileBytes(this.o.dbFile) : null,
      local,
      copies: (await this.store.dbCopies("copy", 14)).map(strip),
      verifies: (await this.store.dbCopies("verify", 10)).map(strip),
    };
  }
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
