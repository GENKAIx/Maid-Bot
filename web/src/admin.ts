// Админка сайта (/admin) без React: разделы и подписи журнала. Ревью — docs/review/админка-2026-11-24.html.
// Каркас (24.11.2026): Обзор и Журнал; этап 1 (24.11.2026): Пользователи, Расходы, Аудитория, Качество разбора — на готовых данных.
// Этап 2 (24.11.2026): онлайн, устройства, карта часов, версии виджета, дорогие сообщения и раздел «Здоровье сервера».
// Этап 3 (24.11.2026): «Использование функций» — счётчики фич (server/src/feature-events.ts, отчёт — admin-stats.ts adminFeatures).
// Этап 4 (24.11.2026): «Витрина» — анимации с проигрывателем, эффекты, сценарии, карта функций (screens/AdminShowcase.tsx,
// реестр web/src/registry.gen.ts пишет tools/registry/make_registry.ts).
// Тарифы (24.11.2026): «Тарифы» и «Общие потолки» — числа платного доступа из базы (web/src/tariffs.ts, screens/AdminTariffs.tsx).
// Этап 5 (24.11.2026): Аналитика — отчёты с шагом и сравнением с прошлым периодом (screens/AdminAnalytics.tsx, графики — adminCharts.tsx,
// ручка GET /api/admin/analytics — server/src/admin-analytics.ts; типы ниже — копия оттуда один в один).
// Этап 3 «Тарифы и управление» (24.11.2026): «Аккаунт» — карточка по номеру и действия с причиной (screens/AdminAccount.tsx,
// сервер — server/src/admin-account.ts); журнал админа — номера вместо имён, параметры и причина.
// stage — с какого этапа раздел живой (ADMIN_LIVE_STAGE и меньше — живой, больше — «появится на этапе N»).

export const ADMIN_LIVE_STAGE = 5;

export type AdminSectionId = "overview" | "analytics" | "users" | "account" | "payments" | "tariffs" | "caps" | "spend" | "audience" | "quality" | "features" | "showcase" | "health" | "log";

// Меню по категориям (24.11.2026): group — заголовок категории (ADMIN_GROUPS, по порядку), icon — имя в icons.tsx.
export const ADMIN_GROUPS = ["Обзор", "Люди и деньги", "ИИ", "Продукт", "Система"] as const;
export type AdminGroup = (typeof ADMIN_GROUPS)[number];

export const ADMIN_SECTIONS: { id: AdminSectionId; title: string; stage: number; group: AdminGroup; icon: string }[] = [
  { id: "overview", title: "Обзор", stage: 0, group: "Обзор", icon: "adm-home" },
  { id: "analytics", title: "Аналитика", stage: 5, group: "Обзор", icon: "adm-chart" },
  { id: "users", title: "Пользователи", stage: 1, group: "Люди и деньги", icon: "adm-users" },
  // Аккаунт по номеру (этап 3 «Тарифы и управление», screens/AdminAccount.tsx): /admin/account/<номер>.
  { id: "account", title: "Аккаунт", stage: 0, group: "Люди и деньги", icon: "adm-id" },
  { id: "payments", title: "Оплаты", stage: 0, group: "Люди и деньги", icon: "adm-star" },
  // Тарифы из базы (24.11.2026, screens/AdminTariffs.tsx): рядом с оплатами — это те же деньги; отдельная категория из двух пунктов
  // только раздула бы меню, а лимиты в штуках (этап 2) лягут в эти же два раздела.
  { id: "tariffs", title: "Тарифы", stage: 0, group: "Люди и деньги", icon: "adm-tag" },
  { id: "caps", title: "Общие потолки", stage: 0, group: "Люди и деньги", icon: "adm-gauge" },
  { id: "audience", title: "Аудитория", stage: 1, group: "Люди и деньги", icon: "adm-target" },
  { id: "spend", title: "Расходы на модель", stage: 1, group: "ИИ", icon: "adm-coins" },
  { id: "quality", title: "Качество разбора", stage: 1, group: "ИИ", icon: "adm-check" },
  { id: "features", title: "Использование функций", stage: 3, group: "Продукт", icon: "adm-spark" },
  { id: "showcase", title: "Витрина", stage: 4, group: "Продукт", icon: "adm-grid" },
  { id: "health", title: "Здоровье сервера", stage: 2, group: "Система", icon: "adm-pulse" },
  { id: "log", title: "Журнал админки", stage: 0, group: "Система", icon: "adm-log" },
];

/** Меню админки: категории по порядку ADMIN_GROUPS, внутри — разделы в порядке ADMIN_SECTIONS. Пустые категории не показываются. */
export function adminNavGroups() {
  return ADMIN_GROUPS.map((group) => ({ group, items: ADMIN_SECTIONS.filter((s) => s.group === group) })).filter((g) => g.items.length);
}

