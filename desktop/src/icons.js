// Иконки программ и игр для статистики: путь к exe запоминает трекер (activity.js, paths), Electron достаёт его значок,
// на сервер уходит PNG (POST /api/icons). Каждую программу — один раз.

const { app } = require("electron");

/** Тот же ключ, что на сервере (server/src/activity.ts iconKey). */
const iconKey = (name) => String(name).toLowerCase().replace(/\.exe$/, "").replace(/[^\p{L}\p{N}]+/gu, "");

/** Значки программ из names, которых ещё нет в sent (Set ключей): [{ name, png }]. byName — имя программы → путь к exe. */
async function newIcons(names, sent, byName, limit = 30) {
  const want = new Map();
  for (const n of names) {
    const k = iconKey(n);
    if (k && !sent.has(k) && !want.has(k)) want.set(k, n);
  }
  if (!want.size) return [];
  const paths = new Map([...byName].map(([n, p]) => [iconKey(n), p]));
  const out = [];
  for (const [k, name] of want) {
    const p = paths.get(k);
    if (!p) continue;
    try {
      const img = await app.getFileIcon(p, { size: "large" });
      if (img.isEmpty()) continue;
      const png = img.toPNG().toString("base64");
      if (png.length <= 24_000) out.push({ name, png });
    } catch {
      // нет значка — останется буква
    }
    if (out.length >= limit) break;
  }
  return out;
}

module.exports = { iconKey, newIcons };
