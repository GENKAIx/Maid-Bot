import { config } from "./config.ts";
import type { Picture } from "./llm.ts";

// Картинка по описанию — RunPod (по умолчанию Z-Image Turbo). Ответ RunPod — ссылка на картинку на 7 дней,
// поэтому картинку сразу скачиваем и храним у себя (таблица drawings). В тестах подменяется функцией.

export type DrawCall = (prompt: string) => Promise<Picture>;

/** Ключ RunPod задан — можно рисовать. */
export const drawReady = () => Boolean(config.drawing.apiKey);
/** Сколько ждать картинку целиком (очередь RunPod + рисование + скачивание). */
export const DRAW_TIMEOUT_MS = 120_000;

interface RunpodJob {
  id?: string;
  status?: string;
  error?: string;
  output?: { result?: string; cost?: number } | string;
}

export async function callDraw(prompt: string): Promise<Picture> {
  const base = `https://api.runpod.ai/v2/${config.drawing.model}`;
  const headers = { Authorization: `Bearer ${config.drawing.apiKey}`, "Content-Type": "application/json" };
  const until = Date.now() + DRAW_TIMEOUT_MS;
  const signal = () => AbortSignal.timeout(Math.max(1000, until - Date.now()));
  const ask = async (url: string, body?: unknown): Promise<RunpodJob> => {
    const r = await fetch(url, { method: body ? "POST" : "GET", headers, body: body ? JSON.stringify(body) : undefined, signal: signal() });
    if (!r.ok) throw new Error(`RunPod ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return (await r.json()) as RunpodJob;
  };
  let job = await ask(`${base}/runsync`, {
    input: { prompt, size: "1024*1024", seed: -1, output_format: "jpeg", enable_safety_checker: true },
  });
  // runsync ждёт не бесконечно: не успела — спрашиваем статус, пока не готово.
  while (job.status === "IN_QUEUE" || job.status === "IN_PROGRESS") {
    if (!job.id || Date.now() > until) throw new Error("RunPod: картинка не успела");
    await new Promise((ok) => setTimeout(ok, 1500));
    job = await ask(`${base}/status/${job.id}`);
  }
  const out = typeof job.output === "string" ? job.output : job.output?.result;
  if (job.status !== "COMPLETED" || !out) throw new Error(`RunPod: ${job.status ?? "?"} ${job.error ?? ""}`.trim());
  const img = await fetch(out, { signal: signal() });
  if (!img.ok) throw new Error(`RunPod: картинка не скачалась (${img.status})`);
  const mime = (img.headers.get("content-type") ?? "image/jpeg").split(";")[0];
  return { mime: mime.startsWith("image/") ? mime : "image/jpeg", data: Buffer.from(await img.arrayBuffer()).toString("base64") };
}