/** Раздел по адресу /admin/<раздел>; незнакомый и пустой — Обзор. */
export function adminSection(arg: string | undefined): AdminSectionId {
  return ADMIN_SECTIONS.find((s) => s.id === arg)?.id ?? "overview";
}

export const ADMIN_ACTIONS: Record<string, string> = {
  code: "запросил код в Telegram",
  enter: "вошёл в админку",
  wrong: "ввёл неверный код",
  leave: "вышел из админки",
  refund: "вернул звёзды",
  "refund-fail": "не смог вернуть звёзды",
  tariff: "изменил тарифы",
  tariff_undo: "вернул тарифы как было",
  extend: "продлил срок",
  grant: "выдал подарок",
  bonus: "поднял лимит на сегодня",
  freeze: "заморозил аккаунт",
  unfreeze: "разморозил аккаунт",
  "paysupport-answer": "ответил на вопрос об оплате",
};

// ——— Аккаунт по номеру (этап 3, GET /api/admin/account/<id>; типы — копия server/src/admin-account.ts accountCard).
export type AccountPlan = "owner" | "friend" | "paid" | "trial" | "expired" | "frozen";
export interface AccountUsed { used: number; limit: number; bonus: number }
export interface AccountCard {
  id: number; created_at: string; days_with_us: number;
  plan: AccountPlan; kind: "trial" | "gift" | "paid" | null; until: string | null; canceled: boolean;
  live_sub: boolean; frozen_at: string | null; protected: boolean; ended: "trial" | "gift" | "paid" | null;
  today: { day: string; resets_at: string; calls: AccountUsed; draws: AccountUsed; voice_sec: AccountUsed; spend_usd: number; cap_usd: number } | null;
  payments: { charge: string; amount: number; currency: string; kind: string; paid_at: string; expires_at: string | null; refunded_at: string | null; refundable: boolean }[];
  events: { at: string; kind: string; amount: number | null }[];
  week: { day: string; ai: number; manual: number; minutes: number; calls: number; usd: number }[];
  devices: { client: string; version: string; last_seen: string; count: number }[];
  last_seen: string | null;
  log: { at: string; who: string; action: string; detail: string; reason: string }[];
}

/** Номер аккаунта из адреса /admin/account/<номер> (нет или не число — null). */
export function accountIdOf(path: string): number | null {
  const m = /^\/admin\/account\/#?(\d{1,12})\/?$/.exec(path);
  return m ? Number(m[1]) : null;
}
/** Номер из поля «Найти»: «1042», «#1042» — 1042; иначе null. */
export function accountQuery(q: string): number | null {
  const m = /^\s*#?(\d{1,12})\s*$/.exec(q);
  const n = m ? Number(m[1]) : 0;
  return n > 0 ? n : null;
}

/** Журнал подписки (billing_events.kind, server/src/db.ts BILLING_KINDS) по-человечески. */
export const BILLING_EVENT_NAMES: Record<string, string> = {
  paid_first: "Первая оплата подписки", paid_once: "Разовая оплата", renewed: "Продление", canceled: "Отменил продление", resumed: "Возобновил продление",
  refunded: "Возврат звёзд", expired: "Подписка кончилась", trial_ended: "Проба кончилась", gift_ended: "Подарок кончился",
  trial_started: "Проба при регистрации", gift: "Подарок по приглашению", admin_extend: "Админ продлил срок", admin_grant: "Админ выдал подарок",
};

/** Тариф в карточке: «Подписка до 01.12.2026», «Подарок до …», «Проба до …», «Друг», «Заморожен», «Срок кончился (подписка)». */
export function accountPlanText(c: Pick<AccountCard, "plan" | "kind" | "until" | "canceled" | "ended">): string {
  const until = c.until ? new Date(c.until).toLocaleDateString("ru-RU") : "—";
  if (c.plan === "owner") return "Владелец — без сроков и лимитов";
  if (c.plan === "friend") return "Друг — бесплатно навсегда";
  if (c.plan === "frozen") return "Заморожен";
  if (c.plan === "paid") return `Подписка до ${until}${c.canceled ? " (продление отменено)" : ""}`;
  if (c.plan === "trial") return `${c.kind === "gift" ? "Подарок" : "Проба"} до ${until}`;
  return `Срок кончился${c.ended ? ` (${c.ended === "paid" ? "подписка" : c.ended === "gift" ? "подарок" : "проба"})` : ""}${c.until ? `, ${until}` : ""}`;
}

