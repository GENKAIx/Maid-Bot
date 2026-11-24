import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { CLIENT_FEATURES, FEATURES } from "../../server/src/feature-list.ts";
import { dayAgo, featureView, sparkPoints, ADMIN_LIVE_STAGE, ADMIN_SECTIONS, CLIENT_NAMES, type FeatureRow } from "../src/admin.ts";
import { NAV_TABS } from "../src/nav.ts";
import { screenFeature, usageCounter, usageSent, USAGE_MAX_COUNT, type UsageKeep } from "../src/usage.ts";

// Этап 3 админки: счётчики фич сайта (web/src/usage.ts) — пачка, повтор, хранилище; имена — из белого списка сервера;
// раздел «Использование функций» (web/src/admin.ts) — фильтр, линия тренда, «последний раз».

test("счётчик: копит в памяти, шлёт пачкой, не дошло — возвращает, пачки не наслаиваются", async () => {
  const sent: Record<string, number>[] = [];
  let answer = true;
  const c = usageCounter(async (counts) => {
    sent.push(counts);
    return answer;
  });
  c.track("screen.today");
  c.track("screen.today");
  c.track("site.theme");
  c.track("Плохое имя");
  assert.deepEqual(c.pending(), { "screen.today": 2, "site.theme": 1 });
  await c.flush();
  assert.deepEqual(sent, [{ "screen.today": 2, "site.theme": 1 }]);
  assert.deepEqual(c.pending(), {});
  await c.flush(); // пусто — не шлёт
  assert.equal(sent.length, 1);
  // Сервер ответил «позже» (429, сеть) — счёт возвращается и прибавляется к новому.
  answer = false;
  c.track("screen.plans");
  await c.flush();
  c.track("screen.plans");
  assert.deepEqual(c.pending(), { "screen.plans": 2 });
  // Пока пачка в пути, вторая не уходит.
  let done!: () => void;
  const slow = usageCounter(() => new Promise<boolean>((r) => { done = () => r(true); }));
  slow.track("screen.notes");
  const first = slow.flush();
  slow.track("screen.notes");
  await slow.flush();
  done();
  await first;
  assert.deepEqual(slow.pending(), { "screen.notes": 1 });
});

test("счётчик: не больше USAGE_MAX_COUNT на фичу; остаток в хранилище переживает перезагрузку, испорченное — пусто", async () => {
  let saved: string | null = null;
  const keep: UsageKeep = { load: () => saved, save: (v) => (saved = v) };
  const c = usageCounter(async () => false, keep);
  for (let i = 0; i < USAGE_MAX_COUNT + 20; i++) c.track("screen.today");
  assert.equal(c.pending()["screen.today"], USAGE_MAX_COUNT);
  await c.flush(true); // уходим, сервер не ответил — в хранилище
  assert.deepEqual(c.pending(), {});
  const again = usageCounter(async () => true, keep);
  assert.deepEqual(again.pending(), { "screen.today": USAGE_MAX_COUNT });
  saved = "{не json";
  assert.deepEqual(usageCounter(async () => true, keep).pending(), {});
  const broken: UsageKeep = { load: () => { throw new Error("нет доступа"); }, save: () => { throw new Error("нет доступа"); } };
  const b = usageCounter(async () => true, broken);
  b.track("screen.today");
  await b.flush(true);
  assert.deepEqual(b.pending(), {}, "без хранилища — в памяти, и уходит");
  assert.deepEqual([200, 401, 400, 429, 500, 502].map(usageSent), [true, true, true, false, false, false]);
});

test("счётчик: две вкладки на одном хранилище — счёт не двоится и не стирается", async () => {
  let saved: string | null = JSON.stringify({ at: 0, counts: { "screen.plans": 1 } }); // остаток прошлого раза
  const keep: UsageKeep = { load: () => saved, save: (v) => (saved = v) };
  let t = 1_000_000;
  const sent: Record<string, number>[] = [];
  const send = async (x: Record<string, number>) => (sent.push(x), true);
  const a = usageCounter(send, keep, () => t);
  const b = usageCounter(send, keep, () => t); // открыли вторую — остаток уже забрала первая
  assert.deepEqual([a.pending(), b.pending()], [{ "screen.plans": 1 }, {}]);
  b.track("screen.today");
  await a.flush();
  await b.flush(); // в ту же минуту: сервер бы ответил 429 — ждёт в памяти
  assert.deepEqual(sent, [{ "screen.plans": 1 }]);
  assert.deepEqual(b.pending(), { "screen.today": 1 });
  // B закрыли в ту же минуту — счёт в хранилище; A через 10 минут забирает его и шлёт.
  await b.flush(true);
  assert.deepEqual(b.pending(), {});
  a.track("screen.notes");
  t += 10 * 60_000;
  await a.flush();
  assert.deepEqual(sent[1], { "screen.today": 1, "screen.notes": 1 });
  assert.deepEqual(JSON.parse(saved!).counts, {});
});

test("счётчик: уход в пределах минуты после пачки — не слать (429 у ушедшей страницы пропал бы), а сохранить", async () => {
  let saved: string | null = null;
  const keep: UsageKeep = { load: () => saved, save: (v) => (saved = v) };
  let t = 5_000_000;
  let calls = 0;
  const c = usageCounter(async () => (calls++, true), keep, () => t);
  c.track("screen.today");
  await c.flush(true); // скрыли вкладку — ушло
  t += 30_000;
  c.track("screen.plans");
  await c.flush(true); // через 30 с закрыли — 429 был бы; в хранилище
  assert.equal(calls, 1);
  assert.deepEqual(JSON.parse(saved!).counts, { "screen.plans": 1 });
  assert.deepEqual(usageCounter(async () => true, keep).pending(), { "screen.plans": 1 }, "уйдёт со следующего захода");
});

