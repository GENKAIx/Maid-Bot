// Оповещения у горничной (inbox.js, tails.js) без Electron и браузера.
// 17.11.2026: значки летали россыпью, одинаковые нельзя было отличить, а о хвостах горничная спрашивала сама, перебивая
// работу. Теперь четыре значка в ряд (будильник, важное, даты, письма) с числом, несколько оповещений — списком, хвосты
// лежат под будильником и сами не всплывают, у писем — последнее письмо и «Прочитать все письма» в «Историю».
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
const inboxSrc = read("renderer/inbox.js"), tails = read("renderer/tails.js"), widget = read("renderer/widget.js"), css = read("renderer/style.css");

// Картинки разделов есть, старых (россыпь, «+N») нет.
for (const f of ["alarm", "warn", "date", "mail"]) check(fs.existsSync(path.join(root, "assets", "inbox", `${f}.png`)), `нет значка ${f}.png`);
for (const f of ["many", "pill", "plan"]) check(!fs.existsSync(path.join(root, "assets", "inbox", `${f}.png`)), `остался старый значок ${f}.png`);
check(!/ibLayout|ibRand|IB_SHOWN/.test(inboxSrc), "в inbox.js осталась россыпь значков");
const inboxCss = css.match(/\.inbox \{([^}]*)\}/)?.[1] ?? "";
check(/display:\s*flex/.test(inboxCss) && !/height:/.test(inboxCss), "значки не в ряд (у .inbox нет flex или осталась высота прямоугольника)");
check(/openGroup\(ib\.dataset\.group\)/.test(widget), "щелчок по значку не открывает раздел");

// Хвосты сами не всплывают и не «сбегают».
check(!/setInterval|setTimeout/.test(tails), "хвосты всплывают сами");
check(!/dodged/.test(tails), "крестик у хвоста всё ещё закрывает задачу как брошенную");
check(/function askTail\(t\)/.test(tails), "askTail не принимает задачу из списка");

// Виды писем сервера — у каждого должен быть раздел.
const kinds = [...read("../server/src/notices.ts").match(/export const NOTICE_KINDS = \[([^\]]+)\]/)[1].matchAll(/"(\w+)"/g)].map((m) => m[1]);

// --- поведение: inbox.js в песочнице ---
const said = [], opened = [], asked = [];
const store = {};
const el = () => ({ html: "", insertAdjacentHTML(_, h) { this.html = h; }, set innerHTML(v) { this.html = v; }, querySelectorAll: () => [] });
const nodes = { "#bubbleText": el(), "#bubbleCards": el() };
const ctx = vm.createContext({
  localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } },
  $: (s) => nodes[s] ?? null, // #inbox нет — drawInbox выходит сразу, рисование проверяется в браузере
  data: {
    day: "2026-11-17", habits: [],
    tasks: [{ id: 7, title: "Сдать отчёт", due_date: "2026-11-12" }, { id: 5, title: "Оплатить интернет", due_date: "2026-11-16" },
      { id: 9, title: "На потом", due_date: "2026-11-20" }, { id: 3, title: "Без срока", due_date: null }],
  },
  say: (text, o) => said.push({ text, o }),
  startButtons: (x) => x.buttons ?? [],
  askTail: (t) => asked.push(t.id),
  maid: { openSection: (p) => opened.push(p) },
  esc: (s) => String(s), humanDay: (d) => d, placeBubble() {}, fitBubble() {},
  Date, JSON, Math, Set, Number, String, console,
});
vm.runInContext(inboxSrc + "\n;globalThis.t = { noticeGroup, groupItems, inboxAdd, inboxRead, openGroup, openItem, tailsOf, IB_GROUPS, IB_KIND };", ctx);
const t = ctx.t;

check(kinds.every((k) => t.IB_KIND[k]), `вид письма без раздела: ${kinds.filter((k) => !t.IB_KIND[k])}`);
check(t.IB_GROUPS.map((g) => g.id).join() === "alarm,warn,date,mail", "порядок значков не «будильник, важное, даты, письма»");
check(t.noticeGroup({ kind: "habit", text: "x" }) === "alarm" && t.noticeGroup({ kind: "game", text: "x" }) === "warn"
  && t.noticeGroup({ kind: "evening", text: "x" }) === "mail" && t.noticeGroup({ kind: "date", text: "x" }) === "date", "раздел по виду письма неверный");