/** «Сегодня» в карточке: «37 из 400 (+20)»; голос — в минутах. */
export function usedText(u: AccountUsed, voice = false): string {
  const k = (n: number) => (voice ? Math.floor(n / 60) : n);
  return `${k(u.used)} из ${k(u.limit)}${u.bonus ? ` (+${k(u.bonus)})` : ""}${voice ? " мин" : ""}`;
}

/** Что можно сделать с аккаунтом (кнопки карточки): продлить и подарить — не другу, не владельцу и не замороженному (сначала
 *  разморозить); подарок — не поверх идущей оплаченной подписки (и с отменённым продлением тоже); лимит — только с тарифом;
 *  заморозить — не защищённого и не уже замороженного. Сервер проверяет то же самое. */
export function accountCan(c: Pick<AccountCard, "plan" | "kind" | "live_sub" | "frozen_at" | "protected">) {
  const free = c.plan === "owner" || c.plan === "friend" || c.protected;
  return {
    extend: !free && !c.frozen_at,
    grant: !free && !c.frozen_at && !c.live_sub && c.plan !== "paid",
    bonus: Boolean(c.kind),
    freeze: !c.protected && !c.frozen_at,
    unfreeze: Boolean(c.frozen_at),
  };
}

// ——— Оплаты (24.11.2026, подписка Telegram Stars: server/src/billing.ts, отчёт — admin-stats.ts adminPayments).
export type PaymentRow = {
  user_id: number; name: string; amount: number; currency: string; kind: string;
  paid_at: string; expires_at: string | null; refunded_at: string | null; charge: string;
};

/** Вид оплаты (payments.kind): первая оплата подписки, продление, разовая. */
export const PAYMENT_KINDS: Record<string, string> = { first: "Подписка", renew: "Продление", once: "Разовая" };

/** Сумма: звёзды — «⭐150», другая валюта — «150 USD». */
export function starsText(amount: number, currency = "XTR"): string {
  return currency === "XTR" ? `⭐${amount}` : `${amount} ${currency}`;
}

/** Можно ли вернуть оплату кнопкой: не возвращена и это последняя невозвращённая у человека (сервер возвращает именно её,
 *  billing.ts refund). rows — новые сверху, как отдаёт /api/admin/payments. */
export function refundable(rows: PaymentRow[], i: number): boolean {
  const p = rows[i];
  if (!p || p.refunded_at) return false;
  return rows.findIndex((x) => x.user_id === p.user_id && !x.refunded_at) === i;
}

/** Деньги: $0.123 → «$0.12», мелочь — с тремя знаками, ноль — «$0». */
export function usd(v: number): string {
  if (!v) return "$0";
  return v < 0.1 ? `$${v.toFixed(3)}` : `$${v.toFixed(2)}`;
}

/** «Когда»: сегодня — время, вчера — «вчера», раньше — «N дн. назад», больше месяца — дата. */
export function ago(iso: string | null, now = new Date()): string {
  if (!iso) return "—";
  const d = Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000);
  if (d <= 0) return new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  if (d === 1) return "вчера";
  if (d < 31) return `${d} дн. назад`;
  return new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "numeric" });
}

/** Источник сообщения по-человечески. */
export const SOURCE_NAMES: Record<string, string> = {
  telegram: "Telegram", desktop: "Сайт и виджет", app: "Приложение", iphone: "Айфон", button: "Кнопки", push: "Push", panel: "Правки мышью",
};

/** Клиент входа (заголовок X-Maid-Client; у старых — по метке входа, server/src/auth.ts). */
export const CLIENT_NAMES: Record<string, string> = {
  web: "Сайт", desktop: "Программа на ПК", "desktop-key": "Ключ ПК (сервер)", widget: "Виджет на ПК", quick: "Быстрая запись", iphone: "Айфон",
  "telegram-widget": "Виджет Telegram", telegram: "Telegram", push: "Push-уведомления", other: "Другое",
};

/** Ветка разбора сообщения (messages.route, server/src/pipeline.ts). */
export const ROUTE_NAMES: Record<string, string> = {
  weather: "Погода", chat: "Разговор", parse: "Разбор упал", clarify: "Уточнение", draw: "Рисование", answer: "Ответ на вопрос",
  talk: "Болтовня", apply: "Запись", correct: "Поправка",
};

/** Код ошибки попытки модели (llm_calls.error_code, server/src/llm.ts). */
export const ERROR_NAMES: Record<string, string> = {
  timeout: "Тайм-аут", net: "Нет сети", http_429: "Лимит (429)", http_5xx: "Сбой провайдера (5xx)", http_4xx: "Отказ (4xx)",
  bad_body: "Плохой ответ", empty: "Пустой ответ", no_key: "Нет ключа", other: "Другое",
};

