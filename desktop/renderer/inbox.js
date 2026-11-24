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
// Напоминания (24.11.2026): у каждого свой день (вопрос про привычку — день из кнопки, остальное — когда пришло). В списке —
// вкладки [Вчера N] [Сегодня N] на месте заголовка (один день — одна вкладка); старше вчерашнего гаснет само. Внизу слева
// «Прочитать все» — гасит открытую вкладку; маленькое облачко над списком «Прочитано: N · ↩ Вернуть» — 5 с. ✕ на строке при
// наведении (на месте времени) — прочитано, ничего не отмечая.
// Напоминания об одном плане («📅 Сегодня», «⏰ Через 1 ч», «⏰ Пора») склеиваются: остаётся последнее.

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

const IB_HIDDEN_KEY = "maid.tailsHidden"; // хвосты, закрытые ✕ или «Прочитать все»: «id:срок» — до смены срока
const IB_UNDO_MS = 5000;
let ibHidden = [];
try {
  ibHidden = JSON.parse(localStorage.getItem(IB_HIDDEN_KEY) || "[]");
} catch {
  ibHidden = [];
}
const ibTailKey = (t) => `${t.id}:${t.due_date}`;
function saveHidden() {
  try { localStorage.setItem(IB_HIDDEN_KEY, JSON.stringify(ibHidden)); } catch {}
}

/** День напоминания: у вопроса про привычку — из кнопки (habit:ID:день:…), у остального — когда пришло (по часам ПК). */
function ibDay(n) {
  const m = n.buttons?.map((b) => /^habit:\d+:(\d{4}-\d{2}-\d{2}):/.exec(b.data ?? "")).find(Boolean);
  if (m) return m[1];
  const d = new Date(n.at ?? Date.now());
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function ibPrevDay(day) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}
const ibToday = () => (typeof data !== "undefined" && data?.day) || ibDay({ at: Date.now() });
/** О каком плане напоминание: «📅 Сегодня: 18:00 — X», «⏰ Через 1 ч: 18:00 — X», «⏰ Пора: 18:00 — X» → «18:00 — X»; иначе "". */
function ibPlanKey(n) {
  if (n.buttons?.length) return ""; // вопрос про привычку и отложенное с кнопками — не план
  return /^(?:📅 Сегодня|⏰ Пора|⏰ Через [^:]+):\s*(.+)$/.exec(String(n.text ?? "").split("\n")[0])?.[1].trim() ?? "";
}

/** Привычку за этот день уже отметили (где угодно)? Сегодня — status, вчера — yesterday с сервера («none» — не отмечено или
 *  минус, поставленный в полночь сам). 24.11.2026: вопрос, пришедший в 23:00, после полуночи висел, хотя вчерашний день отметили
 *  в полной версии, — сверялся только сегодняшний день. */
