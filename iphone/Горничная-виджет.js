// Виджет «Горничной» для iPhone (приложение Scriptable): планы на сегодня, задачи со сроком и ближайший план.
// Установка — iphone/README.md. Ключ спрашивается при первом запуске в Scriptable и хранится в Связке ключей
// телефона (Keychain), в этом файле его нет. Сбросить ключ — запустить скрипт и выбрать «Сменить ключ».

const SERVER = "https://187-126-11-122.sslip.io";
const KEY = "maid.token";
const CACHE = "maid-today.json";

const C = {
  bg: new Color("#1d1b26"),
  bg2: new Color("#2a2638"),
  text: new Color("#f1eefa"),
  dim: new Color("#9a94ad"),
  plan: new Color("#b49cff"),
  task: new Color("#5fd08a"),
  late: new Color("#ff7f7f"),
};
const WEEK = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const MONTH = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

// --- Данные ---

async function askToken() {
  const a = new Alert();
  a.title = "Ключ горничной";
  a.message = "Напишите боту /token и вставьте ключ сюда.";
  a.addSecureTextField("ключ", "");
  a.addAction("Сохранить");
  a.addCancelAction("Отмена");
  if ((await a.presentAlert()) === -1) return null;
  const t = a.textFieldValue(0).trim();
  if (t) Keychain.set(KEY, t);
  return t || null;
}

function cacheFile() {
  const fm = FileManager.local();
  return fm.joinPath(fm.cacheDirectory(), CACHE);
}

// Свежие данные с сервера; нет связи — последние сохранённые (с пометкой).
async function load() {
  if (!Keychain.contains(KEY)) throw new Error("Нет ключа: откройте скрипт в Scriptable и вставьте ключ из /token.");
  const req = new Request(SERVER + "/api/today");
  req.headers = { Authorization: "Bearer " + Keychain.get(KEY) };
  req.timeoutInterval = 20;
  try {
    const data = await req.loadJSON();
    const code = req.response?.statusCode ?? 200;
    if (code === 401) throw new Error("Ключ не подходит: получите новый командой /token.");
    if (code >= 400) throw new Error(data?.error ?? "Сервер ответил " + code);
    // Имя бота — чтобы нажатие на виджет открывало чат с ним.
    const pub = await new Request(SERVER + "/api/public").loadJSON().catch(() => ({}));
    if (pub?.bot) data.bot = pub.bot;
    FileManager.local().writeString(cacheFile(), JSON.stringify(data));
    return { data, stale: false };
  } catch (err) {
    if (/Ключ/.test(err.message)) throw err;
    const fm = FileManager.local();
    if (!fm.fileExists(cacheFile())) throw new Error("Нет связи с сервером.");
    return { data: JSON.parse(fm.readString(cacheFile())), stale: true };
  }
}

// --- Разбор ---

const parse = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / 86400000);
const short = (iso) => {
  const d = parse(iso);
  return `${WEEK[d.getDay()]} ${d.getDate()} ${MONTH[d.getMonth()].slice(0, 3)}`;
};
const inDays = (n) => (n === 1 ? "завтра" : n === 2 ? "послезавтра" : `через ${n} ${n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? "дня" : "дней"}`);
const alive = (e) => !e.status || e.status === "active";
const byTime = (a, b) => (a.time ?? "99").localeCompare(b.time ?? "99");

function rows(data) {
  const today = data.day;
  const plans = (data.events ?? []).filter((e) => e.status !== "deleted" && e.status !== "cancelled").sort(byTime);
  const tasks = (data.tasks ?? []).filter((t) => t.due_date && t.due_date <= today).sort((a, b) => a.due_date.localeCompare(b.due_date));
  const next = (data.upcoming ?? []).filter(alive).sort((a, b) => a.date_iso.localeCompare(b.date_iso) || byTime(a, b))[0];
  return { today, plans, tasks, next };
}

// --- Виджет ---

function line(stack, color, label, text, opts = {}) {
  const row = stack.addStack();
  row.centerAlignContent();
  row.spacing = 5;
  const bar = row.addStack();
  bar.size = new Size(3, opts.small ? 12 : 14);
  bar.cornerRadius = 1.5;
  bar.backgroundColor = color;
  if (label) {
    const l = row.addText(label);
    l.font = Font.semiboldMonospacedSystemFont(opts.small ? 11 : 12);
    l.textColor = opts.labelColor ?? C.dim;
  }
  const t = row.addText(text);
  t.font = Font.mediumSystemFont(opts.small ? 12 : 13);
  t.textColor = opts.done ? C.dim : C.text;
  t.lineLimit = 1;
  row.addSpacer();
}

