import type { DiaryRow, MetricRow, MoneyRow, Store, User } from "./db.ts";
import { SECTIONS, HEALTH_TOPICS } from "./parse.ts";
import { diaryDigest } from "./report.ts";
import { addDays, daysBetween, humanDay } from "./time.ts";

// Вопросы по своим записям: «когда болело сердце?», «сколько потратил на еду в октябре?».
// Модель разбора даёт период и слова для поиска; здесь код находит записи и сам считает суммы —
// модели отвечающей остаётся только пересказать, числа она не складывает.

/** С какого дня искать, если период не назван: «когда болело сердце?» — за всё время. */
export const EVER = "2000-01-01";
const DIGEST_DAYS = 62;
const FOUND_MAX = 60;

const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е");

/** Записи дневника, где встречается хотя бы одно слово (корень). Новые — последними, не больше FOUND_MAX. */
export function matchDiary(rows: DiaryRow[], words: string[]): DiaryRow[] {
  const ws = words.map(norm).filter((w) => w.length >= 3);
  if (!ws.length) return [];
  const hit = rows.filter((r) => {
    const t = norm(`${r.text} ${r.topic} ${HEALTH_TOPICS[r.topic as keyof typeof HEALTH_TOPICS] ?? ""}`);
    return ws.some((w) => t.includes(w));
  });
  return hit.slice(-FOUND_MAX);
}

/** Деньги за период: итог по приходу/расходу и по категориям, отдельно по валютам. */
export function moneyTotals(rows: MoneyRow[]): string[] {
  const sum = new Map<string, number>();
  const add = (k: string, v: number) => sum.set(k, (sum.get(k) ?? 0) + v);
  for (const m of rows) {
    add(`${m.kind}|${m.currency}|*`, m.amount);
    add(`${m.kind}|${m.currency}|${m.category}`, m.amount);
  }
  const out: string[] = [];
  for (const kind of ["expense", "income"] as const) {
    for (const [k, v] of [...sum].filter(([k]) => k.startsWith(kind + "|") && k.endsWith("|*"))) {
      const cur = k.split("|")[1];
      const cats = [...sum]
        .filter(([c]) => c.startsWith(`${kind}|${cur}|`) && !c.endsWith("|*"))
        .sort((a, b) => b[1] - a[1])
        .map(([c, n]) => `${c.split("|")[2]} ${fmt(n)}`);
      out.push(`${kind === "expense" ? "Расход" : "Приход"} всего ${fmt(v)} ${cur}; по категориям: ${cats.join(", ")}`);
    }
  }
  return out;
}

/** Показатели за период: среднее, меньше-больше и сколько дней записано. */
export function metricStats(rows: MetricRow[]): string[] {
  const by = new Map<string, MetricRow[]>();
  for (const m of rows) by.set(m.key, [...(by.get(m.key) ?? []), m]);
  return [...by.values()].map((l) => {
    const v = l.map((m) => m.value);
    const min = l.reduce((a, b) => (b.value < a.value ? b : a));
    const max = l.reduce((a, b) => (b.value > a.value ? b : a));
    const avg = v.reduce((a, b) => a + b, 0) / v.length;
    const u = l[0].unit ? " " + l[0].unit : "";
    return `${l[0].label}: дней ${l.length}, среднее ${fmt(avg)}${u}, меньше всего ${fmt(min.value)}${u} (${min.day_key}), больше всего ${fmt(max.value)}${u} (${max.day_key})`;
  });
}

const fmt = (n: number) => (Math.round(n * 100) / 100).toLocaleString("ru-RU");

/** Всё, что нужно модели для ответа: найденные записи, дневник за период, точные итоги. */
export async function answerData(store: Store, u: User, range: { from: string; to: string }, words: string[]): Promise<string> {
  const parts: string[] = [];
  if (words.length) {
    const found = matchDiary(await store.diaryRange(u.id, range.from, range.to), words);
    const lines = found.map((r) => `${r.day_key} ${SECTIONS[r.section as keyof typeof SECTIONS] ?? r.section}${r.topic ? " / " + (HEALTH_TOPICS[r.topic as keyof typeof HEALTH_TOPICS] ?? r.topic) : ""}: ${r.text}`);
    parts.push(`Записи со словами «${words.join("», «")}» (${found.length}):\n${lines.join("\n") || "не найдено"}`);
  }
  const money = moneyTotals(await store.moneyRange(u.id, range.from, range.to));
  const metrics = metricStats(await store.metricsRange(u.id, range.from, range.to));
  if (money.length || metrics.length) parts.push(`Итоги за ${range.from}…${range.to} (посчитано точно, бери числа отсюда):\n${[...money, ...metrics].join("\n")}`);
  // Дневник целиком — только за короткий период, иначе он не влезет; при поиске хватает найденного.
  if (!words.length || daysBetween(range.from, range.to) <= DIGEST_DAYS) {
    const from = daysBetween(range.from, range.to) > DIGEST_DAYS ? addDays(range.to, -DIGEST_DAYS) : range.from;
    parts.push(`Дневник ${from}…${range.to}:\n${await diaryDigest(store, u, from, range.to)}`);
  }
  return parts.join("\n\n");
}

/** Дни, на которые сослался ответ: даты ГГГГ-ММ-ДД заменяются на «8 ноября», ссылки — строкой в конце. */
export function linkDays(answer: string, publicUrl: string, today: string, max = 8): { text: string; days: string[] } {
  const days: string[] = [];
  const text = answer.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (d) => {
    if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(d)) return d;
    if (!days.includes(d)) days.push(d);
    return humanDay(d, d.slice(0, 4) !== today.slice(0, 4)).split(",")[0];
  });
  const shown = days.slice(0, max);
  if (!shown.length) return { text, days };
  const links = shown.map((d) => (publicUrl ? `<a href="${publicUrl}/diary/${d}">${short(d)}</a>` : short(d))).join(" · ");
  return { text: `${text}\n📅 ${links}`, days: shown };
}

const short = (d: string) => humanDay(d).split(",")[0];
