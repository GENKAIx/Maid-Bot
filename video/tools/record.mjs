// Запись виджета кадр за кадром: настоящая страница виджета (превью со stub.js на 127.0.0.1:3322) в Chrome без окна,
// виртуальное время по 1/30 с, прозрачный фон → public/rec/<сцена>/NNNN.png. Сценарии — tools/scenes.mjs.
// node tools/record.mjs <сцена> [ещё сцены…]
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { SCENES } from "./scenes.mjs";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PAGE = "http://127.0.0.1:3322/rec.html";
const FPS = 30, SCALE = 1.5, W = 660, H = 780;
const port = 9400 + Math.floor(Math.random() * 400);
const proc = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${process.env.TEMP}/maidrec${port}`,
  "--hide-scrollbars", "--mute-audio", "--autoplay-policy=no-user-gesture-required", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let list;
for (let i = 0; i < 60 && !list; i++) { await sleep(250); try { list = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch {} }
const ws = new WebSocket(list.find((p) => p.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const waiters = new Map(), events = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
  else if (m.method) events.push(m);
};
const send = (method, params = {}) => new Promise((res) => { const my = ++id; waiters.set(my, res); ws.send(JSON.stringify({ id: my, method, params })); });
const until = async (name) => { for (;;) { const i = events.findIndex((e) => e.method === name); if (i >= 0) return events.splice(i, 1)[0]; await sleep(2); } };
const evalJs = async (js) => {
  const r = await send("Runtime.evaluate", { expression: js, awaitPromise: false, returnByValue: true });
  if (r.result?.exceptionDetails) console.log("! js:", js.slice(0, 80), r.result.exceptionDetails.exception?.description);
  return r.result?.result?.value;
};

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: SCALE, mobile: false });
await send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });

await send("Page.startScreencast", { format: "png", everyNthFrame: 1 }).then(() => send("Page.stopScreencast"));
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method !== "Page.screencastFrame") return;
  send("Page.screencastFrameAck", { sessionId: m.params.sessionId });
  if (shots) shots.push({ ts: m.params.metadata.timestamp, data: m.params.data });
});
let shots = null;
for (const name of process.argv.slice(2)) {
  const sc = SCENES[name];
  if (!sc) { console.log("нет сцены", name); continue; }
  const out = new URL(`../public/rec/${name}/`, import.meta.url);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  // Часы страницы — на нужный момент дня (Date сдвигается до загрузки скриптов виджета).
  const want = new Date(...(sc.clock ?? [2026, 10, 8, 18, 40, 0])).getTime();
  const shift = await send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => { const d = ${want} - Date.now(); const N = Date.now; const D = Date;
    class F extends D { constructor(...a) { a.length ? super(...a) : super(N() + d); } static now() { return N() + d; } } window.Date = F; })();` });
  await evalJs(`try { localStorage.clear() } catch {}`);
  await send("Page.navigate", { url: `${PAGE}?scene=${name}&v=${Date.now()}` });
  await sleep(2500);
  await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: shift.result.identifier });
  await evalJs(`document.body.classList.add("rec")`);
  if (sc.setup) await evalJs(sc.setup);
  await sleep(400);
  const steps = [...(sc.steps ?? [])].sort((a, b) => a[0] - b[0]);
  const marks = [];
  shots = [];
  await send("Page.startScreencast", { format: "png", everyNthFrame: 1, maxWidth: W * SCALE, maxHeight: H * SCALE });
  const t0 = Date.now() / 1000;
  while (Date.now() / 1000 - t0 < sc.seconds) {
    const t = Date.now() / 1000 - t0;
    while (steps.length && steps[0][0] <= t) { const [at, js, label] = steps.shift(); if (label) marks.push({ t: at, label }); await evalJs(js); }
    await sleep(5);
  }
  await send("Page.stopScreencast");
  await sleep(200);
  const got = shots;
  shots = null;
  // Кадры экрана приходят, когда страница перерисовалась; на сетку 30 к/с — последний кадр не позже нужного момента.
  const frames = Math.round(sc.seconds * FPS);
  let k = 0;
  for (let f = 0; f < frames; f++) {
    const at = t0 + f / FPS;
    while (k + 1 < got.length && got[k + 1].ts <= at) k++;
    writeFileSync(new URL(String(f).padStart(4, "0") + ".png", out), Buffer.from(got[k].data, "base64"));
  }
  writeFileSync(new URL("meta.json", out), JSON.stringify({ frames, fps: FPS, width: W * SCALE, height: H * SCALE, marks: marks.map((m) => ({ frame: Math.round(m.t * FPS), label: m.label })) }));
  console.log(name, frames, "кадров из", got.length, "снимков");
}
ws.close();
proc.kill();
