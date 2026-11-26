// «Витрина» админки (этап 4, 24.11.2026; screens/AdminShowcase.tsx) без React: типы реестра (web/src/registry.gen.ts — его
// пишет tools/registry/make_registry.ts из настоящих исходников), счёт времени проигрывателя и подписи. Ревью —
// docs/review/админка-2026-11-24.html, раздел «Витрина функций и анимаций».
// Живой показ (25.11.2026): карточки (showcaseCards), примеры к эффектам, что проиграть в виджете (PreviewPlay — виды
// server/preview/control.js), поиск, кадр окна и какие виджеты держать живыми (liveSet).

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

// ——— Живой показ (25.11.2026): настоящий виджет в iframe (/admin-preview/renderer/widget.html, server/src/preview.ts) и что
// в нём проиграть. Карточки — из реестра (анимации, эффекты) и features.ts (сценарии): новая анимация или эффект в коде
// попадает в витрину сама, а показ без своего примера (WORDFX_SAMPLES и др.) — ошибка теста web/test/showcase.test.ts.

/** Что проиграть в виджете (server/preview/control.js, виды — PREVIEW_KINDS там же). */
export type PreviewPlay =
  | { kind: "anim"; id: string; ms: number }
  | { kind: "say"; text: string; own?: boolean; emotion: string; heard?: string; mark?: string }
  | { kind: "weather"; sky: string; icon: string; temp: string; text: string }
  | { kind: "holiday"; party: "flame" | "wave" | "salute"; tier?: number }
  | { kind: "scene"; demo: unknown };

export const PREVIEW_URL = "/admin-preview/renderer/widget.html";
/** Окно виджета на ПК (desktop/src/main.js WIDGET_W × WIDGET_H): iframe такого размера, уменьшенный под карточку. */
export const PREVIEW_W = 620, PREVIEW_H = 760;
/** Сколько виджетов живут на странице одновременно (каждый — целая страница виджета). С 26.11.2026 виджет запускается только по
 *  «играть» (остальные карточки — с неподвижным первым кадром), живыми остаются играющая и недавно запущенные на экране. */
export const PREVIEW_LIVE_MAX = 3;
/** «Медленно» — вчетверо. */
export const PREVIEW_SLOW = 0.25;
/** Сколько ещё ждать конца показа (реального времени, мс): показ длится ms мс своего времени, done уже прошло, k — скорость
 *  (PREVIEW_SLOW — вчетверо дольше); плюс 1,5 с, чтобы итог было видно. */
export const previewRemain = (ms: number, done: number, k: number) => Math.max(0, ms - done) / (k > 0 ? k : 1) + 1500;

/** Идущий показ карточки: ms — длина своего времени, done — сколько его уже прошло, k — скорость, at — когда (performance.now)
 *  виджет начал показ; null — ещё не начал: виджет грузится (страница, скрипты, данные дня), отсчёт конца не идёт. */
export type ShowRun = { key: string; ms: number; done: number; at: number | null; k: number };
/** Нажали «играть» (или «ещё раз», настроение): показ ждёт, пока виджет примет команду play. */
export const runPlay = (key: string, ms: number, k: number): ShowRun => ({ key, ms, done: 0, at: null, k });
/** Виджет готов и команда play ушла — показ пошёл с начала, с этой минуты отсчитывается конец. Чужая карточка — без изменений. */
export const runStarted = (r: ShowRun | null, key: string, now: number): ShowRun | null => (r && r.key === key ? { ...r, done: 0, at: now } : r);
/** «Медленно» переключили: прошедшее своё время копится по прежней скорости; показ ещё не начался — только новая скорость. */
export const runSpeed = (r: ShowRun | null, key: string, k: number, now: number): ShowRun | null =>
  !r || r.key !== key ? r : r.at === null ? { ...r, k } : { ...r, done: r.done + (now - r.at) * r.k, at: now, k };
/** Через сколько мс снять показ; null — виджет ещё не начал, таймер не ставится (карточка остаётся играющей и дождётся ready). */
export const runRemain = (r: ShowRun | null): number | null => (!r || r.at === null ? null : previewRemain(r.ms, r.done, r.k));

/** Клавиша большого просмотра → действие: Esc — закрыть, ← → — соседние карточки. Стрелки в поле ввода и уже обработанные
 *  (покадровый проигрыватель шагает ими по кадрам) карточки не листают. Клавиши из виджета (control.js шлёт ev "key") — те же. */