/** Дни недели карты часов (строки — с понедельника). */
export const ADM_WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

/** Время ответа: 840 → «840 мс», 12 300 → «12.3 с»; нет данных — «—». */
export function msText(v: number | null): string {
  if (v == null) return "—";
  return v < 1000 ? `${Math.round(v)} мс` : `${(v / 1000).toFixed(1)} с`;
}

/** Сколько работает сервер: «45 с», «12 мин», «3 ч 5 мин», «2 дн. 4 ч». */
export function uptimeText(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (h < 1) return `${m} мин`;
  if (d < 1) return `${h} ч ${m % 60} мин`;
  return `${d} дн. ${h % 24} ч`;
}

/** Сортировка таблицы людей: по ключу, числа — по убыванию, строки — по алфавиту; повторный щелчок — наоборот. */
export function sortRows<T extends Record<string, unknown>>(rows: T[], key: keyof T, desc: boolean): T[] {
  const k = (r: T) => r[key] ?? "";
  return [...rows].sort((a, b) => {
    const x = k(a), y = k(b);
    const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "ru");
    return desc ? -c : c;
  });
}

// ——— Этап 3: использование функций (/api/admin/features).
export type FeatureStat = { uses30: number; people30: number; weeks: number[]; last: string | null };
export type FeatureRow = { id: string; title: string; group: string; by: "client" | "server"; all: FeatureStat; clients: Record<string, FeatureStat> };
export const FEATURE_WEEKS = 8;
const noStat = (): FeatureStat => ({ uses30: 0, people30: 0, weeks: Array<number>(FEATURE_WEEKS).fill(0), last: null });

/** Строки под фильтр: группа и клиент («all» — все); у строки — счёт выбранного клиента и плоские поля для сортировки. */
export function featureView(rows: FeatureRow[], group: string, client: string) {
  return rows.filter((r) => group === "all" || r.group === group).map((r) => {
    const s = client === "all" ? r.all : r.clients[client] ?? noStat();
    return { id: r.id, title: r.title, group: r.group, by: r.by, uses30: s.uses30, people30: s.people30, weeks: s.weeks,
      trend: s.weeks.reduce((a, b) => a + b, 0), last: s.last ?? "" };
  });
}

/** Линия тренда по неделям в прямоугольнике w×h (точки для <polyline>); всё по нулям — линия по низу. */
export function sparkPoints(weeks: number[], w: number, h: number): string {
  const max = Math.max(1, ...weeks);
  const step = weeks.length > 1 ? w / (weeks.length - 1) : 0;
  return weeks.map((v, i) => `${+(i * step).toFixed(1)},${+(h - 1 - (v / max) * (h - 2)).toFixed(1)}`).join(" ");
}

/** День последнего использования (ГГГГ-ММ-ДД, по поясу человека) относительно «сегодня» админки. */
export function dayAgo(day: string | null, today: string): string {
  if (!day) return "никогда";
  const d = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86_400_000);
  if (d <= 0) return "сегодня";
  if (d === 1) return "вчера";
  if (d < 31) return `${d} дн. назад`;
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "numeric" });
}

// ——— Этап 5: Аналитика (/api/admin/analytics). Типы — копия server/src/admin-analytics.ts (контракт этапа 1 аналитики).
export type AnalyticsReportId = "money" | "subs" | "ai" | "act" | "ret" | "feat" | "parse";
export type AnalyticsStep = "h" | "d" | "w";
export type AnalyticsDays = 1 | 7 | 30 | 90 | 365;
export const ANALYTICS_DAYS: AnalyticsDays[] = [1, 7, 30, 90, 365];
/** cur — текущий период, prev — прошлый той же длины (для стрелки). null — «—». */
export type Pair = { cur: number | null; prev: number | null };
export type AnalyticsNote = "hour_from_calls" | "no_hourly_features" | "days_for_hours" | "latency_30d_only" | "prev_before_data";

