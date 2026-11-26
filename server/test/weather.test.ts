import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { afterEach, test } from "node:test";
import { createApi } from "../src/api.ts";
import { hashPassword } from "../src/auth.ts";
import { Store, type EventRow, type TaskRow } from "../src/db.ts";
import type { LlmCall } from "../src/llm.ts";
import { morningText, weatherLineOk } from "../src/morning.ts";
import { Pipeline, WEATHER_ASK } from "../src/pipeline.ts";
import { Scheduler } from "../src/scheduler.ts";
import { zonedToUtc } from "../src/time.ts";
import { dayWeather, forgetForecasts, outdoor, pickDeed, rainSoon, weatherFor, weatherNet, weatherPhrase, type Hour } from "../src/weather.ts";

// Погода утром (21.11.2026): прогноз Open-Meteo по городу из «О вас», одно дело, которое погода задевает (пять правил),
// фраза из заготовок для виджета и строка от модели (только с числами прогноза) в «Утреннем списке».

const DAY = "2026-11-21";
const TZ = "Europe/Moscow";
const KAZAN = { name: "Казань", region: "Татарстан", country: "Россия", lat: 55.79, lon: 49.12, tz: TZ };

/** Сутки прогноза: base — каждый час, over(h) — свои поля для часа. */
function day(base: Partial<Hour>, over: (h: number) => Partial<Hour> = () => ({})): Hour[] {
  return Array.from({ length: 24 }, (_, h) => ({ h, t: 3, p: 0, pp: 0, code: 3, wind: 3, ...base, ...over(h) }));
}
const RAIN_EVENING = day({}, (h) => (h >= 17 ? { p: 1.2, pp: 90, code: 63 } : {}));
const ev = (title: string, time: string | null, id = 1): EventRow =>
  ({ id, user_id: 1, title, date_iso: DAY, time, end_time: null, details: "", domain: "", status: "active", message_id: null });
const task = (title: string, id = 1): TaskRow => ({ id, user_id: 1, title, priority: "normal", category: "", due_date: null } as TaskRow);
const PLANS = [ev("Пробежка", "08:00", 1), ev("Шиномонтаж", "18:00", 2), ev("Разобрать почту", "12:00", 3)];

/** Подменить сеть: ответ Open-Meteo из часов. */
function serve(hours: Hour[] | null) {
  let n = 0;
  weatherNet.fetch = (async () => {
    n++;
    if (!hours) throw new Error("нет сети");
    return new Response(JSON.stringify({ hourly: {
      time: hours.map((x) => `${DAY}T${String(x.h).padStart(2, "0")}:00`), temperature_2m: hours.map((x) => x.t), precipitation: hours.map((x) => x.p),
      precipitation_probability: hours.map((x) => x.pp), weather_code: hours.map((x) => x.code), wind_speed_10m: hours.map((x) => x.wind),
    } }));
  }) as typeof fetch;
  return () => n;
}
afterEach(() => forgetForecasts());

test("дело на улице — по словам в названии, дома — нет", () => {
  for (const t of ["Пробежка", "Шиномонтаж", "Купить тёплый шарф", "Встреча с Олегом", "Съездить на дачу", "Забрать посылку"]) assert.ok(outdoor(t), t);
  for (const t of ["Разобрать почту", "Отчёт", "Помыть посуду", "Позвонить маме"]) assert.ok(!outdoor(t), t);
});

test("дождь с 17:00: задет шиномонтаж в 18:00, не пробежка в 8:00; фраза — погода, потом одно дело", () => {
  const w = dayWeather(RAIN_EVENING, 7);
  assert.equal(w.kind, "rain");
  assert.deepEqual([w.from, w.to], [17, 24]);
  assert.deepEqual(w.parts.map((p) => p.hot), [false, true, true], "дождь с 17:00 задевает конец дня и вечер");
  const d = pickDeed(w, PLANS, [], 7 * 60, DAY);
  assert.equal(d.plan?.title, "Шиномонтаж");
  const s = weatherPhrase(w, d, 7);
  assert.equal(s.text, "С пяти вечера дождь. А у вас шиномонтаж в 18:00 — зонт не забудьте ☂");
  assert.equal(s.hit, "☂");
  assert.equal(s.pose, "remind");
});

