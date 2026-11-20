import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApi, todayJson } from "../src/api.ts";
import { hashPassword } from "../src/auth.ts";
import { Store } from "../src/db.ts";
import { persona } from "../src/personas.ts";
import { Pipeline } from "../src/pipeline.ts";
import { aboutOffer, addressRule, addressWord, askNext, askShown, callAs, findCities, saveYou, tzOffset, youButton, youView, type City } from "../src/you.ts";

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
  // Пояс выбран самим и совпал с поясом города — стёртый город его не уносит.
  await saveYou(store, u, { tz: "Asia/Yekaterinburg" });
  u = (await store.user(u.id))!;
  await saveYou(store, u, { city: null });
  u = (await store.user(u.id))!;
  assert.equal(u.tz, "Asia/Yekaterinburg", "свой пояс остаётся");
  await saveYou(store, u, { tz: null });
  u = (await store.user(u.id))!;
  await saveYou(store, u, { city: EKB });
  u = (await store.user(u.id))!;
  assert.equal(u.tz, "Asia/Yekaterinburg", "свой пояс стёрли — город снова ставит свой");
  await assert.rejects(saveYou(store, u, { tz: "Mars/Olympus" }), /пояса/);
  await assert.rejects(saveYou(store, u, { wake: 3 }), /подъём/);
  await assert.rejects(saveYou(store, u, { bed: "12:30" }), /отбой/);
  await assert.rejects(saveYou(store, u, { address: "name", name: "  " }), /имя/);
  await saveYou(store, u, { wake: 8, bed: "23:00", address: "mistress", birthday: "1996-03-14", height: 170 });
  v = await youView(store, (await store.user(u.id))!);
  assert.deepEqual([v.wake, v.bed, v.address, v.call, v.birthday, v.height], ["08:00", "23:00", "mistress", "хозяйка", "1996-03-14", 170]);
  assert.deepEqual(v.filled, ["city", "wake", "address", "bed", "birthday", "height", "tz"], "всё указано — 7 из 7");
  // Стереть подъём, обращение и пояс — снова по умолчанию и «не заполнено»; подъём 7 по умолчанию заполненным не считается.
  await saveYou(store, (await store.user(u.id))!, { wake: null, address: null, tz: null, city: null });
  u = (await store.user(u.id))!;
  v = await youView(store, u);
  assert.deepEqual([v.wake, v.address, v.tz], ["07:00", "master", "Europe/Moscow"]);
  assert.deepEqual(v.filled, ["bed", "birthday", "height"]);
  await saveYou(store, u, { wake: 7 });
  assert.ok((await youView(store, (await store.user(u.id))!)).filled.includes("wake"), "7:00, выбранные самим, — заполнено");
  await store.close();
});