export interface AnalyticsBucket {
  /** d: "ГГГГ-ММ-ДД"; w: первый день корзины "ГГГГ-ММ-ДД"; h: начало часа ISO UTC "2026-11-24T13:00:00.000Z". */
  key: string;
  /** d и w: дни включительно (from == to у d); h: ISO [from, to). */
  from: string; to: string;
  /** Сколько дней в корзине: d — 1, h — 1/24, w — 1..7 (первая бывает неполной). */
  days: number;
}
export interface AnalyticsMeta {
  report: AnalyticsReportId; days: AnalyticsDays; step: AnalyticsStep;
  generated_at: string; cached: boolean;
  /** Как разложены дни: "user" — по поясу человека, "utc" — деньги. */
  zone: "user" | "utc";
  /** Последний день периода (сегодня по поясу сервера или UTC — по zone). */
  today: string;
  period: { from: string; to: string };
  prev: { from: string; to: string };
  buckets: AnalyticsBucket[];
  /** Корзины прошлого периода (та же длина; ряды prev_* — по ним). */
  prev_buckets: AnalyticsBucket[];
  star_usd: number;
  since: { payments: string | null; billing_events: string | null; feature_events: string | null; gate: string | null; llm_calls: string | null; presence: string | null };
  notes: AnalyticsNote[];
}
export type AnalyticsResponse =
  | { meta: AnalyticsMeta; report: "money"; data: MoneyData }
  | { meta: AnalyticsMeta; report: "subs"; data: SubsData }
  | { meta: AnalyticsMeta; report: "ai"; data: AiData }
  | { meta: AnalyticsMeta; report: "act"; data: ActData }
  | { meta: AnalyticsMeta; report: "ret"; data: RetData }
  | { meta: AnalyticsMeta; report: "feat"; data: FeatData }
  | { meta: AnalyticsMeta; report: "parse"; data: ParseData };

export interface MoneyData {
  kpi: {
    revenue_stars: Pair;        // чистая: оплаты в периоде − возвраты в периоде
    revenue_sub_stars: Pair;    // оплаты kind first|renew (по paid_at)
    revenue_once_stars: Pair;   // оплаты kind once
    refunds_stars: Pair;        // сумма amount с refunded_at в периоде (положительное число)
    revenue_micro: Pair;        // round(revenue_stars × star_usd × 1e6)
    ai_micro: Pair;             // расход ИИ (1.6)
    margin_micro: Pair;         // revenue_micro − ai_micro
    active: Pair;               // 1.4
    payers: Pair;               // различные user_id с оплатой в периоде (возвращённые не в счёт)
    arpu_stars: Pair;           // revenue_stars / active; active=0 → null
    arppu_stars: Pair;          // revenue_stars / payers; payers=0 → null
    ltv_stars: Pair;            // всё время до конца окна: Σ(оплаты) − Σ(возвраты) / различные платившие
    avg_check_stars: Pair;      // Σ amount оплат в периоде / число этих оплат; 0 оплат → null
    payments: Pair;             // число оплат в периоде
    ai_per_active_micro: Pair;  // ai_micro / active; active=0 → null
  };
  series: {
    sub_stars: number[]; once_stars: number[];
    refund_stars: number[];                 // положительные; рисуются ВНИЗ от нуля
    revenue_micro: number[]; ai_micro: number[];
    active: number[];
    arpu_stars: (number | null)[];          // чистые звёзды корзины / активные корзины
    ai_per_active_micro: (number | null)[]; // ai корзины / активные корзины
  };
}

export interface SubsData {
  price_stars: number;            // tariffs().price (server/src/tariffs.ts)
  trial_days: number;             // tariffs().trialDays
  kpi: {
    active_subs: Pair; trials: Pair; trials_ending_3d: Pair; autorenew: Pair; churn_risk: Pair;
    trial_conversion: Pair;       // доля 0..1: оплатившие / решённые; решённых 0 → null
    trial_decided: Pair;          // в когорте пробы, у кого конец + 3 дн. <= now
    trial_pending: number;        // в когорте, у кого 3 дня ещё не прошли
    new_subs: Pair; renewals: Pair;
    cancels: Pair;                // billing_events kind canceled в периоде (правило since)
    expired: Pair;                // billing_events kind expired в периоде (правило since)
    refunds: Pair;                // payments с refunded_at в периоде (число)
  };
  series: {
    new: number[]; renewed: number[];        // вверх
    canceled: (number | null)[];             // положительные; рисуются ВНИЗ; null — корзина раньше since billing_events
    expired: (number | null)[];              // так же, вниз
    trial_conversion: (number | null)[];     // по корзине конца пробы
  };
  /** «Кто скоро решит»: до 10 строк, ближайшие сверху. */
  soon: SubsSoonRow[];
}
export interface SubsSoonRow {
  user_id: number;
  what: "trial" | "no_renew";   // проба кончается / подписка без автопродления
  left_days: number;            // ceil((access_until − now) / сутки), не меньше 0
  days_with_us: number;         // floor((now − created_at) / сутки)
  active_days_7: number;        // различные активные дни за 7 последних дней по его поясу
  ai_micro_30: number;          // llm_usage за 30 дней UTC
}

