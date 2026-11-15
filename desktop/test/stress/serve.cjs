// Виджет в браузере для стресс-проверок: node desktop/test/stress/serve.cjs → http://localhost:8799/renderer/widget.html
// Страница — настоящая desktop/renderer/widget.html; вместо preload — заглушка stub.js, которая пересылает вызовы window.maid
// сюда, а здесь их исполняет настоящий src/main.js на стенде (harness.cjs) и ходит на поддельный сервер (fake-server.cjs, порт 8798).
// Сбои включаются запросом POST /__ctl, например {"fault":{"mode":"502"}} или {"dataset":"many"} — см. обработчик ниже.
// На установленную программу и боевой сервер этот стенд не ходит.
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { boot, loggedIn } = require("./harness.cjs");
const fake = require("./fake-server.cjs");

const ROOT = path.join(__dirname, "..", "..");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".webp": "image/webp", ".png": "image/png", ".wav": "audio/wav", ".svg": "image/svg+xml", ".json": "application/json" };
const PORT = Number(process.env.STRESS_PORT) || 8799;

(async () => {
  const srv = await fake.create().listen(PORT - 1);
  // keep: папка настроек переживает перезапуск «программы» ({"reboot":true}); лежит во временной папке системы (maid-stress-*).
  let h = boot({ settings: loggedIn(srv.url), keep: true, timeScale: Number(process.env.STRESS_TIMESCALE) || 1 });
  await h.ready();
  const streams = new Set();
  const push = (channel, data) => { for (const r of streams) r.write(`data: ${JSON.stringify({ channel, data })}\n\n`); };
  const wire = () => h.bus.on("send", (win, channel, args) => { if (win.kind === "widget") push(channel, args[0]); });
  wire();
  const readBody = async (req) => { let s = ""; for await (const c of req) s += c; return s ? JSON.parse(s) : {}; };

  http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(obj ?? null)); };
    try {
      if (url.pathname === "/__ipc/invoke") {
        const b = await readBody(req);
        try { return send(200, { value: await h.invoke(b.channel, b.args ?? []) }); } catch (e) { return send(200, { error: e.message }); }
      }
      if (url.pathname === "/__ipc/send") {
        const b = await readBody(req);
        h.send(b.channel, b.args ?? []);
        return send(200, {});
      }
      if (url.pathname === "/__ipc/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
        res.write(": ok\n\n");
        streams.add(res);
        return void req.on("close", () => streams.delete(res));
      }
      if (url.pathname === "/__ctl") {
        const b = await readBody(req);
        if ("fault" in b) srv.fault = b.fault && { ...b.fault, only: b.fault.only ? new RegExp(b.fault.only) : undefined };
        if (b.shiftMs !== undefined) srv.shiftMs = b.shiftMs;
        if (b.dataset) srv.reset(b.dataset);
        if (b.latency !== undefined) { const [lo, hi] = [].concat(b.latency); srv.latency = () => lo + Math.random() * ((hi ?? lo) - lo); }
        if (b.latencyOf) srv.latency = (p) => { for (const [re, ms] of Object.entries(b.latencyOf)) if (new RegExp(re).test(p)) return ms; return 0; };
        if (b.token) srv.token = b.token;
        if (b.notice) srv.notices.push({ id: srv.notices.length + 1, text: b.notice, emotion: "neutral", buttons: b.buttons });
        if (b.patch) Object.assign(srv.state, b.patch);
        if (b.clearLog) srv.log.length = 0;
        if (b.mainSend) push(b.mainSend, b.data);
        // Перезапуск «программы»: новый main.js на тех же настройках (как после обновления).
        if (b.reboot) { const dir = h.app.paths.appData; h.stop(); h = boot({ userData: dir }); await h.ready(); wire(); }
        return send(200, {
          peek: b.peek ? (() => { try { return h.peek(b.peek); } catch (e) { return String(e); } })() : undefined,
          counts: srv.counts(), state: b.state ? srv.state : undefined, sessions: srv.sessions.length, inputs: srv.inputs?.length ?? 0,
          habits: srv.state.habits?.map?.((x) => `${x.id}:${x.status}`), log: b.log ? srv.log.slice(-b.log).map((r) => `${r.method} ${r.path} ${r.handled ? "ok" : "-"}`) : undefined,
          maidLog: b.maidLog ? h.log() : undefined,
        });
      }
      const file = url.pathname === "/__stub.js" ? path.join(__dirname, "stub.js") : path.join(ROOT, decodeURIComponent(url.pathname));
      if (!file.startsWith(ROOT) || !/^\/(renderer|assets|__stub\.js)/.test(url.pathname)) return send(404, { error: "нет" });
      let body = fs.readFileSync(file);
      // Заглушка window.maid — первым скриптом страницы (как preload).
      if (file.endsWith(".html")) body = String(body).replace(/<script src="common\.js">/, `<script src="/__stub.js"></script>\n  <script src="common.js">`);
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
      res.end(body);
    } catch (e) {
      send(e.code === "ENOENT" || e.code === "EISDIR" ? 404 : 500, { error: String(e.message) });
    }
  }).listen(PORT, "127.0.0.1", () => console.log(`виджет: http://localhost:${PORT}/renderer/widget.html  ·  поддельный сервер: ${srv.url}`));
})();
