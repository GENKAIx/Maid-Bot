import ExcelJS from "exceljs";
import { pathToFileURL } from "node:url";
import { config } from "./config.ts";
import { Store, type User } from "./db.ts";
import { METRICS } from "./parse.ts";

// Перенос старой Excel-таблицы «2026 заметки» в базу.
//   npm run import -- <файл.xlsx> [--login <логин>]
// Каждая строка листа (и каждая запись других листов) — одно сообщение с source = import
// и своим source_id: повторный запуск ничего не дублирует, только добавляет новое.

export interface ImportReport {
  days: number;
  diary: number;
  metrics: number;
  activity: number;
  events: number;
  tasks: number;
  dates: number;
  memory: number;
  money: number;
  skipped: number;
  byMonth: Record<string, number>;
  bySection: Record<string, number>;
  byMetric: Record<string, number>;
  warnings: string[];
}

const blank = (): ImportReport => ({
  days: 0, diary: 0, metrics: 0, activity: 0, events: 0, tasks: 0, dates: 0, memory: 0, money: 0, skipped: 0,
  byMonth: {}, bySection: {}, byMetric: {}, warnings: [],
});

type Cell = string | number | Date | null;

/** Значение ячейки exceljs как строка, число или дата (формулы — результатом, rich text — текстом). */
export function cellValue(v: ExcelJS.CellValue): Cell {
  if (v == null) return null;
  if (typeof v === "string") return v.trim() ? v.replace(/\r\n/g, "\n").trim() : null;
  if (typeof v === "number" || v instanceof Date) return v;
  if (typeof v === "boolean") return v ? "да" : "нет";
  if (typeof v === "object") {
    if ("richText" in v) return cellValue(v.richText.map((r) => r.text).join(""));
    if ("result" in v) return cellValue((v as { result?: ExcelJS.CellValue }).result ?? null);
    if ("text" in v) return cellValue((v as { text: string }).text);
    if ("error" in v) return null;
  }
  return null;
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const isoTime = (d: Date) => d.toISOString().slice(11, 16);
const str = (c: Cell) => (c == null ? "" : c instanceof Date ? isoDay(c) : String(c));
const num = (c: Cell): number | null => {
  if (typeof c === "number") return c;
  if (typeof c === "string" && /^-?\d+(?:[.,]\d+)?$/.test(c.trim())) return Number(c.replace(",", "."));
  return null;
};

/** «2 ч 47 мин», «37 мин», «1 ч» → секунды. */
export function parseDuration(s: string): number | null {
  const h = s.match(/(\d+(?:[.,]\d+)?)\s*ч/);
  const m = s.match(/(\d+)\s*мин/);
  if (!h && !m) return null;
  return Math.round((h ? Number(h[1].replace(",", ".")) * 3600 : 0) + (m ? Number(m[1]) * 60 : 0));
}

/** «Активность ПК: 9 ч 37 мин активно, 13 ч 58 мин AFK. … chrome.exe : 2 ч 47 мин» */
export function parsePc(text: string) {
  const head = text.match(/Активность ПК:\s*([^,]+?)\s*активно(?:,\s*([^.]+?)\s*AFK)?/i);
  if (!head) return null;
  const apps: { name: string; sec: number }[] = [];
  for (const line of text.split("\n")) {
    const a = line.match(/^\s*(.+?)\s+:\s+(.+)$/);
    const sec = a && parseDuration(a[2]);
    if (a && sec) apps.push({ name: a[1].trim(), sec });
  }
  return { active: parseDuration(head[1]) ?? 0, afk: head[2] ? parseDuration(head[2]) ?? 0 : 0, apps };
}

/** «Общее время: 37 мин\nHearthstone - 22 мин\nCounter-Strike 2 - 15 мин» */
export function parseGames(text: string) {
  const games: { name: string; sec: number }[] = [];
  for (const line of text.split("\n")) {
    if (/^\s*Общее время/i.test(line)) continue;
    const g = line.match(/^\s*(.+?)\s+[-—–]\s+(.+)$/);
    const sec = g && parseDuration(g[2]);
    if (g && sec) games.push({ name: g[1].trim(), sec });
  }
  return games;
}

/** Число в начале текста с единицей: «6 ч, плохо спал» → 6; «30 мин, бег» → 30. */
const leading = (text: string, unit: RegExp): number | null => {
  const m = text.match(new RegExp(`^\\s*(\\d+(?:[.,]\\d+)?)\\s*${unit.source}`, "i"));
  return m ? Number(m[1].replace(",", ".")) : null;
};

const MONTHS = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
const MONTH_GEN = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];