test("правила: прошедший план не берём, из двух — ближайший, нет плана — задача, дела дома — только погода", () => {
  const all = dayWeather(day({ p: 1, pp: 90, code: 63 }), 7);
  assert.equal(pickDeed(all, PLANS, [], 7 * 60, DAY).plan?.title, "Пробежка", "оба под дождём — ближайший");
  assert.equal(pickDeed(all, PLANS, [], 9 * 60, DAY).plan?.title, "Шиномонтаж", "пробежка прошла");
  const snow = dayWeather(day({ t: -1 }, (h) => (h >= 12 ? { p: 0.8, pp: 80, code: 73 } : {})), 7);
  const d = pickDeed(snow, [ev("Разобрать почту", "12:00")], [task("Купить тёплый шарф")], 7 * 60, DAY);
  assert.equal(d.plan, null);
  assert.equal(d.task?.title, "Купить тёплый шарф");
  assert.match(weatherPhrase(snow, d, 7).text, /^С обеда снег, −1°\. «Купить тёплый шарф» лучше успеть до 12:00, пока не замело\.$/);
  const gray = dayWeather(day({}), 7);
  assert.equal(gray.kind, "gray");
  const none = pickDeed(gray, PLANS, [task("Купить хлеб")], 7 * 60, DAY);
  assert.deepEqual(none, { plan: null, task: null });
  assert.equal(weatherPhrase(gray, none, 7).text, "Пасмурно, +3°, без дождя. Хороший день, чтобы разобрать хвосты 😌");
  assert.equal(weatherPhrase(gray, none, 7).hit, "");
});

test("ясно, мороз, метель, первый снег — свои фразы и позы; метель — с кнопками у плана", () => {
  const clear = dayWeather(day({ t: 2, code: 0 }, (h) => (h >= 12 && h < 17 ? { t: 6 } : {})), 7);
  assert.equal(clear.kind, "clear");
  const sc = weatherPhrase(clear, pickDeed(clear, PLANS, [], 7 * 60, DAY), 7);
  assert.equal(sc.text, "Солнце и +2° — для плана «Пробежка» в 08:00 погода в самый раз.");
  assert.equal(sc.pose, "happy");
  const frost = dayWeather(day({ t: -18, code: 0 }), 7);
  assert.equal(frost.kind, "frost");
  assert.equal(weatherPhrase(frost, pickDeed(frost, PLANS, [], 7 * 60, DAY), 7).text, "Брр, −18°! Пробежка в 08:00 — шапку и перчатки!");
  const storm = dayWeather(day({ t: -4 }, (h) => (h >= 12 ? { p: 2, pp: 90, code: 75, wind: 18 } : {})), 7);
  assert.equal(storm.kind, "storm");
  assert.equal(storm.danger, "метель");
  const ss = weatherPhrase(storm, pickDeed(storm, PLANS, [], 7 * 60, DAY), 7);
  assert.equal(ss.text, "С обеда метель, ветер до 18 м/с. А у вас шиномонтаж в 18:00 — может, перенесём?");
  assert.equal(ss.pose, "worried");
  const snow = dayWeather(day({ t: -1, p: 0.5, pp: 80, code: 71 }), 7);
  assert.match(weatherPhrase(snow, pickDeed(snow, [], [], 7 * 60, DAY), 7, true).text, /^Первый снег! ❄ Снег, −1°\. Одевайтесь теплее\.$/);
  assert.equal(weatherPhrase(snow, pickDeed(snow, [], [], 7 * 60, DAY), 7, true).pose, "excited");
});

test("строка модели о погоде проходит, только если все её числа есть в прогнозе", () => {
  const facts = "Казань: сейчас +3°, за день от +3° до +4°; дождь с 17:00 до 24:00; ветер до 6 м/с; под погоду попадает план «Шиномонтаж» в 18:00";
  assert.ok(weatherLineOk("После пяти пойдёт дождь, а в 18:00 у вас шиномонтаж — зонтик с собой!", facts));
  assert.ok(weatherLineOk("С 17:00 дождь, +3° — к шиномонтажу в 18:00 возьмите зонт.", facts));
  assert.ok(!weatherLineOk("Днём до +8°, вечером дождь.", facts), "выдуманные +8");
  assert.ok(!weatherLineOk("", facts));
  for (const q of ["какая погода?", "Какая сегодня погода", "а что с погодой", "погода", "Погода на сегодня?"]) assert.ok(WEATHER_ASK.test(q), q);
  for (const q of ["погода была ужасная, промок", "купить зонт от погоды"]) assert.ok(!WEATHER_ASK.test(q), q);
});

