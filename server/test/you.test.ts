import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApi, todayJson } from "../src/api.ts";
import { hashPassword } from "../src/auth.ts";
import { Store } from "../src/db.ts";
import { persona } from "../src/personas.ts";
import { Pipeline } from "../src/pipeline.ts";
import { addressRule, addressWord, callAs, findCities, saveYou, tzOffset, youView, type City } from "../src/you.ts";

// «Персонализация → О вас» (20.11.2026): обращение, город с часовым поясом, подъём и отбой — на сервере, одни на все устройства.

const EKB: City = { name: "Екатеринбург", region: "Свердловская область", country: "Россия", lat: 56.84, lon: 60.61, tz: "Asia/Yekaterinburg" };

test("обращение: хозяин по умолчанию, хозяйка, по имени — в готовых фразах и в промпте", () => {
  assert.equal(addressWord({}), "хозяин");
  assert.equal(addressWord({ address: "mistress" }), "хозяйка");
  assert.equal(addressWord({ address: "name", name: " Андрей " }), "Андрей");
  assert.equal(addressWord({ address: "name", name: "" }), "хозяин", "без имени — как было");
  assert.equal(callAs("Хозяин, вот ваши планы на завтра.", { address: "name", name: "Андрей" }), "Андрей, вот ваши планы на завтра.");
  assert.equal(callAs("Доброе утро, хозяин!", { address: "mistress" }), "Доброе утро, хозяйка!");
  assert.equal(callAs("Доброе утро, хозяин!", {}), "Доброе утро, хозяин!");
  assert.equal(callAs("на стороне хозяина", { address: "name", name: "Андрей" }), "на стороне хозяина", "другие падежи не трогаем");
  assert.equal(addressRule({}), "");
  assert.match(addressRule({ address: "name", name: "Андрей" }), /по имени — «Андрей»/);
  assert.match(addressRule({ address: "mistress" }), /женском роде/);
  const p = persona("strict", { address: "name", name: "Андрей" });
  assert.equal(p.tomorrow, "Андрей, вот ваши планы на завтра.");
  assert.match(p.voice, /по имени — «Андрей»/);
  assert.equal(persona("strict", {}).tomorrow, "Хозяин, вот ваши планы на завтра.");
});

test("часовой пояс: смещение словами", () => {
  assert.equal(tzOffset("Asia/Yekaterinburg"), "UTC+5");
  assert.equal(tzOffset("Europe/Moscow"), "UTC+3");
  assert.equal(tzOffset("Asia/Kolkata"), "UTC+5:30");
});

test("город ставит часовой пояс, стёртый город уносит его с собой, свой пояс остаётся", async () => {
  const store = await Store.open(":memory:");
  let u = await store.ensureUser("1", "Андрей", "Europe/Moscow");
  assert.deepEqual((await saveYou(store, u, { city: EKB })), { tzChanged: true });
  u = (await store.user(u.id))!;
  assert.equal(u.tz, "Asia/Yekaterinburg");
  let v = await youView(store, u);
  assert.equal(v.city?.name, "Екатеринбург");
  assert.equal(v.tz_offset, "UTC+5");
  assert.equal(v.tz_from_city, true);
  await saveYou(store, u, { city: null });
  u = (await store.user(u.id))!;
  assert.equal(u.tz, "Europe/Moscow", "пояс был от города — ушёл вместе с ним");
  // Свой пояс, потом город: пояс не трогаем.
  await saveYou(store, u, { tz: "Asia/Novosibirsk" });
  u = (await store.user(u.id))!;
  await saveYou(store, u, { city: EKB });
  u = (await store.user(u.id))!;
  assert.equal(u.tz, "Asia/Novosibirsk");
  await assert.rejects(saveYou(store, u, { tz: "Mars/Olympus" }), /пояса/);
  await assert.rejects(saveYou(store, u, { wake: 3 }), /подъём/);
  await assert.rejects(saveYou(store, u, { bed: "19:00" }), /отбоя/);
  await assert.rejects(saveYou(store, u, { address: "name", name: "  " }), /имя/);
  await saveYou(store, u, { wake: 8, bed: "23:00", address: "mistress", birthday: "1996-03-14", height: 170 });
  v = await youView(store, (await store.user(u.id))!);
  assert.deepEqual([v.wake, v.bed, v.address, v.call, v.birthday, v.height], [8, "23:00", "mistress", "хозяйка", "1996-03-14", 170]);
  assert.deepEqual(v.filled, ["city", "wake", "address", "bed", "birthday", "height", "tz"], "всё указано — 7 из 7");
  // Стереть подъём, обращение и пояс — снова по умолчанию и «не заполнено»; подъём 7 по умолчанию заполненным не считается.
  await saveYou(store, (await store.user(u.id))!, { wake: null, address: null, tz: null, city: null });
  u = (await store.user(u.id))!;
  v = await youView(store, u);
  assert.deepEqual([v.wake, v.address, v.tz], [7, "master", "Europe/Moscow"]);
  assert.deepEqual(v.filled, ["bed", "birthday", "height"]);
  await saveYou(store, u, { wake: 7 });
  assert.ok((await youView(store, (await store.user(u.id))!)).filled.includes("wake"), "7:00, выбранные самим, — заполнено");
  await store.close();
});