export type AiGroup = "parse" | "talk" | "draw" | "voice" | "background" | "other";
/** Назначения llm_usage.kind → группа (USAGE_KINDS из server/src/llm.ts). Незнакомый kind → other. */
export const AI_GROUPS: { id: AiGroup; kinds: string[] }[] = [
  { id: "parse", kinds: ["parse", "correct"] },
  { id: "talk", kinds: ["chat", "answer"] },
  { id: "draw", kinds: ["draw"] },
  { id: "voice", kinds: ["voice"] },
  { id: "background", kinds: ["summary", "patterns"] },
  { id: "other", kinds: ["other"] },
];
export interface AiData {
  source: "llm_usage" | "llm_calls";
  kpi: {
    total_micro: Pair; calls: Pair;
    unpriced_calls: Pair;              // вызовы без цены (их расход — ноль)
    forecast_month_micro: number | null; // Σ за 7 полных прошедших дней UTC / 7 × 30; не зависит от интервала
    capped_users: Pair;                // различные user_id с gate.day_cap / calls_cap / draws_cap / voice_cap > 0 в днях окна
    capped_share: Pair;                // capped_users / active; active=0 → null
    active: Pair;
    top_user: { user_id: number; micro: number } | null; // самый дорогой за период
    subscribers: number;               // plan='paid' со живым сроком сейчас
    subscriber_avg_micro: number | null;          // средний расход ИИ подписчика за период
    subscriber_avg_revenue_micro: number | null;  // выручка подписки за период на подписчика
  };
  groups: { id: AiGroup; kinds: string[] }[]; // = AI_GROUPS
  series: Record<AiGroup, number[]>;          // micro по корзинам
  /** «Сколько людей тратят сколько» — ВСЕГДА за 30 дней UTC до сегодня, среди активных за эти 30 дней (с нулём — в первую полосу). */
  dist: { id: "lt5c" | "5to20c" | "20to50c" | "50cto1" | "1to3" | "gt3"; from_micro: number; to_micro: number | null; users: number; share: number | null }[];
  dist_users: number;
  /** Модели за период: доля расхода, вызовы, главное назначение, время ответа. Сортировка по micro по убыванию. */
  models: { model: string; micro: number; share: number | null; calls: number; top_kind: string; p50_ms: number | null; p95_ms: number | null; timed: number }[];
  limits: { trial_day_micro: number; paid_day_micro: number; trial_pool_day_micro: number }; // из тарифов (server/src/tariffs.ts) × 1e6
}

export interface ActData {
  kpi: {
    signups: Pair;              // users.created_at в периоде
    requests: Pair;             // обращения к ИИ
    manual: Pair;               // отметки кнопкой, push, правки мышью — «без ИИ»
    active: Pair;
    requests_per_active: Pair;  // requests / active
    manual_per_active: Pair;    // manual / active
    payers_share: Pair;         // (активные с оплатой XTR в периоде) / active
  };
  /** Источники сообщений с ИИ по убыванию объёма (telegram, desktop, app, iphone…), подписи — SOURCE_NAMES. */
  sources: string[];
  series: {
    signups: number[];
    requests: number[];
    requests_by_source: Record<string, number[]>;
    manual: number[];
  };
  /** 24 числа: среднее число сообщений (requests + manual) в местный час суток за день периода. */
  hours: number[];
  /** Неделя × час: минуты присутствия, сложенные по людям, ВСЕГДА за 28 дней до сегодня. Строки пн…вс, столбцы 0…23. */
  heat: number[][];
  heat_days: 28;
}

export interface RetData {
  /** Цифры на «сегодня» t; prev — та же точка неделю назад (t−7), независимо от интервала. */
  kpi: { dau: Pair; wau: Pair; mau: Pair; stickiness: Pair; gone: Pair };
  series: {
    active: number[];       // d — активные за день; h — за час; w — различные активные в 7-дневной корзине
    prev_active: number[];  // то же для prev_buckets (рисуется пунктиром по индексу)
  };
  /** Мост MAU: prev = [t−59, t−30], cur = [t−29, t]. */
  bridge: { prev_mau: number; stayed: number; left: number; new: number; returned: number; mau: number };
  /** Когорты: строка — неделя регистрации, новые снизу. */
  cohorts: { week: string; size: number; cells: ({ share: number; users: number } | null)[] }[];
  cohort_cols: number; // число столбцов Н+0…Н+(cohort_cols−1)
}

export interface FeatData {
  groups: Record<string, string>;   // FEATURE_GROUPS
  since: string | null;             // MIN(day_key) feature_events
  active: Pair;
  kpi: { used: Pair; total: number; per_person: Pair; people: Pair; unused: Pair };
  rows: {
    id: string; title: string; group: string; by: "client" | "server";
    uses: Pair; people: Pair;
    share: Pair;                    // people / active (доля активных)
    clients: Record<string, number>; // uses.cur по клиентам
    spark: number[] | null;         // uses по корзинам; на шаге h — null
  }[];                              // сортировка по uses.cur по убыванию
  unused: string[];                 // id фич с uses.cur = 0 за интервал
}

