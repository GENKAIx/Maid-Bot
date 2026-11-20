// Слова с характером (renderer/wordfx.js + wordfx.css, с 20.11.2026) без Electron и браузера: пометки «[крик]слово[/]» в реплике
// горничной. Зачем: пометка с опечаткой не должна вылезти в облачко скобками, текст без пометок (история, диктор) — совпадать с
// показанным, печать — ждать своё слово ровно столько, сколько идёт его действие, а у каждого эффекта — быть и запись, и вид.
// wordfx.js грузится целиком в vm с заглушками (cfg, $, document, matchMedia, setTimeout, performance) и маленьким самодельным DOM;
// planType, runType и разбор своих реплик из say вырезаются из widget.js (как в widget-type.test.cjs); lines.js (LINES, lineItem)
// грузится в свой vm. Пометки разбираются только в своих репликах — со знаком WORDFX_OWN в начале (ставит lineItem, снимает say).
// Запуск: node desktop/test/widget-wordfx.test.cjs
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const same = (got, want, m) => check(JSON.stringify(got) === JSON.stringify(want), `${m} → ${JSON.stringify(got)}, а надо ${JSON.stringify(want)}`);
const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, "renderer", f), "utf8");
const src = read("wordfx.js"), css = read("wordfx.css"), html = read("widget.html"), lines = read("lines.js"), widget = read("widget.js");

// --- маленький DOM: ровно то, чем пользуется wordfx.js (классы, data-, style, поиск по «.a .b», перенос узлов) ---
class Text {
  constructor(data) { this.nodeType = 3; this.data = String(data); this.parent = null; }
  get textContent() { return this.data; }
  remove() { if (this.parent) { this.parent.childNodes.splice(this.parent.childNodes.indexOf(this), 1); this.parent = null; } }
  replaceWith(node) {
    const p = this.parent, i = p.childNodes.indexOf(this), add = node.frag ? [...node.childNodes] : [node];
    for (const a of add) { a.remove(); a.parent = p; }
    p.childNodes.splice(i, 1, ...add);
    this.parent = null;
  }
}
class El {
  constructor(tag = "span", frag = false) {
    this.nodeType = frag ? 11 : 1; this.tag = tag; this.frag = frag; this.childNodes = []; this.parent = null; this.cls = [];
    this.attrs = {}; this.dataset = {}; this.isConnected = true; this.offsetWidth = 0; this.animated = 0;
    const props = {};
    this.style = { setProperty: (k, v) => { props[k] = String(v); }, getPropertyValue: (k) => props[k] ?? "" };
    const el = this;
    this.classList = {
      add: (...c) => { for (const x of c) if (!el.cls.includes(x)) el.cls.push(x); },
      remove: (...c) => { el.cls = el.cls.filter((x) => !c.includes(x)); },
      contains: (c) => el.cls.includes(c),
      toggle: (c, on = !el.cls.includes(c)) => { if (on) el.classList.add(c); else el.classList.remove(c); return on; },
    };
  }
  get ownerDocument() { return doc; }
  get className() { return this.cls.join(" "); }
  set className(v) { this.cls = String(v).split(/\s+/).filter(Boolean); }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(""); }
  set textContent(v) { for (const c of [...this.childNodes]) c.remove(); this.append(String(v)); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  append(...nodes) {
    for (let x of nodes) {
      if (typeof x === "string") x = new Text(x);
      for (const c of x.frag ? [...x.childNodes] : [x]) { c.remove(); c.parent = this; this.childNodes.push(c); }
    }
  }
  appendChild(x) { this.append(x); return x; }
  remove() { if (this.parent) { this.parent.childNodes.splice(this.parent.childNodes.indexOf(this), 1); this.parent = null; } }
  all(out = []) { for (const c of this.childNodes) if (c.nodeType === 1) { out.push(c); c.all(out); } return out; }
  closest(sel) { for (let e = this; e; e = e.parent) if (e.nodeType === 1 && e.cls.includes(sel.slice(1))) return e; return null; }
  querySelectorAll(sel) {
    const parts = sel.trim().split(/\s+/).map((p) => p.slice(1));
    return this.all().filter((e) => {
      if (!e.cls.includes(parts.at(-1))) return false;
      let a = e.parent;
      for (let i = parts.length - 2; i >= 0; i--) {
        while (a && !a.cls.includes(parts[i])) a = a.parent;
        if (!a) return false;
        a = a.parent;
      }
      return true;
    });
  }
  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  animate() { this.animated++; return { finished: Promise.resolve() }; }
}
const doc = { createElement: (tag) => new El(tag), createDocumentFragment: () => new El("#frag", true) };
const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
/** HTML из wordfxHtml (только span и текст) → самодельное дерево в «облачке». */
function parse(h) {
  const box = new El("div");
  let cur = box;
  for (const m of h.matchAll(/<(\/?)(\w+)([^>]*)>|([^<]+)/g)) {
    if (m[4] != null) cur.append(new Text(unesc(m[4])));
    else if (m[1]) cur = cur.parent ?? box;
    else {
      const el = new El(m[2]);
      for (const a of m[3].matchAll(/([\w-]+)="([^"]*)"/g)) {
        if (a[1] === "class") el.className = a[2];
        else if (a[1].startsWith("data-")) el.dataset[a[1].slice(5)] = unesc(a[2]);
        else el.attrs[a[1]] = unesc(a[2]);
      }
      cur.append(el);
      cur = el;
    }
  }
  return box;
}
/** Нарезка букв, как в planType (widget.js): каждый знак текста — span.tw; возвращает буквы по порядку. */
function slice(box) {
  const chars = [];
  const walk = (node) => {
    for (const c of [...node.childNodes]) {
      if (c.nodeType === 3) {
        const frag = doc.createDocumentFragment();
        for (const ch of c.data) { const sp = doc.createElement("span"); sp.className = "tw"; sp.textContent = ch; frag.appendChild(sp); chars.push(sp); }
        c.replaceWith(frag);
      } else walk(c);
    }
  };
  walk(box);
  return chars;
}

// --- загрузка wordfx.js: время — своё (очередь отложенных вызовов), ошибки зацепок (console.error) считаются ---
const bubble = new El("div");
const errors = [];
let clock = 0, timers = [];
const flush = () => {
  let guard = 0, lastAt = clock;
  while (timers.length && guard++ < 5000) {
    timers.sort((a, b) => a.at - b.at);
    const t = timers.shift();
    clock = lastAt = t.at;
    t.fn();
  }
  return lastAt;
};
const ctx = vm.createContext({
  Math, Number, String, Object, Promise,
  cfg: { mute: true, typing: "sound" }, actx: null,
  $: (sel) => (sel === "#bubble" ? bubble : null),
  document: doc,
  matchMedia: () => ({ matches: false }),
  setTimeout: (fn, ms = 0) => { timers.push({ at: clock + ms, fn }); return timers.length; },
  performance: { now: () => clock }, // то же время, что у отложенных вызовов
  TYPE_CPS: { slow: 22, normal: 35, fast: 60 }, // для planType из widget.js
  console: { error: (...a) => errors.push(a.map(String).join(" ")), log() {} },
});
let x = null;
try {
  vm.runInContext(`${src}\nthis.api = { WORDFX, WORDFX_RU, WORDFX_MAX, WORDFX_LONG, WORDFX_WORD, WORDFX_PHRASE, WORDFX_MARK, WORDFX_OWN, wordfxName, wordfxPick, wordfxSweep, wordfxStrip, wordfxHtml, wordfxPrep, wordfxStep, wordfxShown, wordfxBlip, wordfxFinish, wordfxStatic };`, ctx);
  x = ctx.api;
} catch (e) {
  check(false, `wordfx.js не разобрался: ${e?.message ?? e}`);
}

