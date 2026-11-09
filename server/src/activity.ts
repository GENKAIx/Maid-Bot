import { z } from "zod";
import type { Store, User } from "./db.ts";
import type { Send } from "./scheduler.ts";
import { durationHuman, isDayKey } from "./time.ts";

// Активность с трекера ПК (десктоп читает ActivityWatch). Игры в дневник пишет только он.
// Шаги сюда больше не идут: они — показатель дня (POST /api/steps с айфона).

const Item = z.object({ name: z.string().min(1).max(120), sec: z.number().int().min(0).max(86400) });
export const ActivityInput = z.object({
  day: z.string().refine(isDayKey, "день YYYY-MM-DD"),
  source: z.string().min(1).max(40).default("pc"),
  active_sec: z.number().int().min(0).max(86400),
  afk_sec: z.number().int().min(0).max(86400).default(0),
  apps: z.array(Item).max(50).default([]),
  games: z.array(Item).max(50).default([]),
});
export type ActivityInput = z.infer<typeof ActivityInput>;

/** Ключ программы для иконки: без .exe, регистра и знаков — «Counter-Strike 2» и «counterstrike2.exe» совпадут. */
export function iconKey(name: string) {
  return name.toLowerCase().replace(/\.exe$/, "").replace(/[^\p{L}\p{N}]+/gu, "");
}
export const IconsInput = z.object({
  icons: z.array(z.object({ name: z.string().min(1).max(120), png: z.string().regex(/^[A-Za-z0-9+/=]+$/).max(24_000) })).max(60),
});

const GAME_LINES = {
  strict: (t: string) => `🎮 Уже ${t} в играх. Сделайте перерыв: вода, глаза, спина.`,
  kind: (t: string) => `🎮 Ты играешь уже ${t}. Может, чай и пять минут отдыха?`,
  sassy: (t: string) => `🎮 ${t} в играх. Мир снаружи ещё существует, если что.`,
  chill: (t: string) => `🎮 ${t} в игре. Норм, но потянись хоть.`,
} as Record<string, (t: string) => string>;

/** Пороги игр за день в минутах: первый, потом каждые N (по умолчанию 2 ч, 4 ч, 6 ч…). */
export function gameThresholds(u: Pick<User, "game_first_min" | "game_every_min">, minutes: number): number[] {
  const out: number[] = [];
  const every = Math.max(15, u.game_every_min);
  for (let t = Math.max(15, u.game_first_min); t <= minutes; t += every) out.push(t);
  return out;
}

/** Сохранить день активности. Уведомление — один раз на каждый пройденный порог игр. */
export async function recordActivity(store: Store, u: User, input: ActivityInput, send?: Send) {
  await store.upsertActivity({
    user_id: u.id,
    day_key: input.day,
    source: input.source,
    active_sec: input.active_sec,
    afk_sec: input.afk_sec,
    apps: [...input.apps].sort((a, b) => b.sec - a.sec),
    games: [...input.games].sort((a, b) => b.sec - a.sec),
  });
  if (!send || !u.game_alerts) return { alerted: 0 };
  const gameSec = (await store.activityOf(u.id, input.day)).reduce((s, a) => s + a.games.reduce((x, g) => x + g.sec, 0), 0);
  let newest = 0;
  for (const t of gameThresholds(u, Math.floor(gameSec / 60))) if (await store.once(`game:${u.id}:${input.day}:${t}`)) newest = t;
  if (newest) await send(u, (GAME_LINES[u.persona] ?? GAME_LINES.strict)(durationHuman(newest * 60)), "stern");
  return { alerted: newest };
}