/** До мая 2026 таблица была другой: оценки и шаги в столбцах без заголовков. */
const NEW_LAYOUT_FROM = "2026-05-01";

interface DayData {
  diary: { section: string; text: string; topic?: string }[];
  metrics: { key: string; value: number; note?: string }[];
  pc: { active: number; afk: number; apps: { name: string; sec: number }[] } | null;
  games: { name: string; sec: number }[];
}

function oldLayout(c: (i: number) => Cell): DayData {
  const d: DayData = { diary: [], metrics: [], pc: null, games: [] };
  const text = (section: string, i: number, topic = "") => {
    const t = c(i);
    if (typeof t === "string") d.diary.push({ section, text: t, topic });
  };
  const metric = (key: string, i: number, max?: number) => {
    const v = num(c(i));
    if (v != null && (max == null || v <= max)) d.metrics.push({ key, value: v });
  };
  text("notes", 5);
  text("notes", 6);
  text("hobby", 7);
  const h8 = c(8);
  if (typeof h8 === "string") {
    const hours = leading(h8, /ч/);
    if (hours != null && hours <= 24) {
      d.diary.push({ section: "sleep", text: h8 });
      d.metrics.push({ key: "sleep_hours", value: hours });
    } else d.diary.push({ section: "hobby", text: h8 });
  }
  text("sleep", 9);
  metric("sleep_hours", 10, 24);
  const games = num(c(11));
  if (games) d.games.push({ name: "Игры", sec: Math.round(games * 3600) });
  text("sport", 12);
  metric("sport_min", 13);
  metric("rating_food", 14, 10);
  const h15 = c(15);
  if (num(h15) != null) metric("rating_health", 15, 10);
  else text("health", 15);
  metric("rating_day", 16, 10);
  metric("mood", 17, 10);
  metric("energy", 18, 10);
  metric("steps", 19);
  text("mood", 20);
  return d;
}

function newLayout(c: (i: number) => Cell): DayData {
  const d: DayData = { diary: [], metrics: [], pc: null, games: [] };
  const s = (i: number) => (typeof c(i) === "string" ? (c(i) as string) : num(c(i)) != null ? String(c(i)) : "");
  if (s(5)) d.diary.push({ section: "notes", text: s(5) });
  if (s(6)) d.diary.push({ section: "notes", text: `Теги: ${s(6)}`, topic: "tags" });
  if (s(7)) d.diary.push({ section: "hobby", text: s(7) });
  if (s(8)) {
    d.diary.push({ section: "sleep", text: s(8) });
    const h = leading(s(8), /ч/);
    if (h != null && h <= 24) d.metrics.push({ key: "sleep_hours", value: h });
  }
  if (s(9)) {
    const pc = parsePc(s(9));
    if (pc) d.pc = pc;
    else d.diary.push({ section: "sleep", text: s(9) }); // старые строки «Лег в 3 / Проснулся в 12»
  }
  const g = c(10);
  if (typeof g === "string") d.games = parseGames(g);
  else if (typeof g === "number" && g > 0) d.games = [{ name: "Игры", sec: Math.round(g * 3600) }];
  if (s(11)) {
    d.diary.push({ section: "sport", text: s(11) });
    const m = leading(s(11), /мин/);
    if (m != null) d.metrics.push({ key: "sport_min", value: m });
  }
  if (s(12)) d.diary.push({ section: "food", text: s(12) });
  if (s(13)) {
    let rest = s(13);
    const steps = rest.match(/Шаги:\s*(\d+)\.?/i);
    if (steps) {
      d.metrics.push({ key: "steps", value: Number(steps[1]) });
      rest = rest.replace(steps[0], "");
    }
    const weight = rest.match(/Вес\s*:?\s*(\d+(?:[.,]\d+)?)\s*(?:кг)?\.?/i);
    if (weight) {
      d.metrics.push({ key: "weight", value: Number(weight[1].replace(",", ".")) });
      rest = rest.replace(weight[0], "");
    }
    rest = rest.trim();
    if (rest) d.diary.push({ section: "health", text: rest });
  }
  if (s(14)) d.diary.push({ section: "notes", text: s(14), topic: "summary" });
  return d;
}

