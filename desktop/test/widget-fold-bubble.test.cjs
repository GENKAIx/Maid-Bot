// Свернули виджет — облачко закрывается (24.11.2026; widget.js foldAnimated). Было: список напоминаний оставался висеть рядом
// со свёрнутой карточкой. Непрочитанное не теряется — облачко просто закрыто, значки остаются. Разворот облачко не трогает.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const widget = fs.readFileSync(path.join(__dirname, "..", "renderer", "widget.js"), "utf8").replace(/\r\n/g, "\n");
const src = widget.match(/\nfunction foldAnimated\(on\) \{[^]*?\n\}/)?.[0];
check(src, "нет foldAnimated");

const calls = [];
let hidden = false;
const ctx = {
  collapsed: false, folding: null,
  $: (q) => (q === "#bubble" ? { classList: { contains: (c) => c === "hidden" && hidden } } : null),
  hideBubble: () => { calls.push("hide"); hidden = true; },
  setCollapsed: (on) => { calls.push(`collapse:${on}`); ctx.collapsed = on; },
  matchMedia: () => ({ matches: true }), // уменьшенное движение — без анимации, сразу setCollapsed
};
vm.createContext(ctx);
vm.runInContext(`${src}\nthis.fold = foldAnimated;`, ctx);

// Облачко открыто — свернули: закрылось до сворачивания.
ctx.fold(true);
check(calls.join() === "hide,collapse:true", `свернули с облачком: ${calls}`);

// Развернули — облачко не трогается.
calls.length = 0; hidden = false;
ctx.fold(false);
check(calls.join() === "collapse:false", `развернули: ${calls}`);

// Облачко уже закрыто — второй раз не закрывается (без лишнего выхода bubblefx).
calls.length = 0; hidden = true;
ctx.fold(true);
check(calls.join() === "collapse:true", `облачко закрыто: ${calls}`);

// Уже свёрнуто — ничего.
calls.length = 0; hidden = false;
ctx.fold(true);
check(!calls.length, `уже свёрнуто: ${calls}`);

// hideBubble не отмечает прочитанным — непрочитанное остаётся в значках.
const hide = widget.match(/\nfunction hideBubble\(\) \{[^]*?\n\}/)?.[0] ?? "";
check(hide && !/inboxRead/.test(hide), "закрытие облачка не читает оповещение");

console.log(bad ? `${bad} из ${n} не прошли` : `OK: ${n} проверок облачка при сворачивании`);
process.exit(bad ? 1 : 0);
