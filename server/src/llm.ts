import { AsyncLocalStorage } from "node:async_hooks";
import { config } from "./config.ts";

// OpenAI-совместимый чат (OpenAI, OpenRouter, локальный). В тестах подменяется функцией.

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  /** Картинки к сообщению пользователя (чеки, скриншоты) — уходят модели вместе с текстом. */
  images?: Picture[];
}

export interface Picture {
  mime: string;
  /** base64 без префикса data: */
  data: string;
}

/** Картинки больше не принимаем (клиенты сами уменьшают до ~1600 px, это сотни килобайт). */
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
/** Сколько картинок в одном сообщении и сколько всего байт на все. */
export const IMAGE_MAX_COUNT = 6;
export const IMAGES_MAX_BYTES = 20 * 1024 * 1024;
/** Какие картинки понимают модели со зрением. */
export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

/** Картинки — частями content в формате OpenAI (так их понимают и OpenRouter, и другие совместимые). */
const wire = (m: ChatMessage) =>
  m.images?.length
    ? {
        role: m.role,
        content: [
          { type: "text", text: m.content },
          ...m.images.map((i) => ({ type: "image_url", image_url: { url: `data:${i.mime};base64,${i.data}` } })),
        ],
      }
    : { role: m.role, content: m.content };

export type LlmCall = (messages: ChatMessage[], opts?: { json?: boolean; temperature?: number; maxTokens?: number; kind?: UsageKind }) => Promise<string>;

/** Потолок длины ответа: разбор (JSON) — длиннее, разговор и ответы на вопросы — короче. */
export const MAX_TOKENS_JSON = 3000;
export const MAX_TOKENS_TEXT = 800;

/** На что ушёл запрос к модели (строки на сайте — web/src/screens/Settings.tsx, KIND_NAMES). */
export const USAGE_KINDS = ["parse", "answer", "chat", "summary", "patterns", "draw", "voice", "other"] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];
/** Расход одного запроса: токены и деньги (cost — доллары, null — провайдер цену не сообщил). index.ts складывает по дням (таблица llm_usage). */
/** userId — чей запрос (учёт по людям, /accounts); 0 — ничей или не известно. */
export interface LlmUsage { kind: UsageKind; model: string; input: number; output: number; cost: number | null; userId?: number }
let usageSink: ((u: LlmUsage) => void) | null = null;
export const onLlmUsage = (fn: ((u: LlmUsage) => void) | null) => void (usageSink = fn);
// Чей сейчас запрос: бот, API и фоновые задачи оборачивают работу для человека в asUser — расход идёт на его счёт.
const usageUser = new AsyncLocalStorage<number>();
export const asUser = <T>(userId: number, fn: () => T): T => usageUser.run(userId, fn);
/** API: всё дальше в этом запросе — для этого человека (обернуть остаток обработчика в asUser нельзя — он длинный). */
export const enterUser = (userId: number) => usageUser.enterWith(userId);
/** Сообщить о расходе (модель, рисование, голос); ошибка учёта ответу не мешает. */
export function reportUsage(u: LlmUsage) {
  try { usageSink?.({ ...u, userId: u.userId ?? usageUser.getStore() ?? 0 }); } catch { /* учёт не мешает ответу */ }
}
/** OpenRouter присылает цену запроса в usage.cost (доллары), если попросить usage: { include: true }. */
export const isOpenRouter = (url: string) => /openrouter\.ai/.test(url);
const price = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
export const usageCost = (u: { cost?: unknown } | undefined) => price(u?.cost);

export const llmReady = () => Boolean(config.llm.apiKey);

export const callLlm: LlmCall = async (messages, opts = {}) => {
  if (!config.llm.apiKey) throw new Error("LLM_API_KEY не задан");
  const body: Record<string, unknown> = {
    model: config.llm.model,
    messages: messages.map(wire),
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.maxTokens ?? (opts.json ? MAX_TOKENS_JSON : MAX_TOKENS_TEXT),
  };
  if (opts.json) body.response_format = { type: "json_object" };
  if (isOpenRouter(config.llm.baseUrl)) body.usage = { include: true };
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
      const data = (await res.json()) as { model?: string; choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number } };
      if (data.usage) {
        reportUsage({ kind: opts.kind ?? "other", model: config.llm.model, input: data.usage.prompt_tokens ?? 0, output: data.usage.completion_tokens ?? 0, cost: usageCost(data.usage) });
      }
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
