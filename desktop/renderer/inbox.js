// Непрочитанные напоминания: то, что горничная прислала (как в Telegram), летает значками рядом с ней (слева, поодаль —
// чтобы не попасть по фигурке), пока не прочитано. Значок — одиночный эмодзи Noto (assets/inbox, чего не хватает — в НУЖНО_СГЕНЕРИРОВАТЬ.md): таблетка/привычка,
// важная дата, план, остальное. Каждое — свой значок (до 6, дальше «+N»); щелчок — горничная говорит это напоминание с его кнопками. Прочитано — нажата кнопка, ✕ или курсор
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
  if (n.buttons?.some((b) => /^habit:/.test(b.data ?? "")) || /💊|таблет|витамин|лекарств|выпил/i.test(t)) return "pill";
  if (/🎂|🎉|💍|день рождени|годовщин|праздник|важн\S* дат/i.test(t)) return "date";
  if (/⏰|через \d+ мин|в \d{1,2}:\d{2}|план/i.test(t)) return "plan";
  return "mail";
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
// Значки разбросаны вразнобой в прямоугольнике #inbox (CSS: над панелью, от её левого края до горничной). Прямоугольник
// делится на клетки (сколько значков — столько клеток или чуть больше), каждому значку — своя клетка в случайном порядке,
// внутри неё случайный сдвиг, размер, наклон и покачивание. Так значки не выходят за прямоугольник и не налезают друг на друга.
const IB_SHOWN = 6;
const IB_PAD = 6; // запас от края клетки: покачивание до 5 px и наклон
function ibRand(seed) {
  let h = 2166136261;
  for (const c of String(seed)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}
function ibLayout(ids, W, H) {
  const n = ids.length;
  // Сетка с самыми крупными клетками.
  let best = { cols: 1, rows: n, cell: 0 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const cell = Math.min(W / cols, H / rows);
    if (cell > best.cell) best = { cols, rows, cell };
  }
  const cw = W / best.cols;
  const ch = H / best.rows;
  const order = [...Array(best.cols * best.rows).keys()];
  const mix = ibRand(ids.join(","));
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(mix() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const out = new Map();
  ids.forEach((id, i) => {
    const rnd = ibRand(id);
    const cell = order[i];
    const top = Math.min(56, Math.min(cw, ch) - 2 * IB_PAD);
    const s = Math.max(24, Math.round(top - rnd() * Math.min(12, top * 0.25)));
    const x = (cell % best.cols) * cw + IB_PAD + rnd() * Math.max(0, cw - s - 2 * IB_PAD);
    const y = Math.floor(cell / best.cols) * ch + IB_PAD + rnd() * Math.max(0, ch - s - 2 * IB_PAD);
    out.set(id, { x: Math.round(x), y: Math.round(y), s, r: Math.round(rnd() * 28 - 14), t: (2.6 + rnd() * 1.8).toFixed(2),
      d: (rnd() * 2.5).toFixed(2), ax: Math.round(rnd() * 8 - 4), ay: -Math.round(3 + rnd() * 2) });
  });
  return out;
}
function drawInbox(fresh = false) {
  const box = $("#inbox");
  if (!box) return;
  box.classList.toggle("hidden", !inbox.length);
  // Не влезло — последний значок «+N» (стопка писем), он открывает самое старое.
  const list = [...inbox].reverse();
  const extra = list.length > IB_SHOWN ? list.length - IB_SHOWN + 1 : 0;
  const shown = extra ? list.slice(0, IB_SHOWN - 1) : list;
  const keep = new Set(shown.map((n) => String(n.id)));
  for (const b of [...box.children]) if (!keep.has(b.dataset.id)) b.remove();
  const place = ibLayout([...shown.map((n) => String(n.id)), ...(extra ? ["more"] : [])], box.clientWidth || 160, box.clientHeight || 170);
  const make = (id, icon, title, count = "") => {
    let b = box.querySelector(`[data-id="${id}"]`);
    if (!b) {
      b = document.createElement("button");
      b.type = "button";
      b.className = "ib";
      b.dataset.id = id;
      box.appendChild(b);
    }
    b.innerHTML = `<img src="../assets/inbox/${icon}.png" alt="" draggable="false" />${count ? `<span class="ib-n">${count}</span>` : ""}`;
    b.title = title;
    const p = place.get(id);
    for (const [k, v] of [["x", `${p.x}px`], ["y", `${p.y}px`], ["s", `${p.s}px`], ["r", `${p.r}deg`], ["t", `${p.t}s`], ["d", `${p.d}s`], ["ax", `${p.ax}px`], ["ay", `${p.ay}px`]])
      b.style.setProperty(`--${k}`, v);
    return b;
  };
  shown.forEach((n, i) => {
    const b = make(String(n.id), noticeIcon(n), `${n.text.split("\n")[0].slice(0, 80)} · щелчок — прочитать`);
    if (fresh && i === 0) {
      b.classList.remove("new");
      void b.offsetWidth;
      b.classList.add("new");
    }
  });
  if (extra) make("more", "many", `Ещё ${extra} — щелчок, по порядку`, `+${extra}`).classList.add("more");
}
function openInbox(id) {
  const n = inbox.find((x) => String(x.id) === String(id)) ?? inbox[0];
  if (!n) return;
  say(n.text, { buttons: n.buttons, emotion: n.emotion, ms: 0, notice: n.id, mood: n.buttons.length ? "remind" : null });
}