test("поиск города: ответ Open-Meteo → города с регионом и поясом; короткий запрос — без сети", async () => {
  let asked = "";
  const fetcher = (async (url: string) => {
    asked = url;
    return new Response(JSON.stringify({ results: [
      { name: "Екатеринбург", admin1: "Свердловская область", country: "Россия", latitude: 56.84, longitude: 60.61, timezone: "Asia/Yekaterinburg" },
      { name: "Без пояса", latitude: 1, longitude: 2 },
    ] }));
  }) as typeof fetch;
  const list = await findCities("Екат", fetcher);
  assert.match(asked, /geocoding-api\.open-meteo\.com.*name=%D0%95/);
  assert.match(asked, /language=ru/);
  assert.deepEqual(list, [EKB]);
  asked = "";
  assert.deepEqual(await findCities("Е", fetcher), []);
  assert.equal(asked, "", "по одной букве не ищем");
});

test("API: /api/you читает и пишет, /api/city подсказывает, /api/today отдаёт обращение, подъём и отбой", async () => {
  const store = await Store.open(":memory:");
  await store.createUser({ login: "owner", passwordHash: await hashPassword("secret-pass-1"), name: "Андрей", tz: "Europe/Moscow" });
  const server = createApi({ store, pipeline: new Pipeline(store, async () => "{}"), cities: async (q) => (q.startsWith("Ек") ? [EKB] : []) }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, body?: unknown, token?: string) => {
    const r = await fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };
  try {
    const { json: { token } } = await call("/api/login", { login: "owner", password: "secret-pass-1" });
    assert.equal((await call("/api/you")).status, 401);
    const v0 = (await call("/api/you", undefined, token)).json;
    assert.deepEqual([v0.address, v0.call, v0.city, v0.wake, v0.bed, v0.tz], ["master", "хозяин", null, 7, "auto", "Europe/Moscow"]);
    assert.deepEqual(v0.filled, []);
    const found = (await call("/api/city?q=" + encodeURIComponent("Екат"), undefined, token)).json;
    assert.equal(found[0].name, "Екатеринбург");
    const v1 = (await call("/api/you", { city: found[0], address: "name", wake: 8 }, token)).json;
    assert.deepEqual([v1.city.name, v1.tz, v1.tz_offset, v1.call, v1.wake], ["Екатеринбург", "Asia/Yekaterinburg", "UTC+5", "Андрей", 8]);
    assert.equal((await call("/api/you", { wake: 4 }, token)).status, 400);
    assert.equal((await call("/api/you", { address: "boss" }, token)).status, 400);
    const u = (await store.userByLogin("owner"))!;
    const t = await todayJson(store, u);
    assert.deepEqual([t.call, t.wake, t.bed], ["Андрей", 8, "auto"]);
  } finally {
    server.close();
    await store.close();
  }
});
