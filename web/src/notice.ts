// Плашка сообщения на экранах сайта (components.tsx NoteBar, useNote): итог действия с «Отменить», сбой действия, сбой
// загрузки с «Повторить». Здесь — правила без React, чтобы их можно было проверить (test/notice.test.ts).

/** undo — номер для POST /api/undo (кнопка «Отменить»); bad — сбой: красная плашка, role="alert". */
export type Note = { text: string; undo?: number; bad?: boolean };

/** Итог с «Отменить» висит 8 секунд (docs/ДИЗАЙН.md, решение 18). */
export const NOTE_MS = 8000;

/** Сколько висит плашка: итог — NOTE_MS, сбой — 0 (до крестика или следующего действия, чтобы причину успели прочитать). */
export const noteMs = (n: Note): number => (n.bad ? 0 : NOTE_MS);

/** Сбой читается сразу (alert), итог — спокойно (status). */
export const noteRole = (n: Note): "alert" | "status" => (n.bad ? "alert" : "status");

/** Причина сбоя словами: «Не получилось …: причина». */
export const failNote = (what: string, e: unknown): Note => ({ text: `${what}: ${e instanceof Error && e.message ? e.message : "нет связи с сервером"}`, bad: true });

/** Запись в тексте плашки: длинная обрезается, чтобы плашка осталась в одну-две строки. */
export const shortText = (text: string, max = 60): string => (text.length > max ? `${text.slice(0, max).trimEnd()}…` : text);

/** Имя файла резервной копии из заголовка ответа; заголовка нет — обычное имя. */
export const backupName = (disposition: string | null): string => (disposition ?? "").match(/filename="([^"]+)"/)?.[1] ?? "maid-backup.json";

/** Сервер отказал в копии: причина из тела ответа ({ error }), иначе код ответа. Файл при этом не скачивается. */
export function backupProblem(status: number, body: unknown): string {
  const why = body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : "";
  return why || `сервер ответил ${status}`;
}