test("свой подъём и отбой (20.11.2026): любое время с минутами в своих границах; прежний час в базе читается как час", async () => {
  const store = await Store.open(":memory:");
  let u = await store.createUser({ login: "own", passwordHash: "x", name: "Тест", tz: "Europe/Moscow" });
  await saveYou(store, u, { wake: "06:30", bed: "23:45" });
  u = (await store.user(u.id))!;
  assert.equal(u.wake, 390, "в базе — минуты");
  let v = await youView(store, u);
  assert.deepEqual([v.wake, v.bed], ["06:30", "23:45"]);
  assert.deepEqual(v.filled, ["wake", "bed"]);
  let t = await todayJson(store, u);
  assert.deepEqual([t.wake, t.wake_at, t.bed], [6, "06:30", "23:45"], "старый виджет — час, новый — с минутами");
  // Границы: подъём 04:00–11:59, отбой 18:00–03:59 или «сама».
  for (const ok of ["04:00", "11:59"]) await saveYou(store, u, { wake: ok });
  for (const bad of ["03:59", "12:00", "6:30", "25:00", "утро"]) await assert.rejects(saveYou(store, u, { wake: bad }), /подъём/, bad);
  for (const ok of ["18:00", "03:59", "00:15", "auto"]) await saveYou(store, u, { bed: ok });
  for (const bad of ["17:59", "04:00", "12:00", "23:5"]) await assert.rejects(saveYou(store, u, { bed: bad }), /отбой/, bad);
  // Час числом (кнопки облачка, «встаю в 7», перенос со старого виджета) — как раньше.
  await saveYou(store, u, { wake: 9 });
  assert.equal((await youView(store, (await store.user(u.id))!)).wake, "09:00");
  // Запись до 20.11.2026 — час (и 7 по умолчанию у новых): читается как час.
  await store.updateUser(u.id, { wake: 8 });
  u = (await store.user(u.id))!;
  assert.equal((await youView(store, u)).wake, "08:00");
  t = await todayJson(store, u);
  assert.deepEqual([t.wake, t.wake_at], [8, "08:00"]);
  const fresh = await store.createUser({ login: "own2", passwordHash: "x", name: "Новый", tz: "Europe/Moscow" });
  assert.equal((await youView(store, fresh)).wake, "07:00");
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
    assert.deepEqual([v0.address, v0.call, v0.city, v0.wake, v0.bed, v0.tz], ["master", "хозяин", null, "07:00", "auto", "Europe/Moscow"]);
    assert.deepEqual(v0.filled, []);
    const found = (await call("/api/city?q=" + encodeURIComponent("Екат"), undefined, token)).json;
    assert.equal(found[0].name, "Екатеринбург");
    const v1 = (await call("/api/you", { city: found[0], address: "name", wake: 8 }, token)).json;
    assert.deepEqual([v1.city.name, v1.tz, v1.tz_offset, v1.call, v1.wake], ["Екатеринбург", "Asia/Yekaterinburg", "UTC+5", "Андрей", "08:00"]);
    assert.equal((await call("/api/you", { wake: 3 }, token)).status, 400);
    assert.equal((await call("/api/you", { wake: "12:30" }, token)).status, 400);
    assert.equal((await call("/api/you", { wake: "07:40" }, token)).json.wake, "07:40", "своё время с сайта");
    await call("/api/you", { wake: "08:00" }, token);
    assert.equal((await call("/api/you", { address: "boss" }, token)).status, 400);
    const u = (await store.userByLogin("owner"))!;
    const t = await todayJson(store, u);
    assert.deepEqual([t.call, t.wake, t.wake_at, t.bed], ["Андрей", 8, "08:00", "auto"]);
    // Город и подъём указаны, обращение по имени выбрано — вопросов нет; стёрли обращение — облачко спросит его.
    assert.equal(t.ask, null);
    await call("/api/you", { address: null }, token);
    const t2 = await todayJson(store, (await store.userByLogin("owner"))!);
    assert.equal(t2.ask?.field, "address");
    assert.deepEqual((await call("/api/you/ask", { field: "address" }, token)).json, { ok: true });
    assert.equal((await todayJson(store, (await store.userByLogin("owner"))!)).ask, null, "показали — 3 дня тишины");
    assert.equal((await call("/api/you/button", { data: "you:address:mistress" }, token)).json.text, "Хорошо, хозяйка 🙂");
    assert.equal((await call("/api/you/button", { data: "you:nope:1" }, token)).status, 400);
  } finally {
    server.close();
    await store.close();
  }
});

test("Рина спрашивает в облачке: город → подъём → обращение, раз в 3 дня, «Не скажу» — больше никогда", async () => {
  const store = await Store.open(":memory:");
  let u = await store.ensureUser("1", "Андрей", "Europe/Moscow");
  const t0 = new Date("2026-11-20T10:00:00Z");
  assert.equal(askNext(u, t0)?.field, "city");
  assert.deepEqual(askNext(u, t0)!.buttons.map((b) => b.data), ["you:city:later", "you:city:never"]);
  assert.equal(await askShown(store, u, "wake", t0), false, "не тот вопрос — не отмечаем");
  assert.equal(await askShown(store, u, "city", t0), true);
  u = (await store.user(u.id))!;
  assert.equal(askNext(u, new Date(t0.getTime() + 2 * 86_400_000)), null, "через 2 дня — рано");
  const t3 = new Date(t0.getTime() + 3 * 86_400_000);
  assert.equal(askNext(u, t3)?.field, "city", "через 3 дня — снова город (не ответили)");
  assert.match((await youButton(store, u, "you:city:never", t3)).text, /больше не спрашиваю/);
  u = (await store.user(u.id))!;
  const t6 = new Date(t3.getTime() + 3 * 86_400_000);
  const wake = askNext(u, t6)!;
  assert.equal(wake.field, "wake", "город — «Не скажу», дальше подъём");
  assert.ok(wake.buttons.some((b) => b.data === "you:wake:8"));
  assert.match((await youButton(store, u, "you:wake:8", t6)).text, /до 8:00/);
  u = (await store.user(u.id))!;
  assert.equal(u.wake, 480);
  const t9 = new Date(t6.getTime() + 3 * 86_400_000);
  const addr = askNext(u, t9)!;
  assert.equal(addr.field, "address");
  assert.ok(addr.buttons.some((b) => b.data === "you:address:name" && b.text.includes("Андрей")));
  assert.equal((await youButton(store, u, "you:address:name", t9)).text, "Хорошо, Андрей 🙂");
  u = (await store.user(u.id))!;
  assert.equal(askNext(u, new Date(t9.getTime() + 30 * 86_400_000)), null, "всё отвечено — не спрашивает");
  await assert.rejects(youButton(store, u, "you:tz:never"), /неизвестная кнопка/);
  await store.close();
});

