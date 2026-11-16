// Оповещения у горничной: непрочитанное собрано в значки в ряд над левым краем панели (assets/inbox, эмодзи Noto).
//   ⏰ alarm — напоминания о планах, вопросы про привычки и просроченные задачи (хвосты);
//   ⚠ warn  — важное: замечание про игры, наблюдения («сбежавшие задачи», закономерность), сбои разбора;
//   🎂 date  — дни рождения и другие важные даты;
//   💌 mail  — письма: утро, «что завтра», итог дня;
//   ⚙ update — вышла новая версия программы (не письмо: состояние обновления присылает главный процесс, updates.js).
// Значка нет, пока в разделе пусто; больше одного — число на значке. Щелчок: одно оповещение — горничная говорит его с
// кнопками; несколько — список в облачке, щелчок по строке открывает её. У писем иначе: сразу последнее письмо, «ещё N не
// прочитано» и кнопка «Прочитать все письма» — она открывает «Историю» в полной версии и гасит значок.
// Прочитано — нажата кнопка, ✕ или курсор задержался на облачке без кнопок. Раздел письму ставит сервер (notices.kind).
// Письма хранятся здесь же (localStorage) и переживают перезапуск; хвосты берутся из данных дня. Грузится до widget.js.

const INBOX_KEY = "maid.inbox";
const INBOX_MAX = 20;
const IB_GROUPS = [
  { id: "alarm", title: "Напоминания" },
  { id: "warn", title: "Важное" },
  { id: "date", title: "Важные даты" },
  { id: "mail", title: "Письма" },
  { id: "update", title: "Обновление" },
];
// Вид письма с сервера (server/src/notices.ts, NOTICE_KINDS) → раздел.
const IB_KIND = { plan: "alarm", habit: "alarm", game: "warn", note: "warn", other: "warn", date: "date", morning: "mail", tomorrow: "mail", evening: "mail" };

let inbox = [];
try {
  inbox = JSON.parse(localStorage.getItem(INBOX_KEY) || "[]");
} catch {
  inbox = [];
}

function noticeGroup(n) {
  if (IB_KIND[n.kind]) return IB_KIND[n.kind];
  // Лежит в ящике с версии до 0.1.53 — вида нет, раздел по кнопкам и началу текста.
  const t = n.text ?? "";
  if (n.buttons?.some((b) => /^habit:/.test(b.data ?? "")) || /^(⏰|📅)/.test(t)) return "alarm";
  if (/^🎂/.test(t)) return "date";
  if (/^(🎮|🔍|🏃)/.test(t)) return "warn";
  return "mail";
}

// Хвосты — открытые задачи со сроком в прошлом; сами не всплывают, ждут под будильником (вопрос — tails.js, askTail).
function tailsOf() {
  if (typeof data === "undefined" || !data) return [];
  return (data.tasks ?? [])
    .filter((t) => t.due_date && t.due_date < data.day)
    .sort((a, b) => a.due_date.localeCompare(b.due_date) || a.id - b.id);
}
function tailWhen(due) {
  const n = Math.round((Date.parse(data.day) - Date.parse(due)) / 864e5);
  return n === 1 ? "вчера" : n === 2 ? "позавчера" : humanDay(due).split(",")[0];
}

/** Что лежит в разделе, свежее сверху: письма с сервера, у будильника в конце — хвосты (старый срок выше). */
function groupItems(id) {
  if (id === "update") return ibUpdate ? [{ key: "u", update: ibUpdate }] : [];
  const notes = inbox.filter((n) => noticeGroup(n) === id).reverse().map((n) => ({ key: `n${n.id}`, notice: n }));
  return id === "alarm" ? [...notes, ...tailsOf().map((t) => ({ key: `t${t.id}`, tail: t }))] : notes;
}

// Новая версия программы: значок-шестерёнка висит, пока её не поставили («available» — есть, «downloading» / «ready» — ставится).
let ibUpdate = null;
function inboxUpdate(s) {
  const had = Boolean(ibUpdate);
  ibUpdate = s && ["available", "downloading", "ready"].includes(s.status) && s.next ? s : null;
  drawInbox(ibUpdate && !had ? "update" : "");
}
function openUpdate(u) {
  if (u.status !== "available") return say(`Скачиваю версию ${u.next}${u.percent ? ` — ${u.percent} %` : ""}. Программа перезапустится сама.`, { ms: 8000 });
  say(`Вышла новая версия программы — ${u.next} (у вас ${u.version}). Обновить сейчас? Программа скачает её и перезапустится сама.`, {
    ms: 0,
    buttons: [
      { text: "⚙ Обновить", run: () => { maid.installUpdate(); say(`Скачиваю версию ${u.next}. Программа перезапустится сама.`, { ms: 8000 }); } },
      { text: "Позже", run: () => {} },
    ],
  });
}

