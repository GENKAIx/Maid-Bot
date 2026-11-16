// История писем горничной (screens/History.tsx): названия видов и отборы. Виды — те же, что NOTICE_KINDS на сервере
// (server/src/notices.ts).

export interface HistoryItem { id: number; kind: string; text: string; emotion: string; at: string }

/** Вид письма → короткая подпись у письма. */
export const KIND_NAMES: Record<string, string> = {
  morning: "Утро", tomorrow: "Завтра", evening: "Итог дня", plan: "План", habit: "Привычка", date: "Дата", game: "Игры",
  note: "Наблюдение", other: "Прочее",
};

/** Отборы над лентой: название кнопки и виды писем, которые она оставляет (пусто — все). */
export const HISTORY_FILTERS: { id: string; title: string; kinds: string[] }[] = [
  { id: "all", title: "Все", kinds: [] },
  { id: "daily", title: "Утро и вечер", kinds: ["morning", "tomorrow", "evening"] },
  { id: "plan", title: "Планы", kinds: ["plan"] },
  { id: "habit", title: "Привычки", kinds: ["habit"] },
  { id: "date", title: "Даты", kinds: ["date"] },
  { id: "game", title: "Игры", kinds: ["game"] },
  { id: "note", title: "Наблюдения", kinds: ["note"] },
  { id: "other", title: "Прочее", kinds: ["other"] },
];

/** Письма по дням (ключ ГГГГ-ММ-ДД по часам устройства), порядок писем и дней — как пришли: от свежих к старым. */
export function byDay(items: HistoryItem[], dayOf: (iso: string) => string): { day: string; items: HistoryItem[] }[] {
  const days: { day: string; items: HistoryItem[] }[] = [];
  for (const it of items) {
    const day = dayOf(it.at);
    if (days.at(-1)?.day === day) days.at(-1)!.items.push(it);
    else days.push({ day, items: [it] });
  }
  return days;
}
