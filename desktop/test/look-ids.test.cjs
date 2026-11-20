// «Перекрасить Рину» — один список цветов на всех (только чтение, без браузера и Python): таблица сайта LOOK_HAIR / LOOK_EYES
// в web/src/screens/MaidSettings.tsx = LOOK_HAIR / LOOK_EYES в desktop/renderer/look.js (id, порядок, названия, образцы);
// картинки web/public/maid/look/<анимация>-<волосы>-<глаза>.webp — на каждое сочетание, WebP нужного размера, и сделаны
// по нынешним анимациям, маскам и LOOK_VERSION (sources.json от tools/maid-look/make_previews.py); перечисления
// maid_hair / maid_eyes на сервере (z.enum в server/src) — те же id, если сервер их уже знает (поля нет вовсе — пропуск с
// пометкой; поле есть, а перечисление не нашлось — ошибка).
// Запуск: node desktop/test/look-ids.test.cjs — печатает «прошло/всего», при ошибке выход 1.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const repo = path.join(__dirname, "..", "..");
const rel = (...p) => path.join(repo, ...p);
const read = (...p) => fs.readFileSync(rel(...p), "utf8");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// --- look.js: чистая часть до метки «браузер», как в look.test.cjs ---
const src = read("desktop", "renderer", "look.js");
const MARK = "// --- браузер ---";
check(src.includes(MARK), "в look.js нет метки «// --- браузер ---»");
const ctx = vm.createContext({});
vm.runInContext(src.slice(0, src.indexOf(MARK)) + "\nthis.LOOK_HAIR = LOOK_HAIR; this.LOOK_EYES = LOOK_EYES; this.LOOK_VERSION = LOOK_VERSION;", ctx);
const desk = {
  hair: ctx.LOOK_HAIR.map(({ id, name, swatch }) => ({ id, name, swatch })),
  eyes: ctx.LOOK_EYES.map(({ id, name, swatch }) => ({ id, name, swatch })),
};