const count = (r: Record<string, number>, k: string) => (r[k] = (r[k] ?? 0) + 1);

async function saveOnce(store: Store, u: User, sourceId: string, text: string, day: string, at?: Date) {
  const { message, created } = await store.saveMessage({ userId: u.id, source: "import", sourceId, text: text.slice(0, 4000), dayKey: day, at });
  if (created) await store.setMessage(message.id, { state: "done" });
  return created ? message.id : null;
}

/** Импорт рабочей книги для пользователя. Повторный запуск безопасен. */
export async function importWorkbook(store: Store, u: User, wb: ExcelJS.Workbook): Promise<ImportReport> {
  const rep = blank();

  // --- главный лист: дневник по дням ---
  const main = wb.worksheets.find((w) => /^\d{4}$/.test(w.name.trim())) ?? wb.getWorksheet("2026");
  if (!main) rep.warnings.push("нет листа с дневником (имя — год, например «2026»)");
  const plans = new Set<string>();
  if (main) {
    for (let r = 2; r <= main.rowCount; r++) {
      const row = main.getRow(r);
      const c = (i: number) => cellValue(row.getCell(i + 1).value);
      const date = c(0);
      if (!(date instanceof Date)) continue;
      const day = isoDay(date);

      const plan = c(4);
      if (typeof plan === "string" && !plans.has(plan)) {
        plans.add(plan);
        const month = MONTH_GEN[Number(day.slice(5, 7)) - 1];
        const id = await saveOnce(store, u, `xlsx:${main.name}:plan:${day.slice(0, 7)}`, plan, day);
        if (id) {
          await store.addMemory(u.id, "goal", `План на ${month} ${day.slice(0, 4)}`, plan, id);
          rep.memory++;
        }
      }

      const d = day < NEW_LAYOUT_FROM ? oldLayout(c) : newLayout(c);
      if (!d.diary.length && !d.metrics.length && !d.pc && !d.games.length) continue;
      const raw = d.diary.map((x) => x.text).join("\n\n") || d.metrics.map((m) => `${m.key}=${m.value}`).join(", ");
      const id = await saveOnce(store, u, `xlsx:${main.name}:${r}`, raw, day, new Date(`${day}T20:00:00Z`));
      if (!id) {
        rep.skipped++;
        continue;
      }
      rep.days++;
      count(rep.byMonth, MONTHS[Number(day.slice(5, 7)) - 1]);
      for (const x of d.diary) {
        await store.addDiary(u.id, day, x.section, x.text, id, x.topic ?? "");
        rep.diary++;
        count(rep.bySection, x.section);
      }
      for (const m of d.metrics) {
        const meta = METRICS[m.key];
        await store.addMetric({
          user_id: u.id, day_key: day, key: m.key, label: meta?.label ?? m.key, value: m.value, unit: meta?.unit ?? "",
          note: m.note ?? "", source: "import", message_id: id,
        });
        rep.metrics++;
        count(rep.byMetric, m.key);
      }
      if (d.pc || d.games.length) {
        await store.upsertActivity({
          user_id: u.id, day_key: day, source: "import",
          active_sec: d.pc?.active ?? 0, afk_sec: d.pc?.afk ?? 0, apps: d.pc?.apps ?? [], games: d.games,
        });
        rep.activity++;
      }
    }
  }

  // --- планы, задачи, даты: строки с заголовком, ID в первом столбце ---
  const table = (name: string) => {
    const ws = wb.getWorksheet(name);
    if (!ws) return [];
    const head = (ws.getRow(1).values as ExcelJS.CellValue[]).map((v) => str(cellValue(v)));
    const rows: { id: string; get: (h: string) => Cell }[] = [];
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const get = (h: string) => {
        const i = head.indexOf(h);
        return i < 0 ? null : cellValue(row.getCell(i).value);
      };
      const id = str(get("ID")) || `row${r}`;
      if (row.cellCount && (get("Дата") || get("Задача") || get("Название") || get("Событие"))) rows.push({ id, get });
    }
    return rows;
  };

  for (const p of table("Планы")) {
    const date = p.get("Дата");
    if (!(date instanceof Date)) continue;
    const day = isoDay(date);
    const time = p.get("Время");
    const title = str(p.get("Событие")) || "Событие";
    const id = await saveOnce(store, u, `xlsx:plans:${p.id}`, str(p.get("Исходный текст")) || title, day);
    if (!id) {
      rep.skipped++;
      continue;
    }
    const status = str(p.get("Статус"));
    await store.addEvent({
      user_id: u.id, title, date_iso: day, time: time instanceof Date ? isoTime(time) : null, end_time: null,
      details: str(p.get("Детали")), domain: "", message_id: id,
      status: status === "active" || !status ? "active" : status === "done" ? "done" : "cancelled",
    });
    rep.events++;
  }

  for (const t of table("Задачи")) {
    const created = t.get("Создано");
    const day = created instanceof Date ? isoDay(created) : isoDay(new Date());
    const title = str(t.get("Задача"));
    if (!title) continue;
    const id = await saveOnce(store, u, `xlsx:tasks:${t.id}`, str(t.get("Исходный текст")) || title, day);
    if (!id) {
      rep.skipped++;
      continue;
    }
    const st = str(t.get("Статус"));
    const done = t.get("Завершено");
    const due = t.get("Срок");
    await store.addTask({
      user_id: u.id, title, priority: str(t.get("Приоритет")) || "normal", category: str(t.get("Категория")),
      due_date: due instanceof Date ? isoDay(due) : null, notes: str(t.get("Заметки")), message_id: id,
      status: st === "done" ? "done" : st === "deleted" ? "cancelled" : "open",
      created_at: created instanceof Date ? created.toISOString() : undefined,
      done_at: done instanceof Date ? done.toISOString() : null,
    });
    rep.tasks++;
  }

  for (const d of table("Даты")) {
    const date = d.get("Дата");
    if (!(date instanceof Date)) continue;
    const title = str(d.get("Название"));
    if (!title) continue;
    const id = await saveOnce(store, u, `xlsx:dates:${d.id}`, title, isoDay(date));
    if (!id) {
      rep.skipped++;
      continue;
    }
    await store.addDate({
      user_id: u.id, title, date_iso: isoDay(date), type: str(d.get("Тип")) || "other", person: str(d.get("Кого касается")),
      notes: str(d.get("Заметки")), yearly: /^(yes|да|1|true)$/i.test(str(d.get("Повторять каждый год"))) ? 1 : 0,
      message_id: id, status: str(d.get("Статус")) === "deleted" ? "cancelled" : "active",
    });
    rep.dates++;
  }

  // --- доходы: месяц, доллары, рубли; остальные ячейки — заметки о долгах ---
  const inc = wb.getWorksheet("Доходы");
  if (inc) {
    const year = main?.name.trim() ?? "2026";
    for (let r = 2; r <= inc.rowCount; r++) {
      const row = inc.getRow(r);
      const c = (i: number) => cellValue(row.getCell(i + 1).value);
      const month = MONTHS.indexOf(str(c(0)).trim());
      if (month < 0) continue;
      const day = `${year}-${String(month + 1).padStart(2, "0")}-01`;
      for (const [i, currency] of [[1, "USD"], [2, "RUB"]] as const) {
        const amount = num(c(i));
        if (!amount) continue;
        const id = await saveOnce(store, u, `xlsx:income:${r}:${currency}`, `${MONTHS[month]}: ${amount} ${currency}`, day);
        if (!id) {
          rep.skipped++;
          continue;
        }
        await store.addMoney({
          user_id: u.id, day_key: day, kind: "income", amount, currency, category: "заказ",
          note: `доход за ${MONTH_GEN[month]} (из Excel)`, message_id: id,
        });
        rep.money++;
      }
    }
    // Свободные заметки (долги, подписки): всё, что не месяц и не сумма в своих столбцах.
    const notes: string[] = [];
    for (let r = 1; r <= inc.rowCount; r++) {
      const vals = [];
      const row = inc.getRow(r);
      for (let i = 4; i < Math.min(row.cellCount, 40); i++) {
        const v = cellValue(row.getCell(i + 1).value);
        if (v != null && str(v) !== "Дата") vals.push(str(v));
      }
      if (vals.length) notes.push(vals.join(" "));
    }
    for (const [i, n] of notes.entries()) {
      const id = await saveOnce(store, u, `xlsx:income-note:${i}:${n.slice(0, 40)}`, n, isoDay(new Date()));
      if (!id) {
        rep.skipped++;
        continue;
      }
      await store.addMemory(u.id, "fact", "Деньги", n, id);
      rep.memory++;
    }
  }
  return rep;
}

