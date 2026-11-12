import type { ActivityRow, DiaryRow, MetricRow } from "./types";

// Эмодзи дня для календаря дневника: по словам записей (сериал, ресторан, бег…), подразделам здоровья,
// играм за ПК и шагам. Больше совпадений — выше; день показывает до 3, подсказка — что за что.

interface Rule { emoji: string; what: string; re: RegExp; weight?: number }

// Порядок — приоритет при равных совпадениях. Корни слов, без учёта ё.
const RULES: Rule[] = [
  { emoji: "🎂", what: "день рождения", re: /день рожден|днюх|др\b/, weight: 5 },
  { emoji: "🎉", what: "праздник", re: /праздн|вечеринк|тусовк|тусил|новый год|корпоратив/, weight: 3 },
  { emoji: "✈️", what: "поездка", re: /поездк|самол[её]т|аэропорт|улетел|прилетел|путешеств|отпуск/, weight: 3 },
  { emoji: "🚆", what: "дорога", re: /поезд\b|поездом|электричк|вокзал/ },
  { emoji: "🤒", what: "болел", re: /температур|заболел|болею|простуд|грипп|ковид|орви/, weight: 2 },
  { emoji: "🤕", what: "болела голова", re: /голов\S* бол|бол\S* голов|мигрен/ },
  { emoji: "🤧", what: "насморк", re: /насморк|заложен\S* нос|кашл|чиха/ },
  { emoji: "🦷", what: "зубы", re: /зуб|стоматолог/ },
  { emoji: "🩺", what: "врач", re: /врач|доктор|поликлиник|больниц|анализ|терапевт/ },
  { emoji: "💊", what: "таблетки", re: /таблетк|ибупрофен|парацетамол|лекарств|витамин|аевит|омега/ },
  { emoji: "🏋️", what: "зал", re: /\bзал\b|в зале|качал|штанг|гантел|жим|тренажер/ },
  { emoji: "🏃", what: "бег", re: /бегал|пробежк|\bбег\b|пробежал/ },
  { emoji: "🚴", what: "велосипед", re: /велосипед|велик|катался на вел/ },
  { emoji: "🏊", what: "плавание", re: /плавал|бассейн|плавани/ },
  { emoji: "🧘", what: "йога", re: /йог|растяжк|медитир/ },
  { emoji: "⚽", what: "футбол", re: /футбол/ },
  { emoji: "🚶", what: "прогулка", re: /гулял|прогулк|погулял|гуляли/ },
  { emoji: "❤️", what: "с девушкой", re: /девушк|свидани|любим/, weight: 0.9 },
  { emoji: "👨‍👩‍👧", what: "семья", re: /мам[аыеуой]\b|пап[аыеуой]\b|родител|брат|сестр|бабушк|дедушк/, weight: 0.9 },
  { emoji: "👥", what: "друзья", re: /друз|друг[аоу]?\b|с пацан|встретил\S* с/, weight: 0.9 },
  { emoji: "🐱", what: "кот", re: /\bкот(?:[аеуы]|ом|ик\S*)?\b|кошк|чумб/, weight: 0.9 },
  { emoji: "🐶", what: "собака", re: /собак|пс[аеу]\b|щен/, weight: 0.9 },
  { emoji: "🎬", what: "фильм, сериал", re: /сериал|фильм|сери[ийю]|кино|аниме|мультфильм|посмотрел/ },
  { emoji: "📚", what: "книга", re: /книг|читал|прочитал/ },
  { emoji: "🎸", what: "музыка", re: /гитар|музык|пианин|репетиц|концерт|песн/ },
  { emoji: "🎨", what: "рисование", re: /рисовал|рисун|картин|скетч/ },
  { emoji: "🎥", what: "видео", re: /рилс|видео|монтаж|снимал|ютуб|youtube|тикток|стрим/ },
  { emoji: "📱", what: "соцсети", re: /инстаграм|instagram|телеграм|пост\b|подписчик|просмотр/ },
  { emoji: "💻", what: "работа за ПК", re: /код|программир|\bбот\b|бота\b|сайт|верстал|разработ|проект/ },
  { emoji: "💼", what: "работа", re: /работ|офис|созвон|совещани|дедлайн|заказчик|клиент/ },
  { emoji: "📖", what: "учёба", re: /учеб|учил|урок|универ|лекци|экзамен|курс/ },
  { emoji: "🍕", what: "пицца", re: /пицц/ },
  { emoji: "🍣", what: "суши", re: /\bсуши\b|\bролл/ },
  { emoji: "🍔", what: "фастфуд", re: /бургер|макдак|kfc|шаурм|фастфуд/ },
  { emoji: "🍽️", what: "ресторан", re: /ресторан|кафе|доставк/ },
  { emoji: "🍳", what: "готовил", re: /готовил|приготовил|сварил|пожарил|испек/ },
  { emoji: "☕", what: "кофе", re: /кофе|капучино|латте/ },
  { emoji: "🍺", what: "выпивка", re: /пиво|вино|выпил[аи]? (?!таблет)|бар\b|в баре/ },
  { emoji: "🛒", what: "покупки", re: /купил|магазин|покупк|заказал/ },
  { emoji: "🧹", what: "уборка", re: /убирал|уборк|помыл|стирк/ },
  { emoji: "💰", what: "деньги", re: /зарплат|получил деньги|доход|премия/ },
  { emoji: "😴", what: "отсыпался", re: /отсыпал|выспал|весь день спал|дрых/ },
  { emoji: "😄", what: "хорошее настроение", re: /отличн|счастлив|радост|кайф|весел|супер/ },
  { emoji: "😔", what: "грустно", re: /грустн|тоскл|печаль|плохое настроени|депрес/ },
  { emoji: "😠", what: "злился", re: /злил|бесит|разозлил|поругал|ссор/ },
  { emoji: "😩", what: "устал", re: /устал|вымотал|нет сил/ },
];

