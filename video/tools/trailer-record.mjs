// Запись сценок трейлера кадр за кадром: настоящая страница виджета (out/recpage) или сайт на демо-сервере в Chrome без окна.
// node tools/trailer-record.mjs <сценка…> | all | full   → public/rec/t_<имя>/NNNN.png + meta.json
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { FULL, SCENES } from "./trailer-scenes.mjs";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PAGE = new URL("../out/recpage/renderer/rec.html", import.meta.url).href;
const FPS = 30;
const port = 9400 + Math.floor(Math.random() * 400);
const proc = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${process.env.TEMP}/maidtrailer${port}`,
  "--hide-scrollbars", "--mute-audio", "--autoplay-policy=no-user-gesture-required", "--allow-file-access-from-files", "--force-device-scale-factor=1.5", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let list;
for (let i = 0; i < 60 && !list; i++) { await sleep(250); try { list = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch {} }
const ws = new WebSocket(list.find((p) => p.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0, shots = null;
const waiters = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
  else if (m.method === "Page.screencastFrame") { send("Page.screencastFrameAck", { sessionId: m.params.sessionId }); if (shots) shots.push({ ts: m.params.metadata.timestamp, data: m.params.data }); }
};
const send = (method, params = {}) => new Promise((res) => { const my = ++id; waiters.set(my, res); ws.send(JSON.stringify({ id: my, method, params })); });
const evalJs = async (js) => {
  const r = await send("Runtime.evaluate", { expression: js, awaitPromise: false, returnByValue: true });
  if (r.result?.exceptionDetails) console.log("! js:", js.slice(0, 90), r.result.exceptionDetails.exception?.description?.slice(0, 160));
  return r.result?.result?.value;
};
await send("Page.enable");
await send("Runtime.enable");

async function record(name, sc, { url, W, H, SCALE, before }) {
  const out = new URL(`../public/rec/t_${name}/`, import.meta.url);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: SCALE, mobile: false });
  const scripts = [];
  for (const source of before) scripts.push((await send("Page.addScriptToEvaluateOnNewDocument", { source })).result.identifier);
  await send("Page.navigate", { url });
  await sleep(2600);
  for (const identifier of scripts) await send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
  if (sc.mode) { await evalJs(`hideBubble(); setCollapsed(${sc.mode === "fold"}); window.__h?.down?.(false); 0`); await sleep(900); }
  if (sc.setup) { await evalJs(sc.setup + "; 0"); await sleep(1300); }
  if (sc.mode) await evalJs(`hideBubble(); hideClock?.(); 0`);
  await sleep(500);
  const steps = [...(sc.steps ?? [])].sort((a, b) => a[0] - b[0]);
  const marks = [];
  shots = [];
  await send("Page.startScreencast", { format: "png", everyNthFrame: 1, maxWidth: W * SCALE, maxHeight: H * SCALE });
  const t0 = Date.now() / 1000;
  while (Date.now() / 1000 - t0 < sc.seconds) {
    const t = Date.now() / 1000 - t0;
    while (steps.length && steps[0][0] <= t) { const [at, js, label] = steps.shift(); if (label) marks.push({ t: at, label }); await evalJs(js + "; 0"); }
    await sleep(5);
  }
  await send("Page.stopScreencast");
  await sleep(250);
  const got = shots;
  shots = null;
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

let args = process.argv.slice(2);
if (args[0] === "all") args = Object.keys(SCENES);
if (args[0] === "full") args = Object.keys(FULL).map((n) => "full:" + n);
for (const a of args) {
  if (a.startsWith("full:")) {
    const name = a.slice(5), sc = FULL[name];
    const token = readFileSync(new URL("../out/demo.log", import.meta.url), "utf8").match(/token=(\S+)/)[1];
    await send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 250, g: 250, b: 252, a: 255 } });
    await record("full_" + name, sc, { url: "http://127.0.0.1:3399" + sc.url, W: 1600, H: 900, SCALE: 1.2, before: [`localStorage.setItem("maid.token", ${JSON.stringify(token)})`] });
  } else if (SCENES[a]) {
    // Часы страницы — 10 ноября, 18:40 (Date сдвигается до загрузки скриптов виджета).
    const want = new Date(2026, 10, 10, 18, 40, 0).getTime();
    await send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
    await record(a, SCENES[a], { url: `${PAGE}?v=${Date.now()}`, W: 620, H: 760, SCALE: 1.5, before: [`(() => { const d = ${want} - Date.now(); const N = Date.now; const D = Date;
      class F extends D { constructor(...a) { a.length ? super(...a) : super(N() + d); } static now() { return N() + d; } } window.Date = F; })();`] });
  } else console.log("нет сценки", a);
}
ws.close();
proc.kill();
