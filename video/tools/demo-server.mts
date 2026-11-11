// Демо-сервер для съёмки полной версии: настоящий API и собранный сайт на временной базе с вымышленным месяцем.
// Запуск из корня: npx tsx video/tools/demo-server.mts [порт]   → печатает ключ входа (localStorage maid.token).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApi } from "../../server/src/api.ts";
import { issueToken } from "../../server/src/auth.ts";
import { recordActivity } from "../../server/src/activity.ts";
import { Store } from "../../server/src/db.ts";
import { Pipeline } from "../../server/src/pipeline.ts";
import { addDays, dayKey } from "../../server/src/time.ts";

const TZ = "Europe/Moscow";
const port = Number(process.argv[2] ?? 3399);
const file = path.join(os.tmpdir(), `maid-demo-${port}.db`);
for (const f of [file, file + "-wal", file + "-shm"]) fs.rmSync(f, { force: true });
const store = await Store.open(file);
const u = await store.ensureUser("demo", "Алекс", TZ);
const today = dayKey(new Date(), TZ);

// Один и тот же «случайный» месяц при каждом запуске.
let seed = 20261111;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
const hm = (h: number) => { const v = ((h % 24) + 24) % 24; const m = Math.round((v % 1) * 60 / 5) * 5; return `${Math.floor(v) + (m === 60 ? 1 : 0)}:${String(m === 60 ? 0 : m).padStart(2, "0")}`; };

const FOOD = ["Овсянка с бананом, кофе. На обед борщ, вечером паста с курицей.", "Сырники на завтрак. Обед в столовой — плов. Ужин: салат и рыба.",
  "Яичница, тост с авокадо. Днём суп, вечером заказал роллы.", "Гречка с котлетой, йогурт. Вечером омлет и чай с лимоном.", "Блины у мамы. Потом почти не ел, только яблоко и орехи."];
const NOTES = ["Весь день разбирал почту и наконец закрыл отчёт. Вечером гулял в парке.", "Созвон с командой затянулся, зато договорились по срокам. Купил новую лампу на стол.",
  "Съездил к родителям, помог с полкой. Кот Борис опять уронил цветок.", "Дочитал книгу про привычки. Записался к стоматологу на следующую неделю.",
  "Сходили с Катей в кино, фильм так себе, зато попкорн хороший.", "Убрался в квартире, выкинул три пакета хлама. Сразу дышать легче.", "Починил велосипед и проехал до набережной. Ветер, но красиво."];
const SPORT = ["Пробежал 5 км за 29 минут.", "Зал: спина и руки, 50 минут.", "Йога на балконе, 20 минут.", "Плавание, 1 км.", "Турник и планка, коротко."];
const MOOD = ["Спокойный, ровный день.", "Устал, но доволен.", "С утра раздражён, к вечеру отпустило.", "Отличное настроение, всё получается."];
const HOBBY = ["Час играл на гитаре, разучил новый бой.", "Собирал модель корабля, приклеил мачты.", "Рисовал акварелью закат."];
const APPS = ["Code.exe", "chrome.exe", "Telegram.exe", "Figma.exe", "Notion.exe", "explorer.exe", "Spotify.exe"];
const GAMES = ["Counter-Strike 2", "Dota 2", "Baldur's Gate 3", "Stardew Valley"];

for (let i = 72; i >= 0; i--) {
  const day = addDays(today, -i);
  const dow = new Date(day + "T12:00:00Z").getUTCDay();
  const weekend = dow === 0 || dow === 6;
  const bed = (weekend ? 24.6 : 23.4) + (rnd() - 0.4) * 1.6;
  const hours = Math.round(((weekend ? 8.6 : 7.3) + (rnd() - 0.5) * 1.6) * 2) / 2;
  if (i > 0) {
    await store.addDiary(u.id, day, "sleep", `Лёг в ${hm(bed)}, встал в ${hm(bed + hours)}. ${pick(["Выспался.", "Долго не мог уснуть.", "Снилось море.", "Встал бодрым.", "Хотелось ещё полежать."])}`, null);
    await store.addMetric({ user_id: u.id, day_key: day, key: "sleep_hours", label: "Сон", value: hours, unit: "ч", note: "", source: "diary", message_id: null });
    await store.addDiary(u.id, day, "food", pick(FOOD), null);
    await store.addDiary(u.id, day, "notes", pick(NOTES), null);
    if (rnd() < 0.55) await store.addDiary(u.id, day, "sport", pick(SPORT), null);
    if (rnd() < 0.5) await store.addDiary(u.id, day, "mood", pick(MOOD), null);
    if (rnd() < 0.25) await store.addDiary(u.id, day, "hobby", pick(HOBBY), null);
    if (rnd() < 0.5) await store.addMetric({ user_id: u.id, day_key: day, key: "steps", label: "Шаги", value: Math.round(4000 + rnd() * 8000), unit: "", note: "", source: "phone", message_id: null });
  }
  const active = Math.round(((weekend ? 3.5 : 7) + (rnd() - 0.5) * 3) * 3600);
  const game = Math.round((weekend ? 1.5 + rnd() * 2.5 : rnd() < 0.5 ? rnd() * 1.6 : 0) * 3600);
  const share = [0.34, 0.24, 0.12, 0.1, 0.08, 0.07, 0.05];
  await recordActivity(store, u, { day, source: "pc", active_sec: Math.min(86000, active + game), afk_sec: Math.round(rnd() * 5400),
    apps: APPS.map((name, k) => ({ name, sec: Math.round(active * share[k] * (0.7 + rnd() * 0.6)) })),
    games: game ? [{ name: pick(GAMES), sec: Math.round(game * 0.7) }, { name: pick(GAMES), sec: Math.round(game * 0.3) }].filter((g, k, a) => a.findIndex((x) => x.name === g.name) === k) : [] });
}
await store.addEvent({ user_id: u.id, title: "Встреча с Петей", date_iso: addDays(today, 1), time: "15:00", end_time: "16:00", details: "", message_id: null } as never).catch(() => {});
await store.addTask({ user_id: u.id, title: "Купить лампочку", priority: "normal", category: "", due_date: null, notes: "", message_id: null });
await store.addTask({ user_id: u.id, title: "Полить кактус Геннадия", priority: "normal", category: "", due_date: today, notes: "", message_id: null });

const token = await issueToken(store, u.id, "demo");
const pipeline = new Pipeline(store, async () => "{}");
createApi({ store, pipeline, webDir: path.resolve("web/dist") }).listen(port, "127.0.0.1", () => {
  console.log(`DEMO http://127.0.0.1:${port} token=${token}`);
});
