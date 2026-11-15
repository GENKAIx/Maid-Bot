// Имена программ в статистике (экран «Статистика», Stats.tsx).

/** Тот же ключ, что на сервере (server/src/activity.ts iconKey) и в программе на ПК (desktop/src/icons.js). */
export const iconKey = (name: string) => name.toLowerCase().replace(/\.exe$/, "").replace(/[^\p{L}\p{N}]+/gu, "");
export const prettyName = (name: string) => name.replace(/\.exe$/i, "");

/** Одна игра под разными именами: «cs2» (имя файла, новый трекер) и «Counter-Strike 2» (прежний трекер). */
const SAME_GAME: Record<string, string> = { cs2: "counterstrike2" };
const appKey = (name: string) => { const k = iconKey(name); return SAME_GAME[k] ?? k; };

/** Программы за период без игр: прежний трекер записывал игру и в программы, и в игры — в такой день из программ она
 *  убирается (сравнение по ключу значков: «CastleBattle» = «Castle Battle»). В другие дни имя остаётся программой. */
export function appsWithoutGames(rows: { apps: { name: string; sec: number }[]; games: { name: string; sec: number }[] }[]) {
  return rows.flatMap((r) => {
    const games = new Set(r.games.map((g) => appKey(g.name)));
    return r.apps.filter((a) => !games.has(appKey(a.name)));
  });
}

/** Время по программам за период: одна программа под разными именами («chrome.exe» в старых днях, «chrome» в новых,
 *  другой регистр) — одна строка, по тому же ключу, что значки; подпись — имя с наибольшим временем, без .exe. */
export function sumByApp(rows: { name: string; sec: number }[]): Map<string, number> {
  const by = new Map<string, { names: Map<string, number>; sec: number }>();
  for (const r of rows) {
    const k = appKey(r.name) || r.name;
    const e = by.get(k) ?? { names: new Map<string, number>(), sec: 0 };
    e.sec += r.sec;
    const nm = prettyName(r.name);
    e.names.set(nm, (e.names.get(nm) ?? 0) + r.sec);
    by.set(k, e);
  }
  return new Map([...by.values()].map((e) => [[...e.names].sort((a, b) => b[1] - a[1])[0][0], e.sec]));
}
