import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { capacityHeadline, loadLabels, loadTiles, mbText, tileNote, type Capacity, type ServerLoad } from "../src/serverHealth.ts";
import { LoadView } from "../src/screens/AdminLoad.tsx";

// Часть 2 «Тарифы и управление»: «Здоровье сервера» → нагрузка — плашки, подписи, «Сколько выдержит», рендер по готовым данным.

const NOW = {
  at: "2026-11-25T12:00:00.000Z", cpu_proc: 92, cpu_ms: 55_000, cpu_sys: 40, load1: 0.5, cores: 2, rss_mb: 300, heap_mb: 90, heap_total_mb: 120,
  mem_total_mb: 4000, mem_free_mb: 2000, mem_limit_mb: 4000, mem_pct: 50, loop_p50: 1, loop_p99: 12, loop_max: 40, http: 120, http_p50: 5, http_p95: 80,
  http_5xx: 2, bot: 3, llm: 4, llm_err: 1, active: 6, queue: 1, queue_peak: 3, db_mb: 40, disk_free_mb: 1500, disk_total_mb: 20_000, uptime: 3600, tick_ms: 0.8,
};
const FEW: Capacity = { status: "few", minutes: 12, need: 30, peak_active: 0, max_active: 3, people: null, bottleneck: null, limits: [] };
function load(x: Partial<ServerLoad> = {}): ServerLoad {
  const t = Array.from({ length: 60 }, (_, i) => new Date(Date.parse("2026-11-25T11:01:00Z") + i * 60_000).toISOString());
  const keys = ["cpu_sys", "cpu_proc", "cpu_proc_max", "mem_pct", "rss_mb", "heap_mb", "loop_p50", "loop_p99", "loop_max", "http", "http_p50", "http_p95", "http_5xx", "bot", "llm", "llm_err", "queue_peak", "active", "active_max"] as const;
  return {
    now: NOW, last_at: NOW.at, since: "2026-11-20T00:00:00Z", samples: 500,
    peak: { cpu_sys: 70, cpu_proc: 95, mem_pct: 60, rss_mb: 350, loop_p99: 30, loop_max: 120, http: 200, http_p95: 150, http_5xx: 5, llm: 10, queue_peak: 4, active: 9, db_mb: 41 },
    llm_rpm: 60, keep_days: 7, range: "1h", step_min: 1, t,
    series: Object.fromEntries(keys.map((k) => [k, t.map((_, i) => (i === 10 ? null : i))])) as ServerLoad["series"],
    capacity: FEW, ...x,
  };
}

test("плашки: сейчас, пик за сутки, запас от пика; предупреждения", () => {
  const tiles = loadTiles(load());
  const by = (id: string) => tiles.find((t) => t.id === id)!;
  assert.deepEqual([by("cpu_proc").now, by("cpu_proc").peak, by("cpu_proc").spare, by("cpu_proc").warn], ["92%", "95%", "5%", true]);
  assert.equal(by("cpu_sys").title, "Процессор машины (2 яд.)");
  assert.equal(by("mem").spare, "1,6 ГБ", "40% от 4000 МБ");
  assert.equal(by("mem").title, "Память машины");
  assert.equal(by("http_5xx").warn, true);
  assert.equal(by("llm").spare, "50 в мин", "LLM_RPM 60 минус пик 10");
  assert.equal(by("db").spare, "1,5 ГБ на диске (7,5%)");
  assert.equal(by("db").warn, true, "диска меньше 10%");
  // Контейнер с потолком: заголовок и запас — от потолка; без потолка провайдера; без свежего снимка — прочерки.
  const box = loadTiles(load({ now: { ...NOW, mem_limit_mb: 1000 }, llm_rpm: null }));
  assert.equal(box.find((t) => t.id === "mem")!.title, "Память (потолок контейнера)");
  assert.equal(box.find((t) => t.id === "mem")!.spare, "400 МБ");
  assert.equal(box.find((t) => t.id === "llm")!.spare, null);
  assert.equal(tileNote(box.find((t) => t.id === "llm")!), "пик 10 · потолок не задан");
  const old = loadTiles(load({ now: null }));
  assert.ok(old.every((t) => t.now === "—" && !t.warn));
  assert.equal(mbText(0.5), "0,5 МБ");
});