export function reportText(r: ImportReport): string {
  const lines = [
    `Дней дневника: ${r.days}`,
    `  по месяцам: ${Object.entries(r.byMonth).map(([k, v]) => `${k} ${v}`).join(", ") || "—"}`,
    `Записей дневника: ${r.diary} (${Object.entries(r.bySection).map(([k, v]) => `${k} ${v}`).join(", ") || "—"})`,
    `Показателей: ${r.metrics} (${Object.entries(r.byMetric).map(([k, v]) => `${k} ${v}`).join(", ") || "—"})`,
    `Дней активности ПК и игр: ${r.activity}`,
    `Планов: ${r.events}, задач: ${r.tasks}, дат: ${r.dates}`,
    `Памяти (планы месяцев, заметки о деньгах): ${r.memory}`,
    `Доходов: ${r.money}`,
    `Уже было в базе (пропущено): ${r.skipped}`,
  ];
  for (const w of r.warnings) lines.push(`⚠ ${w}`);
  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
  if (!file) throw new Error("укажите файл: npm run import -- <файл.xlsx> [--login <логин>]");
  const li = args.indexOf("--login");
  const store = await Store.open(config.databaseUrl || config.dbFile);
  try {
    let u: User | undefined;
    if (li >= 0) {
      u = await store.userByLogin(args[li + 1] ?? "");
      if (!u) throw new Error(`нет пользователя «${args[li + 1]}»`);
    } else {
      u = (await store.users())[0];
      if (!u && config.allowedChatIds[0]) u = await store.ensureUser(config.allowedChatIds[0], "", config.defaultTimezone);
      if (!u) throw new Error("в базе нет пользователей: создайте (npm run user -- create …) или укажите --login");
    }
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    console.log(`Импорт для #${u.id} ${u.login ?? ""}\n`);
    console.log(reportText(await importWorkbook(store, u, wb)));
  } finally {
    await store.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error("Ошибка:", (e as Error).message);
    process.exitCode = 1;
  });
}
