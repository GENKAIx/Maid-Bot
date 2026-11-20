// Подъём и отбой виджета — с сервера (20.11.2026; widget.js: daySleepSync, sleepMove, bedtime, afterBedtime). Раньше это были
// «Утро» и «Отбой» в настройках виджета на каждом ПК; теперь — «Персонализация → О вас», /api/today отдаёт wake и bed.
// Прежний свой выбор этого ПК переезжает на сервер один раз, если там ещё по умолчанию; в настройках виджета этих строк нет.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const root = path.join(__dirname, "..", "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const widget = read("desktop/renderer/widget.js"), main = read("desktop/src/main.js"), site = read("web/src/screens/Widget.tsx");
const fn = (name) => { const s = widget.match(new RegExp(String.raw`\nfunction ${name}\([^]*?\n\}`))?.[0]; check(s, `нет ${name} в widget.js`); return s ?? ""; };
const decl = (re, what) => { const s = widget.match(re)?.[0]; check(s, `нет ${what}`); return s ?? ""; };

const store = {};
const posted = [];
const ctx = {
  localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } },
  maid: { api: async (m, p, b) => { posted.push([m, p, b]); return {}; } },
};
vm.createContext(ctx);
vm.runInContext([
  decl(/\nconst nightMin = .*/, "nightMin"), decl(/\nlet daySleep = .*/, "daySleep"), decl(/\nlet oldSleep = .*/, "oldSleep"),
  fn("daySleepSync"), fn("sleepMove"), fn("bedtime"), fn("afterBedtime"),
  "this.sync = daySleepSync; this.after = afterBedtime; this.get = () => daySleep; this.old = (x) => { oldSleep = x; };",
].join("\n"), ctx);

const at = (h, m = 0) => new Date(2026, 10, 20, h, m);
(async () => {
  // Сервер без подъёма и отбоя (старый) — 7:00 и «сама», ничего не шлём.
  ctx.old({ bed: "23:00", wake: 8 });
  ctx.sync({});
  check(ctx.get().wake === 7 && ctx.get().bed === "auto", "старый сервер — 7:00 и «сама»");
  check(!posted.length && !store["maid.sleepMoved"], "старому серверу перенос не шлём");

  // Новый сервер с умолчаниями, на ПК было своё — один раз уходит на сервер.
  ctx.sync({ wake: 7, bed: "auto" });
  await new Promise((r) => setTimeout(r, 0));
  check(JSON.stringify(posted[0]) === JSON.stringify(["POST", "/api/you", { bed: "23:00", wake: 8 }]), `перенос: ${JSON.stringify(posted[0])}`);
  check(store["maid.sleepMoved"] === "1", "перенос отмечен");
  ctx.old({ bed: "22:00", wake: 6 });
  ctx.sync({ wake: 7, bed: "auto" });
  check(posted.length === 1, "второй раз не переносим");

  // На сервере уже своё — его и берём; ночь считается по нему.
  ctx.sync({ wake: 9, bed: "00:30" });
  check(ctx.get().wake === 9 && ctx.get().bed === "00:30", "подъём и отбой с сервера");
  check(!ctx.after(at(23, 59)) && ctx.after(at(0, 40)) && ctx.after(at(8, 59)) && !ctx.after(at(9, 0)), "ночь — от отбоя 00:30 до подъёма 9:00");
  ctx.sync({ wake: 7, bed: "лишнее" });
  check(ctx.get().bed === "auto", "странный отбой — «сама»");

  // Настроек «Утро» и «Отбой» у виджета больше нет: ни в main.js, ни на сайте; на сайте — ссылка в «Персонализацию».
  check(!/\bbedtime: oneOf|\bmorning: oneOf/.test(main), "main.js ещё принимает bedtime/morning");
  check(!/title="Утро"|title="Отбой"/.test(site) && /navigate\("\/settings\/persona"\)/.test(site), "в настройках виджета на сайте остались «Утро»/«Отбой» или нет ссылки");
  check(/daySleepSync\(data\)/.test(widget) && !/cfg\.(morning|bedtime)/.test(widget), "widget.js не берёт подъём и отбой из данных дня");

  console.log(bad ? `${bad} из ${n} проверок не прошли` : `OK: ${n} проверок подъёма и отбоя`);
  process.exit(bad ? 1 : 0);
})();
