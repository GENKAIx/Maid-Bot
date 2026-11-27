import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  bandText, cellFill, cellKind, clickMark, clockPos, daysText, dayIndexAt, dragSpan, dueFn, durText, fireTier, fixSpan, hourAt, keySpan,
  monthTally, perDayText, presetSpan, quant, rangeText, responseView, rhythmView, rinaNote, scheduleFrom, streakView, tallyYear, usualBands,
  applyRinaAct, weakDay, weekFromYear, weekView, xLabels, yearMonths, type MarkPoint,
} from "../src/habitpanel.ts";
import { cellTitle } from "../src/habitview.ts";
import type { HabitStats } from "../src/types.ts";

// Страница «Привычки» по макету «Привычки: месяц сеткой» (27.11.2026, «Сирень»): клетки ×N, отрезок графика и рамка обзора,
// серия, сутки, дни недели, год по месяцам, отклик на напоминание, ритм дня, наблюдение Рины (web/src/habitpanel.ts).

const pt = (day: string, min: number, n = 1, gap = false): MarkPoint => ({ day, min, n, gap, time: `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}` });
const add = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

test("слова: дни, длительность, огонёк серии, подпись нормы ×N", () => {
  assert.deepEqual([1, 3, 11, 22, 5].map(daysText), ["1 день", "3 дня", "11 дней", "22 дня", "5 дней"]);
  assert.deepEqual([40, 65, 120, -30].map(durText), ["40 мин", "1 ч 5 мин", "2 ч", "30 мин"]);
  assert.deepEqual([0, 6, 7, 29, 30, 99, 100, 400].map(fireTier), [0, 0, 1, 1, 2, 2, 3, 3], "до 7 — приглушённый, 7 — тёплый, 30 — синий, 100 — золотой");
  assert.equal(perDayText(1), "");
  assert.equal(perDayText(8), "8 раз в день", "единица числа из слов (стр., км) — не норма отметок");
  assert.equal(perDayText(2), "2 раза в день");
  assert.equal(perDayText(5), "5 раз в день");
});

test("клетка: состояние, заливка ×N и что шлёт щелчок", () => {
  const T = "2026-11-27", S = "2026-11-05";
  assert.equal(cellKind({ day: "2026-11-04", due: true, status: null }, T, S), "off");
  assert.equal(cellKind({ day: "2026-11-10", due: true, status: "done" }, T, S), "done");
  assert.equal(cellKind({ day: "2026-11-10", due: true, status: "skipped" }, T, S), "skip");
  assert.equal(cellKind({ day: "2026-11-10", due: true, status: null, count: 5, need: 8 }, T, S), "part");
  assert.equal(cellKind({ day: "2026-11-28", due: true, status: null }, T, S), "future");
  assert.equal(cellKind({ day: "2026-11-10", due: false, status: null }, T, S), "rest");
  assert.equal(cellKind({ day: "2026-11-10", due: true, status: null }, T, S), "empty");
  assert.equal(cellFill({ day: "", due: true, status: null, count: 5, need: 8 }), 0.625);
  assert.equal(cellFill({ day: "", due: true, status: "done", count: 8, need: 8 }), 1);
  assert.equal(cellFill({ day: "", due: true, status: "skipped", count: 0, need: 8 }), 0);
  // Обычная: пусто → сделал → пропуск → сделал; ×N: +1, на полной — пропуск, с пропуска — снова первая отметка.
  assert.deepEqual(clickMark({ status: null }), { status: "done" });
  assert.deepEqual(clickMark({ status: "done" }), { status: "skipped" });
  assert.deepEqual(clickMark({ status: "skipped" }), { status: "done" });
  assert.deepEqual(clickMark({ status: null, need: 8 }), { step: 1 });
  assert.deepEqual(clickMark({ status: "done", need: 8 }), { step: 1 }, "полный ×N щелчком не становится пропуском (стёр бы все времена)");
  assert.deepEqual(clickMark({ status: "skipped", need: 8 }), { step: 1 });
});

