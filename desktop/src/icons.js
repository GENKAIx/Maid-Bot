// Иконки программ и игр для статистики: у запущенных процессов берём путь к exe, Electron достаёт его значок,
// на сервер уходит PNG (POST /api/icons). Каждую программу — один раз; не запущена сейчас — возьмём в другой раз.

const { execFile } = require("node:child_process");
const { app } = require("electron");

/** Тот же ключ, что на сервере (server/src/activity.ts iconKey). */
const iconKey = (name) => String(name).toLowerCase().replace(/\.exe$/, "").replace(/[^\p{L}\p{N}]+/gu, "");

/** Запущенные процессы с путём: ключ имени → путь к exe. */
function processPaths() {
  if (process.platform !== "win32") return Promise.resolve(new Map());
  const cmd = "Get-Process | Where-Object Path | ForEach-Object { $_.ProcessName + '|' + $_.Path }";
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd], { windowsHide: true, timeout: 20_000, maxBuffer: 4 << 20 }, (err, out) => {
      const map = new Map();
      if (!err) for (const line of String(out).split(/\r?\n/)) {
        const i = line.indexOf("|");
        if (i > 0) map.set(iconKey(line.slice(0, i)), line.slice(i + 1).trim());
      }
      resolve(map);
    });
  });
}

/** Значки программ из names, которых ещё нет в sent (Set ключей): [{ name, png }]. */
async function newIcons(names, sent, limit = 30) {
  const want = new Map();
  for (const n of names) {
    const k = iconKey(n);
    if (k && !sent.has(k) && !want.has(k)) want.set(k, n);
  }
  if (!want.size) return [];
  const paths = await processPaths();
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
