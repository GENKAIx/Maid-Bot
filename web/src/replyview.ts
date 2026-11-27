// Чистая логика строки ввода (Composer.tsx), без React: id черновика, состояние ответа и чем его повторить.
// Правила — docs/ДИЗАЙН.md 5.7–5.8 (решение 23): ответ висит до следующей отправки или крестика; три состояния ответа —
// сохранено, не сохранено, нужно уточнение; несохранённое не пропадает.
import { ApiError } from "./api";
import type { Reply } from "./types";

/** Черновик отправки: id живёт, пока не изменилось содержимое (key) и сервер не ответил успехом. */
export interface Draft { key: string; id: string }

/** Отпечаток содержимого строки: текст и приложенные картинки (по длине и хвосту данных — сами данные большие). */
export function draftKey(text: string, pictures: { data: string }[] = []): string {
  return [text.trim(), ...pictures.map((p) => `${p.data.length}:${p.data.slice(-24)}`)].join("\u0000");
}

/** Id для отправки. То же содержимое после сбоя — прежний id: сервер узнаёт повтор и не пишет второй раз.
 *  Новый id — когда текст или картинки изменились либо прежнюю отправку сервер принял (тогда prev — null). */
export function draftFor(prev: Draft | null, key: string, newId: () => string): Draft {
  return prev && prev.key === key ? prev : { key, id: newId() };
}

/** Что висит над строкой ввода. */
export interface Shown {
  text: string;
  /** Ответ сервера на запись: по нему кнопки «Отменить», дни, наложение планов, вопрос «добавить?». */
  reply?: Reply;
  error?: boolean;
  /** Ссылка на оплату (сервер ответил 402). */
  pay?: string;
  /** Идёт работа: «Распознаю…», «Смотрю…». */
  wait?: boolean;
  /** Отправка не дошла или сервер отказал: «Повторить» шлёт то же ещё раз с тем же id — строку ввода или запись голоса. */
  again?: "draft" | "voice";
  /** Исходная фраза вопроса: закрыли вопрос крестиком — она возвращается в строку ввода. */
  sent?: string;
  /** Сбой кнопки внутри плашки (отмена, повтор, закрытие вопроса): плашка и её кнопки остаются, причина — строкой. */
  problem?: string;
  /** Строка под ответом про другое действие: ответ на фразу, которая вопрос не закрыла (вопрос остаётся), либо итог
   *  кнопки прежней плашки, пришедший уже после новой отправки. */
  aside?: string;
}

/** Состояние плашки. Три состояния ответа из 5.8 — saved, unsaved, clarify; wait — ещё нет ответа; error — сбой без записи
 *  (микрофон, картинка, кнопка), не про сохранение. */
export type ReplyState = "wait" | "saved" | "unsaved" | "clarify" | "error";

export function replyState(s: Shown): ReplyState {
  if (s.wait) return "wait";
  if (s.reply?.clarify) return "clarify";
  if (s.reply?.failed || s.again) return "unsaved";
  return s.error ? "error" : "saved";
}

/** Подпись состояния в плашке. У «сохранено» подписи нет: что записано, говорит сам ответ. */
export function stateLabel(st: ReplyState): string {
  return st === "unsaved" ? "Не сохранено" : st === "clarify" ? "Нужно уточнение" : "";
}

/** Красная ли плашка и её роль для экранного диктора. Отказ с оплатой (pay) не красный, но тоже «не сохранено». */
export function stateLook(s: Shown): { bad: boolean; role: "alert" | "status" } {
  const st = replyState(s);
  const bad = st === "error" || (st === "unsaved" && !s.pay);
  return { bad, role: st === "error" || st === "unsaved" ? "alert" : "status" };
}

/** Оставить ли набранное в строке после ответа сервера. Обычно нет: фраза либо записана, либо лежит на сервере (failed —
 *  её повторит кнопка и сам сервер). Исключение — сбой разбора сообщения с картинками: картинки сервер не хранит. */
export function keepDraft(r: { failed?: boolean }, withPictures: boolean): boolean {
  return Boolean(r.failed) && withPictures;
}

/** Вопрос before всё ещё ждёт ответа после ответа r на новую фразу: сервер назвал его номер в waiting. Тогда вопрос
 *  с экрана не уходит — иначе закрыть его было бы нечем, а следующая фраза приклеилась бы к нему. */
export function stillAsked(before: Shown | null, r: { waiting?: number }): before is Shown {
  return Boolean(before?.reply?.clarify && r.waiting && before.reply.messageId === r.waiting);
}

/** Плашка вопроса, который остался ждать. Ответ на вопрос не разобрался (failed) — причина строкой и «Повторить» тем же
 *  способом (way); пришёл ответ на другую фразу (погода, картинка) — он строкой под вопросом (aside). */
export function keepQuestion(before: Shown, r: { failed?: boolean }, text: string, way?: "draft" | "voice"): Shown {
  return r.failed ? { ...before, problem: text, again: way, aside: undefined } : { ...before, aside: text, problem: undefined, again: undefined };
}

/** Плашка, которую нельзя заменить гаснущей ошибкой (нет микрофона, картинка не открылась): ответ с записью, вопрос,
 *  несохранённое, отказ с оплатой — они висят до следующей отправки или крестика (решение 23). Ход работы («Смотрю…»)
 *  и короткие итоги кнопок заменять можно. */
export function holdsPlace(s: Shown | null): boolean {
  return Boolean(s && !s.wait && (s.reply || s.again || s.pay));
}

/** Чем повторить несохранённое: draft — строка ввода с прежним id; voice — та же запись голоса; message — фраза лежит
 *  на сервере (POST /api/messages/:id/retry). Нечего — null. */
export function retryWay(s: Shown): "message" | "draft" | "voice" | null {
  if (s.again) return s.again;
  return s.reply?.failed ? "message" : null;
}

/** «Оставить заметкой» есть, когда фраза лежит на сервере и не записана: сбой разбора или вопрос без ответа. */
export function canNote(s: Shown): boolean {
  return Boolean(s.reply && s.reply.messageId > 0 && (s.reply.failed || s.reply.clarify));
}

/** Есть ли смысл повторять ту же отправку после ошибки: нет связи, сбой сервера, отказ по частоте или лимиту — да;
 *  «пустое сообщение», «слишком длинная запись», «ничего не услышала» — тот же запрос даст тот же отказ. */
export function retryable(err: unknown): boolean {
  if (!(err instanceof ApiError)) return true;
  return err.status >= 500 || err.status === 402 || err.status === 408 || err.status === 429;
}

/** Вопрос «добавить?» ещё открыт — показывать пункты и кнопки. */
export function openProposal(s: Shown | null) {
  const p = s?.reply?.proposal;
  return p && p.status === "open" ? p : null;
}

/** Отмеченные пункты вопроса «добавить?» после щелчка по галочке, по возрастанию. */
export function togglePick(picked: number[], i: number): number[] {
  return (picked.includes(i) ? picked.filter((x) => x !== i) : [...picked, i]).sort((a, b) => a - b);
}
