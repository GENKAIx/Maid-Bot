import type { AccountRow, Store } from "./db.ts";
import { esc } from "./report.ts";
import { dayKey, timeOf } from "./time.ts";

// Сводка аккаунтов для владельца (команда /accounts): кто есть, кто когда писал, сколько, и сколько ушло на ИИ.
// Расход по людям пишется с шага 14 базы (llm.ts, asUser); раньше — одной суммой, она в строке «Ничей и до учёта по людям».

export const ACCOUNTS_DAYS = 7;

const usd = (n: number) => `$${n < 10 ? n.toFixed(2) : n.toFixed(1)}`;

/** «сегодня 13:20» / «вчера 09:05» / «12.11» / «ещё не писал(а)». */
function lastSeen(iso: string | null, now: Date, tz: string): string {
  if (!iso) return "ещё не писал(а)";
  const at = new Date(iso);
  const day = dayKey(at, tz), today = dayKey(now, tz), yesterday = dayKey(new Date(now.getTime() - 86_400_000), tz);
  if (day === today) return `сегодня ${timeOf(at, tz)}`;
  if (day === yesterday) return `вчера ${timeOf(at, tz)}`;
  return `${day.slice(8)}.${day.slice(5, 7)}`;
}

export async function accountsText(store: Store, owners: string[], tz: string, now = new Date()): Promise<string> {
  const month = dayKey(now, tz).slice(0, 7);
  const rows = await store.accounts(month, new Date(now.getTime() - ACCOUNTS_DAYS * 86_400_000).toISOString());
  const people = rows.filter((r) => r.id !== 0);
  const nobody = rows.find((r) => r.id === 0);
  const line = (r: AccountRow) => {
    const who = `<b>${esc(r.name || r.login || `#${r.id}`)}</b>${r.login ? ` · ${esc(r.login)}` : ""}${r.chat_id && owners.includes(r.chat_id) ? " · вы" : ""}`;
    const since = r.created_at ? ` · с ${r.created_at.slice(8, 10)}.${r.created_at.slice(5, 7)}` : "";
    return `${who}${since}\n  писал(а): ${lastSeen(r.last_at, now, tz)} · сообщений за ${ACCOUNTS_DAYS} дн.: ${r.recent}\n  ИИ: ${usd(r.month)} за месяц · ${usd(r.total)} всего`;
  };
  const sumMonth = rows.reduce((s, r) => s + r.month, 0);
  return [
    `<b>Аккаунты: ${people.length}</b>`,
    ...people.map(line),
    ...(nobody ? [`Ничей и до учёта по людям: ${usd(nobody.month)} за месяц · ${usd(nobody.total)} всего`] : []),
    `Всего на ИИ за месяц: ${usd(sumMonth)}`,
  ].join("\n\n");
}