function build({ data, stale }, family) {
  const w = new ListWidget();
  const g = new LinearGradient();
  g.colors = [C.bg2, C.bg];
  g.locations = [0, 1];
  w.backgroundGradient = g;
  w.setPadding(12, 14, 12, 14);
  if (data.bot) w.url = "tg://resolve?domain=" + data.bot;
  w.refreshAfterDate = new Date(Date.now() + 15 * 60000);

  const small = family === "small";
  const max = { small: 4, medium: 5, large: 13, extraLarge: 13 }[family] ?? 5;
  const { today, plans, tasks, next } = rows(data);

  const head = w.addStack();
  head.centerAlignContent();
  const d = parse(today);
  const title = head.addText(small ? `${WEEK[d.getDay()]}, ${d.getDate()}` : `Сегодня · ${WEEK[d.getDay()]}, ${d.getDate()} ${MONTH[d.getMonth()]}`);
  title.font = Font.boldSystemFont(small ? 14 : 15);
  title.textColor = C.text;
  head.addSpacer();
  if (stale) {
    const off = head.addText("нет связи");
    off.font = Font.mediumSystemFont(11);
    off.textColor = C.late;
  }
  w.addSpacer(8);

  const list = w.addStack();
  list.layoutVertically();
  list.spacing = small ? 4 : 5;
  let used = 0;
  for (const e of plans) {
    if (used >= max) break;
    line(list, C.plan, e.time ?? "", e.title, { small, done: !alive(e) });
    used++;
  }
  for (const t of tasks) {
    if (used >= max) break;
    const late = t.due_date < today;
    line(list, late ? C.late : C.task, late ? "срок прошёл" : "", (t.priority === "high" ? "! " : "") + t.title, { small, labelColor: C.late });
    used++;
  }
  const hidden = plans.length + tasks.length - used;
  if (!used) {
    const none = list.addText("Планов на сегодня нет");
    none.font = Font.mediumSystemFont(small ? 12 : 13);
    none.textColor = C.dim;
  } else if (hidden > 0) {
    const more = list.addText(`ещё ${hidden}`);
    more.font = Font.mediumSystemFont(11);
    more.textColor = C.dim;
  }

  w.addSpacer();
  if (next && (used < max || !small)) {
    const n = daysBetween(today, next.date_iso);
    const foot = w.addText(small ? `${inDays(n)}: ${next.title}` : `Дальше · ${short(next.date_iso)} (${inDays(n)})${next.time ? " " + next.time : ""} · ${next.title}`);
    foot.font = Font.mediumSystemFont(11);
    foot.textColor = C.plan;
    foot.lineLimit = 1;
  }
  return w;
}

// Экран блокировки: одна строка-сводка и ближайшие два дела.
function buildLock({ data }, family) {
  const w = new ListWidget();
  const { plans, tasks, next, today } = rows(data);
  const items = [...plans.filter(alive).map((e) => (e.time ? e.time + " " : "") + e.title), ...tasks.map((t) => "• " + t.title)];
  if (family === "accessoryInline") {
    w.addText(items.length ? `${items.length} на сегодня: ${items[0]}` : next ? `${inDays(daysBetween(today, next.date_iso))}: ${next.title}` : "Планов нет");
    return w;
  }
  const head = w.addText(items.length ? `Сегодня · ${items.length}` : "Сегодня свободно");
  head.font = Font.boldSystemFont(13);
  for (const s of items.slice(0, 2)) {
    const t = w.addText(s);
    t.font = Font.systemFont(12);
    t.lineLimit = 1;
  }
  if (!items.length && next) w.addText(`${inDays(daysBetween(today, next.date_iso))}: ${next.title}`).font = Font.systemFont(12);
  return w;
}

function errorWidget(msg) {
  const w = new ListWidget();
  w.backgroundColor = C.bg;
  const t = w.addText("Горничная");
  t.font = Font.boldSystemFont(14);
  t.textColor = C.text;
  w.addSpacer(6);
  const m = w.addText(msg);
  m.font = Font.systemFont(12);
  m.textColor = C.late;
  w.refreshAfterDate = new Date(Date.now() + 30 * 60000);
  return w;
}

// --- Запуск ---

async function main() {
  if (!config.runsInWidget) {
    if (!Keychain.contains(KEY)) await askToken();
    else {
      const a = new Alert();
      a.title = "Горничная";
      a.message = "Скрипт не ставит виджет сам. На главном экране: долгое нажатие → «+» (слева сверху) → Scriptable → размер → «Добавить виджет», затем нажать на виджет и выбрать этот скрипт в поле Script.";
      a.addAction("Показать виджет");
      a.addAction("Сменить ключ");
      a.addCancelAction("Закрыть");
      const pick = await a.presentSheet();
      if (pick === 1) await askToken();
      if (pick === -1) return;
    }
  }
  const family = config.widgetFamily ?? "medium";
  let widget;
  try {
    const got = await load();
    widget = family.startsWith("accessory") ? buildLock(got, family) : build(got, family);
  } catch (err) {
    widget = errorWidget(err.message);
  }
  if (config.runsInWidget) Script.setWidget(widget);
  else await widget.presentMedium();
}

await main();
Script.complete();
