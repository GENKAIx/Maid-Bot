// Общее для окон: короткие помощники и перевод ответа сервера в простой текст.

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
/** Ответ бота приходит в HTML Telegram — показываем только b/i/code. */
const tgHtml = (s) => esc(String(s ?? "").replace(/<(?!\/?(b|i|code)>)[^>]+>/g, "")).replace(/&lt;(\/?(b|i|code))&gt;/g, "<$1>");

// --- картинки (чек, билет, скриншот) ---
/** Первая картинка из буфера обмена или перетаскивания. */
function imageFrom(dt) {
  return [...(dt?.files ?? [])].find((f) => f.type.startsWith("image/")) ??
    [...(dt?.items ?? [])].find((i) => i.kind === "file" && i.type.startsWith("image/"))?.getAsFile() ?? null;
}
/** Все картинки из буфера обмена или перетаскивания. */
function imagesFrom(dt) {
  const files = [...(dt?.files ?? [])].filter((f) => f.type.startsWith("image/"));
  if (files.length) return files;
  return [...(dt?.items ?? [])].filter((i) => i.kind === "file" && i.type.startsWith("image/")).map((i) => i.getAsFile()).filter(Boolean);
}
/** Уменьшить до 1600 px по большей стороне и сжать в JPEG: на сервер уходят сотни килобайт, а не мегабайты. */
async function shrinkImage(file, max = 1600) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  const g = c.getContext("2d");
  g.fillStyle = "#fff"; // прозрачный PNG — на белом, как бумага чека
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  const url = c.toDataURL("image/jpeg", 0.85);
  return { mime: "image/jpeg", data: url.slice(url.indexOf(",") + 1), url };
}
// Брошенный в окно файл не должен открываться вместо окна.
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => e.preventDefault());

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
