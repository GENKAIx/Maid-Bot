// Тарифы из базы (24.11.2026, этап 1 макета docs/review/тарифы-и-управление-макет-2026-11-24.html): разделы админки «Тарифы» и
// «Общие потолки» (screens/AdminTariffs.tsx). Данные — GET /api/admin/tariffs, «Применить» — POST /api/admin/tariffs
// { values, reason }, откат — POST /api/admin/tariffs/undo { id, reason } (server/src/tariffs.ts).
// TARIFF_SPEC, checkTariffValue и checkTariffPatch — копия server/src/tariffs.ts один в один (server/test/tariffs.test.ts сверяет):
// подсказка под полем и 400 сервера говорят одно и то же.
// Лимиты в штуках (запросы, картинки, голос) и свои тарифы «Подарок» и «Плюс» — этап 2: числа ещё согласуются.

export type TariffKey =
  | "price" | "trialDays" | "giftDays" | "signupsOpen" | "signupsPerHour" | "signupsPerDay" | "aiBurst" | "aiWindowMs"
  | "trialDayUsd" | "paidDayUsd" | "trialPoolDayUsd" | "unpricedDrawUsd" | "unpricedVoiceUsd" | "unpricedOtherUsd" | "starUsd";
export type TariffValues = { [K in TariffKey]: K extends "signupsOpen" ? boolean : number };
export type TariffSpec = { kind: "int" | "num" | "bool"; min?: number; max?: number };

export const TARIFF_SPEC: Record<TariffKey, TariffSpec> = {
  price: { kind: "int", min: 1, max: 10_000 },
  trialDays: { kind: "int", min: 1, max: 365 },
  giftDays: { kind: "int", min: 1, max: 365 },
  signupsOpen: { kind: "bool" },
  signupsPerHour: { kind: "int", min: 1, max: 10_000 },
  signupsPerDay: { kind: "int", min: 1, max: 100_000 },
  aiBurst: { kind: "int", min: 1, max: 1000 },
  aiWindowMs: { kind: "int", min: 1000, max: 3_600_000 },
  // Денежные потолки — не ноль: «расход ≥ 0» закрыл бы ИИ всем на плане, а не снял потолок.
  trialDayUsd: { kind: "num", min: 0.01, max: 100 },
  paidDayUsd: { kind: "num", min: 0.01, max: 100 },
  trialPoolDayUsd: { kind: "num", min: 0.01, max: 100 },
  unpricedDrawUsd: { kind: "num", min: 0, max: 100 },
  unpricedVoiceUsd: { kind: "num", min: 0, max: 100 },
  unpricedOtherUsd: { kind: "num", min: 0, max: 100 },
  starUsd: { kind: "num", min: 0, max: 1 },
};
export const TARIFF_KEYS = Object.keys(TARIFF_SPEC) as TariffKey[];

export function checkTariffValue(key: string, v: unknown): string | null {
  // Только свои ключи: constructor, toString, __proto__ из прототипа — «неизвестное поле».
  const s = Object.hasOwn(TARIFF_SPEC, key) ? TARIFF_SPEC[key as TariffKey] : undefined;
  if (!s) return `неизвестное поле ${key}`;
  if (s.kind === "bool") return typeof v === "boolean" ? null : `${key}: нужно да или нет`;
  if (typeof v !== "number" || !Number.isFinite(v)) return `${key}: нужно число`;
  if (s.kind === "int" && !Number.isInteger(v)) return `${key}: нужно целое число`;
  if (s.kind === "num" && Math.abs(v * 1e4 - Math.round(v * 1e4)) > 1e-6) return `${key}: не больше 4 знаков после запятой`;
  if (key === "aiWindowMs" && v % 1000 !== 0) return `${key}: целые секунды`;
  if (s.min !== undefined && v < s.min) return `${key}: не меньше ${s.min}`;
  if (s.max !== undefined && v > s.max) return `${key}: не больше ${s.max}`;
  return null;
}