export function bigViewKey(key: string, opts: { field?: boolean; handled?: boolean } = {}): "close" | "prev" | "next" | null {
  if (key === "Escape") return "close";
  if ((key !== "ArrowLeft" && key !== "ArrowRight") || opts.field || opts.handled) return null;
  return key === "ArrowLeft" ? "prev" : "next";
}

export type ShowGroup = "anim-base" | "anim-event" | "anim-once" | "wordfx" | "bubble" | "gait" | "weather" | "holiday" | "scene";
export const SHOW_GROUPS: { id: ShowGroup; title: string; src: string }[] = [
  { id: "anim-base", title: "Анимации: основа", src: "widget.js baseMood" },
  { id: "anim-event", title: "Анимации: по событию", src: "widget.js react" },
  { id: "anim-once", title: "Анимации: один раз", src: "widget.js forgetFlash" },
  { id: "wordfx", title: "Слова с характером", src: "wordfx.js" },
  { id: "bubble", title: "Облачко", src: "bubblefx.js" },
  { id: "gait", title: "Походка букв", src: "style.css, widget.js TYPE_GAIT" },
  { id: "weather", title: "Погода над панелью", src: "weather.js" },
  { id: "holiday", title: "Праздники привычек", src: "habitparty.js" },
  { id: "scene", title: "Сценарии «Возможностей»", src: "web/src/features.ts" },
];
/** Кнопки фильтра: группы анимаций — одной кнопкой. */
export type ShowFilter = "all" | "anim" | ShowGroup;
export const SHOW_FILTERS: { id: ShowFilter; title: string }[] = [
  { id: "all", title: "Все" }, { id: "anim", title: "Анимации" }, { id: "wordfx", title: "Слова" }, { id: "bubble", title: "Облачко" },
  { id: "gait", title: "Походка" }, { id: "weather", title: "Погода" }, { id: "holiday", title: "Праздники" }, { id: "scene", title: "Сценарии" },
];

/** Эмоции ответа сервера (server/src/personas.ts EMOTIONS) — выбор настроения у реплик. */
export const SHOW_EMOTIONS = ["neutral", "happy", "proud", "worried", "stern", "sleepy", "surprised", "sad", "teasing", "awkward", "deadpan"];
export const EMOTION_NAMES: Record<string, string> = {
  neutral: "спокойно", happy: "радостно", proud: "гордо", worried: "тревожно", stern: "строго", sleepy: "сонно", surprised: "удивлённо",
  sad: "грустно", teasing: "с подколкой", awkward: "неловко", deadpan: "невозмутимо", excited: "восторженно", love: "нежно", angry: "сердито", annoyed: "раздражённо",
};

/** Примеры слов с характером: пометка [имя]слово[/] (как в lines.js); у правки — новое слово, у счёта — число. */
export const WORDFX_SAMPLES: Record<string, string> = {
  shk: "Сдать отчёт нужно [строго]сегодня[/].",
  yell: "Срок — [крик]сегодня[/]!",
  syl: "Это [по слогам]обязательно[/].",
  confetti: "Все задачи [конфетти]сделаны[/]!",
  gold: "Новый уровень — [золото]пятый[/]!",
  count: "Серия уже [счёт]12[/] дней подряд.",
  pulse: "[пульс]Спасибо[/], что заглянули.",
  whisper: "Скажу по секрету: [шёпот]вы молодец[/].",
  drip: "Опять [капля]дождь[/]…",
  wilt: "Цветок на окне [увядает]завял[/].",
  str: "Ладно, [нехотя]сделаю[/].",
  slump: "Сил уже [сползает]нет[/]…",
  jolt: "[ой]Ой[/], чуть не забыла!",
  glitch: "Что-то [сбой]сломалось[/].",
  fix: "Сдадите [правка=никогда]завтра[/].",
  quote: "Вы весь день [кавычки]отдыхали[/].",
  mark: "Главное сегодня — [маркер]выспаться[/].",
  breath: "Вдох… и [дыхание]выдох[/].",
};
/** Пример к слову, у которого своего нет (эффект новее этого списка): карточка не теряется, тест напомнит дописать. */
export const wordfxSample = (id: string, ru: string) => WORDFX_SAMPLES[id] ?? `Вот так: [${ru}]пример[/].`;
/** Пример без пометок — образец карточки, пока виджет не запущен: текст и слово с эффектом. */
export function wordfxPlain(sample: string): { text: string; word?: string } {
  const mark = /\[[^\]]+\]([^[]*)\[\/\]/g;
  const word = [...sample.matchAll(mark)][0]?.[1];
  return { text: sample.replace(mark, "$1"), word };
}

