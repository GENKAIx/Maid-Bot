import { config } from "./config.ts";
import { reportUsage, usageCost } from "./llm.ts";

// Распознавание речи: OpenAI-совместимый /audio/transcriptions (OpenAI, Groq, локальный whisper-сервер).
// По умолчанию — тот же адрес и ключ, что у LLM; свой задаётся STT_BASE_URL / STT_API_KEY / STT_MODEL.

export const sttReady = () => Boolean(config.stt.apiKey);

/** Самая длинная запись, которую принимаем (байты аудио). */
export const VOICE_MAX_BYTES = 5_000_000;

const EXT: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
};

export async function transcribe(audio: Buffer, mime: string): Promise<string> {
  if (!config.stt.apiKey) throw new Error("распознавание речи не настроено (нет ключа)");
  const type = mime.split(";")[0].trim().toLowerCase();
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)], { type: type || "audio/webm" }), `voice.${EXT[type] ?? "webm"}`);
  form.append("model", config.stt.model);
  form.append("language", "ru");
  form.append("response_format", "json");
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${config.stt.baseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.stt.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(60_000),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`распознавание ${res.status}: ${await res.text()}`);
      if (!res.ok) throw Object.assign(new Error(`распознавание ${res.status}: ${(await res.text()).slice(0, 300)}`), { fatal: true });
      // usage есть не у всех: OpenAI — токены (input_tokens) или секунды, OpenRouter ещё и цену (cost).
      const data = (await res.json()) as { text?: string; usage?: { input_tokens?: number; output_tokens?: number; cost?: number } };
      reportUsage({ kind: "voice", model: config.stt.model, input: data.usage?.input_tokens ?? 0, output: data.usage?.output_tokens ?? 0, cost: usageCost(data.usage) });
      return (data.text ?? "").trim();
    } catch (e) {
      lastErr = e;
      if ((e as { fatal?: boolean }).fatal) break;
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  throw lastErr;
}