export type ParseKind = "tasks" | "plans" | "diary" | "habits" | "money" | "other" | "talk";
export const PARSE_KINDS: ParseKind[] = ["tasks", "plans", "diary", "habits", "money", "other", "talk"];
export interface ParseData {
  kpi: {
    requests: Pair; undone: Pair; corrections: Pair; undone_share: Pair; corrections_share: Pair;
    failed_now: number;        // сейчас, без интервала
    failed_retry: number;      // ждут повтора
    clarify_now: number;
    p50_ms: Pair; p95_ms: Pair;
  };
  kinds: ParseKind[];          // = PARSE_KINDS
  series: {
    requests: number[];
    kinds: Record<ParseKind, number[]>;
    err_share: (number | null)[]; // (undone + corrections) / requests корзины; requests=0 → null
  };
}

/** Отчёт в меню раздела; fun и rina — заглушки этапа 2 (запросов не шлют). */
export type AnalyticsTab = AnalyticsReportId | "fun" | "rina";
export const ANALYTICS_REPORTS: { group: string; icon: string; items: { id: AnalyticsTab; title: string; stub?: true }[] }[] = [
  { group: "Деньги", icon: "adm-coins", items: [{ id: "money", title: "Обзор" }, { id: "subs", title: "Подписки" }, { id: "ai", title: "Расход на ИИ" }] },
  { group: "Люди", icon: "adm-users", items: [{ id: "act", title: "Активность" }, { id: "ret", title: "Удержание" }, { id: "fun", title: "Воронки", stub: true }] },
  { group: "Рина и функции", icon: "adm-spark", items: [{ id: "feat", title: "Функции" }, { id: "rina", title: "Рина", stub: true }, { id: "parse", title: "Разбор" }] },
];
/** С этого дня копятся данные для отчётов этапа 2 (Воронки, Рина). */
export const ANALYTICS_COLLECT_SINCE = "2026-11-24";
/** Раз в сколько обновлять открытый отчёт (только при видимой вкладке браузера). */
export const ANALYTICS_REFRESH_MS = 60_000;

/** Отчёт по адресу /admin/analytics/<отчёт>; незнакомый и пустой — «Обзор» (money). */
export function analyticsTab(arg: string | undefined): AnalyticsTab {
  for (const g of ANALYTICS_REPORTS) for (const it of g.items) if (it.id === arg) return it.id;
  return "money";
}

/** Можно ли такой шаг при таком интервале (как сервер: час — до 7 дней, неделя — от 30; у 24 ч — только час, как analyticsFixStep). */
export function analyticsStepOk(days: AnalyticsDays, step: AnalyticsStep): boolean {
  if (days === 1) return step === "h";
  return step === "h" ? days <= 7 : step === "w" ? days >= 30 : true;
}

/** Шаг под интервал, как fixStep макета: 24 ч — час; «час» больше 7 дней и «неделя» меньше 30 — день. */
export function analyticsFixStep(days: AnalyticsDays, step: AnalyticsStep): AnalyticsStep {
  if (days === 1) return "h";
  if (step === "h" && days > 7) return "d";
  if (step === "w" && days < 30) return "d";
  return step;
}

/** Изменение к прошлому периоду: (cur − prev) / prev. Нет числа, prev = 0 или меньше 0,5 % — null («—»). */
export function analyticsDelta(cur: number | null, prev: number | null): number | null {
  if (cur == null || prev == null || prev === 0) return null;
  const d = (cur - prev) / Math.abs(prev);
  return Math.abs(d) < 0.005 ? null : d;
}

export const AI_GROUP_NAMES: Record<AiGroup, string> = {
  parse: "Разбор сообщений", talk: "Разговор", draw: "Картинки", voice: "Голос", background: "Сводки и связи (фон)", other: "Другое",
};
export const PARSE_KIND_NAMES: Record<ParseKind, string> = {
  tasks: "Задачи", plans: "Планы", diary: "Дневник", habits: "Привычки", money: "Деньги", other: "Другое", talk: "Разговор без записи",
};
export const DIST_NAMES: Record<AiData["dist"][number]["id"], string> = {
  lt5c: "до 5¢", "5to20c": "5–20¢", "20to50c": "20–50¢", "50cto1": "50¢–1$", "1to3": "1–3$", gt3: "больше 3$",
};
/** Группа назначения по llm_usage.kind (незнакомое — «Другое»). */
export const aiGroupOf = (kind: string): AiGroup => AI_GROUPS.find((g) => g.kinds.includes(kind))?.id ?? "other";

