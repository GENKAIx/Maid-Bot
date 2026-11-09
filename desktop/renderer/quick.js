// Быстрая запись: то же, что сообщение боту.
const t = $("#t");
const out = $("#out");
let last = null;
maid.on("quick-open", () => { t.value = ""; out.textContent = ""; attach(null); t.focus(); });
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
}
t.addEventListener("paste", (e) => {
  const f = imageFrom(e.clipboardData);
  if (f) { e.preventDefault(); attachFile(f); }
});
document.addEventListener("drop", (e) => attachFile(imageFrom(e.dataTransfer)));
document.addEventListener("keydown", async (e) => {
  if (e.key === "Escape") return picture ? (attach(null), (out.textContent = "")) : maid.hideQuick();
  if (e.key === "z" && e.ctrlKey && last?.undoable && !t.value) {
    const r = await maid.api("POST", "/api/undo", { messageId: last.messageId });
    out.textContent = r.text;
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
  maid.thinking(true);
  try {
    last = await maid.api("POST", "/api/input", { text, image, id: crypto.randomUUID() });
    attach(null);
    out.innerHTML = tgHtml(last.text) + (last.undoable ? '<br><span class="small">Ctrl+Z — отменить</span>' : "");
    maid.reply({ text: last.text, emotion: last.emotion, changes: last.changes, undoable: last.undoable, messageId: last.messageId, days: last.days, heard: text });
    t.value = "";
    maid.changed();
    setTimeout(() => !t.value && maid.hideQuick(), 4000);
  } catch (err) {
    out.textContent = err.message;
  } finally {
    maid.thinking(false);
    t.disabled = false;
    t.focus();
  }
};