test("итог строки: сделано из запланированного до сегодня, сегодня — только если сделано", () => {
  const days = [
    { day: "2026-11-01", due: true, status: "done" }, { day: "2026-11-02", due: true, status: null }, { day: "2026-11-03", due: true, status: "skipped" },
    { day: "2026-11-04", due: false, status: "done" }, { day: "2026-11-05", due: true, status: null, count: 2, need: 3 }, { day: "2026-11-06", due: true, status: null },
  ];
  assert.deepEqual(monthTally(days, "2026-11-05"), { done: 2, due: 4 });
  assert.deepEqual(monthTally(days.map((x) => (x.day === "2026-11-05" ? { ...x, status: "done" } : x)), "2026-11-05"), { done: 3, due: 5 });
});

test("подсказка клетки ×N: «5 из 8 · последняя в 21:14»", () => {
  assert.equal(cellTitle({ day: "2026-11-26", due: true, status: null, count: 5, need: 8, at_time: "21:14", at_day: null }), "2026-11-26 — отмечено 5 из 8 · последняя в 21:14");
  assert.equal(cellTitle({ day: "2026-11-26", due: true, status: "done", count: 8, need: 8, at_time: "21:14", at_day: null }), "2026-11-26 — сделано 8 из 8 · последняя в 21:14");
  assert.equal(cellTitle({ day: "2026-11-25", due: true, status: null, count: 1, need: 2, at_time: "10:02", at_day: "2026-11-26" }), "2026-11-25 — отмечено 1 из 2 · отмечено 26 ноя в 10:02");
  assert.equal(cellTitle({ day: "2026-11-24", due: true, status: "skipped", count: 0, need: 8, at_time: "21:00", at_day: null }), "2026-11-24 — пропуск в 21:00");
});

test("отрезок: кнопки, не короче 3 дней, рамка тянется за края и целиком, стрелки", () => {
  assert.deepEqual(presetSpan(100, 30), { a: 70, b: 99 });
  assert.deepEqual(presetSpan(10, 30), { a: 0, b: 9 }, "привычке меньше 30 дней — весь срок");
  assert.deepEqual(presetSpan(100, 0), { a: 0, b: 99 }, "«Всё»");
  assert.deepEqual(fixSpan({ a: 5, b: 5 }, 100), { a: 5, b: 7 });
  assert.deepEqual(fixSpan({ a: 99, b: 99 }, 100), { a: 97, b: 99 });
  assert.deepEqual(fixSpan({ a: -3, b: 3 }, 100), { a: 0, b: 3 });
  assert.deepEqual(fixSpan({ a: 0, b: 5 }, 2), { a: 0, b: 1 }, "срок короче 3 дней — весь");
  assert.deepEqual([0.25, 0.999, 1.5, -1].map((f) => dayIndexAt(f, 10)), [2, 9, 9, 0]);
  const s = { a: 10, b: 20 };
  assert.deepEqual(dragSpan("l", s, 15, 25, 100), { a: 18, b: 20 }, "левый край не ближе 2 дней к правому");
  assert.deepEqual(dragSpan("l", s, 15, 5, 100), { a: 0, b: 20 });
  assert.deepEqual(dragSpan("r", s, 15, 5, 100), { a: 10, b: 12 });
  assert.deepEqual(dragSpan("r", s, 15, 200, 100), { a: 10, b: 99 });
  assert.deepEqual(dragSpan("m", s, 15, 100, 100), { a: 89, b: 99 }, "сдвиг целиком — длина та же, не за край");
  assert.deepEqual(dragSpan("m", s, 15, 0, 100), { a: 0, b: 10 });
  assert.deepEqual(dragSpan("n", s, 30, 25, 100), { a: 25, b: 30 }, "протянуть по полосе — новый отрезок");
  assert.deepEqual(keySpan({ a: 0, b: 9 }, -1, false, 100), { a: 0, b: 9 }, "у края не двигается");
  assert.deepEqual(keySpan({ a: 0, b: 9 }, 1, false, 100), { a: 1, b: 10 });
  assert.deepEqual(keySpan({ a: 5, b: 7 }, -1, true, 100), { a: 5, b: 7 }, "Shift: не короче 3 дней");
  assert.deepEqual(keySpan({ a: 5, b: 99 }, 1, true, 100), { a: 5, b: 99 });
  assert.equal(rangeText("2026-11-03", "2026-11-27", 2026), "3 — 27 ноября");
  assert.equal(rangeText("2026-10-28", "2026-11-27", 2026), "28 октября — 27 ноября");
  assert.equal(rangeText("2025-10-28", "2026-11-27", 2026), "28 октября 2025 — 27 ноября 2026");
  assert.equal(rangeText("2025-03-01", "2025-03-09", 2026), "1 — 9 марта 2025");
  assert.equal(rangeText("2026-11-27", "2026-11-27", 2026), "27 ноября");
});

