import assert from "node:assert/strict";
import { test } from "node:test";
import { hashPassword } from "../src/auth.ts";
import { Store } from "../src/db.ts";
import type { ChatMessage, LlmCall } from "../src/llm.ts";
import { STOIC, stoicOfDay } from "../src/morning.ts";
import { Scheduler } from "../src/scheduler.ts";
import { zonedToUtc } from "../src/time.ts";

// Утро (15.11.2026): дата и строка про день от модели, все планы на сегодня, задачи только на сегодня (и просроченные),
// мысль стоиков из своего списка. Привычки, «Скоро», дневник и прочее — в полной сводке «сегодня», не утром.

const DAY = "2026-11-15";
const TZ = "Europe/Moscow";

async function morning(llm: LlmCall | null) {
  const store = await Store.open(":memory:");
  const u = await store.createUser({ login: "owner", passwordHash: await hashPassword("secret-pass-1"), tz: TZ });
  const ev = { user_id: u.id, end_time: null, details: "", domain: "", message_id: null };
  await store.addEvent({ ...ev, title: "Поездка к родителям", date_iso: DAY, time: "11:15" });
  await store.addEvent({ ...ev, title: "Купить воды", date_iso: DAY, time: "16:00" });
  await store.addEvent({ ...ev, title: "Кино завтра", date_iso: "2026-11-16", time: "19:00" });
  const task = { user_id: u.id, priority: "normal", category: "", notes: "", message_id: null };
  await store.addTask({ ...task, title: "Задача на сегодня", due_date: DAY });
  await store.addTask({ ...task, title: "Старая задача", due_date: "2026-11-12" });
  await store.addTask({ ...task, title: "Задача на среду", due_date: "2026-11-18" });
  await store.addTask({ ...task, title: "Задача без срока", due_date: null });
  await store.addHabit({ user_id: u.id, title: "Пить воду", days: "1234567", times: "[]", start_date: "2026-11-01", end_date: null, message_id: null });
  const sent: string[] = [];
  const sch = new Scheduler(store, llm, async (_u, text) => void sent.push(text));
  await sch.tick(zonedToUtc(DAY, "09:05", TZ));
  return sent.filter((t) => t.includes("Доброе утро"));
}

test("утро: дата, строка про день, планы, задачи на сегодня, мысль стоиков — по порядку", async () => {
  let asked: ChatMessage[] = [];
  const [text] = await morning(async (m) => ((asked = m), "Сегодня День философии — самое время подумать.\n"));
  assert.ok(text, "утро не пришло");
  const at = (s: string) => text.indexOf(s);
  for (const s of ["15 ноября", "День философии", "Планы", "Поездка к родителям", "Купить воды", "Задачи", "Задача на сегодня", "Старая задача", "—"])
    assert.ok(at(s) >= 0, `в утре нет «${s}»:\n${text}`);
  assert.ok(at("15 ноября") < at("День философии") && at("День философии") < at("Планы") && at("Планы") < at("Задачи"), text);
  const quote = stoicOfDay(DAY);
  assert.ok(text.endsWith(`— ${quote.who}`) && at(quote.text) > at("Задачи"), `мысль стоиков не в конце:\n${text}`);
  for (const s of ["Кино завтра", "Задача на среду", "Задача без срока", "Привычки", "Скоро"]) assert.ok(at(s) < 0, `в утре лишнее «${s}»:\n${text}`);
  assert.match(String(asked[0]?.content), /15 ноября/);
  assert.match(String(asked[0]?.content), /уверен/);
});

test("утро без модели или при её ошибке — приходит без строки про день", async () => {
  for (const llm of [null, (async () => { throw new Error("сеть"); }) as LlmCall]) {
    const [text] = await morning(llm);
    assert.ok(text?.includes("Поездка к родителям") && text.includes(`— ${stoicOfDay(DAY).who}`), text);
  }
});

test("мысль стоиков: своя каждый день, подписи — Марк Аврелий, Сенека, Эпиктет, повтор не раньше чем через два месяца", () => {
  assert.ok(STOIC.length >= 60);
  assert.ok(STOIC.every((q) => ["Марк Аврелий", "Сенека", "Эпиктет"].includes(q.who) && q.text.length <= 200));
  const days = Array.from({ length: 60 }, (_, i) => stoicOfDay(new Date(Date.UTC(2026, 10, 1 + i)).toISOString().slice(0, 10)).text);
  assert.equal(new Set(days).size, 60);
});
