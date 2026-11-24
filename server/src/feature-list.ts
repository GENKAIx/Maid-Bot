// Белый список фич для админки «Использование функций» (этап 3, docs/review/админка-2026-11-24.html). Один источник на всех:
// сервер принимает от клиентов только имена отсюда (feature-events.ts), админка берёт отсюда названия и группы, тест сайта
// (web/test/usage.test.ts) сверяет с этим списком имя в каждом вызове track на сайте. Программа на ПК шлёт имена группы «Виджет».
// by: "client" — считает клиент и шлёт пачкой на POST /api/events/usage; "server" — сервер видит сам (ручка API, команда бота,
// ветка разбора), такие имена от клиентов не принимаются, иначе посчитались бы дважды. api — ручка, по которой сервер считает
// («POST /api/tasks/:id», :id — число); у остальных серверных — место в коде в комментарии строки.
// Только имена и счётчики: ни текстов, ни chat id. Новая фича — строка сюда и вызов в нужном месте.

export type FeatureGroup = "site" | "widget" | "bot" | "common";
export const FEATURE_GROUPS: Record<FeatureGroup, string> = { site: "Сайт", widget: "Виджет", bot: "Бот", common: "Общие" };

export interface FeatureDef { id: string; title: string; group: FeatureGroup; by: "client" | "server"; api?: string }

const site = (id: string, title: string): FeatureDef => ({ id, title, group: "site", by: "client" });
const widget = (id: string, title: string): FeatureDef => ({ id, title, group: "widget", by: "client" });
const bot = (id: string, title: string): FeatureDef => ({ id, title, group: "bot", by: "server" });
const common = (id: string, title: string, api?: string): FeatureDef => ({ id, title, group: "common", by: "server", ...(api ? { api } : {}) });