if (x) {
  const { WORDFX, WORDFX_RU, WORDFX_MAX, WORDFX_LONG, WORDFX_WORD, WORDFX_PHRASE } = x;
  const name = (s) => x.wordfxName(s), pick = (a, b, c) => x.wordfxPick(a, b, c), sweep = (s) => x.wordfxSweep(s);
  const ids = Object.keys(WORDFX);
  const strip = (t) => x.wordfxStrip(t), wrap = (t) => x.wordfxHtml(t);
  const tags = (h) => h.replace(/<[^>]+>/g, "");
  const count = (h, re) => (h.match(re) ?? []).length;

  // --- wordfxStrip: текст без пометок ---
  same(strip("Срок — [крик]сегодня[/]!"), "Срок — сегодня!", "снять пометку");
  same(strip("сдадите [правка=никогда]завтра[/]"), "сдадите никогда", "у правки остаётся исправленное слово");
  same(strip("[правка]завтра[/]"), "завтра", "правка без нового слова — слово как было");
  same(strip("[привет]мир[/] и [/] и [вжух]"), "[привет]мир[/] и [/] и [вжух]", "неизвестные имена и одинокое «[/]» не тронуты");
  same(strip("[привет]мир[/] и [/] и [крик]"), "[привет]мир и  и ", "обрывок с нашим именем убран, а с ним и все «[/]»");
  same(strip("[bold]мир[/]"), "[bold]мир[/]", "латиница в скобках не тронута");
  same(strip("[КРИК]да[/] и [По Слогам]никогда[/] и [Счёт]12[/]"), "да и никогда и 12", "регистр имени");
  same(strip("[строго]Раз[/], [привет]два[/], [маркер]три слова[/]. [шёпот]всё[/]"), "Раз, [привет]два[/], три слова. всё", "несколько пометок");
  same(strip("а [крик]б\nв[/] г"), "а б\nв г", "пометка через перевод строки: скобки сняты, слова остались");
  same([strip(""), strip(null), strip(undefined), strip(5)], ["", "", "", "5"], "пусто и не строка");
  for (const id of ids) same(strip(`до [${WORDFX[id].ru}]слово[/] после`), "до слово после", `имя «${WORDFX[id].ru}» (${id})`);
  // Общий RegExp с флагом g: его lastIndex не должен протекать между вызовами.
  const twice = "Срок — [крик]сегодня[/]! И [маркер]это важно[/].";
  const first = [strip(twice), wrap(twice)];
  for (let i = 0; i < 3; i++) {
    same(strip(twice), first[0], `wordfxStrip, вызов ${i + 2} подряд`);
    same(wrap(twice), first[1], `wordfxHtml, вызов ${i + 2} подряд`);
  }
  x.WORDFX_MARK.exec(twice); // чужой недочитанный поиск (lastIndex посреди строки)
  same(wrap(twice), first[1], "wordfxHtml после недочитанного поиска");
  x.WORDFX_MARK.exec(twice);
  same(strip(twice), first[0], "wordfxStrip после недочитанного поиска");

  // --- wordfxHtml: обёртки ---
  same(wrap("Срок — [крик]сегодня[/]!"), 'Срок — <span class="fx fx-yell" data-fx="yell"><span class="nb"><span class="fw">сегодня</span><span class="pt">!</span></span></span>', "слово и знак за ним");
  same(wrap("Срок — [крик]сегодня[/] уже"), 'Срок — <span class="fx fx-yell" data-fx="yell"><span class="fw">сегодня</span></span> уже', "слово без знака — без .pt и .nb");
  same(wrap("обычный текст, [/] и [привет]"), "обычный текст, [/] и [привет]", "без наших пометок текст тот же");
  same(wrap("обычный текст, [/] и [крик]"), "обычный текст,  и ", "обрывок нашей пометки в wordfxHtml убран");
  const phrase = wrap("Это [маркер]самое важное дело[/]?! Да");
  same([count(phrase, /class="fw"/g), count(phrase, /class="pt"/g), count(phrase, /class="fx /g)], [3, 0, 1], "маркер, фраза из трёх слов: .fw, .pt, .fx");
  // «маркер» (ptOut): заливка лежит на всей пометке, и знак за словом внутрь .fx не уходит — у фразы он идёт простым текстом
  // сразу за закрывающим </span>, у одного слова — в общей неразрывной обёртке .nb снаружи .fx.
  same(phrase, 'Это <span class="fx fx-mark" data-fx="mark"><span class="fw">самое</span> <span class="fw">важное</span> <span class="fw">дело</span></span>?! Да', "маркер, фраза: знак — простым текстом сразу за пометкой");
  same(wrap("Это [маркер]важно[/], да"), 'Это <span class="nb"><span class="fx fx-mark" data-fx="mark"><span class="fw">важно</span></span>,</span> да', "маркер, одно слово: знак снаружи .fx, в общей .nb");
  same(wrap("Это [маркер]важно[/] да"), 'Это <span class="fx fx-mark" data-fx="mark"><span class="fw">важно</span></span> да', "маркер, одно слово без знака: без .nb");
  same(wrap("Это [маркер]важно [/], да"), 'Это <span class="fx fx-mark" data-fx="mark"><span class="fw">важно</span></span> , да', "маркер: знак после пробела к слову не уходит");
  same(wrap("[маркер]раз два[/]…"), '<span class="fx fx-mark" data-fx="mark"><span class="fw">раз</span> <span class="fw">два</span></span>…', "маркер, два слова: без .nb и .pt");
  same(ids.filter((id) => WORDFX[id].ptOut), ["mark"], "эффекты с ptOut");
  // У остальных знак — внутри .fx, в .nb при последнем слове (и у фразы тоже).
  const phraseIn = wrap("Это [строго]самое важное дело[/]?! Да");
  same(phraseIn, 'Это <span class="fx fx-shk" data-fx="shk"><span class="fw">самое</span> <span class="fw">важное</span> <span class="nb"><span class="fw">дело</span><span class="pt">?!</span></span></span> Да', "без ptOut знак уходит к последнему слову фразы");
  for (const id of ids) {
    const e = WORDFX[id], w = id === "count" ? "12" : "слово";
    for (const [inner, sign] of [[w, ","], [w, "?!"], ...(id === "count" ? [] : [["два слова", "."]])]) {
      const h = wrap(`а [${e.ru}=новое]${inner}[/]${sign} б`);
      const one = e.type.one || !inner.includes(" ");
      const fxEl = parse(h).querySelectorAll(".fx")[0];
      same([count(h, /class="pt"/g), count(h, /class="nb"/g), fxEl?.querySelectorAll(".pt").length, fxEl?.querySelectorAll(".nb").length], e.ptOut ? [0, one ? 1 : 0, 0, 0] : [1, 1, 1, 1], `${id}: знак «${sign}» за «${inner}» — .pt, .nb всего и внутри .fx`);
      if (e.ptOut) check(h.includes(one ? `</span></span>${sign}</span> б` : `</span></span>${sign} б`) && (one ? h.startsWith('а <span class="nb"><span class="fx ') : h.startsWith('а <span class="fx ')), `${id} (ptOut): знак «${sign}» не снаружи .fx: ${h}`);
      else check(h.includes(`<span class="pt">${sign}</span></span></span> б`), `${id}: знак «${sign}» не внутри .fx: ${h}`);
      same(tags(h), strip(`а [${e.ru}=новое]${inner}[/]${sign} б`).replace("новое", inner), `${id}: текст со знаком «${sign}» за «${inner}»`);
    }
  }
  const one = wrap("Вы [кавычки]очень заняты[/], да");
  check(count(one, /class="fw"/g) === 1 && one.includes('<span class="fw">очень заняты</span><span class="pt">,</span>'), `type.one: фраза одним куском: ${one}`);
  const fix = wrap("сдадите [правка=никогда]завтра[/].");
  check(fix.includes('class="fx fx-fix" data-fx="fix" data-arg="никогда"') && fix.includes('<span class="fw">завтра</span><span class="pt">.</span>'), `правка: data-arg и старое слово: ${fix}`);
  check(!/data-arg/.test(wrap("[крик]да[/]")) && !/data-arg/.test(wrap("[крик=нет]да[/]")), `data-arg только у эффектов с plainArg: ${wrap("[крик=нет]да[/]")}`);
  same(wrap("[крик=нет]да[/]"), '<span class="fx fx-yell" data-fx="yell"><span class="fw">да</span></span>', "«=слово» у эффекта без plainArg отбрасывается");
  same(wrap("[правка=  никогда ]да[/]"), '<span class="fx fx-fix" data-fx="fix" data-arg="никогда"><span class="fw">да</span></span>', "data-arg — обрезанное новое слово");
  same([wrap("[правка=]да[/]"), wrap("[правка=  ]да[/]"), wrap("[правка]да[/]")], ["да", "да", "да"], "правка без нового слова — обычный текст, без обёртки и data-arg");
  for (const id of ids) {
    const h = wrap(`[${WORDFX[id].ru}=новое]${id === "count" ? "5" : "слово"}[/]`);
    same(/data-arg="/.test(h), !!WORDFX[id].plainArg, `${id}: data-arg в разметке (${h})`);
  }
  const quoted = parse(wrap('[правка=он "там"]тут[/]')).querySelectorAll(".fx")[0];
  check(quoted?.dataset.arg === 'он "там"', `кавычка в data-arg не рвёт атрибут: ${wrap('[правка=он "там"]тут[/]')}`);
  same(wrap("[ШЁПОТ]тихо[/]"), '<span class="fx fx-whisper" data-fx="whisper"><span class="fw">тихо</span></span>', "регистр имени в wordfxHtml");
  // Не больше WORDFX_MAX эффектов: остальные пометки — просто текст.
  same(WORDFX_MAX, 2, "WORDFX_MAX");
  const many = wrap("[крик]раз[/], [маркер]два[/], [золото]три[/] и [правка=пять]четыре[/]!");
  same(count(many, /class="fx /g), WORDFX_MAX, "эффектов в реплике");
  check(many.endsWith("</span> три и пять!") && !/\[/.test(many), `лишние пометки сняты (у правки — исправленное слово): ${many}`);
  // Неизвестная пометка остаётся как есть и в счёт не идёт.
  same(wrap("[привет]мир[/]"), "[привет]мир[/]", "неизвестная пометка");
  const mixed = wrap("[привет]мир[/] [крик]раз[/] [вжух]два[/] [маркер]три[/]");
  check(mixed.startsWith("[привет]мир[/] <span") && mixed.includes(" [вжух]два[/] ") && count(mixed, /class="fx /g) === 2, `неизвестные между известными: ${mixed}`);
  same(wrap("[крик]<b>да</b>[/]"), "<b>да</b>", "пометка поверх тега не оборачивается, скобки сняты");
  same(wrap("[привет]<b>да</b>[/]"), "[привет]<b>да</b>[/]", "чужая пометка поверх тега не тронута");
  // Экранированный текст (после tgHtml): «&amp;» и «&lt;» остаются целыми и не уходят в знак за словом.
  const esc1 = wrap("Чай &amp; [крик]кофе[/]&lt;3 &gt; всё");
  same(esc1, 'Чай &amp; <span class="fx fx-yell" data-fx="yell"><span class="fw">кофе</span></span>&lt;3 &gt; всё', "сущность сразу за словом");
  const esc2 = wrap("[маркер]Том &amp; Джерри[/]!&amp;<b>вот</b>");
  check(esc2.includes('<span class="fw">&amp;</span>') && esc2.endsWith('<span class="fw">Джерри</span></span>!&amp;<b>вот</b>') && !esc2.includes('class="pt"'), `сущность внутри пометки и после знака (маркер: знак снаружи): ${esc2}`);
  const esc3 = wrap("[строго]Том &amp; Джерри[/]!&amp;<b>вот</b>");
  check(esc3.includes('<span class="fw">&amp;</span>') && esc3.includes('<span class="pt">!</span></span></span>&amp;<b>вот</b>'), `сущность внутри пометки и после знака: ${esc3}`);
  same(wrap("a &lt;[крик]да[/]&gt; b"), 'a &lt;<span class="fx fx-yell" data-fx="yell"><span class="fw">да</span></span>&gt; b', "пометка между сущностями");
  // Что видно в облачке (без тегов) — то же, что отдаёт wordfxStrip; у правки в разметке старое слово, новое — в data-arg.
  for (const t of ["Срок — [крик]сегодня[/]!", "[привет]мир[/] [крик]раз[/] [вжух]два[/] [маркер]три слова[/]. [шёпот]всё[/]", "Чай &amp; [счёт]12[/]&lt;3", "[крик]раз[/][маркер]два[/]", "[по слогам]никогда[/]… [дыхание]тише[/]"])
    same(tags(wrap(t)), strip(t), `текст без тегов = wordfxStrip: «${t}»`);

  // --- (1) имя пометки: без регистра, лишних пробелов и разницы «е / ё» ---
  same([name("Счёт"), name("счет"), name("  ПО   Слогам "), name("ШЁПОТ"), name("Ёж ёЁ"), name(5)], ["счет", "счет", "по слогам", "шепот", "еж ее", "5"], "wordfxName");
  for (const id of ids) {
    const ru = WORDFX[id].ru;
    check(WORDFX_RU[name(ru)] === id && name(ru) === name(name(ru)) && !/ё/.test(name(ru)), `${id}: WORDFX_RU по нормализованному имени «${name(ru)}»`);
    for (const v of [ru.toUpperCase(), ru.replace(/ё/g, "е"), ru.replace(/е/g, "ё"), ` ${ru.replace(/ /g, "   ")}  `, ru[0].toUpperCase() + ru.slice(1)]) {
      const w = id === "count" ? "5" : "слово";
      check(pick(v, "новое", w)?.id === id, `${id}: wordfxPick не узнал имя «${v}»`);
      if (v.trim() === v) same(strip(`до [${v}=новое]${w}[/] после`), `до ${id === "fix" ? "новое" : w} после`, `${id}: имя «${v}» в тексте`);
    }
  }
  check(Object.keys(WORDFX_RU).every((k) => k === name(k)), "WORDFX_RU: ключи не нормализованы");
  same([strip("[Счет]5[/]"), strip("[счёт]5[/]"), strip("[СЧЕТ]5[/]"), strip("[шепот]тихо[/]"), strip("[По  Слогам]никогда[/]")], ["5", "5", "5", "тихо", "никогда"], "е/ё, регистр и пробелы в имени: wordfxStrip");
  same(wrap("[Счет]5[/]"), wrap("[счёт]5[/]"), "«[Счет]» = «[счёт]» в wordfxHtml");
  check(/class="fx fx-count"/.test(wrap("[Счет]5[/]")) && /class="fx fx-whisper"/.test(wrap("[Шепот]тихо[/]")) && /class="fx fx-syl"/.test(wrap("[по  слогам]никогда[/]")), "имя без ё / с двойным пробелом не оживило слово");

  // --- (2) wordfxPick: разбор пометки и каждый повод для fx = false ---
  same(pick("привет", null, "мир"), null, "wordfxPick: чужое имя → null");
  same(pick("", null, "мир"), null, "wordfxPick: пустое имя → null");
  {
    const p = pick("Крик", undefined, "сегодня");
    same([p.id, p.e === WORDFX.yell, p.fx, p.word, p.to, p.lead, p.trail, p.plain], ["yell", true, true, "сегодня", "", "", "", "сегодня"], "wordfxPick: обычная пометка");
    same(Object.keys(p).sort(), ["e", "fx", "id", "lead", "plain", "to", "trail", "word"], "wordfxPick: поля");
    const q = pick("правка", " никогда ", "завтра");
    same([q.id, q.fx, q.word, q.to, q.plain], ["fix", true, "завтра", "никогда", "никогда"], "wordfxPick: правка — в чистом тексте новое слово");
    const sp = pick("правка", "никогда", "  завтра ");
    same([sp.fx, sp.word, sp.lead, sp.trail, sp.plain], [true, "завтра", "  ", " ", "  никогда "], "wordfxPick: правка с пробелами по краям");
    same(pick("маркер", null, "раз   два").word, "раз два", "wordfxPick: двойной пробел внутри схлопнут");
  }
  const dead = (nm, arg, inner, why) => {
    const p = pick(nm, arg, inner);
    check(p && p.fx === false && p.plain === inner, `fx=false, ${why}: ${JSON.stringify(p && { fx: p.fx, plain: p.plain })}`);
    const t = `до [${nm}${arg == null ? "" : "=" + arg}]${inner}[/] после`;
    same(strip(t), `до ${inner} после`, `${why}: wordfxStrip снимает скобки`);
    same(wrap(t), `до ${inner} после`, `${why}: wordfxHtml — обычный текст`);
  };
  const live = (nm, arg, inner, why) => check(pick(nm, arg, inner)?.fx === true, `fx=true, ${why}`);
  // слово пустое
  dead("крик", null, " ", "пустое слово (один пробел)");
  dead("крик", null, "   ", "пустое слово (пробелы)");
  same([pick("крик", null, "  ").word, pick("крик", null, "  ").lead, pick("крик", null, "  ").trail], ["", "  ", ""], "пустое слово: пробелы уходят в lead, trail пуст");
  // фраза длиннее WORDFX_PHRASE
  same([WORDFX_WORD, WORDFX_PHRASE], [22, 40], "WORDFX_WORD и WORDFX_PHRASE");
  const fill = (len) => { let s = ""; while (s.length < len) s += s.length % 6 === 5 ? " " : "а"; return s.replace(/ $/, "а"); };
  same([fill(40).length, fill(41).length], [40, 41], "проба: длина фразы");
  live("маркер", null, fill(WORDFX_PHRASE), `фраза ровно ${WORDFX_PHRASE} знаков`);
  dead("маркер", null, fill(WORDFX_PHRASE + 1), `фраза длиннее ${WORDFX_PHRASE}`);
  // слово длиннее WORDFX_WORD
  live("крик", null, "а".repeat(WORDFX_WORD), `слово ровно ${WORDFX_WORD} буквы`);
  dead("крик", null, "а".repeat(WORDFX_WORD + 1), `слово длиннее ${WORDFX_WORD}`);
  dead("маркер", null, "да " + "а".repeat(WORDFX_WORD + 1), "одно из слов фразы слишком длинное");
  live("маркер", null, "а".repeat(WORDFX_WORD) + " " + "б".repeat(WORDFX_PHRASE - WORDFX_WORD - 1), "два слова, каждое в пределах");
  // у эффектов с type.one считается вся фраза
  for (const id of ids.filter((k) => WORDFX[k].type.one && !WORDFX[k].ok)) {
    live(WORDFX[id].ru, "новое", "аааааааааа ббббббббббб", `${id} (type.one): фраза в ${WORDFX_WORD} знака`);
    dead(WORDFX[id].ru, "новое", "аааааааааа бббббббббббб", `${id} (type.one): фраза длиннее ${WORDFX_WORD}, хотя слова короткие`);
  }
  for (const id of ids.filter((k) => !WORDFX[k].type.one && !WORDFX[k].ok))
    live(WORDFX[id].ru, null, "аааааааааа бббббббббббб", `${id} (не one): та же фраза по словам проходит`);
  // длина считается по буквам, а не по записи «&amp;»
  live("крик", null, "а".repeat(WORDFX_WORD - 1) + "&amp;", "сущность &amp; — одна буква");
  dead("крик", null, "а".repeat(WORDFX_WORD) + "&amp;", "слово с сущностью длиннее предела");
  // правка без непустого нового слова
  dead("правка", null, "завтра", "правка без «=»");
  dead("правка", "", "завтра", "правка с пустым «=»");
  dead("правка", "   ", "завтра", "правка с «=» из пробелов");
  live("правка", "никогда", "завтра", "правка с новым словом");
  // ok(word): «счёт» — только число от 2, можно с пробелами
  same(ids.filter((k) => WORDFX[k].ok).sort(), ["count", "syl"], "эффекты с полем ok");
  for (const w of ["2", "7", "12", "500", "10 000", "1 000 000", "02"]) live("счёт", null, w, `счёт на «${w}»`);
  for (const w of ["0", "1", "01", "много", "12а", "а12", "-5", "1,5", "1.5", "12%", "семь", "+7"]) dead("счёт", null, w, `счёт на «${w}»`);
  same([WORDFX.count.ok("10 000"), WORDFX.count.ok("1"), WORDFX.count.ok("2"), WORDFX.count.ok("")], [true, false, true, false], "count.ok напрямую");
  // ok(word): «по слогам» — только русские буквы, без дефиса и цифр
  for (const w of ["никогда", "НИКОГДА", "ёж", "ни за что", "я"]) live("по слогам", null, w, `по слогам на «${w}»`);
  for (const w of ["кто-то", "2026", "дом2", "ок!", "hello", "да, нет", "нет…", "а&amp;б"]) dead("по слогам", null, w, `по слогам на «${w}»`);
  same([WORDFX.syl.ok("никогда"), WORDFX.syl.ok("кто-то"), WORDFX.syl.ok("7"), WORDFX.syl.ok("")], [true, false, false, false], "syl.ok напрямую");
  // слово без эффекта в счёт WORDFX_MAX не идёт
  same(count(wrap("[счёт]много[/] [правка]а[/] [крик]раз[/] [маркер]два[/]"), /class="fx /g), 2, "пометки с fx=false не занимают место в WORDFX_MAX");
  // В записи эффекта поле не объявлено дважды (вторая запись молча перебила бы первую).
  {
    const body = src.slice(src.indexOf("const WORDFX = {"), src.indexOf("const wordfxName"));
    const rows = body.split(/\r?\n/);
    const dup = rows.filter((r, i) => i && r.trim() && r === rows[i - 1] && /^\s*\w+\s*[:(]/.test(r)).map((r) => r.trim().slice(0, 40));
    same(dup, [], "wordfx.js: поле записано два раза подряд");
  }

  // --- (2) пробелы по краям помеченного слова выносятся наружу обёртки ---
  same(wrap("а[крик] да [/]б"), 'а <span class="fx fx-yell" data-fx="yell"><span class="fw">да</span></span> б', "пробелы по краям — снаружи обёртки");
  same(wrap("а [крик]  да[/]!"), 'а   <span class="fx fx-yell" data-fx="yell"><span class="nb"><span class="fw">да</span><span class="pt">!</span></span></span>', "пробел только слева: знак за словом остаётся при нём");
  same(wrap("а [крик]да [/]! б"), 'а <span class="fx fx-yell" data-fx="yell"><span class="fw">да</span></span> ! б', "пробел справа: знак после пробела к слову не уходит");
  same(wrap("[маркер] раз  два [/]"), ' <span class="fx fx-mark" data-fx="mark"><span class="fw">раз</span> <span class="fw">два</span></span> ', "фраза с пробелами по краям и двойным внутри: пустых .fw нет");
  same(wrap("[кавычки] очень заняты [/]"), ' <span class="fx fx-quote" data-fx="quote"><span class="fw">очень заняты</span></span> ', "type.one с пробелами по краям");
  same(wrap("сдадите[правка=никогда] завтра [/]."), 'сдадите <span class="fx fx-fix" data-fx="fix" data-arg="никогда"><span class="fw">завтра</span></span> .', "правка с пробелами по краям");
  same(strip("сдадите[правка=никогда] завтра [/]."), "сдадите никогда .", "правка с пробелами по краям: чистый текст");
  for (const t of ["а[крик] да [/]б", "а [крик]  да[/]!", "[счёт] 12 [/] дней", "[крик] [/]", "а [шёпот]\tда[/]"])
    check(!/<span class="fw">\s|\s<\/span>|<span class="fw"><\/span>/.test(wrap(t)) && tags(wrap(t)) === strip(t), `пробел внутри .fw или текст разошёлся: «${t}» → ${wrap(t)}`);

  // --- (3) wordfxSweep: обрывки пометок с нашими именами ---
  for (const [t, want, why] of [
    ["[привет]мир[/]", "[привет]мир[/]", "чужое имя — текст не тронут"],
    ["а [/] б", "а [/] б", "одинокое «[/]» остаётся"],
    ["[/][/]", "[/][/]", "только закрывающие"],
    ["[bold]мир[/] [1] [а=б] []", "[bold]мир[/] [1] [а=б] []", "чужие скобки"],
    ["", "", "пусто"],
    ["а [крик]б", "а б", "незакрытая пометка"],
    ["а [КРИК]б и [Счет]в", "а б и в", "имя обрывка — без регистра и ё"],
    ["а [правка=никогда]б", "а б", "обрывок с «=словом»"],
    ["[крик]а[/] [/]", "а ", "наша открывающая → убраны все «[/]»"],
    ["[привет]а[/] [крик]б", "[привет]а б", "наш обрывок рядом с чужой пометкой: чужая открывающая остаётся, «[/]» уходят"],
    ["а [крик]б\nв[/] г", "а б\nв г", "через перевод строки"],
    ["[крик]<b>да</b>[/]", "<b>да</b>", "поверх тега"],
    ["[крик][маркер]да[/][/]", "да", "вложенные"],
  ]) same(sweep(t), want, `wordfxSweep: ${why}`);
  same(strip("[крик]а [маркер]б[/] в[/]"), "а б в", "вложенные пометки: wordfxStrip");
  same(strip("[крик][маркер]да[/][/]!"), "да!", "вложенные вплотную: wordfxStrip");
  same(strip("[крик]а"), "а", "незакрытая: wordfxStrip");
  same(strip("[привет]мир[/]"), "[привет]мир[/]", "чужая пометка: wordfxStrip");
  for (const t of ["[крик]а [маркер]б[/] в[/]", "[крик][маркер]да[/][/]!", "а [крик]б", "[крик]<b>да</b>[/] и [шёпот]тихо[/]", "а [крик]б\nв[/] г [золото]д[/]", "[привет]мир[/] [/]", "[счёт]много[/] и [крик]"]) {
    const h = wrap(t);
    check(!ids.some((id) => new RegExp(`\\[${WORDFX[id].ru}[=\\]]`, "i").test(h)), `в облачко вылезла скобка с нашим именем: «${t}» → ${h}`);
    same(tags(h), tags(strip(t)), `обрывки: показанное = wordfxStrip для «${t}»`);
  }
  {
    const h = wrap("[крик]а [маркер]б[/] в[/]");
    check(count(h, /class="fx fx-mark"/g) === 1 && count(h, /class="fx /g) === 1 && !h.includes("["), `вложенные: оживает внутренняя пара, внешние скобки сняты: ${h}`);
  }

  // --- записи эффектов ---
  same(ids.length, 18, "эффектов");
  const rus = ids.map((id) => WORDFX[id].ru);
  same(new Set(rus).size, ids.length, "разных русских имён");
  same(Object.keys(WORDFX_RU).length, ids.length, "WORDFX_RU");
  const TYPE = ["pre", "rate", "post", "pitch", "gain", "every", "climb", "wave", "whole", "one"];
  for (const id of ids) {
    const e = WORDFX[id];
    check(/^[a-z][a-z0-9]*$/.test(id), `${id}: имя не годится для класса css`);
    check(typeof e.ru === "string" && /^[а-яё]+( [а-яё]+)*$/.test(e.ru), `${id}: ru «${e.ru}» — не строчные русские буквы`);
    check(WORDFX_RU[name(e.ru)] === id, `${id}: WORDFX_RU["${name(e.ru)}"] = ${WORDFX_RU[name(e.ru)]}`);
    same(Object.keys(e.type ?? {}).sort(), [...TYPE].sort(), `${id}: поля type`);
    for (const k of TYPE) if (k !== "wave") check(Number.isFinite(e.type?.[k]), `${id}: type.${k} = ${e.type?.[k]} — не число`);
    check(["square", "triangle", "sine", "sawtooth"].includes(e.type?.wave), `${id}: type.wave = ${e.type?.wave}`);
    check(e.type.pre >= 0 && e.type.post >= 0 && e.type.rate > 0 && e.type.every >= 1 && e.type.gain >= 0 && e.type.pitch > 0, `${id}: type вне разумного (${JSON.stringify(e.type)})`);
    check(e.P && Object.keys(e.P).length > 0, `${id}: нет чисел вида P`);
    for (const [k, v] of Object.entries(e.P ?? {}))
      check(typeof v === "number" ? Number.isFinite(v) : /^#[0-9a-f]{6}$/i.test(v), `${id}: P.${k} = ${v} — не конечное число и не цвет`);
    for (const k of Object.keys(e)) check(["ru", "plainArg", "ptOut", "ok", "type", "P", "setup", "hold", "onIn", "onGo", "final"].includes(k), `${id}: неизвестное поле «${k}»`);
    for (const k of ["plainArg", "ptOut"]) check(e[k] === undefined || e[k] === true, `${id}: ${k} = ${e[k]} — не true`);
    for (const k of ["ok", "setup", "hold", "onIn", "onGo", "final"]) check(e[k] == null || typeof e[k] === "function", `${id}: ${k} — не функция`);
    if (e.ok) check(e.ok("") === false && typeof e.ok("слово") === "boolean" && typeof e.ok("12") === "boolean", `${id}: ok должен отвечать true / false`);
  }

  same([WORDFX.count.type.one, WORDFX.count.type.whole], [1, 1], "счёт: type.one и type.whole");

  // --- wordfxStep на самодельных «буквах» ---
  const word = (type, hold) => {
    const fx = { _e: { type, ...(hold ? { hold } : {}) }, _c: {}, dataset: { fx: "test" } };
    const ls = [{ _fx: fx }, { _fx: fx }, { _fx: fx }];
    fx._first = ls[0]; fx._last = ls[2];
    return ls;
  };
  same(x.wordfxStep({}, 500, 20, 0), null, "обычная буква");
  let [a, b, c] = word({ pre: 100, post: 50, rate: 1, whole: 0 });
  same(x.wordfxStep(a, 1000, 20, 0), { at: 1100, next: 1120 }, "пауза pre перед первой буквой");
  same(x.wordfxStep(b, 1120, 20, 0), { at: 1120, next: 1140 }, "вторая буква — без pre");
  same(x.wordfxStep(c, 1140, 20, 260), { at: 1140, next: 1470 }, "последняя буква: шаг + пауза знака + post");
  [a, b, c] = word({ pre: 0, post: 0, rate: 2.5, whole: 0 });
  same([x.wordfxStep(a, 0, 20, 0), x.wordfxStep(b, 50, 20, 120), x.wordfxStep(c, 220, 20, 0)], [{ at: 0, next: 50 }, { at: 50, next: 220 }, { at: 220, next: 270 }], "rate растягивает шаг, но не паузу");
  [a, b, c] = word({ pre: 100, post: 50, rate: 3, whole: 1 }, () => 300);
  same([x.wordfxStep(a, 1000, 20, 0), x.wordfxStep(b, 1100, 20, 0), x.wordfxStep(c, 1100, 20, 0)], [{ at: 1100, next: 1100 }, { at: 1100, next: 1100 }, { at: 1100, next: 1450 }], "whole: все буквы в один момент, потом post + hold");
  [a, b, c] = word({ pre: 0, post: 200, rate: 1, whole: 0 }, () => 300);
  x.wordfxStep(a, 0, 20, 0); x.wordfxStep(b, 20, 20, 0);
  same(x.wordfxStep(c, 40, 20, 0), { at: 40, next: 560 }, "hold у слова по буквам");
  [a, b, c] = word({ pre: 0, post: 200, rate: 1, whole: 1 }, () => -900);
  x.wordfxStep(a, 0, 20, 0); x.wordfxStep(b, 0, 20, 0);
  same(x.wordfxStep(c, 0, 20, 0), { at: 0, next: 0 }, "hold не уводит время назад");
  const solo = { _e: { type: { pre: 70, post: 30, rate: 1, whole: 1 } }, _c: {}, dataset: { fx: "test" } };
  const only = { _fx: solo };
  solo._first = solo._last = only;
  same(x.wordfxStep(only, 10, 20, 0), { at: 80, next: 110 }, "whole, слово из одной буквы");
  errors.length = 0;
  [a, b, c] = word({ pre: 0, post: 40, rate: 1, whole: 0 }, () => { throw new Error("сломанная зацепка"); });
  x.wordfxStep(a, 0, 20, 0); x.wordfxStep(b, 20, 20, 0);
  same(x.wordfxStep(c, 40, 20, 0), { at: 40, next: 100 }, "упавший hold печать не роняет");
  check(errors.length === 1, "упавший hold не попал в console.error");
  errors.length = 0;

  // --- каждый эффект целиком: разметка → буквы → wordfxPrep → время печати → показ букв → отложенные действия ---
  const sample = (id) => `Вот [${WORDFX[id].ru}${id === "fix" ? "=никогда" : ""}]${id === "count" ? "12" : "важное слово"}[/]! Да.`;
  for (const id of ids) {
    const e = WORDFX[id];
    errors.length = 0; timers = []; clock = 0; bubble.animated = 0;
    const box = parse(wrap(sample(id)));
    const chars = slice(box);
    x.wordfxPrep(box);
    const fx = box.querySelectorAll(".fx")[0];
    check(fx && fx._e === e && fx._c && fx._first && fx._last, `${id}: wordfxPrep не подготовил слово`);
    if (!fx?._c) continue;
    same(fx._c.words.length, id === "count" || e.type.one ? 1 : 2, `${id}: слов в c.words`);
    check(fx._c.words.at(-1).classList.contains("lw") && fx._c.words.every((w) => w.dataset.t === (id === "count" ? "12" : e.type.one ? "важное слово" : w.dataset.t) && w.dataset.t), `${id}: у слов нет data-t / .lw`);
    same(fx._c.arg, id === "fix" ? "никогда" : null, `${id}: c.arg`);
    const own = chars.filter((sp) => sp._fx === fx);
    same(own.map((sp) => sp.textContent).join(""), id === "count" ? "12" : "важное слово", `${id}: буквы слова (пробел между словами — в счёт, знак за словом — нет)`);
    same(own.map((sp) => sp.style.getPropertyValue("--i")), own.map((_, i) => String(i)), `${id}: номера букв --i`);
    if (e.hold) {
      const h = e.hold(fx, fx._c);
      check(typeof h === "number" && Number.isFinite(h), `${id}: hold вернул ${h}`);
    }
    // время, как в planType: шаг 20 мс
    let t = 0;
    const at = chars.map((sp) => {
      const now = t, r = x.wordfxStep(sp, t, 20, 0);
      if (r) { t = r.next; return r.at; }
      t += 20;
      return now;
    });
    check(at.every((v, i) => Number.isFinite(v) && (!i || v >= at[i - 1])) && Number.isFinite(t), `${id}: время букв не по порядку: ${at}`);
    const i0 = chars.indexOf(own[0]), i1 = chars.indexOf(own.at(-1));
    same(at[i0] - at[i0 - 1] - 20, e.type.pre, `${id}: пауза перед словом`);
    if (e.type.whole) check(own.every((sp) => at[chars.indexOf(sp)] === at[i0]), `${id}: whole — буквы не в один момент`);
    const wait = at[i1 + 1] - at[i1] - (e.type.whole ? 0 : 20 * e.type.rate);
    const want = Math.max(0, e.type.post + (e.hold ? e.hold(fx, fx._c) : 0));
    check(Math.abs(wait - want) < 1e-6, `${id}: после слова печать ждёт ${wait} мс, а надо post + hold = ${want}`);
    // показ
    for (const sp of chars) {
      sp.classList.add("on");
      x.wordfxShown(sp);
      if (sp === own[0]) check(fx.classList.contains("in") && (own.length === 1 || !fx.classList.contains("go")), `${id}: после первой буквы нет .in (или уже .go)`);
    }
    check(fx.classList.contains("go"), `${id}: после последней буквы нет .go`);
    const end = flush();
    same(errors, [], `${id}: ошибки зацепок при печати`);
    check(!timers.length, `${id}: отложенные действия не кончаются`);
    // действие слова укладывается во время, которое печать на него ждёт (иначе следующий текст побежит поверх)
    if (e.type.whole && e.hold) check(end <= want + 1, `${id}: действие идёт ${end} мс, а печать ждёт ${want}`);
    if (id === "yell") check(bubble.animated > 0, "крик: облачко не вздрогнуло");
    same(fx.querySelectorAll(".pt").length, e.ptOut ? 0 : 1, `${id}: знак за словом внутри .fx`);
    if (id === "count") check(fx._c.w.dataset.n === "12" && fx.classList.contains("fin") && fx._n === 12 && fx._to === 12, `счёт: дошёл до «${fx._c.w.dataset.n}», .fin: ${fx.classList.contains("fin")}`);
    if (id === "syl") check(fx.querySelectorAll(".sy").length === 5 && fx.querySelectorAll(".sy").every((s) => s.classList.contains("hit")), "по слогам: не все слоги упали");
    if (id === "fix") same([fx.querySelectorAll(".fo").map((o) => o.textContent), fx.querySelectorAll(".ft").map((o) => o.textContent)], [["важное слово"], ["никогда"]], "правка: старое и новое слово");
    x.wordfxFinish(box);
    same(errors, [], `${id}: wordfxFinish после печати`);

    // без печати (wordfxStatic): сразу конечный вид, без отложенных действий
    errors.length = 0; timers = []; clock = 0;
    const still = parse(wrap(sample(id)));
    x.wordfxStatic(still);
    const sfx = still.querySelectorAll(".fx")[0];
    check(sfx && ["in", "go", "fin"].every((k) => sfx.classList.contains(k)), `${id}: без печати слово не в конечном виде (${sfx?.className})`);
    check(still.querySelectorAll(".tw").length > 0 && still.querySelectorAll(".tw").every((l) => l.classList.contains("on")), `${id}: без печати буквы не показаны`);
    same(errors, [], `${id}: ошибки зацепок без печати`);
    same(timers.length, 0, `${id}: без печати остались отложенные действия`);
    same(still.textContent.replace(/-/g, "").replace("никогда", ""), strip(sample(id)).replace("никогда", "важное слово").replace("никогда", ""), `${id}: текст облачка без печати`);
    if (id === "count") same(sfx._c.w.dataset.n, "12", "счёт без печати: число на месте");
    if (id === "syl") check(sfx.querySelectorAll(".sy").every((s) => s.classList.contains("hit")), "по слогам без печати: слоги не показаны");
  }
  // «Счёт» не на числе от 2 не оживает вовсе (ok): обёртки нет, слово — обычным текстом.
  for (const txt of ["много", "0", "1", "12а"]) {
    const h = wrap(`Уже [счёт]${txt}[/] дней`);
    same([h, parse(h).querySelectorAll(".fx").length], [`Уже ${txt} дней`, 0], `счёт «${txt}»: без эффекта`);
  }
  // Число с пробелом — один .fw (type.one), а не два слова.
  {
    const h = wrap("Уже [счёт]10 000[/]!");
    same(h, 'Уже <span class="fx fx-count" data-fx="count"><span class="nb"><span class="fw">10 000</span><span class="pt">!</span></span></span>', "счёт «10 000»: один .fw");
  }
  // Число у «счёта»: _to — само число, _n = min(_to, 28) — шагов; на шаге k показано round(_to × k / _n), на последнем — итог
  // (как записан, с пробелом). До 28 считает подряд: 1, 2, 3 … hold = _n × _dt (70 мс на шаг, до 6 шагов — 200 мс).
  for (const [txt, to, steps] of [["500", 500, 28], ["10 000", 10000, 28], ["2", 2, 2], ["7", 7, 7], ["3", 3, 3], ["6", 6, 6], ["12", 12, 12], ["27", 27, 27], ["28", 28, 28], ["29", 29, 28], ["60", 60, 28], ["61", 61, 28], ["1 000 000", 1000000, 28]]) {
    errors.length = 0; timers = []; clock = 0;
    const box = parse(wrap(`[счёт]${txt}[/]`));
    slice(box);
    x.wordfxPrep(box);
    const fx = box.querySelectorAll(".fx")[0];
    const hold = WORDFX.count.hold(fx, fx._c);
    same([fx._to, fx._n, fx._c.words.length], [to, steps, 1], `счёт «${txt}»: число, шагов, слов`);
    same(fx._n, Math.min(fx._to, 28), `счёт «${txt}»: _n = min(_to, 28)`);
    const dt = steps > 6 ? WORDFX.count.P.step : Math.round((WORDFX.count.P.step * 20) / 7);
    same([fx._dt, hold], [dt, steps * dt], `счёт «${txt}»: шаг и hold = _n × _dt`);
    same(fx._c.w.dataset.n, "", `счёт «${txt}»: до показа число пусто`);
    x.wordfxShown(fx._last);
    // по одному шагу: что показано после каждого
    const shown = [fx._c.w.dataset.n], when = [clock];
    for (let guard = 0; timers.length && guard < 200; guard++) {
      timers.sort((p, q) => p.at - q.at);
      const t = timers.shift();
      clock = t.at;
      const was = fx._c.w.dataset.n;
      t.fn();
      if (fx._c.w.dataset.n !== was) { shown.push(fx._c.w.dataset.n); when.push(clock); }
    }
    const end = clock;
    const want = Array.from({ length: steps }, (_, i) => (i + 1 >= steps ? txt : String(Math.round((to * (i + 1)) / steps))));
    same(shown, want, `счёт «${txt}»: числа по шагам`);
    if (to <= 28) same(shown.slice(0, -1), Array.from({ length: to - 1 }, (_, i) => String(i + 1)), `счёт «${txt}»: до 28 считает подряд`);
    else {
      const nums = shown.slice(0, -1).map(Number);
      check(nums.every((v, i) => Number.isInteger(v) && v >= 1 && v < to && (!i || v > nums[i - 1])), `счёт «${txt}»: промежуточные числа не растут или вне 1…${to - 1}: ${shown}`);
    }
    same(when, want.map((_, i) => i * dt), `счёт «${txt}»: моменты шагов`);
    check(fx._c.w.dataset.n === txt && end <= hold && end <= 28 * 70 && fx.classList.contains("fin") && !timers.length && !errors.length, `счёт «${txt}»: в конце «${fx._c.w.dataset.n}», шёл ${end} мс при hold ${hold}; ошибки: ${errors}`);
  }
  // Пустая или сломанная обёртка эффект не включает и не падает.
  errors.length = 0;
  const broken = parse('<span class="fx fx-nope" data-fx="nope"><span class="fw">а</span></span> <span class="fx fx-yell" data-fx="yell"></span>');
  slice(broken);
  x.wordfxPrep(broken);
  x.wordfxFinish(broken);
  check(!errors.length && broken.all().filter((el) => el.cls.includes("fx")).length === 0, `обёртка без эффекта или без букв не погашена: ${errors}`);
  // «Бип»: у обычной буквы — false (решает widget.js), у буквы слова — true.
  const bl = parse(wrap("а [крик]бв[/]")), blc = slice(bl);
  x.wordfxPrep(bl);
  same([x.wordfxBlip(blc[0], 0, 440), x.wordfxBlip(null, 0, 440), x.wordfxBlip(blc[2], 0, 440), x.wordfxBlip(blc[3], 1, 440)], [false, false, true, true], "wordfxBlip");

  // --- деление на слоги у «по слогам» ---
  const syl = (w) => {
    errors.length = 0;
    const box = parse(wrap(`[по слогам]${w}[/]`));
    x.wordfxStatic(box);
    const out = box.querySelectorAll(".fw").map((f) => f.querySelectorAll(".sy").map((s) => s.textContent).join("")).join(" ");
    return errors.length ? `ошибка: ${errors[0]}` : out;
  };
  for (const [w, want] of [
    ["никогда", "ни-ко-гда"], ["больше", "боль-ше"], ["сегодня", "се-го-дня"], ["завтра", "за-втра"], ["майка", "май-ка"], ["район", "рай-он"],
    ["семья", "семь-я"], ["объём", "объ-ём"], ["ванна", "ван-на"], ["палка", "пал-ка"], ["маяк", "ма-як"], ["НИКОГДА", "НИ-КО-ГДА"],
    ["нет", "нет"], ["я", "я"], ["хм", "хм"], ["тсс", "тсс"], ["ъ", "ъ"],
    ["ни за что", "ни за что"], ["никогда больше", "ни-ко-гда боль-ше"],
  ]) same(syl(w), want, `по слогам «${w}»`);
  // не только русские буквы (цифры, знак, дефис) — эффекта нет, слово обычным текстом
  for (const w of ["2026", "ок!", "кто-то", "дом2"]) same([wrap(`[по слогам]${w}[/]`), syl(w)], [w, ""], `по слогам «${w}»: без эффекта`);
  for (const w of ["никогда", "хм", "переподготовка"]) {
    const box = parse(wrap(`[по слогам]${w}[/]`));
    x.wordfxStatic(box);
    const fw = box.querySelectorAll(".fw")[0];
    same(fw.querySelectorAll(".tw").map((l) => l.textContent).join(""), w, `по слогам «${w}»: буквы целы и по порядку`);
    check(fw.querySelectorAll(".hy").length === fw.querySelectorAll(".sy").length - 1 && !fw.querySelectorAll(".sy")[0].querySelectorAll(".hy").length, `по слогам «${w}»: дефис перед каждым слогом, кроме первого`);
  }

  // --- wordfx.css: у каждого эффекта — блок переменных, все var(--k) объявлены, лишних эффектов нет ---
  const heads = [...css.matchAll(/^#bubbleText \.fx-([a-z0-9]+) \{ *(--[^}]*)\}/gm)].map((m) => ({ id: m[1], at: m.index, body: m[2] }));
  same(heads.map((h) => h.id).filter((id, i, all) => all.indexOf(id) !== i), [], "повторные блоки переменных в css");
  const GLOBAL = ["i", "h", "n", "w", "ink"]; // буква, середина, всего букв, номер слова (wordfxPrep) и цвет текста облачка (style.css)
  const SETUP = { str: ["j", "c", "m"] }; // не ручки из P: их ставит setup эффекта (номер буквы в слове, середина слова, букв в слове)
  for (const id of ids) {
    const hi = heads.findIndex((h) => h.id === id);
    check(hi >= 0, `wordfx.css: нет блока переменных «#bubbleText .fx-${id} {»`);
    if (hi < 0) continue;
    const vars = Object.fromEntries([...heads[hi].body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
    const part = css.slice(heads[hi].at, heads[hi + 1]?.at ?? css.length);
    const used = [...new Set([...part.matchAll(/var\(--([\w-]+)/g)].map((m) => m[1]))];
    const byCode = SETUP[id] ?? [];
    same(used.filter((k) => !(k in vars) && !GLOBAL.includes(k) && !byCode.includes(k)), [], `wordfx.css, ${id}: var(--…) без объявления`);
    same(byCode.filter((k) => k in vars || k in WORDFX[id].P || !used.includes(k)), [], `wordfx.css, ${id}: переменная из setup объявлена в css / в P или не используется`);
    same(Object.keys(vars).filter((k) => !used.includes(k) && !(k in WORDFX[id].P)), [], `wordfx.css, ${id}: переменные, которых нет ни в правилах, ни в P`);
    same([...new Set([...part.matchAll(/\.fx-([a-z0-9]+)/g)].map((m) => m[1]))].filter((k) => k !== id), [], `wordfx.css, ${id}: в его правилах чужой эффект`);
    same([...new Set([...part.matchAll(/wx-([a-z0-9]+)-/g)].map((m) => m[1]))].filter((k) => k !== id), [], `wordfx.css, ${id}: чужие кадры анимации`);
    const frames = [...part.matchAll(/@keyframes (wx-[\w-]+)/g)].map((m) => m[1]);
    const called = [...new Set([...part.replace(/@keyframes wx-[\w-]+/g, "").matchAll(/\bwx-[a-z0-9]+-[\w]+/g)].map((m) => m[0]))];
    same([called.filter((k) => !frames.includes(k)), frames.filter((k) => !called.includes(k))], [[], []], `wordfx.css, ${id}: анимации без кадров / кадры без анимации`);
    // числа вида: те же, что P в wordfx.js (звук и ожидание печати считаются по P, вид — по css)
    same(Object.keys(vars).sort(), Object.keys(WORDFX[id].P).sort(), `wordfx.css, ${id}: переменные против P`);
    for (const [k, v] of Object.entries(WORDFX[id].P))
      if (k in vars) check(typeof v === "number" ? parseFloat(vars[k]) === v : vars[k].toLowerCase() === v.toLowerCase(), `wordfx.css, ${id}: --${k}: ${vars[k]}, а в P — ${v}`);
  }
  same([...new Set([...css.matchAll(/\.fx-([a-z0-9]+)/g)].map((m) => m[1]))].filter((k) => !ids.includes(k) && k !== "spark"), [], "wordfx.css: эффекты, которых нет в WORDFX");
  same(heads.map((h) => h.id).filter((k) => !ids.includes(k)), [], "wordfx.css: блоки переменных без записи в WORDFX");
  check(/\.fx-spark\b/.test(css), "wordfx.css: нет вида искр .fx-spark (wordfxSparkle)");
  check(/#bubbleText\.still \.fx[^{]*\{[^}]*animation: none !important/.test(css), "wordfx.css: «меньше движения» не гасит анимации слов");
  // «нехотя»: setup действительно ставит --m на слово и --j, --c на буквы; letter-spacing больше нет (буквы сдвигает transform)
  {
    const box = parse(wrap("[нехотя]ладно уж[/]"));
    slice(box);
    x.wordfxPrep(box);
    const ws = box.querySelectorAll(".fw");
    same(ws.map((w) => w.style.getPropertyValue("--m")), ["5", "2"], "нехотя: --m на словах (букв в слове)");
    same(ws.map((w) => w.querySelectorAll(".tw").map((l) => l.style.getPropertyValue("--j")).join("")), ["01234", "01"], "нехотя: --j на буквах (номер в слове)");
    same(ws.map((w) => [...new Set(w.querySelectorAll(".tw").map((l) => l.style.getPropertyValue("--c")))]), [["2"], ["0.5"]], "нехотя: --c на буквах (середина слова)");
    const hi = heads.findIndex((h) => h.id === "str"), part = hi < 0 ? "" : css.slice(heads[hi].at, heads[hi + 1]?.at ?? css.length);
    check(!/letter-spacing/.test(part) && /transform: translateX\([^;]*var\(--j/.test(part), "wordfx.css, нехотя: буквы должен сдвигать transform, а не letter-spacing");
    // сдвиг буквы — (j − c) × wide / 2: середина слова стоит, края расходятся на половину шага
    const shift = part.match(/@keyframes wx-str-a \{[^@]*?to \{ transform: translateX\(([^;]*)\); \}/)?.[1] ?? "";
    same(shift.replace(/\s+/g, ""), "calc((var(--j,0)-var(--c,0))*var(--wide)/2)", "wordfx.css, нехотя: сдвиг буквы (j − c) × wide / 2");
    check(/from \{ transform: none; \}/.test(part), "wordfx.css, нехотя: в покое буквы на месте");
  }
  // «нехотя»: --c — середина слова и для одной буквы, и для чётного числа букв (сдвиги симметричны: сумма j − c = 0)
  for (const [w, c] of [["а", "0"], ["ну", "0.5"], ["ладно", "2"], ["хорошо", "2.5"]]) {
    const box = parse(wrap(`[нехотя]${w}[/]`));
    slice(box);
    x.wordfxPrep(box);
    const ls = box.querySelectorAll(".tw");
    same([...new Set(ls.map((l) => l.style.getPropertyValue("--c")))], [c], `нехотя «${w}»: --c`);
    same(ls.reduce((s, l) => s + Number(l.style.getPropertyValue("--j")) - Number(l.style.getPropertyValue("--c")), 0), 0, `нехотя «${w}»: сдвиги симметричны`);
  }
  // (9) спрятанное облачко — анимации на паузе; .cut снимает анимации; счёт на розоватом облачке; капля и сердечко исходно не видны
  check(/\.bubble\.hidden #bubbleText \.fx[^{]*\{[^}]*animation-play-state: paused !important/.test(css), "wordfx.css: в спрятанном облачке анимации слов не на паузе");
  check(/#bubbleText \.fx\.cut[^{]*\{[^}]*animation: none !important/.test(css), "wordfx.css: класс .cut не снимает анимации");
  check(/\.bubble\.angry #bubbleText \.fx-count \.fw \{[^}]*color:/.test(css), "wordfx.css: у «счёта» нет цвета для розоватого облачка (.bubble.angry)");
  for (const [sel, what] of [["#bubbleText .fx-pulse.go .fw::after", "сердечко"], ["#bubbleText .fx-drip.go .fw.lw::after", "капля"]]) {
    const rule = css.split(/\r?\n/).find((r) => r.startsWith(sel + " {")) ?? "";
    check(/[{;]\s*opacity: 0;/.test(rule), `wordfx.css: ${what} — исходное opacity: 0 (${sel})`);
  }

  // --- подключение ---
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  const pos = (f) => scripts.indexOf(f);
  check(/<link rel="stylesheet" href="wordfx\.css"/.test(html), "widget.html не подключает wordfx.css");
  check(pos("wordfx.js") >= 0 && pos("wordfx.js") < pos("widget.js"), "wordfx.js не подключён в widget.html раньше widget.js");
  check(pos("lines.js") < 0 || (pos("wordfx.js") >= 0 && pos("wordfx.js") < pos("lines.js")), "wordfx.js не подключён в widget.html раньше lines.js");
  check(html.indexOf('href="wordfx.css"') > html.indexOf('href="style.css"'), "wordfx.css подключён раньше style.css (общие правила облачка перебьют вид слов)");

  // --- (6) wordfxFinish: без cut идущее действие не трогается, с cut — обрывается; c.later после cut молчит ---
  const typed = (text) => {
    errors.length = 0; timers = []; clock = 0;
    bubble.classList.remove("hidden");
    const box = parse(wrap(text));
    const chars = slice(box);
    x.wordfxPrep(box);
    return { box, chars, fx: box.querySelectorAll(".fx")[0], show: () => { for (const sp of chars) { sp.classList.add("on"); x.wordfxShown(sp); } } };
  };
  {
    // wordfxShown: _busy = сейчас + post + hold
    let w = typed("Уже [счёт]12[/] дней");
    clock = 1000;
    w.show();
    const hold = WORDFX.count.hold(w.fx, w.fx._c);
    same(w.fx._busy, 1000 + WORDFX.count.type.post + hold, "wordfxShown: _busy = performance.now() + post + hold");
    check(hold === 12 * 70 && w.fx._c.alive() === true, `счёт 12: hold ${hold}, alive ${w.fx._c.alive()}`);
    // без cut: слово с идущим действием не трогается, счёт добегает сам
    let fired = 0;
    w.fx._c.later(30, () => fired++);
    same(w.fx._c.w.dataset.n, "1", "счёт: первый шаг сразу");
    x.wordfxFinish(w.box);
    same([w.fx._cut === true, w.fx.classList.contains("cut"), w.fx.classList.contains("fin"), w.fx._c.w.dataset.n, w.fx._c.alive()], [false, false, false, "1", true], "wordfxFinish без cut: идущее слово не тронуто");
    x.wordfxFinish(w.box, false);
    same([w.fx._cut === true, w.fx.classList.contains("cut"), w.fx._c.w.dataset.n], [false, false, "1"], "wordfxFinish(box, false): то же");
    flush();
    same([fired, w.fx._c.w.dataset.n, w.fx.classList.contains("fin"), w.fx.classList.contains("cut")], [1, "12", true, false], "без cut: c.later сработал, счёт дошёл сам");

    // cut = true, действие идёт: _cut, классы cut и fin, final; таймеры молчат
    w = typed("Уже [счёт]12[/] дней");
    w.show();
    fired = 0;
    let finals = 0;
    const final0 = WORDFX.count.final;
    w.fx._e = { ...w.fx._e, final: (fx, c) => { finals++; return final0(fx, c); } };
    w.fx._c.later(30, () => fired++);
    clock = 100; // посреди действия
    check(w.fx._busy > clock && timers.length > 0, "проба: действие ещё идёт");
    const ticked = w.fx._c.w.classList.contains("tick");
    w.fx._c.w.classList.remove("tick");
    x.wordfxFinish(w.box, true);
    same([w.fx._cut, ["in", "go", "fin", "cut"].every((k) => w.fx.classList.contains(k)), finals, w.fx._c.w.dataset.n, w.fx._c.alive()], [true, true, 1, "12", false], "wordfxFinish с cut: _cut, классы in/go/fin/cut, final, конечное число, alive() = false");
    flush();
    same([fired, timers.length, w.fx._c.w.dataset.n, w.fx._c.w.classList.contains("tick"), errors.length], [0, 0, "12", false, 0], "после cut: c.later не сработал, счёт не побежал дальше");
    check(ticked, "проба: до обрыва счёт успел сделать шаг");
    let late = 0;
    w.fx._c.later(0, () => late++);
    flush();
    same(late, 0, "после cut: и новый c.later молчит");
    // повторный cut ничего не ломает
    x.wordfxFinish(w.box, true);
    same([w.fx._c.w.dataset.n, errors.length], ["12", 0], "повторный wordfxFinish с cut");

    // cut = true, но действие уже кончилось (_busy в прошлом): слово не трогается
    w = typed("Уже [счёт]12[/] дней");
    w.show();
    flush();
    clock = w.fx._busy + 1;
    x.wordfxFinish(w.box, true);
    same([w.fx._cut === true, w.fx.classList.contains("cut"), w.fx._c.alive()], [false, false, true], "cut после конца действия: слово не обрывается");
    w = typed("Уже [счёт]12[/] дней");
    w.show();
    clock = w.fx._busy; // ровно в момент конца — уже не «в будущем»
    x.wordfxFinish(w.box, true);
    same([w.fx._cut === true, w.fx.classList.contains("cut")], [false, false], "cut ровно в момент _busy: не обрывается");

    // cut = true, слово ещё не допечатано (go нет): конечный вид, но не «обрыв»
    w = typed("Уже [счёт]12[/] дней");
    w.chars[0].classList.add("on");
    x.wordfxShown(w.chars[0]);
    x.wordfxFinish(w.box, true);
    same([["in", "go", "fin"].every((k) => w.fx.classList.contains(k)), w.fx.classList.contains("cut"), w.fx._cut === true, w.fx._c.w.dataset.n, timers.length], [true, false, false, "12", 0], "cut до слова: конечный вид без .cut и без таймеров");
    w = typed("Уже [счёт]12[/] дней");
    x.wordfxFinish(w.box);
    same([["in", "go", "fin"].every((k) => w.fx.classList.contains(k)), w.fx.classList.contains("cut"), w.fx._c.w.dataset.n], [true, false, "12"], "без cut до слова: конечный вид");

    // два слова: первое уже отработало, второе идёт — обрывается только второе
    w = typed("[крик]Эй[/], уже [счёт]12[/] дней");
    w.show();
    const [f1, f2] = w.box.querySelectorAll(".fx");
    clock = 500; // у «крика» конечного вида (final) нет — _busy не задан; счёт (350 + 840) ещё идёт
    check(f1._busy === undefined && f2._busy > clock, `проба: _busy ${f1._busy} и ${f2._busy}`);
    x.wordfxFinish(w.box, true);
    same([f1._cut === true, f1.classList.contains("cut"), f2._cut, f2.classList.contains("cut"), f2.classList.contains("fin")], [false, false, true, true, true], "cut обрывает только слово с идущим действием");
    flush();

    // тот же «крик» сразу после слова (по времени ещё идёт post): щелчок его не обрывает — анимации и таймеры живы
    w = typed("[крик]Эй[/]! Да");
    w.show();
    fired = 0;
    w.fx._c.later(30, () => fired++);
    clock = 10;
    check(clock < WORDFX.yell.type.post, "проба: post «крика» ещё не прошёл");
    x.wordfxFinish(w.box, true);
    same(["_busy" in w.fx, w.fx._cut === true, w.fx.classList.contains("cut"), w.fx.classList.contains("fin"), w.fx.classList.contains("go"), w.fx._c.alive()], [false, false, false, false, true, true], "cut у эффекта без final: _busy не задан, слово не тронуто");
    flush();
    same([fired, errors.length], [1, 0], "cut у эффекта без final: c.later сработал");

    // _busy ставится только эффектам с конечным видом (final): сейчас это «по слогам» и «счёт»
    same(ids.filter((id) => typeof WORDFX[id].final === "function").sort(), ["count", "syl"], "эффекты с final");
    // обрыв у каждого эффекта: с final — после cut ни одно отложенное действие не срабатывает; без final — слово живёт дальше
    for (const id of ids) {
      w = typed(sample(id));
      clock = 400;
      w.show();
      const e = WORDFX[id], span = Math.max(0, e.type.post + (e.hold ? e.hold(w.fx, w.fx._c) : 0));
      if (e.final) same(w.fx._busy, 400 + span, `${id}: _busy = сейчас + post + hold`);
      else same(["_busy" in w.fx, w.fx._busy], [false, undefined], `${id}: без final _busy не задан`);
      let ran = 0;
      w.fx._c.later(1, () => ran++);
      bubble.animated = 0;
      const pending = timers.length;
      x.wordfxFinish(w.box, true);
      if (e.final) {
        check(span > 0, `${id}: у эффекта с final действие должно длиться (post + hold = ${span})`);
        same([w.fx._cut, w.fx.classList.contains("cut"), w.fx.classList.contains("fin")], [true, true, true], `${id}: обрыв во время действия`);
        flush();
        same([ran, bubble.animated, errors.length, timers.length], [0, 0, 0, 0], `${id}: после обрыва — c.later, встряска, ошибки, остаток таймеров`);
        if (id === "syl") check(w.fx.querySelectorAll(".sy").every((sy) => sy.classList.contains("hit")), "по слогам: после обрыва все слоги на месте");
        if (id === "count") same(w.fx._c.w.dataset.n, "12", "счёт: после обрыва — итог");
      } else {
        same([w.fx._cut === true, w.fx.classList.contains("cut"), w.fx.classList.contains("fin"), w.fx.classList.contains("go"), w.fx._c.alive(), timers.length], [false, false, false, true, true, pending], `${id}: без final щелчок слово не обрывает (нет .cut, таймеры на месте)`);
        flush();
        same([ran, errors.length, timers.length], [1, 0, 0], `${id}: без обрыва c.later жив, ошибок нет`);
        // и повторный щелчок, и обычный конец печати его не трогают
        x.wordfxFinish(w.box, true);
        x.wordfxFinish(w.box);
        same([w.fx._cut === true, w.fx.classList.contains("cut"), w.fx.classList.contains("fin")], [false, false, false], `${id}: без final и после конца печати слово не тронуто`);
      }
    }
    // c.later молчит и в спрятанном облачке
    w = typed("Уже [счёт]12[/] дней");
    let hid = 0;
    w.fx._c.later(5, () => hid++);
    bubble.classList.add("hidden");
    flush();
    bubble.classList.remove("hidden");
    same(hid, 0, "c.later в спрятанном облачке молчит");
    errors.length = 0; timers = []; clock = 0;
  }

  // --- (7) tail: planType из widget.js считает конец действия последнего помеченного слова ---
  {
    const from = widget.indexOf("function planType("), to = widget.indexOf("function runType(");
    check(from > 0 && to > from, "в widget.js нет planType / runType");
    ctx.cfg.typeSpeed = "normal";
    vm.runInContext(`${widget.slice(from, to)}\nthis.planType = planType;`, ctx);
    const STEP = 1000 / 35;
    const plan = (text, speed = 1) => {
      errors.length = 0; timers = []; clock = 0;
      const box = parse(wrap(text));
      const tw = ctx.planType(box, speed);
      return { tw, box, fxs: box.querySelectorAll(".fx") };
    };
    const near = (a, b) => Math.abs(a - b) <= 1;
    let p = plan("Просто текст без пометок.");
    same([p.tw.tail, p.tw.chars.length, Object.keys(p.tw).sort()], [0, 25, ["at", "chars", "tail", "total"]], "без пометок: tail = 0");
    check(near(p.tw.total, 25 * STEP + 260), `без пометок: total ${p.tw.total}`);
    // слово по буквам в конце реплики: tail = total = последняя буква + шаг × rate + post
    p = plan("Срок — [крик]сегодня[/]");
    let T = WORDFX.yell.type;
    same(p.tw.tail, p.tw.total, "слово в конце: tail = total");
    check(near(p.tw.tail, p.tw.at.at(-1) + STEP * T.rate + T.post), `крик в конце: tail ${p.tw.tail}, последняя буква ${p.tw.at.at(-1)}`);
    check(p.tw.tail > p.tw.at.at(-1), "крик в конце: печать ждёт после последней буквы");
    // знак за словом печатается после действия: tail раньше total на шаг и паузу знака
    p = plan("Срок — [крик]сегодня[/]!");
    check(near(p.tw.at.at(-1), p.tw.tail) && near(p.tw.total - p.tw.tail, STEP + 260), `крик со знаком: tail ${p.tw.tail}, знак в ${p.tw.at.at(-1)}, total ${p.tw.total}`);
    // слово в середине: tail — момент следующей буквы, меньше total
    p = plan("Срок — [крик]сегодня[/] и точка");
    {
      const last = p.tw.chars.findLastIndex((sp) => sp._fx);
      check(near(p.tw.tail, p.tw.at[last + 1]) && p.tw.tail < p.tw.total, `слово в середине: tail ${p.tw.tail}, следующая буква ${p.tw.at[last + 1]}, total ${p.tw.total}`);
    }
    // слово целиком с hold (счёт) в конце: все буквы в один момент, tail = этот момент + post + hold
    p = plan("Уже [счёт]12[/]");
    T = WORDFX.count.type;
    same(p.tw.tail, p.tw.total, "счёт в конце: tail = total");
    check(near(p.tw.tail - p.tw.at.at(-1), T.post + 12 * 70) && near(p.tw.at.at(-1), 4 * STEP + T.pre), `счёт в конце: буква в ${p.tw.at.at(-1)}, tail ${p.tw.tail}`);
    // само действие (счёт бежит по таймерам) укладывается до tail
    {
      const fx = p.fxs[0];
      clock = p.tw.at.at(-1);
      for (const sp of p.tw.chars) x.wordfxShown(sp);
      check(near(fx._busy, p.tw.tail), `счёт: _busy ${fx._busy} против tail ${p.tw.tail}`);
      const end = flush();
      check(end <= p.tw.tail + 1 && fx.classList.contains("fin") && !errors.length, `счёт: действие кончилось в ${end}, tail ${p.tw.tail}`);
    }
    // по слогам в конце: tail покрывает падение всех слогов
    p = plan("Чепчик не [по слогам]трогать[/]");
    {
      const fx = p.fxs[0], h = WORDFX.syl.hold(fx, fx._c);
      check(h > 0 && near(p.tw.tail - p.tw.at.at(-1), WORDFX.syl.type.post + h) && p.tw.tail === p.tw.total, `по слогам: hold ${h}, tail ${p.tw.tail}, буква в ${p.tw.at.at(-1)}`);
    }
    // два слова: tail — у последнего
    p = plan("[крик]Эй[/], уже [счёт]12[/] дней");
    {
      const lastOf = (fx) => p.tw.chars.indexOf(fx._last);
      const [a, b] = p.fxs;
      check(near(p.tw.tail, p.tw.at[lastOf(b)] + WORDFX.count.type.post + 840) && p.tw.tail > p.tw.at[lastOf(a) + 1] && p.tw.tail < p.tw.total, `два слова: tail ${p.tw.tail}`);
    }
    // эффект без post и hold в конце: tail = конец последней буквы
    p = plan("Она [пульс]розовая[/]");
    check(near(p.tw.tail, p.tw.at.at(-1) + STEP * WORDFX.pulse.type.rate) && p.tw.tail === p.tw.total, `пульс в конце: tail ${p.tw.tail}`);
    // пометка без эффекта (fx = false) времени не занимает
    same([plan("Уже [счёт]много[/] дней").tw.tail, plan("Уже [счёт]много[/] дней").tw.total], [0, plan("Уже много дней").tw.total], "слово без эффекта: tail = 0, время как у обычного текста");
    // для каждого эффекта: tail = последняя буква + её шаг + post + hold, не позже total; at не убывает
    for (const id of ids) {
      p = plan(sample(id));
      const last = p.tw.chars.indexOf(p.fxs[0]._last), e = WORDFX[id];
      const want = p.tw.at[last] + (e.type.whole ? 0 : STEP * e.type.rate) + Math.max(0, e.type.post + (e.hold ? e.hold(p.fxs[0], p.fxs[0]._c) : 0));
      check(near(p.tw.tail, want) && p.tw.tail <= p.tw.total && p.tw.at.every((v, i) => !i || v >= p.tw.at[i - 1]), `${id}: tail ${p.tw.tail}, а надо ${want}; total ${p.tw.total}`);
      same(errors, [], `${id}: ошибки в planType`);
    }
    // быстрая печать (speed 2,5): шаг короче, паузы слова те же
    p = plan("Срок — [крик]сегодня[/]", 2.5);
    check(near(p.tw.tail, p.tw.at.at(-1) + (STEP / 2.5) * WORDFX.yell.type.rate + WORDFX.yell.type.post), `speed 2.5: tail ${p.tw.tail}`);
    errors.length = 0; timers = []; clock = 0;
  }
  // runType (из widget.js): печать кончается, когда показана последняя буква И время дошло до tail; щелчок — wordfxFinish(box, true)
  {
    const from = widget.indexOf("function runType("), to = widget.indexOf("function typeBlip(");
    check(from > 0 && to > from, "в widget.js нет runType / typeBlip");
    let now = 0, nextId = 1;
    const ticks = new Map(), listeners = new Set(), classes = new Set(), finished = [];
    const b = {
      classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
      addEventListener: (t, f) => listeners.add(f), removeEventListener: (t, f) => listeners.delete(f),
      querySelector: () => null, querySelectorAll: () => [],
    };
    const text = { id: "bubbleText" };
    const rt = vm.createContext({
      TYPE_PITCH: {}, typeTimers: [], typing: null, cfg: { mute: true },
      performance: { now: () => now },
      setInterval: (f) => { const id = nextId++; ticks.set(id, f); return id; },
      clearInterval: (id) => ticks.delete(id), clearTimeout: () => {},
      typeBlip: () => {}, wordfxShown: () => {}, wordfxBlip: () => false,
      wordfxFinish: (box, cut) => finished.push([box === text, cut]),
      $: (sel) => (sel === "#bubbleText" ? text : b),
    });
    vm.runInContext(widget.slice(from, to), rt);
    const advance = (ms) => { for (let t = 0; t < ms; t += 16) { now += 16; for (const f of [...ticks.values()]) f(); } };
    const mk = (len, tail) => {
      const chars = [], at = [];
      for (let i = 0; i < len; i++) { const on = new Set(); chars.push({ textContent: "а", on, classList: { add: (c) => on.add(c) }, getBoundingClientRect: () => ({ top: 0, bottom: 0 }) }); at.push(i * 10); }
      return { chars, at, total: Math.max(len * 10, tail ?? 0), ...(tail == null ? {} : { tail }) };
    };
    let tw = mk(5, 600);
    rt.runType(tw, "calm");
    advance(200);
    check(tw.chars.every((c) => c.on.has("on")) && rt.typing !== null && classes.has("typing") && !finished.length, "runType: буквы показаны, но до tail печать не закончена");
    advance(350);
    check(rt.typing !== null, "runType: за 50 мс до tail печать ещё идёт");
    advance(100);
    check(rt.typing === null && !classes.has("typing") && !ticks.size && !listeners.size, "runType: после tail печать закончилась");
    same(finished, [[true, false]], "runType: обычный конец — wordfxFinish(#bubbleText, false)");
    // tail = 0 и без поля tail — кончается сразу после последней буквы
    for (const tail of [0, undefined]) {
      finished.length = 0;
      tw = mk(5, tail);
      rt.runType(tw, "calm");
      advance(80);
      check(rt.typing === null && finished.length === 1 && finished[0][1] === false, `runType: tail ${tail} — конец сразу после последней буквы`);
    }
    // щелчок-пропуск посреди ожидания tail: finish(true) → wordfxFinish(box, true)
    finished.length = 0;
    tw = mk(5, 600);
    rt.runType(tw, "calm");
    advance(200);
    [...listeners][0]?.({ stopPropagation() {} });
    same(finished, [[true, true]], "runType: щелчок — wordfxFinish(#bubbleText, true)");
    check(rt.typing === null && !listeners.size && !ticks.size, "runType: щелчок во время ожидания tail закончил печать");
    // щелчок посреди букв
    finished.length = 0;
    tw = mk(30, 600);
    rt.runType(tw, "calm");
    advance(40);
    [...listeners][0]?.({ stopPropagation() {} });
    check(tw.chars.every((c) => c.on.has("on")) && finished.length === 1 && finished[0][1] === true && rt.typing === null, "runType: щелчок посреди букв дописал всё и передал cut = true");
  }

  // --- (10) пометки в готовых репликах (lines.js): каждая разбирается и оживает, не больше WORDFX_MAX, текст не длиннее WORDFX_LONG ---
  // В реплике бывают подстановки: вместо {n} — число (проба: 7), вместо прочих {имя} — слово (проба: «тест»).
  const NAME = /\[([а-яё][а-яё ]*)(?:=[^\[\]<>\n]*)?\]/gi;
  // Смотрим только тексты реплик — поля t объекта LINES (lines.js прогоняется в vm): в коде lineItem есть своя «/\[\/\]/».
  let marks = 0, marked = 0;
  const seen = new Set();
  const OWN = x.WORDFX_OWN;
  let L = null;
  try {
    const lctx = vm.createContext({ WORDFX_OWN: OWN, localStorage: { getItem: () => null, setItem() {} } });
    vm.runInContext(`${lines}\nthis.api = { LINES, lineItem, line };`, lctx);
    L = lctx.api;
  } catch (e) {
    check(false, `lines.js не разобрался: ${e?.message ?? e}`);
  }
  const texts = [];
  for (const [key, list] of Object.entries(L?.LINES ?? {})) {
    check(Array.isArray(list) && list.length > 0, `lines.js: «${key}» — не список реплик`);
    for (const v of Array.isArray(list) ? list : []) {
      check(v && typeof v.t === "string" && v.t, `lines.js: в «${key}» реплика без текста t`);
      if (v && typeof v.t === "string") texts.push({ key, v });
    }
  }
  check(texts.length > 50, `lines.js: реплик в LINES ${texts.length}`);
  // каждая строка файла со скобкой «[крик]…» — это текст реплики из LINES (кроме кода lineItem), так что ничего не пропущено
  {
    const body = lines.slice(0, lines.search(/\r?\nconst LINES_KEY/));
    const inFile = count(body, /\[\/\]/g), inLines = texts.reduce((s, { v }) => s + count(v.t, /\[\/\]/g), 0);
    same(inLines, inFile, "lines.js: «[/]» в текстах LINES и в записи LINES в файле");
  }
  for (const { v } of texts) {
    const raw = v.t;
    check(!raw.includes(OWN), `lines.js: в тексте реплики уже стоит знак WORDFX_OWN: «${raw.slice(0, 40)}»`);
    if (!raw.includes("[")) continue;
    const t = raw.replace(/\{n\}/g, "7").replace(/\{[a-zа-яё_]\w*\}/gi, "тест");
    const short = raw.length > 70 ? `${raw.slice(0, 70)}…` : raw;
    let here = 0;
    for (const k of t.matchAll(x.WORDFX_MARK)) {
      here++;
      const p = pick(k[1], k[2], k[3]);
      check(p, `lines.js: неизвестная пометка «[${k[1]}]» в «${short}»`);
      if (!p) continue;
      seen.add(p.id);
      check(p.fx === true, `lines.js: пометка «${k[0]}» не оживает (wordfxPick → fx = false) в «${short}»`);
      check(k[2] == null || p.e.plainArg, `lines.js: «=${k[2]}» у пометки «${k[1]}», а слово через «=» берёт только правка: «${short}»`);
      check(k[3].trim() === k[3] && !/ {2}/.test(k[3]), `lines.js: пробел по краю или двойной внутри пометки «${k[0]}»`);
    }
    marks += here;
    marked++;
    const rest = t.replace(x.WORDFX_MARK, "");
    check(!rest.includes("[/]"), `lines.js: «[/]» без открывающей пометки в «${short}»`);
    for (const k of rest.matchAll(NAME)) check(!WORDFX_RU[name(k[1])], `lines.js: пометка «${k[0]}» не закрыта «[/]» в «${short}»`);
    const shown = wrap(t);
    check(strip(t) === tags(shown) || /\[правка/i.test(t) || t.includes("<"), `lines.js: текст без пометок расходится с показанным: «${short}»`);
    check(!/\[\/\]/.test(strip(t)) && ![...strip(t).matchAll(NAME)].some((k) => WORDFX_RU[name(k[1])]), `lines.js: в чистом тексте остались скобки пометок: «${strip(t)}»`);
    check(here >= 1 && here <= WORDFX_MAX, `lines.js: пометок в реплике ${here}, а можно от 1 до ${WORDFX_MAX}: «${short}»`);
    same(count(shown, /class="fx /g), here, `lines.js: оживших слов столько же, сколько пометок, в «${short}»`);
    check(strip(t).length <= WORDFX_LONG, `lines.js: чистый текст ${strip(t).length} знаков, а эффекты идут только до ${WORDFX_LONG}: «${short}»`);
    // реплика целиком проходит подготовку к печати без ошибок зацепок
    errors.length = 0; timers = []; clock = 0;
    const box = parse(shown);
    slice(box);
    x.wordfxPrep(box);
    same([box.querySelectorAll(".fx").filter((f) => f._e).length, errors], [here, []], `lines.js: подготовка к печати «${short}»`);
  }
  check(marks > 0 && marked > 0, `lines.js: пометок ${marks} в ${marked} репликах — должно быть больше нуля`);
  check(seen.size >= 1 && [...seen].every((id) => ids.includes(id)), `lines.js: разных эффектов ${seen.size}`);
  errors.length = 0; timers = []; clock = 0;

  // --- (11) свои и чужие реплики: знак WORDFX_OWN ставит lineItem (lines.js), снимает и разбирает пометки say (widget.js) ---
  same([OWN, OWN.length], ["⁣", 1], "WORDFX_OWN — один невидимый знак U+2063");
  check(strip(OWN + "[крик]да[/]") === OWN + "да" && !wrap("обычный текст").includes(OWN), "wordfxStrip сам знак не снимает (это делает say)");
  // say: кусок из widget.js от «const own» до записи в облачко; planRows, tgHtml, esc — заглушки «как есть».
  let sayText = null;
  {
    const sayAt = widget.indexOf("function say("), sayEnd = widget.indexOf("\nfunction ", sayAt + 1);
    const from = widget.indexOf("const own = text.startsWith(WORDFX_OWN);", sayAt), to = widget.indexOf('$("#bubbleText").innerHTML =', from);
    check(sayAt > 0 && from > sayAt && to > from && to < sayEnd, "в say (widget.js) нет разбора своих реплик (const own = text.startsWith(WORDFX_OWN))");
    const put = widget.slice(to, sayEnd).match(/^\$\("#bubbleText"\)\.innerHTML = (.*);\r?\n/)?.[1];
    check(put, "в say (widget.js) не нашлась запись текста в #bubbleText");
    if (from > 0 && to > from && put) {
      try {
        vm.runInContext(`this.sayText = (function () {
          const planRows = (s) => s, tgHtml = (s) => s, esc = (s) => s;
          return function (text, { changes = [], proposal = null, heard = "" } = {}) {
            ${widget.slice(from, to)}
            return { own, text, marked, plain, fxOn, html: ${put} };
          };
        })();`, ctx);
        sayText = ctx.sayText;
      } catch (e) {
        check(false, `кусок say не разобрался: ${e?.message ?? e}`);
      }
    }
    // по тексту: в widget.js пометки разбираются только в say и только под условием own / fxOn
    const body = widget.slice(sayAt, sayEnd);
    same([count(widget, /wordfxStrip\(/g), count(widget, /wordfxHtml\(/g), count(body, /wordfxStrip\(/g), count(body, /wordfxHtml\(/g)], [1, 1, 1, 1], "widget.js: wordfxStrip и wordfxHtml зовутся по разу, оба в say");
    check(/\r?\n\s*if \(own\) text = wordfxStrip\(text\);\r?\n/.test(body), "say: wordfxStrip зовётся не под условием own");
    check(/const fxOn = marked !== text && /.test(body) && /\(fxOn \? wordfxHtml\(/.test(body), "say: wordfxHtml зовётся не под условием fxOn (marked !== text)");
    check(/const own = text\.startsWith\(WORDFX_OWN\);\r?\n\s*if \(own\) text = text\.slice\(WORDFX_OWN\.length\);\r?\n\s*const marked = text;/.test(body), "say: знак WORDFX_OWN не снимается до разбора");
  }
  if (sayText) {
    // своя реплика: знак снят, пометки сняты из текста и оживают в облачке
    let r = sayText(OWN + "Срок — [крик]сегодня[/]!");
    same([r.own, r.text, r.plain, r.fxOn, r.html], [true, "Срок — сегодня!", "Срок — сегодня!", true, wrap("Срок — [крик]сегодня[/]!")], "say, своя реплика с пометкой");
    check(count(r.html, /class="fx fx-yell"/g) === 1 && !r.html.includes(OWN) && !r.html.includes("["), `say, своя реплика: в облачке ${r.html}`);
    r = sayText(OWN + "сдадите [правка=никогда]завтра[/].");
    same([r.text, r.fxOn, count(r.html, /class="fx fx-fix"/g)], ["сдадите никогда.", true, 1], "say, своя реплика с правкой: в тексте новое слово");
    r = sayText(OWN + "Просто текст");
    same([r.own, r.text, r.fxOn, r.html], [true, "Просто текст", false, "Просто текст"], "say, своя реплика без пометок: знак снят, эффекта нет");
    r = sayText(OWN + "Уже [счёт]много[/] дней");
    same([r.text, r.html], ["Уже много дней", "Уже много дней"], "say, своя реплика с пометкой без эффекта: скобки сняты");
    // чужой текст — как есть: скобки не сняты, обёрток нет
    for (const t of ["[крик]слово[/]", "Срок — [крик]сегодня[/]!", "Добавила «[счёт] за свет»", "[счёт] за свет", "Задача «[правка=никогда]завтра[/]» перенесена", "[маркер]раз два[/], [золото]три[/]", "а [крик]б", "[привет]мир[/]", "Обычный ответ сервера.", "", " " + OWN + "[крик]да[/]", "а" + OWN + "[крик]да[/]"]) {
      r = sayText(t);
      same([r.own, r.text, r.marked, r.plain, r.fxOn, r.html], [false, t, t, t, false, t], `say, чужой текст как есть: «${t}»`);
    }
    // знак только в самом начале и снимается один раз
    r = sayText(OWN + OWN + "[крик]да[/]");
    same([r.own, r.text], [true, OWN + "да"], "say: снимается один знак");
    // своя реплика, но эффектам не место: длинный текст, вопрос «добавить?» — пометки просто сняты
    const long = "очень длинная реплика ".repeat(7);
    check(long.length > WORDFX_LONG, "проба: длинный текст");
    r = sayText(OWN + long + "[крик]да[/]");
    same([r.text, r.fxOn, r.html], [long + "да", false, long + "да"], "say, своя длинная реплика: пометки сняты, эффекта нет");
    r = sayText(OWN + "а".repeat(WORDFX_LONG - 2) + "[крик]да[/]");
    same([r.plain.length, r.fxOn, count(r.html, /class="fx /g)], [WORDFX_LONG, true, 1], `say, своя реплика ровно в ${WORDFX_LONG} знаков: эффект есть`);
    r = sayText(OWN + "Срок — [крик]сегодня[/]!", { proposal: { status: "open" } });
    same([r.text, r.fxOn, r.html], ["Срок — сегодня!", false, "Срок — сегодня!"], "say, своя реплика с вопросом: пометки сняты, эффекта нет");
    // с карточками показывается первая строка
    r = sayText(OWN + "[крик]Готово[/]!\nвторая строка", { changes: [{}] });
    same([r.text, r.plain, r.fxOn, tags(r.html)], ["Готово!\nвторая строка", "Готово!", true, "Готово!"], "say, своя реплика с карточками: первая строка");
    r = sayText("[крик]Готово[/]!\nвторая строка", { changes: [{}] });
    same([r.plain, r.fxOn, r.html], ["[крик]Готово[/]!", false, "[крик]Готово[/]!"], "say, чужой текст с карточками: как есть");
  }
  // lineItem: реплика с пометкой получает знак, без пометки — нет; {имя} подставлено; скобки в подставленном значении убраны
  if (L) {
    const one = (key, v, vars) => {
      const keep = L.LINES[key];
      L.LINES[key] = [v]; // один вариант — выбор не случаен
      try { return L.lineItem(key, vars); } finally { L.LINES[key] = keep; }
    };
    const fill = (t, f) => t.replace(/\{(\w+)\}/g, (_, k) => f(k));
    let own = 0, alien = 0, withVars = 0;
    for (const { key, v } of texts) {
      const has = v.t.includes("[/]"), short = v.t.length > 60 ? `${v.t.slice(0, 60)}…` : v.t;
      const names = [...v.t.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      if (names.length) withVars++;
      // обычные значения: {n} — число, прочее — слово
      const val = (k) => (k === "n" ? 7 : `тест-${k}`);
      const vars = Object.fromEntries(names.map((k) => [k, val(k)]));
      const r = one(key, v, vars);
      same([r.m, r.t], [v.m ?? "neutral", (has ? OWN : "") + fill(v.t, (k) => String(val(k)))], `lineItem «${key}»: «${short}»`);
      same([r.t.startsWith(OWN), r.t.lastIndexOf(OWN)], [has, has ? 0 : -1], `lineItem «${key}»: знак WORDFX_OWN только у реплики с пометкой и только в начале: «${short}»`);
      check(!/\{\w+\}/.test(r.t), `lineItem «${key}»: подстановка осталась в тексте: «${r.t}»`);
      // значения со скобками и пометкой: в своей реплике скобки убраны, в реплике без пометок — значение как есть (say её не разбирает)
      const bad = (k) => `[крик]${k}[/] [x]`;
      const h = one(key, v, Object.fromEntries(names.map((k) => [k, bad(k)])));
      same(h.t, has ? OWN + fill(v.t, (k) => `крик${k}/ x`) : fill(v.t, bad), `lineItem «${key}»: скобки в подставленном значении: «${short}»`);
      // значения нет — пусто
      same(one(key, v, {}).t, (has ? OWN : "") + fill(v.t, () => ""), `lineItem «${key}»: без значений: «${short}»`);
      if (has) own++; else alien++;
      // вся цепочка lineItem → say: своя реплика оживает, чужие скобки из значения — нет
      if (sayText) {
        const s = sayText(r.t), marksIn = count(v.t, /\[\/\]/g);
        same([s.own, s.text.includes(OWN), /\[\/\]/.test(s.text), count(s.html, /class="fx /g)], [has, false, false, has ? marksIn : 0], `lineItem → say «${key}»: «${short}»`);
        const sh = sayText(h.t);
        if (has) check(count(sh.html, /class="fx /g) <= marksIn && (!sh.html.includes("fx-yell") || /\[крик\]/i.test(v.t)) && !/\[крик\]|\[x\]/.test(sh.html), `lineItem → say «${key}»: пометка из подставленного значения ожила: ${sh.html}`);
        else same([sh.fxOn, sh.html], [false, h.t], `lineItem → say «${key}»: реплика без пометок со скобками в значении — как есть`);
      }
    }
    check(own > 0 && alien > 0 && withVars > 0, `lineItem: реплик с пометками ${own}, без ${alien}, с подстановками ${withVars}`);
    same(own, marked, "lineItem: знак получили ровно реплики с пометками");
    // {n} в пометке «счёт» и число 7: подставлено и оживает; значение со скобками — пометкой не становится
    {
      const v = { m: "excited", t: "Уже [счёт]{n}[/] дней, {what}!" };
      const r = one("habitsSalute", v, { n: 12, what: "неделя [подряд]" });
      same([r.m, r.t], ["excited", OWN + "Уже [счёт]12[/] дней, неделя подряд!"], "lineItem: {n} подставлен, скобки из значения убраны");
      const plainV = { t: "Осталось {n}: {what}" };
      same(one("habitsSalute", plainV, { n: 3, what: "«[счёт] за свет»" }), { m: "neutral", t: "Осталось 3: «[счёт] за свет»" }, "lineItem: реплика без пометок — значение со скобками как есть, знака нет, эмоция neutral");
      same(one("habitsSalute", { t: "[крик]{a}[/] и {b}" }, { a: "[золото]раз[/]", b: "[/][маркер]" }).t, OWN + "[крик]золотораз/[/] и /маркер", "lineItem: чужая пометка в значении разбирается на буквы без скобок");
      same(L.lineItem("нет такого ключа"), { t: "", m: "neutral" }, "lineItem: неизвестный ключ");
      const real = L.lineItem("allDone");
      check(L.LINES.allDone.some((q) => (q.t.includes("[/]") ? OWN : "") + q.t === real.t), `lineItem («allDone») вернул не реплику из списка: «${real.t}»`);
      check(typeof L.line("allDone") === "string" && L.line("нет такого ключа") === "", "line(key) — текст реплики");
    }
  }
  errors.length = 0; timers = []; clock = 0;
}

console.log(`${n - bad}/${n}`);
process.exit(bad ? 1 : 0);