// \b в JS не видит русских букв — граница слова по буквам Юникода.
const B = String.raw`(?:(?<=\p{L})(?!\p{L})|(?<!\p{L})(?=\p{L}))`;
const TESTS = RULES.map((r) => new RegExp(r.re.source.split("\\b").join(B), "u"));

const HEALTH: Record<string, string> = { head: "🤕", cold: "🤧", meds: "💊", doctor: "🩺", teeth: "🦷", heart: "❤️‍🩹", stomach: "🤢", injury: "🩹", back: "🦴", eyes: "👁️", allergy: "🤧", pressure: "🩺" };

// Картинки эмодзи (web/public/emoji/<имя>.png): обычные (не смешанные) эмодзи набора Emoji Kitchen (emoji.supply/kitchen).
// 17 эмодзи в наборе нет: family, gym, run, bike, bandage, road нарисовал GPT по заданию docs/Эмодзи_задание.pdf,
// остальные (party, pills, swim, yoga, walk, video, work, study, pizza, beer, money) — пока обычные Noto.
const ICONS: Record<string, string> = {
  "🎂": "birthday", "🎉": "party", "✈️": "trip", "🚆": "road", "🤒": "sick", "🤕": "headache", "🤧": "cold", "🦷": "teeth",
  "🩺": "doctor", "💊": "pills", "🏋️": "gym", "🏃": "run", "🚴": "bike", "🏊": "swim", "🧘": "yoga", "⚽": "football",
  "🚶": "walk", "❤️": "love", "👨‍👩‍👧": "family", "👥": "friends", "🐱": "cat", "🐶": "dog", "🎬": "movie", "📚": "book",
  "🎸": "music", "🎨": "art", "🎥": "video", "📱": "social", "💻": "code", "💼": "work", "📖": "study", "🍕": "pizza",
  "🍣": "sushi", "🍔": "burger", "🍽️": "restaurant", "🍳": "cooking", "☕": "coffee", "🍺": "beer", "🛒": "shopping",
  "🧹": "cleaning", "💰": "money", "😴": "sleep", "😄": "happy", "😔": "sad", "😠": "angry", "😩": "tired", "🎮": "games",
  "👟": "steps", "❤️‍🩹": "heart", "🤢": "nausea", "🩹": "bandage", "🦴": "bone", "👁️": "eyes",
};

