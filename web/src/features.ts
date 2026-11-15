// Раздел «Возможности» (screens/Features.tsx): что умеет программа. У каждой фичи — название, зачем она, живой пример «с горничной»
// (копия виджета) и, где есть, «вручную» (копия панели дня). Пример — сценарий: начальный кадр и шаги «в такую-то мс поменять
// вот это»; кадр на момент t собирает frameAt. Настоящие данные примеры не трогают.

export interface Row { time?: string; title: string; task?: boolean; fresh?: boolean }
export interface Day { wd: string; d: number; n: number }
export interface Frame {
  maid: string;
  /** Что набрано в строке ввода (печатается по букве с момента шага). */
  input?: string;
  /** Идёт запись голоса: вместо строки — волна. */
  mic?: boolean;
  bubble?: string;
  buttons?: string[];
  /** Кнопка, которая сама заполняется (как «Оставить» у пересечения планов). */
  fill?: number;
  /** Нажатая кнопка облачка — вспыхивает. */
  pressed?: number;
  rows?: Row[];
  /** Панель дня: полоса дней, выбранный день, карточки, «+» и форма нового плана, карточка в полёте на другой день. */
  days?: Day[];
  day?: number;
  cards?: Row[];
  plus?: boolean;
  form?: { time: string; title: string };
  drag?: { card: number; to: number };
}
export interface Step { at: number; set: Partial<Frame> }
export interface Demo { kind: "widget" | "panel"; start: Frame; steps: Step[] }
export interface Feature { id: string; title: string; text: string; ai: Demo; manual?: Demo; manualText?: string; sample?: string }

/** Сколько длится пример: последний шаг и ещё немного, чтобы итог было видно. */
export const demoLength = (d: Demo) => (d.steps.at(-1)?.at ?? 0) + 1800;

/** Кадр на момент t (мс от «Показать») и сколько мс прошло с последней смены каждого поля — для печати текста по букве. */
export function frameAt(d: Demo, t: number): { frame: Frame; age: Partial<Record<keyof Frame, number>> } {
  const frame: Frame = { ...d.start };
  const age: Partial<Record<keyof Frame, number>> = {};
  for (const k of Object.keys(d.start) as (keyof Frame)[]) age[k] = t;
  for (const s of d.steps) {
    if (s.at > t) break;
    Object.assign(frame, s.set);
    for (const k of Object.keys(s.set) as (keyof Frame)[]) age[k] = t - s.at;
  }
  return { frame, age };
}

const WEEK: Day[] = [
  { wd: "пн", d: 16, n: 1 }, { wd: "вт", d: 17, n: 0 }, { wd: "ср", d: 18, n: 0 }, { wd: "чт", d: 19, n: 2 },
  { wd: "пт", d: 20, n: 0 }, { wd: "сб", d: 21, n: 1 }, { wd: "вс", d: 22, n: 0 },
];
const withN = (i: number, n: number) => WEEK.map((x, j) => (j === i ? { ...x, n } : x));

