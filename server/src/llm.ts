import { config } from "./config.ts";

// OpenAI-совместимый чат (OpenAI, OpenRouter, локальный). В тестах подменяется функцией.

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type LlmCall = (messages: ChatMessage[], opts?: { json?: boolean; temperature?: number }) => Promise<string>;

export const llmReady = () => Boolean(config.llm.apiKey);

export const callLlm: LlmCall = async (messages, opts = {}) => {
  if (!config.llm.apiKey) throw new Error("LLM_API_KEY не задан");
  const body: Record<string, unknown> = {
    model: config.llm.model,
    messages,
    temperature: opts.temperature ?? 0.2,
  };
  if (opts.json) body.response_format = { type: "json_object" };
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.llm.apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`LLM ${res.status}: ${await res.text()}`);
      if (!res.ok) throw Object.assign(new Error(`LLM ${res.status}: ${await res.text()}`), { fatal: true });
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const text = data.choices?.[0]?.message?.content;
      if (!text) throw new Error("LLM вернул пустой ответ");
      return text;
    } catch (e) {
      lastErr = e;
      if ((e as { fatal?: boolean }).fatal) break;
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  throw lastErr;
};

/** Вытащить JSON-объект из ответа модели (бывает обёрнут в ```json). */
export function extractJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf("{");
    const b = t.lastIndexOf("}");
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new Error("В ответе модели нет JSON");
  }
}