/** Сноски под карточками (meta.notes). */
export const ANALYTICS_NOTE_TEXT: Record<AnalyticsNote, string> = {
  hour_from_calls: "на шаге «час» расход — по журналу вызовов, без дневных итогов",
  no_hourly_features: "по часам функций нет — данные по дням",
  days_for_hours: "цифры — за календарные дни, которые задевает окно часов",
  latency_30d_only: "время ответа — только за последние 30 дней",
  prev_before_data: "часть данных начали писать позже — для такого окна «—»",
};

/** Число по-русски ровно с digits знаками: запятая в дробях, тысячи через неразрывный пробел. */
function fixedText(v: number, digits: number): string {
  const [int, frac = ""] = Math.abs(v).toFixed(digits).split(".");
  const g = int.length > 3 ? int.replace(/\B(?=(\d{3})+(?!\d))/g, " ") : int;
  return frac ? `${g},${frac}` : g;
}

/** Число по-русски: запятая в дробях, тысячи через неразрывный пробел; лишние нули справа убираются. */
export function numText(v: number | null, digits = 0): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const [g, frac = ""] = fixedText(v, digits).split(",");
  const f = frac.replace(/0+$/, "");
  const out = f ? `${g},${f}` : g;
  return v < 0 && out !== "0" ? `−${out}` : out;
}

/** Деньги из micro_usd (миллионные доллара): от доллара — «$1,23», меньше — «61¢» (до 10¢ — с десятой: «0,4¢»). */
export function microText(micro: number | null): string {
  if (micro == null || !Number.isFinite(micro)) return "—";
  const a = Math.abs(micro);
  let out: string;
  if (a === 0) out = "$0";
  else if (a < 1_000_000) { const c = a / 10_000; out = `${numText(c, c < 10 ? 1 : 0)}¢`; }
  else out = `$${fixedText(a / 1e6, a < 1e9 ? 2 : 0)}`;
  return micro < 0 ? `−${out}` : out;
}

/** Доля 0..1 → «12,3%» (целые — без запятой); нет числа — «—». */
export function shareText(share: number | null): string {
  if (share == null || !Number.isFinite(share)) return "—";
  return `${numText(share * 100, 1)}%`;
}

/** Стрелка изменения: «+12,3%» / «−4%». */
export function deltaText(d: number): string {
  return `${d > 0 ? "+" : ""}${numText(d * 100, 1)}%`;
}

const RU_MONTHS = ["янв.", "февр.", "мар.", "апр.", "мая", "июн.", "июл.", "авг.", "сент.", "окт.", "нояб.", "дек."];
const pad2 = (n: number) => String(n).padStart(2, "0");
/** День «ГГГГ-ММ-ДД» → «24 нояб.»; с годом — «24 нояб. 2026». */
export function dayText(day: string, year = false): string {
  const [y, m, d] = day.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return day;
  return `${d} ${RU_MONTHS[m - 1]}${year ? ` ${y}` : ""}`;
}

/** Подпись корзины на оси и в подсказке: час — местным временем браузера «24.11 13:00»; день — «24 нояб.»;
 *  неделя — первый день, у неполной — «(N дн.)». */
export function bucketLabel(b: AnalyticsBucket, step: AnalyticsStep): string {
  if (step === "h") {
    const t = new Date(b.key);
    return `${t.getDate()}.${pad2(t.getMonth() + 1)} ${pad2(t.getHours())}:00`;
  }
  const s = dayText(b.key);
  return step === "w" && b.days < 7 ? `${s} (${b.days} дн.)` : s;
}

/** CSV: запятая, точка в дробях, поле с запятой, кавычкой или переводом строки — в кавычках; null — пусто; BOM в начале. */
export function toCsv(header: string[], rows: (string | number | null)[][]): string {
  const cell = (v: string | number | null) => {
    if (v == null) return "";
    const s = typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : v;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "﻿" + [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
}

/** Имя файла выгрузки: maid-<отчёт>-<таблица>-<дни>d-<ГГГГ-ММ-ДД>.csv. */
export const csvFileName = (report: string, table: string, days: number, today: string) => `maid-${report}-${table}-${days}d-${today}.csv`;

/** Ряды карточки в CSV: корзина (key), её начало и конец, дней в корзине, потом ряды (имена — с единицей). */
export function seriesCsv(buckets: AnalyticsBucket[], cols: { name: string; values: (number | null)[] }[]): string {
  return toCsv(["bucket", "from", "to", "days", ...cols.map((c) => c.name)],
    buckets.map((b, i) => [b.key, b.from, b.to, +b.days.toFixed(4), ...cols.map((c) => c.values[i] ?? null)]));
}
