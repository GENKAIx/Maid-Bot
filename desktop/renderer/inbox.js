// Непрочитанные напоминания: то, что горничная прислала (как в Telegram), летает значками рядом с ней (слева, поодаль —
// чтобы не попасть по фигурке), пока не прочитано. Значок — по смыслу: 💊 таблетка/привычка, 🎂 важная дата, ⏰ план,
// ✉️ остальное. Каждое — свой значок (до 6, дальше «+N»); щелчок — горничная говорит это напоминание с его кнопками. Прочитано — нажата кнопка, ✕ или курсор
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
// Места значков от правого нижнего угла стайки (новые — ближе к горничной), задержка покачивания у каждого своя.
const IB_SPOTS = [[0, 0], [-50, -16], [-16, -54], [-66, -66], [-100, -24], [-44, -104]];
const IB_SHOWN = IB_SPOTS.length;
function drawInbox(fresh = false) {
  const box = $("#inbox");
  if (!box) return;
  box.classList.toggle("hidden", !inbox.length);
  // Новые — первыми (у горничной), старые отлетают дальше; не влезло — последний значок «+N», он открывает самое старое.
  const list = [...inbox].reverse();
  const extra = list.length > IB_SHOWN ? list.length - IB_SHOWN + 1 : 0;
  const shown = extra ? list.slice(0, IB_SHOWN - 1) : list;
  const keep = new Set(shown.map((n) => String(n.id)));
  for (const b of [...box.children]) if (!keep.has(b.dataset.id)) b.remove();
  const make = (id, html, title, i) => {
    let b = box.querySelector(`[data-id="${id}"]`);
    if (!b) {
      b = document.createElement("button");
      b.type = "button";
      b.className = "ib";
      b.dataset.id = id;
      box.appendChild(b);
    }
    b.innerHTML = html;
    b.title = title;
    const [x, y] = IB_SPOTS[i];
    b.style.setProperty("--x", `${x}px`);
    b.style.setProperty("--y", `${y}px`);
    b.style.setProperty("--d", `${(i * 0.37) % 2.6}s`);
    return b;
  };
  shown.forEach((n, i) => {
    const b = make(String(n.id), noticeIcon(n), `${n.text.split("\n")[0].slice(0, 80)} · щелчок — прочитать`, i);
    if (fresh && i === 0) {
      b.classList.remove("new");
      void b.offsetWidth;
      b.classList.add("new");
    }
  });
  if (extra) make("more", `+${extra}`, `Ещё ${extra} — щелчок, по порядку`, IB_SHOWN - 1).classList.add("more");
}
function openInbox(id) {
  const n = inbox.find((x) => String(x.id) === String(id)) ?? inbox[0];
  if (!n) return;
  say(n.text, { buttons: n.buttons, emotion: n.emotion, ms: 0, notice: n.id, mood: n.buttons.length ? "remind" : null });
}