export function checkTariffPatch(raw: unknown): { ok: true; patch: Partial<TariffValues> } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "нужен объект с числами" };
  const keys = Object.keys(raw);
  if (!keys.length) return { ok: false, error: "нечего менять" };
  for (const k of keys) {
    const why = checkTariffValue(k, (raw as Record<string, unknown>)[k]);
    if (why) return { ok: false, error: why };
  }
  return { ok: true, patch: raw as Partial<TariffValues> };
}

// ——— Ответ GET /api/admin/tariffs (server/src/tariffs.ts tariffsView).
export interface TariffChange { key: TariffKey; from: number | boolean; to: number | boolean }
export interface PlanEconomy { people: number; spenders: number; avg_month_usd: number | null; worst_month_usd: number | null; worst_day_usd: number | null; capped_days: number }
export interface TariffHistoryView { id: number; at: string; who: string; source: string; reason: string; changes: TariffChange[] }
export interface TariffsData {
  values: TariffValues;
  defaults: TariffValues;
  overridden: string[];
  reload_ms: number;
  /** SIGNUPS_OPEN=0 в .env сервера: регистрация закрыта поверх выключателя (старый сервер без поля — нет). */
  env_closed?: boolean;
  history: TariffHistoryView[];
  economy: { trial: PlanEconomy; paid: PlanEconomy };
  now: { trial_pool_today_usd: number; signups_hour: number; signups_day: number };
}

export type TariffPart = "plans" | "caps";

/** Поле в разделе: подпись, единица, пояснение; scale — во сколько раз число на сервере больше числа в поле (окно: мс ↔ с). */
export interface TariffField { key: TariffKey; title: string; unit: string; hint?: string; step: number; scale?: number }

/** Карточки «Тарифов»: проба, подписка, подарок (у подарка — только срок: лимиты у него пробы). */
export const PLAN_CARDS: { id: "trial" | "paid" | "gift"; title: string; who: string; fields: TariffField[] }[] = [
  {
    id: "trial", title: "Проба", who: "каждому новому после /start",
    fields: [
      { key: "trialDays", title: "Срок", unit: "дн.", step: 1 },
      { key: "trialDayUsd", title: "Денежный потолок", unit: "$/день", hint: "свой у человека, по llm_usage за день UTC", step: 0.1 },
    ],
  },
  {
    id: "paid", title: "Подписка", who: "оплатили звёздами в Telegram",
    fields: [
      { key: "price", title: "Цена", unit: "⭐ / 30 дн.", hint: "новая цена — только для новых счетов: уже оформленную подписку Telegram продлевает по цене при оформлении", step: 10 },
      { key: "paidDayUsd", title: "Денежный потолок", unit: "$/день", hint: "свой у человека, по llm_usage за день UTC", step: 0.1 },
    ],
  },
  {
    id: "gift", title: "Подарок по /invite", who: "приглашённые владельцем",
    fields: [{ key: "giftDays", title: "Срок", unit: "дн.", hint: "продлевает срок и тем, у кого запись уже есть", step: 1 }],
  },
];
/** Внизу «Тарифов»: курс звезды для экономики и аналитики. */
export const PLAN_EXTRA: TariffField[] = [
  { key: "starUsd", title: "Сколько $ за 1 ⭐", unit: "$", hint: "оценка после комиссий — только для экономики и аналитики, людям не видна", step: 0.001 },
];

