// Тарифы из базы (24.11.2026, этап 1 макета docs/review/тарифы-и-управление-макет-2026-11-24.html): разделы админки «Тарифы» и
// «Общие потолки» (screens/AdminTariffs.tsx). Данные — GET /api/admin/tariffs, «Применить» — POST /api/admin/tariffs
// { values, reason }, откат — POST /api/admin/tariffs/undo { id, reason } (server/src/tariffs.ts).
// TARIFF_SPEC, checkTariffValue и checkTariffPatch — копия server/src/tariffs.ts один в один (server/test/tariffs.test.ts сверяет):
// подсказка под полем и 400 сервера говорят одно и то же.
// Этап 2 (24.11.2026): лимиты в штуках на человека в день (запросы к ИИ, картинки, минуты голоса), подарок по /invite — свой тариф,
// тексты при упоре в лимит (поля-строки kind text). Тариф «Плюс» — потом.

export type TariffKey =
  | "price" | "trialDays" | "giftDays" | "signupsOpen" | "signupsPerHour" | "signupsPerDay" | "aiBurst" | "aiWindowMs"
  | "trialDayUsd" | "paidDayUsd" | "trialPoolDayUsd" | "unpricedDrawUsd" | "unpricedVoiceUsd" | "unpricedOtherUsd" | "starUsd"
  | "trialCalls" | "trialDraws" | "trialVoiceMin" | "paidCalls" | "paidDraws" | "paidVoiceMin"
  | "giftDayUsd" | "giftCalls" | "giftDraws" | "giftVoiceMin" | "limitText" | "paidLimitText";
export type TariffTextKey = "limitText" | "paidLimitText";
export type TariffValue = number | boolean | string;
export type TariffValues = { [K in TariffKey]: K extends "signupsOpen" ? boolean : K extends TariffTextKey ? string : number };
export type TariffSpec = { kind: "int" | "num" | "bool" | "text"; min?: number; max?: number };

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
  // Лимиты в штуках в день: 0 — функция на тарифе недоступна.
  trialCalls: { kind: "int", min: 0, max: 100_000 },
  trialDraws: { kind: "int", min: 0, max: 100_000 },
  trialVoiceMin: { kind: "int", min: 0, max: 100_000 },
  paidCalls: { kind: "int", min: 0, max: 100_000 },
  paidDraws: { kind: "int", min: 0, max: 100_000 },
  paidVoiceMin: { kind: "int", min: 0, max: 100_000 },
  giftDayUsd: { kind: "num", min: 0.01, max: 100 },
  giftCalls: { kind: "int", min: 0, max: 100_000 },
  giftDraws: { kind: "int", min: 0, max: 100_000 },
  giftVoiceMin: { kind: "int", min: 0, max: 100_000 },
  limitText: { kind: "text", min: 1, max: 300 },
  paidLimitText: { kind: "text", min: 1, max: 300 },
};
export const isTextKey = (k: TariffKey): k is TariffTextKey => TARIFF_SPEC[k].kind === "text";
export const TARIFF_KEYS = Object.keys(TARIFF_SPEC) as TariffKey[];

