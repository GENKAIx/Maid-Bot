// Облачко-актёр, значки у головы, правила вкуса и походка букв (renderer/bubblefx.js + bubblefx.css, style.css, с 20.11.2026)
// без Electron и браузера. bubblefx.js грузится в vm с заглушками; planType вырезается из widget.js и режет текст в маленьком DOM;
// остальное (порядок вызовов в say / hideBubble, настройка «Эффекты», подключение файлов) — проверка по тексту.
// Как это выглядит и движется — смотреть на стенде (test/stress/serve.cjs) в браузере.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const same = (a, b, m) => check(JSON.stringify(a) === JSON.stringify(b), `${m}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
const src = read("renderer/bubblefx.js"), css = read("renderer/bubblefx.css"), style = read("renderer/style.css");
const widget = read("renderer/widget.js"), html = read("renderer/widget.html"), main = read("src/main.js");
const tsx = read("../web/src/screens/Widget.tsx"), personas = read("../server/src/personas.ts");

// --- (1) bubblefx.js в vm: правила вкуса и выбор превращения ---
const stage = { classes: new Set() };
const ctx = {
  cfg: { fx: "normal" }, collapsed: false, reduce: false,
  $: (s) => (s === "#stage" ? { classList: { contains: (c) => stage.classes.has(c) } } : null),
  wordfxTone: () => {}, wordfxNoise: () => {}, wordfxJolt: () => {}, react: () => {},
  setTimeout: () => 0, clearTimeout: () => {}, document: {},
};
ctx.matchMedia = () => ({ matches: ctx.reduce });
vm.createContext(ctx);
try {
  vm.runInContext(src + "\nthis.api = { bubblefxAllow, bubblefxUsed, bubblefxPick, bubblefxLevel, BUBBLEFX_SERIOUS, BUBBLEFX_KINDS, BUBBLEFX_MARK };", ctx);
} catch (e) {
  check(false, `bubblefx.js не разобрался: ${e?.message ?? e}`);
}
const A = ctx.api;
if (A) {
  // «1 из 3»: после эффекта две реплики ровные, третья снова может быть с эффектом
  ctx.cfg.fx = "normal";
  check(A.bubblefxAllow("Привет") === true, "первая реплика: эффект можно");
  A.bubblefxUsed();
  same([A.bubblefxAllow("раз"), A.bubblefxAllow("два"), A.bubblefxAllow("три")], [false, false, true], "после эффекта: две ровные, третья — можно");
  A.bubblefxUsed();
  // реплика без эффекта тоже считается
  same([A.bubblefxAllow("а"), A.bubblefxAllow("б")], [false, false], "после эффекта — снова две ровные");
  // серьёзное — всегда ровно, даже когда очередь подошла
  for (const t of ["Давление 150 на 95 — выше вашей нормы. Запишитесь к врачу.", "Не забудьте выпить таблетку", "Списали 3000 ₽ за кредит", "Зарплата пришла", "Штраф за парковку", "Болит голова?"]) {
    ctx.cfg.fx = "festive";
    check(A.bubblefxAllow(t) === false, `серьёзное с эффектом: «${t}»`);
  }
  for (const t of ["Сегодня всё получается!", "Отчёт сдан, хозяин", "Ни одного хвоста на сегодня"]) check(!A.BUBBLEFX_SERIOUS.test(t), `обычное посчитано серьёзным: «${t}»`);
  // настройка: тихо — никогда, празднично — каждый раз
  ctx.cfg.fx = "quiet";
  A.bubblefxAllow("x"); A.bubblefxAllow("x"); A.bubblefxAllow("x");
  check(A.bubblefxAllow("Привет") === false, "«тихо»: эффект всё равно разрешён");
  ctx.cfg.fx = "festive";
  A.bubblefxUsed();
  check(A.bubblefxAllow("Привет") === true, "«празднично»: правило «1 из 3» не снято");
  ctx.cfg.fx = "что-то";
  check(A.bubblefxLevel() === "normal", "незнакомое значение настройки — не «обычно»");
  ctx.cfg.fx = "normal";

  // выбор превращения
  const pick = (o) => A.bubblefxPick(o);
  same([pick({ emotion: "sad", plain: "Денёк так себе" }), pick({ emotion: "sleepy", plain: "Мне же совсем нечем заняться." }), pick({ emotion: "proud", plain: "Отличный день, правда?" })], ["melt", "deflate", "bloom"], "грусть — тает, усталость — сдувается, гордость — цветы");
  same([pick({ emotion: "happy", heard: "Спасибо!", plain: "Рада стараться!" }), pick({ emotion: "neutral", heard: "благодарю", plain: "Всегда пожалуйста" })], ["heart", "heart"], "«спасибо» — сердце");
  check(pick({ emotion: "happy", heard: "спасибо", plain: "а".repeat(60) }) === null, "сердце с длинным текстом (в сердце не влезет)");
  same([pick({ emotion: "surprised", plain: "Сорок задач на завтра?!" }), pick({ emotion: "surprised", plain: "Ого, семь дел!" })], ["fall", null], "удивление с «?!» — падает за панель, без «?!» — нет");
  ctx.collapsed = true;
  check(pick({ emotion: "surprised", plain: "Сорок задач?!" }) === null, "свёрнутая панель: падение за панель всё равно выбрано");
  ctx.collapsed = false;
  stage.classes.add("no-maid");
  check(pick({ emotion: "surprised", plain: "Сорок задач?!" }) === null, "горничная спрятана: падение всё равно выбрано");
  stage.classes.clear();
  same([pick({ emotion: "neutral", plain: "Записала." }), pick({ emotion: "sad", plain: "x", weighty: true }), pick({ emotion: "sad", plain: "а".repeat(91) })], [null, null, null], "спокойно / с карточками / длинное — без превращения");
  ctx.reduce = true;
  check(pick({ emotion: "sad", plain: "Грустно" }) === null, "«меньше движения»: превращение всё равно выбрано");
  ctx.reduce = false;
  // у каждого превращения со своим уходом — функция ухода; у падения ухода нет (облачко не трогает)
  for (const k of ["melt", "deflate", "heart", "bloom"]) check(typeof A.BUBBLEFX_KINDS[k] === "function" && typeof A.BUBBLEFX_KINDS[k + "Exit"] === "function", `превращение ${k}: нет начала или ухода`);
  check(typeof A.BUBBLEFX_KINDS.fall === "function" && !A.BUBBLEFX_KINDS.fallExit, "падение за панель: нет функции или лишний уход");
  check(A.BUBBLEFX_MARK.gloom && A.BUBBLEFX_MARK.drop, "значки: нет линий уныния или капли");
}

