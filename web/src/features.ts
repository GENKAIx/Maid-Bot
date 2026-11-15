// Раздел «Возможности» (screens/Features.tsx): что умеет программа. У каждой фичи — название, зачем она, живой пример «с горничной»
// (копия виджета) и, где есть, второй пример: «вручную» (копия панели дня), чат Telegram, поиск или круг статистики. Пример — сценарий: начальный кадр и шаги «в такую-то мс поменять
// вот это»; кадр на момент t собирает frameAt. Настоящие данные примеры не трогают.

export interface Row {
  time?: string; title: string; task?: boolean; fresh?: boolean;
  /** Привычка — круглая отметка; done — отмечена (задача — зачёркнута); late — просрочена (красная); note — справа («пт», «🔥 5», «1/30»). */
  habit?: boolean; done?: boolean; late?: boolean; note?: string;
}
/** Сообщение в чате Telegram: от человека (me) или от горничной; time — подпись времени. */
export interface Msg { me?: boolean; text: string; time: string; buttons?: string[] }
export interface Hit { title: string; sub: string }
export interface App { label: string; sec: number; game?: boolean }
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
  /** Чат Telegram: сообщения по порядку. */
  msgs?: Msg[];
  /** Поиск: запрос (печатается) и найденное. */
  query?: string;
  hits?: Hit[];
  /** Статистика дня: секунды за ПК и в играх (круг суток) и программы. */
  pc?: number;
  games?: number;
  apps?: App[];
}
export interface Step { at: number; set: Partial<Frame> }
export interface Demo { kind: "widget" | "panel" | "chat" | "search" | "stats"; start: Frame; steps: Step[] }
/** manual — второй пример; manualTitle — его подпись (по умолчанию «Вручную»), aiTitle — подпись первого (с вторым — «С горничной»). */
export interface Feature {
  id: string; title: string; text: string; ai: Demo; manual?: Demo; manualText?: string;
  aiTitle?: string; manualTitle?: string;
}

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
const CALL: Row = { time: "10:00", title: "Созвон" };
const maidSays = (text: string, time: string, buttons?: string[]): Msg => ({ text, time, buttons });
const iSay = (text: string, time: string): Msg => ({ me: true, text, time });