test("счётчик: выход из аккаунта — не ушедшее выбрасывается, и из хранилища, и ответ прежней пачки его не вернёт", async () => {
  let saved: string | null = JSON.stringify({ at: 0, counts: { "screen.money": 2 } });
  const keep: UsageKeep = { load: () => saved, save: (v) => (saved = v) };
  let answer!: (ok: boolean) => void;
  const c = usageCounter(() => new Promise<boolean>((r) => (answer = r)), keep);
  c.track("screen.today");
  const flying = c.flush(true);
  c.drop(); // выход не дождался ответа
  answer(false);
  await flying;
  assert.deepEqual(c.pending(), {});
  assert.deepEqual(JSON.parse(saved!).counts, {});
  assert.deepEqual(usageCounter(async () => true, keep).pending(), {}, "следующему аккаунту — ничего");
});

test("имена: экраны меню, поиск и каталог и каждый track(\"…\") сайта — в белом списке сервера, группа «Сайт»", () => {
  const site = new Set(FEATURES.filter((f) => f.group === "site").map((f) => f.id));
  for (const t of NAV_TABS) assert.ok(site.has(screenFeature(t.path)!), `нет фичи для экрана ${t.id}`);
  for (const p of ["/search/хлеб", "/catalog"]) assert.ok(site.has(screenFeature(p)!), p);
  assert.equal(screenFeature("/"), "screen.today");
  assert.equal(screenFeature("/nope"), "screen.today", "незнакомый адрес показывает «Сегодня»");
  for (const p of ["/widget", "/maid", "/settings/maid", "/settings/persona/"]) assert.equal(screenFeature(p), null, `${p}: прежний адрес — считается новый`);
  assert.equal(screenFeature("/settings/widget"), "screen.settings");
  const files = (dir: URL): URL[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? files(new URL(`${d.name}/`, dir)) : /\.tsx?$/.test(d.name) ? [new URL(d.name, dir)] : []);
  const used = files(new URL("../src/", import.meta.url)).flatMap((f) => [...readFileSync(f, "utf8").matchAll(/\btrack\("([^"]+)"\)/g)].map((m) => m[1]));
  assert.ok(used.length >= 3);
  for (const id of used) assert.ok(CLIENT_FEATURES.has(id) && site.has(id), `track("${id}") — нет в белом списке сайта`);
  // И обратно: у каждой фичи сайта, которую шлёт клиент, есть экран или вызов track — иначе вечное «никогда» в отчёте.
  const screens = new Set([...NAV_TABS.map((t) => screenFeature(t.path)), screenFeature("/search"), screenFeature("/catalog")]);
  for (const f of FEATURES.filter((x) => x.group === "site" && x.by === "client")) assert.ok(screens.has(f.id) || used.includes(f.id), `${f.id}: на сайте её никто не шлёт`);
});

test("админка, этап 3: раздел живой; фильтр по группе и клиенту, линия тренда, «последний раз»", () => {
  assert.ok(ADMIN_LIVE_STAGE >= 3);
  assert.ok(ADMIN_SECTIONS.find((s) => s.id === "features")!.stage <= ADMIN_LIVE_STAGE);
  assert.equal(ADMIN_SECTIONS.find((s) => s.id === "showcase")!.stage, 4, "витрина — этап 4");
  for (const c of ["web", "desktop", "iphone", "telegram", "telegram-widget", "push", "other"]) assert.ok(CLIENT_NAMES[c], c);
  const st = (uses30: number, last: string | null, w = 0) => ({ uses30, people30: uses30 ? 1 : 0, weeks: [0, 0, 0, 0, 0, 0, w, uses30], last });
  const rows: FeatureRow[] = [
    { id: "screen.today", title: "Сегодня", group: "site", by: "client", all: st(5, "2026-11-24", 2), clients: { web: st(3, "2026-11-24"), desktop: st(2, "2026-11-20") } },
    { id: "bot.today", title: "/today", group: "bot", by: "server", all: st(0, "2026-09-01"), clients: { telegram: st(0, "2026-09-01") } },
  ];
  assert.deepEqual(featureView(rows, "all", "all").map((r) => [r.id, r.uses30, r.trend]), [["screen.today", 5, 7], ["bot.today", 0, 0]]);
  assert.deepEqual(featureView(rows, "site", "desktop").map((r) => [r.id, r.uses30, r.last]), [["screen.today", 2, "2026-11-20"]]);
  assert.deepEqual(featureView(rows, "all", "iphone").map((r) => [r.uses30, r.last, r.weeks.length]), [[0, "", 8], [0, "", 8]], "у клиента нет счёта — нули");
  assert.equal(sparkPoints([0, 0, 0], 10, 10), "0,9 5,9 10,9");
  assert.equal(sparkPoints([0, 4], 10, 10), "0,9 10,1");
  assert.equal(dayAgo(null, "2026-11-24"), "никогда");
  assert.equal(dayAgo("2026-11-24", "2026-11-24"), "сегодня");
  assert.equal(dayAgo("2026-11-25", "2026-11-24"), "сегодня", "у человека восточнее уже завтра");
  assert.equal(dayAgo("2026-11-23", "2026-11-24"), "вчера");
  assert.equal(dayAgo("2026-11-14", "2026-11-24"), "10 дн. назад");
  assert.match(dayAgo("2026-09-01", "2026-11-24"), /2026/);
});
