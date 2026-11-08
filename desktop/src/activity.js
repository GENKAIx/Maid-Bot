// Трекер ПК: читает ActivityWatch (http://localhost:5600) и считает день —
// время в приложениях только пока человек не AFK. Игры — по списку имён программ из настроек.

const os = require("node:os");

const AW = "http://localhost:5600/api/0";

async function get(path) {
  const res = await fetch(AW + path, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`ActivityWatch ${res.status}`);
  return res.json();
}

function pickBucket(buckets, prefix) {
  const host = os.hostname();
  const ids = Object.keys(buckets).filter((id) => id.startsWith(prefix));
  return ids.find((id) => id === `${prefix}_${host}`) ?? ids[0] ?? null;
}

/** Пересечение отрезков [a,b) событий окон с отрезками «не AFK». */
function overlap(start, end, active) {
  let sec = 0;
  for (const [a, b] of active) {
    const s = Math.max(start, a);
    const e = Math.min(end, b);
    if (e > s) sec += (e - s) / 1000;
  }
  return sec;
}

/** Начало и конец местного дня (YYYY-MM-DD) в мс. */
function dayBounds(day) {
  const [y, m, d] = day.split("-").map(Number);
  const start = new Date(y, m - 1, d).getTime();
  return [start, new Date(y, m - 1, d + 1).getTime()];
}

function localDay(t = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
}

function isGame(app, games) {
  const a = app.toLowerCase();
  return games.some((g) => g && a === g.toLowerCase().trim());
}

async function collectDay(day, games = []) {
  const buckets = await get("/buckets/");
  const win = pickBucket(buckets, "aw-watcher-window");
  const afk = pickBucket(buckets, "aw-watcher-afk");
  if (!win) throw new Error("в ActivityWatch нет aw-watcher-window");
  const [from, to] = dayBounds(day);
  const range = `?start=${new Date(from).toISOString()}&end=${new Date(to).toISOString()}&limit=-1`;
  const clip = (e) => {
    const s = Math.max(from, new Date(e.timestamp).getTime());
    const f = Math.min(to, new Date(e.timestamp).getTime() + e.duration * 1000);
    return [s, f];
  };

  let active = [[from, to]];
  let afkSec = 0;
  if (afk) {
    const evs = await get(`/buckets/${encodeURIComponent(afk)}/events${range}`);
    active = [];
    for (const e of evs) {
      const [s, f] = clip(e);
      if (f <= s) continue;
      if (e.data?.status === "not-afk") active.push([s, f]);
      else afkSec += (f - s) / 1000;
    }
  }

  const apps = new Map();
  for (const e of await get(`/buckets/${encodeURIComponent(win)}/events${range}`)) {
    const [s, f] = clip(e);
    if (f <= s) continue;
    const name = String(e.data?.app ?? "?").replace(/\.exe$/i, "") || "?";
    const sec = overlap(s, f, active);
    if (sec > 0) apps.set(name, (apps.get(name) ?? 0) + sec);
  }
  const list = [...apps].map(([name, sec]) => ({ name, sec: Math.round(sec) })).filter((x) => x.sec >= 60).sort((a, b) => b.sec - a.sec);
  const gameNames = games.map((g) => g.replace(/\.exe$/i, ""));
  return {
    day,
    source: "pc",
    active_sec: Math.min(86400, list.reduce((s, x) => s + x.sec, 0)),
    afk_sec: Math.min(86400, Math.round(afkSec)),
    apps: list.filter((x) => !isGame(x.name, gameNames)).slice(0, 30),
    games: list.filter((x) => isGame(x.name, gameNames)),
  };
}

module.exports = { collectDay, localDay };
