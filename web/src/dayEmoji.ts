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
  { emoji: "🍣", what: "суши", re: /суши|ролл/ },
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

//  в JS не видит русских букв — граница слова по буквам Юникода.
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

export interface DayEmoji { emoji: string; what: string }

/** Эмодзи по дням: day_key → до max штук, самые заметные первыми. */
export function dayEmojis(diary: DiaryRow[], activity: ActivityRow[], metrics: MetricRow[], max = 3): Map<string, DayEmoji[]> {
  const score = new Map<string, Map<string, { what: string; s: number; order: number }>>();
  const add = (day: string, emoji: string, what: string, s: number, order: number) => {
    const m = score.get(day) ?? (score.set(day, new Map()), score.get(day)!);
    const cur = m.get(emoji);
    if (cur) cur.s += s; else m.set(emoji, { what, s, order });
  };
  for (const r of diary) {
    if (r.section === "tags") continue; // теги повторяют итог
    const t = r.text.toLowerCase().replace(/ё/g, "е");
    RULES.forEach((rule, i) => { if (TESTS[i].test(t)) add(r.day_key, rule.emoji, rule.what, rule.weight ?? 1, i); });
    if (r.section === "health" && r.topic && HEALTH[r.topic]) add(r.day_key, HEALTH[r.topic], "здоровье", 1, 100);
    if (r.section === "sport") add(r.day_key, "🏃", "спорт", 0.5, 101);
  }
  for (const a of activity) {
    const games = a.games.reduce((s, g) => s + g.sec, 0);
    if (games >= 45 * 60) add(a.day_key, "🎮", `игры ${Math.round(games / 360) / 10} ч`, 1 + games / 7200, 102);
  }
  for (const m of metrics) {
    if (m.key === "steps" && m.value >= 10000) add(m.day_key, "👟", `${Math.round(m.value).toLocaleString("ru-RU")} шагов`, 1, 103);
    if (m.key === "sport_min" && m.value >= 20) add(m.day_key, "🏃", "спорт", 0.5, 101);
  }
  const out = new Map<string, DayEmoji[]>();
  for (const [day, m] of score) {
    out.set(day, [...m.entries()].sort((a, b) => b[1].s - a[1].s || a[1].order - b[1].order).slice(0, max).map(([emoji, v]) => ({ emoji, what: v.what })));
  }
  return out;
}