test("подписи дней: короткий отрезок — даты, длинный — начала месяцев", () => {
  assert.deepEqual(xLabels("2026-10-29", 30, 300).map((l) => l.label), ["29 окт", "13 ноя", "27 ноя"]);
  assert.deepEqual(xLabels("2026-08-29", 91, 300).map((l) => [l.k, l.label]), [[3, "сен"], [33, "окт"], [64, "ноя"]]);
  assert.deepEqual(xLabels("2025-12-15", 100, 300).map((l) => l.label), ["янв 2026", "фев", "мар"], "у января — год");
  assert.deepEqual(xLabels("2026-11-27", 1, 300).map((l) => l.k), [0]);
});

test("полоса «обычно» и медианы", () => {
  assert.equal(quant([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quant([], 0.5), null);
  assert.equal(quant([10, 20, 30, 40, 50], 0.25), 20);
  const one = usualBands([pt("2026-11-01", 700), pt("2026-11-02", 720), pt("2026-11-03", 740), pt("2026-11-04", 760)], 1);
  assert.deepEqual(one, [{ lo: 715, hi: 745, med: 730, i: 0 }]);
  assert.equal(bandText(one[0]), "обычно около 12:10");
  assert.deepEqual(usualBands([pt("2026-11-01", 700)], 1), [], "одна отметка — полосы нет");
  const many = usualBands([pt("2026-11-01", 500, 1), pt("2026-11-01", 600, 2), pt("2026-11-01", 1200, 3), pt("2026-11-02", 520, 1), pt("2026-11-02", 1260, 2)], 8);
  assert.deepEqual(many, [{ lo: 510, hi: 1230, med: null, win: true }]);
  assert.equal(bandText(many[0]), "обычно с 08:30 до 20:30");
});

test("расписание по клеткам и «по расписанию ли день»", () => {
  const week = Array.from({ length: 7 }, (_, i) => ({ day: add("2026-11-23", i), due: i < 5 }));
  assert.equal(scheduleFrom(week), "12345");
  assert.equal(scheduleFrom(week.slice(0, 6)), null, "меньше недели — не знаем");
  const year: HabitStats["year"] = [{ day: "2026-11-23", s: "done" }, { day: "2026-11-24", s: "rest" }];
  const due = dueFn(year, null, "2026-11-01", null);
  assert.equal(due("2026-10-30"), false, "до начала");
  assert.equal(due("2026-11-23"), true);
  assert.equal(due("2026-11-24"), false);
  assert.equal(due("2026-12-10"), null, "дальше года и расписания нет — не знаем");
  assert.equal(dueFn(year, "12345", "2026-11-01", "2026-12-01")("2026-12-02"), false, "после конца срока");
});

test("серия: дорога к рекорду, когда побьёте, вехи", () => {
  const every = () => true;
  const v = streakView({ streak: 5, best: 10, todayOpen: false, isDue: every, today: "2026-11-27" });
  assert.equal(v.record, false);
  assert.equal(v.need, 6);
  assert.equal(v.beatOn, "2026-12-03");
  assert.equal(v.next, 7);
  assert.equal(v.toNext, 2);
  assert.equal(v.pct, 50);
  assert.deepEqual(v.milestones.map((m) => m.got), [true, false, false, false]);
  assert.equal(streakView({ streak: 5, best: 10, todayOpen: true, isDue: every, today: "2026-11-27" }).beatOn, "2026-12-02", "сегодня ещё можно отметить");
  const weekdays = (d: string) => [1, 2, 3, 4, 5].includes(new Date(Date.parse(`${d}T12:00:00Z`)).getUTCDay());
  assert.equal(streakView({ streak: 5, best: 10, todayOpen: false, isDue: weekdays, today: "2026-11-27" }).beatOn, "2026-12-07", "по будням");
  const rec = streakView({ streak: 12, best: 10, todayOpen: false, isDue: every, today: "2026-11-27" });
  assert.equal(rec.record, true);
  assert.equal(rec.best, 12);
  assert.equal(rec.next, 30);
  const zero = streakView({ streak: 0, best: 0, todayOpen: true, isDue: every, today: "2026-11-27" });
  assert.equal(zero.record, false);
  assert.equal(zero.beatOn, null);
  assert.equal(streakView({ streak: 5, best: 10, todayOpen: false, isDue: (d) => (d < "2026-12-01" ? true : null), today: "2026-11-27" }).beatOn, null, "расписание дальше не знаем — даты нет");
});

test("циферблат: 00:00 сверху, по часовой; час под указателем", () => {
  assert.deepEqual(clockPos(0, 84), [100, 16]);
  assert.deepEqual(clockPos(360, 84), [184, 100]);
  assert.deepEqual(clockPos(720, 84), [100, 184]);
  assert.deepEqual([[0, -10], [10, 0], [0, 10], [-10, 0]].map(([x, y]) => hourAt(x, y)), [0, 6, 12, 18]);
});

test("дни недели: лучший и слабый, ровно, мало данных; день с пропусками", () => {
  const w = [10, 9, 8, 7, 6, 5, 4].map((done) => ({ done, planned: 10 }));
  const v = weekView(w);
  assert.deepEqual(v.p, [100, 90, 80, 70, 60, 50, 40]);
  assert.equal(v.hi, 0);
  assert.equal(v.lo, 6);
  assert.equal(v.text, "Лучше всего по понедельникам (100 %), слабее по воскресеньям: 40 %.");
  assert.equal(weekView(w.map(() => ({ done: 8, planned: 10 }))).text, "Все дни держатся ровно, 80 %.");
  assert.equal(weekView(w.map(() => ({ done: 1, planned: 2 }))).text, "Пока мало отметок, чтобы сравнить дни.");
  const fri = w.map((_, i) => (i === 4 ? { done: 5, planned: 10 } : { done: 10, planned: 10 }));
  assert.equal(weakDay(fri), "Чаще всего пропускаете в пятницу: 50 % против 100 % в другие дни.");
  assert.equal(weakDay(w.map(() => ({ done: 8, planned: 10 }))), null);
});

test("год по месяцам: 12 месяцев, сдвиг первого дня, лучший месяц; сделано на отрезке", () => {
  const year: HabitStats["year"] = Array.from({ length: 371 }, (_, i) => {
    const day = add("2025-11-24", i);
    return { day, s: day < "2026-11-27" ? "done" : day === "2026-11-27" ? "today" : "wait" };
  });
  const { months, best } = yearMonths(year, "2026-11-27");
  assert.equal(months.length, 12);
  assert.equal(months[0].month, "2025-12");
  assert.equal(months[0].offset, 0, "1 декабря 2025 — понедельник");
  assert.equal(months[0].weeks, 5);
  const nov = months[11];
  assert.equal(nov.month, "2026-11");
  assert.equal(nov.offset, 6, "1 ноября 2026 — воскресенье");
  assert.equal(nov.weeks, 6);
  assert.deepEqual([nov.done, nov.planned], [26, 26], "сегодня, ещё не отмеченное, не в счёт");
  assert.equal(best, nov, "при равенстве — свежий");
  assert.deepEqual(tallyYear(year, "2026-11-01", "2026-11-30"), { done: 26, planned: 26 });
  // Пропуск и неполный день доходят до клетки (штриховка, заливка на долю).
  const marked: HabitStats["year"] = year.map((c) => (c.day === "2026-11-03" ? { ...c, s: "miss", k: "part", p: 0.5 } : c.day === "2026-11-04" ? { ...c, s: "miss", k: "skip" } : c));
  const nov2 = yearMonths(marked, "2026-11-27").months[11];
  assert.deepEqual(nov2.cells.find((c) => c.day === "2026-11-03"), { day: "2026-11-03", s: "miss", k: "part", p: 0.5 });
  assert.deepEqual(nov2.cells.find((c) => c.day === "2026-11-04"), { day: "2026-11-04", s: "miss", k: "skip" });
  // Дни недели по отрезку: короче 3 месяцев — 3 месяца до конца отрезка.
  const wk = weekFromYear(marked, "2026-11-20", "2026-11-26");
  assert.equal(wk.wide, true);
  assert.equal(wk.w.reduce((n, x) => n + x.planned, 0), 90);
  assert.equal(wk.w.reduce((n, x) => n + x.done, 0), 88);
  const long = weekFromYear(marked, "2026-06-01", "2026-11-26");
  assert.deepEqual([long.wide, long.w.reduce((n, x) => n + x.planned, 0)], [false, 179]);
  assert.equal(tallyYear(year, "2020-01-01", "2026-11-30"), null, "старше года — не знаем");
});

test("отклик на напоминание: через сколько, разброс, ранняя и поздняя", () => {
  const pts = [pt("2026-11-01", 730), pt("2026-11-02", 740), pt("2026-11-03", 760), pt("2026-11-04", 720)];
  assert.deepEqual(responseView(pts, [720]), { early: 720, late: 760, usual: 735, after: 15, spread: 9 });
  assert.equal(responseView(pts.slice(0, 2), [720]), null, "меньше 3 отметок");
  assert.deepEqual(responseView(pts, []), { early: 720, late: 760, usual: 735, after: null, spread: null });
  // Отметка раньше всех напоминаний — минус; у двух напоминаний — от ближайшего прошедшего.
  assert.equal(responseView([pt("2026-11-01", 700), pt("2026-11-02", 700), pt("2026-11-03", 700)], [720])!.after, -20);
  assert.equal(responseView([pt("2026-11-01", 1270), pt("2026-11-02", 1270), pt("2026-11-03", 600)], [540, 1260])!.after, 10);
});

test("ритм дня ×N: в среднем, норма набрана, первая и последняя, промежуток", () => {
  const pts = [pt("2026-11-20", 480, 1), pt("2026-11-20", 780, 2), pt("2026-11-20", 1200, 3), pt("2026-11-21", 500, 1), pt("2026-11-21", 800, 2), pt("2026-11-27", 490, 1)];
  const r = rhythmView({ pts, perDay: 3, isDue: () => true, a: "2026-11-20", b: "2026-11-27", today: "2026-11-27" })!;
  assert.equal(r.planned, 7, "сегодня не в счёт");
  assert.equal(r.avg, 5 / 7);
  assert.equal(r.full, 1);
  assert.equal(r.first, 490);
  assert.equal(r.last, 1000);
  assert.equal(r.gap, 300);
  assert.equal(rhythmView({ pts: pts.slice(0, 2), perDay: 3, isDue: () => true, a: "2026-11-20", b: "2026-11-27", today: "2026-11-27" }), null);
});

test("Рина заметила: по данным отрезка, без выдумок", () => {
  const flat = Array.from({ length: 7 }, () => ({ done: 8, planned: 10 }));
  const late = [pt("2026-11-01", 760), pt("2026-11-02", 770), pt("2026-11-03", 780)];
  assert.deepEqual(rinaNote({ pts: late.slice(0, 2), perDay: 1, remind: ["12:00"], weekdays: flat, streak: 0, best: 0 }).mood, "think");
  assert.match(rinaNote({ pts: late.slice(0, 2), perDay: 1, remind: ["12:00"], weekdays: flat, streak: 0, best: 0 }).text, /мало/);
  assert.deepEqual(rinaNote({ pts: late, perDay: 1, remind: ["12:00"], weekdays: flat, streak: 5, best: 8 }), {
    text: "Обычно вы отмечаете около 12:50 — на 50 мин позже напоминания. Давайте я буду напоминать в 12:40? До нового рекорда всего 4 дня.", mood: "think",
    act: { time: "12:40", replace: "12:00", label: "Напоминать в 12:40" },
  });
  // Совет кнопкой: заменить то напоминание, на которое отвечают; у двух — второе остаётся.
  assert.deepEqual(applyRinaAct(["12:00", "21:00"], { time: "12:40", replace: "12:00", label: "" }), ["12:40", "21:00"]);
  assert.deepEqual(applyRinaAct(["09:00"], { time: "12:00", replace: null, label: "" }), ["09:00", "12:00"]);
  assert.equal(rinaNote({ pts: late, perDay: 1, remind: [], weekdays: flat, streak: 0, best: 0 }).act, null, "без напоминаний — совета нет");
  assert.equal(rinaNote({ pts: late, perDay: 1, remind: [], weekdays: flat, streak: 0, best: 0 }).text, "Обычно вы отмечаете около 12:50.");
  assert.equal(rinaNote({ pts: late, perDay: 1, remind: ["12:45"], weekdays: flat, streak: 0, best: 0 }).text, "Напоминание попадает точно: отмечаете в среднем через 5 мин.");
  const water = [pt("2026-11-01", 480, 1), pt("2026-11-01", 540, 2), pt("2026-11-01", 900, 3), pt("2026-11-01", 960, 4), pt("2026-11-02", 480, 1)];
  assert.equal(rinaNote({ pts: water, perDay: 4, remind: [], weekdays: flat, streak: 0, best: 0 }).text, "Самый долгий перерыв — между 09:00 и 15:00: 6 ч без отметок.");
  const w2 = rinaNote({ pts: water, perDay: 4, remind: ["08:00"], weekdays: flat, streak: 0, best: 0 });
  assert.deepEqual(w2.act, { time: "12:00", replace: null, label: "Напоминать ещё в 12:00" });
  assert.match(w2.text, /Добавить напоминание на 12:00\?/);
  const fri = flat.map((_, i) => (i === 4 ? { done: 5, planned: 10 } : { done: 10, planned: 10 }));
  const weak = rinaNote({ pts: late, perDay: 1, remind: [], weekdays: fri, streak: 0, best: 0 });
  assert.equal(weak.mood, "worried");
  assert.match(weak.text, /Чаще всего пропускаете в пятницу/);
});

test("страница: клетки, ×N, минус отметка, раскрытие, зелёный и красный в обеих темах, ✓ в сделанных", () => {
  const src = readFileSync(new URL("../src/screens/Habits.tsx", import.meta.url), "utf8");
  assert.match(src, /data-s=\{kind\}/);
  assert.match(src, /onContextMenu=\{\(e\) => \{ e\.preventDefault\(\);[^}]*mark\(h, x, true\)/, "правый клик — минус одна отметка");
  assert.match(src, /press\.current = window\.setTimeout\(\(\) => \{ pressedAt\.current = Date\.now\(\); mark\(h, x, true\); \}, 550\)/, "долгое нажатие пальцем");
  assert.match(src, /step: -1, day: x\.day/);
  assert.match(src, /aria-expanded=\{opened\}/);
  assert.match(src, /×\{per\}/);
  assert.match(src, /per_day: n/, "поле «раз в день» шлёт per_day");
  const panel = readFileSync(new URL("../src/screens/HabitStats.tsx", import.meta.url), "utf8");
  for (const t of ["Во сколько отмечали", "По отметкам", "Сутки целиком", "Серия", "Сутки", "Дни недели", "Год по месяцам", "Отклик на напоминание", "Ритм дня", "Рина заметила"]) assert.ok(panel.includes(t), t);
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(css, /:root \{[^}]*--habit-done: var\(--green\); --habit-skip: var\(--red\);/, "светлая тема");
  assert.match(css, /:root\[data-theme="dark"\] \{[^}]*--habit-done: var\(--green\); --habit-skip: var\(--red\);/, "тёмная тема");
  assert.match(src, /kind === "done" && <b className="hg-ok" aria-hidden="true">✓<\/b>/, "галочка в сделанной клетке");
  assert.match(css, /\.hg-cell\[data-s="done"\] \{ background: var\(--habit-done\); \}/);
  assert.match(css, /\.hg-cell\[data-s="skip"\] \{ background: repeating-linear-gradient\(135deg, var\(--habit-skip\)/);
  assert.match(css, /\.hg-title\[data-t="3"\] \{ --fire: var\(--habit-gold\); \}/);
  assert.doesNotMatch(css, /\.hg-cell\.done/, "старых зелёных клеток нет");
  // Телефон: таблица прокручивается внутри, страница не шире экрана.
  assert.match(css, /\.hg-wrap \{ overflow-x: auto;/);
  assert.match(css, /@media \(max-width: 720px\) \{\s*\.habit-grid \{ grid-template-columns: var\(--hg-narrow\)/);
});
