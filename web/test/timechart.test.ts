import assert from "node:assert/strict";
import { test } from "node:test";
import { axisLabels, DAY_END, dayPos, dayTicks, gapLinks, hhmm, hitBands, lineRuns, markerSize, medianMin, pointTip, timeScale, timeSummary, tipLeft, tipTop, toMin } from "../src/timechart.ts";

// График «Во сколько отмечали» в статистике привычки (26.11.2026): шкала времени, медиана, куски линии, подписи.

test("шкала времени: целые часы с запасом, позже — выше, не уже 2 часов, не больше 5 подписей", () => {
  // 12:04 и 12:40, напоминание 12:00 → с запасом 30 мин: 11:00–14:00 по часу.
  assert.deepEqual(timeScale([724, 760, 720]), { lo: 660, hi: 840, ticks: [660, 720, 780, 840] });
  // 07:15 … 23:50 → 06:00–23:59 по 6 часов, «24:00» не подписывается.
  const wide = timeScale([435, 1430]);
  assert.equal(wide.hi, DAY_END);
  assert.deepEqual(wide.ticks.map(hhmm), ["06:00", "12:00", "18:00"]);
  assert.deepEqual(timeScale([1439]).ticks.map(hhmm), ["21:00", "22:00", "23:00"]);
  assert.deepEqual(timeScale([]).ticks.map(hhmm), ["00:00", "06:00", "12:00", "18:00"]);
  for (const mins of [[0], [1439], [1420, 1439], [300, 302], [60, 1400], [600, 900], [0, 1439]]) {
    const s = timeScale(mins);
    assert.ok(s.lo >= 0 && s.hi <= DAY_END && s.hi - s.lo >= 120, `диапазон ${mins}`);
    assert.ok(s.ticks.every((t) => t <= 1380), `подписи не позже 23:00 ${mins}`);
    assert.ok(s.ticks.length >= 2 && s.ticks.length <= 5, `подписи ${mins}`);
    assert.ok(mins.every((m) => m >= s.lo && m <= s.hi), `всё внутри ${mins}`);
    assert.ok(s.ticks.every((t) => t % 60 === 0));
  }
});

test("медиана, часы-минуты, куски линии", () => {
  assert.equal(medianMin([]), null);
  assert.equal(medianMin([760, 700, 724]), 724);
  assert.equal(medianMin([700, 760]), 730);
  assert.equal(hhmm(730), "12:10");
  assert.equal(toMin("08:05"), 485);
  const pts = [{ day: "a", gap: false }, { day: "b", gap: false }, { day: "c", gap: true }, { day: "d", gap: true }, { day: "e", gap: false }];
  assert.deepEqual(lineRuns(pts).map((r) => r.map((p) => p.day).join("")), ["ab", "c", "de"], "сплошные куски");
  assert.deepEqual(gapLinks(pts).map(([a, b]) => a.day + b.day), ["bc", "cd"], "пунктир через пропуски, одиночная c соединена с обеими сторонами");
  assert.deepEqual(gapLinks([{ day: "a", gap: true }, { day: "b", gap: false }]), [], "пропуск до первой точки — без мостика");
});

test("ось Y: 🔔 на высоте напоминания, соседний час ближе 14 px не подписан", () => {
  const y = (m: number) => (840 - m) * (144 / 180); // 11:00–14:00 на 144 px: час = 48 px
  const a = axisLabels([660, 720, 780, 840], [730], y);
  assert.deepEqual(a.filter((l) => l.bell).map((l) => l.label), ["🔔 12:10"]);
  assert.deepEqual(a.filter((l) => !l.bell).map((l) => l.label), ["11:00", "13:00", "14:00"], "12:00 — в 8 px от 🔔, убран");
  assert.deepEqual(axisLabels([660, 720, 780, 840], [750], y).filter((l) => !l.bell).length, 4, "12:30 — в 24 px, все часы на месте");
  const two = axisLabels([660, 720, 780, 840], [720, 725, 790], y);
  assert.deepEqual(two.filter((l) => l.bell).map((l) => l.label), ["🔔 12:00", "🔔 13:10"], "у двух близких — подпись у первого");
  assert.deepEqual(two.filter((l) => !l.bell).map((l) => l.label), ["11:00", "14:00"]);
  assert.deepEqual(axisLabels([660, 720], [], y).map((l) => l.label), ["11:00", "12:00"]);
});

test("точки: густо — мельче, редко — обычные; подсказка у краёв по своей ширине", () => {
  assert.deepEqual(markerSize([50, 58.7, 67.4]), { r: 2.5, ring: 1.5, hover: 4 });
  assert.deepEqual(markerSize([50, 80, 120]), { r: 4, ring: 2, hover: 5.5 });
  assert.deepEqual(markerSize([50]), { r: 4, ring: 2, hover: 5.5 });
  assert.equal(tipLeft(160, 100, 320), 110, "в середине — по центру");
  assert.equal(tipLeft(310, 100, 320), 216, "у правого края — прижата вправо");
  assert.equal(tipLeft(45, 100, 320), 4, "у левого края — прижата влево");
});

test("ось дней: по дате, подписи первый — середина — последний; подсказка и подпись для чтения", () => {
  assert.equal(dayPos("2026-10-28", "2026-10-28", "2026-11-26"), 0);
  assert.equal(dayPos("2026-11-26", "2026-10-28", "2026-11-26"), 1);
  assert.ok(Math.abs(dayPos("2026-11-12", "2026-10-28", "2026-11-26") - 15 / 29) < 1e-9, "пропущенные дни — пробел");
  assert.equal(dayPos("2026-11-26", "2026-11-26", "2026-11-26"), 0.5);
  assert.deepEqual(dayTicks("2026-10-28", "2026-11-26").map((d) => d.label), ["28 окт", "12 ноя", "26 ноя"]);
  assert.deepEqual(dayTicks("2026-11-20", "2026-11-26").map((d) => d.label), ["20 ноя", "26 ноя"]);
  assert.equal(pointTip({ day: "2026-11-26", time: "12:04" }), "чт 26 ноя — 12:04");
  assert.equal(
    timeSummary({ from: "2026-10-28", to: "2026-11-26", points: [{ min: 724 }, { min: 760 }], remind: ["12:00"] }),
    "Во сколько отмечали с 28 октября по 26 ноября: дней с отметкой — 2, обычно около 12:22; напоминание в 12:00",
  );
});

test("полосы наведения не перекрываются и ведут к ближайшему дню; подсказка у верхнего края — под точкой", () => {
  const xs = [46, 54.6, 63.2, 120];
  const bands = hitBands(xs, 40, 300);
  assert.deepEqual(bands.map((b) => +b.x.toFixed(2)), [40, 50.3, 58.9, 91.6]);
  for (let i = 0; i < bands.length; i++) {
    assert.ok(bands[i].x <= xs[i] && xs[i] <= bands[i].x + bands[i].w, `точка ${i} в своей полосе`);
    if (i) assert.equal(+(bands[i - 1].x + bands[i - 1].w).toFixed(6), +bands[i].x.toFixed(6), "полосы встык, без нахлёста");
  }
  assert.equal(bands[3].x + bands[3].w, 300);
  assert.equal(tipTop(100), 70);
  assert.equal(tipTop(12), 22);
});