export const FEATURES: FeatureDef[] = [
  // Сайт: открытые экраны (App.tsx, по адресу) и действия, которых сервер не видит.
  site("screen.today", "Экран «Сегодня»"),
  site("screen.plans", "Экран «Планы»"),
  site("screen.habits", "Экран «Привычки»"),
  site("screen.diary", "Экран «Дневник»"),
  site("screen.profile", "Экран «Профиль»"),
  site("screen.persona", "Экран «Персонализация»"),
  site("screen.notes", "Экран «Заметки»"),
  site("screen.health", "Экран «Здоровье»"),
  site("screen.money", "Экран «Деньги»"),
  site("screen.stats", "Экран «Статистика»"),
  site("screen.trash", "Экран «Корзина»"),
  site("screen.history", "Экран «История»"),
  site("screen.album", "Экран «Альбом»"),
  site("screen.features", "Экран «Возможности»"),
  site("screen.settings", "Экран «Настройки»"),
  site("screen.search", "Экран «Поиск»"),
  site("screen.catalog", "Каталог для разработки"),
  site("site.hotkey_search", "Поиск по Ctrl+K или «/»"),
  site("site.theme", "Смена темы оформления"),
  site("site.feature_demo", "Пример в «Возможностях»"),
  // Виджет на ПК (desktop/renderer): шлёт программа, клиент «desktop».
  widget("widget.start", "Запуск программы на ПК"),
  widget("widget.fold", "Свернуть или развернуть виджет"),
  widget("widget.quick", "Окно быстрой записи"),
  widget("widget.tour", "Экскурсия по виджету"),
  widget("widget.poke", "Тычок по голове горничной"),
  widget("widget.hints", "Подсказки над строкой"),
  widget("widget.clock", "Часы планов"),
  widget("widget.inbox", "Ящик оповещений"),
  widget("widget.tails", "Разбор хвоста"),
  widget("widget.main", "Главное окно из виджета"),
  widget("widget.section", "Раздел сайта из виджета"),
  widget("widget.settings", "Настройки виджета"),
  widget("widget.weather", "Плашка погоды"),
  widget("widget.drag", "Перетаскивание виджета"),
  widget("widget.update", "Обновление программы по кнопке"),
  // Бот: команды (bot.ts, общий обработчик перед командами).
  bot("bot.start", "/start"),
  bot("bot.list", "/list и «список» — список-виджет"),
  bot("bot.today", "/today"),
  bot("bot.plans", "/plans"),
  bot("bot.tasks", "/tasks"),
  bot("bot.dates", "/dates"),
  bot("bot.memory", "/memory"),
  bot("bot.habits", "/habits"),
  bot("bot.summary", "/summary"),
  bot("bot.undo", "/undo"),
  bot("bot.ask", "/ask"),
  bot("bot.persona", "/persona и выбор характера"),
  bot("bot.token", "/token — ключ для айфона"),
  bot("bot.invite", "/invite"),
  bot("bot.model", "/model"),
  bot("bot.accounts", "/accounts"),
  // Подписка (billing.ts): /terms и /paysupport отвечают и незнакомцам (до фильтра) — у них счётчик не идёт.
  bot("bot.terms", "/terms — условия"),
  bot("bot.paysupport", "/paysupport — вопрос об оплате"),
  bot("bot.cancel_sub", "/cancel_sub — отменить продление"),
  bot("bot.resume_sub", "/resume_sub — возобновить продление"),
  bot("bot.signups", "/signups — открыть или закрыть регистрацию (владелец)"),
  bot("bot.answer", "/answer — ответ на вопрос об оплате (владелец)"),
  bot("bot.refund", "/refund — возврат (владелец)"),
  bot("bot.widget", "Список-виджет Telegram: нажатия"),
  // Общие: то, что есть и на сайте, и в виджете, и в боте; клиент — колонкой. Ветки разбора — pipeline.ts (handle).
  common("record", "Запись через горничную"),
  common("rec.diary", "Записано: дневник"),
  common("rec.event", "Записано: план"),
  common("rec.task", "Записано: задача"),
  common("rec.date", "Записано: важная дата"),
  common("rec.memory", "Записано: память"),
  common("rec.metric", "Записано: здоровье"),
  common("rec.money", "Записано: деньги"),
  common("rec.habit", "Записано: привычка"),
  common("rec.mark", "Записано: отметка привычки"),
  common("rec.edit", "Записано: правка"),
  common("rec.trait", "Записано: особенность профиля"),
  common("rec.note", "Записано: заметка"),
  common("photo", "Картинка в сообщении"),
  common("weather_ask", "Вопрос «какая погода?»"),
  common("chat", "Разговор без записи"),
  common("answer", "Ответ на вопрос о записях"),
  common("talk", "Болтовня"),
  common("draw", "«Нарисуй»"),
  common("voice", "Голосовая запись", "POST /api/voice"),
  common("correct", "Поправка к ответу", "POST /api/correct"),
  common("undo", "Отмена ↩", "POST /api/undo"),
  common("retry", "Повторить разбор", "POST /api/messages/:id/retry"),
  common("as_note", "Оставить заметкой", "POST /api/messages/:id/note"),
  common("proposal", "Ответ на «Добавить?»", "POST /api/proposals/:id"),
  common("clash", "Пересечение планов: сдвинуть или оставить", "POST /api/clash"),
  common("habit.mark", "Отметка привычки", "POST /api/habits/:id/mark"),
  common("habit.unmark", "Снять отметку привычки", "POST /api/habits/:id/unmark"),
  common("habit.edit", "Правка привычки мышью", "POST /api/habits/:id"),
  common("habit.stats", "Статистика привычки", "GET /api/habits/:id/stats"),
  common("task.add", "Задача вручную", "POST /api/tasks"),
  common("task.edit", "Правка задачи мышью", "POST /api/tasks/:id"),
  common("task.plan", "Задачу — в план", "POST /api/tasks/:id/plan"),
  common("task.copy", "Копия задачи", "POST /api/tasks/:id/copy"),
  common("event.add", "План вручную", "POST /api/events"),
  common("event.edit", "Правка плана мышью", "POST /api/events/:id"),
  common("event.task", "План — в задачи", "POST /api/events/:id/task"),
  common("event.repeat", "Повтор плана", "POST /api/events/:id/repeat"),
  common("event.copy", "Копия плана", "POST /api/events/:id/copy"),
  common("note.add", "Заметка вручную", "POST /api/notes"),
  common("note.edit", "Правка заметки", "POST /api/notes/:id"),
  common("date.add", "Важная дата вручную", "POST /api/dates"),
  common("date.edit", "Правка важной даты", "POST /api/dates/:id"),
  common("diary.delete", "Удаление записи дневника", "DELETE /api/diary/:id"),
  common("sleep", "Сон вручную", "POST /api/sleep"),
  common("steps", "Шаги с айфона", "POST /api/steps"),
  common("rate", "Оценка дня", "POST /api/rate"),
  common("search", "Поиск по записям", "GET /api/search"),
  common("trash.purge", "Очистка корзины", "POST /api/trash/purge"),
  common("settings", "Настройки горничной", "POST /api/settings"),
  common("you", "«О вас»: сохранить", "POST /api/you"),
  common("you.ask", "«О вас»: вопрос Рины", "POST /api/you/ask"),
  common("you.button", "«О вас»: кнопка ответа", "POST /api/you/button"),
  common("profile", "Профиль: сохранить", "POST /api/profile"),
  common("profile.steam", "Профиль: аватар Steam", "POST /api/profile/steam"),
  common("trait", "Особенности профиля", "POST /api/traits"),
  common("trait.edit", "Особенность: правка или ответ", "POST /api/traits/:id"),
  common("weather.move", "Перенос плана из-за дождя", "POST /api/weather/move"),
  common("push.subscribe", "Включить push", "POST /api/push/subscribe"),
  common("push.act", "Кнопка в push-уведомлении"),
  common("backup", "Резервная копия", "GET /api/backup"),
  common("tracker", "Трекер ПК: отчёт", "POST /api/activity"),
];

export const FEATURE_IDS = new Set(FEATURES.map((f) => f.id));
/** Имена, которые принимаются от клиентов (POST /api/events/usage). */
export const CLIENT_FEATURES = new Set(FEATURES.filter((f) => f.by === "client").map((f) => f.id));

/** Ручки API → фича: «POST /api/tasks/:id» → регулярка по методу и пути. */
const API_FEATURES = FEATURES.filter((f) => f.api).map((f) => {
  const [method, path] = f.api!.split(" ");
  return { id: f.id, method, re: new RegExp(`^${path.replace(/:id/g, "\\d+")}$`) };
});
/** Какую фичу считать за удачный запрос к API; null — запрос не фича (чтение экрана, служебное). */
export function featureOfApi(method: string, path: string): string | null {
  return API_FEATURES.find((f) => f.method === method && f.re.test(path))?.id ?? null;
}