export const FEATURES: Feature[] = [
  {
    id: "words",
    title: "Записать словами",
    text: "Пишешь как другу — горничная сама понимает, что это: план со временем, задача или запись в дневник, и раскладывает по местам. " +
      "Дату и время понимает по-человечески: «завтра в 3», «в пятницу вечером», «через неделю».",
    sample: "завтра в 15 врач",
    ai: {
      kind: "widget",
      start: { maid: "idle", input: "", rows: [{ time: "10:00", title: "Созвон" }] },
      steps: [
        { at: 400, set: { input: "завтра в 15 врач" } },
        { at: 1700, set: { input: "", maid: "think", bubble: "…" } },
        { at: 2500, set: { maid: "write", bubble: "Записала: завтра в 15:00 — Врач.", rows: [{ time: "10:00", title: "Созвон" }, { time: "Пн 15:00", title: "Врач", fresh: true }] } },
        { at: 4600, set: { input: "купить хлеб", rows: [{ time: "10:00", title: "Созвон" }, { time: "Пн 15:00", title: "Врач" }] } },
        { at: 5600, set: { input: "", maid: "think", bubble: "…" } },
        { at: 6300, set: { maid: "happy", bubble: "Добавила задачу «Купить хлеб».", rows: [{ time: "10:00", title: "Созвон" }, { time: "Пн 15:00", title: "Врач" }, { title: "Купить хлеб", task: true, fresh: true }] } },
      ],
    },
    manualText: "В панели дня: «+», время и название.",
    manual: {
      kind: "panel",
      start: { maid: "idle", days: WEEK, day: 0, cards: [{ time: "10:00", title: "Созвон" }] },
      steps: [
        { at: 600, set: { plus: true } },
        { at: 1000, set: { form: { time: "", title: "" } } },
        { at: 1300, set: { form: { time: "15:00", title: "" } } },
        { at: 2000, set: { form: { time: "15:00", title: "Врач" } } },
        { at: 3000, set: { plus: false, form: undefined, days: withN(0, 2), cards: [{ time: "10:00", title: "Созвон" }, { time: "15:00", title: "Врач", fresh: true }] } },
      ],
    },
  },
  {
    id: "voice",
    title: "Сказать голосом",
    text: "Руки заняты — нажми микрофон в виджете или в строке на сайте и скажи. Горничная расшифрует речь и запишет так же, как текст: " +
      "план, задачу, что ты съел или как спал.",
    ai: {
      kind: "widget",
      start: { maid: "idle", input: "", rows: [{ time: "10:00", title: "Созвон" }] },
      steps: [
        { at: 400, set: { mic: true, maid: "listen" } },
        { at: 2600, set: { mic: false, input: "напомни в 7 вечера позвонить маме" } },
        { at: 3200, set: { input: "", maid: "think", bubble: "…" } },
        { at: 3900, set: { maid: "happy", bubble: "Записала: сегодня в 19:00 — Позвонить маме. Напомню заранее.", rows: [{ time: "10:00", title: "Созвон" }, { time: "19:00", title: "Позвонить маме", fresh: true }] } },
      ],
    },
  },
  {
    id: "days",
    title: "Планы по дням",
    text: "Панель дня показывает неделю: сколько планов в каждый день и что именно. Перенести план — сказать горничной «перенеси…» или " +
      "перетащить карточку на другой день. Если новый план ложится на занятое время, горничная предложит сдвинуть его.",
    sample: "перенеси врача на четверг",
    ai: {
      kind: "widget",
      start: { maid: "idle", input: "", rows: [{ time: "10:00", title: "Созвон" }, { time: "Пн 15:00", title: "Врач" }] },
      steps: [
        { at: 400, set: { input: "перенеси врача на четверг" } },
        { at: 1900, set: { input: "", maid: "think", bubble: "…" } },
        { at: 2600, set: { maid: "write", bubble: "Перенесла «Врач» на чт, 19 ноября, 15:00.", rows: [{ time: "10:00", title: "Созвон" }, { time: "Чт 15:00", title: "Врач", fresh: true }] } },
        { at: 4600, set: { input: "в четверг в 15 стрижка", rows: [{ time: "10:00", title: "Созвон" }, { time: "Чт 15:00", title: "Врач" }] } },
        { at: 6000, set: { input: "", maid: "think", bubble: "…" } },
        { at: 6700, set: { maid: "worried", bubble: "В 15:00 у вас уже «Врач».", buttons: ["➜ Сдвинуть на 16:00", "Оставить"], fill: 1 } },
        { at: 8300, set: { pressed: 0 } },
        { at: 8700, set: { maid: "happy", bubble: "Сдвинула «Стрижку» на 16:00.", buttons: undefined, fill: undefined, pressed: undefined,
          rows: [{ time: "10:00", title: "Созвон" }, { time: "Чт 15:00", title: "Врач" }, { time: "Чт 16:00", title: "Стрижка", fresh: true }] } },
      ],
    },
    manualText: "Перетащить карточку на нужный день.",
    manual: {
      kind: "panel",
      start: { maid: "idle", days: withN(0, 2), day: 0, cards: [{ time: "10:00", title: "Созвон" }, { time: "15:00", title: "Врач" }] },
      steps: [
        { at: 700, set: { day: 3, cards: [{ time: "09:00", title: "Спортзал" }, { time: "18:00", title: "Кино" }] } },
        { at: 1900, set: { day: 0, cards: [{ time: "10:00", title: "Созвон" }, { time: "15:00", title: "Врач" }] } },
        { at: 2700, set: { drag: { card: 1, to: 3 } } },
        { at: 3700, set: { drag: undefined, days: [WEEK[0], WEEK[1], WEEK[2], { ...WEEK[3], n: 3 }, ...WEEK.slice(4)], cards: [{ time: "10:00", title: "Созвон" }] } },
        { at: 4500, set: { day: 3, cards: [{ time: "09:00", title: "Спортзал" }, { time: "15:00", title: "Врач", fresh: true }, { time: "18:00", title: "Кино" }] } },
      ],
    },
  },
];
