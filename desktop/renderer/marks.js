// Метки над строкой, пока пишешь (вариант А ревью 19.11.2026): какой день, какое время, какая сумма — считает сам виджет,
// простыми правилами, без модели, поэтому мгновенно. Опечатку «в 51» или «послезавтра» вместо «завтра» видно до Enter,
// а не в готовой записи. Фразу целиком по-прежнему разбирает модель (server/src/parse.ts) — метки только подсказка:
// где модель переспросит («в 7» без утра/вечера, parse.ts), метка тоже спрашивает («07:00 или 19:00?»).
// Главное (ревью 20.11.2026): уверенная неверная метка или красная «опечатка» на обычном числе хуже, чем никакой.
// Не уверена — метки нет или «переспросит»; красная — только когда это явно время или дата и такого не бывает.
// Используется в строке чата панели (widget.js syncMarks) и в окне быстрой записи (quick.js). Тест: desktop/test/widget-marks.test.cjs.
// Все имена верхнего уровня — с draft/DRAFT_: скрипты страницы делят одну область имён (renderer-globals.test.cjs).

const DRAFT_SCAN = 600; // длиннее не смотреть: метки нужны для короткой фразы, а считаются на каждую букву
const DRAFT_MAX = 4; // до двух рядов: «51 — нет такого часа» и «07:00 или 19:00?» в один не влезают
const DRAFT_PAST_DAYS = 90; // прошедшая дата дальше трёх месяцев, а такая же впереди — какой год, не понять (dateRead)
const DRAFT_L = String.raw`(?<![\p{L}\d])`; // граница слова: \b в JS только для латиницы («завтра» внутри «послезавтра»)
const DRAFT_R = String.raw`(?![\p{L}\d])`;
// Месяцы — только настоящие окончания: «2 мая», «8 марта», но не «2 майки», «3 мартини».
const DRAFT_MON = ["январ[ьяе]", "феврал[ьяе]", "март[ае]?", "апрел[ьяе]", "ма[йяе]", "июн[ьяе]", "июл[ьяе]", "август[ае]?", "сентябр[ьяе]", "октябр[ьяе]", "ноябр[ьяе]", "декабр[ьяе]"];
const DRAFT_MON_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const DRAFT_WD = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
// Дни недели — формы одного дня: «в пятницу», «до пятницы», «к пятнице». «По пятницам», «каждую пятницу» — привычка (ниже).
const DRAFT_WD_FULL = ["воскресень[еяю]", "понедельник[ау]?", "вторник[ау]?", "сред[ауые]", "четверг[ау]?", "пятниц[ауые]", "суббот[ауые]"];
const DRAFT_WD_STEM = "(?:воскресень|понедельник|вторник|сред|четверг|пятниц|суббот)";
// Слова после числа, с которыми это не время и не деньги: «5 км», «35 страниц», «на 15 минут», «в 30 лет», «12 яиц»,
// «до 10 числа», «в 19 веке».
const DRAFT_UNIT = String.raw`(?:шт\p{L}*|кг|гр?|грамм\p{L}*|км|м|метр\p{L}*|л|литр\p{L}*|мин\p{L}*|сек\p{L}*|час\p{L}*|ч|сут\p{L}*|дн\p{L}*|день|недел\p{L}*|месяц\p{L}*|лет|год\p{L}*|раз\p{L}*|страниц\p{L}*|стр|шаг\p{L}*|%|человек\p{L}*|кабинет\p{L}*|этаж\p{L}*|класс\p{L}*|комнат\p{L}*|квартир\p{L}*|сери\p{L}*|из|балл\p{L}*|кал\p{L}*|ккал|мл|подход\p{L}*|бутыл\p{L}*|пачк\p{L}*|яиц|яйц\p{L}*|штук\p{L}*|тетрад\p{L}*|книг\p{L}*|глав\p{L}*|градус\p{L}*|кмч|млн|млрд|числ\p{L}*|век\p{L}*)`;
// Что считают после предлога: «в 2 магазина», «в 5 подъезде», «после 2 пар», «в 3 копиях», «сел в 45 автобус»,
// «работаю в 2 смены», «в 4 зале», «в 14 поликлинику», «в 5 садике», «в 1 квартале», «пить в 2 приёма», «в 4 руки» — не время.
const DRAFT_COUNT = String.raw`(?:магазин\p{L}*|подъезд\p{L}*|вагон\p{L}*|сезон\p{L}*|пар[аыуе]?|урок\p{L}*|экземпляр\p{L}*|копи\p{L}*|част\p{L}*|дом[аеу]?|школ\p{L}*|процент\p{L}*|случа\p{L}*|мест[аео]?|ряд\p{L}*|корпус\p{L}*|палат\p{L}*|аудитори\p{L}*|автобус\p{L}*|трамва\p{L}*|маршрутк\p{L}*|регион\p{L}*|смен\p{L}*|тайм\p{L}*|групп\p{L}*|тур[аеуы]?|раунд\p{L}*|этап\p{L}*|заход\p{L}*|сло[йяе]|очеред\p{L}*|половин\p{L}*|цвет\p{L}*|номер\p{L}*|том[ае]?|зал[еа]`
  + String.raw`|поликлиник\p{L}*|больниц\p{L}*|роддом\p{L}*|гимнази\p{L}*|лице[йяеию]\p{L}*|(?:дет)?сад(?:[уеа]|ик\p{L}*)?|отделени\p{L}*|терминал\p{L}*|филиал\p{L}*|окн\p{L}*|переговорн\p{L}*`
  + String.raw`|микрорайон\p{L}*|квартал\p{L}*|четверт\p{L}*|полугоди\p{L}*|сет(?:[аеуы]|ах|ов)?|прием(?:а|ах|ов)|рук(?:[иуе]|ах|ами)?)`;