/** Облачко: превращения выбирает сам виджет (bubblefxPick) по эмоции и тексту, значки — поверх реплики. */
export const BUBBLE_SAMPLES: Record<string, { text: string; emotion: string; heard?: string; mark?: string }> = {
  melt: { text: "Не успели сегодня. Ну ничего…", emotion: "sad" },
  deflate: { text: "Пф-ф… устала.", emotion: "sleepy" },
  heart: { text: "Всегда рада помочь!", emotion: "happy", heard: "спасибо тебе" },
  bloom: { text: "Все задачи сделаны — вы молодец!", emotion: "proud" },
  fall: { text: "Сто задач за один день?!", emotion: "surprised" },
  // Длинная грустная реплика: тает только короткая, а линии уныния — у каждой грустной.
  gloom: { text: "Сегодня ни одна привычка не отмечена, и задачи с прошлой недели так и висят. Завтра начнём заново, хорошо?", emotion: "sad" },
  drop: { text: "Кажется, я перепутала время…", emotion: "awkward", mark: "drop" },
};
export const GAIT_SAMPLE = "Записала ваш план на завтра.";
export const WEATHER_SAMPLES: Record<string, { icon: string; temp: string; text: string }> = {
  storm: { icon: "🌨", temp: "−9°", text: "Метель" },
  snow: { icon: "❄", temp: "−3°", text: "Снег" },
  rain: { icon: "☂", temp: "+6°", text: "Дождь" },
  frost: { icon: "🥶", temp: "−18°", text: "Мороз" },
  gray: { icon: "☁", temp: "+2°", text: "Пасмурно" },
  sun: { icon: "☀", temp: "+21°", text: "Ясно" },
};
export const HOLIDAY_PLAY: Record<string, "flame" | "wave" | "salute"> = { "Огонёк взрослеет": "flame", "Волна по отметкам": "wave", "Салют из искр": "salute" };
const FLAME_TIERS = [{ id: "7", label: "7 дней" }, { id: "30", label: "30 дней" }, { id: "100", label: "100 дней" }];

export interface ShowCard {
  key: string; group: ShowGroup; id: string; title: string; sub: string; text: string;
  /** Сколько длится показ, мс (после — карточка снова «стоит»). */
  ms: number;
  /** Картинка до запуска виджета (анимации — /maid/<id>.webp сайта). */
  poster?: string;
  /** Без картинки — образец: реплика (word — слово с эффектом) или подпись, как это выглядит в виджете. */
  still?: { text: string; word?: string; icon?: string };
  /** Сценарий: второй пример («Вручную», «В Telegram», поиск, статистика) — в виджете его нет, он на странице «Возможности». */
  extra?: string;
  /** Сценарий: позы горничной по ходу — ссылки на карточки анимаций. */
  poses?: string[];
  /** Выбор настроения или варианта; первый — по умолчанию. */
  moods?: { id: string; label: string }[];
  play: (mood?: string) => PreviewPlay;
  /** Анимация из реестра — для большого просмотра (покадровый проигрыватель). */
  anim?: AnimInfo;
}

/** Сценарий «Возможностей» — сколько полей нужно витрине (сам тип — web/src/features.ts). */
type SceneFrame = { maid?: string; bubble?: string; msgs?: { me?: boolean; text: string }[] };
type SceneDemo = { kind: string; start: SceneFrame; steps: { at: number; set: SceneFrame }[] };
export type ShowScene = { id: string; title: string; text: string; ai: SceneDemo; manual?: SceneDemo; manualTitle?: string };
const sceneLength = (d: { steps: { at: number }[] }) => (d.steps.at(-1)?.at ?? 0) + 1800;
/** Виды второго примера по-человечески. */
export const SCENE_KINDS: Record<string, string> = { widget: "виджет", panel: "панель дня", chat: "чат Telegram", search: "поиск Ctrl+K", stats: "статистика дня" };
/** Позы горничной сценария по порядку, без повторов. */
export const scenePoses = (d: SceneDemo) => [...new Set([d.start, ...d.steps.map((x) => x.set)].map((f) => f.maid).filter((m): m is string => Boolean(m)))];
/** Итоговая реплика сценария — образец карточки: последнее облачко или последняя реплика горничной в чате. */
export function sceneStill(d: SceneDemo): string {
  let out = "";
  for (const f of [d.start, ...d.steps.map((x) => x.set)]) {
    if (f.bubble && f.bubble !== "…") out = f.bubble;
    const m = f.msgs?.filter((x) => !x.me).at(-1);
    if (m) out = m.text;
  }
  return out;
}

