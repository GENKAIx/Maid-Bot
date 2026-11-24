import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// В разработке (npm --workspace web run dev) запросы /api идут на сервер :3000.
// Сборка — web/dist, сервер отдаёт её сам (WEB_DIR).

// Версия сайта — время сборки по UTC: «год.день года.ЧЧММ» (26.328.1530). Такой вид пропускает сервер (auth.ts: clientMeta,
// X-Maid-Version) и сравнивает по числам — новее сборка, больше версия.
function buildVersion(t = new Date()) {
  const day = Math.floor((Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()) - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86_400_000) + 1;
  const hm = String(t.getUTCHours()).padStart(2, "0") + String(t.getUTCMinutes()).padStart(2, "0");
  return `${t.getUTCFullYear() % 100}.${day}.${Number(hm)}`;
}

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(buildVersion()) },
  server: { port: 5173, proxy: { "/api": "http://localhost:3000" } },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
});