// --- таблица сайта: const LOOK_HAIR = [ { id: "…", name: "…", swatch: "#……" }, … ]; ---
const page = read("web", "src", "screens", "MaidSettings.tsx");
const webTable = (name) => {
  const m = page.match(new RegExp(`^const ${name} = \\[([\\s\\S]*?)^\\];`, "m"));
  if (!m) return null;
  return [...m[1].matchAll(/\{\s*id:\s*"([^"]+)",\s*name:\s*"([^"]+)",\s*swatch:\s*"([^"]+)"\s*\}/g)].map((x) => ({ id: x[1], name: x[2], swatch: x[3] }));
};
const web = { hair: webTable("LOOK_HAIR"), eyes: webTable("LOOK_EYES") };
for (const [k, label] of [["hair", "LOOK_HAIR"], ["eyes", "LOOK_EYES"]]) {
  const w = web[k], d = desk[k];
  check(w && w.length > 0, `MaidSettings.tsx: не нашлась таблица ${label} (const ${label} = [ { id, name, swatch }, … ];)`);
  if (!w) continue;
  check(same(w.map((o) => o.id), d.map((o) => o.id)), `${label}: id или порядок на сайте ${w.map((o) => o.id)} ≠ look.js ${d.map((o) => o.id)}`);
  check(same(w.map((o) => o.name), d.map((o) => o.name)), `${label}: названия на сайте ≠ look.js`);
  check(same(w.map((o) => o.swatch.toLowerCase()), d.map((o) => o.swatch.toLowerCase())), `${label}: образцы на сайте ≠ look.js`);
}
check(desk.hair[0]?.id === "red" && desk.eyes[0]?.id === "violet", "свои цвета (red, violet) должны быть первыми — сайт берёт первый, если поля нет");
check(/\/maid\/look\/hello-\$\{hair\}-\$\{eyes\}\.webp/.test(page), "MaidSettings.tsx: картинки ждём по адресу /maid/look/hello-${hair}-${eyes}.webp");

// --- картинки web/public/maid/look ---
const lookDir = rel("web", "public", "maid", "look");
let man = null;
try {
  man = JSON.parse(fs.readFileSync(path.join(lookDir, "sources.json"), "utf8"));
} catch (e) {
  check(false, `web/public/maid/look/sources.json не читается (${e.message}) — запусти python tools/maid-look/make_previews.py`);
}
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
// Размер картинки WebP из заголовка: VP8X (холст), VP8L или VP8.
const webpSize = (b) => {
  if (b.length < 30 || b.toString("latin1", 0, 4) !== "RIFF" || b.toString("latin1", 8, 12) !== "WEBP") return null;
  const t = b.toString("latin1", 12, 16), d = 20;
  if (t === "VP8X") return [b.readUIntLE(d + 4, 3) + 1, b.readUIntLE(d + 7, 3) + 1];
  if (t === "VP8L") { const v = b.readUInt32LE(d + 1); return [(v & 0x3fff) + 1, ((v >>> 14) & 0x3fff) + 1]; }
  if (t === "VP8 ") return [b.readUInt16LE(d + 6) & 0x3fff, b.readUInt16LE(d + 8) & 0x3fff];
  return null;
};
if (man) {
  check(man.version === ctx.LOOK_VERSION, `картинки сделаны для LOOK_VERSION ${man.version}, в look.js ${ctx.LOOK_VERSION} — перезапусти make_previews.py`);
  const anims = Object.keys(man.files || {}).map((f) => f.replace(/\.webp$/, ""));
  check(anims.includes("hello"), "в sources.json нет hello — её картинки показывает страница «Горничная»");
  const want = new Set(["sources.json"]);
  for (const a of anims) {
    const f = man.files[a + ".webp"];
    check(f.src === sha(rel("desktop", "assets", "maid", a + ".webp")), `${a}.webp перерисована после картинок — перезапусти make_previews.py`);
    check(f.keep === sha(rel("desktop", "assets", "maid-keep", a + ".webp")), `маска ${a}.webp пересобрана после картинок — перезапусти make_previews.py`);
    let missing = 0, wrong = 0;
    for (const h of desk.hair) {
      for (const e of desk.eyes) {
        const name = `${a}-${h.id}-${e.id}.webp`;
        want.add(name);
        const p = path.join(lookDir, name);
        if (!fs.existsSync(p)) { missing++; console.log("  нет", name); continue; }
        if (!same(webpSize(fs.readFileSync(p)), man.size)) { wrong++; console.log("  не тот размер", name); }
      }
    }
    check(missing === 0, `${a}: нет ${missing} картинок из ${desk.hair.length * desk.eyes.length}`);
    check(wrong === 0, `${a}: ${wrong} картинок не WebP ${man.size?.join("×")}`);
  }
  const extra = fs.readdirSync(lookDir).filter((f) => !want.has(f));
  check(extra.length === 0, `лишние файлы в web/public/maid/look (цвета нет в look.js?): ${extra.join(", ")}`);
}

// --- сервер: maid_hair / maid_eyes ---
// Поля нет нигде в server/src — сервер его ещё не знает: пропуск с пометкой. Поле есть — у него должен найтись z.enum:
// прямо в схеме (maid_hair: z.enum([...]) или z.enum(ИМЯ)) или через константу-схему, как ShelfKey в api.ts
// (maid_hair: ИМЯ.optional(), const ИМЯ = z.enum(...)), а список — [...] на месте или const ИМЯ = [...] (as … — можно).
// Не нашёлся или не разбирается — FAIL, а не пропуск: иначе неполное перечисление сервера прошло бы молча.
const serverDir = rel("server", "src");
const tsFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap((d) => (d.isDirectory() ? tsFiles(path.join(dir, d.name)) : d.name.endsWith(".ts") ? [path.join(dir, d.name)] : []));
const server = tsFiles(serverDir).map((f) => fs.readFileSync(f, "utf8")).join("\n");
const noComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
// Выражение с позиции i до «,», «;» или конца строки снаружи скобок либо до лишней закрывающей скобки; строки,
// комментарии и вложенные скобки — целиком.
const exprAt = (s, i) => {
  let depth = 0, j = i;
  for (; j < s.length; j++) {
    const c = s[j];
    if (c === "/" && s[j + 1] === "/") { const e = s.indexOf("\n", j); j = (e < 0 ? s.length : e) - 1; continue; }
    if (c === "/" && s[j + 1] === "*") { const e = s.indexOf("*/", j + 2); j = (e < 0 ? s.length : e + 2) - 1; continue; }
    if (c === '"' || c === "'" || c === "`") { for (j++; j < s.length && s[j] !== c; j++) if (s[j] === "\\") j++; continue; }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) { if (depth === 0) break; depth--; }
    else if (depth === 0 && (c === "," || c === ";" || c === "\n")) break;
  }
  return noComments(s.slice(i, j)).trim();
};
// Определение const/let/var ИМЯ = … (первое в server/src) или null.
const constOf = (id) => {
  const m = new RegExp(`\\b(?:const|let|var)\\s+${id.replace(/\$/g, "\\$")}\\b\\s*(?::[^=\\n]+)?=\\s*`).exec(server);
  return m ? exprAt(server, m.index + m[0].length) : null;
};
// Список строк: ["a", "b"] (as const / as […] — можно) или ИМЯ такого списка; не только строки — undefined.
const listOf = (expr, seen = new Set()) => {
  const e = expr.replace(/\s+as\s+[\s\S]*$/, "").trim();
  if (e.startsWith("[") && e.endsWith("]")) {
    const body = e.slice(1, -1), str = /(["'`])((?:\\.|(?!\1).)*)\1/g;
    return body.replace(str, "").replace(/[\s,]/g, "") === "" ? [...body.matchAll(str)].map((x) => x[2]) : undefined;
  }
  if (!/^[A-Za-z_$][\w$]*$/.test(e) || seen.has(e)) return undefined;
  seen.add(e);
  const d = constOf(e);
  return d === null ? undefined : listOf(d, seen);
};
// Что стоит после «maid_hair:». z.enum(…) → список значений; z.optional/nullable(…) — внутрь; другая z.… → "не enum";
// ИМЯ или ИМЯ.optional() / .default(…) и т. п. → его определение; остальное (тип TS, значение, чтение поля) — null, не схема.
const ZOD_WRAP = "optional|nullable|nullish|default|catch|describe";
const enumOf = (expr, seen = new Set()) => {
  const z = /^z\s*\.\s*(\w+)\s*\(/.exec(expr);
  if (z) {
    if (z[1] === "enum") return listOf(exprAt(expr, z[0].length));
    return ["optional", "nullable", "nullish"].includes(z[1]) ? enumOf(exprAt(expr, z[0].length), seen) : "не enum";
  }
  const m = new RegExp(`^([A-Za-z_$][\\w$]*)(?:\\s*\\.\\s*(?:${ZOD_WRAP})\\s*\\([^()]*\\))*$`).exec(expr);
  if (!m || seen.has(m[1])) return null;
  seen.add(m[1]);
  const d = constOf(m[1]);
  return d === null ? null : enumOf(d, seen);
};
for (const [field, k] of [["maid_hair", "hair"], ["maid_eyes", "eyes"]]) {
  if (!new RegExp(`\\b${field}\\b`).test(server)) { console.log(`пропуск: в server/src ещё нет ${field} — сверю, когда сервер его получит`); continue; }
  const found = [...server.matchAll(new RegExp(`["']?\\b${field}["']?\\s*\\??\\s*:\\s*`, "g"))]
    .map((m) => enumOf(exprAt(server, m.index + m[0].length))).filter((r) => r !== null);
  const lists = found.filter(Array.isArray);
  check(found.length > 0, `${field} есть в server/src, но его z.enum не нашёлся (ждём ${field}: z.enum([...]) или ${field}: ИМЯ.optional(), где const ИМЯ = z.enum(...))`);
  check(found.every((r) => r !== "не enum"), `${field}: на сервере схема не z.enum — по контракту только id из look.js`);
  check(found.every((r) => r !== undefined), `${field}: z.enum есть, но список его значений не разобрался (нужен ["…", …] или const ИМЯ = ["…", …])`);
  for (const ids of lists) check(same([...ids].sort(), desk[k].map((o) => o.id).sort()), `${field}: на сервере ${ids}, в look.js ${desk[k].map((o) => o.id)}`);
}

console.log(`look-ids: ${n - bad}/${n}`);
process.exit(bad ? 1 : 0);