async function owner(withCity = true) {
  const store = await Store.open(":memory:");
  const u = await store.createUser({ login: "owner", passwordHash: await hashPassword("secret-pass-1"), tz: TZ });
  if (withCity) await store.updateUser(u.id, { city: JSON.stringify(KAZAN) });
  const e = { user_id: u.id, end_time: null, details: "", domain: "", message_id: null };
  await store.addEvent({ ...e, title: "Пробежка", date_iso: DAY, time: "08:00" });
  await store.addEvent({ ...e, title: "Шиномонтаж", date_iso: DAY, time: "18:00" });
  return { store, u: (await store.user(u.id))! };
}

test("погода дня: город из «О вас», один запрос на город, нет города или сети — null; первый снег — один день за сезон", async () => {
  const n = serve(RAIN_EVENING);
  const { store, u } = await owner();
  const at = zonedToUtc(DAY, "07:10", TZ);
  const w = await weatherFor(store, u, at);
  assert.equal(w?.city, "Казань");
  assert.equal(w?.plan?.title, "Шиномонтаж");
  assert.equal(w?.text, "С пяти вечера дождь. А у вас шиномонтаж в 18:00 — зонт не забудьте ☂");
  assert.match(w!.facts, /дождь с 17:00 до 24:00/);
  await weatherFor(store, u, at);
  assert.equal(n(), 1, "второй раз — из памяти");
  assert.equal(await weatherFor(store, { ...u, city: "" }, at), null);
  forgetForecasts();
  serve(null);
  assert.equal(await weatherFor(store, u, at), null, "сеть молчит — без погоды");
  serve(day({ t: -1, p: 0.5, pp: 80, code: 71 }));
  assert.match((await weatherFor(store, u, at))!.text, /^Первый снег!/);
  assert.match((await weatherFor(store, u, zonedToUtc(DAY, "09:00", TZ)))!.text, /^Первый снег!/, "весь первый день");
  forgetForecasts();
  const next = "2026-11-22";
  weatherNet.fetch = (async () => new Response(JSON.stringify({ hourly: {
    time: Array.from({ length: 24 }, (_, h) => `${next}T${String(h).padStart(2, "0")}:00`), temperature_2m: Array(24).fill(-1),
    precipitation: Array(24).fill(0.5), precipitation_probability: Array(24).fill(80), weather_code: Array(24).fill(71), wind_speed_10m: Array(24).fill(2),
  } }))) as typeof fetch;
  assert.doesNotMatch((await weatherFor(store, u, zonedToUtc(next, "07:10", TZ)))!.text, /Первый снег/, "на другой день — просто снег");
});

test("утренний список: строка погоды от модели; число не из прогноза или нет модели — фраза из заготовок", async () => {
  serve(RAIN_EVENING);
  const { store, u } = await owner();
  // morningText берёт погоду на «сейчас», поэтому прогноз — дождь весь день, чтобы проверка не зависела от часа прогона.
  serve(day({ p: 1, pp: 90, code: 63 }));
  forgetForecasts();
  let asked = "";
  const ok: LlmCall = async (m) => ((asked = String(m[1].content)), JSON.stringify({ fact: "", wish: "Спокойного дня.", weather: "Весь день дождь, +3° — зонт не забудьте." }));
  const today = (await import("../src/time.ts")).dayKey(new Date(), TZ);
  let text = await morningText(store, ok, u, today);
  assert.match(asked, /Погода \(факты\): Казань: сейчас \+3°/);
  assert.match(text, /🌧 Весь день дождь, \+3° — зонт не забудьте\./);
  const liar: LlmCall = async () => JSON.stringify({ fact: "", wish: "", weather: "Днём до +12°, солнце." });
  text = await morningText(store, liar, u, today);
  assert.doesNotMatch(text, /\+12/);
  assert.match(text, /🌧 Дождь, \+3°/, "заготовка вместо выдумки");
  text = await morningText(store, null, u, today);
  assert.match(text, /🌧 Дождь, \+3°/);
  text = await morningText(store, null, { ...u, city: "" }, today);
  assert.doesNotMatch(text, /🌧/, "без города — без погоды");
});