function saveInbox() {
  inbox = inbox.slice(-INBOX_MAX);
  localStorage.setItem(INBOX_KEY, JSON.stringify(inbox));
}
// Новое напоминание с сервера: в ящик и сразу сказать (если вы тут — прочитаете сразу).
function inboxAdd(n) {
  if (inbox.some((x) => x.id === n.id)) return;
  inbox.push({ id: n.id, text: n.text, emotion: n.emotion, buttons: n.buttons ?? [], kind: n.kind ?? "", at: Date.now() });
  saveInbox();
  drawInbox(noticeGroup(n));
}
function inboxRead(id) {
  const before = inbox.length;
  inbox = inbox.filter((x) => x.id !== id);
  if (inbox.length === before) return;
  saveInbox();
  drawInbox();
}
// Данные дня обновились: привычку уже отметили (в Telegram, в окне, в списке задач) — напоминание о ней больше не нужно;
// число хвостов под будильником тоже могло измениться.
function inboxTidy() {
  if (!data?.habits) return;
  const before = inbox.length;
  inbox = inbox.filter((n) => !n.buttons?.some((b) => {
    const m = /^habit:(\d+):(\d{4}-\d{2}-\d{2}):/.exec(b.data ?? "");
    return m && m[2] === data.day && data.habits.find((h) => h.id === Number(m[1]))?.status;
  }));
  if (inbox.length !== before) saveInbox();
  drawInbox();
}

/** Значки в ряд, по порядку разделов; fresh — раздел, куда только что пришло новое (значок покачивается). */
function drawInbox(fresh = "") {
  const box = $("#inbox");
  if (!box) return;
  const shown = IB_GROUPS.map((g) => ({ ...g, n: groupItems(g.id).length })).filter((g) => g.n);
  box.classList.toggle("hidden", !shown.length);
  const keep = new Set(shown.map((g) => g.id));
  for (const b of [...box.children]) if (!keep.has(b.dataset.group)) b.remove();
  let prev = null;
  for (const g of shown) {
    let b = box.querySelector(`[data-group="${g.id}"]`);
    if (!b) {
      b = document.createElement("button");
      b.type = "button";
      b.className = "ib";
      b.dataset.group = g.id;
      b.innerHTML = `<img src="../assets/inbox/${g.id}.png" alt="" draggable="false" /><span class="ib-n"></span>`;
    }
    // Порядок разделов постоянный: значок встаёт на своё место, даже если появился позже соседей.
    if (prev ? prev.nextSibling !== b : box.firstChild !== b) box.insertBefore(b, prev ? prev.nextSibling : box.firstChild);
    prev = b;
    b.title = `${g.title} · ${g.n}`;
    const badge = b.querySelector(".ib-n");
    badge.textContent = g.n > 1 ? (g.n > 99 ? "99+" : g.n) : "";
    badge.hidden = g.n < 2;
    if (fresh === g.id) {
      b.classList.remove("new");
      void b.offsetWidth;
      b.classList.add("new");
    }
  }
}

function openNotice(n, extra = []) {
  const own = startButtons(n);
  say(n.text, { buttons: [...own, ...extra], emotion: n.emotion, ms: 0, notice: n.id, mood: own.length ? "remind" : null });
}
/** Первая строка письма без разметки — для списка. */
function ibLine(text) {
  const s = String(text ?? "").replace(/<[^>]+>/g, "").split("\n")[0].trim();
  return s.length > 64 ? `${s.slice(0, 62).trimEnd()}…` : s;
}
// Несколько оповещений в разделе — список: щелчок по строке открывает её (письмо — с его кнопками, хвост — вопрос «сделали?»).
function openList(g, items) {
  say(`${g.title} · ${items.length}`, { ms: 0 });
  $("#bubbleCards").innerHTML = `<div class="ib-list">${items.map((it) => it.tail
    ? `<button type="button" data-key="${it.key}"><b>${esc(it.tail.title)}</b><small>срок был ${esc(tailWhen(it.tail.due_date))}</small></button>`
    : `<button type="button" data-key="${it.key}"><b>${esc(ibLine(it.notice.text))}</b><small>${new Date(it.notice.at).toTimeString().slice(0, 5)}</small></button>`).join("")}</div>`;
  $("#bubbleCards").querySelectorAll("[data-key]").forEach((btn) => {
    btn.onclick = () => openItem(items.find((it) => it.key === btn.dataset.key));
  });
  placeBubble();
  fitBubble();
}
function openItem(it) {
  if (!it) return;
  if (it.tail) askTail(it.tail);
  else if (it.update) openUpdate(it.update);
  else openNotice(it.notice);
}
// Письма: последнее — сразу, с числом непрочитанных; «Прочитать все письма» — в «Историю» полной версии (отбор «Утро и вечер»).
function openMail(items) {
  const rest = items.length - 1;
  const readAll = {
    text: "💌 Прочитать все письма",
    run: () => {
      inbox = inbox.filter((n) => noticeGroup(n) !== "mail");
      saveInbox();
      drawInbox();
      maid.openSection("/history/daily");
    },
  };
  openNotice(items[0].notice, rest ? [readAll] : []);
  if (rest) $("#bubbleText").insertAdjacentHTML("afterbegin", `<span class="tail-count">ещё ${rest} не прочитано</span>`);
}
function openGroup(id) {
  const g = IB_GROUPS.find((x) => x.id === id);
  const items = groupItems(id);
  if (!g || !items.length) return;
  if (id === "mail") return openMail(items);
  if (items.length === 1) return openItem(items[0]);
  openList(g, items);
}
