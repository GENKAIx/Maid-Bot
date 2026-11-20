// Обращение в репликах виджета (lines.js: setLineCall, lineCallIn; widget.js ставит его из /api/today.call), 20.11.2026:
// в «Персонализации → О вас» выбрали «хозяйка» или по имени — в готовых репликах вместо «хозяин» звучит выбранное,
// заглавная остаётся заглавной, другие падежи не трогаются; без выбора (или старый сервер без call) — «хозяин», как было.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const dir = path.join(__dirname, "..", "renderer");
const lines = fs.readFileSync(path.join(dir, "lines.js"), "utf8");
const widget = fs.readFileSync(path.join(dir, "widget.js"), "utf8");

const ctx = { localStorage: { getItem: () => null, setItem() {} }, Math, Date, JSON, WORDFX_OWN: "\u2063" };
vm.createContext(ctx);
vm.runInContext(`${lines}\nthis.L = LINES; this.set = setLineCall; this.callIn = lineCallIn; this.item = lineItem;`, ctx);

check(ctx.callIn("Доброе утро, хозяин!") === "Доброе утро, хозяин!", "по умолчанию — «хозяин»");
ctx.set("хозяйка");
check(ctx.callIn("Доброе утро, хозяин!") === "Доброе утро, хозяйка!", "хозяйка в середине");
check(ctx.callIn("Хозяин! Руки!") === "Хозяйка! Руки!", "заглавная в начале");
ctx.set("Андрей");
check(ctx.callIn("Хозяин, я же тут") === "Андрей, я же тут", "имя в начале");
check(ctx.callIn("Спасибо, хозяин") === "Спасибо, Андрей", "имя в конце");
check(ctx.callIn("дом хозяина") === "дом хозяина", "другие падежи не трогаем");
// Реплика целиком: все варианты с «хозяин» из LINES проходят через подстановку.
const withWord = Object.entries(ctx.L).flatMap(([k, vs]) => vs.filter((v) => /[Хх]озяин(?![а-яё])/.test(v.t)).map((v) => [k, v]));
check(withWord.length >= 15, `реплик с «хозяин» мало: ${withWord.length}`);
const [key, only] = withWord.find(([k]) => ctx.L[k].length > 0);
ctx.L[key] = [only]; // один вариант — lineItem возьмёт именно его
const got = ctx.item(key).t;
check(!/[Хх]озяин(?![а-яё])/.test(got) && got.includes("Андрей"), `в реплике «${key}» осталось «хозяин»: ${got}`);
ctx.set(undefined);
check(ctx.callIn("Есть, хозяин!") === "Есть, хозяин!", "старый сервер без call — как было");
check(ctx.callIn("Есть, хозяин!") === "Есть, хозяин!" && (ctx.set(""), ctx.callIn("Хозяин!") === "Хозяин!"), "пустое слово — «хозяин»");

// widget.js берёт обращение из данных дня на каждом опросе.
check(/setLineCall\(data\.call\)/.test(widget), "widget.js не передаёт data.call в setLineCall");

console.log(bad ? `${bad} из ${n} проверок не прошли` : `OK: ${n} проверок обращения`);
process.exit(bad ? 1 : 0);
