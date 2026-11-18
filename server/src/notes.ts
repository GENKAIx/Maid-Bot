import type { NoteRow } from "./db.ts";

// Заметки «на потом»: что посмотреть, во что поиграть, что почитать, идеи — то, что записывают без дня и времени, чтобы
// потом найти. Каждая заметка лежит на полке; разбор раскладывает сам (parse.ts, stash), полку можно поменять.
// «Что посмотреть?» — ответ по полкам (pipeline.answer → notesData). Страница — «Заметки» (web, Notes.tsx).

export const SHELVES = { film: "Фильмы", series: "Сериалы", game: "Игры", book: "Книги", idea: "Идеи", other: "Прочее" } as const;
export type Shelf = keyof typeof SHELVES;
export const SHELF_KEYS = Object.keys(SHELVES) as Shelf[];
/** Полки «посмотреть, поиграть, почитать»: у их заметок есть «готово» с оценкой. У идей и прочего — только «готово». */
export const RATED_SHELVES: Shelf[] = ["film", "series", "game", "book"];

export const NOTE_TITLE_MAX = 200;
export const NOTE_TEXT_MAX = 500;
/** Сколько заметок с полки уходит модели в ответ на «что посмотреть?». */
const ANSWER_MAX = 60;

const ALIASES: Record<string, Shelf> = {
  films: "film", movie: "film", movies: "film", фильм: "film", фильмы: "film", кино: "film",
  serial: "series", serials: "series", show: "series", tv: "series", anime: "series", сериал: "series", сериалы: "series", аниме: "series",
  games: "game", игра: "game", игры: "game",
  books: "book", книга: "book", книги: "book",
  ideas: "idea", идея: "idea", идеи: "idea",
  others: "other", misc: "other", прочее: "other", другое: "other",
};

/** Полка по слову модели или пользователя; незнакомое — null. */
export function shelfKey(s: string | null | undefined): Shelf | null {
  const k = (s ?? "").trim().toLowerCase();
  return (SHELF_KEYS as string[]).includes(k) ? (k as Shelf) : ALIASES[k] ?? null;
}

const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\d]+/gu, " ").trim();
/** Одно и то же название: без регистра, «ё» и знаков («Дюна 2» и «дюна-2»). */
export const sameNote = (a: string, b: string) => norm(a) === norm(b);

/** Сколько заметок ждёт на каждой полке — виджету ПК для подсказок («Что посмотреть?» — только когда есть что). */
export function noteCounts(rows: NoteRow[]): Record<Shelf, number> {
  const out = Object.fromEntries(SHELF_KEYS.map((k) => [k, 0])) as Record<Shelf, number>;
  for (const n of rows) if (n.status === "open" && n.shelf in out) out[n.shelf as Shelf]++;
  return out;
}

/** Давность словами — датой нельзя: даты в ответах становятся ссылками на дневник (ask.linkDays). */
function ago(iso: string, now: Date): string {
  const days = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000));
  if (days < 1) return "сегодня";
  if (days < 7) return `${days} дн. назад`;
  if (days < 60) return `${Math.floor(days / 7)} нед. назад`;
  if (days < 730) return `${Math.floor(days / 30)} мес. назад`;
  return `${Math.floor(days / 365)} г. назад`;
}

/** Заметки для ответа на вопрос. shelves — с каких полок (пусто — со всех), words — корни слов (пусто — все заметки полок).
 *  Открытые — свежие первыми, не больше ANSWER_MAX на полку; готовые — последние, с оценками. Пустая строка — нечего показать. */
export function notesData(rows: NoteRow[], shelves: Shelf[], words: string[], now = new Date()): string {
  const ws = words.map(norm).filter((w) => w.length >= 3);
  const fits = (n: NoteRow) => !ws.length || ws.some((w) => norm(`${n.title} ${n.note}`).includes(w));
  const out: string[] = [];
  for (const shelf of shelves.length ? shelves : SHELF_KEYS) {
    const mine = rows.filter((n) => n.shelf === shelf && fits(n));
    const open = mine.filter((n) => n.status === "open");
    const done = mine.filter((n) => n.status === "done");
    if (!open.length && !done.length) {
      if (shelves.length && !ws.length) out.push(`Полка «${SHELVES[shelf]}»: пусто.`);
      continue;
    }
    const line = (n: NoteRow) => `- ${n.title}${n.note ? ` (${n.note})` : ""} — записано ${ago(n.created_at, now)}`;
    out.push(`Полка «${SHELVES[shelf]}», ждёт: ${open.length}${open.length > ANSWER_MAX ? ` (показаны ${ANSWER_MAX})` : ""}\n${open.slice(0, ANSWER_MAX).map(line).join("\n") || "- ничего"}`);
    if (done.length) {
      out.push(`Полка «${SHELVES[shelf]}», уже готово: ${done.length}\n${done.slice(0, 15).map((n) => `- ${n.title}${n.rating ? ` — оценка ${n.rating}/10` : ""}`).join("\n")}`);
    }
  }
  return out.join("\n");
}