const DRAFT_CUR = String.raw`(?:₽|р\.?|руб\p{L}*\.?|\$|долл\p{L}*|бакс\p{L}*|€|евро|usd|eur|rub)`;
const DRAFT_MULT = String.raw`(?:тыс\p{L}*\.?|тыщ\p{L}*|косар\p{L}*)`; // «2 тыс», «3 тыщи», «2 косаря» — тысячи
// Деньги без знака валюты — только с подсказкой рядом: «за 180», «потратил 450», «скинул маме 300», «такси 450», «450 на такси».
const DRAFT_VERB = String.raw`(?:потрат\p{L}*|заплат\p{L}*|отдал\p{L}*|стоил\p{L}*|стоит|обошл\p{L}*|пришл[оа]|получил\p{L}*|заработ\p{L}*|зарплат\p{L}*|аванс\p{L}*|перев[её]л\p{L}*|скинул\p{L}*|вернул\p{L}*|одолжил\p{L}*|занял\p{L}*|долг(?:а|у|ом|и|ов)?|чек|итого|доход\p{L}*)`;
// Глаголы денег с другим смыслом: «дорога заняла 40», «скинул 12 за полгода», «получил 85 на экзамене» — деньги только от 100,
// если рядом нет кому, «у кого» или карты («скинул маме 50», «занял у брата 50»).
const DRAFT_WEAK = String.raw`(?:занял\p{L}*|скинул\p{L}*|получил\p{L}*)`;
// Зарплату, аванс, аренду пишут в тысячах: «зарплата 85», «аренда 35» — не 85 ₽; деньги — от 1000, «к», «тыс» или валюта.
const DRAFT_BIG = String.raw`(?:зарплат\p{L}*|зп|аванс\p{L}*|аренд\p{L}*|ипотек\p{L}*|преми[яюие]\p{L}*|оклад\p{L}*)`;
const DRAFT_NOUN = String.raw`(?:такси|кофе|обед\p{L}*|ужин\p{L}*|завтрак\p{L}*|продукт\p{L}*|бензин\p{L}*|аренд\p{L}*|подписк\p{L}*|кино|бар|доставк\p{L}*|самокат\p{L}*|метро|проезд\p{L}*|стрижк\p{L}*|аптек\p{L}*|пицц\p{L}*|шаурм\p{L}*|коммуналк\p{L}*|интернет\p{L}*|связь|телефон|спортзал\p{L}*|абонемент\p{L}*|отел\p{L}*|гостиниц\p{L}*|хостел\p{L}*)`;
// Товар, а не дело: у «пиво 6.50», «бензин 31.04» число через точку — цена. У дела («кино 19.30», «доставка 20.11») — время, дата.
const DRAFT_GOODS = String.raw`(?:пив[оа]|бензин\p{L}*|продукт\p{L}*|хлеб\p{L}*|молок\p{L}*|сигарет\p{L}*)`;
// «за 40» — деньги, если в части фразы покупка («купил кофе за 250»), и минуты, если дорога или дело («доехал за 40»,
// «пробежал 3 км за 15», «решил задачу за 20»).
const DRAFT_BUY = String.raw`(?:купи\p{L}*|купл\p{L}*|покуп\p{L}*|взял\p{L}*|заказ\p{L}*|продал\p{L}*|оплат\p{L}*|брал\p{L}*)`;
const DRAFT_MOVE = String.raw`(?:дое\p{L}*|дош[её]?л\p{L}*|добра\p{L}*|долет\p{L}*|пробеж\p{L}*|пробег\p{L}*|проплы\p{L}*|проех\p{L}*|прош[её]?л[аи]?|сдела\p{L}*|реши\p{L}*|собра\p{L}*|прочита\p{L}*|выучи\p{L}*|написа\p{L}*|справи\p{L}*|управи\p{L}*|км|м)`;
// Слово сразу за голым числом, с которым оно ещё может быть суммой: предлог, «налом», день, кому («300 маме»).
// Любое другое слово — то, что считают: «10 лайков», «2 билета», «10 тысяч шагов» — не деньги.
const DRAFT_FREE = String.raw`(?:на|за|в|во|с|со|и|а|но|или|до|от|для|у|к|ко|из|без|уже|еще|всего|только|итого|примерно|наличн\p{L}*|нал\p{L}*|карт\p{L}*|переводом|назад|сегодня|вчера|завтра|позавчера|послезавтра|утром|днем|вечером|ночью)`;
const DRAFT_WHOM = String.raw`(?:мам\p{L}*|пап\p{L}*|брат\p{L}*|сестр\p{L}*|друг[уа]?|подруг\p{L}*|жен[еу]|муж[уа]?|сын[уа]?|доч\p{L}*|бабушк\p{L}*|бабул\p{L}*|дедушк\p{L}*|деду|тет\p{L}*|дяд\p{L}*|коллег\p{L}*|начальник\p{L}*|хозяйк\p{L}*|хозяин\p{L}*|арендодател\p{L}*|сосед\p{L}*)`;
// Слово перед дробью или «5:30» — это измерение, не дата и не время: «вес 85.30», «сахар 5.06», «темп 5:30», «планка 2:30»,
// «размер 20.10».
const DRAFT_METRIC = String.raw`(?:вес\p{L}*|вешу|темп\p{L}*|жар|сахар\p{L}*|глюкоз\p{L}*|рост|курс\p{L}*|пульс\p{L}*|давлени\p{L}*|верси\p{L}*|рейтинг\p{L}*|оценк\p{L}*|кэф|коэф\p{L}*|индекс\p{L}*|гемоглобин\p{L}*|холестерин\p{L}*|планк\p{L}*|км|бег\p{L}*|пробежк\p{L}*|круг\p{L}*|результат\p{L}*|рекорд\p{L}*|размер\p{L}*)`;
// Счёт матча, а не время: «счёт 21:15», «выиграли 21:19», «сет 22:25».
const DRAFT_SCORE = String.raw`(?:сч[её]т\p{L}*|выигр\p{L}*|проигр\p{L}*|сет\p{L}*|вничью|ничь[яюе])`;
// Перед «6:40» без предлога — длительность или доля, а не час: «спал 6:40», «сон 7:30», «соотношение 16:10».
// Не в DRAFT_METRIC: «спал до 9.30» — время подъёма.
const DRAFT_LENGTH = String.raw`(?:сон|спал\p{L}*|поспал\p{L}*|проспал\p{L}*|сплю|соотношени\p{L}*|пропорци\p{L}*|формат\p{L}*)`;
// Уровень, а не час, у «до/около N»: «гемоглобин упал до 9», «нагрелось до 20», «скидка до 20», «было около 20».
const DRAFT_LEVEL = String.raw`(?:подня\p{L}*|подним\p{L}*|упал\p{L}*|упад\p{L}*|сниз\p{L}*|снижа\p{L}*|вырос\p{L}*|нагре\p{L}*|остыл\p{L}*|охлад\p{L}*|скидк\p{L}*|разогна\p{L}*|похуде\p{L}*|сброси\p{L}*|было)`;
// Сон: «лёг в 12» — полночь, «уснул в 2» — ночь, «встал в 8» — утро; модель здесь не переспрашивает, метка тоже.
// «Лечь спать в 12», «ложиться в 12», «уснуть до 12» — тоже сон; «лечу в 12» — не он.
const DRAFT_SLEEP = String.raw`(?:лег|легла|легли|лечь|ложусь|ложит\p{L}*|ложи(?:сь|тесь)|лягу|уснул\p{L}*|усну|уснуть|засыпа\p{L}*|заснул\p{L}*|засну|заснуть|отбой|вырубил\p{L}*|отрубил\p{L}*)`;
const DRAFT_WAKE = String.raw`(?:встал\p{L}*|встаю|встану|вставать|проснул\p{L}*|просыпа\p{L}*|проснусь|подъем)`;
// Утро/вечер сразу после числа: «в 7 вечера», «в 7:30 вечером», «в 3 часа дня».
const DRAFT_Q = String.raw`(?:\s*час\p{L}*)?(?:\s+(утра|утром|дня|днем|вечера|вечером|ночи|ночью))?`;
// Дела со временем: рядом с ними «в 51» — опечатка в часе, а не «уложился в 30». Звонят и на номер («позвонить в 112»),
// поэтому у трёх цифр опечатка — только когда встреча сразу за числом («в 155 встреча»; «встреча в 405» — кабинет).
const DRAFT_MEET = String.raw`(?:встреч\p{L}*|созвон\p{L}*|врач\p{L}*|прием\p{L}*|запис\p{L}*|планерк\p{L}*|собрани\p{L}*|будильник\p{L}*|напомн\p{L}*)`;
const DRAFT_EVENT = String.raw`(?:${DRAFT_MEET}|позвон\p{L}*|звонок)`;
// Деньги или измерение в части фразы: «обед обошёлся в 60», «температура в 38» — большое число после «в» — не опечатка в часе.
const DRAFT_NOT_CLOCK = String.raw`(?:${DRAFT_VERB}|${DRAFT_NOUN}|${DRAFT_METRIC}|обош\p{L}*|обой\p{L}*|уложи\p{L}*|влез\p{L}*|температур\p{L}*)`;
// Дело сделано: «уложились в 2 дня», «ремонт сделали в 4 дня» — это длительность, а не 14:00.
const DRAFT_DONE = String.raw`(?:уложи\p{L}*|управи\p{L}*|справи\p{L}*|сдела\p{L}*|законч\p{L}*|успе\p{L}*|построи\p{L}*|отремонтир\p{L}*|собра\p{L}*|написа\p{L}*|прочита\p{L}*|выучи\p{L}*)`;
// Оплата к сроку: «оплатить интернет до 15», «платёж по кредиту до 15» — чаще число месяца, чем час.
const DRAFT_PAY = String.raw`(?:оплат\p{L}*|заплат\p{L}*|платеж\p{L}*|внест\p{L}*|внеси|погас\p{L}*|кредит\p{L}*|аренд\p{L}*|коммуналк\p{L}*|квартир\p{L}*)`;
const DRAFT_KIND_ORDER = { day: 0, time: 1, sum: 2 };

