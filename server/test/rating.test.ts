import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApi } from "../src/api.ts";
import { hashPassword } from "../src/auth.ts";
import { Store } from "../src/db.ts";
import type { ChatMessage, LlmCall } from "../src/llm.ts";
import { Pipeline } from "../src/pipeline.ts";
import { rateButtons, rateDay, Scheduler, type Button } from "../src/scheduler.ts";
import { zonedToUtc } from "../src/time.ts";

// Оценка дня под вечерним итогом: 😞 😐 🙂 😄 → показатель «Оценка дня» (rating_day, /10), одна на день.

const DAY = "2026-11-14";
const TZ = "Europe/Moscow";

async function setup() {
  const store = await Store.open(":memory:");
  const u = await store.createUser({ login: "owner", passwordHash: await hashPassword("secret-pass-1"), tz: TZ });
  return { store, u };
}
const ratings = async (store: Store, userId: number, day = DAY) => (await store.metricsRange(userId, day, day, "rating_day")).map((m) => m.value);

test("оценка дня: четыре смайлика, нажатие пишет «Оценку дня», повторное — заменяет", async () => {
  const { store, u } = await setup();
  const b = rateButtons(DAY);
  assert.deepEqual(b.map((x) => x.text), ["😞", "😐", "🙂", "😄"]);
  assert.deepEqual(b.map((x) => x.data), ["rate:2026-11-14:3", "rate:2026-11-14:5", "rate:2026-11-14:7", "rate:2026-11-14:9"]);
  assert.match(await rateDay(store, u, DAY, 7), /🙂 7\/10/);
  assert.match(await rateDay(store, u, DAY, 9), /😄 9\/10/);
  assert.deepEqual(await ratings(store, u.id), [9]);
  const [m] = await store.metricsRange(u.id, DAY, DAY, "rating_day");
  assert.equal(m.label, "Оценка дня");
  assert.equal(m.unit, "/10");
  await assert.rejects(rateDay(store, u, DAY, 4));
});

test("оценка дня: вечерний итог уходит с кнопками, итог видит оценки прошлых дней", async () => {
  const { store, u } = await setup();
  await rateDay(store, u, "2026-11-12", 3);
  let seen: ChatMessage[] = [];
  const llm: LlmCall = async (m) => ((seen = m), "Хороший день.");
  const sent: { text: string; buttons?: Button[] }[] = [];
  const sch = new Scheduler(store, llm, async (_u, text, _e, buttons) => void sent.push({ text, buttons }));
  await sch.tick(zonedToUtc(DAY, "22:01", TZ));
  const ev = sent.find((x) => /Итог дня/.test(x.text));
  assert.ok(ev, "итога нет");
  assert.deepEqual(ev.buttons?.map((x) => x.data), rateButtons(DAY).map((x) => x.data));
  assert.match(seen.map((m) => m.content).join("\n"), /2026-11-12 Оценка дня: 3\/10/);
});

test("оценка дня: кнопка в виджете (/api/rate)", async () => {
  const { store, u } = await setup();
  const server = createApi({ store, pipeline: new Pipeline(store, async () => "{}") }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, body: unknown, token?: string) => {
    const r = await fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };
  try {
    const { json: { token } } = await call("/api/login", { login: "owner", password: "secret-pass-1" });
    const r = await call("/api/rate", { day: DAY, value: 5 }, token);
    assert.equal(r.status, 200);
    assert.match(r.json.text, /😐 5\/10/);
    assert.deepEqual(await ratings(store, u.id), [5]);
    assert.equal((await call("/api/rate", { day: DAY, value: 6 }, token)).status, 400);
    assert.equal((await call("/api/rate", { day: "вчера", value: 5 }, token)).status, 400);
    assert.equal((await call("/api/rate", { day: DAY, value: 5 })).status, 401);
  } finally {
    server.close();
  }
});