/** Все карточки витрины по порядку групп; scenes — FEATURES из features.ts. */
export function showcaseCards(reg: Registry, scenes: ShowScene[]): ShowCard[] {
  const out: ShowCard[] = [];
  for (const a of reg.anims) {
    const group: ShowGroup = a.group === "base" ? "anim-base" : a.group === "once" ? "anim-once" : "anim-event";
    const ms = a.group === "once" ? a.ms : Math.max(2 * a.ms, 6000);
    out.push({ key: `anim:${a.id}`, group, id: a.id, title: a.name, sub: `${a.desk.frames} кадр. · ${secText(a.ms)}`,
      text: animWhen(a) + (a.emotions.length ? ` · эмоции ответа: ${a.emotions.join(", ")}` : ""),
      ms, poster: `/maid/${a.id}.webp`, anim: a, play: () => ({ kind: "anim", id: a.id, ms }) });
  }
  const moodsOf = (ids: string[]) => ids.map((id) => ({ id, label: EMOTION_NAMES[id] ?? id }));
  for (const w of reg.effects.wordfx) {
    out.push({ key: `wordfx:${w.id}`, group: "wordfx", id: w.id, title: `[${w.ru}]`, sub: w.id, text: w.text, ms: 9000, moods: moodsOf(SHOW_EMOTIONS),
      still: wordfxPlain(wordfxSample(w.id, w.ru)),
      play: (mood) => ({ kind: "say", own: true, text: wordfxSample(w.id, w.ru), emotion: mood || "neutral" }) });
  }
  for (const b of reg.effects.bubble) {
    const s = BUBBLE_SAMPLES[b.id] ?? { text: "Вот так выглядит облачко.", emotion: "neutral", mark: b.kind === "mark" ? b.id : undefined };
    out.push({ key: `bubble:${b.id}`, group: "bubble", id: b.id, title: b.id, sub: b.kind === "mark" ? "значок" : "превращение", text: b.text, ms: 9000, still: { text: s.text },
      play: () => ({ kind: "say", text: s.text, emotion: s.emotion, heard: s.heard, mark: s.mark }) });
  }
  for (const g of reg.effects.gait) {
    out.push({ key: `gait:${g.id}`, group: "gait", id: g.id, title: g.id, sub: g.emotions.join(", "), text: `Буквы реплики появляются походкой «${g.id}» — у эмоций ${g.emotions.join(", ")}.`,
      ms: 6000, moods: moodsOf(g.emotions), still: { text: GAIT_SAMPLE }, play: (mood) => ({ kind: "say", text: GAIT_SAMPLE, emotion: mood || g.emotions[0] }) });
  }
  for (const w of reg.effects.weather) {
    const s = WEATHER_SAMPLES[w.id] ?? { icon: "⛅", temp: "+5°", text: w.id };
    out.push({ key: `weather:${w.id}`, group: "weather", id: w.id, title: s.text, sub: `${s.icon} ${s.temp} · ${w.id}`, text: w.text, ms: 10_000,
      still: { icon: s.icon, text: `${s.temp} · ${s.text}` },
      play: () => ({ kind: "weather", sky: w.id, ...s }) });
  }
  reg.effects.holidays.forEach((h, i) => {
    const party = HOLIDAY_PLAY[h.title] ?? "wave";
    out.push({ key: `holiday:${i}`, group: "holiday", id: party, title: h.title, sub: party, text: h.text, ms: 9000, moods: party === "flame" ? FLAME_TIERS : undefined,
      still: { icon: party === "flame" ? "🔥" : party === "salute" ? "🎆" : "🌊", text: h.title },
      play: (mood) => ({ kind: "holiday", party, tier: party === "flame" ? Number(mood || 7) : undefined }) });
  });
  const anims = new Set(reg.anims.map((a) => a.id));
  for (const f of scenes) {
    const ms = sceneLength(f.ai);
    out.push({ key: `scene:${f.id}`, group: "scene", id: f.id, title: f.title, sub: `${f.ai.kind === "chat" ? "реплики из чата Telegram" : "виджет"} · ${secText(ms)}`, text: f.text, ms,
      still: { text: sceneStill(f.ai) || f.title },
      extra: f.manual ? `Второй пример — «${f.manualTitle ?? "Вручную"}»: ${SCENE_KINDS[f.manual.kind] ?? f.manual.kind} · ${secText(sceneLength(f.manual))}` : undefined,
      poses: scenePoses(f.ai).filter((m) => anims.has(m)),
      play: () => ({ kind: "scene", demo: f.ai }) });
  }
  return out;
}

