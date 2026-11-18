import type { NoteRow } from "./types";

// Экран «Заметки» (screens/Notes.tsx): что на какой полке показать, давность записи и «Случайное». Без React — проверяется тестом.

const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е");

/** Заметки полки (shelf «all» — со всех) со всеми словами запроса в названии или пометке. Порядок — как пришли (свежие первыми). */
export function shownNotes(notes: NoteRow[], shelf: string, query: string): NoteRow[] {
  const words = norm(query).split(/\s+/).filter(Boolean);
  return notes.filter((n) => (shelf === "all" || n.shelf === shelf) && words.every((w) => norm(`${n.title} ${n.note}`).includes(w)));
}

/** Сколько заметок ждёт на каждой полке; all — всего. */
export function shelfCounts(notes: NoteRow[]): Record<string, number> {
  const out: Record<string, number> = { all: 0 };
  for (const n of notes) {
    if (n.status !== "open") continue;
    out.all++;
    out[n.shelf] = (out[n.shelf] ?? 0) + 1;
  }
  return out;
}

/** Давность записи: «сегодня», «вчера», «5 дн.», «3 нед.», «4 мес.», «2 г.». */
export function noteAge(iso: string, now = new Date()): string {
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.max(0, Math.round((day(now) - day(new Date(iso))) / 86_400_000));
  if (days === 0) return "сегодня";
  if (days === 1) return "вчера";
  if (days < 14) return `${days} дн.`;
  if (days < 60) return `${Math.floor(days / 7)} нед.`;
  if (days < 730) return `${Math.floor(days / 30)} мес.`;
  return `${Math.floor(days / 365)} г.`;
}

/** «Случайное»: любая из ждущих, но не та, что выпала прошлый раз (если есть из чего выбирать). Нечего выбирать — null. */
export function randomNote(notes: NoteRow[], lastId: number | null, rnd = Math.random): NoteRow | null {
  const open = notes.filter((n) => n.status === "open");
  const pool = open.length > 1 ? open.filter((n) => n.id !== lastId) : open;
  return pool.length ? pool[Math.min(pool.length - 1, Math.floor(rnd() * pool.length))] : null;
}