/** Адрес картинки эмодзи или undefined — тогда рисуется сам символ. */
// ?v= — новая версия картинок (браузер держит старые /emoji/*.png в кэше); при замене картинок увеличить.
const V = 2;
export const emojiIcon = (emoji: string) => (ICONS[emoji] ? `/emoji/${ICONS[emoji]}.png?v=${V}` : undefined);

/** Почему эмодзи у дня: запись (hit — слово, на которое он сработал) или факт («игры 2,5 ч»). */
export interface Why { text: string; hit?: string }
export interface DayEmoji { emoji: string; what: string; why: Why[] }

const mins = (sec: number) => (sec >= 3600 ? `${Math.floor(sec / 3600)} ч ${Math.round((sec % 3600) / 60)} мин` : `${Math.round(sec / 60)} мин`);

/** Совпадение (часто корень: «чиха») расширенное до целых слов: «чихал». */
function wordAt(text: string, from: number, to: number): string | undefined {
  const letter = /[\p{L}\p{N}-]/u;
  while (from > 0 && letter.test(text[from - 1])) from--;
  while (to < text.length && letter.test(text[to])) to++;
  return text.slice(from, to).trim() || undefined;
}

/** Эмодзи по дням: day_key → до max штук, самые заметные первыми; у каждого — почему он там. */
export function dayEmojis(diary: DiaryRow[], activity: ActivityRow[], metrics: MetricRow[], max = 3): Map<string, DayEmoji[]> {
  const score = new Map<string, Map<string, { what: string; s: number; order: number; why: Why[] }>>();
  const add = (day: string, emoji: string, what: string, s: number, order: number, why: Why) => {
    const m = score.get(day) ?? (score.set(day, new Map()), score.get(day)!);
    const cur = m.get(emoji);
    if (!cur) m.set(emoji, { what, s, order, why: [why] });
    else {
      cur.s += s;
      if (!cur.why.some((w) => w.text === why.text)) cur.why.push(why);
    }
  };
  for (const r of diary) {
    if (r.section === "tags") continue; // теги повторяют итог
    const t = r.text.toLowerCase().replace(/ё/g, "е"); // та же длина, что у r.text, — место совпадения общее
    RULES.forEach((rule, i) => {
      const m = TESTS[i].exec(t);
      if (m) add(r.day_key, rule.emoji, rule.what, rule.weight ?? 1, i, { text: r.text, hit: wordAt(r.text, m.index, m.index + m[0].length) });
    });
    if (r.section === "health" && r.topic && HEALTH[r.topic]) add(r.day_key, HEALTH[r.topic], "здоровье", 1, 100, { text: r.text });
    if (r.section === "sport") add(r.day_key, "🏃", "спорт", 0.5, 101, { text: r.text });
  }
  for (const a of activity) {
    const games = a.games.reduce((s, g) => s + g.sec, 0);
    if (games >= 45 * 60) {
      add(a.day_key, "🎮", `игры ${Math.round(games / 360) / 10} ч`, 1 + games / 7200, 102,
        { text: `Игры за ПК ${mins(games)}: ${[...a.games].sort((x, y) => y.sec - x.sec).map((g) => `${g.name} ${mins(g.sec)}`).join(", ")}` });
    }
  }
  for (const m of metrics) {
    if (m.key === "steps" && m.value >= 10000) add(m.day_key, "👟", `${Math.round(m.value).toLocaleString("ru-RU")} шагов`, 1, 103, { text: `Шагов за день: ${Math.round(m.value).toLocaleString("ru-RU")} (от 10 000)` });
    if (m.key === "sport_min" && m.value >= 20) add(m.day_key, "🏃", "спорт", 0.5, 101, { text: `Спорт ${Math.round(m.value)} мин` });
  }
  const out = new Map<string, DayEmoji[]>();
  for (const [day, m] of score) {
    out.set(day, [...m.entries()].sort((a, b) => b[1].s - a[1].s || a[1].order - b[1].order).slice(0, max).map(([emoji, v]) => ({ emoji, what: v.what, why: v.why })));
  }
  return out;
}