test("подписи плашек: «запас» — только где он посчитан (процессор, память, модель, диск); у прочих — без слова «запас»", () => {
  const tiles = loadTiles(load());
  const note = (id: string) => tileNote(tiles.find((t) => t.id === id)!);
  assert.equal(note("cpu_proc"), "пик 95% · запас 5%");
  assert.equal(note("mem"), "пик 60% · запас 1,6 ГБ");
  assert.equal(note("llm"), "пик 10 · запас 50 в мин");
  assert.equal(note("db"), "пик 41 МБ · запас 1,5 ГБ на диске (7,5%)");
  assert.equal(note("rss"), "пик 350 МБ · куча 90 МБ");
  assert.equal(note("loop"), "пик 30 мс · наибольшая 120 мс");
  assert.equal(note("http"), "пик 200 · p95 80 мс");
  assert.equal(note("http_p95"), "пик 150 мс · p50 5 мс");
  assert.equal(note("http_5xx"), "пик 5");
  assert.equal(note("queue"), "пик 4 · активных 6");
  for (const id of ["rss", "loop", "http", "http_p95", "http_5xx", "queue"]) assert.doesNotMatch(note(id), /запас/, id);
  const noDisk = loadTiles(load({ now: { ...NOW, disk_free_mb: null } })).find((t) => t.id === "db")!;
  assert.equal(tileNote(noDisk), "пик 41 МБ · диск не измерить");
  const html = renderToStaticMarkup(createElement(LoadView, { v: load(), range: "1h" }));
  assert.ok(!html.includes("запас куча") && !html.includes("запас p95") && !html.includes("запас —"));
});

test("подписи времени и «Сколько выдержит»: мало данных, итог, без потолка", () => {
  assert.deepEqual(loadLabels(["2026-11-25T09:05:00Z"], "24h", "UTC"), ["09:05"]);
  assert.deepEqual(loadLabels(["2026-11-25T09:00:00Z"], "7d", "UTC"), ["25.11 09:00"]);
  assert.deepEqual(capacityHeadline(FEW), { value: "мало данных", hint: "минут с людьми за 7 дней: 12 из нужных 30" });
  const ok: Capacity = {
    status: "ok", minutes: 300, need: 30, peak_active: 12.5, max_active: 15, people: 140, bottleneck: "memory",
    limits: [{ id: "cpu", people: 300, per: 150, budget: 51_000, note: "" }, { id: "memory", people: 140, per: 8, budget: 1120, note: "" }, { id: "model", people: null, per: 0.4, budget: null, note: "" }],
  };
  const h = capacityHeadline(ok);
  assert.equal(h.value, "≈ 140 чел.");
  assert.match(h.hint, /первым упрётся память/);
  assert.match(h.hint, /в час пик за 7 дн\. в среднем 12,5 активных/);
  assert.doesNotMatch(h.hint, /сейчас/, "пик за неделю — не «сейчас»");
  assert.equal(capacityHeadline({ ...ok, people: null, bottleneck: null }).value, "не видно потолка");
});

test("рендер нагрузки: плашки, переключатель интервала, графики, подпись «оценка по замерам, не нагрузочный тест»", () => {
  const html = renderToStaticMarkup(createElement(LoadView, { v: load(), range: "1h" }));
  for (const s of ["Процессор процесса (одно ядро)", "Задержка цикла событий", "Вызовы модели в минуту", "Очередь разбора и люди", "Сколько выдержит", "мало данных", "оценка по замерам, не нагрузочный тест", "1 ч", "7 дн"]) {
    assert.ok(html.includes(s), s);
  }
  assert.match(html, /aria-selected="true"[^>]*>1 ч/);
  const ok: Capacity = { status: "ok", minutes: 300, need: 30, peak_active: 10, max_active: 15, people: 100, bottleneck: "cpu", limits: [{ id: "cpu", people: 100, per: 500, budget: 51_000, note: "одно ядро" }] };
  const full = renderToStaticMarkup(createElement(LoadView, { v: load({ capacity: ok }), range: "1h" }));
  assert.ok(full.includes("≈ 100 чел.") && full.includes("Процессор · первым") && full.includes("500 мс в мин"));
  // Таблица «Сколько выдержит» — в прокрутке, как остальные таблицы админки (на телефоне страница не едет вбок).
  assert.match(full, /<div class="adm-scroll"[^>]*><table class="adm-table">/);
  // Единицы графиков — в заголовках (на оси только числа).
  for (const t of ["Процессор, %", "Память процесса, МБ", "Задержка цикла событий, мс", "Время ответа, мс", "Ошибки за шаг"]) assert.ok(full.includes(`<h3>${t}</h3>`), t);
  const stale = renderToStaticMarkup(createElement(LoadView, { v: load({ now: null }), range: "24h" }));
  assert.ok(stale.includes("Свежего снимка нет"));
  const empty = renderToStaticMarkup(createElement(LoadView, { v: load({ now: null, samples: 0, last_at: null }), range: "24h" }));
  assert.ok(empty.includes("Снимков ещё нет"));
});
