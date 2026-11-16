import type { NoticeRow, Store } from "./db.ts";

// История писем горничной (сайт → «Ещё → История»): всё, что она присылала сама — утро, итоги, напоминания, — с видом
// письма, чтобы отбирать по нему. Вид ставит тот, кто отправляет (пятый аргумент Send), и он лежит в notices.kind.

/** Виды писем; other — без вида (например, «так и не смогла разобрать…»). */
export const NOTICE_KINDS = ["morning", "tomorrow", "evening", "plan", "habit", "date", "game", "note", "other"] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

/** Сколько последних писем сервер хранит на человека (старше — удаляются при каждой отправке). */
export const NOTICES_KEEP = 1000;

/** Вид отложенного или запланированного напоминания: вопрос про привычку (кнопки habit:) или план. */
export const reminderKind = (buttons?: { data: string }[]): NoticeKind => (buttons?.some((b) => b.data.startsWith("habit:")) ? "habit" : "plan");

// Письма, записанные до 17.11.2026, вида не имеют — он угадывается по кнопкам и началу текста. Новым письмам не нужно.
function oldKind(r: NoticeRow): NoticeKind {
  const b = r.buttons;
  if (b.includes('"habit:')) return "habit";
  if (b.includes('"rate:')) return "evening";
  if (b.includes('"trait:')) return "note";
  const t = r.text;
  if (t.startsWith("☀️")) return "morning";
  if (t.startsWith("🌙")) return "tomorrow";
  if (t.startsWith("🎂")) return "date";
  if (t.startsWith("🎮")) return "game";
  if (t.startsWith("⏰") || t.startsWith("📅")) return "plan";
  return "other";
}
export const kindOf = (r: NoticeRow): NoticeKind => ((NOTICE_KINDS as readonly string[]).includes(r.kind) ? (r.kind as NoticeKind) : oldKind(r));

export interface HistoryItem { id: number; kind: NoticeKind; text: string; emotion: string; at: string }

/** Письма от свежих к старым: только нужных видов (пусто — все), старше письма before, не больше limit; more — есть ли ещё. */
export async function historyOf(store: Store, userId: number, opts: { kinds?: NoticeKind[]; before?: number; limit?: number } = {}) {
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  const all = (await store.noticesAll(userId, NOTICES_KEEP))
    .map((r): HistoryItem => ({ id: r.id, kind: kindOf(r), text: r.text, emotion: r.emotion, at: r.at }))
    .filter((r) => (!opts.kinds?.length || opts.kinds.includes(r.kind)) && (!opts.before || r.id < opts.before));
  return { items: all.slice(0, limit), more: all.length > limit };
}
