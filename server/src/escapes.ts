import type { TaskRow } from "./db.ts";
import { esc } from "./report.ts";
import { dayKey } from "./time.ts";

// Недельная сводка «сбежали от задач»: задачи, закрытые крестиком без ответа (dodged), за последние 7 дней.
// Горничная мягко говорит, сколько и от чего чаще всего. Вид задачи — по словам в названии, иначе её категория.

const KINDS: [RegExp, string][] = [
  [/звон|созвон|набрать|перезвон/, "звонков"],
  [/напис|ответ|письм|почт|сообщ|мейл|email/, "переписки"],
  [/куп|заказ|магазин|продукт/, "покупок"],
  [/убра|убор|помы|стир|поглад|пылесос|мусор/, "уборки"],
  [/оплат|счёт|счет|налог|банк|квитанц|штраф/, "оплат"],
  [/врач|стомат|анализ|клиник|больниц|запис[ао]т/, "врачей"],
  [/трен|спорт|зал|бег|пробеж|растяж|йог/, "спорта"],
  [/учи|урок|курс|прочит|книг|экзамен|домашк/, "учёбы"],
  [/документ|паспорт|справк|заявлен|отчёт|отчет/, "бумажных дел"],
];

/** Вид задачи для сводки: «звонков», «покупок»… или категория; null — не понять. */
export function escapeKind(t: Pick<TaskRow, "title" | "category">): string | null {
  const s = t.title.toLowerCase();
  for (const [re, name] of KINDS) if (re.test(s)) return name;
  return t.category.trim() ? t.category.trim().toLowerCase() : null;
}

const tasksWord = (n: number) => {
  const d = n % 10, h = n % 100;
  return d === 1 && h !== 11 ? "задачи" : "задач";
};

/** Текст сводки за 7 дней до today (включительно) или null, если не сбегали. */
export function escapesText(tasks: TaskRow[], today: string, tz: string): string | null {
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - 6 * 864e5).toISOString().slice(0, 10);
  const ran = tasks.filter((t) => {
    if (t.status !== "dodged" || !t.closed_at) return false;
    const day = dayKey(new Date(t.closed_at), tz);
    return day >= from && day <= today;
  });
  if (!ran.length) return null;
  const count = new Map<string, number>();
  for (const t of ran) {
    const k = escapeKind(t);
    if (k) count.set(k, (count.get(k) ?? 0) + 1);
  }
  const top = [...count].sort((a, b) => b[1] - a[1]);
  // «Чаще всего» — только если вид явно впереди: хотя бы 2 раза и больше любого другого.
  const most = top[0] && top[0][1] >= 2 && (top.length === 1 || top[0][1] > top[1][1]) ? top[0][0] : null;
  const n = ran.length;
  const head = `🏃 За неделю вы убежали от ${n} ${tasksWord(n)}${most ? ` — чаще всего от ${esc(most)}` : ""}.`;
  const names = ran.slice(-3).map((t) => `«${esc(t.title)}»`).join(", ");
  const tail = n >= 4
    ? "Ничего страшного, но, может, на следующей неделе брать поменьше? Я помогу выбрать главное."
    : "Бывает. Если задача не нужна — её можно смело отменить, а не убегать 🙂";
  return `${head}\nНапример: ${names}.\n${tail}`;
}
