import assert from "node:assert/strict";
import { test } from "node:test";
import { hashPassword } from "../src/auth.ts";
import { Store } from "../src/db.ts";
import type { ChatMessage } from "../src/llm.ts";
import { dayNumbers, EVENING_MAX, Scheduler } from "../src/scheduler.ts";

// Вечерний итог — коротко: строка цифр и 2–3 предложения горничной; записи дня не пересказываются.

const DAY = "2026-11-13";

async function setup() {
  const store = await Store.open(":memory:");
  const u = await store.createUser({ login: "owner", passwordHash: await hashPassword("secret-pass-1"), tz: "Europe/Moscow" });
  await store.addDiary(u.id, DAY, "food", "Жареные пельмени.", null);
  await store.addDiary(u.id, DAY, "food", "Солёные семечки.", null);
  await store.addDiary(u.id, DAY, "health", "Чешутся руки.", null);
  await store.addDiary(u.id, "2026-11-10", "health", "Чешется шея после острого.", null);
  await store.addDiary(u.id, "2026-11-01", "health", "Запись старше недели.", null);
  await store.upsertActivity({ user_id: u.id, day_key: DAY, source: "pc", active_sec: 7200, afk_sec: 0, apps: [], games: [{ name: "Dota", sec: 7200 }] });
  return { store, u };
}

test("итог дня: цифры строкой, записи дня не перечисляются, без ИИ — только цифры", async () => {
  const { store, u } = await setup();
  const text = await new Scheduler(store, null, async () => {}).eveningText(u, DAY);
  assert.match(text, /^<b>Итог дня, /);
  assert.match(text, /🎮 2 ч/);
  assert.match(text, /📝 3 записи/);
  assert.doesNotMatch(text, /пельмени|семечки|Чешутся/);
  assert.equal(text.split("\n").length, 2);
});

test("итог дня: горничная видит факты дня и прошлые 6 дней, человеку — её 2–3 предложения одной строкой", async () => {
  const { store, u } = await setup();
  let seen: ChatMessage[] = [];
  const llm = async (m: ChatMessage[]) => {
    seen = m;
    return "Руки чешутся второй раз за неделю после острого.\nЗавтра без острого и запиши, как будет.";
  };
  const text = await new Scheduler(store, llm, async () => {}).eveningText(u, DAY);
  const ask = seen.map((m) => m.content).join("\n");
  assert.match(ask, /пельмени/); // подробности дня — горничной
  assert.match(ask, /Чешется шея после острого/); // и записи за неделю
  assert.doesNotMatch(ask, /старше недели/);
  assert.match(ask, /НЕ пересказывай/);
  const [head, numbers, blank, words, ...rest] = text.split("\n");
  assert.match(head, /Итог дня/);
  assert.match(numbers, /🎮/);
  assert.equal(blank, "");
  assert.equal(words, "Руки чешутся второй раз за неделю после острого. Завтра без острого и запиши, как будет.");
  assert.equal(rest.length, 0);
  assert.doesNotMatch(text, /пельмени/);
});

test("итог дня: слишком длинный ответ обрезается по слову, ошибка ИИ — остаются цифры", async () => {
  const { store, u } = await setup();
  const long = "слово ".repeat(200);
  const cut = await new Scheduler(store, async () => long, async () => {}).eveningText(u, DAY);
  const words = cut.split("\n\n")[1];
  assert.ok(words.length <= EVENING_MAX * 1.5 + 1, String(words.length));
  assert.match(words, /слово…$/);
  const failed = await new Scheduler(store, async () => { throw new Error("нет связи"); }, async () => {}).eveningText(u, DAY);
  assert.equal(failed.split("\n").length, 2);
});

test("итог дня: строка цифр — только то, что было", () => {
  assert.equal(dayNumbers({ tasks: 0, habitsDone: 0, habits: 0, gameSec: 30, notes: 0, spent: [] }), "");
  assert.equal(
    dayNumbers({ tasks: 3, habitsDone: 3, habits: 3, gameSec: 5400, notes: 1, spent: ["−1 200 RUB"] }),
    "✔ 3 задачи · привычки 3/3 · 🎮 1 ч 30 мин · 📝 1 запись · 💸 −1 200 RUB",
  );
});
