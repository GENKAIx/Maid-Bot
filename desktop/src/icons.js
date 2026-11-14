// Иконки программ и игр для статистики: путь к exe запоминает трекер (activity.js, paths), на сервер уходит PNG 32 px
// (POST /api/icons). Каждую программу — один раз. Программы из Microsoft Store (путь в WindowsApps: Claude, ChatGPT…) — значок
// из их AppxManifest.xml (Square44x44Logo), у их exe своего нет. Стандартный серый значок «программа» (Electron отдаёт его,
// когда своего нет) — не значок: на сервер уходит пустой png — сервер стирает прежний, на сайте остаётся буква.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** Тот же ключ, что на сервере (server/src/activity.ts iconKey). */
const iconKey = (name) => String(name).toLowerCase().replace(/\.exe$/, "").replace(/[^\p{L}\p{N}]+/gu, "");

/** Логотип приложения из AppxManifest.xml: у Application с этим exe (путь от папки пакета), иначе у первого; нет — "". */
function manifestLogo(xml, exeRel) {
  const apps = [...xml.matchAll(/<Application\b[^>]*>[\s\S]*?<\/Application>/g)].map((m) => m[0]);
  const norm = (s) => s.replace(/\//g, "\\").toLowerCase();
  const own = apps.find((a) => norm(/Executable="([^"]+)"/.exec(a)?.[1] ?? "") === norm(exeRel)) ?? apps[0] ?? xml;
  return /Square44x44Logo="([^"]+)"/.exec(own)?.[1] ?? "";
}

/** Лучший файл логотипа из папки: прозрачный 32 или 48 px, потом с подложкой, потом по масштабу. files — имена в папке. */
function pickLogo(files, stem) {
  const has = new Map(files.map((f) => [f.toLowerCase(), f]));
  const s = stem.toLowerCase();
  const order = [
    "targetsize-32_altform-unplated", "targetsize-48_altform-unplated", "targetsize-32", "targetsize-48",
    "targetsize-24_altform-unplated", "targetsize-64_altform-unplated", "scale-100", "scale-200", "scale-150", "scale-125",
  ].map((q) => `${s}.${q}.png`);
  for (const f of [...order, `${s}.png`]) if (has.has(f)) return has.get(f);
  return "";
}

/** Путь к логотипу программы из Microsoft Store или "" (не из Store, манифест не читается). */
function storeLogoPath(exe) {
  const m = /^(.*\\WindowsApps\\[^\\]+)\\(.+)$/i.exec(exe);
  if (!m) return "";
  try {
    const rel = manifestLogo(fs.readFileSync(path.join(m[1], "AppxManifest.xml"), "utf8"), m[2]);
    if (!rel) return "";
    const dir = path.join(m[1], path.dirname(rel));
    const file = pickLogo(fs.readdirSync(dir), path.basename(rel, path.extname(rel)));
    return file ? path.join(dir, file) : "";
  } catch {
    return "";
  }
}

let generic = null; // PNG стандартного значка exe — у пустого .exe во временной папке
async function genericPng(app) {
  if (generic) return generic;
  const dummy = path.join(os.tmpdir(), "maid-noicon.exe");
  try {
    fs.writeFileSync(dummy, "");
    generic = (await app.getFileIcon(dummy, { size: "large" })).toPNG().toString("base64");
  } catch {
    generic = "-";
  }
  return generic;
}

/** Значок программы: PNG base64 до 32 px; своего нет — "". */
async function iconOf(exe) {
  const { app, nativeImage } = require("electron");
  const logo = storeLogoPath(exe);
  let img = logo ? nativeImage.createFromPath(logo) : null;
  if (!img || img.isEmpty()) {
    img = await app.getFileIcon(exe, { size: "large" });
    if (img.isEmpty() || img.toPNG().toString("base64") === (await genericPng(app))) return "";
  }
  if (img.getSize().width > 32) img = img.resize({ width: 32, height: 32, quality: "best" });
  return img.toPNG().toString("base64");
}

/**
 * Значки программ из names, которых ещё нет в sent (Set ключей): [{ name, png }], png "" — своего значка нет.
 * byName — имя программы → путь к exe.
 */
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
      const png = await iconOf(p);
      if (png.length <= 24_000) out.push({ name, png });
    } catch {
      // значок не достался — попробуем в другой раз
    }
    if (out.length >= limit) break;
  }
  return out;
}

module.exports = { iconKey, newIcons, manifestLogo, pickLogo, storeLogoPath };
