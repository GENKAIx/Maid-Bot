// Карточки записей в облачке ответа (widget.js, KIND и sectionOf) — по видам, которые шлёт сервер (server/src/pipeline.ts, Change.kind).
// 19.11.2026: заметку («запиши в заметки …») сервер присылает видом "note", а в KIND его не было — карточка выходила
// «• note Название», щелчок вёл на главную, а не в «Заметки». Теперь у каждого вида с сервера есть значок и название.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const root = path.join(__dirname, "..");
const widget = fs.readFileSync(path.join(root, "renderer", "widget.js"), "utf8");
const pipeline = fs.readFileSync(path.join(root, "..", "server", "src", "pipeline.ts"), "utf8");

const union = pipeline.match(/kind:\s*((?:"[a-z]+"\s*\|\s*)+"[a-z]+")\s*;/)?.[1];
check(union, "в pipeline.ts не нашёлся список видов записей (kind: \"…\" | …)");
const kinds = [...(union ?? "").matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
check(kinds.includes("note"), "сервер больше не шлёт заметки — проверку надо поправить");

const ctx = {};
vm.createContext(ctx);
try {
  vm.runInContext(`${widget.match(/\nconst KIND = \{[^]*?\n\};/)?.[0] ?? ""}\n${widget.match(/\nfunction sectionOf\([^]*?\n\}/)?.[0] ?? ""}\nthis.KIND = KIND; this.sectionOf = sectionOf;`, ctx);
} catch (e) {
  check(false, `KIND или sectionOf не разобрались: ${e?.message ?? e}`);
}
for (const k of kinds) {
  const v = ctx.KIND?.[k];
  check(Array.isArray(v) && v[0] && v[1], `у вида «${k}» нет значка и названия — карточка выйдет «• ${k} …»`);
}
check(ctx.sectionOf?.({ kind: "note", title: "Идеи подарков" }, "2026-11-19") === "/notes", "карточка заметки не ведёт в «Заметки»");

console.log(`${n - bad}/${n}`);
process.exit(bad ? 1 : 0);
