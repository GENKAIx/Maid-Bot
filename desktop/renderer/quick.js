// Быстрая запись: то же, что сообщение боту.
const t = $("#t");
const out = $("#out");
let last = null;
maid.on("quick-open", () => { t.value = ""; out.textContent = ""; attach(null); syncMarks(); t.focus(); });
// Метки (marks.js): пока пишешь — какой день, время и сумму поняла строка, на месте строки ответа; стёрли текст — снова ответ.
// День — на часах компьютера: у окна быстрой записи нет данных дня с сервера.
function syncMarks() {
  out.classList.toggle("hidden", draftMarksShow($("#marks"), t.value, draftNow()));
}
// Свежая строка ответа («…», ответ, ошибка, «картинка приложена») важнее меток: пока её не сменил ввод, меток нет.
function showOut() {
  $("#marks").classList.add("hidden");
  out.classList.remove("hidden");
}
t.addEventListener("input", syncMarks);
// Картинка (чек, билет): Ctrl+V или перетащить в окно; уходит с Enter, текст — подпись.
let picture = null;
function attach(p) {
  picture = p;
  $("#pic").classList.toggle("hidden", !p);
  $("#pic").src = p?.url ?? "";
}
async function attachFile(file) {
  if (!file) return;
  try { attach(await shrinkImage(file)); out.textContent = "📷 Картинка приложена — допиши подпись или жми Enter"; }
  catch { out.textContent = "Не получилось открыть картинку."; }
  showOut();
}
t.addEventListener("paste", (e) => {
  const f = imageFrom(e.clipboardData);
  if (f) { e.preventDefault(); attachFile(f); }
});
document.addEventListener("drop", (e) => attachFile(imageFrom(e.dataTransfer)));
document.addEventListener("keydown", async (e) => {
  if (e.key === "Escape") return picture ? (attach(null), (out.textContent = ""), syncMarks()) : maid.hideQuick();
  if (e.key === "z" && e.ctrlKey && last?.undoable && !t.value) {
    const r = await maid.api("POST", "/api/undo", { messageId: last.messageId });
    out.textContent = r.text;
    showOut();
    last = null;
    maid.changed();
  }
});
$("#f").onsubmit = async (e) => {
  e.preventDefault();
  const text = t.value.trim();
  if (!text && !picture) return;
  const image = picture ? { data: picture.data, mime: picture.mime } : undefined;
  t.disabled = true;
  out.textContent = image ? "📷 Смотрю…" : "…";
  showOut();
  maid.thinking(true);
  try {
    last = await maid.api("POST", "/api/input", { text, image, id: crypto.randomUUID() });
    attach(null);
    out.innerHTML = tgHtml(last.text) + (last.undoable ? '<br><span class="small">Ctrl+Z — отменить</span>' : "");
    maid.reply({ text: last.text, emotion: last.emotion, changes: last.changes, refs: last.refs, undoable: last.undoable, messageId: last.messageId, days: last.days, heard: text });
    t.value = "";
    syncMarks();
    maid.changed();
    setTimeout(() => !t.value && maid.hideQuick(), 4000);
  } catch (err) {
    const raw = String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
    // Сервер ничего не записал (main.js KEEP_MARK U+2064: картинка без подписи) — строку и картинку не трогаем.
    const kept = /^\u2063?\u2064/.test(raw);
    const msg = raw.replace(/^(\u2063?)\u2064/, "$1");
    // Нужна подписка (402, main.js PAY_MARK): текст горничной и кнопка — счёт Telegram открывает main (pay-open).
    // Текст сервер уже записал заметкой — строку можно очистить; картинка без подписи заметкой не пишется — она остаётся.
    if (msg.startsWith("\u2063")) {
      out.textContent = msg.slice(1) + " ";
      const pay = document.createElement("button");
      pay.type = "button";
      pay.className = "pay";
      pay.textContent = "⭐ Оформить подписку";
      pay.onclick = async () => { const fail = await maid.openPay().catch((e) => String(e.message)); if (fail) out.textContent = fail; };
      out.appendChild(pay);
      if (text && !kept) {
        t.value = "";
        attach(null);
        maid.changed();
      }
    } else out.textContent = msg;
    showOut();
  } finally {
    maid.thinking(false);
    t.disabled = false;
    t.focus();
  }
};