/** «Общие потолки»: защита всего сервера и одна частота ИИ на пробу и подписку. */
export const CAP_GROUPS: { title: string; hint: string; fields: TariffField[] }[] = [
  {
    title: "Регистрация", hint: "незнакомцы по /start без приглашения; /signups off|on в боте — тот же выключатель",
    fields: [
      { key: "signupsPerHour", title: "Регистраций в час", unit: "на сервер", step: 5 },
      { key: "signupsPerDay", title: "Регистраций в сутки", unit: "на сервер", step: 10 },
    ],
  },
  {
    title: "Частота ИИ", hint: "одна на пробу и подписку; друзьям и владельцу — без ограничения",
    fields: [
      { key: "aiBurst", title: "Вызовов за окно", unit: "шт.", step: 1 },
      { key: "aiWindowMs", title: "Окно частоты", unit: "с", hint: "за сколько секунд считаются вызовы", step: 10, scale: 1000 },
    ],
  },
  {
    title: "Деньги", hint: "по llm_usage за день UTC",
    fields: [
      { key: "trialPoolDayUsd", title: "Общий потолок проб", unit: "$/день", hint: "все пробы вместе: наплыв одноразовых аккаунтов не съест бюджет", step: 1 },
      { key: "unpricedDrawUsd", title: "Рисунок без цены", unit: "$", hint: "если провайдер не вернул цену — для потолков", step: 0.005 },
      { key: "unpricedVoiceUsd", title: "Голос без цены", unit: "$", step: 0.001 },
      { key: "unpricedOtherUsd", title: "Остальное без цены", unit: "$", step: 0.001 },
    ],
  },
];

/** Какие поля в каком разделе (выключатель регистрации — в «Общих потолках»). */
export const PART_KEYS: Record<TariffPart, TariffKey[]> = {
  plans: [...PLAN_CARDS.flatMap((c) => c.fields.map((f) => f.key)), ...PLAN_EXTRA.map((f) => f.key)],
  caps: ["signupsOpen", ...CAP_GROUPS.flatMap((g) => g.fields.map((f) => f.key))],
};

const FIELD_OF = new Map<TariffKey, TariffField>([...PLAN_CARDS.flatMap((c) => c.fields), ...PLAN_EXTRA, ...CAP_GROUPS.flatMap((g) => g.fields)].map((f) => [f.key, f]));
export const fieldOf = (k: TariffKey): TariffField | undefined => FIELD_OF.get(k);

/** Число сервера → текст поля (окно — в секундах). */
export function toInput(key: TariffKey, v: number): string {
  const s = fieldOf(key)?.scale ?? 1;
  return String(Math.round((v / s) * 1e4) / 1e4);
}
/** Текст поля → число сервера и ошибка той же проверкой, что на сервере (checkTariffValue). Запятая — как точка. */
export function fromInput(key: TariffKey, text: string): { value: number; error: string | null } {
  const t = text.trim().replace(",", ".");
  const n = t === "" ? NaN : Number(t);
  const s = fieldOf(key)?.scale ?? 1;
  const value = Number.isFinite(n) ? Math.round(n * s * 1e6) / 1e6 : NaN;
  return { value, error: checkTariffValue(key, value) };
}

/** Что изменилось в черновике по сравнению с действующими числами (только поля keys). */
export function tariffDiff(draft: TariffValues, applied: TariffValues, keys: TariffKey[] = TARIFF_KEYS): TariffChange[] {
  return keys.filter((k) => draft[k] !== applied[k]).map((k) => ({ key: k, from: applied[k], to: draft[k] }));
}

const TITLES: Partial<Record<TariffKey, string>> = { signupsOpen: "Регистрация новых" };
/** Подпись поля для плашки и истории: «Подписка: цена», «Окно частоты». */
export function tariffTitle(k: TariffKey): string {
  const card = PLAN_CARDS.find((c) => c.fields.some((f) => f.key === k));
  const f = fieldOf(k);
  return TITLES[k] ?? (card ? `${card.title}: ${f!.title.toLowerCase()}` : f?.title ?? k);
}
/** Значение с единицей: «150 ⭐ / 30 дн.», «60 с», «открыта». */
export function tariffValueText(k: TariffKey, v: number | boolean): string {
  if (typeof v === "boolean") return v ? "открыта" : "закрыта";
  const f = fieldOf(k);
  return `${toInput(k, v)}${f?.unit ? ` ${f.unit}` : ""}`;
}
export const changeText = (c: TariffChange) => `${tariffTitle(c.key)}: ${tariffValueText(c.key, c.from)} → ${tariffValueText(c.key, c.to)}`;