export const FEATURES: Feature[] = [
  {
    id: "words",
    title: "Записать словами",
    text: "Пишешь как другу — горничная сама понимает, что это: план со временем, задача или запись в дневник, и раскладывает по местам. " +
      "Дату и время понимает по-человечески: «завтра в 3», «в пятницу вечером», «через неделю».",
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
  {
    id: "remind",
    title: "Напоминания",
    text: "О плане со временем горничная напомнит сама — когда удобно: в начале дня, за час, за 5 минут, в момент начала или за своё " +
      "время («Настройки» → «Когда напоминать»). Напоминание приходит в виджет, в Telegram и push на телефон.",
    ai: {
      kind: "widget",
      start: { maid: "idle", input: "", rows: [CALL] },
      steps: [
        { at: 400, set: { input: "напомни через 20 минут выключить духовку" } },
        { at: 2900, set: { input: "", maid: "think", bubble: "…" } },
        { at: 3600, set: { maid: "write", bubble: "Записала: сегодня в 13:00 — Выключить духовку.", rows: [CALL, { time: "13:00", title: "Выключить духовку", fresh: true }] } },
        { at: 6400, set: { maid: "idle", bubble: undefined, rows: [CALL, { time: "13:00", title: "Выключить духовку" }] } },
        { at: 7200, set: { maid: "remind", bubble: "⏰ Пора: 13:00 — Выключить духовку" } },
      ],
    },
    manualTitle: "В Telegram",
    manualText: "и push на телефоне",
    manual: {
      kind: "chat",
      start: { maid: "idle", msgs: [] },
      steps: [
        { at: 900, set: { msgs: [maidSays("📅 Сегодня: 15:00 — Врач", "09:00")] } },
        { at: 2900, set: { msgs: [maidSays("📅 Сегодня: 15:00 — Врач", "09:00"), maidSays("⏰ Через 1 ч: 15:00 — Врач", "14:00")] } },
        { at: 4900, set: { msgs: [maidSays("📅 Сегодня: 15:00 — Врач", "09:00"), maidSays("⏰ Через 1 ч: 15:00 — Врач", "14:00"), maidSays("⏰ Пора: 15:00 — Врач", "15:00")] } },
      ],
    },
  },
  {
    id: "tasks",
    title: "Задачи и хвосты",
    text: "Дела со сроком и без. Просроченное горничная не забывает: спрашивает по одной — «Сделано», «Перенести» или «Не буду». " +
      "В воскресенье покажет, от каких задач увиливали всю неделю.",
    ai: {
      kind: "widget",
      start: { maid: "idle", input: "", rows: [CALL, { title: "Оплатить интернет", task: true, late: true, note: "пт" }] },
      steps: [
        { at: 600, set: { maid: "worried", bubble: "«Оплатить интернет» висит с пятницы. Что с ней?", buttons: ["Сделано", "Перенести", "Не буду"] } },
        { at: 2900, set: { pressed: 0 } },
        { at: 3300, set: { maid: "done", bubble: "Отметила: сделано.", buttons: undefined, pressed: undefined,
          rows: [CALL, { title: "Оплатить интернет", task: true, done: true }] } },
        { at: 5200, set: { maid: "idle", bubble: undefined, input: "до пятницы сдать отчёт" } },
        { at: 6600, set: { input: "", maid: "think", bubble: "…" } },
        { at: 7300, set: { maid: "write", bubble: "Добавила задачу «Сдать отчёт» — до пт, 20 ноября.",
          rows: [CALL, { title: "Оплатить интернет", task: true, done: true }, { title: "Сдать отчёт", task: true, note: "пт", fresh: true }] } },
      ],
    },
  },
  {
    id: "habits",
    title: "Привычки и курсы",
    text: "Привычка — то, что делаешь регулярно; курс — то же на N дней (витамины, таблетки, челлендж). Горничная заводит их, " +
      "когда ты сам хочешь («хочу…», «буду…»), спрашивает в своё время с кнопками «Да», «Ещё нет», «Нет» и считает серии.",
    ai: {
      kind: "widget",
      start: { maid: "idle", input: "", rows: [{ title: "Зарядка", habit: true, done: true, note: "🔥 5" }] },
      steps: [
        { at: 400, set: { input: "хочу 30 дней пить витамин D" } },
        { at: 2200, set: { input: "", maid: "think", bubble: "…" } },
        { at: 2900, set: { maid: "write", bubble: "Завела курс «Витамин D» — 30 дней, с сегодня.",
          rows: [{ title: "Зарядка", habit: true, done: true, note: "🔥 5" }, { title: "Витамин D", habit: true, note: "0/30", fresh: true }] } },
        { at: 5600, set: { maid: "idle", bubble: undefined, rows: [{ title: "Зарядка", habit: true, done: true, note: "🔥 5" }, { title: "Витамин D", habit: true, note: "0/30" }] } },
        { at: 6300, set: { maid: "remind", bubble: "Витамин D сегодня?", buttons: ["✅ Да", "⏳ Ещё нет", "✖ Нет"] } },
        { at: 7900, set: { pressed: 0 } },
        { at: 8300, set: { maid: "streak", bubble: "Отметила. День 1 из 30.", buttons: undefined, pressed: undefined,
          rows: [{ title: "Зарядка", habit: true, done: true, note: "🔥 5" }, { title: "Витамин D", habit: true, done: true, note: "1/30", fresh: true }] } },
      ],
    },
  },
  {
    id: "digest",
    title: "Утро, завтра и вечер",
    text: "Каждый день в своё время: утром — дата, что-нибудь интересное про этот день, планы, задачи и напутствие; вечером — что ждёт " +
      "завтра; перед сном — итог дня цифрами и пара слов от горничной, и можно оценить день. Время меняется в настройках.",
    aiTitle: "В Telegram",
    ai: {
      kind: "chat",
      start: { maid: "idle", msgs: [] },
      steps: [
        { at: 600, set: { msgs: [maidSays("☀️ Доброе утро.\n\n16 ноября, пн\nСегодня День терпимости — не ворчим на пробки.\n" +
          "Планы\n• 10:00 — Созвон\n• 15:00 — Врач\nЗадачи\n• Оплатить интернет\n💭 Что не зависит от вас, не стоит нервов.", "09:00")] } },
        { at: 5600, set: { msgs: [maidSays("☀️ Доброе утро. …", "09:00"), maidSays("🌙 Завтра, 17 ноября, вт:\n• 11:00 — Стрижка", "20:00")] } },
        { at: 7600, set: { msgs: [maidSays("☀️ Доброе утро. …", "09:00"), maidSays("🌙 Завтра, 17 ноября, вт:\n• 11:00 — Стрижка", "20:00"),
          maidSays("Итог дня, 16 ноября, пн\n✔ 3 задачи · привычки 2/2 · 🎮 1 ч · 📝 4 записи\nДень ровный: и врач, и зарядка. Ложитесь вовремя.", "22:00", ["😞", "😐", "🙂", "😄"])] } },
        { at: 9800, set: { pressed: 3 } },
      ],
    },
  },
  {
    id: "diary",
    title: "Дневник и поиск",
    text: "Всё, что рассказал о дне — сон, еда, спорт, здоровье, настроение, — горничная раскладывает по разделам дневника. В календаре " +
      "у каждого дня свои значки. Поиск (Ctrl+K) находит задачи и планы по любому слову, даже удалённые за последние 14 дней.",
    ai: {
      kind: "widget",
      start: { maid: "idle", input: "", rows: [CALL] },
      steps: [
        { at: 400, set: { input: "спал 6 часов, на обед борщ" } },
        { at: 2000, set: { input: "", maid: "think", bubble: "…" } },
        { at: 2700, set: { maid: "write", bubble: "Записала в дневник: сон — 6 ч, обед — борщ." } },
      ],
    },
    manualTitle: "Поиск",
    manualText: "Ctrl+K на сайте",
    manual: {
      kind: "search",
      start: { maid: "idle", query: "", hits: [] },
      steps: [
        { at: 600, set: { query: "врач" } },
        { at: 1600, set: { hits: [{ title: "Врач", sub: "план · чт, 19 ноября, 15:00" }, { title: "Записаться к врачу", sub: "задача · сделано 2 ноября" }] } },
      ],
    },
  },
  {
    id: "pc",
    title: "Компьютер и игры",
    text: "Программа на ПК раз в 10 минут отмечает, что запущено. Видно, сколько времени за компьютером и сколько из него в играх. " +
      "Засиделся в игре 2 часа — горничная скажет (выключается в настройках).",
    ai: {
      kind: "widget",
      start: { maid: "idle", input: "", rows: [CALL] },
      steps: [
        { at: 700, set: { maid: "refuse", bubble: "🎮 Вы уже 2 часа в Dota 2. Может, перерыв?" } },
      ],
    },
    manualTitle: "Статистика",
    manualText: "день на сайте",
    manual: {
      kind: "stats",
      start: { maid: "idle", pc: 0, games: 0, apps: [] },
      steps: [
        { at: 300, set: { pc: 19980, games: 7200, apps: [{ label: "Dota 2", sec: 7200, game: true }, { label: "Chrome", sec: 6000 }, { label: "VS Code", sec: 4200 }] } },
      ],
    },
  },
  {
    id: "dates",
    title: "Важные даты",
    text: "Дни рождения, годовщины, праздники и дедлайны. Горничная запоминает их по одной фразе, повторяет каждый год и за месяц " +
      "показывает на «Сегодня» — со сколькими днями до и сколько исполнится.",
    ai: {
      kind: "widget",
      start: { maid: "idle", input: "", rows: [CALL] },
      steps: [
        { at: 400, set: { input: "у мамы день рождения 12 марта" } },
        { at: 2200, set: { input: "", maid: "think", bubble: "…" } },
        { at: 2900, set: { maid: "happy", bubble: "Запомнила: 12 марта — день рождения мамы, каждый год." } },
      ],
    },
  },
  {
    id: "maid",
    title: "Горничная",
    text: "Живая: десятки анимаций, реагирует на то, что пишешь, радуется сделанному и грустит о пропущенном. Четыре характера — строгая, " +
      "добрая, дерзкая и расслабленная. Когда тебя нет за компьютером, засыпает, а вернёшься — расскажет, что пришло.",
    aiTitle: "Характеры и настроение",
    ai: {
      kind: "widget",
      start: { maid: "idle", input: "", rows: [CALL] },
      steps: [
        { at: 300, set: { maid: "write", bubble: "Строгая: «Записала.»" } },
        { at: 1800, set: { maid: "happy", bubble: "Добрая: «Записала! 🌸»" } },
        { at: 3300, set: { maid: "smug", bubble: "Дерзкая: «Записала. Не благодари.»" } },
        { at: 4800, set: { maid: "tea", bubble: "Расслабленная: «Записала, норм.»" } },
        { at: 6600, set: { maid: "sleep", bubble: undefined } },
        { at: 8600, set: { maid: "surprised", bubble: "О, вы вернулись!" } },
      ],
    },
  },
  {
    id: "telegram",
    title: "Telegram",
    text: "Та же горничная в Telegram: пиши текстом, голосовым или фото — чек станет тратой, билет — планом, список — задачами. " +
      "Данные одни: записанное в Telegram сразу видно в виджете и на сайте.",
    aiTitle: "В Telegram",
    ai: {
      kind: "chat",
      start: { maid: "idle", msgs: [] },
      steps: [
        { at: 400, set: { msgs: [iSay("завтра в 15 врач", "12:40")] } },
        { at: 1500, set: { msgs: [iSay("завтра в 15 врач", "12:40"), maidSays("Записала: завтра в 15:00 — Врач.", "12:40")] } },
        { at: 3000, set: { msgs: [iSay("завтра в 15 врач", "12:40"), maidSays("Записала: завтра в 15:00 — Врач.", "12:40"), iSay("🎤 Голосовое, 0:04", "12:41")] } },
        { at: 4100, set: { msgs: [iSay("завтра в 15 врач", "12:40"), maidSays("Записала: завтра в 15:00 — Врач.", "12:40"), iSay("🎤 Голосовое, 0:04", "12:41"),
          maidSays("Записала: сегодня в 19:00 — Позвонить маме.", "12:41")] } },
        { at: 5600, set: { msgs: [iSay("🎤 Голосовое, 0:04", "12:41"), maidSays("Записала: сегодня в 19:00 — Позвонить маме.", "12:41"), iSay("🧾 Фото чека", "12:42")] } },
        { at: 6700, set: { msgs: [iSay("🎤 Голосовое, 0:04", "12:41"), maidSays("Записала: сегодня в 19:00 — Позвонить маме.", "12:41"), iSay("🧾 Фото чека", "12:42"),
          maidSays("Трата: 1 240 ₽ — продукты.", "12:42")] } },
      ],
    },
  },
];
