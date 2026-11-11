import { config } from "./config.ts";
import type { Picture } from "./llm.ts";

// Картинка по описанию — RunPod (по умолчанию Z-Image Turbo), а без ключа RunPod — OpenRouter (по умолчанию Gemini 2.5 Flash Image).
// Ответ RunPod — ссылка на картинку на 7 дней, OpenRouter — картинка в base64; в обоих случаях храним у себя (таблица drawings).
// В тестах подменяется функцией.

export type DrawCall = (prompt: string) => Promise<Picture>;

/** Задан ключ RunPod или OpenRouter — можно рисовать. */
export const drawReady = () => Boolean(config.drawing.apiKey || config.drawing.openrouterKey);
/** Сколько ждать картинку целиком (очередь RunPod + рисование + скачивание). */
export const DRAW_TIMEOUT_MS = 120_000;

interface RunpodJob {
  id?: string;
  status?: string;
  error?: string;
  output?: { result?: string; cost?: number } | string;
}

/** Рисует тем, что настроено: RunPod главнее, иначе OpenRouter. */
export const callDraw: DrawCall = (prompt) => (config.drawing.apiKey ? callRunpod(prompt) : callOpenRouterDraw(prompt));

export async function callRunpod(prompt: string): Promise<Picture> {
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

interface OpenRouterImageAnswer {
  error?: { message?: string };
  choices?: { message?: { content?: string; images?: { image_url?: { url?: string } }[] } }[];
}

/** OpenRouter: chat/completions с modalities image — картинка приходит data:-ссылкой в message.images. */
export async function callOpenRouterDraw(prompt: string): Promise<Picture> {
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.drawing.openrouterKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.drawing.openrouterModel,
      modalities: ["image", "text"],
      messages: [{ role: "user", content: `Draw a single square picture: ${prompt}` }],
    }),
    signal: AbortSignal.timeout(DRAW_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`OpenRouter ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const ans = (await r.json()) as OpenRouterImageAnswer;
  const url = ans.choices?.[0]?.message?.images?.[0]?.image_url?.url ?? "";
  const m = /^data:(image\/[\w.+-]+);base64,(.+)$/s.exec(url);
  if (!m) throw new Error(`OpenRouter: картинки нет ${ans.error?.message ?? (ans.choices?.[0]?.message?.content ?? "").slice(0, 200)}`.trim());
  return { mime: m[1], data: m[2] };
}