const DRAFT_RE_PART = new RegExp(`${DRAFT_L}(утр(?:о|ом|а|ечком)|днем|вечер(?:ом|а|ком)?|ноч(?:ью|ь|и))${DRAFT_R}`, "gu");
const DRAFT_RE_Q = new RegExp(`^${DRAFT_Q}`, "u");
const DRAFT_RE_SLEEP_BEFORE = new RegExp(`${DRAFT_L}${DRAFT_SLEEP}(?:\\s+спать)?\\s+$`, "u");
const DRAFT_RE_WAKE_BEFORE = new RegExp(`${DRAFT_L}${DRAFT_WAKE}\\s+$`, "u");
const DRAFT_RE_SLEEP_AFTER = new RegExp(`^\\s+${DRAFT_SLEEP}${DRAFT_R}`, "u");
const DRAFT_RE_WAKE_AFTER = new RegExp(`^\\s+${DRAFT_WAKE}${DRAFT_R}`, "u");
const DRAFT_RE_BED_BEFORE = new RegExp(`${DRAFT_L}спать\\s+$`, "u");
const DRAFT_RE_BED_AFTER = new RegExp(`^\\s+спать${DRAFT_R}`, "u");
const DRAFT_RE_SLEPT_BEFORE = new RegExp(`${DRAFT_L}(?:спал\\p{L}*|поспал\\p{L}*|проспал\\p{L}*|сплю)\\s+$`, "u");
const DRAFT_RE_METRIC = new RegExp(`${DRAFT_L}${DRAFT_METRIC}[\\s:=—-]*$`, "u");
const DRAFT_RE_LENGTH = new RegExp(`${DRAFT_L}${DRAFT_LENGTH}[\\s:=—-]*$`, "u");
const DRAFT_RE_SCORE = new RegExp(`${DRAFT_L}${DRAFT_SCORE}[\\s:=—-]*(?:\\d{1,3}:\\d{1,3}\\s*,\\s*)*$`, "u"); // «счёт 21:15, 18:25»
const DRAFT_RE_LEVEL = new RegExp(`${DRAFT_L}${DRAFT_LEVEL}${DRAFT_R}`, "u");
const DRAFT_RE_AFTER = new RegExp(`^(?:\\s*(?:${DRAFT_UNIT}|${DRAFT_COUNT}|${DRAFT_CUR}|${DRAFT_MULT})${DRAFT_R}|(?:к|k)(?!\\p{L}))`, "u");
const DRAFT_RE_EVENT = new RegExp(`${DRAFT_L}${DRAFT_EVENT}${DRAFT_R}`, "u");
const DRAFT_RE_EVENT_WORD = new RegExp(`^${DRAFT_EVENT}$`, "u");
const DRAFT_RE_MEET_AFTER = new RegExp(`^\\s+${DRAFT_MEET}${DRAFT_R}`, "u");
const DRAFT_RE_NOT_CLOCK = new RegExp(`${DRAFT_L}${DRAFT_NOT_CLOCK}${DRAFT_R}`, "u");
const DRAFT_RE_DONE = new RegExp(`${DRAFT_L}${DRAFT_DONE}${DRAFT_R}`, "u");
const DRAFT_RE_PAY = new RegExp(`${DRAFT_L}${DRAFT_PAY}${DRAFT_R}`, "u");
// «В 9 без 15», «в 9 без четверти» — это 08:45 или 20:45, а не 09:00.
const DRAFT_RE_LESS = /^\s+без\s+(?:\d{1,2}(?!\d)|четверт\p{L}*|пяти|десяти|пятнадцати|двадцати(?:\s+пяти)?)/u;
// Латинское слово перед «22.04», «18.12» — название программы, а это версия: «ubuntu 22.04», «обновил node до 20.11».
const DRAFT_RE_LATIN_BEFORE = /(?:^|[^\p{L}\d])[a-z][a-z\d+#_-]*\s+$/u;
const DRAFT_RE_FREE = new RegExp(`^(?:${DRAFT_FREE}|${DRAFT_WHOM})$`, "u");
const DRAFT_RE_VERB_BEFORE = new RegExp(`${DRAFT_L}${DRAFT_VERB}\\s+(?:\\p{L}+\\s+){0,2}$`, "u"); // «заплатил за квартиру 30к»
const DRAFT_RE_WEAK = new RegExp(`^${DRAFT_WEAK}`, "u");
const DRAFT_RE_BIG_BEFORE = new RegExp(`${DRAFT_L}${DRAFT_BIG}\\s+(?:\\p{L}+\\s+)?$`, "u"); // «зарплата 85», «зп пришла 90»
const DRAFT_RE_TO_WHOM = new RegExp(`${DRAFT_L}(?:у\\s+\\p{L}+|${DRAFT_WHOM}|карт\\p{L}*)${DRAFT_R}`, "u");
// «Расход 500», «расход на бензин 2000» — деньги; «расход воды 120», «расход топлива 12» — нет.
const DRAFT_RE_SPENT_BEFORE = new RegExp(`${DRAFT_L}расход\\p{L}*\\s+(?:(?:на|за)\\s+\\p{L}+\\s+)?$`, "u");
const DRAFT_RE_NOUN_BEFORE = new RegExp(`${DRAFT_L}${DRAFT_NOUN}\\s+$`, "u");
const DRAFT_RE_GOODS_BEFORE = new RegExp(`${DRAFT_L}${DRAFT_GOODS}\\s+$`, "u");
const DRAFT_RE_NOUN_AFTER = new RegExp(`^\\s+на\\s+${DRAFT_NOUN}${DRAFT_R}`, "u");
const DRAFT_RE_ANY_CUE = new RegExp(`${DRAFT_L}(?:${DRAFT_VERB}|${DRAFT_NOUN})${DRAFT_R}`, "u");
const DRAFT_RE_BUY = new RegExp(`${DRAFT_L}(?:${DRAFT_BUY}|${DRAFT_VERB})${DRAFT_R}`, "u");
const DRAFT_RE_MOVE = new RegExp(`${DRAFT_L}${DRAFT_MOVE}${DRAFT_R}`, "u");
const DRAFT_RE_NOUN = new RegExp(`${DRAFT_L}${DRAFT_NOUN}${DRAFT_R}`, "u");
// Прошедшее время: «был», «ходила», «сделали», «пришёл», «лёг», «отвёз», «принёс», «испекла». Не глаголы, хоть и на «-л»:
// «зал», «вокзал», «футбол», «дела», «или», «около», «мыло», «недели», «цели», «родители», «строители», «гантели», «мангал»,
// имена «Оли», «Павел» («сказал», «заказал» — глаголы). Без приставки «бизнес», «фитнес» — не «нёс».
const DRAFT_RE_PAST = /^(?:\p{L}*[аеиоуыяш]л(?:а|о|и)?(?:сь|ся)?|лег(?:ла|ли)?|(?:с|по)?мог(?:ла|ли)?|(?:при|от|у|за|в|вы|под|пере|до|с|про|на|раз|рас|из|ис|по)?(?:вез|нес|пек)(?:ла|ли|ло)?)$/u;
const DRAFT_RE_PAST_NOT = /^(?:или|около|(?:\p{L}*(?:вок|спорт|кино))?зала?|\p{L}*бола?|стола?|пола?|гола?|укола?|канала?|финала?|сериала?|журнала?|бокала?|сигнала?|материала?|квартала?|мангала?|байкала?|школа|дела|дело|сила|тела|тело|село|мало|кола|кило|пчела|игла|скала|шкала|смола|весело|смело|мило|мыло|шило|\p{L}*[аи]тели|недели|модели|цели|отели|постели|гантели|панели|качели|мебели|метели|тоннели|пули|чили|оли|коли|вали|гали|мила|павел|михаил|даниил|угол|стул|ангел|узел|орел|козел|котел)$/u;
// Привычка, а не один день: «по понедельникам», «каждую среду», «каждый вторник и четверг», «каждую неделю в субботу»,
// «каждый второй вторник», «через каждые 2 недели в пятницу», «раз в 2 недели в субботу», «каждый день кроме субботы», «с пн по пт».
// Частота — тоже: «раз в 3 дня», «раз в 2 часа», «раз в 2-3 дня» — не день и не час (а «в 10 утра» после неё — час).
const DRAFT_ANY_WD = `(?:${DRAFT_WD_STEM}\\p{L}*|(?:${DRAFT_WD.join("|")})\\.?)`;
const DRAFT_WD_LIST = `${DRAFT_ANY_WD}(?:\\s*(?:,|и)\\s*(?:во?\\s+)?${DRAFT_ANY_WD})*`;
const DRAFT_RE_HABIT = new RegExp(`${DRAFT_L}(?:по\\s+${DRAFT_WD_STEM}\\p{L}*ам`
  + `|(?:через\\s+)?кажд\\p{L}*\\s+(?:(?:\\d+\\s+)?недел\\p{L}*\\s+(?:в|во)\\s+|(?:втор|треть|перв|последн|четн|нечетн)\\p{L}*\\s+)?${DRAFT_WD_LIST}`
  + `|кроме\\s+${DRAFT_WD_LIST}`
  + `|раз\\s+в\\s+(?:\\d+\\s+)?недел\\p{L}*\\s+(?:в|во)\\s+${DRAFT_ANY_WD}`
  + `|раза?\\s+в\\s+\\d+(?:[.,]\\d+)?(?:\\s*[-–—]\\s*\\d+)?\\s*(?:дн\\p{L}*|день|сут\\p{L}*|час\\p{L}*|ч|мин\\p{L}*|недел\\p{L}*|месяц\\p{L}*|год\\p{L}*|лет)`
  + `|со?\\s+${DRAFT_ANY_WD}\\s+(?:по|до)\\s+${DRAFT_ANY_WD})${DRAFT_R}`, "gu");
// «на следующей неделе», «на след. неделе», «на будущей неделе», «на этой неделе», «на прошлой неделе» рядом с днём недели;
// «на той неделе» — не понять, какой.
const DRAFT_RE_WEEK = new RegExp(`${DRAFT_L}на\\s+(?:(позапрошл|прошл|эт|след|будущ)\\p{L}*\\.?|(той))\\s+(?:недел\\p{L}*|нед\\.?)${DRAFT_R}`, "u");
const DRAFT_WEEK_SHIFT = { позапрошл: -2, прошл: -1, эт: 0, след: 1, будущ: 1 }; // сдвиг по слову — в неделях или в годах
// Год словами рядом с датой: «в следующем году 20 ноября», «5 марта прошлого года».
const DRAFT_RE_YEAR = new RegExp(`${DRAFT_L}(позапрошл|прошл|эт|след|будущ)\\p{L}*\\s+год(?:а|у)?${DRAFT_R}`, "u");
// «через неделю», «через 2 недели» рядом с днём недели.
const DRAFT_RE_WEEKS = new RegExp(`${DRAFT_L}через\\s+(?:неделю|(\\d+)\\s*недел\\p{L}*)${DRAFT_R}`, "u");

const draftPad = (n) => String(n).padStart(2, "0");
const draftHm = (m) => `${draftPad(Math.floor(m / 60) % 24)}:${draftPad(m % 60)}`;
const draftKey = (y, m, d) => `${y}-${draftPad(m)}-${draftPad(d)}`;
function draftAddDays(key, n) {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const draftWdOf = (key) => new Date(`${key}T12:00:00Z`).getUTCDay();
const draftDays = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 864e5);
// Неделя — с понедельника: понедельник недели дня key и день wd (0 — вс) этой недели.
const draftMonday = (key) => draftAddDays(key, -((draftWdOf(key) + 6) % 7));
const draftInWeek = (monday, wd) => draftAddDays(monday, (wd + 6) % 7);
function draftDateOk(y, m, d) {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
// Дата без года: прошла больше месяца назад — значит, следующая такая (как nextYearly на сервере: планы, праздники,
// дни рождения); недавняя — этого года или, в начале января, прошлого (дневник). «29 февраля» в невисокосный год — null: метки нет.
// ahead — срок или цель («к 31 декабря», «до 31.12», «на 30 декабря»): это не дневник, прошлого года у них не бывает.
function draftYearly(mon, d, today, ahead = false) {
  const y = Number(today.slice(0, 4));
  for (const yy of ahead ? [y, y + 1] : [y - 1, y, y + 1]) if (draftDateOk(yy, mon, d) && draftDays(today, draftKey(yy, mon, d)) >= -30) return draftKey(yy, mon, d);
  return null;
}
// Последняя такая дата не позже сегодня — для рассказа о прошлом («30 декабря был на корпоративе» 2 января — прошлого года).
function draftLastOn(mon, d, today) {
  const y = Number(today.slice(0, 4));
  for (let yy = y; yy >= y - 4; yy--) if (draftDateOk(yy, mon, d) && draftKey(yy, mon, d) <= today) return draftKey(yy, mon, d);
  return null;
}
// Такая дата в пределах месяца от сегодня, в любую сторону: «20.11» — завтра, «16.10» — давно.
const draftNearDate = (mon, d, today) => [-1, 0, 1].some((dy) => {
  const y = Number(today.slice(0, 4)) + dy;
  return draftDateOk(y, mon, d) && Math.abs(draftDays(today, draftKey(y, mon, d))) <= 30;
});
// «пт, 20 ноября»; другой год или давно прошедшая дата — с годом: «пн, 5 марта 2026» сразу видно как прошлое.
function draftDayText(key, today) {
  const [y, m, d] = key.split("-").map(Number);
  const year = y !== Number(today.slice(0, 4)) || draftDays(today, key) < -30 ? ` ${y}` : "";
  return `${DRAFT_WD[draftWdOf(key)]}, ${d} ${DRAFT_MON_GEN[m - 1]}${year}`;
}
// Промежуток в одном месяце: «пн, 23 – пт, 27 ноября».
const draftRangeText = (k1, k2, today) => `${DRAFT_WD[draftWdOf(k1)]}, ${Number(k1.slice(8))} – ${draftDayText(k2, today)}`;
// Два прочтения дня недели одной меткой: «пн: 16 или 23 ноября?».
function draftTwoDays(wd, k1, k2) {
  const [, m1, d1] = k1.split("-").map(Number), [, m2, d2] = k2.split("-").map(Number);
  return `${DRAFT_WD[wd]}: ${m1 === m2 ? d1 : `${d1} ${DRAFT_MON_GEN[m1 - 1]}`} или ${d2} ${DRAFT_MON_GEN[m2 - 1]}?`;
}
// Сумма как в разделе «Деньги»: группы разрядов, копейки только если есть («1,50 €»).
function draftMoney(v, cur) {
  const cents = Math.round(v * 100) % 100 !== 0;
  const n = v.toLocaleString("ru-RU", { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: 2 }).replace(/[  ]/g, " ");
  return `${n} ${cur}`;
}

// Часть фразы — от запятой, точки, «!», «?» до следующих; точка между цифрами («15.30») и после сокращения
// («на след. неделе») — не граница.
const DRAFT_RE_ABBR = /(?:^|[^\p{L}])(?:след|нед)$/iu;
const draftStop = (s, j) => ",;!?\n".includes(s[j])
  || (s[j] === "." && !(/\d/.test(s[j - 1] ?? "") && /\d/.test(s[j + 1] ?? "")) && !DRAFT_RE_ABBR.test(s.slice(Math.max(0, j - 5), j)));
function draftClauseStart(s, i) {
  for (let j = i - 1; j >= 0; j--) if (draftStop(s, j)) return j + 1;
  return 0;
}
function draftClauseEnd(s, i) {
  for (let j = i; j < s.length; j++) if (draftStop(s, j)) return j;
  return s.length;
}
// «Начало», «начала» — глагол, только если дальше неопределённая форма: «начало болеть», но не «начало курса», «с начала недели».
const draftIsPast = (w, next = "") => DRAFT_RE_PAST.test(w) && !DRAFT_RE_PAST_NOT.test(w)
  && !(/^начал[ао]$/.test(w) && !/(?:ть|ться|ти)$/.test(next));
// В части фразы вокруг [a, b) есть глагол в прошедшем: «в понедельник был у врача». «Хотел бы», «если бы» — не прошлое;
// слово с большой буквы не в начале фразы — имя («день рождения у Коли», «приедет Павел»), а не глагол. raw — текст как написан.
function draftPastClause(raw, a, b) {
  const st = draftClauseStart(raw, a);
  const left = raw.slice(st, a).match(/\p{L}+/gu) ?? [], right = raw.slice(b, draftClauseEnd(raw, b)).match(/\p{L}+/gu) ?? [];
  const opens = left.length > 0 && (st === 0 || /[.!?\n]/.test(raw[st - 1])); // первое слово фразы — с большой буквы и так
  const words = [...left, ...right], low = words.map((w) => w.toLowerCase().replace(/ё/g, "е"));
  if (low.includes("бы")) return false;
  return words.some((w, i) => ((i === 0 && opens) || !/^\p{Lu}/u.test(w)) && draftIsPast(low[i], low[i + 1]));
}
// Утро/вечер для часа без слова сразу после числа: ближайшее слово перед ним в той же части фразы и после прошлого числа
// («вечером в 9 и утром в 7» — у каждого своё). «3 дня», «конца дня» — не «днём»: из фразы считается только «днём».
function draftPartBefore(s, at) {
  let w = s.slice(draftClauseStart(s, at), at);
  const d = w.search(/\d(?!.*\d)/s);
  if (d >= 0) w = w.slice(d + 1).replace(DRAFT_RE_Q, ""); // «в 9 утра и в 7»: «утра» — у девяти
  return [...w.matchAll(DRAFT_RE_PART)].pop()?.[1] ?? "";
}
// Глагол сна рядом с часом: перед предлогом («лёг в 12», «встал в 8») или сразу после («в 7 встал»).
// Одно «спать» — сон только с «в», «к»: «пора спать в 12», «в 12 спать» — полночь, а «спать до 12» — подъём в полдень.
function draftVerbAt(s, a, b) {
  const before = s.slice(Math.max(0, a - 30), a), after = s.slice(b, b + 30);
  const bed = /^(?:во?|ко?)\s/.test(s.slice(a, a + 3));
  if (DRAFT_RE_SLEEP_BEFORE.test(before) || (bed && DRAFT_RE_BED_BEFORE.test(before))) return "sleep";
  if (DRAFT_RE_WAKE_BEFORE.test(before)) return "wake";
  if (DRAFT_RE_SLEEP_AFTER.test(after) || (bed && DRAFT_RE_BED_AFTER.test(after))) return "sleep";
  return DRAFT_RE_WAKE_AFTER.test(after) ? "wake" : "";
}
// Час по слову: near — слово сразу после числа («в 9 ночи» — 21:00), иначе — из фразы. null — по слову не понять.
// «12 утра» — полдень («встал в 12 утра»), «12 вечера» — полночь. «В 6–8 ночи» — то ли вечер, то ли утро: null.
function draftShift(h, w, near) {
  if (/^вечер/.test(w)) return h === 12 ? 0 : h < 12 ? h + 12 : h;
  if (/^дн/.test(w)) return h >= 1 && h <= 6 ? h + 12 : h; // «в 3 дня» — 15:00, «днём в 11» — 11:00
  if (/^ноч/.test(w)) return h === 12 ? 0 : h < 6 || h > 12 ? h : near && h >= 9 ? h + 12 : null; // «ночью … в 8» — не понять
  if (/^утр/.test(w)) return h <= 12 ? h : null;
  return null;
}
// Час 0–23 по подсказкам: слово после числа, глагол сна, слово во фразе. null — подсказок нет.
function draftHour(h, { q, verb, ctx }) {
  if (q) return draftShift(h, q, true);
  if (verb === "sleep" && (h === 12 || (h >= 1 && h <= 5))) return h % 12;
  if (verb === "wake" && h >= 5 && h <= 11) return h;
  return ctx ? draftShift(h, ctx, false) : null;
}
// Время: { bad } — такого нет; { m, text, ask } — минуты от полуночи (для «или» — первое прочтение) и текст метки.
// Час 1–11 без подсказки — оба прочтения возможны, модель переспросит (parse.ts): метка тоже спрашивает. Точное «7:30» — как написано.
function draftClock(h, mi, exact, hint) {
  if (h > 24 || mi > 59) return { bad: true };
  if (h === 24) return { ask: true, m: mi, text: `${draftHm(mi)}?` };
  const k = h === 0 ? 0 : draftHour(h, hint);
  if (k !== null) return { m: k * 60 + mi, text: draftHm(k * 60 + mi) };
  if (exact || h >= 12) return { m: h * 60 + mi, text: draftHm(h * 60 + mi) };
  return { ask: true, m: h * 60 + mi, text: `${draftHm(h * 60 + mi)} или ${draftHm((h + 12) * 60 + mi)}?` };
}
const draftMetric = (s, at) => DRAFT_RE_METRIC.test(s.slice(Math.max(0, at - 30), at));
// Счёт матча перед числом: «счёт 21:15», «сет 22:25»; в перечне после невозможного часа («волейбол 25:23, 18:25») — тоже счёт.
function draftScore(s, at) {
  const before = s.slice(Math.max(0, at - 40), at);
  const prev = before.match(/(?<!\d)(\d{1,3}):\d{1,3}\s*,\s*$/);
  return DRAFT_RE_SCORE.test(before) || (prev !== null && Number(prev[1]) > 24);
}
// Измерение, длительность или счёт перед числом без предлога: «вес 85.30», «спал 6:40», «соотношение 16:10», «счёт 21:15».
const draftMeasure = (s, at) => draftMetric(s, at) || DRAFT_RE_LENGTH.test(s.slice(Math.max(0, at - 30), at)) || draftScore(s, at);
// За числом — единица, счёт, валюта или тысячи: «в 30 лет», «в 2 магазина», «в 20 евро», «в 12 тысяч», «в 4к».
const draftCountAfter = (s, i) => DRAFT_RE_AFTER.test(s.slice(i, i + 30));
// За числом — то, что считают, в родительном падеже множественного: «около 20 отжиманий», «до 8 стаканов», «после 3 бокалов»,
// «до 10 сигарет». «Часов» и дела («после 7 звонок») — не счёт.
function draftCountedAfter(s, i) {
  const w = s.slice(i).match(/^\s+(\p{L}+)/u)?.[1] ?? "";
  return /(?:ов|ев|ий|ей|ок|ек|ет)$/.test(w) && !/^час/.test(w) && !DRAFT_RE_EVENT_WORD.test(w);
}
// Сразу за числом — конец, предлог или дело: «в 51», «в 51 к врачу», «в 51 созвон» — опечатка в часе.
// Другое слово («в 85 больницу», «в 40 магазин») — номер или счёт, не час.
function draftTypoAfter(s, i) {
  const w = s.slice(i).match(/^\s*(\p{L}+)/u);
  return !w || DRAFT_RE_FREE.test(w[1]) || DRAFT_RE_EVENT_WORD.test(w[1]);
}
// «D.MM» через точку, где день — возможный час (до 23): "date", "time" или "hide" (не понять — ни даты, ни времени).
// Ноль впереди («01.12») — дата. Минуты «12», «03» у времени редки, «05», «10» — обычны: «к 15.12» — 15 декабря,
// «к 9.10» — 9 октября или 09:10. После «в» — время («в 10.10», «электричка в 8.03»), только не ночью с такими минутами:
// «во 2.12» — не понять. Без предлога «созвон 16.10» — не понять, если такая дата не рядом с сегодня (тогда скорее
// дата: «20.11» — завтра). «9.10» без предлога — не понять. «До 18.10», «после 18.05», «с 10.10» — как «к»: час двумя
// цифрами с круглыми минутами читается не хуже даты.
function draftDotReading(pre, ds, ms, today) {
  const d = Number(ds), mon = Number(ms), round = mon % 5 === 0;
  if (ds.length === 2 && ds[0] === "0") return "date";
  if (/^во?$/.test(pre)) return round || d >= 6 ? "time" : "hide";
  if (/^ко?$/.test(pre) || (ds.length === 2 && /^(?:до|после|со?|по)$/.test(pre))) return round ? "hide" : "date";
  if (pre) return "date";
  if (ds.length === 1) return "hide";
  return round && !draftNearDate(mon, d, today) ? "hide" : "date";
}
// Число месяца рядом с днём недели: после — «в пятницу 27», «в пятницу 27-го», «в субботу 28го», до — «22-го в воскресенье».
// { n, sure }: sure — с «-го», это точно число месяца. «В пятницу 7 вечера», «в пятницу 15 человек», «в пятницу 19:00» — null.
function draftDayNum(s, a, b) {
  const m = s.slice(b, b + 40).match(/^\s*,?\s*(\d{1,2})(-?(?:го|ое|е))?(?![\d.:/\p{L}-]|,\d)/u);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 31) {
    if (m[2]) return { n: Number(m[1]), sure: true };
    if (!DRAFT_RE_Q.exec(s.slice(b + m[0].length))[0] && !draftCountAfter(s, b + m[0].length)) return { n: Number(m[1]), sure: false };
  }
  const p = s.slice(draftClauseStart(s, a), a).match(/(?<!\d)(\d{1,2})-?(?:го|ое|е)\s*,?\s*$/);
  return p && Number(p[1]) >= 1 && Number(p[1]) <= 31 ? { n: Number(p[1]), sure: true } : null;
}
// День недели wd с числом n — если такой ровно один в пяти неделях от сегодня, в обе стороны («в воскресенье 22-го»).
function draftWdDate(today, wd, n) {
  const hits = [];
  for (let i = -35; i <= 35; i++) {
    const k = draftAddDays(today, i);
    if (draftWdOf(k) === wd && Number(k.slice(8)) === n) hits.push(k);
  }
  return hits.length === 1 ? hits[0] : null;
}
// Голое число ещё может быть суммой: за ним конец, знак, предлог, глагол («в 12 тысяч уложился») или кому («300 маме», «500 Пете»).
function draftFreeAfter(after, rawAfter) {
  const w = after.match(/^\s+(\p{L}+)/u);
  return !w || DRAFT_RE_FREE.test(w[1]) || draftIsPast(w[1]) || /^\s+\p{Lu}/u.test(rawAfter);
}
// Подсказка, что голое число v — деньги, и какая: "verb" — «потратил 450», «скинул маме 300», «кино 2 билета по 400»,
// «купил кофе за 250»; "weak" — глагол с другим смыслом без кому («дорога заняла 40»); "noun" — одно слово покупки:
// «такси 450», «450 на такси»; "za" — «за 500» без дороги и дела рядом; "" — подсказки нет.
function draftMoneyCue(s, a, b, v) {
  const before = s.slice(Math.max(0, a - 60), a), after = s.slice(b, b + 40);
  const verb = before.match(DRAFT_RE_VERB_BEFORE);
  if (verb) return DRAFT_RE_WEAK.test(verb[0]) && !DRAFT_RE_TO_WHOM.test(s.slice(draftClauseStart(s, a), draftClauseEnd(s, b))) ? "weak" : "verb";
  if (DRAFT_RE_SPENT_BEFORE.test(before)) return "verb";
  if (/(?:^|\s)за\s+$/.test(before)) {
    // «за 40»: с покупкой — деньги; с дорогой или делом («доехал за 40», «км за 5») — минуты; без них — только от 100.
    const clause = s.slice(draftClauseStart(s, a), draftClauseEnd(s, b));
    if (DRAFT_RE_BUY.test(clause)) return "verb";
    if (DRAFT_RE_MOVE.test(clause)) return "";
    if (DRAFT_RE_NOUN.test(clause)) return "noun";
    return v >= 100 ? "za" : "";
  }
  if (DRAFT_RE_NOUN_BEFORE.test(before) || DRAFT_RE_NOUN_AFTER.test(after)) return "noun";
  return /\d+\s+\p{L}+\s+по\s+$/u.test(before) && DRAFT_RE_ANY_CUE.test(s.slice(draftClauseStart(s, a), a)) ? "verb" : "";
}
// Число через точку — цена, а не время и не дата: глагол денег («потратил 8.40», «купил хлеб за 12.40») или товар перед ним
// («пиво 6.50», «бензин 31.04»). Одно слово дела («кино 19.30», «доставка 20.11») — не цена.
function draftPriceAt(s, a, b, v) {
  const cue = draftMoneyCue(s, a, b, v);
  return (cue !== "" && cue !== "noun") || DRAFT_RE_GOODS_BEFORE.test(s.slice(Math.max(0, a - 30), a));
}

/** Метки фразы: [{kind: "day"|"time"|"sum", state: "ok"|"ask"|"bad", text}] по порядку день → время → сумма.
 *  today — день сервера 'YYYY-MM-DD' (data.day), now — 'ЧЧ:ММ' на часах. Чистая функция: ни DOM, ни часов. */
function draftMarks(text, { today, now }) {
  const typed = String(text).slice(0, DRAFT_SCAN);
  const s = typed.toLowerCase().replace(/ё/g, "е");
  const raw = typed.length === s.length ? typed : s; // как написано — для имён с большой буквы; позиции те же, что в s
  const out = [];
  const used = []; // [от, до) — уже объяснённые куски: следующие правила их не трогают
  const free = (a, b) => used.every(([x, y]) => b <= x || a >= y);
  const take = (a, b) => used.push([a, b]);
  const hide = (m) => take(m.index, m.index + m[0].length);
  const scan = (re, fn) => { for (const m of s.matchAll(re)) if (free(m.index, m.index + m[0].length)) fn(m, m.index, m.index + m[0].length); };
  const add = (a, b, kind, state, txt) => { take(a, b); out.push({ kind, state, text: txt, at: a }); };

  // 0. Телефоны, длинные числа, оценки, дроби, давление, спортивное время — никогда не метки:
  //    «+7 912 345-67-89», «123-45-67», «8 из 10», «8/10», «1/2 таблетки», «24/7», «130/85», «за 1:45:20», «5 км за 25:30».
  scan(/(?:\+7|(?<!\d)8)?[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}(?!\d)|\d{7,}/g, hide);
  scan(/(?<![\d-])\d{3}-\d{2}-\d{2}(?![\d-])/g, hide);
  scan(/\d+\s*из\s*\d+/g, hide);
  // Дата через косую — только с годом («20/11/2026») или после «до/к/с/по» («до 20/11»).
  scan(/(?<![\d/])\d+\s*\/\s*\d+(?:\/(\d{4}|\d{2}))?(?![\d/])/g, (m) => {
    const datePre = new RegExp(`${DRAFT_L}(?:до|к|ко|с|со|по)\\s+$`, "u").test(s.slice(0, m.index));
    if (!m[1] && !(datePre && /^\d{1,2}\/\d{2}$/.test(m[0]))) hide(m);
  });
  scan(/(?<![\d:])\d{1,2}:\d{2}:\d{2}(?![\d:])/g, hide);
  scan(new RegExp(`${DRAFT_L}за\\s+\\d{1,2}:\\d{2}(?![\\d:])`, "gu"), hide);

  // 1. День: «завтра», даты, дни недели, «через 3 дня». Даты — раньше дней недели: «в пятницу 27 ноября» — день скажет дата.
  const day = (a, b, key, state = "ok", txt = "") => add(a, b, "day", state, txt || draftDayText(key, today));
  // «После завтра» раздельно — то же «послезавтра» («после завтрака» — нет: граница слова).
  const REL = { позавчера: -2, вчера: -1, сегодня: 0, завтра: 1 };
  scan(new RegExp(`${DRAFT_L}(позавчера|вчера|сегодня|после\\s*завтра|завтра)${DRAFT_R}`, "gu"), (m, a, b) => day(a, b, draftAddDays(today, /^после/.test(m[1]) ? 2 : REL[m[1]])));
  scan(DRAFT_RE_HABIT, hide); // привычка: метки дня нет (время, если есть, остаётся)

  // Дата без года — ближайшая такая (draftYearly); в рассказе о прошлом («был у врача 15 октября») — последняя прошедшая.
  // Прошедшая дальше трёх месяцев, а ближайшая впереди («25 января обещали доставку») — какой год, метка спрашивает.
  // «Записался на 25 ноября», «перенесли на 27 ноября» — срок, он впереди, хоть глагол и в прошедшем
  // («к 15 октября закончил ремонт», «до 15 октября был в отпуске» — прошлое). Год словами («в следующем году 20 ноября»,
  // «5 марта прошлого года») — тот год; такого дня в нём нет — метки нет.
  // { key } — день, { ask } — вопрос, { bad } — такого дня нет ни в каком году, null — метки нет.
  const dateSpans = []; // где метки дат: день недели рядом с ними своей метки не даёт
  const RE_AIM = new RegExp(`${DRAFT_L}на\\s+$`, "u");
  const RE_DUE = new RegExp(`${DRAFT_L}(?:ко?|до)\\s+$`, "u");
  const dateRead = (a, b, d, mon, y) => {
    if (y !== null) return draftDateOk(y, mon, d) ? { key: draftKey(y, mon, d) } : { bad: true };
    if (!draftDateOk(2028, mon, d)) return { bad: true }; // 2028 — високосный: 29 февраля бывает
    const yw = s.slice(draftClauseStart(s, a), draftClauseEnd(s, b)).match(DRAFT_RE_YEAR);
    if (yw) {
      const yy = Number(today.slice(0, 4)) + DRAFT_WEEK_SHIFT[yw[1]];
      return draftDateOk(yy, mon, d) ? { key: draftKey(yy, mon, d) } : null;
    }
    const aim = /^на\s/.test(s.slice(a, a + 3)) || RE_AIM.test(s.slice(Math.max(0, a - 3), a));
    const due = /^(?:ко?|до)\s/.test(s.slice(a, a + 3)) || RE_DUE.test(s.slice(Math.max(0, a - 3), a));
    const next = draftYearly(mon, d, today, aim || due);
    const past = !aim && draftPastClause(raw, a, b) ? draftLastOn(mon, d, today) : null;
    if (past && past !== next && draftDays(past, today) > DRAFT_PAST_DAYS) {
      return next ? { ask: `${d} ${DRAFT_MON_GEN[mon - 1]}: ${past.slice(0, 4)} или ${next.slice(0, 4)}?` } : null;
    }
    const key = past ?? next;
    return key ? { key } : null;
  };
  const dateChip = (a, b, r, badText) => {
    if (!r) return take(a, b); // «в 29 февраля» в невисокосный год — метки нет, и это не «в 29» часов
    dateSpans.push([a, b]);
    if (r.bad) return day(a, b, null, "bad", badText);
    if (r.ask) return day(a, b, null, "ask", r.ask);
    day(a, b, r.key, "ok", r.text);
  };
  const MON = DRAFT_MON.join("|");
  const monOf = (w) => DRAFT_MON.findIndex((x) => new RegExp(`^(?:${x})$`, "u").test(w)) + 1;
  // Промежуток дней — от первого до последнего: «с 1 по 10 декабря», «21-22 ноября». Перечень — «5 и 6 декабря»,
  // «21, 22 и 23 ноября» — одной меткой не сказать: метки нет (а не последний день, будто это день записи).
  scan(new RegExp(`${DRAFT_L}(?:со?\\s+(\\d{1,2})\\s+(?:по|до)\\s+|(\\d{1,2})\\s*[-–—]\\s*)(\\d{1,2})\\s+(${MON})(?:\\s+(\\d{4}))?${DRAFT_R}`, "gu"), (m, a, b) => {
    const d1 = Number(m[1] ?? m[2]), d2 = Number(m[3]), mon = monOf(m[4]);
    const r = dateRead(a, b, d1, mon, m[5] ? Number(m[5]) : null);
    const y = r?.key ? Number(r.key.slice(0, 4)) : 0;
    if (!r?.key || d2 <= d1 || !draftDateOk(y, mon, d2)) return take(a, b);
    dateChip(a, b, { key: r.key, text: draftRangeText(r.key, draftKey(y, mon, d2), today) });
  });
  scan(new RegExp(`${DRAFT_L}\\d{1,2}(?:\\s*,\\s*\\d{1,2})*(?:\\s*,\\s*|\\s+и\\s+)\\d{1,2}\\s+(?:${MON})${DRAFT_R}`, "gu"), hide);
  scan(new RegExp(`${DRAFT_L}(\\d{1,2})\\s+(${MON})(?:\\s+(\\d{4}))?${DRAFT_R}`, "gu"), (m, a, b) => {
    const mon = monOf(m[2]), d = Number(m[1]);
    dateChip(a, b, dateRead(a, b, d, mon, m[3] ? Number(m[3]) : null), `${d} ${DRAFT_MON_GEN[mon - 1]} — такого дня нет`);
  });
  // Числом: «20.11», «до 20/11», «20.11.2026». Без года месяц — двумя цифрами: «85.3», «7.5 часов», «2.1» — дроби, не даты.
  // «11.00», «9.30», «в 10.10» — время (ниже); «вес 85.10», «курс 31.05» — измерения; «к 9.10» — не понять (draftDotReading).
  scan(/(?<![\p{L}\d.:,/])(?:(в|во|к|ко|до|с|со|по|после|на)\s+)?(\d{1,2})([./])(\d{1,2})(?:\3(\d{4}|\d{2}))?(?![\d.,:/])/gu, (m, a, b) => {
    const d = Number(m[2]), mon = Number(m[4]), yr = m[5];
    if (draftMeasure(s, a)) return;
    if (!yr) {
      if (m[4].length !== 2 || mon === 0 || mon > 12 || d === 0 || d > 31 || draftCountAfter(s, b)) return;
      if (m[3] === "." && d <= 23) {
        const reading = draftDotReading(m[1] ?? "", m[2], m[4], today);
        if (reading === "time") return; // время — ниже
        if (reading === "hide") return hide(m);
      }
    }
    // «ubuntu 22.04», «обновил node до 20.11» — версия; «бензин 31.04 за литр» — цена: ни даты, ни времени, ни красной.
    if (DRAFT_RE_LATIN_BEFORE.test(s.slice(Math.max(0, a - 20), a)) || (!m[1] && !yr && draftPriceAt(s, a, b, d))) return hide(m);
    const year = yr ? Number(yr.length === 2 ? `20${yr}` : yr) : null;
    dateChip(a, b, dateRead(a, b, d, mon, year), `${m[0].replace(/^\D+/, "")} — такой даты нет`);
  });
  // Дни недели. Рядом дата («в пятницу 27 ноября», «27.11 в пт») — день скажет дата. Число без месяца: «в воскресенье 22-го» —
  // то воскресенье, если оно одно такое рядом; «в пятницу 27» — какая пятница, не понять. «В ту пятницу», «в чёрную пятницу»,
  // «чёрная пятница», «Робинзон и Пятница», «неделю назад в пятницу» — тоже не понять: метки нет.
  const nearDate = (a, b) => dateSpans.some(([x, y]) => (x >= b && /^\s*,?\s*(?:(?:в|во)\s+)?$/.test(s.slice(b, x))) || (y <= a && /^\s*,?\s*$/.test(s.slice(y, a))));
  const yesterday = draftAddDays(today, -1);
  DRAFT_WD_FULL.forEach((full, wd) => scan(new RegExp(`${DRAFT_L}(?:(в|во|на|до|к|ко|с|со|по)\\s+)?(?:(след(?:ующ\\p{L}*)?\\.?|эт\\p{L}*|ближайш\\p{L}*|позапрошл\\p{L}*|прошл\\p{L}*)\\s+)?(${full}|${DRAFT_WD[wd]}\\.?)${DRAFT_R}`, "gu"), (m, a, b) => {
    const pre = m[1] ?? "", mod = m[2] ?? "", word = m[3];
    // «60 вт» — ватты, «ср.» — «сравни»: сокращение — только с предлогом («в пт»). «Окружающая среда», «в среде разработки» — не день.
    if (word.replace(".", "").length === 2 && !pre) return;
    if (wd === 3 && ((!pre && !mod) || (/^во?$/.test(pre) && word === "среде"))) return;
    const cs = draftClauseStart(s, a), clause = s.slice(cs, draftClauseEnd(s, b));
    if (nearDate(a, b)) return take(a, b);
    const num = draftDayNum(s, a, b);
    if (num) {
      const k = num.sure && draftWdDate(today, wd, num.n);
      return k ? day(a, b, k) : take(a, b);
    }
    if (/(?:^|[^\p{L}])назад(?!\p{L})/u.test(clause)) return take(a, b);
    if (!pre && !mod && /(?:^|[^\p{L}])(?:в|во|на|до|к|ко|с|со|по)\s+\p{L}+\s+$/u.test(s.slice(cs, a))) return take(a, b);
    // Без предлога после прилагательного («чёрная пятница», «страстная пятница») — праздник; с большой буквы не первым
    // словом («Робинзон и Пятница») — имя.
    if (!pre && !mod && (/(?:^|[^\p{L}])\p{L}{2,}(?:ая|яя|ое|ее|ий|ый|ой|ую|юю)\s+$/u.test(s.slice(cs, a))
      || (/^\p{Lu}/u.test(raw.slice(a, b)) && /\p{L}/u.test(raw.slice(cs, a))))) return take(a, b);
    const near = draftAddDays(today, (wd - draftWdOf(today) + 7) % 7);
    // «Через неделю в пятницу» — одна метка, не две: этот день недели в неделе через N недель — или, если он уже прошёл
    // к тому дню («через неделю в понедельник»), — какой из двух, спрашивает.
    const weeks = clause.match(DRAFT_RE_WEEKS);
    if (weeks) {
      take(cs + weeks.index, cs + weeks.index + weeks[0].length);
      const t = draftAddDays(today, 7 * Number(weeks[1] ?? 1));
      const inWeek = draftInWeek(draftMonday(t), wd), onAfter = draftAddDays(t, (wd - draftWdOf(t) + 7) % 7);
      return inWeek === onAfter ? day(a, b, inWeek) : day(a, b, null, "ask", draftTwoDays(wd, inWeek, onAfter));
    }
    // «В пятницу на следующей неделе» — пятница недели с понедельника; «на этой неделе в среду», а среда уже прошла, — метки нет.
    const week = clause.match(DRAFT_RE_WEEK);
    if (week) {
      if (week[2]) return take(a, b); // «на той неделе»
      const k = draftInWeek(draftAddDays(draftMonday(today), 7 * DRAFT_WEEK_SHIFT[week[1]]), wd);
      return week[1] === "эт" && k < today ? take(a, b) : day(a, b, k);
    }
    // «В прошлую среду» в четверг — вчера или неделей раньше (про вчера сказали бы «вчера»): спрашивает.
    const back = (n) => {
      const k = draftAddDays(near, -7 * n);
      return draftAddDays(near, -7) === yesterday ? day(a, b, null, "ask", draftTwoDays(wd, draftAddDays(k, -7), k)) : day(a, b, k);
    };
    if (/^позапрошл/.test(mod)) return back(2);
    if (/^прошл/.test(mod)) return back(1);
    // «В понедельник был у врача» — скорее прошедший понедельник (дневник), но не наверняка: спрашивает.
    // «Договорились на пятницу» — срок, он впереди.
    const past = pre !== "на" && draftPastClause(raw, a, b);
    if (/^эт/.test(mod)) {
      // «В эту среду была у врача» — среда этой недели, если она уже прошла; ещё впереди — какая, не понять.
      // «В эту среду» без прошлого, а среда этой недели уже прошла (сегодня четверг), — тоже спрашивает.
      const k = draftInWeek(draftMonday(today), wd);
      if (past) return k <= today ? day(a, b, k) : day(a, b, null, "ask", draftTwoDays(wd, draftAddDays(k, -7), k));
      return k < today ? day(a, b, null, "ask", draftTwoDays(wd, k, near)) : day(a, b, near);
    }
    if (/^ближайш/.test(mod)) return near === today ? day(a, b, null, "ask", `${DRAFT_WD[wd]}: сегодня или через неделю?`) : day(a, b, near);
    // «В следующую пятницу», «в след. пятницу» на этой неделе — модель может понять по-разному: метка спрашивает.
    if (/^след/.test(mod)) return near === today ? day(a, b, draftAddDays(near, 7)) : day(a, b, null, "ask", draftTwoDays(wd, near, draftAddDays(near, 7)));
    if (past) return day(a, b, null, "ask", draftTwoDays(wd, draftAddDays(near, -7), near));
    if (near === today) return day(a, b, null, "ask", `${DRAFT_WD[wd]}: сегодня или через неделю?`);
    day(a, b, near);
  }));
  // «Через 3 дня», «через неделю». «Через 2 дня после операции» — считается не от сегодня: метки нет.
  scan(new RegExp(`${DRAFT_L}через\\s+(\\d+|неделю)\\s*(дн\\p{L}*|день|недел\\p{L}*)?${DRAFT_R}`, "gu"), (m, a, b) => {
    const anchor = s.slice(b).match(/^\s+(?:после|до)\s+[\p{L}\d]+/u);
    if (anchor) return take(a, b + anchor[0].length);
    const n = m[1] === "неделю" ? 7 : /^недел/.test(m[2] ?? "") ? 7 * Number(m[1]) : /^(дн|день)/.test(m[2] ?? "") ? Number(m[1]) : null;
    if (n !== null && n <= 366) day(a, b, draftAddDays(today, n));
  });

  // 2. Время. Утро/вечер — сразу после числа («в 7 вечера») или ближайшее во фразе («завтра вечером в 7»), сон — по глаголу.
  const time = (a, b, state, txt) => add(a, b, "time", state, txt);
  const hint = (a, b, q) => ({ q, verb: draftVerbAt(s, a, b), ctx: draftPartBefore(s, a) });
  scan(new RegExp(`${DRAFT_L}в\\s+(полдень|полночь)${DRAFT_R}`, "gu"), (m, a, b) => time(a, b, "ok", m[1] === "полдень" ? "12:00" : "00:00"));
  // «через 2 часа», «через полчаса», «через 1 час 30 минут», «через час и 15 минут».
  // «Через 2 часа после еды», «через час после ужина» — от еды, а не от «сейчас»: метки нет (и у «после 18» тоже).
  scan(new RegExp(`${DRAFT_L}через\\s+(?:(\\d+(?:[.,]\\d)?)\\s+)?(полчаса|полтора\\s+час\\p{L}*|час\\p{L}*|мин\\p{L}*)(?:\\s+(?:и\\s+)?(\\d+)\\s*мин\\p{L}*)?${DRAFT_R}`, "gu"), (m, a, b) => {
    const anchor = s.slice(b).match(/^\s+(?:после|до)\s+[\p{L}\d]+/u);
    if (anchor) return take(a, b + anchor[0].length);
    const base = m[2] === "полчаса" ? 30 : /^полтора/.test(m[2]) ? 90 : Number((m[1] ?? "1").replace(",", ".")) * (/^час/.test(m[2]) ? 60 : 1);
    const n = Math.round(base + Number(m[3] ?? 0));
    const [h, mi] = now.split(":").map(Number);
    const t = h * 60 + mi + n;
    if (n > 0 && n < 24 * 60) time(a, b, "ok", `≈ ${draftHm(t)}${t >= 1440 ? " завтра" : ""}`);
  });
  // Длительность — «на 15 минут», «за 5 минут», «2 часа» — объяснена, метки нет.
  scan(new RegExp(`${DRAFT_L}(?:(?:на|за)\\s+)?\\d+(?:[.,]\\d+)?\\s*(?:мин\\p{L}*|час\\p{L}*|ч|сек\\p{L}*)${DRAFT_R}(?!\\s*(?:утра|дня|вечера|ночи))`, "gu"), (m) => {
    if (/^(на|за)\s/.test(m[0]) || !/(?:^|\s)(в|во|к|до|с|после|около)\s+$/.test(s.slice(0, m.index))) hide(m);
  });
  // Промежуток: «с 9 до 18», «15:00–16:30», «с 9.00 до 18.00», «в 15.00-16.00», «в 10-11». «5-6 штук» — не время.
  const T = String.raw`(\d{1,2})(?:([:.,-])(\d{2}))?`;
  scan(new RegExp(`${DRAFT_L}(?:(с|со|в|во)\\s+)?${T}${DRAFT_Q}\\s*(до|-|–|—)\\s*${T}${DRAFT_Q}(?![\\d\\p{L}]|[:.,]\\d)`, "gu"), (m, a, b) => {
    const pre = m[1] ?? "", ha = Number(m[2]), ma = Number(m[4] ?? 0), hb = Number(m[7]), mb = Number(m[9] ?? 0);
    const mins = Boolean(m[4] || m[9]);
    if (!pre && !mins) return;
    // «в 10-11» — промежуток; «в 19-30», «в 9-15» — это минуты (ниже); «в 9 до 18» — не промежуток.
    if (/^во?$/.test(pre) && (m[6] === "до" || (!mins && !(hb > ha && hb - ha <= 2)))) return;
    if (draftCountAfter(s, b)) return; // «с 5 до 7 лет», «с 20 до 30 человек»
    const slept = DRAFT_RE_SLEPT_BEFORE.test(s.slice(Math.max(0, a - 30), a)); // «спал с 2 до 10» — ночь и утро
    const ctx = draftPartBefore(s, a);
    const hintA = { q: m[5], verb: slept ? "sleep" : "", ctx };
    let A = draftClock(ha, ma, Boolean(m[4]), hintA);
    const B = hb === 24 && !mb ? { m: 1440 } : draftClock(hb, mb, Boolean(m[9]), { q: m[10], verb: slept ? "wake" : "", ctx });
    // Красная — только для явных часов с минутами, на тот конец, где ошибка: «с 9:00 до 25:00» — «25:00». «С 20 до 25» — скорее числа месяца.
    if (A.bad || B.bad) {
      const wrong = A.bad ? `${m[2]}${m[3] ?? ""}${m[4] ?? ""}` : `${m[7]}${m[8] ?? ""}${m[9] ?? ""}`;
      if (/\d:\d/.test(m[0])) time(a, b, "bad", `${wrong} — нет такого времени`);
      return;
    }
    // «С 7 до 9 вечера», «в 10-11 вечера», «с 10 до 12 ночи»: слово у конца — и у начала, если начало с ним всё ещё раньше
    // конца (19:00–21:00, 22:00–00:00). «С 9 до 6 вечера» — 21:00 позже 18:00: начало остаётся 09:00.
    // «С 10 до 2 ночи» — начало 6–11 с «ночи» у конца — вечер, а конец — уже после полуночи: 22:00–02:00.
    if (m[10] && !m[5] && ha >= 1 && ha <= 11 && draftHour(ha, hintA) === null) {
      const night = /^ноч/.test(m[10]);
      const A2 = night && ha >= 6 ? { m: (ha + 12) * 60 + ma } : draftClock(ha, ma, true, { q: m[10] });
      if (A2.m < (night && B.m <= A2.m ? B.m + 1440 : B.m || 1440)) A = A2;
    }
    const span = (x, y) => `${draftHm(x)}–${draftHm(y)}`;
    let x = A.m, y = B.m;
    if (x === y) return take(a, b); // «с 9 до 9», «с 12 до 12» — не промежуток: метки нет
    if (A.ask && B.ask) {
      // «с 9 до 6», «с 8 до 5» — рабочий день: 09:00–18:00. Иначе — один вопрос на весь промежуток, не два «или».
      if (hb >= ha) return time(a, b, "ask", `${span(x, y)} или ${span(x + 720, y + 720)}?`);
      y += 720;
    } else if (A.ask) {
      if (x >= y) return time(a, b, "ask", `${span(x, y)}?`);
    } else if (B.ask) {
      if (y <= x) y += 720; // «с 14 до 6» — до 18:00
      if (y <= x) return time(a, b, "ask", `${span(x, B.m)}?`);
    }
    time(a, b, "ok", span(x, y));
  });
  // Предлог и час: «в 7», «к 19:30», «до 18.00», «в 19-30», «в 15 30», «в 19 часов 30 минут», «в 7:30 вечера».
  // Дальше — минуты, утро/вечер и что за числом.
  scan(new RegExp(`${DRAFT_L}(в|во|к|ко|до|после|около|на|с|со)\\s+(\\d+)(?!\\d)`, "gu"), (m, a) => {
    const pre = m[1], hs = m[2];
    let b = a + m[0].length;
    const rest = s.slice(b);
    const ord = rest.match(/^-\p{L}+/u);
    if (ord) return take(a, b + ord[0].length); // «к 20-му», «в 90-х» — число месяца, годы
    if (/^\p{L}/u.test(rest)) return; // «в 4к», «в 2х»
    // Красная «нет такого часа» — только рядом с делом или днём: «в 51 созвон»; «родила в 25», «сел в 45 автобус» — не время.
    const clause = s.slice(draftClauseStart(s, a), draftClauseEnd(s, b));
    const timeish = () => out.some((x) => x.kind === "day") || DRAFT_RE_EVENT.test(clause);
    if (hs.length > 2) {
      // «в 155 встреча», «в 1530 встреча» — опечатка в часе: встреча сразу за числом. «Встреча в 405» — кабинет,
      // «позвонить в 112» — номер, «обед обошёлся в 450» — деньги, «в 2026» — год, «в 300 метрах» — не время.
      if (/^(в|во|к|ко)$/.test(pre) && !/^(19|20)\d\d$/.test(hs) && !/^[.,:-]?\d/.test(rest) && !draftCountAfter(s, b) && DRAFT_RE_MEET_AFTER.test(rest)) time(a, b, "bad", `${hs} — нет такого часа`);
      return;
    }
    let sep = "", mm = "", exact = false;
    const mt = rest.match(/^([:.,-])(\d+)(?!\d)/);
    const hw = rest.match(/^\s*час\p{L}*\s+(\d{1,2})(?!\d)(\s*мин\p{L}*)?/u);
    if (mt) {
      if (mt[2].length !== 2) {
        // «в 15:5», «в 15:300» — опечатка в минутах; «в 1.5 раза», «до 38.5» — дробь, не время;
        // «с 0:2 до 2:2», «поставил на 2:1» — счёт или ставка: цифра к цифре — не красная.
        if (mt[1] === ":" && (hs.length === 2 || mt[2].length > 2)) time(a, b + mt[0].length, "bad", `${hs}:${mt[2]} — нет такого времени`);
        return;
      }
      if (!free(b, b + mt[0].length)) return; // «в 9-10 декабря» — числа уже у даты
      // «в 9-18» — скорее часы работы, чем 09:18: через дефис минуты — круглые («в 19-30», «в 9-15») или больше 24.
      const n = Number(mt[2]);
      if (mt[1] === "-" && n % 5 !== 0 && n <= 24 && n > Number(hs)) return take(a, b + mt[0].length);
      [, sep, mm] = mt;
      b += mt[0].length;
      exact = true;
    } else if (hw && (hw[2] || (free(b, b + hw[0].length) && !draftCountAfter(s, b + hw[0].length)))) {
      // «в 19 часов 30 минут», «в 7 часов 15» — минуты словами; как «в 7» — без утра/вечера спрашивает. «75 минут» — не понять.
      if (Number(hw[1]) > 59) return;
      sep = " ";
      mm = draftPad(hw[1]);
      b += hw[0].length;
    } else {
      // «в 19 30» — минуты через пробел, если за ними не «человек», «рублей»: «в 15 30 человек» — это 15:00.
      // «в 18 30 ноября» — «30» уже у даты: 18:00.
      const sp = rest.match(/^ (\d{2})(?![\d.,:])/);
      if (sp && free(b, b + sp[0].length) && Number(hs) <= 23 && Number(sp[1]) <= 59 && !draftCountAfter(s, b + sp[0].length)) {
        sep = " "; mm = sp[1]; b += sp[0].length; exact = true;
      }
    }
    const qm = s.slice(b).match(DRAFT_RE_Q);
    b += qm[0].length;
    if (!qm[1] && draftCountAfter(s, b)) return; // «в 2 магазина», «в 30 лет», «в 20 евро», «в 12 тысяч» — не время
    if (/[.,]/.test(sep) && draftMetric(s, a)) return; // «сахар до 5.50»
    const h = Number(hs), mi = Number(mm || 0);
    if (!mm) {
      if (/^(на|с|со)$/.test(pre)) return; // «на 15», «с 2 друзьями» — не время; «на 15:00», «с 10.00» — время
      if (h > 24) {
        // «в 51 созвон» — опечатка; «к 25» — к числу месяца; «до 38», «после 40», «около 30» — температура, вес, возраст.
        // За числом другое слово («в 85 больницу») или рядом деньги, измерение («температура в 38») — не опечатка.
        const typo = (/^во?$/.test(pre) || (/^ко?$/.test(pre) && h > 31)) && timeish() && draftTypoAfter(s, b) && !DRAFT_RE_NOT_CLOCK.test(clause);
        if (typo) time(a, b, "bad", `${hs} — нет такого часа`);
        return;
      }
      // «сахар до 7», «гемоглобин упал до 9», «скидка до 20», «было около 20» — уровень, а не час.
      if (/^(до|около)$/.test(pre) && !qm[1] && (draftMetric(s, a) || DRAFT_RE_LEVEL.test(s.slice(draftClauseStart(s, a), a)))) return;
      // «в 9 без 15», «в 9 без четверти» — 08:45 или 20:45, а не 09:00.
      const less = s.slice(b).match(DRAFT_RE_LESS);
      if (less) return take(a, b + less[0].length);
      // «в 6–8 ночи» — то ли вечер, то ли утро («в 9 ночи» — 21:00, «в 2 ночи» — 02:00).
      if (/^ноч/.test(qm[1] ?? "") && h >= 6 && h <= 8) return take(a, b);
      // «уложились в 2 дня», «ремонт сделали в 4 дня» — длительность, а не 14:00.
      if (/^во?$/.test(pre) && qm[1] === "дня" && DRAFT_RE_DONE.test(clause)) return take(a, b);
      if (!qm[1] && !/час/.test(qm[0])) {
        // «оплатить интернет до 15», «платёж по кредиту до 15» — скорее число месяца, чем час.
        if (/^(до|ко?)$/.test(pre) && DRAFT_RE_PAY.test(clause)) return take(a, b);
        // «около 20 отжиманий», «до 8 стаканов воды», «после 3 бокалов» — счёт, а не час.
        if (/^(до|около|после)$/.test(pre) && draftCountedAfter(s, b)) return take(a, b);
      }
    }
    const c = draftClock(h, mi, exact, hint(a, b, qm[1]));
    if (!c.bad) time(a, b, c.ask ? "ask" : "ok", c.text);
    else if (sep === ":") time(a, b, "bad", `${hs}:${mm} — нет такого времени`); // «в 19-75», «до 38.50» — не красная
  });
  // Без предлога: «посылку 9.30», «стоматолог 15:30». «1.50 евро», «12.30 кг», «темп 5:30», «вес 85.30», «спал 6:40» — не время.
  // Час до пяти без утра/ночи — скорее длительность («тренировка 1:20», «марафон 4:15»); «48:30», «26:40» — минуты и секунды
  // («время 48:30», «5 км, 26:40»): метки нет, и не красная — красная только после «в/к/до/с».
  // Через точку после «за» или рядом с деньгами — цена: «кофе за 6.50», «потратил 8.40», «пиво 6.50».
  scan(/(?<![\d:.,])(\d{1,2})([:.])(\d{2})(?![\d:.,])/gu, (m, a, b) => {
    if (draftCountAfter(s, b) || draftMeasure(s, a)) return;
    if (m[2] === "." && (/(?:^|\s)за\s+$/.test(s.slice(Math.max(0, a - 4), a)) || draftPriceAt(s, a, b, Number(`${m[1]}.${m[3]}`)))) return;
    const qm = s.slice(b).match(DRAFT_RE_Q);
    if (!qm[1] && Number(m[1]) <= 5) return;
    const c = draftClock(Number(m[1]), Number(m[3]), true, hint(a, b, qm[1]));
    if (!c.bad) time(a, b + (qm[1] ? qm[0].length : 0), c.ask ? "ask" : "ok", c.text);
  });

  // 3. Сумма. «1 240», «1 240,50», «1.500» (с подсказкой денег — тысяча пятьсот), «1,50», «30к», «2 тыс», «3 тыщи», «2 косаря», «$1.5k».
  //    Число не делится на части по запятой: «1 240,50 ₽» — одна сумма, а не «50 ₽».
  const NUM = String.raw`(\d{1,3}(?:[  ]\d{3})+(?:[.,]\d{2})?|\d{1,3}(?:\.\d{3})+(?![\d,])|\d+(?:[.,]\d+)?)(?![.,]?\d)`;
  const val = (n) => Number(/^\d{1,3}(?:\.\d{3})+$/.test(n) ? n.replace(/\./g, "") : n.replace(/[  ]/g, "").replace(",", "."));
  const curOf = (c) => (!c ? "₽" : /^(\$|долл|бакс|usd)/.test(c) ? "$" : /^(€|евро|eur)/.test(c) ? "€" : "₽");
  const sum = (a, b, v, cur) => { if (v > 0 && v < 1e9) add(a, b, "sum", "ok", draftMoney(v, cur)); };
  scan(new RegExp(`${DRAFT_L}полтора\\s+косар\\p{L}*|(?<!\\d\\s*)${DRAFT_L}косар(?:ь|я)${DRAFT_R}|${DRAFT_L}пятихат\\p{L}*`, "gu"),
    (m, a, b) => sum(a, b, /полтора/.test(m[0]) ? 1500 : /пятихат/.test(m[0]) ? 500 : 1000, "₽"));
  scan(new RegExp(`([$€₽])\\s*${NUM}(?:(к|k)(?!\\p{L}))?|(?<!\\d[.,])${DRAFT_L}${NUM}(?:(к|k)(?!\\p{L})|\\s*(${DRAFT_MULT}))?\\s*(${DRAFT_CUR})?(?![\\p{L}\\d])`, "gu"), (m, a, b) => {
    if (m[1]) return sum(a, b, val(m[2]) * (m[3] ? 1000 : 1), curOf(m[1])); // «$20», «$1.5k»
    const [, , , , n, k, mult = "", cur] = m;
    const v = val(n) * (k || mult ? 1000 : 1);
    const after = s.slice(b);
    if (cur) {
      // «3 рубля 50 копеек» — одна сумма.
      const kop = /^(₽|р|руб)/.test(cur) && !k && !mult && /^\d+$/.test(n) ? after.match(/^\s+(\d{1,2})\s*коп\p{L}*/u) : null;
      return kop ? sum(a, b + kop[0].length, v + Number(kop[1]) / 100, "₽") : sum(a, b, v, curOf(cur)); // «450 ₽», «в 20 евро», «5 тыс. руб.»
    }
    if (/^\d{4}$/.test(n) && /^\s*г/.test(after)) return; // «2026 год»
    if (/^\s*[-–—]\s*\d{1,2}(?!\d)/.test(after)) return; // «обед 13-14», «доставка 14-18» — часы, не деньги
    if (!k && !mult && /^\d+[.,]\d$/.test(n)) return; // «зарплата 85.5», «потратил 1.5» — тысячи или дробь, не копейки
    if (draftCountAfter(s, b) && !/^\s+из\s/.test(after)) return; // «за 2 недели», «потратил 2 недели на ремонт»
    if (!draftFreeAfter(after, raw.slice(b))) return; // «10к шагов», «2 билета», «10 лайков» — счёт, не деньги
    if (/^косар/.test(mult)) return sum(a, b, v, "₽");
    // «в 12 тысяч уложился», «бюджет до 30 тысяч» — тысячи после предлога — деньги; «в 4к», «5к» без подсказки — нет.
    if (mult && new RegExp(`${DRAFT_L}(?:в|во|до|около|после|на|за|от|по)\\s+$`, "u").test(s.slice(Math.max(0, a - 10), a))) return sum(a, b, v, "₽");
    const cue = draftMoneyCue(s, a, b, v);
    // Голое число без знака и тысяч: до 10 — не рубли («получил 5», «кофе 2»), при одном слове покупки — до 30 («аренда 25»,
    // «кино 7»), у глагола с другим смыслом — до 100 («дорога заняла 40»), у зарплаты, аванса, аренды — до 1000 («зарплата 85»).
    const least = DRAFT_RE_BIG_BEFORE.test(s.slice(Math.max(0, a - 40), a)) ? 1000 : cue === "weak" ? 100 : cue === "noun" ? 30 : 10;
    if (cue && (k || mult || v >= least)) sum(a, b, v, "₽");
  });

  // Порядок как в записи: день, время, сумма; одинаковые — один раз.
  const seen = new Set();
  return out
    .sort((a, b) => DRAFT_KIND_ORDER[a.kind] - DRAFT_KIND_ORDER[b.kind] || a.at - b.at)
    .filter((x) => !seen.has(`${x.kind}${x.text}`) && seen.add(`${x.kind}${x.text}`))
    .map(({ kind, state, text: t }) => ({ kind, state, text: t }));
}
// День на часах компьютера (окно быстрой записи не знает дня сервера) и время сейчас.
function draftNow(d = new Date()) {
  return { today: `${d.getFullYear()}-${draftPad(d.getMonth() + 1)}-${draftPad(d.getDate())}`, now: `${draftPad(d.getHours())}:${draftPad(d.getMinutes())}` };
}

// --- показ ---
const DRAFT_ICON = { day: "📅", time: "⏰", sum: "💰" };
const DRAFT_TITLE = { ok: "Так поняла строка — фразу целиком горничная разберёт после Enter", ask: "Можно понять по-разному — горничная переспросит", bad: "Похоже на опечатку" };
const DRAFT_STATE_ORDER = { bad: 0, ask: 1, ok: 2 };
function draftChip(m) {
  const el = document.createElement("span");
  el.className = `dmark ${m.kind} ${m.state}`;
  el.textContent = `${DRAFT_ICON[m.kind]} ${m.text}`;
  el.title = DRAFT_TITLE[m.state];
  return el;
}
// Сколько рядов разрешено (box.dataset.rows, по умолчанию 2; окну быстрой записи — один): что перенеслось ниже, убирается,
// как у подсказок (hints.js). Метки уже по важности, поэтому отрезаются «ок», а не опечатка; спрятанных меток в ряду нет.
function draftTrimRows(box, rows) {
  const tops = [];
  for (const el of [...box.children]) {
    const top = Math.round(el.getBoundingClientRect().top);
    if (!tops.includes(top)) tops.push(top);
    if (tops.length > rows) el.remove();
  }
}
/** Метки текста в ряд box; перерисовывает, только когда метки поменялись (не на каждую букву). Есть метки — true.
 *  Опечатка и «переспросит» — вперёд (внутри — день, время, сумма), потом обрезка до DRAFT_MAX и до рядов: красная не теряется. */
function draftMarksShow(box, text, ctx) {
  const all = String(text).trim() ? draftMarks(text, ctx) : [];
  const list = [...all].sort((a, b) => DRAFT_STATE_ORDER[a.state] - DRAFT_STATE_ORDER[b.state]).slice(0, DRAFT_MAX);
  const rows = Number(box.dataset.rows) || 2;
  const key = `${rows}|${list.map((m) => `${m.kind}:${m.state}:${m.text}`).join("|")}`;
  if (box.dataset.key !== key) {
    box.replaceChildren(...list.map(draftChip));
    box.classList.toggle("hidden", !list.length);
    // Ряд сейчас не виден (запись голоса, открытая история) — мерить нечего: перерисовать и обрезать в следующий раз.
    const measured = box.getClientRects().length > 0;
    if (measured) draftTrimRows(box, rows);
    box.dataset.key = measured || !list.length ? key : "";
  }
  box.classList.toggle("hidden", !box.children.length);
  return box.children.length > 0;
}
