// Непрочитанные напоминания: то, что горничная прислала (как в Telegram), висит значком у её головы,
// пока его не прочитали. Значок — по смыслу: 💊 таблетка/привычка, 🎂 важная дата, ⏰ план, ✉️ остальное; рядом — сколько.
// Щелчок — горничная говорит самое старое непрочитанное с его кнопками. Прочитано — нажата кнопка, ✕ или курсор
// задержался на облачке без кнопок. Само исчезнувшее облачко (вас не было за компьютером) остаётся в значке.
// Хранится здесь же (localStorage) — переживает перезапуск. Грузится до widget.js; say / data — при вызове.

const INBOX_KEY = "maid.inbox";
const INBOX_MAX = 20;
let inbox = [];
try {
  inbox = JSON.parse(localStorage.getItem(INBOX_KEY) || "[]");
} catch {
  inbox = [];
}

function noticeIcon(n) {
  const t = n.text ?? "";
  if (n.buttons?.some((b) => /^habit:/.test(b.data ?? "")) || /💊|таблет|витамин|лекарств|выпил/i.test(t)) return "💊";
  if (/🎂|🎉|💍|день рождени|годовщин|праздник|важн\S* дат/i.test(t)) return "🎂";
  if (/⏰|через \d+ мин|в \d{1,2}:\d{2}|план/i.test(t)) return "⏰";
  return "✉️";
}
function saveInbox() {
  inbox = inbox.slice(-INBOX_MAX);
  localStorage.setItem(INBOX_KEY, JSON.stringify(inbox));
}
// Новое напоминание с сервера: в ящик и сразу сказать (если вы тут — прочитаете сразу).
function inboxAdd(n) {
  if (inbox.some((x) => x.id === n.id)) return;
  inbox.push({ id: n.id, text: n.text, emotion: n.emotion, buttons: n.buttons ?? [], at: Date.now() });
  saveInbox();
  drawInbox(true);
}
function inboxRead(id) {
  const before = inbox.length;
  inbox = inbox.filter((x) => x.id !== id);
  if (inbox.length === before) return;
  saveInbox();
  drawInbox();
}
// Привычку уже отметили (в Telegram, в окне, в списке задач) — напоминание о ней больше не нужно.
function inboxTidy() {
  if (!data?.habits) return;
  const before = inbox.length;
  inbox = inbox.filter((n) => !n.buttons?.some((b) => {
    const m = /^habit:(\d+):(\d{4}-\d{2}-\d{2}):/.exec(b.data ?? "");
    return m && m[2] === data.day && data.habits.find((h) => h.id === Number(m[1]))?.status;
  }));
  if (inbox.length !== before) {
    saveInbox();
    drawInbox();
  }
}
function drawInbox(fresh = false) {
  const el = $("#inbox");
  if (!el) return;
  el.classList.toggle("hidden", !inbox.length);
  if (!inbox.length) return;
  const last = inbox[inbox.length - 1];
  el.innerHTML = `<span class="ib-icon">${noticeIcon(last)}</span>${inbox.length > 1 ? `<span class="ib-count">${inbox.length}</span>` : ""}`;
  el.title = inbox.length > 1 ? `Непрочитанных напоминаний: ${inbox.length} · щелчок — прочитать` : "Напоминание · щелчок — прочитать";
  if (fresh) {
    el.classList.remove("new");
    void el.offsetWidth;
    el.classList.add("new");
  }
}
function openInbox() {
  const n = inbox[0];
  if (!n) return;
  say(n.text, { buttons: n.buttons, emotion: n.emotion, ms: 0, notice: n.id, mood: n.buttons.length ? "remind" : null });
}