test("«Записать в профиль?»: город и подъём из разговора, Да — записано и пояс по городу, Нет — ничего", async () => {
  const store = await Store.open(":memory:");
  let u = await store.ensureUser("1", "Андрей", "Europe/Moscow");
  const cities = async (q: string) => (q === "Екатеринбург" ? [EKB] : []);
  const o = (await aboutOffer(store, u, { city: "Екатеринбург", wake: 7 }, cities))!;
  assert.equal(o.text, "Записать в профиль: город — Екатеринбург (Свердловская область), часы — по UTC+5, подъём — 7:00?");
  const [yes, no] = o.buttons.map((b) => b.data);
  assert.match(yes, /^you:offer:y\w+$/);
  assert.equal(no, yes.replace(":y", ":n"));
  const r = await youButton(store, u, yes);
  assert.equal(r.tzChanged, true);
  assert.match(r.text, /Записала в профиль: город Екатеринбург, подъём 7:00\. Часы теперь по UTC\+5/);
  u = (await store.user(u.id))!;
  assert.equal(u.tz, "Asia/Yekaterinburg");
  assert.ok((await youView(store, u)).filled.includes("wake"), "подъём 7:00, подтверждённый человеком, — заполнен");
  assert.equal((await youButton(store, u, yes)).text, "Это уже решили.", "второе нажатие — ничего");
  assert.equal(await aboutOffer(store, u, { city: "екатеринбург", wake: 7 }, cities), null, "уже так в профиле — не спрашивает");
  assert.equal(await aboutOffer(store, u, { city: "Атлантида" }, cities), null, "город не нашёлся — молчит");
  // Два предложения подряд: «Да» под первым записывает своё, а не второе.
  const o9 = (await aboutOffer(store, u, { wake: 9 }, cities))!;
  const o10 = (await aboutOffer(store, u, { wake: 10 }, cities))!;
  assert.equal((await youButton(store, u, o9.buttons[1].data)).text, "Хорошо, не записываю.");
  assert.equal((await store.user(u.id))!.wake, 420);
  await youButton(store, u, o10.buttons[0].data);
  assert.equal((await store.user(u.id))!.wake, 600, "второе предложение — своё");
  // Свой пояс: текст не обещает сменить часы, и «Да» их не меняет.
  await saveYou(store, (await store.user(u.id))!, { city: null, tz: "Europe/Samara" });
  u = (await store.user(u.id))!;
  const kzn: City = { name: "Казань", region: "Татарстан", country: "Россия", lat: 55.79, lon: 49.12, tz: "Europe/Moscow" };
  const ok = (await aboutOffer(store, u, { city: "Казань" }, async () => [kzn]))!;
  assert.equal(ok.text, "Записать в профиль: город — Казань (Татарстан)?");
  const rk = await youButton(store, u, ok.buttons[0].data);
  assert.equal(rk.tzChanged, false);
  assert.equal((await store.user(u.id))!.tz, "Europe/Samara");
  await store.close();
});

test("разговор: «я из Екатеринбурга, встаю в 7» — разбор кладёт about, горничная отдельно спрашивает «Записать в профиль?»", async () => {
  const store = await Store.open(":memory:");
  const u = await store.ensureUser("1", "Андрей", "Europe/Moscow");
  const pipe = new Pipeline(store, async () => JSON.stringify({ summary: "о себе", about: { city: "Екатеринбург", wake: "7:00" }, reply: "Приятно познакомиться!" }));
  pipe.cities = async (q) => (q === "Екатеринбург" ? [EKB] : []);
  pipe.aboutDelayMs = 0;
  const sent: { text: string; data: string[] }[] = [];
  pipe.onAbout = async (_u, text, buttons) => void sent.push({ text, data: buttons.map((b) => b.data) });
  const r = await pipe.handle({ user: u, source: "telegram", sourceId: "1", text: "я из Екатеринбурга, встаю в 7", at: new Date("2026-11-20T08:00:00Z") });
  assert.match(r.text, /Приятно познакомиться/);
  assert.equal(sent.length, 0, "вопрос — после ответа, ответ его не ждёт");
  await pipe.aboutJob;
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /^Записать в профиль: город — Екатеринбург.*подъём — 7:00\?$/);
  assert.match(sent[0].data.join(" "), /^you:offer:y\w+ you:offer:n\w+$/);
  // Без about — ничего не спрашивает.
  const pipe2 = new Pipeline(store, async () => JSON.stringify({ summary: "чай", reply: "Записала" }));
  pipe2.onAbout = pipe.onAbout;
  await pipe2.handle({ user: u, source: "telegram", sourceId: "2", text: "выпил чаю", at: new Date("2026-11-20T08:05:00Z") });
  assert.equal(sent.length, 1);
  await store.close();
});