test("«дождь через час»: раз в день, только если план на улице попадает под дождь", async () => {
  serve(RAIN_EVENING);
  const { store, u } = await owner();
  assert.equal(await rainSoon(store, u, zonedToUtc(DAY, "15:30", TZ)), null, "до дождя больше часа");
  assert.equal(await rainSoon(store, u, zonedToUtc(DAY, "16:10", TZ)), "☂ Через час дождь, а в 18:00 «Шиномонтаж» — зонт не забудьте.");
  const sent: string[] = [];
  const sch = new Scheduler(store, null, async (_u, t) => void sent.push(t));
  await store.updateUser(u.id, { weather_rain: 1, morning_time: "23:59", tomorrow_time: "23:58", evening_time: "23:57" });
  await sch.tick(zonedToUtc(DAY, "16:10", TZ));
  await sch.tick(zonedToUtc(DAY, "16:20", TZ));
  assert.equal(sent.filter((t) => t.startsWith("☂")).length, 1);
  const off = (await owner()).store;
  const sent2: string[] = [];
  await new Scheduler(off, null, async (_u, t) => void sent2.push(t)).tick(zonedToUtc(DAY, "16:10", TZ));
  assert.equal(sent2.filter((t) => t.startsWith("☂")).length, 0, "выключено по умолчанию");
});

test("API: /api/weather, «Перенести на завтра» и обратно, «какая погода?» в чате без модели", async () => {
  serve(day({ p: 1, pp: 90, code: 63 }));
  const { store, u } = await owner();
  let llmCalls = 0;
  const pipeline = new Pipeline(store, async () => ((llmCalls++), "{}"));
  const server = createApi({ store, pipeline }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, body?: unknown, token?: string) => {
    const r = await fetch(base + path, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };
  try {
    const { json: { token } } = await call("/api/login", { login: "owner", password: "secret-pass-1" });
    const w = (await call("/api/weather", undefined, token)).json.weather;
    assert.equal(w.kind, "rain");
    assert.equal(w.icon, "🌧");
    assert.equal(w.parts.length, 3);
    assert.equal((await call("/api/me", undefined, token)).json.weather_rain, 0, "«дождь за час» выключено по умолчанию");
    assert.equal((await call("/api/settings", { weather_rain: 1 }, token)).json.weather_rain, 1, "включается в настройках");
    const today = (await import("../src/time.ts")).dayKey(new Date(), TZ);
    const e = { id: await store.addEvent({ user_id: u.id, end_time: null, details: "", domain: "", message_id: null, title: "Шиномонтаж", date_iso: today, time: "23:30" }) };
    const moved = await call("/api/weather/move", { eventId: e.id }, token);
    assert.equal(moved.status, 200, JSON.stringify(moved.json));
    assert.notEqual(moved.json.date, today);
    assert.equal((await call("/api/weather/move", { eventId: e.id }, token)).status, 404, "уже не сегодня");
    assert.equal((await call("/api/weather/move", { eventId: e.id, back: true }, token)).json.date, today, "↩ Отменить");
    const r = await pipeline.handle({ user: u, source: "web", sourceId: "w1", text: "какая погода?" });
    assert.match(r.text, /^🌧 /);
    assert.deepEqual(r.weather, { kind: "rain", sky: "rain" }, "признак погоды — виджет играет по нему сцену");
    assert.equal(llmCalls, 0, "без модели");
    const r2 = await pipeline.handle({ user: { ...u, city: "" }, source: "web", sourceId: "w2", text: "Погода?" });
    assert.match(r2.text, /из какого вы города/);
    assert.equal(r2.weather, undefined, "без прогноза — без сцены");
  } finally {
    server.close();
  }
});

test("«какая погода?» в грозу: признак погоды с danger — виджет играет дождь, а не метель", async () => {
  serve(day({ t: 26, p: 2, pp: 90, code: 95, wind: 5 }));
  const { store, u } = await owner();
  const pipeline = new Pipeline(store, async () => "{}");
  const r = await pipeline.handle({ user: u, source: "web", sourceId: "g1", text: "какая погода?" });
  assert.deepEqual(r.weather, { kind: "storm", sky: "rain", danger: "гроза" });
});
