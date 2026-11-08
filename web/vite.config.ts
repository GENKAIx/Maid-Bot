import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// В разработке (npm --workspace web run dev) запросы /api идут на сервер :3000.
// Сборка — web/dist, сервер отдаёт её сам (WEB_DIR).
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { "/api": "http://localhost:3000" } },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
});
