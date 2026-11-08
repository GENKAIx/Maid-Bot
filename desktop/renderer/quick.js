// Быстрая запись: то же, что сообщение боту.
const t = $("#t");
const out = $("#out");
let last = null;
maid.on("quick-open", () => { t.value = ""; out.textContent = ""; t.focus(); });
document.addEventListener("keydown", async (e) => {
  if (e.key === "Escape") maid.hideQuick();
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
  if (!text) return;
  t.disabled = true;
  out.textContent = "…";
  maid.thinking(true);
  try {
    last = await maid.api("POST", "/api/input", { text, id: crypto.randomUUID() });
    out.innerHTML = tgHtml(last.text) + (last.undoable ? '<br><span class="small">Ctrl+Z — отменить</span>' : "");
    maid.reply({ text: last.text, emotion: last.emotion, changes: last.changes, undoable: last.undoable, messageId: last.messageId, days: last.days });
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