/** Деньги для карточек: $1.95, мелочь — $0.012; нет данных — «—». */
export function money(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  return `${v < 0 ? "−" : ""}$${a < 0.1 && a > 0 ? a.toFixed(3) : a.toFixed(2)}`;
}

/** Выручка подписки за месяц с человека, $: цена × курс звезды. */
export const paidRevenue = (v: TariffValues) => v.price * v.starUsd;

export interface TariffWarning { kind: "bad" | "warn" | "info"; text: string }

/** Предупреждения, которые честно считаются из чисел черновика (draft) и действующих (applied); part — какой раздел;
 *  envClosed — SIGNUPS_OPEN=0 в .env сервера. */
export function tariffWarnings(draft: TariffValues, applied: TariffValues, part: TariffPart, envClosed = false): TariffWarning[] {
  const out: TariffWarning[] = [];
  if (part === "plans") {
    const rev = paidRevenue(draft), capMonth = draft.paidDayUsd * 30;
    if (capMonth > rev) {
      out.push({ kind: "bad", text: `Денежный потолок подписки за 30 дней (${money(capMonth)}) больше месячной выручки с человека (${money(rev)}: ${draft.price} ⭐ × $${draft.starUsd}). Тот, кто каждый день выбирает потолок, обходится дороже, чем платит.` });
    }
    if (draft.price !== applied.price) {
      out.push({ kind: "warn", text: "Цена меняется только для новых счетов. Уже оформленную подписку Telegram продлевает по цене, что была при оформлении (по документации Bot API), — подписчики платят старую, пока не отменят подписку. Старые ссылки на оплату перестанут приниматься — бот и сайт выдадут новые." });
    }
    out.push({ kind: "info", text: "Подарок по /invite сейчас живёт по лимитам пробы: в базе он хранится как проба с отметкой «подарок» (access.ts trialLenOf). Свои лимиты подарка и тариф «Плюс» — этап 2." });
  } else {
    if (envClosed) out.push({ kind: "bad", text: "В .env сервера SIGNUPS_OPEN=0: регистрация закрыта, что бы ни стояло в выключателе ниже. Открыть — убрать SIGNUPS_OPEN=0 и перезапустить сервер." });
    if (!draft.signupsOpen) out.push({ kind: "warn", text: "Регистрация закрыта: незнакомцы по /start получают «Регистрация сейчас закрыта». Приглашения /invite работают." });
    if (draft.signupsPerDay < draft.signupsPerHour) out.push({ kind: "info", text: "Регистраций в сутки меньше, чем в час: часовой потолок никогда не сработает." });
    if (draft.trialPoolDayUsd < draft.trialDayUsd) out.push({ kind: "info", text: `Общий потолок проб (${money(draft.trialPoolDayUsd)}) меньше потолка одного человека на пробе (${money(draft.trialDayUsd)}).` });
  }
  return out;
}

/** Откуда строка истории: «Применить» в админке, откат, команда /signups в боте. */
export const TARIFF_SOURCES: Record<string, string> = { admin: "админка", undo: "откат", bot: "бот" };

/** «Вернуть как было» у строки истории h: что изменится сейчас (только поля этой строки — к значениям до неё; уже так — не в списке)
 *  и какие более поздние строки трогали те же поля (их правка этих полей тоже отменится). history — новые сверху. */
export function undoPreview(h: TariffHistoryView, values: TariffValues, history: TariffHistoryView[]): { changes: TariffChange[]; later: number[] } {
  const keys = new Set(h.changes.map((c) => c.key));
  const changes = h.changes.filter((c) => values[c.key] !== c.from).map((c) => ({ key: c.key, from: values[c.key], to: c.from }));
  const later = history.filter((x) => x.id > h.id && x.changes.some((c) => keys.has(c.key))).map((x) => x.id).sort((a, b) => a - b);
  return { changes, later };
}