export function checkTariffValue(key: string, v: unknown): string | null {
  // Только свои ключи: constructor, toString, __proto__ из прототипа — «неизвестное поле».
  const s = Object.hasOwn(TARIFF_SPEC, key) ? TARIFF_SPEC[key as TariffKey] : undefined;
  if (!s) return `неизвестное поле ${key}`;
  if (s.kind === "bool") return typeof v === "boolean" ? null : `${key}: нужно да или нет`;
  if (s.kind === "text") {
    if (typeof v !== "string") return `${key}: нужен текст`;
    if (v.trim().length < (s.min ?? 0)) return `${key}: напишите текст`;
    if (v.length > (s.max ?? Infinity)) return `${key}: не длиннее ${s.max} знаков`;
    if (/[<>&]/.test(v)) return `${key}: без знаков < > &`;
    // eslint-disable-next-line no-control-regex -- управляющие знаки и есть то, что ищем
    if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(v)) return `${key}: без служебных знаков`;
    return null;
  }
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
export interface TariffChange { key: TariffKey; from: TariffValue; to: TariffValue }
/** quota_days — дни, когда человек выбрал хоть один лимит в штуках целиком (старый сервер без поля — нет). */
export interface PlanEconomy { people: number; spenders: number; avg_month_usd: number | null; worst_month_usd: number | null; worst_day_usd: number | null; capped_days: number; quota_days?: number }
/** Средние цены единиц лимита за 30 дней (server/src/tariffs.ts unitPrices); нет данных — null. */
export interface UnitPrices { call_usd: number | null; draw_usd: number | null; voice_min_usd: number | null }
export interface TariffHistoryView { id: number; at: string; who: string; source: string; reason: string; changes: TariffChange[] }
export interface TariffsData {
  values: TariffValues;
  defaults: TariffValues;
  overridden: string[];
  reload_ms: number;
  /** SIGNUPS_OPEN=0 в .env сервера: регистрация закрыта поверх выключателя (старый сервер без поля — нет). */
  env_closed?: boolean;
  history: TariffHistoryView[];
  economy: { trial: PlanEconomy; paid: PlanEconomy; gift?: PlanEconomy };
  unit_prices?: UnitPrices;
  now: { trial_pool_today_usd: number; signups_hour: number; signups_day: number };
}

export type TariffPart = "plans" | "caps";

/** Поле в разделе: подпись, единица, пояснение; scale — во сколько раз число на сервере больше числа в поле (окно: мс ↔ с). */
export interface TariffField { key: TariffKey; title: string; unit: string; hint?: string; step: number; scale?: number }

const CALLS_HINT = "обращения человека: сообщение, голосовое, фото, /ask, поправка; видно человеку; 0 — нельзя";
const ZERO_HINT = "0 — на тарифе нельзя";
const CAP_HINT = "скрытый потолок $ на человека за день UTC (llm_usage), если что-то пошло не так";
/** Лимиты в штуках карточки: запросы, картинки, голос — по макету FIELDS. */
const limitFields = (p: "trial" | "paid" | "gift"): TariffField[] => [
  { key: `${p}Calls` as TariffKey, title: "Запросов к ИИ в день", unit: "шт.", hint: CALLS_HINT, step: 10 },
  { key: `${p}Draws` as TariffKey, title: "Картинок в день", unit: "шт.", hint: ZERO_HINT, step: 1 },
  { key: `${p}VoiceMin` as TariffKey, title: "Голоса в день", unit: "мин", hint: ZERO_HINT, step: 5 },
  { key: `${p}DayUsd` as TariffKey, title: "Денежный предохранитель", unit: "$/день", hint: CAP_HINT, step: 0.1 },
];

/** Карточки «Тарифов»: проба, подписка, подарок по /invite — у каждого свой срок (цена), лимиты в штуках и денежный предохранитель. */
export const PLAN_CARDS: { id: "trial" | "paid" | "gift"; title: string; who: string; fields: TariffField[] }[] = [
  {
    id: "trial", title: "Проба", who: "каждому новому после /start",
    fields: [{ key: "trialDays", title: "Срок", unit: "дн.", step: 1 }, ...limitFields("trial")],
  },
  {
    id: "paid", title: "Подписка", who: "оплатили звёздами в Telegram",
    fields: [
      { key: "price", title: "Цена", unit: "⭐ / 30 дн.", hint: "новая цена — только для новых счетов: уже оформленную подписку Telegram продлевает по цене при оформлении", step: 10 },
      ...limitFields("paid"),
    ],
  },
  {
    id: "gift", title: "Подарок по /invite", who: "приглашённые владельцем",
    fields: [{ key: "giftDays", title: "Срок", unit: "дн.", hint: "продлевает срок и тем, у кого запись уже есть", step: 1 }, ...limitFields("gift")],
  },
];
/** «Общие потолки» → карточка «Что увидит человек, когда лимит кончился»: тексты Рины при упоре в лимит в штуках. */
export const LIMIT_TEXTS: TariffField[] = [
  { key: "limitText", title: "Проба и подарок", unit: "", hint: "с выходом — подпиской", step: 0 },
  { key: "paidLimitText", title: "Подписка", unit: "", hint: "без фразы про подписку — она уже есть", step: 0 },
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
  caps: ["signupsOpen", ...CAP_GROUPS.flatMap((g) => g.fields.map((f) => f.key)), ...LIMIT_TEXTS.map((f) => f.key)],
};

