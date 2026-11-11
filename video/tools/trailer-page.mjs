// Страница для съёмки трейлера: копия настоящего виджета (desktop/renderer + assets) с заглушкой сервера → video/out/recpage.
// node tools/trailer-page.mjs
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const root = new URL("../../", import.meta.url);
const out = new URL("../out/recpage/", import.meta.url);
rmSync(out, { recursive: true, force: true });
mkdirSync(new URL("renderer/", out), { recursive: true });
cpSync(new URL("desktop/renderer/", root), new URL("renderer/", out), { recursive: true });
cpSync(new URL("desktop/assets/", root), new URL("assets/", out), { recursive: true });
cpSync(new URL("trailer-stub.js", import.meta.url), new URL("renderer/trailer-stub.js", out));
let html = readFileSync(new URL("renderer/widget.html", out), "utf8");
html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "");
html = html.replace(/<script src=/, '<script src="trailer-stub.js"></script>\n  <script src=');
writeFileSync(new URL("renderer/rec.html", out), html);
console.log("страница записи:", new URL("renderer/rec.html", out).pathname);
