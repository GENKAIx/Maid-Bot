import { z } from "zod";
import type { Store, User } from "./db.ts";
import type { Send } from "./scheduler.ts";
import { isDayKey } from "./time.ts";

// Активность с трекера ПК (десктоп читает ActivityWatch). Игры в дневник пишет только он.

const Item = z.object({ name: z.string().min(1).max(120), sec: z.number().int().min(0).max(86400) });
export const ActivityInput = z.object({
  day: z.string().refine(isDayKey, "день YYYY-MM-DD"),
  source: z.string().min(1).max(40).default("pc"),
  active_sec: z.number().int().min(0).max(86400),
  afk_sec: z.number().int().min(0).max(86400).default(0),
  apps: z.array(Item).max(50).default([]),
  games: z.array(Item).max(50).default([]),
  steps: z.number().int().min(0).nullable().optional(),
});
export type ActivityInput = z.infer<typeof ActivityInput>;

const GAME_LINES = {
  strict: (h: number) => `🎮 Уже ${h} ч в играх. Сделайте перерыв: вода, глаза, спина.`,
  kind: (h: number) => `🎮 Ты играешь уже ${h} ч. Может, чай и пять минут отдыха?`,
  sassy: (h: number) => `🎮 ${h} ч в играх. Мир снаружи ещё существует, если что.`,
  chill: (h: number) => `🎮 ${h} ч в игре. Норм, но потянись хоть.`,
} as Record<string, (h: number) => string>;

/** Сохранить день активности. Уведомление — один раз на каждый новый полный час игр. */
export async function recordActivity(store: Store, u: User, input: ActivityInput, send?: Send) {
  store.upsertActivity({
    user_id: u.id,
    day_key: input.day,
    source: input.source,
    active_sec: input.active_sec,
    afk_sec: input.afk_sec,
    apps: [...input.apps].sort((a, b) => b.sec - a.sec),
    games: [...input.games].sort((a, b) => b.sec - a.sec),
    steps: input.steps ?? null,
  });
  if (!send || !u.game_alerts) return { alerted: 0 };
  const gameSec = store.activityOf(u.id, input.day).reduce((s, a) => s + a.games.reduce((x, g) => x + g.sec, 0), 0);
  const hours = Math.floor(gameSec / 3600);
  let newest = 0;
  for (let h = 1; h <= hours; h++) if (store.once(`game:${u.id}:${input.day}:${h}`)) newest = h;
  if (newest) await send(u, (GAME_LINES[u.persona] ?? GAME_LINES.strict)(newest), "stern");
  return { alerted: newest };
}
