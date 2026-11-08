// Общее для окон: короткие помощники и перевод ответа сервера в простой текст.

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
/** Ответ бота приходит в HTML Telegram — показываем только b/i/code. */
const tgHtml = (s) => esc(String(s ?? "").replace(/<(?!\/?(b|i|code)>)[^>]+>/g, "")).replace(/&lt;(\/?(b|i|code))&gt;/g, "<$1>");

const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const WD = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
function humanDay(key) {
  const [y, m, d] = key.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]}, ${WD[new Date(y, m - 1, d).getDay()]}`;
}
function dur(sec) {
  const t = Math.round(sec / 60);
  const h = Math.floor(t / 60);
  return h ? `${h} ч ${t % 60} мин` : `${t} мин`;
}
const SECTION = { notes: "Заметки", sleep: "Сон", food: "Еда", sport: "Спорт", health: "Здоровье", hobby: "Хобби", mood: "Настроение", summary: "Саммари", tags: "Теги" };
function dateWhen(d) {
  return d.inDays === 0 ? "сегодня" : d.inDays === 1 ? "завтра" : `через ${d.inDays} дн.`;
}
