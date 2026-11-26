// Ссылки на задачи, которые уже есть (26.11.2026). Ответ «Эта задача уже в списке, под номером #102: «…». Второй раз записывать
// не стала.» (и правка задачи словами) приходит с refs: [{ tbl: "tasks", id, title }] (server/src/pipeline.ts, TaskRef) — под
// ответом плашка «↗ название», в облачке и в переписке. Щелчок: панель разворачивается (если свёрнута), переписка уступает место
// списку, строка задачи прокручивается на виду и подсвечивается ~2 с. Задачи уже нет (сделана, удалена) — плашка серая
// «задачи уже нет», без перехода. Задача есть, но в списке её не видно (спит до срока, раздел задач выключен) — раздел «Планы»
// в приложении. Скрипт стоит перед widget.js: всё, что берётся оттуда (data, $, collapsed…), — только при вызове.
const TASKREF_LIT_MS = 2000;
const TASKREF_MAX = 5;
let taskRefLit = null; // { id, at, n } — подсветка переживает перерисовку списка (render → taskRefRelight); n — номер перехода
let taskRefLitN = 0;

/** Задача ещё открыта (есть в данных виджета)? */
function taskRefAlive(id) {
  return (data?.tasks ?? []).some((t) => t.id === Number(id));
}
/** refs ответа → ссылки на задачи; незнакомое (другая таблица, без id) — мимо: новый вид с сервера не ломает виджет. */
function taskRefsOf(refs) {
  return (Array.isArray(refs) ? refs : [])
    .filter((r) => r && r.tbl === "tasks" && Number.isInteger(Number(r.id)) && Number(r.id) > 0)
    .slice(0, TASKREF_MAX)
    .map((r) => ({ tbl: "tasks", id: Number(r.id), title: String(r.title ?? "").slice(0, 200) }));
}
const taskRefTip = (r, live) => `${r.title}${live ? " — показать в списке задач" : " — задачи уже нет"}`;
/** Плашка в переписке (widget.js, herHtml): h — номер сообщения в chatLog, j — номер ссылки. */
function taskRefChipHtml(r, h, j) {
  const live = taskRefAlive(r.id);
  return `<button type="button" class="h-chip ref${live ? "" : " gone"}" data-h="${h}" data-r="${j}"${live ? "" : " disabled"} title="${esc(taskRefTip(r, live))}">`
    + `↗ <span class="chip-t">${esc(r.title)}</span>${live ? "" : `<span class="chip-gone">· задачи уже нет</span>`}</button>`;
}
/** Карточка в облачке (widget.js, say) — рядом с карточками «Записала». */
function taskRefCard(r) {
  const el = document.createElement("button");
  el.type = "button";
  el.dataset.refTask = String(r.id);
  el.innerHTML = `<span class="card-icon">↗</span><span class="card-body">${esc(r.title)}</span>`;
  taskRefMark(el, r, taskRefAlive(r.id));
  el.onclick = () => {
    if (goToTask(r.id)) return hideBubble();
    taskRefMark(el, r, false); // пока висело облачко, задачу закрыли
  };
  return el;
}
function taskRefMark(el, r, live) {
  el.className = `card ref ${live ? "go" : "gone"}`;
  el.disabled = !live;
  el.title = taskRefTip(r, live);
  if (!live && !el.querySelector(".chip-gone")) el.insertAdjacentHTML("beforeend", `<span class="chip-gone">задачи уже нет</span>`);
}
/** Перейти к задаче в списке. false — задачи уже нет (никуда не ведёт). */
function goToTask(id) {
  id = Number(id);
  if (!taskRefAlive(id)) return false;
  // Развернули ради задачи — панель остаётся развёрнутой (как если бы взялись за неё сами).
  autoOpened = false;
  const folded = collapsed;
  if (folded) foldAnimated(false);
  if (!$("#chatHist").classList.contains("hidden")) toggleHistory(false);
  const wait = folded && !matchMedia("(prefers-reduced-motion: reduce)").matches ? 600 : 0; // панель вырастает из карточки
  taskRefLit = { id, at: Date.now() + wait, n: ++taskRefLitN };
  setTimeout(() => taskRefShow(id), wait);
  return true;
}
const taskRefRow = (id) => $(`#body .list [data-done="${id}"]`)?.closest("li") ?? null;
function taskRefShow(id) {
  let li = taskRefRow(id);
  // За кнопкой «Ещё N» — показать список до неё.
  if (!li && cfg.sections.tasks && !shownTaskIds.has(id)) {
    tasksMore = Math.max(tasksMore, (data?.tasks ?? []).length);
    render();
    li = taskRefRow(id);
  }
  if (!li) {
    taskRefLit = null;
    return maid.openSection("/plans");
  }
  li.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  taskRefRelight();
}
/** Подсветить строку (и снова — после перерисовки списка), пока не прошло TASKREF_LIT_MS. Строка не перерисовалась с прошлого
 *  перехода (тот же класс, анимация отыграла) — класс снять и пересчитать: иначе второй щелчок по той же задаче её не мигнёт.
 *  Через TASKREF_LIT_MS класс снимается таймером — и при «уменьшить движение» (там фон без анимации) подсветка не остаётся. */
function taskRefRelight() {
  if (!taskRefLit) return;
  const lit = taskRefLit;
  const since = Date.now() - lit.at;
  if (since >= TASKREF_LIT_MS) return void (taskRefLit = null);
  const li = taskRefRow(lit.id);
  if (!li) return;
  if (li.dataset.litN === String(lit.n)) return; // уже горит от этого перехода
  if (li.classList.contains("ref-lit")) {
    li.classList.remove("ref-lit");
    void li.offsetWidth; // перерасчёт: анимация начнётся заново
  }
  li.dataset.litN = String(lit.n);
  li.style.setProperty("--lit-delay", `-${Math.max(0, since)}ms`);
  li.classList.add("ref-lit");
  setTimeout(() => {
    if (taskRefLit === lit) taskRefLit = null;
    if (li.dataset.litN !== String(lit.n)) return; // строку уже подсветил новый переход
    li.classList.remove("ref-lit");
    delete li.dataset.litN;
  }, TASKREF_LIT_MS - Math.max(0, since));
}