// Письма без вида (лежат в ящике со старой версии программы).
check(t.noticeGroup({ text: "⏰ Пора: Созвон" }) === "alarm" && t.noticeGroup({ text: "🎂 Завтра день рождения" }) === "date"
  && t.noticeGroup({ text: "🎮 Уже 2 ч" }) === "warn" && t.noticeGroup({ text: "☀️ Доброе утро" }) === "mail", "старое письмо без вида попало не в свой раздел");

// Хвосты: только открытые задачи со сроком в прошлом, старый срок выше.
check(t.tailsOf().map((x) => x.id).join() === "7,5", `хвосты: ${t.tailsOf().map((x) => x.id)}`);

// Два хвоста под будильником — список.
t.openGroup("alarm");
check(said.at(-1).text === "Напоминания · 2" && /Сдать отчёт[^]*Оплатить интернет/.test(nodes["#bubbleCards"].html), "два хвоста не показаны списком под будильником");
// Строка списка с хвостом — вопрос именно об этой задаче.
t.openItem(t.groupItems("alarm")[1]);
check(asked.at(-1) === 5, "строка хвоста открыла вопрос не о своей задаче");

t.inboxAdd({ id: 1, text: "⏰ Через 1 ч: Врач", emotion: "neutral", buttons: [], kind: "plan" });
check(t.groupItems("alarm").map((x) => x.key).join() === "n1,t7,t5", "под будильником порядок не «письма, потом хвосты»");

// В разделе одно оповещение — открывается сразу, без списка.
t.inboxAdd({ id: 2, text: "🎮 Уже 2 ч в играх", emotion: "angry", buttons: [], kind: "game" });
t.openGroup("warn");
check(said.at(-1).text === "🎮 Уже 2 ч в играх" && said.at(-1).o.notice === 2, "единственное оповещение раздела не открылось сразу");

// Письма: последнее, «ещё N не прочитано», кнопка в «Историю».
t.inboxAdd({ id: 3, text: "☀️ Доброе утро", emotion: "happy", buttons: [], kind: "morning" });
t.openGroup("mail");
check(said.at(-1).text === "☀️ Доброе утро" && said.at(-1).o.buttons.length === 0, "у единственного письма лишняя кнопка");
t.inboxAdd({ id: 4, text: "Итог дня", emotion: "proud", buttons: [{ text: "🙂", data: "rate:2026-11-17:7" }], kind: "evening" });
t.inboxAdd({ id: 5, text: "🌙 Завтра", emotion: "neutral", buttons: [], kind: "tomorrow" });
t.openGroup("mail");
const mail = said.at(-1);
check(mail.text === "🌙 Завтра" && mail.o.notice === 5, "письма открываются не с последнего");
check(/ещё 2 не прочитано/.test(nodes["#bubbleText"].html), "нет строки «ещё N не прочитано»");
const all = mail.o.buttons.find((b) => /Прочитать все письма/.test(b.text));
check(!!all, "нет кнопки «Прочитать все письма»");
all?.run();
check(opened.at(-1) === "/history/daily", "«Прочитать все письма» ведёт не в «Историю»");
check(t.groupItems("mail").length === 0 && t.groupItems("warn").length === 1 && t.groupItems("alarm").length === 3, "«Прочитать все письма» погасила не только письма");
// У других разделов такой кнопки нет.
t.openGroup("warn");
check(!said.at(-1).o.buttons.some((b) => /Прочитать все/.test(b.text)), "кнопка «Прочитать все письма» есть не только у писем");

// Прочитанное письмо уходит из раздела, хвосты остаются.
t.inboxRead(1);
t.openGroup("alarm");
check(said.at(-1).text === "Напоминания · 2", "после прочтения письма под будильником остались не только хвосты");

// Оценка дня — ряд из десяти звёзд, а не кнопки с числами (17.11.2026: было четыре смайлика).
check(fs.existsSync(path.join(root, "assets", "star.png")), "нет картинки звезды");
check(/\/\^rate:\/\.test\(x\.data \?\? ""\) \? `<button class="rate-star"/.test(widget), "кнопки оценки дня рисуются не звёздами");
check(/\.bubble-actions:has\(\.rate-star:hover\) \.rate-star img \{ filter: none; \}/.test(css) && /\.rate-star:hover ~ \.rate-star img/.test(css),
  "звёзды не зажигаются до той, на которую навели");
const server = read("../server/src/scheduler.ts");
check(/export const RATE_MAX = 10;/.test(server) && !/DAY_RATES/.test(server), "на сервере оценка дня не от 1 до 10");

console.log(`${n - bad}/${n}`);
process.exit(bad ? 1 : 0);
