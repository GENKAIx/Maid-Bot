// «Витрина» админки (этап 4, 24.11.2026; screens/AdminShowcase.tsx) без React: типы реестра (web/src/registry.gen.ts — его
// пишет tools/registry/make_registry.ts из настоящих исходников), счёт времени проигрывателя и подписи. Ревью —
// docs/review/админка-2026-11-24.html, раздел «Витрина функций и анимаций».

export type AnimGroup = "base" | "event" | "once";
export interface AnimInfo {
  id: string; name: string; group: AnimGroup;
  /** Основа при просроченных задачах (fun.js dueMood). */
  due?: boolean;
  /** Эмоции ответа сервера, которые включают эту анимацию (EMOTION_MOOD в widget.js). */
  emotions: string[];
  /** Сайт (web/public/maid): кадры, длительность круга, холст, вес файла. */
  frames: number; ms: number; w: number; h: number; bytes: number;
  /** Программа на ПК (desktop/assets/maid): вдвое больше кадров и холст 400×427. */
  desk: { frames: number; w: number; h: number };
}
export interface Registry {
  anims: AnimInfo[];
  effects: {
    wordfx: { id: string; ru: string; text: string }[];
    bubble: { id: string; kind: "shape" | "mark"; text: string }[];
    weather: { id: string; text: string }[];
    gait: { id: string; emotions: string[]; animation: string; keyframes: string }[];
    holidays: { title: string; text: string }[];
  };
  map: {
    site: { id: string; path: string; title: string; feature: string }[];
    windows: { file: string; title: string; text: string; feature?: string }[];
    bot: { cmd: string; title: string; owner: boolean; feature?: string }[];
    features: { id: string; title: string; group: string; by: "client" | "server" }[];
    groups: Record<string, string>;
  };
}

export const ANIM_GROUPS: Record<AnimGroup, string> = { base: "основа", event: "по событию", once: "один раз" };

/** Когда играет анимация — по-человечески. */
export function animWhen(a: AnimInfo): string {
  if (a.group === "base") return "основа (baseMood)";
  if (a.group === "once") return "один раз, по событию";
  return a.due ? "по событию; основа при просроченных задачах" : "по событию";
}

/** Скорости проигрывателя. */
export const PLAYER_SPEEDS = [0.25, 0.5, 1, 2];

/** Шаг проигрывателя: с кадра i прошло dt мс (уже с учётом скорости) и накоплено carry мс внутри кадра. Возвращает новый
 *  кадр, остаток и «дошли до конца» (без повтора — стоим на последнем кадре). durations — мс каждого кадра. */
export function playerStep(durations: number[], i: number, carry: number, dt: number, loop: boolean): { i: number; carry: number; end: boolean } {
  const n = durations.length;
  if (!n) return { i: 0, carry: 0, end: true };
  let t = carry + Math.max(0, dt);
  // Длинный провал (вкладка спала) — не крутить тысячи кругов: только остаток от длины круга.
  const total = durations.reduce((a, b) => a + Math.max(1, b), 0);
  if (loop && t > total) t %= total;
  for (let guard = 0; guard <= n * 2; guard++) {
    const d = Math.max(1, durations[i]);
    if (t < d) return { i, carry: t, end: false };
    t -= d;
    if (i + 1 < n) i++;
    else if (loop) i = 0;
    else return { i: n - 1, carry: 0, end: true };
  }
  return { i, carry: 0, end: false };
}

/** Момент начала кадра i, мс. */
export const frameStart = (durations: number[], i: number) => durations.slice(0, i).reduce((a, b) => a + b, 0);

/** Вес файла: 290 000 → «283 КБ», 1 600 000 → «1.5 МБ». */
export function sizeText(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} КБ` : `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

/** Секунды: 3000 → «3 с», 5478 → «5.5 с». */
export function secText(ms: number): string {
  const s = Math.round(ms / 100) / 10;
  return `${Number.isInteger(s) ? s : s.toFixed(1)} с`;
}

// ——— Карта функций и числа этапа 3 (/api/admin/features).
/** missing — фичи нет в отчёте: реестр новее сервера (у сервера такого счётчика ещё нет), это не «не используется». */
export type UsageNum = { uses30: number; people30: number; missing?: boolean };

/** Счёт фичи за 30 дней по отчёту «Использование функций»; нет фичи у пункта или нет отчёта — null. */
export function usageIndex(report: { features: { id: string; all: UsageNum }[] } | null): (id: string | undefined) => UsageNum | null {
  const by = new Map((report?.features ?? []).map((f) => [f.id, f.all]));
  return (id) => (id && report ? by.get(id) ?? { uses30: 0, people30: 0, missing: true } : null);
}

/** Сколько пунктов в группе карты использовались за 30 дней (у пунктов без фичи — не в счёт). */
export function usedCount(ids: (string | undefined)[], usage: (id: string | undefined) => UsageNum | null): { used: number; counted: number } {
  const known = ids.filter((x): x is string => Boolean(x));
  return { used: known.filter((id) => (usage(id)?.uses30 ?? 0) > 0).length, counted: known.length };
}
