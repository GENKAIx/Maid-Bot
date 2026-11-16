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

test("итог дня: цифры по пунктам, записи дня не перечисляются, без ИИ — только цифры", async () => {
  const { store, u } = await setup();
  const text = await new Scheduler(store, null, async () => {}).eveningText(u, DAY);
  assert.match(text, /^<b>Итог дня, /);
  assert.match(text, /🎮 2 ч/);
  assert.match(text, /📝 3 записи/);
  assert.doesNotMatch(text, /пельмени|семечки|Чешутся/);
  // Заголовок и по строке на каждую цифру: игры и записи — отдельными пунктами, а не через « · ».
  const [head, ...items] = text.split("\n");
  assert.match(head, /Итог дня/);
  assert.deepEqual(items, ["🎮 2 ч", "📝 3 записи"]);
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
  const [top, tail, ...more] = text.split("\n\n");
  const [head, ...numbers] = top.split("\n");
  const [words, ...rest] = tail.split("\n");
  assert.equal(more.length, 0);
  assert.match(head, /Итог дня/);
  assert.ok(numbers.includes("🎮 2 ч"), numbers.join(" | "));
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
  assert.doesNotMatch(failed, /\n\n/); // без слов горничной — только заголовок и пункты
  assert.match(failed, /\n🎮 2 ч/);
});

test("итог дня: пункты цифр — только то, что было, каждый своей строкой", () => {
  assert.equal(dayNumbers({ tasks: 0, habitsDone: 0, habits: 0, gameSec: 30, notes: 0, spent: [] }), "");
  assert.equal(
    dayNumbers({ tasks: 3, habitsDone: 3, habits: 3, gameSec: 5400, notes: 1, spent: ["−1 200 RUB"] }),
    "✔ 3 задачи\n🔁 привычки 3/3\n🎮 1 ч 30 мин\n📝 1 запись\n💸 −1 200 RUB",
  );
});

test("итог дня: ответ ИИ оборван на полуслове — остаются законченные предложения, без начатого ничего", async () => {
  const { store, u } = await setup();
  const torn = "Уборка и нос снова вместе. Завтра наденьте маску. Если заложенность продержится, покажит";
  const words = (await new Scheduler(store, async () => torn, async () => {}).eveningText(u, DAY)).split("\n\n")[1];
  assert.equal(words, "Уборка и нос снова вместе. Завтра наденьте маску.");
  const none = await new Scheduler(store, async () => "Уборка и нос снова вместе и завтра", async () => {}).eveningText(u, DAY);
  assert.doesNotMatch(none, /\n\n|Уборка/, "начатое предложение без конца показано");
  const done = (await new Scheduler(store, async () => "Хороший день! Так держать…", async () => {}).eveningText(u, DAY)).split("\n\n")[1];
  assert.equal(done, "Хороший день! Так держать…");
  const quote = (await new Scheduler(store, async () => "Ты сказал «устал».", async () => {}).eveningText(u, DAY)).split("\n\n")[1];
  assert.equal(quote, "Ты сказал «устал».");
});
