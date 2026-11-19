// ПКМ по плану в ленте «Дальше» (widget.js) — то же меню, что у карточки в панели планов (clock.js openPlanMenu), без Electron.
// 19.11.2026: правый щелчок работал только в панели планов и по задачам и привычкам; по строкам «Дальше» (плашка, строки ленты,
// прошедший неотмеченный план, «Дальше: …») он ничего не делал. Меню открывается и тогда, когда панель закрыта или открыта
// на другом дне, поэтому «✓ Состоялось» и «× Убрать из планов» не должны искать план только среди планов дня панели,
// а окно повтора — вставать по панели (закрытая панель — пустой прямоугольник в углу окна).
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const root = path.join(__dirname, "..");
const widget = fs.readFileSync(path.join(root, "renderer", "widget.js"), "utf8");
const clock = fs.readFileSync(path.join(root, "renderer", "clock.js"), "utf8");

// Обработчик ПКМ ленты: строки планов — меню плана; строки важных дат — нет (у них своё место — панель дня).
const menu = widget.match(/\$\("#next"\)\.addEventListener\("contextmenu"[^]*?\n\}\);/)?.[0] ?? "";
check(menu, "у ленты «Дальше» нет обработчика правого щелчка");
check(/openPlanMenu\(/.test(menu), "ПКМ в ленте не открывает меню плана");
check(/preventDefault\(\)/.test(menu), "ПКМ в ленте не гасит системное меню");
check(/dataset\.date/.test(menu), "ПКМ по важной дате в ленте ищет план");
check(/data\.upcoming/.test(menu), "ПКМ не находит планы следующего дня (они в ленте из upcoming)");

// «✓ Состоялось» / «× Убрать» из меню: план не с дня панели — всё равно уходит на сервер.
const setSrc = clock.match(/\nasync function setPlanStatus\([^]*?\n\}/)?.[0];
check(setSrc, "в clock.js нет setPlanStatus");
check(/setPlanStatus\(e\.id, act, e\)/.test(clock.match(/\nfunction openPlanMenu\([^]*?\n\}/)?.[0] ?? ""), "меню плана не передаёт сам план в setPlanStatus");
(async () => {
  try {
    const calls = [];
    const ctx = {
      clockDay: "2026-11-25", // панель открыта на другом дне (или не открывалась — тогда null)
      plansOf: () => [], planDone: new Map(), doneTimers: new Map(), planCountdown() {}, lastPlans: null, drawClock() {},
      farPlans: new Map(), load: async () => {}, react() {}, say(t) { calls.push(["say", t]); }, clearTimeout() {},
      maid: { api: async (m, url, body) => { calls.push([m, url, body]); return {}; } },
    };
    vm.createContext(ctx);
    vm.runInContext(`${setSrc ?? ""}\nthis.f = setPlanStatus;`, ctx);
    await ctx.f(99, "done", { id: 99, title: "Продать акции", date_iso: "2026-11-19", time: "18:34", status: "active" });
    check(calls.some((c) => c[0] === "POST" && c[1] === "/api/events/99" && c[2]?.status === "done"), `план не с дня панели не отмечен: ${JSON.stringify(calls)}`);
    calls.length = 0;
    await ctx.f(98, "cancelled");
    check(!calls.length, "без плана setPlanStatus всё равно что-то шлёт");
  } catch (e) {
    check(false, `setPlanStatus оборвался: ${e?.stack ?? e}`);
  }

  // Окно повтора при закрытой панели — у ленты, а не в углу окна.
  const rep = clock.match(/\nfunction openRepeat\([^]*?\n\}/)?.[0] ?? "";
  check(/classList\.contains\("hidden"\)\s*\?\s*\$\("#next"\)/.test(rep), "окно повтора встаёт по закрытой панели (в угол окна)");

  console.log(`${n - bad}/${n}`);
  process.exit(bad ? 1 : 0);
})();