// --- (2) CSP и вид: в разметке из bubblefx.js нет атрибута style (style-src 'self'); классы из js есть в css ---
check(!/style="/.test(src), "bubblefx.js: в разметке атрибут style= (CSP его не пропустит)");
const used = new Set([...src.matchAll(/["'` ]((?:bfx|k)-[a-z][a-z-]*)/g)].map((m) => m[1]).filter((c) => !c.endsWith("-")));
for (const c of ["bfx-goo", "bfx-defs", "bfx-mk", "bfx-on-", "bfx-mk-"]) used.delete(c);
for (const c of used) check(new RegExp(`\\.${c}\\b`).test(css) || c === "bfx-vinebox", `класс ${c} из bubblefx.js не описан в bubblefx.css`);
for (const c of ["bfx-mk-gloom", "bfx-mk-drop", "bfx-on-gloom", "bfx-pale", "k-melt", "k-flat", "k-heart", "bfx-ghost", "bfx-gone"]) check(css.includes("." + c), `в bubblefx.css нет .${c}`);
check(/prefers-reduced-motion/.test(css), "bubblefx.css: нет правила для «меньше движения»");

// --- (3) подключение: css и js в widget.html, js — после wordfx.js (его звуки) и до widget.js ---
const pos = (f) => html.indexOf(`src="${f}"`);
check(html.includes('href="bubblefx.css"'), "widget.html: не подключён bubblefx.css");
check(pos("bubblefx.js") > pos("wordfx.js") && pos("wordfx.js") > 0 && pos("bubblefx.js") < pos("widget.js"), "widget.html: bubblefx.js не между wordfx.js и widget.js");

// --- (4) widget.js: где зовётся ---
const sayAt = widget.indexOf("function say("), sayEnd = widget.indexOf("\nfunction ", sayAt + 1), say = widget.slice(sayAt, sayEnd);
const count = (s, re) => (s.match(re) || []).length;
same([count(widget, /bubblefxAllow\(/g), count(say, /bubblefxAllow\(/g)], [1, 1], "bubblefxAllow зовётся один раз, в say");
check(/const fxAllow = text !== "…" && bubblefxAllow\(plain\);/.test(say), "say: правила вкуса считают и «…» (думает)");
check(/const fxOn = fxAllow && /.test(say), "say: слова с характером идут мимо правил вкуса");
check(say.indexOf("bubblefxStop()") > 0 && say.indexOf("bubblefxStop()") < say.indexOf("innerHTML"), "say: прошлое превращение не снимается до нового текста");
check(/bubblefxPick\(\{ emotion, heard, plain, weighty \}\)/.test(say) && say.indexOf("bubblefxPick") > say.indexOf("const weighty"), "say: превращение выбирается не по weighty");
check(/\$\("#bubbleText"\)\.dataset\.fx !== "1" \? bubblefxPick/.test(say), "say: превращение и слова с характером могут сыграть вместе");
check(/if \(bx \|\| \$\("#bubbleText"\)\.dataset\.fx === "1"\) bubblefxUsed\(\);/.test(say), "say: показанный эффект не отмечается (правило «1 из 3»)");
check(/typing\.then = \(\) => \{ then\?\.\(\); bubblefxStart\(bx\); \}/.test(say), "say: превращение не ждёт конца печати");
check(/emotion === "sad" && text !== "…"\) bubblefxMark\("gloom"/.test(say), "say: у грустной реплики нет линий уныния");
const hide = widget.slice(widget.indexOf("function hideBubble("), widget.indexOf("\nfunction ", widget.indexOf("function hideBubble(") + 1));
check(hide.indexOf("bubblefxExit()") > 0 && hide.indexOf("bubblefxExit()") < hide.indexOf('classList.add("hidden")'), "hideBubble: превращённое облачко уходит не по-своему (bubblefxExit до hidden)");

// --- (5) высота «бипа» и походка букв — у всех 11 эмоций сервера ---
const emotions = JSON.parse(personas.match(/export const EMOTIONS = (\[[^\]]+\])/)[1]);
same(emotions.length, 11, "эмоций сервера (personas.ts)");
const pitchSrc = widget.match(/const TYPE_PITCH = (\{[\s\S]*?\});/)[1], gaitSrc = widget.match(/const TYPE_GAIT = (\{[\s\S]*?\});/)[1];
const PITCH = vm.runInNewContext(`(${pitchSrc})`), GAIT = vm.runInNewContext(`(${gaitSrc})`);
for (const e of emotions) {
  check(typeof PITCH[e] === "number" && PITCH[e] > 0.5 && PITCH[e] < 1.5, `«бип»: нет высоты у эмоции ${e}`);
  check(typeof GAIT[e] === "string", `походка: нет у эмоции ${e}`);
}
same([PITCH.stern < 1, PITCH.sleepy < PITCH.sad, PITCH.surprised > PITCH.happy, PITCH.neutral], [true, true, true, 1], "«бип»: строгий ниже, сонный ниже грустного, удивлённый выше радостного");
same([...new Set(Object.values(GAIT))].sort(), ["happy", "neutral", "sad", "stern", "surprised", "teasing"], "шесть походок");
for (const g of new Set(Object.values(GAIT))) {
  check(style.includes(`#bubbleText[data-gait="${g}"] .gw > .tw.on { animation: gait-${g} `) && style.includes(`@keyframes gait-${g} `), `style.css: нет походки ${g}`);
}
check(/dataset\.gait = typed && cfg\.fx !== "quiet" \? TYPE_GAIT\[emotion\] \?\? "neutral" : ""/.test(say), "say: походка не по эмоции или не выключается настройкой «тихо»");

// --- (6) planType: при походке буквы слова лежат в .gw; пробелы, слова с характером и длинные слова — без .gw ---
function el(tag, cls = "") {
  const e = { nodeType: 1, tag, className: cls, childNodes: [], parentNode: null, textContent: "",
    classList: { contains: (c) => e.className.split(" ").includes(c) },
    appendChild(c) { if (c.frag) { for (const k of c.childNodes) { k.parentNode = e; e.childNodes.push(k); } c.childNodes = []; } else { c.parentNode = e; e.childNodes.push(c); } return c; } };
  return e;
}
function txt(data) {
  const t = { nodeType: 3, data, parentNode: null,
    replaceWith(f) { const p = t.parentNode, i = p.childNodes.indexOf(t); for (const k of f.childNodes) k.parentNode = p; p.childNodes.splice(i, 1, ...f.childNodes); } };
  return t;
}
const docStub = { createElement: (t) => el(t), createDocumentFragment: () => { const f = el("#frag"); f.frag = true; return f; } };
const from = widget.indexOf("function planType("), to = widget.indexOf("function runType(");
const pctx = { document: docStub, cfg: { typeSpeed: "normal" }, TYPE_CPS: { slow: 22, normal: 35, fast: 60 }, wordfxPrep: () => {}, wordfxStep: () => null };
vm.createContext(pctx);
vm.runInContext(widget.slice(from, to), pctx);
function box(parts) {
  const b = el("div");
  for (const p of parts) {
    if (typeof p === "string") b.appendChild(txt(p));
    else { const s = el("span", p.cls); s.appendChild(txt(p.t)); b.appendChild(s); }
  }
  return b;
}
const show = (n) => (n.nodeType === 3 ? n.data : n.className === "tw" ? n.textContent : n.className === "gw" ? `<${n.childNodes.map(show).join("")}>` : n.childNodes.map(show).join(""));
{
  const long = "https://example.com/very/long/path";
  let b = box(["Ого, семь дел до обеда?\nВот ", { cls: "fx fx-yell", t: "это" }, " утро! " + long]);
  const r = pctx.planType(b, 1, true);
  same(show(b), "<Ого,> <семь> <дел> <до> <обеда?>\n<Вот> это <утро!> " + long, "походка: слова в .gw, пробелы и перевод строки снаружи, слово с характером и ссылка — без .gw");
  same(r.chars.map((c) => c.textContent).join(""), "Ого, семь дел до обеда?\nВот это утро! " + long, "походка: буквы по порядку, ни одна не потеряна");
  b = box(["Ого, семь дел"]);
  pctx.planType(b, 1, false);
  same(show(b), "Ого, семь дел", "без походки — без .gw");
  b = box(["😀 ок"]);
  same(pctx.planType(b, 1, true).chars.length, 4, "походка: значок — одна буква");
}

// --- (7) настройка «Эффекты»: main.js пропускает, виджет читает, сайт показывает ---
check(/fx: oneOf\("quiet", "normal", "festive"\),/.test(main), "main.js: настройка fx не пропускается (WIDGET_PREFS)");
check(/fx: \["quiet", "festive"\]\.includes\(w\.fx\) \? w\.fx : "normal"/.test(widget) && /popSound: "bubble", fx: "normal" \};/.test(widget), "widget.js: настройка fx не читается или нет значения по умолчанию");
check(/fx\?: "quiet" \| "normal" \| "festive"/.test(tsx) && /xpBar: "always", fx: "normal",/.test(tsx), "Widget.tsx: нет поля fx или значения по умолчанию");
check(/<Choices label="Эффекты" value=\{p\.fx\}/.test(tsx) && /\["quiet", "Тихо", [^\]]+\], \["normal", "Обычно", [^\]]+\], \["festive", "Празднично", [^\]]+\]/.test(tsx), "Widget.tsx: нет выбора «Эффекты: тихо / обычно / празднично»");

console.log(`${n - bad}/${n}`);
process.exit(bad ? 1 : 0);