function habitAnswered(id, day) {
  const h = data?.habits?.find((x) => x.id === id);
  if (!h) return false;
  if (day === data.day) return Boolean(h.status);
  return day === ibPrevDay(data.day) && Boolean(h.yesterday) && h.yesterday !== "none";
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
    .filter((t) => t.due_date && t.due_date < data.day && !ibHidden.includes(ibTailKey(t)))
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
/** Шестерёнка, пока качается и ставится новая версия: крутится (busy), справа — сколько скачано (pct, «59 %»). */
function updateBadge(u) {
  const busy = Boolean(u && ["downloading", "ready"].includes(u.status));
  return { busy, pct: busy && Number.isFinite(u.percent) ? `${u.percent} %` : "" };
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
  // Новое напоминание о плане — прежние о нём же («Через 1 ч» → «Пора») больше не нужны.
  const plan = ibPlanKey(n);
  if (plan) inbox = inbox.filter((x) => ibPlanKey(x) !== plan);
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
// число хвостов под будильником тоже могло измениться. Новый день: напоминания старше вчерашнего гаснут; повторы об одном
// плане склеиваются (могли накопиться до 0.1.87); закрытые хвосты, которых больше нет, забываются.
function inboxTidy() {
  if (!data?.habits) return;
  const before = inbox.length;
  inbox = inbox.filter((n) => !n.buttons?.some((b) => {
    const m = /^habit:(\d+):(\d{4}-\d{2}-\d{2}):/.exec(b.data ?? "");
    return m && habitAnswered(Number(m[1]), m[2]);
  }));
  const yesterday = ibPrevDay(data.day);
  inbox = inbox.filter((n) => noticeGroup(n) !== "alarm" || ibDay(n) >= yesterday);
  const last = new Map();
  for (const n of inbox) if (ibPlanKey(n)) last.set(ibPlanKey(n), n.id);
  inbox = inbox.filter((n) => !ibPlanKey(n) || last.get(ibPlanKey(n)) === n.id);
  if (inbox.length !== before) saveInbox();
  const tails = new Set((data.tasks ?? []).filter((t) => t.due_date).map(ibTailKey));
  const kept = ibHidden.filter((k) => tails.has(k));
  if (kept.length !== ibHidden.length) { ibHidden = kept; saveHidden(); }
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
    if (g.id === "update") {
      const u = updateBadge(ibUpdate);
      b.classList.toggle("busy", u.busy);
      let pct = b.querySelector(".ib-pct");
      if (!pct) { pct = document.createElement("span"); pct.className = "ib-pct"; b.append(pct); }
      pct.textContent = u.pct;
      pct.hidden = !u.pct;
      if (u.busy) b.title = `Обновление · скачано ${u.pct || "…"}`;
    }
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
// У напоминаний — вкладки «Вчера / Сегодня» (если есть оба дня); у любого списка — «Прочитать все» внизу слева и ✕ на строке.
let ibList = null; // открытый список: { g, tab }
/** Напоминания по дням: хвосты — сегодня (они про сейчас), остальное — по своему дню. */
function alarmSplit(items) {
  const today = ibToday();
  const old = (it) => Boolean(it.notice) && ibDay(it.notice) < today;
  return { yesterday: items.filter(old), today: items.filter((it) => !old(it)) };
}
function openList(g, items, tab = "", extra = []) {
  ibList = { g, tab };
  say(g.title, { ms: 0, buttons: [{ text: "Прочитать все", run: () => ibReadAll() }, ...extra] });
  $("#bubbleActions")?.querySelector('[data-i="0"]')?.classList.add("ib-readall");
  drawIbList(items, tab);
}
/** Нарисовать открытый список (и заново — после ✕ или смены вкладки): облачко на месте, без звука и анимации появления. */
function drawIbList(items, tab) {
  const { g } = ibList;
  const split = g.id === "alarm" ? alarmSplit(items) : null;
  const both = Boolean(split?.today.length && split.yesterday.length);
  tab = both ? (tab && split[tab].length ? tab : split.today.length ? "today" : "yesterday") : "";
  ibList.tab = tab;
  const shown = tab ? split[tab] : items;
  // У напоминаний вместо заголовка — вкладки (24.11.2026: заголовок занимал место сверху); один день — одна вкладка.
  const days = split ? [["yesterday", "Вчера"], ["today", "Сегодня"]].filter(([id]) => split[id].length) : [];
  const open = tab || days[0]?.[0];
  $("#bubbleText").textContent = split ? "" : `${g.title} · ${items.length}`;
  const tabs = split ? `<div class="ib-tabs" role="tablist" aria-label="${g.title}">${days.map(([id, name]) =>
    `<button type="button" role="tab" data-tab="${id}" aria-selected="${open === id}" class="${open === id ? "on" : ""}">${name} <span>${split[id].length}</span></button>`).join("")}</div>` : "";
  const x = `<span class="ib-x" data-x role="button" title="Прочитано — убрать из списка" aria-label="Прочитано">✕</span>`;
  $("#bubbleCards").innerHTML = `${tabs}<div class="ib-list">${shown.map((it) => it.tail
    ? `<button type="button" data-key="${it.key}"><b>${esc(it.tail.title)}</b><small class="ib-time">срок был ${esc(tailWhen(it.tail.due_date))}</small>${x}</button>`
    : `<button type="button" data-key="${it.key}"><b>${esc(ibLine(it.notice.text))}</b><small class="ib-time">${new Date(it.notice.at).toTimeString().slice(0, 5)}</small>${x}</button>`).join("")}</div>`;
  $("#bubbleCards").querySelectorAll("[data-tab]").forEach((btn) => {
    btn.onclick = () => drawIbList(groupItems(g.id), btn.dataset.tab);
  });
  $("#bubbleCards").querySelectorAll(".ib-list [data-key]").forEach((btn) => {
    btn.onclick = (ev) => {
      const it = shown.find((y) => y.key === btn.dataset.key);
      if (ev.target.closest("[data-x]")) return ibDismiss(it, btn);
      openItem(it);
    };
  });
  placeBubble();
  fitBubble();
}
/** Прочитано без ответа: письмо — из ящика, хвост — скрыт до смены срока. */
function ibForget(it) {
  if (it.notice) inbox = inbox.filter((n) => n.id !== it.notice.id);
  else if (it.tail && !ibHidden.includes(ibTailKey(it.tail))) ibHidden.push(ibTailKey(it.tail));
}
// ✕ на строке: строка гаснет, список смыкается; пусто — облачко закрывается.
function ibDismiss(it, row) {
  if (!it || row.classList.contains("gone")) return;
  ibForget(it);
  saveInbox();
  saveHidden();
  drawInbox();
  row.classList.add("gone");
  const list = ibList;
  setTimeout(() => {
    if (ibList !== list || $("#bubble").classList.contains("hidden")) return;
    const left = groupItems(list.g.id);
    if (!left.length) return hideBubble();
    drawIbList(left, list.tab);
  }, matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 220);
}
// Маленькое облачко над списком: «Прочитано: N · ↩ Вернуть» (24.11.2026: раньше «Вернуть» стояла кнопкой внизу, а реплики
// «Прочитано» не было видно — её сразу сменял список другого дня). Над облачком нет места (у верха окна) — строкой в его верху.
let ibToastTimer = 0;
function ibToastOff() {
  clearTimeout(ibToastTimer);
  $("#bubble")?.querySelector(".ib-toast")?.remove();
}
function ibToast(count, undo) {
  ibToastOff();
  const b = $("#bubble");
  const t = document.createElement("div");
  t.className = "ib-toast";
  t.setAttribute("role", "status");
  t.innerHTML = `<span>✓ Прочитано: ${count}</span><button type="button">↩ Вернуть</button>`;
  t.querySelector("button").onclick = (e) => { e.stopPropagation(); ibToastOff(); undo(); };
  b.append(t);
  if (b.getBoundingClientRect().top - t.offsetHeight - 8 < 0) {
    t.classList.add("inline"); // под облачком его закрыла бы панель
    b.prepend(t);
  }
  ibToastTimer = setTimeout(ibToastOff, IB_UNDO_MS);
}
// «Прочитать все» — открытая вкладка (или весь список, если вкладок нет); IB_UNDO_MS можно «↩ Вернуть».
function ibReadAll() {
  const { g, tab } = ibList;
  const items = groupItems(g.id);
  const gone = tab ? alarmSplit(items)[tab] : items;
  const inboxWas = inbox.slice(), hiddenWas = ibHidden.slice();
  gone.forEach(ibForget);
  saveInbox();
  saveHidden();
  drawInbox();
  const back = () => { inbox = inboxWas; ibHidden = hiddenWas; saveInbox(); saveHidden(); drawInbox(); openGroup(g.id); };
  const rest = groupItems(g.id);
  if (!rest.length) return say(`Прочитано: ${gone.length}.`, { ms: IB_UNDO_MS, buttons: [{ text: "↩ Вернуть", run: back }] });
  openList(g, rest);
  ibToast(gone.length, back);
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
  maid.track?.("widget.inbox");
  if (id === "mail") return openMail(items);
  if (items.length === 1) return openItem(items[0]);
  openList(g, items);
}
