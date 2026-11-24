import { config } from "./config.ts";
import { llmErrorCode, reportCall, reportUsage, usageCost } from "./llm.ts";

// Распознавание речи: OpenAI-совместимый /audio/transcriptions (OpenAI, Groq, локальный whisper-сервер).
// По умолчанию — тот же адрес и ключ, что у LLM; свой задаётся STT_BASE_URL / STT_API_KEY / STT_MODEL.

export const sttReady = () => Boolean(config.stt.apiKey);

/** Самая длинная запись, которую принимаем (байты аудио). */
export const VOICE_MAX_BYTES = 5_000_000;

/** Байт в секунду записи виджета и сайта: оба пишут Opus с audioBitsPerSecond 32 000 (desktop/renderer/voice.js, web/src/recorder.ts). */
export const VOICE_BYTES_PER_SEC = 4000;
/** Больше байт в секунду почти не бывает (128 кбит/с, mp3 и AAC): названная клиентом длительность не может быть короче размер / это. */
export const VOICE_MAX_BYTES_PER_SEC = 16_000;
/** Секунды голоса для лимита в штуках (access.ts), вверх до целых, не меньше 1. Длительность от клиента (сайт, Telegram
 *  voice.duration) — но не короче, чем записалось бы при 128 кбит/с (занизить её сильно нельзя); не прислал (виджет 0.1.92) — по
 *  размеру при 32 кбит/с, как пишут виджет и сайт. opus — запись наших клиентов (/api/voice, webm и ogg): они пишут 32 кбит/с,
 *  поэтому и названная длительность не короче размера при 32 кбит/с (иначе sec: 0 засчитывал бы вчетверо меньше). */
export function voiceSeconds(bytes: number, sec?: number | null, opus = false): number {
  const b = Math.max(0, bytes);
  if (sec == null || !Number.isFinite(sec)) return Math.max(1, Math.ceil(b / VOICE_BYTES_PER_SEC));
  return Math.max(1, Math.ceil(Math.max(0, sec)), Math.ceil(b / (opus ? VOICE_BYTES_PER_SEC : VOICE_MAX_BYTES_PER_SEC)));
}
/** Запись в Opus (webm, ogg) — так пишут сайт и виджет. */
export const isOpusMime = (mime: string) => /^audio\/(webm|ogg)/i.test(mime.trim());

const EXT: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
};

export async function transcribe(audio: Buffer, mime: string): Promise<string> {
  if (!config.stt.apiKey) throw Object.assign(new Error("распознавание речи не настроено (нет ключа)"), { code: "no_key" });
  const type = mime.split(";")[0].trim().toLowerCase();
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)], { type: type || "audio/webm" }), `voice.${EXT[type] ?? "webm"}`);
  form.append("model", config.stt.model);
  form.append("language", "ru");
  form.append("response_format", "json");
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const t0 = performance.now();
    try {
      const res = await fetch(`${config.stt.baseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.stt.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(60_000),
      });
      if (res.status === 429 || res.status >= 500) throw Object.assign(new Error(`распознавание ${res.status}: ${await res.text()}`), { status: res.status });
      if (!res.ok) throw Object.assign(new Error(`распознавание ${res.status}: ${(await res.text()).slice(0, 300)}`), { status: res.status, fatal: true });
      // usage есть не у всех: OpenAI — токены (input_tokens) или секунды, OpenRouter ещё и цену (cost).
      const data = (await res.json()) as { text?: string; usage?: { input_tokens?: number; output_tokens?: number; cost?: number } };
      const cost = usageCost(data.usage);
      reportUsage({ kind: "voice", model: config.stt.model, input: data.usage?.input_tokens ?? 0, output: data.usage?.output_tokens ?? 0, cost });
      reportCall({ kind: "voice", model: config.stt.model, ms: performance.now() - t0, cost });
      return (data.text ?? "").trim();
    } catch (e) {
      reportCall({ kind: "voice", model: config.stt.model, ms: performance.now() - t0, cost: null, error: llmErrorCode(e) });
      lastErr = e;
      if ((e as { fatal?: boolean }).fatal) break;
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  throw lastErr;
}