const FIELD_OF = new Map<TariffKey, TariffField>([...PLAN_CARDS.flatMap((c) => c.fields), ...PLAN_EXTRA, ...CAP_GROUPS.flatMap((g) => g.fields), ...LIMIT_TEXTS].map((f) => [f.key, f]));
export const fieldOf = (k: TariffKey): TariffField | undefined => FIELD_OF.get(k);

/** Число сервера → текст поля (окно — в секундах); текст — как есть. */
export function toInput(key: TariffKey, v: number | string): string {
  if (typeof v === "string") return v;
  const s = fieldOf(key)?.scale ?? 1;
  return String(Math.round((v / s) * 1e4) / 1e4);
}
/** Текст поля → число сервера и ошибка той же проверкой, что на сервере (checkTariffValue). Запятая — как точка. Поле-текст — как
 *  написано (без пробелов по краям). */
export function fromInput(key: TariffKey, text: string): { value: number | string; error: string | null } {
  if (isTextKey(key)) {
    const v = text.trim();
    return { value: v, error: checkTariffValue(key, v) };
  }
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

const TITLES: Partial<Record<TariffKey, string>> = { signupsOpen: "Регистрация новых", limitText: "Текст при упоре в лимит (проба и подарок)", paidLimitText: "Текст при упоре в лимит (подписка)" };
/** Подпись поля для плашки и истории: «Подписка: цена», «Окно частоты». */
export function tariffTitle(k: TariffKey): string {
  const card = PLAN_CARDS.find((c) => c.fields.some((f) => f.key === k));
  const f = fieldOf(k);
  return TITLES[k] ?? (card ? `${card.title}: ${f!.title.toLowerCase()}` : f?.title ?? k);
}
/** Значение с единицей: «150 ⭐ / 30 дн.», «60 с», «открыта». */
export function tariffValueText(k: TariffKey, v: TariffValue): string {
  if (typeof v === "boolean") return v ? "открыта" : "закрыта";
  if (typeof v === "string") return `«${v.length > 60 ? `${v.slice(0, 60)}…` : v}»`;
  const f = fieldOf(k);
  return `${toInput(k, v)}${f?.unit ? ` ${f.unit}` : ""}`;
}
/** Два текста для «было → стало» (плашка, история, откат): короткие — целиком; длинные — без общего начала и конца, только
 *  отличающийся кусок с парой слов вокруг («…»): иначе правка в хвосте длинного текста выглядела бы «тот же текст → тот же текст». */
export function textChange(a: string, b: string, max = 60, around = 15): [string, string] {
  if (a.length <= max && b.length <= max) return [a, b];
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  let from = Math.max(0, head - around);
  const space = a.indexOf(" ", from); // с начала слова
  if (from > 0 && space >= 0 && space < head) from = space + 1;
  const cut = (x: string) => {
    const to = Math.min(x.length, x.length - tail + around);
    return `${from > 0 ? "…" : ""}${x.slice(from, to)}${to < x.length ? "…" : ""}`;
  };
  return [cut(a), cut(b)];
}
export const changeText = (c: TariffChange) => {
  const [from, to] = typeof c.from === "string" && typeof c.to === "string"
    ? textChange(c.from, c.to).map((x) => `«${x}»`)
    : [tariffValueText(c.key, c.from), tariffValueText(c.key, c.to)];
  return `${tariffTitle(c.key)}: ${from} → ${to}`;
};

/** Деньги для карточек: $1.95, мелочь — $0.012; нет данных — «—». */
export function money(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  return `${v < 0 ? "−" : ""}$${a < 0.1 && a > 0 ? a.toFixed(3) : a.toFixed(2)}`;
}

/** Выручка подписки за месяц с человека, $: цена × курс звезды. */
export const paidRevenue = (v: TariffValues) => v.price * v.starUsd;

export interface TariffWarning { kind: "bad" | "warn" | "info"; text: string }

/** Худший день человека на тарифе, $: выбрал все лимиты в штуках по средним ценам (prices), но не больше денежного предохранителя.
 *  Цены нет у нужной штуки (лимит > 0, а данных ещё нет) — по штукам не посчитать, остаётся только предохранитель (by: "cap"). */
export function worstDay(v: TariffValues, plan: "trial" | "paid" | "gift", prices?: UnitPrices | null): { usd: number; by: "cap" | "limits" } {
  const cap = v[`${plan}DayUsd`];
  const parts: [number, number | null | undefined][] = [
    [v[`${plan}Calls`], prices?.call_usd], [v[`${plan}Draws`], prices?.draw_usd], [v[`${plan}VoiceMin`], prices?.voice_min_usd],
  ];
  if (parts.some(([n, p]) => n > 0 && p == null)) return { usd: cap, by: "cap" };
  const sum = parts.reduce((s, [n, p]) => s + (n > 0 ? n * p! : 0), 0);
  return sum < cap ? { usd: sum, by: "limits" } : { usd: cap, by: "cap" };
}

/** Предупреждения, которые честно считаются из чисел черновика (draft) и действующих (applied); part — какой раздел;
 *  envClosed — SIGNUPS_OPEN=0 в .env сервера; prices — средние цены единиц лимита (нет — худший случай по предохранителю). */
export function tariffWarnings(draft: TariffValues, applied: TariffValues, part: TariffPart, envClosed = false, prices?: UnitPrices | null): TariffWarning[] {
  const out: TariffWarning[] = [];
  if (part === "plans") {
    const rev = paidRevenue(draft), w = worstDay(draft, "paid", prices), worstMonth = w.usd * 30;
    if (worstMonth > rev) {
      const how = w.by === "limits"
        ? `человек каждый день выбирает все лимиты в штуках: средние цены за 30 дней — запрос ${money(prices?.call_usd)}, картинка ${money(prices?.draw_usd)}, минута голоса ${money(prices?.voice_min_usd)}`
        : `человек каждый день упирается в денежный предохранитель ${money(draft.paidDayUsd)}/день${prices ? "" : " (средних цен ещё нет — по штукам не посчитать)"}`;
      out.push({ kind: "bad", text: `Худший случай по подписке за 30 дней — ${money(worstMonth)}: ${how}. Это больше месячной выручки с человека (${money(rev)}: ${draft.price} ⭐ × $${draft.starUsd}) — такой подписчик обходится дороже, чем платит.` });
    }
    if (draft.price !== applied.price) {
      out.push({ kind: "warn", text: "Цена меняется только для новых счетов. Уже оформленную подписку Telegram продлевает по цене, что была при оформлении (по документации Bot API), — подписчики платят старую, пока не отменят подписку. Старые ссылки на оплату перестанут приниматься — бот и сайт выдадут новые." });
    }
    for (const [p, name] of [["trial", "пробы"], ["paid", "подписки"], ["gift", "подарка"]] as const) {
      if (draft[`${p}Calls`] === 0) out.push({ kind: "warn", text: `Запросов к ИИ у ${name} — 0: ИИ на этом тарифе закрыт совсем (разбор, разговор, голос и картинки).` });
    }
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