/** Поиск и фильтр витрины: по названию, id, подписи и описанию; без учёта регистра и «ё». */
export function filterCards(cards: ShowCard[], filter: ShowFilter, q: string): ShowCard[] {
  const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е");
  const words = norm(q).split(/\s+/).filter(Boolean);
  return cards.filter((c) => (filter === "all" || c.group === filter || (filter === "anim" && c.group.startsWith("anim-")))
    && words.every((w) => norm(`${c.title} ${c.id} ${c.sub} ${c.text}`).includes(w)));
}

/** Что видно в карточке (слева и сверху окно виджета прозрачное и пустое): face — горничная, облачко и верх панели
 *  (анимации, слова, облачко, походка), panel — горничная и вся панель (погода, праздники привычек, сценарии). */
export const PREVIEW_CROPS = { face: { x: 120, y: 140, w: 500, h: 360 }, panel: { x: 150, y: 120, w: 470, h: 640 } } as const;
export type PreviewCrop = keyof typeof PREVIEW_CROPS;
export const cropOf = (g: ShowGroup): PreviewCrop => (g === "weather" || g === "holiday" || g === "scene" ? "panel" : "face");
/** Масштаб окна виджета под ширину (и высоту, если она задана) места; w × h — видимая часть окна. */
export const previewScale = (width: number, height = Infinity, w = PREVIEW_W, h = PREVIEW_H) => Math.max(0.1, Math.min(1, width / w, height / h));

/** Какие виджеты держать живыми: играющая, потом недавно запущенные (recent — по «играть») на самом экране (onScreen), потом
 *  недавние в запасе у края (visible); не больше max. Сами видимые карточки виджет больше не запускают (26.11.2026): каждый —
 *  целая страница виджета, а первый кадр карточки — неподвижная картинка (poster). */
export function liveSet(visible: string[], recent: string[], playing: string | null, max = PREVIEW_LIVE_MAX, onScreen: string[] = []): string[] {
  const screen = onScreen.filter((k) => visible.includes(k));
  const order = [...(playing ? [playing] : []), ...recent.filter((k) => screen.includes(k)), ...recent.filter((k) => visible.includes(k))];
  return [...new Set(order)].slice(0, max);
}

// ——— Файлы показа с меткой версии (26.11.2026, server/src/preview.ts): список — GET /admin-preview/files.json (по пропуску),
// адрес с меткой браузер держит в кэше год (immutable). Кнопка «Загрузить всё заранее» качает их все — потом карточки и
// повторные заходы берут файлы из кэша браузера без запросов.

export type PreviewFile = { path: string; v: string; bytes: number };
export const PREVIEW_FILES_URL = "/admin-preview/files.json";
export const previewTagged = (f: PreviewFile) => `/admin-preview/${f.path}?v=${f.v}`;
/** Неподвижная картинка карточки анимации — первый кадр (poster/<id>.webp с меткой); нет в списке — null. */
export function posterOf(files: PreviewFile[] | null, id: string): string | null {
  const f = files?.find((x) => x.path === `poster/${id}.webp`);
  return f ? previewTagged(f) : null;
}

/** Сколько файлов качать заранее одновременно. */
export const PRELOAD_PARALLEL = 4;
export type PreloadState = { done: number; total: number; bytes: number; totalBytes: number; failed: number; stopped?: boolean };
/** Скачать все файлы (get — один адрес; бросил — не скачался), по parallel сразу; после каждого — onProgress. Отменили (signal) —
 *  новые не начинаются, итог со stopped. */
export async function preloadAll(files: PreviewFile[], get: (url: string, signal?: AbortSignal) => Promise<void>,
  opts: { parallel?: number; signal?: AbortSignal; onProgress?: (s: PreloadState) => void } = {}): Promise<PreloadState> {
  const s: PreloadState = { done: 0, total: files.length, bytes: 0, totalBytes: files.reduce((a, f) => a + f.bytes, 0), failed: 0 };
  let next = 0;
  const worker = async () => {
    while (next < files.length && !opts.signal?.aborted) {
      const f = files[next++];
      try {
        await get(previewTagged(f), opts.signal);
        if (opts.signal?.aborted) break;
        s.done++;
        s.bytes += f.bytes;
      } catch {
        if (opts.signal?.aborted) break;
        s.failed++;
      }
      opts.onProgress?.({ ...s });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.parallel ?? PRELOAD_PARALLEL, files.length)) }, worker));
  if (opts.signal?.aborted) s.stopped = true;
  return s;
}
/** «12 из 140, 8.4 из 92.1 МБ». */
export const preloadText = (s: PreloadState) => `${s.done} из ${s.total}, ${(s.bytes / 1048576).toFixed(1)} из ${(s.totalBytes / 1048576).toFixed(1)} МБ`;
