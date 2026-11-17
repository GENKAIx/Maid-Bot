import type { Store } from "./db.ts";

// Альбом реакций: какие анимации горничной человек уже видел. Реакции случаются только в виджете на ПК — он шлёт имя,
// когда анимация показана впервые (desktop/renderer/album.js); сайт рисует альбом: увиденное открыто, остальное — силуэты.
// Хранится одной записью на человека: kv «album:<id>» → {"имя": "когда увидел впервые"}.

/** Все анимации горничной (тот же список, что MOODS в desktop/renderer/widget.js), в порядке альбома. */
export const ALBUM = ["idle", "think", "sleep", "offline", "remind", "angry", "clean", "hello", "happy", "proud", "write", "done",
  "streak", "sad", "worried", "surprised", "neutral", "listen", "tea", "bow", "excited", "smitten", "giggle", "gasp", "smug",
  "refuse", "forget", "think2", "analysis", "list", "present", "letter", "salute", "thumbsup", "wrench", "deadpan", "facepalm", "pout",
  "shy", "shh", "bedtime"] as const;

const albumKey = (userId: number) => `album:${userId}`;

export async function albumOf(store: Store, userId: number): Promise<Record<string, string>> {
  try {
    const v = JSON.parse((await store.kvGet(albumKey(userId))) ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(ALBUM.filter((m) => typeof v[m] === "string").map((m) => [m, v[m] as string]));
  } catch {
    return {};
  }
}

/** Отметить увиденное; уже открытое не трогает (дата первого показа остаётся). fresh — что открылось этим вызовом. */
export async function albumSee(store: Store, userId: number, moods: string[], at = new Date()) {
  const seen = await albumOf(store, userId);
  const fresh = ALBUM.filter((m) => moods.includes(m) && !seen[m]);
  if (fresh.length) {
    for (const m of fresh) seen[m] = at.toISOString();
    await store.kvSet(albumKey(userId), JSON.stringify(seen));
  }
  return { seen, fresh, total: ALBUM.length };
}
